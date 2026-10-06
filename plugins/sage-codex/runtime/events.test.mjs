import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, realpathSync, readFileSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { test } from "node:test";

const load = () => import("./events.mjs");
const root = "11111111-1111-4111-8111-111111111111";
const child = "22222222-2222-4222-8222-222222222222";
const other = "33333333-3333-4333-8333-333333333333";
const base = { schema: 1, runtime: "0.160.0", session: root };
const request = { ...base, kind: "spawn-request", actor: root, call: "call_1", turn: "turn_1", name: "worker" };
const result = { ...base, kind: "spawn-result", actor: root, call: "call_1", turn: "turn_1", path: "/root/worker" };
const start = { ...base, kind: "child-start", child, parent: root, path: "/root/worker", turn: "start_1" };
const stop = { ...base, kind: "child-stop", child, turn: "child_turn_1" };
function temporary(t) {
  const path = mkdtempSync(join(realpathSync(tmpdir()), "sage-event-store-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
const options = { version: "0.160.0" };
const hook = { session_id: root, turn_id: "turn_1", tool_name: "collaborationspawn_agent", tool_use_id: "call_1", tool_input: { task_name: "worker", message: "not retained" } };

test("native spawn records retain exact identity and discard prompt content", async () => {
  const { decodeEvent } = await load();
  assert.deepEqual(decodeEvent({ ...hook, hook_event_name: "PreToolUse" }, options), request);
  assert.deepEqual(decodeEvent({ ...hook, hook_event_name: "PostToolUse", tool_response: JSON.stringify({ task_name: "/root/worker" }) }, options), result);
  assert.equal(decodeEvent({ ...hook, hook_event_name: "PreToolUse", tool_name: "collaboration.spawn_agent" }, options), null);
  assert.equal(decodeEvent({ hook_event_name: "UserPromptSubmit", prompt: "not retained" }, options), null);
});

test("native child start requires explicit matching saved metadata", async () => {
  const { decodeEvent } = await load();
  const input = { session_id: root, agent_id: child, turn_id: "start_1", hook_event_name: "SubagentStart" };
  const metadata = { id: child, session_id: root, parent_thread_id: root, agent_path: "/root/worker", instructions: "not retained" };
  assert.deepEqual(decodeEvent(input, { ...options, metadata }), start);
  for (const key of ["id", "session_id", "parent_thread_id", "agent_path"]) {
    const absent = { ...metadata }; delete absent[key];
    assert.throws(() => decodeEvent(input, { ...options, metadata: absent }));
  }
  assert.throws(() => decodeEvent(input, { ...options, metadata: { ...metadata, id: other } }), /identity differs/);
});

test("unknown versions and malformed identity cannot enter the store", async () => {
  const { decodeEvent, observation } = await load();
  assert.throws(() => decodeEvent(hook, { version: "0.160.1" }), /unsupported runtime/);
  for (const invalid of [null, {}, { ...request, session: "" }, { ...request, turn: "" }, { ...request, name: "../worker" }, { ...request, prompt: "extra" }, { ...start, path: "/root/../worker" }]) {
    assert.throws(() => observation(invalid));
  }
  assert.throws(() => decodeEvent({ ...hook, hook_event_name: "PostToolUse", tool_response: "failure" }, options), /not JSON/);
});

test("every callback order joins the same child and keeps its capacity held", async () => {
  const { bindings } = await load();
  function* permutations(items) { if (!items.length) yield []; else for (let i = 0; i < items.length; i++) for (const rest of permutations(items.filter((_, j) => i !== j))) yield [items[i], ...rest]; }
  const expected = bindings([request, result, start, stop]);
  assert.equal(expected.unresolved, false);
  assert.equal(expected.reservations[0].state, "bound");
  assert.equal(expected.reservations[0].held, true);
  assert.deepEqual(expected.reservations[0].stopTurns, [stop.turn]);
  let count = 0;
  for (const order of permutations([request, result, start, stop])) {
    assert.deepEqual(bindings(order), expected);
    assert.deepEqual(bindings([...order, ...order]), expected);
    count++;
  }
  assert.equal(count, 24);
});

test("missing spawn results and orphan child stops remain unresolved", async () => {
  const { bindings } = await load();
  for (const events of [[request], [result], [request, result], [start], [stop], [request, start, stop]]) {
    const state = bindings(events);
    assert.equal(state.unresolved, true);
    assert.ok(state.reservations.every((r) => r.held && r.state === "pending"));
  }
});

test("a reused task path never chooses a child by time or arrival order", async () => {
  const { bindings } = await load();
  const events = [request, result, start, { ...request, call: "call_2" }, { ...result, call: "call_2" }, { ...start, child: other }];
  for (const order of [events, [...events].reverse()]) {
    const state = bindings(order);
    assert.equal(state.unresolved, true);
    assert.ok(state.reservations.every((r) => r.state === "conflict" && r.held));
    assert.deepEqual(state.unboundChildren, [child, other]);
  }
});

test("conflicting call, turn, parent and child identities do not become bindings", async () => {
  const { bindings } = await load();
  for (const events of [
    [request, { ...request, name: "different" }, result, start],
    [request, { ...result, turn: "another_turn" }, start],
    [request, result, { ...start, parent: other }],
    [request, result, start, { ...start, path: "/root/other" }],
    [request, result, { ...start, child: root }],
  ]) {
    const state = bindings(events);
    assert.equal(state.unresolved, true);
    assert.ok(state.reservations.every((r) => r.state !== "bound" && r.held));
  }
  assert.throws(() => bindings([request, { ...start, session: other }]), /mixed root/);
});

test("concurrent children join distinct calls without cross assignment", async () => {
  const { bindings } = await load();
  const events = Array.from({ length: 5 }, (_, i) => {
    const name = `worker_${i}`, id = `22222222-2222-4222-8222-${String(i).padStart(12, "0")}`;
    return [{ ...request, call: `call_${i}`, name }, { ...result, call: `call_${i}`, path: `/root/${name}` }, { ...start, child: id, path: `/root/${name}` }];
  }).flat();
  const expected = bindings(events);
  assert.equal(expected.unresolved, false);
  assert.equal(new Set(expected.reservations.map((r) => r.child)).size, 5);
  for (let i = 0; i < events.length; i++) assert.deepEqual(bindings([...events.slice(i), ...events.slice(0, i)].reverse()), expected);
});

test("published events survive a new reader without losing or duplicating identity", async (t) => {
  const { publish, readObservations, bindings } = await load();
  const dir = temporary(t);
  for (const event of [stop, result, request, start, request]) publish(dir, event);
  assert.equal(readdirSync(dir).length, 4);
  const reader = await import(`./events.mjs?reader=${encodeURIComponent(dir)}`);
  assert.deepEqual(reader.bindings(reader.readObservations(dir)), bindings([request, result, start, stop]));
  assert.equal(readObservations(dir).length, 4);
});

test("separate concurrent writers publish every fact exactly once", async (t) => {
  const { readObservations } = await load();
  const dir = join(temporary(t), "new", "records");
  const url = new URL("./events.mjs", import.meta.url).href;
  await Promise.all(Array.from({ length: 4 }, (_, i) => new Promise((resolve, reject) => {
    const worker = new Worker(`const {workerData}=require('node:worker_threads'); import(workerData.url).then(({publish})=>{for(const event of workerData.events)publish(workerData.dir,event);});`, { eval: true, workerData: { url, dir, events: Array.from({ length: 8 }, (_, j) => ({ ...request, call: `call_${i}_${j}` })).concat([request, start]) } });
    worker.once("error", reject);
    worker.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`writer exit ${code}`)));
  })));
  const records = readObservations(dir);
  assert.equal(records.length, 34);
  assert.equal(new Set(records.filter((e) => e.kind === "spawn-request").map((e) => e.call)).size, 33);
});

test("a partial unpublished write cannot replace a committed observation", async (t) => {
  const { publish, readObservations } = await load();
  const dir = temporary(t);
  publish(dir, request);
  writeFileSync(join(dir, ".pending-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), "incomplete");
  assert.deepEqual(readObservations(dir), [request]);
  publish(dir, request);
  assert.deepEqual(readObservations(dir), [request]);
});

test("corrupt published data fails closed and cannot be overwritten by a duplicate", async (t) => {
  const { publish, readObservations } = await load();
  const dir = temporary(t), name = publish(dir, request);
  writeFileSync(join(dir, name), "corrupt");
  assert.throws(() => readObservations(dir), /hash differs/);
  assert.throws(() => publish(dir, request), /published record differs/);
  assert.equal(readFileSync(join(dir, name), "utf8"), "corrupt");
});

test("published links, extra entries and oversized records fail closed", async (t) => {
  const { publish, readObservations } = await load();
  const dir = temporary(t);
  const actual = join(dir, "actual"); mkdirSync(actual);
  const target = join(dir, "target"); writeFileSync(target, "not a record");
  symlinkSync(target, join(actual, `${"a".repeat(64)}.json`));
  assert.throws(() => readObservations(actual), /unexpected published entry/);
  const extra = join(dir, "extra"); mkdirSync(extra);writeFileSync(join(extra, "unrecognized"), "{}");
  assert.throws(() => readObservations(extra), /unexpected published entry/);
  const large = join(dir, "large"); mkdirSync(large);writeFileSync(join(large, `${"a".repeat(64)}.json`), "x".repeat(16385));
  assert.throws(() => readObservations(large), /invalid record/);
  const link = join(dir, "link");symlinkSync(actual, link);
  assert.throws(() => publish(link, request), /real directory/);
});

test("schema names cannot select inherited object properties", async () => {
  const { observation, bindings } = await load();
  for (const kind of ["__proto__", "constructor", "toString", "hasOwnProperty", 1]) {
    assert.throws(() => observation({ ...base, kind }), /unknown observation kind/);
    assert.throws(() => bindings([{ ...base, kind }]), /unknown observation kind/);
  }
});

test("oversized observations are refused before any publication", async (t) => {
  const { publish } = await load();
  const dir = temporary(t);
  assert.throws(() => publish(dir, { ...request, name: "x".repeat(16385) }), /too large/);
  assert.deepEqual(readdirSync(dir), []);
});

test("parent paths must agree with root and nested actor identities", async () => {
  const { bindings, observation } = await load();
  assert.equal(bindings([]).unresolved, true);
  const wrong = bindings([request, { ...result, path: "/root/unrelated/worker" }, { ...start, path: "/root/unrelated/worker" }]);
  assert.equal(wrong.reservations[0].state, "conflict");
  const nestedRequest = { ...request, actor: child, call: "nested", name: "child" };
  const nestedResult = { ...result, actor: child, call: "nested", path: "/root/worker/child" };
  const nestedStart = { ...start, child: other, parent: child, path: "/root/worker/child" };
  const valid = bindings([request, result, start, nestedRequest, nestedResult, nestedStart]);
  assert.equal(valid.unresolved, false);
  assert.equal(valid.reservations.length, 2);
  assert.equal(bindings([nestedRequest, nestedResult, nestedStart]).unresolved, true);
  const circular = bindings([nestedRequest, nestedResult, nestedStart, { ...start, parent: other }]);
  assert.ok(circular.reservations.every((r) => r.state === "conflict"));
  assert.throws(() => observation({ ...request, name: "root" }));
  assert.throws(() => observation({ ...start, path: "/root/root" }));
  for (const name of ["1", "_", "1_child"]) assert.equal(observation({ ...request, name }).name, name);
});

test("duplicate publication refuses a FIFO without opening a blocking reader", { skip: process.platform === "win32" }, async (t) => {
  const { publish } = await load();
  const { execFileSync } = await import("node:child_process");
  const dir = temporary(t), name = publish(dir, request);
  rmSync(join(dir, name));
  execFileSync("mkfifo", [join(dir, name)]);
  assert.throws(() => publish(dir, request), /invalid record file/);
});

test("a symbolic link in any directory component is refused before publication", async (t) => {
  const { publish, readObservations } = await load();
  const dir = temporary(t), outside = join(dir, "outside"), alias = join(dir, "alias");
  mkdirSync(outside);symlinkSync(outside, alias);
  assert.throws(() => publish(join(alias, "nested"), request), /real directory/);
  assert.deepEqual(readdirSync(outside), []);
  assert.throws(() => readObservations(alias), /real directory/);
  const nested = join(dir, "real", "nested");
  publish(nested, request);
  assert.deepEqual(readObservations(nested), [request]);
});

test("unlimited abandoned writes cannot force an unbounded directory scan", async (t) => {
  const { readObservations } = await load();
  const dir = temporary(t);
  for (let i = 0; i < 8193; i++) writeFileSync(join(dir, `.pending-aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`), "");
  assert.throws(() => readObservations(dir), /too many directory entries/);
});

test("POSIX backslashes stay literal during directory validation", { skip: process.platform === "win32" }, async (t) => {
  const { publish, readObservations } = await load();
  const dir = temporary(t), literal = join(dir, "a\\b"), outside = join(dir, "outside");
  publish(literal, request);
  assert.deepEqual(readObservations(literal), [request]);
  assert.deepEqual(readdirSync(dir), ["a\\b"]);
  mkdirSync(outside);
  const link = join(dir, "link\\name");symlinkSync(outside, link);
  assert.throws(() => publish(join(link, "nested"), request), /real directory/);
  assert.deepEqual(readdirSync(outside), []);
});
