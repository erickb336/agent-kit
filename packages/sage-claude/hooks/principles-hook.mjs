#!/usr/bin/env node
// The principles hook of sage. Claude Code sends one JSON event on stdin and reads one JSON answer on stdout.
//   - It puts a principle's text into the agent's context at the moment the principle applies (MOMENTS), once per
//     session. So the principle no longer depends on the agent choosing to load its skill.
//   - It stops the agent once from finishing when the code changed and no check ran after the change (prove-it-works).
// AGENT_KIT_HOOKS=off turns it off. Orchestrator sets it for its workers, because it gives each step its own principles.
// The AGENT_KIT_* names stay from the kit's first name, agent-kit, so that Orchestrator's workers keep working.
// The hook never breaks a session: on any error it answers nothing.
import { appendFileSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SKILLS = join(dirname(fileURLToPath(import.meta.url)), "../skills");

import { applyPrinciples, MOMENTS, fingerprint } from "sage-core";
export { MOMENTS, fingerprint };

export function skillText(name) {
  return readFileSync(join(SKILLS, name, "SKILL.md"), "utf8").replace(/^---\n[\s\S]*?\n---\n/, "").replace(/<!--[\s\S]*?-->/, "").trim();
}

export function handle(input, state) {
  const events = { UserPromptSubmit: "prompt", PreToolUse: "before-tool", PostToolUse: "after-tool", PostToolUseFailure: "after-tool", PostCompact: "compact", Stop: "stop" };
  const shell = input.tool_name === "Bash";
  const result = applyPrinciples({
    kind: events[input.hook_event_name], cwd: input.cwd, prompt: input.prompt,
    command: shell ? [].concat(input.tool_input?.command ?? []).join(" ") : undefined,
    paths: shell ? [] : [input.tool_input?.file_path, input.tool_input?.notebook_path].filter((p) => typeof p === "string"),
    inspection: /^(mcp__.*(browser|preview|simulator|chrome|playwright)|browser)/i.test(input.tool_name ?? "") ? input.tool_name : undefined,
    outcome: input.hook_event_name === "PostToolUseFailure" ? "failure" : "success",
    continuing: input.stop_hook_active,
  }, state, skillText);
  return result?.context ? { hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: result.context } } : result;
}

function stateFile(sessionId) {
  return join(process.env.AGENT_KIT_HOOKS_STATE ?? join(tmpdir(), "agent-kit-hooks"), `${String(sessionId).replace(/[^\w.-]/g, "_")}.json`);
}

function loadState(sessionId) {
  try {
    return JSON.parse(readFileSync(stateFile(sessionId), "utf8"));
  } catch {
    return { given: [], failures: {} };
  }
}

function saveState(sessionId, state) {
  const f = stateFile(sessionId);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(`${f}.${process.pid}`, JSON.stringify(state));
  renameSync(`${f}.${process.pid}`, f); // whole or nothing, when two hooks finish at the same time
}

function log(entry) {
  if (process.env.AGENT_KIT_HOOKS_LOG) appendFileSync(process.env.AGENT_KIT_HOOKS_LOG, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
}

// Node gives this module its real path, so a path to the hook through a symbolic link is compared as a real path too.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url) && process.env.AGENT_KIT_HOOKS !== "off") {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
    const state = loadState(input.session_id ?? "unknown");
    const output = handle(input, state);
    saveState(input.session_id ?? "unknown", state);
    log({ input: { ...input, tool_response: JSON.stringify(input.tool_response ?? null).slice(0, 2000) }, output });
    if (output) process.stdout.write(JSON.stringify(output));
  } catch (err) {
    try {
      log({ input, error: String(err?.stack ?? err) });
    } catch {
      /* the log is for tests only */
    }
  }
}
