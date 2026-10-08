import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Programs that run a later word as a program, each with its options that take a value (that value is not the program).
 * A key of two words is a program and its subcommand. The ones after "|" leave a bare kill the shell's builtin.
 */
const PACKAGE_RUNNER = /^-(?:p|c|-package|-call)$/;
const WRAPPER = new Map([
  ["sudo", /^-(?:[acugpCDrtUTRh]|-(?:auth-type|login-class|user|group|prompt|close-from|chdir|chroot|role|type|other-user|command-timeout|host))$/],
  ["doas", /^-[uC]$/],
  ["env", /^-(?:[uCP]|-(?:unset|chdir))$/],
  ["nice", /^-(?:n|-adjustment)$/],
  ["timeout", /^-(?:[sk]|-(?:signal|kill-after))$/],
  ["gtimeout", /^-(?:[sk]|-(?:signal|kill-after))$/],
  ["xargs", /^-(?:[IJLnPsEdaRS]|-(?:replace|max-lines|max-args|max-procs|max-chars|eof|delimiter|arg-file))$/],
  ["exec", /^-a$/],
  ["stdbuf", /^-(?:[ioe]|-(?:input|output|error))$/],
  ["caffeinate", /^-[tw]$/],
  ["watch", undefined],
  ...["npx", "bunx", "npm exec", "pnpm dlx"].map((name) => [name, PACKAGE_RUNNER]),
  ...["nohup", "command", "builtin", "time", "noglob", "nocorrect"].map((name) => [name, undefined]),
]);
// Include flag-only names too, so an abbreviated long option must be unique across the wrapper's options.
const WRAPPER_LONG_OPTIONS = new Map([
  ["sudo", "background preserve-env edit set-home login remove-timestamp list preserve-groups shell other-user validate askpass auth-type bell close-from login-class chdir group help host reset-timestamp no-update non-interactive prompt chroot role stdin command-timeout type user version"],
  ["nice", "adjustment help version"],
  ...["timeout", "gtimeout"].map(name => [name, "signal kill-after foreground preserve-status verbose help version"]),
  ["xargs", "replace max-lines max-args max-procs max-chars eof delimiter arg-file null interactive no-run-if-empty verbose exit show-limits open-tty help version"],
  ["stdbuf", "input output error help version"],
  ...["npx", "bunx", "npm exec", "pnpm dlx"].map(name => [name, "package call yes no quiet bun help version"]),
  ["nohup", "help version"],
].map(([name, options]) => [name, options.split(" ")]));

function longOptionName(option, names = []) {
  const prefix = option.slice(2).split("=")[0];
  if (names.includes(prefix)) return prefix;
  const matches = names.filter(name => name.startsWith(prefix));
  if (matches.length !== 1) throw evidenceError(`unknown or ambiguous wrapper option ${option}`);
  return matches[0];
}

/** Shell keywords before a command: the command after them runs in the same shell. After for, select or case come words, not a program. */
const KEYWORD = /^(?:!|\{|\}|if|then|elif|else|fi|while|until|do|done|esac|coproc)$/;
const LIST = /^(?:for|select|case)$/;
const SHELLS = /^(?:sh|bash|zsh|dash|ksh|fish)$/;

/**
 * The programs that a command line runs, for the hook's rules on agents (agentProblem) and on the state tool (T83).
 * Each is { word, file, args, dir, path, stdin, piped }, in the order of the command line:
 *   - word: the program as written, after shell keywords (if, while, do, !, {), assignments (X=1), redirections
 *     (2>/dev/null, >out) and wrappers with their options (sudo, env, timeout, xargs, nice, npx, npm exec, pnpm dlx,
 *     bunx and others in WRAPPER). After for, select and case come words, not a program; a case pattern is not one.
 *   - file: the real file that runs, found through PATH (a PATH=… before it, or an earlier export PATH=…) and links,
 *     from dir. Undefined for a bare kill (the shell's builtin, unless a wrapper such as sudo or xargs runs it), for a
 *     word with a variable, ~ or a substitution, and for a program that is not found.
 *   - args: the words after the program, without their quotes and redirections.
 *   - dir: the folder it runs in, after an earlier "cd <dir>" of the same line.
 *   - path: its effective PATH, after assignments and wrappers.
 *   - stdin: its heredoc and here-string bodies, and the words of the command piped into it.
 *   - piped: whether another command supplies its stdin through a pipe; a heredoc alone is not a pipe.
 * It also reads the text that other programs run as commands, up to 3 levels deep: the -c text of a shell (sh, bash,
 * zsh, dash, ksh, fish) and its stdin heredoc when it has no script, the words of eval, PowerShell's -Command text,
 * the program of find -exec, and a program word with spaces that a wrapper such as watch gives to sh -c. The words
 * after a script (bash ./x.sh kill) are the script's arguments, not programs. Each $( ) or backtick is a command of its
 * own, and so is each <( ) and >( ). It cannot see a program in a variable ($P), in text piped into a shell, or inside a script.
 * With executableEvidence, also retain external wrappers and literal command names. Wrapper options own their values;
 * shell syntax and builtin wrappers are not external executable evidence. Both views use the same semantic traversal.
 * Throws when the shell reader cannot read the line (see shellCommands), and for text nested more than 3 levels deep.
 */
export function programsRun(command, cwd, path = process.env.PATH ?? "", { executableEvidence = false } = {}) {
  const found = { leaves: [], executables: [] };
  readPrograms(command, cwd, path, 0, found);
  return executableEvidence ? found.executables : found.leaves;
}

const WATCH_OPTIONS = [
  "beep", "color", "no-color", "differences", "help", "interval", "errexit", "follow", "chgexit",
  "equexit", "exec", "precise", "no-rerun", "shotsdir", "no-title", "no-wrap", "version",
];

// watch stops its options at the first command word. Only -x/--exec preserves literal argv.
function watchOptions(words, next) {
  let shellText = true;
  for (; /^-./.test(words[next] ?? ""); next++) {
    const option = words[next];
    if (option === "--") { next++; break; }
    if (option.startsWith("--")) {
      const name = longOptionName(option, WATCH_OPTIONS);
      if (name === "exec" && !option.includes("=")) shellText = false;
      else if (/^(?:interval|equexit|shotsdir)$/.test(name ?? "") && !option.includes("=")) next++;
      continue;
    }
    for (let i = 1; i < option.length; i++) {
      const flag = option[i];
      if (flag === "x") shellText = false;
      if (/[nqs]/.test(flag)) { // a required value is attached or is the next word
        if (i === option.length - 1) next++;
        break;
      }
      if (flag === "d") break; // an optional differences value must be attached: -dx consumes x
    }
  }
  return { next, shellText };
}

const ENV_OPTIONS = {
  "argv0": "a", "ignore-environment": "i", "env0-from": "value", "null": "0", "unset": "u", "chdir": "C",
  "default-signal": "optional", "ignore-signal": "optional", "block-signal": "optional",
  "list-signal-handling": "flag", "debug": "v", "quoting-style": "value", "split-string": "S", "help": "flag", "version": "flag",
};

const evidenceError = message => Object.assign(new Error(message), { code: "SAGE_EXECUTABLE_EVIDENCE" });

/** env -S splits argv, not shell commands. Refuse unknown expansion instead of losing executable evidence. */
function envSplit(text) {
  const words = [];
  let word, quote;
  const add = value => { word = (word ?? "") + value; };
  const end = () => { if (word !== undefined) words.push(word); word = undefined; };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if ((char === "'" || char === '"') && (!quote || quote === char)) {
      quote = quote ? undefined : char;
      add("");
    } else if (/\s/.test(char) && !quote) end();
    else if (char === "#" && word === undefined) break;
    else if (char === "$" && quote !== "'") throw evidenceError("env split-string contains an unresolved variable");
    else if (char === "\\" && (quote !== "'" || ["\\", "'"].includes(text[i + 1]))) {
      const escape = text[++i];
      if (escape === "_" && quote !== '"') end();
      else if (escape === "c" && quote !== '"') break;
      else if (escape === "_" && quote === '"') add(" ");
      else if (["'", '"', "#", "$", "\\"].includes(escape)) add(escape);
      else if (Object.hasOwn({ f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" }, escape)) add({ f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" }[escape]);
      else throw evidenceError("env split-string contains an invalid escape");
    } else add(char);
  }
  if (quote) throw evidenceError("env split-string has an open quote");
  end();
  return words;
}

function wrapperArguments(words, next, wrapper, path, dir) {
  let splits = 0, chdir;
  while (next < words.length) {
    const word = words[next];
    // sudo resumes option parsing after an assignment. env consumes assignments only after its options.
    if (wrapper === "sudo" && !word.startsWith("-") && word[0] !== "/" && word[0] !== "=" && word.includes("=")) {
      if (/^PATH=/.test(word)) path = word.slice(5).replace(/\$\{?PATH\}?(?!\w)/g, path);
      next++;
      continue;
    }
    if (!/^-./.test(word)) break;
    const option = words[next++];
    if (option === "--") break;
    if (wrapper !== "env") {
      const takesValue = WRAPPER.get(wrapper);
      let flag = option.split("=")[0], value;
      if (option.startsWith("--")) {
        flag = `--${longOptionName(option, WRAPPER_LONG_OPTIONS.get(wrapper))}`;
        if (takesValue?.test(flag)) value = option.includes("=") ? option.slice(option.indexOf("=") + 1) : words[next++];
      } else {
        const index = [...option].findIndex((char, i) => i > 0 && takesValue?.test(`-${char}`));
        if (wrapper === "sudo" && !/^[AaBbCcDEegHhiKklNnPpRrSsTtUuVv]+$/.test(option.slice(1, index < 0 ? undefined : index + 1))) {
          throw evidenceError(`unknown sudo option ${option}`);
        }
        if (index >= 0) {
          flag = `-${option[index]}`;
          value = option.slice(index + 1) || words[next++];
        }
      }
      if (takesValue?.test(flag) && value === undefined) throw evidenceError(`${wrapper} option has no value`);
      if (wrapper === "sudo" && (flag === "-D" || flag === "--chdir")) chdir = value;
      continue;
    }
    let flags;
    if (option.startsWith("--")) {
      const name = longOptionName(option, Object.keys(ENV_OPTIONS));
      flags = [ENV_OPTIONS[name]];
    } else flags = [...option.slice(1)];
    for (let i = 0; i < flags.length; i++) {
      const flag = flags[i];
      if (!["a", "u", "C", "P", "S", "value"].includes(flag)) continue;
      const attached = option.startsWith("--") ? (option.includes("=") ? option.slice(option.indexOf("=") + 1) : undefined) : flags.slice(i + 1).join("") || undefined;
      const value = attached ?? words[next++];
      if (value === undefined) throw evidenceError("env option has no value");
      if (flag === "S") {
        if (++splits > 4) throw evidenceError("env split-string nested more than 4 levels deep");
        const expanded = envSplit(value);
        words.splice(next, 0, ...expanded);
      } else if (flag === "P") path = value;
      else if (flag === "C") chdir = value;
      break;
    }
  }
  if (wrapper === "timeout" || wrapper === "gtimeout") next++; // only timeout owns a duration operand
  if (wrapper === "env" && words[next] === "-") next++;
  if (wrapper === "env") {
    while (words[next]?.includes("=")) {
      const word = words[next++];
      if (/^PATH=/.test(word)) path = word.slice(5).replace(/\$\{?PATH\}?(?!\w)/g, path);
    }
  }
  return { next, path, dir: chdir === undefined ? dir : resolve(dir, chdir), split: splits > 0 };
}

function readPrograms(command, dir, path, depth, found) {
  const emit = (run, wrapper = false) => {
    found.executables.push(run);
    if (!wrapper) found.leaves.push(run);
  };
  const inner = (text, at, here, transformed = false) => {
    try {
      if (depth === 3) throw new Error("commands nested more than 3 levels deep");
      readPrograms(text, at, here, depth + 1, found);
    } catch (error) {
      if (transformed) error.code = "SAGE_EXECUTABLE_EVIDENCE";
      throw error;
    }
  };
  const commands = shellCommands(command);
  for (const c of commands) {
    const { bodies, syntax } = c;
    const words = [...c.words];
    const set = (w) => /^PATH=/.test(w) && w.slice(5).replace(/\$\{?PATH\}?(?!\w)/g, path);
    const exported = words[0] === "export" && words.slice(1).filter(word => /^PATH=/.test(word)).at(-1);
    if (exported) path = set(exported);
    let here = path;
    let at = dir; // a wrapper chdir belongs to this command, not the following shell command
    let viaExec = false;
    let transformed = false;
    let argv = false; // external wrappers pass argv; shell modifiers retain assignment and keyword grammar
    for (let k = 0; k < words.length; k++) {
      const w = words[k];
      const name = w.split("/").pop();
      const assignment = !argv && syntax[k]?.assignment;
      const keyword = !argv && !syntax[k]?.quoted;
      if (assignment && /^PATH=/.test(w)) here = set(w);
      if (assignment || (keyword && KEYWORD.test(w))) continue;
      if (keyword && LIST.test(w)) break;
      if (keyword && w === "function" && ++k) continue; // the function name is not a program
      const file = program(w, at, here);
      const lexicalWrapper = !argv && !w.includes("/") && (/^(?:command|builtin|exec)$/.test(name) || (keyword && /^(?:time|noglob|nocorrect)$/.test(name)));
      const wrapperNames = lexicalWrapper ? [name] : [file?.split("/").pop(), name].filter(Boolean);
      const wrapper = wrapperNames.flatMap(base => [`${base} ${words[k + 1]}`, base]).find(key => WRAPPER.has(key));
      if (wrapper) {
        const modifier = keyword && !w.includes("/") && /^(?:time|noglob|nocorrect)$/.test(name);
        const external = viaExec || w.includes("/") || (!modifier && !/^(?:command|builtin|exec)$/.test(name));
        if (external) emit({ word: w, file, args: words.slice(k + 1), dir: at, path: here, stdin: [], piped: false }, true);
        if (wrapper.includes(" ")) k++;
        if (modifier) {
          if (name === "time" && words[k + 1] === "-p") k++;
          if (name === "time" && words[k + 1] === "--") k++;
          continue;
        }
        viaExec ||= external || name === "exec";
        argv = true;
        if (wrapper === "watch") {
          const watched = watchOptions(words, k + 1);
          if (watched.shellText) {
            inner(words.slice(watched.next).join(" "), at, here, transformed);
            break;
          }
          k = watched.next - 1;
        } else {
          const wrapped = wrapperArguments(words, k + 1, wrapper, here, at);
          k = wrapped.next - 1;
          here = wrapped.path;
          at = wrapped.dir;
          transformed ||= wrapped.split;
        }
        continue;
      }
      const args = words.slice(k + 1);
      const pipes = commands.filter((p) => p.pipeTo === c);
      const stdin = [...bodies, ...pipes.map((p) => p.words.join(" "))];
      emit({ word: w, file: w === "kill" && !viaExec ? undefined : file, args, dir: at, path: here, stdin, piped: pipes.length > 0 });
      for (const text of commandText(name, args, bodies)) inner(text, at, here, transformed);
      const exec = args.findIndex((a) => /^-(?:exec|execdir|ok|okdir)$/.test(a)); // find … -exec kill {} ;
      if (exec >= 0 && args[exec + 1]) {
        const end = args.findIndex((a, j) => j > exec && /^[;+]$/.test(a));
        emit({ word: args[exec + 1], file: program(args[exec + 1], at, here), args: args.slice(exec + 2, end < 0 ? undefined : end), dir: at, path: here, stdin: [], piped: false });
      }
      break;
    }
    if (words.length && words.every((word, index) => syntax[index]?.assignment)) path = here;
    if (words[0] === "cd" && words.length === 2) dir = resolve(dir, words[1]); // for the commands after it
  }
}

/** The text that a shell, eval or PowerShell runs as commands: -c text, eval's words, or stdin when there is no script. */
export function commandText(name, args, bodies) {
  if (name === "eval") return [args.join(" ")];
  if (/^(?:pwsh|powershell)(?:\.exe)?$/i.test(name)) {
    const c = args.findIndex((a) => /^-c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?$/i.test(a));
    return c >= 0 ? [args.slice(c + 1).join(" ")] : [];
  }
  if (!SHELLS.test(name)) return [];
  let k = 0;
  let text = false;
  let stdin = false;
  for (; /^[-+]./.test(args[k] ?? "") && args[k] !== "--"; k++) {
    if (/^-[a-zA-Z]*c/.test(args[k]) || args[k] === "--command") text = true;
    if (/^-[a-zA-Z]*s/.test(args[k])) stdin = true;
    if (/^[-+][a-zA-Z]*[oO]$|^--(?:rcfile|init-file)$/.test(args[k])) k++; // an option with a value: -o pipefail
  }
  if (args[k] === "--") k++;
  if (text) return args[k] === undefined ? [] : [args[k]]; // the words after it are $0, $1, …
  return stdin || args[k] === undefined ? bodies : []; // with a script, the words and stdin are the script's
}

/** The real file that a program word runs, through PATH and links; undefined when it has a variable or is not found. */
function program(word, dir, path) {
  for (const file of word.includes("/") ? [word] : path.split(":").map((d) => `${d || "."}/${word}`)) {
    if (/[$`~]/.test(file)) return undefined; // the shell would expand it, so the hook cannot tell which file runs
    try {
      const real = realpathSync.native(resolve(dir, file)); // native: the name on disk, so "PS" on macOS is ps
      if (statSync(real).isFile() && statSync(real).mode & 0o111) return real;
    } catch {}
  }
  return undefined;
}

/**
 * The simple commands of a shell command line: { words, bodies, host, piped, pipeTo, grouped, writes }. The words lose their
 * quotes and redirections (2>/dev/null, >out, <in, with their targets); syntax retains quote and assignment eligibility; the bodies are the command's heredocs and
 * here-strings, which stay text. The patterns of a case arm ("top)") are not commands. A command substitution, $( ) or a backtick, gives
 * commands of its own, whose host is the command and word they land in (index -1: a heredoc), and so does a process
 * substitution, <( ) or >( ). Throws when it cannot read the line: an open quote, substitution, heredoc, "(" or case,
 * or a ")" with no "(". The hook's rules then refuse a line that names what they guard (fail closed).
 */
export function shellCommands(src) {
  const out = [];
  readCommands(src, 0, "", out, undefined);
  return out;
}

function readCommands(src, i, close, out, host) {
  const fresh = () => ({ words: [], syntax: [], bodies: [], host, piped: false, grouped: false, writes: false, redirects: [], heredoc: false });
  let cmd = fresh();
  let word;
  let quoted = false, assignment = false;
  let depth = 0;
  let target; // after a redirection: its operator, kept with its target in redirects, or "body" for the text of a here-string
  const cases = []; // each open case: { depth } where it opens, and pattern: true before an arm's ")", false after it
  const arm = () => (cases.at(-1)?.depth === depth ? cases.at(-1) : undefined); // the case whose arms are read at this depth
  const heredocs = [];
  const add = (text) => (word = (word ?? "") + text);
  const endWord = () => {
    if (word === undefined) return;
    if (target === "body") cmd.bodies.push(word);
    else if (target) cmd.redirects.push(target + word);
    else { cmd.words.push(word); cmd.syntax.push({ quoted, assignment }); }
    word = target = undefined;
    quoted = assignment = false;
    const [first, , third] = cmd.words;
    if (first === "case" && !cmd.syntax[0].quoted && cmd.words.length === 3 && third === "in" && !cmd.syntax[2].quoted) {
      endCommand();
      cases.push({ depth, pattern: true });
    } else if (first === "esac" && !cmd.syntax[0].quoted && cmd.words.length === 1 && arm()) cases.pop();
  };
  const endCommand = () => {
    endWord();
    if (target) throw new Error("a redirection with no target");
    cmd.grouped ||= depth > 0;
    if ((cmd.words.length || cmd.heredoc || cmd.redirects.length) && !arm()?.pattern) out.push(cmd); // a bare "> file" is a command: it writes (T83-R6-BAREREDIRECT)
    cmd = fresh();
  };
  const here = () => ({ cmd, index: cmd.words.length });
  while (i < src.length) {
    const c = src[i];
    const esac = word === "esac" && !quoted && !cmd.words.length; // "esac)" closes a $( ), and "esac |" pipes the case on
    if (arm()?.pattern && "()|".includes(c) && !esac) { // a case arm: "(a|b)" or "a)"; its pattern runs nothing
      endWord();
      if (cmd.words.length > 1) throw new Error("a case pattern of more than one word"); // a shell refuses it too
      cmd = fresh();
      if (c === ")") arm().pattern = false;
      i++;
      continue;
    }
    if (arm()?.pattern === false && c === ";" && ";&".includes(src[i + 1])) { // ;; ;& ;;& end an arm
      endCommand();
      arm().pattern = true;
      i += src.startsWith(";;&", i) ? 3 : 2;
      continue;
    }
    if (c === close && depth === 0) {
      if (heredocs.length) throw new Error("an open heredoc");
      endCommand();
      if (cases.length) throw new Error("a case with no esac");
      return i + 1;
    }
    if (c === "\\") {
      if (src[i + 1] !== "\n") { quoted = true; add(src[i + 1] ?? ""); }
      i += 2;
    } else if (c === "'") {
      quoted = true;
      const j = src.indexOf("'", i + 1);
      if (j < 0) throw new Error("an open quote");
      add(src.slice(i + 1, j));
      i = j + 1;
    } else if (c === '"') {
      quoted = true;
      const r = readExpanding(src, i + 1, '"', out, here());
      add(r.text);
      i = r.i;
    } else if (c === "`" || (c === "$" && src[i + 1] === "(")) {
      i = readCommands(src, i + (c === "`" ? 1 : 2), c === "`" ? "`" : ")", out, here());
      add("$(…)");
    } else if ((c === "<" || c === ">") && src[i + 1] === "(") { // a process substitution, <( ) or >( ): commands of its own
      i = readCommands(src, i + 2, ")", out, here());
      add("$(…)");
    } else if (c === "#" && word === undefined) {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (src.startsWith("<<<", i)) {
      endWord();
      target = "body";
      i += 3;
    } else if (src.startsWith("<<", i)) {
      endWord();
      cmd.heredoc = true;
      i = readDelimiter(src, i + 2, heredocs, cmd);
    } else if (c === "\n") {
      endCommand();
      i = readBodies(src, i + 1, heredocs, out);
    } else if (c === " " || c === "\t") {
      endWord();
      i++;
    } else if (c === ">" || c === "<" || (c === "&" && src[i + 1] === ">")) {
      // A redirection: >, >>, >|, >&, &>, &>>, <, <>, <&, with the number or {name} of its file descriptor before it.
      // It and its target are not words, so ps>out and 2>/dev/null ps run ps.
      if (!quoted && /^(?:\d+|\{\w+\})$/.test(word ?? "")) word = undefined;
      endWord();
      const op = /^(?:&>>?|>>|>\||>&|<>|<&|>|<)/.exec(src.slice(i, i + 3))[0];
      cmd.writes ||= op.includes(">");
      target = op;
      i += op.length;
    } else if (c === "|" && src[i + 1] !== "|") {
      const from = cmd;
      from.piped = true;
      endCommand();
      from.pipeTo = cmd;
      i++;
    } else if (c === ";" || c === "&" || c === "|" || c === "(" || c === ")") {
      if (c === ")" && !depth) throw new Error('a ")" with no "("');
      endCommand();
      if (c === "(") depth++;
      if (c === ")" && cases.at(-1)?.depth === depth--) throw new Error("a case with no esac");
      i += (c === "|" || c === "&") && src[i + 1] === c ? 2 : 1;
    } else {
      if (c === "=" && !quoted && /^[A-Za-z_]\w*$/.test(word ?? "")) assignment = true;
      add(c);
      i++;
    }
  }
  if (close) throw new Error(close === ")" ? "an open $(" : "an open backtick");
  if (heredocs.length) throw new Error("an open heredoc");
  endCommand();
  if (depth) throw new Error('an open "("');
  if (cases.length) throw new Error("a case with no esac");
  return i;
}

/** Double-quoted text, or a heredoc body that expands (stop ""): its text, and the commands of its substitutions. */
function readExpanding(src, i, stop, out, host) {
  let text = "";
  while (i < src.length && src[i] !== stop) {
    const c = src[i];
    if (c === "\\" && i + 1 < src.length) {
      text += '$`"\\'.includes(src[i + 1]) ? src[i + 1] : src[i + 1] === "\n" ? "" : c + src[i + 1];
      i += 2;
    } else if (c === "`" || (c === "$" && src[i + 1] === "(")) {
      i = readCommands(src, i + (c === "`" ? 1 : 2), c === "`" ? "`" : ")", out, host);
      text += "$(…)";
    } else {
      text += c;
      i++;
    }
  }
  if (stop && i >= src.length) throw new Error("an open quote");
  return { text, i: i + 1 };
}

/** The delimiter after "<<" or "<<-". A quoted delimiter makes the body plain text, with no substitutions. */
function readDelimiter(src, i, heredocs, cmd) {
  const strip = src[i] === "-";
  if (strip) i++;
  while (src[i] === " " || src[i] === "\t") i++;
  let delimiter = "";
  let quoted = false;
  while (i < src.length && !/[\s;&|()<>]/.test(src[i])) {
    const c = src[i];
    if (c === "'" || c === '"') {
      const j = src.indexOf(c, i + 1);
      if (j < 0) throw new Error("an open quote");
      delimiter += src.slice(i + 1, j);
      i = j + 1;
      quoted = true;
    } else if (c === "\\") {
      delimiter += src[i + 1] ?? "";
      i += 2;
      quoted = true;
    } else {
      delimiter += c;
      i++;
    }
  }
  if (!delimiter) throw new Error("a heredoc with no delimiter");
  heredocs.push({ delimiter, strip, expand: !quoted, cmd });
  return i;
}

/** The bodies of the heredocs that the last line opened, read up to each delimiter line, given to their commands. */
function readBodies(src, i, heredocs, out) {
  for (const { delimiter, strip, expand, cmd } of heredocs.splice(0)) {
    const lines = [];
    for (;;) {
      if (i >= src.length) throw new Error("an open heredoc");
      const end = src.indexOf("\n", i) < 0 ? src.length : src.indexOf("\n", i);
      const line = src.slice(i, end);
      i = end + 1;
      if ((strip ? line.replace(/^\t+/, "") : line) === delimiter) break;
      lines.push(line);
    }
    const body = lines.join("\n");
    cmd.bodies.push(body);
    if (expand) readExpanding(body, 0, "", out, { cmd, index: -1 });
  }
  return Math.min(i, src.length);
}
