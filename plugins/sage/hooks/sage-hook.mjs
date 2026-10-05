#!/usr/bin/env node
// The sage hook. Claude Code sends one JSON event on stdin; the hook answers with one JSON object on stdout, or nothing.
//   - "sage mode" makes the session the user's chief of staff (agents/chief-of-staff.md) until "sage mode off". A
//     session that starts as the sage:chief-of-staff agent is in sage mode from its first event. Only the user's own
//     words switch a mode on, or sage mode off: never an agent's report, a task notification or another session's
//     message (promptOf). When the hook cannot read the frames of a prompt, nothing in it switches a mode on (fail
//     closed). An autopilot off counts in more text: in the owner's text, in a message the owner sends while Claude
//     works, and in a frame on a line that starts with the off-phrase. Such a message never switches a mode on.
//   - In sage mode it holds the rules that prompts alone did not hold in Orchestrator (docs/design/sage-mode.html,
//     "Rules"): the chief never edits files, every brief has all its fields, at most cap.<project> (default
//     max_agents) sage agents run at once for a project and cap_total across all projects, nobody force-pushes or pushes to main, and a merge needs autopilot on, the checked head SHA and the clean
//     cycles that the ledger records for it (the merge check). The merge rule and the push rule are allow-lists: a
//     command that names a merge or runs a push is refused unless it is exactly the merge form or the push form, or the
//     merge text stands only in a harmless command's text. One case asks the user instead of a refusal: the chief's
//     first creation of main or master on GitHub, in one literal gh api form (FIRST_FORM), checked on GitHub only
//     (firstUpload, firstCreation).
//   - A sage agent may finish only with the full report of the sage:report skill.
//   - Only the chief writes the logbook, in any mode (agentProblem): an agent runs the state tool only as one plain read
//     command, never the PR script, never a command outside the sandbox, never writes under the sage root with a file
//     tool (canonical paths), and never runs a shell write near the logbook (deny by default). Shell text cannot be read
//     completely: the sandbox (T80) is the full guard for shell writes.
//   - Only sage.mjs changes the logbook (chiefProblem): the chief's own file tools and shell writes never change it.
// SAGE_HOOKS=off turns it off. The hook never breaks a session: on an error it answers nothing, but it refuses a merge,
// a push, every file change and command of an agent, and a chief's shell write that names a logbook file.
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
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
// A prefix that stays on its line. With the m flag, "^" matches after each line break, so a prefix that also matched
// line breaks would read each run of blank lines again from each of its lines: quadratic time on a long report (T34).
const LINE_START = String.raw`^(?:${SP}|["'“‘*_>-])*`;
const END = String.raw`(?=${SP}*(?:[.,:;!\r\n  ]|$))`;
const SAGE = String.raw`(?:enter${SP}+)?sage${SP}+mode(?:${SP}+on)?`;
const AND_AUTOPILOT = String.raw`(?:${SP}+autopilot|(?:${SP}*[.,:;!]${SP}*|${SP}+)autopilot${SP}+on)`; // "sage mode autopilot", "sage mode, autopilot on"
const SAGE_ON = new RegExp(`${START}${SAGE}${AND_AUTOPILOT}?${END}`, "i");
const OFF_LINE = new RegExp(`${LINE_START}(?:sage${SP}+mode|autopilot)${SP}+off\\b`, "im"); // in any text, at the start of any line
const SAGE_OFF = new RegExp(`${START}sage${SP}+mode${SP}+off(?![\\p{L}\\p{N}-])(?!.*\\?)`, "iu"); // "." stops at a line break
const AUTOPILOT_ON = new RegExp(`${START}(?:autopilot${SP}+on|${SAGE}${AND_AUTOPILOT})${END}`, "i");
// The word autopilot, and the off words in any form ("no more", "turn off", "switch off" and "hold off" have one too).
const AUTOPILOT = /\bauto[-\s]?pilots?\b/i;
const OFF_WORD = /\b(?:off|no|without|don['’]?t|do\s+not|end(?:s|ed|ing)?|quit(?:s|ting)?|exit(?:s|ed|ing)?)\b|\b(?:stop|disabl|paus|cancel|kill|halt|deactivat|abort|suspend)|\bauto[-\s]?pilots?\s*=\s*false\b/i;
const broadOff = (text) => OFF_LINE.test(text) || (AUTOPILOT.test(text) && OFF_WORD.test(text));
const FILE_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit)$/;
const AGENT_TOOLS = /^(Agent|Task)$/;
/** The tools that run a command. The PreToolUse matcher in claude.json names each of them. */
const COMMAND_TOOLS = /^(?:Bash|Monitor|PowerShell|mcp__terminal__.*)$/;
const CHIEF = /(^|:)chief-of-staff$/;
const OURS = /^sage:/;
/** An agent's event: Claude Code sets agent_id only for a subagent's events. An empty agent_id, or a sage role other than the chief, counts too (fail closed). */
const agentEvent = (input) => "agent_id" in (input ?? {}) || (OURS.test(input?.agent_type ?? "") && !CHIEF.test(input.agent_type));
export const BRIEF_FIELDS = ["GOAL", "SCOPE", "CONTEXT", "DECISIONS", "ACCEPTANCE", "VERIFY", "BUDGET", "FORBIDDEN", "REPORT", "STANDING"];
export const REPORT_FIELDS = ["STATUS", "RESULT", "EVIDENCE", "FINDINGS", "QUESTIONS", "NOT VERIFIED", "BRANCH"];
/** The fields of a template that do not start a line. Markdown around a field ("**STATUS**", "| STATUS |") is fine. */
const missingFields = (fields, text) => fields.filter((f) => !new RegExp(`^(?:${SP}|[*_#|>-])*${f}\\b`, "m").test(text ?? ""));

/**
 * A prompt: whether the owner wrote it, and the owner's text. Claude Code sends no sender field: a live capture of a
 * UserPromptSubmit hook in 2.1.289 has session_id, transcript_path, cwd, prompt_id, permission_mode, hook_event_name
 * and prompt, and its docs name no sender field either. So the hook reads the sender from the prompt. Claude Code puts
 * an agent's report, a task notification, another session's message and a system reminder in frames, and it can join
 * the owner's message to them. A frame closes only with a close of its own kind. Another session's message closes with
 * the note that Claude Code puts after it, so the note is part of the frame.
 * The hook counts the frames on the prompt as Claude Code sent it.
 *   - The owner's message that Claude Code queues while it works (queuedText) comes in a system reminder. It counts only
 *     as a whole system reminder, with Claude Code's note, outside every other frame and with no frame mark in it. The
 *     queued shape inside another frame is that frame's text. An agent can write a whole queued shape at the end of a
 *     bare system reminder, and the hook cannot tell it from a real one. So a queued message counts only for an
 *     autopilot off, never for an on: the owner sends an on again when Claude is idle.
 *   - text: the text before the first frame and after the last close. An agent cannot write there, also when it
 *     writes a close in its report, because the real close comes after it. It can switch a mode on.
 *   - outside: all the text outside the frames, also between two frames, with the queued messages. It counts only for
 *     an autopilot off (the broad off rule).
 *   - owner: false when the hook cannot read the frames (fail closed): a kind with more opens than closes or more
 *     closes than opens, or a frame's marker in the text. Then nothing in the prompt switches a mode on.
 */
const FRAMES = [
  [/<task-notification>/g, /<\/task-notification>/g],
  [/<agent-message[\s>]/g, /<\/agent-message>/g],
  [new RegExp(`^${SP}*Another Claude session sent a message:`, "gm"), new RegExp(`^${SP}*That "other Claude session"[^\\n]*`, "gm")],
  [/<system-reminder>/g, /<\/system-reminder>/g],
];
/** The owner's text in a queued message: the frame's text up to the first note with no "<" after it. One read (T34). */
function queuedText(frame) {
  const open = /^<system-reminder>\s*The user sent a new message while you were working:\n/.exec(frame);
  const close = "</system-reminder>";
  if (!open || !frame.endsWith(close)) return [];
  const body = frame.slice(open[0].length, -close.length);
  const note = body.indexOf("\n\nThis is how Claude Code surfaces messages", body.lastIndexOf("<") + 1);
  return note < 0 ? [] : [body.slice(0, note)];
}
const MARKERS = /\[Subagent hand-back\]|\[SYSTEM NOTIFICATION/i;
export function promptOf(input) {
  const all = input.prompt ?? "";
  const marks = FRAMES.map(([open, close]) => [[...all.matchAll(open)], [...all.matchAll(close)]]);
  // Each open is +1 and each close is -1; a frame is a span from depth 0 back to depth 0. A close sorts before an open.
  const edges = marks.flatMap(([o, c]) => [...o.map((m) => [m.index, 1]), ...c.map((m) => [m.index + m[0].length, -1])]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const frames = [];
  let depth = 0;
  for (const [at, step] of edges) {
    if (step > 0 && depth === 0) frames.push([at, all.length, 0]);
    if (step > 0 || depth > 0) frames.at(-1)[2]++; // the frame's opens and closes
    if (step > 0) depth++;
    else if (depth > 0 && --depth === 0) frames.at(-1)[1] = at;
  }
  // A queued message is a whole frame with only its own open and close.
  const queued = frames.flatMap(([s, e, n]) => (n === 2 ? queuedText(all.slice(s, e)) : []));
  // The text between the frames, in pieces.
  const pieces = [];
  let at = 0;
  for (const [s, e] of frames) {
    pieces.push(all.slice(at, s));
    at = e;
  }
  pieces.push(all.slice(at));
  const text = pieces.length > 1 ? `${pieces[0]}\n${pieces.at(-1)}` : pieces[0];
  const balanced = marks.every(([o, c]) => o.length === c.length);
  return { owner: balanced && !MARKERS.test(text), text, outside: [...pieces, ...queued].join("\n"), all };
}

/**
 * Switches the modes, and returns the notes for the chief. Only the owner's own text switches sage mode or autopilot
 * on, or sage mode off. Off is the safe direction, so an autopilot off counts in more text: the broad off rule in all
 * the text outside the frames (in the whole prompt when the hook cannot read the frames), and an off line anywhere. A sage mode off that is not the owner's switches only autopilot off, so that the git rules stay.
 */
function switchModes({ owner, text, outside, all }, state) {
  const notes = [];
  if (owner && SAGE_OFF.test(text)) {
    Object.assign(state, { sage: false, given: false, autopilot: false });
    notes.push("sage: sage mode is off. You may change files yourself again.");
  } else if (owner && SAGE_ON.test(text)) state.sage = true;
  if (OFF_LINE.test(all) || broadOff(owner ? outside : all)) {
    if (state.autopilot) notes.push("sage: autopilot is off. Work stops at verified, and the user merges.");
    state.autopilot = false;
  } else if (owner && state.sage && AUTOPILOT_ON.test(text)) {
    state.autopilot = true;
    const c = stateTool.config();
    const broken = Object.keys(c).find((k) => c[k] === "invalid");
    const [small, large, risky] = [{}, { size: "large" }, { risk: "auth" }].map((task) => stateTool.cyclesFor(task, c));
    if (broken) notes.push(`sage: autopilot is on. ${broken} in config.json is not a number: no merge until it is fixed (sage config ${broken}=<n>).`);
    else notes.push(`sage: autopilot is on. A pull request merges on its head SHA after ${small} clean cycle${small === 1 ? "" : "s"} for a tiny or small task, ${large} for a large task and ${risky} for a task with a risk flag; a large task with a risk flag needs the larger count. Merge with gh pr merge <n> --squash --delete-branch --match-head-commit <sha>.`);
  }
  return notes;
}

/** "1 sage agent is running", "3 sage agents are running". */
const running = (n) => `${n} sage ${n === 1 ? "agent is" : "agents are"} running`;

export function handle(input, state, slots) {
  const event = input.hook_event_name;
  const main = !agentEvent(input);
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
  const ours = OURS.test(input.agent_type ?? "");
  if (!main && ours && input.agent_id) slots.touch(input.agent_id); // the agent's lease: a slot that no event touched for an hour expires
  if (event === "SubagentStart") return void (ours && slots.bind(input.agent_id));
  // The session's live tasks at the main session's Stop: a slot whose agent is not among them is free. An agent that
  // dies (for one, on a usage limit) fires no SubagentStop, but it leaves the registry, and the chief's next turn ends.
  // Only then: at a SubagentStop, a foreground agent of the session may be running and not listed.
  if (event === "Stop" && main && Array.isArray(input.background_tasks)) slots.reconcile(input.background_tasks.map((t) => t?.id));
  if (event === "SubagentStop") {
    // A sage agent finishes only with the full report. The second stop goes through, so this cannot loop.
    if (ours && !input.stop_hook_active && typeof input.last_assistant_message === "string") {
      const missing = missingFields(REPORT_FIELDS, input.last_assistant_message);
      if (missing.length) return { decision: "block", reason: `sage: your report has no ${missing.join(", ")}. End with the report of the sage:report skill: ${REPORT_FIELDS.join(", ")}, each at the start of a line, with "none" where a field has nothing.` };
    }
    return void slots.release(input.agent_id);
  }
  if (event === "PostToolUseFailure" && AGENT_TOOLS.test(input.tool_name ?? "")) return void slots.drop(input.tool_use_id);
  if (event === "PreToolUse" && input.tool_name === "TaskStop") return void slots.release(input.tool_input?.task_id); // a stopped agent's task id is its agent id
  const why = event === "PreToolUse" ? (main ? chiefProblem(input, state.sage) : agentProblem(input)) : undefined;
  if (why && main) return deny(event, `${why} Only sage.mjs changes the logbook: run the state tool's command for this change (node <path to skills/sage/sage.mjs> ...), as a command of its own. If no command does it, ask the user.`);
  if (why) return deny(event, `${why} Only the chief writes the logbook. An agent may run only ${READ_FORM}. Report what the logbook needs, and the chief records it.`);
  if (event !== "PreToolUse" || !state.sage) return undefined;

  const tool = input.tool_name ?? "";
  const ti = input.tool_input ?? {};
  if (main && FILE_TOOLS.test(tool)) return deny(event, 'sage mode is on, so you do not change files yourself. Give this change to a sage:implementer. The user ends sage mode with a message that starts with "sage mode off".');
  if (main && AGENT_TOOLS.test(tool) && OURS.test(ti.subagent_type ?? "")) {
    const missing = missingFields(BRIEF_FIELDS, ti.prompt);
    if (missing.length) return deny(event, `the brief has no ${missing.join(", ")}. Every brief has all of ${BRIEF_FIELDS.join(", ")}, each at the start of a line. A tiny task may keep each field to one line.`);
    const caps = stateTool.config();
    const project = input.cwd ? stateTool.projectName(input.cwd) : "other";
    const cap = caps[`cap.${project}`] ?? caps.max_agents;
    const r = slots.take(project, cap, caps.cap_total, input.tool_use_id ?? String(Date.now()));
    if (r.refused) {
      slots.log(`${project} ${r.project}/${cap} total ${r.total}/${caps.cap_total}`);
      const raise = (key, n) => `Wait for one to finish, or raise the cap: node "${join(ROOT, "skills/sage/sage.mjs")}" config ${key}=${n + 1}`;
      if (r.refused === "mark") return deny(event, `the agent cap could not mark its slot (${r.error}), so it refuses this spawn. Tell the user.`);
      if (r.refused === "total") return deny(event, `${running(r.total)} across all projects, and the total cap is ${caps.cap_total} (${project} has ${r.project}). ${raise("cap_total", caps.cap_total)}`);
      return deny(event, `${running(r.project)} for ${project}, and its cap is ${cap} (${r.total} of ${caps.cap_total} across all projects). ${raise(`cap.${project}`, cap)}`);
    }
  }
  if (tool === "Bash") return gitGate(event, [].concat(ti.command ?? []).join(" "), state, input.cwd ?? process.cwd(), main);
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
/** The word git, and then the word push. The first git is enough, so the test reads the text once (T34). */
const pushText = (text) => /\bpush\b/i.test(/\bgit\b([\s\S]*)/i.exec(text)?.[1] ?? "");
const refuse = (why) => `${why} Push only with ${PUSH_FORM}.`;
function pushProblem(command, cwd) {
  let commands;
  try {
    commands = shellCommands(command);
  } catch (e) {
    return pushText(command) ? refuse(`the hook cannot read this command (${e.message}), so it refuses it. Close each quote, substitution and heredoc.`) : undefined;
  }
  let dir = cwd;
  for (const { cmd, words, bodies } of runnable(commands)) {
    if (cmd.words[0] === "cd" && cmd.words.length === 2) dir = resolve(dir, cmd.words[1]);
    const git = words.findIndex((w, k) => /(?:^|\/)git$/.test(w) && /^push$/i.test(subcommand(words, k + 1)));
    const why = git >= 0 ? pushForm(words, git, dir) : ghApi(words) && words.some((w) => REFS_ENDPOINT.test(w)) && words.some((w) => MAIN_FIELD.test(w)) ? TO_MAIN : [...words, ...bodies].some((w) => /\s/.test(w) && pushText(w)) ? "this command gives push text to another program (a shell, eval or a script), so the hook cannot read the push." : undefined;
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
/** The one command that can create main or master (firstUpload). */
const FIRST_FORM = "gh api --hostname github.com -X POST repos/<owner>/<repo>/git/refs -f ref=refs/heads/main -f sha=<full commit id>";
const TO_MAIN = `work reaches main only through a pull request. Push the task's branch and open a pull request. (Only the first creation of main in a blank GitHub repository asks the user, from the main session, as a command of its own: ${FIRST_FORM}, for a commit with no parent that is already on GitHub. After it, the chief tries to turn on branch protection for that branch.)`;

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

/**
 * The one exception to the push rule: the first creation of main or master on GitHub, for a blank project. The whole
 * command is FIRST_FORM, its flags in any order, each once, with nothing before or after it. Every word in it is
 * literal, so the user approves an immutable commit and a fixed destination. Returns { owner, repo, branch, sha }, or
 * undefined: then the push rule refuses the command as before. firstCreation then checks it on GitHub.
 */
function firstUpload(command) {
  if (!/^[\w./= -]+$/.test(command)) return undefined; // no quote, variable, newline, chain or redirection
  const words = command.trim().split(/ +/);
  if (words[0] !== "gh" || words[1] !== "api") return undefined; // no prefix: not env, an assignment or a path to gh
  const f = {};
  for (let k = 2; k < words.length; k++) {
    const w = words[k];
    let key;
    let value;
    if (w === "--hostname") [key, value] = ["host", words[++k]];
    else if (w === "-X" || w === "--method") [key, value] = ["method", words[++k]];
    else if (w.startsWith("--method=")) [key, value] = ["method", w.slice(9)];
    else if (w === "-f") [, key, value] = /^(ref|sha)=(.*)$/.exec(words[++k] ?? "") ?? [];
    else if (!w.startsWith("-")) [key, value] = ["endpoint", w];
    if (!key || key in f || value === undefined) return undefined; // another flag or field, or one given twice
    f[key] = value;
  }
  const [, owner, repo] = /^repos\/((?!\.+\/)[\w.-]+)\/((?!\.+\/)[\w.-]+)\/git\/refs$/.exec(f.endpoint ?? "") ?? [];
  const [, branch] = /^refs\/heads\/(main|master)$/.exec(f.ref ?? "") ?? [];
  if (!repo || !branch || f.host !== "github.com" || f.method !== "POST" || !/^[0-9a-f]{40}$/.test(f.sha ?? "")) return undefined;
  return { owner, repo, branch, sha: f.sha };
}

/**
 * One GET from the GitHub API through gh, by the deadline: { status, body }. The host is always github.com, whatever
 * GH_HOST or GH_REPO say. SIGKILL ends a gh that ignores SIGTERM, so the timeout holds. It throws on an error, a timeout or an answer with no HTTP status.
 */
function githubGet(path, deadline) {
  const timeout = Math.min(5000, deadline - Date.now());
  if (timeout <= 0) throw new Error("no time was left");
  const env = { ...process.env, GH_HOST: undefined, GH_REPO: undefined, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" };
  const r = spawnSync("gh", ["api", "--hostname", "github.com", "--include", path], { encoding: "utf8", timeout, killSignal: "SIGKILL", maxBuffer: 256 * 2 ** 20, stdio: ["ignore", "pipe", "ignore"], env });
  if (r.error) throw new Error(r.error.code === "ETIMEDOUT" ? "gh did not answer in time" : r.error.message);
  const status = /^HTTP\/\S+ (\d{3})/.exec(r.stdout)?.[1];
  if (!status) throw new Error("gh gave no HTTP status");
  const at = r.stdout.search(/\r?\n\r?\n/);
  return { status: Number(status), body: at < 0 ? "" : r.stdout.slice(at).trim() };
}

/**
 * A name from GitHub for the prompt: in double quotes, at most 60 characters (code points). It drops control and format
 * characters, separators other than the plain space (such as U+2028), and quote characters (also the fullwidth U+FF02).
 */
const quoted = (name) => `"${[...String(name).replace(/(?! )[\p{Cc}\p{Cf}\p{Z}"'`‘-‟＂]/gu, "")].slice(0, 60).join("")}"`;

/** The body of a 200 answer as JSON, or {} for another status. It throws a fixed reason, never the body's text. */
function json({ status, body }) {
  if (status !== 200) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("GitHub's answer was not JSON");
  }
}

/** git's empty tree: the tree of a commit with no files. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * The checks of the first creation, all on GitHub, never on the local repo: the branch is absent (404), the commit is
 * there and has no parent, and its tree gives the file count and the top-level names. Returns { decision, reason }:
 * "ask" with the prompt, or "deny". The deadline keeps the three calls inside the 10 seconds that Claude Code gives the hook.
 */
function firstCreation({ owner, repo, branch, sha }) {
  const where = `github.com/${owner}/${repo}`;
  const no = (why) => ({ decision: "deny", reason: `this command creates ${branch} on ${where}, and the hook asks the user only when GitHub shows that it is the first creation of ${branch} at one root commit: ${why}. ${TO_MAIN}` });
  try {
    const deadline = Date.now() + 7000;
    const api = `repos/${owner}/${repo}/git`;
    const ref = githubGet(`${api}/ref/heads/${branch}`, deadline);
    if (ref.status !== 404) return no(`GitHub answered ${ref.status} for ${branch}, not 404 (no such branch)`);
    const commit = githubGet(`${api}/commits/${sha}`, deadline);
    const c = json(commit);
    if (c.sha !== sha || !/^[0-9a-f]{40}$/.test(c.tree?.sha ?? "")) return no(`GitHub has no commit ${sha} in ${owner}/${repo} (answer ${commit.status}). Push it on a task branch first`);
    // gh follows a redirect of a renamed or moved repository: then the answer is for another name than the prompt shows.
    if (!String(c.url).toLowerCase().startsWith(`https://api.github.com/repos/${owner}/${repo}/`.toLowerCase())) return no(`GitHub answered for another repository than ${owner}/${repo}, as for a renamed or moved repository. Use its current name`);
    if (!Array.isArray(c.parents)) return no(`GitHub's answer for commit ${sha} has no list of parents`);
    if (c.parents.length) return no(`commit ${sha} has a parent, so it is not one root commit`);
    // GitHub stores no object for git's empty tree, so its tree API answers 404 for it: that tree has no files.
    const tree = c.tree.sha === EMPTY_TREE ? { status: 200, body: '{"tree":[]}' } : githubGet(`${api}/trees/${c.tree.sha}?recursive=1`, deadline);
    const t = json(tree);
    if (!Array.isArray(t.tree)) return no(`GitHub did not give the files of commit ${sha} (answer ${tree.status})`);
    const files = t.tree.filter((e) => e.type === "blob").length;
    const top = t.tree.map((e) => String(e.path)).filter((p) => !p.includes("/"));
    const more = top.length > 10 ? ` and ${t.truncated ? "more" : `${top.length - 10} more`}` : t.truncated ? " and more" : "";
    const names = top.length ? `; top level: ${top.slice(0, 10).map(quoted).join(", ")}${more}` : "";
    const count = files || t.truncated ? `${t.truncated ? "more than " : ""}${files} file${files === 1 && !t.truncated ? "" : "s"}` : "no files";
    return { decision: "ask", reason: `this is the first creation of ${branch} on ${where}: GitHub has no ${branch}, and commit ${sha} is one root commit with ${count}${names}. The user must approve it. After this, sage tries to turn on branch protection for ${branch} (GitHub offers it for public repos, and for private repos on paid plans).` };
  } catch (e) {
    return no(`the check on GitHub failed (${e.message})`);
  }
}

/**
 * Only the chief writes the logbook (T83). An agent's event may run the state tool only as one plain read command, by an
 * allow-list of subcommands, so a subcommand added later is refused until it is listed here. The rule holds for every
 * tool that runs a command (COMMAND_TOOLS), not only Bash. Shell text cannot be read completely, so the shell rule stops
 * mistakes and the common forgery forms; the sandbox (T80) is the full guard for shell writes. Undefined, or the reason.
 */
const READS = { status: () => true, "merge-check": () => true, logbook: (pos) => pos[0] !== "repair", standing: (pos) => pos[0] !== "add", config: (pos) => !pos.length };
const READ_FORM = "node <path to skills/sage/sage.mjs> <status, merge-check, logbook, standing or config> [--project <path>], as one plain command: no quote, variable, ;, &&, ||, |, `, $(, >, < or newline, and config with no key=value";
const PLAIN = /^[\w./=:@,+-]+(?:[ \t]+[\w./=:@,+-]+)*$/;
/** The logbook's files by name (S2). */
const TABLES = ["tasks.tsv", "runs.tsv", "findings.tsv", "gates.tsv", "ledger.tsv", "decisions.tsv", "config.json", "standing.md", "status.md"];
/** All the text of a tool call's input, one string per field. */
const fields = (v) => (typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(fields) : []);
/** Text as APFS compares names: it ignores case and Unicode form, and folds compatibility forms (ſ is s, ﬆ is st). */
const fold = (text) => text.normalize("NFKC").toLowerCase();
/** The words of a command's text, in their own case. Quotes and backslashes are removed, so .cl''aude is .claude. */
const wordsOf = (text) =>
  text
    .replace(/['"\\]/g, "")
    .replace(/\$\{(\w+)\}/g, "$$$1")
    .split(/[\s;&|()<>`=:]+/)
    .filter(Boolean);
/** The words of the text, folded, each as its path parts. */
const partsOf = (text) => wordsOf(fold(text)).map((word) => ({ word, parts: word.split("/") }));
const GLOB = /[*?[{]/;
/** Does a path part name name, also as a shell pattern (sag?, .cl*, [.]claude, {a,b})? */
function names(part, name) {
  if (part === name) return true;
  if (!GLOB.test(part)) return false;
  if (part.replace(/[^*?[{]/g, "").length > 8) return true; // many wildcards could name anything, and would make a slow match
  const re = part.replace(/[.+^$()|\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".").replace(/\[!/g, "[^").replace(/\{([^{}]*)\}/g, (_, alts) => `(?:${alts.split(",").join("|")})`);
  try {
    return new RegExp(`^${re}$`).test(name);
  } catch {
    return true; // a pattern that the hook cannot read could name anything
  }
}
const HOME = /^(?:~|\$home)(?:\/|$)/;
/** The sage root's text and canonical path, in lower case. strict: throw when the root cannot be resolved (for agents). */
function rootsOf(strict) {
  let raw;
  try {
    raw = stateTool.sageRoot(process.env);
    return [fold(raw), canonical(raw)];
  } catch (e) {
    if (strict) throw e;
    return raw ? [fold(raw)] : [];
  }
}
/** Does the text name the sage root: its path or a variable that sets it, or .claude then sage in one path, in any case or as a pattern? */
function namesRoot(text, words, roots, cwd) {
  const low = fold(text.replace(/['"\\]/g, ""));
  return usesRootVar(text, roots[1], cwd) || roots.some((r) => low.includes(r)) || words.some(({ parts }) => parts.some((p, k) => names(p, ".claude") && names(parts[k + 1] ?? "", "sage")));
}
/**
 * Does the text use a variable that sets the sage root (sageRoot: SAGE_HOME, CLAUDE_CONFIG_DIR)? An assignment of a
 * plain path that does not overlap the real root (a scratch or temp SAGE_HOME for tests) is no use, and nor is a later
 * $VAR of a variable that the text assigned so. Every other mention is a use: a $VAR (also ${VAR}, $env:VAR, %VAR%) that
 * the text did not assign so, an assignment of any other value, and a bare name in a command with a substitution or a
 * pipe, which can read the variable (printenv). Without the real root (root), every mention is a use.
 */
function usesRootVar(text, root, cwd) {
  const safe = new Set();
  const reads = /\$\(|`|\|/.test(text);
  for (const [, ref, name, set, value] of text.replace(/['"\\]/g, "").matchAll(/(\$\{?|\$env:|%)?\b(SAGE_HOME|CLAUDE_CONFIG_DIR)\b(=([^\s;&|<>()`]*))?/gi)) {
    if (ref) {
      if (!safe.has(name)) return true;
    } else if (set) {
      if (!root || !value || /[$`*?[{%]/.test(value) || overlaps(canonical(from(cwd, pathOf(value))), root)) return true;
      safe.add(name);
    } else if (reads) return true;
  }
  return false;
}
/** Does the text name a logbook file, in any case or as a pattern? */
const namesTable = (words) => words.some(({ parts }) => parts.some((p) => TABLES.some((t) => names(p, t))));
/** A path into a project's worktrees (<project>/.claude/worktrees/<name>), where agents work: plain, with no "..", pattern or variable. */
const worktree = (word) => /(?:^|\/)\.claude\/worktrees\/[\w-]/.test(word) && word.split(".claude").length === 2 && !/[*?[{$~]/.test(word) && !word.split("/").includes("..");
/** A path from the cwd, as the shell gives it to the system: ".." is not removed here, so the system resolves it after a link. */
const from = (cwd, path) => (isAbsolute(path) ? path : `${isAbsolute(cwd) ? cwd : resolve(cwd)}/${path}`); // throws on a cwd that is not text
/** Does a canonical path overlap the canonical root: is it in the root, or the root in it? */
const overlaps = (path, root) => [[path, root], [root, path]].some(([a, b]) => a === b || a.startsWith(b.endsWith(sep) ? b : b + sep));
/** A shell word as a path: ~ is the home folder, and a pattern stands for the folder before its first wildcard. */
function pathOf(word) {
  const parts = word.replace(/^~(?=\/|$)/, process.env.HOME ?? "~").split("/");
  const k = parts.findIndex((p) => GLOB.test(p));
  return (k < 0 ? parts : parts.slice(0, k)).join("/") || (word.startsWith("/") ? "/" : ".");
}
/**
 * Is an agent's command near the logbook (deny by default)? It names the sage root or a logbook file's folder; or
 * .claude (not in a plain worktree path); or the home folder with a variable or a pattern; or it changes to the home
 * folder. A word that, through the links on disk, is in the sage root or holds it is near too. A pattern or a logbook
 * file's name is near only in a command that can leave the cwd: cd or pushd, "..", ~, $, a backtick, or an absolute path
 * (the owner's decision T83-COST-GLOB, so that rm dist/* and jq ... > config.json pass in a project).
 */
function nearLogbook(text, roots, cwd) {
  const words = partsOf(text);
  const plain = words.filter(({ word }) => !GLOB.test(word));
  const low = fold(text);
  const home = fold(process.env.HOME ?? "");
  const atHome = (w) => /^(?:~|\$home|-)\/?$/.test(w) || (home.length > 1 && (w === home || w === `${home}/`));
  const fromHome = (w) => HOME.test(w) || (home.length > 1 && (w === home || w.startsWith(`${home}/`)));
  const leaves =
    /[$`]/.test(text) ||
    words.some(({ word, parts }) => /^(?:cd|pushd)$/.test(word) || parts.includes("..") || parts[0].startsWith("~") || (/^\/(?!\/)/.test(word) && !/^\/dev\/(?:null|stdout|stderr)$/.test(word)));
  const resolved = [...new Set(wordsOf(text))].filter((w) => !/[$`]/.test(w)).map((w) => canonical(from(cwd, pathOf(w))));
  return (
    namesRoot(text, plain, roots, cwd) ||
    plain.some(({ word, parts }) => parts.includes(".claude") && !worktree(word)) ||
    (leaves && (words.length > plain.length || namesTable(words))) ||
    resolved.some((p) => overlaps(p, roots[1])) ||
    wordsOf(text).some((w) => linkOnPattern(w, cwd)) ||
    words.some(({ word }) => fromHome(word) && /[*?[{$]/.test(word.replace(/^\$home/, ""))) ||
    /(?:^|[\s;&|(`])(?:cd|pushd)[ \t]*(?:$|[\n;&|)`])/m.test(low) ||
    words.some(({ word }, k) => /^(?:cd|pushd)$/.test(word) && atHome(words[k + 1]?.word ?? "-"))
  );
}
/**
 * Is a link on a pattern's path (T83-S-GLOBLINK)? The hook does not expand a pattern, so it cannot resolve the links
 * that the pattern matches. A part before the first wildcard that is a link, or an entry of that folder that the first
 * pattern part names and that is a link (also a dangling one), makes the word near.
 */
function linkOnPattern(word, cwd) {
  const parts = word.replace(/^~(?=\/|$)/, process.env.HOME ?? "~").split("/");
  const k = parts.findIndex((p) => GLOB.test(p));
  if (k < 0) return false;
  let dir = word.startsWith("/") ? "" : isAbsolute(cwd) ? cwd : resolve(cwd);
  try {
    for (const part of parts.slice(0, k).filter(Boolean)) {
      dir = `${dir}/${part}`; // as the shell gives it to the system: ".." is not removed
      if (lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink()) return true;
    }
    return readdirSync(dir || "/", { withFileTypes: true }).some((e) => e.isSymbolicLink() && names(fold(parts[k]), fold(e.name)));
  } catch (e) {
    if (["ENOENT", "ENOTDIR"].includes(e?.code)) return false; // no folder there: the pattern matches nothing
    throw e; // the agent check refuses what it cannot read
  }
}
/** Does a link command (ln, link) make a link whose target the hook cannot read, or whose target, read from the link's folder, overlaps the root? */
function linksNear(text, root, cwd) {
  return shellCommands(text).some(({ words }) => {
    const k = words.findIndex((w) => !/^\w+=/.test(w));
    if (!/^(?:ln|link)$/.test(basename(words[k] ?? ""))) return false;
    if (words.some((w) => w.includes("$"))) return true; // also $(…) and a backtick, which shellCommands gives as $(…)
    const operands = words.slice(k + 1).filter((w) => !w.startsWith("-"));
    const link = from(cwd, operands.at(-1) ?? ".");
    return operands.some((w) => [link, dirname(link)].some((dir) => overlaps(canonical(from(dir, pathOf(w))), root)));
  });
}
/** The commands that write, move, remove or link a file, also in PowerShell (case does not matter there). */
const WRITE_NAMES = new Set(["tee", "cp", "mv", "rm", "rmdir", "ln", "link", "install", "touch", "dd", "truncate", "rsync", "sponge", "patch", "unlink", "shred", "tar", "unzip", "set-content", "out-file", "add-content", "copy-item", "move-item", "remove-item", "rename-item", "new-item", "ni", "sc", "ac", "del"]);
/** The commands that only read: their words name no command to run, so only a redirection makes them write. */
const READERS = /^(?:cat|grep|egrep|fgrep|rg|head|tail|wc|echo|printf|ls|less|diff|cut|uniq|stat|file|jq|cd|pushd)$/;
/** A redirection of the command at word k to a file: not /dev/null, /dev/stdout or /dev/stderr, and not a &N duplicate. */
function toFile(words, k) {
  const w = words[k];
  let rest = w.slice(w.indexOf(">") + 1).replace(/^[>|]/, "");
  if (rest.startsWith("&")) {
    rest = rest.slice(1);
    if (/^\d+-?$|^-$/.test(rest)) return false;
  }
  return !/^\/dev\/(?:null|stdout|stderr)$/.test(rest || (words[k + 1] ?? ""));
}
function writesIn({ words, redirects }) {
  if (redirects.some((k) => toFile(words, k)) || words.some((w) => w.includes("<>"))) return true;
  const low = words.map((w) => w.toLowerCase());
  const base = low.map((w) => basename(w));
  if (READERS.test(base[low.findIndex((w) => !/^\w+=/.test(w))] ?? "")) return false;
  const has = (re) => base.some((w) => re.test(w));
  return (
    base.some((w) => WRITE_NAMES.has(w)) ||
    (has(/^g?sed$|^perl$|^ruby$/) && low.some((w) => /^-[a-z]*i|^--in-place/.test(w))) ||
    (has(/^g?awk$/) && low.includes("inplace")) ||
    (has(/^find$/) && low.some((w) => /^-(?:delete|exec|execdir|ok|okdir|fprint|fprintf|fls)$/.test(w))) ||
    (has(/^(?:node|deno|bun|python[\d.]*|perl|ruby|php|osascript|sh|bash|zsh|dash|ksh|fish|pwsh|powershell)$/) && low.some((w) => /^-(?:[a-z]*[ce]|p|-eval|-print|command)$/.test(w))) ||
    /^(?:eval|source|\.|exec)$/.test(base[low.findIndex((w) => !/^\w+=/.test(w))] ?? "")
  );
}
/** Does one field of a command's text have a write form? A text that the hook cannot read counts as one (fail closed). */
function writes(text) {
  try {
    return shellCommands(text).some(writesIn);
  } catch {
    return true;
  }
}
/** Is the command only the state tool: one command, node and the tool's path, with no redirection, pipe, chain or substitution? */
function stateToolOnly(command) {
  try {
    const [c, ...more] = shellCommands(command);
    return !more.length && !c.writes && !c.piped && !c.grouped && !c.bodies.length && c.words[0] === "node" && /(?:^|\/)skills\/sage\/sage\.mjs$/.test(c.words[1] ?? "") && !c.words[1].split("/").includes("..");
  } catch {
    return false; // the hook cannot read it
  }
}
/** The file that a file tool changes, as a canonical path under the sage root, or undefined. It throws when it cannot resolve a path. */
function underRoot(input) {
  const ti = input.tool_input ?? {};
  const root = canonical(stateTool.sageRoot(process.env));
  const path = canonical(from(input.cwd ?? process.cwd(), String(ti.file_path ?? ti.notebook_path ?? "")));
  return path === root || path.startsWith(root + sep) ? `the sage root ${root} (${path})` : undefined;
}
/** Does a command tool's input write a logbook file? sage: in sage mode a logbook file's name counts too. */
function shellWrite(ti, sage, cwd) {
  const text = fields(ti);
  const all = text.join("\n");
  const words = partsOf(all);
  return text.some(writes) && (namesRoot(all, words, rootsOf(false), cwd) || (sage && namesTable(words))) && !stateToolOnly(typeof ti.command === "string" ? ti.command : "");
}
/**
 * The chief's own tools change no logbook file either (S2): only sage.mjs does, so each change leaves its record. A file
 * tool never writes under the sage root, and a command that names the sage root (or, in sage mode, a logbook file) with a
 * write form is refused, unless it is only the state tool. The hook sees the command, not the files that sage.mjs writes.
 * The owner's own ! commands are no hook events, so they stay free. Undefined, or the reason for the refusal.
 */
function chiefProblem(input, sage) {
  if (FILE_TOOLS.test(input.tool_name ?? "")) {
    try {
      const at = underRoot(input);
      return at && `the chief never writes under ${at} with a file tool.`;
    } catch {
      return undefined; // the sage root cannot be read: in sage mode, the rule that the chief changes no file still refuses
    }
  }
  if (!COMMAND_TOOLS.test(input.tool_name ?? "")) return undefined;
  return shellWrite(input.tool_input ?? {}, sage, input.cwd ?? process.cwd()) ? "the chief never writes, moves or removes a logbook file from the shell." : undefined;
}
/**
 * Does a command's text run the state tool ("tool") or the PR script ("pr")? It decides on the program that runs, not on
 * a mention, so a read, a diff or a commit message that names sage.mjs passes (T83-C2). The program is the first word
 * after assignments, options and wrappers (env, xargs, ...), and the word after -exec. It runs the file when it is the
 * file; when it is an interpreter (node, python, ...) whose words up to its script, whose heredoc or whose piped input
 * name the file; and when text that a shell or eval runs does. A variable or substitution there runs the file when the
 * text names it anywhere, and so does text that the hook cannot read. Deliberate forgery past this is the sandbox's job.
 */
const kind = (text) => (/sage-pr\.mjs/i.test(text) ? "pr" : /sage\.mjs/i.test(text) ? "tool" : undefined);
const WRAPPERS = /^(?:sudo|doas|env|nice|nohup|timeout|gtimeout|xargs|exec|stdbuf|caffeinate|watch|command|builtin|time|noglob|nocorrect)$/;
const INTERPRETERS = /^(?:node|nodejs|deno|bun|python[\d.]*|perl|ruby|php|osascript|source|\.)$/;
const SHELL_RUNNERS = /^(?:sh|bash|zsh|dash|ksh|fish|pwsh|powershell)$/;
function scriptRun(text, depth = 0) {
  const named = kind(text.replace(/['"\\]/g, ""));
  if (!named) return undefined;
  let commands;
  try {
    commands = shellCommands(text);
  } catch {
    return named;
  }
  for (const c of commands) {
    for (const start of [0, ...c.words.flatMap((w, k) => (/^-(?:exec|execdir|ok|okdir)$/.test(w) ? [k + 1] : []))]) {
      const words = c.words.slice(start);
      const k = words.findIndex((w) => !/^\w+=/.test(w) && !w.startsWith("-") && !/^\d+[smhd]?$/.test(w) && !WRAPPERS.test(basename(w)));
      if (k < 0) continue;
      const name = basename(words[k]).toLowerCase();
      const rest = words.slice(k + 1);
      if (words[k].includes("$")) return named;
      if (/^sage(?:-pr)?\.mjs$/.test(name)) return kind(name);
      if (name === "eval" || SHELL_RUNNERS.test(name)) {
        if (depth >= 3 || rest.some((w) => w.includes("$"))) return named;
        const inner = [...(name === "eval" ? [rest.join(" ")] : rest.filter((w) => /\s/.test(w))), ...c.bodies];
        const run = inner.map((t) => scriptRun(t, depth + 1)).sort()[0];
        if (run) return run;
      } else if (INTERPRETERS.test(name)) {
        const script = rest.findIndex((w) => !w.startsWith("-"));
        const head = script < 0 ? rest : rest.slice(0, script + 1);
        if (head.some((w) => w.includes("$"))) return named;
        const piped = commands.filter((p) => p.pipeTo === c).map((p) => p.words.join(" "));
        const run = [...head, ...c.bodies, ...piped].map(kind).sort()[0];
        if (run) return run;
      }
    }
  }
  return undefined;
}
/** An agent's check fails closed: when it throws, the agent's command or file change is refused. */
function agentProblem(input) {
  const file = FILE_TOOLS.test(input.tool_name ?? "");
  if (!file && !COMMAND_TOOLS.test(input.tool_name ?? "")) return undefined;
  try {
    return agentCheck(input, file);
  } catch (e) {
    return `the hook could not check this agent's ${file ? "file change" : "command"} (${e?.message ?? e}), so it refuses it.`;
  }
}
function agentCheck(input, file) {
  const ti = input.tool_input ?? {};
  const roots = rootsOf(true); // fail closed: an agent does nothing while the sage root cannot be resolved
  if (file) {
    const at = underRoot(input);
    return at ? `an agent never writes under ${at}.` : undefined;
  }
  if (ti.dangerouslyDisableSandbox) return "an agent never runs a command outside the sandbox (dangerouslyDisableSandbox).";
  const command = typeof ti.command === "string" ? ti.command : "";
  const run = fields(ti).map((t) => scriptRun(t)).sort()[0]; // "pr" sorts before "tool"
  if (run === "pr") return "only the chief runs the PR script (sage-pr.mjs).";
  if (run === "tool") {
    const [node, path, cmd, ...args] = command.trim().split(/[ \t]+/);
    const own = PLAIN.test(command.trim()) && node === "node" && /(?:^|\/)skills\/sage\/sage\.mjs$/.test(path) && !path.split("/").includes("..");
    if (!own || canonical(resolve(input.cwd ?? process.cwd(), path)) !== canonical(TOOL)) return "an agent runs the state tool only as one plain command, with nothing before or after it, and only the copy that this hook loads.";
    // The words that are not options or option values, read as the state tool reads them (sage.mjs parse).
    const pos = [];
    for (let k = 0; k < args.length; k++) {
      if (!args[k].startsWith("--")) pos.push(args[k]);
      else if (!args[k].includes("=")) k++;
    }
    return Object.hasOwn(READS, cmd ?? "") && READS[cmd](pos) ? undefined : `"${[cmd, ...pos.slice(0, 1)].join(" ")}" writes the logbook, or is not a read command of the state tool.`;
  }
  const text = fields(ti);
  const cwd = input.cwd ?? process.cwd();
  return text.some(writes) && (nearLogbook(text.join("\n"), roots, cwd) || text.some((t) => linksNear(t, roots[1], cwd))) ? "an agent never writes, moves or removes a logbook file from the shell, and never writes near one with a pattern, a variable or a link to it." : undefined;
}

/**
 * The canonical path for a compare: the real path of its longest part that exists (a link is followed, also when its
 * target is missing), in lower case and NFC, because APFS ignores both. On a volume that is case-sensitive, this can only
 * refuse more.
 */
const canonical = (path) => fold(real(path));
function real(path) {
  let rest = [];
  for (let hops = 0; ; ) {
    try {
      return join(realpathSync.native(path), ...rest); // the system resolves ".." after each link; only the missing rest is joined
    } catch {
      let link = false;
      try {
        link = lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink();
      } catch {} // a name that is too long, or a file used as a folder: it does not exist
      if (link) {
        if (++hops > 64) throw new Error(`too many links in ${path}`);
        path = from(dirname(path), readlinkSync(path));
      } else if (dirname(path) === path) return join(path, ...rest);
      else [path, rest] = [dirname(path), [basename(path), ...rest]];
    }
  }
}

const MERGE_FORM = "gh pr merge <n> --squash --delete-branch --match-head-commit <sha>";

function gitGate(event, command, state, cwd, main) {
  const first = main ? firstUpload(command) : undefined; // an agent never gets the exception
  if (first) {
    const { decision, reason } = firstCreation(first);
    return decide(event, decision, reason);
  }
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
  if (!/^[1-9]\d*$/.test(pr ?? "")) return { problem: `name the pull request by its number, with no leading zero: ${MERGE_FORM}.` };
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
  const fresh = () => ({ words: [], bodies: [], host, piped: false, grouped: false, writes: false, redirects: [], heredoc: false });
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
      cmd.redirects.push(cmd.words.length); // the word that holds it
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
/**
 * An id from an event (a session, an agent or a tool use) as a file name: one safe character set, at most 128
 * characters, so that it can never name a path outside its directory or one the file system refuses. Every write and
 * every comparison of an id goes through this one mapping.
 */
const safe = (raw) => String(raw ?? "").replace(/[^\w.-]/g, "_").slice(0, 128);

/** A refusal, or a question to the user. Its reason can quote the command, so its control characters are escaped: they can change what a terminal shows. */
const decide = (event, decision, reason) => ({ hookSpecificOutput: { hookEventName: event, permissionDecision: decision, permissionDecisionReason: `sage: ${String(reason).replace(/\p{Cc}/gu, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)}` } });
const deny = (event, reason) => decide(event, "deny", reason);

/**
 * The agent cap. All sessions share one slot directory. Each running sage agent holds one slot: a numbered directory
 * that mkdir creates atomically, so agents that the chief starts in one message cannot take the same slot, and the
 * slot numbers are the total cap. A slot's marks name its project, its session and its tool use; it is pending from
 * the spawn until SubagentStart names the agent, and a spawn that passed marks its slot ok. A project's cap is a true
 * count of its other slots: every one with a lower number (a slot with no marks yet counts as the project's), and every
 * higher one that passed. A higher slot that has not passed yet is a simultaneous spawn, and it counts this slot in its
 * turn, so simultaneous spawns get the same answer as spawns in a row. A slot is free again at SubagentStop, at a
 * TaskStop of its session, when the spawn fails before its agent started, when the session's live tasks no longer name
 * the agent at the session's Stop, or when nothing touched it for an hour. Each release looks only among the session's
 * own slots.
 */
export function slotsFor(dir, session, now = Date.now()) {
  const STALE = { pending: 10 * 60_000, agent: 60 * 60_000 };
  const id = (raw) => safe(raw) || undefined; // an id that is empty after the mapping is missing
  const num = (slot) => Number(slot.slice(5));
  const list = () => {
    try {
      return readdirSync(dir).filter((d) => d.startsWith("slot-")).sort((a, b) => num(a) - num(b));
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
  const mark = (slot, prefix) => marks(slot).find((m) => m.startsWith(prefix))?.slice(prefix.length);
  const ofSession = () => list().filter((slot) => mark(slot, "session-") === session);
  const withMark = (name) => ofSession().find((slot) => marks(slot).includes(name));
  const free = (slot) => {
    if (!slot) return;
    try {
      rmdirSync(join(dir, slot)); // an empty slot goes even when it cannot be read: the marks could not be written
    } catch {
      rmSync(join(dir, slot), { recursive: true, force: true });
    }
  };
  const expire = () => {
    for (const slot of list()) {
      const kind = mark(slot, "agent-") === undefined ? "pending" : "agent";
      try {
        if (now - statSync(join(dir, slot)).mtimeMs > STALE[kind]) free(slot);
      } catch {
        /* freed meanwhile */
      }
    }
  };
  const counts = (project) => {
    const all = list();
    return { total: all.length, project: all.filter((slot) => mark(slot, "project-") === project).length };
  };
  return {
    /** Takes a slot for a spawn: { ok }, or the refusal ("project" or "total") with the counts of running agents. */
    take(project, cap, capTotal, toolUseId) {
      mkdirSync(dir, { recursive: true });
      expire();
      let mine;
      for (let k = 1; k <= capTotal && !mine; k++) {
        try {
          mkdirSync(join(dir, `slot-${k}`));
          mine = `slot-${k}`;
        } catch {
          /* taken */
        }
      }
      if (!mine) return { refused: "total", ...counts(project) };
      try {
        const tu = id(toolUseId) ?? String(now);
        for (const m of [`project-${project}`, `session-${session}`, `tool-${tu}`, `pending-${tu}`]) writeFileSync(join(dir, mine, m), "");
        const counted = (slot) => slot !== mine && (mark(slot, "project-") ?? project) === project && (num(slot) < num(mine) || marks(slot).includes("ok"));
        if (list().filter(counted).length < cap) {
          writeFileSync(join(dir, mine, "ok"), "");
          return { ok: true };
        }
        free(mine);
        return { refused: "project", ...counts(project) };
      } catch (e) {
        free(mine); // a slot with some marks would count against the project for 10 minutes
        return { refused: "mark", error: e?.message ?? String(e), ...counts(project) };
      }
    },
    bind(agentId) {
      if (!id(agentId)) return;
      for (const slot of ofSession()) {
        const pending = marks(slot).find((m) => m.startsWith("pending-"));
        if (!pending) continue;
        try {
          renameSync(join(dir, slot, pending), join(dir, slot, `agent-${id(agentId)}`)); // atomic: one start binds one slot
          return;
        } catch {
          /* another start took this one */
        }
      }
    },
    release: (agentId) => free(withMark(`agent-${id(agentId)}`)),
    /** A failed spawn frees its slot while it is pending. A bound slot stays: SubagentStart names no tool use, so the agent may be another spawn's. */
    drop: (toolUseId) => free(withMark(`pending-${id(toolUseId)}`)),
    touch(agentId) {
      try {
        utimesSync(join(dir, withMark(`agent-${id(agentId)}`)), new Date(now), new Date(now));
      } catch {
        /* no slot: the agent's slot expired, or it is not a sage agent's */
      }
    },
    /** Frees the session's bound slots whose agent is not among the live task ids. */
    reconcile(liveIds) {
      liveIds = liveIds.map(id);
      for (const slot of ofSession()) {
        const agent = mark(slot, "agent-");
        if (agent !== undefined && !liveIds.includes(agent)) free(slot);
      }
    },
    /** One line per refusal in the hook state folder, next to the slots: the time, the project and the counts. */
    log(text) {
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, "..", "refusals.log"), `${new Date(now).toISOString()} ${text}\n`);
    },
  };
}

const stateDir = () => process.env.SAGE_HOOKS_STATE ?? join(tmpdir(), "sage-hooks");

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
    const output = handle(input, state, slotsFor(join(stateDir(), "slots"), session));
    if (JSON.stringify(state) !== before) {
      mkdirSync(stateDir(), { recursive: true });
      writeFileSync(`${file}.${process.pid}`, JSON.stringify(state));
      renameSync(`${file}.${process.pid}`, file);
    }
    if (output) process.stdout.write(JSON.stringify(output));
  } catch (e) {
    // Never break the session, but never let a merge or a push through because the hook failed.
    const command = [].concat(input?.tool_input?.command ?? []).join(" ");
    const tools = (re) => re.test(input?.tool_name ?? "");
    const agentWrite = agentEvent(input) && (tools(FILE_TOOLS) || tools(COMMAND_TOOLS)); // fail closed: an agent does nothing unchecked
    let chiefWrite;
    try {
      chiefWrite = tools(COMMAND_TOOLS) && shellWrite(input.tool_input ?? {}, true, input.cwd ?? process.cwd());
    } catch {
      chiefWrite = tools(COMMAND_TOOLS);
    }
    if (input?.hook_event_name === "PreToolUse" && (mentionsMerge(command) || pushText(command) || agentWrite || chiefWrite)) {
      process.stdout.write(JSON.stringify(deny("PreToolUse", `the hook could not check this command (${e?.message ?? e}), so it refuses it. Tell the user.`)));
    }
  }
}
