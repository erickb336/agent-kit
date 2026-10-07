import { shellCommands, programsRun, commandText } from "./command-reader.mjs";
import { PR } from "./pull-request.mjs";

const MERGE_FORM = "gh pr merge <n> --squash --delete-branch --match-head-commit <sha>";
const bare = (text) => text.replace(/\\\n/g, "").replace(/['"\\]/g, "");

/**
 * Text that names a merge: the word gh and the word merge in any order (so also "$G pr merge" or "gh pr $(echo merge)"),
 * a merge path of the REST API, or a GraphQL merge mutation. Each test is one linear scan.
 */
export const mentionsMerge = (text) =>
  (/\bgh\b/i.test(text) && /\bmerge\b/i.test(text)) || (/\bpulls\//i.test(text) && /\/merge\b/i.test(text)) || /\/merges\b|\b(?:mergePullRequest|mergeBranch|enablePullRequestAutoMerge)\b/i.test(text);

/** git's options before its subcommand, and the ones that take the next word as their value. */
export const GIT_VALUE = /^(?:-C|-c|--git-dir|--work-tree|--namespace|--config-env|--super-prefix)$/;
export const gitSubcommand = (words, k) => {
  while (words[k]?.startsWith("-")) k += GIT_VALUE.test(words[k]) ? 2 : 1;
  return words[k] ?? "";
};

/** The provider supplies its state-tool path. This policy only reads command text.
 * A null prPattern preserves diagnostics when a provider has no state tool; its merge check must still refuse.
 */
export function createCommandPolicy({ stateToolPath, prPattern = PR } = {}) {
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
      if (name === "git" && expansion.test(gitSubcommand(args, 0))) return reason;
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

  const CANNOT = `the hook cannot prove that this command is only the merge command, so it refuses it. Merge only with ${MERGE_FORM}, as a command of its own: not through the GitHub API, a variable, a script or another program. Merge text may stand only in the text of echo, printf, cat, grep, git commit, gh pr create, comment, view or edit, or the state tool, and not piped on or written to a file that a later command could run.`;

  /**
   * The merge in a Bash command, by an allow-list. Undefined when the command names no merge outside harmless text.
   * Else { pr, sha } when the whole command is the one merge form, which the merge check then decides, or { problem }.
   */
  function mergeIn(command) {
    const form = mergeForm(command);
    if (form) return form;
    let commands;
    try {
      commands = shellCommands(command);
    } catch (e) {
      return mentionsMerge(bare(command)) ? { problem: `${CANNOT} (It cannot read the command: ${e.message}.)` } : undefined;
    }
    return mentionsMerge(codeText(commands)) || commands.some(expandedMerge) ? { problem: CANNOT } : undefined;
  }

  /** A command whose name comes from an expansion ($'…', $( ), a backtick or $VAR), with the word merge in its words. */
  const expandedMerge = ({ words, bodies }) => /\$/.test(words.find((w) => !/^\w+=/.test(w)) ?? "") && /\bmerge\b/i.test([...words, ...bodies].join(" "));

  /** The merge form, when the command is one gh pr merge with plain words only: { pr, sha }, or { problem }. */
  function mergeForm(command) {
    const text = command.trim();
    const words = text.split(/[ \t]+/);
    if (words.slice(0, 3).join(" ") !== "gh pr merge" || /[^\w \t=-]/.test(text)) return undefined;
    const [, , , pr, ...flags] = words;
    // The default is the shared PR rule. A provider may have no rule when its state tool failed to load.
    if (prPattern && !prPattern.test(pr ?? "")) return { problem: `name the pull request by its number (digits, no leading zero): ${MERGE_FORM}.` };
    const shas = [];
    const modes = new Set();
    for (let k = 0; k < flags.length; k++) {
      const f = flags[k];
      if (f === "--match-head-commit") shas.push(flags[++k] ?? "");
      else if (f.startsWith("--match-head-commit=")) shas.push(f.slice(f.indexOf("=") + 1));
      else if (f === "--squash" || f === "--delete-branch") modes.add(f);
      else return { problem: `merge only with ${MERGE_FORM}; "${f}" is not part of it.` };
    }
    if (!shas.length) return { problem: "merge only the checked commit: add --match-head-commit <the head SHA that the ledger verified>." };
    if (shas.length > 1) return { problem: `give --match-head-commit once, not ${shas.length} times: gh uses the last one, and the merge check reads one.` };
    if (!/^[0-9a-f]{40}$/i.test(shas[0])) return { problem: `--match-head-commit needs the full 40-character head SHA that the ledger verified, not "${shas[0]}".` };
    if (modes.size < 2) return { problem: `merge only with ${MERGE_FORM}: add --squash and --delete-branch.` };
    return { pr, sha: shas[0] };
  }

  function harmless([a, b, c, ...rest]) {
    if (a === "echo" || a === "cat" || a === "grep" || (a === "printf" && ![b, c, ...rest].some((w) => w?.startsWith("-v")))) return 1;
    if ((a === "git" && b === "commit") || (a === "node" && stateToolPath !== undefined && b === stateToolPath)) return 2;
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

  /** The text of a command line that can run. A local "git merge" is not a merge of a pull request, so its subcommand word is left out. */
  const codeText = (commands) =>
    runnable(commands)
      .map(({ words, bodies }) => [...(words[0] === "git" && /^merge(?:-base|-file|-tree)?$/.test(words[1] ?? "") ? [words[0], ...words.slice(2)] : words), ...bodies].join(" "))
      .join("\n");

  return { expansionProblem, mergeIn, runnable };
}
