#!/usr/bin/env node
// The hook launcher: node launcher.mjs <hook file name>. Claude Code resolves CLAUDE_PLUGIN_ROOT once, at the start of
// a session, to that version's folder in ~/.claude/plugins/cache/sage/sage/, and an update of sage installs a new
// folder beside it. So a session registers this launcher, and at each event the launcher runs the hook of the install
// that the "user" entry of ~/.claude/plugins/installed_plugins.json records now.
// Fail safe: it runs the hook next to itself when the record is missing, not a regular file or over 1 MB; when the
// install is not an absolute path, resolves (also through a symbolic link or "..") outside the cache folder, has a
// lower release than this launcher's own install, or has no regular hook file. It never runs code from any other place.
// The release is plugin.json's metadata.release (an integer; none is 0). Claude Code does not read metadata, so the
// release does not pin updates the way plugin.json's "version" does. Bump it when a release must not be undone.
// Fail closed: when the chosen hook throws on import it runs its own hook, and when that throws too it refuses a
// PreToolUse call, so that no broken install lets a merge skip the merge check.
// Known limits: agents can write in the cache folder, so a folder made there with a high release passes. A symbolic
// link swapped in between the check and the import, or a hook that reads stdin and then throws, also gets through.
// The hook runs in this process (one node start per event): the hook's main guard compares process.argv[1] to its own
// path, so the launcher sets argv[1] to the hook it chose, and the hook also reads its state tool and skills from its
// own folder, so an old session reports the newest state tool's path.
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const name = basename(process.argv[2] ?? "");
if (!name.endsWith(".mjs")) {
  process.stderr.write("usage: node launcher.mjs <hook file name>, for example sage-hook.mjs\n");
  process.exit(1);
}
const ownRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** The text of a regular file of at most 1 MB. O_NONBLOCK: a FIFO opens at once and fails the check, not hangs. */
function read(file) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const s = fstatSync(fd);
    if (!s.isFile() || s.size > 1 << 20) throw new Error(`${file} is not a regular file of at most 1 MB`);
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

const release = (root) => JSON.parse(read(join(root, ".claude-plugin", "plugin.json"))).metadata?.release ?? 0;

function current() {
  const plugins = join(homedir(), ".claude", "plugins");
  const cache = realpathSync(join(plugins, "cache", "sage", "sage")) + sep;
  const entry = JSON.parse(read(join(plugins, "installed_plugins.json"))).plugins["sage@sage"].find((e) => e.scope === "user");
  if (!isAbsolute(entry.installPath)) throw new Error(`${entry.installPath} is not absolute`);
  const install = realpathSync(entry.installPath);
  if (!install.startsWith(cache)) throw new Error(`${install} is outside ${cache}`);
  if (!(release(install) >= release(ownRoot))) throw new Error(`${install} is older than ${ownRoot}`);
  const hook = realpathSync(join(install, "hooks", name)); // the real path is what runs, checked last to keep the window short
  if (!hook.startsWith(install + sep) || !statSync(hook).isFile()) throw new Error(`${hook} is not a hook of ${install}`);
  return hook;
}

const run = (hook) => {
  process.argv[1] = hook;
  return import(pathToFileURL(hook).href);
};

let hook;
try {
  hook = current();
} catch {
  hook = join(ownRoot, "hooks", name);
}
try {
  await run(hook);
} catch (first) {
  try {
    await run(realpathSync(join(ownRoot, "hooks", name)));
  } catch (e) {
    let event;
    try {
      event = JSON.parse(readFileSync(0, "utf8")).hook_event_name;
    } catch {}
    const reason = `sage: the ${name} hook could not load (${first?.message ?? first}; ${e?.message ?? e}), so it refuses this call. Tell the user.`;
    if (event === "PreToolUse") process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, permissionDecision: "deny", permissionDecisionReason: reason } }));
    else process.stderr.write(`${reason}\n`);
  }
}
