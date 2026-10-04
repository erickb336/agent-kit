// The sage board: the text board and the page, drawn from the sample model (sample data) and from a hostile one.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import vm from "node:vm";
import { pageHtml, stubHtml, textBoard } from "../plugins/sage/skills/sage/board.mjs";
import { LONG, PAYLOAD, hostileModel, sample } from "./fixtures/board/hostile.mjs";

/** The example of the spec (t7/spec.md section 5), line for line. */
const SPEC_EXAMPLE = `**sage board** · 14:19 · 4 projects

**Needs you (3)**
- tide-notes T2 · G1: Export one Markdown file per note, or one .zip with all notes? Recommended: One .zip with all notes.
- tide-notes T5 · G2: Drop the old column tags_csv on staging now? This cannot be undone. Recommended: Keep it 7 more days.
- ramen-finder T2 · PR #42 is ready to merge: 5 of 5 verdicts pass on a1b2c3d.

**Running (5)**
- ramen-finder T3 · R15 designer 2/3 · 1 h
- tide-notes T3 · R7 qa · 1 h · quiet 14 min
- pocket-atlas T5 · R5 implementer · 50 min
- ramen-finder T4 · R20 implementer · 19 min
- pocket-atlas T3 · R3 code-reviewer · 9 min

**Needs a chief (1)**
- tide-notes T1 · R3 implementer lost: its chief session closed

**Tasks**
- ramen-finder: 1 PR ready · 1 repairing · 1 designing
- tide-notes: 2 awaiting you · 1 building · 1 verifying · 1 framed
- pocket-atlas: 1 building · 1 reviewing · 1 replan · 1 briefed
- harbor-api: no open tasks

Full board on the Mac: ~/.claude/sage/board.html`;

/** A model with n projects; each project gets the tasks, runs and gates that `fill` returns for it. */
function made(n, fill = () => ({})) {
  const m = { built: "2026-10-03T14:19:52", root: "/Users/owner/.claude/sage", home: "/Users/owner", chiefs: {}, projects: [], tasks: [], runs: [], ledger: [], findings: [], gates: [], decisions: [] };
  for (let i = 0; i < n; i++) {
    const p = `proj${i}`;
    m.projects.push({ key: p, store: `${p}-abcdef` });
    const f = fill(p, i);
    for (const k of ["tasks", "runs", "gates"]) m[k].push(...(f[k] ?? []));
  }
  return m;
}
const task = (p, id, state = "building") => ({ p, id, title: `Task ${id}`, size: "small", route: ["build"], state });
const run = (p, id, t, status, start = "2026-10-03T14:00:00") => ({ p, id, t, role: "implementer", status, start });
const dataOf = (html) => JSON.parse(/<script type="application\/json" id="board-data">([\s\S]*?)<\/script>/.exec(html)[1]);

test("the text board of the sample is the example of the spec, line for line", () => {
  assert.equal(textBoard(sample()), SPEC_EXAMPLE);
});

test("20 running agents and nothing else: 25 lines or fewer, the rest in one line", () => {
  const text = textBoard(made(1, (p) => ({ tasks: [task(p, "T1")], runs: Array.from({ length: 20 }, (_, i) => run(p, `R${i + 1}`, "T1", "running", `2026-10-03T13:${String(10 + i).padStart(2, "0")}:00`)) })));
  const lines = text.split("\n");
  assert.ok(lines.length <= 25, `${lines.length} lines`);
  assert.equal(lines.filter((l) => l.startsWith("- proj0 T1 · R")).length, 6);
  assert.ok(lines.includes("- proj0 T1 · R1 implementer · 1 h 10 min"), text);
  assert.ok(lines.includes("- and 14 more"), text);
});

test("every section over its cap and two failed stores: 35 lines or fewer, one failed line, an 'and N more' line each", () => {
  const m = made(7, (p) => ({
    tasks: [task(p, "T1"), task(p, "T2", "awaiting-you")],
    gates: [{ p, id: "G1", task: "T2", question: `Ship ${p}?`, options: ["yes", "no"], recommendation: "yes", answer: "" }],
    runs: [run(p, "R1", "T1", "running"), run(p, "R2", "T2", "lost")],
  }));
  m.projects[2].failed = { at: "2026-10-03T14:19:00", error: "a line is not JSON", lastGood: "2026-10-03T14:02:00" };
  m.projects[5].failed = { at: "2026-10-03T14:19:00", error: "a line is not JSON", lastGood: null };
  const lines = textBoard(m).split("\n");
  assert.ok(lines.length <= 35, `${lines.length} lines`);
  assert.equal(lines[1], "proj2 and proj5 did not rebuild at 14:19: their lines are from older builds.");
  assert.deepEqual(lines.filter((l) => l.startsWith("- and ")), ["- and 2 more", "- and 1 more", "- and 4 more", "- and 2 more"]);
  assert.ok(lines.includes("**Needs a chief (7)**") && lines.includes("- proj0 T2 · R2 implementer lost: its chief session closed"));
  assert.ok(!lines.some((l) => l.includes("show the gates")));
});

test("one failed store: one line under the header, with the time of its last good build", () => {
  const m = sample();
  m.projects[1].failed = { at: "2026-10-03T14:19:00", error: "a line is not JSON", lastGood: "2026-10-03T14:02:00" };
  assert.equal(textBoard(m).split("\n")[1], "tide-notes did not rebuild at 14:19: its lines are from 14:02.");
});

test("no projects: the header, a blank line and one sentence", () => {
  assert.equal(textBoard(made(0)), "**sage board** · 14:19 · 0 projects\n\nNo projects yet. In a project folder, say “sage mode” and give the chief a task.");
});

test("a long item is cut at 160 characters, and a line break in a value does not add a line", () => {
  const m = made(1, (p) => ({ tasks: [task(p, "T1", "awaiting-you")], gates: [{ p, id: "G1", task: "T1", question: `Keep\nit? ${"x".repeat(300)}`, options: [], recommendation: "yes", answer: "" }] }));
  const item = textBoard(m).split("\n").find((l) => l.startsWith("- proj0 T1 · G1"));
  assert.equal(item, `- ${`proj0 T1 · G1: Keep it? ${"x".repeat(300)}`.slice(0, 159)}…`);
  assert.equal([...item.slice(2)].length, 160);
});

test("the page holds the model in one JSON block that the data cannot close, and a CSP with the hashes of its own code", () => {
  const m = sample();
  m.tasks[0].title = "</script><script>alert(1)</script><!--<script> & \u2028 \u2029 $& $1";
  const html = pageHtml(m);
  assert.equal(html.match(/<\/script>/g).length, 2);
  assert.ok(!/<script>alert/.test(html));
  const data = dataOf(html);
  assert.equal(data.tasks[0].title, m.tasks[0].title);
  assert.deepEqual(data.text, textBoard(m).split("\n"));
  const hash = (re) => createHash("sha256").update(re.exec(html)[1]).digest("base64");
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html)[1];
  assert.equal(csp, `default-src 'none'; script-src 'sha256-${hash(/<script>([\s\S]*?)<\/script>/)}'; style-src 'sha256-${hash(/<style>([\s\S]*?)<\/style>/)}'; base-uri 'none'; form-action 'none'`);
  assert.ok(html.indexOf("Content-Security-Policy") < html.indexOf("<style>"));
  assert.ok(!/\ssrc=|<link|@import|style="/.test(html), "no load from outside the file, and no style attribute");
});

test("the template ships no sample data and no demo control", () => {
  const data = dataOf(pageHtml(made(0)));
  assert.deepEqual([data.projects, data.tasks, data.runs, data.text.length], [[], [], [], 3]);
  const html = pageHtml(made(0));
  for (const word of ["ramen", "tide-notes", "pc-state", "pc-theme", "Prototype", "#/states", "#/notes", "Sample link"]) assert.ok(!html.includes(word), word);
});

test("checked fields keep only values of their pattern; a record with a bad id is left out", () => {
  const data = dataOf(pageHtml(hostileModel()));
  const t = (p, id) => data.tasks.find((x) => x.p === p && x.id === id);
  assert.equal(t("ramen-finder", "T2").pr, null);
  assert.deepEqual(t("ramen-finder", "T4").risk, ["auth"]);
  assert.equal(t("pocket-atlas", "T5").state, "unknown");
  assert.deepEqual([data.projects[0].repo, data.projects[1].repo, data.projects[3].repo], [null, null, null]);
  const r9 = data.runs.find((r) => r.p === "ramen-finder" && r.id === "R9");
  assert.deepEqual([r9.reports[0].sha, r9.from, r9.tokens, data.ledger[0].cycle], [null, ["R7"], null, null]);
  assert.equal(data.tasks.length, 15);
  assert.deepEqual(Object.keys(data.chiefs), Object.keys(sample().chiefs));
  assert.ok(data.tasks.some((x) => x.title.endsWith(LONG)), "free text stays as it is");
});

/** Runs the page code in node:vm with a small stand-in for the DOM, and keeps every HTML string it writes. */
function runPage(html) {
  const data = /<script type="application\/json" id="board-data">([\s\S]*?)<\/script>/.exec(html)[1];
  const code = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  const writes = [];
  const node = () => ({ hidden: true, dataset: {}, style: {}, classList: { add() {}, remove() {} }, focus() {}, setAttribute() {}, removeAttribute() {}, scrollIntoView() {}, addEventListener() {}, querySelector: () => node(), querySelectorAll: () => [], set innerHTML(v) { writes.push(v); }, get innerHTML() { return ""; } });
  const els = { "board-data": { textContent: data } };
  const on = {};
  const location = { hash: "#/", search: "", pathname: "/board.html", reload() {} };
  vm.runInNewContext(code, {
    document: { getElementById: (id) => (id.startsWith("run-") ? null : (els[id] ??= node())), querySelectorAll: () => [], addEventListener() {}, contains: () => false, activeElement: null, visibilityState: "visible" },
    window: { addEventListener: (k, f) => (on[k] = f), scrollTo() {}, getSelection: () => "" },
    location, history: { replaceState() {} }, CSS: { escape: (s) => s }, navigator: {}, setInterval() {}, setTimeout() {}, clearTimeout() {}, URLSearchParams,
  });
  return { writes, go: (hash) => { location.hash = hash; on.hashchange(); } };
}
const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

test("the page escapes every value it inserts: a payload in every string of the data stays text on every view and drawer", () => {
  const html = pageHtml(sample());
  const TIMES = new Set(["built", "at", "start", "end", "last", "resumedAt", "closedAt", "created", "lastGood"]);
  // Pass 1 poisons every string. Pass 2 keeps the fields that choose what to draw, so that every view and chip draws.
  for (const keep of [TIMES, new Set([...TIMES, "group", "status", "kind", "role", "state", "route"])]) {
    const poison = (v, k) => (typeof v === "string" ? (keep.has(k) ? v : v + PAYLOAD) : Array.isArray(v) ? v.map((x) => poison(x, k)) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([kk, x]) => [k === "chiefs" ? kk + PAYLOAD : kk, poison(x, kk)])) : v);
    const bad = poison(dataOf(html));
    bad.projects[0].failed = { at: bad.built, error: PAYLOAD, lastGood: null };
    const json = JSON.stringify(bad).replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
    const page = runPage(html.replace(/(<script type="application\/json" id="board-data">)[\s\S]*?(<\/script>)/, (_, a, b) => a + json + b));
    const routes = ["#/", "#/text", "#/t/x/T9", ...bad.projects.map((p) => `#/p/${encodeURIComponent(p.key)}`), ...bad.tasks.map((t) => `#/t/${encodeURIComponent(t.p)}/${encodeURIComponent(t.id)}`)];
    let drawers = 0;
    for (const r of routes) {
      page.go(r);
      for (const [, id] of page.writes.at(-1).matchAll(/data-art="([^"]*)"/g)) { page.go(`${r}?art=${encodeURIComponent(unescape(id))}`); drawers++; }
    }
    const all = page.writes.join("\n");
    assert.ok(drawers > 100, `${drawers} drawers`);
    if (keep.has("group")) assert.equal(all.match(/class="card tcard /g).length, 15, "every task card drew");
    assert.ok(all.includes("&lt;i data-pwn&gt;"), "the payload reached the page as text");
    assert.ok(!all.includes("<i data-pwn") && !all.includes("<img"), "no injected tag");
    assert.ok(!/data-pwn=["']/.test(all), "no attribute breakout");
    assert.ok(!/href=["']?\s*javascript:/i.test(all), "no javascript: link");
  }
});

test("the page of one project is a fixed stub that opens the board on that project", () => {
  assert.equal(stubHtml("tide-notes"), `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'">
<meta http-equiv="refresh" content="0;url=../board.html#/p/tide-notes">
<title>sage board · tide-notes</title>
</head>
<body>
<p><a href="../board.html#/p/tide-notes">Open the sage board for tide-notes</a></p>
</body>
</html>
`);
  assert.throws(() => stubHtml('x"><script>'), /not a project key/);
});
