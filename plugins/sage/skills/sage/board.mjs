// The sage board: one plain model, two renderers. pageHtml(model) gives the self-contained page (the template
// board.html next to this file, with the model in one JSON block), and textBoard(model) gives the compact board for
// the chat. Phase 3 fills the model from the store; scripts/fixtures/board/sample.json shows its shape (sample data).
//
// The model:
//   { built, root, home, sample?,
//     chiefs:    { <session id>: { name, open, closedAt } },
//     projects:  [{ key, store, repo, created, olderClosed, failed: { at, error, lastGood } | null }],
//     tasks:     [{ p, id, title, size, risk: [], route: [], state, branch, pr, round }],
//     runs:      [{ p, id, t, role, k, round, chief, status, noReport, resumed, resumedAt, legacy, at, start, end, last,
//                   tokens, tools, model, agent, from: ["R4", "T1/R1"], brief: { at, sha256, head } | null,
//                   steers: [{ at, text, sha256 }], reports: [{ at, status, result, branch, sha, pr, sha256, head }],
//                   transcript: { bytes, src } | null, children: [{ type, description, agent, model, start, end }] }],
//     ledger:    [{ p, task, kind, sha, cycle, run }],
//     findings:  [{ p, task, key, round, source, run, severity, summary, triage, reason, status }],
//     gates:     [{ p, id, task, question, options: [], recommendation, default, answer, at }],
//     decisions: [{ p, at, task, decision, why }] }
// Times are ISO strings. `p` is a project key. The model holds only what the board shows: open tasks, tasks closed in
// the last 7 days, and their runs and rows (phase 3 windows it).
//
// Safety, in three layers: clean() keeps a checked field only when it matches its pattern, the page escapes every value
// it inserts, and the page's Content-Security-Policy lets only its own script and style run.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** Task states in board order, each with its group. A state that is not here goes last, in "plan". */
const STATES = { "awaiting-you": "you", "pr-ready": "you", building: "build", repairing: "build", reviewing: "check", verifying: "check", verified: "check", framed: "plan", designing: "plan", replan: "plan", briefed: "plan", held: "held", merged: "closed", abandoned: "closed", concluded: "closed" };
const LABELS = { "awaiting-you": "awaiting you", "pr-ready": "PR ready" };
const WRITERS = ["implementer", "designer"];
const PASS = /-(clean|pass)$/;
const QUIET_MS = 10 * 60000;
const CAPS = { needs: 5, running: 6, chief: 3, projects: 5 };
const ITEM_MAX = 160;
const has = (table, key) => Object.hasOwn(table, key);

// Layer 1: each field passes its check, or becomes null (a record without a valid id is left out).
const matches = (re) => (v) => (typeof v === "string" && re.test(v) ? v : null);
const KEY = matches(/^[a-z0-9][a-z0-9-]{0,63}$/);
const STORE = matches(/^[a-z0-9-]{1,64}-[0-9a-f]{6}$/);
const TASK = matches(/^T\d{1,6}$/);
const RUN = matches(/^R\d{1,6}$/);
const GATE = matches(/^G\d{1,6}$/);
const FROM = matches(/^(T\d{1,6}\/)?R\d{1,6}$/);
const SESSION = matches(/^[0-9a-f][0-9a-f-]{7,35}$/);
const AGENT = matches(/^[\w-]{1,64}$/);
const WORD = matches(/^[a-z][a-z0-9-]{0,39}$/);
const SHA = matches(/^[0-9a-f]{7,40}$/);
const SHA256 = matches(/^[0-9a-f]{64}$/);
const REPO = matches(/^https:\/\/github\.com\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/);
const PATH = matches(/^\/[^\0-\x1f]*$/);
const TIME = (v) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : null);
const INT = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
const COUNT = (v) => INT(v) ?? 0;
const TEXT = (v) => (v == null ? "" : String(v));
const BOOL = (v) => v === true;
const UNKNOWN = (v) => WORD(v) ?? "unknown";
const list = (check) => (v) => (Array.isArray(v) ? v.map(check).filter((x) => x != null) : []);
const shape = (fields) => (v) => (v && typeof v === "object" ? Object.fromEntries(Object.entries(fields).map(([k, check]) => [k, check(v[k])])) : null);

const PROJECT = shape({ key: KEY, store: STORE, repo: REPO, created: TIME, olderClosed: COUNT, failed: shape({ at: TIME, error: TEXT, lastGood: TIME }) });
const TASK_ROW = shape({ p: KEY, id: TASK, title: TEXT, size: WORD, risk: list(WORD), route: list(WORD), state: UNKNOWN, branch: TEXT, pr: INT, round: COUNT });
const RUN_ROW = shape({
  p: KEY, id: RUN, t: TASK, role: UNKNOWN, k: INT, round: COUNT, chief: SESSION, status: UNKNOWN, noReport: BOOL, resumed: BOOL, resumedAt: TIME,
  legacy: BOOL, at: TIME, start: TIME, end: TIME, last: TIME, tokens: INT, tools: INT, model: TEXT, agent: AGENT, from: list(FROM),
  brief: shape({ at: TIME, sha256: SHA256, head: TEXT }),
  steers: list(shape({ at: TIME, text: TEXT, sha256: SHA256 })),
  reports: list(shape({ at: TIME, status: WORD, result: TEXT, branch: TEXT, sha: SHA, pr: INT, sha256: SHA256, head: TEXT })),
  transcript: shape({ bytes: INT, src: TEXT }),
  children: list(shape({ type: TEXT, description: TEXT, agent: AGENT, model: TEXT, start: TIME, end: TIME })),
});
const LEDGER_ROW = shape({ p: KEY, task: TASK, kind: UNKNOWN, sha: SHA, cycle: INT, run: RUN });
const FINDING_ROW = shape({ p: KEY, task: TASK, key: TEXT, round: COUNT, source: UNKNOWN, run: RUN, severity: UNKNOWN, summary: TEXT, triage: WORD, reason: TEXT, status: UNKNOWN });
const GATE_ROW = shape({ p: KEY, id: GATE, task: TASK, question: TEXT, options: list(TEXT), recommendation: TEXT, default: TEXT, answer: TEXT, at: TIME });
const DECISION_ROW = shape({ p: KEY, at: TIME, task: TASK, decision: TEXT, why: TEXT });

function clean(m) {
  const built = TIME(m?.built);
  const root = PATH(m?.root);
  if (!built || !root) throw new TypeError("board: the model needs a build time (built) and the absolute sage root (root)");
  const chiefs = {};
  for (const [id, c] of Object.entries(m.chiefs ?? {})) if (SESSION(id) && c) chiefs[id] = { name: TEXT(c.name), open: BOOL(c.open), closedAt: TIME(c.closedAt) };
  const projects = list(PROJECT)(m.projects).filter((p) => p.key && p.store);
  const keys = new Set(projects.map((p) => p.key));
  const tasks = list(TASK_ROW)(m.tasks).filter((t) => keys.has(t.p) && t.id);
  const ids = new Set(tasks.map((t) => `${t.p}/${t.id}`));
  const onTask = (row, task) => ids.has(`${row.p}/${task}`);
  const runs = list(RUN_ROW)(m.runs).filter((r) => r.id && onTask(r, r.t));
  for (const r of runs) if (!has(chiefs, r.chief ?? "")) r.chief = null;
  return {
    sample: BOOL(m.sample), built, root, home: PATH(m.home), chiefs, projects, tasks, runs,
    ledger: list(LEDGER_ROW)(m.ledger).filter((l) => onTask(l, l.task)),
    findings: list(FINDING_ROW)(m.findings).filter((f) => onTask(f, f.task)),
    gates: list(GATE_ROW)(m.gates).filter((g) => g.id && onTask(g, g.task)),
    decisions: list(DECISION_ROW)(m.decisions).filter((d) => d.at && onTask(d, d.task)),
  };
}

/** The checked model plus every value that both renderers show, so that neither computes it a second time. */
function view(model) {
  const m = clean(model);
  const built = Date.parse(m.built);
  const order = (r) => Date.parse(r.start ?? r.at ?? m.built);
  const runsOf = (t) => m.runs.filter((r) => r.p === t.p && r.t === t.id);
  for (const t of m.tasks) {
    t.group = has(STATES, t.state) ? STATES[t.state] : "plan";
    t.label = has(LABELS, t.state) ? LABELS[t.state] : t.state;
    // The head: the SHA of the newest report of a writer run; else the newest SHA in the ledger.
    const reports = runsOf(t).filter((r) => WRITERS.includes(r.role)).flatMap((r) => r.reports).filter((x) => x.sha && x.at);
    reports.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    t.head = reports[0]?.sha ?? m.ledger.filter((l) => l.p === t.p && l.task === t.id && l.sha).at(-1)?.sha ?? null;
    t.closedAt = m.decisions.filter((d) => d.p === t.p && d.task === t.id && /^state (merged|abandoned|concluded)\b/.test(d.decision)).at(-1)?.at ?? null;
  }
  const taskOf = (r) => m.tasks.find((t) => t.p === r.p && t.id === r.t);
  for (const r of m.runs) {
    r.of = r.k ? runsOf(taskOf(r)).filter((x) => x.k).length : null;
    r.quiet = r.status === "running" && r.last != null && built - Date.parse(r.last) >= QUIET_MS;
    // A run needs a chief when it is lost or ended with no report, its task is open, and no later run of its role exists.
    r.needsChief = (r.status === "lost" || r.noReport) && taskOf(r).group !== "closed" && !runsOf(taskOf(r)).some((x) => x !== r && x.role === r.role && order(x) > order(r));
  }
  m.reload = m.runs.some((r) => r.status === "running");
  m.needs = [
    ...m.gates.filter((g) => !g.answer).map((g) => ({ kind: "gate", p: g.p, task: g.task, gate: g.id })),
    ...m.tasks.filter((t) => t.state === "pr-ready").map((t) => {
      const onHead = m.ledger.filter((l) => l.p === t.p && l.task === t.id && l.sha && l.sha === t.head);
      return { kind: "pr", p: t.p, task: t.id, pass: onHead.filter((l) => PASS.test(l.kind)).length, total: onHead.length };
    }),
  ];
  return m;
}

const pad = (n) => String(n).padStart(2, "0");
const hm = (iso) => `${pad(new Date(iso).getHours())}:${pad(new Date(iso).getMinutes())}`;
function dur(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 1) return "under 1 min";
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
}
const shownRoot = (m) => (m.home && m.root.startsWith(`${m.home}/`) ? `~${m.root.slice(m.home.length)}` : m.root);
/** One line of a list: no line breaks, and at most ITEM_MAX characters. */
function item(s) {
  const chars = [...s.replace(/\s+/g, " ").trim()];
  return chars.length > ITEM_MAX ? `${chars.slice(0, ITEM_MAX - 1).join("")}…` : chars.join("");
}
const names = (xs) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

function lines(m) {
  const built = Date.parse(m.built);
  const L = [`**sage board** · ${hm(m.built)} · ${m.projects.length} project${m.projects.length === 1 ? "" : "s"}`];
  if (!m.projects.length) return [...L, "", "No projects yet. In a project folder, say “sage mode” and give the chief a task."];
  const failed = m.projects.filter((p) => p.failed);
  if (failed.length === 1) L.push(item(`${failed[0].key} did not rebuild at ${hm(failed[0].failed.at ?? m.built)}: ${failed[0].failed.lastGood ? `its lines are from ${hm(failed[0].failed.lastGood)}` : "it shows only its name"}.`));
  else if (failed.length) L.push(item(`${names(failed.map((p) => p.key))} did not rebuild at ${hm(m.built)}: their lines are from older builds.`));
  const task = (p, id) => m.tasks.find((t) => t.p === p && t.id === id);
  const section = (head, rows, cap, always) => {
    if (!rows.length && !always) return;
    L.push("", `**${head} (${rows.length})**`);
    if (!rows.length) L.push("Nothing.");
    for (const row of rows.slice(0, cap)) L.push(`- ${item(row)}`);
    if (rows.length > cap) L.push(`- and ${rows.length - cap} more`);
  };
  section("Needs you", m.needs.map((n) => {
    if (n.kind === "pr") { const t = task(n.p, n.task); return `${n.p} ${n.task} · PR #${t.pr ?? "?"} is ready to merge: ${n.pass} of ${n.total} verdicts pass on ${t.head ?? "no commit"}.`; }
    const g = m.gates.find((x) => x.p === n.p && x.id === n.gate);
    return `${n.p} ${n.task} · ${g.id}: ${g.question} Recommended: ${g.recommendation.split(":")[0].replace(/\.$/, "")}.`;
  }), CAPS.needs, true);
  const running = m.runs.filter((r) => r.status === "running").sort((a, b) => Date.parse(a.start ?? m.built) - Date.parse(b.start ?? m.built));
  section("Running", running.map((r) => `${r.p} ${r.t} · ${r.id} ${r.role}${r.k ? ` ${r.k}/${r.of}` : ""} · ${dur(built - Date.parse(r.start ?? m.built))}${r.quiet ? ` · quiet ${dur(built - Date.parse(r.last))}` : ""}`), CAPS.running);
  section("Needs a chief", m.runs.filter((r) => r.needsChief).map((r) => `${r.p} ${r.t} · ${r.id} ${r.role} ${r.status === "lost" ? "lost: its chief session closed" : "ended with no report"}`), CAPS.chief);
  L.push("", "**Tasks**");
  const states = Object.keys(STATES);
  const rank = (s) => (states.includes(s) ? states.indexOf(s) : states.length);
  for (const p of m.projects.slice(0, CAPS.projects)) {
    const counts = new Map();
    for (const t of m.tasks.filter((t) => t.p === p.key && t.group !== "closed").sort((a, b) => rank(a.state) - rank(b.state))) counts.set(t.label, (counts.get(t.label) ?? 0) + 1);
    L.push(`- ${item(`${p.key}: ${counts.size ? [...counts].map(([label, n]) => `${n} ${label}`).join(" · ") : "no open tasks"}`)}`);
  }
  if (m.projects.length > CAPS.projects) L.push(`- and ${m.projects.length - CAPS.projects} more`);
  L.push("", `Full board on the Mac: ${shownRoot(m)}/board.html`);
  return L;
}

/** The compact board for the chat: Markdown lines, the same for the same model. */
export function textBoard(model) {
  return lines(view(model)).join("\n");
}

const TEMPLATE = new URL("./board.html", import.meta.url);
const hash = (s) => `'sha256-${createHash("sha256").update(s, "utf8").digest("base64")}'`;

/** The whole page: the template, the checked model in one JSON block, and a CSP that allows only the page's own code. */
export function pageHtml(model) {
  const v = view(model);
  v.text = lines(v);
  const template = readFileSync(TEMPLATE, "utf8");
  const style = /<style>([\s\S]*?)<\/style>/.exec(template)[1];
  const code = /<script>([\s\S]*?)<\/script>/.exec(template)[1];
  const csp = `default-src 'none'; script-src ${hash(code)}; style-src ${hash(style)}; base-uri 'none'; form-action 'none'`;
  // In the JSON, < > & and the two line separators become \u escapes, so the data can never close its script tag.
  const json = JSON.stringify(v).replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return template.replace("{{CSP}}", () => csp).replace("{{BOARD_DATA}}", () => json);
}

/** The page of one project: a fixed stub that opens the all-projects page on that project. It never needs a rebuild. */
export function stubHtml(key) {
  if (!KEY(key)) throw new TypeError(`board: "${key}" is not a project key`);
  const url = `../board.html#/p/${key}`;
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy" content="default-src 'none'">\n<meta http-equiv="refresh" content="0;url=${url}">\n<title>sage board · ${key}</title>\n</head>\n<body>\n<p><a href="${url}">Open the sage board for ${key}</a></p>\n</body>\n</html>\n`;
}
