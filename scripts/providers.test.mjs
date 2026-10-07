import "./test-env.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawnSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

test("shared command extraction parses executable text in both isolated bundles", async t => {
  for (const provider of ["claude", "codex"]) {
    const f = isolated(t, provider);
    const api = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
    assert.equal(typeof api.shellCommands, "function");
    assert.equal(typeof api.programsRun, "function");
    const command = "echo fixture | sh";
    const parsed = api.shellCommands(command);
    assert.deepEqual(parsed.map(c => c.words), [["echo", "fixture"], ["sh"]]);
    assert.equal(parsed[0].pipeTo, parsed[1]);
    const runs = api.programsRun(command, f.dir, "");
    assert.deepEqual(runs.map(({ word, stdin, piped }) => ({ word, stdin, piped })), [
      { word: "echo", stdin: [], piped: false }, { word: "sh", stdin: ["echo fixture"], piped: true },
    ]);
    assert.throws(() => api.shellCommands("echo 'open"), /open quote/);
    if (provider === "claude") {
      const hook = await import(pathToFileURL(join(f.plugin, "hooks/sage-hook.mjs")));
      assert.deepEqual(hook.shellCommands(command), parsed);
      assert.deepEqual(hook.programsRun(command, f.dir, ""), runs);
    }
  }
});

test("shared command extraction preserves T199 and harmless arguments in both isolated bundles", async t => {
  for (const provider of ["claude", "codex"]) {
    const f = isolated(t, provider);
    const api = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
    assert.equal(typeof api.createCommandPolicy, "function");
    const tool = join(f.plugin, "skills/sage/sage.mjs");
    const policy = api.createCommandPolicy({ stateToolPath: tool });
    for (const command of ["g{h,h} pr view 1", "git pu{s,s}h origin topic", "gh pr {m,m}erge 1",
      "printf 'gh pr {m,m}erge 1' | cat | sh"]) {
      assert.match(policy.expansionProblem(command, f.dir), /shell expansion can hide the command/);
    }
    for (const command of ["echo '{sample}'", "git add '*.mjs'", "gh pr view 1", "[ -f '*.txt' ]", "[[ -f '*.txt' ]]"]) {
      assert.equal(policy.expansionProblem(command, f.dir), undefined, command);
    }
    const rows = policy.runnable(api.shellCommands(`node '${tool}' log --why 'gh pr merge'; git push origin topic`));
    assert.deepEqual(rows.map(r => r.words), [["node", tool], ["git", "push", "origin", "topic"]]);
  }
});

test("shared merge and push extraction classifies merges in both isolated bundles", async t => {
  const sha = "a".repeat(40);
  for (const provider of ["claude", "codex"]) {
    const f = isolated(t, provider);
    const api = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
    const tool = join(f.plugin, "skills/sage/sage.mjs");
    const policy = api.createCommandPolicy({ stateToolPath: tool });
    const candidate = `gh pr merge 12 --squash --delete-branch --match-head-commit ${sha}`;
    assert.deepEqual(policy.mergeIn(candidate), { pr: "12", sha });
    for (const text of [candidate.replace(" 12 ", " 012 "), candidate.replace(sha, "abc"), `${candidate} --admin`,
      `sh -c '${candidate}'`, `echo '${candidate}' | sh`, `echo '${candidate}' > run; sh run`,
      "gh api repos/o/r/pulls/12/merge", "gh pr 'merge", "$(echo gh) pr merge 12"]) {
      assert.equal(typeof policy.mergeIn(text)?.problem, "string", text);
    }
    for (const text of ["git status", "git merge topic", `echo '${candidate}'`, `echo '${candidate}' | head -1`,
      `node '${tool}' log --why '${candidate}'`]) assert.equal(policy.mergeIn(text), undefined, text);
    assert.match(policy.mergeIn(`node '/other/sage.mjs' log --why '${candidate}'`).problem, /cannot prove/);
    assert.equal(api.mentionsMerge("gh api graphql -f query=mergePullRequest"), true);
    assert.equal(api.mentionsMerge("git merge topic"), false);
    assert.equal(api.PR.test("12"), true);
    assert.equal(api.PR.test("012"), false);
    if (provider === "claude") {
      const adapter = await import(pathToFileURL(join(f.plugin, "hooks/command-policy.mjs")));
      assert.deepEqual(adapter.createCommandPolicy({ stateToolPath: tool }).mergeIn(candidate), { pr: "12", sha });
      const hook = await import(pathToFileURL(join(f.plugin, "hooks/sage-hook.mjs")));
      assert.deepEqual(hook.mergeIn(candidate), { pr: "12", sha });
    }
  }
});

test("shared merge and push extraction applies push rules and injected branch evidence in both isolated bundles", async t => {
  for (const provider of ["claude", "codex"]) {
    const f = isolated(t, provider);
    const api = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
    const tool = join(f.plugin, "skills/sage/sage.mjs");
    const policy = api.createPushPolicy({ stateToolPath: tool, readBranch: dir => dir === join(f.dir, "project/nested") ? "main" : "topic" });
    for (const text of ["git push origin topic", "git push -u --follow-tags origin topic", "git push --delete origin topic",
      "echo 'git push origin main'", "git status", `node '${tool}' log --why 'git push origin main'`]) {
      assert.equal(policy.pushProblem(text, f.dir), undefined, text);
    }
    for (const text of ["git push origin main", "git push origin refs/heads/master", "git push origin topic:main",
      "git push -f origin topic", "git push --force-with-lease origin topic", "git push --forc origin topic",
      "git push --mirror origin", "git push origin HEAD", "git push origin", "git push upstream topic",
      "git push origin '$BRANCH'", "sudo git push origin topic", "sh -c 'git push origin topic'",
      "echo 'git push origin main' | sh", "git push 'origin", "gh api repos/o/r/git/refs -f ref=refs/heads/main",
      "node /other/sage.mjs log --why 'git push origin main'"]) {
      assert.equal(typeof policy.pushProblem(text, f.dir), "string", text);
    }
    assert.match(policy.pushProblem("cd project; git -C nested push origin topic", f.dir), /checkout is on main/);
    assert.equal(policy.pushProblem("cd project; git -C nested push --delete origin topic", f.dir), undefined);
    assert.match(api.createPushPolicy({ readBranch: () => "topic", mainReason: "Use a reviewed pull request." }).pushProblem("git push origin main", f.dir), /^Use a reviewed pull request\./);
    assert.equal(api.createPushPolicy({ readBranch: () => undefined }).pushProblem("git push origin topic", f.dir), undefined);
    if (provider === "claude") {
      const adapter = await import(pathToFileURL(join(f.plugin, "hooks/command-policy.mjs")));
      assert.match(adapter.createPushPolicy({ readBranch: () => "main" }).pushProblem("git push origin topic", f.dir), /checkout is on main/);
    }
  }
});

test("shared merge and push extraction keeps transitive module failures closed and broken-state merge diagnostics", async t => {
  for (const missing of ["core/push-policy.mjs", "core/pull-request.mjs"]) {
    const f = isolated(t, "claude");
    rmSync(join(f.plugin, missing), { force: true });
    const hook = await import(pathToFileURL(join(f.plugin, "hooks/sage-hook.mjs")));
    for (const sage of [false, true]) for (const tool_name of ["Bash", "Monitor", "PowerShell", "mcp__terminal__run"]) {
      for (const actor of [{}, { agent_id: "fixture-child" }]) {
        const output = hook.handle({ hook_event_name: "PreToolUse", tool_name,
          tool_input: { command: "gh api repos/o/r/git/refs -f ref=refs/heads/main" }, ...actor }, { sage }, {});
        assert.equal(output?.hookSpecificOutput?.permissionDecision, "deny", `${missing}: ${tool_name}`);
        assert.match(output.hookSpecificOutput.permissionDecisionReason, /command modules could not load/);
      }
    }
  }
  const f = isolated(t, "claude");
  writeFileSync(join(f.plugin, "skills/sage/sage.mjs"), 'throw new Error("fixture broken state tool");\n');
  const hook = await import(pathToFileURL(join(f.plugin, "hooks/sage-hook.mjs")));
  const sha = "a".repeat(40);
  const candidate = `gh pr merge 012 --squash --delete-branch --match-head-commit ${sha}`;
  assert.deepEqual(hook.mergeIn(candidate), { pr: "012", sha }, "a broken state tool preserves the old diagnostic order");
  const output = hook.handle({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: candidate } }, { sage: true, autopilot: true }, {});
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /the merge check refuses: it could not run \(fixture broken state tool\)/);
});

test("shared file and mode extraction applies the chief edit rule in both isolated bundles", async t => {
  for (const provider of ["claude", "codex"]) {
    const f = isolated(t, provider);
    const api = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
    assert.equal(api.chiefEditDenied({ sage: true, chief: true }), true);
    for (const context of [{ sage: true, chief: false }, { sage: false, chief: true }, { sage: false, chief: false }]) {
      assert.equal(api.chiefEditDenied(context), false);
    }
    for (const context of [{}, { sage: true }, { sage: "on", chief: true }]) assert.throws(() => api.chiefEditDenied(context), /Invalid edit policy context/);
    if (provider === "claude") {
      const adapter = await import(pathToFileURL(join(f.plugin, "hooks/file-policy.mjs")));
      assert.equal(adapter.chiefEditDenied({ sage: true, chief: true }), true);
      assert.equal(adapter.chiefEditDenied({ sage: true, chief: false }), false);
      const hooks = join(f.dir, "hook-state");
      mkdirSync(hooks);
      for (const sage of [true, 1, "on", false, 0, ""]) for (const tool_name of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) {
        writeFileSync(join(hooks, "fixture.json"), JSON.stringify({ sage }));
        const result = spawnSync(process.execPath, [join(f.plugin, "hooks/sage-hook.mjs")], {
          input: JSON.stringify({ session_id: "fixture", hook_event_name: "PreToolUse", tool_name, cwd: f.dir,
            tool_input: { file_path: join(f.dir, "sample.txt"), notebook_path: join(f.dir, "sample.ipynb") } }),
          encoding: "utf8", env: { ...process.env, SAGE_HOOKS_STATE: hooks, SAGE_HOME: join(f.dir, "logbooks") },
        });
        assert.equal(result.status, 0, result.stderr);
        const output = JSON.parse(result.stdout || "{}");
        assert.equal(output.hookSpecificOutput?.permissionDecision, sage ? "deny" : undefined, `${tool_name}: persisted sage=${JSON.stringify(sage)}`);
      }
    }
  }
});

test("shared file and mode extraction preserves classified mode phrases in both isolated bundles", async t => {
  const prompt = (text, owner = true) => ({ owner, text, outside: text, all: text });
  for (const provider of ["claude", "codex"]) {
    const f = isolated(t, provider);
    const api = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
    assert.deepEqual(api.modeSignals(prompt("sage mode")), { sageOff: false, sageOn: true, autopilotOff: false, autopilotOn: false, modeWord: true });
    assert.deepEqual(api.modeSignals(prompt("sage mode off")), { sageOff: true, sageOn: false, autopilotOff: true, autopilotOn: false, modeWord: true });
    assert.deepEqual(api.modeSignals(prompt("sage mode, autopilot on")), { sageOff: false, sageOn: true, autopilotOff: false, autopilotOn: true, modeWord: true });
    assert.equal(api.modeSignals(prompt("sage mode continue on the project")).sageOn, true);
    for (const text of ["What does sage mode do?", "sage mode?", "sage mode online: is it a thing?", "autopilot on main"]) {
      const signals = api.modeSignals(prompt(text));
      assert.equal(signals.sageOn, false, text);
      assert.equal(signals.autopilotOn, false, text);
    }
    for (const text of ["sage mode", "sage mode off", "autopilot on"]) {
      const signals = api.modeSignals(prompt(text, false));
      assert.equal(signals.sageOn, false, text);
      assert.equal(signals.sageOff, false, text);
      assert.equal(signals.autopilotOn, false, text);
    }
    assert.equal(api.modeSignals(prompt("Please stop autopilot", false)).autopilotOff, true);
    assert.equal(api.modeSignals({ owner: true, text: "sage mode", outside: "sage mode", all: "sage mode\nautopilot off" }).autopilotOff, true);
    assert.equal(api.modeSignals({ owner: true, text: "sage mode", outside: "sage mode", all: "sage mode\nReport: no autopilot changes" }).autopilotOff, false);
    for (const input of [{}, { owner: "user", text: "sage mode", outside: "", all: "" }, { owner: true, text: "sage mode", all: "" }]) assert.throws(() => api.modeSignals(input), /Invalid mode prompt/);
    if (provider === "claude") {
      const adapter = await import(pathToFileURL(join(f.plugin, "hooks/mode-policy.mjs")));
      assert.equal(adapter.modeSignals(prompt("sage mode")).sageOn, true);
      assert.equal(adapter.modeSignals(prompt("sage mode", false)).sageOn, false);
    }
  }
});

test("shared file and mode extraction refuses active edits when the file policy is missing", async t => {
  for (const missing of ["hooks/file-policy.mjs", "core/file-policy.mjs"]) {
    const f = isolated(t, "claude");
    rmSync(join(f.plugin, missing), { force: true });
    const hook = await import(pathToFileURL(join(f.plugin, "hooks/sage-hook.mjs")));
    for (const tool_name of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) {
      const input = { hook_event_name: "PreToolUse", tool_name, cwd: f.dir, tool_input: { file_path: join(f.dir, "sample.txt"), notebook_path: join(f.dir, "sample.ipynb") } };
      const output = hook.handle(input, { sage: true }, {});
      assert.equal(output?.hookSpecificOutput?.permissionDecision, "deny", `${missing}: ${tool_name}`);
      assert.match(output.hookSpecificOutput.permissionDecisionReason, /file policy cannot load/);
      assert.equal(hook.handle(input, { sage: false }, {}), undefined);
    }
    if (missing.startsWith("core/")) {
      const output = hook.handle({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "gh api repos/o/r/git/refs -f ref=refs/heads/main" } }, { sage: false }, {});
      assert.equal(output?.hookSpecificOutput?.permissionDecision, "deny");
      assert.match(output.hookSpecificOutput.permissionDecisionReason, /command modules could not load/);
    }
  }
});

test("shared file and mode extraction clears cached autopilot before tool checks when the mode policy is missing", async t => {
  for (const missing of ["hooks/mode-policy.mjs", "core/mode-policy.mjs"]) {
    const f = isolated(t, "claude");
    rmSync(join(f.plugin, missing), { force: true });
    // A passing fixture ledger makes a stale autopilot flag an actual bypass; no real logbook is read.
    writeFileSync(join(f.plugin, "skills/sage/sage.mjs"), `export const sageRoot = () => ${JSON.stringify(join(f.dir, "logbooks"))};\nexport const mergeCheck = () => ({ ok: true });\n`);
    const hook = await import(pathToFileURL(join(f.plugin, "hooks/sage-hook.mjs")));
    const state = { sage: true, autopilot: true };
    const output = hook.handle({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd: f.dir,
      tool_input: { command: `gh pr merge 12 --squash --delete-branch --match-head-commit ${"a".repeat(40)}` } }, state, {});
    assert.equal(state.autopilot, false, missing);
    assert.equal(state.sage, true, "the existing Sage restrictions stay active");
    assert.equal(output?.hookSpecificOutput?.permissionDecision, "deny");
    assert.match(output.hookSpecificOutput.permissionDecisionReason, missing.startsWith("core/") ? /command modules could not load/ : /autopilot is off/);
    for (const sage of [false, true]) {
      const state = { sage, given: true, autopilot: true };
      const output = hook.handle({ hook_event_name: "UserPromptSubmit", prompt: "sage mode", cwd: f.dir }, state, {});
      assert.equal(state.sage, sage, "missing policy cannot start Sage mode");
      assert.equal(state.autopilot, false);
      assert.match(context(output), /mode policy cannot load/);
    }
  }
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
  assert.deepEqual(api.readAdmission(dir), { config: admissionConfig, sessions: [owner], reservations: [], bindings: [], preparations: [], modes: [{ ...admissionScope(owner), after: null, turn: owner.activation, sage: true }] });
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

test("admission refuses malformed UTF-8 even when decoding would preserve the canonical record", async t => {
  const { api, dir, scope } = await admissionFixture(t);
  api.reserveBriefAdmission(dir, scope, admissionRequest("call-1"), admissionDispatch,
    { issuerRole: "chief-of-staff", role: "lead" }, completeBrief("Keep the replacement character: \ufffd."));
  assert.equal(api.readAdmission(dir).reservations[0].brief.GOAL, "Keep the replacement character: \ufffd.");
  const path = join(dir, "00000002.json"), valid = readFileSync(path);
  const offset = valid.indexOf(Buffer.from("\ufffd", "utf8"));
  assert.notEqual(offset, -1);
  const malformed = Buffer.concat([valid.subarray(0, offset), Buffer.from([0xff]), valid.subarray(offset + 3)]);
  assert.equal(malformed.toString("utf8"), valid.toString("utf8"), "lossy decoding would conceal the corrupt bytes");
  writeFileSync(path, malformed);
  assert.throws(() => api.readAdmission(dir), /invalid journal UTF-8/);
  assert.throws(() => api.reserveAdmission(dir, scope, admissionRequest("next-call"), admissionDispatch), /invalid journal UTF-8/);
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


async function roleAdmissionFixture(t, limits = { total: 50, projects: [{ project: "project-a", limit: 50 }, { project: "project-b", limit: 50 }] }, provider = "codex") {
  const { dir, plugin } = isolated(t, provider);
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
  for (const provider of ["claude", "codex"]) {
    const f = await roleAdmissionFixture(t, undefined, provider);
    const roles = ["lead", "pe", "designer", "arena-judge", "implementer", "code-reviewer", "security-reviewer", "ux-reviewer", "qa"];
    roles.forEach((role, index) => assert.equal(f.reserve(index + 1, role).decision, "permit-once"));
    assert.deepEqual(f.api.readAdmission(f.journal).reservations.map(row => row.rolePlan), roles.map(role => ({ issuerRole: "chief-of-staff", role })));
  }
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

const bindingFor = (assignment, child = "child-1", turn = "child-turn") => ({ project: assignment.project,
  session: assignment.session, epoch: assignment.epoch, assignment: assignment.id,
  issuer: assignment.issuer, call: assignment.call, child, turn });

test("child binding persists the reserved role without another permit and permits exact retries", async t => {
  const f = await roleAdmissionFixture(t);
  assert.equal(typeof f.api.bindAdmission, "function");
  const first = f.reserve(1);
  const binding = bindingFor(first.assignment);
  assert.deepEqual(f.api.bindAdmission(f.journal, binding), { decision: "bound", binding, role: "lead" });
  assert.deepEqual(f.api.bindAdmission(f.journal, binding), { decision: "already-bound", binding, role: "lead" });
  f.api.changeAdmissionMode(f.journal, { ...f.scope, after: f.activation, turn: "b72422c7-509c-43aa-8c42-827c556f8a57", sage: false });
  assert.equal(f.api.bindAdmission(f.journal, binding).decision, "already-bound");
  assert.deepEqual(f.api.readAdmission(f.journal).bindings, [binding]);
  assert.equal(f.api.readAdmission(f.journal).reservations.length, 1);
  assert.equal(f.reserve(1).decision, "already-reserved");
});

test("child binding refuses changed scope, roleless reservations, self-binding, and replacement identities", async t => {
  const f = await roleAdmissionFixture(t);
  const a = f.reserve(1).assignment; const b = bindingFor(a);
  for (const change of [{ project: "project-b" }, { session: "other" }, { epoch: f.activation },
    { assignment: f.activation }, { issuer: "other" }, { call: "other" }, { child: a.issuer }, { role: "qa" }]) {
    assert.throws(() => f.api.bindAdmission(f.journal, { ...b, ...change }));
  }
  const legacy = f.api.reserveAdmission(...f.args(2));
  assert.throws(() => f.api.bindAdmission(f.journal, bindingFor(legacy.assignment)), /recorded role/);
  f.api.bindAdmission(f.journal, b);
  assert.throws(() => f.api.bindAdmission(f.journal, { ...b, child: "other-child" }), /different child binding/);
  assert.throws(() => f.api.bindAdmission(f.journal, { ...b, turn: "later-turn" }), /different child binding/);
  const second = f.reserve(3).assignment;
  assert.throws(() => f.api.bindAdmission(f.journal, bindingFor(second)), /another assignment/);
  assert.deepEqual(f.api.readAdmission(f.journal).bindings, [b]);
});

test("child binding refuses ambiguous names and role admission prevents name reuse", async t => {
  const f = await roleAdmissionFixture(t);
  const first = f.reserve(1);
  const args = f.args(2); args[3].name = "agent-1";
  assert.throws(() => f.api.reserveRoleAdmission(...args, { issuerRole: "chief-of-staff", role: "qa" }), /name is already reserved/);
  f.api.reserveAdmission(...args);
  assert.throws(() => f.api.bindAdmission(f.journal, bindingFor(first.assignment)), /name is ambiguous/);
  assert.deepEqual(f.api.readAdmission(f.journal).bindings, []);
});

test("child binding atomically selects one child when two callers claim the same assignment", async t => {
  const f = await roleAdmissionFixture(t); const a = f.reserve(1).assignment;
  const script = `const input=JSON.parse(process.argv[1]); const api=await import(input.url);
    try { console.log(JSON.stringify(api.bindAdmission(input.dir,input.binding))); }
    catch(error) { console.log(JSON.stringify({refused:error.message})); }`;
  const run = childName => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script,
      JSON.stringify({ url: f.url, dir: f.journal, binding: bindingFor(a, childName) })], { shell: false });
    let stdout = "", stderr = "";
    child.stdout.on("data", b => { stdout += b; }); child.stderr.on("data", b => { stderr += b; });
    child.once("error", reject); child.once("close", code => {
      try { assert.equal(code, 0, stderr); assert.equal(stderr, ""); resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
    }); child.stdin.end();
  });
  const results = await Promise.all([run("child-a"), run("child-b")]);
  assert.equal(results.filter(row => row.decision === "bound").length, 1);
  assert.equal(results.filter(row => /different child binding/.test(row.refused)).length, 1);
  assert.deepEqual(f.api.readAdmission(f.journal).bindings, [results.find(row => row.binding).binding]);
});


test("child binding keeps an exact receipt after a later legacy name collision", async t => {
  const f = await roleAdmissionFixture(t); const a = f.reserve(1).assignment;
  const b = bindingFor(a); f.api.bindAdmission(f.journal, b);
  const args = f.args(2); args[3].name = "agent-1"; f.api.reserveAdmission(...args);
  assert.deepEqual(f.api.bindAdmission(f.journal, b), { decision: "already-bound", binding: b, role: "lead" });
});

test("child binding reads prior role records with reused names but refuses a new ambiguous binding", async t => {
  const { createHash } = await import("node:crypto");
  const f = await roleAdmissionFixture(t); const first = f.reserve(1); f.reserve(2);
  let previous = null;
  for (let revision = 0; revision < 4; revision++) {
    const path = join(f.journal, String(revision).padStart(8, "0") + ".json");
    const prior = JSON.parse(readFileSync(path, "utf8"));
    if (prior.data.kind === "reserve") { delete prior.data.uniqueName; prior.data.dispatch.name = "agent-1"; }
    const body = { schema: prior.schema, revision, previous, data: prior.data };
    previous = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    writeFileSync(path, JSON.stringify({ ...body, hash: previous }) + "\n");
  }
  assert.equal(f.api.readAdmission(f.journal).reservations.length, 2);
  assert.throws(() => f.api.bindAdmission(f.journal, bindingFor(first.assignment)), /name is ambiguous/);
});


const completeBrief = goal => Object.fromEntries(["GOAL", "SCOPE", "CONTEXT", "DECISIONS", "ACCEPTANCE", "VERIFY", "BUDGET", "FORBIDDEN", "REPORT", "STANDING"]
  .map(field => [field, field === "GOAL" ? goal : "none"]));

test("brief admission uses the existing field contract and preserves readable text", async t => {
  const f = await roleAdmissionFixture(t);
  const { BRIEF_FIELDS } = await import("../plugins/sage/hooks/sage-hook.mjs");
  assert.deepEqual(f.api.BRIEF_FIELDS, BRIEF_FIELDS);
  assert.equal(Object.isFrozen(f.api.BRIEF_FIELDS), true);
  const brief = completeBrief("Build the fixed fixture.\nKeep the second line.");
  assert.deepEqual(f.api.parseBrief(brief), brief);
  const rendered = f.api.renderBrief(brief);
  assert(rendered.startsWith("GOAL\nBuild the fixed fixture.\nKeep the second line.\n\nSCOPE\nnone"));
  assert(rendered.endsWith("STANDING\nnone"));
});

test("brief admission rejects missing, inherited, invalid, and oversized fields", async t => {
  const f = await roleAdmissionFixture(t); const brief = completeBrief("A complete task.");
  const inherited = Object.assign(Object.create({ GOAL: brief.GOAL }), brief); delete inherited.GOAL;
  for (const value of [null, [], {}, inherited, { ...brief, extra: "unexpected" }, { ...brief, GOAL: "  " },
    { ...brief, SCOPE: null }, { ...brief, VERIFY: "bad\0text" }, { ...brief, GOAL: "\ud800" }, { ...brief, GOAL: "x".repeat(33 * 1024) }, { ...brief, CONTEXT: "\n".repeat(20_000) }]) {
    assert.throws(() => f.api.parseBrief(value));
    assert.throws(() => f.api.reserveBriefAdmission(...f.args(1), { issuerRole: "chief-of-staff", role: "lead" }, value));
  }
  assert.deepEqual(f.api.readAdmission(f.journal).reservations, []);
});

test("brief admission saves role and instructions together and copies caller values", async t => {
  const f = await roleAdmissionFixture(t); const brief = completeBrief("The original task.");
  const result = f.api.reserveBriefAdmission(...f.args(1), { issuerRole: "chief-of-staff", role: "lead" }, brief);
  assert.equal(result.decision, "permit-once");
  brief.GOAL = "Changed after admission.";
  const row = f.api.readAdmission(f.journal).reservations[0];
  assert.equal(row.assignment.id, result.assignment.id); assert.equal(row.rolePlan.role, "lead");
  assert.equal(row.brief.GOAL, "The original task.");
  row.brief.GOAL = "Changed snapshot.";
  assert.equal(f.api.readAdmission(f.journal).reservations[0].brief.GOAL, "The original task.");
});

test("brief admission retries cannot change, add, or remove saved instructions", async t => {
  const f = await roleAdmissionFixture(t); const brief = completeBrief("The fixed task.");
  const role = { issuerRole: "chief-of-staff", role: "lead" };
  const first = f.api.reserveBriefAdmission(...f.args(1), role, brief);
  const reordered = Object.fromEntries(Object.entries(brief).reverse());
  assert.equal(f.api.reserveBriefAdmission(...f.args(1), role, reordered).assignment.id, first.assignment.id);
  assert.throws(() => f.api.reserveBriefAdmission(...f.args(1), role, { ...brief, GOAL: "Different task." }), /different work/);
  assert.throws(() => f.api.reserveRoleAdmission(...f.args(1), role), /different work/);
  assert.throws(() => f.api.reserveAdmission(...f.args(1)), /different work/);
  f.reserve(2);
  assert.throws(() => f.api.reserveBriefAdmission(...f.args(2), role, brief), /different work/);
  f.api.changeAdmissionMode(f.journal, { ...f.scope, after: f.activation, turn: "b72422c7-509c-43aa-8c42-827c556f8a57", sage: false });
  assert.equal(f.api.reserveBriefAdmission(...f.args(1), role, brief).decision, "already-reserved");
  assert.equal(f.api.readAdmission(f.journal).reservations.length, 2);
});

test("brief admission keeps capacity limits and publishes no failed reservation", async t => {
  const f = await roleAdmissionFixture(t, { total: 1, projects: [{ project: "project-a", limit: 1 }] });
  const role = { issuerRole: "chief-of-staff", role: "lead" };
  f.api.reserveBriefAdmission(...f.args(1), role, completeBrief("First task."));
  assert.throws(() => f.api.reserveBriefAdmission(...f.args(2), role, completeBrief("Second task.")), /capacity/);
  const rows = f.api.readAdmission(f.journal).reservations;
  assert.equal(rows.length, 1); assert.equal(rows[0].brief.GOAL, "First task.");
});

test("brief admission permits only one of two concurrent instructions for the same call", async t => {
  const f = await roleAdmissionFixture(t);
  const script = `const input=JSON.parse(process.argv[1]);const api=await import(input.url);
    try { console.log(JSON.stringify(api.reserveBriefAdmission(...input.args,{issuerRole:'chief-of-staff',role:'lead'},input.brief))); }
    catch(error) { console.log(JSON.stringify({refused:error.message})); }`;
  const run = goal => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script,
      JSON.stringify({ url: f.url, args: f.args(1), brief: completeBrief(goal) })], { shell: false });
    let stdout = "", stderr = "";
    child.stdout.on("data", b => { stdout += b; }); child.stderr.on("data", b => { stderr += b; });
    child.once("error", reject); child.once("close", code => {
      try { assert.equal(code, 0, stderr); assert.equal(stderr, ""); resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
    }); child.stdin.end();
  });
  const results = await Promise.all([run("First proposed task."), run("Second proposed task.")]);
  assert.equal(results.filter(row => row.decision === "permit-once").length, 1);
  assert.equal(results.filter(row => /different work/.test(row.refused)).length, 1);
  assert.equal(f.api.readAdmission(f.journal).reservations.length, 1);
});


async function preparationFixture(t, limits) {
  const { plugin } = isolated(t, "codex");
  const api = await import(pathToFileURL(join(plugin, "core/index.mjs")));
  assert.equal(typeof api.prepareAdmission, "function", "durable task preparation must ship in core");
  assert.equal(typeof api.reservePreparedAdmission, "function", "prepared dispatch consumption must ship in core");
  const f = await roleAdmissionFixture(t, limits);
  const role = { issuerRole: "chief-of-staff", role: "lead" };
  const request = { task: "T1", run: "R1", issuer: "root", name: "agent-1" };
  const prepare = (changes = {}, brief = completeBrief("Complete the fixture task."), plan = role) =>
    f.api.prepareAdmission(f.journal, f.scope, { ...request, ...changes }, plan, brief);
  const reserve = (id, call = "spawn-1", dispatch = f.args(1)[3], issuerRole = role.issuerRole, issuer = "root", scope = f.scope) =>
    f.api.reservePreparedAdmission(f.journal, scope, { preparation: id, issuer, call }, dispatch, issuerRole);
  return { ...f, role, request, prepare, reserve };
}

test("prepared admission saves immutable work before the native call without taking capacity", async t => {
  const f = await preparationFixture(t, { total: 1, projects: [{ project: "project-a", limit: 1 }] });
  const brief = completeBrief("The saved task.");
  const first = f.prepare({}, brief);
  assert.equal(first.decision, "prepared");
  f.prepare({ name: "second" });
  brief.GOAL = "Caller changed it."; first.preparation.brief.GOAL = "Receipt changed it.";
  const snapshot = f.api.readAdmission(f.journal);
  assert.equal(snapshot.preparations.length, 2);
  assert.equal(snapshot.preparations[0].brief.GOAL, "The saved task.");
  assert.deepEqual(snapshot.reservations, []);
  const admitted = f.reserve(first.preparation.id);
  assert.equal(admitted.decision, "permit-once");
  const row = f.api.readAdmission(f.journal).reservations[0];
  assert.equal(row.preparation, first.preparation.id);
  assert.equal(row.brief.GOAL, "The saved task.");
  assert.equal(row.assignment.call, "spawn-1");
  assert.notEqual(row.assignment.id, first.preparation.id);
});

test("prepared admission retries preserve the original task role and every brief field", async t => {
  const f = await preparationFixture(t); const first = f.prepare();
  assert.deepEqual(f.prepare(), { decision: "already-prepared", preparation: first.preparation });
  for (const changes of [{ task: "T2" }, { run: "R2" }]) assert.throws(() => f.prepare(changes), /different work/);
  for (const key of f.api.BRIEF_FIELDS) {
    assert.throws(() => f.prepare({}, { ...completeBrief("Complete the fixture task."), [key]: "Replacement text." }), /different work/);
  }
  assert.throws(() => f.prepare({}, completeBrief("Complete the fixture task."), { issuerRole: "chief-of-staff", role: "qa" }), /different work/);
  assert.equal(f.api.readAdmission(f.journal).preparations.length, 1);
  const admitted = f.reserve(first.preparation.id);
  assert.equal(f.reserve(first.preparation.id).assignment.id, admitted.assignment.id);
  assert.equal(f.reserve(first.preparation.id).decision, "already-reserved");
  assert.throws(() => f.reserve(first.preparation.id, "spawn-2"), /already has a dispatch/);
  assert.throws(() => f.api.reserveBriefAdmission(...f.args(1), f.role, completeBrief("Complete the fixture task.")), /different work/);
});

test("prepared admission refuses invalid briefs roles and requests without publishing", async t => {
  const f = await preparationFixture(t);
  for (const brief of [{}, { ...completeBrief("Complete the fixture task."), GOAL: "" }, { ...completeBrief("Complete the fixture task."), GOAL: "x\0y" },
    { ...completeBrief("Complete the fixture task."), GOAL: "x".repeat(32769) }]) assert.throws(() => f.prepare({}, brief));
  for (const plan of [{ issuerRole: "qa", role: "qa" }, { issuerRole: "lead", role: "lead" },
    { issuerRole: "chief-of-staff", role: "chief-of-staff" }]) assert.throws(() => f.prepare({}, completeBrief("Complete the fixture task."), plan));
  for (const changes of [{ task: "bad" }, { run: "bad" }, { name: "" }, { issuer: null }, { extra: true }]) {
    assert.throws(() => f.prepare(changes));
  }
  assert.deepEqual(f.api.readAdmission(f.journal).preparations, []);
});

test("prepared admission requires matching scope issuer name and current issuer role at dispatch", async t => {
  const f = await preparationFixture(t); const first = f.prepare(); const id = first.preparation.id;
  assert.throws(() => f.reserve(id, "spawn-1", { ...f.args(1)[3], name: "other" }), /differs from its preparation/);
  assert.throws(() => f.reserve(id, "spawn-1", f.args(1)[3], "lead"), /differs from its preparation/);
  assert.throws(() => f.reserve(id, "spawn-1", f.args(1)[3], "chief-of-staff", "other"), /differs from its preparation/);
  const owner = f.api.activateAdmission(f.journal, { project: "project-b", session: "root", activation: f.activation });
  assert.throws(() => f.reserve(id, "spawn-1", f.args(1)[3], "chief-of-staff", "root",
    { project: owner.project, session: owner.session, epoch: owner.epoch }), /differs from its preparation/);
  assert.throws(() => f.reserve("00000000-0000-0000-0000-000000000000"), /unavailable/);
  assert.deepEqual(f.api.readAdmission(f.journal).reservations, []);
});

test("prepared admission enforces mode capacity and role limits again at dispatch", async t => {
  const f = await preparationFixture(t, { total: 1, projects: [{ project: "project-a", limit: 1 }] });
  const first = f.prepare();
  f.api.changeAdmissionMode(f.journal, { ...f.scope, after: f.activation, turn: "b72422c7-509c-43aa-8c42-827c556f8a57", sage: false });
  assert.equal(f.prepare().decision, "already-prepared");
  assert.throws(() => f.prepare({ name: "other" }), /mode is off/);
  assert.throws(() => f.reserve(first.preparation.id), /mode is off/);
  f.api.changeAdmissionMode(f.journal, { ...f.scope, after: "b72422c7-509c-43aa-8c42-827c556f8a57", turn: "c72422c7-509c-43aa-8c42-827c556f8a57", sage: true });
  f.api.reserveRoleAdmission(...f.args(2), f.role);
  assert.throws(() => f.reserve(first.preparation.id), /capacity/);
  const leads = await preparationFixture(t); const prepared = leads.prepare();
  for (let n = 2; n <= 4; n++) leads.api.reserveRoleAdmission(...leads.args(n), leads.role);
  assert.throws(() => leads.reserve(prepared.preparation.id), /three lead slots/);
  assert.equal(leads.api.readAdmission(leads.journal).reservations.length, 3);
});

test("prepared admission refuses an already dispatched name and preserves legacy reservations", async t => {
  const f = await preparationFixture(t);
  f.api.reserveAdmission(...f.args(1));
  assert.throws(() => f.prepare(), /already reserved/);
  assert.deepEqual(f.api.readAdmission(f.journal).preparations, []);
  const row = f.api.readAdmission(f.journal).reservations[0];
  assert.equal(Object.hasOwn(row, "preparation"), false);
  assert.equal(Object.hasOwn(row, "brief"), false);
  const prepared = f.prepare({ name: "agent-2" });
  f.api.reserveAdmission(...f.args(2));
  assert.throws(() => f.reserve(prepared.preparation.id, "another-call", f.args(2)[3]), /already reserved/);
});

test("prepared admission gives one preparation and one dispatch to concurrent callers", async t => {
  const f = await preparationFixture(t);
  const script = `const input=JSON.parse(process.argv[1]);const api=await import(input.url);
    try { console.log(JSON.stringify(api[input.method](...input.args))); }
    catch(error) { console.log(JSON.stringify({refused:error.message})); }`;
  const run = (method, args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, JSON.stringify({ url: f.url, method, args })], { shell: false });
    let stdout = "", stderr = "";
    child.stdout.on("data", b => { stdout += b; }); child.stderr.on("data", b => { stderr += b; });
    child.once("error", reject); child.once("close", code => {
      try { assert.equal(code, 0, stderr); assert.equal(stderr, ""); resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
    }); child.stdin.end();
  });
  const proposed = await Promise.all(["First work.", "Other work."].map(goal => run("prepareAdmission",
    [f.journal, f.scope, f.request, f.role, completeBrief(goal)])));
  assert.equal(proposed.filter(row => row.decision === "prepared").length, 1);
  assert.equal(proposed.filter(row => /different work/.test(row.refused)).length, 1);
  const id = proposed.find(row => row.decision === "prepared").preparation.id;
  const dispatched = await Promise.all(["call-1", "call-2"].map(call => run("reservePreparedAdmission",
    [f.journal, f.scope, { preparation: id, issuer: "root", call }, f.args(1)[3], "chief-of-staff"])));
  assert.equal(dispatched.filter(row => row.decision === "permit-once").length, 1);
  assert.equal(dispatched.filter(row => /already has a dispatch/.test(row.refused)).length, 1);
  assert.equal(f.api.readAdmission(f.journal).reservations.length, 1);
});
