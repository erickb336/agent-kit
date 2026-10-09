// The observation writer runs as a CLI against temporary stores. No provider or process lookup supplies test facts.
import "./test-env.mjs";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const CORE = new URL("../packages/sage-core/index.mjs", import.meta.url).href;
const SPY = fileURLToPath(new URL("./kill-spy.mjs", import.meta.url));
const AT = "2026-01-01T00:00:00Z", SHA = "a".repeat(40);
const pr = { repository: "https://github.com/sample/project", number: 12, state: "open", head: SHA };
const hex = data => Buffer.from(JSON.stringify(data)).toString("hex");

function fixture() {
  const temp = mkdtempSync(join(tmpdir(), "sage-observations-"));
  const home = join(temp, "home"), project = join(temp, "project"), runner = join(temp, "cli.mjs"), kills = join(temp, "kills");
  mkdirSync(project);
  writeFileSync(runner, `import { createStateTool } from ${JSON.stringify(CORE)}; createStateTool({ defaultRoot() { throw Error("missing test home"); } }).runCli();`);
  const env = { ...process.env, SAGE_HOME: home, SAGE_TEST_PIDS: "{}", SAGE_TEST_KILLS: kills, NODE_OPTIONS: `--import=${JSON.stringify(SPY)}` };
  const run = (...args) => spawnSync(process.execPath, [runner, ...args, "--project", project], { env, encoding: "utf8", timeout: 60_000 });
  const ok = (...args) => { const out = run(...args); assert.equal(out.status, 0, out.stderr); return out.stdout.trim(); };
  const dir = ok("init").slice("logbook ".length);
  ok("task", "add", "--title", "Sample task", "--size", "small");
  const args = (kind, data, task = "T1", at = AT) => ["observe", task, "--kind", kind, "--source", "sample-api", "--basis", "observed", "--observed-at", at, "--data-hex", hex(data)];
  const observe = (kind, data, task, at) => ok(...args(kind, data, task, at));
  const file = join(dir, "observations.json");
  const records = () => JSON.parse(readFileSync(file, "utf8")).records;
  const tables = () => Object.fromEntries(readdirSync(dir).filter(name => name.endsWith(".tsv")).map(name => [name, readFileSync(join(dir, name), "utf8")]));
  const concurrent = (...argv) => new Promise(resolve => execFile(process.execPath, [runner, ...argv, "--project", project], { env, encoding: "utf8", timeout: 60_000 }, (error, stdout, stderr) => resolve({ status: error?.code ?? 0, stdout, stderr })));
  return { temp, home, project, dir, file, kills, run, ok, args, observe, records, tables, concurrent };
}

test("board observations: PR facts retain provenance without changing tables or merge decisions", () => {
  const f = fixture(), tables = f.tables(), merge = f.run("merge-check", "--sha", SHA);
  assert.equal(f.observe("pr", pr), "O1 observed pr for T1");
  assert.equal(f.observe("pr", { ...pr, head: "b".repeat(40) }, "T1", "2026-01-02T00:00:00.000Z"), "O2 observed pr for T1");
  const value = JSON.parse(readFileSync(f.file, "utf8"));
  assert.equal(value.version, 1);
  assert.deepEqual(value.records.map(({ recordedAt, ...row }) => row), [
    { id: "O1", task: "T1", kind: "pr", source: "sample-api", basis: "observed", observedAt: "2026-01-01T00:00:00.000Z", data: pr },
    { id: "O2", task: "T1", kind: "pr", source: "sample-api", basis: "observed", observedAt: "2026-01-02T00:00:00.000Z", data: { ...pr, head: "b".repeat(40) } },
  ]);
  for (const row of value.records) assert.equal(new Date(row.recordedAt).toISOString(), row.recordedAt);
  assert.deepEqual(f.tables(), tables);
  assert.deepEqual([f.run("merge-check", "--sha", SHA).status, f.run("merge-check", "--sha", SHA).stderr], [merge.status, merge.stderr]);
  assert.equal(existsSync(f.kills), false);
});

test("board observations: run provider metadata belongs to its recorded task and keeps old run columns", () => {
  const f = fixture();
  f.ok("run", "add", "T1", "--role", "qa");
  f.ok("task", "add", "--title", "Another task", "--size", "small");
  const tables = f.tables(), data = { run: "R1", provider: "sample-provider", head: SHA, cycle: 2 };
  assert.equal(f.observe("run", data), "O1 observed run for T1");
  assert.deepEqual(f.records()[0].data, data);
  const before = readFileSync(f.file, "utf8");
  const wrongTask = f.run(...f.args("run", data, "T2"));
  assert.equal(wrongTask.status, 1);
  assert.match(wrongTask.stderr, /R1.*T1/);
  assert.equal(f.run(...f.args("run", { ...data, run: "R99" })).status, 1);
  assert.equal(readFileSync(f.file, "utf8"), before);
  assert.deepEqual(f.tables(), tables);
});

test("board observations: completion, mode and bounded artifact references record explicit facts only", () => {
  const f = fixture();
  f.ok("task", "T1", "set", "state=abandoned");
  const completion = { state: "abandoned", at: "2025-12-31T23:00:00.000Z" }, mode = { session: "sample-session", autopilot: false };
  assert.equal(f.observe("completion", completion), "O1 observed completion for T1");
  assert.equal(f.observe("mode", mode), "O2 observed mode for T1");
  const target = join(f.temp, "private-fixture.txt");
  writeFileSync(target, "sample private content");
  symlinkSync(target, join(f.dir, "briefs", "T1.md"));
  const local = { type: "brief", label: "<sample brief>", path: "briefs/T1.md", sha256: "0".repeat(64) };
  assert.equal(f.observe("artifact", local), "O3 observed artifact for T1", "recording a reference neither follows the link nor checks its target");
  assert.equal(f.observe("artifact", { type: "issue", label: "Sample issue", url: "https://github.com/sample/project/issues/1" }), "O4 observed artifact for T1");
  assert.deepEqual(f.records().map(row => row.data), [completion, mode, local, { type: "issue", label: "Sample issue", url: "https://github.com/sample/project/issues/1" }]);
  assert.equal(readFileSync(target, "utf8"), "sample private content");
  assert.equal(f.records().some(row => JSON.stringify(row).includes("sample private content")), false);
});

test("board observations: invalid evidence and damaged sidecars refuse without replacing prior records", () => {
  const f = fixture();
  f.observe("pr", pr);
  const before = readFileSync(f.file, "utf8");
  for (const [kind, data, at] of [
    ["pr", { ...pr, repository: "https://user:secret@example.invalid/repo" }],
    ["pr", { ...pr, repository: "file:///tmp/example" }],
    ["pr", { ...pr, head: "short" }],
    ["pr", { ...pr, repository: "https://github.com/sample/project?next=other" }],
    ["pr", { ...pr, repository: "https://github.com/sample/project#other" }],
    ["pr", { ...pr, extra: "unknown" }],
    ["pr", pr, "2999-01-01T00:00:00Z"],
    ["mode", { session: "x", autopilot: "false" }],
    ["completion", { state: "merged", at: "2026-02-01T00:00:00Z" }],
    ...["../secret", "/tmp/secret", "briefs/../secret", "briefs/\\secret", "briefs/a\nb"].map(path => ["artifact", { type: "brief", label: "Sample", path, sha256: "0".repeat(64) }]),
    ["artifact", { type: "brief", label: "Sample", path: "briefs/a.md" }],
    ["artifact", { type: "brief", label: "Sample", path: "briefs/a.md", url: "https://example.invalid", sha256: "0".repeat(64) }],
  ]) {
    const out = f.run(...f.args(kind, data, "T1", at ?? AT));
    assert.equal(out.status, 1, JSON.stringify({ kind, data, out }));
    assert.equal(readFileSync(f.file, "utf8"), before);
  }
  for (const missing of ["--source", "--basis", "--observed-at"]) {
    const args = f.args("pr", pr), index = args.indexOf(missing);
    args.splice(index, 2);
    assert.equal(f.run(...args).status, 1, missing);
    assert.equal(readFileSync(f.file, "utf8"), before);
  }
  for (const damaged of ["{", JSON.stringify({ version: 2, records: [] }), JSON.stringify({ version: 1, records: [{ ...f.records()[0], observedAt: "2999-01-01T00:00:00.000Z" }] })]) {
    writeFileSync(f.file, damaged);
    assert.equal(f.run(...f.args("pr", pr)).status, 1);
    assert.equal(readFileSync(f.file, "utf8"), damaged);
    writeFileSync(f.file, before);
  }
  const external = join(f.temp, "external.json");
  writeFileSync(external, before);
  rmSync(f.file);
  symlinkSync(external, f.file);
  assert.equal(f.run(...f.args("pr", pr)).status, 1, "a linked sidecar refuses");
  assert.equal(readFileSync(external, "utf8"), before);
  rmSync(f.file);
  mkdirSync(f.file);
  assert.equal(f.run(...f.args("pr", pr)).status, 1, "a nonregular sidecar refuses");
  assert.deepEqual(readdirSync(f.file), []);
  rmSync(f.file, { recursive: true });
  const oversized = " ".repeat(4 * 1024 * 1024 + 1);
  writeFileSync(f.file, oversized);
  assert.equal(f.run(...f.args("pr", pr)).status, 1, "an oversized sidecar refuses");
  assert.equal(readFileSync(f.file, "utf8"), oversized);
});

test("board observations: concurrent writers append every fact with distinct record identities", async () => {
  const f = fixture();
  const outputs = await Promise.all(Array.from({ length: 8 }, (_, i) => f.concurrent(...f.args("pr", { ...pr, number: i + 1 }))));
  for (const out of outputs) assert.equal(out.status, 0, out.stderr);
  const records = f.records();
  assert.deepEqual(records.map(row => row.id), ["O1", "O2", "O3", "O4", "O5", "O6", "O7", "O8"]);
  assert.deepEqual(records.map(row => row.data.number).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(existsSync(join(f.dir, ".lock")), false);
  assert.equal(existsSync(f.kills), false);
});
