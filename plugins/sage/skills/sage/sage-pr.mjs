#!/usr/bin/env node
// sage-pr: the one script that pushes a task's reviewed commit and opens, shows or merges its pull request, on the
// chief's behalf, so that agents never push or call gh (T77 section 5, T92 part P4). It runs with full access, so its
// arguments are a closed grammar: exactly `create|view|merge <task id>`, and everything else refuses. The branch and the
// reviewed head come only from the logbook, which only the chief writes: the branch from tasks.tsv, the head from the
// task's latest ledger row. The project must be the logbook's own checkout (checkout.txt), outside the worktree root,
// and its origin a GitHub repository. git runs only in the script's own mirror (<logbook>/mirror.git), with sage's
// neutral options, and gh only in an empty folder; both through execFile with argument arrays, never a shell. The whole
// run holds the logbook's lock, so two calls on one project never share the mirror. The script writes, reads and
// runs nothing in a folder that an agent can write (its worktree, the temp folder), except that it reads the bundle once
// without a link: its own files are in a new folder in the logbook folder. git and gh get only the allow-listed variables
// of the chief's environment (KEEP), and the script refuses NODE_OPTIONS, which it cannot undo. No message prints a
// URL's user or password, an Authorization header, a gh token's value, the origin or SAGE_REPO, nor the argument list of
// a failed git call. Exit codes: 0 done (also "already merged", when GitHub merged the reviewed head), 1 refused (the
// script's own checks), 2 failed (git or gh failed, or the logbook stayed busy), 3 merged but the mirror refresh failed
// (run merge again later). A folder that the script cannot remove at the end gives a warning, never another exit code.
import { execFileSync } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, realpathSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { PR, git, mergeCheck, ofTask, projectRoot, read, sage, storeDir, withLock, worktreeRoot } from "./sage.mjs";

const BASE = "main";
/** The largest bundle that create reads: 100 MiB, GitHub's limit for one file. A task's bundle (main..branch) is far smaller. */
export const BUNDLE_MAX = 100 * 1024 * 1024;
const VERBS = ["create", "view", "merge"];
const TASK = /^T[1-9][0-9]{0,5}$/;
/** owner/name of a GitHub repository, from an https (also with a user or token), ssh or scp-form origin. */
const GITHUB = /^(?:https:\/\/(?:[^/@\s]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;

/** The variables that hold a gh token: their values never print. Read once at the start, before the environment is cleaned. */
const SECRETS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"].map((v) => process.env[v]).filter(Boolean);

/**
 * The only variables of the chief's environment that the script, git and gh keep. Every other one drops, because it can
 * change where git pushes or what git and gh run: GIT_CONFIG_COUNT/KEY/VALUE, GIT_CONFIG_PARAMETERS, GIT_SSH_COMMAND,
 * GIT_DIR, GH_HOST, GH_REPO, HTTPS_PROXY, GH_ENTERPRISE_TOKEN, and others.
 * - PATH: finds git, gh and ssh.
 * - HOME: gh's login (~/.config/gh) and ssh's keys and known hosts.
 * - LANG, LC_*: the language and the character set of the messages.
 * - GH_TOKEN, GITHUB_TOKEN: gh's login when the chief gives it as a variable (gh reads them for github.com only).
 * - GH_CONFIG_DIR: gh's login folder when the chief moved it.
 * - SSH_AUTH_SOCK: the ssh agent, for an ssh origin.
 * - SAGE_* and CLAUDE_CONFIG_DIR: the state tool's own variables (the logbook, the worktree root); git and gh ignore them.
 * - NODE_TEST_CONTEXT and TMPDIR: in a node test run, the logbook lock takes its liveness probe from SAGE_TEST_PIDS for a
 *   logbook in the temp folder, so that a held lock in a test never probes a real pid. git and gh get the script's own
 *   folder as TMPDIR.
 */
const KEEP = /^(?:PATH|HOME|LANG|LC_[A-Z]+|GH_TOKEN|GITHUB_TOKEN|GH_CONFIG_DIR|SSH_AUTH_SOCK|SAGE_[A-Z_]+|CLAUDE_CONFIG_DIR|NODE_TEST_CONTEXT|TMPDIR)$/;
/**
 * git's settings over every config file: no credential helper from a config file (an empty value clears the list), and
 * for github.com the helper that gh's own login gives (`gh auth setup-git` writes the same).
 */
const SETTINGS = [
  ["credential.helper", ""],
  ["credential.https://github.com.helper", "!gh auth git-credential"],
];
/**
 * The script's environment: the KEEP variables of env, no system or global git config (the global config can redirect
 * a push or run a helper), and SETTINGS. The variables of SETTINGS replace any of the chief's.
 */
export function clean(env) {
  const settings = SETTINGS.flatMap(([key, value], i) => [[`GIT_CONFIG_KEY_${i}`, key], [`GIT_CONFIG_VALUE_${i}`, value]]);
  return { ...Object.fromEntries(Object.entries(env).filter(([k]) => KEEP.test(k))), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_COUNT: String(SETTINGS.length), ...Object.fromEntries(settings) };
}
/**
 * Removes credentials from text that the script does not write, such as gh's error messages (messages never print the
 * origin or SAGE_REPO): the value of each token variable as ***; the rest of an Authorization line as ***, also in a quoted
 * or key=value form; and everything before the last '@' of a word as ***@, after a URL's scheme (with or without a path)
 * and in the scp form user:pass@host:path, so that no punctuation in a user or password ends the match early.
 */
const redact = (text) =>
  SECRETS.reduce((t, value) => t.split(value).join("***"), String(text))
    .replace(/(authorization["']?\s*[:=]).*/gi, "$1 ***")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)\S*@|\S*@(?=[^\s@]*[:/])/gi, (_, scheme = "") => `${scheme}***@`);
class Refusal extends Error {}
/** The merge happened, and only the mirror's refresh after it failed: exit 3, so the chief does not merge again. */
class Merged extends Error {}
const no = (message) => {
  throw new Refusal(redact(`refused: ${message}`));
};
const short = (sha) => String(sha).slice(0, 7);
/** The real path of a folder, or the path itself when it does not exist. */
const real = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

/** The arguments: exactly a verb and a task id. A third word, an option or any other form refuses. */
export function parse(argv) {
  if (argv.length !== 2) no(`expected 2 arguments (create, view or merge, and a task id such as T12), got ${argv.length}`);
  const [verb, task] = argv;
  if (!VERBS.includes(verb)) no(`the verb is create, view or merge, not ${JSON.stringify(verb)}`);
  if (!TASK.test(task)) no(`the task id is T and digits, such as T12, not ${JSON.stringify(task)}`);
  return { verb, task };
}

/** The task's records, from the logbook only: its branch and, for create and merge, its reviewed head; and where to push. */
export function record(task, verb, env = process.env) {
  const project = resolve(env.SAGE_PROJECT ?? process.cwd());
  const root = projectRoot(project);
  const trees = real(worktreeRoot(env));
  if (`${real(root)}${sep}`.startsWith(`${trees}${sep}`)) no(`the project ${project} is in the worktree root ${trees}, where agents write: run sage-pr from the project's main checkout, or set SAGE_PROJECT=<that folder>`);
  const dir = storeDir(project, env);
  if (!existsSync(join(dir, "tasks.tsv"))) no(`no logbook for the project ${project}: run sage-pr from the project's main checkout, or set SAGE_PROJECT=<that folder>`);
  // The logbook's key is short, so another folder can have the same one: the logbook must name this folder as its checkout.
  let named;
  try {
    named = readFileSync(join(dir, "checkout.txt"), "utf8").trim();
  } catch {}
  if (named === undefined) no(`the logbook ${dir} does not name its project's main checkout: run sage init --project <main checkout> once, from the main checkout`);
  if (named !== root) no(`the logbook ${dir} is the logbook of ${named}, not of ${root}: run sage-pr from ${named}, or set SAGE_PROJECT=${named}`);
  const t = read(dir, "tasks").find((r) => r.id === task) ?? no(`no task ${task} in ${dir}: check the task id, or frame the task first (sage task add)`);
  const branch = t.branch || no(`${task} has no branch: sage task ${task} set branch=<branch>`);
  if (!ofTask(task, branch)) no(`branch "${branch}" is not a branch of ${task} ([<prefix>/]${task.toLowerCase()}[-<words>]): sage task ${task} set branch=claude/${task.toLowerCase()}`);
  let head;
  if (verb !== "view") {
    head = read(dir, "ledger").filter((r) => r.task === task && r.sha).at(-1)?.sha ?? no(`${task} has no verdict with a SHA, so it has no reviewed head: record the route's verdicts on the reviewed head (sage verdict ${task} --sha <sha> --kind <kind>)`);
    if (!/^[0-9a-f]{40}$/.test(head)) no(`the reviewed head of ${task} is not a full SHA: ${JSON.stringify(head)}. Record the verdict with the full SHA: sage verdict ${task} --sha <40-character sha> --kind <kind>`);
  }
  let url;
  try {
    url = git(["-C", root, "config", "--get", "remote.origin.url"], env).trim();
  } catch {
    no(`the project ${project} has no origin remote: git -C ${project} remote add origin <address>`);
  }
  if (!url || url.startsWith("-")) no(`the origin of ${project} is not a repository address: git -C ${project} remote set-url origin <address>`);
  // owner/name only: the pattern takes no user, password or host
  const repo = GITHUB.exec(url)?.[1] ?? no(`the origin of ${project} is not a GitHub repository, and sage-pr pushes only to GitHub: git -C ${root} remote set-url origin https://github.com/<owner>/<name>.git`);
  if (env.SAGE_REPO !== undefined && env.SAGE_REPO.toLowerCase() !== repo.toLowerCase()) no(`SAGE_REPO is not the origin's repository ${repo}, so gh and git would act on two repositories. Unset SAGE_REPO, or set it to ${repo}`);
  return { project, dir, t, branch, head, url, repo };
}

/**
 * git with sage's neutral options. A failure names only the git command and its exit status, which stays on the error:
 * git's own message holds the argument list, and so the origin URL.
 */
function run(args, env) {
  try {
    return git(args, env).trim();
  } catch (e) {
    const command = args.find((a, i) => !a.startsWith("-") && !["-C", "-c"].includes(args[i - 1]));
    throw Object.assign(new Error(`git ${command} failed with exit ${e.status ?? e.code}`), { status: e.status });
  }
}
/** git in the mirror. */
const inMirror = (mirror, args, env) => run(["-C", mirror, ...args], env);

/** The mirror: a bare repository in the logbook folder that only this script writes, with main fetched from the origin now. */
function mirrorOf(dir, url, env) {
  const mirror = join(dir, "mirror.git");
  const st = lstatSync(mirror, { throwIfNoEntry: false });
  if (st && !st.isDirectory()) no(`${mirror} is not a folder: ask the user to remove it`);
  if (!st) run(["init", "-q", "--bare", mirror], env);
  rmSync(join(mirror, "FETCH_HEAD"), { force: true }); // an older script's, with the origin's address in it
  inMirror(mirror, ["fetch", "-q", "--no-tags", "--no-write-fetch-head", "--", url, `+refs/heads/${BASE}:refs/heads/${BASE}`], env);
  return mirror;
}

/** Is commit a an ancestor of b in the mirror? An unknown commit is not. Any other error of git (a disk error) is a failure. */
function ancestor(mirror, a, b, env) {
  try {
    inMirror(mirror, ["rev-parse", "-q", "--verify", `${a}^{commit}`], env);
    inMirror(mirror, ["merge-base", "--is-ancestor", a, b], env);
    return true;
  } catch (e) {
    if (e.status === 1) return false;
    throw e;
  }
}

/**
 * Copies the bundle into the script's folder: it opens once, without following a link, checks the open file (a plain
 * file with one link, at most BUNDLE_MAX bytes, that starts with a bundle's first line) and copies from it, so a change
 * of the path after the check reaches nothing. The first line keeps out a file that git reads otherwise, such as
 * "gitdir: <repository>". The bundle's folder must be a folder in the worktree root `root`, not a link to another place:
 * the script goes into the folder, checks where it is, and opens the bundle relative to it (node has no openat), so a
 * swap of the folder's path after the check reaches nothing.
 */
export function copyBundle(path, temp, branch, root) {
  const make = `git bundle create ${path} ${BASE}..${branch}`;
  const remake = `: remove it, then write it with ${make}`;
  const back = process.cwd();
  let fd;
  try {
    process.chdir(dirname(path));
    const parent = realpathSync(".");
    if (parent !== join(realpathSync(root), basename(dirname(path)))) no(`the bundle's folder ${dirname(path)} is a link to ${parent}, not a folder in the worktree root: remove the link, then write the bundle with ${make}`);
    fd = openSync(basename(path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    if (e.code === "ELOOP") no(`the bundle ${path} is a link, not a plain file${remake}`);
    if (e.code === "ENOENT") no(`no bundle at ${path}: write it with ${make}`);
    throw e;
  } finally {
    process.chdir(back);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) no(`the bundle ${path} is not a plain file${remake}`);
    if (!st.size) no(`the bundle ${path} is empty. Write it with ${make}`);
    if (st.nlink !== 1) no(`the bundle ${path} has ${st.nlink} links, not 1${remake}`);
    if (st.size > BUNDLE_MAX) no(`the bundle ${path} is over ${BUNDLE_MAX} bytes: the bundle is too big, ask the user`);
    const copy = join(temp, "task.bundle");
    const out = openSync(copy, "wx", 0o600); // O_CREAT|O_EXCL: never through a link or into an old file
    try {
      const buf = Buffer.alloc(1024 * 1024);
      for (let n = 0, r; (r = readSync(fd, buf, 0, buf.length, null)) > 0; ) {
        if (!n && !/^# v[23] git bundle\n/.test(buf.toString("latin1", 0, Math.min(r, 16)))) no(`the bundle ${path} is not a git bundle: it does not start with "# v2 git bundle" or "# v3 git bundle". Write it with ${make}`);
        if ((n += r) > BUNDLE_MAX) no(`the bundle ${path} is over ${BUNDLE_MAX} bytes: the bundle is too big, ask the user`); // it grew after the check
        writeSync(out, buf, 0, r);
      }
    } finally {
      closeSync(out);
    }
    return copy;
  } finally {
    closeSync(fd);
  }
}

/**
 * gh in a new empty folder in the script's folder, with --repo and never a prompt. GIT_DIR names no repository, and
 * GIT_CEILING_DIRECTORIES stops a search above the script's folder, so the git calls of gh find no repository and read
 * no repository's config. A failed gh call (network, GitHub, login, a refused merge) is a failure, exit 2, not a
 * refusal: the script did not refuse it.
 */
function gh(args, temp, env) {
  try {
    const repoless = { ...env, GIT_DIR: "/nonexistent", GIT_CEILING_DIRECTORIES: temp, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" };
    return execFileSync("gh", args, { cwd: mkdtempSync(join(temp, "gh-")), encoding: "utf8", env: repoless, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${String(e.stderr || e.message).trim()}`);
  }
}

/** A merged pull request of the task is done only when GitHub merged the reviewed head; any other head refuses. */
const sameHead = (p, head) => p.headRefOid === head || no(`pull request #${p.number} merged ${short(p.headRefOid)}, not the reviewed head ${short(head)}: ask the user`);

/**
 * The pull requests of the branch into main in the repository itself, in every state, newest first: a fork's pull request
 * with the same branch name is not the task's. GitHub keeps at most one of them open (it refuses a second with 422).
 */
function mine(repo, branch, temp, env) {
  const owner = repo.split("/")[0].toLowerCase();
  const all = JSON.parse(gh(["pr", "list", `--repo=${repo}`, `--head=${branch}`, `--base=${BASE}`, "--state=all", "--json=number,url,state,headRefOid,isCrossRepository,headRepositoryOwner"], temp, env) || "[]");
  return all.filter((p) => p.isCrossRepository === false && p.headRepositoryOwner?.login?.toLowerCase() === owner);
}


/**
 * create: pushes the reviewed head to the task's branch, fast-forward only, and opens a pull request when none is open.
 * A second create after a repair pushes the new reviewed head and opens nothing new. It returns the number of the open
 * pull request, which the logbook gets after the lock (remember), so that merge knows which pull request to merge. A
 * task with a merged pull request of its branch has nothing to create: after a squash merge the head is not on main, so
 * only GitHub tells. A recorded number that is not a pull request of the branch counts as none.
 */
function create({ dir, t, branch, head, url, repo }, temp, env) {
  const path = join(worktreeRoot(env), basename(dir), `${t.id}.bundle`);
  const bundle = copyBundle(path, temp, branch, worktreeRoot(env));
  const prs = mine(repo, branch, temp, env);
  const merged = prs.filter((p) => p.state === "MERGED");
  if (merged.length) {
    const done = merged.find((p) => p.headRefOid === head) ?? sameHead(merged[0], head); // sameHead refuses here
    no(`already merged as PR #${done.number}: nothing to create. Mark the task merged: sage task ${t.id} set state=merged`);
  }
  const mirror = mirrorOf(dir, url, env);
  const ref = `refs/sage/${t.id}`;
  const bad = `the bundle is not a git bundle of the branch ${branch} that fits main (git bundle create <file> main..${branch})`;
  let heads;
  try {
    inMirror(mirror, ["bundle", "verify", "-q", bundle], env);
    heads = inMirror(mirror, ["bundle", "list-heads", bundle, `refs/heads/${branch}`], env);
  } catch {
    no(bad);
  }
  if (!heads.split("\n").some((l) => l.endsWith(` refs/heads/${branch}`))) no(bad);
  inMirror(mirror, ["-c", "transfer.fsckObjects=true", "fetch", "-q", "--no-tags", "--no-write-fetch-head", "--", bundle, `+refs/heads/${branch}:${ref}`], env); // a lock or disk error: failed
  const tip = inMirror(mirror, ["rev-parse", "--verify", `${ref}^{commit}`], env);
  if (tip !== head) no(`the bundle tip ${short(tip)} is not the reviewed head ${short(head)}. Review ${short(tip)} and record its verdicts, or write the bundle with ${branch} at ${short(head)}: git bundle create ${path} main..${branch}`);
  if (ancestor(mirror, head, `refs/heads/${BASE}`, env)) no(`the head ${short(head)} is already on ${BASE}: the task's work is on ${BASE}, so mark the task merged: sage task ${t.id} set state=merged`);
  const line = inMirror(mirror, ["ls-remote", "--", url, `refs/heads/${branch}`], env).split("\n").find((l) => l.endsWith(`\trefs/heads/${branch}`));
  const remote = line?.split("\t")[0];
  let pushed = `${branch} is already at ${short(head)}`;
  if (remote !== head) {
    if (remote && !ancestor(mirror, remote, head, env)) no(`the remote ${branch} is at ${short(remote)}, and ${short(head)} does not follow from it: a push would not be a fast-forward. The remote branch moved: review its tip, or ask the user`);
    inMirror(mirror, ["-c", "push.followTags=false", "push", "-q", "--", url, `${head}:refs/heads/${branch}`], env); // a tag can start a release
    pushed = `pushed ${short(head)} to ${branch}`;
  }
  const open = prs.find((p) => p.state === "OPEN");
  if (open) return { out: `${pushed}; pull request #${open.number} ${open.url} is open`, number: String(open.number) };
  const body = join(temp, "body.md");
  writeFileSync(body, `${t.id}: ${t.title}\n\nReviewed head: ${head}\n`, { flag: "wx", mode: 0o600 });
  const made = gh(["pr", "create", `--repo=${repo}`, `--base=${BASE}`, `--head=${branch}`, `--title=${t.id}: ${t.title}`, `--body-file=${body}`], temp, env);
  const out = `${pushed}; opened ${made}`;
  const number = /\/pull\/([1-9][0-9]*)$/.exec(made)?.[1];
  if (!number) throw new Error(`${out}, but its number is not in gh's answer, so the logbook has no PR number: sage task ${t.id} set pr=<n>`);
  return { out, number };
}

/** Records the open pull request's number in the logbook, when it has none or another, through the state tool (which takes the lock itself). */
function remember({ project, t }, { out, number }, env) {
  if (t.pr === number) return out;
  try {
    sage(["task", t.id, "set", `pr=${number}`, "--project", project], env);
  } catch (e) {
    throw new Error(`${out}, but the logbook did not take PR ${number} (${e.message}). Run sage-pr create ${t.id} again`);
  }
  return `${out}; ${t.id} has PR ${number} in the logbook${t.pr ? `, not PR ${t.pr}` : ""}`;
}

/**
 * merge: merges the task's pull request (its PR number in the logbook) only when it is the open pull request of the
 * task's branch into main in the repository itself, at the reviewed head, the task is verified, and the merge check
 * passes on the reviewed head with that PR. Then it reads the pull request again: only MERGED at the reviewed head is a
 * merge (a merge queue can leave it open; a failure after the merge, such as the branch deletion, still merged it), and
 * it fetches the new main into the mirror. When that pull request is already merged with the reviewed head (a merge
 * before, whose mirror refresh failed), there is nothing to merge: it only refreshes the mirror. A merge of another head
 * (a web merge, or a merge before a repair) refuses.
 */
function merge({ dir, t, branch, head, url, repo }, temp, env) {
  const pr = t.pr || no(`${t.id} has no PR number in the logbook: run sage-pr create ${t.id}, which records it`);
  if (!PR.test(pr)) no(`the PR of ${t.id} in the logbook is not a pull request number: sage task ${t.id} set pr=<n>`);
  const find = () => mine(repo, branch, temp, env).find((p) => String(p.number) === pr);
  const p = find() ?? no(`pull request #${pr} is not a pull request of ${branch} into ${BASE} in ${repo} (GitHub has no such pull request, or it is another branch's or a fork's): run sage-pr create ${t.id}, which records the task's own, or sage task ${t.id} set pr=<n>`);
  const refresh = (done) => {
    try {
      return `${done}; the mirror's ${BASE} is now ${short(inMirror(mirrorOf(dir, url, env), ["rev-parse", `refs/heads/${BASE}`], env))}`;
    } catch (e) {
      throw new Merged(`${done}; the mirror refresh failed: ${e.message.replace(/^refused: /, "")}. Run sage-pr merge ${t.id} again later: it reports "already merged" and refreshes the mirror`);
    }
  };
  if (p.state === "MERGED" && sameHead(p, head)) return refresh(`already merged: ${branch} at ${short(head)}; nothing to do`);
  if (p.state !== "OPEN") no(`pull request #${pr} of ${branch} is ${p.state}, not open: reopen it on GitHub, or run sage-pr create ${t.id} to open a new one`);
  if (t.state !== "verified") no(`${t.id} is ${t.state || "in no state"}, not verified: merge only a task whose route is done. When it is: sage task ${t.id} set state=verified`);
  if (p.headRefOid !== head) no(`pull request #${pr} is at ${short(p.headRefOid)}, not at the reviewed head ${short(head)}. If ${short(head)} is a repair, push it first: sage-pr create ${t.id}. Else the branch moved after review: review ${short(p.headRefOid)} and record its verdicts`);
  const r = mergeCheck(head, env, { pr });
  if (!r.ok) no(`merge check: ${r.reason}`);
  const moved = ". If GitHub says that the head changed, the branch moved after review: review the new head and record its verdicts";
  let out, failed;
  try {
    out = gh(["pr", "merge", `--repo=${repo}`, "--squash", "--delete-branch", `--match-head-commit=${head}`, "--", pr], temp, env);
  } catch (e) {
    failed = e;
  }
  let after;
  try {
    after = find();
  } catch (e) {
    throw failed ? new Error(`${failed.message}${moved}`) : new Error(`gh pr merge ran, but the pull request could not be read again (${e.message}): run sage-pr merge ${t.id} again`);
  }
  if (after?.state === "MERGED" && after.headRefOid === head) return refresh(`merged ${branch} at ${short(head)}${out ? `: ${out}` : ""}${failed ? ` (GitHub merged it, but ${failed.message})` : ""}`);
  if (failed) throw new Error(`${failed.message}${moved}`);
  throw new Error(`gh pr merge ran, but pull request #${pr} is ${after?.state ?? "gone"} at ${short(after?.headRefOid ?? "")}, not merged at ${short(head)}: GitHub may have queued it (a merge queue or auto-merge). Run sage-pr merge ${t.id} again later: it reports "already merged" once GitHub has merged it`);
}

/** Removes a folder of the script. A failure only warns: it never changes the exit code. */
function remove(path) {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (e) {
    console.error(`sage-pr: warning: could not remove ${path} (${e.code ?? e.message}): remove it by hand`);
  }
}

/**
 * Runs one call. A refusal throws, with its reason. The whole call holds the logbook's lock, so no other call uses the
 * mirror or the script's folders at the same time; so each .sage-pr-* folder that is there at the start is a stale one.
 * The script's own folder is new in the logbook folder, which agents cannot write, and git and gh use it as their temp
 * folder too; it goes at the end (rmSync removes a link, not its target). create records the PR number after the lock,
 * because the state tool takes the same lock.
 */
export function sagePr(argv, env = process.env) {
  const { verb, task } = parse(argv);
  const rec = record(task, verb, env);
  const done = withLock(rec.dir, () => {
    for (const name of readdirSync(rec.dir).filter((n) => n.startsWith(".sage-pr-"))) remove(join(rec.dir, name));
    const temp = mkdtempSync(join(rec.dir, ".sage-pr-"));
    const tools = { ...env, TMPDIR: temp };
    try {
      if (verb === "view") return gh(["pr", "view", `--repo=${rec.repo}`, "--json=number,state,headRefOid,url", "--", rec.branch], temp, tools);
      return verb === "create" ? create(rec, temp, tools) : merge(rec, temp, tools);
    } finally {
      remove(temp);
    }
  });
  return verb === "create" ? remember(rec, done, env) : done;
}

/**
 * The script's whole process gets the clean environment, so that also the state tool's own git calls (which read
 * process.env) see only it. NODE_OPTIONS ran its code before the script started, so the script can only refuse it.
 */
function start() {
  if (process.env.NODE_OPTIONS !== undefined) no("NODE_OPTIONS is set, and it can run code inside the script. Run sage-pr without it: env -u NODE_OPTIONS node sage-pr.mjs <verb> <task>");
  const env = clean(process.env);
  for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
  Object.assign(process.env, env);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    start();
    console.log(redact(sagePr(process.argv.slice(2))));
  } catch (e) {
    const code = e instanceof Refusal ? 1 : e instanceof Merged ? 3 : 2;
    console.error(`sage-pr: ${redact(code === 2 ? `failed: ${e.message}` : e.message)}`);
    process.exit(code);
  }
}
