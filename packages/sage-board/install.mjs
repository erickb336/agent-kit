// Optional local files only. The caller selects stable paths and starts launchd separately.
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const packages = dirname(dirname(fileURLToPath(import.meta.url)));
const MAX_BYTES = 64 * 1024 * 1024;
const refuse = reason => { throw new TypeError(`board install: ${reason}`); };

function absolute(value, name) {
  if (typeof value !== "string" || Buffer.byteLength(value) > 4096 || !isAbsolute(value) || value !== resolve(value) || /[\p{Cc}\p{Cf}]/u.test(value) || value.includes("\\") || [...value].some(char => { const cp = char.codePointAt(0); return cp >= 0xd800 && cp <= 0xdfff || cp === 0xfffe || cp === 0xffff; })) refuse(`${name} needs a bounded absolute path without controls`);
  return value;
}

// Check every existing component; a missing final file does not make a linked parent safe.
function inspect(path, name, kind, missing = false) {
  const root = parse(path).root, parts = relative(root, path).split(sep).filter(Boolean);
  let cursor = root, result;
  for (const [index, part] of parts.entries()) {
    cursor = join(cursor, part);
    try { result = lstatSync(cursor); }
    catch (error) { if (error.code === "ENOENT" && missing) return; throw error; }
    if (result.isSymbolicLink()) refuse(`${name} must not use a symbolic link`);
    if (index < parts.length - 1 && !result.isDirectory()) refuse(`${name} parent is not a directory`);
  }
  result ??= lstatSync(root);
  if (kind === "file" && !result.isFile() || kind === "directory" && !result.isDirectory()) refuse(`${name} is not a ${kind}`);
  return result;
}

function directory(path) {
  const root = parse(path).root;
  let cursor = root;
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    try { mkdirSync(cursor, { mode: 0o700 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    inspect(cursor, "destination", "directory");
  }
}

// Directory identity handles differently cased paths without assuming a filesystem's case rules.
function containsDirectory(parent, child) {
  let identity;
  try { identity = lstatSync(parent); }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
  for (let cursor = child;; cursor = dirname(cursor)) {
    try {
      const entry = lstatSync(cursor);
      if (entry.dev === identity.dev && entry.ino === identity.ino) return true;
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (dirname(cursor) === cursor) return false;
  }
}

function paths({ installDir, configPath, nodePath } = {}, installed = false) {
  absolute(installDir, "installDir"); absolute(configPath, "configPath"); absolute(nodePath, "nodePath");
  inspect(installDir, "installDir", "directory", !installed);
  if ((!installed && (containsDirectory(packages, installDir) || containsDirectory(installDir, packages))) || /(?:^|\/)plugins\/(?:cache|marketplaces)(?:\/|$)/i.test(installDir)) refuse("installDir must be outside source packages and plugin caches");
  inspect(configPath, "configPath", "file"); inspect(nodePath, "nodePath", "file");
  const cliPath = join(installDir, "packages", "sage-board", "cli.mjs");
  if (installed) inspect(cliPath, "installed CLI", "file");
  return { installDir, configPath, nodePath, cliPath };
}

const xml = value => String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]);
function plistFor({ installDir, configPath, nodePath, cliPath }) {
  const args = [nodePath, cliPath, "board", "--serve", "--config", configPath];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key><string>dev.sage.board</string>\n  <key>ProgramArguments</key>\n  <array>${args.map(arg => `\n    <string>${xml(arg)}</string>`).join("")}\n  </array>\n  <key>WorkingDirectory</key><string>${xml(installDir)}</string>\n  <key>RunAtLoad</key><true/>\n</dict>\n</plist>\n`;
}

function packageFiles() {
  const files = [], folders = [];
  let bytes = 0;
  function walk(path, depth = 0) {
    if (depth > 32 || files.length + folders.length >= 4096) refuse("source package exceeds the copy limit");
    const stat = inspect(path, "source package", undefined);
    const name = relative(packages, path);
    if (stat.isDirectory()) {
      folders.push(name);
      for (const entry of readdirSync(path).sort()) walk(join(path, entry), depth + 1);
    } else {
      if (!stat.isFile() || stat.size > MAX_BYTES - bytes) refuse("source package must contain bounded regular files");
      const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
      try {
        const opened = fstatSync(fd);
        if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) refuse("source package changed during the copy");
        const buffer = Buffer.alloc(stat.size + 1);
        let count = 0, read;
        while (count < buffer.length && (read = readSync(fd, buffer, count, buffer.length - count, null)) > 0) count += read;
        const after = fstatSync(fd);
        if (count !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) refuse("source package changed during the copy");
        bytes += count;
        files.push({ name, content: buffer.subarray(0, count) });
      } finally { closeSync(fd); }
    }
  }
  for (const name of ["sage-board", "sage-core"]) walk(join(packages, name));
  if (!files.some(file => file.name === join("sage-board", "cli.mjs"))) refuse("source board CLI is missing");
  return { files, folders };
}

/** Copy provider-neutral packages into an explicit stable directory. No file is overwritten or removed. */
export function installBoard(options) {
  const checked = paths(options);
  if (inspect(checked.installDir, "installDir", "directory", true) && readdirSync(checked.installDir).length) refuse("installDir must be absent or empty");
  const { files, folders } = packageFiles();
  directory(checked.installDir);
  const target = join(checked.installDir, "packages");
  mkdirSync(target, { mode: 0o700 });
  for (const name of folders) { inspect(dirname(join(target, name)), "destination", "directory"); mkdirSync(join(target, name), { mode: 0o700 }); }
  for (const { name, content } of files) {
    inspect(dirname(join(target, name)), "destination", "directory");
    writeFileSync(join(target, name), content, { flag: "wx", mode: 0o600 });
  }
  return { cliPath: checked.cliPath, plist: plistFor(checked) };
}

/** Write the requested per-user login artifact. Loading or starting it is a separate owner action. */
export function writeLoginFile({ plistPath, ...options } = {}) {
  absolute(plistPath, "plistPath");
  const checked = paths(options, true);
  if (inspect(plistPath, "plistPath", "file", true)) refuse("plistPath already exists");
  directory(dirname(plistPath));
  writeFileSync(plistPath, plistFor(checked), { flag: "wx", mode: 0o600 });
  return { plistPath, cliPath: checked.cliPath };
}
