#!/usr/bin/env node
// The sage hook. Claude Code sends one JSON event on stdin; the hook answers with one JSON object on stdout, or nothing.
//   - "sage mode" makes the session the user's chief of staff (agents/chief-of-staff.md) until "sage mode off". A
//     session that starts as the sage:chief-of-staff agent is in sage mode from its first event. Only the user's own
//     words switch a mode on, or sage mode off: never an agent's report, a task notification or another session's
//     message (promptOf). When the hook cannot read the frames of a prompt, nothing in it switches a mode on (fail
//     closed). An autopilot off counts in any text, also in a frame.
//   - In sage mode it holds the rules that prompts alone did not hold in Orchestrator (docs/design/sage-mode.html,
//     "Rules"): the chief never edits files, every brief has all its fields, at most max_agents sage agents run at
//     once, nobody force-pushes or pushes to main, and a merge needs autopilot on, the checked head SHA and the clean
//     cycles that the ledger records for it (the merge check). The merge rule and the push rule are allow-lists: a
//     command that names a merge or runs a push is refused unless it is exactly the merge form or the push form, or the
//     merge text stands only in a harmless command's text.
//   - A sage agent may finish only with the full report of the sage:report skill.
// SAGE_HOOKS=off turns it off. The hook never breaks a session: on an error it answers nothing, but it refuses a merge
// or a push.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The state tool. When it cannot load, the hook still runs, and its merge check refuses every merge.
const stateTool = await import("../skills/sage/sage.mjs").catch((error) => ({ error }));
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// The mode phrases, in a message from the user (promptOf). "sage mode" (also "sage mode on"), "sage mode off" and
// "autopilot on" count only at the start of the message, so that a mention or a quote switches nothing: "sage mode
// off" also drops the git rules. "sage mode" and "autopilot on" must stand alone or end at ".", ",", ":", ";", "!" or
// the end of their line, so "autopilot on?" and "autopilot on main" switch nothing. "sage mode off" must not run on into
// a longer word ("sage mode off-topic"), and its line must have no "?" ("sage mode off? what does it do?"). Because a
// missed off is the unsafe one, any line that starts with "sage mode off" or "autopilot off" switches autopilot off,
// even as a question or in a frame. The owner's own text also switches it off when it mentions autopilot and has an off
// word anywhere. A frame does not, because its boilerplate has off words ("NOT a message from the user"). Off wins over
// on. Only OFF_LINE has the m flag: with it, "^" also matches the start of each later line.
const START = String.raw`^[\s"'“‘*_>-]*`;
const SP = String.raw`[^\S\r\n  ]`; // a space, a tab or an NBSP, never a line break
const END = String.raw`(?=${SP}*(?:[.,:;!\r\n  ]|$))`;
const SAGE = String.raw`(?:enter${SP}+)?sage${SP}+mode(?:${SP}+on)?`;
const AND_AUTOPILOT = String.raw`(?:${SP}+autopilot|(?:${SP}*[.,:;!]${SP}*|${SP}+)autopilot${SP}+on)`; // "sage mode autopilot", "sage mode, autopilot on"
const SAGE_ON = new RegExp(`${START}${SAGE}${AND_AUTOPILOT}?${END}`, "i");
const OFF_LINE = new RegExp(`${START}(?:sage${SP}+mode|autopilot)${SP}+off\\b`, "im"); // in any text, at the start of any line
const SAGE_OFF = new RegExp(`${START}sage${SP}+mode${SP}+off(?![\\p{L}\\p{N}-])(?!.*\\?)`, "iu"); // "." stops at a line break
const AUTOPILOT_ON = new RegExp(`${START}(?:autopilot${SP}+on|${SAGE}${AND_AUTOPILOT})${END}`, "i");
// The word autopilot, and the off words in any form ("no more", "turn off", "switch off" and "hold off" have one too).
const AUTOPILOT = /\bauto[-\s]?pilots?\b/i;
const OFF_WORD = /\b(?:off|no|without|don['’]?t|do\s+not|end(?:s|ed|ing)?|quit(?:s|ting)?|exit(?:s|ed|ing)?)\b|\b(?:stop|disabl|paus|cancel|kill|halt|deactivat|abort|suspend)|\bauto[-\s]?pilots?\s*=\s*false\b/i;
const broadOff = (text) => OFF_LINE.test(text) || (AUTOPILOT.test(text) && OFF_WORD.test(text));
const FILE_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit)$/;
const AGENT_TOOLS = /^(Agent|Task)$/;
const CHIEF = /(^|:)chief-of-staff$/;
const OURS = /^sage:/;
export const BRIEF_FIELDS = ["GOAL", "SCOPE", "CONTEXT", "DECISIONS", "ACCEPTANCE", "VERIFY", "BUDGET", "FORBIDDEN", "REPORT", "STANDING"];
export const REPORT_FIELDS = ["STATUS", "RESULT", "EVIDENCE", "FINDINGS", "QUESTIONS", "NOT VERIFIED", "BRANCH"];
/** The fields of a template that do not start a line. Markdown around a field ("**STATUS**", "| STATUS |") is fine. */
const missingFields = (fields, text) => fields.filter((f) => !new RegExp(`^[\\s*_#|>-]*${f}\\b`, "m").test(text ?? ""));

/**
 * A prompt: whether the owner wrote it, and the owner's text. Claude Code sends no sender field: a live capture of a
 * UserPromptSubmit hook in 2.1.289 has session_id, transcript_path, cwd, prompt_id, permission_mode, hook_event_name
 * and prompt, and its docs name no sender field either. So the hook reads the sender from the prompt. Claude Code puts
 * an agent's report, a task notification, another session's message and a system reminder in frames, and it can join
 * the owner's message to them. A frame closes only with a close of its own kind. Another session's message closes with
 * the note that Claude Code puts after it, so the note is part of the frame.
 *   - text: the text before the first frame and after the last close. An agent cannot write there, also when it
 *     writes a close in its report, because the real close comes after it. The owner's message that Claude Code queues
 *     while it works (QUEUED) is the owner's text, although it comes in a system reminder.
 *   - owner: false when the hook cannot read the frames (fail closed): a kind with more opens than closes or more
 *     closes than opens, or a frame's marker in the text. Then nothing in the prompt switches a mode on.
 *   - queued: the owner's queued messages, also when they come between two frames. They count only for an off,
 *     because an agent can write the queued shape in its report.
 */
const FRAMES = [
  [/<task-notification>/g, /<\/task-notification>/g],
  [/<agent-message[\s>]/g, /<\/agent-message>/g],
  [/^[^\S\n]*Another Claude session sent a message:/gm, /^[^\S\n]*That "other Claude session"[^\n]*/gm],
  [/<system-reminder>/g, /<\/system-reminder>/g],
];
const QUEUED = /<system-reminder>\s*The user sent a new message while you were working:\n([\s\S]*?)(?:\n\nThis is how Claude Code surfaces messages[^<]*)?<\/system-reminder>/g;
const MARKERS = /\[Subagent hand-back\]|\[SYSTEM NOTIFICATION/i;
export function promptOf(input) {
  const prompt = (input.prompt ?? "").replace(QUEUED, "\n$1\n");
  const marks = FRAMES.map(([open, close]) => [[...prompt.matchAll(open)], [...prompt.matchAll(close)]]);
  const opens = marks.flatMap(([o]) => o).map((m) => m.index);
  const ends = marks.flatMap(([, c]) => c).map((m) => m.index + m[0].length);
  const text = opens.length ? [prompt.slice(0, Math.min(...opens)), prompt.slice(Math.max(...ends, 0))].join("\n") : prompt;
  const balanced = marks.every(([o, c]) => o.length === c.length);
  const queued = [...(input.prompt ?? "").matchAll(QUEUED)].map((m) => m[1]);
  return { owner: balanced && !MARKERS.test(text), text, queued, all: prompt };
}

/**
 * Switches the modes, and returns the notes for the chief. Only the owner's own text switches sage mode or autopilot
 * on, or sage mode off. Off is the safe direction, so an autopilot off counts in more text: the broad off rule in the
 * owner's text and queued messages (in the whole prompt when the hook cannot read the frames), and an off line
 * anywhere. A sage mode off that is not the owner's switches only autopilot off, so that the git rules stay.
 */
function switchModes({ owner, text, queued, all }, state) {
  const notes = [];
  if (owner && SAGE_OFF.test(text)) {
    Object.assign(state, { sage: false, given: false, autopilot: false });
    notes.push("sage: sage mode is off. You may change files yourself again.");
  } else if (owner && SAGE_ON.test(text)) state.sage = true;
  if (OFF_LINE.test(all) || broadOff(owner ? [text, ...queued].join("\n") : all)) {
    if (state.autopilot) notes.push("sage: autopilot is off. Work stops at verified, and the user merges.");
    state.autopilot = false;
  } else if (owner && state.sage && AUTOPILOT_ON.test(text)) {
    state.autopilot = true;
    notes.push(`sage: autopilot is on. A pull request merges after ${stateTool.config().autopilot_cycles} clean cycles on its head SHA, with gh pr merge <n> --squash --delete-branch --match-head-commit <sha>.`);
  }
  return notes;
}

export function handle(input, state, slots) {
  const event = input.hook_event_name;
  const main = !input.agent_id; // Claude Code sets agent_id only for a subagent's events
  if (main && CHIEF.test(input.agent_type ?? "")) state.sage = true;

  if (event === "UserPromptSubmit") {
    const notes = switchModes(promptOf(input), state);
    if (state.sage && !state.given) {
      state.given = true;
      notes.unshift(chiefText());
    }
    return notes.length ? context(event, notes.join("\n\n---\n\n")) : undefined;
  }
  if (event === "PostCompact") {
    state.given = false; // the compaction can drop the instructions, so give them again at the next prompt
    return undefined;
  }
  if (event === "SubagentStart") return void (OURS.test(input.agent_type ?? "") && slots.bind(input.agent_id));
  if (event === "SubagentStop") {
    // A sage agent finishes only with the full report. The second stop goes through, so this cannot loop.
    if (OURS.test(input.agent_type ?? "") && !input.stop_hook_active && typeof input.last_assistant_message === "string") {
      const missing = missingFields(REPORT_FIELDS, input.last_assistant_message);
      if (missing.length) return { decision: "block", reason: `sage: your report has no ${missing.join(", ")}. End with the report of the sage:report skill: ${REPORT_FIELDS.join(", ")}, each at the start of a line, with "none" where a field has nothing.` };
    }
    return void slots.release(input.agent_id);
  }
  if (event === "PostToolUseFailure" && AGENT_TOOLS.test(input.tool_name ?? "")) return void slots.drop(input.tool_use_id);
  if (event !== "PreToolUse" || !state.sage) return undefined;

  const tool = input.tool_name ?? "";
  const ti = input.tool_input ?? {};
  if (main && FILE_TOOLS.test(tool)) return deny(event, 'sage mode is on, so you do not change files yourself. Give this change to a sage:implementer. The user ends sage mode with a message that starts with "sage mode off".');
  if (main && AGENT_TOOLS.test(tool) && OURS.test(ti.subagent_type ?? "")) {
    const missing = missingFields(BRIEF_FIELDS, ti.prompt);
    if (missing.length) return deny(event, `the brief has no ${missing.join(", ")}. Every brief has all of ${BRIEF_FIELDS.join(", ")}, each at the start of a line. A tiny task may keep each field to one line.`);
    const cap = stateTool.config().max_agents;
    if (!slots.take(cap, input.tool_use_id ?? String(Date.now()))) return deny(event, `${cap} sage agents are running, and the cap is ${cap}. Wait for one to finish, then start this one.`);
  }
  if (tool === "Bash") return gitGate(event, [].concat(ti.command ?? []).join(" "), state, input.cwd ?? process.cwd());
  return undefined;
}

/**
 * The push rule is an allow-list, as the merge rule is. A command that runs git push anywhere in a command line (also
 * behind a wrapper such as sudo, nice, xargs or timeout, or a shell keyword such as if, !, do or {), or that gives push
 * text to another program (sh -c, eval, a heredoc), is refused unless it is the one push form: a command of its own
 * that pushes the literal name of a branch that is not main or master, from a checkout that is not on main or master.
 * Undefined when the command line has no push, or only pushes in that form; else the reason for the refusal.
 */
const PUSH_FORM = 'git [-C <dir>] push [-u] [--follow-tags] [-o <option>] origin <branch>, as a command of its own, with the literal name of the task\'s branch: not main or master, HEAD, @, a pattern, a variable, or a refspec with ":" or "+". To delete a branch: git push --delete origin <branch>';
const PUSH_TEXT = /\bgit\b[\s\S]*\bpush\b/i;
const refuse = (why) => `${why} Push only with ${PUSH_FORM}.`;
function pushProblem(command, cwd) {
  let commands;
  try {
    commands = shellCommands(command);
  } catch (e) {
    return PUSH_TEXT.test(command) ? refuse(`the hook cannot read this command (${e.message}), so it refuses it. Close each quote, substitution and heredoc.`) : undefined;
  }
  let dir = cwd;
  for (const { cmd, words, bodies } of runnable(commands)) {
    if (cmd.words[0] === "cd" && cmd.words.length === 2) dir = resolve(dir, cmd.words[1]);
    const git = words.findIndex((w, k) => /(?:^|\/)git$/.test(w) && /^push$/i.test(subcommand(words, k + 1)));
    const why = git >= 0 ? pushForm(words, git, dir) : [...words, ...bodies].some((w) => /\s/.test(w) && PUSH_TEXT.test(w)) ? "this command gives push text to another program (a shell, eval or a script), so the hook cannot read the push." : undefined;
    if (why) return refuse(why);
  }
  return undefined;
}

/** git's options before its subcommand, and the ones that take the next word as their value. */
const GIT_VALUE = /^(?:-C|-c|--git-dir|--work-tree|--namespace|--config-env|--super-prefix)$/;
const subcommand = (words, k) => {
  while (words[k]?.startsWith("-")) k += GIT_VALUE.test(words[k]) ? 2 : 1;
  return words[k] ?? "";
};
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
const TO_MAIN = "work reaches main only through a pull request. Push the task's branch and open a pull request.";

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
  if (main) return TO_MAIN;
  if (other) return other;
  if (names.length < 2) return "name the remote and the branch: a push with no branch pushes what the checkout's settings say, which can be main.";
  if (names[0] !== "origin") return `push to origin, not to "${names[0]}".`;
  if (remove) return undefined;
  const branch = branchAt(dir);
  return branch && MAIN_REF.test(branch) ? `this checkout is on ${branch}. Push from the task's worktree, on the task's branch.` : undefined;
}

/** The branch that the checkout at dir is on, or undefined when git cannot read it. */
function branchAt(dir) {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined } }).trim();
  } catch {
    return undefined;
  }
}

const MERGE_FORM = "gh pr merge <n> --squash --delete-branch --match-head-commit <sha>";

function gitGate(event, command, state, cwd) {
  const push = pushProblem(command, cwd);
  if (push) return deny(event, push);
  const merge = mergeIn(command);
  if (!merge) return undefined;
  if (merge.problem) return deny(event, merge.problem);
  if (!state.autopilot) return deny(event, 'autopilot is off, so the user merges. Report the pull request as ready. The user turns it on with a message that starts with "autopilot on".');
  let verdict;
  try {
    if (stateTool.error) throw stateTool.error;
    verdict = stateTool.mergeCheck(merge.sha, process.env, { pr: merge.pr });
  } catch (e) {
    verdict = { reason: `it could not run (${e?.message ?? e}), so it refuses every merge. Tell the user.` };
  }
  return verdict?.ok === true ? undefined : deny(event, `the merge check refuses: ${verdict?.reason}`);
}

/**
 * Text that names a merge: the word gh and the word merge in any order (so also "$G pr merge" or "gh pr $(echo merge)"),
 * a merge path of the REST API, or a GraphQL merge mutation. Each test is one linear scan.
 */
const mentionsMerge = (text) =>
  (/\bgh\b/i.test(text) && /\bmerge\b/i.test(text)) || (/\bpulls\//i.test(text) && /\/merge\b/i.test(text)) || /\/merges\b|\b(?:mergePullRequest|mergeBranch|enablePullRequestAutoMerge)\b/i.test(text);
const CANNOT = `the hook cannot prove that this command is only the merge command, so it refuses it. Merge only with ${MERGE_FORM}, as a command of its own: not through the GitHub API, a variable, a script or another program. Merge text may stand only in the text of echo, printf, cat, grep, git commit, gh pr create, comment, view or edit, or the state tool, and not piped on or written to a file that a later command could run.`;

/**
 * The merge in a Bash command, by an allow-list. Undefined when the command names no merge outside harmless text.
 * Else { pr, sha } when the whole command is the one merge form, which the merge check then decides, or { problem }.
 */
export function mergeIn(command) {
  const form = mergeForm(command);
  if (form) return form;
  let commands;
  try {
    commands = shellCommands(command);
  } catch (e) {
    return mentionsMerge(command.replace(/\\\n/g, "").replace(/['"\\]/g, "")) ? { problem: `${CANNOT} (It cannot read the command: ${e.message}.)` } : undefined;
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
  if (!/^\d+$/.test(pr ?? "")) return { problem: `name the pull request by its number: ${MERGE_FORM}.` };
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

/**
 * The known-harmless commands, which never run their arguments: the number of words of the command's name, or 0.
 * printf -v sets a variable, so it is not harmless.
 */
const TOOL = join(ROOT, "skills/sage/sage.mjs");
function harmless([a, b, c, ...rest]) {
  if (a === "echo" || a === "cat" || a === "grep" || (a === "printf" && ![b, c, ...rest].some((w) => w?.startsWith("-v")))) return 1;
  if ((a === "git" && b === "commit") || (a === "node" && b === TOOL)) return 2;
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

/**
 * The simple commands of a shell command line: { words, bodies, host, piped, pipeTo, grouped, writes }. The words lose their
 * quotes; the bodies are the command's heredocs, which stay text. A command substitution, $( ) or a backtick, gives
 * commands of its own, whose host is the command and word they land in (index -1: a heredoc). Throws when it cannot
 * read the line: an open quote, substitution or heredoc, or a ")" with no "(".
 */
export function shellCommands(src) {
  const out = [];
  readCommands(src, 0, "", out, undefined);
  return out;
}

function readCommands(src, i, close, out, host) {
  const fresh = () => ({ words: [], bodies: [], host, piped: false, grouped: false, writes: false, heredoc: false });
  let cmd = fresh();
  let word;
  let depth = 0;
  const heredocs = [];
  const add = (text) => (word = (word ?? "") + text);
  const endWord = () => {
    if (word !== undefined) cmd.words.push(word);
    word = undefined;
  };
  const endCommand = () => {
    endWord();
    cmd.grouped ||= depth > 0;
    if (cmd.words.length || cmd.heredoc) out.push(cmd);
    cmd = fresh();
  };
  const here = () => ({ cmd, index: cmd.words.length });
  while (i < src.length) {
    const c = src[i];
    if (c === close && depth === 0) {
      if (heredocs.length) throw new Error("an open heredoc");
      endCommand();
      return i + 1;
    }
    if (c === "\\") {
      if (src[i + 1] !== "\n") add(src[i + 1] ?? "");
      i += 2;
    } else if (c === "'") {
      const j = src.indexOf("'", i + 1);
      if (j < 0) throw new Error("an open quote");
      add(src.slice(i + 1, j));
      i = j + 1;
    } else if (c === '"') {
      const r = readExpanding(src, i + 1, '"', out, here());
      add(r.text);
      i = r.i;
    } else if (c === "`" || (c === "$" && src[i + 1] === "(")) {
      i = readCommands(src, i + (c === "`" ? 1 : 2), c === "`" ? "`" : ")", out, here());
      add("$(…)");
    } else if (c === "#" && word === undefined) {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (src.startsWith("<<<", i)) {
      add("<<<");
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
    } else if (c === ">" || (c === "&" && src[i + 1] === ">")) {
      cmd.writes = true; // a redirection: ">", ">>", "&>", and ">&2" or "2>&1", whose "&" ends nothing
      const n = src[i + 1] === "&" ? 2 : 1;
      add(src.slice(i, i + n));
      i += n;
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
      if (c === ")") depth--;
      i += (c === "|" || c === "&") && src[i + 1] === c ? 2 : 1;
    } else {
      add(c);
      i++;
    }
  }
  if (close) throw new Error(close === ")" ? "an open $(" : "an open backtick");
  if (heredocs.length) throw new Error("an open heredoc");
  endCommand();
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

/** The chief of staff's instructions from its agent file, with the state tool's path and the skills to load. */
export function chiefText() {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(readFileSync(join(ROOT, "agents/chief-of-staff.md"), "utf8"));
  const skills = [...m[1].matchAll(/^\s+-\s+(\S+)\s*$/gm)].map((x) => x[1]);
  return [
    `sage: sage mode is on. You are the user's chief of staff until a message from the user starts with "sage mode off".`,
    `The state tool: node "${join(ROOT, "skills/sage/sage.mjs")}" <command> --project <path>. Each shell call starts fresh, so write this full command every time; do not keep it in a variable. Load these skills now: ${skills.join(", ")}.`,
    m[2].trim(),
  ].join("\n\n");
}

const context = (event, text) => ({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });
/** A refusal. Its reason can quote the command, so its control characters are escaped: they can change what a terminal shows. */
const deny = (event, reason) => ({ hookSpecificOutput: { hookEventName: event, permissionDecision: "deny", permissionDecisionReason: `sage: ${String(reason).replace(/\p{Cc}/gu, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)}` } });

/**
 * The agent cap. Each running sage agent holds one slot: a directory that mkdir creates atomically, so agents that
 * the chief starts in one message cannot take the same slot. A slot is pending from the spawn until SubagentStart
 * names the agent, and free again at SubagentStop. A slot that is never named, or never freed, expires.
 */
export function slotsFor(dir, now = Date.now()) {
  const STALE = { pending: 10 * 60_000, agent: 6 * 3600_000 };
  const list = () => {
    try {
      return readdirSync(dir).filter((d) => d.startsWith("slot-"));
    } catch {
      return [];
    }
  };
  const marks = (slot) => {
    try {
      return readdirSync(join(dir, slot));
    } catch {
      return [];
    }
  };
  const free = (slot) => rmSync(join(dir, slot), { recursive: true, force: true });
  const expire = () => {
    for (const slot of list()) {
      const [mark] = marks(slot);
      const kind = mark?.startsWith("agent-") ? "agent" : "pending";
      const age = now - statSync(join(dir, slot)).mtimeMs;
      if (!mark ? age > STALE.pending : age > STALE[kind]) free(slot);
    }
  };
  return {
    take(cap, toolUseId) {
      mkdirSync(dir, { recursive: true });
      expire();
      for (let k = 1; k <= cap; k++) {
        try {
          mkdirSync(join(dir, `slot-${k}`));
        } catch {
          continue; // taken
        }
        writeFileSync(join(dir, `slot-${k}`, `pending-${toolUseId}`), "");
        return true;
      }
      return false;
    },
    bind(agentId) {
      for (const slot of list()) {
        const pending = marks(slot).find((m) => m.startsWith("pending-"));
        if (!pending) continue;
        try {
          renameSync(join(dir, slot, pending), join(dir, slot, `agent-${agentId}`)); // atomic: one start binds one slot
          return;
        } catch {
          /* another start took this one */
        }
      }
    },
    release(agentId) {
      for (const slot of list()) if (marks(slot).includes(`agent-${agentId}`)) free(slot);
    },
    drop(toolUseId) {
      for (const slot of list()) if (marks(slot).includes(`pending-${toolUseId}`)) free(slot);
    },
    count: () => list().length,
  };
}

const stateDir = () => process.env.SAGE_HOOKS_STATE ?? join(tmpdir(), "sage-hooks");
const safe = (id) => String(id).replace(/[^\w.-]/g, "_");

// Node gives this module its real path, so a path to the hook through a symbolic link is compared as a real path too.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url) && process.env.SAGE_HOOKS !== "off") {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
    const session = safe(input.session_id ?? "unknown");
    const file = join(stateDir(), `${session}.json`);
    let state;
    try {
      state = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      state = {};
    }
    const before = JSON.stringify(state);
    const output = handle(input, state, slotsFor(join(stateDir(), `${session}.slots`)));
    if (JSON.stringify(state) !== before) {
      mkdirSync(stateDir(), { recursive: true });
      writeFileSync(`${file}.${process.pid}`, JSON.stringify(state));
      renameSync(`${file}.${process.pid}`, file);
    }
    if (output) process.stdout.write(JSON.stringify(output));
  } catch (e) {
    // Never break the session, but never let a merge or a push through because the hook failed.
    const command = [].concat(input?.tool_input?.command ?? []).join(" ");
    if (input?.hook_event_name === "PreToolUse" && (mentionsMerge(command) || PUSH_TEXT.test(command))) {
      process.stdout.write(JSON.stringify(deny("PreToolUse", `the hook could not check this command (${e?.message ?? e}), so it refuses it. Tell the user.`)));
    }
  }
}
