import "./test-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStateTool } from "../packages/sage-core/index.mjs";
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "sage-board-view-")), root = join(dir, "logbooks");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tool = createStateTool({ defaultRoot: () => root });
  const env = { ...process.env, SAGE_HOME: root };
  const run = (...args) => tool.sage([...args, "--project", dir], env);
  run("init"); run("task", "add", "--title", "Sample task", "--size", "small");
  return { dir, root, run };
}
function snapshot(path) {
  return Object.fromEntries(readdirSync(path, { withFileTypes: true }).flatMap(entry => {
    const file = join(path, entry.name);
    return entry.isDirectory() ? Object.entries(snapshot(file)).map(([name, body]) => [`${entry.name}/${name}`, body]) : [[entry.name, readFileSync(file).toString("hex")]];
  }));
}
test("rich chat board reads the recorded current project without writing the logbook", t => {
  const { root, run } = fixture(t), before = snapshot(root);
  let output; assert.doesNotThrow(() => { output = run("board", "this", "--view", "chat"); });
  assert.ok(output.includes("Sample task")); assert.ok(output.includes("Backlog"));
  assert.deepEqual(snapshot(root), before);
});
test("rich task lookup gives details and unknown tasks suggest nearest ids without opening one", t => {
  const { root, run } = fixture(t), before = snapshot(root);
  let output; assert.doesNotThrow(() => { output = run("board", "T1", "--view", "task"); });
  assert.ok(output.includes("**Brief**")); assert.ok(output.includes("**Evidence**"));
  assert.throws(() => run("board", "T9", "--view", "task"), /Nearest recorded ids: T1.*No task was opened/);
  assert.deepEqual(snapshot(root), before);
});
test("rich status and HTML use the same task and leave history unchanged", t => {
  const { root, run } = fixture(t), before = snapshot(root);
  let status, html; assert.doesNotThrow(() => { status = run("board", "this", "--view", "status"); html = run("board", "this", "--view", "html"); });
  assert.ok(status.includes("framed 1")); assert.ok(status.includes("Budget this week: unknown"));
  assert.ok(html.startsWith("<!doctype html>")); assert.ok(html.includes("Sample task"));
  assert.deepEqual(snapshot(root), before);
});


test("one checkout shows both sources; task lookup refuses duplicate IDs and accepts an exact source scope", t => {
  const { dir, root } = fixture(t), otherRoot = join(dir, "other-logbooks");
  const tool = createStateTool({ defaultRoot: () => root });
  const otherEnv = { ...process.env, SAGE_HOME: otherRoot };
  tool.sage(["init", "--project", dir], otherEnv);
  tool.sage(["task", "add", "--title", "Second provider task", "--size", "small", "--project", dir], otherEnv);
  const sources = [{ id: "first", path: root }, { id: "second", path: otherRoot }];
  const env = { ...process.env, SAGE_HOME: root, SAGE_BOARD_ROOTS: JSON.stringify(sources) };
  const before = [snapshot(root), snapshot(otherRoot)];
  let shown; assert.doesNotThrow(() => { shown = tool.sage(["board", "this", "--view", "chat", "--project", dir], env); });
  assert.ok(shown.includes("Sample task") && shown.includes("Second provider task"));
  assert.throws(() => tool.sage(["board", "T1", "--view", "task", "--project", dir], env), /task is ambiguous/);
  const key = `second/${readdirSync(otherRoot).find(name => /-[0-9a-f]{6}$/.test(name))}`;
  const selected = tool.sage(["board", key, "--view", "chat", "--project", dir], env);
  assert.ok(selected.includes("Second provider task") && !selected.includes("Sample task"));
  assert.deepEqual([snapshot(root), snapshot(otherRoot)], before);
});


test("task transitions record their actual time for board detail without a board write", t => {
  const { root, run } = fixture(t);
  run("task", "T1", "set", "state=abandoned");
  const before = snapshot(root);
  const decisions = Object.entries(before).find(([name]) => name.endsWith("/decisions.tsv"))[1];
  assert.ok(Buffer.from(decisions, "hex").toString("utf8").includes("state abandoned"));
  const shown = run("board", "T1", "--view", "task");
  assert.ok(shown.includes("state abandoned"));
  assert.deepEqual(snapshot(root), before);
});
