// A hostile board model, made from the sample (sample data, made up). Every free-text field carries PAYLOAD, and the
// checked fields carry values that must not pass their checks. The tests and the browser check use it.
import { readFileSync } from "node:fs";

export const PAYLOAD = ` <img src=x onerror="document.title='PWNED'"><i data-pwn>" data-pwn="1' data-pwn='1 </script><!--<script> javascript:alert(1) \u2028end`;
export const LONG = "W".repeat(2000);

export const sample = () => JSON.parse(readFileSync(new URL("./sample.json", import.meta.url), "utf8"));

export function hostileModel() {
  const m = sample();
  const X = (s) => (s ? s + PAYLOAD : s);
  m.sample = true;
  for (const c of Object.values(m.chiefs)) c.name = X(c.name);
  for (const t of m.tasks) { t.title = X(t.title); t.branch = X(t.branch); }
  for (const r of m.runs) {
    r.model = X(r.model);
    if (r.brief) r.brief.head = X(r.brief.head);
    for (const s of r.steers) s.text = X(s.text);
    for (const x of r.reports) { x.result = X(x.result); x.head = X(x.head); x.branch = X(x.branch); }
    if (r.transcript) r.transcript.src = X(r.transcript.src);
    for (const c of r.children) { c.type = X(c.type); c.description = X(c.description); c.model = X(c.model); }
  }
  for (const f of m.findings) { f.key = X(f.key); f.summary = X(f.summary); f.reason = X(f.reason); }
  for (const g of m.gates) { g.question = X(g.question); g.options = g.options.map(X); g.recommendation = X(g.recommendation); g.default = X(g.default); g.answer = X(g.answer); }
  for (const d of m.decisions) { d.decision = X(d.decision); d.why = X(d.why); }
  // Very long values: a title with no space, and a gate question for the 160-character cut of the text board.
  m.tasks.find((t) => t.p === "tide-notes" && t.id === "T1").title += LONG;
  m.gates[0].question += " " + "x".repeat(400);
  // Checked fields with values that must fail their checks.
  const task = (p, id) => m.tasks.find((t) => t.p === p && t.id === id);
  task("ramen-finder", "T2").pr = '42" onmouseover="alert(1)';
  task("ramen-finder", "T4").risk.push("<i data-pwn>");
  task("pocket-atlas", "T5").state = '"><i data-pwn>';
  m.projects[0].repo = "javascript:alert(1)//github.com/a/b";
  m.projects[1].repo = "https://evil.example/github.com/a/b";
  m.projects[1].failed = { at: "2026-10-03T14:19:00", error: X("sage could not read events/b71e07aa.jsonl line 212: it is not JSON."), lastGood: "2026-10-03T14:02:00" };
  const r9 = m.runs.find((r) => r.p === "ramen-finder" && r.id === "R9");
  r9.reports[0].sha = "<b>a1b2c3d</b>";
  r9.from.push('R1"><i data-pwn>');
  r9.tokens = "<i data-pwn>";
  m.ledger[0].cycle = "1<i data-pwn>";
  m.tasks.push({ p: "ramen-finder", id: 'T9"><i data-pwn>', title: "dropped: bad id", size: "tiny", risk: [], route: ["build"], state: "building", branch: "", pr: null, round: 0 });
  m.chiefs['"><i data-pwn>'] = { name: "dropped: bad session id", open: true, closedAt: null };
  return m;
}
