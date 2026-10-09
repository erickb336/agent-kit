import test from "node:test";
import assert from "node:assert/strict";
import { buildBoardModel } from "../packages/sage-core/board-model.mjs";
const now = "2026-10-08T20:00:00.000Z";
const head = "a".repeat(40), old = "b".repeat(40);
const task = (id, state, extra = {}) => ({ id, title: "Sample", size: "small", risk: "", route: "build,code-review,qa", state, branch: "", pr: "", round: "0", keys: "", ...extra });
const source = (id, tasks, tables = {}, records = []) => ({ id, label: id, diagnostics: [], projects: [{ key: `${id}/sample-abcdef`, name: "sample-abcdef", diagnostics: [], tables: { tasks, ...tables }, observations: { version: 1, records } }] });
const observation = (kind, data, extra = {}) => ({ id: "O1", task: "T1", kind, source: "sample recorder", basis: "observed", observedAt: now, recordedAt: now, data, ...extra });

test("board columns use every required state and completion dates, not latest activity", () => {
  const states = ["framed", "designing", "awaiting-you", "briefed", "building", "repairing", "held", "replan", "reviewing", "verifying", "verified", "pr-ready", "merged", "concluded", "abandoned"];
  const tasks = states.map((state, i) => task(`T${i + 1}`, state));
  const records = [observation("completion", { state: "merged", at: "2026-10-01T20:00:00Z" }, { task: "T13" }), observation("completion", { state: "concluded", at: "2026-10-01T19:59:59Z" }, { task: "T14" })];
  const model = buildBoardModel([source("one", tasks, { decisions: [{ task: "T14", at: now, decision: "sample recent activity" }] }, records)], { now });
  assert.deepEqual(model.columns.map(c => c.tasks.length), [1, 2, 5, 2, 2, 1]);
  assert.equal(model.tasks.find(t => t.id === "T15").column, null);
  assert.equal(model.tasks.find(t => t.id === "T14").visible, false);
});

test("same task IDs in different sources stay separate and owner counts count tasks once", () => {
  const tables = { gates: [{ id: "G1", task: "T1", question: "First", answer: "", recommendation: "Choose A" }, { id: "G2", task: "T1", question: "Second", answer: "" }] };
  const model = buildBoardModel([source("one", [task("T1", "held")], tables), source("two", [task("T1", "framed")])], { now });
  assert.equal(model.counts.tasks, 2);
  assert.equal(model.counts.needsOwner, 1);
  assert.notEqual(model.tasks[0].key, model.tasks[1].key);
  assert.equal(model.needsOwner[0].reasons.length, 3);
});

test("review steps use the recorded current head and run role, with inferred work counted separately", () => {
  const tables = { runs: [{ id: "R1", task: "T1", role: "security-reviewer", status: "running" }], ledger: [{ task: "T1", pr: "12", sha: old, kind: "qa-pass", cycle: "1", at: now }, { task: "T1", pr: "12", sha: head, kind: "findings", cycle: "1", run: "R1", at: now }] };
  const records = [observation("pr", { number: 12, head, state: "open" }), observation("run", { run: "R1", provider: "sample-provider", head, cycle: 1 })];
  const model = buildBoardModel([source("one", [task("T1", "reviewing", { pr: "12", risk: "auth", route: "build,code-review,security-review,qa" })], tables, records)], { now });
  const steps = model.tasks[0].cycles[0].steps;
  assert.equal(steps.find(s => s.role === "qa").status, "pending");
  assert.equal(steps.find(s => s.role === "code-review").status, "pending");
  assert.equal(steps.find(s => s.role === "security-review").status, "failed");
  assert.equal(model.counts.recordedAgents, 1);
  assert.equal(model.counts.inferredWork, 0);
  const inferred = buildBoardModel([source("two", [task("T1", "framed", { pr: "12", branch: "codex/t1-sample" })], {}, records.filter(r => r.kind === "pr"))], { now });
  assert.equal(inferred.counts.inferredWork, 1);
  assert.equal(inferred.counts.recordedAgents, 0);
  assert.equal(inferred.tasks[0].pr, "12");
});


test("same-second later clean verdict clears the owner failure; later failure restores it", () => {
  const records = [observation("pr", { number: 12, head, state: "open" })];
  const failed = { task: "T1", pr: "12", sha: head, kind: "qa-fail", cycle: "1", at: now };
  const clean = { ...failed, kind: "qa-pass" };
  const make = ledger => buildBoardModel([source("one", [task("T1", "reviewing", { pr: "12" })], { ledger }, records)], { now }).tasks[0];
  assert.equal(make([failed, clean]).reasons.some(reason => reason.kind === "qa-fail"), false);
  assert.equal(make([clean, failed]).reasons.some(reason => reason.kind === "qa-fail"), true);
});


test("task detail derives brief fields and skipped loop stages from recorded route", () => {
  const input = source("one", [task("T1", "building")], {}, [observation("artifact", { type: "brief", label: "Brief" })]);
  input.projects[0].contents = { O1: { verified: true, text: "GOAL: Ship the board\nSCOPE: This task\nACCEPTANCE: All views agree\n- Keep sources separate\nVERIFY: Tests" } };
  const result = buildBoardModel([input], { now }).tasks[0];
  assert.equal(result.briefFields.goal, "Ship the board");
  assert.equal(result.briefFields.acceptance, "All views agree\n- Keep sources separate");
  assert.equal(result.loop.steps.find(step => step.label === "design").status, "skipped");
  assert.equal(result.loop.steps.find(step => step.label === "build").status, "current");
  assert.equal(result.loop.steps.find(step => step.label === "framed").status, "done");
});


test("Done accepts the recorded completion transition, never unrelated later decisions", () => {
  const input = source("one", [task("T1", "merged")], { decisions: [{ task: "T1", at: now, decision: "state merged", why: "task set" }] });
  assert.equal(buildBoardModel([input], { now }).columns.find(column => column.key === "done").tasks.length, 1);
  input.projects[0].tables.decisions = [{ task: "T1", at: now, decision: "changed title", why: "sample" }];
  assert.equal(buildBoardModel([input], { now }).columns.find(column => column.key === "done").tasks.length, 0);
});


test("review cycle requirements take the largest applicable size and risk count", () => {
  const input = source("one", [task("T1", "reviewing", { size: "large", risk: "auth" }), task("T2", "reviewing", { size: "investigate", route: "investigate,evidence-review" })]);
  input.config = { "cycles.small": 3, "cycles.large": 2, "cycles.risk": 2 };
  assert.equal(buildBoardModel([input], { now }).tasks[0].requiredCycles, 3);
  input.config = {};
  assert.equal(buildBoardModel([input], { now }).tasks[1].requiredCycles, 1);
});
