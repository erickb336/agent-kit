// The dictionary (writing/dictionary.md): the flagged-word scan on literal texts, then `npm run build` and
// `npm run check` as people run them, in a copy of this repository.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { ROOT, parseSource } from "./build.mjs";
import { checkWords, flaggedWords } from "./dictionary.mjs";

const words = checkWords(parseSource(readFileSync(join(ROOT, "writing/dictionary.md"), "utf8"), "dictionary").body);
const scan = (text, html) => flaggedWords(text, words, { html }).map(({ line, word }) => `${line}:${word}`);

test("a flagged word or its plural is found, with its line and the approved word to say", () => {
  assert.deepEqual(flaggedWords("The chief keeps the work\nin the store.", words), [{ line: 2, word: "store", use: ["logbook"] }]);
  assert.deepEqual(scan("Two stores, a Pipeline and a sign off."), ["1:stores", "1:Pipeline", "1:sign off"]);
  assert.deepEqual(flaggedWords("one ticket", words)[0].use, ["request", "task", "brief"]);
  assert.deepEqual(scan("The logbook, a restore, the stored file."), []);
});

test("a word in quotes, in code or in a link URL passes; the same word outside them fails", () => {
  for (const [inside, outside] of [
    ['Do not say "store".', "Do not say store."],
    ["Do not say “store”.", "Do not say store."],
    ["Run `sage store`.", "Run sage store."],
    ["Run this:\n\n```\nsage store\n```\n", "Run this:\n\nsage store\n"],
    ["1. Run this:\n   ```bash\n   sage store\n   ```\n", "1. Run this:\n   sage store\n"],
    ["See [the docs](https://example.com/store).", "See [the store](https://example.com/)."],
  ]) {
    assert.deepEqual(scan(inside), [], inside);
    assert.equal(scan(outside).length, 1, outside);
  }
});

test("an allowed name passes only as it is written in the dictionary", () => {
  assert.deepEqual(scan("My Orchestrator taught it."), []);
  assert.deepEqual(scan("An orchestrator taught it."), ["1:orchestrator"]);
});

test("an alt text and a YAML description are text that a person reads; a URL in HTML is not", () => {
  assert.deepEqual(scan('<img alt="the store" src="docs/store.svg">'), ["1:store"]);
  assert.deepEqual(scan('---\ndescription: "Keeps the store. Says \\"sage mode\\"."\n---'), ["2:store"]);
});

test("in a page or a graphic, the text counts, and code, scripts and tags do not", () => {
  assert.deepEqual(scan('<p class="store">The store</p>\n<code>store</code>\n<script>store()</script>\n<text>Store</text>', true), ["1:store", "4:Store"]);
});

/** A copy of this repository, where the tests can change files and run the npm scripts. */
function copy() {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "sage-dictionary-")); // the real path, so that build.mjs sees that it runs as the script
  cpSync(ROOT, dir, { recursive: true, filter: (src) => ![".git", ".claude", "node_modules"].includes(relative(ROOT, src)) });
  const run = (script) => spawnSync("node", [join(dir, "scripts", `${script}.mjs`)], { encoding: "utf8" });
  const file = join(dir, "plugins/sage/agents/qa.md");
  const original = readFileSync(file, "utf8");
  return { dir, run, write: (rel, text) => writeFileSync(join(dir, rel), text), read: (rel) => readFileSync(join(dir, rel), "utf8"), agent: (line) => writeFileSync(file, `${original}\n${line}\n`) };
}

test("npm run check fails on a flagged word in an agent file, a skill or the README, and names the file and line", () => {
  const c = copy();
  assert.equal(c.run("check").status, 0, c.run("check").stderr);
  for (const rel of ["plugins/sage/agents/qa.md", "plugins/sage/skills/report/SKILL.md", "README.md"]) {
    const before = c.read(rel);
    c.write(rel, `${before}\nThe chief keeps it in the store.\n`);
    const r = c.run("check");
    assert.equal(r.status, 1, rel);
    assert.match(r.stderr, new RegExp(`✗ ${rel}:${before.split("\n").length + 1}: "store" is a flagged word; say logbook`));
    c.write(rel, before);
  }
});

test("npm run check passes when the word is quoted, in a code span, in a code block or in a link URL", () => {
  const c = copy();
  for (const line of ['Do not say "store".', "Run `sage store`.", "```\nsage store\n```", "See [the docs](https://example.com/store)."]) {
    c.agent(line);
    const r = c.run("check");
    assert.equal(r.status, 0, `${line}\n${r.stderr}`);
  }
  c.agent("See the store.");
  assert.equal(c.run("check").status, 1);
});

test("npm run build makes the dictionary skill and the README's word table from writing/dictionary.md", () => {
  const c = copy();
  const source = c.read("writing/dictionary.md");
  c.write("writing/dictionary.md", source.replace("kept on the owner's Mac. |", "kept on the owner's computer. |").replace("**Flagged:** store,", "**Flagged:** store, ledger book,"));
  assert.equal(c.run("check").status, 1, "the generated files are out of date before the build");
  assert.equal(c.run("build").status, 0);
  assert.match(c.read("plugins/sage/skills/dictionary/SKILL.md"), /\| \*\*logbook\*\* \| .*kept on the owner's computer\. \| store, database \|/);
  assert.match(c.read("README.md"), /\n\| \*\*Logbook\*\* \| .*kept on the owner's computer\. \|\n/);
  assert.equal(c.run("check").status, 0, c.run("check").stderr);
  c.agent("Write it in the ledger book.");
  assert.match(c.run("check").stderr, /qa\.md:\d+: "ledger book" is a flagged word/);
});

test("npm run check fails when the README's word table is edited by hand", () => {
  const c = copy();
  c.write("README.md", c.read("README.md").replace("| **Logbook** |", "| **Store** |"));
  const r = c.run("check");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /✗ README\.md: out of date; run npm run build/);
});

test("the skip of a file that an open pull request fixes fails once the file is clean", () => {
  const c = copy();
  const rel = "plugins/sage/skills/sage/SKILL.md";
  c.write(rel, c.read(rel).replace(/\bstore\b(?!`)/g, "logbook"));
  assert.match(c.run("check").stderr, /✗ plugins\/sage\/skills\/sage\/SKILL\.md: has no flagged word now; remove it from WAITING/);
});

// Round 1: the findings of the first review cycle on pull request #7, each as the reviewers showed it.

test("every sage agent loads the dictionary skill, and the hook tells the chief to load it", async () => {
  const { chiefText } = await import("../plugins/sage/hooks/sage-hook.mjs");
  assert.match(chiefText(), /Load these skills now: [^\n]*sage:dictionary/);
  const c = copy();
  c.write("plugins/sage/agents/qa.md", c.read("plugins/sage/agents/qa.md").replace("  - sage:dictionary\n", ""));
  assert.match(c.run("check").stderr, /✗ agents\/qa\.md: must preload sage:dictionary/);
});

test("the text of an alt, a title and an aria-label counts in a page and a graphic", () => {
  assert.deepEqual(scan('<p title="the store">x</p>\n<img alt="the store" src="a.png">\n<svg aria-label="the store"><title>t</title></svg>', true), ["1:store", "2:store", "3:store"]);
  assert.deepEqual(scan("<p title='a pipeline'>x</p>", true), ["1:pipeline"]);
  assert.deepEqual(scan('<p class="store" data-x="store">x</p>', true), []);
});

test("a Mermaid label counts, although Mermaid puts it in double quotes", () => {
  assert.deepEqual(scan('<pre class="mermaid">\nC --- S[("Store · tasks")]\nA -->|"handoff"| B\n</pre>\n<p>Not "store".</p>', true), ["2:Store", "3:handoff"]);
});

test("a word between underscores, which Markdown shows in italics, counts", () => {
  assert.deepEqual(scan("_store_, __store__ and _main agent_."), ["1:store", "1:store", "1:main agent"]);
  assert.deepEqual(scan("storeDir, restore and the store2 file."), []);
});

test("a two-word term across a line break counts, and an inch mark opens no quote", () => {
  assert.deepEqual(scan("Ask the main\nagent."), ["1:main agent"]);
  assert.deepEqual(scan('A 27" screen in the store, a 5" one.'), ["1:store"]);
  assert.deepEqual(scan('A 27" screen and the "store" here.'), []);
});

test("every form of Markdown code, and single quotes, pass as the dictionary says; apostrophes do not hide a word", () => {
  for (const [inside, outside] of [
    ["Run ``sage store`` now.", "Run sage store now."],
    ["~~~\nsage store\n~~~\n", "~~~\nsage\n~~~\nstore\n"],
    ["Run this:\n\n    sage store\n", "Run this:\n    sage store\n"],
    ["1. Run this:\n\n       sage store\n", "1. Run this:\n\n    sage store\n"],
    ["Use <code>sage store</code> here.", "Use <b>sage store</b> here."],
    ["See <https://example.com/store>.", "See https://example.com/ and the store."],
    ["Do not say 'store'.", "Do not say store."],
    ["Do not say ‘store’.", "Do not say store."],
    ["The owner's 'store' word.", "The owner's store word."],
  ]) {
    assert.deepEqual(scan(inside), [], inside);
    assert.equal(scan(outside).length, 1, outside);
  }
  assert.deepEqual(scan("It's the store's file, and the owner’s store."), ["1:store", "1:store"]);
});

test("a YAML-only escape in a description is read, not a crash", () => {
  assert.deepEqual(scan('---\ndescription: "Never changes files \\_ nor the store."\n---'), ["2:store"]);
  assert.deepEqual(scan("---\ndescription: 'It''s not the store.'\n---"), ["2:store"]);
  const c = copy();
  c.write("plugins/sage/agents/qa.md", c.read("plugins/sage/agents/qa.md").replace("Never changes files.", "Never changes files \\_ ok."));
  c.write("plugins/sage/skills/report/SKILL.md", c.read("plugins/sage/skills/report/SKILL.md").replace(/^description: "/m, 'description: "\\_ '));
  const r = c.run("check");
  assert.equal(r.status, 0, r.stderr);
});

test("a flagged word in a graphic says that its fix goes in scripts/graphics.mjs", () => {
  const c = copy();
  c.write("scripts/graphics.mjs", c.read("scripts/graphics.mjs").replace("keeps the logbook.", "keeps the store.").replace('"Logbook"', '"Store"'));
  assert.equal(c.run("graphics").status, 0);
  const r = c.run("check");
  assert.match(r.stderr, /✗ docs\/assets\/loop-light\.svg:1: "store" is a flagged word; say logbook \(writing\/dictionary\.md\); fix it in scripts\/graphics\.mjs, then run npm run graphics\n/);
  assert.match(r.stderr, /✗ docs\/assets\/loop-light\.svg:58: "Store" is a flagged word; say logbook \(writing\/dictionary\.md\); fix it in scripts\/graphics\.mjs/);
});

test("a title on the design page and a Mermaid label there fail the check", () => {
  const c = copy();
  const page = c.read("docs/design/sage-mode.html");
  c.write("docs/design/sage-mode.html", page.replace('S[("Logbook', 'S[("Store').replace("<main>", '<main><p title="the store">x</p>'));
  const r = c.run("check");
  assert.match(r.stderr, /✗ docs\/design\/sage-mode\.html:105: "Store" is a flagged word/);
  assert.match(r.stderr, new RegExp(`✗ docs/design/sage-mode\\.html:${page.slice(0, page.indexOf("<main>")).split("\n").length}: "store" is a flagged word`));
});

test("a README without its end marker gives one line from build and from check, not a stack trace", () => {
  const c = copy();
  c.write("README.md", c.read("README.md").replace("<!-- The end of the word table. -->", ""));
  for (const script of ["build", "check"]) {
    const r = c.run(script);
    assert.equal(r.status, 1, script);
    assert.match(r.stderr, /^✗ README\.md: the word table needs the lines <!-- The word table comes from writing\/dictionary\.md: edit it there, then run npm run build\. --> and <!-- The end of the word table\. -->$/m, script);
    assert.doesNotMatch(r.stderr, /^\s+at /m, script);
  }
});

test("a merge gate is a merge check: a gate is a question for the owner", () => {
  assert.deepEqual(flaggedWords("The merge gate reads it.\nTwo merge-gates.", words), [
    { line: 1, word: "merge gate", use: ["merge check"] },
    { line: 2, word: "merge-gates", use: ["merge check"] },
  ]);
});
