// Runs the hook as Claude Code and Codex do: one JSON event on stdin, one JSON answer on stdout, in a real git repository.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ROOT } from "./build.mjs";

const HOOK = join(ROOT, "plugins/agent-kit/hooks/principles-hook.mjs");

/** A session in a new git repository with one committed code file. */
function session(env = {}) {
  const repo = mkdtempSync(join(tmpdir(), "agent-kit-repo-"));
  const git = (...args) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
  git("init", "-q");
  writeFileSync(join(repo, "sum.js"), "export const sum = (a, b) => a + b;\n");
  git("add", "-A");
  git("commit", "-qm", "start");
  const stateDir = mkdtempSync(join(tmpdir(), "agent-kit-state-"));
  const send = (event) => {
    const r = spawnSync("node", [HOOK], { input: JSON.stringify({ session_id: "s1", cwd: repo, ...event }), encoding: "utf8", env: { ...process.env, AGENT_KIT_HOOKS_STATE: stateDir, ...env } });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout ? JSON.parse(r.stdout) : undefined;
  };
  return { repo, git, send, edit: (file, text) => writeFileSync(join(repo, file), text) };
}

const context = (out) => out?.hookSpecificOutput?.additionalContext ?? "";
const prompt = (text) => ({ hook_event_name: "UserPromptSubmit", prompt: text });
const bash = (event, command, tool_response = { stdout: "", stderr: "", interrupted: false }) => ({ hook_event_name: event, tool_name: "Bash", tool_input: { command }, tool_response });
const stop = (active = false) => ({ hook_event_name: "Stop", stop_hook_active: active });

test("a design request gets the design principles once per session", () => {
  const s = session();
  const first = context(s.send(prompt("Design the data model for trips")));
  assert.match(first, /# Exhaust the design space/);
  assert.match(first, /# Experience first/);
  assert.match(first, /# Foundational thinking/);
  assert.doesNotMatch(first, /^---\nname:/m, "the skill's frontmatter is left out");
  assert.equal(s.send(prompt("Now design the screens")), undefined);
});

test("a plain question gets no principle", () => {
  assert.equal(session().send(prompt("What does this function return?")), undefined);
});

test("AGENT_KIT_HOOKS=off turns the hook off", () => {
  const s = session({ AGENT_KIT_HOOKS: "off" });
  assert.equal(s.send(prompt("Design the data model")), undefined);
  s.edit("sum.js", "changed\n");
  assert.equal(s.send(stop()), undefined);
});

test("a test file edit gets test-behavior, from Claude Code's Edit and from Codex's apply_patch", () => {
  const claude = session().send({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "/x/src/sum.test.js" } });
  assert.match(context(claude), /# Test behaviour, not implementation/);
  const patch = "*** Begin Patch\n*** Update File: src/sum.test.ts\n@@\n-a\n+b\n*** End Patch";
  const codex = session().send({ hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { command: patch } });
  assert.match(context(codex), /# Test behaviour, not implementation/);
  assert.equal(codex.hookSpecificOutput.hookEventName, "PreToolUse");
});

test("a document edit gets contextualize; a commit gets sequence-verifiable-units", () => {
  const s = session();
  assert.match(context(s.send({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "docs/design.md" } })), /# Contextualize and write for the reader/);
  assert.match(context(s.send(bash("PreToolUse", 'git commit -m "x"'))), /# Sequence verifiable units/);
  assert.equal(s.send(bash("PreToolUse", "git status")), undefined);
});

test("the stop gate blocks once when the code changed and no check ran", () => {
  const s = session();
  s.send(prompt("Make sum handle strings"));
  s.edit("sum.js", "export const sum = (a, b) => Number(a) + Number(b);\n");
  const out = s.send(stop());
  assert.equal(out.decision, "block");
  assert.match(out.reason, /no check ran after the change/);
  assert.match(out.reason, /# Prove it works/);
  assert.equal(s.send(stop(true)), undefined, "the continued turn may finish");
  assert.equal(s.send(stop()), undefined, "the same code is not stopped twice");
  s.edit("sum.js", "changed again\n");
  assert.equal(s.send(stop()).decision, "block", "new unchecked code is stopped again");
});

test("the stop gate lets the agent finish after a check, after a commit, and after document changes", () => {
  const s = session();
  s.send(prompt("Make sum handle strings"));
  s.edit("sum.js", "v2\n");
  s.send(bash("PostToolUse", "npm test 2>&1 | tail -20"));
  s.git("commit", "-qam", "v2");
  assert.equal(s.send(stop()), undefined, "a commit does not change the checked code");

  const d = session();
  d.send(prompt("Fix the README"));
  d.edit("README.md", "# Sum\n");
  assert.equal(d.send(stop()), undefined, "documents are not code");

  const q = session();
  q.edit("sum.js", "the person's own change before the turn\n");
  q.send(prompt("What does sum do?"));
  assert.equal(q.send(stop()), undefined, "only changes made in this turn count");
});

test("a browser look counts as a check", () => {
  const s = session();
  s.send(prompt("Restyle the page"));
  s.edit("sum.js", "v2\n");
  s.send({ hook_event_name: "PostToolUse", tool_name: "mcp__Claude_Browser__computer", tool_input: { action: "screenshot" }, tool_response: {} });
  assert.equal(s.send(stop()), undefined);
});

test("no gate outside a git repository", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-kit-nogit-"));
  const send = (e) => spawnSync("node", [HOOK], { input: JSON.stringify({ session_id: "n", cwd: dir, ...e }), encoding: "utf8", env: { ...process.env, AGENT_KIT_HOOKS_STATE: dir } }).stdout;
  send(prompt("Change it"));
  writeFileSync(join(dir, "a.js"), "x");
  assert.equal(send(stop()), "");
});

test("a failed check gets fix-root-causes; two failed fixes get attack-the-premise", () => {
  const s = session();
  // Claude Code sends a failed command as PostToolUseFailure.
  assert.match(context(s.send({ hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "npm test" }, error: "Exit code 1" })), /# Fix root causes/);
  s.edit("sum.js", "fix 1\n");
  // Codex sends it as PostToolUse, with only the output (this is what a real Codex 0.159 run sent).
  assert.equal(s.send(bash("PostToolUse", "npm test", NODE_TEST_FAILED)), undefined);
  assert.equal(s.send(bash("PostToolUse", "npm test", NODE_TEST_FAILED)), undefined, "a re-run without a change is not a failed fix");
  s.edit("sum.js", "fix 2\n");
  assert.match(context(s.send(bash("PostToolUse", "npm test", NODE_TEST_FAILED))), /# Attack the premise/);
});

const NODE_TEST_FAILED = "\n> test\n> node --test\n\n✔ adds numbers (0.35ms)\n✖ an empty sum is 0 (0.09ms)\nℹ tests 2\nℹ pass 1\nℹ fail 1\n";

test("Codex output: the failure lines of common check tools count as a failure; a pass does not", () => {
  const failures = [NODE_TEST_FAILED, "Tests:       1 failed, 4 passed, 5 total", "FAIL\tgithub.com/x/sum\t0.01s", "test result: FAILED. 1 passed; 1 failed", "src/a.ts(3,1): error TS2322: Type 'string'", "✖ 2 problems (2 errors, 0 warnings)"];
  for (const out of failures) assert.match(context(session().send(bash("PostToolUse", "npm test", out))), /# Fix root causes/, out);
  const passes = ["ℹ tests 3\nℹ pass 3\nℹ fail 0\n", "Tests:       5 passed, 5 total", "ok  \tgithub.com/x/sum\t0.01s", "0 failed"];
  for (const out of passes) assert.equal(session().send(bash("PostToolUse", "npm test", out)), undefined, out);
  // Claude Code's PostToolUse is a success, whatever the output says.
  assert.equal(session().send(bash("PostToolUse", "npm test", { stdout: "1 failed", stderr: "", interrupted: false })), undefined);
});

test("a passed check resets the count of failed fixes", () => {
  const s = session();
  s.send(bash("PostToolUseFailure", "npm test"));
  s.edit("sum.js", "fix 1\n");
  s.send(bash("PostToolUseFailure", "npm test"));
  s.send(bash("PostToolUse", "npm test", "Exit code: 0\nOutput:\nok"));
  s.edit("sum.js", "fix 2\n");
  assert.equal(s.send(bash("PostToolUseFailure", "npm test")), undefined, "fix-root-causes was given already; the count starts again");
});

test("after a compaction, a principle is given again at its next moment", () => {
  const s = session();
  assert.ok(context(s.send(prompt("Refactor the parser"))));
  assert.equal(s.send(prompt("Refactor more")), undefined);
  s.send({ hook_event_name: "PostCompact" });
  assert.match(context(s.send(prompt("Refactor more"))), /# Subtract before you add/);
});
