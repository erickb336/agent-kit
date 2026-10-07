import { shellCommands, programsRun, commandText } from "./command-reader.mjs";

/** git's options before its subcommand, and the ones that take the next word as their value. */
const GIT_VALUE = /^(?:-C|-c|--git-dir|--work-tree|--namespace|--config-env|--super-prefix)$/;
const subcommand = (words, k) => {
  while (words[k]?.startsWith("-")) k += GIT_VALUE.test(words[k]) ? 2 : 1;
  return words[k] ?? "";
};

/** The provider supplies its state-tool path. This policy only reads command text. */
export function createCommandPolicy({ stateToolPath }) {
  /** Expansion in a command word can hide git, gh, push or merge. Arguments keep their ordinary braces and globs. */
  function expansionProblem(command, cwd) {
    const expansion = /[{[*?]/;
    const expands = (word) => !/^(?:[{}]|\[\[?)$/.test(word) && expansion.test(word); // literal groups and test commands
    const reason = "shell expansion can hide the command. Use literal program and git or gh subcommand words, without {, [, * or ?.";
    let runs;
    try {
      runs = programsRun(command, cwd);
    } catch (e) {
      return expansion.test(command) ? `${reason} The hook cannot read this command (${e.message}).` : undefined;
    }
    for (const { word, args, stdin, piped } of runs) {
      if (expands(word)) return reason;
      const name = word.split("/").pop();
      // A shell can run text from a pipe, including through filters. Its output is unknown: refuse expansion in that text.
      if (piped && commandText(name, args, stdin) === stdin && runnable(shellCommands(command)).some(({ words, bodies }) => [...words, ...bodies].some(expands))) return reason;
      if (name === "git" && expansion.test(subcommand(args, 0))) return reason;
      if (name !== "gh") continue;
      let k = 0;
      for (let n = 0; n < 2; n++) {
        while (args[k]?.startsWith("-")) k += /^(?:-R|--repo)$/.test(args[k]) ? 2 : 1;
        const sub = args[k++] ?? "";
        if (expansion.test(sub)) return reason;
        if (n === 0 && sub !== "pr") break; // api's next word is an endpoint, not a subcommand
      }
    }
    return undefined;
  }

  function harmless([a, b, c, ...rest]) {
    if (a === "echo" || a === "cat" || a === "grep" || (a === "printf" && ![b, c, ...rest].some((w) => w?.startsWith("-v")))) return 1;
    if ((a === "git" && b === "commit") || (a === "node" && b === stateToolPath)) return 2;
    return a === "gh" && b === "pr" && /^(?:create|comment|view|edit)$/.test(c ?? "") ? 3 : 0;
  }
  /** The commands that may end a pipe after a harmless command: they only cut, count or sort its text. */
  const FILTER = /^(?:head|tail|wc|sort|uniq|less)$/;
  const filters = (c) => FILTER.test(c.words[0] ?? "") && c.words.slice(1).every((w) => /^(?:-\w*|\d+)$/.test(w) && !/^-o|^--output/.test(w));
  /** Shell structure that can send a command's output somewhere other than its own line: then no text is harmless. */
  const STRUCTURE = /^(?:[{}!]|if|then|elif|else|fi|for|while|until|do|done|case|esac|select|function|time|coproc|alias|shopt|enable)$/;

  /**
   * The words of each command that can run: all its words and heredoc bodies, except the arguments and heredocs of a
   * harmless command whose output stays harmless. That command is not in a group, not written to a file that a later
   * command could run, is piped on only through filters, and, in a substitution, lands in a harmless argument itself.
   */
  function runnable(commands) {
    const structure = commands.some((c) => STRUCTURE.test(c.words[0] ?? ""));
    const last = commands.at(-1);
    const stays = (c) => !(c.writes && c !== last) && (!c.piped || (c.pipeTo && filters(c.pipeTo) && stays(c.pipeTo)));
    const contained = (c) => {
      const n = harmless(c.words);
      if (!n || structure || c.grouped || !stays(c)) return false;
      return !c.host || (contained(c.host.cmd) && (c.host.index < 0 || c.host.index >= harmless(c.host.cmd.words)));
    };
    return commands.map((c) => (contained(c) ? { cmd: c, words: c.words.slice(0, harmless(c.words)), bodies: [] } : { cmd: c, words: c.words, bodies: c.bodies }));
  }

  return { expansionProblem, runnable };
}
