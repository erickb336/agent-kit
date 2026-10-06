#!/usr/bin/env node
// sage-pr: the one script that pushes a task's reviewed commit and opens, shows or merges its pull request, on the
// chief's behalf, so that agents never push or call gh (T77 section 5, T92 part P4). It runs with full access, so its
// arguments are a closed grammar: exactly `create|view|merge <task id>`, and everything else refuses. The branch and the
// reviewed head come only from the logbook, which only the chief writes: the branch from tasks.tsv, the head from the
// task's latest ledger row. git runs only in the script's own mirror (<logbook>/mirror.git), with sage's neutral options,
// and gh only in an empty temp folder; both through execFile with argument arrays, never a shell.
import { execFileSync } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdtempSync, openSync, readSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BRANCH, git, mergeCheck, projectRoot, read, storeDir, worktreeRoot } from "./sage.mjs";

const BASE = "main";
/** The largest bundle that create reads: 100 MiB, GitHub's limit for one file. A task's bundle (main..branch) is far smaller. */
export const BUNDLE_MAX = 100 * 1024 * 1024;
const VERBS = ["create", "view", "merge"];
const TASK = /^T[1-9][0-9]{0,5}$/i;
/** owner/name of a GitHub repository, from an https, ssh or scp-form origin. */
const GITHUB = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;
const REPO = /^[A-Za-z0-9_][A-Za-z0-9_.-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

class Refusal extends Error {}
const no = (message) => {
  throw new Refusal(`refused: ${message}`);
};
const short = (sha) => sha.slice(0, 7);

/** The arguments: exactly a verb and a task id. A third word, an option or any other form refuses. */
export function parse(argv) {
  if (argv.length !== 2) no(`expected 2 arguments (create, view or merge, and a task id such as T12), got ${argv.length}`);
  const [verb, task] = argv;
  if (!VERBS.includes(verb)) no(`the verb is create, view or merge, not ${JSON.stringify(verb)}`);
  if (!TASK.test(task)) no(`the task id is T and digits, such as T12, not ${JSON.stringify(task)}`);
  return { verb, task: task.toUpperCase() };
}

/** The task's records, from the logbook only: its branch and, for create and merge, its reviewed head; and where to push. */
export function record(task, verb, env = process.env) {
  const project = resolve(env.SAGE_PROJECT ?? process.cwd());
  const dir = storeDir(project, env);
  if (!existsSync(join(dir, "tasks.tsv"))) no(`no logbook for the project ${project}`);
  const t = read(dir, "tasks").find((r) => r.id === task) ?? no(`no task ${task} in ${dir}`);
  const branch = t.branch || no(`${task} has no branch: sage task ${task} set branch=<branch>`);
  if (branch.replace(/^refs\/heads\//i, "").toLowerCase() === BASE) no(`branch "${branch}" is the base branch`);
  if (!BRANCH.test(branch)) no(`branch "${branch}" is not a task branch`);
  if (!new RegExp(`^(?:[A-Za-z0-9_-]+/)?${task}(?:-[A-Za-z0-9._-]+)?$`, "i").test(branch)) no(`branch "${branch}" is outside the task's pattern [<prefix>/]${task.toLowerCase()}[-<words>]`);
  let head;
  if (verb !== "view") {
    head = read(dir, "ledger").filter((r) => r.task === task && r.sha).at(-1)?.sha ?? no(`${task} has no verdict with a SHA, so it has no reviewed head`);
    if (!/^[0-9a-f]{40}$/.test(head)) no(`the reviewed head of ${task} is not a full SHA: ${JSON.stringify(head)}`);
  }
  let url;
  try {
    url = git(["-C", projectRoot(project), "config", "--get", "remote.origin.url"], env).trim();
  } catch {
    no(`the project ${project} has no origin remote`);
  }
  if (!url || url.startsWith("-")) no(`the origin of ${project} is not a repository address: ${JSON.stringify(url)}`);
  const repo = env.SAGE_REPO ?? GITHUB.exec(url)?.[1] ?? no(`the origin ${JSON.stringify(url)} is not a GitHub repository; set SAGE_REPO=<owner>/<name>`);
  if (!REPO.test(repo)) no(`SAGE_REPO is not <owner>/<name>: ${JSON.stringify(repo)}`);
  return { dir, t, branch, head, url, repo };
}

/** git in the mirror, with sage's neutral options. The exit status of a failure is on the error. */
const inMirror = (mirror, args, env) => git(["-C", mirror, ...args], env).trim();

/** The mirror: a bare repository in the logbook folder that only this script writes, with main fetched from the origin now. */
function mirrorOf(dir, url, env) {
  const mirror = join(dir, "mirror.git");
  const st = lstatSync(mirror, { throwIfNoEntry: false });
  if (st && !st.isDirectory()) no(`${mirror} is not a folder`);
  if (!st) git(["init", "-q", "--bare", mirror], env);
  inMirror(mirror, ["fetch", "-q", "--", url, `+refs/heads/${BASE}:refs/heads/${BASE}`], env);
  return mirror;
}

/** Is commit a an ancestor of b in the mirror? An unknown commit is not. */
function ancestor(mirror, a, b, env) {
  try {
    inMirror(mirror, ["merge-base", "--is-ancestor", a, b], env);
    return true;
  } catch (e) {
    if (e.status === 1 || e.status === 128) return false;
    throw e;
  }
}

/**
 * Copies the bundle into the temp folder: it opens once, without following a link, checks the open file (a plain file
 * with one link, at most BUNDLE_MAX bytes) and copies from it, so a change of the path after the check reaches nothing.
 */
export function copyBundle(path, temp) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    if (e.code === "ELOOP") no(`the bundle ${path} is a link, not a plain file`);
    if (e.code === "ENOENT") no(`no bundle at ${path}`);
    throw e;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) no(`the bundle ${path} is not a plain file`);
    if (st.nlink !== 1) no(`the bundle ${path} has ${st.nlink} links, not 1`);
    if (st.size > BUNDLE_MAX) no(`the bundle ${path} is over ${BUNDLE_MAX} bytes`);
    const copy = join(temp, "task.bundle");
    const out = openSync(copy, "wx", 0o600);
    try {
      const buf = Buffer.alloc(1024 * 1024);
      for (let n = 0, r; (r = readSync(fd, buf, 0, buf.length, null)) > 0; ) {
        if ((n += r) > BUNDLE_MAX) no(`the bundle ${path} is over ${BUNDLE_MAX} bytes`); // it grew after the check
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

/** gh in a new empty folder that is not a repository, so it reads no git config; with --repo, never a prompt. */
function gh(args, temp, env) {
  try {
    return execFileSync("gh", args, { cwd: mkdtempSync(join(temp, "gh-")), encoding: "utf8", env: { ...env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" }, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    no(`gh ${args.slice(0, 2).join(" ")} failed: ${String(e.stderr ?? e.message).trim()}`);
  }
}

/**
 * create: pushes the reviewed head to the task's branch, fast-forward only, and opens a pull request when none is open.
 * A second create after a repair pushes the new reviewed head and opens nothing new.
 */
function create({ dir, t, branch, head, url, repo }, temp, env) {
  const bundle = copyBundle(join(worktreeRoot(env), basename(dir), `${t.id}.bundle`), temp);
  const mirror = mirrorOf(dir, url, env);
  const ref = `refs/sage/${t.id}`;
  try {
    inMirror(mirror, ["-c", "transfer.fsckObjects=true", "fetch", "-q", "--", bundle, `+refs/heads/${branch}:${ref}`], env);
  } catch {
    no(`the bundle is not a git bundle of the branch ${branch} that fits main (git bundle create <file> main..${branch})`);
  }
  const tip = inMirror(mirror, ["rev-parse", "--verify", `${ref}^{commit}`], env);
  if (tip !== head) no(`the bundle tip ${short(tip)} is not the reviewed head ${short(head)}`);
  if (ancestor(mirror, head, `refs/heads/${BASE}`, env)) no(`the head ${short(head)} is already on ${BASE}`);
  const line = inMirror(mirror, ["ls-remote", "--", url, `refs/heads/${branch}`], env).split("\n").find((l) => l.endsWith(`\trefs/heads/${branch}`));
  const remote = line?.split("\t")[0];
  let pushed = `${branch} is already at ${short(head)}`;
  if (remote !== head) {
    if (remote && !ancestor(mirror, remote, head, env)) no(`the remote ${branch} is at ${short(remote)}, and ${short(head)} does not follow from it: a push would not be a fast-forward`);
    inMirror(mirror, ["push", "-q", "--", url, `${head}:refs/heads/${branch}`], env);
    pushed = `pushed ${short(head)} to ${branch}`;
  }
  const open = JSON.parse(gh(["pr", "list", `--repo=${repo}`, `--head=${branch}`, "--state=open", "--json=number,url"], temp, env) || "[]");
  if (open.length) return `${pushed}; pull request ${open.map((p) => `#${p.number} ${p.url}`).join(", ")} is open`;
  const body = join(temp, "body.md");
  writeFileSync(body, `${t.id}: ${t.title}\n\nReviewed head: ${head}\n`);
  return `${pushed}; opened ${gh(["pr", "create", `--repo=${repo}`, `--base=${BASE}`, `--head=${branch}`, `--title=${t.id}: ${t.title}`, `--body-file=${body}`], temp, env)}`;
}

/** merge: after the merge check passes on the reviewed head, merges only that head, then fetches the new main into the mirror. */
function merge({ dir, t, branch, head, url, repo }, temp, env) {
  const r = mergeCheck(head, env, { pr: t.pr || undefined });
  if (!r.ok) no(`merge check: ${r.reason}`);
  const out = gh(["pr", "merge", `--repo=${repo}`, "--squash", "--delete-branch", `--match-head-commit=${head}`, "--", branch], temp, env);
  const main = inMirror(mirrorOf(dir, url, env), ["rev-parse", `refs/heads/${BASE}`], env);
  return `merged ${branch} at ${short(head)}${out ? `: ${out}` : ""}; the mirror's ${BASE} is now ${short(main)}`;
}

/** Runs one call. A refusal throws, with its reason. */
export function sagePr(argv, env = process.env) {
  const { verb, task } = parse(argv);
  const rec = record(task, verb, env);
  const temp = mkdtempSync(join(tmpdir(), "sage-pr-"));
  try {
    if (verb === "view") return gh(["pr", "view", `--repo=${rec.repo}`, "--json=number,state,headRefOid,url", "--", rec.branch], temp, env);
    return verb === "create" ? create(rec, temp, env) : merge(rec, temp, env);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    console.log(sagePr(process.argv.slice(2)));
  } catch (e) {
    console.error(`sage-pr: ${e instanceof Refusal ? e.message : `failed: ${e.message}`}`);
    process.exit(e instanceof Refusal ? 1 : 2);
  }
}
