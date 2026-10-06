#!/usr/bin/env node
// sage-pr: the one script that pushes a task's reviewed commit and opens, shows or merges its pull request, on the
// chief's behalf, so that agents never push or call gh (T77 section 5, T92 part P4). Before the reviews, `import` copies the
// agent's bundle into the mirror and writes a review copy that agents cannot write; create and merge then refuse a head
// whose review copy is not older than its first verdict, so every verdict is on the objects that create pushes (G79).
// It runs with full access, so its arguments are a closed grammar: exactly `import|create|view|merge <task id>`, and
// everything else refuses. The branch and the
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
// script's own checks, and git's own result that a mirror or a bundle is not one), 2 failed (git or gh failed or took too
// long, or the logbook stayed busy), 3 merged but the mirror refresh failed
// (run merge again later). A folder that the script cannot remove at the end gives a warning, never another exit code.
import { execFileSync } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { PR, mergeCheck, ofTask, projectRoot, read, sage, storeDir, withLock, worktreeRoot } from "./sage.mjs";

const BASE = "main";
/**
 * The largest bundle that import and create read: 10 MiB. A task's bundle (main..branch) holds only the task's new objects,
 * compressed: sage's whole history is about 0.5 MiB. zlib packs about 1000:1, so a bundle can expand to 1000 times its
 * size in the mirror and in the review copy; 10 MiB keeps that to about 10 GiB, and TIMEOUT stops it earlier.
 */
export const BUNDLE_MAX = 10 * 1024 * 1024;
/**
 * The seconds that one git call on the bundle's objects may take (verify, fetch, merge-base, archive, diff) and tar: then
 * it stops, exit 2, and the lock is free again. SAGE_PR_TIMEOUT (1 to 9999) replaces it, for a test or a slow disk.
 * Calls to the origin have no limit: the first fetch of a large repository can take minutes.
 */
const TIMEOUT = 120;
const VERBS = ["import", "create", "view", "merge"];
const TASK = /^T[1-9][0-9]{0,5}$/;
/**
 * owner and name of a GitHub repository, from an origin in exactly one of three forms, each with an optional .git and /:
 * https://github.com/<owner>/<name>, ssh://git@github.com/<owner>/<name> and git@github.com:<owner>/<name>. The whole
 * address must match, so a user or token, a port, a query, a fragment, another host and an upper-case host refuse: a '#'
 * or '?' in a user part puts another host in front of github.com (https://evil.example#@github.com/o/r).
 */
const GITHUB = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;
/** owner/name of a GitHub origin, or undefined. A part of only dots is no name: git would read it as a parent folder. */
const repoOf = (url) => {
  const m = GITHUB.exec(url);
  return m && !/^\.+$/.test(m[1]) && !/^\.+$/.test(m[2]) ? `${m[1]}/${m[2]}` : undefined;
};

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
  if (argv.length !== 2) no(`expected 2 arguments (import, create, view or merge, and a task id such as T12), got ${argv.length}`);
  const [verb, task] = argv;
  if (!VERBS.includes(verb)) no(`the verb is import, create, view or merge, not ${JSON.stringify(verb)}`);
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
  if (verb === "create" || verb === "merge") {
    head = read(dir, "ledger").filter((r) => r.task === task && r.sha).at(-1)?.sha ?? no(`${task} has no verdict with a SHA, so it has no reviewed head: record the route's verdicts on the reviewed head (sage verdict ${task} --sha <sha> --kind <kind>)`);
    if (!/^[0-9a-f]{40}$/.test(head)) no(`the reviewed head of ${task} is not a full SHA: ${JSON.stringify(head)}. Record the verdict with the full SHA: sage verdict ${task} --sha <40-character sha> --kind <kind>`);
  }
  let url;
  try {
    url = run(["-C", root, "config", "--get", "remote.origin.url"], env);
  } catch {
    no(`the project ${project} has no origin remote: git -C ${project} remote add origin <address>`);
  }
  if (!url || url.startsWith("-")) no(`the origin of ${project} is not a repository address: git -C ${project} remote set-url origin <address>`);
  const repo = repoOf(url) ?? no(`the origin of ${project} is not a GitHub repository, and sage-pr pushes only to GitHub: git -C ${root} remote set-url origin https://github.com/<owner>/<name>.git`);
  if (env.SAGE_REPO !== undefined && env.SAGE_REPO.toLowerCase() !== repo.toLowerCase()) no(`SAGE_REPO is not the origin's repository ${repo}, so gh and git would act on two repositories. Unset SAGE_REPO, or set it to ${repo}`);
  return { project, dir, t, branch, head, url, repo };
}

/** The seconds of TIMEOUT, or of SAGE_PR_TIMEOUT when it is 1 to 9999. */
const limitOf = (env) => (/^[1-9][0-9]{0,3}$/.test(env.SAGE_PR_TIMEOUT ?? "") ? Number(env.SAGE_PR_TIMEOUT) : TIMEOUT);
/**
 * One program (git or tar) through execFile, stopped after limitOf seconds when timed. A failure names only the program,
 * its command and its exit status; the status and git's stderr stay on the error for the callers that read git's own
 * result, but never print: git's own message holds the argument list, and so the origin URL.
 */
function runFile(program, args, env, timed) {
  const limit = timed ? limitOf(env) : 0;
  try {
    return execFileSync(program, args, { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"], timeout: limit * 1000, killSignal: "SIGKILL" }).trim();
  } catch (e) {
    const command = args.find((a, i) => !a.startsWith("-") && !["-C", "-c"].includes(args[i - 1])) ?? args[0];
    if (e.code === "ETIMEDOUT") throw new Error(`${program} ${command} took over ${limit} s and was stopped: run it again. If it stops again, the bundle holds too much data: ask the user`);
    throw Object.assign(new Error(`${program} ${command} failed with exit ${e.status ?? e.code}: run sage-pr again`), { status: e.status, stderr: String(e.stderr ?? "") });
  }
}
/**
 * git with the neutral options of the state tool's git() (sage.mjs): no fsmonitor, no hooks, no system config, only local,
 * https and ssh transports, never a prompt. It is its own call here, because the script needs git's stderr and a time limit.
 */
const run = (args, env, timed = false) =>
  runFile("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args], { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_ALLOW_PROTOCOL: "file:https:ssh", GIT_TERMINAL_PROMPT: "0" }, timed);
/** git in the mirror, named with --git-dir: git then never looks for a repository in a folder above it. */
const inMirror = (mirror, args, env, timed) => run([`--git-dir=${mirror}`, ...args], env, timed);

/**
 * The mirror: a bare repository in the logbook folder that only this script writes, with main fetched from the origin now.
 * A new mirror is made in the script's folder and then moved in whole, so a stopped call leaves no half-made mirror (the
 * next call removes the script's old folders). Anything else at the mirror's path (a file, a link, an empty or other
 * folder, a repository that is not bare) refuses: it is the user's to remove, and the script removes no data it did not make.
 */
function mirrorOf(dir, url, temp, env) {
  const mirror = join(dir, "mirror.git");
  const st = lstatSync(mirror, { throwIfNoEntry: false });
  if (!st) {
    run(["init", "-q", "--bare", join(temp, "mirror.git")], env);
    renameSync(join(temp, "mirror.git"), mirror);
  } else {
    let bare = false;
    try {
      bare = st.isDirectory() && inMirror(mirror, ["rev-parse", "--is-bare-repository"], env) === "true";
    } catch (e) {
      if (!(e.status === 128 && /^fatal: (?:not a git repository|invalid gitfile format)/m.test(e.stderr))) throw e; // a transient failure: run again
    }
    if (!bare) no(`${mirror} is not a bare git repository: ask the user to remove it. The next call then makes a new mirror`);
  }
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

/** git's own result for a file that is not a bundle, or a bundle that does not fit the mirror: exit 1 and one of these. */
const NOT_A_BUNDLE = /^error: (?:unrecognized header|Repository lacks these prerequisite commits|unsupported bundle version|unknown capability|.* does not look like a v2 or v3 bundle file)/m;
/**
 * The part that import and create share: copies the task's bundle (copyBundle), verifies it against the mirror, and
 * fetches its branch into refs/sage/<task> with fsck, so every object's hash is checked. The tip comes from the fetched
 * ref. Only git's own result that the bundle is none or does not fit main refuses; any other failure of git is exit 2.
 */
function fetchBundle({ dir, t, branch, url }, temp, env) {
  const path = join(worktreeRoot(env), basename(dir), `${t.id}.bundle`);
  const bundle = copyBundle(path, temp, branch, worktreeRoot(env));
  const mirror = mirrorOf(dir, url, temp, env);
  const ref = `refs/sage/${t.id}`;
  const bad = `the bundle is not a git bundle of the branch ${branch} that fits main (git bundle create <file> main..${branch})`;
  try {
    inMirror(mirror, ["bundle", "verify", "-q", bundle], env, true);
  } catch (e) {
    if (e.status === 1 && NOT_A_BUNDLE.test(e.stderr)) no(bad);
    throw e;
  }
  const heads = inMirror(mirror, ["bundle", "list-heads", bundle, `refs/heads/${branch}`], env, true);
  if (!heads.split("\n").some((l) => l.endsWith(` refs/heads/${branch}`))) no(bad);
  inMirror(mirror, ["-c", "transfer.fsckObjects=true", "fetch", "-q", "--no-tags", "--no-write-fetch-head", "--", bundle, `+refs/heads/${branch}:${ref}`], env, true); // a lock or disk error: failed
  return { mirror, path, tip: inMirror(mirror, ["rev-parse", "--verify", `${ref}^{commit}`], env) };
}

/** The review copy of a task's commit in the logbook folder: the files, and the diff from the merge base with main. */
const reviewOf = (dir, task, sha) => ({ files: join(dir, "review", `${task}-${sha}`), diff: join(dir, "review", `${task}-${sha}.diff`) });
/**
 * The mirror's own attributes, over any .gitattributes in the task's commit: no export-ignore or export-subst (which would
 * hide or change a file in the archive), no conversion of line ends, encoding or ident, no filter, and no "-diff" (which
 * would show a text file as binary in the diff).
 */
const ATTRIBUTES = "* -export-ignore -export-subst -text !eol -ident -filter -working-tree-encoding !diff\n";
/**
 * import: fetches the task's bundle into the mirror (fetchBundle) and writes its review copy in review/ of the logbook
 * folder, which agents cannot write: the files of the tip (git archive) and its diff from the merge base with main. Both
 * are written in the script's folder and then moved in; the diff goes last, so its presence marks a whole copy, and its
 * time is the import time that create and merge compare with the first verdict. The reviewers read only this copy:
 * git diff, show and log in the agent's clone do not check the objects' hashes, so the agent can change what they show.
 * An import of a tip that has a review copy changes nothing and prints the same line.
 */
function importTask(rec, temp, env) {
  const { mirror, tip } = fetchBundle(rec, temp, env);
  const { files, diff } = reviewOf(rec.dir, rec.t.id, tip);
  const out = `imported ${tip}: review the files in ${files} and the change in ${diff}`;
  if (lstatSync(diff, { throwIfNoEntry: false })) return out;
  let base;
  try {
    base = inMirror(mirror, ["merge-base", `refs/heads/${BASE}`, tip], env, true);
  } catch (e) {
    if (e.status === 1) no(`${short(tip)} has no commit in common with ${BASE}: write the bundle from a branch that starts on ${BASE} (git bundle create <file> main..${rec.branch})`);
    throw e;
  }
  mkdirSync(join(mirror, "info"), { recursive: true });
  writeFileSync(join(mirror, "info", "attributes"), ATTRIBUTES);
  const tar = join(temp, "files.tar");
  const newFiles = join(temp, "files");
  const newDiff = join(temp, "change.diff");
  inMirror(mirror, ["archive", "--format=tar", `--output=${tar}`, tip], env, true);
  mkdirSync(newFiles);
  runFile("tar", ["-xf", tar, "-C", newFiles], env, true);
  inMirror(mirror, ["diff", "--no-ext-diff", "--no-textconv", "--no-color", `--output=${newDiff}`, `${base}..${tip}`], env, true);
  mkdirSync(dirname(files), { recursive: true });
  remove(files); // the files of an import that stopped before its diff: the script's own
  renameSync(newFiles, files);
  renameSync(newDiff, diff);
  return out;
}

/**
 * Refuses the reviewed head unless its review copy is older than the first verdict on it in the logbook: a verdict
 * recorded before the import may be on what the agent's clone showed, not on the objects that create pushes. The ledger
 * holds times to the second, so a verdict in the same second as the import refuses too.
 */
function imported({ dir, t, head }) {
  const first = Math.min(...read(dir, "ledger").filter((r) => r.sha === head).map((r) => Date.parse(r.at)));
  const st = lstatSync(reviewOf(dir, t.id, head).diff, { throwIfNoEntry: false });
  if (!st?.isFile() || !(st.mtimeMs < first)) no(`${short(head)} has no review copy from before its first verdict, so the reviews may have read other objects than the ones that sage-pr pushes: run sage-pr import ${t.id}, have the reviewers read the review copy that it names, and record their verdicts again`);
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

/** The most pull requests that one lookup reads: one page of GitHub's API. */
export const LIMIT = 100;
/**
 * The pull requests of the branch into main in the repository itself, in every state, newest first: a fork's pull request
 * with the same branch name is not the task's (isCrossRepository is true; the owner's name is not compared, because it
 * changes when the owner is renamed). GitHub keeps at most one of them open (it refuses a second with 422). GitHub filters
 * by the branch name only, so forks' pull requests count towards the limit: a full list can hide the task's own, and refuses.
 */
function mine(repo, branch, temp, env) {
  const all = JSON.parse(gh(["pr", "list", `--repo=${repo}`, `--head=${branch}`, `--base=${BASE}`, "--state=all", `--limit=${LIMIT}`, "--json=number,url,state,headRefOid,isCrossRepository"], temp, env) || "[]");
  if (all.length >= LIMIT) no(`GitHub lists ${LIMIT} or more pull requests of ${branch} into ${BASE} (forks' pull requests with the same branch name count too), so the task's own can be missing from the list: ask the user`);
  return all.filter((p) => p.isCrossRepository === false);
}


/**
 * create: pushes the reviewed head to the task's branch, fast-forward only, and opens a pull request when none is open.
 * A second create after a repair pushes the new reviewed head and opens nothing new. It returns the number of the open
 * pull request, which the logbook gets after the lock (remember), so that merge knows which pull request to merge. A
 * task with a merged pull request of its branch has nothing to create: after a squash merge the head is not on main, so
 * only GitHub tells. A recorded number that is not a pull request of the branch counts as none.
 */
function create(rec, temp, env) {
  const { t, branch, head, url, repo } = rec;
  const prs = mine(repo, branch, temp, env);
  const merged = prs.filter((p) => p.state === "MERGED");
  if (merged.length) {
    const done = merged.find((p) => p.headRefOid === head) ?? sameHead(merged[0], head); // sameHead refuses here
    no(`already merged as PR #${done.number}: nothing to create. Mark the task merged: sage task ${t.id} set state=merged`);
  }
  const { mirror, path, tip } = fetchBundle(rec, temp, env);
  if (tip !== head) no(`the bundle tip ${short(tip)} is not the reviewed head ${short(head)}. Review ${short(tip)} and record its verdicts, or write the bundle with ${branch} at ${short(head)}: git bundle create ${path} main..${branch}`);
  if (ancestor(mirror, head, `refs/heads/${BASE}`, env)) no(`the head ${short(head)} is already on ${BASE}: the task's work is on ${BASE}, so mark the task merged: sage task ${t.id} set state=merged`);
  imported(rec);
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
 * task's branch into main in the repository itself, at the reviewed head, the task is verified or pr-ready, and the merge check
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
      return `${done}; the mirror's ${BASE} is now ${short(inMirror(mirrorOf(dir, url, temp, env), ["rev-parse", `refs/heads/${BASE}`], env))}`;
    } catch (e) {
      throw new Merged(`${done}; the mirror refresh failed: ${e.message.replace(/^refused: /, "")}. Run sage-pr merge ${t.id} again later: it reports "already merged" and refreshes the mirror`);
    }
  };
  if (p.state === "MERGED" && sameHead(p, head)) return refresh(`already merged: ${branch} at ${short(head)}; nothing to do`);
  if (p.state !== "OPEN") no(`pull request #${pr} of ${branch} is ${p.state}, not open: reopen it on GitHub, or run sage-pr create ${t.id} to open a new one`);
  if (!["verified", "pr-ready"].includes(t.state)) no(`${t.id} is ${t.state || "in no state"}, not verified or pr-ready: merge only a task whose route is done. When it is: sage task ${t.id} set state=verified`);
  if (p.headRefOid !== head) no(`pull request #${pr} is at ${short(p.headRefOid)}, not at the reviewed head ${short(head)}. If ${short(head)} is a repair, push it first: sage-pr create ${t.id}. Else the branch moved after review: review ${short(p.headRefOid)} and record its verdicts`);
  imported({ dir, t, head });
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
      return { import: importTask, create, merge }[verb](rec, temp, tools);
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
