#!/usr/bin/env node
// The remote-control skill's script.
//   node remote-control.mjs [on|off|status]               Remote Control for every new session (on is the default)
//   node remote-control.mjs server <folder|off|status>    a Remote Control server in <folder> that starts at each login (macOS)
// on and off set remoteControlAtStartup in the user's settings file, ~/.claude/settings.json (or $CLAUDE_CONFIG_DIR/settings.json).
// /config writes the same key to the same file, and Claude Code reads it before the old place, ~/.claude.json.
// They change only that key, and they write nothing when the file is not valid JSON.
// server adds a launchd login item that runs `claude remote-control` in the folder, so the phone can start sessions there.
import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "remoteControlAtStartup";
const COMMANDS = { on: true, off: false, status: undefined };

export function settingsFile(env = process.env) {
  return join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "settings.json");
}

/** Sets the key to `value`, or only reads it when `value` is undefined. Returns the value before and after. */
export function setRemoteControl(file, value) {
  const exists = existsSync(file);
  let settings;
  try {
    settings = JSON.parse(exists ? readFileSync(file, "utf8") : "{}");
  } catch (err) {
    throw new Error(`${file} is not valid JSON, so nothing changed. ${err.message}`);
  }
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) throw new Error(`${file} is not a JSON object, so nothing changed.`);
  const before = settings[KEY];
  if (value === undefined || before === value) return { before, after: before };
  settings[KEY] = value;
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", { mode: exists ? statSync(file).mode & 0o777 : 0o600 });
  renameSync(tmp, file); // whole or nothing, because Claude Code reads this file at any time
  return { before, after: value };
}

const label = (v) => (v === true ? "on" : v === false ? "off" : v === undefined ? "not set" : JSON.stringify(v));

// The server: one launchd login item, in the user's GUI session, so that it can read the login from the keychain.
// The label and the log keep the kit's first name, agent-kit, so that an installed login item stays under control.
const LABEL = "io.github.erickb336.agent-kit.remote-control";
const agentFile = () => join(homedir(), "Library/LaunchAgents", `${LABEL}.plist`);
const logFile = () => join(homedir(), "Library/Logs/agent-kit-remote-control.log");
const service = () => `gui/${process.getuid()}/${LABEL}`;

function launchctl(...args) {
  try {
    return execFileSync("launchctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    if (err.code === "ENOENT") throw new Error("The server needs macOS: launchctl is not on this computer.");
    throw err;
  }
}

function serverState() {
  let out;
  try {
    out = launchctl("print", service());
  } catch {
    return { loaded: false, running: false };
  }
  return { loaded: true, running: /^\s*state = running$/m.test(out), pid: /^\s*pid = (\d+)$/m.exec(out)?.[1] };
}

const xml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const str = (s) => `<string>${xml(s)}</string>`;

/**
 * env -u CLAUDE_CODE_OAUTH_TOKEN: that token (from `claude setup-token`) is inference-only, and Claude Code prefers it to
 * the full login, so the server would refuse to start. Other programs that need the token keep it.
 * --no-create-session-in-dir: a session appears only when the user starts one, not at each login or restart.
 */
function plist({ folder, claude, path, log }) {
  const command = ["/usr/bin/env", "-u", "CLAUDE_CODE_OAUTH_TOKEN", claude, "remote-control", "--no-create-session-in-dir"];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>${str(LABEL)}
  <key>ProgramArguments</key><array>${command.map(str).join("")}</array>
  <key>WorkingDirectory</key>${str(folder)}
  <key>EnvironmentVariables</key><dict><key>PATH</key>${str(path)}</dict>
  <key>StandardOutPath</key>${str(log)}
  <key>StandardErrorPath</key>${str(log)}
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>60</integer>
</dict>
</plist>
`;
}

function findClaude() {
  for (const dir of (process.env.PATH ?? "").split(":").filter(Boolean)) {
    try {
      accessSync(join(dir, "claude"), constants.X_OK);
      return join(dir, "claude");
    } catch {
      /* not in this folder */
    }
  }
  throw new Error("The claude command is not on PATH, so nothing changed.");
}

/** The server draws a status screen for a terminal; the log keeps its text without the terminal's control codes. */
const log = () => (existsSync(logFile()) ? readFileSync(logFile(), "utf8").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trim() : "");
const lastLines = (n) => log().split("\n").slice(-n).join("\n");
/** The server writes "Ready" when claude.ai has registered it. Until then the phone cannot see it. */
const readiness = () => (/\bReady\b/.test(log()) ? "Ready: the phone can start sessions." : `Not ready yet. Its last message:\n${lastLines(3) || "(none)"}`);

function stopServer() {
  if (serverState().loaded) launchctl("bootout", service());
  const existed = existsSync(agentFile());
  rmSync(agentFile(), { force: true });
  return existed;
}

function startServer(folderArg) {
  const folder = resolve(folderArg.replace(/^~(?=\/|$)/, homedir()));
  if (!existsSync(folder) || !statSync(folder).isDirectory()) throw new Error(`${folder} is not a folder, so nothing changed.`);
  const claude = findClaude();
  stopServer();
  mkdirSync(dirname(agentFile()), { recursive: true });
  mkdirSync(dirname(logFile()), { recursive: true });
  writeFileSync(logFile(), "");
  writeFileSync(agentFile(), plist({ folder, claude, path: process.env.PATH ?? "", log: logFile() }));
  let state;
  try {
    launchctl("bootstrap", `gui/${process.getuid()}`, agentFile());
    // A server that cannot start (no login, a folder not trusted) stops within a few seconds.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.AGENT_KIT_SERVER_WAIT_MS ?? 8000));
    state = serverState();
  } catch (err) {
    stopServer();
    throw err;
  }
  if (!state.running) {
    const why = lastLines(5);
    stopServer();
    throw new Error(`The server stopped at once. The script removed the login item. The server's last message:\n${why || "(none)"}`);
  }
  return `Remote Control server: running in ${folder} (pid ${state.pid}). It starts again at each login. Log: ${logFile()}\n${readiness()}`;
}

function serverStatus() {
  if (!existsSync(agentFile())) return "Remote Control server: not installed.";
  const folder = /<key>WorkingDirectory<\/key><string>([^<]*)<\/string>/.exec(readFileSync(agentFile(), "utf8"))?.[1];
  const s = serverState();
  if (!s.running) return `Remote Control server: installed, not running, in ${folder}. Log: ${logFile()}\n${lastLines(5)}`.trim();
  return `Remote Control server: running (pid ${s.pid}) in ${folder}. Log: ${logFile()}\n${readiness()}`;
}

function server(arg) {
  if (arg === "status") return serverStatus();
  if (arg === "off") return stopServer() ? "Remote Control server: off. The script removed the login item." : "Remote Control server: off. It was not installed.";
  if (!arg) throw new Error("Give a folder, off or status after server.");
  return startServer(arg);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command = "on", arg] = process.argv.slice(2);
  if (command !== "server" && !Object.hasOwn(COMMANDS, command)) {
    console.error(`Unknown command "${command}". Use on, off, status or server.`);
    process.exit(2);
  }
  try {
    if (command === "server") console.log(server(arg));
    else {
      const file = settingsFile();
      const { before, after } = setRemoteControl(file, COMMANDS[command]);
      console.log(`Remote Control for new sessions: ${label(after)}${before === after ? "" : ` (was ${label(before)})`}. File: ${file}`);
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
