import "./test-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStateTool } from "../packages/sage-core/index.mjs";
import { createBoardConfig, readBoardConfig, runBoardCli } from "../packages/sage-board/cli.mjs";
function fixture(t) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "sage-board-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "logbooks"), config = join(dir, "settings/board.json");
  const tool = createStateTool({ defaultRoot: () => root });
  tool.sage(["init", "--project", dir], { ...process.env, SAGE_HOME: root });
  tool.sage(["task", "add", "--title", "Sample CLI task", "--size", "small", "--project", dir], { ...process.env, SAGE_HOME: root });
  const value = createBoardConfig(config, { sources: [{ id: "sample", path: root }], pagesDir: join(dir, "pages") });
  return { dir, root, config, value };
}
test("standalone config has a generated secret, private mode and no logbook output path", t => {
  const { config, root, value } = fixture(t);
  assert.equal(value.secret.length, 43);
  assert.throws(() => createBoardConfig(join(root, "low-port.json"), { sources: [{ id: "sample", path: root }], port: 1023 }), /1024 to 65535/);
  assert.equal(statSync(config).mode & 0o777, 0o600);
  assert.deepEqual(readBoardConfig(config), value);
  assert.throws(() => createBoardConfig(join(root, "settings.json"), { sources: [{ id: "sample", path: root }] }), /outside logbook roots/);
  assert.throws(() => createBoardConfig(config, { sources: [{ id: "sample", path: root }] }), /EEXIST/);
});
test("standalone HTML export includes task detail, prints its path and does not overwrite", async t => {
  const { dir, config, value } = fixture(t), lines = [];
  await runBoardCli(["board", "all", "--html", "--config", config], { output: line => lines.push(line) });
  const file = lines[0];
  assert.ok(file.startsWith(join(dir, "pages/board-")));
  const html = readFileSync(file, "utf8");
  assert.ok(html.includes("Sample CLI task")); assert.ok(html.includes("<h3>Evidence</h3>"));
  assert.ok(!html.includes(value.secret));
  await runBoardCli(["board", "all", "--html", "--config", config], { output: line => lines.push(line) });
  assert.notEqual(lines[1], file);
  assert.ok(existsSync(file) && existsSync(lines[1]));
  await assert.rejects(runBoardCli(["board", "all", "--html", "--out", file, "--config", config], { output: () => {} }), /EEXIST/);
});
test("standalone refuses linked output parents and exposes status without a server", async t => {
  const { dir, root, config } = fixture(t), lines = [];
  const link = join(dir, "linked-pages"); symlinkSync(root, link);
  await assert.rejects(runBoardCli(["board", "all", "--html", "--out", join(link, "board.html"), "--config", config]), TypeError);
  assert.equal(existsSync(join(root, "board.html")), false);
  const outside = join(dir, "outside"), outsideLink = join(dir, "outside-link"); mkdirSync(outside); symlinkSync(outside, outsideLink);
  await assert.rejects(runBoardCli(["board", "all", "--html", "--out", join(outsideLink, "board.html"), "--config", config]), TypeError);
  assert.equal(existsSync(join(outside, "board.html")), false);
  await runBoardCli(["board", "all", "--status", "--config", config], { output: line => lines.push(line) });
  assert.ok(lines[0].includes("framed 1"));
  await assert.rejects(runBoardCli(["board", "--config", config, "--config", config]), /repeated/);
});

test("standalone setup and installation stay explicit, with no service operation or secret output", async t => {
  const { dir, root } = fixture(t), config = join(dir, "extra/board.json"), lines = [];
  await runBoardCli(["board", "--setup", "--config", config, "--sources", JSON.stringify([{ id: "sample", path: root }])], { output: line => lines.push(line) });
  const secret = readBoardConfig(config).secret;
  const install = join(dir, "installed"), plist = join(dir, "login/board.plist");
  await assert.rejects(runBoardCli(["board", "--install", "--install-dir", install, "--login-file", join(root, "board.plist"), "--config", config]), /outside logbook roots/);
  assert.equal(existsSync(install), false);
  await runBoardCli(["board", "--install", "--install-dir", install, "--login-file", plist, "--config", config], { output: line => lines.push(line) });
  assert.ok(readFileSync(join(install, "packages/sage-board/cli.mjs"), "utf8").includes("runBoardCli"));
  assert.ok(readFileSync(plist, "utf8").includes("dev.sage.board"));
  assert.ok(!lines.join("\n").includes(secret));
  assert.ok(!readFileSync(plist, "utf8").includes(secret));
});


test("malformed settings and setup JSON never expose input in diagnostics", async t => {
  const { dir } = fixture(t), malformed = join(dir, "bad.json"), privateText = "SAMPLE_SECRET_DO_NOT_LOG";
  writeFileSync(malformed, privateText);
  assert.throws(() => readBoardConfig(malformed), error => error.message === "board JSON is invalid" && !error.message.includes(privateText));
  await assert.rejects(runBoardCli(["board", "--setup", "--config", join(dir, "unused.json"), "--sources", privateText]), { message: "board JSON is invalid" });
  assert.equal(existsSync(join(dir, "unused.json")), false);
});


test("settings reads reject linked ancestors and service commands reject ignored task scope", async t => {
  const { dir, config } = fixture(t), link = join(dir, "settings-link");
  symlinkSync(join(dir, "settings"), link);
  assert.throws(() => readBoardConfig(join(link, "board.json")), /ordinary directory/);
  await assert.rejects(runBoardCli(["board", "--serve", "--scope", "sample/project", "--config", config]), /only for a task lookup/);
});
