import "./test-env.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  const dir = mkdtempSync(join(tmpdir(), "sage-provider-"));
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
  const dir = mkdtempSync(join(tmpdir(), "sage-core-"));
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
  const dir = mkdtempSync(join(tmpdir(), "sage-outcome-"));
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
  const dir = mkdtempSync(join(tmpdir(), "sage-build-"));
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
  const dir = mkdtempSync(join(tmpdir(), "sage-pin-"));
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
