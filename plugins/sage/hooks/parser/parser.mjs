// The shell parser of the sage hook: mvdan/sh (BSD-3-Clause, see LICENSE-mvdan-sh) in parser.wasm, built from parse.go
// by scripts/build-parser.mjs. Everything here is synchronous, because the hook's handle is: the module compiles on
// the first call, once per process, and each call runs in the same instance.
import { readFileSync } from "node:fs";

/** A longer line is refused unread. Claude Code asks the owner about any command line above 10,000 characters (T125 design). */
export const MAX_LENGTH = 10_000;

let wasm;

/** The parser's instance. Go's WASI target needs a few system calls; it gets no arguments, no environment and no files. */
function instance() {
  if (wasm) return wasm;
  const module = new WebAssembly.Module(readFileSync(new URL("parser.wasm", import.meta.url)));
  const view = () => new DataView(wasm.exports.memory.buffer);
  const zero = (...ptrs) => { for (const p of ptrs) view().setUint32(p, 0, true); return 0; };
  const sys = {
    args_sizes_get: zero,
    environ_sizes_get: zero,
    args_get: () => 0,
    environ_get: () => 0,
    clock_time_get: (id, precision, out) => (view().setBigUint64(out, process.hrtime.bigint(), true), 0),
    random_get: (ptr, len) => (crypto.getRandomValues(new Uint8Array(wasm.exports.memory.buffer, ptr, len)), 0),
    fd_write: (fd, iovs, count, written) => {
      let n = 0;
      for (let i = 0; i < count; i++) n += view().getUint32(iovs + i * 8 + 4, true);
      view().setUint32(written, n, true);
      return 0;
    },
    sched_yield: () => 0,
    proc_exit: (code) => { throw new Error(`the parser exited with code ${code}`); },
  };
  const EBADF = 8; // every other call is about a file, and there are none
  const imports = Object.fromEntries(WebAssembly.Module.imports(module).map(({ name }) => [name, sys[name] ?? (() => EBADF)]));
  wasm = new WebAssembly.Instance(module, { wasi_snapshot_preview1: imports });
  wasm.exports._initialize();
  return wasm;
}

/**
 * The simple commands of a command line, read as zsh or bash: { words, bodies, host, piped, pipeTo, grouped, writes },
 * as shellCommands in sage-hook.mjs gives them (host is { cmd, index }; pipeTo and host.cmd are commands of the list).
 * Throws when the parser cannot read the line, or when it is longer than MAX_LENGTH: the hook then fails closed.
 */
export function parseCommands(src, { zsh = false } = {}) {
  if (src.length > MAX_LENGTH) throw new Error(`a command line of more than ${MAX_LENGTH} characters`);
  const { exports } = instance();
  const bytes = new TextEncoder().encode(src);
  new Uint8Array(exports.memory.buffer, exports.alloc(bytes.length), bytes.length).set(bytes);
  const r = exports.parse(bytes.length, zsh ? 1 : 0);
  const result = JSON.parse(new TextDecoder().decode(new Uint8Array(exports.memory.buffer, Number(r >> 32n), Number(r & 0xffffffffn))));
  if (result.error) throw new Error(result.error);
  const commands = result.commands;
  for (const c of commands) {
    if (c.host) c.host.cmd = commands[c.host.cmd];
    c.pipeTo = c.pipeTo === null ? undefined : commands[c.pipeTo];
    if (!c.host) c.host = undefined;
  }
  return commands;
}
