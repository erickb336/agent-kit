// The shell parser of the sage hook: mvdan/sh (BSD-3-Clause, see LICENSE-mvdan-sh) in parser.wasm, built from parse.go
// by scripts/build-parser.mjs. Everything here is synchronous, because the hook's handle is: the module compiles on
// the first call, once per process, after its sha256 matches parser.wasm.sha256, and each call runs in a new instance
// (about 0.2 ms), so that a call that traps (a panic in the parser) leaves nothing behind for the next one.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** A longer line is refused unread. Claude Code asks the owner about any command line above 10,000 characters (T125 design). */
export const MAX_LENGTH = 10_000;
export const WASM = new URL("parser.wasm", import.meta.url);
export const RECORD = new URL("parser.wasm.sha256", import.meta.url);
export const RESTORE = "git checkout HEAD -- plugins/sage/hooks/parser/parser.wasm plugins/sage/hooks/parser/parser.wasm.sha256";

/**
 * The sha256 that parser.wasm.sha256 records, in the form that `shasum -a 256 parser.wasm` prints. Throws when the
 * file is missing or is not that form.
 */
export function recorded() {
  let text;
  try {
    text = readFileSync(RECORD, "utf8");
  } catch {
    throw new Error(`plugins/sage/hooks/parser/parser.wasm.sha256 is missing. Restore it from git: ${RESTORE}`);
  }
  const m = /^([0-9a-f]{64}) {2}parser\.wasm\n?$/.exec(text);
  if (!m) throw new Error(`plugins/sage/hooks/parser/parser.wasm.sha256 is not a valid hash record ("<64 hex digits>  parser.wasm", as shasum -a 256 prints it). Restore it from git: ${RESTORE}`);
  return m[1];
}

/** parser.wasm's bytes, when their sha256 is the recorded one. Throws otherwise, so that the hook fails closed. */
export function verifiedWasm() {
  const bytes = readFileSync(WASM);
  const sum = createHash("sha256").update(bytes).digest("hex");
  const want = recorded();
  if (sum !== want) {
    throw new Error(`plugins/sage/hooks/parser/parser.wasm differs from its recorded hash: its sha256 is ${sum}, and parser.wasm.sha256 records ${want}. The usual fix is to restore both from git: ${RESTORE}. After a change to parse.go, rebuild instead with npm run parser, which needs TinyGo 0.42.0 and Go 1.26.8 on PATH (see the README).`);
  }
  return bytes;
}

let module;

/** A new instance of the parser. TinyGo's WASI target imports five system calls; it gets no arguments and no files. */
function instance() {
  module ??= new WebAssembly.Module(verifiedWasm());
  let wasm;
  const view = () => new DataView(wasm.exports.memory.buffer);
  const zero = (...ptrs) => { for (const p of ptrs) view().setUint32(p, 0, true); return 0; };
  const wasi = {
    args_sizes_get: zero,
    args_get: () => 0,
    clock_time_get: (id, precision, out) => (view().setBigUint64(out, process.hrtime.bigint(), true), 0),
    random_get: (ptr, len) => (crypto.getRandomValues(new Uint8Array(wasm.exports.memory.buffer, ptr, len)), 0),
    fd_write: (fd, iovs, count, written) => {
      let n = 0;
      for (let i = 0; i < count; i++) n += view().getUint32(iovs + i * 8 + 4, true);
      view().setUint32(written, n, true);
      return 0;
    },
  };
  wasm = new WebAssembly.Instance(module, { wasi_snapshot_preview1: wasi });
  wasm.exports._initialize();
  return wasm;
}

const strings = (a) => Array.isArray(a) && a.every((s) => typeof s === "string");
const index = (i, n) => Number.isInteger(i) && i >= 0 && i < n;

/** Throws unless r is the parser's result: { error: string } or { commands: [...] } with each field of its type and each index in range. */
function checkShape(r) {
  if (typeof r?.error === "string" && Object.keys(r).length === 1) return;
  const list = r?.commands;
  const ok = Array.isArray(list) && Object.keys(r).length === 1 && list.every((c) =>
    c !== null && typeof c === "object" && strings(c.words) && strings(c.bodies) &&
    (c.host === null || (index(c.host.cmd, list.length) && Number.isInteger(c.host.index) && c.host.index >= -1)) &&
    (c.pipeTo === null || index(c.pipeTo, list.length)) &&
    [c.piped, c.grouped, c.writes].every((b) => typeof b === "boolean"));
  if (!ok) throw new Error("the parser gave a result of the wrong shape");
}

/**
 * The simple commands of a command line, read as zsh or bash: { words, bodies, host, piped, pipeTo, grouped, writes },
 * as shellCommands in sage-hook.mjs gives them (host is { cmd, index }; pipeTo and host.cmd are commands of the list).
 * A line with no command (empty, blanks, a comment, only a redirection) gives an empty list. Throws when the parser
 * cannot read the line, when it is longer than MAX_LENGTH, when it has a NUL byte, or when it nests deeper than the
 * parser's stack allows: the hook then fails closed.
 */
export function parseCommands(src, { zsh = false } = {}) {
  if (src.length > MAX_LENGTH) throw new Error(`a command line of more than ${MAX_LENGTH} characters`);
  if (src.includes("\0")) throw new Error("a NUL byte: a shell drops it, so the line that runs is not the line that was read");
  const result = parseRaw(src, { zsh });
  if (result.error) throw new Error(result.error);
  const commands = result.commands;
  for (const c of commands) {
    if (c.host) c.host.cmd = commands[c.host.cmd];
    c.pipeTo = c.pipeTo === null ? undefined : commands[c.pipeTo];
    if (!c.host) c.host = undefined;
  }
  return commands;
}

/** The parser's own result for src, with indexes in place of objects: { commands } or { error }. Throws when the parser stops or its result has the wrong shape. */
export function parseRaw(src, { zsh = false } = {}) {
  const { exports } = instance();
  const bytes = new TextEncoder().encode(src);
  const at = exports.alloc(bytes.length); // first: it can grow the memory, which detaches the old buffer
  new Uint8Array(exports.memory.buffer, at, bytes.length).set(bytes);
  let r;
  try {
    r = exports.parse(bytes.length, zsh ? 1 : 0);
  } catch (e) {
    throw new Error(`the parser stopped (${e.message}). A line that nests too deep for the parser's 1 MiB stack (target.json) does this: more than about 600 commands in one pipe or && chain, or more than about 300 nested substitutions`);
  }
  const result = JSON.parse(new TextDecoder().decode(new Uint8Array(exports.memory.buffer, Number(r >> 32n), Number(r & 0xffffffffn))));
  checkShape(result);
  return result;
}
