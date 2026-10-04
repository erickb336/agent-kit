#!/usr/bin/env node
// The sage hook. Claude Code sends one JSON event on stdin; the hook answers with one JSON object on stdout, or nothing.
//   - "sage mode" makes the session the user's chief of staff (agents/chief-of-staff.md) until "sage mode off". A
//     session that starts as the sage:chief-of-staff agent is in sage mode from its first event.
//   - In sage mode it holds the rules that prompts alone did not hold in Orchestrator (docs/design/sage-mode.html,
//     "Rules"): the chief never edits files, every brief has all its fields, at most max_agents sage agents run at
//     once, nobody force-pushes or pushes to main, and `gh pr merge` needs autopilot on, the checked head SHA and the
//     clean cycles that the ledger records for it.
//   - A sage agent may finish only with the full report of the sage:report skill.
// SAGE_HOOKS=off turns it off. The hook never breaks a session: on any error it answers nothing.
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config, mergeCheck } from "../skills/sage/sage.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// The mode phrases. "sage mode" (also "sage mode on"), "sage mode off" and "autopilot on" count only at the start of the
// message, so that a mention, a quote or an agent's report ("<task-notification>…") switches nothing: "sage mode off"
// also drops the git gates. "sage mode" and "autopilot on" must stand alone or end at ".", ",", ":", ";", "!" or the end
// of their line, so "autopilot on?" and "autopilot on main" switch nothing. "sage mode off" must not run on into a longer
// word ("sage mode off-topic"), and its line must have no "?" ("sage mode off? what does it do?"). Because a missed off
// is the unsafe one, a message that starts with "sage mode off" always switches autopilot off, even as a question, and
// so does any message that mentions autopilot and has an off word anywhere. Off wins over on in the same message.
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

export function handle(input, state, slots) {
  const event = input.hook_event_name;
  const main = !input.agent_id; // Claude Code sets agent_id only for a subagent's events
  if (main && CHIEF.test(input.agent_type ?? "")) state.sage = true;

  if (event === "UserPromptSubmit") {
    const prompt = input.prompt ?? "";
    const notes = [];
    if (SAGE_OFF.test(prompt)) {
      Object.assign(state, { sage: false, given: false, autopilot: false });
      notes.push("sage: sage mode is off. You may change files yourself again.");
    } else if (SAGE_ON.test(prompt)) state.sage = true;
    if (autopilotOff(prompt)) {
      if (state.autopilot) notes.push("sage: autopilot is off. Work stops at verified, and the user merges.");
      state.autopilot = false;
    } else if (state.sage && AUTOPILOT_ON.test(prompt)) {
      state.autopilot = true;
      notes.push(`sage: autopilot is on. A pull request merges after ${config().autopilot_cycles} clean cycles on its head SHA, with gh pr merge <n> --squash --delete-branch --match-head-commit <sha>.`);
    }
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
    const cap = config().max_agents;
    if (!slots.take(cap, input.tool_use_id ?? String(Date.now()))) return deny(event, `${cap} sage agents are running, and the cap is ${cap}. Wait for one to finish, then start this one.`);
  }
  if (tool === "Bash") return gitGate(event, [].concat(ti.command ?? []).join(" "), state);
  return undefined;
}

/** A git push, also with git's own options first: git -C <dir> push, git -c <key=value> push. */
const PUSH = String.raw`\bgit(?:\s+-[Cc]\s+\S+)*\s+push\b`;

function gitGate(event, command, state) {
  if (new RegExp(`${PUSH}[^;&|]*\\s(--force\\S*|-f)(?=\\s|$)`).test(command)) return deny(event, "sage mode never force-pushes. Push a new commit instead.");
  if (new RegExp(`${PUSH}[^;&|]*[\\s:](main|master)(?=\\s|$|[;&|])`).test(command)) return deny(event, "work reaches main only through a pull request. Push the task's branch and open a pull request.");
  if (!/\bgh\s+pr\s+merge\b/.test(command)) return undefined;
  if (!state.autopilot) return deny(event, 'autopilot is off, so the user merges. Report the pull request as ready. The user turns it on with a message that starts with "autopilot on".');
  const sha = /--match-head-commit(?:=|\s+)([0-9a-f]{7,40})\b/.exec(command)?.[1];
  if (!sha) return deny(event, "merge only the checked commit: add --match-head-commit <the head SHA that the ledger verified>.");
  const verdict = mergeCheck(sha);
  return verdict.ok ? undefined : deny(event, `the merge gate refuses: ${verdict.reason}`);
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
const deny = (event, reason) => ({ hookSpecificOutput: { hookEventName: event, permissionDecision: "deny", permissionDecisionReason: `sage: ${reason}` } });

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

if (process.argv[1] === fileURLToPath(import.meta.url) && process.env.SAGE_HOOKS !== "off") {
  try {
    const input = JSON.parse(readFileSync(0, "utf8"));
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
  } catch {
    /* never break the session */
  }
}
