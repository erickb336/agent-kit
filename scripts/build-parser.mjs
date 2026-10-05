// Builds the sage hook's shell parser, plugins/sage/hooks/parser/parser.wasm, from parse.go and the pinned mvdan/sh
// (go.mod, go.sum), and records its sha256 in parser.wasm.sha256. It needs the Go of go.mod's toolchain line on PATH;
// `npm run check` rebuilds it with that Go and compares, so a person can verify the binary file from its sources.
// Run `npm run parser` after a change to the parser's sources.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT } from "./build.mjs";

export const PARSER = join(ROOT, "plugins/sage/hooks/parser");
export const WASM = join(PARSER, "parser.wasm");
export const RECORD = join(PARSER, "parser.wasm.sha256");

export const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
/** The sha256 that parser.wasm.sha256 records ("<sha256>  parser.wasm", as shasum -a 256 prints it). */
export const recorded = () => readFileSync(RECORD, "utf8").split(/\s+/)[0];
/** The Go that the build needs: go.mod's toolchain line. */
export const pinnedGo = () => /^toolchain (go\S+)$/m.exec(readFileSync(join(PARSER, "go.mod"), "utf8"))[1];

/** The version of the go on PATH, or undefined when there is none. */
export function goOnPath() {
  try {
    return execFileSync("go", ["env", "GOVERSION"], { encoding: "utf8", env: { ...process.env, GOTOOLCHAIN: "local" }, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

/** Builds parser.wasm into out, with no build path, build id or symbols in it, and gives its sha256. */
export function buildParser(out) {
  const env = { ...process.env, GOOS: "wasip1", GOARCH: "wasm", CGO_ENABLED: "0", GOFLAGS: "-mod=readonly", GOTOOLCHAIN: "local" };
  execFileSync("go", ["build", "-buildmode=c-shared", "-trimpath", "-ldflags=-s -w -buildid=", "-o", out, "."], { cwd: PARSER, env, stdio: "inherit" });
  return sha256(out);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const go = goOnPath();
  if (go !== pinnedGo()) {
    console.error(`✗ the parser builds with ${pinnedGo()} (go.mod's toolchain line); the go on PATH is ${go ?? "missing"}`);
    process.exit(1);
  }
  const sum = buildParser(WASM);
  writeFileSync(RECORD, `${sum}  parser.wasm\n`);
  console.log(`✓ parser.wasm: ${readFileSync(WASM).length} bytes, sha256 ${sum}`);
}
