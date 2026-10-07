import "./test-env.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
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
  assert.deepEqual(api.readAdmission(dir), { config: admissionConfig, sessions: [owner], reservations: [] });
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
