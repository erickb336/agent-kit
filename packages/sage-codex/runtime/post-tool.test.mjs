import assert from "node:assert/strict";
import { test } from "node:test";
const load = () => import("./post-tool.mjs");
const root = "11111111-1111-4111-8111-111111111111";
const child = "22222222-2222-4222-8222-222222222222";
const turn = "33333333-3333-4333-8333-333333333333";
const native = actor => ({ version: "0.160.0", actor });
const event = () => ({ hook_event_name: "PostToolUse", session_id: root, turn_id: turn,
  tool_name: "collaborationspawn_agent", tool_use_id: "spawn-1", tool_input: { task_name: "qa", message: "private task" },
  tool_response: JSON.stringify({ task_name: "/root/qa", other: "private result" }) });

test("native post-tool records only frozen dispatch identity for root and child actors", async () => {
  const { postToolOutput } = await load();
  for (const actor of [root, child]) {
    let captured;
    assert.deepEqual(await postToolOutput(event(), native(actor), async () => ({ recordDispatchResult(record) {
      captured = record; assert.equal(Object.isFrozen(record), true); return { decision: "recorded" };
    } })), {});
    assert.deepEqual(captured, { schema: 1, runtime: "0.160.0", session: root, kind: "spawn-result", actor, call: "spawn-1", turn, path: "/root/qa" });
    assert.doesNotMatch(JSON.stringify(captured), /private/);
  }
});

test("native post-tool rejects forged actors, unsupported context, and malformed results before loading policy", async () => {
  const { postToolOutput } = await load();
  let loaded = false;
  const loader = async () => { loaded = true; };
  for (const context of [null, {}, { ...native(root), version: "old" }, { ...native(root), extra: true }, native("invalid")]) {
    await assert.rejects(postToolOutput(event(), context, loader));
  }
  for (const change of [{ agent_id: child }, { turn_id: "invalid" }, { session_id: "invalid" },
    { tool_input: null }, { tool_response: "not-json" }, { tool_response: {} },
    { tool_response: JSON.stringify({ task_name: "/root/qa" }) + " ".repeat(16 * 1024) }]) {
    await assert.rejects(postToolOutput({ ...event(), ...change }, native(root), loader));
  }
  assert.equal(loaded, false);
});

test("native post-tool keeps message and followup results distinct and leaves other tools alone", async () => {
  const { postToolOutput } = await load();
  for (const [tool_name, mode] of [["collaborationsend_message", "message"], ["collaborationfollowup_task", "task"]]) {
    let captured;
    await postToolOutput({ ...event(), tool_name, tool_input: { target: "qa", message: "private" }, tool_response: "" }, native(root),
      async () => ({ recordDispatchResult(record) { captured = record; return { decision: "recorded" }; } }));
    assert.equal(captured.kind, "dispatch-result"); assert.equal(captured.mode, mode); assert.equal(captured.target, "qa");
  }
  let loaded = false;
  assert.deepEqual(await postToolOutput({ ...event(), tool_name: "apply_patch", tool_response: "done" }, native(root), async () => { loaded = true; }), {});
  assert.equal(loaded, false);
});

test("native post-tool requires explicit publication and propagates policy failures to the server boundary", async () => {
  const { postToolOutput } = await load();
  for (const receipt of [Object.assign(Object.create({ decision: "recorded" }), { unrelated: true }), null, {}, { decision: "pass" }, { decision: "recorded", extra: true }]) {
    await assert.rejects(postToolOutput(event(), native(root), async () => ({ recordDispatchResult: () => receipt })));
  }
  for (const loader of [async () => { throw Error("private loader"); }, async () => ({}),
    async () => ({ recordDispatchResult() { throw Error("private publication"); } })]) {
    await assert.rejects(postToolOutput(event(), native(root), loader));
  }
});
