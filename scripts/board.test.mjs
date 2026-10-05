// The chat board on a sample fixture (made-up logbooks in scripts/fixtures/board/home), and the hook's board phrase.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { board } from "../plugins/sage/skills/sage/board.mjs";
import { storeDir } from "../plugins/sage/skills/sage/sage.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/board/home", import.meta.url));
const TOOL = fileURLToPath(new URL("../plugins/sage/skills/sage/sage.mjs", import.meta.url));
const HOOK = fileURLToPath(new URL("../plugins/sage/hooks/sage-hook.mjs", import.meta.url));
const DAY = new Date("2026-10-05T19:00:00Z"); // 12:00 in Los Angeles: outside the night window
const NIGHT = new Date("2026-10-05T06:00:00Z"); // 23:00 in Los Angeles

/**
 * A copy of the fixture as the sage home, and a session folder: "sage" is a git checkout with a GitHub remote, and the
 * fixture's sage logbook is its own logbook (book: the folder name that storeDir gives it, as the state tool does).
 */
function world() {
  const dir = mkdtempSync(join(tmpdir(), "sage-board-"));
  const home = join(dir, "home");
  cpSync(FIXTURE, home, { recursive: true });
  const sage = join(dir, "sage");
  mkdirSync(sage);
  execFileSync("git", ["init", "-q", sage]);
  execFileSync("git", ["-C", sage, "remote", "add", "origin", "git@github.com:acme/sage.git"]);
  const outside = join(dir, "elsewhere");
  mkdirSync(outside);
  const env = { SAGE_HOME: home };
  const book = basename(storeDir(sage, env));
  renameSync(join(home, "sage-aaaaaa"), join(home, book));
  const show = (scope, project = sage, now = DAY) => board({ scope, project, env, now });
  return { dir, home, sage, outside, env, book, show };
}

test("show board: the session's project, and one line per other project with something waiting", () => {
  const { show } = world();
  assert.equal(
    show("this"),
    [
      "**sage board · sage** · built 2026-10-05 19:00 UTC",
      "",
      "**Needs you (4)**",
      "- **G1** (T6) Sample\\: keep the old config key or drop it? Options: keep / drop. Recommended: drop\\: nobody uses it. Default: keep.",
      "- T2 [#7](https://github.com/acme/sage/pull/7) waits for your merge (risk input): Sample\\: the chat board",
      "- T3 [#8](https://github.com/acme/sage/pull/8) waits for your merge (autopilot may merge it tonight): Sample\\: a docs fix",
      "- T4 [#9](https://github.com/acme/sage/pull/9) waits for your merge (large): Sample\\: the large rebuild",
      "",
      "**Running now (2)**",
      "- T5 implementer · 15 h",
      "- T6 code-review · 14 h 30 min",
      "",
      "**Merged since the last board (0)**",
      "- nothing",
      "- first board for sage: earlier merges not listed",
      "",
      "**sage** · github.com/acme/sage",
      "- T2 Sample\\: the chat board · verified · [#7](https://github.com/acme/sage/pull/7)",
      "- T3 Sample\\: a docs fix · verified · [#8](https://github.com/acme/sage/pull/8) · round 1",
      "- T4 Sample\\: the large rebuild · pr-ready · [#9](https://github.com/acme/sage/pull/9)",
      "- T5 Sample\\: a hook change in progress · building · no PR",
      "- T6 Sample\\: the config reader · reviewing · [#10](https://github.com/acme/sage/pull/10) · round 2",
      "- framed backlog: 4 · next up (framed, in id order): T7 Sample\\: next task one; T8 Sample\\: next task two; T9 Sample\\: next task three",
      "",
      "**Other projects**",
      "- sage-bot: 1 gate waiting",
    ].join("\n"),
  );
});

test("show board for this project is the same board as show board", () => {
  const a = world();
  const b = world();
  assert.equal(a.show("this").replaceAll(a.dir, ""), b.show(undefined).replaceAll(b.dir, ""));
});

test("show board for all: needs-you of every project at the top, then one section per project", () => {
  const out = world().show("all");
  assert.match(out, /^\*\*sage board · all projects\*\*/);
  assert.match(out, /\*\*Needs you \(5\)\*\*\n- sage \*\*G1\*\* \(T6\)[^\n]*\n(- sage T[^\n]*\n){3}- sage-bot \*\*G1\*\* \(T2\) Sample\\: which channel first\?/);
  assert.match(out, /\*\*Running now \(3\)\*\*\n- order-chaser T1 implementer · 16 h 50 min\n- sage T5 implementer/);
  assert.deepEqual(out.match(/^\*\*[a-z-]+\*\*.*$/gm), ["**order-chaser**", "**sage** · github.com/acme/sage", "**sage-bot**"]);
  assert.match(out, /\*\*sage-bot\*\*\n- no active tasks\n- framed backlog: 1 · next up \(framed, in id order\): T2 Sample\\: bot follow-up/);
  assert.doesNotMatch(out, /Other projects/);
});

test("show board for <project>: one project, its name in any case; another project's PR has no link without its checkout", () => {
  const out = world().show("Sage-Bot");
  assert.match(out, /^\*\*sage board · sage-bot\*\*/);
  assert.match(out, /\*\*Needs you \(1\)\*\*\n- \*\*G1\*\* \(T2\)/);
  assert.doesNotMatch(out, /\*\*sage\*\*|order-chaser|Other projects/);
});

test("show board for an unknown name lists the known projects", () => {
  assert.equal(world().show("chaser"), 'No project named "chaser". Known projects: order-chaser, sage, sage-bot.');
});

test("a session outside every project shows all projects", () => {
  const w = world();
  const out = w.show("this", w.outside);
  assert.match(out, /^\*\*sage board · all projects \(this folder has no logbook\)\*\*/);
  assert.deepEqual(out.match(/^\*\*[a-z-]+\*\*/gm), ["**order-chaser**", "**sage**", "**sage-bot**"]);
});

test("needs you: a verified PR that is not merged is always listed, with the reason, by day and at night", () => {
  const w = world();
  for (const now of [DAY, NIGHT]) {
    const out = w.show("this", w.sage, now);
    assert.match(out, /\*\*Needs you \(4\)\*\*/);
    assert.match(out, /\n- T3 \[#8\]\(https:\/\/github\.com\/acme\/sage\/pull\/8\) waits for your merge \(autopilot may merge it tonight\): Sample\\: a docs fix\n/);
    assert.match(out, /T2 \[#7\][^\n]*waits for your merge \(risk input\)/);
    assert.match(out, /T4 \[#9\][^\n]*waits for your merge \(large\)/);
    assert.doesNotMatch(out, /G2/); // an answered gate
  }
});

test("merged since the last board: the next board lists only the new merges, and board.json holds the shown ones", () => {
  const w = world();
  w.show("this");
  assert.deepEqual(JSON.parse(readFileSync(join(w.home, "board.json"), "utf8")).merged, { sage: ["T1"] });
  const tasks = join(w.home, w.book, "tasks.tsv");
  writeFileSync(tasks, readFileSync(tasks, "utf8").replace("\tverified\tt2\t", "\tmerged\tt2\t"));
  const out = w.show("this", w.sage, new Date("2026-10-05T20:00:00Z"));
  assert.match(out, /\*\*Merged since 2026-10-05 19:00 UTC \(1\)\*\*\n- T2 \[#7\]\(https:\/\/github\.com\/acme\/sage\/pull\/7\) Sample\\: the chat board\n\n/);
});

test("a project's checkout.txt gives its PR links, and a broken logbook shows one line", () => {
  const w = world();
  const bot = join(w.dir, "bot");
  execFileSync("git", ["init", "-q", bot]);
  execFileSync("git", ["-C", bot, "remote", "add", "origin", "https://github.com/acme/sage-bot.git"]);
  writeFileSync(join(w.home, "sage-bot-bbbbbb", "checkout.txt"), `${bot}\n`);
  rmSync(join(w.home, "order-chaser-cccccc", "runs.tsv"));
  const out = w.show("all");
  assert.match(out, /\*\*sage-bot\*\* · github\.com\/acme\/sage-bot/);
  assert.match(out, /\*\*order-chaser\*\*\n- logbook cannot be read: .*runs\\\.tsv is missing/);
  assert.match(w.show("this", bot), /^\*\*sage board · sage-bot\*\*/); // the session matched by checkout.txt
});

test("sage board through the CLI: read-only with --remember no, and a bad option is refused", () => {
  const w = world();
  const run = (...args) => spawnSync("node", [TOOL, "board", ...args, "--project", w.sage], { encoding: "utf8", env: { ...process.env, ...w.env } });
  const r = run("all", "--remember", "no");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^\*\*sage board · all projects\*\*/);
  assert.equal(existsSync(join(w.home, "board.json")), false);
  assert.match(run("--remember", "maybe").stderr, /--remember yes or no/);
  assert.equal(run().status, 0);
  assert.equal(existsSync(join(w.home, "board.json")), true);
});

/** Appends one row (its cells in the table's column order) to a table of a fixture logbook. */
function add(w, book, table, cells) {
  const file = join(w.home, book, `${table}.tsv`);
  writeFileSync(file, readFileSync(file, "utf8") + cells.join("\t") + "\n");
}
/** Every "](" that is not escaped must open one of the board's own PR links. */
const ownLinksOnly = (out) => assert.doesNotMatch(out, /(?<!\\)\]\((?!https:\/\/github\.com\/acme\/sage\/pull\/\d+\))/);

test("agent-written text is escaped: no link, image, comment or HTML reaches the owner live", () => {
  const w = world();
  add(w, w.book, "gates", ["G3", "T6", "Approve? [Approve here](https://evil.example/approve) ![x](https://evil.example/x.png) <!-- hide -->", "[ok](https://evil.example/a)|no", "**yes** `rm -rf`", "<b>x</b>", "", "2026-10-05T03:00:00Z"]);
  add(w, w.book, "tasks", ["T12", "<img src=x onerror=alert(1)>\u200b ~~a~~ #|_\u202e", "small", "", "build", "building", "t12", "", "0", ""]);
  const out = w.show("this");
  assert.ok(
    out.includes(
      "\n- **G3** (T6) Approve? \\[Approve here\\]\\(https\\://evil\\.example/approve\\) \\!\\[x\\]\\(https\\://evil\\.example/x\\.png\\) \\<\\!-- hide --\\> Options: \\[ok\\]\\(https\\://evil\\.example/a\\) / no. Recommended: \\*\\*yes\\*\\* \\`rm -rf\\`. Default: \\<b\\>x\\</b\\>.\n",
    ),
    out,
  );
  assert.ok(out.includes("\n- T12 \\<img src=x onerror=alert\\(1\\)\\> \\~\\~a\\~\\~ \\#\\|\\_ · building · no PR\n"), out);
  ownLinksOnly(out);
  assert.doesNotMatch(out, /(?<!\\)</);
});

test("agent-written text gives no autolink: a bare URL, a www host, an email or an escaped link stays plain text", () => {
  const w = world();
  add(w, w.book, "gates", ["G5", "T6", "Go to https://evil.example/approve or www.evil.example now", "ftp://evil.example/f|owner@evil.example", "\\[x\\](https://evil.example/b)", "mailto:owner@evil.example", "", "2026-10-05T03:00:00Z"]);
  add(w, w.book, "tasks", ["T15", "a http://e.example WWW.e.example a@b.co", "small", "", "build", "building", "t15", "", "0", ""]);
  const out = w.show("this");
  assert.ok(
    out.includes(
      "\n- **G5** (T6) Go to https\\://evil\\.example/approve or www\\.evil\\.example now Options: ftp\\://evil\\.example/f / owner\\@evil\\.example. Recommended: \\\\\\[x\\\\\\]\\(https\\://evil\\.example/b\\). Default: mailto\\:owner\\@evil\\.example.\n",
    ),
    out,
  );
  assert.ok(out.includes("\n- T15 a http\\://e\\.example WWW\\.e\\.example a\\@b\\.co · building · no PR\n"), out);
  // GFM makes a link of a bare "://" URL, a "www." host and an email; the board's own PR links are the only URLs left.
  assert.doesNotMatch(out.replace(/\]\(https:\/\/github\.com\/acme\/sage\/pull\/\d+\)/g, ""), /(?<!\\):\/\/|www\.|(?<!\\)@/i);
  ownLinksOnly(out);
});

test("an id-like cell is kept only in its format, else shown as ?: a hand-made PR cell gives no link to another host", () => {
  const w = world();
  add(w, w.book, "tasks", ["T13", "Sample: a forged PR cell", "small", "", "build", "verified", "t13", "7](https://evil.example/pr) [#7", "0", ""]);
  add(w, w.book, "tasks", ["T14```", "Sample: a forged id", "small", "input```", "build", "building```", "t14", "", "1```", ""]);
  add(w, w.book, "gates", ["G4```", "T6```", "Sample: a forged gate", "a|b", "a", "a", "", "2026-10-05T03:00:00Z"]);
  add(w, w.book, "runs", ["R4", "T5```", "implementer```", "0", "", "t5", "running", "", "", "2026-10-05T05:00:00Z", ""]);
  const out = w.show("this");
  assert.ok(out.includes("\n- T13 PR ? waits for your merge (autopilot may merge it tonight): Sample\\: a forged PR cell\n"), out);
  assert.ok(out.includes("\n- ? Sample\\: a forged id · ? · no PR · round ?\n"), out);
  assert.ok(out.includes("\n- **?** (?) Sample\\: a forged gate Options: a / b. Recommended: a. Default: a.\n"), out);
  assert.ok(out.includes("\n- ? ? · 14 h\n"), out);
  assert.doesNotMatch(out, /`|evil/);
  ownLinksOnly(out);
});

test("board.json: a FIFO, a big file, a bad date or a non-array list is ignored and rewritten", () => {
  for (const make of [
    (file) => execFileSync("mkfifo", [file]),
    (file) => writeFileSync(file, JSON.stringify({ at: "2026-10-05T18:00:00Z", merged: { sage: [] }, pad: "x".repeat(70000) })),
    (file) => writeFileSync(file, JSON.stringify({ at: "[x](https://evil.example)", merged: { sage: [] } })),
    (file) => writeFileSync(file, JSON.stringify({ at: "2026-10-05T18:00:00Z", merged: { sage: 5 } })),
    (file) => writeFileSync(file, JSON.stringify({ at: "2026-10-05T18:00:00Z", merged: { sage: [7] } })),
  ]) {
    const w = world();
    const file = join(w.home, "board.json");
    make(file);
    const out = w.show("this");
    assert.match(out, /\*\*Merged since the last board \(0\)\*\*\n- nothing\n- first board for sage/);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { at: "2026-10-05T19:00:00Z", merged: { sage: ["T1"] } });
  }
});

test("a remote that only names github.com in its path gives no PR links", () => {
  const w = world();
  execFileSync("git", ["-C", w.sage, "remote", "set-url", "origin", "https://evil.example/github.com/acme/sage.git"]);
  const out = w.show("this");
  assert.match(out, /- T2 PR #7 waits for your merge/);
  assert.match(out, /^\*\*sage\*\*$/m);
  assert.doesNotMatch(out, /evil/);
});

test("the all-projects board shows at most 8 active tasks per project, then a count and the phrase for the rest", () => {
  const w = world();
  for (let i = 20; i < 25; i++) add(w, w.book, "tasks", [`T${i}`, `Sample: busy ${i}`, "small", "", "build", "building", `t${i}`, "", "0", ""]);
  const all = w.show("all");
  assert.match(all, /\n- T6 [^\n]*\n- T20 [^\n]*\n- T21 [^\n]*\n- T22 [^\n]*\n- and 2 more \(show board for sage\)\n- framed backlog: 4/);
  assert.doesNotMatch(all, /T23 Sample/);
});

test("one project's board shows at most 8 active tasks too: with 12, 8 lines and and 4 more", () => {
  const w = world();
  for (let i = 20; i < 27; i++) add(w, w.book, "tasks", [`T${i}`, `Sample: busy ${i}`, "small", "", "build", "building", `t${i}`, "", "0", ""]);
  const out = w.show("this");
  assert.match(out, /\*\*sage\*\* · github\.com\/acme\/sage\n- T2 [^\n]*\n- T3 [^\n]*\n- T4 [^\n]*\n- T5 [^\n]*\n- T6 [^\n]*\n- T20 [^\n]*\n- T21 [^\n]*\n- T22 Sample\\: busy 22 · building · no PR\n- and 4 more\n- framed backlog: 4/);
  assert.doesNotMatch(out, /T23 Sample/);
  assert.match(w.show("sage"), /- T22 [^\n]*\n- and 4 more\n/);
});

test("a folder that only shares a logbook's name shows that board, but never PR links from its own remote", () => {
  const w = world();
  const twin = join(w.dir, "other", "sage");
  mkdirSync(twin, { recursive: true });
  execFileSync("git", ["init", "-q", twin]);
  execFileSync("git", ["-C", twin, "remote", "add", "origin", "git@github.com:mallory/sage.git"]);
  const out = w.show("this", twin);
  assert.match(out, /^\*\*sage board · sage\*\*/);
  assert.match(out, /\n- T2 PR #7 waits for your merge \(risk input\)/);
  assert.match(out, /^\*\*sage\*\*$/m);
  assert.doesNotMatch(out, /mallory|\]\(/);
  assert.match(w.show("this"), /T2 \[#7\]\(https:\/\/github\.com\/acme\/sage\/pull\/7\)/); // the logbook's own folder keeps its links
});

/** The hook's note for one prompt, or "" when it gives none. */
function note(prompt) {
  const dir = mkdtempSync(join(tmpdir(), "sage-board-hook-"));
  const env = { ...process.env, SAGE_HOOKS_STATE: join(dir, "state"), SAGE_HOME: join(dir, "home") };
  const r = spawnSync("node", [HOOK], { input: JSON.stringify({ session_id: "s1", hook_event_name: "UserPromptSubmit", prompt, cwd: "/work/sage" }), encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : "";
}

test("the board phrase: each scope at the start of the owner's message gives the command", () => {
  const cmd = (scope) => `sage.mjs" board ${scope} --project '/work/sage'`;
  assert.match(note("show board"), new RegExp(cmd("this")));
  assert.ok(note("Show board for this project.").includes(cmd("this")));
  assert.ok(note("show board for all").includes(cmd("all")));
  assert.ok(note("show board for Order-Chaser").includes(cmd("order-chaser")));
  assert.match(note("show board"), /choice card/);
  assert.ok(note("show board for all projects").includes(cmd("all")));
  assert.ok(note("show board for thistle").includes(cmd("thistle")));
  assert.ok(note("show board for this-app").includes(cmd("this-app")));
  assert.ok(note("show board for this").includes(cmd("this")));
});

test("the board phrase: a trailing full stop, ! or , ends the sentence, not the scope", () => {
  const cmd = (scope) => `sage.mjs" board ${scope} --project '/work/sage'`;
  for (const end of [".", "!", ",", ";", ":", "...", ". Thanks"]) {
    assert.ok(note(`Show board for all${end}`).includes(cmd("all")), end);
    assert.ok(note(`show board for sage${end}`).includes(cmd("sage")), end);
    assert.ok(note(`show board for this${end}`).includes(cmd("this")), end);
  }
  assert.ok(note("show board for all projects.").includes(cmd("all")));
  assert.ok(note("show board for sage.v2.").includes(cmd("sage.v2"))); // an inner dot stays
  assert.ok(note("show board for my-app.").includes(cmd("my-app")));
});

test("the board phrase: no board inside a quote, an agent's report, a question or a longer word", () => {
  assert.equal(note('He wrote "show board" in the doc.'), "");
  assert.equal(note("<task-notification>\nshow board\n</task-notification>"), "");
  assert.equal(note('<agent-message from="x">\nshow board for all\n</agent-message>'), "");
  assert.equal(note("show board?"), "");
  assert.equal(note("show boards"), "");
});
