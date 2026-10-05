// The board for the chat: one compact Markdown text, built from every project's logbook under the sage root, that
// fits a phone screen. `sage board [this|all|<project>]` prints it. It takes no lock and never writes to a logbook:
// every table is replaced whole, so a read sees it before or after a change. It writes one file at the sage root,
// board.json, the merged tasks it has shown, so that the next board lists only what merged since.
// Every cell is agent-written data. An id-like cell is kept only in its format, else it shows as "?". Free text is
// escaped, so that the only links, images and HTML on the board are the board's own PR links, built from digits.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { BLOCKS, RISKS, STATES, projectName, read, sageRoot, storeDir } from "./sage.mjs";

const FOLDER = /^([a-z0-9-]+)-[0-9a-f]{6}$/;
const CLOSED = ["merged", "concluded", "abandoned"];
const WAITS = ["verified", "pr-ready"];
const CAP = { needs: 8, running: 8, merged: 8, next: 3, active: 8 };
// The agent roles beside the step names. The lists from sage.mjs are read at call time: the two modules import each other.
const AGENTS = ["implementer", "designer", "code-reviewer", "security-reviewer", "ux-reviewer", "arena-judge", "researcher"];
/** The format of each id-like cell. A cell that does not match shows as "?"; an empty cell stays empty. */
const FORMAT = {
  tasks: { id: /^T\d+$/, state: (v) => STATES.includes(v), pr: /^\d+$/, round: /^\d+$/, risk: (v) => v.split(",").every((r) => RISKS.includes(r)) },
  runs: { task: /^T\d+$/, role: (v) => BLOCKS.includes(v) || AGENTS.includes(v) },
  gates: { id: /^G\d+$/, task: /^T\d+$/ },
};
const fits = (test, v) => (typeof test === "function" ? test(v) : test.test(v));
const clean = (table, row) => {
  for (const [k, test] of Object.entries(FORMAT[table])) if (row[k] && !fits(test, row[k])) row[k] = "?";
  return row;
};

/** One line of free text: no line breaks or hidden characters, at most max characters, Markdown and HTML escaped. */
function text(s, max) {
  const chars = [...String(s ?? "").replace(/\s+/g, " ").replace(/[\p{Cc}\p{Cf}]/gu, "").trim()];
  const line = chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("");
  return line.replace(/[\\`*_[\]()<>!#|~]/g, "\\$&");
}
const n = (id) => Number(String(id).replace(/\D/g, "")) || 0;
const plural = (k, word) => `${k} ${word}${k === 1 ? "" : "s"}`;
function age(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m} min`;
  if (m < 48 * 60) return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
  return `${Math.floor(m / 1440)} d`;
}

/** The GitHub repository of a checkout, as https://github.com/<owner>/<repo>, or null. */
function repoOf(path) {
  try {
    const url = execFileSync("git", ["-C", path, "remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const m = /^(?:https:\/\/|ssh:\/\/git@|git@)github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url);
    return m ? `https://github.com/${m[1]}/${m[2]}` : null;
  } catch {
    return null;
  }
}
const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/** Every logbook under the root: its key (the folder name without its hash), tables, and checkout when checkout.txt names it. */
function logbooks(root) {
  let folders = [];
  try {
    folders = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && FOLDER.test(d.name) && existsSync(join(root, d.name, "tasks.tsv")));
  } catch {}
  return folders.map(({ name }) => {
    const dir = join(root, name);
    let checkout = null;
    try {
      checkout = readFileSync(join(dir, "checkout.txt"), "utf8").trim() || null;
    } catch {}
    const book = { key: FOLDER.exec(name)[1], dir, checkout, tasks: [], runs: [], gates: [], error: null };
    try {
      for (const t of ["tasks", "runs", "gates"]) book[t] = read(dir, t).map((row) => clean(t, row));
    } catch (e) {
      book.error = text(e.message, 120);
    }
    return book;
  });
}

/** The session's logbook: the one storeDir gives, else the one whose checkout.txt names the project, else the one with its name. */
function sessionBook(books, project, env) {
  if (!project) return null;
  const exact = storeDir(project, env);
  const root = real(project);
  const name = projectName(project);
  return books.find((b) => b.dir === exact) ?? books.find((b) => b.checkout && real(b.checkout) === root) ?? books.find((b) => !b.checkout && b.key === name) ?? null;
}

/** The last board's board.json, or null when it is not a regular file under 64 KB in the right shape (the next board rewrites it). */
function seen(root) {
  const file = join(root, "board.json");
  try {
    const st = lstatSync(file);
    if (!st.isFile() || st.size >= 64 * 1024) return null;
    const s = JSON.parse(readFileSync(file, "utf8"));
    const lists = s?.merged && typeof s.merged === "object" && !Array.isArray(s.merged) ? Object.values(s.merged) : null;
    const ok = /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d)?Z$/.test(s?.at) && lists?.every((l) => Array.isArray(l) && l.every((id) => typeof id === "string"));
    return ok ? s : null;
  } catch {
    return null;
  }
}
/** Saves the merged tasks that this board showed, per project; a project not shown keeps its old list. Never through a link. */
function remember(root, last, books, at) {
  const merged = { ...(last?.merged ?? {}) };
  for (const b of books) if (!b.error) merged[b.key] = b.tasks.filter((t) => t.state === "merged").map((t) => t.id);
  const file = join(root, "board.json");
  const temp = `${file}.${randomUUID()}`;
  try {
    writeFileSync(temp, JSON.stringify({ at, merged }, null, 2) + "\n", { flag: "wx" });
    renameSync(temp, file);
  } catch {
    rmSync(temp, { force: true });
  }
}

/**
 * The board as Markdown. scope: "this" (the session's project, and one line per other project with something waiting),
 * "all", or a project's key (any case). project: the session's folder; a session outside every project shows all.
 */
export function board({ scope = "this", project, env = process.env, now = new Date(), save = true } = {}) {
  const root = sageRoot(env);
  const books = logbooks(root).sort((a, b) => a.key.localeCompare(b.key));
  const built = now.toISOString().slice(0, 16).replace("T", " ");
  if (!books.length) return `**sage board** · built ${built} UTC\n\nNo logbooks yet under ${root}. In a project folder, start sage mode and give the chief a task.`;
  const known = books.map((b) => b.key).join(", ");
  let shown;
  let others = [];
  let title;
  const want = String(scope).toLowerCase();
  if (want === "all") [shown, title] = [books, "all projects"];
  else if (want === "this") {
    const mine = sessionBook(books, project, env);
    if (mine) [shown, others, title] = [[mine], books.filter((b) => b !== mine), mine.key];
    else [shown, title] = [books, "all projects (this folder has no logbook)"];
  } else {
    shown = books.filter((b) => b.key === want);
    if (!shown.length) return `No project named "${text(scope, 40)}". Known projects: ${known}.`;
    title = want;
  }

  const mine = sessionBook(books, project, env);
  const sessionRepo = project && mine ? repoOf(project) : null;
  for (const b of books) b.repo = b.checkout ? repoOf(b.checkout) : b === mine ? sessionRepo : null;
  const pr = (b, t) => (!t.pr ? "no PR" : t.pr === "?" ? "PR ?" : b.repo ? `[#${t.pr}](${b.repo}/pull/${t.pr})` : `PR #${t.pr}`);
  const many = shown.length > 1;
  const tag = (b) => (many ? `${b.key} ` : "");

  // Needs you: open gates, then every verified pull request that is not merged. Autopilot is a per-session switch,
  // so the board cannot know that it will merge a small one: it says so, and still lists it.
  const gates = (b) => b.gates.filter((g) => !g.answer);
  const waiting = (b) =>
    b.tasks
      .filter((t) => WAITS.includes(t.state) && t.pr)
      .map((t) => ({ t, why: t.size === "large" ? "large" : t.risk ? `risk ${t.risk}` : "autopilot may merge it tonight" }));
  const options = (g) => text(String(g.options ?? "").split(/[|,]/).map((o) => o.trim()).filter(Boolean).join(" / "), 80) || "none";
  const L = [`**sage board · ${title}** · built ${built} UTC`];
  const needs = shown.flatMap((b) => [
    ...gates(b).map((g) => `${tag(b)}**${g.id}** (${g.task}) ${text(g.question, 110)} Options: ${options(g)}. Recommended: ${text(g.recommendation, 60) || "none"}. Default: ${text(g.default, 40) || "none"}.`),
    ...waiting(b).map(({ t, why }) => `${tag(b)}${t.id} ${pr(b, t)} waits for your merge (${why}): ${text(t.title, 50)}`),
  ]);
  const section = (head, rows, cap) => {
    L.push("", `**${head}**`);
    if (!rows.length) L.push("- nothing");
    for (const row of rows.slice(0, cap)) L.push(`- ${row}`);
    if (rows.length > cap) L.push(`- and ${rows.length - cap} more`);
  };
  section(`Needs you (${needs.length})`, needs, CAP.needs);
  const running = shown.flatMap((b) => b.runs.filter((r) => r.status === "running").map((r) => ({ b, r }))).sort((x, y) => Date.parse(x.r.started) - Date.parse(y.r.started));
  section(`Running now (${running.length})`, running.map(({ b, r }) => `${tag(b)}${r.task} ${r.role} · ${Number.isFinite(Date.parse(r.started)) ? age(now - Date.parse(r.started)) : "age unknown"}`), CAP.running);

  // Merged since the last board: the merged tasks that the last board did not show.
  const last = seen(root);
  const fresh = shown.flatMap((b) => b.tasks.filter((t) => t.state === "merged" && last?.merged?.[b.key] && !last.merged[b.key].includes(t.id)).map((t) => `${tag(b)}${t.id} ${pr(b, t)} ${text(t.title, 50)}`));
  const firstFor = shown.filter((b) => !b.error && !last?.merged?.[b.key]);
  const since = last ? `since ${last.at.slice(0, 16).replace("T", " ")} UTC` : "since the last board";
  section(`Merged ${since} (${fresh.length})`, fresh, CAP.merged);
  if (firstFor.length) L.push(`- first board for ${firstFor.map((b) => b.key).join(", ")}: earlier merges not listed`);

  // One section per project: its active tasks, the framed backlog as a count, and the next 3 framed tasks by id.
  for (const b of shown) {
    L.push("", `**${b.key}**${b.repo ? ` · ${b.repo.replace("https://", "")}` : ""}`);
    if (b.error) {
      L.push(`- logbook cannot be read: ${b.error}`);
      continue;
    }
    const active = b.tasks.filter((t) => !CLOSED.includes(t.state) && t.state !== "framed").sort((x, y) => n(x.id) - n(y.id));
    const framed = b.tasks.filter((t) => t.state === "framed").sort((x, y) => n(x.id) - n(y.id));
    const cap = many ? CAP.active : active.length;
    for (const t of active.slice(0, cap)) L.push(`- ${t.id} ${text(t.title, 40)} · ${t.state} · ${pr(b, t)}${t.round && t.round !== "0" ? ` · round ${t.round}` : ""}`);
    if (active.length > cap) L.push(`- and ${active.length - cap} more (show board for ${b.key})`);
    if (!active.length) L.push("- no active tasks");
    L.push(`- framed backlog: ${framed.length}${framed.length ? ` · next up (framed, in id order): ${framed.slice(0, CAP.next).map((t) => `${t.id} ${text(t.title, 30)}`).join("; ")}` : ""}`);
  }
  const elsewhere = others
    .map((b) => {
      const parts = [b.error ? "logbook cannot be read" : "", gates(b).length ? `${plural(gates(b).length, "gate")} waiting` : "", waiting(b).length ? `${plural(waiting(b).length, "PR")} waiting for your merge` : ""].filter(Boolean);
      return parts.length ? `${b.key}: ${parts.join(", ")}` : null;
    })
    .filter(Boolean);
  if (elsewhere.length) section("Other projects", elsewhere, elsewhere.length);
  if (save) remember(root, last, shown, now.toISOString().slice(0, 19) + "Z");
  return L.join("\n");
}
