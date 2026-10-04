// The hook launcher runs the hook of the sage install that the record names now, in a fake plugins folder under a fake
// HOME. It never touches the real ~/.claude/plugins.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  const version = (v, withHook = true) => {
    mkdirSync(join(cache, v, "hooks"), { recursive: true });
    for (const file of readdirSync(HOOKS)) copyFileSync(join(HOOKS, file), join(cache, v, "hooks", file));
    for (const name of Object.keys(REGISTERED)) {
      const file = join(cache, v, "hooks", name);
      if (withHook) writeFileSync(file, `process.stdout.write(JSON.stringify({ version: ${JSON.stringify(v)}, argv1: process.argv[1] }));\n`);
      else rmSync(file);
    }
    return join(cache, v);
  };
  const old = version("old");
  const newer = version("new");
  const record = (installPath) => writeFileSync(join(dir, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "sage@sage": [{ scope: "user", installPath, version: "x" }] } }));
  // Runs an event through the OLD version's registered command, as a session that started before the update does.
  const run = (name = HOOK, event = { hook_event_name: "Stop" }) => {
    const r = spawnSync("sh", ["-c", REGISTERED[name]], { input: JSON.stringify(event), encoding: "utf8", env: { ...process.env, HOME: dir, CLAUDE_PLUGIN_ROOT: old, SAGE_HOOKS_STATE: join(dir, "state"), SAGE_HOME: join(dir, "home") } });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  const ran = () => JSON.parse(run()).version;
  return { dir, cache, old, newer, version, record, run, ran };
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
  assert.match(out.hookSpecificOutput.additionalContext, new RegExp(`The state tool: node "${join(h.newer, "skills/sage/sage.mjs")}"`));
});

test("the launcher adds under 50 ms to an event", () => {
  const h = home();
  h.record(h.newer);
  const direct = join(h.newer, "hooks", HOOK);
  const ms = (args) => {
    const t = process.hrtime.bigint();
    assert.equal(spawnSync("node", args, { input: "{}", env: { ...process.env, HOME: h.dir } }).status, 0);
    return Number(process.hrtime.bigint() - t) / 1e6;
  };
  const median = (args) => {
    const times = Array.from({ length: 11 }, () => ms(args)).sort((a, b) => a - b);
    return times[5];
  };
  const overhead = median([join(h.old, "hooks", "launcher.mjs"), HOOK]) - median([direct]);
  console.log(`launcher overhead: ${overhead.toFixed(1)} ms`);
  assert.ok(overhead < 50, `${overhead} ms`);
});

test("every event of both hook files runs through the launcher", () => {
  for (const [file, name] of [["claude.json", HOOK], ["hooks.json", "principles-hook.mjs"]])
    for (const [event, groups] of Object.entries(JSON.parse(readFileSync(join(HOOKS, file), "utf8")).hooks))
      for (const g of groups) for (const h of g.hooks) assert.equal(h.command, `node "\${CLAUDE_PLUGIN_ROOT}/hooks/launcher.mjs" ${name}`, `${file} ${event}`);
});
