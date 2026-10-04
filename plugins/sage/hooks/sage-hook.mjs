#!/usr/bin/env node
// The sage hook. Claude Code sends one JSON event on stdin; the hook answers with one JSON object on stdout, or nothing.
//   - "sage mode" makes the session the user's chief of staff (agents/chief-of-staff.md) until "sage mode off". A
//     session that starts as the sage:chief-of-staff agent is in sage mode from its first event. Only the user's own
//     messages switch a mode: never an agent's report, a task notification or another session's message (promptOf).
//   - In sage mode it holds the rules that prompts alone did not hold in Orchestrator (docs/design/sage-mode.html,
//     "Rules"): the chief never edits files, every brief has all its fields, at most max_agents sage agents run at
//     once, nobody force-pushes or pushes to main, and a merge needs autopilot on, the checked head SHA and the clean
//     cycles that the ledger records for it (the merge check).
//   - A sage agent may finish only with the full report of the sage:report skill.
// SAGE_HOOKS=off turns it off. The hook never breaks a session: on an error it answers nothing, but it refuses a merge.
import { mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The state tool. When it cannot load, the hook still runs, and its merge check refuses every merge.
const stateTool = await import("../skills/sage/sage.mjs").catch((error) => ({ error }));
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// The mode phrases, in a message from the user (promptOf). "sage mode" (also "sage mode on"), "sage mode off" and
// "autopilot on" count only at the start of the message, so that a mention or a quote switches nothing: "sage mode
// off" also drops the git rules. "sage mode" and "autopilot on" must stand alone or end at ".", ",", ":", ";", "!" or
// the end of their line, so "autopilot on?" and "autopilot on main" switch nothing. "sage mode off" must not run on into
// a longer word ("sage mode off-topic"), and its line must have no "?" ("sage mode off? what does it do?"). Because a
// missed off is the unsafe one, a message that starts with "sage mode off" always switches autopilot off, even as a
// question, and so does any message that mentions autopilot and has an off word anywhere. Off wins over on.
// No mode-phrase regex has the m flag: with it, "^" would also match the start of each later line.
const START = String.raw`^[\s"'“‘*_>-]*`;
const SP = String.raw`[^\S\r\n  ]`; // a space, a tab or an NBSP, never a line break
const END = String.raw`(?=${SP}*(?:[.,:;!\r\n  ]|$))`;
const SAGE = String.raw`(?:enter${SP}+)?sage${SP}+mode(?:${SP}+on)?`;
const AND_AUTOPILOT = String.raw`(?:${SP}+autopilot|(?:${SP}*[.,:;!]${SP}*|${SP}+)autopilot${SP}+on)`; // "sage mode autopilot", "sage mode, autopilot on"
const SAGE_ON = new RegExp(`${START}${SAGE}${AND_AUTOPILOT}?${END}`, "i");
const SAGE_MODE_OFF = new RegExp(`${START}sage${SP}+mode${SP}+off\\b`, "i");
const SAGE_OFF = new RegExp(`${START}sage${SP}+mode${SP}+off(?![\\p{L}\\p{N}-])(?!.*\\?)`, "iu"); // "." stops at a line break
const AUTOPILOT_ON = new RegExp(`${START}(?:autopilot${SP}+on|${SAGE}${AND_AUTOPILOT})${END}`, "i");
// The word autopilot, and the off words in any form ("no more", "turn off", "switch off" and "hold off" have one too).
const AUTOPILOT = /\bauto[-\s]?pilots?\b/i;
const OFF_WORD = /\b(?:off|no|without|don['’]?t|do\s+not|end(?:s|ed|ing)?|quit(?:s|ting)?|exit(?:s|ed|ing)?)\b|\b(?:stop|disabl|paus|cancel|kill|halt|deactivat|abort|suspend)|\bauto[-\s]?pilots?\s*=\s*false\b/i;
const autopilotOff = (prompt) => SAGE_MODE_OFF.test(prompt) || (AUTOPILOT.test(prompt) && OFF_WORD.test(prompt));
const FILE_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit)$/;
const AGENT_TOOLS = /^(Agent|Task)$/;
const CHIEF = /(^|:)chief-of-staff$/;
const OURS = /^sage:/;
export const BRIEF_FIELDS = ["GOAL", "SCOPE", "CONTEXT", "DECISIONS", "ACCEPTANCE", "VERIFY", "BUDGET", "FORBIDDEN", "REPORT", "STANDING"];
export const REPORT_FIELDS = ["STATUS", "RESULT", "EVIDENCE", "FINDINGS", "QUESTIONS", "NOT VERIFIED", "BRANCH"];
/** The fields of a template that do not start a line. Markdown around a field ("**STATUS**", "| STATUS |") is fine. */
const missingFields = (fields, text) => fields.filter((f) => !new RegExp(`^[\\s*_#|>-]*${f}\\b`, "m").test(text ?? ""));

/**
 * A prompt and its author. Claude Code also sends agents' reports, task notifications and other sessions' messages as
 * prompts. In 2.1.288 its hook input has no author field (the docs name prompt_source, which that build does not send),
 * so a prompt that starts with one of the frames that Claude Code puts around them is the harness's too.
 */
const HARNESS_FRAME = /^\s*(?:Another Claude session sent a message:|<agent-message[\s>]|<task-notification>)/;
export function promptOf(input) {
  const text = input.prompt ?? "";
  const harness = (input.prompt_source != null && input.prompt_source !== "user") || HARNESS_FRAME.test(text);
  return { author: harness ? "harness" : "owner", text };
}

/** Switches the modes by the user's own message, and returns the notes for the chief. */
function switchModes(text, state) {
  const notes = [];
  if (SAGE_OFF.test(text)) {
    Object.assign(state, { sage: false, given: false, autopilot: false });
    notes.push("sage: sage mode is off. You may change files yourself again.");
  } else if (SAGE_ON.test(text)) state.sage = true;
  if (autopilotOff(text)) {
    if (state.autopilot) notes.push("sage: autopilot is off. Work stops at verified, and the user merges.");
    state.autopilot = false;
  } else if (state.sage && AUTOPILOT_ON.test(text)) {
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
    const { author, text } = promptOf(input);
    const notes = author === "owner" ? switchModes(text, state) : [];
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
  if (tool === "Bash") return gitGate(event, [].concat(ti.command ?? []).join(" "), state);
  return undefined;
}

/** A git push, also with git's own options first: git -C <dir> push, git -c <key=value> push. */
const PUSH = String.raw`\bgit(?:\s+-[Cc]\s+\S+)*\s+push\b`;

const MERGE_FORM = "gh pr merge <n> --squash --delete-branch --match-head-commit <sha>";

function gitGate(event, command, state) {
  if (new RegExp(`${PUSH}[^;&|]*\\s(--force\\S*|-f)(?=\\s|$)`).test(command)) return deny(event, "sage mode never force-pushes. Push a new commit instead.");
  if (new RegExp(`${PUSH}[^;&|]*[\\s:](main|master)(?=\\s|$|[;&|])`).test(command)) return deny(event, "work reaches main only through a pull request. Push the task's branch and open a pull request.");
  const merge = mergeIn(command);
  if (!merge) return undefined;
  if (merge.unsure) return deny(event, `the merge check cannot tell whether this command merges: ${merge.unsure}. Run a merge as a command of its own: ${MERGE_FORM}.`);
  if (!state.autopilot) return deny(event, 'autopilot is off, so the user merges. Report the pull request as ready. The user turns it on with a message that starts with "autopilot on".');
  if (merge.problem) return deny(event, merge.problem);
  let verdict;
  try {
    if (stateTool.error) throw stateTool.error;
    verdict = stateTool.mergeCheck(merge.sha, process.env, { pr: merge.pr });
  } catch (e) {
    verdict = { reason: `it could not run (${e?.message ?? e}), so it refuses every merge. Tell the user.` };
  }
  return verdict?.ok === true ? undefined : deny(event, `the merge check refuses: ${verdict?.reason}`);
}

/** Text that may name a merge: the merge command, or a merge through the GitHub API (REST or GraphQL). */
const API_MERGE = /\/pulls\/\d+\/merge\b|\/merges\b|\b(?:mergePullRequest|mergeBranch|enablePullRequestAutoMerge)\b/i;
const mentionsMerge = (text) => /\bgh\b[\s\S]*\bmerge\b/i.test(text.replace(/['"\\]/g, "")) || API_MERGE.test(text);
/** A command that runs text as code: a shell, eval, source, xargs, or an interpreter with inline code (node -e). */
const RUNNER = /^(?:sh|bash|zsh|dash|ksh|fish|eval|source|xargs)$/;
const INTERPRETER = /^(?:node|deno|bun|python[\d.]*|perl|ruby)$/;
const name = (word) => word.slice(word.lastIndexOf("/") + 1);
const runsText = (words) => words.some((w) => RUNNER.test(name(w))) || (words.some((w) => INTERPRETER.test(name(w))) && words.some((w) => /^-\w*[cepE]\w*$|^--(?:eval|print)\b/.test(w)));

/**
 * The merge in a Bash command, read from its shell words, so that the merge command's words in quoted text or in a
 * heredoc are not a merge. Undefined when the command merges nothing. Else { pr, sha } for one well-formed merge,
 * { problem } for a merge that the check refuses, or { unsure } when the hook cannot read the command well enough.
 */
export function mergeIn(command) {
  let commands, bodies;
  try {
    ({ commands, bodies } = shellCommands(command));
  } catch (e) {
    return mentionsMerge(command) ? { unsure: `the hook cannot read it (${e.message})` } : undefined;
  }
  if (commands.some(runsText) && [...commands.flat(), ...bodies].some(mentionsMerge)) return { unsure: "it gives text that names a merge to a shell or an interpreter" };
  const merges = commands.map(mergeOf).filter(Boolean);
  if (!merges.length) return undefined;
  if (merges.length > 1) return { problem: `run one merge per command; this command has ${merges.length}.` };
  const [{ api, targets, shas }] = merges;
  if (api) return { problem: `merge only with ${MERGE_FORM}, not through the GitHub API: the merge check needs the pull request's number and its head SHA.` };
  const pr = targets.length === 1 ? /^#?(\d+)$|^https:\/\/\S+\/pull\/(\d+)(?:[/?#]\S*)?$/.exec(targets[0])?.slice(1).find(Boolean) : undefined;
  if (!pr) return { problem: `name the pull request by its number: ${MERGE_FORM}.` };
  if (!shas.length) return { problem: "merge only the checked commit: add --match-head-commit <the head SHA that the ledger verified>." };
  if (shas.length > 1) return { problem: `give --match-head-commit once, not ${shas.length} times: gh uses the last one, and the merge check reads one.` };
  if (!/^[0-9a-f]{40}$/i.test(shas[0])) return { problem: `--match-head-commit needs the full 40-character head SHA that the ledger verified, not "${shas[0]}".` };
  return { pr, sha: shas[0] };
}

/** The other flags of gh pr and gh pr merge that take a value. */
const GH_VALUE = new Set(["-R", "--repo", "-b", "--body", "-F", "--body-file", "-t", "--subject", "-A", "--author-email"]);
const HTTP_TOOLS = /^(?:curl|wget|http|https|xh)$/;

/** The merge in one simple command: gh pr merge (also after sudo, env or xargs), or a merge through the GitHub API. */
function mergeOf(words) {
  for (let i = 0; i < words.length; i++) {
    if (name(words[i]) !== "gh") continue;
    const positional = [];
    const shas = [];
    for (let k = i + 1; k < words.length; k++) {
      const w = words[k];
      if (w === "--") {
        positional.push(...words.slice(k + 1));
        break;
      }
      if (w.startsWith("--match-head-commit=")) shas.push(w.slice(w.indexOf("=") + 1));
      else if (w === "--match-head-commit") shas.push(words[++k] ?? "");
      else if (GH_VALUE.has(w)) k++;
      else if (!w.startsWith("-")) positional.push(w);
    }
    if (positional[0] === "pr" && positional[1] === "merge") return { targets: positional.slice(2), shas };
    if (positional[0] === "api" && words.some((w) => API_MERGE.test(w))) return { api: true };
  }
  if (words.some((w) => HTTP_TOOLS.test(name(w))) && words.some((w) => API_MERGE.test(w))) return { api: true };
  return undefined;
}

/**
 * The simple commands of a shell command line, as lists of words without their quotes, and the bodies of its
 * heredocs, which stay text. A command substitution, $( ) or a backtick, gives commands of its own: outside quotes,
 * in double quotes, and in a heredoc whose delimiter has no quotes. Throws when it cannot read the line: an open
 * quote, substitution or heredoc, or a ")" with no "(".
 */
export function shellCommands(src) {
  const out = { commands: [], bodies: [] };
  readCommands(src, 0, "", out);
  return out;
}

function readCommands(src, i, close, out) {
  let words = [];
  let word;
  let depth = 0;
  const heredocs = [];
  const add = (text) => (word = (word ?? "") + text);
  const endWord = () => {
    if (word !== undefined) words.push(word);
    word = undefined;
  };
  const endCommand = () => {
    endWord();
    if (words.length) out.commands.push(words);
    words = [];
  };
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
      const r = readExpanding(src, i + 1, '"', out);
      add(r.text);
      i = r.i;
    } else if (c === "`" || (c === "$" && src[i + 1] === "(")) {
      i = readCommands(src, i + (c === "`" ? 1 : 2), c === "`" ? "`" : ")", out);
      add("$(…)");
    } else if (c === "#" && word === undefined) {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (src.startsWith("<<<", i)) {
      add("<<<");
      i += 3;
    } else if (src.startsWith("<<", i)) {
      endWord();
      i = readDelimiter(src, i + 2, heredocs);
    } else if (c === "\n") {
      endCommand();
      i = readBodies(src, i + 1, heredocs, out);
    } else if (c === " " || c === "\t") {
      endWord();
      i++;
    } else if (c === ";" || c === "&" || c === "|" || c === "(" || c === ")") {
      if (c === ")" && !depth--) throw new Error('a ")" with no "("');
      if (c === "(") depth++;
      endCommand();
      i++;
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
function readExpanding(src, i, stop, out) {
  let text = "";
  while (i < src.length && src[i] !== stop) {
    const c = src[i];
    if (c === "\\" && i + 1 < src.length) {
      text += '$`"\\'.includes(src[i + 1]) ? src[i + 1] : src[i + 1] === "\n" ? "" : c + src[i + 1];
      i += 2;
    } else if (c === "`" || (c === "$" && src[i + 1] === "(")) {
      i = readCommands(src, i + (c === "`" ? 1 : 2), c === "`" ? "`" : ")", out);
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
function readDelimiter(src, i, heredocs) {
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
  heredocs.push({ delimiter, strip, expand: !quoted });
  return i;
}

/** The bodies of the heredocs that the last line opened, read up to each delimiter line. */
function readBodies(src, i, heredocs, out) {
  for (const { delimiter, strip, expand } of heredocs.splice(0)) {
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
    out.bodies.push(body);
    if (expand) readExpanding(body, 0, "", out);
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
    // Never break the session, but never let a merge through because the hook failed.
    if (input?.hook_event_name === "PreToolUse" && mentionsMerge([].concat(input.tool_input?.command ?? []).join(" "))) {
      process.stdout.write(JSON.stringify(deny("PreToolUse", `the merge check could not run (${e?.message ?? e}), so it refuses this command. Tell the user.`)));
    }
  }
}
