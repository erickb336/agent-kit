// The hook launcher runs the hook of the sage install that its own plugins tree records now, in fake plugins trees
// under the temporary folder. It never touches the real ~/.claude/plugins.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HOOKS = fileURLToPath(new URL("../plugins/sage/hooks", import.meta.url));
const HOOK = "sage-hook.mjs";

/** The command that a hook file registers for an event, as Claude Code runs it: through a shell, with CLAUDE_PLUGIN_ROOT set. */
const command = (file, event) => JSON.parse(readFileSync(join(HOOKS, file), "utf8")).hooks[event][0].hooks[0].command;
const REGISTERED = { [HOOK]: command("claude.json", "Stop"), "principles-hook.mjs": command("hooks.json", "Stop") };

/** A fake HOME with two installed versions of sage, each with this tree's hooks folder, its hooks replaced by markers that print the version. */
function home() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sage-launcher-"))); // real: macOS puts tmpdir behind a symbolic link
  const cache = join(dir, ".claude", "plugins", "cache", "sage", "sage");
  // release: the plugin.json metadata.release of the version; undefined writes a plugin.json without one (release 0).
  const version = (v, withHook = true, release) => {
    mkdirSync(join(cache, v, "hooks"), { recursive: true });
    mkdirSync(join(cache, v, ".claude-plugin"), { recursive: true });
    writeFileSync(join(cache, v, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "sage", ...(release === undefined ? {} : { metadata: { release } }) }));
    cpSync(HOOKS, join(cache, v, "hooks"), { recursive: true }); // with its parser/ folder
    for (const name of Object.keys(REGISTERED)) {
      const file = join(cache, v, "hooks", name);
      if (withHook) writeFileSync(file, `process.stdout.write(JSON.stringify({ version: ${JSON.stringify(v)}, argv1: process.argv[1] }));\n`);
      else rmSync(file);
    }
    return join(cache, v);
  };
  const old = version("old");
  const newer = version("new");
  const recordFile = join(dir, ".claude", "plugins", "installed_plugins.json");
  const record = (installPath, entries = [{ scope: "user", installPath, version: "x" }]) => writeFileSync(recordFile, JSON.stringify({ version: 2, plugins: { "sage@sage": entries } }));
  // Runs an event through the OLD version's registered command, as a session that started before the update does.
  const exec = (name = HOOK, event = { hook_event_name: "Stop" }, cwd = dir) =>
    spawnSync("sh", ["-c", REGISTERED[name]], { cwd, input: JSON.stringify(event), encoding: "utf8", timeout: 5000, env: { ...process.env, HOME: dir, CLAUDE_PLUGIN_ROOT: old, SAGE_HOOKS_STATE: join(dir, "state"), SAGE_HOME: join(dir, "home") } });
  const run = (name, event, cwd) => {
    const r = exec(name, event, cwd);
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  const ran = (cwd) => JSON.parse(run(HOOK, undefined, cwd)).version;
  return { dir, cache, old, newer, version, record, recordFile, exec, run, ran };
}

test("an event through the old version's command runs the hook of the newer install that the record names", () => {
  const h = home();
  h.record(h.newer);
  assert.deepEqual(JSON.parse(h.run()), { version: "new", argv1: join(h.newer, "hooks", HOOK) });
  assert.deepEqual(JSON.parse(h.run("principles-hook.mjs")), { version: "new", argv1: join(h.newer, "hooks", "principles-hook.mjs") }, "the principles hook too");
});

test("without a record, or with an unreadable one, the launcher runs its own hook", () => {
  const h = home();
  assert.equal(h.ran(), "old");
  writeFileSync(join(h.dir, ".claude", "plugins", "installed_plugins.json"), "{ not json");
  assert.equal(h.ran(), "old");
  writeFileSync(join(h.dir, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ plugins: {} }));
  assert.equal(h.ran(), "old");
});

test("a record that points outside the cache, through a symbolic link that leaves it, or at a missing hook runs the launcher's own hook", () => {
  const h = home();
  const outside = join(h.dir, "elsewhere");
  mkdirSync(join(outside, "hooks"), { recursive: true });
  writeFileSync(join(outside, "hooks", HOOK), `process.stdout.write(JSON.stringify({ version: "outside" }));\n`);
  h.record(outside);
  assert.equal(h.ran(), "old");
  symlinkSync(outside, join(h.cache, "link"));
  h.record(join(h.cache, "link"));
  assert.equal(h.ran(), "old");
  h.record(join(h.cache, "missing"));
  assert.equal(h.ran(), "old");
  h.record(h.version("bare", false));
  assert.equal(h.ran(), "old", "an install that lacks the hook");
  h.record(h.newer);
  assert.equal(h.ran(), "new", "the same hook in an install that has it");
});

test("the real hook, run through the launcher from an old session, names the newest install's state tool", () => {
  const h = home();
  copyFileSync(join(HOOKS, HOOK), join(h.newer, "hooks", HOOK));
  mkdirSync(join(h.newer, "agents"));
  copyFileSync(join(HOOKS, "../agents/chief-of-staff.md"), join(h.newer, "agents", "chief-of-staff.md"));
  h.record(h.newer);
  const out = JSON.parse(h.run(HOOK, { session_id: "s1", hook_event_name: "UserPromptSubmit", prompt: "sage mode. Ramen Finder: fix the crash" }));
  assert.match(out.hookSpecificOutput.additionalContext, new RegExp(`The state tool: node ${join(h.newer, "skills/sage/sage.mjs")} <command>`));
});

test("the launcher adds under 50 ms of CPU time to an event", () => {
  const h = home();
  h.record(h.newer);
  const direct = join(h.newer, "hooks", HOOK);
  // CPU time, not wall-clock time: a busy machine makes a process wait for a core, but it does not add to its CPU time.
  // The child reports its own user + system time at exit, node start included.
  const report = "data:text/javascript,process.on('exit',()=>{const u=process.cpuUsage();process.stderr.write(String((u.user+u.system)/1000))})";
  const cpu = (args) => {
    const r = spawnSync("node", ["--import", report, ...args], { input: "{}", encoding: "utf8", env: { ...process.env, HOME: h.dir } });
    assert.equal(r.status, 0, r.stderr);
    return Number(r.stderr);
  };
  const median = (args) => Array.from({ length: 11 }, () => cpu(args)).sort((a, b) => a - b)[5];
  const [launched, alone] = [median([join(h.old, "hooks", "launcher.mjs"), HOOK]), median([direct])];
  console.log(`launcher CPU overhead: ${(launched - alone).toFixed(1)} ms (${launched.toFixed(1)} ms against ${alone.toFixed(1)} ms)`);
  assert.ok(launched - alone < 50, `${launched - alone} ms of CPU`);
});

test("every event of both hook files runs through the launcher", () => {
  for (const [file, name] of [["claude.json", HOOK], ["hooks.json", "principles-hook.mjs"]])
    for (const [event, groups] of Object.entries(JSON.parse(readFileSync(join(HOOKS, file), "utf8")).hooks))
      for (const g of groups) for (const h of g.hooks) assert.equal(h.command, `node "\${CLAUDE_PLUGIN_ROOT}/hooks/launcher.mjs" ${name}`, `${file} ${event}`);
});

test("the hook's exit code and stderr reach Claude Code through the launcher", () => {
  const h = home();
  writeFileSync(join(h.newer, "hooks", HOOK), `process.stderr.write("blocked by the new hook");\nprocess.exit(2);\n`);
  h.record(h.newer);
  const r = h.exec();
  assert.deepEqual([r.status, r.stderr, r.stdout], [2, "blocked by the new hook", ""]);
});

test("a path that leaves the cache by a longer folder name or by '..', or a relative path, runs the launcher's own hook", () => {
  const h = home();
  const evil = join(h.cache, "..", "sage-evil", "v"); // cache/sage/sage-evil starts with the text cache/sage/sage
  mkdirSync(join(evil, "hooks"), { recursive: true });
  writeFileSync(join(evil, "hooks", HOOK), `process.stdout.write(JSON.stringify({ version: "evil" }));\n`);
  h.record(evil);
  assert.equal(h.ran(), "old", "cache/sage/sage-evil");
  h.record(`${h.cache}/new/../../sage-evil/v`);
  assert.equal(h.ran(), "old", "'..' out of the cache");
  h.record(`${h.cache}/old/../new`);
  assert.equal(h.ran(), "new", "'..' that stays in the cache");
  h.record("new");
  assert.equal(h.ran(h.cache), "old", "a relative path, also when it resolves into the cache");
});

test("the record's user entry counts, not its first entry", () => {
  const h = home();
  const project = h.version("project");
  h.record(null, [{ scope: "project", installPath: project, projectPath: "/p" }, { scope: "user", installPath: h.newer }]);
  assert.equal(h.ran(), "new");
  h.record(null, [{ scope: "project", installPath: project, projectPath: "/p" }]);
  assert.equal(h.ran(), "old", "no user entry");
});

test("a FIFO as the record or as the chosen hook runs the launcher's own hook at once", () => {
  const h = home();
  assert.equal(spawnSync("mkfifo", [h.recordFile]).status, 0);
  // h.ran fails when the launcher blocks: exec kills it after 5 s, and a killed process has no exit status 0.
  assert.equal(h.ran(), "old");
  rmSync(h.recordFile);
  h.record(h.newer);
  rmSync(join(h.newer, "hooks", HOOK));
  assert.equal(spawnSync("mkfifo", [join(h.newer, "hooks", HOOK)]).status, 0);
  assert.equal(h.ran(), "old", "a FIFO hook");
});

test("a hook that throws on import falls back to the own hook, and when both throw a PreToolUse call is denied", () => {
  const h = home();
  const merge = { session_id: "s1", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "gh pr merge 18" } };
  writeFileSync(join(h.newer, "hooks", HOOK), `throw new Error("broken new");\n`);
  h.record(h.newer);
  assert.equal(h.ran(), "old", "the own marker hook runs");
  copyFileSync(join(HOOKS, HOOK), join(h.old, "hooks", HOOK));
  mkdirSync(join(h.old, "agents"));
  copyFileSync(join(HOOKS, "../agents/chief-of-staff.md"), join(h.old, "agents", "chief-of-staff.md"));
  h.run(HOOK, { session_id: "s1", hook_event_name: "UserPromptSubmit", prompt: "sage mode. Ramen Finder: fix the crash" });
  assert.match(JSON.parse(h.run(HOOK, merge)).hookSpecificOutput.permissionDecisionReason, /^sage: merge only the checked commit/, "the real own hook still checks the merge");
  writeFileSync(join(h.old, "hooks", HOOK), `throw new Error("broken old");\n`);
  const out = JSON.parse(h.run(HOOK, merge)).hookSpecificOutput;
  assert.equal(out.permissionDecision, "deny");
  assert.match(out.permissionDecisionReason, /could not load \(broken new; broken old\)/);
  const stop = h.exec();
  assert.deepEqual([stop.status, stop.stdout], [0, ""], "another event is not blocked");
  assert.match(stop.stderr, /could not load/);
});

test("an install with a lower release than the launcher's own is refused; an equal or higher one runs", () => {
  const h = home();
  h.version("old", true, 2);
  h.record(h.version("older", true, 1));
  assert.equal(h.ran(), "old", "release 1 under 2");
  h.record(h.newer);
  assert.equal(h.ran(), "old", "no release (0) under 2");
  h.record(h.version("same", true, 2));
  assert.equal(h.ran(), "same");
  h.record(h.version("next", true, 3));
  assert.equal(h.ran(), "next");
});

test("the launcher without a hook name exits with its usage, not an import error", () => {
  const r = spawnSync("node", [join(HOOKS, "launcher.mjs")], { input: "{}", encoding: "utf8" });
  assert.deepEqual([r.status, r.stdout], [1, ""]);
  assert.match(r.stderr, /^usage: node launcher\.mjs <hook file name>/);
});

test("this tree's plugin.json has a release, so older installs without one are refused", () => {
  assert.ok(Number.isInteger(JSON.parse(readFileSync(join(HOOKS, "../.claude-plugin/plugin.json"), "utf8")).metadata.release));
});

test("the launcher's own plugins tree decides, not HOME: a record and a release-999 folder planted under HOME never run", () => {
  const h = home();
  const planted = realpathSync(mkdtempSync(join(tmpdir(), "sage-planted-")));
  const plantedCache = join(planted, ".claude", "plugins", "cache", "sage", "sage", "999");
  mkdirSync(join(plantedCache, "hooks"), { recursive: true });
  mkdirSync(join(plantedCache, ".claude-plugin"), { recursive: true });
  writeFileSync(join(plantedCache, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "sage", metadata: { release: 999 } }));
  writeFileSync(join(plantedCache, "hooks", HOOK), `process.stdout.write(JSON.stringify({ version: "planted" }));\n`);
  writeFileSync(join(planted, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "sage@sage": [{ scope: "user", installPath: plantedCache }] } }));
  const ran = () => JSON.parse(spawnSync("sh", ["-c", REGISTERED[HOOK]], { input: '{"hook_event_name":"Stop"}', encoding: "utf8", env: { ...process.env, HOME: planted, CLAUDE_PLUGIN_ROOT: h.old } }).stdout).version;
  assert.equal(ran(), "old", "no record in the own tree: the own hook, not the planted one");
  h.record(h.newer);
  assert.equal(ran(), "new", "the own tree's record decides");
});

test("a launcher outside any plugins cache (a dev folder) runs its own hook, also when the record names a newer release", () => {
  const h = home();
  const dev = join(h.dir, "checkout", "plugins", "sage");
  mkdirSync(join(dev, ".claude-plugin"), { recursive: true });
  writeFileSync(join(dev, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "sage" }));
  cpSync(join(h.old, "hooks"), join(dev, "hooks"), { recursive: true });
  writeFileSync(join(dev, "hooks", HOOK), `process.stdout.write(JSON.stringify({ version: "dev" }));\n`);
  h.record(h.version("next", true, 999));
  const r = spawnSync("sh", ["-c", REGISTERED[HOOK]], { input: '{"hook_event_name":"Stop"}', encoding: "utf8", env: { ...process.env, HOME: h.dir, CLAUDE_PLUGIN_ROOT: dev } });
  assert.equal(JSON.parse(r.stdout).version, "dev");
});

test("when both hooks fail to load, only a Bash merge or push is denied; other calls and the principles hook pass", () => {
  const h = home();
  for (const name of Object.keys(REGISTERED)) for (const v of [h.old, h.newer]) writeFileSync(join(v, "hooks", name), `throw new Error("broken");\n`);
  h.record(h.newer);
  const pre = (tool_name, tool_input, name = HOOK) => h.exec(name, { hook_event_name: "PreToolUse", tool_name, tool_input });
  for (const command of ["gh pr merge 18", "git push origin hook/t44-launcher"]) {
    const r = pre("Bash", { command });
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "deny", command);
  }
  for (const [tool, input, name] of [["Edit", { file_path: "/x" }], ["Bash", { command: "ls" }], ["Bash", { command: "gh pr merge 18" }, "principles-hook.mjs"]]) {
    const r = pre(tool, input, name);
    assert.deepEqual([r.status, r.stdout], [0, ""], `${tool} ${JSON.stringify(input)} ${name ?? HOOK}`);
    assert.match(r.stderr, /could not load/);
  }
});
