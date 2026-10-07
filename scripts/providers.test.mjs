import "./test-env.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawnSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { createInterface } from "node:readline";
import { ROOT, filesUnder, outputs } from "./build.mjs";
import { createStateTool, applyPrinciples } from "../packages/sage-core/index.mjs";
import { handle, patchPaths, stateKey } from "../plugins/sage-codex/hooks/principles-hook.mjs";

const context = (output) => output?.hookSpecificOutput?.additionalContext ?? "";
const state = () => ({ given: [], failures: {} });
const source = (path) => readFileSync(join(ROOT, path), "utf8");
const json = (path) => JSON.parse(source(path));

function isolated(t, provider) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "sage-provider-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const plugin = join(dir, "plugin");
  cpSync(join(ROOT, provider === "claude" ? "plugins/sage" : "plugins/sage-codex"), plugin, { recursive: true });
  return { dir, plugin };
}

test("provider packages are complete outside the checkout, with no opposite adapter", async (t) => {
  for (const provider of ["claude", "codex"]) {
    const { dir, plugin } = isolated(t, provider);
    const paths = filesUnder(plugin);
    assert.ok(paths.some((p) => p.endsWith("core/index.mjs")));
    assert.ok(existsSync(join(plugin, "LICENSE-pstack")));
    assert.equal(existsSync(join(plugin, ".claude-plugin")), provider === "claude");
    assert.equal(existsSync(join(plugin, "agents")), provider === "claude");
    assert.equal(existsSync(join(plugin, "hooks/sage-hook.mjs")), provider === "claude");
    assert.equal(existsSync(join(plugin, "skills/sage/sage-pr.mjs")), provider === "claude");
    for (const file of paths.filter((p) => p.endsWith(".mjs"))) {
      const text = readFileSync(file, "utf8");
      assert.doesNotMatch(text, /from "sage-core"/);
      for (const [, specifier] of text.matchAll(/(?:from\s+|import\()"(\.[^"]+)"/g)) {
        const target = resolve(dirname(file), specifier);
        assert.ok(target.startsWith(`${plugin}/`), `${file}: ${specifier} escapes plugin`);
        assert.ok(existsSync(target), `${file}: missing ${specifier}`);
      }
    }
    const env = { ...process.env, SAGE_HOME: join(dir, "logbooks") };
    const run = (...args) => spawnSync(process.execPath, [join(plugin, "skills/sage/sage.mjs"), ...args, "--project", dir], { encoding: "utf8", env });
    assert.equal(run("init").status, 0);
    const task = run("task", "add", "--title", "Shared behavior", "--size", "small");
    assert.equal(task.status, 0, task.stderr);
    assert.match(run("status").stdout, /tasks\s+1 · framed 1/);
    const board = run("board", "this");
    assert.equal(board.status, 0, board.stderr);
    assert.match(board.stdout, /Shared behavior/);
    const mod = await import(pathToFileURL(join(plugin, "skills/sage/sage.mjs")).href);
    const tool = provider === "codex" ? mod.tool : mod;
    assert.match(tool.sageRoot({}), new RegExp(`\\.${provider}/sage$`));
    const config = run("config");
    assert.equal(config.status, 0, config.stderr);
    assert.match(config.stdout, provider === "codex" ? /inherit,inherit,inherit/ : /opus,sonnet,sonnet/);
  }
});

test("core instances isolate provider defaults and validation without changing process environment", (t) => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "sage-core-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const a = createStateTool({ defaultRoot: () => join(dir, "a"), models: ["a", "inherit"], modelDefaults: { arena_models: "a" } });
  const b = createStateTool({ defaultRoot: () => join(dir, "b") });
  assert.equal(a.config({}).arena_models, "a");
  assert.equal(b.config({}).arena_models, "inherit,inherit,inherit");
  assert.throws(() => b.sage(["config", "model.qa=opus"], {}), /inherit/);
  assert.equal(b.sageRoot({ SAGE_HOME: dir }), dir);
  a.sage(["config", "model.qa=a"], {});
  assert.equal(a.config({})["model.qa"], "a");
  assert.equal(b.config({})["model.qa"], undefined);
  for (const file of filesUnder(join(ROOT, "packages/sage-core"))) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /CLAUDE_|CODEX_|sage-claude|sage-codex|"(?:opus|sonnet|haiku|fable)"/);
  }
});

test("manifests point to disjoint plugin roots and only supported Codex hooks", () => {
  assert.equal(json(".claude-plugin/marketplace.json").plugins[0].source, "./plugins/sage");
  assert.equal(json(".agents/plugins/marketplace.json").plugins[0].source.path, "./plugins/sage-codex");
  const manifest = json("plugins/sage-codex/.codex-plugin/plugin.json");
  assert.equal(manifest.hooks, "./hooks/hooks.json");
  const hooks = json("plugins/sage-codex/hooks/hooks.json").hooks;
  assert.deepEqual(Object.keys(hooks), ["UserPromptSubmit", "PreToolUse"]);
  assert.match(source("plugins/sage-codex/skills/sage/SKILL.md"), /Agent orchestration and autopilot are not available/);
  assert.deepEqual([...outputs()], [...outputs()], "packaging is deterministic");
});

test("Codex patches give advice for every path and both ends of a move", () => {
  const patch = "*** Begin Patch\n*** Update File: src/a.js\n@@\n-a\n+b\n*** Update File: tests/b.test.js\n*** Move to: README.md\n@@\n-a\n+b\n*** Add File: docs/help.md\n+*** Delete File: fake.js\n*** End Patch";
  assert.deepEqual(patchPaths(patch), ["src/a.js", "tests/b.test.js", "README.md", "docs/help.md"]);
  const s = state();
  const event = { hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { command: patch } };
  const advice = context(handle(event, s));
  assert.match(advice, /Test behaviour/);
  assert.match(advice, /reader/i);
  assert.match(advice, /README/);
  assert.equal(handle(event, s), undefined, "advice is given once per session");
  assert.deepEqual(patchPaths("not a patch"), []);
});

test("Codex process hooks isolate roots, children and providers; unknown input cannot block", (t) => {
  const { dir, plugin } = isolated(t, "codex");
  const env = { ...process.env, AGENT_KIT_HOOKS_STATE: dir };
  const send = (event, extra = {}) => spawnSync(process.execPath, [join(plugin, "hooks/principles-hook.mjs")], { env: { ...env, ...extra }, input: typeof event === "string" ? event : JSON.stringify(event), encoding: "utf8" });
  const prompt = { session_id: "session", hook_event_name: "UserPromptSubmit", prompt: "Design a schema" };
  const first = send(prompt);
  assert.equal(first.status, 0, first.stderr);
  assert.match(context(JSON.parse(first.stdout)), /Exhaust the design space/);
  assert.equal(send(prompt).stdout, "");
  assert.ok(send({ ...prompt, agent_id: "child" }).stdout);
  assert.notEqual(stateKey(prompt), stateKey({ ...prompt, agent_id: "child" }));
  assert.notEqual(stateKey({ session_id: "a/b" }), stateKey({ session_id: "a_b" }));
  assert.equal(send({ ...prompt, session_id: "off" }, { AGENT_KIT_HOOKS: "off" }).stdout, "");
  for (const input of ["not json", "null", {}, { ...prompt, session_id: undefined }, { ...prompt, hook_event_name: "Stop" }, { ...prompt, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: "Exit code: 0" }]) {
    const result = send(input);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
  }
  assert.equal(existsSync(join(dir, "session.json")), false, "Claude state is not written");
});

test("unknown check outcomes cannot erase recorded failures in shared policy", (t) => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "sage-outcome-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", dir]);
  writeFileSync(join(dir, "code.js"), "one");
  const s = state();
  const input = { kind: "after-tool", cwd: dir, command: "npm test", outcome: "failure" };
  applyPrinciples(input, s, (name) => name);
  assert.ok(s.failures["npm test"]);
  applyPrinciples({ ...input, outcome: "unknown" }, s, (name) => name);
  assert.ok(s.failures["npm test"]);
  applyPrinciples({ ...input, outcome: "success" }, s, (name) => name);
  assert.equal(s.failures["npm test"], undefined);
});

test("check rejects a foreign file and build removes it from an assembled plugin", (t) => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "sage-build-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(ROOT, dir, { recursive: true, filter: (path) => ![".git", "node_modules"].includes(relative(ROOT, path)) });
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"), "dir");
  const foreign = join(dir, "plugins/sage/hooks/codex-only.mjs");
  writeFileSync(foreign, "throw new Error('foreign adapter');\n");
  const run = (name) => spawnSync(process.execPath, [join(dir, "scripts", `${name}.mjs`)], { encoding: "utf8" });
  const rejected = run("check");
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /codex-only.mjs: not in the package/);
  const built = run("build");
  assert.equal(built.status, 0, built.stderr);
  assert.equal(existsSync(foreign), false);
  const checked = run("check");
  assert.equal(checked.status, 0, checked.stderr);
});

test("a mismatched core pin fails the build before replacing plugin files", (t) => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "sage-pin-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(ROOT, dir, { recursive: true, filter: (path) => ![".git", "node_modules"].includes(relative(ROOT, path)) });
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"), "dir");
  const manifest = join(dir, "packages/sage-codex/package.json");
  const meta = JSON.parse(readFileSync(manifest, "utf8"));
  meta.dependencies["sage-core"] = "999.0.0";
  writeFileSync(manifest, JSON.stringify(meta));
  const output = join(dir, "plugins/sage-codex/core/index.mjs");
  const before = readFileSync(output, "utf8");
  const result = spawnSync(process.execPath, [join(dir, "scripts/build.mjs")], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /sage-codex must pin sage-core 0.1.0/);
  assert.equal(readFileSync(output, "utf8"), before);
});

test("check rejects a hook change made only in the generated Claude plugin", (t) => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "sage-stale-hook-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(ROOT, dir, { recursive: true, filter: (path) => ![".git", "node_modules"].includes(relative(ROOT, path)) });
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"), "dir");
  const hook = join(dir, "plugins/sage/hooks/sage-hook.mjs");
  writeFileSync(hook, `${readFileSync(hook, "utf8")}\n// A change in the old source path.\n`);
  const checked = spawnSync(process.execPath, [join(dir, "scripts/check.mjs")], { encoding: "utf8" });
  assert.equal(checked.status, 1);
  assert.match(checked.stderr, /plugins\/sage\/hooks\/sage-hook\.mjs: out of date/);
  const built = spawnSync(process.execPath, [join(dir, "scripts/build.mjs")], { encoding: "utf8" });
  assert.equal(built.status, 0, built.stderr);
  const current = spawnSync(process.execPath, [join(dir, "scripts/check.mjs")], { encoding: "utf8" });
  assert.equal(current.status, 0, current.stderr);
});

const assignmentScope = { project: "project-a", session: "root-session", epoch: "11111111-1111-4111-8111-111111111111" };
const assignmentDispatch = { task: "T1", run: "R1", issuer: "root-session", call: "spawn-1" };
const assignmentId = "22222222-2222-4222-8222-222222222222";
const assignmentCase = () => ({
  scope: { ...assignmentScope },
  assignment: { ...assignmentScope, id: assignmentId, ...assignmentDispatch },
  binding: { ...assignmentScope, assignment: assignmentId, issuer: "root-session", call: "spawn-1", child: "child-a" },
  native: { session: "root-session", child: "child-a", turn: "turn-a" },
  reference: { assignment: assignmentId, task: "T1", run: "R1" },
});
const assignmentApi = () => import("../packages/sage-core/index.mjs");

test("assignment intents use fresh IDs and retain project, epoch and dispatch identity", async () => {
  const { createAssignment } = await assignmentApi();
  const first = createAssignment(assignmentScope, assignmentDispatch);
  const second = createAssignment(assignmentScope, assignmentDispatch);
  assert.match(first.id, /^[0-9a-f]{8}-[0-9a-f-]{27}$/);
  assert.notEqual(first.id, second.id);
  assert.deepEqual({ ...first, id: assignmentId }, { ...assignmentScope, id: assignmentId, ...assignmentDispatch });
  assert.deepEqual(assignmentScope, { project: "project-a", session: "root-session", epoch: "11111111-1111-4111-8111-111111111111" });
});

test("report correlation returns only an exact nonterminal identity receipt", async () => {
  const { correlateReport } = await assignmentApi();
  const input = assignmentCase();
  const expected = { schema: 1, kind: "report-submission", ...assignmentScope, assignment: assignmentId,
    task: "T1", run: "R1", issuer: "root-session", call: "spawn-1", child: "child-a", turn: "turn-a" };
  assert.deepEqual(correlateReport(input), expected);
  assert.deepEqual(correlateReport(structuredClone(input)), expected);
  assert.deepEqual(input, assignmentCase());
});

test("equal task and run IDs cannot cross a project, session or restart epoch", async () => {
  const { correlateReport } = await assignmentApi();
  for (const [key, value] of Object.entries({ project: "project-b", session: "other-root", epoch: "33333333-3333-4333-8333-333333333333" })) {
    for (const part of ["scope", "binding"]) {
      const input = assignmentCase(); input[part][key] = value;
      assert.throws(() => correlateReport(input), /current scope/);
    }
  }
});

test("a report cannot substitute the dispatch issuer, call or native child identity", async () => {
  const { correlateReport } = await assignmentApi();
  for (const [part, key, value] of [
    ["binding", "assignment", "33333333-3333-4333-8333-333333333333"], ["binding", "issuer", "another-lead"], ["binding", "call", "spawn-2"], ["binding", "session", "another-root"],
    ["native", "session", "another-root"], ["native", "child", "another-child"],
  ]) {
    const input = assignmentCase(); input[part][key] = value;
    assert.throws(() => correlateReport(input), /binding|another child or session/);
  }
  const self = assignmentCase(); self.binding.child = self.native.child = self.binding.issuer;
  assert.throws(() => correlateReport(self), /own child/);
});

test("stale assignment, task and run references cannot claim a newer assignment", async () => {
  const { correlateReport } = await assignmentApi();
  for (const [key, value] of Object.entries({ assignment: "44444444-4444-4444-8444-444444444444", task: "T2", run: "R2" })) {
    const input = assignmentCase(); input.reference[key] = value;
    assert.throws(() => correlateReport(input), /another assignment|another task or run/);
  }
});

test("assignment boundaries reject missing, malformed and extra identity fields", async () => {
  const { createAssignment, correlateReport } = await assignmentApi();
  assert.throws(() => createAssignment({ ...assignmentScope, project: "" }, assignmentDispatch), /project/);
  assert.throws(() => createAssignment(assignmentScope, { ...assignmentDispatch, task: "T0" }), /task/);
  for (const part of ["scope", "assignment", "binding", "native", "reference"]) {
    for (const bad of [null, [], {}, { ...assignmentCase()[part], message: "private report text" }]) {
      const input = assignmentCase(); input[part] = bad;
      assert.throws(() => correlateReport(input), /Assignment:/);
    }
  }
  for (const turn of ["", "x".repeat(257), "line\nbreak", "turn\n"]) {
    const input = assignmentCase(); input.native.turn = turn;
    assert.throws(() => correlateReport(input), /turn/);
  }
});

const admissionApi = () => import("../packages/sage-core/index.mjs");
const admissionConfig = { total: 3, projects: [{ project: "one", limit: 2 }, { project: "two", limit: 2 }] };
const admissionOwner = { project: "one", session: "session-one", activation: "11111111-1111-4111-8111-111111111111" };
const admissionDispatch = { tool: "native-spawn", turn: "parent-turn", name: "worker", argumentsHash: "a".repeat(64) };
const admissionRequest = (call) => ({ task: "T1", run: "R1", issuer: "session-one", call });
const admissionScope = (owner) => ({ project: owner.project, session: owner.session, epoch: owner.epoch });
function admissionTemp(t) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "sage-admission-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
async function admissionFixture(t) {
  const api = await admissionApi(), dir = admissionTemp(t);
  api.configureAdmission(dir, admissionConfig);
  const owner = api.activateAdmission(dir, admissionOwner);
  return { api, dir, owner, scope: admissionScope(owner) };
}

test("admission initializes one immutable configuration and idempotent session ownership", async (t) => {
  const { api, dir, owner } = await admissionFixture(t);
  assert.deepEqual(api.configureAdmission(dir, { ...admissionConfig, projects: [...admissionConfig.projects].reverse() }), admissionConfig);
  const ordered = api.configureAdmission(admissionTemp(t), { total: 2, projects: [{ project: "a", limit: 1 }, { project: "B", limit: 1 }] });
  assert.deepEqual(ordered.projects.map(row => row.project), ["B", "a"]);
  assert.deepEqual(api.activateAdmission(dir, admissionOwner), owner);
  assert.match(owner.epoch, /^[0-9a-f-]{36}$/);
  assert.deepEqual(api.readAdmission(dir), { config: admissionConfig, sessions: [owner], reservations: [], modes: [{ ...admissionScope(owner), after: null, turn: owner.activation, sage: true }] });
  assert.throws(() => api.configureAdmission(dir, { ...admissionConfig, total: 4 }), /configuration differs/);
  assert.throws(() => api.activateAdmission(dir, { ...admissionOwner, activation: "22222222-2222-4222-8222-222222222222" }), /already has an owner/);
});

test("admission permits dispatch once and holds the reservation across a fresh reader", async (t) => {
  const { api, dir, scope } = await admissionFixture(t);
  const first = api.reserveAdmission(dir, scope, admissionRequest("call-1"), admissionDispatch);
  assert.equal(first.decision, "permit-once");
  assert.deepEqual(api.reserveAdmission(dir, scope, admissionRequest("call-1"), admissionDispatch), { decision: "already-reserved", assignment: first.assignment });
  assert.deepEqual(api.readAdmission(dir).reservations, [{ assignment: first.assignment, dispatch: admissionDispatch }]);
  const reader = spawnSync(process.execPath, ["--input-type=module", "-e", `import {readAdmission} from ${JSON.stringify(pathToFileURL(join(ROOT, "packages/sage-core/index.mjs")).href)}; process.stdout.write(JSON.stringify(readAdmission(process.argv[1])));`, dir], { encoding: "utf8", env: process.env });
  assert.equal(reader.status, 0, reader.stderr);
  assert.deepEqual(JSON.parse(reader.stdout).reservations, [{ assignment: first.assignment, dispatch: admissionDispatch }]);
});

test("admission refuses changed duplicate task, run, tool, turn, name or argument identity", async (t) => {
  const { api, dir, scope } = await admissionFixture(t);
  api.reserveAdmission(dir, scope, admissionRequest("call-1"), admissionDispatch);
  for (const change of [{ task: "T2" }, { run: "R2" }]) assert.throws(() => api.reserveAdmission(dir, scope, { ...admissionRequest("call-1"), ...change }, admissionDispatch), /different work/);
  for (const change of [{ tool: "other-tool" }, { turn: "other-turn" }, { name: "other-name" }, { argumentsHash: "b".repeat(64) }]) assert.throws(() => api.reserveAdmission(dir, scope, admissionRequest("call-1"), { ...admissionDispatch, ...change }), /different work/);
  assert.equal(api.readAdmission(dir).reservations.length, 1);
});

test("admission enforces both project and participating-store capacity", async (t) => {
  const { api, dir, scope } = await admissionFixture(t);
  api.reserveAdmission(dir, scope, admissionRequest("call-1"), admissionDispatch);
  api.reserveAdmission(dir, scope, admissionRequest("call-2"), admissionDispatch);
  assert.throws(() => api.reserveAdmission(dir, scope, admissionRequest("call-3"), admissionDispatch), /project capacity/);
  const other = api.activateAdmission(dir, { ...admissionOwner, project: "two", session: "session-two" });
  api.reserveAdmission(dir, admissionScope(other), { ...admissionRequest("call-3"), issuer: "session-two" }, admissionDispatch);
  assert.throws(() => api.reserveAdmission(dir, admissionScope(other), { ...admissionRequest("call-4"), issuer: "session-two" }, admissionDispatch), /total capacity/);
  assert.equal(api.readAdmission(dir).reservations.length, 3);
});

test("admission rejects absent owners, stale epochs, unknown projects and invalid limits", async (t) => {
  const { api, dir, scope } = await admissionFixture(t);
  for (const change of [{ session: "unowned" }, { epoch: "33333333-3333-4333-8333-333333333333" }, { project: "unknown" }]) assert.throws(() => api.reserveAdmission(dir, { ...scope, ...change }, admissionRequest("call-1"), admissionDispatch), /owner|project/);
  for (const total of [0, 51, 1.5, "3"]) assert.throws(() => api.configureAdmission(admissionTemp(t), { ...admissionConfig, total }), /capacity/);
  assert.throws(() => api.configureAdmission(admissionTemp(t), { total: 3, projects: [{ project: "one", limit: 1 }, { project: "one", limit: 2 }] }), /duplicate project/);
  const sparse = admissionTemp(t);
  assert.throws(() => api.configureAdmission(sparse, { total: 2, projects: new Array(1) }), /record fields/);
  const { readdirSync } = await import("node:fs");
  assert.deepEqual(readdirSync(sparse), []);
  assert.equal(api.readAdmission(dir).reservations.length, 0);
});

test("admission rejects a corrupt tail, missing revision, symbolic link and malformed record", async (t) => {
  const { symlinkSync, unlinkSync } = await import("node:fs");
  for (const damage of ["corrupt", "gap", "link", "shape"]) {
    const { api, dir, scope } = await admissionFixture(t);
    const target = join(dir, "00000001.json"), bytes = readFileSync(target, "utf8");
    if (damage === "gap") unlinkSync(join(dir, "00000000.json"));
    else if (damage === "link") { writeFileSync(join(dir, ".pending-11111111-1111-4111-8111-111111111111"), bytes); unlinkSync(target); symlinkSync(join(dir, ".pending-11111111-1111-4111-8111-111111111111"), target); }
    else writeFileSync(target, damage === "corrupt" ? bytes.replace("session-one", "session-two") : "{}\n");
    assert.throws(() => api.reserveAdmission(dir, scope, admissionRequest("call-1"), admissionDispatch));
  }
});

test("admission ignores unpublished pending bytes but never turns them into capacity", async (t) => {
  const { api, dir, scope } = await admissionFixture(t);
  writeFileSync(join(dir, ".pending-11111111-1111-4111-8111-111111111111"), "incomplete temporary record");
  const result = api.reserveAdmission(dir, scope, admissionRequest("call-1"), admissionDispatch);
  assert.equal(result.decision, "permit-once");
  assert.equal(api.readAdmission(dir).reservations.length, 1);
});

test("admission concurrent writers never grant duplicate dispatch or exceed capacity", async (t) => {
  const { spawn } = await import("node:child_process");
  const { api, dir, scope } = await admissionFixture(t);
  const module = pathToFileURL(join(ROOT, "packages/sage-core/index.mjs")).href;
  const program = `import {reserveAdmission} from ${JSON.stringify(module)}; process.send({ready:true}); process.once('message', value=>{try{process.send({result:reserveAdmission(value.dir,value.scope,value.request,value.dispatch)});}catch(error){process.send({error:error.message});}process.disconnect();});`;
  const batch = async (calls) => {
    const children = calls.map((call) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", program], { stdio: ["ignore", "pipe", "pipe", "ipc"], env: process.env });
      let result, stderr = "", stdout = "";
      child.stderr.on("data", data => { stderr += data; }); child.stdout.on("data", data => { stdout += data; });
      const ready = new Promise((resolve, reject) => { child.once("error", reject); child.once("message", value => value.ready ? resolve() : reject(Error("worker not ready"))); });
      child.on("message", value => { if (!value.ready) result = value; });
      const closed = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => { try { assert.equal(code, 0, stderr); assert.equal(signal, null); assert.equal(stderr, ""); assert.equal(stdout, ""); assert(result); resolve(result); } catch (error) { reject(error); } }); });
      return { child, call, ready, closed };
    });
    await Promise.all(children.map(c => c.ready));
    for (const c of children) c.child.send({ dir, scope, request: admissionRequest(c.call), dispatch: admissionDispatch });
    return Promise.all(children.map(c => c.closed));
  };
  const same = await batch(Array(6).fill("same-call"));
  assert.equal(same.filter(row => row.result?.decision === "permit-once").length, 1);
  assert.equal(same.filter(row => row.result?.decision === "already-reserved").length, 5);
  assert.equal(new Set(same.map(row => row.result.assignment.id)).size, 1);
  const distinct = await batch(Array.from({ length: 6 }, (_, i) => `distinct-${i}`));
  assert.equal(distinct.filter(row => row.result?.decision === "permit-once").length, 1);
  assert.equal(distinct.filter(row => /project capacity/.test(row.error)).length, 5);
  assert.equal(api.readAdmission(dir).reservations.length, 2);
});

test("admission failure after publication keeps its slot and never reissues permission", async (t) => {
  const { api, dir, scope } = await admissionFixture(t);
  const module = pathToFileURL(join(ROOT, "packages/sage-core/index.mjs")).href;
  const program = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    const link=fs.linkSync,sync=fs.fsyncSync; let linked=false,failed=false;
    fs.linkSync=(...args)=>{link(...args);linked=true;};
    fs.fsyncSync=(fd)=>{if(linked&&!failed){failed=true;throw Error('injected_sync_failure');}return sync(fd);};
    syncBuiltinESMExports(); const api=await import(${JSON.stringify(module)});
    const [dir,scope,request,dispatch]=JSON.parse(process.argv[1]); let first;
    try{first=api.reserveAdmission(dir,scope,request,dispatch);}catch(error){first={error:error.message};}
    fs.linkSync=link;fs.fsyncSync=sync;syncBuiltinESMExports();
    process.stdout.write(JSON.stringify({first,failed,retry:api.reserveAdmission(dir,scope,request,dispatch)}));`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", program, JSON.stringify([dir, scope, admissionRequest("call-1"), admissionDispatch])], { encoding: "utf8", env: process.env });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.first, { error: "injected_sync_failure" });
  assert.equal(output.failed, true);
  assert.equal(output.retry.decision, "already-reserved");
  assert.deepEqual(api.readAdmission(dir).reservations, [{ assignment: output.retry.assignment, dispatch: admissionDispatch }]);
});

test("admission rejects correctly hashed records that violate replay rules", async (t) => {
  const { createHash } = await import("node:crypto");
  for (const violation of ["duplicate", "capacity"]) {
    const { api, dir, scope } = await admissionFixture(t);
    let revision = 2, previous = JSON.parse(readFileSync(join(dir, "00000001.json"), "utf8"));
    let data = previous.data;
    if (violation === "capacity") {
      api.reserveAdmission(dir, scope, admissionRequest("call-1"), admissionDispatch);
      api.reserveAdmission(dir, scope, admissionRequest("call-2"), admissionDispatch);
      revision = 4; previous = JSON.parse(readFileSync(join(dir, "00000003.json"), "utf8"));
      data = { ...previous.data, assignment: { ...previous.data.assignment, id: "33333333-3333-4333-8333-333333333333", call: "call-3" } };
    }
    const body = { schema: 1, revision, previous: previous.hash, data };
    const record = { ...body, hash: createHash("sha256").update(JSON.stringify(body)).digest("hex") };
    writeFileSync(join(dir, `${String(revision).padStart(8, "0")}.json`), JSON.stringify(record) + "\n");
    assert.throws(() => api.readAdmission(dir), violation === "duplicate" ? /duplicate transition/ : /project capacity/);
    assert.throws(() => api.reserveAdmission(dir, scope, admissionRequest("next-call"), admissionDispatch));
  }
});

test("a missing shared file policy still refuses active chief edits without disabling the hook", async (t) => {
  const { dir, plugin } = isolated(t, "claude");
  rmSync(join(plugin, "hooks/file-policy.mjs"), { force: true });
  const { handle: check } = await import(pathToFileURL(join(plugin, "hooks/sage-hook.mjs")).href);
  const input = { hook_event_name: "PreToolUse", tool_name: "Edit", session_id: "fixture", cwd: dir, tool_input: { file_path: join(dir, "sample.txt") } };
  const result = check(input, { sage: true }, {});
  assert.equal(result.hookSpecificOutput.permissionDecision, "deny");
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /file policy cannot load/);
  assert.equal(check(input, { sage: false }, {}), undefined);
});

const filePolicyApi = () => import("../plugins/sage-codex/runtime/file-policy.mjs");

test("the Codex direct edit gate denies the active chief but leaves child and inactive checks available", async () => {
  const { directEditDecision } = await filePolicyApi();
  const patch = { tool_name: "apply_patch", tool_input: { input: "*** Begin Patch\n*** Add File: sample.txt\n+sample\n*** End Patch" } };
  assert.equal(directEditDecision(patch, { sage: true, chief: true }).decision, "deny");
  assert.deepEqual(directEditDecision(patch, { sage: true, chief: false }), { decision: "pass" });
  assert.deepEqual(directEditDecision(patch, { sage: false, chief: true }), { decision: "pass" });
  assert.deepEqual(directEditDecision({ tool_name: "collaborationlist_agents" }, { sage: true, chief: true }), { decision: "pass" });
});

test("the Codex direct edit gate refuses unverified mode or chief context", async () => {
  const { directEditDecision } = await filePolicyApi();
  for (const context of [undefined, null, {}, { sage: true }, { chief: true }, { sage: "on", chief: true }]) {
    assert.throws(() => directEditDecision({ tool_name: "apply_patch" }, context));
  }
});


test("shared mode signals preserve owner phrases and conservative autopilot off", async () => {
  const { modeSignals } = await import("../packages/sage-core/index.mjs");
  const prompt = (text, owner = true) => ({ owner, text, outside: text, all: text });
  assert.deepEqual(modeSignals(prompt("sage mode")), { sageOff: false, sageOn: true, autopilotOff: false, autopilotOn: false, modeWord: true });
  assert.equal(modeSignals(prompt("sage mode continue on the project")).sageOn, true);
  assert.equal(modeSignals(prompt("sage mode off")).sageOff, true);
  assert.equal(modeSignals(prompt("sage mode off")).autopilotOff, true);
  assert.equal(modeSignals(prompt("sage mode, autopilot on")).autopilotOn, true);
  for (const text of ["What does sage mode do?", "sage mode?", "sage mode online: is it a thing?", "autopilot on main"]) {
    const result = modeSignals(prompt(text));
    assert.equal(result.sageOn, false); assert.equal(result.autopilotOn, false);
  }
  for (const text of ["sage mode", "sage mode off", "autopilot on"]) {
    const result = modeSignals(prompt(text, false));
    assert.equal(result.sageOn, false); assert.equal(result.sageOff, false); assert.equal(result.autopilotOn, false);
  }
  assert.equal(modeSignals(prompt("Please stop autopilot", false)).autopilotOff, true);
  assert.equal(modeSignals({ owner: true, text: "sage mode", outside: "sage mode", all: "sage mode\nautopilot off" }).autopilotOff, true);
});

test("shared mode signals reject unclassified or malformed prompt input", async () => {
  const { modeSignals } = await import("../packages/sage-core/index.mjs");
  assert.equal(modeSignals({ owner: true, text: "sage mode", outside: "sage mode", all: "sage mode" }).sageOn, true);
  for (const input of [null, {}, { owner: "user", text: "sage mode", outside: "", all: "" },
    { owner: true, text: "sage mode", all: "" }, { owner: false, text: null, outside: "", all: "" }]) {
    assert.throws(() => modeSignals(input));
  }
});

test("missing shared mode policy cannot enable mode or retain autopilot", async (t) => {
  const { dir, plugin } = isolated(t, "claude");
  rmSync(join(plugin, "hooks/mode-policy.mjs"), { force: true });
  const { handle: check } = await import(pathToFileURL(join(plugin, "hooks/sage-hook.mjs")).href);
  for (const sage of [false, true]) {
    const state = { sage, autopilot: true };
    const result = check({ hook_event_name: "UserPromptSubmit", session_id: "fixture", cwd: dir, prompt: "sage mode" }, state, {});
    assert.equal(state.sage, sage); assert.equal(state.autopilot, false);
    assert.match(JSON.stringify(result), /mode policy cannot load/);
  }
});


const modeTurn = "22222222-2222-4222-8222-222222222222";
const modeNextTurn = "33333333-3333-4333-8333-333333333333";

test("admission mode persists off and on without releasing held work", async (t) => {
  const { api, dir, scope, owner } = await admissionFixture(t);
  api.reserveAdmission(dir, scope, admissionRequest("held-call"), admissionDispatch);
  const off = api.changeAdmissionMode(dir, { ...scope, after: owner.activation, turn: modeTurn, sage: false });
  assert.equal(off.decision, "changed"); assert.equal(off.mode.sage, false);
  assert.deepEqual(api.activateAdmission(dir, admissionOwner), owner);
  assert.equal(api.readAdmission(dir).modes.at(-1).sage, false);
  assert.equal(api.readAdmission(dir).reservations.length, 1);
  assert.equal(api.reserveAdmission(dir, scope, admissionRequest("held-call"), admissionDispatch).decision, "already-reserved");
  assert.throws(() => api.reserveAdmission(dir, scope, admissionRequest("off-call"), admissionDispatch), /mode is off/);
  const on = api.changeAdmissionMode(dir, { ...scope, after: modeTurn, turn: modeNextTurn, sage: true });
  assert.equal(on.mode.sage, true);
  assert.equal(api.reserveAdmission(dir, scope, admissionRequest("next-call"), admissionDispatch).decision, "permit-once");
  assert.equal(api.readAdmission(dir).reservations.length, 2);
});

test("admission mode retries cannot replay an old on over a later off", async (t) => {
  const { api, dir, scope, owner } = await admissionFixture(t);
  const request = { ...scope, after: owner.activation, turn: modeTurn, sage: true };
  api.changeAdmissionMode(dir, request);
  const off = api.changeAdmissionMode(dir, { ...scope, after: modeTurn, turn: modeNextTurn, sage: false });
  const retry = api.changeAdmissionMode(dir, request);
  assert.deepEqual(retry, { decision: "already-recorded", mode: off.mode });
  assert.equal(api.readAdmission(dir).modes.length, 3);
  assert.throws(() => api.changeAdmissionMode(dir, { ...request, sage: false }), /different mode request/);
  assert.throws(() => api.changeAdmissionMode(dir, { ...request, turn: "44444444-4444-4444-8444-444444444444" }), /mode changed/);
});

test("admission mode refuses missing owners, stale epochs and invalid mode fields", async (t) => {
  const { api, dir, scope, owner } = await admissionFixture(t);
  const request = { ...scope, after: owner.activation, turn: modeTurn, sage: false };
  assert.equal(typeof api.changeAdmissionMode, "function");
  for (const change of [{ session: "absent" }, { epoch: modeNextTurn }, { project: "absent" },
    { sage: "off" }, { sage: null }, { turn: "bad" }, { after: "bad" }, { extra: true }]) {
    assert.throws(() => api.changeAdmissionMode(dir, { ...request, ...change }));
  }
  assert.equal(api.readAdmission(dir).modes.length, 1);
});


test("admission mode concurrent changes require the same unchanged prior turn", async (t) => {
  const { spawn } = await import("node:child_process");
  const { api, dir, scope, owner } = await admissionFixture(t);
  const module = pathToFileURL(join(ROOT, "packages/sage-core/index.mjs")).href;
  const program = `import {changeAdmissionMode} from ${JSON.stringify(module)}; process.send({ready:true}); process.once('message', value=>{try{process.send({result:changeAdmissionMode(value.dir,value.request)});}catch(error){process.send({error:error.message});}process.disconnect();});`;
  const children = [modeTurn, modeNextTurn].map((turn, index) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", program], { stdio: ["ignore", "pipe", "pipe", "ipc"], env: process.env });
    let result, stderr = "", stdout = "";
    child.stderr.on("data", data => { stderr += data; }); child.stdout.on("data", data => { stdout += data; });
    const ready = new Promise((resolve, reject) => { child.once("error", reject); child.once("message", value => value.ready ? resolve() : reject(Error("worker not ready"))); });
    child.on("message", value => { if (!value.ready) result = value; });
    const closed = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => {
      try { assert.equal(code, 0, stderr); assert.equal(signal, null); assert.equal(stderr, ""); assert.equal(stdout, ""); assert(result); resolve(result); }
      catch (error) { reject(error); }
    }); });
    return { child, ready, closed, request: { ...scope, after: owner.activation, turn, sage: index === 0 } };
  });
  await Promise.all(children.map(c => c.ready));
  for (const c of children) c.child.send({ dir, request: c.request });
  const results = await Promise.all(children.map(c => c.closed));
  assert.equal(results.filter(r => r.result?.decision === "changed").length, 1);
  assert.equal(results.filter(r => /mode changed/.test(r.error)).length, 1);
  assert.deepEqual(api.readAdmission(dir).modes.at(-1), results.find(r => r.result).result.mode);
  assert.equal(api.readAdmission(dir).modes.length, 2);
});


async function nativeModeFixture(t) {
  const { dir, plugin } = isolated(t, "codex");
  const api = await import(pathToFileURL(join(plugin, "runtime/mode.mjs")).href);
  const core = await import(pathToFileURL(join(plugin, "core/index.mjs")).href);
  const directory = join(dir, "admission"), projectDirectory = join(dir, "workspace"), sessionsDir = join(dir, "sessions");
  mkdirSync(projectDirectory); mkdirSync(sessionsDir);
  core.configureAdmission(directory, { total: 3, projects: [{ project: "one", limit: 3 }, { project: "two", limit: 3 }] });
  const session = "11111111-1111-4111-8111-111111111111";
  const transcript = join(sessionsDir, "root.jsonl");
  writeFileSync(transcript, JSON.stringify({ type: "session_meta", payload: { id: session, session_id: session, cli_version: "0.160.0" } }) + "\n");
  const input = { hook_event_name: "UserPromptSubmit", session_id: session, turn_id: modeTurn, cwd: projectDirectory,
    transcript_path: transcript, model: "fixture", permission_mode: "default", prompt: "sage mode" };
  return { api, core, input, context: { version: "0.160.0", actor: session },
    options: { directory, project: "one", projectDirectory, sessionsDir } };
}

test("Codex mode adapter persists verified phrases and keeps autopilot disabled", async (t) => {
  const { api, core, input, context, options } = await nativeModeFixture(t);
  assert.equal(api.updateOwnerMode({ ...input, prompt: "What does sage mode do?" }, context, options).sage, false);
  assert.equal(core.readAdmission(options.directory).sessions.length, 0);
  const active = api.updateOwnerMode({ ...input, prompt: "sage mode, autopilot on" }, context, options);
  assert.equal(active.sage, true); assert.equal(active.autopilot, false); assert.equal(active.signals.autopilotOn, true);
  assert.equal(api.updateOwnerMode({ ...input, turn_id: modeNextTurn, prompt: "continue" }, context, options).sage, true);
  assert.equal(api.updateOwnerMode({ ...input, turn_id: "44444444-4444-4444-8444-444444444444", prompt: "sage mode off" }, context, options).sage, false);
  assert.equal(api.readMode(options.directory, options.project, input.session_id).sage, false);
  assert.equal(core.readAdmission(options.directory).modes.length, 2);
});

test("Codex mode adapter never replays old activation or mode prompts over off", async (t) => {
  const { api, input, context, options } = await nativeModeFixture(t);
  api.updateOwnerMode(input, context, options);
  const on = { ...input, turn_id: modeNextTurn };
  api.updateOwnerMode(on, context, options);
  api.updateOwnerMode({ ...input, turn_id: "44444444-4444-4444-8444-444444444444", prompt: "sage mode off" }, context, options);
  assert.equal(api.updateOwnerMode(input, context, options).sage, false);
  assert.equal(api.updateOwnerMode(on, context, options).sage, false);
  assert.throws(() => api.updateOwnerMode({ ...input, prompt: "sage mode off" }, context, options), /different mode request/);
  assert.throws(() => api.updateOwnerMode({ ...on, prompt: "sage mode off" }, context, options), /different mode request/);
  assert.equal(api.readMode(options.directory, options.project, input.session_id).modes.length, 3);
});

test("Codex mode adapter requires exact project and native owner identity before writes", async (t) => {
  const { api, core, input, context, options } = await nativeModeFixture(t);
  for (const native of [null, { ...context, actor: modeTurn }, { ...context, version: "0.160.1" }]) {
    assert.equal(api.updateOwnerMode(input, native, options), null);
  }
  assert.equal(api.updateOwnerMode({ ...input, cwd: options.sessionsDir }, context, options), null);
  assert.equal(api.updateOwnerMode({ ...input, agent_id: input.session_id }, context, options), null);
  assert.equal(core.readAdmission(options.directory).sessions.length, 0);
  api.updateOwnerMode(input, context, options);
  assert.equal(core.readAdmission(options.directory).sessions[0].session, `codex:${input.session_id}`);
  assert.equal(api.readMode(options.directory, "two", input.session_id).sage, false);
  assert.throws(() => api.readMode(options.directory, "absent", input.session_id), /not configured/);
});

test("Codex mode adapter refuses damaged storage and foreign metadata", async (t) => {
  const { api, core, input, context, options } = await nativeModeFixture(t);
  writeFileSync(input.transcript_path, JSON.stringify({ type: "session_meta", payload: { id: modeNextTurn, session_id: modeNextTurn, cli_version: "0.160.0" } }) + "\n");
  assert.equal(api.updateOwnerMode(input, context, options), null);
  assert.equal(core.readAdmission(options.directory).sessions.length, 0);
  assert.throws(() => api.updateOwnerMode({ ...input, transcript_path: join(options.projectDirectory, "outside.jsonl") }, context, options));
  writeFileSync(join(options.directory, "00000000.json"), "broken");
  assert.throws(() => api.readMode(options.directory, options.project, input.session_id));
});


test("Codex mode adapter records an initial off so its retry cannot replace later on", async (t) => {
  const { api, core, input, context, options } = await nativeModeFixture(t);
  const off = { ...input, prompt: "sage mode off" };
  assert.equal(api.updateOwnerMode(off, context, options).sage, false);
  assert.equal(core.readAdmission(options.directory).modes.length, 1);
  const owner = core.readAdmission(options.directory).sessions[0];
  const initial = { project: owner.project, session: owner.session, activation: owner.activation };
  assert.throws(() => core.activateAdmission(options.directory, initial), /different initial mode/);
  assert.throws(() => core.activateAdmission(options.directory, initial, { sage: "off" }), /invalid initial mode/);
  assert.equal(api.updateOwnerMode({ ...input, turn_id: modeNextTurn }, context, options).sage, true);
  assert.equal(api.updateOwnerMode(off, context, options).sage, true);
  assert.equal(core.readAdmission(options.directory).modes.length, 2);
  assert.throws(() => api.updateOwnerMode(input, context, options), /different mode request/);
});


test("admission retains the original on meaning of earlier activation records", async (t) => {
  const { createHash } = await import("node:crypto");
  const { api, dir, owner, scope } = await admissionFixture(t);
  const path = join(dir, "00000001.json");
  const record = JSON.parse(readFileSync(path, "utf8"));
  delete record.data.sage;
  const { hash, ...body } = record;
  writeFileSync(path, JSON.stringify({ ...body, hash: createHash("sha256").update(JSON.stringify(body)).digest("hex") }) + "\n");
  assert.equal(api.readAdmission(dir).modes.at(-1).sage, true);
  assert.deepEqual(api.activateAdmission(dir, admissionOwner), owner);
  api.changeAdmissionMode(dir, { ...scope, after: owner.activation, turn: modeTurn, sage: false });
  assert.equal(api.readAdmission(dir).modes.at(-1).sage, false);
});


test("Codex bundles the MCP SDK with native identity and hidden tool metadata intact", async (t) => {
  const { dir, plugin } = isolated(t, "codex");
  assert.ok(existsSync(join(plugin, "runtime/mcp-sdk.mjs")));
  assert.equal(existsSync(join(dir, "node_modules")), false);
  const entry = join(dir, "server.mjs");
  writeFileSync(entry, `
    import { McpServer, serveStdio, z } from './plugin/runtime/mcp-sdk.mjs';
    serveStdio(() => {
      const server = new McpServer({ name: 'sage-test', version: '0.1.0' });
      server.registerTool('sage_native_hook', {
        inputSchema: z.object({}).passthrough(), _meta: { ui: { visibility: ['app'] } },
      }, async (input, context) => ({ content: [{ type: 'text', text: JSON.stringify({
        version: server.server.getClientVersion()?.version,
        actor: context.mcpReq._meta?.threadId, input,
      }) }] }));
      return server;
    });
  `);
  const child = spawn(process.execPath, [entry], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
  t.after(() => child.stdin.end());
  let stderr = '', sequence = 0;
  const pending = new Map();
  const closed = new Promise(resolve => child.once('close', (code, signal) => {
    for (const { reject } of pending.values()) reject(Error('MCP server closed before its response'));
    resolve({ code, signal });
  }));
  child.stderr.on('data', chunk => { stderr += chunk; });
  createInterface({ input: child.stdout }).on('line', line => {
    try {
      const message = JSON.parse(line);
      pending.get(message.id)?.resolve(message);
      pending.delete(message.id);
    } catch (error) {
      for (const { reject } of pending.values()) reject(error);
      child.stdin.end();
    }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const init = await request('initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codex', version: '0.160.0' },
  });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const listed = await request('tools/list', {});
  assert.equal(listed.result.tools.length, 1);
  assert.deepEqual(listed.result.tools[0]._meta.ui.visibility, ['app']);
  const actor = 'd72422c7-509c-43aa-8c42-827c556f8a57';
  const input = { hook_event_name: 'PreToolUse', extra: { retained: true }, actor: 'forged', version: 'forged' };
  const called = await request('tools/call', { name: 'sage_native_hook', arguments: input, _meta: { threadId: actor } });
  assert.deepEqual(JSON.parse(called.result.content[0].text), { version: '0.160.0', actor, input });
  const absent = await request('tools/call', { name: 'sage_native_hook', arguments: input });
  assert.equal(Object.hasOwn(JSON.parse(absent.result.content[0].text), 'actor'), false);
  child.stdin.end();
  assert.deepEqual(await closed, { code: 0, signal: null });
  assert.equal(stderr, '');
});

test("Codex includes each bundled MCP dependency license", (t) => {
  const { plugin } = isolated(t, "codex");
  for (const name of ['@modelcontextprotocol-server', '@modelcontextprotocol-core', 'zod',
    'ajv', 'ajv-formats', 'fast-deep-equal', 'fast-uri', 'json-schema-traverse', 'content-type']) {
    const text = readFileSync(join(plugin, 'licenses', name + '.txt'), 'utf8');
    assert.match(text, name.startsWith('@modelcontextprotocol') ? /Apache License/ : /MIT|Permission is hereby granted/);
    assert.match(text, /[Cc]opyright/);
  }
});


async function roleAdmissionFixture(t, limits = { total: 50, projects: [{ project: "project-a", limit: 50 }, { project: "project-b", limit: 50 }] }) {
  const { dir, plugin } = isolated(t, "codex");
  const url = pathToFileURL(join(plugin, "core/index.mjs")).href;
  const api = await import(url);
  assert.equal(typeof api.reserveRoleAdmission, "function");
  const journal = join(dir, "admission");
  api.configureAdmission(journal, limits);
  const activation = "a72422c7-509c-43aa-8c42-827c556f8a57";
  const owner = api.activateAdmission(journal, { project: "project-a", session: "root", activation });
  const scope = { project: owner.project, session: owner.session, epoch: owner.epoch };
  const args = (index, issuer = "root", current = scope) => [journal, current,
    { task: "T1", run: `R${index}`, issuer, call: `spawn-${index}` },
    { tool: "spawn", turn: activation, name: `agent-${index}`, argumentsHash: "a".repeat(64) }];
  const reserve = (index, role = "lead", issuerRole = "chief-of-staff", issuer = "root", current = scope) =>
    api.reserveRoleAdmission(...args(index, issuer, current), { issuerRole, role });
  return { api, url, journal, scope, activation, args, reserve };
}

test("role admission preserves chief specialist workflows and records the role plan", async t => {
  const f = await roleAdmissionFixture(t);
  const roles = ["lead", "pe", "designer", "arena-judge", "implementer", "code-reviewer", "security-reviewer", "ux-reviewer", "qa"];
  roles.forEach((role, index) => assert.equal(f.reserve(index + 1, role).decision, "permit-once"));
  assert.deepEqual(f.api.readAdmission(f.journal).reservations.map(row => row.rolePlan), roles.map(role => ({ issuerRole: "chief-of-staff", role })));
});

test("role admission refuses a third layer, a lead outside its team, and a child chief", async t => {
  const f = await roleAdmissionFixture(t);
  for (const issuerRole of ["pe", "designer", "arena-judge", "implementer", "code-reviewer", "security-reviewer", "ux-reviewer", "qa"]) {
    assert.throws(() => f.reserve(1, "qa", issuerRole, "specialist"), /specialist cannot start/);
  }
  for (const role of ["lead", "pe", "designer", "arena-judge"]) assert.throws(() => f.reserve(1, role, "lead", "lead-1"), /only its permitted team/);
  assert.throws(() => f.reserve(1, "chief-of-staff"), /owner session/);
  for (const role of [undefined, "unknown", "sage:qa", 7]) assert.throws(() => f.api.reserveRoleAdmission(...f.args(1), { issuerRole: "lead", role }), /Invalid role plan/);
  assert.deepEqual(f.api.readAdmission(f.journal).reservations, []);
});

test("role admission enforces three leads across project sessions and retains other project capacity", async t => {
  const f = await roleAdmissionFixture(t);
  for (let i = 1; i <= 3; i++) f.reserve(i);
  const other = f.api.activateAdmission(f.journal, { project: "project-a", session: "other-root", activation: f.activation });
  assert.throws(() => f.reserve(4, "lead", "chief-of-staff", "other-root", { project: other.project, session: other.session, epoch: other.epoch }), /three lead slots/);
  const b = f.api.activateAdmission(f.journal, { project: "project-b", session: "root-b", activation: f.activation });
  assert.equal(f.reserve(5, "lead", "chief-of-staff", "root-b", { project: b.project, session: b.session, epoch: b.epoch }).decision, "permit-once");
  assert.equal(f.api.readAdmission(f.journal).reservations.length, 4);
});

test("role admission counts each lead's children separately and keeps the lower capacity limit", async t => {
  const f = await roleAdmissionFixture(t);
  for (let i = 1; i <= 3; i++) f.reserve(i, ["implementer", "code-reviewer", "qa"][i - 1], "lead", "lead-1");
  assert.throws(() => f.reserve(4, "qa", "lead", "lead-1"), /three child slots/);
  assert.equal(f.reserve(5, "security-reviewer", "lead", "lead-2").decision, "permit-once");
  assert.equal(f.reserve(6, "ux-reviewer", "lead", "lead-2").decision, "permit-once");
  const small = await roleAdmissionFixture(t, { total: 50, projects: [{ project: "project-a", limit: 1 }] });
  small.reserve(1);
  assert.throws(() => small.reserve(2), /project capacity/);
  const total = await roleAdmissionFixture(t, { total: 1, projects: [{ project: "project-a", limit: 50 }] });
  total.reserve(1);
  assert.throws(() => total.reserve(2, "qa", "lead", "lead-1"), /total capacity/);
});

test("role admission conservatively counts legacy roles and never changes a retry's role plan", async t => {
  const f = await roleAdmissionFixture(t);
  for (let i = 1; i <= 3; i++) f.api.reserveAdmission(...f.args(i));
  assert.throws(() => f.reserve(4), /three lead slots/);
  assert.throws(() => f.reserve(1), /different work/);
  const known = await roleAdmissionFixture(t);
  for (let i = 1; i <= 3; i++) known.reserve(i, "qa");
  assert.equal(known.reserve(4).decision, "permit-once", "known specialists do not take lead slots");
  const first = known.reserve(5, "qa", "lead", "lead-1");
  assert.equal(known.reserve(5, "qa", "lead", "lead-1").decision, "already-reserved");
  assert.throws(() => known.reserve(5, "implementer", "lead", "lead-1"), /different work/);
  assert.throws(() => known.api.reserveAdmission(...known.args(5, "lead-1")), /different work/);
  known.api.changeAdmissionMode(known.journal, { ...known.scope, after: known.activation, turn: "b72422c7-509c-43aa-8c42-827c556f8a57", sage: false });
  assert.equal(known.reserve(5, "qa", "lead", "lead-1").assignment.id, first.assignment.id);
  assert.throws(() => known.reserve(6), /mode is off/);
  assert.equal(known.api.readAdmission(known.journal).reservations.length, 5);
});

test("role admission grants only one remaining lead slot to concurrent callers", async t => {
  const f = await roleAdmissionFixture(t);
  f.reserve(1); f.reserve(2);
  const script = `
    const input = JSON.parse(process.argv[1]);
    const api = await import(input.url);
    try { console.log(JSON.stringify({ decision: api.reserveRoleAdmission(...input.args, { issuerRole: 'chief-of-staff', role: 'lead' }).decision })); }
    catch (error) { console.log(JSON.stringify({ refused: error.message })); }
  `;
  const run = index => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, JSON.stringify({ url: f.url, args: f.args(index) })], { shell: false });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", code => {
      try { assert.equal(code, 0, stderr); assert.equal(stderr, ""); resolve(JSON.parse(stdout)); }
      catch (error) { reject(error); }
    });
    child.stdin.end();
  });
  const results = await Promise.all([run(3), run(4)]);
  assert.equal(results.filter(row => row.decision === "permit-once").length, 1);
  assert.equal(results.filter(row => /three lead slots/.test(row.refused)).length, 1);
  assert.equal(f.api.readAdmission(f.journal).reservations.length, 3);
});
