// The board for the chat: one compact Markdown text, built from every project's logbook under the sage root, that
// fits a phone screen. `sage board [this|all|<project>]` prints it. It takes no lock and never writes to a logbook:
// every table is replaced whole, so a read sees it before or after a change. It writes one file at the sage root,
// board.json: per logbook folder, when the last board showed it, its highest task id then and its tasks not closed then,
// so that the next board lists only what merged since. It writes board.json under a lock at the sage root.
// Every cell is agent-written data. An id-like cell is kept only in its format, else it shows as "?". Free text is
// escaped, also ":", "." and "@" against autolinks and "&" against entities, so that the only links, images and HTML on the board are the
// board's own PR links, built from digits.
import { execFileSync } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, openSync, readSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { BLOCKS, RISKS, STATES, projectName, projectRoot, read, sageRoot, slug, storeDir, withLock } from "./sage.mjs";

const FOLDER = /^([a-z0-9-]+)-[0-9a-f]{6}$/;
const CLOSED = ["merged", "concluded", "abandoned"];
const WAITS = ["verified", "pr-ready"];
const CAP = { running: 8, merged: 8, next: 3, active: 8 };
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

/**
 * One line of free text: no line breaks or hidden characters, at most max characters, Markdown and HTML escaped.
 * ":", "." and "@" are escaped too, so that GFM makes no autolink of a bare URL, a www host or an email, and "&", so that
 * no entity (&colon;) decodes to one.
 */
function text(s, max) {
  const chars = [...String(s ?? "").replace(/\s+/g, " ").replace(/[\p{Cc}\p{Cf}]/gu, "").trim()];
  const line = chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("");
  return line.replace(/[\\`*_[\]()<>!#|~:.@&]/g, "\\$&");
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
/**
 * The text of a small regular file, or null: for a missing file, a link, a FIFO, a device, a folder or a file over max
 * bytes. It never blocks (the open does not wait for a FIFO's writer) and reads at most max + 1 bytes.
 */
function small(path, max) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    if (!fstatSync(fd).isFile()) return null;
    const buf = Buffer.alloc(max + 1);
    const len = readSync(fd, buf, 0, max + 1, 0);
    return len > max ? null : buf.toString("utf8", 0, len);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/**
 * Every logbook under the root, sorted by key: its folder, its name (the folder without its hash), its key (the name, or
 * the folder when two logbooks have the same name), its tables (all, or none when one cannot be read), and its checkout
 * when checkout.txt names it.
 */
function logbooks(root) {
  let folders = [];
  try {
    folders = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && FOLDER.test(d.name) && existsSync(join(root, d.name, "tasks.tsv")));
  } catch {}
  const books = folders.map(({ name: folder }) => {
    const dir = join(root, folder);
    const checkout = small(join(dir, "checkout.txt"), 4096)?.trim() || null;
    const book = { folder, name: FOLDER.exec(folder)[1], dir, checkout, tasks: [], runs: [], gates: [], error: null };
    try {
      const [tasks, runs, gates] = ["tasks", "runs", "gates"].map((t) => read(dir, t).map((row) => clean(t, row)));
      Object.assign(book, { tasks, runs, gates });
    } catch (e) {
      book.error = text(e.message.replaceAll(`${dir}/`, "").replaceAll(dir, folder), 120); // the reason, not the long path
    }
    return book;
  });
  for (const b of books) b.key = books.some((o) => o !== b && o.name === b.name) ? b.folder : b.name;
  return books.sort((a, b) => a.key.localeCompare(b.key));
}

/** A name for matching: NFC, and Latin letters in lower case. */
const fold = (s) => String(s).normalize("NFC").replace(/\p{Script=Latin}/gu, (c) => c.toLowerCase());

/**
 * The logbooks that a typed name can mean. An exact real name picks one. Else its slug matches a key, a logbook folder or
 * a name. Returns the candidates and whether the one candidate is sure: a typed name with letters or digits that the
 * slug drops (中文, Café) is never sure by its slug alone, so a fallback slug such as "project" never picks a project.
 */
function named(books, typed, want) {
  const real = books.filter((b) => b.real && fold(b.real) === fold(typed));
  if (real.length) return [real, real.length === 1];
  const bySlug = books.filter((b) => [b.key, b.folder, b.name].includes(want));
  const lossy = /(?![a-z0-9])[\p{L}\p{N}]/u.test(String(typed).toLowerCase());
  return [bySlug, bySlug.length === 1 && !lossy];
}

/**
 * The session's logbook as a list: the one storeDir gives, else the one whose checkout.txt names the project, else the
 * logbooks without checkout.txt that have its name (one is sure; two or more are candidates).
 */
function sessionBooks(books, project, env) {
  if (!project) return [];
  const exact = storeDir(project, env);
  const root = real(project);
  const name = projectName(project);
  const sure = books.find((b) => b.dir === exact) ?? books.find((b) => b.checkout && real(b.checkout) === root);
  return sure ? [sure] : books.filter((b) => !b.checkout && b.name === name);
}

/**
 * The last boards: board.json as { <logbook folder>: { at, top, open } }, or {} when it is not a regular file under 64 KB
 * in that shape (the next board rewrites it). top is the highest task number then, and open the tasks not closed then.
 * A closed task never changes state, so a task merged now is new when it is above top or was open: the entry stays small
 * however many tasks merged.
 */
function seen(root) {
  try {
    const s = JSON.parse(small(join(root, "board.json"), 64 * 1024));
    const ok =
      s && typeof s === "object" && !Array.isArray(s) &&
      Object.entries(s).every(([k, v]) => FOLDER.test(k) && /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d)?Z$/.test(v?.at) && Number.isSafeInteger(v.top) && v.top >= 0 && Array.isArray(v.open) && v.open.every((id) => /^T\d+$/.test(id)));
    return ok ? s : {};
  } catch {
    return {};
  }
}
/** A task merged since the last board of its logbook (last: that logbook's entry). */
const mergedSince = (last, t) => t.state === "merged" && /^T\d+$/.test(t.id) && (n(t.id) > last.top || last.open.includes(t.id));
/**
 * Saves, per logbook folder that this board showed, the time, its highest task number and its tasks not closed; a logbook
 * not shown keeps its entry. It reads board.json again under the lock, so two boards at once lose no entry. Never through
 * a link. When the lock stays busy, it saves nothing: the board is still right, and the next one lists the merges.
 */
function remember(root, books, at) {
  const file = join(root, "board.json");
  try {
    withLock(root, () => {
      const next = seen(root);
      for (const b of books) {
        if (b.error) continue;
        const ids = b.tasks.map((t) => t.id).filter((id) => /^T\d+$/.test(id));
        next[b.folder] = { at, top: Math.max(0, ...ids.map(n)), open: b.tasks.filter((t) => !CLOSED.includes(t.state) && ids.includes(t.id)).map((t) => t.id) };
      }
      const temp = `${file}.${randomUUID()}`;
      try {
        writeFileSync(temp, JSON.stringify(next, null, 2) + "\n", { flag: "wx" });
        renameSync(temp, file);
      } catch {
        rmSync(temp, { force: true });
      }
    });
  } catch {}
}

/**
 * The board as Markdown. scope: "this" (the session's project, and one line per other project with something waiting),
 * "all", or a project's key or logbook folder, as a slug like projectName gives (so any case, and "_", "." or a space
 * for "-"). project: the session's folder; a session outside every project shows all. The "this" and "all" boards show
 * at most 8 active tasks per project; a board for one named project shows all of them.
 */
export function board({ scope = "this", project, env = process.env, now = new Date(), save = true } = {}) {
  const root = sageRoot(env);
  const books = logbooks(root);
  const built = now.toISOString().slice(0, 16).replace("T", " ");
  if (!books.length) return `**sage board** · built ${built} UTC\n\nNo logbooks yet under ${root}. In a project folder, start sage mode and give the chief a task.`;
  // A logbook's real name: the folder name of its checkout (checkout.txt), or of the session folder when that folder is
  // the logbook's own project (its storeDir). Unknown otherwise. PR links come from the same folder: a folder that only
  // shares the logbook's name gives none.
  const own = project && books.find((b) => b.dir === storeDir(project, env));
  for (const b of books) {
    const home = b.checkout ?? (b === own ? projectRoot(resolve(project)) : null);
    b.real = home ? basename(resolve(home)).normalize("NFC") : null;
    b.repo = home ? repoOf(home) : null;
  }
  const label = (b) => (b.real && b.real !== b.key ? `${b.key} (${text(b.real, 40)})` : b.key);
  const known = books.map(label).join(", ");
  let shown;
  let others = [];
  let title;
  const want = slug(scope);
  if (want === "all") [shown, title] = [books, "all projects"];
  else if (want === "this") {
    const mine = sessionBooks(books, project, env);
    if (mine.length > 1) return `Not sure which project this folder is. Candidates: ${mine.map(label).join(", ")}. Type the key or the real name.`;
    if (mine.length) [shown, others, title] = [mine, books.filter((b) => b !== mine[0]), label(mine[0])];
    else [shown, title] = [books, "all projects (this folder has no logbook)"];
  } else {
    let sure;
    [shown, sure] = named(books, scope, want);
    if (!shown.length) return `No project named "${text(scope, 40)}". Known projects: ${known}.`;
    if (!sure) return `Not sure which project "${text(scope, 40)}" is. Candidates: ${shown.map(label).join(", ")}. Type the key or the real name.`;
    title = label(shown[0]);
  }
  const cap = want === "all" || want === "this" ? CAP.active : Infinity;

  const pr = (b, t) => (!t.pr ? "no PR" : t.pr === "?" ? "PR ?" : b.repo ? `[#${t.pr}](${b.repo}/pull/${t.pr})` : `PR #${t.pr}`);
  const many = shown.length > 1;
  const tag = (b) => (many ? `${label(b)} ` : "");

  // Needs you: open gates, then every verified pull request that is not merged. Autopilot is a per-session switch,
  // so the board cannot know that it will merge a small one: it says so, and still lists it.
  const gates = (b) => b.gates.filter((g) => !g.answer);
  const waiting = (b) =>
    b.tasks
      .filter((t) => WAITS.includes(t.state) && t.pr)
      .map((t) => ({ t, why: t.size === "large" ? "large" : t.risk ? `risk ${t.risk}` : "autopilot may merge it tonight" }));
  const options = (g) => text(String(g.options ?? "").split("|").map((o) => o.trim()).filter(Boolean).join(" / "), 80) || "none";
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
  section(`Needs you (${needs.length})`, needs, needs.length);
  const running = shown.flatMap((b) => b.runs.filter((r) => r.status === "running").map((r) => ({ b, r }))).sort((x, y) => Date.parse(x.r.started) - Date.parse(y.r.started));
  section(`Running now (${running.length})`, running.map(({ b, r }) => `${tag(b)}${r.task} ${r.role} · ${Number.isFinite(Date.parse(r.started)) ? age(now - Date.parse(r.started)) : "age unknown"}`), CAP.running);

  // Merged since the last board: per logbook, the merged tasks that the last board of that logbook did not show as merged.
  const last = seen(root);
  const fresh = shown.flatMap((b) => b.tasks.filter((t) => last[b.folder] && mergedSince(last[b.folder], t)).map((t) => `${tag(b)}${t.id} ${pr(b, t)} ${text(t.title, 50)}`));
  const firstFor = shown.filter((b) => !b.error && !last[b.folder]);
  const times = [...new Set(shown.filter((b) => last[b.folder]).map((b) => last[b.folder].at.slice(0, 16).replace("T", " ")))];
  const since = times.length === 1 ? `since ${times[0]} UTC` : times.length ? "since each project's last board" : "since the last board";
  section(`Merged ${since} (${fresh.length})`, fresh, CAP.merged);
  if (firstFor.length) L.push(`- first board for ${firstFor.map(label).join(", ")}: earlier merges not listed`);

  // One section per project: its active tasks, the framed backlog as a count, and the next 3 framed tasks by id.
  for (const b of shown) {
    L.push("", `**${label(b)}**${b.repo ? ` · ${b.repo.replace("https://", "")}` : ""}`);
    if (b.error) {
      L.push(`- logbook cannot be read: ${b.error}`);
      continue;
    }
    const active = b.tasks.filter((t) => !CLOSED.includes(t.state) && t.state !== "framed").sort((x, y) => n(x.id) - n(y.id));
    const framed = b.tasks.filter((t) => t.state === "framed").sort((x, y) => n(x.id) - n(y.id));
    for (const t of active.slice(0, cap)) L.push(`- ${t.id} ${text(t.title, 40)} · ${t.state} · ${pr(b, t)}${t.round && t.round !== "0" ? ` · round ${t.round}` : ""}`);
    if (active.length > cap) L.push(`- and ${active.length - cap} more (show board for ${b.key})`);
    if (!active.length) L.push("- no active tasks");
    L.push(`- framed backlog: ${framed.length}${framed.length ? ` · next up (framed, in id order): ${framed.slice(0, CAP.next).map((t) => `${t.id} ${text(t.title, 30)}`).join("; ")}` : ""}`);
  }
  const elsewhere = others
    .map((b) => {
      const parts = [b.error ? "logbook cannot be read" : "", gates(b).length ? `${plural(gates(b).length, "gate")} waiting` : "", waiting(b).length ? `${plural(waiting(b).length, "PR")} waiting for your merge` : ""].filter(Boolean);
      return parts.length ? `${label(b)}: ${parts.join(", ")}` : null;
    })
    .filter(Boolean);
  if (elsewhere.length) section("Other projects", elsewhere, elsewhere.length);
  if (save) remember(root, shown, now.toISOString().slice(0, 19) + "Z");
  return L.join("\n");
}
