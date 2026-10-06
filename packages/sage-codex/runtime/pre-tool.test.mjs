import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const load = () => import("./pre-tool.mjs");
const input = { hook_event_name: "PreToolUse", session_id: "root", turn_id: "turn", tool_use_id: "call", tool_name: "collaborationspawn_agent", tool_input: { task_name: "worker" } };
const raw = JSON.stringify(input);
const denial = (reason = "Sage could not verify this tool call.") => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });

test("pre-tool pass preserves native permission checks without an allow decision", async () => {
  const { preToolDecision } = await load();
  let calls = 0;
  const result = await preToolDecision(raw, async () => ({ evaluate: async (event) => {
    calls++; assert.deepEqual(event, input); return { decision: "pass" };
  } }));
  assert.deepEqual(result, {});
  assert.equal(calls, 1);
});

test("pre-tool explicit denial retains only its supported native fields", async () => {
  const { preToolDecision } = await load();
  assert.deepEqual(await preToolDecision(raw, async () => ({ evaluate: () => ({ decision: "deny", reason: "The task has no approved brief." }) })), denial("The task has no approved brief."));
});

test("pre-tool missing dependencies produce a denial without private error text", async (t) => {
  const { preToolDecision } = await load();
  const dir = mkdtempSync(join(tmpdir(), "sage-missing-policy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const absent = pathToFileURL(join(dir, "absent-policy.mjs"));
  let attempted = false;
  const result = await preToolDecision(raw, async () => {
    attempted = true;
    return import(absent.href);
  });
  assert.equal(attempted, true);
  assert.deepEqual(result, denial());
  assert.equal(JSON.stringify(result).includes("absent-policy"), false);
});

test("pre-tool synchronous and asynchronous policy failures both deny", async () => {
  const { preToolDecision } = await load();
  for (const evaluate of [() => { throw Error("private detail"); }, async () => { throw Error("private detail"); }]) {
    assert.deepEqual(await preToolDecision(raw, async () => ({ evaluate })), denial());
  }
  for (const module of [null, {}, { evaluate: true }]) {
    assert.deepEqual(await preToolDecision(raw, async () => module), denial());
  }
});

test("pre-tool malformed or oversized input denies before loading policy", async () => {
  const { preToolDecision } = await load();
  const missing = Object.keys(input).map(key => { const copy = { ...input }; delete copy[key]; return JSON.stringify(copy); });
  for (const bad of [...missing, JSON.stringify({ ...input, tool_input: [] }), JSON.stringify({ ...input, tool_name: "\n" }), null, input, "{", "[]", "null", "{}", JSON.stringify({ ...input, hook_event_name: "PostToolUse" }), " ".repeat(1024 * 1024 + 1)]) {
    let calls = 0;
    const result = await preToolDecision(bad, async () => { calls++; return { evaluate: () => ({ decision: "pass" }) }; });
    assert.deepEqual(result, denial());
    assert.equal(calls, 0);
  }
});

test("pre-tool ambiguous policy results cannot permit a call", async () => {
  const { preToolDecision } = await load();
  for (const result of [undefined, null, true, [], {}, { decision: "allow" }, { decision: "pass", reason: "extra" }, { decision: "pass", updatedInput: {} }, { decision: "deny" }, { decision: "deny", reason: "" }, { decision: "deny", reason: "\n" }, { decision: "deny", reason: "a\u0000b" }, { decision: "deny", reason: "x".repeat(501) }, { decision: "deny", reason: "safe", continue: true }]) {
    assert.deepEqual(await preToolDecision(raw, async () => ({ evaluate: () => result })), denial());
  }
});
