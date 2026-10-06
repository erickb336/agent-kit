import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const load = () => import("./events.mjs");
const root = "11111111-1111-4111-8111-111111111111";
const child = "22222222-2222-4222-8222-222222222222";
const base = { schema: 1, runtime: "0.160.0", session: root };
const options = { version: "0.160.0" };
const hook = { session_id: root, turn_id: "parent_1", tool_use_id: "dispatch_1", tool_input: { target: "/root/worker", message: "private payload must not persist" } };
const input = (event, mode = "message") => ({ ...hook, hook_event_name: event, tool_name: mode === "message" ? "collaborationsend_message" : "collaborationfollowup_task", ...(event === "PostToolUse" ? { tool_response: "" } : {}) });
const request = { ...base, kind: "dispatch-request", actor: root, call: "dispatch_1", turn: "parent_1", mode: "message", target: "/root/worker" };
const result = { ...request, kind: "dispatch-result" };
const childEvents = [
  { ...base, kind: "spawn-request", actor: root, call: "spawn_1", turn: "parent_1", name: "worker" },
  { ...base, kind: "spawn-result", actor: root, call: "spawn_1", turn: "parent_1", path: "/root/worker" },
  { ...base, kind: "child-start", child, parent: root, path: "/root/worker", turn: "child_1" },
  { ...base, kind: "child-stop", child, turn: "child_1" },
];

test("accepted native messages and later tasks persist identity without content", async (t) => {
  const { decodeEvent, publish, readObservations } = await load();
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "sage-dispatch-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const mode of ["message", "task"]) {
    for (const event of ["PreToolUse", "PostToolUse"]) {
      const expected = { ...(event === "PreToolUse" ? request : result), mode };
      const record = decodeEvent(input(event, mode), options);
      assert.deepEqual(record, expected);
      publish(dir, record);
    }
  }
  assert.equal(readObservations(dir).length, 4);
  for (const name of readdirSync(dir)) assert(!readFileSync(join(dir, name), "utf8").includes("private payload"));
});

test("dispatches retain the declared target and nested actor without guessing resolution", async () => {
  const { decodeEvent } = await load();
  for (const target of ["/root", "/root/lead/worker", "worker", "../peer", child]) {
    const record = decodeEvent({ ...input("PreToolUse", "task"), agent_id: child, tool_input: { target, message: "unused" } }, options);
    assert.equal(record.target, target);
    assert.equal(record.actor, child);
    assert.equal(record.mode, "task");
    assert.equal(Object.hasOwn(record, "child"), false);
  }
});

test("malformed dispatch identity and unrecognized results never become accepted evidence", async () => {
  const { decodeEvent, observation } = await load();
  for (const tool_response of [undefined, null, {}, "failure", "{}", " "]) {
    assert.throws(() => decodeEvent({ ...input("PostToolUse"), tool_response }, options), /dispatch result/);
  }
  for (const target of ["", "has space", "line\nbreak", "x".repeat(4097), null]) {
    assert.throws(() => decodeEvent({ ...input("PreToolUse"), tool_input: { target } }, options), /target/);
  }
  for (const bad of [{ ...request, mode: "unknown" }, { ...request, message: "extra" }, { ...result, turn: "" }, { ...request, actor: "missing" }]) assert.throws(() => observation(bad));
  assert.equal(decodeEvent({ ...input("PreToolUse"), tool_name: "collaboration.send_message" }, options), null);
});

test("request and acceptance order or duplicates never imply child-turn attribution", async () => {
  const { bindings } = await load();
  const expected = bindings([...childEvents, request, result]);
  assert.equal(expected.dispatches.length, 1);
  assert.equal(expected.dispatches[0].state, "accepted");
  assert.equal(expected.dispatches[0].attributed, false);
  assert.equal(expected.unresolved, true);
  assert(expected.reservations.every((row) => row.held));
  assert.deepEqual(bindings([result, request, ...childEvents]), expected);
  assert.deepEqual(bindings([...childEvents, result, request, result, request]), expected);
  const two = bindings([...childEvents, request, result, { ...request, call: "task_2", mode: "task" }, { ...result, call: "task_2", mode: "task" }, { ...childEvents.at(-1), turn: "child_2" }]);
  assert.equal(two.dispatches.length, 2);
  assert(two.dispatches.every((row) => row.state === "accepted" && !row.attributed));
  assert.equal(two.unresolved, true);
});

test("missing or conflicting dispatch evidence remains unresolved", async () => {
  const { bindings } = await load();
  for (const events of [[request], [result]]) {
    const state = bindings([...childEvents, ...events]);
    assert.equal(state.dispatches[0].state, "pending");
    assert.equal(state.unresolved, true);
  }
  for (const changed of [{ target: "/root/other" }, { mode: "task" }, { turn: "parent_2" }]) {
    const state = bindings([...childEvents, request, { ...result, ...changed }]);
    assert.equal(state.dispatches[0].state, "conflict");
    assert.equal(state.dispatches[0].attributed, false);
    assert.equal(state.unresolved, true);
  }
  assert.equal(bindings([...childEvents, request, { ...request, target: "other" }, result]).dispatches[0].state, "conflict");
  assert.equal(bindings([...childEvents, request, result, { ...result, mode: "task" }]).dispatches[0].state, "conflict");
});

test("sender identity separates equal call IDs and cannot claim another sender's result", async () => {
  const { bindings } = await load();
  const state = bindings([...childEvents, request, { ...result, actor: child }]);
  assert.equal(state.dispatches.length, 2);
  assert(state.dispatches.every((row) => row.state === "pending" && !row.attributed));
  assert.equal(state.unresolved, true);
});
