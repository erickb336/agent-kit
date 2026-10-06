// Runs the remote-control skill's script as the skill does: against a settings file in a temporary config folder, and
// for the server, in a temporary home folder with stand-ins for launchctl and claude, so that the tests run on any computer.
import "./test-env.mjs"; // first: no variable of the developer's shell changes a result
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ROOT } from "./build.mjs";

const SCRIPT = join(ROOT, "plugins/sage/skills/remote-control/remote-control.mjs");

function configDir() {
  const dir = mkdtempSync(join(tmpdir(), "agent-kit-config-"));
  const run = (...args) => spawnSync("node", [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, CLAUDE_CONFIG_DIR: dir } });
  const file = join(dir, "settings.json");
  return { file, run, read: () => JSON.parse(readFileSync(file, "utf8")) };
}

test("on creates the settings file, readable only by the user", () => {
  const c = configDir();
  const r = c.run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Remote Control for new sessions: on \(was not set\)/);
  assert.deepEqual(c.read(), { remoteControlAtStartup: true });
  assert.equal(statSync(c.file).mode & 0o777, 0o600);
});

test("on and off change only their key, and keep the other settings", () => {
  const c = configDir();
  writeFileSync(c.file, JSON.stringify({ enabledPlugins: { "agent-kit@agent-kit": true }, model: "opus" }));
  assert.equal(c.run("on").status, 0);
  const off = c.run("off");
  assert.match(off.stdout, /: off \(was on\)/);
  assert.deepEqual(c.read(), { enabledPlugins: { "agent-kit@agent-kit": true }, model: "opus", remoteControlAtStartup: false });
});

test("status and a repeated command write nothing", () => {
  const c = configDir();
  writeFileSync(c.file, '{"remoteControlAtStartup":true}');
  for (const args of [["status"], ["on"]]) {
    const r = c.run(...args);
    assert.match(r.stdout, /: on\. File:/);
    assert.equal(readFileSync(c.file, "utf8"), '{"remoteControlAtStartup":true}', `${args} must not rewrite the file`);
  }
});

test("a settings file that is not valid JSON stays as it is", () => {
  const c = configDir();
  writeFileSync(c.file, '{"model": "opus",');
  const r = c.run("on");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not valid JSON, so nothing changed/);
  assert.equal(readFileSync(c.file, "utf8"), '{"model": "opus",');
});

test("an unknown command changes nothing", () => {
  const c = configDir();
  const r = c.run("enable");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Use on, off, status or server/);
});

/** The stand-in launchctl records each call, and answers print with FAKE_STATE (running by default) while the item is loaded. */
const FAKE_LAUNCHCTL = `#!/bin/sh
echo "$*" >> "$HOME/launchctl.calls"
case "$1" in
  bootstrap) touch "$HOME/loaded"; if [ -n "$FAKE_SERVER_LOG" ]; then echo "$FAKE_SERVER_LOG" >> "$HOME/Library/Logs/agent-kit-remote-control.log"; fi ;;
  bootout) rm -f "$HOME/loaded" ;;
  print) [ -f "$HOME/loaded" ] || exit 113; printf '\\tstate = %s\\n\\tpid = 4242\\n' "\${FAKE_STATE:-running}" ;;
esac
`;

function mac() {
  const home = mkdtempSync(join(tmpdir(), "agent-kit-home-"));
  const bin = join(home, "bin");
  mkdirSync(bin);
  mkdirSync(join(home, "workspace"));
  writeFileSync(join(bin, "launchctl"), FAKE_LAUNCHCTL, { mode: 0o755 });
  writeFileSync(join(bin, "claude"), "#!/bin/sh\n", { mode: 0o755 });
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, AGENT_KIT_SERVER_WAIT_MS: "0" };
  return {
    home,
    bin,
    plist: join(home, "Library/LaunchAgents/io.github.erickb336.agent-kit.remote-control.plist"),
    run: (args, more = {}) => spawnSync("node", [SCRIPT, ...args], { encoding: "utf8", env: { ...env, ...more } }),
    calls: () => readFileSync(join(home, "launchctl.calls"), "utf8"),
  };
}

test("server adds a login item that runs claude remote-control in the folder, and starts it", () => {
  const m = mac();
  const r = m.run(["server", "~/workspace"], { FAKE_SERVER_LOG: "\x1b[1A\x1b[J·✔︎· Ready · workspace · HEAD" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.split(". ")[0], `Remote Control server: running in ${m.home}/workspace (pid 4242)`);
  assert.match(r.stdout, /\nReady: the phone can start sessions\.\n$/);
  const item = readFileSync(m.plist, "utf8");
  const command = ["/usr/bin/env", "-u", "CLAUDE_CODE_OAUTH_TOKEN", `${m.bin}/claude`, "remote-control", "--no-create-session-in-dir"];
  assert.ok(item.includes(`<array>${command.map((a) => `<string>${a}</string>`).join("")}</array>`), "the server starts without the inference-only token");
  assert.ok(item.includes(`<key>WorkingDirectory</key><string>${m.home}/workspace</string>`), item);
  assert.ok(item.includes(`<key>PATH</key><string>${m.bin}:`), "the server gets the user's PATH, for the sessions' tools");
  assert.ok(m.calls().includes(`bootstrap gui/${process.getuid()} ${m.plist}\n`));
});

test("a server that stops at once leaves no login item, and shows why", () => {
  const m = mac();
  const r = m.run(["server", "~/workspace"], { FAKE_STATE: "not running", FAKE_SERVER_LOG: "Error: You must be logged in to use Remote Control." });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /The server stopped at once[\s\S]*Error: You must be logged in to use Remote Control\./);
  assert.equal(existsSync(m.plist), false);
  assert.match(m.run(["server", "status"]).stdout, /not installed/);
});

test("a server that runs but is not registered yet says so, with the reason", () => {
  const m = mac();
  const r = m.run(["server", "~/workspace"], { FAKE_SERVER_LOG: "Error: This folder is already served by another Claude Code on this device. Stop it first." });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\nNot ready yet\. Its last message:\nError: This folder is already served by another Claude Code/);
  assert.match(m.run(["server", "status"]).stdout, /Not ready yet/);
});

test("server status shows the folder; server off stops the server and removes the login item", () => {
  const m = mac();
  m.run(["server", "~/workspace"]);
  assert.match(m.run(["server", "status"]).stdout, new RegExp(`^Remote Control server: running \\(pid 4242\\) in ${m.home}/workspace\\.`));
  assert.match(m.run(["server", "off"]).stdout, /off\. The script removed the login item\./);
  assert.equal(existsSync(m.plist), false);
  assert.ok(m.calls().includes(`bootout gui/${process.getuid()}/io.github.erickb336.agent-kit.remote-control\n`));
  assert.match(m.run(["server", "off"]).stdout, /It was not installed\./);
});

test("server with a folder that does not exist changes nothing", () => {
  const m = mac();
  const r = m.run(["server", "~/no-such-folder"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no-such-folder is not a folder, so nothing changed/);
  assert.equal(existsSync(m.plist), false);
});
