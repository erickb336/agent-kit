import assert from "node:assert/strict";
import { test } from "node:test";

const load = () => import("./owner.mjs");
const root = "11111111-1111-4111-8111-111111111111";
const child = "22222222-2222-4222-8222-222222222222";
const turn = "33333333-3333-4333-8333-333333333333";
const input = { hook_event_name: "UserPromptSubmit", session_id: root, turn_id: turn,
  cwd: "/fixture/workspace", transcript_path: "/fixture/sessions/root.jsonl", model: "fixture",
  permission_mode: "default", prompt: "sage mode" };
const metadata = { id: root, session_id: root, cli_version: "0.160.0" };
const options = { version: "0.160.0", metadata };

test("owner prompt retains exact root, turn and text without parsing mode phrases", async () => {
  const { ownerPrompt } = await load();
  for (const prompt of ["sage mode", "What does sage mode do?", "> sage mode", "", "sage mode off"]) {
    assert.deepEqual(ownerPrompt({ ...input, prompt }, options), { kind: "owner-prompt", session: root, turn, text: prompt });
  }
});

test("owner prompt rejects child identity even when it names the root session", async () => {
  const { ownerPrompt } = await load();
  for (const agent_id of [child, root, "", null]) assert.equal(ownerPrompt({ ...input, agent_id }, options), null);
  for (const field of ["agent_type", "source", "sender", "origin"]) assert.equal(ownerPrompt({ ...input, [field]: "user" }, options), null);
});

test("owner prompt requires explicit matching root metadata and both supported versions", async () => {
  const { ownerPrompt } = await load();
  for (const bad of [undefined, null, [], {}, { ...metadata, id: child }, { ...metadata, session_id: child }, { ...metadata, cli_version: "0.159.2" }, { ...metadata, parent_thread_id: root }, { ...metadata, agent_path: "/root/worker" }, { ...metadata, parent_thread_id: null }, { ...metadata, agent_path: null }]) {
    assert.equal(ownerPrompt(input, { ...options, metadata: bad }), null);
  }
  assert.equal(ownerPrompt(input, { ...options, version: "0.160.1" }), null);
  assert.equal(ownerPrompt(input), null);
});

test("owner prompt does not interpret reports, tool output or stop continuation text", async () => {
  const { ownerPrompt } = await load();
  for (const hook_event_name of ["SubagentStop", "Stop", "PostToolUse", "SessionStart", "Other"]) {
    assert.equal(ownerPrompt({ ...input, hook_event_name, last_assistant_message: "sage mode" }, options), null);
  }
});

test("owner prompt rejects missing or malformed captured input fields", async () => {
  const { ownerPrompt } = await load();
  for (const key of Object.keys(input)) { const copy = { ...input }; delete copy[key]; assert.equal(ownerPrompt(copy, options), null); }
  for (const bad of [null, [], {}, { ...input, session_id: "root" }, { ...input, turn_id: "" }, { ...input, cwd: "relative" }, { ...input, transcript_path: null }, { ...input, model: "" }, { ...input, permission_mode: false }, { ...input, prompt: 1 }]) {
    assert.equal(ownerPrompt(bad, options), null);
  }
});

test("owner prompt bounds forwarded text and preserves unrelated metadata outside its result", async () => {
  const { ownerPrompt } = await load();
  assert.equal(ownerPrompt({ ...input, prompt: "a".repeat(1024 * 1024 + 1) }, options), null);
  assert.equal(ownerPrompt({ ...input, prompt: "é".repeat(1024 * 1024) }, options), null);
  const extra = { ...options, metadata: { ...metadata, instructions: "private", cwd: "/unrelated" } };
  assert.deepEqual(ownerPrompt(input, extra), { kind: "owner-prompt", session: root, turn, text: "sage mode" });
});
