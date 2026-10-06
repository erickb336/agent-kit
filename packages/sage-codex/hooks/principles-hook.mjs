#!/usr/bin/env node
// Codex 0.159.2 native hook boundary. Unknown events and tools have no effect.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyPrinciples } from "sage-core";

const SKILLS = join(dirname(fileURLToPath(import.meta.url)), "../skills");
const skillText = (name) => readFileSync(join(SKILLS, name, "SKILL.md"), "utf8").replace(/^---\n[\s\S]*?\n---\n/, "").replace(/<!--[\s\S]*?-->/, "").trim();

/** All patch headers, including both ends of a move. This selects advice, not write authorization. */
export function patchPaths(patch) {
  if (typeof patch !== "string") return [];
  const lines = patch.replaceAll("\r\n", "\n").trim().split("\n");
  if (lines[0] !== "*** Begin Patch" || lines.at(-1) !== "*** End Patch") return [];
  return lines.flatMap((line) => /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/.exec(line)?.slice(1) ?? []);
}

export function handle(input, state) {
  if (!input || typeof input !== "object") return;
  const event = input.hook_event_name;
  let normalized;
  if (event === "UserPromptSubmit" && typeof input.prompt === "string") {
    normalized = { kind: "prompt", prompt: input.prompt };
  } else if (event === "PreToolUse") {
    if (input.tool_name === "apply_patch") normalized = { kind: "before-tool", paths: patchPaths(input.tool_input?.command) };
    else if (input.tool_name === "Bash" && typeof input.tool_input?.command === "string") normalized = { kind: "before-tool", command: input.tool_input.command };
  }
  if (!normalized) return;
  // Stop continuations and failure outcomes have not been verified; this adapter never blocks.
  const effect = applyPrinciples(normalized, state, skillText);
  return effect?.context ? { hookSpecificOutput: { hookEventName: event, additionalContext: effect.context } } : undefined;
}

// Hash the full identity: a child shares its parent's session_id but gets separate advice.
export function stateKey(input) {
  if (typeof input.session_id !== "string" || !input.session_id) return undefined;
  return createHash("sha256").update(JSON.stringify([input.session_id, input.agent_id ?? null])).digest("hex");
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url) && process.env.AGENT_KIT_HOOKS !== "off") {
  try {
    const input = JSON.parse(readFileSync(0, "utf8"));
    const key = stateKey(input);
    if (key) {
      const dir = join(process.env.AGENT_KIT_HOOKS_STATE ?? join(tmpdir(), "agent-kit-hooks"), "codex");
      const file = join(dir, `${key}.json`);
      let state = { given: [], failures: {} };
      try {
        const saved = JSON.parse(readFileSync(file, "utf8"));
        if (Array.isArray(saved.given) && saved.given.every((s) => typeof s === "string")) state = { ...state, given: saved.given };
      } catch { /* New session or damaged advice state. */ }
      const output = handle(input, state);
      mkdirSync(dir, { recursive: true });
      writeFileSync(`${file}.${process.pid}`, JSON.stringify(state));
      renameSync(`${file}.${process.pid}`, file);
      if (output) process.stdout.write(JSON.stringify(output));
    }
  } catch { /* Advice must not break a coding session. */ }
}
