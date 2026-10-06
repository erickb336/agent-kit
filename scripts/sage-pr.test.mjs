// Runs the PR script as the chief does, against a local bare repository that stands in for GitHub and a fake gh first
// on PATH that records its arguments and its folder. HOME, GH_CONFIG_DIR, the sage root and the worktree root are temp
// folders, and GH_TOKEN is a dummy, so no test reaches GitHub or reads the owner's token.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const TOOL = fileURLToPath(new URL("../plugins/sage/skills/sage/sage.mjs", import.meta.url));
const PR = fileURLToPath(new URL("../plugins/sage/skills/sage/sage-pr.mjs", import.meta.url));
const timeout = 20_000;

/**
 * The fake gh: it records each call (arguments, folder, the folder's entries, token, config folder) and plays GitHub's
 * pull requests on the bare repository. A pull request in FAKE_GH_STATE may have base (default main), cross (from a fork)
 * and owner (its head repository's owner, default "owner"); its headRefOid is oid (set by merge), else the branch's tip in the
 * bare repository. view and merge take a number or a branch after --.
 * FAKE_GH_FAIL names a call (create, merge, ...) that fails like GitHub, with FAKE_GH_ERR on stderr; FAKE_GH_CREATE_OUT
 * replaces create's answer.
 */
const FAKE_GH = `#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const env = process.env, args = process.argv.slice(2);
appendFileSync(env.FAKE_GH_LOG, JSON.stringify({ args, cwd: process.cwd(), entries: readdirSync(process.cwd()), token: env.GH_TOKEN, config: env.GH_CONFIG_DIR }) + "\\n");
const prs = existsSync(env.FAKE_GH_STATE) ? JSON.parse(readFileSync(env.FAKE_GH_STATE, "utf8")) : [];
const save = () => writeFileSync(env.FAKE_GH_STATE, JSON.stringify(prs));
const flag = (n) => args.find((a) => a.startsWith("--" + n + "="))?.slice(n.length + 3);
const after = args[args.indexOf("--") + 1];
const bare = (...a) => execFileSync("git", ["--git-dir", env.FAKE_GH_BARE, ...a], { encoding: "utf8" }).trim();
const url = (n) => "https://github.com/owner/repo/pull/" + n;
const tip = (b) => { try { return bare("rev-parse", "--verify", "-q", "refs/heads/" + b); } catch { return ""; } };
const json = (p) => { const all = { number: p.number, state: p.state, url: url(p.number), baseRefName: p.base ?? "main", headRefName: p.head, headRefOid: p.oid ?? tip(p.head), isCrossRepository: !!p.cross, headRepositoryOwner: { login: p.owner ?? "owner" } }; return Object.fromEntries(flag("json").split(",").filter((k) => k in all).map((k) => [k, all[k]])); };
if (args[1] === env.FAKE_GH_FAIL) { console.error(env.FAKE_GH_ERR ?? "HTTP 502: Bad Gateway (https://api.github.com/graphql)"); process.exit(1); }
const pick = () => prs.find((x) => (/^[0-9]+$/.test(after) ? x.number === Number(after) : x.head === after));
if (args[1] === "list") console.log(JSON.stringify(prs.filter((p) => p.head === flag("head") && (p.base ?? "main") === flag("base") && p.state === "OPEN").map(json)));
else if (args[1] === "create") { prs.push({ number: prs.length + 1, head: flag("head"), base: flag("base"), state: "OPEN" }); save(); console.log(env.FAKE_GH_CREATE_OUT ?? url(prs.length)); }
else if (args[1] === "view") { const p = pick(); if (!p) { console.error("no pull requests found for " + after); process.exit(1); } console.log(JSON.stringify(json(p))); }
else if (args[1] === "merge") {
  const p = pick();
  if (!p || p.state !== "OPEN" || bare("rev-parse", "refs/heads/" + p.head) !== flag("match-head-commit")) { console.error("head mismatch"); process.exit(1); }
  const squash = bare("commit-tree", flag("match-head-commit") + "^{tree}", "-p", "refs/heads/main", "-m", "squash");
  bare("update-ref", "refs/heads/main", squash); bare("update-ref", "-d", "refs/heads/" + p.head);
  p.state = "MERGED"; p.oid = flag("match-head-commit"); save();
} else process.exit(3);
`;

/**
 * One project in temp folders: a GitHub stand-in (bare repository), a main checkout with origin set to it, a logbook with
 * task T1 on branch claude/t1, and the fake gh. Each helper runs one program with an argument array.
 */
function world() {
  const t = realpathSync(mkdtempSync(join(tmpdir(), "sage-pr-test-")));
  const at = (...p) => join(t, ...p);
  for (const d of ["home", "gh-config", "sage", "worktrees", "bin"]) mkdirSync(at(d));
  writeFileSync(at("bin", "gh"), FAKE_GH);
  chmodSync(at("bin", "gh"), 0o755);
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
  const pr = (...a) => spawnSync("node", [PR, ...a], { encoding: "utf8", env, cwd: at("home"), timeout });
  git("init", "-q", "--bare", "-b", "main", at("remote.git"));
  git("init", "-q", "-b", "main", at("project"));
  writeFileSync(at("project", "a.txt"), "a\n");
  p("add", "a.txt");
  p("commit", "-q", "-m", "a");
  p("remote", "add", "origin", at("remote.git"));
  p("push", "-q", "origin", "main");
  sage("init");
  sage("task", "add", "--title", "Add b", "--size", "small");
  sage("task", "T1", "set", "branch=claude/t1");
  p("checkout", "-q", "-b", "claude/t1");
  const logbook = sage("logbook").trim();
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
  return { at, env, git, p, sage, pr, logbook, bundle, commit, calls, remote, task, forge, github };
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
    ["pr", "list", "--repo=owner/repo", "--head=claude/t1", "--base=main", "--state=open", "--json=number,url,isCrossRepository,headRepositoryOwner"],
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
  assert.deepEqual(w.calls().at(-1).args, ["pr", "merge", "--repo=owner/repo", "--squash", "--delete-branch", `--match-head-commit=${head}`, "--", "1"]);
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
  assert.equal(existsSync(join(w.logbook, "mirror.git")), false);
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
  assert.deepEqual(w.calls(), []);
});

test("a bundle whose tip is not the reviewed head refuses", () => {
  const w = world();
  const head = w.commit("b.txt");
  w.sage("verdict", "T1", "--sha", head, "--kind", "checks-pass");
  const extra = w.commit("unreviewed.txt");
  refused(w.pr("create", "T1"), new RegExp(`the bundle tip ${extra.slice(0, 7)} is not the reviewed head ${head.slice(0, 7)}\\. Review ${extra.slice(0, 7)} and record its verdicts, or write the bundle with claude/t1 at ${head.slice(0, 7)}: git bundle create .*T1\\.bundle main\\.\\.claude/t1$`, "m"));
  assert.equal(w.remote("refs/heads/claude/t1"), "");
  assert.deepEqual(w.calls(), []);
});

test("a forged branch in the logbook: the base branch or a branch outside the task's pattern refuses", () => {
  const w = world();
  const head = w.commit("b.txt");
  w.sage("verdict", "T1", "--sha", head, "--kind", "checks-pass");
  const tasks = join(w.logbook, "tasks.tsv");
  const text = readFileSync(tasks, "utf8");
  const cases = [
    ["main", /branch "main" is the base branch: sage task T1 set branch=claude\/t1$/m],
    ["refs/heads/main", /branch "refs\/heads\/main" is the base branch/],
    ["MAIN", /branch "MAIN" is the base branch/],
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
  assert.deepEqual(w.calls(), []);
});

test("create and merge need a reviewed head; a task without one refuses", () => {
  const w = world();
  w.commit("b.txt");
  refused(w.pr("create", "T1"), /T1 has no verdict with a SHA, so it has no reviewed head: record the route's verdicts on the reviewed head \(sage verdict T1 --sha <sha> --kind <kind>\)$/m);
  refused(w.pr("merge", "T1"), /T1 has no verdict with a SHA/);
  assert.deepEqual(w.calls(), []);
});

const short = (sha) => sha.slice(0, 7);
/** World with T1's head reviewed clean (checks, review and QA) and its pull request opened by create. */
function reviewed() {
  const w = world();
  const head = w.commit("b.txt");
  for (const kind of ["checks-pass", "review-clean", "qa-pass"]) w.sage("verdict", "T1", "--sha", head, "--kind", kind);
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
  refused(w.pr("merge", "T1"), /pull request #1 is not the open pull request of claude\/t1 into main in owner\/repo: it is CLOSED, from claude\/t1 into main\. Give T1 its own PR: sage task T1 set pr=<n>$/m);
  w.github((prs) => [{ ...prs[0], state: "MERGED", head: "claude/t2" }]);
  refused(w.pr("merge", "T1"), /pull request #1 is not the open pull request .*: it is MERGED, from claude\/t2 into main\./);
  w.github((prs) => [{ ...prs[0], state: "MERGED", head: "claude/t1", cross: true }]);
  refused(w.pr("merge", "T1"), /it is MERGED, from another repository's claude\/t1 into main\./);
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
  w.env.FAKE_GH_FAIL = "merge";
  delete w.env.FAKE_GH_ERR;
  r = w.pr("merge", "T1");
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.stderr, "sage-pr: failed: gh pr merge failed: HTTP 502: Bad Gateway (https://api.github.com/graphql). If GitHub says that the head changed, the branch moved after review: review the new head and record its verdicts\n");
  delete w.env.FAKE_GH_FAIL;
  const moved = w.git("--git-dir", w.at("remote.git"), "commit-tree", `${head}^{tree}`, "-p", head, "-m", "moved");
  w.git("--git-dir", w.at("remote.git"), "update-ref", "refs/heads/claude/t1", moved);
  r = w.pr("merge", "T1");
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.stderr, "sage-pr: failed: gh pr merge failed: head mismatch. If GitHub says that the head changed, the branch moved after review: review the new head and record its verdicts\n");
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
    refused(r, /^sage-pr: refused: the origin of .*\/project is not a GitHub repository; set SAGE_REPO=<owner>\/<name>\n$/);
    assert.doesNotMatch(r.stderr, /s3cret|gitlab|user/);
  }
  w.p("remote", "set-url", "origin", w.at("remote.git"));
  for (const repo of ["https://user:s3cret@github.com/o/r", "o/r@s3cret", "user:s3cret@github.com:o/r"]) {
    w.env.SAGE_REPO = repo;
    const r = w.pr("view", "T1");
    refused(r, /^sage-pr: refused: SAGE_REPO is not <owner>\/<name>: set it to the repository's owner and name only, such as SAGE_REPO=octo\/app\n$/);
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
  w.p("remote", "set-url", "origin", `${w.at("nowhere")}//user:s3cret-token@host/repo.git`); // a local path: the fetch fails with no network
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
  refused(w.pr("merge", "T1"), /pull request #1 is not the open pull request of claude\/t1 into main in owner\/repo: it is OPEN, from another repository's claude\/t1 into main/);
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
  assert.equal(r.stderr, "sage-pr: failed: gh pr view failed: no pull requests found for claude/t1\n");
  assert.deepEqual(w.calls().at(-1).args.slice(0, 3), ["pr", "view", "--repo=Other/Repo"]);
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
    ["2", /pull request #2 is not the open pull request of claude\/t1 into main in owner\/repo: it is OPEN, from claude\/t2 into main\. Give T1 its own PR: sage task T1 set pr=<n>/],
    ["3", /pull request #3 is not the open pull request .*: it is OPEN, from claude\/t1 into release\./],
    ["", /T1 has no PR number in the logbook: run sage-pr create T1, which records it/],
  ];
  for (const [n, why] of cases) {
    w.sage("task", "T1", "set", `pr=${n}`);
    refused(w.pr("merge", "T1"), why);
  }
  assert.equal(w.calls().filter((c) => c.args[1] === "merge").length, 0);
  w.sage("task", "T1", "set", "pr=1");
  assert.equal(w.pr("merge", "T1").status, 0);
  assert.deepEqual(w.calls().at(-1).args, ["pr", "merge", "--repo=owner/repo", "--squash", "--delete-branch", `--match-head-commit=${head}`, "--", "1"]);
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

test("T96-C5-TWOOPEN: two open pull requests of the branch: create keeps the recorded one, and refuses when none is recorded", () => {
  const w = world();
  const head = w.commit("b.txt");
  w.sage("verdict", "T1", "--sha", head, "--kind", "checks-pass");
  writeFileSync(w.at("gh.json"), JSON.stringify([1, 2].map((number) => ({ number, head: "claude/t1", state: "OPEN" }))));
  refused(w.pr("create", "T1"), /^sage-pr: refused: 2 pull requests of claude\/t1 into main are open \(#1, #2\), and the logbook names none of them: ask the user which one is T1's, then sage task T1 set pr=<n>\n$/);
  assert.equal(w.remote("refs/heads/claude/t1"), "", "nothing pushed");
  w.sage("task", "T1", "set", "pr=2");
  const r = w.pr("create", "T1");
  assert.equal(r.stdout, `pushed ${short(head)} to claude/t1; pull request #2 https://github.com/owner/repo/pull/2 is open\n`, r.stderr);
  assert.equal(w.task("T1").pr, "2");
  assert.equal(w.calls().filter((c) => c.args[1] === "create").length, 0);
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
  writeFileSync(join(w.logbook, "mirror.git"), "");
  refused(w.pr("create", "T1"), /^sage-pr: refused: .*\/mirror\.git is not a folder: ask the user to remove it\n$/);
  w.p("remote", "remove", "origin");
  refused(w.pr("view", "T1"), /^sage-pr: refused: the project (.*\/project) has no origin remote: git -C \1 remote add origin <address>\n$/);
  assert.deepEqual(w.calls(), []);
});

test("the script starts git and gh only through execFile with an argument array, never a shell", () => {
  const src = readFileSync(PR, "utf8");
  assert.deepEqual([...src.matchAll(/import \{([^}]*)\} from "node:child_process"/g)].map((m) => m[1].trim()), ["execFileSync"]);
  assert.doesNotMatch(src, /\bshell\s*:|\bexecSync\b|\bspawn(Sync)?\b|(?<![.\w])exec\(/);
  assert.deepEqual([...src.matchAll(/execFileSync\(("[^"]*")/g)].map((m) => m[1]), ['"gh"']); // git goes through sage.mjs git(), which is execFileSync too
});
