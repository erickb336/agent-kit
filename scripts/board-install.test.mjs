import "./test-env.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const INSTALLER = new URL("../packages/sage-board/install.mjs", import.meta.url);
const xmlText = value => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
async function fixture() {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "sage-board-install-")));
  const source = join(temp, "source"), packages = join(source, "packages"), board = join(packages, "sage-board"), core = join(packages, "sage-core");
  mkdirSync(board, { recursive: true }); mkdirSync(core);
  writeFileSync(join(board, "install.mjs"), readFileSync(INSTALLER));
  writeFileSync(join(board, "package.json"), '{"type":"module"}');
  writeFileSync(join(board, "cli.mjs"), 'import { sample } from "../sage-core/index.mjs"; process.stdout.write(sample);');
  writeFileSync(join(core, "index.mjs"), 'export const sample = "installed fixture board";');
  mkdirSync(join(packages, "unrelated-provider"));
  writeFileSync(join(packages, "unrelated-provider", "private.txt"), "not board input");
  const configPath = join(temp, "config.json"), installDir = join(temp, "stable", "board"), nodePath = realpathSync(process.execPath);
  writeFileSync(configPath, JSON.stringify({ secret: "fixture-secret-kept-in-config" }));
  const api = await import(pathToFileURL(join(board, "install.mjs")).href);
  return { temp, source, packages, board, core, configPath, installDir, nodePath, api, options: { configPath, installDir, nodePath } };
}

test("board install: stable copy runs after its source is gone and excludes other packages", async () => {
  const f = await fixture();
  const result = f.api.installBoard(f.options);
  assert.equal(result.cliPath, join(f.installDir, "packages", "sage-board", "cli.mjs"));
  assert.deepEqual(readdirSync(join(f.installDir, "packages")).sort(), ["sage-board", "sage-core"]);
  assert.equal(readFileSync(join(f.installDir, "packages", "sage-core", "index.mjs"), "utf8"), readFileSync(join(f.core, "index.mjs"), "utf8"));
  rmSync(f.source, { recursive: true });
  const out = spawnSync(f.nodePath, [result.cliPath, "board", "--status"], { encoding: "utf8", timeout: 60_000 });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stdout, "installed fixture board");
  assert.equal(existsSync(join(f.temp, "Library")), false, "installation does not create a login artifact");
});

test("board install: plist arguments are exact, XML-escaped and contain no configuration secret", async () => {
  const f = await fixture(), special = "<&\"'>";
  const configPath = join(f.temp, `config${special}.json`), installDir = join(f.temp, `stable${special}`);
  writeFileSync(configPath, '{"secret":"fixture-secret-kept-in-config"}');
  const { cliPath, plist } = f.api.installBoard({ ...f.options, configPath, installDir });
  const argumentsText = plist.match(/<array>([\s\S]*?)<\/array>/)[1];
  assert.deepEqual([...argumentsText.matchAll(/<string>(.*?)<\/string>/g)].map(match => match[1]), [f.nodePath, cliPath, "board", "--serve", "--config", configPath].map(xmlText));
  assert.match(plist, /<key>Label<\/key><string>dev\.sage\.board<\/string>/);
  assert.ok(plist.includes(`<key>WorkingDirectory</key><string>${xmlText(installDir)}</string>`));
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.equal(plist.includes("fixture-secret-kept-in-config"), false);
});

test("board install: destination and source links refuse without replacing files", async () => {
  const f = await fixture();
  mkdirSync(f.installDir, { recursive: true });
  writeFileSync(join(f.installDir, "keep"), "existing installation");
  assert.throws(() => f.api.installBoard(f.options), /absent or empty/);
  assert.equal(readFileSync(join(f.installDir, "keep"), "utf8"), "existing installation");
  const linked = join(f.temp, "linked");
  symlinkSync(f.installDir, linked);
  for (const installDir of [linked, join(linked, "new")]) assert.throws(() => f.api.installBoard({ ...f.options, installDir }), /symbolic link/);
  const sourceLink = join(f.core, "external.mjs");
  symlinkSync(f.configPath, sourceLink);
  const fresh = join(f.temp, "fresh");
  assert.throws(() => f.api.installBoard({ ...f.options, installDir: fresh }), /symbolic link/);
  assert.equal(existsSync(fresh), false, "source inspection finishes before destination changes");
  rmSync(sourceLink);
  const outside = join(f.temp, "outside"); mkdirSync(outside);
  symlinkSync(outside, join(f.core, "linked-folder"));
  assert.throws(() => f.api.installBoard({ ...f.options, installDir: fresh }), /symbolic link/);
  assert.deepEqual(readdirSync(outside), []);
});

test("board install: path inputs refuse malformed, linked, missing and unstable locations", async () => {
  const f = await fixture();
  for (const installDir of ["relative", f.installDir + "/../other", f.installDir + "\n", f.installDir + "\ufffe", f.installDir + "\ud800", "/" + "x".repeat(4096), join(f.packages, "inside"), join(f.temp, "plugins", "cache", "board"), join(f.temp, "plugins", "Cache", "board")]) {
    assert.throws(() => f.api.installBoard({ ...f.options, installDir }));
  }
  for (const name of ["configPath", "nodePath"]) {
    assert.throws(() => f.api.installBoard({ ...f.options, [name]: join(f.temp, "missing") }));
    assert.throws(() => f.api.installBoard({ ...f.options, [name]: f.temp }), /not a file/);
    const link = join(f.temp, `${name}-link`); symlinkSync(f.options[name], link);
    assert.throws(() => f.api.installBoard({ ...f.options, [name]: link }), /symbolic link/);
  }
  const foldedPackages = join(f.source, "PACKAGES");
  if (existsSync(foldedPackages)) assert.throws(() => f.api.installBoard({ ...f.options, installDir: join(foldedPackages, "sage-core", "stable") }), /outside source/);
  assert.equal(existsSync(f.installDir), false);
});

test("board install: explicit login artifact is private, exclusive and works from installed package", async () => {
  const f = await fixture(), installed = f.api.installBoard(f.options);
  const plistPath = join(f.temp, "Library", "LaunchAgents", "dev.sage.board.plist");
  const local = await import(pathToFileURL(join(f.installDir, "packages", "sage-board", "install.mjs")).href);
  assert.deepEqual(local.writeLoginFile({ ...f.options, plistPath }), { plistPath, cliPath: installed.cliPath });
  assert.equal(readFileSync(plistPath, "utf8"), installed.plist);
  assert.equal(statSync(plistPath).mode & 0o777, 0o600);
  assert.throws(() => local.writeLoginFile({ ...f.options, plistPath }), /already exists/);
  assert.equal(readFileSync(plistPath, "utf8"), installed.plist);
  const link = join(f.temp, "login-link"); symlinkSync(plistPath, link);
  assert.throws(() => local.writeLoginFile({ ...f.options, plistPath: link }), /symbolic link/);
  const parent = join(f.temp, "parent-link"); symlinkSync(join(f.temp, "Library"), parent);
  assert.throws(() => local.writeLoginFile({ ...f.options, plistPath: join(parent, "new.plist") }), /symbolic link/);
  rmSync(installed.cliPath);
  assert.throws(() => local.writeLoginFile({ ...f.options, plistPath: join(f.temp, "missing-cli.plist") }), /ENOENT/);
  assert.equal(existsSync(join(f.temp, "missing-cli.plist")), false);
});
