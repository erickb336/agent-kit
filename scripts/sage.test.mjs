// Runs the sage state tool as the chief of staff does: one command, one line out, against a temporary store.
import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const LIB = new URL("../plugins/sage/skills/sage/sage.mjs", import.meta.url).href;
const TOOL = fileURLToPath(LIB);
const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

/** A store for one made-up project. ok() expects success, no() expects a refusal; both return the output. */
function store() {
  const home = mkdtempSync(join(tmpdir(), "sage-home-"));
  const project = mkdtempSync(join(tmpdir(), "sage-project-"));
  const env = { ...process.env, SAGE_HOME: home };
  const run = (...args) => spawnSync("node", [TOOL, ...args, "--project", project], { encoding: "utf8", env });
  /** Runs a command in its own process and does not wait for it, as a second chief session does. */
  const go = (...args) => new Promise((done) => execFile("node", [TOOL, ...args, "--project", project], { env }, (err, stdout, stderr) => done({ status: err ? err.code : 0, stdout, stderr })));
  const ok = (...args) => {
    const r = run(...args);
    assert.equal(r.status, 0, `sage ${args.join(" ")} failed: ${r.stderr}`);
    return r.stdout.trim();
  };
  const no = (...args) => {
    const r = run(...args);
    assert.equal(r.status, 1, `sage ${args.join(" ")} should be refused, printed: ${r.stdout}`);
    return r.stderr.trim();
  };
  ok("init");
  return { home, run, go, ok, no, dir: ok("store") };
}

/** The rows of one table in a store. */
function rows(dir, table) {
  const [head, ...lines] = readFileSync(join(dir, `${table}.tsv`), "utf8").split("\n").filter(Boolean);
  return lines.map((line) => Object.fromEntries(line.split("\t").map((v, i) => [head.split("\t")[i], v])));
}

/** The output of fn and the milliseconds it took. */
function timed(fn) {
  const t0 = Date.now();
  const out = fn();
  return [out, Date.now() - t0];
}

/** A process that holds a store's lock as a command does: it crashes inside the lock, or keeps it for ms. */
function hold(dir, ms) {
  const inside = ms === "crash" ? `process.kill(process.pid, "SIGKILL")` : `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${ms})`;
  const args = ["--input-type=module", "-e", `import { withLock } from ${JSON.stringify(LIB)}; withLock(${JSON.stringify(dir)}, () => { console.log("holding"); ${inside}; });`];
  if (ms === "crash") return spawnSync("node", args, { encoding: "utf8" });
  const child = spawn("node", args);
  const exited = once(child, "exit");
  return new Promise((held, failed) => {
    child.stdout.once("data", () => held({ pid: child.pid, exited }));
    child.once("exit", (code) => failed(new Error(`the holder exited with ${code} before it held the lock`)));
  });
}

/** Leaves the lock of a crashed command in the store, with its owner record changed by edit. Returns the lock's path. */
function crash(dir, edit = {}) {
  assert.equal(hold(dir, "crash").signal, "SIGKILL");
  const lock = join(dir, ".lock");
  const owner = join(lock, readdirSync(lock)[0]);
  writeFileSync(owner, JSON.stringify({ ...JSON.parse(readFileSync(owner, "utf8")), ...edit }));
  return lock;
}

/** Moves a task from framed to reviewing, as a small route does. */
const toReviewing = (s, t) => {
  for (const state of ["briefed", "building", "reviewing"]) s.ok("task", t, "set", `state=${state}`);
};

test("a task's size gives its least route, and a risk adds the security review", () => {
  const s = store();
  assert.equal(s.ok("task", "add", "--title", "Fix the crash", "--size", "small"), "T1 framed · small · route build,code-review,qa");
  assert.equal(s.ok("task", "add", "--title", "Export trips", "--size", "small", "--risk", "data"), "T2 framed · small · risk data · route build,code-review,security-review,qa");
  assert.match(s.no("task", "add", "--title", "x", "--size", "huge"), /size is one of tiny, small, large, investigate/);
  assert.match(s.no("task", "add", "--title", "x", "--size", "small", "--add", "pe"), /missing --why/, "an added block needs its reason");
  assert.match(s.ok("task", "add", "--title", "Migrate", "--size", "small", "--add", "pe", "--why", "touches the schema"), /route pe,build,code-review,qa/);
  assert.match(readFileSync(join(s.dir, "decisions.tsv"), "utf8"), /T3\tadded pe\ttouches the schema/);
});

test("a task moves only along the design's states", () => {
  const s = store();
  s.ok("task", "add", "--title", "t", "--size", "small");
  assert.match(s.no("task", "T1", "set", "state=verified"), /cannot go from framed to verified\. Next: designing, briefed/);
  toReviewing(s, "T1");
  assert.match(s.ok("task", "T1", "set", "state=abandoned"), /^T1 abandoned/, "any state may be abandoned");
});

test("no dropped findings: a task cannot reach verifying while a finding is open, and a dismissal needs its reason", () => {
  const s = store();
  s.ok("task", "add", "--title", "t", "--size", "small");
  toReviewing(s, "T1");
  assert.equal(s.ok("finding", "add", "T1", "--source", "code-reviewer", "--severity", "high", "--summary", "empty date crashes"), "F-T1-1 open · high · T1");
  assert.match(s.no("task", "T1", "set", "state=verifying"), /open findings: F-T1-1 \(not triaged\)/);
  assert.match(s.no("finding", "triage", "T1", "F-T1-1", "dismiss"), /missing --reason/);
  assert.equal(s.ok("finding", "triage", "T1", "F-T1-1", "dismiss", "--reason", "the date field is required"), "F-T1-1 dismissed · dismiss");
  assert.match(s.ok("task", "T1", "set", "state=verifying"), /^T1 verifying/);
});

test("repair rounds are bounded, and a round that fixes nothing re-plans the task", () => {
  const s = store();
  s.ok("task", "add", "--title", "t", "--size", "small");
  toReviewing(s, "T1");
  assert.match(s.no("round", "T1"), /no open findings marked fix/);
  s.ok("finding", "add", "T1", "--source", "qa", "--severity", "low", "--summary", "a typo in the error");
  s.ok("finding", "triage", "T1", "F-T1-1", "fix");
  assert.match(s.no("round", "T1"), /only low findings are marked fix \(F-T1-1\)\. A repair round needs a medium or high finding/);
  s.ok("finding", "add", "T1", "--source", "qa", "--severity", "high", "--summary", "crash");
  s.ok("finding", "triage", "T1", "F-T1-2", "fix");
  assert.equal(s.ok("round", "T1"), "T1 repairing · round 1 of 3 · fix F-T1-1,F-T1-2", "the low finding joins the round");
  s.ok("task", "T1", "set", "state=reviewing");
  assert.equal(s.ok("round", "T1"), "T1 replan: round 1 did not fix F-T1-1,F-T1-2. Attack the premise, then brief again.");

  const b = store();
  b.ok("task", "add", "--title", "t", "--size", "small");
  toReviewing(b, "T1");
  for (let n = 1; n <= 3; n++) {
    b.ok("finding", "add", "T1", "--source", "qa", "--severity", "medium", "--summary", `problem ${n}`);
    b.ok("finding", "triage", "T1", `F-T1-${n}`, "fix");
    if (n > 1) b.ok("finding", "close", "T1", `F-T1-${n - 1}`);
    assert.match(b.ok("round", "T1"), new RegExp(`round ${n} of 3`));
    b.ok("task", "T1", "set", "state=reviewing");
  }
  b.ok("finding", "add", "T1", "--source", "qa", "--severity", "medium", "--summary", "problem 4");
  b.ok("finding", "triage", "T1", "F-T1-4", "fix");
  b.ok("finding", "close", "T1", "F-T1-3");
  assert.equal(b.ok("round", "T1"), "T1 held: 3 repair rounds did not make it clean. Stop and ask the user.");
});

test("one writer per branch", () => {
  const s = store();
  s.ok("task", "add", "--title", "t", "--size", "small");
  assert.match(s.no("run", "add", "T1", "--role", "implementer"), /needs --branch/);
  assert.equal(s.ok("run", "add", "T1", "--role", "implementer", "--branch", "claude/t1"), "R1 running · implementer on T1 · claude/t1");
  assert.match(s.no("run", "add", "T1", "--role", "implementer", "--branch", "claude/t1"), /R1 \(implementer\) still writes claude\/t1/);
  assert.match(s.ok("run", "add", "T1", "--role", "code-reviewer", "--branch", "claude/t1"), /R2 running/, "readers do not count");
  s.ok("run", "done", "R1", "--status", "done", "--tokens", "52000");
  assert.match(s.ok("run", "add", "T1", "--role", "implementer", "--branch", "claude/t1"), /R3 running/);
});

test("the merge check needs no open findings, checks-pass, and the route's verdicts in 2 clean cycles on the SHA", () => {
  const s = store();
  s.ok("task", "add", "--title", "t", "--size", "small");
  const verdict = (kind, cycle, sha = SHA) => s.ok("verdict", "T1", "--sha", sha, "--kind", kind, "--cycle", String(cycle), "--pr", "41");
  assert.match(s.no("merge-check", "--sha", SHA), /no verdicts recorded/);
  verdict("checks-pass", 1);
  verdict("review-clean", 1);
  assert.match(s.no("merge-check", "--sha", SHA), /T1: 0 of 2 clean cycles on this SHA; never recorded: qa-pass/);
  verdict("qa-pass", 1);
  assert.match(s.no("merge-check", "--sha", SHA), /T1: 1 of 2 clean cycles/);
  verdict("review-clean", 2);
  verdict("qa-pass", 2);
  assert.equal(s.ok("merge-check", "--sha", SHA.slice(0, 12)), "T1 may merge: 2 clean cycles on this SHA");
  assert.match(s.no("merge-check", "--sha", "ffffffffffffffffffffffffffffffffffffffff"), /no verdicts recorded/, "another SHA has none of these verdicts");

  s.ok("finding", "add", "T1", "--source", "security-reviewer", "--severity", "high", "--summary", "token in the log");
  assert.match(s.no("merge-check", "--sha", SHA), /open findings: F-T1-1/);
  s.ok("finding", "triage", "T1", "F-T1-1", "dismiss", "--reason", "a test token");
  verdict("findings", 3);
  assert.match(s.no("merge-check", "--sha", SHA), /cycle 3 found problems on this SHA \(findings\)/);
});

test("a tiny task needs only its checks once", () => {
  const s = store();
  s.ok("task", "add", "--title", "Fix a typo", "--size", "tiny");
  s.ok("verdict", "T1", "--sha", SHA, "--kind", "checks-pass");
  assert.equal(s.ok("merge-check", "--sha", SHA), "T1 may merge: 1 clean cycle on this SHA");
});

test("config, gates, standing orders and status", () => {
  const s = store();
  assert.equal(s.ok("config"), "max_agents=3 autopilot_cycles=2 max_rounds=3 arena=3 arena_models=opus,sonnet,sonnet");
  assert.equal(s.ok("config", "max_agents=5", "arena_models=opus,opus,sonnet"), "max_agents=5 autopilot_cycles=2 max_rounds=3 arena=3 arena_models=opus,opus,sonnet");
  assert.match(s.no("config", "arena_models=gpt-5"), /arena_models as a list of opus, sonnet, haiku, inherit/);
  assert.match(s.no("config", "colour=5"), /config takes max_agents/);
  s.ok("task", "add", "--title", "Export trips", "--size", "large");
  assert.equal(s.ok("gate", "add", "T1", "--question", "Include deleted trips?", "--options", "yes|no", "--recommend", "no", "--default", "no"), "G1 open · Include deleted trips?");
  assert.match(s.ok("standing", "add", "Use pnpm, not npm."), /standing order 5 added/);
  assert.match(s.ok("standing"), /5\. Use pnpm, not npm\./);
  const lines = s.ok("status").split("\n");
  assert.equal(lines[1], "tasks   1 · framed 1");
  assert.equal(lines[2], "gates   1 open · G1 Include deleted trips? (default: no)");
  assert.match(readFileSync(join(s.dir, "status.md"), "utf8"), /\| T1 \| framed \| large \| 0 \|  \| Export trips \|/);
  s.ok("gate", "answer", "G1", "no");
  assert.match(s.ok("status"), /gates   0 open/);
  assert.match(readFileSync(join(s.dir, "decisions.tsv"), "utf8"), /Include deleted trips\? → no\tthe user's answer/);
});

test("a command without a store tells how to make one", () => {
  const home = mkdtempSync(join(tmpdir(), "sage-home-"));
  const r = spawnSync("node", [TOOL, "status", "--project", tmpdir()], { encoding: "utf8", env: { ...process.env, SAGE_HOME: home } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no store for this project\. Run: sage init/);
  assert.equal(existsSync(join(home, "config.json")), false);
  writeFileSync(join(home, "x"), ""); // the root holds only stores and config.json; a stray file is ignored
  assert.match(spawnSync("node", [TOOL, "merge-check", "--sha", SHA], { encoding: "utf8", env: { ...process.env, SAGE_HOME: home } }).stderr, /no verdicts recorded/);
});

test("fixes from dry run 1: a value may start with --, status.md never lags, and a clean verdict lists open fix findings", () => {
  const s = store();
  s.ok("task", "add", "--title", "t", "--size", "small");
  assert.match(readFileSync(join(s.dir, "status.md"), "utf8"), /\| T1 \| framed \|/, "status.md follows a change without a status command");
  s.ok("finding", "add", "T1", "--source", "code-reviewer", "--severity", "medium", "--summary", "--since=DATE is ignored");
  assert.match(readFileSync(join(s.dir, "findings.tsv"), "utf8"), /\t--since=DATE is ignored\t/);
  s.ok("finding", "triage", "T1", "F-T1-1", "fix");
  assert.match(s.ok("verdict", "T1", "--sha", SHA, "--kind", "review-clean"), /still open: F-T1-1\. Close the ones that this review confirmed fixed\./);
  assert.doesNotMatch(s.ok("verdict", "T1", "--sha", SHA, "--kind", "findings"), /still open/, "a findings verdict does not remind");
});

test("verified needs one clean cycle on the latest SHA; an autopilot merge needs two", () => {
  const s = store();
  s.ok("task", "add", "--title", "t", "--size", "small");
  toReviewing(s, "T1");
  s.ok("task", "T1", "set", "state=verifying");
  assert.match(s.no("task", "T1", "set", "state=verified"), /T1 has no verdicts yet/);
  for (const kind of ["checks-pass", "review-clean"]) s.ok("verdict", "T1", "--sha", SHA, "--kind", kind);
  assert.match(s.no("task", "T1", "set", "state=verified"), /not verified on a1b2c3d: T1: 0 of 1 clean cycles on this SHA; never recorded: qa-pass/);
  s.ok("verdict", "T1", "--sha", SHA, "--kind", "qa-pass");
  assert.match(s.ok("task", "T1", "set", "state=verified"), /^T1 verified/);
  assert.match(s.no("merge-check", "--sha", SHA), /1 of 2 clean cycles/, "autopilot wants 2");
  assert.equal(s.ok("merge-check", "--sha", SHA, "--cycles", "1"), "T1 may merge: 1 clean cycle on this SHA");
});

test("two chiefs at once: 2 x 50 rounds of updates and of creates lose no write and repeat no id", async () => {
  const s = store();
  s.ok("task", "add", "--title", "a", "--size", "small");
  s.ok("task", "add", "--title", "b", "--size", "small");
  const refused = [];
  let lost = 0;
  for (let i = 1; i <= 50; i++) {
    const out = await Promise.all([s.go("task", "T1", "set", `branch=a-${i}`), s.go("task", "T2", "set", `branch=b-${i}`)]);
    refused.push(...out.filter((r) => r.status !== 0).map((r) => r.stderr));
    const branch = Object.fromEntries(rows(s.dir, "tasks").map((t) => [t.id, t.branch]));
    lost += (branch.T1 !== `a-${i}`) + (branch.T2 !== `b-${i}`);
  }
  for (let i = 1; i <= 50; i++) {
    const out = await Promise.all([s.go("task", "add", "--title", `ca-${i}`, "--size", "tiny"), s.go("task", "add", "--title", `cb-${i}`, "--size", "tiny")]);
    refused.push(...out.filter((r) => r.status !== 0).map((r) => r.stderr));
  }
  const tasks = rows(s.dir, "tasks");
  assert.deepEqual(
    { refused, lost, created: tasks.filter((t) => /^c[ab]-\d+$/.test(t.title)).length, duplicates: tasks.length - new Set(tasks.map((t) => t.id)).size },
    { refused: [], lost: 0, created: 100, duplicates: 0 },
  );
  assert.equal(tasks.at(-1).id, "T102");
});

test("two implementer runs on one branch at once: exactly one is refused, every time", async () => {
  const s = store();
  s.ok("task", "add", "--title", "t", "--size", "small");
  const outcomes = [];
  for (let k = 1; k <= 10; k++) {
    const out = await Promise.all([1, 2].map(() => s.go("run", "add", "T1", "--role", "implementer", "--branch", `feat-${k}`)));
    outcomes.push(out.map((r) => r.status).sort().join(" and "));
    assert.match(out.find((r) => r.status === 1)?.stderr ?? "", new RegExp(`still writes feat-${k}\\. One writer per branch\\.`));
  }
  assert.deepEqual(outcomes, Array(10).fill("0 and 1"));
});

test("a lock left by a crashed command is cleared by the next command", () => {
  const s = store();
  s.ok("task", "add", "--title", "t", "--size", "small");
  const lock = crash(s.dir);
  let [r, ms] = timed(() => s.run("task", "T1", "set", "branch=after-crash"));
  assert.equal(r.status, 0, r.stderr);
  assert.ok(ms < 2000, `cleared after ${ms} ms`);
  assert.equal(existsSync(lock), false);
  assert.equal(rows(s.dir, "tasks")[0].branch, "after-crash");

  crash(s.dir, { boot: 1 }); // the machine started again since the lock was taken
  [r, ms] = timed(() => s.run("task", "T1", "set", "branch=after-boot"));
  assert.equal(r.status, 0, r.stderr);
  assert.ok(ms < 2000, `cleared after ${ms} ms`);

  crash(s.dir, { pid: process.pid, start: 1000 }); // its pid now names another live process, which started later: this test
  [r, ms] = timed(() => s.run("task", "T1", "set", "branch=after-reuse"));
  assert.equal(r.status, 0, r.stderr);
  assert.ok(ms >= 500 && ms < 3000, `cleared after ${ms} ms: the start time is checked after 500 ms`);
  assert.equal(existsSync(lock), false);
  assert.equal(rows(s.dir, "tasks")[0].branch, "after-reuse");
});

test("a holder that may be alive keeps the lock: a waiter waits for it, or refuses after about 3 s with one line", async () => {
  const s = store();
  s.ok("task", "add", "--title", "t", "--size", "small");
  let h = await hold(s.dir, 4500);
  let [r, ms] = timed(() => s.run("task", "T1", "set", "branch=while-held"));
  assert.equal(r.status, 1);
  assert.match(r.stderr, new RegExp(`^sage: the store is busy: pid ${h.pid} on \\S+ has held \\S+\\.lock for \\d+\\.\\d s\\. Nothing changed; run the command again\\.\\n$`));
  assert.ok(ms >= 3000 && ms < 5000, `refused after ${ms} ms; the hook timeout is 10 s`);
  assert.deepEqual(await h.exited, [0, null], "the holder finished with its lock");
  assert.equal(rows(s.dir, "tasks")[0].branch, "");

  h = await hold(s.dir, 1500);
  [r, ms] = timed(() => s.run("task", "T1", "set", "branch=after-wait"));
  assert.equal(r.status, 0, r.stderr);
  assert.ok(ms >= 1000, `took the lock after ${ms} ms, while the holder still held it`);
  await h.exited;

  const lock = crash(s.dir, { host: "other-host", boot: 1 }); // this machine cannot check a process on another one
  [r, ms] = timed(() => s.run("task", "T1", "set", "branch=other-host"));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^sage: the store is busy: pid \d+ on other-host has held \S+\.lock for/);
  assert.ok(ms >= 3000 && ms < 5000, `refused after ${ms} ms`);
  assert.equal(existsSync(lock), true);
  rmSync(lock, { recursive: true });
  assert.match(s.ok("task", "T1", "set", "branch=after-removal"), /^T1 framed/);
});

test("merge-check, status, store and standing take no lock: they work while another command holds it", async () => {
  const s = store();
  s.ok("task", "add", "--title", "t", "--size", "tiny");
  s.ok("verdict", "T1", "--sha", SHA, "--kind", "checks-pass");
  const h = await hold(s.dir, 4000);
  const [out, ms] = timed(() => [s.ok("merge-check", "--sha", SHA), s.ok("status").split("\n")[1], s.ok("store"), s.ok("standing").split("\n")[0]]);
  assert.deepEqual(out, ["T1 may merge: 1 clean cycle on this SHA", "tasks   1 · framed 1", s.dir, "# Standing orders"]);
  assert.ok(ms < 3000, `${ms} ms: a command that waited for the lock would refuse at 3 s`);
  await h.exited;
});

test("ids after a gap are new: a lost row never gives its id again, and a new finding never reopens an old one", () => {
  const s = store();
  /** Removes one row, as a write lost before the lock did. */
  const lose = (table, col, id) => {
    const f = join(s.dir, `${table}.tsv`);
    writeFileSync(f, readFileSync(f, "utf8").split("\n").filter((line) => line.split("\t")[col] !== id).join("\n"));
  };
  s.ok("task", "add", "--title", "a", "--size", "small");
  s.ok("task", "add", "--title", "b", "--size", "small");
  lose("tasks", 0, "T1");
  assert.match(s.ok("task", "add", "--title", "c", "--size", "small"), /^T3 framed/);
  s.ok("run", "add", "T2", "--role", "qa");
  s.ok("run", "add", "T2", "--role", "qa");
  lose("runs", 0, "R1");
  assert.match(s.ok("run", "add", "T2", "--role", "qa"), /^R3 running/);
  for (const q of ["a?", "b?"]) s.ok("gate", "add", "T2", "--question", q, "--options", "yes|no", "--recommend", "no");
  lose("gates", 0, "G1");
  assert.match(s.ok("gate", "add", "T2", "--question", "c?", "--options", "yes|no", "--recommend", "no"), /^G3 open/);
  s.ok("finding", "add", "T2", "--source", "qa", "--severity", "low", "--summary", "first");
  s.ok("finding", "add", "T2", "--source", "qa", "--severity", "low", "--summary", "second");
  s.ok("finding", "triage", "T2", "F-T2-2", "dismiss", "--reason", "by design");
  lose("findings", 1, "F-T2-1");
  assert.equal(s.ok("finding", "add", "T2", "--source", "qa", "--severity", "high", "--summary", "third"), "F-T2-3 open · high · T2");
  assert.deepEqual(rows(s.dir, "findings").map((f) => `${f.key} ${f.status} ${f.summary}`), ["F-T2-2 dismissed second", "F-T2-3 open third"]);
});

test("config: every count is 1 or more, config.json is written whole, and a torn or bad file gives the defaults", async () => {
  const s = store();
  const f = join(s.home, "config.json");
  for (const [key, why] of Object.entries({ max_agents: "no sage agent could start", autopilot_cycles: "a merge would need no review", max_rounds: "no repair round could start", arena: "an arena would have no candidates" })) {
    assert.equal(s.no("config", `${key}=0`), `sage: ${key} must be a whole number of 1 or more: with 0, ${why}`);
  }
  assert.match(s.no("config", "max_agents=-1"), /max_agents must be a whole number of 1 or more/);
  assert.match(s.no("config", "toString=5"), /config takes max_agents/);
  assert.equal(existsSync(f), false, "a refused change writes nothing");

  s.ok("task", "add", "--title", "t", "--size", "small");
  for (const kind of ["checks-pass", "review-clean", "qa-pass"]) s.ok("verdict", "T1", "--sha", SHA, "--kind", kind);
  for (const text of ['{"autopilot_cycles": 1', "", "null", '{"autopilot_cycles": 0}']) {
    writeFileSync(f, text);
    assert.match(s.no("merge-check", "--sha", SHA), /T1: 1 of 2 clean cycles/, `config.json ${JSON.stringify(text)} keeps the default of 2 cycles`);
  }
  assert.match(s.no("merge-check", "--sha", SHA, "--cycles", "0"), /--cycles is a whole number of 1 or more/);
  writeFileSync(f, '{"max_agents": "x", "max_rounds": 5, "arena_models": "gpt-5"}');
  assert.equal(s.ok("config"), "max_agents=3 autopilot_cycles=2 max_rounds=5 arena=3 arena_models=opus,sonnet,sonnet", "each bad value gives its default");

  // Two processes write config.json 200 times each, while this one reads it: every read sees a whole file.
  const writers = [1, 2].map(() => spawn("node", ["--input-type=module", "-e", `import { sage } from ${JSON.stringify(LIB)}; for (let i = 1; i <= 200; i++) sage(["config", "max_rounds=" + i]);`], { env: { ...process.env, SAGE_HOME: s.home } }));
  const exits = Promise.all(writers.map((w) => once(w, "exit")));
  let running = true;
  exits.then(() => (running = false));
  let reads = 0;
  let torn = 0;
  while (running) {
    try {
      JSON.parse(readFileSync(f, "utf8"));
    } catch {
      torn++;
    }
    reads++;
    await new Promise((next) => setImmediate(next));
  }
  assert.deepEqual(await exits, [[0, null], [0, null]]);
  assert.equal(torn, 0, `${torn} of ${reads} reads saw half a file`);
  assert.equal(JSON.parse(readFileSync(f, "utf8")).max_rounds, 200);
});

test("an investigation ends at concluded, after a clean evidence review recorded without a SHA; a build route cannot", () => {
  const s = store();
  assert.equal(s.ok("task", "add", "--title", "Why are writes lost?", "--size", "investigate"), "T1 framed · investigate · route investigate,evidence-review");
  toReviewing(s, "T1");
  assert.match(s.no("verdict", "T1", "--kind", "evidence-clean", "--sha", SHA), /T1 has no build block, so its verdicts name no commit: leave out --sha/);
  s.ok("task", "T1", "set", "state=verifying");
  assert.match(s.no("task", "T1", "set", "state=verified"), /T1 has no build block, so it ends at concluded/);
  assert.match(s.no("task", "T1", "set", "state=concluded"), /T1 needs a clean evidence review as its latest verdict: sage verdict T1 --kind evidence-clean/);
  assert.equal(s.ok("verdict", "T1", "--kind", "evidence-clean", "--run", "R1"), "T1 evidence-clean · cycle 1");
  s.ok("finding", "add", "T1", "--source", "code-reviewer", "--severity", "medium", "--summary", "a claim without its command");
  assert.match(s.no("task", "T1", "set", "state=concluded"), /T1 has open findings: F-T1-1 \(not triaged\)/);
  s.ok("finding", "triage", "T1", "F-T1-1", "dismiss", "--reason", "the command is in the notes");
  s.ok("verdict", "T1", "--kind", "findings");
  assert.match(s.no("task", "T1", "set", "state=concluded"), /needs a clean evidence review as its latest verdict/, "only the latest verdict counts");
  s.ok("verdict", "T1", "--kind", "evidence-clean");
  assert.match(s.ok("task", "T1", "set", "state=concluded"), /^T1 concluded/);
  assert.match(s.no("task", "T1", "set", "state=reviewing"), /cannot go from concluded to reviewing\. Next: none/);
  assert.equal(s.ok("status").split("\n")[1], "tasks   1 · concluded 1");
  assert.deepEqual(rows(s.dir, "ledger").map((r) => `${r.kind}:${r.sha}`), ["evidence-clean:", "findings:", "evidence-clean:"], "the merge gate reads no row without a SHA");

  const b = store();
  b.ok("task", "add", "--title", "t", "--size", "small");
  assert.match(b.no("verdict", "T1", "--kind", "checks-pass"), /missing --sha/);
  toReviewing(b, "T1");
  b.ok("task", "T1", "set", "state=verifying");
  assert.match(b.no("task", "T1", "set", "state=concluded"), /T1 has a build block, so it ends at verified/);
});
