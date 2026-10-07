import assert from "node:assert/strict";
import { test } from "node:test";
const load = () => import("./mcp-policy.mjs");
const root = "11111111-1111-4111-8111-111111111111";
const child = "33333333-3333-4333-8333-333333333333";
const event = () => ({ hook_event_name: "PreToolUse", session_id: root, turn_id: "22222222-2222-4222-8222-222222222222", tool_name: "control", tool_use_id: "call", tool_input: {} });
const context = () => ({ version: "0.160.0", actor: root });
const unpack = result => {
  assert.deepEqual(Object.keys(result), ["content"]);
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  return JSON.parse(result.content[0].text);
};
const denial = result => assert.equal(unpack(result).hookSpecificOutput.permissionDecision, "deny");

test("native MCP root policy keeps ordinary approvals and carries current context", async () => {
  const { mcpPreToolResult } = await load();
  const result = await mcpPreToolResult(JSON.stringify(event()), context(), async () => ({ evaluate(input, native) {
    assert.deepEqual(input, event()); assert.deepEqual(native, context());
    assert.equal(Object.hasOwn(input, "agent_id"), false);
    return { decision: "pass" };
  } }));
  assert.deepEqual(unpack(result), {});
});

test("native MCP child policy derives actor while retaining its root session", async () => {
  const { mcpPreToolResult } = await load();
  const result = await mcpPreToolResult(JSON.stringify(event()), { ...context(), actor: child }, async () => ({ evaluate(input, native) {
    assert.equal(input.session_id, root); assert.equal(input.agent_id, child); assert.equal(native.actor, child);
    return { decision: "deny", reason: "This child cannot edit that file." };
  } }));
  denial(result);
  assert.equal(unpack(result).hookSpecificOutput.permissionDecisionReason, "This child cannot edit that file.");
});

test("native MCP refuses supplied actor fields and malformed identity before policy loading", async () => {
  const { mcpPreToolResult } = await load();
  for (const change of [{ agent_id: child }, { actor: child }, { version: "0.160.0" }, { session_id: "invalid" }, { turn_id: "invalid" }, { tool_name: "" }]) {
    let loaded = false;
    denial(await mcpPreToolResult(JSON.stringify({ ...event(), ...change }), context(), async () => { loaded = true; }));
    assert.equal(loaded, false);
  }
});

test("native MCP refuses missing or unsupported connection context without a saved fallback", async () => {
  const { mcpPreToolResult } = await load();
  for (const native of [null, {}, [], { actor: root }, { version: "0.160.0" }, { ...context(), version: "0.159.0" }, { ...context(), actor: "invalid" }, { ...context(), receipt: "saved" }]) {
    let loaded = false;
    denial(await mcpPreToolResult(JSON.stringify(event()), native, async () => { loaded = true; }));
    assert.equal(loaded, false);
  }
});

test("native MCP loader and policy errors become successful protocol results containing denial", async () => {
  const { mcpPreToolResult } = await load();
  for (const loader of [async () => { throw Error("private loader detail"); }, async () => ({ evaluate() { throw Error("private policy detail"); } }), async () => ({ evaluate: () => ({ decision: "allow" }) })]) {
    const result = await mcpPreToolResult(JSON.stringify(event()), context(), loader);
    denial(result); assert.equal(JSON.stringify(result).includes("private"), false);
  }
});
