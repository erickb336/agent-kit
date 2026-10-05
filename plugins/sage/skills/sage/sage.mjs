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
/** The last states: a task in one of them is done with its worktree and its branch. */
const DONE = Object.keys(NEXT).filter((s) => !NEXT[s].length);
export const DEFAULTS = { max_agents: 3, "cycles.small": 1, "cycles.large": 2, "cycles.risk": 2, max_rounds: 3, arena: 3, arena_models: "opus,sonnet,sonnet", cap_total: 12 };
/** The counts in the config, and what a 0 would do. Each count is a whole number of 1 or more. */
/** The owner's floors (gate G18): a large or risk-flagged task needs at least 2 clean cycles. Only a code change lowers them; every other count is 1 or more. */
const FLOOR = { "cycles.large": 2, "cycles.risk": 2 };
const floor = (key) => FLOOR[key] ?? 1;
/** The limits that keep a typo from blocking every merge or starting too many agents: 10 for cycles and rounds, 50 for agent counts. */
const LIMIT = { "cycles.small": 10, "cycles.large": 10, "cycles.risk": 10, max_rounds: 10 };
const limit = (key) => LIMIT[key] ?? 50;
const COUNTS = { max_agents: "no sage agent could start", "cycles.small": "a tiny or small task would merge with no review", "cycles.large": "a large task would merge with no review", "cycles.risk": "a task with a risk flag would merge with no review", max_rounds: "no repair round could start", arena: "an arena would have no candidates", cap_total: "no sage agent could start" };
/** One project's own agent cap, cap.<project>, with the project's name as projectName gives it. Without one, max_agents is the project's cap. */
const CAP = /^cap\.[a-z0-9][a-z0-9-]*$/;
const KEYS = "max_agents, cycles.small, cycles.large, cycles.risk, max_rounds, arena and cap_total as key=number, cap.<project>=number for one project's cap";
const MODELS = ["opus", "sonnet", "haiku", "inherit"];
const TABLES = {
  tasks: ["id", "title", "size", "risk", "route", "state", "branch", "pr", "round", "keys"],
  runs: ["id", "task", "role", "round", "candidate", "branch", "status", "tokens", "report", "started", "ended"],
  findings: ["task", "key", "round", "source", "severity", "summary", "triage", "reason", "status"],
  ledger: ["task", "pr", "sha", "kind", "cycle", "run", "at"],
  gates: ["id", "task", "question", "options", "recommendation", "default", "answer", "at"],
  decisions: ["at", "task", "decision", "why"],
};
const COMMANDS = ["init", "logbook", "standing", "task", "round", "run", "finding", "verdict", "gate", "log", "status", "merge-check", "config", "worktrees"];
/** The options of each command, by its name or by its name and first word. Every command also takes --project. */
const OPTIONS = {
  "logbook repair": ["accept-loss"],
  "task add": ["title", "size", "risk", "add", "why"],
  "run add": ["role", "branch", "candidate"],
  "run done": ["status", "tokens", "report"],
  "finding add": ["source", "severity", "summary", "key"],
  "finding triage": ["reason"],
  "finding move": ["to", "size"],
  verdict: ["sha", "kind", "cycle", "pr", "run"],
  "gate add": ["question", "options", "recommend", "default"],
  log: ["why"],
  "merge-check": ["sha", "pr", "cycles"],
  worktrees: ["dry-run"],
};
/** The options that take no value. */
const FLAGS = ["dry-run"];
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

/** The project's name: its main checkout's folder name as a slug. The store's folder and the cap.<project> config key use it. */
export function projectName(path) {
  return basename(projectRoot(resolve(path))).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}

export function storeDir(project, env = process.env) {
  const root = projectRoot(resolve(project));
  return join(sageRoot(env), `${projectName(root)}-${createHash("sha1").update(root).digest("hex").slice(0, 6)}`);
}

/**
 * A config value in its stored form, or undefined when it is not valid. A count is valid as a whole number, or a string
 * of one ("3"), at or above its floor. Above its limit, a cycles count keeps its value (fewer would ease a merge) and
 * any other count reads as the limit (more would start more agents or rounds than written).
 */
function valid(key, value) {
  if (key === "arena_models") {
    const models = typeof value === "string" ? list(value) : [];
    return models.length && models.every((m) => MODELS.includes(m)) ? models.join(",") : undefined;
  }
  const n = typeof value === "string" && /^[1-9][0-9]*$/.test(value) ? Number(value) : value;
  if (!(Object.hasOwn(COUNTS, key) || CAP.test(key)) || !Number.isInteger(n) || n < floor(key)) return undefined;
  return key.startsWith("cycles.") ? n : Math.min(n, limit(key));
}

/** A count typed on the command line, or undefined when it is not a whole number from its floor to its limit. */
const typed = (key, text) => (/^[1-9]\d*$/.test(text) && Number(text) <= limit(key) ? valid(key, Number(text)) : undefined);

/** The refusal for a path that holds something other than a regular file: a folder, a FIFO or a device. */
const notRegular = (path) => new Refusal(`${path} is not a regular file. Ask the user to fix or remove it.`);

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

/**
 * The settings for all projects. The hooks call this, so it never throws or waits: a missing, torn or bad value (a count
 * as "3x", for one), a count below its floor, or a config.json that is not a regular file, gives the default (each
 * floor is its default). Above its limit, a cycles count keeps its value and any other count reads as the limit. A file of
 * an older sage holds autopilot_cycles for cycles.large: it counts when cycles.large is absent, never below the floor.
 */
export function config(env = process.env) {
  let c = { ...DEFAULTS };
  try {
    const s = saved(env);
    if (!Object.hasOwn(s, "cycles.large") && Object.hasOwn(s, "autopilot_cycles")) s["cycles.large"] = s.autopilot_cycles;
    const caps = Object.keys(s).filter((k) => CAP.test(k)).map((k) => [k, valid(k, s[k])]).filter(([, v]) => v !== undefined);
    c = Object.fromEntries([...Object.entries(DEFAULTS).map(([k, d]) => [k, valid(k, s[k]) ?? d]), ...caps]);
  } catch {}
  return c;
}

/** The clean cycles that a task needs before its merge: cycles.small for every task, cycles.large for a large one, and cycles.risk for any task with a risk flag (the largest count wins). */
export function cyclesFor(task, c) {
  return Math.max(c["cycles.small"], task.size === "large" ? c["cycles.large"] : 0, task.risk ? c["cycles.risk"] : 0);
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

/**
 * The characters that a person does not see but a terminal or an agent acts on: the controls but tab and line feed (C0,
 * DEL and C1), the bidi embeddings, overrides, isolates and marks (U+202A-202E, U+2066-2069, U+200E, U+200F, U+061C), the
 * zero-width characters (U+200B-200D, U+2060, U+FEFF), the variation selectors (U+FE00-FE0F, U+E0100-E01EF) and the tag
 * characters (U+E0000-E007F, text that only an agent reads). A joiner or non-joiner (U+200C, U+200D) between two letters
 * stays, as Persian and Indic text needs it; a joiner between two emoji stays, so a joined emoji stays whole; the emoji
 * selector (U+FE0F) stays after an emoji or a keycap base. Other text, also emoji and every script, stays; a subdivision
 * flag shows as a black flag.
 */
const HIDDEN = /[\0-\x08\x0b-\x1f\x7f-\x9f\u061c\u200b\u200e\u200f\u2060\ufeff\ufe00-\ufe0e\u202a-\u202e\u2066-\u2069\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]|(?<![\p{Extended_Pictographic}0-9#*])\ufe0f|(?<![\p{L}\p{M}](?=[\u200c\u200d]\p{L})|[\p{Extended_Pictographic}\p{Emoji_Modifier}]\ufe0f?(?=\u200d\p{Extended_Pictographic}))[\u200c\u200d]/gu;
/** A cell as the tables hold it: on one line, without a hidden character. */
const cell = (v) => String(v ?? "").replace(/[\t\r\n]+/g, " ").replace(HIDDEN, "").trim();
/** Text with each hidden character, tab and line feed shown as \xNN or \u{N}, so that a printed line never drives the terminal or hides text. */
const visible = (s) => String(s).replace(new RegExp(`[\\t\\n]|${HIDDEN.source}`, "gu"), (c) => (c.codePointAt(0) < 0x100 ? `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}` : `\\u{${c.codePointAt(0).toString(16)}}`));

/** What to ask the user about a file that cannot be read: never to remove the root, which holds every logbook, nor a file that a permission keeps shut, whose rows are there. */
const fixIt = (at, why, root) => `Ask the user to ${["EACCES", "EPERM"].includes(why) ? "fix the permissions of " : at === root ? "fix " : "fix or remove "}${at}.`;

/**
 * The refusal for a table of a logbook that lost its rows: it is missing, or has no header line. It names both ways out,
 * and the repair names also the tables that the refused command already repairs (also), so one command repairs them all.
 */
const lost = (dir, table, what, also = []) =>
  new Refusal(`${join(dir, `${table}.tsv`)} ${what}, but every table of a logbook has at least its header line, so its rows are lost. Ask the user to restore it from a copy. If the user accepts the loss, run: sage logbook repair --accept-loss ${[...also, table].join(",")} --project <the project>. If no project uses ${dir}, ask the user to remove it.`);

/**
 * A table of a logbook as its header's columns and its data lines. It refuses, with the path, a table that is missing or
 * a link to nothing, one with no line (0 bytes, or only blank lines), one that is not a regular file, and one whose first
 * line does not name every column of this version (the header was lost or edited), so no data line is taken for it. A
 * header-only table is a table without rows: a cut that keeps only the header cannot be told from it. An editor's BOM
 * and CRLF line ends read as a plain file.
 */
function sheet(dir, table, also = []) {
  const file = join(dir, `${table}.tsv`);
  let text;
  try {
    text = readRegular(file);
  } catch (e) {
    if (e instanceof Refusal || !e.code) throw e;
    refuse(`${file} cannot be read (${e.code}). ${fixIt(file, e.code)}`);
  }
  if (text === undefined) throw lost(dir, table, "is missing or is a link to nothing", also);
  const [head, ...lines] = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  if (!head) throw lost(dir, table, text ? "has only blank lines" : "is empty (0 bytes)", also);
  const cols = head.split("\t");
  if (!TABLES[table].every((c) => cols.includes(c))) refuse(`the header of ${file} is damaged: its first line must be the column names ${TABLES[table].join(", ")}, separated by tabs. Ask the user to fix or add that line.`);
  return { cols, lines };
}

const rowsOf = ({ cols, lines }) =>
  lines.map((line) => {
    const v = line.split("\t");
    return Object.fromEntries(cols.map((c, i) => [c, v[i] ?? ""]));
  });
const read = (dir, table) => rowsOf(sheet(dir, table));

/**
 * The integrity check of a logbook: every table (but skip, the ones that a repair starts again) is there, is a regular
 * file that it can read, is not empty, and has its header line. It refuses the first that fails and names its file. The
 * merge check runs it on every logbook, and every write on its own, so no command hides a lost table or makes a new one.
 */
const check = (dir, skip = []) => Object.fromEntries(Object.keys(TABLES).filter((t) => !skip.includes(t)).map((t) => [t, sheet(dir, t, skip)]));

/**
 * Refuses, before any change, a logbook that a command could not change whole: one that fails the integrity check, or a
 * table that a newer version of this tool wrote. A write keeps only the columns that this version knows, so another
 * chief session's values would be lost in silence. Reading a newer logbook is safe. A folder without tasks.tsv is init's
 * new logbook (init writes tasks.tsv last), and it may have only tables without rows: rows without their tasks are a loss.
 */
function ready(dir, skip = []) {
  for (const file of ["status.md", "standing.md"]) target(join(dir, file));
  if (!skip.includes("tasks") && !lstatSync(join(dir, "tasks.tsv"), { throwIfNoEntry: false })) {
    if (skip.length || Object.keys(TABLES).some((t) => (readRegular(join(dir, `${t}.tsv`)) ?? "").trim().split(/\r?\n/).length > 1)) throw lost(dir, "tasks", "is missing", skip);
    return;
  }
  for (const [table, { cols }] of Object.entries(check(dir, skip))) {
    const extra = cols.filter((c) => c && !TABLES[table].includes(c));
    if (extra.length) refuse(`${join(dir, `${table}.tsv`)} has columns that this version of sage does not know (${extra.join(", ")}): a newer sage wrote this logbook, and a write of this version would lose them. Update the sage plugin and restart this session. Nothing changed; status, logbook, standing and merge-check still work.`);
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
    else {
      const eq = a.includes("=");
      const o = a.slice(2, eq ? a.indexOf("=") : undefined);
      const flag = FLAGS.includes(o) && !eq;
      const v = eq ? a.slice(a.indexOf("=") + 1) : flag ? "" : args[++i];
      if (!eq && !flag) spaced.push(o);
      if (o in opt) refuse(`--${o} is given twice. Give it once${o === "accept-loss" ? `, with the tables joined by a comma: --accept-loss ${opt[o]},${v}` : ""}.`);
      opt[o] = v;
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

/** Frames a task with its route and writes it: the least route of its size, the security review for a risk, and the added blocks. */
function frame(dir, title, size, risk, add) {
  const blocks = new Set([...SIZES[size], ...(risk.length && size !== "investigate" ? ["security-review"] : []), ...add]);
  const task = { id: nextId(dir, "T"), title, size, risk: risk.join(","), route: BLOCKS.filter((b) => blocks.has(b)).join(","), state: "framed", round: 0 }; // the blocks in their order
  write(dir, "tasks", [...read(dir, "tasks"), task]);
  return task;
}
const framed = (task) => `${task.id} framed · ${task.size}${task.risk ? ` · risk ${task.risk}` : ""} · route ${task.route}`;

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
 * by the caller; rows are only that task's ledger rows for the SHA. A task without rows is in the merge check only through
 * its PR number.
 */
function judge(dir, tasks, findings, id, rows, cycles, repaired) {
  const task = tasks.find((t) => t.id === id);
  if (!task) return { ok: false, reason: `${id} is in ${join(dir, "ledger.tsv")} but not in its tasks.tsv: ${repaired ? `tasks.tsv was started again without rows (see decisions.tsv), so the verdicts of ${id} are on a lost task. Push a new commit, and record its verdicts under a task that the logbook has.` : `a stray or damaged logbook. If no project uses it, ask the user to remove ${dir}.`}` };
  const who = task.state === "abandoned" ? `${task.id} (abandoned)` : task.id; // it still counts: the merge check fails closed
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
 * The judgment of the merge check: may this head SHA merge? Every task that has verdicts on the full SHA, in every
 * project's logbook, must pass on its own rows, also an abandoned one, so no other logbook or task can lend its verdicts.
 * With pr, the tasks of that pull request in those logbooks must pass too, and there must be one. Each task wants the
 * clean cycles of its size and risk (cyclesFor), or cycles when it is given and higher: cycles only raises. The hook calls this, so it
 * never throws: what it cannot read refuses the merge.
 */
export function mergeCheck(sha, env = process.env, { cycles, pr } = {}) {
  const root = sageRoot(env);
  try {
    if (notFull(sha)) return { ok: false, reason: notFull(sha) };
    sha = String(sha).toLowerCase(); // the ledger holds SHAs as git prints them
    pr &&= String(pr); // the tasks table holds it as text
    const cfg = config(env); // once: the merge check may judge thousands of tasks
    // A logbook may be a link to a folder: the writes go through it, so the merge check reads through it too. A link to nothing
    // holds no logbook, for the writes either; one that cannot be followed refuses.
    const dirs = existsSync(root) ? readdirSync(root).map((name) => join(root, name)).filter((path) => statSync(path, { throwIfNoEntry: false })?.isDirectory()).sort() : [];
    const each = dirs.flatMap((dir) => {
      // A folder with tasks.tsv, also a link, is a logbook, and it must pass the integrity check. A folder without it is
      // none: init has not finished it, or it lost its tasks. Its verdicts name tasks that it does not have, so they refuse.
      const book = lstatSync(join(dir, "tasks.tsv"), { throwIfNoEntry: false }) && check(dir);
      if (!book && !readRegular(join(dir, "ledger.tsv"))?.trim()) return [];
      const rows = rowsOf(book ? book.ledger : sheet(dir, "ledger")).filter((r) => r.sha === sha);
      if (!rows.length) return [];
      const [tasks, findings] = book ? [rowsOf(book.tasks), rowsOf(book.findings)] : [[], []];
      const repaired = book && rowsOf(book.decisions).some((d) => d.decision.startsWith("tasks.tsv started again without rows"));
      const ofPr = pr ? tasks.filter((t) => t.pr === pr).map((t) => t.id) : [];
      return [...new Set([...rows.map((r) => r.task), ...ofPr])].map((id) => {
        const own = rows.filter((r) => r.task === id);
        const task = tasks.find((t) => t.id === id);
        return { dir, id, ofPr: ofPr.includes(id), own: own.length, ...judge(dir, tasks, findings, id, own, task ? Math.max(cycles ?? 0, cyclesFor(task, cfg)) : cycles, repaired) };
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
    if (e instanceof Refusal) return { ok: false, reason: `the merge check refuses every merge, because ${e.message}` }; // it names the file and what to do
    const [at, why] = [e?.path, e?.code ?? e?.message ?? e];
    if (at === undefined) return { ok: false, reason: `the merge check failed (${why}), so it refuses every merge.` };
    return { ok: false, reason: `the merge check cannot read ${at} (${why}), so it refuses every merge. ${fixIt(at, why, root)}` };
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
    const cycles = opt.cycles === undefined ? undefined : (typed("cycles.small", opt.cycles) ?? refuse("--cycles is a whole number from 1 to 10")); // the chief's explicit count: it only raises a task's own count
    if (opt.pr !== undefined && !PR.test(opt.pr)) refuse("--pr is the pull request's number, for example --pr 5");
    const r = mergeCheck(opt.sha ?? refuse("merge-check needs --sha with the full 40-character SHA of the head commit: git rev-parse <branch>"), env, { cycles, pr: opt.pr });
    return r.ok ? r.reason : refuse(r.reason);
  }
  if (cmd === "config") {
    const set = {};
    for (const kv of pos) {
      const [k, v = ""] = kv.split("=");
      const count = Object.hasOwn(COUNTS, k) || CAP.test(k);
      if (count && /^[1-9]\d*$/.test(v) && Number(v) > limit(k)) refuse(`${k} must be ${limit(k)} or less: ${v} is above the limit, which keeps a typo from blocking every merge or starting too many agents`);
      if (count && typed(k, v) === undefined) refuse(`${k} must be a whole number of ${floor(k)} or more${/^0+$/.test(v) ? `: with 0, ${COUNTS[k] ?? "no sage agent could start for that project"}` : /^[1-9]\d*$/.test(v) ? `: ${v} is below the floor of ${floor(k)}, which only a code change lowers` : `, not ${JSON.stringify(v)}`}`);
      set[k] = (count ? typed(k, v) : valid(k, v)) ?? refuse(`config takes ${KEYS}, and arena_models as a list of ${MODELS.join(", ")}`);
    }
    if (pos.length) {
      const file = join(sageRoot(env), "config.json");
      mkdirSync(sageRoot(env), { recursive: true });
      const st = lstatSync(file, { throwIfNoEntry: false });
      if (st && !st.isFile()) refuse(`${file} is ${st.isSymbolicLink() ? "a link" : st.isDirectory() ? "a folder" : st.isFIFO() ? "a named pipe" : st.isSocket() ? "a socket" : "a device"}, not a regular file, so config writes nothing. Replace it with a regular file.`);
      // A write never follows a link (sec15d), also one that replaces config.json after the check above (F-T42-2): the new
      // text goes to a new temp file in the sage folder (wx: never through a planted link), and a rename onto the path itself
      // replaces whatever is there, a link too. put() would rename onto the link's target.
      const temp = `${file}.${randomUUID()}`;
      writeFileSync(temp, JSON.stringify({ ...saved(env), ...set }, null, 2) + "\n", { flag: "wx" }); // a key of a newer version stays
      try {
        renameSync(temp, file);
      } catch (e) {
        rmSync(temp, { force: true });
        throw e;
      }
    }
    const c = { ...config(env), ...set };
    return Object.entries(c).map(([k, v]) => `${k}=${v}`).join(" ");
  }
  const project = resolve(opt.project ?? env.SAGE_PROJECT ?? process.cwd());
  if (cmd === "worktrees") return worktrees(project, env, opt["dry-run"] !== undefined);
  const dir = storeDir(project, env);
  const repair = cmd === "logbook" && pos[0] === "repair";
  const skip = repair ? [...new Set(list(opt["accept-loss"]))] : [];
  const odd = skip.filter((t) => !Object.hasOwn(TABLES, t));
  if (repair && (odd.length || !skip.length)) refuse(`logbook repair needs --accept-loss with the tables whose rows the user accepts to lose, joined by a comma: ${Object.keys(TABLES).join(", ")}.${odd.length ? ` Not ${odd.join(", ")}.` : ""}`);
  if (cmd !== "init" && !(repair && existsSync(dir)) && !existsSync(join(dir, "tasks.tsv"))) {
    const printed = visible(project); // a path with control characters prints otherwise than it is, so it gets no line to paste
    refuse(`no logbook for the project ${printed}. ${printed === project ? `Run: sage init --project ${shell(project)}` : "Its path has control characters, so no command is printed to paste. Rename the folder, or run sage init from inside it."}`);
  }
  // A read takes no lock: every file is replaced whole, so it sees the store before or after a change, never half of one.
  if ((cmd === "logbook" && !repair) || cmd === "status" || (cmd === "standing" && pos[0] !== "add")) return act(cmd, pos, opt, dir, env);
  if (cmd === "init") {
    mkdirSync(join(dir, "briefs"), { recursive: true });
    mkdirSync(join(dir, "reports"), { recursive: true });
  }
  const out = withLock(dir, () => {
    ready(dir, skip);
    const out = act(cmd, pos, opt, dir, env, skip);
    status(dir, true);
    nameCheckout(dir, project);
    return out;
  });
  // A task that reaches a last state gives up its worktree here, so the rule is in code. It never fails the move.
  const to = cmd === "task" && pos[1] === "set" ? pos.slice(2).findLast((kv) => kv.startsWith("state="))?.slice(6) : undefined;
  if (!DONE.includes(to)) return out;
  try {
    const task = read(dir, "tasks").find((t) => t.id === pos[0]);
    return [out, ...tidy(dir, projectRoot(project), env, { task }).map((line) => `worktree ${line}`)].join("\n");
  } catch (e) {
    return `${out}\nworktree not tidied: ${e.message}`;
  }
}

/** Writes the project's main checkout to checkout.txt, for sage worktrees, which tidies every project. Never fails. */
function nameCheckout(dir, project) {
  try {
    const at = projectRoot(project);
    if (readRegular(join(dir, "checkout.txt"))?.trim() !== at) put(join(dir, "checkout.txt"), `${at}\n`);
  } catch {}
}

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** The pull requests of a project, or null when gh cannot give them, for example offline. $SAGE_GH names another gh. */
function pullRequests(root, env) {
  try {
    return JSON.parse(execFileSync(env.SAGE_GH ?? "gh", ["pr", "list", "--state", "all", "--limit", "1000", "--json", "number,state,headRefName,headRefOid,isCrossRepository"], { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000 }));
  } catch {
    return null;
  }
}

/** Folders that a build or an install makes again, at any depth. An ignored file outside them may be the owner's only copy. */
const REBUILDABLE = new Set(["node_modules", "dist", "build", ".next", ".nuxt", ".turbo", ".cache", "coverage", ".parcel-cache", "__pycache__", ".pytest_cache", ".venv", "target", ".gradle"]);

/** The ignored paths of a worktree. git remove deletes ignored files; a failed listing throws, so the caller keeps the worktree. */
const ignoredPaths = (path) =>
  execFileSync("git", ["-C", path, "status", "-z", "--porcelain", "--ignored=matching"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    .split("\0")
    .filter((e) => e.startsWith("!! ")) // matching names the folder a pattern matches ("a/node_modules/"), not the untracked folder above it
    .map((e) => e.slice(3));
const rebuildable = (p) => p.split("/").slice(0, -1).some((folder) => REBUILDABLE.has(folder)); // "dist/" and "a/dist/b" end in a name or ""

/** The first folder at or under rel (relative to root) that holds a .git entry, a folder or a file: a repository with its own commits. Links are not followed. */
function nestedRepo(root, rel) {
  const todo = [rel.replace(/\/$/, "")];
  while (todo.length) {
    const at = todo.pop();
    if (basename(at) === ".git") return dirname(at);
    const st = lstatSync(join(root, at), { throwIfNoEntry: false });
    if (!st?.isDirectory()) continue;
    for (const e of readdirSync(join(root, at), { withFileTypes: true })) {
      if (e.name === ".git") return at;
      if (e.isDirectory()) todo.push(join(at, e.name));
    }
  }
}

/** The branches that sage never deletes: main, master, the main checkout's, and the remote's default by its local and its remote HEAD. */
function defaultBranches(root, main, remote) {
  const out = new Set(["main", "master", main.branch?.slice(11), remote?.head]);
  try {
    out.add(git(root, "symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD").replace(/^origin\//, ""));
  } catch {}
  return out;
}

/** The refs of origin as the remote itself gives them, and its default branch, or null when the remote cannot be reached. */
function remoteRefs(root) {
  try {
    const lines = execFileSync("git", ["-C", root, "ls-remote", "--symref", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 }).split("\n");
    const head = lines.find((l) => l.startsWith("ref: ") && l.endsWith("\tHEAD"))?.slice(5, -5).replace(/^refs\/heads\//, "");
    const refs = lines.filter((l) => /^[0-9a-f]{40}\t(refs\/heads\/|refs\/pull\/\d+\/head$)/.test(l)).map((l) => l.split("\t"));
    return { head, refs };
  } catch {
    return null;
  }
}

/** True when the remote has the commit: a branch or a PR head of origin is the commit, or contains it after a fetch that changes no local branch. */
function onRemote(root, remote, sha) {
  if (remote.refs.some(([at]) => at === sha)) return true;
  const known = (at) => {
    try {
      return git(root, "cat-file", "-t", at) === "commit";
    } catch {
      return false;
    }
  };
  const fetch = remote.refs.filter(([at]) => !known(at)).map(([, ref]) => ref);
  if (fetch.length) git(root, "fetch", "-q", "--no-tags", "--no-write-fetch-head", "origin", ...fetch); // no destination: no local ref changes
  return remote.refs.some(([at]) => {
    try {
      return git(root, "merge-base", "--is-ancestor", sha, at) === "";
    } catch {
      return false;
    }
  });
}

/**
 * Removes the worktrees and local branches of finished work in one project, and returns one line for each that it
 * removed or kept, with the reason. Finished: every task that owns the branch is merged, concluded or abandoned; a branch
 * that no task owns is finished when its PR (same head, same repository) is merged or closed. Never while its PR is open,
 * a run of its task or branch runs, or it is a default branch. It removes only a clean one with no file hidden from git
 * status, whose last commit the remote itself has, whose ignored files are all in rebuildable folders and hold no nested
 * repository, and only when GitHub gives the PR state: it fails closed. It uses
 * git worktree remove without --force, deletes the branch only at that commit, and never touches the main checkout or a
 * folder that is not a registered worktree. With task, only that task's branch.
 */
function tidy(dir, root, env, { task: only, dry } = {}) {
  let trees;
  try {
    trees = git(root, "worktree", "list", "--porcelain").split(/\n\n+/).map((block) => Object.fromEntries(block.split("\n").map((l) => [l.split(" ")[0], l.slice(l.indexOf(" ") + 1)])));
  } catch {
    return only ? [] : [`${root}: skipped: it is not a git checkout`];
  }
  const [main, ...others] = trees; // git lists the main checkout first
  const [tasks, runs] = [read(dir, "tasks"), read(dir, "runs")];
  const checkedOut = new Set(trees.map((t) => t.branch));
  const seen = new Set();
  const all = [
    ...others.filter((t) => t.branch?.startsWith("refs/heads/") && !("prunable" in t)).sort((a, b) => (a.worktree < b.worktree ? -1 : 1)).map((t) => ({ path: t.worktree, branch: t.branch.slice(11), head: t.HEAD })),
    ...tasks.filter((t) => DONE.includes(t.state) && t.branch && !checkedOut.has(`refs/heads/${t.branch}`)).flatMap((t) => {
      try {
        return [{ branch: t.branch, head: git(root, "rev-parse", "--verify", "-q", `refs/heads/${t.branch}`) }]; // a branch without its worktree
      } catch {
        return [];
      }
    }),
  ].filter((c) => (only ? c.branch === only.branch : true) && main.worktree !== c.path && !seen.has(c.branch) && seen.add(c.branch));
  let prs, remote, keep;
  const lines = [];
  for (const c of all) {
    const own = tasks.filter((t) => t.branch === c.branch);
    const task = own.find((t) => !DONE.includes(t.state)) ?? only ?? own.at(-1); // a branch that two tasks share is done when both are
    if (runs.some((r) => r.status === "running" && (r.branch === c.branch || own.some((t) => t.id === r.task)))) continue;
    if (prs === undefined) [prs, remote] = [pullRequests(root, env), remoteRefs(root)]; // once, and only when a worktree needs them
    keep ??= defaultBranches(root, main, remote);
    if (keep.has(c.branch)) continue;
    if ((prs ?? []).some((p) => p.state === "OPEN" && (p.headRefName === c.branch || (task?.pr && String(p.number) === task.pr)))) continue;
    // A PR counts only for a branch that no task owns, and only the PR of this very head from this repository.
    const ended = !own.length && (prs ?? []).find((p) => ["MERGED", "CLOSED"].includes(p.state) && p.headRefName === c.branch && p.headRefOid === c.head && p.isCrossRepository === false);
    const why = own.length ? (DONE.includes(task.state) ? `${task.id} ${task.state}` : "") : ended ? `PR ${ended.number} ${ended.state.toLowerCase()}` : "";
    if (!why) continue;
    const line = (verdict) => lines.push(`${c.path ? `${c.path} · ${c.branch}` : `branch ${c.branch}`} · ${why}: ${verdict}`);
    try {
      const ignored = c.path ? ignoredPaths(c.path) : [];
      const nested = ignored.map((p) => nestedRepo(c.path, p)).find((p) => p !== undefined);
      const hidden = c.path ? git(c.path, "ls-files", "-v").split("\n").filter((l) => /^(S|[a-z]) /.test(l)).map((l) => l.slice(2)) : [];
      const reason =
        c.path && git(c.path, "status", "--porcelain") ? "it has changes that are not committed"
        : hidden.length ? `files hidden from git status: ${hidden.slice(0, 3).join(", ")}`
        : nested !== undefined ? `a nested git repository: ${nested}`
        : ignored.some((p) => !rebuildable(p)) ? `ignored files that are not rebuildable: ${ignored.filter((p) => !rebuildable(p)).slice(0, 3).join(", ")}`
        : remote === null ? "the remote cannot be reached"
        : !onRemote(root, remote, c.head) ? `its last commit ${c.head.slice(0, 7)} is not on the remote`
        : prs === null ? "GitHub cannot be reached, so its PR state is unknown"
        : "";
      if (reason || dry) {
        line(reason ? `kept: ${reason}` : "would remove");
        continue;
      }
      if (c.path) git(root, "worktree", "remove", c.path);
      git(root, "update-ref", "-d", `refs/heads/${c.branch}`, c.head); // only at the commit that is on the remote
      try {
        git(root, "config", "--remove-section", `branch.${c.branch}`);
      } catch {} // a branch without an upstream has no section
      line("removed");
    } catch (e) {
      line(`kept: git refused: ${String(e.stderr || e.message).split("\n")[0].replace(/^(fatal|error): /, "")}`);
    }
  }
  if (!dry) {
    try {
      git(root, "worktree", "prune");
    } catch {}
  }
  return lines;
}

/** sage worktrees: tidy in every project's logbook. A logbook names its main checkout in checkout.txt, which each change writes. */
function worktrees(project, env, dry) {
  const own = storeDir(project, env);
  if (existsSync(join(own, "tasks.tsv"))) withLock(own, () => nameCheckout(own, project)); // so the hint below is true
  const root = sageRoot(env);
  const dirs = existsSync(root) ? readdirSync(root).map((name) => join(root, name)).filter((d) => existsSync(join(d, "tasks.tsv"))).sort() : [];
  const lines = dirs.flatMap((dir) => {
    try {
      const at = readRegular(join(dir, "checkout.txt"))?.trim();
      if (!at || storeDir(at, env) !== dir) return [`${dir}: skipped: it does not name its main checkout yet. Run sage worktrees in that project once.`];
      return tidy(dir, at, env, { dry });
    } catch (e) {
      return [`${dir}: skipped: ${e.message}`];
    }
  });
  return lines.join("\n") || "no stale worktrees";
}

function act(cmd, pos, opt, dir, env, skip) {
  const [sub, id, ...more] = pos;
  switch (cmd) {
    case "init":
      // A new logbook's tables, tasks.tsv last: the merge check takes a folder with it for a whole logbook. An existing
      // logbook passed the integrity check (ready), so init makes no table there.
      for (const t of Object.keys(TABLES).reverse()) if (!existsSync(join(dir, `${t}.tsv`))) write(dir, t, []);
      if (!existsSync(join(dir, "standing.md"))) put(join(dir, "standing.md"), STANDING);
      return `logbook ${dir}`;
    case "logbook": {
      if (sub !== "repair") return dir;
      // The user accepts the loss of the rows of each table in skip: its old file goes aside, never away, and the table
      // starts again. The decisions come first, so a write that fails or is stopped leaves no table reset without its
      // decision; a table reset without the others leaves the check failing, so nothing passes before the repair is whole.
      const tables = skip.map((table) => {
        const file = join(dir, `${table}.tsv`);
        try {
          sheet(dir, table);
        } catch {
          const aside = lstatSync(file, { throwIfNoEntry: false }) ? `${file}.lost-${Date.now()}` : "";
          return { table, file, aside, was: aside ? `; its old file is ${aside}` : "" };
        }
        return refuse(`${file} passes the logbook check, so it has nothing to repair. Nothing changed.`);
      });
      const decided = tables.map(({ table, was }) => ({ at: now(), task: "", decision: `${table}.tsv started again without rows${was}`, why: "the user accepts the loss of its rows" }));
      const trail = tables.find((t) => t.table === "decisions");
      if (trail?.aside) renameSync(trail.file, trail.aside);
      write(dir, "decisions", [...(trail ? [] : read(dir, "decisions")), ...decided]);
      for (const { table, file, aside } of tables.filter((t) => t !== trail)) {
        if (aside) renameSync(file, aside);
        write(dir, table, []);
      }
      const kept = tables.filter((t) => t.aside);
      const old = kept.length === 1 ? (tables.length === 1 ? `; its old file is ${kept[0].aside}` : `; the old file of ${kept[0].table}.tsv is ${kept[0].aside}`) : kept.length ? `; the old files are ${kept.map((t) => t.aside).join(" and ")}` : "";
      return `${tables.map((t) => `${t.table}.tsv`).join(" and ")} started again without rows${old}. The decision${tables.length === 1 ? " is" : "s are"} in decisions.tsv.`;
    }
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
        const task = frame(dir, need(opt.title, "--title"), size, risk, list(opt.add));
        if (opt.add) write(dir, "decisions", [...read(dir, "decisions"), { at: now(), task: task.id, decision: `added ${opt.add}`, why }]);
        return framed(task);
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
      const roles = [...new Set(fix.map((f) => f.source))].sort().join(","); // the repair's diff goes back to the roles that found the problems
      return `${task.id} repairing · round ${round} of ${config(env).max_rounds} · fix ${keys} · re-run ${roles} on the repair's diff`;
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
        const key = cell(opt.key) || nextId(dir, `F-${task.id}-`); // as the table holds it, so the same --key finds its finding again
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
      } else if (sub === "move") {
        // A new medium finding of a repair round goes to a follow-up task, not to another round. A high one blocks until it is fixed.
        if (f.status !== "open") refuse(`${f.key} is ${f.status}: only an open finding moves.`);
        if (f.severity === "high") refuse(`${f.key} is high, so it blocks ${id} until it is fixed: a high finding never moves to a follow-up task.`);
        const title = need(cell(opt.to), '--to "<the follow-up task\'s title>"');
        const size = opt.size ?? "small";
        if (!SIZES[size] || size === "investigate") refuse("--size is tiny, small or large");
        const to = frame(dir, title, size, [], []);
        const was = f.key;
        Object.assign(f, { task: to.id, key: nextId(dir, `F-${to.id}-`), round: 0, triage: "" });
        write(dir, "findings", findings);
        write(dir, "decisions", [...read(dir, "decisions"), { at: now(), task: id, decision: `${was} moved to ${to.id} as ${f.key}: ${f.summary}`, why: `the follow-up task: ${title}` }]);
        return `${was} moved to ${to.id} as ${f.key} · ${framed(to)}`;
      } else refuse("finding add, triage, close or move");
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
      // The refusal names the finding first: a chief that recorded the verdict before its finding must not hide the finding.
      if (FOUND.includes(kind) && findings.every((f) => f.severity === "low")) {
        const reviews = CLEAN.filter((k) => k !== "qa-pass"); // the clean verdicts of the blocks that give findings
        const fits = kind === "qa-fail" ? ["qa-pass"] : reviews.filter((k) => list(task.route).some((b) => VERDICT[b] === k));
        const clean = fits.length === 1 ? fits[0] : `this review's clean verdict (${(fits.length ? fits : reviews).join(", ")})`;
        refuse(`${task.id} has no open medium or high finding, so ${kind} is refused. If this review found a medium or high problem, record it first: sage finding add ${task.id} --source <role> --severity <medium or high> --summary "<the problem>", then ${kind} again. If it found only low ones, its cycle is clean: record ${clean}, and fix, move or dismiss each low finding before the merge.`);
      }
      // A route without build has no commit to judge. Its rows have no SHA, so the merge check never reads them.
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

/** The text that the tool prints: its lines, each with its control characters shown as \xNN. Ids, columns and paths come from files and the user. */
const shown = (text) => text.split("\n").map(visible).join("\n");
/** The standing orders as a person wrote them, for briefs to copy word for word: tabs stay, a CRLF or CR line end prints as a plain one, and no hidden character stays. */
const orders = (text) => text.replace(/\r\n?/g, "\n").replace(HIDDEN, "");

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    console.log((process.argv[2] === "standing" ? orders : shown)(sage(process.argv.slice(2))));
  } catch (err) {
    console.error(`sage: ${shown(err instanceof Refusal ? err.message : err.stack)}`);
    process.exit(err instanceof Refusal ? 1 : 2);
  }
}
