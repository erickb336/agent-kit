// The chat board on a sample fixture (made-up logbooks in scripts/fixtures/board/home), and the hook's board phrase.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { board } from "../plugins/sage/skills/sage/board.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/board/home", import.meta.url));
const TOOL = fileURLToPath(new URL("../plugins/sage/skills/sage/sage.mjs", import.meta.url));
const HOOK = fileURLToPath(new URL("../plugins/sage/hooks/sage-hook.mjs", import.meta.url));
const DAY = new Date("2026-10-05T19:00:00Z"); // 12:00 in Los Angeles: outside the night window
const NIGHT = new Date("2026-10-05T06:00:00Z"); // 23:00 in Los Angeles

/** A copy of the fixture as the sage home, and a session folder: "sage" is a git checkout with a GitHub remote. */
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
  const show = (scope, project = sage, now = DAY) => board({ scope, project, env, now });
  return { dir, home, sage, outside, env, show };
}

test("show board: the session's project, and one line per other project with something waiting", () => {
  const { show } = world();
  assert.equal(
    show("this"),
    [
      "**sage board · sage** · built 2026-10-05 19:00 UTC",
      "",
      "**Needs you (4)**",
      "- **G1** (T6) Sample: keep the old config key or drop it? Recommended: drop: nobody uses it. Default: keep.",
      "- T2 [#7](https://github.com/acme/sage/pull/7) waits for your merge (risk input): Sample: the chat board",
      "- T3 [#8](https://github.com/acme/sage/pull/8) waits for your merge (outside the night window): Sample: a docs fix",
      "- T4 [#9](https://github.com/acme/sage/pull/9) waits for your merge (large): Sample: the large rebuild",
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
      "- T2 Sample: the chat board · verified · [#7](https://github.com/acme/sage/pull/7)",
      "- T3 Sample: a docs fix · verified · [#8](https://github.com/acme/sage/pull/8) · round 1",
      "- T4 Sample: the large rebuild · pr-ready · [#9](https://github.com/acme/sage/pull/9)",
      "- T5 Sample: a hook change in progress · building · no PR",
      "- T6 Sample: the config reader · reviewing · [#10](https://github.com/acme/sage/pull/10) · round 2",
      "- framed backlog: 4 · next up (framed, in id order): T7 Sample: next task one; T8 Sample: next task two; T9 Sample: next task three",
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
  assert.match(out, /\*\*Needs you \(5\)\*\*\n- sage \*\*G1\*\* \(T6\)[^\n]*\n(- sage T[^\n]*\n){3}- sage-bot \*\*G1\*\* \(T2\) Sample: which channel first\?/);
  assert.match(out, /\*\*Running now \(3\)\*\*\n- order-chaser T1 implementer · 16 h 50 min\n- sage T5 implementer/);
  assert.deepEqual(out.match(/^\*\*[a-z-]+\*\*.*$/gm), ["**order-chaser**", "**sage** · github.com/acme/sage", "**sage-bot**"]);
  assert.match(out, /\*\*sage-bot\*\*\n- no active tasks\n- framed backlog: 1 · next up \(framed, in id order\): T2 Sample: bot follow-up/);
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

test("needs you: at night a small verified task without a risk flag is autopilot's, so it is not listed", () => {
  const w = world();
  const night = w.show("this", w.sage, NIGHT);
  assert.match(night, /\*\*Needs you \(3\)\*\*/);
  assert.doesNotMatch(night, /T3 \[#8\][^\n]*waits/);
  assert.match(night, /T2 \[#7\][^\n]*waits for your merge \(risk input\)/);
  assert.match(night, /T4 \[#9\][^\n]*waits for your merge \(large\)/);
  assert.match(w.show("this"), /T3 \[#8\][^\n]*waits for your merge \(outside the night window\)/);
  assert.doesNotMatch(night, /G2/); // an answered gate
});

test("merged since the last board: the next board lists only the new merges, and board.json holds the shown ones", () => {
  const w = world();
  w.show("this");
  assert.deepEqual(JSON.parse(readFileSync(join(w.home, "board.json"), "utf8")).merged, { sage: ["T1"] });
  const tasks = join(w.home, "sage-aaaaaa", "tasks.tsv");
  writeFileSync(tasks, readFileSync(tasks, "utf8").replace("\tverified\tt2\t", "\tmerged\tt2\t"));
  const out = w.show("this", w.sage, new Date("2026-10-05T20:00:00Z"));
  assert.match(out, /\*\*Merged since 2026-10-05 19:00 UTC \(1\)\*\*\n- T2 \[#7\]\(https:\/\/github\.com\/acme\/sage\/pull\/7\) Sample: the chat board\n\n/);
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
  assert.match(out, /\*\*order-chaser\*\*\n- logbook cannot be read: .*runs\.tsv is missing/);
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
});

test("the board phrase: no board inside a quote, an agent's report, a question or a longer word", () => {
  assert.equal(note('He wrote "show board" in the doc.'), "");
  assert.equal(note("<task-notification>\nshow board\n</task-notification>"), "");
  assert.equal(note('<agent-message from="x">\nshow board for all\n</agent-message>'), "");
  assert.equal(note("show board?"), "");
  assert.equal(note("show boards"), "");
});
