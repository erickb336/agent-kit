#!/usr/bin/env node
// sage: the state tool of sage mode. The chief of staff calls it through the shell: one command in, one line out.
// The store is plain TSV and Markdown in ~/.claude/sage/<project>-<hash>/ ($SAGE_HOME overrides the root), and every
// table has one writer: this tool. It holds the rules that prompts alone did not hold in Orchestrator: no dropped
// findings, bounded repair rounds, one writer per branch, and a merge only of a head SHA with the clean cycles that
// its route needs. The sage hook calls mergeCheck before any `gh pr merge` in sage mode.
// Several chief sessions may share one store: each command that changes it holds the store's lock (withLock).
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, hostname, uptime } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The least route for each size. The chief may add blocks, never remove these. */
export const SIZES = {
  tiny: ["build"],
  small: ["build", "code-review", "qa"],
  large: ["design", "pe", "build", "code-review", "security-review", "ux-review", "qa"],
  investigate: ["investigate", "evidence-review"],
};
export const BLOCKS = ["design", "arena", "pe", "build", "code-review", "security-review", "ux-review", "qa", "investigate", "evidence-review"];
export const RISKS = ["auth", "data", "schema", "money", "secrets", "input"];
/** The verdict a block gives on a head SHA. checks-pass is needed once per SHA; the others once per cycle. */
const VERDICT = { build: "checks-pass", "code-review": "review-clean", "security-review": "security-clean", "ux-review": "ux-clean", qa: "qa-pass", "evidence-review": "evidence-clean" };
const NOT_CLEAN = ["checks-fail", "findings", "qa-fail"];
export const KINDS = [...Object.values(VERDICT), ...NOT_CLEAN];
const WRITERS = ["implementer", "designer"];
/** A task's states and the moves between them (docs/design/sage-mode.html, "A task's life"). Any state may go to abandoned. */
const NEXT = {
  framed: ["designing", "briefed"],
  designing: ["awaiting-you"],
  "awaiting-you": ["briefed", "designing"],
  briefed: ["building"],
  building: ["held", "reviewing"],
  held: ["building", "briefed"],
  reviewing: ["verifying"],
  repairing: ["reviewing"],
  replan: ["briefed"],
  verifying: ["verified", "concluded"], // verified for a route with build; concluded for one without
  verified: ["merged", "pr-ready", "reviewing"],
  "pr-ready": ["merged", "reviewing"],
  merged: [],
  concluded: [],
  abandoned: [],
};
export const DEFAULTS = { max_agents: 3, autopilot_cycles: 2, max_rounds: 3, arena: 3, arena_models: "opus,sonnet,sonnet" };
/** The counts in the config, and what a 0 would do. Each count is a whole number of 1 or more. */
const COUNTS = { max_agents: "no sage agent could start", autopilot_cycles: "a merge would need no review", max_rounds: "no repair round could start", arena: "an arena would have no candidates" };
const MODELS = ["opus", "sonnet", "haiku", "inherit"];
const TABLES = {
  tasks: ["id", "title", "size", "risk", "route", "state", "branch", "pr", "round", "keys"],
  runs: ["id", "task", "role", "round", "candidate", "branch", "status", "tokens", "report", "started", "ended"],
  findings: ["task", "key", "round", "source", "severity", "summary", "triage", "reason", "status"],
  ledger: ["task", "pr", "sha", "kind", "cycle", "run", "at"],
  gates: ["id", "task", "question", "options", "recommendation", "default", "answer", "at"],
  decisions: ["at", "task", "decision", "why"],
};
const STANDING = `# Standing orders

Every brief carries these lines word for word. Add a line when you notice that you repeat an instruction.

1. Work only in your own worktree and branch. Never merge, never force-push, never push to main.
2. Stop at a product question: report it with your recommendation. Do not guess.
3. Every claim in your report has its evidence: the command and its output, or a screenshot.
4. Reviewers and QA report only correctness, requirements and security problems, not style.
`;

class Refusal extends Error {}
const refuse = (message) => {
  throw new Refusal(message);
};

export function sageRoot(env = process.env) {
  return env.SAGE_HOME ?? join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "sage");
}

/** The main checkout of a project, also from inside one of its worktrees. */
function projectRoot(path) {
  try {
    const common = execFileSync("git", ["-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return dirname(common);
  } catch {
    return resolve(path);
  }
}

export function storeDir(project, env = process.env) {
  const root = projectRoot(resolve(project));
  const name = basename(root).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";
  return join(sageRoot(env), `${name}-${createHash("sha1").update(root).digest("hex").slice(0, 6)}`);
}

/** A config value in its stored form, or undefined when it is not valid. */
function valid(key, value) {
  if (key === "arena_models") {
    const models = list(String(value));
    return models.length && models.every((m) => MODELS.includes(m)) ? models.join(",") : undefined;
  }
  return Object.hasOwn(COUNTS, key) && /^[1-9]\d*$/.test(String(value)) ? Number(value) : undefined;
}

/** The settings for all projects. The hooks call this, so it never throws: a missing, torn or bad value gives its default. */
export function config(env = process.env) {
  let saved = {};
  try {
    saved = JSON.parse(readFileSync(join(sageRoot(env), "config.json"), "utf8")) ?? {};
  } catch {}
  return Object.fromEntries(Object.entries(DEFAULTS).map(([k, d]) => [k, valid(k, saved[k]) ?? d]));
}

/** Writes a whole file or nothing: readers take no lock, so they must never see half a file. */
function put(file, text) {
  writeFileSync(`${file}.${process.pid}`, text);
  renameSync(`${file}.${process.pid}`, file);
}

const cell = (v) => String(v ?? "").replace(/[\t\r\n]+/g, " ").trim();

function read(dir, table) {
  const f = join(dir, `${table}.tsv`);
  if (!existsSync(f)) return [];
  const [head, ...lines] = readFileSync(f, "utf8").split("\n").filter(Boolean);
  const cols = head.split("\t");
  return lines.map((line) => {
    const v = line.split("\t");
    return Object.fromEntries(cols.map((c, i) => [c, v[i] ?? ""]));
  });
}

function write(dir, table, rows) {
  const cols = TABLES[table];
  put(join(dir, `${table}.tsv`), [cols.join("\t"), ...rows.map((r) => cols.map((c) => cell(r[c])).join("\t"))].join("\n") + "\n");
}

const now = () => new Date().toISOString().slice(0, 19) + "Z";
/** The highest number after the prefix, plus 1. A row lost before the lock came cannot make an id that is in use. */
const nextId = (ids, prefix) => `${prefix}${Math.max(0, ...ids.filter((i) => i.startsWith(prefix)).map((i) => Number(i.slice(prefix.length)) || 0)) + 1}`;
const list = (s) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : []);

function parse(args) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) pos.push(a);
    else if (a.includes("=")) opt[a.slice(2, a.indexOf("="))] = a.slice(a.indexOf("=") + 1);
    else opt[a.slice(2)] = i + 1 < args.length ? args[++i] : "true"; // every option takes a value, which may start with "--"
  }
  return { pos, opt };
}

const need = (value, what) => value || refuse(`missing ${what}`);

function taskOf(dir, id) {
  const tasks = read(dir, "tasks");
  const task = tasks.find((t) => t.id === id) ?? refuse(`no task ${id}`);
  return { tasks, task };
}

function move(task, to) {
  if (to !== "abandoned" && !(NEXT[task.state] ?? []).includes(to)) refuse(`${task.id} cannot go from ${task.state} to ${to}. Next: ${(NEXT[task.state] ?? []).join(", ") || "none"}`);
  task.state = to;
}

/**
 * The judgment of the merge gate: does this head SHA have the clean cycles its route needs? Searches every project's
 * ledger for the SHA. One clean cycle makes a task verified; an autopilot merge wants autopilot_cycles of them.
 */
export function mergeCheck(sha, env = process.env, cycles = config(env).autopilot_cycles) {
  const root = sageRoot(env);
  const same = (a) => a && (a.startsWith(sha) || sha.startsWith(a)) && Math.min(a.length, sha.length) >= 7;
  const dirs = existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(root, d.name)) : [];
  for (const dir of dirs) {
    const rows = read(dir, "ledger").filter((r) => same(r.sha));
    if (!rows.length) continue;
    const task = read(dir, "tasks").find((t) => t.id === rows[0].task);
    if (!task) return { ok: false, reason: `the ledger names task ${rows[0].task}, which does not exist` };
    const open = read(dir, "findings").filter((f) => f.task === task.id && f.status === "open");
    if (open.length) return { ok: false, reason: `${task.id} has open findings: ${open.map((f) => f.key).join(", ")}. Triage and close them first.` };
    const bad = rows.find((r) => NOT_CLEAN.includes(r.kind));
    if (bad) return { ok: false, reason: `${task.id}: cycle ${bad.cycle} found problems on this SHA (${bad.kind}). Repair, then review the new SHA.` };
    if (!rows.some((r) => r.kind === "checks-pass")) return { ok: false, reason: `${task.id}: no checks-pass on this SHA.` };
    const perCycle = list(task.route).map((b) => VERDICT[b]).filter((k) => k && k !== "checks-pass");
    const want = perCycle.length ? cycles : 1;
    const clean = perCycle.length ? [...new Set(rows.map((r) => r.cycle))].filter((c) => perCycle.every((k) => rows.some((r) => r.cycle === c && r.kind === k))).length : 1;
    if (clean < want) {
      const missing = perCycle.filter((k) => !rows.some((r) => r.kind === k));
      return { ok: false, reason: `${task.id}: ${clean} of ${want} clean cycles on this SHA${missing.length ? `; never recorded: ${missing.join(", ")}` : ""}.` };
    }
    return { ok: true, task: task.id, reason: `${task.id} may merge: ${clean} clean cycle${clean === 1 ? "" : "s"} on this SHA` };
  }
  return { ok: false, reason: `no verdicts recorded for ${sha}. Record the reviews and QA with sage verdict first.` };
}

/** The status lines. With save, also status.md: only a command that holds the lock saves, so status.md never lags. */
function status(dir, save) {
  const tasks = read(dir, "tasks");
  const runs = read(dir, "runs");
  const gates = read(dir, "gates").filter((g) => !g.answer);
  const count = {};
  for (const t of tasks) count[t.state] = (count[t.state] ?? 0) + 1;
  const tokens = runs.reduce((n, r) => n + (Number(r.tokens) || 0), 0);
  const lines = [
    `sage · ${basename(dir)} · ${now().slice(11, 16)} UTC`,
    `tasks   ${tasks.length}${Object.entries(count).map(([s, n]) => ` · ${s} ${n}`).join("")}`,
    `gates   ${gates.length} open${gates.map((g) => ` · ${g.id} ${g.question} (default: ${g.default || "none"})`).join("")}`,
    `agents  ${runs.length} runs · ${runs.filter((r) => r.status === "running").length} running · about ${Math.round(tokens / 1000)}k tokens`,
  ];
  const table = ["", "| Task | State | Size | Round | PR | Title |", "| --- | --- | --- | --- | --- | --- |", ...tasks.map((t) => `| ${t.id} | ${t.state} | ${t.size} | ${t.round} | ${t.pr} | ${t.title} |`)];
  if (save) put(join(dir, "status.md"), [`# ${lines[0]}`, "", ...lines.slice(1).map((l) => `    ${l}`), ...table].join("\n") + "\n");
  return lines.join("\n");
}

/** Runs one command and returns its output line(s). A refused command throws, with the reason. */
export function sage(argv, env = process.env) {
  const [cmd, ...rest] = argv;
  const { pos, opt } = parse(rest);
  if (cmd === "merge-check") {
    const cycles = opt.cycles === undefined ? undefined : (valid("autopilot_cycles", opt.cycles) ?? refuse("--cycles is a whole number of 1 or more"));
    const r = mergeCheck(need(opt.sha, "--sha"), env, cycles);
    return r.ok ? r.reason : refuse(r.reason);
  }
  if (cmd === "config") {
    const cfg = config(env);
    for (const kv of pos) {
      const [k, v = ""] = kv.split("=");
      if (Object.hasOwn(COUNTS, k) && valid(k, v) === undefined) refuse(`${k} must be a whole number of 1 or more: with 0, ${COUNTS[k]}`);
      cfg[k] = valid(k, v) ?? refuse(`config takes max_agents, autopilot_cycles, max_rounds and arena as key=number, and arena_models as a list of ${MODELS.join(", ")}`);
    }
    if (pos.length) {
      mkdirSync(sageRoot(env), { recursive: true });
      put(join(sageRoot(env), "config.json"), JSON.stringify(cfg, null, 2) + "\n");
    }
    return Object.entries(cfg).map(([k, v]) => `${k}=${v}`).join(" ");
  }
  const dir = storeDir(opt.project ?? env.SAGE_PROJECT ?? process.cwd(), env);
  if (cmd !== "init" && !existsSync(join(dir, "tasks.tsv"))) refuse(`no store for this project. Run: sage init --project <path>`);
  // A read takes no lock: every file is replaced whole, so it sees the store before or after a change, never half of one.
  if (["store", "status"].includes(cmd) || (cmd === "standing" && pos[0] !== "add")) return act(cmd, pos, opt, dir, env);
  if (cmd === "init") {
    mkdirSync(join(dir, "briefs"), { recursive: true });
    mkdirSync(join(dir, "reports"), { recursive: true });
  }
  return withLock(dir, () => {
    const out = act(cmd, pos, opt, dir, env);
    status(dir, true);
    return out;
  });
}

function act(cmd, pos, opt, dir, env) {
  const [sub, id, ...more] = pos;
  switch (cmd) {
    case "init":
      for (const t of Object.keys(TABLES)) if (!existsSync(join(dir, `${t}.tsv`))) write(dir, t, []);
      if (!existsSync(join(dir, "standing.md"))) put(join(dir, "standing.md"), STANDING);
      return `store ${dir}`;
    case "store":
      return dir;
    case "standing": {
      if (sub === "add") {
        const text = readFileSync(join(dir, "standing.md"), "utf8").trimEnd();
        const n = (text.match(/^\d+\./gm) ?? []).length + 1;
        put(join(dir, "standing.md"), `${text}\n${n}. ${cell(need([id, ...more].join(" "), "the order's text"))}\n`);
        return `standing order ${n} added`;
      }
      return readFileSync(join(dir, "standing.md"), "utf8").trimEnd();
    }
    case "task": {
      if (sub === "add") {
        const size = need(opt.size, "--size");
        if (!SIZES[size]) refuse(`size is one of ${Object.keys(SIZES).join(", ")}`);
        const risk = list(opt.risk);
        const odd = [...risk.filter((r) => !RISKS.includes(r)), ...list(opt.add).filter((b) => !BLOCKS.includes(b))];
        if (odd.length) refuse(`unknown: ${odd.join(", ")}. Risks: ${RISKS.join(", ")}. Blocks: ${BLOCKS.join(", ")}`);
        const why = opt.add ? need(opt.why, "--why for the added blocks") : ""; // refuse before anything is written
        const blocks = new Set([...SIZES[size], ...(risk.length && size !== "investigate" ? ["security-review"] : []), ...list(opt.add)]);
        const route = BLOCKS.filter((b) => blocks.has(b)); // the blocks in their order
        const tasks = read(dir, "tasks");
        const task = { id: nextId(tasks.map((t) => t.id), "T"), title: need(opt.title, "--title"), size, risk: risk.join(","), route: route.join(","), state: "framed", round: 0 };
        write(dir, "tasks", [...tasks, task]);
        if (opt.add) write(dir, "decisions", [...read(dir, "decisions"), { at: now(), task: task.id, decision: `added ${opt.add}`, why }]);
        return `${task.id} framed · ${size}${risk.length ? ` · risk ${risk.join(",")}` : ""} · route ${task.route}`;
      }
      const { tasks, task } = taskOf(dir, need(sub, "the task id")); // task <T> [set key=value ...]
      if (id === "set") {
        for (const kv of more) {
          const [k, v] = [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)];
          if (k === "state") {
            if (v === "repairing") refuse("start a repair with: sage round <task>");
            move(task, v); // the design's states first; the table is written only if every check below passes
            const build = list(task.route).includes("build");
            if ((v === "verified" && !build) || (v === "concluded" && build)) refuse(`${task.id} ${build ? "has a build block, so it ends at verified" : "has no build block, so it ends at concluded"}`);
            if (v === "verifying" || v === "concluded") {
              const open = read(dir, "findings").filter((f) => f.task === task.id && f.status === "open");
              if (open.length) refuse(`${task.id} has open findings: ${open.map((f) => `${f.key} (${f.triage || "not triaged"})`).join(", ")}. Close or dismiss each one first.`);
            }
            if (v === "concluded" && read(dir, "ledger").filter((r) => r.task === task.id).at(-1)?.kind !== "evidence-clean") {
              refuse(`${task.id} needs a clean evidence review as its latest verdict: sage verdict ${task.id} --kind evidence-clean --run <R>`);
            }
            if (v === "verified") {
              const head = read(dir, "ledger").filter((r) => r.task === task.id).at(-1)?.sha ?? refuse(`${task.id} has no verdicts yet`);
              const r = mergeCheck(head, env, 1);
              if (!r.ok) refuse(`${task.id} is not verified on ${head.slice(0, 7)}: ${r.reason}`);
            }
          } else if (["branch", "pr", "title"].includes(k)) task[k] = v;
          else refuse(`task set takes state=, branch=, pr= or title=`);
        }
        write(dir, "tasks", tasks);
      }
      return `${task.id} ${task.state} · ${task.size} · round ${task.round} · route ${task.route}${task.branch ? ` · ${task.branch}` : ""}${task.pr ? ` · PR ${task.pr}` : ""}`;
    }
    case "round": {
      const { tasks, task } = taskOf(dir, need(sub, "the task id"));
      if (!["reviewing", "verifying"].includes(task.state)) refuse(`${task.id} is ${task.state}. A repair starts from reviewing or verifying.`);
      const fix = read(dir, "findings").filter((f) => f.task === task.id && f.status === "open" && f.triage === "fix");
      const keys = fix.map((f) => f.key).sort().join(",");
      if (!keys) refuse(`${task.id} has no open findings marked fix`);
      if (fix.every((f) => f.severity === "low")) refuse(`${task.id}: only low findings are marked fix (${keys}). A repair round needs a medium or high finding. Dismiss the low ones with a reason, or let them join the next round.`);
      const round = Number(task.round) + 1;
      if (round > config(env).max_rounds) {
        task.state = "held";
        write(dir, "tasks", tasks);
        return `${task.id} held: ${round - 1} repair rounds did not make it clean. Stop and ask the user.`;
      }
      if (keys === task.keys) {
        task.state = "replan";
        write(dir, "tasks", tasks);
        return `${task.id} replan: round ${round - 1} did not fix ${keys}. Attack the premise, then brief again.`;
      }
      Object.assign(task, { state: "repairing", round, keys });
      write(dir, "tasks", tasks);
      return `${task.id} repairing · round ${round} of ${config(env).max_rounds} · fix ${keys}`;
    }
    case "run": {
      const runs = read(dir, "runs");
      if (sub === "add") {
        const { task } = taskOf(dir, need(id, "the task id"));
        const role = need(opt.role, "--role");
        const branch = opt.branch ?? "";
        if (WRITERS.includes(role)) {
          if (!branch) refuse(`a ${role} run needs --branch`);
          const other = runs.find((r) => r.branch === branch && r.status === "running" && WRITERS.includes(r.role));
          if (other) refuse(`${other.id} (${other.role}) still writes ${branch}. One writer per branch.`);
        }
        const run = { id: nextId(runs.map((r) => r.id), "R"), task: task.id, role, round: task.round, candidate: opt.candidate ?? "", branch, status: "running", started: now() };
        write(dir, "runs", [...runs, run]);
        return `${run.id} running · ${role} on ${task.id}${branch ? ` · ${branch}` : ""}${run.candidate ? ` · candidate ${run.candidate}` : ""}`;
      }
      if (sub === "done") {
        const run = runs.find((r) => r.id === id) ?? refuse(`no run ${id}`);
        const st = need(opt.status, "--status");
        if (!["done", "blocked", "question", "failed"].includes(st)) refuse("status is done, blocked, question or failed");
        Object.assign(run, { status: st, tokens: opt.tokens ?? run.tokens, report: opt.report ?? run.report, ended: now() });
        write(dir, "runs", runs);
        return `${run.id} ${st}`;
      }
      refuse("run add or run done");
    }
    case "finding": {
      const findings = read(dir, "findings");
      if (sub === "add") {
        const { task } = taskOf(dir, need(id, "the task id"));
        const severity = need(opt.severity, "--severity");
        if (!["high", "medium", "low"].includes(severity)) refuse("severity is high, medium or low");
        const key = opt.key ?? nextId(findings.filter((f) => f.task === task.id).map((f) => f.key), `F-${task.id}-`);
        const again = findings.find((f) => f.task === task.id && f.key === key);
        if (again) Object.assign(again, { status: "open", triage: "", round: task.round }); // it came back
        else findings.push({ task: task.id, key, round: task.round, source: need(opt.source, "--source"), severity, summary: need(opt.summary, "--summary"), status: "open" });
        write(dir, "findings", findings);
        return `${key} open${again ? " again" : ""} · ${severity} · ${task.id}`;
      }
      const f = findings.find((x) => x.task === id && x.key === more[0]) ?? refuse(`no finding ${more[0]} on ${id}`);
      if (sub === "triage") {
        const t = need(more[1], "fix, dismiss or ask");
        if (!["fix", "dismiss", "ask"].includes(t)) refuse("triage is fix, dismiss or ask");
        if (t === "dismiss") Object.assign(f, { reason: need(opt.reason, "--reason for a dismissal"), status: "dismissed" });
        f.triage = t;
      } else if (sub === "close") {
        if (f.triage !== "fix" && f.triage !== "ask") refuse(`${f.key} is not triaged as fix or ask`);
        f.status = "closed";
      } else refuse("finding add, triage or close");
      write(dir, "findings", findings);
      return `${f.key} ${f.status} · ${f.triage}`;
    }
    case "verdict": {
      const { tasks, task } = taskOf(dir, need(sub, "the task id"));
      const kind = need(opt.kind, "--kind");
      if (!KINDS.includes(kind)) refuse(`kind is one of ${KINDS.join(", ")}`);
      // A route without build has no commit to judge. Its rows have no SHA, so the merge gate never reads them.
      const sha = list(task.route).includes("build") ? need(opt.sha, "--sha") : "";
      if (!sha && opt.sha) refuse(`${task.id} has no build block, so its verdicts name no commit: leave out --sha`);
      if (sha && !/^[0-9a-f]{7,40}$/.test(sha)) refuse("--sha is a git commit SHA");
      if (opt.pr) task.pr = opt.pr;
      write(dir, "tasks", tasks);
      write(dir, "ledger", [...read(dir, "ledger"), { task: task.id, pr: task.pr, sha, kind, cycle: opt.cycle ?? "1", run: opt.run ?? "", at: now() }]);
      const open = NOT_CLEAN.includes(kind) ? [] : read(dir, "findings").filter((f) => f.task === task.id && f.status === "open" && f.triage === "fix");
      return `${task.id} ${kind}${sha ? ` · ${sha.slice(0, 7)}` : ""} · cycle ${opt.cycle ?? "1"}${open.length ? ` · still open: ${open.map((f) => f.key).join(", ")}. Close the ones that this review confirmed fixed.` : ""}`;
    }
    case "gate": {
      const gates = read(dir, "gates");
      if (sub === "add") {
        const g = { id: nextId(gates.map((x) => x.id), "G"), task: id ?? "", question: need(opt.question, "--question"), options: need(opt.options, "--options"), recommendation: need(opt.recommend, "--recommend"), default: opt.default ?? "", at: now() };
        write(dir, "gates", [...gates, g]);
        return `${g.id} open · ${g.question}`;
      }
      if (sub === "answer") {
        const g = gates.find((x) => x.id === id) ?? refuse(`no gate ${id}`);
        g.answer = need(more.join(" "), "the answer");
        write(dir, "gates", gates);
        write(dir, "decisions", [...read(dir, "decisions"), { at: now(), task: g.task, decision: `${g.question} → ${g.answer}`, why: "the user's answer" }]);
        return `${g.id} answered · ${g.answer}`;
      }
      refuse("gate add or gate answer");
    }
    case "log": {
      write(dir, "decisions", [...read(dir, "decisions"), { at: now(), task: sub === "-" ? "" : sub, decision: need(id, "the decision"), why: need(opt.why, "--why") }]);
      return "logged";
    }
    case "status":
      return status(dir);
    default:
      refuse(`unknown command "${cmd ?? ""}". Commands: init, store, standing, task, round, run, finding, verdict, gate, log, status, merge-check, config`);
  }
}

/**
 * The store's lock. The folder <store>/.lock holds one owner file, <token>.json, with the holder's pid, host, boot time
 * and start time. A process makes the folder with its owner file under a temporary name, then renames it to .lock. The
 * rename is atomic and fails while .lock holds a file, so the lock never exists without its owner. A waiter removes
 * the lock only when its holder is surely gone, and only by the holder's own file name and an rmdir that works only
 * on an empty folder, so it can never remove a newer holder. After LOCK_WAIT_MS it refuses. The hooks read without
 * the lock, so they never wait for it.
 */
const LOCK_WAIT_MS = 3000;
const BOOT = Date.now() - uptime() * 1000;
const START = Date.now() - process.uptime() * 1000;
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function holder(lock) {
  try {
    const [file] = readdirSync(lock);
    return { file, ...JSON.parse(readFileSync(join(lock, file), "utf8")) };
  } catch {
    return undefined; // released between the two reads, or not an owner file
  }
}

/** True only when the holder is surely gone: an earlier boot of this machine, no process under its pid, or a newer one. */
function gone(h, checkStart) {
  if (Math.abs(h.boot - BOOT) > 60_000) return h.host === hostname(); // another machine may still hold it
  try {
    process.kill(h.pid, 0);
  } catch (e) {
    return e.code === "ESRCH";
  }
  if (!checkStart) return false;
  try {
    const ps = execFileSync("ps", ["-o", "lstart=", "-p", String(h.pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, stdio: ["ignore", "pipe", "ignore"] });
    return Date.parse(ps.trim()) > h.start + 2000; // the pid now names a process that started after the holder
  } catch {
    return false;
  }
}

/** Runs fn while this process holds the store's lock. Refuses, with nothing changed, when the store stays busy. */
export function withLock(dir, fn) {
  const lock = join(dir, ".lock");
  const me = { pid: process.pid, host: hostname(), boot: BOOT, start: START, at: Date.now(), token: randomUUID() };
  const tmp = `${lock}.${me.token}`;
  mkdirSync(tmp);
  writeFileSync(join(tmp, `${me.token}.json`), JSON.stringify(me));
  const t0 = Date.now();
  for (let checked = ""; ; ) {
    try {
      renameSync(tmp, lock);
      break;
    } catch (e) {
      if (e.code !== "ENOTEMPTY" && e.code !== "EEXIST") {
        rmSync(tmp, { recursive: true, force: true });
        throw e;
      }
    }
    const h = holder(lock);
    const waited = Date.now() - t0;
    const checkStart = h && waited > 500 && checked !== h.token; // ps once per holder, and only for a slow one
    if (checkStart) checked = h.token;
    if (h && gone(h, checkStart)) {
      try {
        unlinkSync(join(lock, h.file));
        rmdirSync(lock);
        continue;
      } catch {} // another waiter removed it first, or a new holder came in: wait as for any holder
    }
    if (waited >= LOCK_WAIT_MS) {
      rmSync(tmp, { recursive: true, force: true });
      const who = h ? `pid ${h.pid} on ${h.host} has held ${lock} for ${((Date.now() - h.at) / 1000).toFixed(1)} s` : `${lock} has no readable owner; remove it if no sage command runs`;
      refuse(`the store is busy: ${who}. Nothing changed; run the command again.`);
    }
    pause(h ? 5 + Math.floor(Math.random() * 20) : 1);
  }
  try {
    return fn();
  } finally {
    try {
      unlinkSync(join(lock, `${me.token}.json`));
      rmdirSync(lock);
    } catch {}
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    console.log(sage(process.argv.slice(2)));
  } catch (err) {
    console.error(`sage: ${err instanceof Refusal ? err.message : err.stack}`);
    process.exit(err instanceof Refusal ? 1 : 2);
  }
}
