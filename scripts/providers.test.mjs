import "./test-env.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
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
