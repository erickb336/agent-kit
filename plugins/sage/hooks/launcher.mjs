#!/usr/bin/env node
// The hook launcher: node launcher.mjs <hook file name>. Claude Code resolves CLAUDE_PLUGIN_ROOT once, at the start of
// a session, to that version's folder in ~/.claude/plugins/cache/sage/sage/, and an update of sage installs a new
// folder beside it. So a session registers this launcher, and at each event the launcher runs the hook of the install
// that ~/.claude/plugins/installed_plugins.json records now. Fail safe: when the record is missing, unreadable, or
// points outside the cache folder (also through a symbolic link), or the hook is not there, it runs the hook next to
// itself. It never runs code from any other place.
// The hook runs in this process (one node start per event): the hook's main guard compares process.argv[1] to its own
// path, so the launcher sets argv[1] to the hook it chose, and the hook also reads its state tool and skills from its
// own folder, so an old session reports the newest state tool's path.
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const name = basename(process.argv[2] ?? "");
const own = join(dirname(fileURLToPath(import.meta.url)), name);

function current() {
  const plugins = join(homedir(), ".claude", "plugins");
  const cache = realpathSync(join(plugins, "cache", "sage", "sage")) + sep;
  const install = JSON.parse(readFileSync(join(plugins, "installed_plugins.json"), "utf8")).plugins["sage@sage"][0].installPath;
  const hook = realpathSync(join(install, "hooks", name));
  if (!hook.startsWith(cache)) throw new Error(`${hook} is outside ${cache}`);
  return hook;
}

let hook;
try {
  hook = current();
} catch {
  hook = realpathSync(own);
}
process.argv[1] = hook;
await import(pathToFileURL(hook).href);
