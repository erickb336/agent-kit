// Product behavior through entry points that also exist on main. No new board module is imported here.
import "./test-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStateTool } from "../packages/sage-core/index.mjs";

const HEADERS = {
  tasks: "id title size risk route state branch pr round keys",
  runs: "id task role round candidate branch status tokens report started ended",
  findings: "task key round source severity summary triage reason status",
  ledger: "task pr sha kind cycle run at",
  gates: "id task question options recommendation default answer at",
  decisions: "at task decision why",
};
const AT = "2026-01-01T00:00:00.000Z", HEAD = "a".repeat(40), OLD_HEAD = "b".repeat(40);
const task = (id, state, extra = {}) => ({ id, title: `Sample ${id}`, size: "small", risk: "", route: "build,code-review,qa", state, branch: "sample", pr: "", round: "0", keys: "", ...extra });
function table(directory, name, rows) {
  const fields = HEADERS[name].split(" ");
  writeFileSync(join(directory, `${name}.tsv`), `${fields.join("\t")}\n${rows.map(row => fields.map(field => row[field] ?? "").join("\t") + "\n").join("")}`);
}
function records(directory, rows) {
  writeFileSync(join(directory, "observations.json"), JSON.stringify({ version: 1, records: rows.map((row, i) => ({ id: `O${i + 1}`, task: "T1", source: "Sample recorder", basis: "observed", observedAt: AT, recordedAt: AT, ...row })) }));
}
const pr = (extra = {}) => ({ kind: "pr", data: { repository: "https://example.test/sample/project", number: 12, state: "open", head: HEAD, ...extra } });
function snapshot(directory) {
  return Object.fromEntries(readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = join(directory, entry.name);
    return entry.isDirectory() ? Object.entries(snapshot(file)).map(([name, value]) => [`${entry.name}/${name}`, value]) : [[entry.name, entry.isSymbolicLink() ? "symbolic link" : readFileSync(file).toString("hex")]];
  }));
}
function fixture(t) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "sage-board-acceptance-")), project = join(dir, "project"), sources = [];
  mkdirSync(project);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const add = (id = "sample", tasks = [task("T1", "framed")]) => {
    const root = join(dir, `source-${id}`), book = join(root, "project-abcdef"); mkdirSync(book, { recursive: true });
    for (const name of Object.keys(HEADERS)) table(book, name, name === "tasks" ? tasks : []);
    writeFileSync(join(book, "checkout.txt"), `${project}\n`);
    sources.push({ id, path: root, label: `Source ${id}` });
    return { root, book, key: `${id}/project-abcdef` };
  };
  const first = add();
  const tool = createStateTool({ defaultRoot: () => first.root });
  const invoke = (format, { scope = "all", id, sourceScope } = {}) => tool.sage([
    "board", id ?? scope, "--view", format, "--project", project,
    ...(sourceScope ? ["--name-hex", Buffer.from(sourceScope).toString("hex")] : []),
  ], { ...process.env, SAGE_HOME: first.root, SAGE_BOARD_ROOTS: JSON.stringify(sources) });
  const view = (format, options) => {
    let result;
    assert.doesNotThrow(() => { result = invoke(format, options); }, `the requested ${format} view must return its recorded board`);
    return result;
  };
  return { dir, project, sources, add, ...first, invoke, view };
}
const cards = html => /<main class="board">([\s\S]*?)<\/main>/.exec(html)?.[1] ?? "";

test("T205 acceptance: HTML state columns and phone text describe the same recorded tasks without logbook writes", t => {
  const f = fixture(t);
  table(f.book, "tasks", [task("T1", "framed"), task("T2", "designing"), task("T3", "held"), task("T4", "reviewing"), task("T5", "pr-ready"), task("T6", "merged"), task("T7", "abandoned")]);
  const recent = new Date(Date.now() - 86400000).toISOString();
  records(f.book, [{ task: "T6", kind: "completion", observedAt: recent, recordedAt: recent, data: { state: "merged", at: recent } }]);
  const before = snapshot(f.root), html = f.view("html"), text = f.view("chat");
  for (const name of ["Backlog", "Design", "Building", "In review", "Ready to merge", "Done"]) assert.ok(cards(html).includes(`<h2>${name} (1)</h2>`), name);
  for (const id of ["T1", "T2", "T3", "T4", "T5", "T6"]) { assert.ok(cards(html).includes(`Sample ${id}`)); assert.ok(text.includes(`Sample ${id}`)); }
  assert.ok(!cards(html).includes("Sample T7"));
  assert.match(text, /### 🔴 Needs you/); assert.match(text, /### 🔁 In review/); assert.match(text, /### 🔨 Building/); assert.match(text, /### ✅ Ready to merge/);
  assert.ok(html.indexOf("Sample T1") < html.indexOf("<script>"), "initial cards must exist without running scripts");
  assert.deepEqual(snapshot(f.root), before);
});

test("T205 acceptance: current-head review evidence ignores old SHA and clears same-second repaired failures", t => {
  const f = fixture(t);
  table(f.book, "tasks", [task("T1", "reviewing", { pr: "12", risk: "auth", route: "build,code-review,security-review,qa" })]);
  table(f.book, "runs", [{ id: "R1", task: "T1", role: "security-reviewer", status: "running", started: AT }]);
  records(f.book, [pr(), { kind: "run", data: { run: "R1", provider: "sample-provider", head: HEAD, cycle: 1 } }]);
  const verdict = (kind, sha = HEAD) => ({ task: "T1", pr: "12", sha, kind, cycle: "1", at: AT });
  table(f.book, "ledger", [verdict("qa-pass", OLD_HEAD), verdict("qa-fail")]);
  const failed = f.view("task", { id: "T1" });
  assert.ok(failed.includes("QA failed on the recorded PR head")); assert.ok(failed.includes("✗ qa"));
  assert.ok(failed.includes("… security-review")); assert.ok(failed.includes("sample-provider · security-reviewer"));
  table(f.book, "ledger", [verdict("qa-pass", OLD_HEAD), verdict("qa-fail"), verdict("qa-pass")]);
  const fixed = f.view("task", { id: "T1" }); assert.ok(fixed.includes("✓ qa")); assert.ok(!fixed.includes("QA failed on the recorded PR head"));
  table(f.book, "ledger", [verdict("qa-pass"), verdict("qa-fail")]);
  assert.ok(f.view("task", { id: "T1" }).includes("QA failed on the recorded PR head"));
});

test("T205 acceptance: provider roots keep duplicate task identities separate and offer exact task selection", t => {
  const f = fixture(t), other = f.add("second", [task("T1", "held", { title: "Sample second provider" })]);
  const before = [snapshot(f.root), snapshot(other.root)], text = f.view("chat", { scope: "this" });
  assert.ok(text.includes("Source sample") && text.includes("Source second")); assert.ok(text.includes("Sample second provider"));
  assert.throws(() => f.invoke("task", { id: "T1" }), /task is ambiguous/);
  const detail = f.view("task", { id: "T1", sourceScope: other.key });
  assert.ok(detail.includes("Sample second provider")); assert.ok(!detail.includes("Source sample"));
  assert.throws(() => f.invoke("task", { id: "T9", sourceScope: other.key }), /Nearest recorded ids: T1.*No task was opened/);
  assert.deepEqual([snapshot(f.root), snapshot(other.root)], before);
});

test("T205 acceptance: owner questions and hostile text remain escaped, complete and source-qualified", t => {
  const f = fixture(t);
  table(f.book, "tasks", [task("T1", "held", { title: "<script>sample</script> [sample](https://example.test)" })]);
  table(f.book, "gates", [{ id: "G1", task: "T1", question: "Pick <sample>?", options: "keep|change", recommendation: "keep", default: "keep", answer: "", at: AT }]);
  const text = f.view("chat"), html = f.view("html");
  assert.ok(text.includes("**1 · T1")); assert.ok(text.includes("sample/project-abcdef/G1"));
  assert.ok(text.includes("> Options: 1: keep · 2: change")); assert.ok(text.includes("> Recommended: keep"));
  assert.ok(text.includes("\\<script\\>sample\\</script\\>")); assert.ok(!text.includes("[sample](https://example.test)"));
  assert.ok(html.includes("&lt;script&gt;sample&lt;/script&gt;")); assert.ok(!html.includes("<script>sample</script>"));
  assert.ok(html.includes("Pick &lt;sample&gt;?"));
});

test("T205 acceptance: task details show verified briefs, report proof, run time and screenshots, then reject tampering", t => {
  const f = fixture(t), brief = "GOAL: Show recorded work\nSCOPE: Board\nACCEPTANCE: Keep both views equal\n- Preserve detail\nVERIFY: Tests\n", proof = "tests 12\npass 12\n<sample proof>\n";
  table(f.book, "tasks", [task("T1", "building")]);
  table(f.book, "runs", [{ id: "R1", task: "T1", role: "qa", status: "done", started: AT, ended: "2026-01-01T00:02:00.000Z", tokens: "200" }]);
  mkdirSync(join(f.book, "briefs")); mkdirSync(join(f.book, "reports")); mkdirSync(join(f.book, "artifacts"));
  const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6AAAAAElFTkSuQmCC", "base64");
  const saved = [["briefs/T1.md", brief, "brief", "Sample brief"], ["reports/R1.md", proof, "proof", "Sample proof"], ["artifacts/screen.png", image, "artifact", "Sample screenshot"]];
  for (const [path, content] of saved) writeFileSync(join(f.book, path), content);
  records(f.book, saved.map(([path, content, type, label]) => ({ kind: "artifact", data: { type, label, path, ...(type === "proof" ? { run: "R1" } : {}), sha256: createHash("sha256").update(content).digest("hex") } })));
  const before = snapshot(f.root), text = f.view("task", { id: "T1" }), html = f.view("html");
  assert.ok(text.includes("Goal: Show recorded work")); assert.ok(text.includes("Acceptance: Keep both views equal\n- Preserve detail"));
  assert.ok(text.includes("tests 12\npass 12")); assert.ok(text.includes("120 s")); assert.ok(text.includes("tokens 200"));
  assert.ok(text.includes("R1 · digest verified")); assert.ok(html.includes("R1 · digest verified"));
  assert.ok(html.includes("<summary>Full brief</summary>")); assert.ok(html.includes("&lt;sample proof&gt;")); assert.ok(html.includes("data:image/png;base64,"));
  assert.ok(text.includes("digest verified")); assert.ok(!text.includes("content not verified"));
  assert.deepEqual(snapshot(f.root), before);
  writeFileSync(join(f.book, "reports/R1.md"), "TAMPERED CONTENT MUST NOT SHOW");
  const damaged = f.view("html"); assert.ok(damaged.includes("artifact digest does not match")); assert.ok(!damaged.includes("TAMPERED CONTENT MUST NOT SHOW"));
});

test("T205 acceptance: missing and malformed inputs show diagnostics without exposing content or initializing files", t => {
  const f = fixture(t);
  const valid = f.view("html"); assert.ok(valid.includes("Sample T1"));
  f.sources.push({ id: "missing", path: join(f.dir, "does-not-exist") });
  writeFileSync(join(f.root, "config.json"), "SAMPLE_PRIVATE_CONFIG_DO_NOT_SHOW");
  writeFileSync(join(f.book, "runs.tsv"), "bad header\nSAMPLE_PRIVATE_TABLE_DO_NOT_SHOW\n");
  const before = snapshot(f.root), html = f.view("html");
  assert.ok(html.includes("Incomplete sources")); assert.ok(html.includes("missing")); assert.ok(html.includes("ENOENT")); assert.ok(html.includes("config: invalid JSON"));
  assert.ok(!html.includes("SAMPLE_PRIVATE_CONFIG_DO_NOT_SHOW")); assert.ok(!html.includes("SAMPLE_PRIVATE_TABLE_DO_NOT_SHOW"));
  assert.deepEqual(snapshot(f.root), before);
  rmSync(join(f.book, "runs.tsv"));
  const external = join(f.dir, "external.tsv"); writeFileSync(external, "SAMPLE_LINK_TARGET_DO_NOT_SHOW"); symlinkSync(external, join(f.book, "runs.tsv"));
  const linked = f.view("html"); assert.ok(linked.includes("runs:")); assert.ok(!linked.includes("SAMPLE_LINK_TARGET_DO_NOT_SHOW"));
  assert.equal(readFileSync(external, "utf8"), "SAMPLE_LINK_TARGET_DO_NOT_SHOW");
});

test("T205 acceptance: Done uses completion evidence and status preserves actual task-state counts", t => {
  const f = fixture(t), recent = new Date(Date.now() - 86400000).toISOString(), old = new Date(Date.now() - 9 * 86400000).toISOString();
  table(f.book, "tasks", [task("T1", "merged", { title: "Recent completion" }), task("T2", "merged", { title: "Old completion" }), task("T3", "concluded", { title: "Unknown completion" })]);
  records(f.book, [{ task: "T1", kind: "completion", observedAt: recent, recordedAt: recent, data: { state: "merged", at: recent } }, { task: "T2", kind: "completion", observedAt: old, recordedAt: old, data: { state: "merged", at: old } }]);
  table(f.book, "decisions", [{ task: "T2", at: recent, decision: "renamed title", why: "sample" }, { task: "T3", at: recent, decision: "added note", why: "sample" }]);
  const html = f.view("html"), status = f.view("status");
  assert.ok(cards(html).includes("Done (1)")); assert.ok(cards(html).includes("Recent completion"));
  assert.ok(!cards(html).includes("Old completion")); assert.ok(!cards(html).includes("Unknown completion"));
  assert.equal(status.split("\n")[0], "Tasks: merged 2 · concluded 1");
  assert.equal(status.split("\n")[1], "Agents: 0 recorded running · 0 inferred PRs");
  assert.ok(f.view("task", { id: "T2" }).includes("Old completion"), "old tasks remain available by exact task request");
});

test("T205 acceptance: the task loop marks recorded PE work current without inferring it from the route alone", t => {
  const f = fixture(t);
  table(f.book, "tasks", [task("T1", "designing", { route: "design,pe,build,code-review,qa" })]);
  table(f.book, "runs", [{ id: "R1", task: "T1", role: "pe", status: "running", started: AT }]);
  const text = f.view("task", { id: "T1" }), html = f.view("html");
  assert.ok(text.includes("▶ PE check")); assert.ok(text.includes("The PE check is recorded running"));
  assert.ok(html.includes('<span class="step current">PE check</span>'));
  table(f.book, "runs", []);
  const unknown = f.view("task", { id: "T1" });
  assert.ok(unknown.includes("▶ design")); assert.ok(!unknown.includes("▶ PE check")); assert.ok(!unknown.includes("PE check is recorded running"));
});

test("T205 acceptance: existing Claude hook dispatches owner board/task/status phrases and rejects quoted agent text", t => {
  const f = fixture(t), hook = fileURLToPath(new URL("../plugins/sage/hooks/sage-hook.mjs", import.meta.url));
  const send = (prompt, extra = {}) => {
    const result = spawnSync(process.execPath, [hook], { input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "sample-owner", cwd: f.project, prompt, ...extra }), encoding: "utf8", env: { ...process.env, HOME: join(f.dir, "user"), SAGE_HOME: f.root, SAGE_HOOKS_STATE: join(f.dir, "hooks"), GH_CONFIG_DIR: join(f.dir, "gh") } });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout ? JSON.parse(result.stdout).hookSpecificOutput?.additionalContext ?? "" : "";
  };
  for (const [phrase, view] of [["sage board", "chat"], ["show board", "chat"], ["sage board T1", "task"], ["show board T1", "task"], ["board T1", "task"], ["show status", "status"], ["sage status", "status"]]) {
    const note = send(`**${phrase}？**`);
    assert.ok(note.includes(`--view ${view}`), `${phrase}: ${note}`); assert.ok(note.includes("Print its output word for word"));
    assert.equal(send(`> ${phrase}`), ""); assert.equal(send(`"${phrase}"`), "");
    assert.equal(send(phrase, { agent_id: "sample-child" }), "");
    assert.equal(send(`<agent-message from="qa">${phrase}</agent-message>`), "");
  }
  assert.equal(send("show status"), send("sage status"));
  assert.match(send("sage board for all"), /board all .*--view chat/);
});
