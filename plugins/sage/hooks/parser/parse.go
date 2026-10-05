// The sage hook's shell reader: mvdan.cc/sh/v3/syntax parses a command line in bash or zsh mode, and Parse gives
// the hook's command list as JSON, in the shape that shellCommands in sage-hook.mjs gives today:
//
//	{"commands": [{"words", "bodies", "host": {"cmd", "index"}, "piped", "pipeTo", "grouped", "writes"}]}
//	{"error": "..."}
//
// A command's words lose their quotes and redirections. A command substitution, $( ) or a backtick, and a process
// substitution, <( ), >( ) or zsh's =( ), are "$(…)" in the word and give commands of their own, listed before the
// command they land in (host: its index in the list, and the word's index; -1 for a heredoc). Keywords (if, while,
// case, time, coproc, function) are not words: their commands are listed with grouped set. Parse refuses (an error)
// what it cannot read, so that the hook fails closed.
package main

import (
	"encoding/json"
	"fmt"
	"regexp"
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
	out []*command
}

// A zsh glob qualifier that runs code: *(e:'ps':), *(+f), *(#qe:…:). mvdan/sh reads it as plain text.
var codeQualifier = regexp.MustCompile(`\([^)]*[e+]`)

// Parse gives the command list of src, read as zsh when zsh is true, else as bash. TinyGo has no recover() on
// WebAssembly: a panic stops the instance with a trap, and parser.mjs throws it.
func Parse(src string, zsh bool) []byte {
	lang := syntax.LangBash
	if zsh {
		lang = syntax.LangZsh
	}
	f, err := syntax.NewParser(syntax.Variant(lang)).Parse(strings.NewReader(src), "")
	if err != nil {
		return fail(err)
	}
	if zsh {
		if err := qualifiers(f); err != nil {
			return fail(err)
		}
	}
	r := &reader{src: src}
	if err := r.stmts(f.Stmts, at{}, false); err != nil {
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

// qualifiers refuses a word with a glob qualifier that runs code. A heredoc body is text, not words: only the commands
// of its substitutions are checked.
func qualifiers(f *syntax.File) (err error) {
	var check func(n syntax.Node) bool
	check = func(n syntax.Node) bool {
		switch x := n.(type) {
		case *syntax.Redirect:
			if x.Word != nil {
				syntax.Walk(x.Word, check)
			}
			if x.Hdoc != nil {
				syntax.Walk(x.Hdoc, func(n syntax.Node) bool {
					if s, ok := n.(*syntax.CmdSubst); ok {
						syntax.Walk(s, check)
						return false
					}
					return true
				})
			}
			return false
		case *syntax.Word:
			for _, p := range x.Parts {
				if l, ok := p.(*syntax.Lit); ok && err == nil && codeQualifier.MatchString(l.Value) {
					err = fmt.Errorf("a zsh glob qualifier that can run code: %s", l.Value)
				}
			}
		}
		return err == nil
	}
	syntax.Walk(f, check)
	return err
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

// substsAt lists the commands of each substitution in n, landing at h.
func (r *reader) substsAt(n syntax.Node, h at) {
	if n == nil {
		return
	}
	syntax.Walk(n, func(n syntax.Node) bool {
		switch x := n.(type) {
		case *syntax.CmdSubst:
			r.stmts(x.Stmts, h, false)
			return false
		case *syntax.ProcSubst:
			r.stmts(x.Stmts, h, false)
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
			return r.text(x)
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
