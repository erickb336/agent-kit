// Runs the pstack sync as the weekly workflow does: against a fake upstream git repository, in a copy of the kit's
// layout, with GITHUB_OUTPUT set.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fingerprint } from "./sync-pstack.mjs";

const SYNC = fileURLToPath(new URL("./sync-pstack.mjs", import.meta.url));
const principle = (id, text) => `---\nname: principle-${id}\ndescription: "Apply when ${id}."\ndisable-model-invocation: true\n---\n# ${id}\n\n${text}\n`;

function setup() {
  const up = mkdtempSync(join(tmpdir(), "pstack-up-"));
  const root = mkdtempSync(join(tmpdir(), "pstack-root-"));
  const git = (...a) => execFileSync("git", ["-C", up, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" });
  const put = (path, text) => {
    mkdirSync(dirname(join(up, "pstack", path)), { recursive: true });
    writeFileSync(join(up, "pstack", path), text);
  };
  const release = (version, files) => {
    put(".cursor-plugin/plugin.json", JSON.stringify({ version }));
    for (const [path, text] of Object.entries(files)) put(path, text);
    git("add", "-A");
    git("commit", "-qm", version);
  };
  git("init", "-q", "-b", "main");
  mkdirSync(join(root, "principles"));
  mkdirSync(join(root, "upstream"));
  writeFileSync(join(root, "upstream/pstack.json"), JSON.stringify({ repo: "x/plugins", path: "pstack", include: ["LICENSE", "skills/principle-*/SKILL.md"] }));
  const run = () => {
    const out = join(root, "github-output");
    rmSync(out, { force: true });
    const r = spawnSync("node", [SYNC, "--from", up], { encoding: "utf8", env: { ...process.env, PSTACK_SYNC_ROOT: root, GITHUB_OUTPUT: out } });
    assert.equal(r.status, 0, r.stderr);
    return { text: r.stdout, output: readFileSync(out, "utf8") };
  };
  return { root, release, run };
}

test("the first sync takes only the included files, and says so", () => {
  const s = setup();
  s.release("1.0.0", { LICENSE: "MIT License\n", "skills/principle-alpha/SKILL.md": principle("alpha", "v1"), "skills/poteto-mode/SKILL.md": "a mode" });
  const r = s.run();
  assert.match(r.text, /^pstack none → 1\.0\.0 \(x\/plugins [0-9a-f]{7}\)\nadded 2 · changed 0 · removed 0 · overrides to review 0/);
  assert.equal(r.output, "changed=true\ntouched=0\nversion=1.0.0\n");
  assert.ok(existsSync(join(s.root, "upstream/pstack/skills/principle-alpha/SKILL.md")));
  assert.equal(existsSync(join(s.root, "upstream/pstack/skills/poteto-mode")), false, "pstack's modes stay out");
  assert.match(readFileSync(join(s.root, "upstream/pstack.json"), "utf8"), /"version": "1\.0\.0"/);
});

test("an upstream change under an override is flagged for review; other changes just flow", () => {
  const s = setup();
  s.release("1.0.0", { LICENSE: "MIT\n", "skills/principle-alpha/SKILL.md": principle("alpha", "v1"), "skills/principle-beta/SKILL.md": principle("beta", "v1") });
  s.run();
  const reviewed = fingerprint(readFileSync(join(s.root, "upstream/pstack/skills/principle-alpha/SKILL.md")));
  writeFileSync(join(s.root, "principles/alpha.md"), `---\nid: alpha\nsource: pstack principle-alpha, adapted\nupstream: ${reviewed}\n---\n\nMy alpha.\n`);

  s.release("1.1.0", { "skills/principle-beta/SKILL.md": principle("beta", "v2") });
  const quiet = s.run();
  assert.match(quiet.text, /1\.0\.0 → 1\.1\.0[\s\S]*changed 1 · removed 0 · overrides to review 0\n~ skills\/principle-beta\/SKILL\.md/);
  assert.match(quiet.output, /^changed=true\ntouched=0\n/m, "beta has no override, so the update can merge by itself");

  s.release("1.2.0", { "skills/principle-alpha/SKILL.md": principle("alpha", "v2") });
  const flagged = s.run();
  assert.match(flagged.text, /! principles\/alpha\.md overrides skills\/principle-alpha\/SKILL\.md, which changed since its review/);
  assert.match(flagged.output, /^touched=1$/m, "the update waits for a person");
  assert.match(readFileSync(join(s.root, "principles/alpha.md"), "utf8"), /My alpha\./, "the sync never touches an override");
});

test("a sync with nothing new reports no change", () => {
  const s = setup();
  s.release("1.0.0", { LICENSE: "MIT\n", "skills/principle-alpha/SKILL.md": principle("alpha", "v1") });
  s.run();
  assert.match(s.run().output, /^changed=false$/m);
});
