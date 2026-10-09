#!/usr/bin/env node
import { closeSync, constants, fstatSync, mkdirSync, lstatSync, statSync, openSync, readSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { boardView } from "../sage-core/index.mjs";
import { installBoard, writeLoginFile } from "./install.mjs";
import { createBoardServer } from "./server.mjs";

const parseJson = text => { try { return JSON.parse(text); } catch { throw new TypeError("board JSON is invalid"); } };
const boundedPath = path => { if (typeof path !== "string" || !isAbsolute(path) || path.length > 4096 || /[\p{Cc}\p{Cf}]/u.test(path)) throw new TypeError("use a bounded absolute path without control characters"); return resolve(path); };
function noLinkedParents(path) {
  const parts = resolve(path).split(sep).filter(Boolean); let current = sep;
  for (const part of parts.slice(0, -1)) {
    current = resolve(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new TypeError("board output parent must be an ordinary directory");
  }
}
function outsideRoots(file, sources) {
  for (const source of sources) {
    if (within(file, source.path) || process.platform === "darwin" && within(file.toLowerCase(), source.path.toLowerCase())) return false;
    const root = statSync(source.path, { throwIfNoEntry: false });
    if (!root) continue;
    let parent = dirname(file);
    while (true) {
      const stat = statSync(parent, { throwIfNoEntry: false });
      if (stat && stat.dev === root.dev && stat.ino === root.ino) return false;
      const next = dirname(parent); if (next === parent) break; parent = next;
    }
  }
  return true;
}
const within = (file, root) => { const part = relative(root, file); return part === "" || part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part); };
export function readBoardConfig(path) {
  path = boundedPath(path);
  noLinkedParents(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd); if (!stat.isFile() || stat.size > 65536) throw new TypeError("board config must be a regular file of at most 64 KiB");
    const buffer = Buffer.alloc(65537), count = readSync(fd, buffer, 0, buffer.length, 0);
    if (count !== stat.size || count > 65536) throw new TypeError("board config changed during the read");
    return validateBoardConfig(parseJson(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, count))), path);
  } finally { closeSync(fd); }
}
export function validateBoardConfig(config, configPath = null) {
  const allowed = ["version", "sources", "port", "allowedHosts", "secret", "pagesDir"];
  if (!config || config.version !== 1 || Object.keys(config).some(key => !allowed.includes(key)) || !Array.isArray(config.sources) || !config.sources.length) throw new TypeError("board config needs version 1 and explicit sources");
  const ids = new Set();
  const sources = config.sources.map(source => {
    if (!source || !/^[a-zA-Z0-9_-]{1,80}$/.test(source.id ?? "") || ids.has(source.id) || Object.keys(source).some(key => !["id", "label", "path", "provider"].includes(key))) throw new TypeError("board sources need distinct ids and known fields");
    ids.add(source.id); return { ...source, path: boundedPath(source.path) };
  });
  const port = config.port ?? 43123;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new TypeError("board port must be from 1024 to 65535");
  if (typeof config.secret !== "string" || !/^[a-zA-Z0-9_-]{43,128}$/.test(config.secret)) throw new TypeError("board secret must hold at least 32 random bytes as base64url");
  if (!Array.isArray(config.allowedHosts ?? []) || (config.allowedHosts ?? []).some(host => typeof host !== "string" || host.length > 255)) throw new TypeError("allowedHosts must be a bounded list of exact host names");
  const pagesDir = config.pagesDir ? boundedPath(config.pagesDir) : null;
  if (configPath && !outsideRoots(resolve(configPath), sources) || pagesDir && !outsideRoots(pagesDir, sources)) throw new TypeError("board config and exported pages must stay outside logbook roots");
  return { version: 1, sources, port, allowedHosts: config.allowedHosts ?? [], secret: config.secret, ...(pagesDir ? { pagesDir } : {}) };
}
export function createBoardConfig(path, { sources, port = 43123, allowedHosts = [], pagesDir } = {}) {
  path = boundedPath(path);
  const config = validateBoardConfig({ version: 1, sources, port, allowedHosts, secret: randomBytes(32).toString("base64url"), ...(pagesDir ? { pagesDir } : {}) }, path);
  noLinkedParents(path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return config;
}
function parse(argv) {
  if (argv[0] !== "board") throw new TypeError("use: sage board [this|all|project|Tn] --config <absolute path> [--serve|--html --out <absolute path>|--status]");
  const options = {}, values = [];
  for (let i = 1; i < argv.length; i++) {
    const value = argv[i];
    if (!value.startsWith("--")) { values.push(value); continue; }
    const key = value.slice(2);
    if (!["config", "out", "project", "scope", "serve", "html", "status", "setup", "sources", "pages", "port", "allowed-hosts", "install", "install-dir", "login-file"].includes(key) || Object.hasOwn(options, key)) throw new TypeError("unknown or repeated board option");
    if (["serve", "html", "status", "setup", "install"].includes(key)) options[key] = true;
    else { if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new TypeError(`--${key} needs a value`); options[key] = argv[++i]; }
  }
  if (values.length > 1 || [options.serve, options.html, options.status, options.setup, options.install].filter(Boolean).length > 1 || !options.config) throw new TypeError("board needs one scope, one format and --config");
  return { options, value: values[0] ?? "all" };
}
export async function runBoardCli(argv, { output = line => process.stdout.write(`${line}\n`) } = {}) {
  const { options, value } = parse(argv);
  if (options.scope && (options.serve || options.setup || options.install)) throw new TypeError("--scope is only for a task lookup");
  if (options.setup) {
    if (value !== "all" || !options.sources || options.sources.length > 65536 || options.project || options.out || options["install-dir"] || options["login-file"]) throw new TypeError("setup needs --sources JSON and --config only, with optional port, pages and allowed-hosts");
    if (options.port && !/^[1-9]\d*$/.test(options.port)) throw new TypeError("port must be a positive integer");
    createBoardConfig(options.config, { sources: parseJson(options.sources), port: options.port ? Number(options.port) : 43123, pagesDir: options.pages, allowedHosts: options["allowed-hosts"] ? parseJson(options["allowed-hosts"]) : [] });
    output(`Board config created: ${boundedPath(options.config)}. The sign-in password stays in this private file.`); return null;
  }
  if (options.sources || options.pages || options.port || options["allowed-hosts"]) throw new TypeError("source and service settings require --setup");
  const config = readBoardConfig(options.config);
  if (options.install) {
    if (value !== "all" || !options["install-dir"] || options.project || options.out) throw new TypeError("install needs --install-dir and --config");
    const installDir = boundedPath(options["install-dir"]);
    if (!outsideRoots(installDir, config.sources)) throw new TypeError("installation must stay outside logbook roots");
    const plistPath = options["login-file"] ? boundedPath(options["login-file"]) : null;
    if (plistPath && !outsideRoots(plistPath, config.sources)) throw new TypeError("login file must stay outside logbook roots");
    if (plistPath) noLinkedParents(plistPath);
    const installed = installBoard({ installDir, configPath: boundedPath(options.config), nodePath: process.execPath });
    output(`Installed board command: ${installed.cliPath}`);
    if (plistPath) {
      writeLoginFile({ plistPath, installDir, configPath: boundedPath(options.config), nodePath: process.execPath });
      output(`Login file created: ${plistPath}. Start it with launchctl when ready.`);
    }
    return null;
  }
  if (options["install-dir"] || options["login-file"]) throw new TypeError("installation paths require --install");
  if (options.serve) {
    if (value !== "all" || options.out || options.project) throw new TypeError("server uses all configured sources; no output or project option");
    const server = createBoardServer(config); await server.start();
    output(`Sage board: http://127.0.0.1:${config.port}/ · sign in as sage with the password in the config.`);
    return server;
  }
  const taskId = /^T[1-9]\d*$/.test(value) ? value : null;
  if (options.scope && !taskId) throw new TypeError("--scope selects the exact project of a task lookup");
  const format = options.html ? "html" : options.status ? "status" : taskId ? "task" : "chat";
  const body = boardView({ sources: config.sources, scope: taskId ? options.scope ?? "this" : value, project: options.project, taskId, format });
  if (options.html) {
    const file = boundedPath(options.out ?? (config.pagesDir ? resolve(config.pagesDir, `board-${Date.now()}-${randomBytes(6).toString("hex")}.html`) : ""));
    if (!file.endsWith(".html") || !outsideRoots(file, config.sources)) throw new TypeError("HTML output must be an .html artifact outside logbook roots");
    noLinkedParents(file);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, body, { flag: "wx", mode: 0o600 }); output(file);
  } else { if (options.out) throw new TypeError("--out needs --html"); output(body); }
  return null;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const server = await runBoardCli(process.argv.slice(2));
    if (server) { const stop = () => { server.close().then(() => { process.exitCode = 0; }).catch(() => { process.exitCode = 1; }); }; process.once("SIGINT", stop); process.once("SIGTERM", stop); }
  } catch (error) { process.stderr.write(`sage board: ${error.message}\n`); process.exitCode = 1; }
}
