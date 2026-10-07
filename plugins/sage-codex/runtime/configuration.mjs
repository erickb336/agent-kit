import { constants, openSync, closeSync, fstatSync, readSync, realpathSync, statSync, lstatSync } from "node:fs";
import { isAbsolute, resolve, dirname, relative, sep } from "node:path";
import { TextDecoder } from "node:util";
import { readAdmission } from "../core/index.mjs";
import { serveHooks } from "./mcp-server.mjs";
import { servePreparations } from "./preparation-server.mjs";

const LIMIT = 64 * 1024;
const message = "Sage native hook configuration is unavailable.";
const refuse = () => { throw Error(message); };
const fields = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const pathSyntax = path => typeof path === "string" && path.length <= 4096 && !/\p{Cc}/u.test(path)
  && isAbsolute(path) && resolve(path) === path;
const canonical = path => pathSyntax(path) && realpathSync(path) === path;
const contains = (parent, child) => {
  const part = relative(parent, child);
  return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part));
};
// Codex can start MCP before it creates this leaf directory. Prompt-time identity
// checks still validate every actual directory component and the transcript.
const nativeSessions = path => {
  if (!pathSyntax(path) || !canonical(dirname(path)) || !statSync(dirname(path)).isDirectory()) return false;
  try { return lstatSync(path).isDirectory() && canonical(path); }
  catch (error) { if (error.code === "ENOENT") return true; throw error; }
};

/** Read an explicit launcher-owned file. Never resolve its path from a hook request. */
export function readHookConfiguration(file) {
  let fd;
  try {
    if (!canonical(file)) refuse();
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > LIMIT) refuse();
    const bytes = Buffer.alloc(LIMIT + 1);
    let used = 0;
    while (used < bytes.length) {
      const count = readSync(fd, bytes, used, bytes.length - used, used);
      if (!count) break;
      used += count;
    }
    if (used > LIMIT) refuse();
    const config = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used)));
    if (!fields(config, ["version", "mode"]) || ![1, 2].includes(config.version)
      || !fields(config.mode, ["directory", "project", "projectDirectory", "sessionsDir",
        ...(config.version === 2 ? ["observationsRoot"] : [])])) refuse();
    const mode = config.mode;
    for (const key of ["directory", "projectDirectory", ...(config.version === 2 ? ["observationsRoot"] : [])]) {
      if (!canonical(mode[key]) || !statSync(mode[key]).isDirectory()) refuse();
    }
    if (!nativeSessions(mode.sessionsDir)) refuse();
    if (config.version === 2 && (contains(mode.directory, mode.observationsRoot)
      || contains(mode.observationsRoot, mode.directory))) refuse();
    if (typeof mode.project !== "string" || !/^[A-Za-z0-9_.:-]{1,256}$/.test(mode.project)) refuse();
    const journal = readAdmission(mode.directory);
    if (!journal.config.projects.some(row => row.project === mode.project)) refuse();
    return Object.freeze({ ...mode });
  } catch {
    // Do not return file contents, private paths, or underlying filesystem errors.
    refuse();
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The installed entry supplies the fixed policy loader; configuration cannot name code. */
export function serveConfiguredHooks(file, loadPolicy) {
  let mode;
  try { mode = readHookConfiguration(file); }
  catch { console.error(message); }
  return serveHooks({ mode, loadPolicy: async () => {
    if (!mode) refuse();
    return await loadPolicy(mode);
  } });
}

/** The visible preparation server uses the same owner-controlled file as the hook server. */
export function serveConfiguredPreparations(file) {
  let options;
  try {
    options = readHookConfiguration(file);
    if (!options.observationsRoot) refuse();
  } catch {
    options = undefined;
    console.error(message);
  }
  // An invalid snapshot stays unavailable for this connection. No request can supply its paths.
  return servePreparations(options);
}
