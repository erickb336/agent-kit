// Builds the sage hook's shell parser, plugins/sage/hooks/parser/parser.wasm, from parse.go and the pinned mvdan/sh
// (go.mod, go.sum) with TinyGo, and records its sha256 in parser.wasm.sha256. It needs the pinned TinyGo on PATH, and
// the Go of go.mod's toolchain line as the go on PATH (TinyGo uses it for the standard library). `npm run check`
// rebuilds the parser when both are there and compares, so a person can verify the binary file from its sources.
// Run `npm run parser` after a change to the parser's sources.
//
// Why TinyGo: a standard Go WASM file is about 4 MB, and a new Node process spends 39 to 68 ms of CPU to compile it
// and start Go's runtime; the TinyGo file is about 0.46 MB and takes about 10 ms. The hook starts a new process for
// each tool call.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT } from "./build.mjs";

export const PARSER = join(ROOT, "plugins/sage/hooks/parser");
export const WASM = join(PARSER, "parser.wasm");
export const RECORD = join(PARSER, "parser.wasm.sha256");
export const TINYGO = "0.42.0";

export const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
/** The sha256 that parser.wasm.sha256 records ("<sha256>  parser.wasm", as shasum -a 256 prints it). */
export const recorded = () => readFileSync(RECORD, "utf8").split(/\s+/)[0];
/** The toolchains that the build needs, as `tinygo version` names them: the pinned TinyGo and go.mod's toolchain line. */
export const pinned = () => `tinygo ${TINYGO} with ${/^toolchain (go\S+)$/m.exec(readFileSync(join(PARSER, "go.mod"), "utf8"))[1]}`;

/** The toolchains on PATH in the same form, or undefined when TinyGo or its Go is missing. */
export function onPath() {
  try {
    const v = execFileSync("tinygo", ["version"], { encoding: "utf8", env: { ...process.env, GOTOOLCHAIN: "local" }, stdio: ["ignore", "pipe", "ignore"] });
    const m = /^tinygo version (\S+) .*using go version (go\S+) /m.exec(v);
    return m ? `tinygo ${m[1]} with ${m[2]}` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Builds parser.wasm into out and gives its sha256. TinyGo puts no build path or build id in the file; -no-debug
 * leaves out DWARF. The scheduler is none: the parser starts no goroutine, and the default scheduler needs Binaryen's
 * wasm-opt. TinyGo always runs wasm-opt on a WASM file, so the build gives it a stand-in that copies the file
 * unchanged: Binaryen is not a pinned tool here, and the file is fast enough without its optimizations.
 */
export function buildParser(out) {
  const dir = mkdtempSync(join(tmpdir(), "sage-wasm-opt-"));
  try {
    const wasmOpt = join(dir, "wasm-opt");
    writeFileSync(wasmOpt, '#!/bin/sh\n# tinygo calls: wasm-opt --version, and wasm-opt -Oz -g <in> --output <out>\n[ "$1" = --version ] && { echo "wasm-opt version 102"; exit 0; }\nexec cp "$3" "$5"\n');
    chmodSync(wasmOpt, 0o755);
    const env = { ...process.env, CGO_ENABLED: "0", GOFLAGS: "-mod=readonly", GOTOOLCHAIN: "local", WASMOPT: wasmOpt };
    execFileSync("tinygo", ["build", "-target=wasip1", "-buildmode=c-shared", "-scheduler=none", "-no-debug", "-o", out, "."], { cwd: PARSER, env, stdio: "inherit" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return sha256(out);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const tools = onPath();
  if (tools !== pinned()) {
    console.error(`✗ the parser builds with ${pinned()} (TINYGO in this file, and go.mod's toolchain line); PATH has ${tools ?? "no tinygo"}`);
    process.exit(1);
  }
  const sum = buildParser(WASM);
  writeFileSync(RECORD, `${sum}  parser.wasm\n`);
  console.log(`✓ parser.wasm: ${readFileSync(WASM).length} bytes, sha256 ${sum}`);
}
