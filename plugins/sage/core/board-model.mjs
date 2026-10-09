import { basename } from "node:path";
// One semantic model for HTML, chat and the read-only server.
const COLUMNS = [
  ["backlog", "Backlog", ["framed"]],
  ["design", "Design", ["designing", "awaiting-you"]],
  ["building", "Building", ["briefed", "building", "repairing", "held", "replan"]],
  ["review", "In review", ["reviewing", "verifying"]],
  ["ready", "Ready to merge", ["verified", "pr-ready"]],
  ["done", "Done", ["merged", "concluded"]],
];
const CLEAN = { checks: "checks-pass", "code-review": "review-clean", "security-review": "security-clean", "ux-review": "ux-clean", qa: "qa-pass", "evidence-review": "evidence-clean" };
const FAILED = { checks: ["checks-fail"], qa: ["qa-fail"], "code-review": ["findings"], "security-review": ["findings"], "ux-review": ["findings"] };
const RUN_ROLE = { "code-review": "code-reviewer", "security-review": "security-reviewer", "ux-review": "ux-reviewer" };
const time = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const rows = (project, name, task) => (project.tables[name] ?? []).filter(row => row.task === task.id);
const positive = value => /^([1-9]\d*)$/.test(String(value)) ? Number(value) : null;

function latest(records, kind, accept = () => true) {
  return records.filter(record => record.kind === kind && accept(record.data)).reduce((best, record) => !best || Date.parse(record.observedAt) >= Date.parse(best.observedAt) ? record : best, null);
}

function briefFields(text) {
  const fields = {}; let field = null;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const match = /^(?:[ \t]|[*_#|>-])*([A-Z]+)\b[*_]*(?:[ \t]*:[*_ \t]*|[ \t]+|$)(.*)$/i.exec(line);
    if (match && ["GOAL", "SCOPE", "CONTEXT", "DECISIONS", "ACCEPTANCE", "VERIFY", "BUDGET", "FORBIDDEN", "REPORT", "STANDING"].includes(match[1].toUpperCase())) { field = match[1].toUpperCase(); fields[field] = match[2]; }
    else if (field) fields[field] += `\n${line}`;
  }
  return { goal: fields.GOAL?.trim() || null, acceptance: fields.ACCEPTANCE?.trim() || null };
}
function loopFor(task, route, cycles, head, reasons, runs) {
  const active = ["designing", "awaiting-you"].includes(task.state) && route.includes("pe") && runs.some(run => run.role === "pe" && run.status === "running") ? "PE check" : { framed: "framed", designing: "design", "awaiting-you": "design", briefed: "briefed", building: "build", reviewing: "review", verifying: "review", repairing: "repair", verified: "verified", "pr-ready": "verified", merged: "merge", concluded: "verified" }[task.state] ?? null;
  const stages = ["framed", "design", "PE check", "briefed", "build", "review", "repair", "verified", "merge"];
  const index = stages.indexOf(active);
  const steps = stages.map((label, i) => {
    const skipped = label === "design" && !route.includes("design") || label === "PE check" && !route.includes("pe") || label === "build" && !route.includes("build") || label === "merge" && !route.includes("build") || label === "repair" && Number(task.round) === 0;
    return { label, status: skipped ? "skipped" : label === active ? reasons.length ? "needs-owner" : "current" : index >= 0 && i < index ? "done" : "pending" };
  });
  const cycle = cycles.find(c => c.steps.some(s => s.status !== "done")) ?? cycles.at(-1);
  const running = cycle?.steps.filter(s => s.status === "running").map(s => s.role) ?? [];
  const explanation = reasons.length ? reasons.map(reason => reason.text).join(" ") : active === "PE check" ? "The PE check is recorded running." : running.length ? `Cycle ${cycle.number} of ${cycles.length} on head ${head?.slice(0, 7) ?? "unknown"}: ${running.join(", ")} runs now.` : `Recorded state: ${task.state}. ${head ? `Review evidence uses head ${head.slice(0, 7)}.` : "The current PR head is unknown."}`;
  return { steps, explanation };
}

function card(source, project, task, now) {
  const records = (project.observations?.records ?? []).filter(record => record.task === task.id && time(record.observedAt) !== null && time(record.observedAt) <= now);
  const pr = latest(records, "pr", data => String(data.number) === task.pr);
  const completion = latest(records, "completion", data => data.state === task.state);
  const mode = latest(records, "mode");
  const runs = rows(project, "runs", task).map(run => ({ ...run, evidence: latest(records, "run", data => data.run === run.id) }));
  const agents = runs.filter(run => run.status === "running").map(run => ({ id: run.id, role: run.role, provider: run.evidence?.data.provider ?? null, evidence: run.evidence, recordedStatus: run.status }));
  const ledger = rows(project, "ledger", task);
  const gates = rows(project, "gates", task).filter(gate => !gate.answer);
  const reasons = gates.map(gate => ({ kind: "gate", key: `${project.key}/${gate.id}`, text: gate.question, recommendation: gate.recommendation || null, gateId: gate.id, options: gate.options ? gate.options.split("|").map(option => option.trim()) : [] }));
  if (["held", "replan"].includes(task.state)) reasons.push({ kind: task.state, text: task.state === "held" ? "The task is held." : "The task needs a new plan." });
  if (["verified", "pr-ready"].includes(task.state)) {
    if (!mode || !mode.data.autopilot) reasons.push({ kind: "merge", text: mode ? "Autopilot is off. The owner can review the merge." : "Autopilot state is unknown. The owner must review the merge." });
  }
  const head = pr?.data.head ?? null;
  const current = head ? ledger.filter(row => row.sha === head && String(row.pr) === task.pr) : [];
  const route = task.route.split(",").filter(Boolean);
  const steps = [...(route.includes("build") ? ["checks"] : []), ...route.filter(block => CLEAN[block])];
  const required = Math.max(positive(source.config?.["cycles.small"]) ?? 1, task.size === "large" ? Math.max(2, positive(source.config?.["cycles.large"] ?? source.config?.autopilot_cycles) ?? 2) : 1, task.risk ? Math.max(2, positive(source.config?.["cycles.risk"]) ?? 2) : 1);
  const cycles = Array.from({ length: Math.min(required, 10) }, (_, i) => ({ number: i + 1, steps: steps.map(role => {
    const evidence = current.filter(row => role === "checks" || positive(row.cycle) === i + 1);
    const relevant = evidence.filter(row => row.kind === CLEAN[role] || (FAILED[role] ?? []).includes(row.kind) && (row.kind !== "findings" || runs.some(run => run.id === row.run && run.role === (RUN_ROLE[role] ?? role))));
    const last = relevant.at(-1);
    const running = runs.find(run => run.status === "running" && run.role === (RUN_ROLE[role] ?? role) && run.evidence?.data.head === head && run.evidence?.data.cycle === i + 1);
    return { role, status: !head ? "unknown" : last ? last.kind === CLEAN[role] ? "done" : "failed" : running ? "running" : "pending", evidence: last ?? null, run: running?.id ?? null };
  }) }));
  for (const [index, row] of current.entries()) {
    if (!["checks-fail", "qa-fail"].includes(row.kind)) continue;
    // The ledger is append-only; order resolves equal second-precision timestamps.
    const newer = current.slice(index + 1).find(other => other.kind === (row.kind === "checks-fail" ? "checks-pass" : "qa-pass") && other.cycle === row.cycle);
    if (!newer) reasons.push({ kind: row.kind, text: `${row.kind === "checks-fail" ? "Checks" : "QA"} failed on the recorded PR head.`, evidence: row });
  }
  const inferred = pr?.data.state === "open" && task.branch.startsWith("codex/") && !agents.length;
  if (inferred && !["merged", "concluded", "abandoned"].includes(task.state)) reasons.push({ kind: "review-wait", text: "The PR has inferred provider work and waits for review." });
  const column = COLUMNS.find(([, , states]) => states.includes(task.state))?.[0] ?? null;
  const completionDecision = rows(project, "decisions", task).filter(row => row.decision === `state ${task.state}`).at(-1);
  const completedAt = completion ? time(completion.data.at) : ["merged", "concluded", "abandoned"].includes(task.state) ? time(completionDecision?.at) : null;
  const brief = project.contents?.[latest(records, "artifact", data => data.type === "brief")?.id]?.text ?? null;
  return { key: `${project.key}/${task.id}`, source: source.id, sourceLabel: source.label, project: project.key, projectName: project.checkout ? basename(project.checkout) : project.name.replace(/-[0-9a-f]{6}$/, ""), ...Object.fromEntries(["id", "title", "size", "risk", "route", "state", "branch", "pr", "round", "keys"].map(field => [field, task[field] ?? ""])), column, prEvidence: pr, currentHead: head, modeEvidence: mode, completedAt, visible: column !== "done" || completedAt !== null && completedAt <= now && completedAt >= now - 7 * 86400000, agents, inferredWork: inferred, cycles, requiredCycles: required, reasons, runs, ledger, gates, findings: rows(project, "findings", task), decisions: rows(project, "decisions", task).slice(-10), brief, briefFields: briefFields(brief), loop: loopFor(task, route, cycles, head, reasons, runs), artifacts: records.filter(record => record.kind === "artifact").map(record => ({ ...record, content: project.contents?.[record.id] ?? null })), diagnostics: [...project.diagnostics] };
}

export function buildBoardModel(sources, { now = new Date().toISOString() } = {}) {
  const at = time(now);
  if (at === null) throw new TypeError("board time must be an ISO date");
  const tasks = sources.flatMap(source => source.projects.flatMap(project => (project.tables.tasks ?? []).filter(task => /^T[1-9]\d*$/.test(task.id)).map(task => card(source, project, task, at))));
  const visible = tasks.filter(task => task.visible && task.column);
  return { at: new Date(at).toISOString(), tasks, columns: COLUMNS.map(([key, name]) => ({ key, name, tasks: visible.filter(task => task.column === key), needsOwner: visible.some(task => task.column === key && task.reasons.length) })), needsOwner: visible.filter(task => task.reasons.length), counts: { tasks: visible.length, needsOwner: visible.filter(task => task.reasons.length).length, recordedAgents: visible.reduce((n, task) => n + task.agents.length, 0), inferredWork: visible.filter(task => task.inferredWork).length, inReview: visible.filter(task => task.column === "review").length }, sources: sources.map(source => ({ id: source.id, label: source.label, diagnostics: source.diagnostics })), diagnostics: sources.flatMap(source => [...source.diagnostics.map(message => ({ source: source.id, message })), ...source.projects.flatMap(project => project.diagnostics.map(message => ({ source: source.id, project: project.key, message })))]) };
}
