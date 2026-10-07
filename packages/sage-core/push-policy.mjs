import { resolve } from "node:path";
import { shellCommands } from "./command-reader.mjs";
import { createCommandPolicy, GIT_VALUE, gitSubcommand } from "./command-policy.mjs";

/** Shared push rules. The provider supplies a synchronous reader of the checkout's current branch.
 * This module never executes a command or offers a first-upload exception.
 * Undefined branch evidence retains the existing Claude behavior; a stricter reader can throw.
 */
export function createPushPolicy({ stateToolPath, readBranch, mainReason = "work reaches main only through a pull request. Push the task's branch and open a pull request." } = {}) {
  if (typeof readBranch !== "function") throw new TypeError("readBranch must be a function");
  if (typeof mainReason !== "string" || !mainReason.trim() || mainReason.length > 2048 || /[\x00-\x1f\x7f]/.test(mainReason)) throw new TypeError("mainReason must be a bounded message without control characters");
  const { runnable } = createCommandPolicy({ stateToolPath });
  const PUSH_FORM = 'git [-C <dir>] push [-u] [--follow-tags] [-o <option>] origin <branch>, as a command of its own, with the literal name of the task\'s branch: not main or master, HEAD, @, a pattern, a variable, or a refspec with ":" or "+". To delete a branch: git push --delete origin <branch>';
  /** The word git, and then a later word: one linear scan from the first git (T34, T100-N5). */
  const gitThen = (text, word) => new RegExp(`\\b${word}\\b`, "i").test(/\bgit\b([\s\S]*)/i.exec(text)?.[1] ?? "");
  const pushText = (text) => gitThen(text, "push");
  /** A command line without quotes, backslashes and line joins: the text that the rules test when the reader cannot read the line (fail closed). */
  const bare = (text) => text.replace(/\\\n/g, "").replace(/['"\\]/g, "");
  const refuse = (why) => `${why} Push only with ${PUSH_FORM}.`;
  function pushProblem(command, cwd) {
    let commands;
    try {
      commands = shellCommands(command);
    } catch (e) {
      return pushText(bare(command)) ? refuse(`the hook cannot read this command (${e.message}), so it refuses it. Close each quote, substitution and heredoc.`) : undefined;
    }
    let dir = cwd;
    for (const { cmd, words, bodies } of runnable(commands)) {
      if (cmd.words[0] === "cd" && cmd.words.length === 2) dir = resolve(dir, cmd.words[1]);
      const git = words.findIndex((w, k) => /(?:^|\/)git$/.test(w) && /^push$/i.test(gitSubcommand(words, k + 1)));
      const why = git >= 0 ? pushForm(words, git, dir) : ghApi(words) && words.some((w) => REFS_ENDPOINT.test(w)) && words.some((w) => MAIN_FIELD.test(w)) ? mainReason : [...words, ...bodies].some((w) => /\s/.test(w) && pushText(w)) ? "this command gives push text to another program (a shell, eval or a script), so the hook cannot read the push." : undefined;
      if (why) return refuse(why);
    }
    return undefined;
  }

  /** A ref that git reads as main or master: main, heads/main, refs/heads/main. */
  const MAIN_REF = /^(?:refs\/)?(?:heads\/)?(?:main|master)$/i;
  /** A branch name with no expansion, pattern or special ref in it: not HEAD, @, a variable, a glob or a refspec. */
  const LITERAL = /^(?!-)(?!(?:.*\/)?HEAD$)[^$`*?[\]:+~^\\{}<>|&;!@'"()]+$/i;
  const PUSH_OPTIONS = /^(?:-u|--set-upstream|--follow-tags|-q|--quiet|--no-verify|--delete|-d|-o.*|--push-option=.*)$/;
  /** git accepts a long option by any unambiguous start of its name, such as --forc. */
  const longOption = (word, names) => {
    const name = word.split("=")[0];
    return name.length > 3 && names.some((n) => n.startsWith(name));
  };
  const FORCE = "sage mode never force-pushes. Push a new commit instead.";
  /** Why the git push at words[git] is not the push form, or undefined. dir is where the command runs. */
  function pushForm(words, git, dir) {
    let force = false;
    let main = false;
    let remove = false;
    let other = git > 0 ? `"${words.slice(0, git).join(" ")}" runs this push; the hook reads a push only as a command of its own.` : undefined;
    const names = [];
    let k = git + 1;
    for (; !/^push$/i.test(words[k]); k++) {
      if (words[k] === "-C") dir = resolve(dir, words[k + 1]);
      else other ??= `"${words[k]}" is not part of the push form.`;
      if (GIT_VALUE.test(words[k])) k++;
    }
    for (k++; k < words.length; k++) {
      let w = words[k];
      // A redirection, such as 2>&1, ">/dev/null" or "main>/dev/null": keep only the word before it.
      const r = w.search(/&?[<>]/);
      if (r >= 0) {
        if (w.length === r + /^&?[<>]+&?/.exec(w.slice(r))[0].length) k++; // its target is the next word
        w = /^\d*$/.test(w.slice(0, r)) ? "" : w.slice(0, r);
        if (!w) continue;
      }
      if (w.startsWith("--") ? longOption(w, ["--force", "--force-with-lease", "--force-if-includes"]) : /^-[^-o]*f/.test(w) || w.startsWith("+")) force = true;
      else if (longOption(w, ["--mirror", "--all", "--branches"]) || (!w.startsWith("-") && MAIN_REF.test(w.slice(w.indexOf(":") + 1)))) main = true;
      else if (w === "--delete" || w === "-d") remove = true;
      else if (w === "-o" || w === "--push-option") k++;
      else if (w.startsWith("-") ? !PUSH_OPTIONS.test(w) : names.length && !LITERAL.test(w)) other ??= `"${w}" is not part of the push form.`;
      if (!w.startsWith("-")) names.push(w);
    }
    if (force) return FORCE;
    if (main) return mainReason;
    if (other) return other;
    if (names.length < 2) return "name the remote and the branch: a push with no branch pushes what the checkout's settings say, which can be main.";
    if (names[0] !== "origin") return `push to origin, not to "${names[0]}".`;
    if (remove) return undefined;
    const branch = readBranch(dir);
    if (branch !== undefined && (typeof branch !== "string" || !branch || /[\s\x00-\x1f\x7f]/u.test(branch))) throw new TypeError("readBranch must return a branch name or undefined");
    return branch && MAIN_REF.test(branch) ? `this checkout is on ${branch}. Push from the task's worktree, on the task's branch.` : undefined;
  }

  /** Whether the command is gh api: gh as the command word, as gh or a path that ends in /gh, after any NAME=value, env and command. */
  function ghApi(words) {
    let k = 0;
    while (/^(?:[A-Za-z_]\w*=|env$|command$)/.test(words[k] ?? "")) k++;
    return /(?:^|\/)gh$/.test(words[k] ?? "") && words[k + 1] === "api";
  }

  /** A gh api endpoint of git refs: repos/<o>/<r>/git/refs or repos/<o>/<r>/git/refs/<ref>. */
  const REFS_ENDPOINT = /^\/?repos\/[^/]+\/[^/]+\/git\/refs(?:\/|$)/;
  /** A gh api field that names main or master as the ref, such as -f ref=refs/heads/main. */
  const MAIN_FIELD = /^(?:-[fF]|--(?:raw-)?field=)?ref=(?:refs\/)?(?:heads\/)?(?:main|master)$/i;

  return Object.freeze({ pushProblem });
}
