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

/** The fake gh: it records each call (arguments, folder, the folder's entries, token, config folder) and plays GitHub's pull requests on the bare repository. */
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
if (args[1] === "list") console.log(JSON.stringify(prs.filter((p) => p.head === flag("head") && p.state === "OPEN").map((p) => ({ number: p.number, url: url(p.number) }))));
else if (args[1] === "create") { prs.push({ number: prs.length + 1, head: flag("head"), state: "OPEN" }); save(); console.log(url(prs.length)); }
else if (args[1] === "view") { const p = prs.find((x) => x.head === after); if (!p) { console.error("no pull requests found for branch " + after); process.exit(1); } console.log(JSON.stringify({ number: p.number, state: p.state, url: url(p.number) })); }
else if (args[1] === "merge") {
  const p = prs.find((x) => x.head === after && x.state === "OPEN");
  if (!p || bare("rev-parse", "refs/heads/" + after) !== flag("match-head-commit")) { console.error("head mismatch"); process.exit(1); }
  const squash = bare("commit-tree", flag("match-head-commit") + "^{tree}", "-p", "refs/heads/main", "-m", "squash");
  bare("update-ref", "refs/heads/main", squash); bare("update-ref", "-d", "refs/heads/" + after);
  p.state = "MERGED"; save();
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
  return { at, env, git, p, sage, pr, logbook, bundle, commit, calls, remote };
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
  assert.equal(r.stdout, `pushed ${head.slice(0, 7)} to claude/t1; opened https://github.com/owner/repo/pull/1\n`);
  assert.equal(w.remote("refs/heads/claude/t1"), head);
  const calls = w.calls();
  assert.deepEqual(calls.map((c) => c.args.slice(0, -1).concat(c.args.at(-1).startsWith("--body-file=") ? ["--body-file=<temp>"] : c.args.at(-1))), [
    ["pr", "list", "--repo=owner/repo", "--head=claude/t1", "--state=open", "--json=number,url"],
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
  refused(w.pr("create", "T1"), new RegExp(`the remote claude/t1 is at ${repaired.slice(0, 7)}, and ${rewritten.slice(0, 7)} does not follow from it: a push would not be a fast-forward`));
  assert.equal(w.remote("refs/heads/claude/t1"), repaired);
  assert.equal(w.calls().filter((c) => c.args[1] === "create").length, 1);
});

test("view shows the task's pull request, with -- before the branch", () => {
  const w = world();
  const head = w.commit("b.txt");
  w.sage("verdict", "T1", "--sha", head, "--kind", "checks-pass");
  w.pr("create", "T1");
  const r = w.pr("view", "T1");
  assert.equal(r.stdout, `{"number":1,"state":"OPEN","url":"https://github.com/owner/repo/pull/1"}\n`);
  assert.deepEqual(w.calls().at(-1).args, ["pr", "view", "--repo=owner/repo", "--json=number,state,headRefOid,url", "--", "claude/t1"]);
});

test("merge runs the merge check, merges only the reviewed head, and fetches the new main into the mirror", () => {
  const w = world();
  const head = w.commit("b.txt");
  w.sage("verdict", "T1", "--sha", head, "--kind", "checks-pass");
  w.pr("create", "T1");
  w.sage("task", "T1", "set", "pr=1");
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
  assert.deepEqual(w.calls().at(-1).args, ["pr", "merge", "--repo=owner/repo", "--squash", "--delete-branch", `--match-head-commit=${head}`, "--", "claude/t1"]);
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
    [() => symlinkSync("/etc/hosts", w.bundle), /the bundle .*T1\.bundle is a link, not a plain file/],
    [() => symlinkSync(good, w.bundle), /is a link, not a plain file/],
    [() => linkSync(good, w.bundle), /the bundle .* has 2 links, not 1/],
    [() => mkdirSync(w.bundle), /the bundle .* is not a plain file/],
    [() => (writeFileSync(w.bundle, ""), truncateSync(w.bundle, 100 * 1024 * 1024 + 1)), /the bundle .* is over 104857600 bytes/],
    [() => {}, /no bundle at .*T1\.bundle/],
    [() => writeFileSync(w.bundle, "not a bundle\n"), /the bundle is not a git bundle of the branch claude\/t1/],
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
  refused(w.pr("create", "T1"), new RegExp(`the bundle tip ${extra.slice(0, 7)} is not the reviewed head ${head.slice(0, 7)}`));
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
    ["main", /branch "main" is the base branch/],
    ["refs/heads/main", /branch "refs\/heads\/main" is the base branch/],
    ["MAIN", /branch "MAIN" is the base branch/],
    ["master", /branch "master" is not a task branch/],
    ["origin/claude/t1", /branch "origin\/claude\/t1" is not a task branch/],
    ["--force", /branch "--force" is not a task branch/],
    ["feature-x", /branch "feature-x" is outside the task's pattern/],
    ["claude/t10", /branch "claude\/t10" is outside the task's pattern/],
    ["a/b/t1", /branch "a\/b\/t1" is outside the task's pattern/],
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
  refused(w.pr("create", "T1"), new RegExp(`the head ${main.slice(0, 7)} is already on main`));
  assert.equal(w.remote("refs/heads/claude/t1"), "");
  assert.deepEqual(w.calls(), []);
});

test("create and merge need a reviewed head; a task without one refuses", () => {
  const w = world();
  w.commit("b.txt");
  refused(w.pr("create", "T1"), /T1 has no verdict with a SHA, so it has no reviewed head/);
  refused(w.pr("merge", "T1"), /T1 has no verdict with a SHA/);
  assert.deepEqual(w.calls(), []);
});

test("the script starts git and gh only through execFile with an argument array, never a shell", () => {
  const src = readFileSync(PR, "utf8");
  assert.deepEqual([...src.matchAll(/import \{([^}]*)\} from "node:child_process"/g)].map((m) => m[1].trim()), ["execFileSync"]);
  assert.doesNotMatch(src, /\bshell\s*:|\bexecSync\b|\bspawn(Sync)?\b|(?<![.\w])exec\(/);
  assert.deepEqual([...src.matchAll(/execFileSync\(("[^"]*")/g)].map((m) => m[1]), ['"gh"']); // git goes through sage.mjs git(), which is execFileSync too
});
