// The sage hook's shell reader: mvdan.cc/sh/v3/syntax parses a command line in bash or zsh mode, and Parse gives
// the hook's command list as JSON, in the shape that shellCommands in sage-hook.mjs gives today:
//
//	{"commands": [{"words", "bodies", "host": {"cmd", "index"}, "piped", "pipeTo", "grouped", "writes"}]}
//	{"error": "..."}
//
// A command's words lose their quotes and redirections. A command substitution, $( ) or a backtick, and a process
// substitution, <( ), >( ) or zsh's =( ), are "$(…)" in the word and give commands of their own, listed before the
// command they land in (host: its index in the list, and the word's index; -1 for a heredoc). Keywords (if, while,
// case, time, coproc, function) are not words: their commands are listed with grouped set. A line with no command gives
// an empty list. Parse refuses (an error) what it cannot read, so that the hook fails closed: a NUL byte, an ANSI-C
// string ($'…') with an escape other than the 13 that bash and zsh read alike, bash's ${x@P}, a glob group with code
// in it, and in zsh mode the forms that turn text into code (see checks) and the reserved words that mvdan/sh reads
// as words (zshReserved).
package main

import (
	"cmp"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"

	"mvdan.cc/sh/v3/syntax"
)

type command struct {
	Words   []string `json:"words"`
	Bodies  []string `json:"bodies"`
	Host    *host    `json:"host"`
	Piped   bool     `json:"piped"`
	PipeTo  *int     `json:"pipeTo"`
	Grouped bool     `json:"grouped"`
	Writes  bool     `json:"writes"`

	host   *command // the command that a substitution's text lands in, and the word: index
	index  int
	pipeTo *command
}

type host struct {
	Cmd   int `json:"cmd"`
	Index int `json:"index"`
}

// at is where a command's text lands: in a word of another command, or at the top (cmd nil).
type at struct {
	cmd   *command
	index int
}

type reader struct {
	src string
	zsh bool
	out []*command
	err error // the first error in a substitution (substsAt)
}

// The zsh reserved words (zshmisc(1), "Reserved Words") that mvdan/sh v3.14.1 reads as a plain word, and that start
// a command whose program is not the first word: coproc, repeat (repeat 1 kill 1) and foreach (foreach x (a) kill 1;
// end). The others are keywords to mvdan/sh, are refused as a syntax error (always), or come before the program as a
// word that the hook skips (nocorrect) or reads as the program (end, float, integer and the declarations).
var zshReserved = []string{"coproc", "repeat", "foreach"}

// Glob groups: one rule. mvdan/sh v3.14.1 keeps the text of a bash extglob group, @( ) ?( ) *( ) +( ) !( ), and of a
// zsh glob group, ( ), as a plain literal: it does not read the substitutions in it, and the shell runs them (bash also
// in [[ ]] and case patterns). Where zsh does filename generation, it reads a trailing group with no | or ( in it, and
// a (#q…) group, as glob qualifiers, and any qualifier can change the command: e and + run code, P and ^P add words
// (a(P:ps:) runs ps a), and a : modifier rewrites them (/bin/pwd(:s/wd/s/) runs /bin/ps). So, outside double quotes
// and heredocs:
//   - a group's text may hold only plain bytes (see plain): no $, `, < or >, which start a substitution;
//   - in zsh, where the shell does filename generation, each ( ) must be a plain alternation, such as *.(js|ts): one or
//     more | between letters, digits and _ . * ? -, in one literal. Anything else is refused: a backslash, a quote,
//     an expansion, a brace or a nested group can turn a group with a | into qualifiers (m(P:x\|y:), m(P:x:{|,})).
//
// zsh does no filename generation in an assignment's value (x=, local x=), a case pattern, or the pattern of
// [[ a == b ]], != and =~; it does in a command's words, an array, a redirection, a for list, ${x:-…} there, and
// [[ -n … ]] with (#q). Each was checked with zsh 5.9 and a qualifier that touches a marker file.

// Where a word is, for the glob group rule.
const (
	inText    = iota // double quotes and heredoc bodies: a ( ) is text
	inPattern        // a pattern or value with no filename generation
	inFiles          // filename generation
)

// Parse gives the command list of src, read as zsh when zsh is true, else as bash. TinyGo has no recover() on
// WebAssembly: a panic stops the instance with a trap, and parser.mjs throws it.
func Parse(src string, zsh bool) []byte {
	if strings.IndexByte(src, 0) >= 0 {
		return fail(errors.New("a NUL byte: a shell drops it, so the line that runs is not the line that was read"))
	}
	lang := syntax.LangBash
	if zsh {
		lang = syntax.LangZsh
	}
	f, err := syntax.NewParser(syntax.Variant(lang)).Parse(strings.NewReader(src), "")
	if err != nil {
		return fail(err)
	}
	if err := checks(f, zsh); err != nil {
		return fail(err)
	}
	r := &reader{src: src, zsh: zsh, out: []*command{}}
	if err := cmp.Or(r.stmts(f.Stmts, at{}, false), r.err); err != nil {
		return fail(err)
	}
	index := map[*command]int{}
	for i, c := range r.out {
		index[c] = i
	}
	for _, c := range r.out {
		if c.host != nil {
			c.Host = &host{index[c.host], c.index}
		}
		if c.pipeTo != nil {
			i := index[c.pipeTo]
			c.PipeTo = &i
		}
	}
	b, _ := json.Marshal(map[string][]*command{"commands": r.out})
	return b
}

func fail(err error) []byte {
	b, _ := json.Marshal(map[string]string{"error": err.Error()})
	return b
}

// checks refuses the forms that the command list cannot show, because the shell makes them into other text or code:
//   - an ANSI-C string with an escape that ansiC does not decode, in both modes;
//   - ${x@P}, which expands the value as a prompt and runs its substitutions (bash 4.4 and later; zsh mode refuses
//     it as a syntax error), and an @ operator that mvdan/sh reads as more than one letter;
//   - a glob group that the glob group rule (above) refuses: a substitution that mvdan/sh keeps as text, and in zsh any
//     group that zsh can read as glob qualifiers: *(N), a(P:ps:), *(e:'ps':), *(#q.), *(N$x);
//   - in zsh mode, a parameter expansion that makes a value into code (zshexpn(1), "Parameter Expansion Flags"):
//     the e flag runs the value's substitutions (${(e)x}); %% with PROMPT_SUBST does too; a substitution in a flag's
//     argument runs (${(l:$(ps):)x}); ${~x}, $~x and the ~ flag make a value a glob pattern, which can hold a qualifier
//     that runs code.
func checks(f *syntax.File, zsh bool) (err error) {
	var walk func(n syntax.Node, at int)
	walk = func(n syntax.Node, at int) {
		syntax.Walk(n, func(n syntax.Node) bool {
			if err != nil {
				return false
			}
			switch x := n.(type) {
			case *syntax.Redirect:
				if x.Word != nil {
					walk(x.Word, inFiles)
				}
				if x.Hdoc != nil {
					walk(x.Hdoc, inText)
				}
				return false
			case *syntax.CmdSubst, *syntax.ProcSubst:
				if at != inFiles {
					walk(x, inFiles)
					return false
				}
			case *syntax.DblQuoted:
				if at != inText {
					walk(x, inText)
					return false
				}
			case *syntax.Assign:
				if x.Value != nil && at == inFiles {
					walk(x.Value, inPattern)
					if x.Index != nil {
						walk(x.Index, at)
					}
					if x.Array != nil {
						walk(x.Array, at)
					}
					return false
				}
			case *syntax.BinaryTest:
				if at == inFiles && (x.Op == syntax.TsMatchShort || x.Op == syntax.TsMatch || x.Op == syntax.TsNoMatch || x.Op == syntax.TsReMatch) {
					walk(x.X, at)
					walk(x.Y, inPattern)
					return false
				}
			case *syntax.CaseItem:
				if at == inFiles {
					for _, p := range x.Patterns {
						walk(p, inPattern)
					}
					for _, s := range x.Stmts {
						walk(s, at)
					}
					return false
				}
			case *syntax.ExtGlob:
				if strings.IndexFunc(x.Pattern.Value, func(r rune) bool { return r < 0x80 && !plain(byte(r)) }) >= 0 {
					err = fmt.Errorf("an extended glob group with a substitution, which the reader does not read: %s%s)", x.Op, x.Pattern.Value)
				}
			case *syntax.SglQuoted:
				if _, ok := ansiC(x.Value); x.Dollar && !ok {
					err = fmt.Errorf(`an ANSI-C string with an escape other than \a \b \e \E \f \n \r \t \v \\ \' \" \?: $'%s'`, x.Value)
				}
			case *syntax.Word:
				if zsh && at != inText {
					err = globGroups(x, at == inFiles)
				}
			case *syntax.ParamExp:
				if x.Exp != nil && x.Exp.Op == syntax.OtherParamOps && (x.Exp.Word == nil || x.Exp.Word.Lit() == "P" || x.Exp.Word.Lit() == "") {
					err = errors.New("a parameter expansion with @P, which expands the value as a prompt and runs its substitutions, or with an @ operator that is not one letter")
				}
				if zsh && (x.GlobSubst == syntax.OptOn || x.Flags != nil && strings.ContainsAny(x.Flags.Value, "e%~$`")) {
					err = errors.New("a zsh parameter expansion that can run code: the e, % or ~ flag, a substitution in a flag, or ${~x}")
				}
			}
			return err == nil
		})
	}
	walk(f, inFiles)
	return err
}

// globGroups applies the glob group rule to a zsh word: each byte in a ( ) is plain, and where files is true, each
// ( ) is a plain alternation and the parentheses balance.
func globGroups(w *syntax.Word, files bool) error {
	depth, group := 0, ""
	qualifiers := func() error {
		return fmt.Errorf("a zsh glob group that zsh can read as glob qualifiers, which can add, change or run words: %s", group)
	}
	for _, p := range w.Parts {
		l, ok := p.(*syntax.Lit)
		if !ok {
			if depth > 0 && files {
				group += "…"
				return qualifiers()
			}
			continue
		}
		for j := 0; j < len(l.Value); j++ {
			c := l.Value[j]
			if depth == 0 && c == '\\' {
				j++
				continue
			}
			if depth == 0 && c != '(' && (c != ')' || !files) {
				continue
			}
			group += string(c)
			switch {
			case c == '(':
				depth++
			case c == ')':
				depth--
			case !plain(c):
				return fmt.Errorf("a zsh glob group with a substitution, which the reader does not read: %s", group)
			}
			if depth > 0 {
				continue
			}
			if files && (depth < 0 || !strings.Contains(group, "|") || strings.Trim(group[1:len(group)-1], alternation) != "") {
				return qualifiers()
			}
			group = ""
		}
	}
	if depth > 0 && files {
		return qualifiers()
	}
	return nil
}

// alternation is the bytes of a plain alternation group, besides the parentheses.
const alternation = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.*?-|"

// plain is true for a byte that is literal text in a glob group: a letter, a digit, a blank, a non-ASCII byte, or one
// of _.,:;/|*?!^~#@%+=-[]{}()'"\. It is false for $, `, < and >, which start a substitution, and for any other byte.
func plain(c byte) bool {
	return c >= 0x80 || 'a' <= c && c <= 'z' || 'A' <= c && c <= 'Z' || '0' <= c && c <= '9' || strings.IndexByte(" \t\n_.,:;/|*?!^~#@%+=-[]{}()'\"\\", c) >= 0
}

// ansiC decodes the text of $'…' when it has only the escapes that bash and zsh decode alike; ok is false otherwise.
// The others (numbers such as \x67, \c, \u, \M-, and an unknown escape, which bash keeps and zsh drops) are refused,
// so that $'\x67it' cannot hide a program name.
func ansiC(s string) (_ string, ok bool) {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] != '\\' {
			b.WriteByte(s[i])
			continue
		}
		if i++; i == len(s) {
			return "", false
		}
		c := strings.IndexByte(`abeEfnrtv\'"?`, s[i])
		if c < 0 {
			return "", false
		}
		b.WriteByte("\a\b\x1b\x1b\f\n\r\t\v\\'\"?"[c])
	}
	return b.String(), true
}

func (r *reader) text(n syntax.Node) string { return r.src[n.Pos().Offset():n.End().Offset()] }

// raw is a heredoc body as written. Its own end position reaches past the delimiter line, so it is built from its parts.
func (r *reader) raw(w *syntax.Word) string {
	var b strings.Builder
	for _, p := range w.Parts {
		if l, ok := p.(*syntax.Lit); ok {
			b.WriteString(l.Value)
		} else {
			b.WriteString(r.text(p))
		}
	}
	return b.String()
}

func (r *reader) stmts(list []*syntax.Stmt, h at, grouped bool) error {
	for _, s := range list {
		if err := r.stmt(s, h, grouped); err != nil {
			return err
		}
	}
	return nil
}

func (r *reader) stmt(s *syntax.Stmt, h at, grouped bool) error {
	if s == nil {
		return nil
	}
	start := len(r.out)
	var c *command // the command that the statement's redirections belong to
	switch x := s.Cmd.(type) {
	case nil: // only redirections, such as ">out"
		c = r.newCommand(h, grouped)
	case *syntax.CallExpr:
		if w := x.Args; r.zsh && len(w) > 0 && slices.Contains(zshReserved, w[0].Lit()) {
			return fmt.Errorf("zsh's %s, which mvdan/sh reads as a word", w[0].Lit())
		}
		c = r.newCommand(h, grouped)
		for _, a := range x.Assigns {
			r.word(c, r.assign(a), a)
		}
		for _, w := range x.Args {
			r.word(c, r.wordText(w), w)
		}
	case *syntax.DeclClause:
		c = r.newCommand(h, grouped)
		r.word(c, x.Variant.Value, x.Variant)
		for _, a := range x.Args {
			r.word(c, r.assign(a), a)
		}
	case *syntax.LetClause:
		c = r.newCommand(h, grouped)
		r.word(c, "let", nil)
		for _, e := range x.Exprs {
			r.word(c, r.text(e), e)
		}
	case *syntax.BinaryCmd:
		if err := r.stmt(x.X, h, grouped); err != nil {
			return err
		}
		left := r.out[start:]
		next := len(r.out)
		if err := r.stmt(x.Y, h, grouped); err != nil {
			return err
		}
		if x.Op == syntax.Pipe || x.Op == syntax.PipeAll {
			var to *command
			for _, c := range r.out[next:] {
				if c.host == h.cmd {
					to = c
					break
				}
			}
			for _, c := range left {
				if c.host == h.cmd {
					c.Piped, c.pipeTo = true, to
				}
			}
		}
	case *syntax.Subshell:
		if err := r.stmts(x.Stmts, h, true); err != nil {
			return err
		}
	case *syntax.Block:
		if err := r.stmts(x.Stmts, h, true); err != nil {
			return err
		}
	case *syntax.IfClause:
		for i := x; i != nil; i = i.Else {
			if err := r.stmts(i.Cond, h, true); err != nil {
				return err
			}
			if err := r.stmts(i.Then, h, true); err != nil {
				return err
			}
		}
	case *syntax.WhileClause:
		if err := r.stmts(x.Cond, h, true); err != nil {
			return err
		}
		if err := r.stmts(x.Do, h, true); err != nil {
			return err
		}
	case *syntax.ForClause:
		r.substsAt(x.Loop, h)
		if err := r.stmts(x.Do, h, true); err != nil {
			return err
		}
	case *syntax.CaseClause:
		r.substsAt(x.Word, h)
		for _, item := range x.Items {
			for _, p := range item.Patterns {
				r.substsAt(p, h)
			}
			if err := r.stmts(item.Stmts, h, true); err != nil {
				return err
			}
		}
	case *syntax.FuncDecl:
		if err := r.stmt(x.Body, h, true); err != nil {
			return err
		}
	case *syntax.TimeClause:
		if err := r.stmt(x.Stmt, h, grouped); err != nil {
			return err
		}
	case *syntax.CoprocClause:
		if err := r.stmt(x.Stmt, h, true); err != nil {
			return err
		}
	case *syntax.ArithmCmd, *syntax.TestClause:
		r.substsAt(x, h)
	default:
		return fmt.Errorf("a command form that the reader does not know: %T", x)
	}
	if c == nil { // a compound command's redirections: its heredocs are a command of no words, and a write is for all its commands
		c = r.newCommand(h, true)
		defer func() {
			for _, d := range r.out[start:] {
				d.Writes = d.Writes || c.Writes
			}
		}()
	}
	for _, rd := range s.Redirs {
		switch rd.Op {
		case syntax.Hdoc, syntax.DashHdoc:
			if rd.Hdoc != nil {
				c.Bodies = append(c.Bodies, strings.TrimSuffix(r.raw(rd.Hdoc), "\n"))
				if !quoted(rd.Word) {
					r.substsAt(rd.Hdoc, at{c, -1})
				}
			}
		case syntax.WordHdoc:
			c.Bodies = append(c.Bodies, r.wordText(rd.Word))
			r.substsAt(rd.Word, at{c, len(c.Words)})
		default:
			c.Writes = c.Writes || strings.Contains(rd.Op.String(), ">")
			r.substsAt(rd.Word, at{c, len(c.Words)})
		}
	}
	if len(c.Words) > 0 || len(c.Bodies) > 0 || slices.ContainsFunc(r.out[start:], func(d *command) bool { return d.host == c }) {
		r.out = append(r.out, c)
	}
	return nil
}

func (r *reader) newCommand(h at, grouped bool) *command {
	return &command{Words: []string{}, Bodies: []string{}, host: h.cmd, index: h.index, Grouped: grouped || h.cmd != nil && h.cmd.Grouped}
}

// word adds a word to c, after the commands of the substitutions in its node.
func (r *reader) word(c *command, text string, n syntax.Node) {
	if n != nil {
		r.substsAt(n, at{c, len(c.Words)})
	}
	c.Words = append(c.Words, text)
}

// substsAt lists the commands of each substitution in n, landing at h. The first error that a substitution's
// commands give is kept in r.err, and Parse refuses the line.
func (r *reader) substsAt(n syntax.Node, h at) {
	if n == nil {
		return
	}
	syntax.Walk(n, func(n syntax.Node) bool {
		if r.err != nil {
			return false
		}
		switch x := n.(type) {
		case *syntax.CmdSubst:
			r.err = r.stmts(x.Stmts, h, false)
			return false
		case *syntax.ProcSubst:
			r.err = r.stmts(x.Stmts, h, false)
			return false
		}
		return true
	})
}

func (r *reader) assign(a *syntax.Assign) string {
	switch {
	case a.Naked && a.Value != nil:
		return r.wordText(a.Value)
	case a.Naked || a.Index != nil || a.Array != nil || a.Value == nil:
		return r.text(a)
	case a.Append:
		return a.Name.Value + "+=" + r.wordText(a.Value)
	}
	return a.Name.Value + "=" + r.wordText(a.Value)
}

// wordText is a word without its quotes. A substitution is "$(…)"; a parameter, arithmetic or other expansion keeps
// its source text.
func (r *reader) wordText(w *syntax.Word) string {
	var b strings.Builder
	for _, p := range w.Parts {
		b.WriteString(r.partText(p, false))
	}
	return b.String()
}

func (r *reader) partText(p syntax.WordPart, inDouble bool) string {
	switch x := p.(type) {
	case *syntax.Lit:
		return unescape(x.Value, inDouble)
	case *syntax.SglQuoted:
		if x.Dollar {
			v, _ := ansiC(x.Value) // checks refused the line if this fails
			return v
		}
		return x.Value
	case *syntax.DblQuoted:
		var b strings.Builder
		for _, q := range x.Parts {
			b.WriteString(r.partText(q, true))
		}
		return b.String()
	case *syntax.CmdSubst, *syntax.ProcSubst:
		return "$(…)"
	case *syntax.ParamExp:
		// mvdan/sh v3.14.1 ends a zsh $=x or $^x at the end of the line one byte early: end it after the name.
		if x.Short && x.Index == nil && x.Param != nil {
			return r.src[x.Pos().Offset():max(x.End().Offset(), x.Param.Pos().Offset()+uint(len(x.Param.Value)))]
		}
	}
	return r.text(p)
}

// unescape removes the backslashes that the shell removes: before any character outside quotes, and before $ ` " \
// and a newline inside double quotes.
func unescape(s string, inDouble bool) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+1 < len(s) {
			next := s[i+1]
			if next == '\n' {
				i++
				continue
			}
			if !inDouble || strings.IndexByte("$`\"\\", next) >= 0 {
				b.WriteByte(next)
				i++
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

// quoted is true for a heredoc delimiter with quotes or a backslash: its body is plain text, with no substitutions.
func quoted(w *syntax.Word) bool {
	for _, p := range w.Parts {
		if l, ok := p.(*syntax.Lit); !ok || strings.Contains(l.Value, `\`) {
			return true
		}
	}
	return false
}
