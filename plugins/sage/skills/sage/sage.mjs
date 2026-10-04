#!/usr/bin/env node
// sage: the state tool of sage mode. The chief of staff calls it through the shell: one command in, one line out.
// The store is plain TSV and Markdown in ~/.claude/sage/<project>-<hash>/ ($SAGE_HOME overrides the root), and every
// table has one writer: this tool. It holds the rules that prompts alone did not hold in Orchestrator: no dropped
// findings, bounded repair rounds, one writer per branch, and a merge only of a head SHA with the clean cycles that
// its route needs. The sage hook calls mergeCheck before any `gh pr merge` in sage mode.
// Several chief sessions may share one store: each command that changes it holds the store's lock (withLock). They may
// run two versions of this tool, so a command refuses to change a logbook that a newer version wrote (ready).
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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
/** The verdicts of a review or QA that found a medium or high problem. A failed check needs no finding. */
const FOUND = ["findings", "qa-fail"];
const NOT_CLEAN = ["checks-fail", ...FOUND];
const CLEAN = Object.values(VERDICT).filter((k) => k !== "checks-pass");
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
const COMMANDS = ["init", "logbook", "standing", "task", "round", "run", "finding", "verdict", "gate", "log", "status", "merge-check", "config"];
/** The options of each command, by its name or by its name and first word. Every command also takes --project. */
const OPTIONS = {
  "task add": ["title", "size", "risk", "add", "why"],
  "run add": ["role", "branch", "candidate"],
  "run done": ["status", "tokens", "report"],
  "finding add": ["source", "severity", "summary", "key"],
  "finding triage": ["reason"],
  verdict: ["sha", "kind", "cycle", "pr", "run"],
  "gate add": ["question", "options", "recommend", "default"],
  log: ["why"],
  "merge-check": ["sha", "pr", "cycles"],
};
/** A pull request's number: only digits, so that "#5" or a link never hides a task from merge-check --pr. */
const PR = /^\d+$/;
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

/** A config value in its stored form, or undefined when it is not valid. Only a number or a string can be valid. */
function valid(key, value) {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  if (key === "arena_models") {
    const models = list(String(value));
    return models.length && models.every((m) => MODELS.includes(m)) ? models.join(",") : undefined;
  }
  return Object.hasOwn(COUNTS, key) && /^[1-9]\d*$/.test(String(value)) ? Number(value) : undefined;
}

/** The refusal for a path that holds something other than a regular file: a folder, a FIFO or a device. */
const notRegular = (path) => Object.assign(new Refusal(`${path} is not a regular file. Ask the user to fix or remove it.`), { path, code: "not a regular file" });

/**
 * The text of a regular file, also through a link, or undefined when nothing is there. Something else (a FIFO, a device
 * or a folder) refuses, and so does a file it cannot read, with its path. It never blocks: the open does not wait for a
 * FIFO's writer, and the check is on the open file.
 */
function readRegular(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (e) {
    if (e.code === "ENOENT") return undefined;
    throw e;
  }
  try {
    if (!fstatSync(fd).isFile()) throw notRegular(path);
    return readFileSync(fd, "utf8");
  } catch (e) {
    e.path ??= path; // a file too long for a string, for one
    throw e;
  } finally {
    closeSync(fd);
  }
}

/** config.json as an object, or {} when it is missing, torn, not an object or not a regular file. It never throws or waits. */
function saved(env) {
  try {
    const value = JSON.parse(readRegular(join(sageRoot(env), "config.json")));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

/** The settings for all projects. The hooks call this, so it never throws or waits: a missing, torn or bad value, or a config.json that is not a regular file, gives the defaults. */
export function config(env = process.env) {
  try {
    const s = saved(env);
    return Object.fromEntries(Object.entries(DEFAULTS).map(([k, d]) => [k, valid(k, s[k]) ?? d]));
  } catch {
    return { ...DEFAULTS };
  }
}

/** The file that a write to file replaces: file, or the target of its link. Something there that is not a regular file refuses. */
function target(file) {
  let real = file;
  try {
    real = realpathSync(file);
  } catch {} // nothing there yet
  if (lstatSync(real, { throwIfNoEntry: false })?.isFile() === false) throw notRegular(file); // a rename onto it would fail and leave the temp file
  return real;
}

/** Writes a whole file or nothing: readers take no lock, so they must never see half a file. A link stays a link: its target gets the text. */
function put(file, text) {
  const real = target(file);
  writeFileSync(`${real}.${process.pid}`, text);
  renameSync(`${real}.${process.pid}`, real);
}

const cell = (v) => String(v ?? "").replace(/[\t\r\n]+/g, " ").trim();

/** The lines of a table that are not blank: its header first. A missing table has none. */
const lines = (dir, table) => (readRegular(join(dir, `${table}.tsv`)) ?? "").split("\n").filter(Boolean);

function read(dir, table) {
  const [head = "", ...rows] = lines(dir, table);
  const cols = head.split("\t");
  return rows.map((line) => {
    const v = line.split("\t");
    return Object.fromEntries(cols.map((c, i) => [c, v[i] ?? ""]));
  });
}

/**
 * Refuses, before any change, a logbook that a command could not change whole: a table or status.md that is not a
 * regular file, or a table that a newer version of this tool wrote. A write keeps only the columns that this version
 * knows, so another chief session's values would be lost in silence. Reading such a logbook is safe.
 */
function ready(dir) {
  target(join(dir, "status.md"));
  for (const [table, cols] of Object.entries(TABLES)) {
    const extra = (lines(dir, table)[0] ?? "").split("\t").filter((c) => c && !cols.includes(c));
    if (extra.length) refuse(`${join(dir, `${table}.tsv`)} has columns that this version of sage does not know (${extra.join(", ")}): a newer sage wrote this logbook. Update the sage plugin and restart this session. Nothing changed.`);
  }
}

function write(dir, table, rows) {
  const cols = TABLES[table];
  put(join(dir, `${table}.tsv`), [cols.join("\t"), ...rows.map((r) => cols.map((c) => cell(r[c])).join("\t"))].join("\n") + "\n");
}

const now = () => new Date().toISOString().slice(0, 19) + "Z";
/**
 * A new id: the highest whole number after the prefix that any row of the logbook names, plus 1. So an id never comes
 * back, also when its own row is lost while another row (a verdict's run, a decision, a round's keys) still names it.
 * Only digits count ("Infinity" does not), and BigInt keeps a long number exact.
 */
function nextId(dir, prefix) {
  let max = 0n;
  for (const table of Object.keys(TABLES)) {
    for (const [, n] of (readRegular(join(dir, `${table}.tsv`)) ?? "").matchAll(new RegExp(`(?<![A-Za-z0-9])${prefix}(\\d+)`, "g"))) if (BigInt(n) > max) max = BigInt(n);
  }
  return `${prefix}${max + 1n}`;
}
const list = (s) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : []);
/** Does a task build code? Only a route with build has commits, a pull request and a merge. */
const builds = (task) => list(task.route).includes("build");

/**
 * A command's words and options. Every option takes a value: --name value, or --name=value. The value may start with
 * "--", but it may not be another option of the command: then the value is missing. A command refuses an option that
 * it does not take, so a typo or an option of a newer version is never dropped in silence.
 */
function parse(cmd, args) {
  const pos = [];
  const opt = Object.create(null);
  const spaced = []; // the options whose value is the next word
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) pos.push(a);
    else if (a.includes("=")) opt[a.slice(2, a.indexOf("="))] = a.slice(a.indexOf("=") + 1);
    else {
      spaced.push(a.slice(2));
      opt[a.slice(2)] = args[++i];
    }
  }
  const name = OPTIONS[`${cmd} ${pos[0]}`] ? `${cmd} ${pos[0]}` : cmd;
  const takes = [...(OPTIONS[name] ?? []), "project"];
  for (const o of Object.keys(opt)) if (!takes.includes(o)) refuse(`${name} takes no --${o}. Its options: ${takes.map((t) => `--${t}`).join(", ")}.`);
  for (const o of spaced) {
    const v = opt[o];
    if (v === undefined || (v.startsWith("--") && takes.includes(v.slice(2).split("=")[0]))) refuse(`--${o} needs a value. A value that starts with -- goes after =: --${o}=<value>.`);
  }
  return { pos, opt };
}

const need = (value, what) => value || refuse(`missing ${what}`);
/** A word as a shell reads it: in single quotes when it holds anything but letters, digits and ._/-, so a pasted command does only what it says. */
const shell = (word) => (/^[\w./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`);

/** Refuses an id that the logbook does not have, and names the latest ids that it has, to pick from. */
const missing = (what, ids) => refuse(`no ${what}. ${ids.length ? `The latest: ${ids.slice(-10).join(", ")}.` : "There is none yet."}`);

function taskOf(dir, id) {
  const tasks = read(dir, "tasks");
  const task = tasks.find((t) => t.id === id) ?? missing(`task ${id}`, tasks.map((t) => t.id));
  return { tasks, task };
}

function move(task, to) {
  if (to !== "abandoned" && !(NEXT[task.state] ?? []).includes(to)) refuse(`${task.id} cannot go from ${task.state} to ${to}. Next: ${(NEXT[task.state] ?? []).join(", ") || "none"}`);
  task.state = to;
}

/** Gives a task its pull request, or clears it with "". An investigation changes no code, so it may only clear one. */
function setPr(task, pr) {
  if (pr && !builds(task)) refuse(`${task.id} is an investigation: it changes no code, so it has no pull request. A build is its own task: sage task add --size tiny, small or large, then give that task the PR.`);
  if (pr && !PR.test(pr)) refuse(`${JSON.stringify(pr)} is not a pull request number. Give only its digits, for example pr=5 or --pr 5.`);
  task.pr = pr;
}

/** Why sha cannot name a commit in the ledger, or "". A short SHA could match another commit with the same prefix. Case does not matter. */
const notFull = (sha) => (/^[0-9a-f]{40}$/i.test(sha) ? "" : `${JSON.stringify(sha)} is not a full commit SHA: a short one can match another commit. Give all 40 characters: git rev-parse <branch>.`);

/**
 * Does one task have the clean cycles its route needs on one SHA? tasks and findings are its logbook's tables, read once
 * by the caller; rows are only that task's ledger rows for the SHA. A task without rows is in the merge gate only through
 * its PR number.
 */
function judge(dir, tasks, findings, id, rows, cycles) {
  const task = tasks.find((t) => t.id === id);
  if (!task) return { ok: false, reason: `${id} is in ${join(dir, "ledger.tsv")} but not in its tasks.tsv: a stray or damaged logbook. If no project uses it, ask the user to remove ${dir}.` };
  const who = task.state === "abandoned" ? `${task.id} (abandoned)` : task.id; // it still counts: the gate fails closed
  const clear = `clear its PR (sage task ${task.id} set pr=)`;
  if (!rows.length && !builds(task)) return { ok: false, reason: `${who} is an investigation, so it has no pull request, but it has PR ${task.pr}: ${clear}.` };
  if (!rows.length) return { ok: false, reason: `${who} is a task of PR ${task.pr} but has no verdicts on this SHA. Record them, or, if it is no longer part of PR ${task.pr}, ${clear}.` };
  const open = findings.filter((f) => f.task === task.id && f.status === "open");
  if (open.length) return { ok: false, reason: `${who} has open findings: ${open.map((f) => f.key).join(", ")}. Triage and close them first.` };
  const bad = rows.find((r) => NOT_CLEAN.includes(r.kind));
  if (bad) return { ok: false, reason: `${who}: cycle ${bad.cycle} found problems on this SHA (${bad.kind}). Repair, then review the new SHA.` };
  if (!rows.some((r) => r.kind === "checks-pass")) return { ok: false, reason: `${who}: no checks-pass on this SHA. Run the checks on it and record checks-pass.` };
  const perCycle = list(task.route).map((b) => VERDICT[b]).filter((k) => k && k !== "checks-pass");
  const want = perCycle.length ? cycles : 1;
  const clean = perCycle.length ? [...new Set(rows.map((r) => r.cycle))].filter((c) => perCycle.every((k) => rows.some((r) => r.cycle === c && r.kind === k))).length : 1;
  if (clean < want) {
    const missing = perCycle.filter((k) => !rows.some((r) => r.kind === k));
    return { ok: false, reason: `${who}: ${clean} of ${want} clean cycles on this SHA${missing.length ? `; never recorded: ${missing.join(", ")}` : ""}. Run the next cycle of its reviews on this SHA and record each verdict.` };
  }
  return { ok: true, reason: `${task.id} may merge: ${clean} clean cycle${clean === 1 ? "" : "s"} on this SHA` };
}

/**
 * The judgment of the merge gate: may this head SHA merge? Every task that has verdicts on the full SHA, in every
 * project's logbook, must pass on its own rows, also an abandoned one, so no other logbook or task can lend its verdicts.
 * With pr, the tasks of that pull request in those logbooks must pass too, and there must be one. An autopilot merge
 * wants autopilot_cycles clean cycles. The hook calls this, so it never throws: what it cannot read refuses the merge.
 */
export function mergeCheck(sha, env = process.env, { cycles, pr } = {}) {
  const root = sageRoot(env);
  try {
    if (notFull(sha)) return { ok: false, reason: notFull(sha) };
    sha = String(sha).toLowerCase(); // the ledger holds SHAs as git prints them
    cycles ??= config(env).autopilot_cycles;
    pr &&= String(pr); // the tasks table holds it as text
    // A logbook may be a link to a folder: the writes go through it, so the gate reads through it too.
    const dirs = existsSync(root) ? readdirSync(root).map((name) => join(root, name)).filter((path) => statSync(path).isDirectory()).sort() : [];
    const each = dirs.flatMap((dir) => {
      const rows = read(dir, "ledger").filter((r) => r.sha === sha);
      if (!rows.length) return [];
      const [tasks, findings] = [read(dir, "tasks"), read(dir, "findings")];
      const ofPr = pr ? tasks.filter((t) => t.pr === pr).map((t) => t.id) : [];
      return [...new Set([...rows.map((r) => r.task), ...ofPr])].map((id) => {
        const own = rows.filter((r) => r.task === id);
        return { dir, id, ofPr: ofPr.includes(id), own: own.length, ...judge(dir, tasks, findings, id, own, cycles) };
      });
    });
    if (!each.length) return { ok: false, reason: `no verdicts recorded for ${sha}. Record the reviews and QA with sage verdict first.` };
    if (pr && !each.some((r) => r.ofPr)) return { ok: false, reason: `no task of PR ${pr} has verdicts on ${sha.slice(0, 7)}: only ${each.map((r) => `${r.dir} ${r.id}`).join(", ")} ${each.length === 1 ? "has" : "have"}. Record PR ${pr}'s verdicts under its own task (sage verdict <T> --sha <sha> --pr ${pr}), or set its PR: sage task <T> set pr=${pr}.` };
    if (each.length === 1) return { ok: each[0].ok, reason: each[0].reason };
    const all = `${each.length} tasks have verdicts on ${sha.slice(0, 7)}${pr ? ` or belong to PR ${pr}` : ""}, and each must pass`;
    const bad = each.filter((r) => !r.ok);
    if (!bad.length) return { ok: true, reason: `${all}: ${each.map((r) => `${r.dir} ${r.reason}`).join("; ")}` };
    const out = bad.some((r) => r.own) ? ", or push a new commit and record its verdicts under the live tasks only" : ""; // a new commit leaves behind only verdicts
    return { ok: false, reason: `${all}; ${bad.length} fail${bad.length === 1 ? "s" : ""}. ${bad.map((r) => `${r.dir} ${r.reason}`).join(" ")} To merge, make each one pass${out}.` };
  } catch (e) {
    const [at, why] = [e?.path, e?.code ?? e?.message ?? e];
    if (at === undefined) return { ok: false, reason: `the merge gate failed (${why}), so it refuses every merge.` };
    return { ok: false, reason: `the merge gate cannot read ${at} (${why}), so it refuses every merge. Ask the user to fix ${at === root ? "" : "or remove "}${at}.` }; // never the root: it holds every logbook
  }
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
  if (!COMMANDS.includes(cmd)) refuse(`unknown command "${cmd ?? ""}". Commands: ${COMMANDS.join(", ")}`);
  const { pos, opt } = parse(cmd, rest);
  if (cmd === "merge-check") {
    const cycles = opt.cycles === undefined ? undefined : (valid("autopilot_cycles", opt.cycles) ?? refuse("--cycles is a whole number of 1 or more"));
    if (opt.pr !== undefined && !PR.test(opt.pr)) refuse("--pr is the pull request's number, for example --pr 5");
    const r = mergeCheck(opt.sha ?? refuse("merge-check needs --sha with the full 40-character SHA of the head commit: git rev-parse <branch>"), env, { cycles, pr: opt.pr });
    return r.ok ? r.reason : refuse(r.reason);
  }
  if (cmd === "config") {
    const set = {};
    for (const kv of pos) {
      const [k, v = ""] = kv.split("=");
      if (Object.hasOwn(COUNTS, k) && valid(k, v) === undefined) refuse(`${k} must be a whole number of 1 or more${/^0+$/.test(v) ? `: with 0, ${COUNTS[k]}` : `, not ${JSON.stringify(v)}`}`);
      set[k] = valid(k, v) ?? refuse(`config takes max_agents, autopilot_cycles, max_rounds and arena as key=number, and arena_models as a list of ${MODELS.join(", ")}`);
    }
    if (pos.length) {
      mkdirSync(sageRoot(env), { recursive: true });
      put(join(sageRoot(env), "config.json"), JSON.stringify({ ...saved(env), ...set }, null, 2) + "\n"); // a key of a newer version stays
    }
    return Object.entries({ ...config(env), ...set }).map(([k, v]) => `${k}=${v}`).join(" ");
  }
  const project = resolve(opt.project ?? env.SAGE_PROJECT ?? process.cwd());
  const dir = storeDir(project, env);
  if (cmd !== "init" && !existsSync(join(dir, "tasks.tsv"))) refuse(`no logbook for the project ${project}. Run: sage init --project ${shell(project)}`);
  // A read takes no lock: every file is replaced whole, so it sees the store before or after a change, never half of one.
  if (["logbook", "status"].includes(cmd) || (cmd === "standing" && pos[0] !== "add")) return act(cmd, pos, opt, dir, env);
  if (cmd === "init") {
    mkdirSync(join(dir, "briefs"), { recursive: true });
    mkdirSync(join(dir, "reports"), { recursive: true });
  }
  return withLock(dir, () => {
    ready(dir);
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
      return `logbook ${dir}`;
    case "logbook":
      return dir;
    case "standing": {
      if (sub === "add") {
        const text = (readRegular(join(dir, "standing.md")) ?? "").trimEnd();
        const n = (text.match(/^\d+\./gm) ?? []).length + 1;
        put(join(dir, "standing.md"), `${text}\n${n}. ${cell(need([id, ...more].join(" "), "the order's text"))}\n`);
        return `standing order ${n} added`;
      }
      return (readRegular(join(dir, "standing.md")) ?? "").trimEnd();
    }
    case "task": {
      if (sub === "add") {
        const size = need(opt.size, "--size");
        if (!SIZES[size]) refuse(`size is one of ${Object.keys(SIZES).join(", ")}`);
        const risk = list(opt.risk);
        const odd = [...risk.filter((r) => !RISKS.includes(r)), ...list(opt.add).filter((b) => !BLOCKS.includes(b))];
        if (odd.length) refuse(`unknown: ${odd.join(", ")}. Risks: ${RISKS.join(", ")}. Blocks: ${BLOCKS.join(", ")}`);
        if (size === "investigate" && list(opt.add).includes("build")) refuse("an investigation changes no code, so it takes no build block. Frame the build as its own task: sage task add --size tiny, small or large");
        const why = opt.add ? need(opt.why, "--why for the added blocks") : ""; // refuse before anything is written
        const blocks = new Set([...SIZES[size], ...(risk.length && size !== "investigate" ? ["security-review"] : []), ...list(opt.add)]);
        const route = BLOCKS.filter((b) => blocks.has(b)); // the blocks in their order
        const tasks = read(dir, "tasks");
        const task = { id: nextId(dir, "T"), title: need(opt.title, "--title"), size, risk: risk.join(","), route: route.join(","), state: "framed", round: 0 };
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
            const build = builds(task);
            if ((v === "verified" && !build) || (v === "concluded" && build)) refuse(`${task.id} ${build ? "has a build block, so it ends at verified" : "has no build block, so it ends at concluded"}`);
            if (v === "verifying" || v === "concluded") {
              const open = read(dir, "findings").filter((f) => f.task === task.id && f.status === "open");
              if (open.length) refuse(`${task.id} has open findings: ${open.map((f) => `${f.key} (${f.triage || "not triaged"})`).join(", ")}. Close or dismiss each one first.`);
            }
            if (v === "concluded" && read(dir, "ledger").filter((r) => r.task === task.id).at(-1)?.kind !== "evidence-clean") {
              refuse(`${task.id} needs a clean evidence review as its latest verdict: sage verdict ${task.id} --kind evidence-clean --run <R>`);
            }
            if (v === "verified") {
              const rows = read(dir, "ledger").filter((r) => r.task === task.id);
              const head = rows.at(-1)?.sha ?? refuse(`${task.id} has no verdicts yet`);
              const r = judge(dir, tasks, read(dir, "findings"), task.id, rows.filter((r) => r.sha === head), 1);
              if (!r.ok) refuse(`${task.id} is not verified on ${head.slice(0, 7)}: ${r.reason}`);
            }
          } else if (k === "pr") setPr(task, v);
          else if (["branch", "title"].includes(k)) task[k] = v;
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
          if (other) refuse(`${other.id} (${other.role}) still writes ${branch}, and a branch has one writer. Finish that run first (sage run done ${other.id} --status done, blocked, question or failed), or give this run another branch.`);
        }
        const run = { id: nextId(dir, "R"), task: task.id, role, round: task.round, candidate: opt.candidate ?? "", branch, status: "running", started: now() };
        write(dir, "runs", [...runs, run]);
        return `${run.id} running · ${role} on ${task.id}${branch ? ` · ${branch}` : ""}${run.candidate ? ` · candidate ${run.candidate}` : ""}`;
      }
      if (sub === "done") {
        const run = runs.find((r) => r.id === id) ?? missing(`run ${id}`, runs.map((r) => r.id));
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
        const key = opt.key ?? nextId(dir, `F-${task.id}-`);
        const again = findings.find((f) => f.task === task.id && f.key === key);
        // Without --summary, a known key keeps its summary. An empty one is refused, so no summary is ever lost.
        const summary = opt.summary === undefined ? again?.summary : cell(opt.summary) || refuse(`${key} on ${task.id}: --summary is empty. Give the finding in a few words${again ? ", or leave out --summary to keep its summary" : ""}.`);
        if (again && summary !== again.summary) write(dir, "decisions", [...read(dir, "decisions"), { at: now(), task: task.id, decision: `${key} opened again: ${summary}`, why: `the summary before: ${again.summary}` }]);
        if (again) Object.assign(again, { status: "open", triage: "", round: task.round, severity, source: opt.source ?? again.source, summary }); // it came back
        else findings.push({ task: task.id, key, round: task.round, source: need(opt.source, "--source"), severity, summary: need(summary, "--summary"), status: "open" });
        write(dir, "findings", findings);
        return `${key} open${again ? " again" : ""} · ${severity} · ${task.id}`;
      }
      const f = findings.find((x) => x.task === id && x.key === more[0]) ?? missing(`finding ${more[0]} on ${id}`, findings.filter((x) => x.task === id).map((x) => x.key));
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
      // The clean rule: a cycle is clean when no medium or high finding is open. Low ones are fixed, moved or dismissed
      // before a merge, and an open one blocks it. So a problem verdict needs an open finding that is not low.
      const findings = read(dir, "findings").filter((f) => f.task === task.id && f.status === "open");
      if (FOUND.includes(kind) && findings.every((f) => f.severity === "low")) {
        refuse(`${task.id} has no open medium or high finding, so this review's cycle is clean. Record its clean verdict (${CLEAN.join(", ")}); fix, move or dismiss each low finding before the merge. For a medium or high problem, record the finding first: sage finding add ${task.id}.`);
      }
      // A route without build has no commit to judge. Its rows have no SHA, so the merge gate never reads them.
      if (builds(task) && !opt.sha) refuse(`${task.id} has a build block, so each verdict names its commit: add --sha with the full 40-character SHA (git rev-parse <branch>)`);
      if (!builds(task) && opt.sha) refuse(`${task.id} has no build block, so its verdicts name no commit: leave out --sha`);
      if (opt.sha && notFull(opt.sha)) refuse(notFull(opt.sha));
      const sha = opt.sha?.toLowerCase() ?? ""; // as git prints it
      if (opt.pr) setPr(task, opt.pr);
      write(dir, "tasks", tasks);
      write(dir, "ledger", [...read(dir, "ledger"), { task: task.id, pr: task.pr, sha, kind, cycle: opt.cycle ?? "1", run: opt.run ?? "", at: now() }]);
      const open = NOT_CLEAN.includes(kind) ? [] : findings.filter((f) => f.triage === "fix");
      return `${task.id} ${kind}${sha ? ` · ${sha.slice(0, 7)}` : ""} · cycle ${opt.cycle ?? "1"}${open.length ? ` · still open: ${open.map((f) => f.key).join(", ")}. Close the ones that this review confirmed fixed.` : ""}`;
    }
    case "gate": {
      const gates = read(dir, "gates");
      if (sub === "add") {
        const g = { id: nextId(dir, "G"), task: id ?? "", question: need(opt.question, "--question"), options: need(opt.options, "--options"), recommendation: need(opt.recommend, "--recommend"), default: opt.default ?? "", at: now() };
        write(dir, "gates", [...gates, g]);
        return `${g.id} open · ${g.question}`;
      }
      if (sub === "answer") {
        const g = gates.find((x) => x.id === id) ?? missing(`gate ${id}`, gates.map((x) => x.id));
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
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * The owner of a lock folder (.lock, or a waiter's temp folder), with its file name from the folder, never from the
 * record. Undefined when the folder is gone or is not a real folder, or does not hold exactly one regular <uuid>.json
 * file: nobody removes such a lock but a person.
 */
function holder(folder) {
  try {
    const names = lstatSync(folder).isDirectory() ? readdirSync(folder) : [];
    if (names.length !== 1 || !new RegExp(`^${UUID}\\.json$`).test(names[0])) return undefined;
    return { ...JSON.parse(readRegular(join(folder, names[0]))), file: names[0] };
  } catch {
    return undefined; // released between the reads, or not an owner record
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

/** Removes a lock folder by its owner file's name, then the folder, which must then be empty. False if either fails. */
function clear(folder, file) {
  try {
    unlinkSync(join(folder, file));
    rmdirSync(folder);
    return true;
  } catch {
    return false;
  }
}

/** Runs fn while this process holds the store's lock. Refuses, with nothing changed, when the store stays busy. */
export function withLock(dir, fn) {
  const lock = join(dir, ".lock");
  const token = randomUUID();
  const tmp = `${lock}.${token}`;
  mkdirSync(tmp);
  writeFileSync(join(tmp, `${token}.json`), JSON.stringify({ pid: process.pid, host: hostname(), boot: BOOT, start: START, at: Date.now() }));
  const t0 = Date.now();
  for (let checked = ""; ; ) {
    try {
      renameSync(tmp, lock);
      break;
    } catch (e) {
      if (!["ENOTEMPTY", "EEXIST", "ENOTDIR"].includes(e.code)) {
        rmSync(tmp, { recursive: true, force: true });
        throw e;
      }
    }
    const h = holder(lock);
    const waited = Date.now() - t0;
    const checkStart = h && waited > 500 && checked !== h.file; // ps once per holder, and only for a slow one
    if (checkStart) checked = h.file;
    if (h && gone(h, checkStart) && clear(lock, h.file)) continue; // if clear fails, another waiter was first
    if (waited >= LOCK_WAIT_MS) {
      rmSync(tmp, { recursive: true, force: true });
      const who = h ? `pid ${cell(h.pid)} on ${cell(h.host)} has held ${lock}${Number.isFinite(h.at) ? ` for ${((Date.now() - h.at) / 1000).toFixed(1)} s` : ""}` : `${lock} has no valid owner file`;
      refuse(`the logbook is busy: ${who}. Nothing changed. Run the command again; if no sage command runs${h ? ` on ${cell(h.host)}` : ""}, remove ${lock} first.`);
    }
    pause(5 + Math.floor(Math.random() * 20));
  }
  try {
    // The temp folder of a waiter that was killed stays behind. Remove it by the lock's rules: owner surely gone, by name.
    for (const name of readdirSync(dir).filter((n) => new RegExp(`^\\.lock\\.${UUID}$`).test(n))) {
      const h = holder(join(dir, name));
      if (h && gone(h, false)) clear(join(dir, name), h.file);
    }
    return fn();
  } finally {
    clear(lock, `${token}.json`);
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
