// Runs the PR script as the chief does, against a local bare repository that stands in for GitHub and a fake gh first
// on PATH that records its arguments and its folder. HOME, GH_CONFIG_DIR, the sage root and the worktree root are temp
// folders, and GH_TOKEN is a dummy, so no test reaches GitHub or reads the owner's token.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { hostname, tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const TOOL = fileURLToPath(new URL("../plugins/sage/skills/sage/sage.mjs", import.meta.url));
const PR = fileURLToPath(new URL("../plugins/sage/skills/sage/sage-pr.mjs", import.meta.url));
const SPY = fileURLToPath(new URL("kill-spy.mjs", import.meta.url));
/** The origin of every test project: GitHub's address. The mirror's config sends it to the local stand-in, so no test reaches GitHub. */
const ORIGIN = "https://github.com/owner/repo.git";
const timeout = 20_000;

/**
 * The fake gh: it records each call (arguments, folder, the folder's entries, token, config folder, the names of its
 * environment's variables, the repository that git finds in its folder after a git status, as real gh's git calls would,
 * and the mode of a --body-file) and plays GitHub's pull requests on the bare repository, as gh and GitHub do: list is
 * newest first; view of a branch takes the newest open pull request, else the newest (gh's findForBranch); create
 * refuses a second open pull request of one branch into one base in the repository itself (GitHub's 422). A pull
 * request in FAKE_GH_STATE may have base (default main), cross (from a fork) and owner (its head repository's owner,
 * default "owner"); its headRefOid is oid (set by merge), else the branch's tip in the bare repository.
 * FAKE_GH_FAIL names a call (create, merge, ...) that fails like GitHub, with FAKE_GH_ERR on stderr; FAKE_GH_CREATE_OUT
 * replaces create's answer; FAKE_GH_QUEUE makes merge queue the pull request and leave it open; FAKE_GH_MERGE_THEN_FAIL
 * makes merge fail after it merged (as a branch deletion that gets 403); FAKE_GH_STICK leaves a file in gh's folder and
 * makes the folder read-only, so that the script cannot remove it. The script gives gh only allow-listed variables, so the
 * fake reads the test's environment (FAKE_GH_*) from fake.json next to it, which the pr helper writes before each call.
 */
const FAKE_GH = `#!/usr/bin/env node
const { appendFileSync, chmodSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const env = JSON.parse(readFileSync(__dirname + "/fake.json", "utf8")), args = process.argv.slice(2), got = process.env;
const entries = readdirSync(process.cwd());
const flag = (n) => args.find((a) => a.startsWith("--" + n + "="))?.slice(n.length + 3);
let repo = "none";
try { execFileSync("git", ["status", "--porcelain"], { stdio: "ignore" }); } catch {}
try { repo = execFileSync("git", ["rev-parse", "--absolute-git-dir"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch {}
const bodyMode = flag("body-file") && (statSync(flag("body-file")).mode & 0o777).toString(8);
appendFileSync(env.FAKE_GH_LOG, JSON.stringify({ args, cwd: process.cwd(), entries, token: got.GH_TOKEN, config: got.GH_CONFIG_DIR, keys: Object.keys(got).sort(), repo, bodyMode }) + "\\n");
if (env.FAKE_GH_STICK) { writeFileSync("stuck", ""); chmodSync(process.cwd(), 0o555); }
const prs = existsSync(env.FAKE_GH_STATE) ? JSON.parse(readFileSync(env.FAKE_GH_STATE, "utf8")) : [];
const save = () => writeFileSync(env.FAKE_GH_STATE, JSON.stringify(prs));
const after = args[args.indexOf("--") + 1];
const bare = (...a) => execFileSync("git", ["--git-dir", env.FAKE_GH_BARE, ...a], { encoding: "utf8", env }).trim();
const url = (n) => "https://github.com/owner/repo/pull/" + n;
const tip = (b) => { try { return bare("rev-parse", "--verify", "-q", "refs/heads/" + b); } catch { return ""; } };
const json = (p) => { const all = { number: p.number, state: p.state, url: url(p.number), baseRefName: p.base ?? "main", headRefName: p.head, headRefOid: p.oid ?? tip(p.head), isCrossRepository: !!p.cross, headRepositoryOwner: { login: p.owner ?? "owner" } }; return Object.fromEntries(flag("json").split(",").filter((k) => k in all).map((k) => [k, all[k]])); };
const newest = (list) => [...list].sort((a, b) => b.number - a.number);
if (args[1] === env.FAKE_GH_FAIL) { console.error(env.FAKE_GH_ERR ?? "HTTP 502: Bad Gateway (https://api.github.com/graphql)"); process.exit(1); }
const pick = () => (/^[0-9]+$/.test(after) ? prs.find((x) => x.number === Number(after)) : newest(prs.filter((x) => x.head === after)).sort((a, b) => (b.state === "OPEN") - (a.state === "OPEN"))[0]);
if (args[1] === "list") console.log(JSON.stringify(newest(prs.filter((p) => p.head === flag("head") && (p.base ?? "main") === flag("base") && (flag("state") === "all" || p.state === flag("state").toUpperCase()))).map(json)));
else if (args[1] === "create") {
  if (prs.some((p) => p.state === "OPEN" && p.head === flag("head") && (p.base ?? "main") === flag("base") && !p.cross)) { console.error("pull request create failed: GraphQL: A pull request already exists for owner:" + flag("head") + ". (createPullRequest)"); process.exit(1); }
  prs.push({ number: prs.length + 1, head: flag("head"), base: flag("base"), state: "OPEN" }); save(); console.log(env.FAKE_GH_CREATE_OUT ?? url(prs.length));
}
else if (args[1] === "view") { const p = pick(); if (!p) { console.error(/^[0-9]+$/.test(after) ? "GraphQL: Could not resolve to a PullRequest with the number of " + after + ". (repository.pullRequest)" : 'no pull requests found for branch "' + after + '"'); process.exit(1); } console.log(JSON.stringify(json(p))); }
else if (args[1] === "merge") {
  const p = pick();
  if (!p || p.state !== "OPEN" || bare("rev-parse", "refs/heads/" + p.head) !== flag("match-head-commit")) { console.error("head mismatch"); process.exit(1); }
  if (env.FAKE_GH_QUEUE) { console.log("! Pull request owner/repo#" + p.number + " will be added to the merge queue for main when ready"); process.exit(0); }
  const squash = bare("commit-tree", flag("match-head-commit") + "^{tree}", "-p", "refs/heads/main", "-m", "squash");
  bare("update-ref", "refs/heads/main", squash); bare("update-ref", "-d", "refs/heads/" + p.head);
  p.state = "MERGED"; p.oid = flag("match-head-commit"); save();
  if (env.FAKE_GH_MERGE_THEN_FAIL) { console.error("failed to delete remote branch claude/t1: HTTP 403: Resource not accessible by integration"); process.exit(1); }
} else process.exit(3);
`;

/**
 * One project in temp folders: a GitHub stand-in (bare repository), a main checkout whose origin is GitHub's address of
 * owner/repo, a logbook with task T1 on branch claude/t1 and a mirror whose config sends that address to the stand-in
 * (route), the fake gh, and a fake ps. The script starts with the kill spy (node --import, not NODE_OPTIONS), so a
 * liveness probe of the lock signals no real process: it lands in kills. Each helper runs one program with an argument array.
 */
function world() {
  const t = realpathSync(mkdtempSync(join(tmpdir(), "sage-pr-test-")));
  const at = (...p) => join(t, ...p);
  for (const d of ["home", "gh-config", "sage", "worktrees", "bin"]) mkdirSync(at(d));
  writeFileSync(at("bin", "gh"), FAKE_GH);
  writeFileSync(at("bin", "ps"), `#!/bin/sh\ntouch ${at("ps-RAN")}\necho "Sat Jan  1 00:00:00 2000"\n`);
  for (const b of ["gh", "ps"]) chmodSync(at("bin", b), 0o755);
  const env = {
    ...process.env,
    HOME: at("home"),
    GH_CONFIG_DIR: at("gh-config"),
    GH_TOKEN: "dummy-token-not-real",
    SAGE_HOME: at("sage"),
    SAGE_WORKTREES: at("worktrees"),
    SAGE_PROJECT: at("project"),
    SAGE_REPO: "owner/repo",
    SAGE_TEST_PIDS: "{}",
    SAGE_TEST_KILLS: at("kills"),
    PATH: `${at("bin")}:${process.env.PATH}`,
    FAKE_GH_LOG: at("gh.log"),
    FAKE_GH_STATE: at("gh.json"),
    FAKE_GH_BARE: at("remote.git"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
    DO_NOT_TRACK: "1",
  };
  const git = (...a) => execFileSync("git", a, { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim();
  const p = (...a) => git("-C", at("project"), ...a);
  const sage = (...a) => {
    const r = spawnSync("node", [TOOL, ...a, "--project", at("project")], { encoding: "utf8", env, timeout });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  const pr = (...a) => {
    writeFileSync(at("bin", "fake.json"), JSON.stringify(env));
    return spawnSync("node", [`--import=${SPY}`, PR, ...a], { encoding: "utf8", env, cwd: at("home"), timeout });
  };
  git("init", "-q", "--bare", "-b", "main", at("remote.git"));
  git("init", "-q", "-b", "main", at("project"));
  writeFileSync(at("project", "a.txt"), "a\n");
  p("add", "a.txt");
  p("commit", "-q", "-m", "a");
  p("remote", "add", "origin", at("remote.git"));
  p("push", "-q", "origin", "main");
  p("remote", "set-url", "origin", ORIGIN);
  sage("init");
  sage("task", "add", "--title", "Add b", "--size", "small");
  sage("task", "T1", "set", "branch=claude/t1");
  p("checkout", "-q", "-b", "claude/t1");
  const logbook = sage("logbook").trim();
  const mirror = join(logbook, "mirror.git");
  git("init", "-q", "--bare", mirror);
  /** Sends the origin's address (or url) to target in the mirror's config, and every other GitHub address to nowhere. */
  const route = (target, url = ORIGIN) => {
    const keys = spawnSync("git", ["--git-dir", mirror, "config", "--name-only", "--get-regexp", "^url\\."], { encoding: "utf8", env }).stdout.split("\n").filter(Boolean);
    for (const key of new Set(keys)) git("--git-dir", mirror, "config", "--unset-all", key);
    git("--git-dir", mirror, "config", `url.${target}.insteadOf`, url);
    git("--git-dir", mirror, "config", "--add", `url.${at("nowhere")}/.insteadOf`, "https://github.com/");
  };
  route(at("remote.git"));
  const bundle = join(at("worktrees"), basename(logbook), "T1.bundle");
  /** A new commit on the task branch, its bundle (main..claude/t1, as the implementer writes it), and its SHA. */
  const commit = (name) => {
    writeFileSync(at("project", name), `${name}\n`);
    p("add", name);
    p("commit", "-q", "-m", name);
    mkdirSync(join(bundle, ".."), { recursive: true });
    rmSync(bundle, { force: true });
    p("bundle", "create", "-q", bundle, "main..claude/t1");
    return p("rev-parse", "HEAD");
  };
  const calls = () => (existsSync(at("gh.log")) ? readFileSync(at("gh.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  const remote = (ref) => {
    try {
      return git("--git-dir", at("remote.git"), "rev-parse", "--verify", "-q", ref);
    } catch {
      return "";
    }
  };
  /** A task's row in tasks.tsv, by its column names. */
  const task = (id) => {
    const [head, ...rows] = readFileSync(join(logbook, "tasks.tsv"), "utf8").trim().split("\n").map((l) => l.split("\t"));
    return Object.fromEntries(head.map((c, i) => [c, rows.find((r) => r[0] === id)?.[i]]));
  };
  /** Writes one cell of a task's row in tasks.tsv, as a forged or damaged logbook would have it. */
  const forge = (id, column, value) => {
    const file = join(logbook, "tasks.tsv");
    const [head, ...rows] = readFileSync(file, "utf8").trim().split("\n").map((l) => l.split("\t"));
    const row = rows.find((r) => r[0] === id);
    row[head.indexOf(column)] = value;
    writeFileSync(file, [head, ...rows].map((r) => r.join("\t")).join("\n") + "\n");
  };
  /** The pull requests of the fake gh, changed by a function. */
  const github = (change) => writeFileSync(at("gh.json"), JSON.stringify(change(JSON.parse(readFileSync(at("gh.json"), "utf8")))));
  /** The refs of the mirror: none until the script fetched. */
  const mirrored = () => git("--git-dir", mirror, "for-each-ref");
  const kills = () => (existsSync(at("kills")) ? readFileSync(at("kills"), "utf8") : "");
  return { at, env, git, p, sage, pr, logbook, mirror, route, mirrored, kills, bundle, commit, calls, remote, task, forge, github };
}

/** A refusal: exit 1, and stderr starts with "sage-pr: refused:" and matches why. */
function refused(r, why) {
  assert.equal(r.status, 1, `exit ${r.status}: ${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /^sage-pr: refused: /);
  assert.match(r.stderr, why);
}

test("create pushes the reviewed head and opens one pull request, with gh in an empty folder", () => {
  const w = world();
  const head = w.commit("b.txt");
  w.sage("verdict", "T1", "--sha", head, "--kind", "checks-pass");
  const r = w.pr("create", "T1");
  assert.equal(r.stderr, "");
  assert.equal(r.stdout, `pushed ${head.slice(0, 7)} to claude/t1; opened https://github.com/owner/repo/pull/1; T1 has PR 1 in the logbook\n`);
  assert.equal(w.task("T1").pr, "1", "T96-Q3: the logbook has the PR number");
  assert.equal(w.remote("refs/heads/claude/t1"), head);
  const calls = w.calls();
  assert.deepEqual(calls.map((c) => c.args.slice(0, -1).concat(c.args.at(-1).startsWith("--body-file=") ? ["--body-file=<temp>"] : c.args.at(-1))), [
    ["pr", "list", "--repo=owner/repo", "--head=claude/t1", "--base=main", "--state=all", "--json=number,url,state,headRefOid,isCrossRepository,headRepositoryOwner"],
    ["pr", "create", "--repo=owner/repo", "--base=main", "--head=claude/t1", "--title=T1: Add b", "--body-file=<temp>"],
  ]);
  for (const c of calls) {
    assert.deepEqual(c.entries, []); // an empty folder: gh reads no repository there
    assert.ok(!c.cwd.startsWith(w.at("project")) && !c.cwd.startsWith(w.at("worktrees")), c.cwd);
    assert.equal(c.token, "dummy-token-not-real");
    assert.equal(c.config, w.at("gh-config"));
  }
  assert.ok(existsSync(join(w.logbook, "mirror.git", "HEAD")), "the mirror is in the logbook folder");
});

test("create again: no second pull request, a repair's head goes out fast-forward only", () => {
  const w = world();
  const first = w.commit("b.txt");
  w.sage("verdict", "T1", "--sha", first, "--kind", "checks-pass");
  assert.equal(w.pr("create", "T1").status, 0);
  const again = w.pr("create", "T1");
  assert.equal(again.stdout, `claude/t1 is already at ${first.slice(0, 7)}; pull request #1 https://github.com/owner/repo/pull/1 is open\n`);
  const repaired = w.commit("c.txt");
  w.sage("verdict", "T1", "--sha", repaired, "--kind", "checks-pass");
  assert.equal(w.pr("create", "T1").stdout, `pushed ${repaired.slice(0, 7)} to claude/t1; pull request #1 https://github.com/owner/repo/pull/1 is open\n`);
  assert.equal(w.remote("refs/heads/claude/t1"), repaired);
  // A rewritten history (amend): its head does not follow from the remote branch, so no push.
  w.p("commit", "-q", "--amend", "-m", "c rewritten");
  rmSync(w.bundle);
  w.p("bundle", "create", "-q", w.bundle, "main..claude/t1");
  const rewritten = w.p("rev-parse", "HEAD");
  w.sage("verdict", "T1", "--sha", rewritten, "--kind", "checks-pass");
  refused(w.pr("create", "T1"), new RegExp(`the remote claude/t1 is at ${repaired.slice(0, 7)}, and ${rewritten.slice(0, 7)} does not follow from it: a push would not be a fast-forward\. The remote branch moved: review its tip, or ask the user$`, "m"));
  assert.equal(w.remote("refs/heads/claude/t1"), repaired);
  assert.equal(w.calls().filter((c) => c.args[1] === "create").length, 1);
});

test("view shows the task's pull request, with -- before the branch", () => {
  const w = world();
  const head = w.commit("b.txt");
  w.sage("verdict", "T1", "--sha", head, "--kind", "checks-pass");
  w.pr("create", "T1");
  const r = w.pr("view", "T1");
  assert.equal(r.stdout, `{"number":1,"state":"OPEN","headRefOid":"${head}","url":"https://github.com/owner/repo/pull/1"}\n`);
  assert.deepEqual(w.calls().at(-1).args, ["pr", "view", "--repo=owner/repo", "--json=number,state,headRefOid,url", "--", "claude/t1"]);
});

test("merge runs the merge check, merges only the reviewed head, and fetches the new main into the mirror", () => {
  const w = world();
  const head = w.commit("b.txt");
  w.sage("verdict", "T1", "--sha", head, "--kind", "checks-pass");
  w.pr("create", "T1");
  assert.equal(w.task("T1").pr, "1", "create recorded the PR number");
  w.forge("T1", "state", "verified");
  // The merge check refuses: only checks-pass, no review or QA.
  refused(w.pr("merge", "T1"), /merge check: T1: 0 of 1 clean cycles on this SHA; never recorded: review-clean, qa-pass/);
  assert.equal(w.calls().filter((c) => c.args[1] === "merge").length, 0);
  w.sage("verdict", "T1", "--sha", head, "--kind", "review-clean");
  w.sage("verdict", "T1", "--sha", head, "--kind", "qa-pass");
  // A logbook that init did not make, with verdicts on the head, refuses too.
  const rogue = w.at("sage", "rogue-926427");
  mkdirSync(rogue);
  writeFileSync(join(rogue, "ledger.tsv"), `task\tpr\tsha\tkind\tcycle\trun\tat\nT9\t\t${head}\tqa-pass\t1\t\t2026-10-05T00:00:00Z\n`);
  refused(w.pr("merge", "T1"), /merge check: .*rogue-926427 has verdicts on .* not in the known project list/);
  assert.equal(w.calls().filter((c) => c.args[1] === "merge").length, 0);
  rmSync(rogue, { recursive: true });
  const r = w.pr("merge", "T1");
  assert.equal(r.status, 0, r.stderr);
  const main = w.remote("refs/heads/main");
  assert.equal(r.stdout, `merged claude/t1 at ${head.slice(0, 7)}; the mirror's main is now ${main.slice(0, 7)}\n`);
  assert.deepEqual(w.calls().at(-2).args, ["pr", "merge", "--repo=owner/repo", "--squash", "--delete-branch", `--match-head-commit=${head}`, "--", "1"]);
  assert.equal(w.calls().at(-1).args[1], "list", "the script reads the pull request again after the merge");
  assert.equal(w.git("--git-dir", join(w.logbook, "mirror.git"), "rev-parse", "refs/heads/main"), main);
  assert.notEqual(main, head); // the stand-in squashed: the new main is a new commit that the mirror fetched
});

test("the argument grammar: exactly create, view or merge and a task id; everything else refuses before any git or gh", () => {
  const w = world();
  const head = w.commit("b.txt");
  w.sage("verdict", "T1", "--sha", head, "--kind", "checks-pass");
  const cases = [
    [[], /expected 2 arguments .*got 0/],
    [["create"], /expected 2 arguments .*got 1/],
    [["merge", "T1", "--admin"], /expected 2 arguments .*got 3/],
    [["merge", "1", "-R", "evil/repo"], /expected 2 arguments .*got 4/],
    [["create", "T1", "--body-file", "/etc/hosts"], /expected 2 arguments .*got 4/],
    [["merge", "T1", "-d"], /expected 2 arguments .*got 3/],
    [["create", "-R", "evil/repo"], /expected 2 arguments .*got 3/],
    [["view", "T1;id"], /the task id is T and digits/],
    [["view", "../T1"], /the task id is T and digits/],
    [["merge", "1"], /the task id is T and digits/],
    [["view", "--repo=evil/repo"], /the task id is T and digits/],
    [["view", "-T1"], /the task id is T and digits/],
    [["view", "T01"], /the task id is T and digits/],
    [["view", "T1 "], /the task id is T and digits/],
    [["view", "t1"], /the task id is T and digits/], // T96-C3: only a capital T
    [["--admin", "T1"], /the verb is create, view or merge/],
    [["pr", "T1"], /the verb is create, view or merge/],
    [["Create", "T1"], /the verb is create, view or merge/],
    [["view", "T2"], /no task T2/],
  ];
  for (const [args, why] of cases) refused(w.pr(...args), why);
  assert.deepEqual(w.calls(), []);
  assert.equal(w.remote("refs/heads/claude/t1"), "");
  assert.equal(w.mirrored(), "");
});

test("the bundle: a link, a second hard link, a folder, a file over the limit or a missing file refuses", () => {
  const w = world();
  const head = w.commit("b.txt");
  w.sage("verdict", "T1", "--sha", head, "--kind", "checks-pass");
  const good = w.at("good.bundle");
  writeFileSync(good, readFileSync(w.bundle));
  const cases = [
    [() => symlinkSync("/etc/hosts", w.bundle), /the bundle (.*T1\.bundle) is a link, not a plain file: remove it, then write it with git bundle create \1 main\.\.claude\/t1$/m],
    [() => symlinkSync(good, w.bundle), /is a link, not a plain file/],
    [() => linkSync(good, w.bundle), /the bundle (.*) has 2 links, not 1: remove it, then write it with git bundle create \1 main\.\.claude\/t1$/m],
    [() => mkdirSync(w.bundle), /the bundle (.*) is not a plain file: remove it, then write it with git bundle create \1 main\.\.claude\/t1$/m],
    [() => (writeFileSync(w.bundle, ""), truncateSync(w.bundle, 100 * 1024 * 1024 + 1)), /the bundle .* is over 104857600 bytes: the bundle is too big, ask the user$/m],
    [() => {}, /no bundle at (.*T1\.bundle): write it with git bundle create \1 main\.\.claude\/t1$/m],
    [() => writeFileSync(w.bundle, "not a bundle\n"), /T1\.bundle is not a git bundle: it does not start with "# v2 git bundle" or "# v3 git bundle"\. Write it with git bundle create .*T1\.bundle main\.\.claude\/t1/],
    [() => writeFileSync(w.bundle, ""), /T1\.bundle is empty\. Write it with git bundle create/],
    // T96-S3: a gitdir file names a repository, and git's local transport would fetch from it as from a bundle.
    [() => writeFileSync(w.bundle, `gitdir: ${w.at("project", ".git")}\n`), /T1\.bundle is not a git bundle: it does not start with "# v2 git bundle"/],
    [() => writeFileSync(w.bundle, "# v2 git bundle\nnot really\n"), /the bundle is not a git bundle of the branch claude\/t1/],
  ];
  for (const [plant, why] of cases) {
    rmSync(w.bundle, { recursive: true, force: true });
    plant();
    refused(w.pr("create", "T1"), why);
  }
  assert.equal(w.remote("refs/heads/claude/t1"), "");
  assert.deepEqual(w.calls().map((c) => c.args[1]), ["list"], "the last bundle passes the file checks, so only the lookup of merged pull requests ran");
});

test("a bundle whose tip is not the reviewed head refuses", () => {
  const w = world();
  const head = w.commit("b.txt");
  w.sage("verdict", "T1", "--sha", head, "--kind", "checks-pass");
  const extra = w.commit("unreviewed.txt");
  refused(w.pr("create", "T1"), new RegExp(`the bundle tip ${extra.slice(0, 7)} is not the reviewed head ${head.slice(0, 7)}\\. Review ${extra.slice(0, 7)} and record its verdicts, or write the bundle with claude/t1 at ${head.slice(0, 7)}: git bundle create .*T1\\.bundle main\\.\\.claude/t1$`, "m"));
  assert.equal(w.remote("refs/heads/claude/t1"), "");
  assert.deepEqual(w.calls().map((c) => c.args[1]), ["list"], "only the lookup of merged pull requests");
});

test("T165-G: a forged branch in the logbook: the base branch or a branch outside the task's pattern refuses, by the one task-branch rule", () => {
  const w = world();
  const head = w.commit("b.txt");
  w.sage("verdict", "T1", "--sha", head, "--kind", "checks-pass");
  const tasks = join(w.logbook, "tasks.tsv");
  const text = readFileSync(tasks, "utf8");
  const cases = [
    ["main", /branch "main" is not a branch of T1 \(\[<prefix>\/\]t1\[-<words>\]\): sage task T1 set branch=claude\/t1$/m],
    ["refs/heads/main", /branch "refs\/heads\/main" is not a branch of T1/],
    ["MAIN", /branch "MAIN" is not a branch of T1/],
    ["master", /branch "master" is not a branch of T1 \(\[<prefix>\/\]t1\[-<words>\]\): sage task T1 set branch=claude\/t1/],
    ["origin/claude/t1", /branch "origin\/claude\/t1" is not a branch of T1 \(\[<prefix>\/\]t1\[-<words>\]\): sage task T1 set branch=claude\/t1/],
    ["--force", /branch "--force" is not a branch of T1 \(\[<prefix>\/\]t1\[-<words>\]\): sage task T1 set branch=claude\/t1/],
    ["feature-x", /branch "feature-x" is not a branch of T1 \(\[<prefix>\/\]t1\[-<words>\]\): sage task T1 set branch=claude\/t1/],
    ["claude/t10", /branch "claude\/t10" is not a branch of T1 \(\[<prefix>\/\]t1\[-<words>\]\): sage task T1 set branch=claude\/t1/],
    ["a/b/t1", /branch "a\/b\/t1" is not a branch of T1 \(\[<prefix>\/\]t1\[-<words>\]\): sage task T1 set branch=claude\/t1/],
  ];
  for (const verb of ["create", "view", "merge"]) {
    for (const [branch, why] of cases) {
      writeFileSync(tasks, text.replace("\tclaude/t1\t", `\t${branch}\t`));
      refused(w.pr(verb, "T1"), why);
    }
  }
  assert.deepEqual(w.calls(), []);
  assert.equal(w.remote("refs/heads/main"), w.git("-C", w.at("project"), "rev-parse", "main"));
});

test("a reviewed head that is already on main refuses", () => {
  const w = world();
  const main = w.p("rev-parse", "main"); // claude/t1 starts at main, with no commit of its own
  assert.equal(w.p("rev-parse", "claude/t1"), main);
  mkdirSync(join(w.bundle, ".."), { recursive: true });
  w.p("bundle", "create", "-q", w.bundle, "claude/t1");
  w.sage("verdict", "T1", "--sha", main, "--kind", "checks-pass");
  refused(w.pr("create", "T1"), new RegExp(`the head ${main.slice(0, 7)} is already on main: the task's work is on main, so mark the task merged: sage task T1 set state=merged$`, "m"));
  assert.equal(w.remote("refs/heads/claude/t1"), "");
  assert.deepEqual(w.calls().map((c) => c.args[1]), ["list"], "only the lookup of merged pull requests");
});

test("create and merge need a reviewed head; a task without one refuses", () => {
  const w = world();
  w.commit("b.txt");
  refused(w.pr("create", "T1"), /T1 has no verdict with a SHA, so it has no reviewed head: record the route's verdicts on the reviewed head \(sage verdict T1 --sha <sha> --kind <kind>\)$/m);
  refused(w.pr("merge", "T1"), /T1 has no verdict with a SHA/);
  assert.deepEqual(w.calls(), []);
});

const short = (sha) => sha.slice(0, 7);
/** World with T1's head reviewed clean (checks, review and QA), T1 verified, and its pull request opened by create. */
function reviewed() {
  const w = world();
  const head = w.commit("b.txt");
  for (const kind of ["checks-pass", "review-clean", "qa-pass"]) w.sage("verdict", "T1", "--sha", head, "--kind", kind);
  w.forge("T1", "state", "verified");
  assert.equal(w.pr("create", "T1").status, 0);
  return { w, head };
}

test("T96-S1: create fetches and pushes no tag, also with push.followTags=true in the global config", () => {
  const w = world();
  const head = w.commit("b.txt");
  w.p("tag", "-a", "-m", "release", "v9.9.9", head);
  rmSync(w.bundle);
  w.p("bundle", "create", "-q", w.bundle, "main..claude/t1", "v9.9.9");
  assert.match(w.p("bundle", "list-heads", w.bundle), /refs\/tags\/v9\.9\.9/, "the bundle carries the tag");
  writeFileSync(w.at("home", ".gitconfig"), "[push]\n\tfollowTags = true\n");
  w.sage("verdict", "T1", "--sha", head, "--kind", "checks-pass");
  const r = w.pr("create", "T1");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(w.remote("refs/heads/claude/t1"), head);
  assert.equal(w.git("--git-dir", w.at("remote.git"), "tag", "-l"), "", "no tag reached the remote");
  assert.equal(w.git("--git-dir", join(w.logbook, "mirror.git"), "tag", "-l"), "", "no tag in the mirror");
});

test("T96-C1: a merge whose mirror refresh fails exits 3 and says that it merged", () => {
  const { w, head } = reviewed();
  const before = w.remote("refs/heads/main");
  writeFileSync(join(w.logbook, "mirror.git", "refs", "heads", "main.lock"), ""); // a held lock: the fetch of main fails
  const r = w.pr("merge", "T1");
  assert.equal(r.status, 3, r.stderr);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, `sage-pr: merged claude/t1 at ${short(head)}; the mirror refresh failed: git fetch failed with exit 1. Run sage-pr merge T1 again later: it reports "already merged" and refreshes the mirror\n`);
  assert.notEqual(w.remote("refs/heads/main"), before, "the merge happened");
});

test("T96-R2-AFTEREXIT3: merge again after exit 3 says already merged, refreshes the mirror, and merges nothing", () => {
  const { w, head } = reviewed();
  const lock = join(w.logbook, "mirror.git", "refs", "heads", "main.lock");
  writeFileSync(lock, "");
  assert.equal(w.pr("merge", "T1").status, 3);
  const main = w.remote("refs/heads/main");
  let r = w.pr("merge", "T1"); // the lock is still held: the refresh fails again
  assert.equal(r.status, 3, r.stderr);
  assert.equal(r.stderr, `sage-pr: already merged: claude/t1 at ${short(head)}; nothing to do; the mirror refresh failed: git fetch failed with exit 1. Run sage-pr merge T1 again later: it reports "already merged" and refreshes the mirror\n`);
  rmSync(lock);
  r = w.pr("merge", "T1");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `already merged: claude/t1 at ${short(head)}; nothing to do; the mirror's main is now ${short(main)}\n`);
  assert.equal(w.git("--git-dir", join(w.logbook, "mirror.git"), "rev-parse", "refs/heads/main"), main);
  assert.equal(w.calls().filter((c) => c.args[1] === "merge").length, 1, "one gh pr merge only");
});

test("T96-R2-OPENTEST: merge refuses a CLOSED pull request, and a MERGED one of another branch; a MERGED one of the task is done", () => {
  const { w, head } = reviewed();
  w.github((prs) => [{ ...prs[0], state: "CLOSED" }]);
  refused(w.pr("merge", "T1"), /^sage-pr: refused: pull request #1 of claude\/t1 is CLOSED, not open: reopen it on GitHub, or run sage-pr create T1 to open a new one\n$/);
  const other = /^sage-pr: refused: pull request #1 is not a pull request of claude\/t1 into main in owner\/repo \(GitHub has no such pull request, or it is another branch's or a fork's\): run sage-pr create T1, which records the task's own, or sage task T1 set pr=<n>\n$/;
  w.github((prs) => [{ ...prs[0], state: "MERGED", head: "claude/t2" }]);
  refused(w.pr("merge", "T1"), other);
  w.github((prs) => [{ ...prs[0], state: "MERGED", head: "claude/t1", cross: true }]);
  refused(w.pr("merge", "T1"), other);
  w.github((prs) => [{ ...prs[0], state: "MERGED", cross: false }]);
  const r = w.pr("merge", "T1");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`^already merged: claude/t1 at ${short(head)}; nothing to do; the mirror's main is now [0-9a-f]{7}\n$`));
  assert.equal(w.calls().filter((c) => c.args[1] === "merge").length, 0);
});

test("T96-R2-GHEXIT: a gh call that fails exits 2 (failed), redacted, and names the next step after a head mismatch", () => {
  const w = world();
  const head = w.commit("b.txt");
  for (const kind of ["checks-pass", "review-clean", "qa-pass"]) w.sage("verdict", "T1", "--sha", head, "--kind", kind);
  w.env.FAKE_GH_FAIL = "create";
  w.env.FAKE_GH_ERR = "HTTP 401: Bad credentials https://u:p@ss@github.com/o/r user:s3cret@host:path https://tok3n@github.com/x";
  let r = w.pr("create", "T1");
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.stderr, "sage-pr: failed: gh pr create failed: HTTP 401: Bad credentials https://***@github.com/o/r ***@host:path https://***@github.com/x\n");
  delete w.env.FAKE_GH_FAIL;
  assert.equal(w.pr("create", "T1").status, 0);
  w.forge("T1", "state", "verified");
  w.env.FAKE_GH_FAIL = "merge";
  delete w.env.FAKE_GH_ERR;
  r = w.pr("merge", "T1");
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.stderr, "sage-pr: failed: gh pr merge failed: HTTP 502: Bad Gateway (https://api.github.com/graphql). If GitHub says that the head changed, the branch moved after review: review the new head and record its verdicts\n");
  delete w.env.FAKE_GH_FAIL;
  const moved = w.git("--git-dir", w.at("remote.git"), "commit-tree", `${head}^{tree}`, "-p", head, "-m", "moved");
  w.git("--git-dir", w.at("remote.git"), "update-ref", "refs/heads/claude/t1", moved);
  r = w.pr("merge", "T1");
  refused(r, new RegExp(`^sage-pr: refused: pull request #1 is at ${short(moved)}, not at the reviewed head ${short(head)}\\. If ${short(head)} is a repair, push it first: sage-pr create T1\\. Else the branch moved after review: review ${short(moved)} and record its verdicts\n$`));
  assert.equal(w.calls().filter((c) => c.args[1] === "merge").length, 1, "only the merge that failed with 502");
  r = w.pr("view", "T2");
  assert.equal(r.status, 1, "a task that the logbook does not have is the script's own refusal");
});

test("T96-R2-RECFAIL: create exits 2 when the logbook refuses the PR number, and when gh's answer has no number", () => {
  const w = world();
  const head = w.commit("b.txt");
  w.sage("verdict", "T1", "--sha", head, "--kind", "checks-pass");
  w.forge("T1", "route", "investigate"); // the state tool gives no PR to a task without a build step
  let r = w.pr("create", "T1");
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, new RegExp(`^sage-pr: failed: pushed ${short(head)} to claude/t1; opened https://github.com/owner/repo/pull/1, but the logbook did not take PR 1 \\(.*is an investigation.*\\)\\. Run sage-pr create T1 again\n$`));
  assert.equal(w.task("T1").pr, "");
  const w2 = world();
  const head2 = w2.commit("b.txt");
  w2.sage("verdict", "T1", "--sha", head2, "--kind", "checks-pass");
  w2.env.FAKE_GH_CREATE_OUT = "Created the pull request.";
  r = w2.pr("create", "T1");
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.stderr, `sage-pr: failed: pushed ${short(head2)} to claude/t1; opened Created the pull request., but its number is not in gh's answer, so the logbook has no PR number: sage task T1 set pr=<n>\n`);
  assert.equal(w2.task("T1").pr, "");
});

test("T96-R2-STALEPR: create replaces a recorded PR that is not the open pull request of the branch into main, and says so", () => {
  const w = world();
  const first = w.commit("b.txt");
  w.sage("verdict", "T1", "--sha", first, "--kind", "checks-pass");
  assert.equal(w.pr("create", "T1").status, 0);
  assert.equal(w.task("T1").pr, "1");
  w.github((prs) => [{ ...prs[0], state: "CLOSED" }]);
  const repaired = w.commit("c.txt");
  w.sage("verdict", "T1", "--sha", repaired, "--kind", "checks-pass");
  const r = w.pr("create", "T1");
  assert.equal(r.stdout, `pushed ${short(repaired)} to claude/t1; opened https://github.com/owner/repo/pull/2; T1 has PR 2 in the logbook, not PR 1\n`, r.stderr);
  assert.equal(w.task("T1").pr, "2");
  // An open pull request of the branch into another base is not the task's: create opens one into main.
  w.github((prs) => prs.map((p) => (p.number === 2 ? { ...p, base: "release" } : p)));
  assert.equal(w.pr("create", "T1").stdout, `claude/t1 is already at ${short(repaired)}; opened https://github.com/owner/repo/pull/3; T1 has PR 3 in the logbook, not PR 2\n`);
});

test("T96-S6-REDACT: no message prints the origin or SAGE_REPO, in any address form", () => {
  const w = world();
  const head = w.commit("b.txt");
  w.sage("verdict", "T1", "--sha", head, "--kind", "checks-pass");
  delete w.env.SAGE_REPO;
  for (const url of ["user:s3cret@gitlab.invalid:x/y.git", "https://user:p@s3cret@github.com/x/y.git", "https://user:s3cret@gitlab.invalid/x/y.git"]) {
    w.p("remote", "set-url", "origin", url);
    const r = w.pr("create", "T1");
    refused(r, /^sage-pr: refused: the origin of .*\/project is not a GitHub repository, and sage-pr pushes only to GitHub: git -C .*\/project remote set-url origin https:\/\/github\.com\/<owner>\/<name>\.git\n$/);
    assert.doesNotMatch(r.stderr, /s3cret|gitlab|user/);
  }
  w.p("remote", "set-url", "origin", "https://github.com/owner/repo.git");
  for (const repo of ["https://user:s3cret@github.com/o/r", "o/r@s3cret", "user:s3cret@github.com:o/r", "owner/repo@s3cret"]) {
    w.env.SAGE_REPO = repo;
    const r = w.pr("view", "T1");
    refused(r, /^sage-pr: refused: SAGE_REPO is not the origin's repository owner\/repo, so gh and git would act on two repositories\. Unset SAGE_REPO, or set it to owner\/repo\n$/);
    assert.doesNotMatch(r.stderr, /s3cret/);
  }
  assert.deepEqual(w.calls(), []);
});

test("T96-S7-PRCELL: merge refuses a PR cell that is not a pull request number, before gh", () => {
  const { w } = reviewed();
  for (const cell of ["https://github.com/owner/repo/pull/1", "--admin", "01", "1 --admin"]) {
    w.forge("T1", "pr", cell);
    const r = w.pr("merge", "T1");
    refused(r, /^sage-pr: refused: the PR of T1 in the logbook is not a pull request number: sage task T1 set pr=<n>\n$/);
  }
  assert.equal(w.calls().filter((c) => c.args[1] !== "list" && c.args[1] !== "create").length, 0);
});

test("T96-S2: no message prints the origin's user or password, nor the arguments of a failed git", () => {
  const w = world();
  const head = w.commit("b.txt");
  w.sage("verdict", "T1", "--sha", head, "--kind", "checks-pass");
  delete w.env.SAGE_REPO;
  w.p("remote", "set-url", "origin", "https://user:s3cret-token@gitlab.invalid/x/y.git");
  let r = w.pr("create", "T1");
  refused(r, /the origin of .*\/project is not a GitHub repository/);
  assert.doesNotMatch(r.stderr, /s3cret/);
  w.env.SAGE_REPO = "owner/repo";
  const secret = "https://user:s3cret-token@github.com/owner/repo.git";
  w.p("remote", "set-url", "origin", secret);
  w.route(`${w.at("nowhere")}//user:s3cret-token@host/repo.git`, secret); // a local path: the fetch fails with no network
  r = w.pr("create", "T1");
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.stderr, "sage-pr: failed: git fetch failed with exit 128\n");
});

test("T96-S4: a fork's open pull request with the task's branch name is not the task's", () => {
  const w = world();
  const head = w.commit("b.txt");
  for (const kind of ["checks-pass", "review-clean", "qa-pass"]) w.sage("verdict", "T1", "--sha", head, "--kind", kind);
  writeFileSync(w.at("gh.json"), JSON.stringify([{ number: 1, head: "claude/t1", state: "OPEN", cross: true, owner: "stranger" }]));
  assert.equal(w.pr("create", "T1").stdout, `pushed ${short(head)} to claude/t1; opened https://github.com/owner/repo/pull/2; T1 has PR 2 in the logbook\n`);
  w.sage("task", "T1", "set", "pr=1"); // a logbook that names the fork's pull request
  w.forge("T1", "state", "verified");
  refused(w.pr("merge", "T1"), /pull request #1 is not a pull request of claude\/t1 into main in owner\/repo \(GitHub has no such pull request, or it is another branch's or a fork's\)/);
  assert.equal(w.calls().filter((c) => c.args[1] === "merge").length, 0);
});

test("T96-S5: SAGE_REPO that is not the GitHub origin's repository refuses before gh", () => {
  const w = world();
  for (const url of ["https://github.com/other/repo.git", "https://x-access-token:s3cret@github.com/other/repo.git", "git@github.com:other/repo.git"]) {
    w.p("remote", "set-url", "origin", url);
    const r = w.pr("view", "T1");
    refused(r, /SAGE_REPO is not the origin's repository other\/repo, so gh and git would act on two repositories\. Unset SAGE_REPO, or set it to other\/repo/);
    assert.doesNotMatch(r.stderr, /s3cret/);
  }
  assert.deepEqual(w.calls(), []);
  w.env.SAGE_REPO = "Other/Repo"; // GitHub's names ignore case
  const r = w.pr("view", "T1");
  assert.equal(r.status, 2, r.stderr); // a gh failure, not a refusal
  assert.equal(r.stderr, 'sage-pr: failed: gh pr view failed: no pull requests found for branch "claude/t1"\n');
  assert.deepEqual(w.calls().at(-1).args.slice(0, 3), ["pr", "view", "--repo=other/repo"], "gh gets the origin's repository");
});

test("T96-C2: create takes the task's own reviewed head, not a later verdict of another task of the same PR", () => {
  const w = world();
  const head = w.commit("b.txt");
  w.sage("verdict", "T1", "--sha", head, "--kind", "checks-pass");
  w.sage("task", "add", "--title", "Other", "--size", "small");
  w.sage("task", "T2", "set", "pr=1");
  w.sage("verdict", "T2", "--sha", w.p("rev-parse", "main"), "--kind", "checks-pass"); // later in the ledger, with PR 1
  const r = w.pr("create", "T1");
  assert.equal(r.stdout, `pushed ${short(head)} to claude/t1; opened https://github.com/owner/repo/pull/1; T1 has PR 1 in the logbook\n`, r.stderr);
  assert.equal(w.remote("refs/heads/claude/t1"), head);
});

test("T96-C4: merge takes the logbook's PR number, only when it is the open pull request of the branch into main", () => {
  const { w, head } = reviewed();
  const prs = JSON.parse(readFileSync(w.at("gh.json"), "utf8"));
  writeFileSync(w.at("gh.json"), JSON.stringify([...prs, { number: 2, head: "claude/t2", state: "OPEN" }, { number: 3, head: "claude/t1", base: "release", state: "OPEN" }]));
  const cases = [
    ["2", /pull request #2 is not a pull request of claude\/t1 into main in owner\/repo \(GitHub has no such pull request, or it is another branch's or a fork's\): run sage-pr create T1/],
    ["3", /pull request #3 is not a pull request of claude\/t1 into main in owner\/repo/],
    ["", /T1 has no PR number in the logbook: run sage-pr create T1, which records it/],
  ];
  for (const [n, why] of cases) {
    w.sage("task", "T1", "set", `pr=${n}`);
    refused(w.pr("merge", "T1"), why);
  }
  assert.equal(w.calls().filter((c) => c.args[1] === "merge").length, 0);
  w.sage("task", "T1", "set", "pr=1");
  assert.equal(w.pr("merge", "T1").status, 0);
  assert.deepEqual(w.calls().at(-2).args, ["pr", "merge", "--repo=owner/repo", "--squash", "--delete-branch", `--match-head-commit=${head}`, "--", "1"]);
});

test("T96-Q1: no logbook names the next step", () => {
  const w = world();
  w.env.SAGE_PROJECT = w.at("home");
  refused(w.pr("view", "T1"), /no logbook for the project .*\/home: run sage-pr from the project's main checkout, or set SAGE_PROJECT=<that folder>/);
});

test("T96-S8-STALEMERGED: merge says already merged only when GitHub merged the reviewed head", () => {
  const { w, head } = reviewed();
  const other = w.remote("refs/heads/main"); // a web merge of another commit
  w.github((prs) => [{ ...prs[0], state: "MERGED", oid: other }]);
  const stale = new RegExp(`^sage-pr: refused: pull request #1 merged ${short(other)}, not the reviewed head ${short(head)}: ask the user\n$`);
  refused(w.pr("merge", "T1"), stale);
  refused(w.pr("create", "T1"), stale);
  // A merge before a repair: the merged head is the one reviewed before, not the reviewed head now.
  const { w: w2, head: first } = reviewed();
  assert.equal(w2.pr("merge", "T1").status, 0);
  const repaired = w2.commit("c.txt");
  for (const kind of ["checks-pass", "review-clean", "qa-pass"]) w2.sage("verdict", "T1", "--sha", repaired, "--kind", kind);
  refused(w2.pr("merge", "T1"), new RegExp(`^sage-pr: refused: pull request #1 merged ${short(first)}, not the reviewed head ${short(repaired)}: ask the user\n$`));
  assert.equal(w2.calls().filter((c) => c.args[1] === "merge").length, 1, "one gh pr merge only");
  assert.equal(w2.remote("refs/heads/claude/t1"), "", "nothing pushed after the merge");
});

test("T96-R3-REOPEN: create after a merge (normal, or one that exited 3) refuses and opens no new pull request", () => {
  const already = /^sage-pr: refused: already merged as PR #1: nothing to create\. Mark the task merged: sage task T1 set state=merged\n$/;
  const { w } = reviewed();
  assert.equal(w.pr("merge", "T1").status, 0);
  refused(w.pr("create", "T1"), already);
  assert.equal(w.remote("refs/heads/claude/t1"), "", "the merged branch is not pushed again");
  assert.equal(w.task("T1").pr, "1");
  assert.equal(w.calls().filter((c) => c.args[1] === "create").length, 1);
  const { w: w3, head } = reviewed();
  const lock = join(w3.logbook, "mirror.git", "refs", "heads", "main.lock");
  writeFileSync(lock, "");
  assert.equal(w3.pr("merge", "T1").status, 3);
  refused(w3.pr("create", "T1"), already);
  rmSync(lock);
  const r = w3.pr("merge", "T1"); // what the exit-3 message says to do
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `already merged: claude/t1 at ${short(head)}; nothing to do; the mirror's main is now ${short(w3.remote("refs/heads/main"))}\n`);
  assert.equal(w3.calls().filter((c) => c.args[1] === "create").length, 1);
});

test("T165-H: the fake gh plays GitHub: a second open pull request of one branch fails with 422, and view of a branch takes the newest open one, else the newest", () => {
  const w = world();
  const gh = (...a) => {
    writeFileSync(w.at("bin", "fake.json"), JSON.stringify(w.env));
    return spawnSync(w.at("bin", "gh"), a, { encoding: "utf8", env: w.env, cwd: w.at("home") });
  };
  const create = ["pr", "create", "--repo=owner/repo", "--base=main", "--head=claude/t1", "--title=x", "--body-file=/dev/null"];
  assert.equal(gh(...create).stdout, "https://github.com/owner/repo/pull/1\n");
  const again = gh(...create);
  assert.equal(again.status, 1);
  assert.equal(again.stderr, "pull request create failed: GraphQL: A pull request already exists for owner:claude/t1. (createPullRequest)\n");
  const view = () => JSON.parse(gh("pr", "view", "--repo=owner/repo", "--json=number,state", "--", "claude/t1").stdout);
  w.github(() => [1, 2, 3].map((number) => ({ number, head: "claude/t1", state: number === 2 ? "OPEN" : "CLOSED" })));
  assert.deepEqual(view(), { number: 2, state: "OPEN" });
  w.github((prs) => prs.map((p) => ({ ...p, state: "CLOSED" })));
  assert.deepEqual(view(), { number: 3, state: "CLOSED" });
  const list = JSON.parse(gh("pr", "list", "--repo=owner/repo", "--head=claude/t1", "--base=main", "--state=all", "--json=number").stdout);
  assert.deepEqual(list, [{ number: 3 }, { number: 2 }, { number: 1 }], "newest first");
});

test("T96-S9-REDACTGAPS: gh's stderr loses a credential URL with no path, an Authorization line and each token's value", () => {
  const w = world();
  const head = w.commit("b.txt");
  w.sage("verdict", "T1", "--sha", head, "--kind", "checks-pass");
  Object.assign(w.env, { GH_TOKEN: "tokA-s3cret", GITHUB_TOKEN: "tokB-s3cret", GH_ENTERPRISE_TOKEN: "tokC-s3cret", GITHUB_ENTERPRISE_TOKEN: "tokD-s3cret" });
  w.env.FAKE_GH_FAIL = "list";
  const u = "https://user:s3cret@github.com";
  w.env.FAKE_GH_ERR = [`a ${u}`, `b ${u} c`, `d ${u}?x ${u}#y (${u}) ${u}.`, "Authorization: token s3cret-header", "> authorization: Bearer s3cret-bearer", "tokens tokA-s3cret tokB-s3cret tokC-s3cret tokD-s3cret"].join("\n");
  const r = w.pr("create", "T1");
  assert.equal(r.status, 2, r.stderr);
  const v = "https://***@github.com";
  assert.equal(r.stderr, `sage-pr: failed: gh pr list failed: a ${v}\nb ${v} c\nd ${v}?x ${v}#y (${v}) ${v}.\nAuthorization: ***\n> authorization: ***\ntokens *** *** *** ***\n`);
  assert.doesNotMatch(r.stderr, /s3cret/);
});

test("T96-R3-NEXTSTEP3: each refusal names the next step", () => {
  const w = world();
  const head = w.commit("b.txt");
  refused(w.pr("view", "T9"), /^sage-pr: refused: no task T9 in .*: check the task id, or frame the task first \(sage task add\)\n$/);
  const ledger = join(w.logbook, "ledger.tsv");
  writeFileSync(ledger, `${readFileSync(ledger, "utf8").trim()}\nT1\t\tabc1234\tchecks-pass\t1\t\t2026-10-05T00:00:00Z\n`);
  refused(w.pr("create", "T1"), /^sage-pr: refused: the reviewed head of T1 is not a full SHA: "abc1234"\. Record the verdict with the full SHA: sage verdict T1 --sha <40-character sha> --kind <kind>\n$/);
  w.sage("verdict", "T1", "--sha", head, "--kind", "checks-pass");
  rmSync(w.mirror, { recursive: true });
  writeFileSync(w.mirror, "");
  refused(w.pr("create", "T1"), /^sage-pr: refused: .*\/mirror\.git is not a folder: ask the user to remove it\n$/);
  w.p("remote", "remove", "origin");
  refused(w.pr("view", "T1"), /^sage-pr: refused: the project (.*\/project) has no origin remote: git -C \1 remote add origin <address>\n$/);
  assert.deepEqual(w.calls().map((c) => c.args[1]), ["list"], "only before the mirror check");
});

test("the script starts git and gh only through execFile with an argument array, never a shell", () => {
  const src = readFileSync(PR, "utf8");
  assert.deepEqual([...src.matchAll(/import \{([^}]*)\} from "node:child_process"/g)].map((m) => m[1].trim()), ["execFileSync"]);
  assert.doesNotMatch(src, /\bshell\s*:|\bexecSync\b|\bspawn(Sync)?\b|(?<![.\w])exec\(/);
  assert.deepEqual([...src.matchAll(/execFileSync\(("[^"]*")/g)].map((m) => m[1]), ['"gh"']); // git goes through sage.mjs git(), which is execFileSync too
});

/** A world with T1's head reviewed (checks only), not yet created. */
function ready() {
  const w = world();
  const head = w.commit("b.txt");
  w.sage("verdict", "T1", "--sha", head, "--kind", "checks-pass");
  return { w, head };
}
/** A script for git to run (fsmonitor, ssh, a hook) that only touches the marker file and fails. */
function toucher(w, name) {
  writeFileSync(w.at(`${name}.sh`), `#!/bin/sh\ntouch ${w.at(`${name}-RAN`)}\nexit 1\n`);
  chmodSync(w.at(`${name}.sh`), 0o755);
  return { script: w.at(`${name}.sh`), ran: () => existsSync(w.at(`${name}-RAN`)) };
}

test("T96-S11-BODYLINK: create writes nothing in the temp folder, so an agent's link there reaches no file", async () => {
  const { w } = ready();
  mkdirSync(w.at("agent-tmp"));
  w.env.TMPDIR = w.at("agent-tmp"); // the temp folder, which agents can write
  const victim = w.at("victim.txt");
  writeFileSync(victim, "the owner's file\n");
  // An agent that links body.md, in each new folder of the temp folder, to the owner's file (R615 E1).
  const stop = w.at("stop");
  const agent = spawn(process.execPath, ["-e", `const f = require("node:fs"), p = require("node:path"); const [tmp, target, stop] = process.argv.slice(1); const end = Date.now() + 30000; while (Date.now() < end && !f.existsSync(stop)) for (const n of f.readdirSync(tmp)) { try { f.symlinkSync(target, p.join(tmp, n, "body.md")); } catch {} }`, w.at("agent-tmp"), victim, stop], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 300));
  let r;
  try {
    r = w.pr("create", "T1");
  } finally {
    writeFileSync(stop, "");
    await new Promise((done) => agent.on("exit", done));
  }
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(victim, "utf8"), "the owner's file\n");
  for (const c of w.calls()) assert.match(c.cwd, new RegExp(`^${w.logbook.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\.sage-pr-[^/]+/gh-[^/]+$`), "gh runs in the script's folder in the logbook");
  assert.deepEqual(readdirSync(w.at("agent-tmp")), [], "the script made nothing in the temp folder");
  assert.deepEqual(readdirSync(w.logbook).filter((n) => n.startsWith(".sage-pr-")), [], "the script's folder is gone at the end");
});

test("T167: a .git that an agent plants one level above the logbook is not gh's repository, and its fsmonitor never runs", () => {
  const { w } = ready();
  const fsmonitor = toucher(w, "fsmonitor");
  w.git("init", "-q", w.at("agent-repo"));
  w.git("-C", w.at("agent-repo"), "config", "core.fsmonitor", fsmonitor.script);
  writeFileSync(w.at("sage", ".git"), `gitdir: ${w.at("agent-repo", ".git")}\n`); // in the sage root, above <logbook>/.sage-pr-*/gh-*
  const r = w.pr("create", "T1");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(w.calls().map((c) => c.repo), ["none", "none"], "git finds no repository in gh's folder");
  assert.equal(fsmonitor.ran(), false);
  // The fake's git does find the planted repository from the logbook folder when nothing stops it: the check above can fail.
  const probe = spawnSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: w.logbook, encoding: "utf8", env: { PATH: process.env.PATH, HOME: w.at("home") } });
  assert.equal(probe.stdout.trim(), w.at("agent-repo", ".git"));
});

test("T96-S13-ENV: git and gh get only the allow-listed variables: GIT_CONFIG_*, GH_HOST, GH_REPO, a proxy and other tokens drop", () => {
  const { w, head } = ready();
  w.git("init", "-q", "--bare", w.at("evil.git"));
  const hook = toucher(w, "hook");
  mkdirSync(w.at("hooks"));
  for (const h of ["reference-transaction", "pre-push"]) writeFileSync(w.at("hooks", h), readFileSync(hook.script)), chmodSync(w.at("hooks", h), 0o755);
  Object.assign(w.env, {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `url.${w.at("evil.git")}.pushInsteadOf`, // R615 E4b: the push went to evil.git while the script said "pushed"
    GIT_CONFIG_VALUE_0: w.at("remote.git"),
    GIT_CONFIG_PARAMETERS: `'core.hookspath'='${w.at("hooks")}' 'url.${w.at("evil.git")}.insteadof'='${w.at("remote.git")}'`,
    GH_HOST: "ghe.example.invalid",
    GH_REPO: "evil/other",
    HTTPS_PROXY: "http://127.0.0.1:9",
    GH_ENTERPRISE_TOKEN: "dummy-enterprise",
    SOME_OTHER: "x",
  });
  const r = w.pr("create", "T1");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(w.remote("refs/heads/claude/t1"), head, "the push reached the origin");
  assert.equal(w.git("--git-dir", w.at("evil.git"), "for-each-ref"), "", "nothing reached evil.git");
  assert.equal(hook.ran(), false);
  const passed = /^(?:LANG|LC_[A-Z]+|SSH_AUTH_SOCK|CLAUDE_CONFIG_DIR|NODE_TEST_CONTEXT|__CF_USER_TEXT_ENCODING)$/; // kept when the test's environment has them; macOS adds the last to each process
  for (const c of w.calls())
    assert.deepEqual(c.keys.filter((k) => !passed.test(k)), [
      "GH_CONFIG_DIR", "GH_NO_UPDATE_NOTIFIER", "GH_PROMPT_DISABLED", "GH_TOKEN",
      "GIT_CEILING_DIRECTORIES", "GIT_CONFIG_COUNT", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_KEY_0", "GIT_CONFIG_KEY_1", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_VALUE_0", "GIT_CONFIG_VALUE_1", "GIT_DIR",
      "HOME", "PATH", "SAGE_HOME", "SAGE_PROJECT", "SAGE_REPO", "SAGE_TEST_KILLS", "SAGE_TEST_PIDS", "SAGE_WORKTREES", "TMPDIR",
    ]);
});

test("T96-S13-SSH: GIT_SSH_COMMAND does not reach git; an ssh origin goes through ssh on PATH", () => {
  const { w } = ready();
  w.p("remote", "set-url", "origin", "ssh://git@github.com/owner/repo.git");
  const planted = toucher(w, "ssh-command");
  const onPath = toucher(w, "ssh"); // the stand-in for ssh: no test reaches GitHub
  writeFileSync(w.at("bin", "ssh"), readFileSync(onPath.script));
  chmodSync(w.at("bin", "ssh"), 0o755);
  w.env.GIT_SSH_COMMAND = planted.script; // R615 E4d
  const r = w.pr("create", "T1");
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.stderr, "sage-pr: failed: git fetch failed with exit 128\n");
  assert.equal(planted.ran(), false);
  assert.equal(onPath.ran(), true, "git ran ssh from PATH");
});

test("T96-S13-NODEOPTIONS: NODE_OPTIONS refuses before any git or gh", () => {
  const { w } = ready();
  w.env.NODE_OPTIONS = "--no-warnings";
  refused(w.pr("create", "T1"), /^sage-pr: refused: NODE_OPTIONS is set, and it can run code inside the script\. Run sage-pr without it: env -u NODE_OPTIONS node sage-pr\.mjs <verb> <task>\n$/);
  assert.deepEqual(w.calls(), []);
  assert.equal(w.mirrored(), "");
});

test("T96-S14-PARENTLINK: a bundle whose folder is a link to another place refuses", () => {
  const { w } = ready();
  const folder = join(w.at("worktrees"), basename(w.logbook));
  mkdirSync(w.at("elsewhere"));
  renameSync(folder, w.at("elsewhere", "moved")); // R615 E3
  symlinkSync(w.at("elsewhere", "moved"), folder);
  refused(w.pr("create", "T1"), /^sage-pr: refused: the bundle's folder .* is a link to .*\/elsewhere\/moved, not a folder in the worktree root: remove the link, then write the bundle with git bundle create .*\/T1\.bundle main\.\.claude\/t1\n$/);
  assert.deepEqual(w.calls(), []);
});

test("T96-S14-FETCHHEAD: the mirror keeps no FETCH_HEAD, which would hold the origin's address", () => {
  const { w } = reviewed();
  assert.equal(existsSync(join(w.logbook, "mirror.git", "FETCH_HEAD")), false, "after create");
  assert.equal(w.pr("merge", "T1").status, 0);
  assert.equal(existsSync(join(w.logbook, "mirror.git", "FETCH_HEAD")), false, "after merge");
});

test("T96-S14-CREDHELPER: a credential helper in the mirror's config never runs; github.com's credentials come from gh", async () => {
  const { w } = reviewed();
  // A local https origin that asks for a password (401), so that git looks for a credential helper.
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", w.at("key.pem"), "-out", w.at("cert.pem")], { stdio: "ignore" });
  const server = spawn(process.execPath, ["-e", `const f = require("node:fs"); const [key, cert, port] = process.argv.slice(1); const s = require("node:https").createServer({ key: f.readFileSync(key), cert: f.readFileSync(cert) }, (q, a) => { a.writeHead(401, { "WWW-Authenticate": 'Basic realm="t"' }); a.end(); }); s.listen(0, "127.0.0.1", () => f.writeFileSync(port, String(s.address().port))); setTimeout(() => process.exit(0), 30000);`, w.at("key.pem"), w.at("cert.pem"), w.at("port")], { stdio: "ignore" });
  try {
    for (let i = 0; i < 100 && !existsSync(w.at("port")); i++) await new Promise((r) => setTimeout(r, 50));
    w.route(`https://127.0.0.1:${readFileSync(w.at("port"), "utf8")}/owner/repo.git`);
    const helper = toucher(w, "helper");
    const config = join(w.logbook, "mirror.git", "config");
    writeFileSync(config, `${readFileSync(config, "utf8")}[http]\n\tsslCAInfo = ${w.at("cert.pem")}\n[credential]\n\thelper = !${helper.script}\n`); // R615 E6
    const r = w.pr("create", "T1");
    assert.equal(r.stderr, "sage-pr: failed: git fetch failed with exit 128\n");
    assert.equal(helper.ran(), false, "the mirror's helper did not run");
  } finally {
    server.kill();
  }
  // The same settings send github.com's credentials to gh's login: git credential asks the fake gh.
  const { clean } = await import(PR);
  const fill = spawnSync("git", ["-C", join(w.logbook, "mirror.git"), "credential", "fill"], { input: "protocol=https\nhost=github.com\n\n", encoding: "utf8", env: { ...clean(w.env), GIT_TERMINAL_PROMPT: "0" } });
  assert.notEqual(fill.status, 0, "the fake gh gives no password");
  assert.deepEqual(w.calls().at(-1).args, ["auth", "git-credential", "get"]);
});

/** A refusal of the state tool: exit 1, and stderr matches why. */
function toolRefused(w, why, ...a) {
  const r = spawnSync("node", [TOOL, ...a, "--project", w.at("project")], { encoding: "utf8", env: w.env, timeout });
  assert.equal(r.status, 1, `exit ${r.status}: ${r.stdout}${r.stderr}`);
  assert.match(r.stderr, why);
}

test("T165-A: a recorded PR number that GitHub does not have counts as none in create, and merge refuses it with the fix", () => {
  const w = world();
  const head = w.commit("b.txt");
  for (const kind of ["checks-pass", "review-clean", "qa-pass"]) w.sage("verdict", "T1", "--sha", head, "--kind", kind);
  w.forge("T1", "state", "verified");
  w.sage("task", "T1", "set", "pr=7");
  refused(w.pr("merge", "T1"), /^sage-pr: refused: pull request #7 is not a pull request of claude\/t1 into main in owner\/repo \(GitHub has no such pull request, or it is another branch's or a fork's\): run sage-pr create T1, which records the task's own, or sage task T1 set pr=<n>\n$/);
  const r = w.pr("create", "T1");
  assert.equal(r.stdout, `pushed ${short(head)} to claude/t1; opened https://github.com/owner/repo/pull/1; T1 has PR 1 in the logbook, not PR 7\n`, r.stderr);
  assert.equal(w.task("T1").pr, "1");
  assert.equal(w.pr("merge", "T1").status, 0);
});

test("T165-B: a merge before the repair is pushed refuses and names create", () => {
  const { w, head } = reviewed();
  const repaired = w.commit("c.txt");
  for (const kind of ["checks-pass", "review-clean", "qa-pass"]) w.sage("verdict", "T1", "--sha", repaired, "--kind", kind);
  refused(w.pr("merge", "T1"), new RegExp(`^sage-pr: refused: pull request #1 is at ${short(head)}, not at the reviewed head ${short(repaired)}\\. If ${short(repaired)} is a repair, push it first: sage-pr create T1\\. Else the branch moved after review: review ${short(head)} and record its verdicts\n$`));
  assert.equal(w.calls().filter((c) => c.args[1] === "merge").length, 0);
  assert.equal(w.pr("create", "T1").status, 0);
  const r = w.pr("merge", "T1");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`^merged claude/t1 at ${short(repaired)}`));
});

test("T165-C: redaction hides a user and password with punctuation, and quoted or key=value Authorization forms", () => {
  const { w } = ready();
  w.env.FAKE_GH_FAIL = "list";
  w.env.FAKE_GH_ERR = ["a https://us(er:pa)ss@github.com/x", `b git clone us"er:p'w@host:path`, `"Authorization": "Bearer s3cret-a"`, "authorization=token s3cret-b", "{'authorization': 'Basic s3cret-c'}", "-c http.extraheader=Authorization: Bearer s3cret-d"].join("\n");
  const r = w.pr("create", "T1");
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.stderr, `sage-pr: failed: gh pr list failed: a https://***@github.com/x\nb git clone ***@host:path\n"Authorization": ***\nauthorization= ***\n{'authorization': ***\n-c http.extraheader=Authorization: ***\n`);
  assert.doesNotMatch(r.stderr, /s3cret|er:pa|p'w/);
});

test("T165-D: a merge that GitHub only queued is no success; merge again after GitHub merged it says already merged", () => {
  const { w, head } = reviewed();
  w.env.FAKE_GH_QUEUE = "1";
  let r = w.pr("merge", "T1");
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.stderr, `sage-pr: failed: gh pr merge ran, but pull request #1 is OPEN at ${short(head)}, not merged at ${short(head)}: GitHub may have queued it (a merge queue or auto-merge). Run sage-pr merge T1 again later: it reports "already merged" once GitHub has merged it\n`);
  delete w.env.FAKE_GH_QUEUE;
  w.github((prs) => [{ ...prs[0], state: "MERGED", oid: head }]); // the queue merged it
  r = w.pr("merge", "T1");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`^already merged: claude/t1 at ${short(head)}; nothing to do`));
});

test("T165-E: with an empty PR cell, create finds a merged pull request of the branch and opens none", () => {
  const { w, head } = ready();
  writeFileSync(w.at("gh.json"), JSON.stringify([{ number: 1, head: "claude/t1", state: "MERGED", oid: head }])); // merged on the web; the logbook has no PR
  refused(w.pr("create", "T1"), /^sage-pr: refused: already merged as PR #1: nothing to create\. Mark the task merged: sage task T1 set state=merged\n$/);
  w.github(() => [{ number: 1, head: "claude/t1", state: "MERGED", oid: w.remote("refs/heads/main") }]);
  refused(w.pr("create", "T1"), new RegExp(`^sage-pr: refused: pull request #1 merged ${short(w.remote("refs/heads/main"))}, not the reviewed head ${short(head)}: ask the user\n$`));
  assert.equal(w.remote("refs/heads/claude/t1"), "", "nothing pushed");
  assert.equal(w.calls().filter((c) => c.args[1] === "create").length, 0);
});

test("T165-F: the state tool and the PR script take one PR-number rule: no leading zero, no 0", () => {
  const { w } = ready();
  for (const n of ["01", "0", "007"]) toolRefused(w, new RegExp(`^sage: "${n}" is not a pull request number`), "task", "T1", "set", `pr=${n}`);
  toolRefused(w, /--pr is the pull request's number/, "merge-check", "--sha", "a".repeat(40), "--pr", "01");
  w.sage("task", "T1", "set", "pr=10");
  assert.equal(w.task("T1").pr, "10");
});

test("T165-I: a lock or disk error on the bundle fetch or the ancestor check is a failure (exit 2), not a refusal", () => {
  const { w, head } = ready();
  mkdirSync(join(w.mirror, "refs", "sage"), { recursive: true });
  writeFileSync(join(w.mirror, "refs", "sage", "T1.lock"), ""); // another git holds the ref
  let r = w.pr("create", "T1");
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.stderr, "sage-pr: failed: git fetch failed with exit 1\n");
  rmSync(join(w.mirror, "refs", "sage", "T1.lock"));
  // git on PATH that fails merge-base as a disk error does (exit 128), while the commits are there.
  const real = process.env.PATH.split(delimiter).map((d) => join(d, "git")).find((f) => existsSync(f));
  writeFileSync(w.at("bin", "git"), `#!/usr/bin/env node\nconst { existsSync } = require("node:fs");\nconst args = process.argv.slice(2);\nif (args.includes("merge-base") && existsSync(__dirname + "/fail-merge-base")) { console.error("fatal: read error: Input/output error"); process.exit(128); }\nprocess.exit(require("node:child_process").spawnSync(${JSON.stringify(real)}, args, { stdio: "inherit" }).status ?? 1);\n`);
  chmodSync(w.at("bin", "git"), 0o755);
  writeFileSync(w.at("bin", "fail-merge-base"), "");
  r = w.pr("create", "T1");
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.stderr, "sage-pr: failed: git merge-base failed with exit 128\n");
  assert.equal(w.remote("refs/heads/claude/t1"), "", "nothing pushed");
  rmSync(w.at("bin", "fail-merge-base"));
  r = w.pr("create", "T1");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(w.remote("refs/heads/claude/t1"), head);
});

test("T165-J: create removes a stale folder of an earlier run and an old FETCH_HEAD in the mirror", () => {
  const { w } = ready();
  mkdirSync(join(w.logbook, ".sage-pr-Stale1"));
  writeFileSync(join(w.logbook, ".sage-pr-Stale1", "body.md"), "old\n");
  writeFileSync(join(w.mirror, "FETCH_HEAD"), "0000000000000000000000000000000000000000\t\tbranch 'main' of https://user:s3cret@github.com/owner/repo\n");
  const r = w.pr("create", "T1");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readdirSync(w.logbook).filter((n) => n.startsWith(".sage-pr-")), []);
  assert.equal(existsSync(join(w.mirror, "FETCH_HEAD")), false);
});

test("T165-K: the bundle opens relative to the folder that the script checked, so a swap of the folder after the check reaches nothing", async () => {
  const { w } = ready();
  const { copyBundle } = await import(PR);
  const folder = dirname(w.bundle);
  mkdirSync(w.at("elsewhere"));
  writeFileSync(w.at("elsewhere", "T1.bundle"), readFileSync(w.bundle)); // the agent's good-looking bundle in another place
  rmSync(w.bundle); // the checked folder has none
  const fs = createRequire(import.meta.url)("node:fs");
  const original = fs.realpathSync;
  let swapped = false;
  // Right after the script resolves the bundle's folder, the folder moves away and a link to the other place takes its name.
  fs.realpathSync = Object.assign((path, options) => {
    const out = original(path, options);
    if (!swapped && out === folder) {
      swapped = true;
      renameSync(folder, w.at("moved"));
      symlinkSync(w.at("elsewhere"), folder);
    }
    return out;
  }, { native: original.native });
  syncBuiltinESMExports();
  const temp = mkdtempSync(join(w.logbook, ".k-"));
  try {
    assert.throws(() => copyBundle(w.bundle, temp, "claude/t1", w.at("worktrees")), /^Error: refused: no bundle at .*T1\.bundle: write it with git bundle create/);
  } finally {
    fs.realpathSync = original;
    syncBuiltinESMExports();
  }
  assert.equal(swapped, true, "the swap happened after the check");
  assert.equal(existsSync(join(temp, "task.bundle")), false, "nothing copied from the other place");
});

test("T165-L: a held lock in a test asks the fake liveness probe (SAGE_TEST_PIDS), never a real pid", () => {
  const { w, head } = ready();
  mkdirSync(join(w.logbook, ".lock"));
  writeFileSync(join(w.logbook, ".lock", "00000000-0000-4000-8000-000000000001.json"), JSON.stringify({ pid: 424242, host: hostname(), start: Date.now() - 1000, at: Date.now() }));
  w.env.SAGE_TEST_PIDS = JSON.stringify({ 424242: null }); // the holder is gone
  const r = w.pr("create", "T1");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(w.remote("refs/heads/claude/t1"), head);
  assert.equal(w.kills(), "", "no process.kill reached a pid");
  assert.equal(existsSync(w.at("ps-RAN")), false, "no ps ran");
});

test("T165-M: create writes body.md new (wx), never through a planted link, and with mode 0600", async () => {
  const { w } = ready();
  const r = w.pr("create", "T1");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(w.calls().find((c) => c.args[1] === "create").bodyMode, "600");
  // In the process: a body.md that is there before the write (a link to the owner's file) makes create fail.
  const w2 = ready().w;
  const victim = w2.at("victim.txt");
  writeFileSync(victim, "the owner's file\n");
  writeFileSync(w2.at("bin", "fake.json"), JSON.stringify(w2.env));
  const { sagePr } = await import(PR);
  const fs = createRequire(import.meta.url)("node:fs");
  const original = fs.mkdtempSync;
  fs.mkdtempSync = (prefix, options) => {
    const made = original(prefix, options);
    if (basename(prefix) === ".sage-pr-") symlinkSync(victim, join(made, "body.md"));
    return made;
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => sagePr(["create", "T1"], w2.env), /EEXIST/);
  } finally {
    fs.mkdtempSync = original;
    syncBuiltinESMExports();
  }
  assert.equal(readFileSync(victim, "utf8"), "the owner's file\n");
  assert.equal(w2.calls().filter((c) => c.args[1] === "create").length, 0);
});

test("T166-A: a gh merge that fails after GitHub merged (a branch deletion that gets 403) is a merge: exit 0, or 3 when the refresh fails", () => {
  const { w, head } = reviewed();
  w.env.FAKE_GH_MERGE_THEN_FAIL = "1";
  const r = w.pr("merge", "T1");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `merged claude/t1 at ${short(head)} (GitHub merged it, but gh pr merge failed: failed to delete remote branch claude/t1: HTTP 403: Resource not accessible by integration); the mirror's main is now ${short(w.remote("refs/heads/main"))}\n`);
  const { w: w2, head: head2 } = reviewed();
  w2.env.FAKE_GH_MERGE_THEN_FAIL = "1";
  writeFileSync(join(w2.mirror, "refs", "heads", "main.lock"), "");
  const r2 = w2.pr("merge", "T1");
  assert.equal(r2.status, 3, r2.stderr);
  assert.match(r2.stderr, new RegExp(`^sage-pr: merged claude/t1 at ${short(head2)} \\(GitHub merged it, but gh pr merge failed: .*\\); the mirror refresh failed: git fetch failed with exit 1\\.`));
});

test("T166-B: a work folder that the script cannot remove gives a warning on stderr and keeps the exit code", () => {
  const { w, head } = ready();
  w.env.FAKE_GH_STICK = "1";
  const r = w.pr("create", "T1");
  try {
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `pushed ${short(head)} to claude/t1; opened https://github.com/owner/repo/pull/1; T1 has PR 1 in the logbook\n`);
    assert.match(r.stderr, /^sage-pr: warning: could not remove .*\/\.sage-pr-[^/ ]+ \((?:EACCES|ENOTEMPTY)\): remove it by hand\n$/);
  } finally {
    for (const name of readdirSync(w.logbook).filter((n) => n.startsWith(".sage-pr-"))) for (const g of readdirSync(join(w.logbook, name))) chmodSync(join(w.logbook, name, g), 0o755);
  }
});

test("T168: merge refuses a task that is not verified or pr-ready; an already merged pull request at the reviewed head still exits 0", () => {
  const { w, head } = reviewed();
  w.forge("T1", "state", "reviewing");
  refused(w.pr("merge", "T1"), /^sage-pr: refused: T1 is reviewing, not verified or pr-ready: merge only a task whose route is done\. When it is: sage task T1 set state=verified\n$/);
  assert.equal(w.calls().filter((c) => c.args[1] === "merge").length, 0);
  w.forge("T1", "state", "pr-ready");
  const ready = w.pr("merge", "T1");
  assert.equal(ready.status, 0, ready.stderr);
  assert.match(ready.stdout, new RegExp(`^merged claude/t1 at ${short(head)}`));
  w.forge("T1", "state", "merged");
  const r = w.pr("merge", "T1");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`^already merged: claude/t1 at ${short(head)}; nothing to do`));
});

test("T169: a call waits for the logbook's lock before it uses the mirror, and fails when the lock stays held", () => {
  const { w } = ready();
  mkdirSync(join(w.logbook, ".lock"));
  writeFileSync(join(w.logbook, ".lock", "00000000-0000-4000-8000-000000000002.json"), JSON.stringify({ pid: 424243, host: hostname(), start: Date.now() - 1000, at: Date.now() })); // alive: SAGE_TEST_PIDS is {}
  const r = w.pr("create", "T1");
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /^sage-pr: failed: the logbook is busy: pid 424243 on .* has held .*\/\.lock for [0-9.]+ s\. Nothing changed\. Run the command again/);
  assert.deepEqual(w.calls(), []);
  assert.equal(w.mirrored(), "", "the mirror is untouched");
  assert.equal(w.remote("refs/heads/claude/t1"), "");
  assert.equal(w.kills(), "");
});

test("T170: the project must be the logbook's checkout, outside the worktree root, with a GitHub origin that SAGE_REPO names", async () => {
  const { w, head } = ready();
  const { storeDir } = await import(TOOL);
  w.git("init", "-q", "--bare", w.at("evil.git"));
  w.p("push", "-q", w.at("evil.git"), "main");
  /** A folder of the agent's with origin evil.git, whose logbook key leads to the project's logbook (a collision), and the bundle there. */
  const plant = (folder) => {
    mkdirSync(folder, { recursive: true });
    w.git("init", "-q", folder);
    w.git("-C", folder, "remote", "add", "origin", w.at("evil.git"));
    const key = storeDir(folder, { SAGE_HOME: w.at("sage") });
    symlinkSync(w.logbook, key);
    mkdirSync(join(w.at("worktrees"), basename(key)), { recursive: true });
    writeFileSync(join(w.at("worktrees"), basename(key), "T1.bundle"), readFileSync(w.bundle));
  };
  plant(w.at("collide"));
  w.env.SAGE_PROJECT = w.at("collide");
  refused(w.pr("create", "T1"), new RegExp(`^sage-pr: refused: the logbook .* is the logbook of ${w.at("project")}, not of ${w.at("collide")}: run sage-pr from ${w.at("project")}, or set SAGE_PROJECT=${w.at("project")}\n$`));
  plant(w.at("worktrees", "project", "start"));
  w.env.SAGE_PROJECT = w.at("worktrees", "project", "start");
  refused(w.pr("create", "T1"), /^sage-pr: refused: the project .*\/worktrees\/project\/start is in the worktree root .*\/worktrees, where agents write: run sage-pr from the project's main checkout, or set SAGE_PROJECT=<that folder>\n$/);
  w.env.SAGE_PROJECT = w.at("project");
  w.p("remote", "set-url", "origin", w.at("evil.git")); // SAGE_REPO=owner/repo is set, but the origin is not GitHub
  refused(w.pr("create", "T1"), /^sage-pr: refused: the origin of .*\/project is not a GitHub repository, and sage-pr pushes only to GitHub/);
  assert.equal(w.git("--git-dir", w.at("evil.git"), "for-each-ref", "refs/heads/claude"), "", "nothing reached evil.git");
  assert.deepEqual(w.calls(), []);
  w.p("remote", "set-url", "origin", ORIGIN);
  assert.equal(w.pr("create", "T1").status, 0);
  assert.equal(w.remote("refs/heads/claude/t1"), head);
});
