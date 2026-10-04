// Runs the sage state tool as the chief of staff does: one command, one line out, against a temporary store.
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir, uptime } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const LIB = new URL("../plugins/sage/skills/sage/sage.mjs", import.meta.url).href;
const TOOL = fileURLToPath(LIB);
const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const BOOT = Date.now() - uptime() * 1000;
/** A command that hangs is stopped after this, so that a test fails instead of waiting for ever. */
const timeout = 10_000;

/** A store for one made-up project, in a new root or in home. ok() expects success, no() expects a refusal; both return the output. */
function store(home = mkdtempSync(join(tmpdir(), "sage-home-")), name = "sage-project-") {
  const project = mkdtempSync(join(tmpdir(), name));
  const env = { ...process.env, SAGE_HOME: home };
  const run = (...args) => spawnSync("node", [TOOL, ...args, "--project", project], { encoding: "utf8", env, timeout });
  /** Runs a command in its own process and does not wait for it, as a second chief session does. */
  const go = (...args) => new Promise((done) => execFile("node", [TOOL, ...args, "--project", project], { env, timeout }, (err, stdout, stderr) => done({ status: err ? err.code : 0, stdout, stderr })));
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
  assert.equal(s.ok("merge-check", "--sha", SHA), "T1 may merge: 2 clean cycles on this SHA");
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
  assert.match(r.stderr, new RegExp(`^sage: the store is busy: pid ${h.pid} on (\\S+) has held (\\S+\\.lock) for \\d+\\.\\d s\\. Nothing changed\\. Run the command again; if no sage command runs on \\1, remove \\2 first\\.\\n$`));
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

/** Plants an owner file in a store's lock folder, as another program or a person could. Returns the lock's path. */
function plant(dir, name, record) {
  const lock = join(dir, ".lock");
  mkdirSync(lock);
  writeFileSync(join(lock, name), JSON.stringify(record));
  return lock;
}

test("S1: a waiter takes the owner file's name only from the lock folder, so no record makes it remove a file outside", async () => {
  const s = store();
  s.ok("task", "add", "--title", "t", "--size", "small");
  const victim = join(s.home, "important.txt");
  writeFileSync(victim, "keep me");
  let lock = crash(s.dir, { file: "../../important.txt" }); // a dead holder whose record names another file
  assert.match(s.ok("task", "T1", "set", "branch=after-plant"), /^T1 framed/, "the waiter clears the dead holder's own file");
  assert.equal(existsSync(lock), false);
  assert.equal(readFileSync(victim, "utf8"), "keep me");

  lock = plant(s.dir, "x.json", { file: "../../important.txt", pid: spawnSync("node", ["-e", ""]).pid, host: hostname(), boot: BOOT, start: 0, at: 0 });
  const r = await s.go("task", "T1", "set", "branch=odd-name");
  assert.equal(r.stderr, `sage: the store is busy: ${lock} has no valid owner file. Nothing changed. Run the command again; if no sage command runs, remove ${lock} first.\n`, "an owner file not named <uuid>.json is never removed");
  assert.equal(r.status, 1);
  assert.deepEqual([readFileSync(victim, "utf8"), readdirSync(lock)], ["keep me", ["x.json"]]);
});

test("S2: a planted lock never hangs a command, the refusal says which folder to remove, and a killed waiter's temp folder goes", async () => {
  const [fifo, live] = [store(), store()];
  const fifoLock = join(fifo.dir, ".lock");
  mkdirSync(fifoLock);
  execFileSync("mkfifo", [join(fifoLock, `${randomUUID()}.json`)]);
  const liveLock = plant(live.dir, `${randomUUID()}.json`, { pid: 1, host: hostname(), boot: BOOT, start: Date.now(), at: Date.now() }); // alive, and not sage
  const [[a, b], ms] = await (async (t0) => [await Promise.all([fifo.go("log", "-", "x", "--why", "w"), live.go("log", "-", "x", "--why", "w")]), Date.now() - t0])(Date.now());
  assert.equal(a.stderr, `sage: the store is busy: ${fifoLock} has no valid owner file. Nothing changed. Run the command again; if no sage command runs, remove ${fifoLock} first.\n`);
  assert.match(b.stderr, new RegExp(`^sage: the store is busy: pid 1 on ${hostname()} has held ${liveLock} for \\d\\.\\d s\\. Nothing changed\\. Run the command again; if no sage command runs on ${hostname()}, remove ${liveLock} first\\.\\n$`));
  assert.deepEqual([a.status, b.status], [1, 1]);
  assert.ok(ms >= 3000 && ms < 6000, `both refused after ${ms} ms`);
  rmSync(liveLock, { recursive: true }); // what the line says to do
  assert.equal(live.ok("log", "-", "x", "--why", "w"), "logged");

  const s = store();
  const lock = crash(s.dir);
  const killed = join(s.dir, `.lock.${basename(readdirSync(lock)[0], ".json")}`);
  renameSync(lock, killed); // the temp folder of a waiter that was killed before its rename
  const waiter = join(s.dir, `.lock.${randomUUID()}`); // the temp folder of a waiter that still runs: this process
  mkdirSync(waiter);
  writeFileSync(join(waiter, `${basename(waiter).slice(6)}.json`), JSON.stringify({ pid: process.pid, host: hostname(), boot: BOOT, start: Date.now() - process.uptime() * 1000, at: Date.now() }));
  s.ok("log", "-", "x", "--why", "w");
  assert.deepEqual([existsSync(killed), existsSync(waiter)], [false, true]);
});

test("S3: only digits count in an id, so a new finding never reopens a key that it did not name", () => {
  const s = store();
  s.ok("task", "add", "--title", "t", "--size", "small");
  s.ok("finding", "add", "T1", "--key", "F-T1-Infinity", "--severity", "low", "--source", "qa", "--summary", "old low");
  s.ok("finding", "triage", "T1", "F-T1-Infinity", "dismiss", "--reason", "cosmetic");
  assert.equal(s.ok("finding", "add", "T1", "--severity", "high", "--source", "sec", "--summary", "new high: auth bypass"), "F-T1-1 open · high · T1");
  s.ok("finding", "add", "T1", "--key", "F-T1-9007199254740993", "--severity", "low", "--source", "qa", "--summary", "a long number");
  assert.equal(s.ok("finding", "add", "T1", "--severity", "high", "--source", "qa", "--summary", "next"), "F-T1-9007199254740994 open · high · T1", "a long number stays exact");
  assert.equal(s.ok("finding", "add", "T1", "--key", "F-T1-Infinity", "--severity", "medium"), "F-T1-Infinity open again · medium · T1", "a named key opens its finding again");
  assert.deepEqual(rows(s.dir, "findings").map((f) => `${f.key} ${f.severity} ${f.status} ${f.summary}`), [
    "F-T1-Infinity medium open old low",
    "F-T1-1 high open new high: auth bypass",
    "F-T1-9007199254740993 low open a long number",
    "F-T1-9007199254740994 high open next",
  ]);
});

test("S4: every store that has verdicts on a SHA must pass, so a second store cannot open the merge gate", () => {
  const real = store();
  real.ok("task", "add", "--title", "t", "--size", "small");
  real.ok("verdict", "T1", "--sha", SHA, "--kind", "checks-pass");
  real.ok("finding", "add", "T1", "--source", "security-reviewer", "--severity", "high", "--summary", "auth bypass");
  const decoy = store(real.home, "aa-"); // its name comes first
  decoy.ok("task", "add", "--title", "decoy", "--size", "tiny");
  decoy.ok("verdict", "T1", "--sha", SHA, "--kind", "checks-pass");
  const [d, r] = [decoy.dir, real.dir];
  const todo = "To merge, make each one pass, or push a new commit and record its verdicts under the live tasks only.";
  assert.equal(real.no("merge-check", "--sha", SHA), `sage: 2 tasks have verdicts on a1b2c3d, and each must pass; 1 fails. ${r} T1 has open findings: F-T1-1. Triage and close them first. ${todo}`);
  real.ok("finding", "triage", "T1", "F-T1-1", "fix");
  real.ok("finding", "close", "T1", "F-T1-1");
  for (const kind of ["review-clean", "qa-pass"]) real.ok("verdict", "T1", "--sha", SHA, "--kind", kind);
  assert.equal(real.ok("merge-check", "--sha", SHA, "--cycles", "1"), `2 tasks have verdicts on a1b2c3d, and each must pass: ${d} T1 may merge: 1 clean cycle on this SHA; ${r} T1 may merge: 1 clean cycle on this SHA`);
  decoy.ok("task", "add", "--title", "decoy", "--size", "small");
  decoy.ok("verdict", "T2", "--sha", SHA, "--kind", "checks-pass");
  assert.equal(real.no("merge-check", "--sha", SHA, "--cycles", "1"), `sage: 3 tasks have verdicts on a1b2c3d, and each must pass; 1 fails. ${d} T2: 0 of 1 clean cycles on this SHA; never recorded: review-clean, qa-pass. Run the next cycle of its reviews on this SHA and record each verdict. ${todo}`, "a store that fails closes the gate");
});

test("S5: verdicts and the merge gate take only a full SHA, and each task counts only its own verdicts", () => {
  const s = store();
  s.ok("task", "add", "--title", "a", "--size", "small");
  s.ok("task", "add", "--title", "b", "--size", "small");
  const short = (sha) => `sage: "${sha}" is not a full commit SHA: a short one can match another commit. Give all 40 characters: git rev-parse <branch>.`;
  assert.equal(s.no("verdict", "T1", "--sha", "9999999", "--kind", "checks-pass"), short("9999999"));
  for (const kind of ["checks-pass", "review-clean", "qa-pass"]) s.ok("verdict", "T1", "--sha", SHA, "--kind", kind);
  assert.equal(s.no("merge-check", "--sha", SHA.slice(0, 7), "--cycles", "1"), short("a1b2c3d"));
  assert.equal(s.ok("merge-check", "--sha", SHA, "--cycles", "1"), "T1 may merge: 1 clean cycle on this SHA");

  const other = "0123456789abcdef0123456789abcdef01234567";
  s.ok("verdict", "T1", "--sha", other, "--kind", "checks-pass");
  for (const kind of ["review-clean", "qa-pass"]) s.ok("verdict", "T2", "--sha", other, "--kind", kind); // T2's reviews are not T1's
  assert.equal(s.no("merge-check", "--sha", other, "--cycles", "1"), `sage: 2 tasks have verdicts on 0123456, and each must pass; 2 fail. ${s.dir} T1: 0 of 1 clean cycles on this SHA; never recorded: review-clean, qa-pass. Run the next cycle of its reviews on this SHA and record each verdict. ${s.dir} T2: no checks-pass on this SHA. Run the checks on it and record checks-pass. To merge, make each one pass, or push a new commit and record its verdicts under the live tasks only.`);
});

test("S6: an investigation takes no build block; a build that it needs is its own task", () => {
  const s = store();
  assert.equal(s.no("task", "add", "--title", "inv", "--size", "investigate", "--risk", "auth", "--add", "build", "--why", "x"), "sage: an investigation changes no code, so it takes no build block. Frame the build as its own task: sage task add --size tiny, small or large");
  assert.deepEqual(rows(s.dir, "tasks"), [], "a refused task writes nothing");
  assert.equal(s.ok("task", "add", "--title", "inv", "--size", "investigate", "--add", "pe", "--why", "x"), "T1 framed · investigate · route pe,investigate,evidence-review");
});

test("S7: config and the merge gate read only regular files and never throw, so the hook never waits or lets a merge through", () => {
  const s = store();
  s.ok("task", "add", "--title", "t", "--size", "tiny");
  s.ok("verdict", "T1", "--sha", SHA, "--kind", "checks-pass");
  execFileSync("mkfifo", [join(s.home, "config.json")]);
  const [out, ms] = timed(() => [s.ok("config"), s.ok("merge-check", "--sha", SHA)]);
  assert.deepEqual(out, ["max_agents=3 autopilot_cycles=2 max_rounds=3 arena=3 arena_models=opus,sonnet,sonnet", "T1 may merge: 1 clean cycle on this SHA"]);
  assert.ok(ms < 3000, `${ms} ms`);
  rmSync(join(s.dir, "ledger.tsv"));
  execFileSync("mkfifo", [join(s.dir, "ledger.tsv")]);
  assert.match(s.no("merge-check", "--sha", SHA), /^sage: no verdicts recorded for a1b2c3d/, "a table that is not a regular file has no rows");
  const file = join(s.home, "a-file");
  writeFileSync(file, "");
  const r = spawnSync("node", [TOOL, "merge-check", "--sha", SHA], { encoding: "utf8", env: { ...process.env, SAGE_HOME: file }, timeout });
  assert.deepEqual([r.status, r.stderr], [1, `sage: the merge gate cannot read ${file} (ENOTDIR), so it refuses every merge. Ask the user to fix or remove ${file}.\n`]);
});

test("F1: no config.json makes config() or the merge gate throw: a value that is not a number or a string gives its default", async () => {
  const s = store();
  s.ok("task", "add", "--title", "t", "--size", "small");
  s.ok("verdict", "T1", "--sha", SHA, "--kind", "checks-pass");
  const deep = `${"[".repeat(20000)}${"]".repeat(20000)}`; // String() of this overflows the stack
  writeFileSync(join(s.home, "config.json"), `{"autopilot_cycles": ${deep}, "max_agents": [5], "max_rounds": 4}`);
  const { config, mergeCheck } = await import(LIB);
  const env = { SAGE_HOME: s.home };
  assert.deepEqual(config(env), { max_agents: 3, autopilot_cycles: 2, max_rounds: 4, arena: 3, arena_models: "opus,sonnet,sonnet" });
  const none = "9".repeat(40);
  assert.deepEqual(mergeCheck(none, env), { ok: false, reason: `no verdicts recorded for ${none}. Record the reviews and QA with sage verdict first.` }, "the hook's call: no cycles given");
  assert.equal(mergeCheck(SHA, env).ok, false);
  assert.equal(s.ok("config"), "max_agents=3 autopilot_cycles=2 max_rounds=4 arena=3 arena_models=opus,sonnet,sonnet");
  assert.match(s.no("merge-check", "--sha", SHA), /^sage: T1: 0 of 2 clean cycles on this SHA; never recorded: review-clean, qa-pass\./);
});

test("F2: with --pr, every task of that pull request must pass on the SHA, so a lighter task cannot decide it alone", () => {
  const s = store();
  s.ok("task", "add", "--title", "the PR's task", "--size", "small");
  s.ok("task", "add", "--title", "a typo", "--size", "tiny");
  const old = "0123456789abcdef0123456789abcdef01234567";
  for (const kind of ["checks-pass", "review-clean", "qa-pass"]) s.ok("verdict", "T1", "--sha", old, "--kind", kind, "--pr", "5");
  s.ok("verdict", "T2", "--sha", SHA, "--kind", "checks-pass"); // the head after a repair push, recorded under the tiny task
  assert.equal(s.ok("merge-check", "--sha", SHA, "--cycles", "1"), "T2 may merge: 1 clean cycle on this SHA", "without --pr, as the hook calls it until T4");
  const todo = "To merge, make each one pass, or push a new commit and record its verdicts under the live tasks only.";
  assert.equal(s.no("merge-check", "--sha", SHA, "--cycles", "1", "--pr", "5"), `sage: 2 tasks have verdicts on a1b2c3d or belong to PR 5, and each must pass; 1 fails. ${s.dir} T1: no checks-pass on this SHA. Run the checks on it and record checks-pass. ${todo}`);
  assert.equal(s.no("merge-check", "--sha", SHA, "--pr", "6"), `sage: no task of PR 6 has verdicts on a1b2c3d: only ${s.dir} T2 has. Record PR 6's verdicts under its own task (sage verdict <T> --sha <sha> --pr 6), or set its PR: sage task <T> set pr=6.`);
  assert.equal(s.no("merge-check", "--sha", SHA, "--pr", "#5"), "sage: --pr is the pull request's number, for example --pr 5");
  for (const kind of ["checks-pass", "review-clean", "qa-pass"]) s.ok("verdict", "T1", "--sha", SHA, "--kind", kind);
  assert.equal(s.ok("merge-check", "--sha", SHA, "--cycles", "1", "--pr", "5"), `2 tasks have verdicts on a1b2c3d or belong to PR 5, and each must pass: ${s.dir} T2 may merge: 1 clean cycle on this SHA; ${s.dir} T1 may merge: 1 clean cycle on this SHA`);
});

test("F-R44-2: a refusal lists every failing task, marks an abandoned one, which still counts, and names the new-commit way out", () => {
  const s = store();
  for (const title of ["a", "b", "an old try"]) s.ok("task", "add", "--title", title, "--size", "small");
  s.ok("task", "T3", "set", "state=abandoned");
  const clean = (t, sha) => {
    for (const kind of ["checks-pass", "review-clean", "qa-pass"]) s.ok("verdict", t, "--sha", sha, "--kind", kind, "--pr", "4");
  };
  clean("T1", SHA);
  s.ok("verdict", "T2", "--sha", SHA, "--kind", "checks-pass", "--pr", "4");
  s.ok("verdict", "T3", "--sha", SHA, "--kind", "findings");
  assert.equal(s.no("merge-check", "--sha", SHA, "--cycles", "1"), `sage: 3 tasks have verdicts on a1b2c3d, and each must pass; 2 fail. ${s.dir} T2: 0 of 1 clean cycles on this SHA; never recorded: review-clean, qa-pass. Run the next cycle of its reviews on this SHA and record each verdict. ${s.dir} T3 (abandoned): cycle 1 found problems on this SHA (findings). Repair, then review the new SHA. To merge, make each one pass, or push a new commit and record its verdicts under the live tasks only.`);
  const next = "0123456789abcdef0123456789abcdef01234567"; // the new commit
  clean("T1", next);
  clean("T2", next);
  assert.equal(s.ok("merge-check", "--sha", next, "--cycles", "1", "--pr", "4"), `2 tasks have verdicts on 0123456 or belong to PR 4, and each must pass: ${s.dir} T1 may merge: 1 clean cycle on this SHA; ${s.dir} T2 may merge: 1 clean cycle on this SHA`);
});

test("F3: a ledger of blank lines blocks nothing, and a refusal names the full path at fault and what to do", () => {
  const s = store();
  s.ok("task", "add", "--title", "t", "--size", "tiny");
  s.ok("verdict", "T1", "--sha", SHA, "--kind", "checks-pass");
  const blank = join(s.home, "zz-blank");
  mkdirSync(blank);
  writeFileSync(join(blank, "ledger.tsv"), "\n\n");
  assert.equal(s.ok("merge-check", "--sha", SHA), "T1 may merge: 1 clean cycle on this SHA", "a ledger of blank lines has no verdicts");
  const planted = join(s.home, "0-plant");
  mkdirSync(planted);
  writeFileSync(join(planted, "ledger.tsv"), `task\tpr\tsha\tkind\tcycle\trun\tat\nT404\t\t${SHA}\tchecks-pass\t1\t\t\n`);
  assert.equal(s.no("merge-check", "--sha", SHA), `sage: 2 tasks have verdicts on a1b2c3d, and each must pass; 1 fails. ${planted} T404 is in ${join(planted, "ledger.tsv")} but not in its tasks.tsv: a stray or damaged logbook. If no project uses it, ask the user to remove ${planted}. To merge, make each one pass, or push a new commit and record its verdicts under the live tasks only.`);
  rmSync(planted, { recursive: true });
  const shut = join(s.home, "zz-shut", "ledger.tsv");
  mkdirSync(dirname(shut));
  writeFileSync(shut, "x");
  chmodSync(shut, 0);
  assert.equal(s.no("merge-check", "--sha", SHA), `sage: the merge gate cannot read ${shut} (EACCES), so it refuses every merge. Ask the user to fix or remove ${shut}.`);
});

test("F4: a finding opened again takes the new summary and source, and the decision trail keeps the old summary", () => {
  const s = store();
  s.ok("task", "add", "--title", "t", "--size", "small");
  s.ok("finding", "add", "T1", "--source", "code-reviewer", "--severity", "low", "--summary", "the date is off by one");
  s.ok("finding", "triage", "T1", "F-T1-1", "dismiss", "--reason", "rare");
  assert.equal(s.ok("finding", "add", "T1", "--key", "F-T1-1", "--source", "qa", "--severity", "high", "--summary", "every date is off by one day"), "F-T1-1 open again · high · T1");
  assert.deepEqual(rows(s.dir, "findings").map((f) => `${f.key} ${f.source} ${f.severity} ${f.status} ${f.summary}`), ["F-T1-1 qa high open every date is off by one day"]);
  assert.match(readFileSync(join(s.dir, "decisions.tsv"), "utf8"), /\tT1\tF-T1-1 opened again: every date is off by one day\tthe summary before: the date is off by one\n$/);
});

test("F-R44-1: a link in the sage folder is read and written through, so its values and rows stay and it stays a link", () => {
  const s = store();
  const elsewhere = mkdtempSync(join(tmpdir(), "sage-dotfiles-"));
  writeFileSync(join(elsewhere, "config.json"), JSON.stringify({ autopilot_cycles: 3, max_agents: 5 }));
  symlinkSync(join(elsewhere, "config.json"), join(s.home, "config.json"));
  assert.equal(s.ok("config"), "max_agents=5 autopilot_cycles=3 max_rounds=3 arena=3 arena_models=opus,sonnet,sonnet");
  assert.equal(s.ok("config", "max_rounds=4"), "max_agents=5 autopilot_cycles=3 max_rounds=4 arena=3 arena_models=opus,sonnet,sonnet");
  assert.deepEqual([lstatSync(join(s.home, "config.json")).isSymbolicLink(), JSON.parse(readFileSync(join(elsewhere, "config.json"), "utf8")).max_rounds], [true, 4]);

  s.ok("task", "add", "--title", "a", "--size", "small");
  s.ok("task", "add", "--title", "b", "--size", "small");
  renameSync(join(s.dir, "tasks.tsv"), join(elsewhere, "tasks.tsv"));
  symlinkSync(join(elsewhere, "tasks.tsv"), join(s.dir, "tasks.tsv"));
  assert.equal(s.ok("status").split("\n")[1], "tasks   2 · framed 2");
  assert.match(s.ok("task", "add", "--title", "c", "--size", "small"), /^T3 framed/);
  assert.deepEqual([lstatSync(join(s.dir, "tasks.tsv")).isSymbolicLink(), rows(elsewhere, "tasks").map((t) => t.id)], [true, ["T1", "T2", "T3"]]);
});

test("F-R44-3: verified counts only the task's own verdicts on the SHA, not another task's", () => {
  const s = store();
  s.ok("task", "add", "--title", "a", "--size", "small");
  s.ok("task", "add", "--title", "b", "--size", "small");
  toReviewing(s, "T1");
  s.ok("task", "T1", "set", "state=verifying");
  s.ok("verdict", "T1", "--sha", SHA, "--kind", "checks-pass");
  for (const kind of ["review-clean", "qa-pass"]) s.ok("verdict", "T2", "--sha", SHA, "--kind", kind); // T2's reviews are not T1's
  assert.match(s.no("task", "T1", "set", "state=verified"), /^sage: T1 is not verified on a1b2c3d: T1: 0 of 1 clean cycles on this SHA; never recorded: review-clean, qa-pass\./);
  for (const kind of ["review-clean", "qa-pass"]) s.ok("verdict", "T1", "--sha", SHA, "--kind", kind);
  assert.match(s.ok("task", "T1", "set", "state=verified"), /^T1 verified/);
});
