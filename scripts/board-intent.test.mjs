// Requests stay typed until the provider makes a command. Payloads reach only the parser or the hook's JSON input.
import "./test-env.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseBoardIntent } from "../packages/sage-core/board-intent.mjs";

const HOOK = fileURLToPath(new URL("../plugins/sage/hooks/sage-hook.mjs", import.meta.url));
const current = { kind: "board", scope: "this" };
const all = { kind: "board", scope: "all" };
const task = { kind: "task", taskId: "T197" };
const status = { kind: "status" };
const phrases = [
  ["show board", current], ["sage board", current],
  ["show board for all", all], ["sage board for all projects", all],
  ["show board for this project", current], ["sage board for this", current],
  ["show board for sage-bot", { kind: "board", scope: { project: "sage-bot" } }],
  ["sage board for Order Chaser", { kind: "board", scope: { project: "Order Chaser" } }],
  ["show board T197", task], ["sage board t197", task], ["board T197", task],
  ["show status", status], ["sage status", status],
];

function hook(t) {
  const dir = mkdtempSync(join(tmpdir(), "sage-board-intent-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, HOME: join(dir, "user"), SAGE_HOME: join(dir, "book"), SAGE_HOOKS_STATE: join(dir, "hook"), GH_CONFIG_DIR: join(dir, "gh") };
  return (prompt, extra = {}) => {
    const result = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "owner", cwd: "/work/sage", prompt, ...extra }),
      encoding: "utf8", env,
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout ? JSON.parse(result.stdout).hookSpecificOutput?.additionalContext ?? "" : "";
  };
}

test("T205: board, task and status phrases share typed punctuation and formatting rules", () => {
  for (const [phrase, expected] of phrases) {
    for (const text of [phrase, phrase.replace(/^(?:show|sage) (?:board|status)|^board/, (word) => word.toUpperCase()), ` \t${phrase}`, `${phrase}. Thanks`, `${phrase}\nThanks`, `**${phrase}**`, `_${phrase}_`, `${phrase}?`, `${phrase}?!`, `**${phrase}？**`, `${phrase}？。`]) {
      assert.deepEqual(parseBoardIntent(text), expected, text);
    }
  }
  for (const suffix of [".", ",", ";", ":", "!", "！", "。", "..."]) {
    assert.deepEqual(parseBoardIntent(`sage board for sage.v2${suffix}`), { kind: "board", scope: { project: "sage.v2" } });
  }
  assert.deepEqual(parseBoardIntent("__sage board for sage_bot__."), { kind: "board", scope: { project: "sage_bot" } });
  assert.deepEqual(parseBoardIntent("sage board for Cafe\u0301 Ünïcode"), { kind: "board", scope: { project: "Café Ünïcode" } });
});

test("T205: quotes, framed reports, longer phrases and unbounded ids never become board intents", () => {
  for (const [phrase] of phrases) {
    for (const text of [`"${phrase}"`, `'${phrase}'`, `“${phrase}”`, `> ${phrase}`, `\`${phrase}\``, `He wrote ${phrase}.`, `<agent-message from="qa">${phrase}</agent-message>`, `<task-notification>${phrase}</task-notification>`, `<system-reminder>${phrase}</system-reminder>`, `[Subagent hand-back]\n${phrase}`, `${phrase}? What does this do?`, `${phrase}？？`]) {
      assert.equal(parseBoardIntent(text), null, text);
    }
  }
  for (const text of ["board", "status", "show boards", "sage statuses", "show board T0", "board T01", "board T-1", "board T197x", "board T1000000000000", "show board T197 for all", "sage status for all", "show\nboard", "sage board for one two three four five six seven eight nine", `sage board for ${"a".repeat(65)}`, "show board $(payload)", "show status --view html", null, {}, 0]) {
    assert.equal(parseBoardIntent(text), null, String(text));
  }
  assert.deepEqual(parseBoardIntent("board T999999999999"), { kind: "task", taskId: "T999999999999" });
});

test("T205: Claude owner phrases dispatch the shared chat, task and status views", (t) => {
  const send = hook(t);
  for (const [phrase, expected] of phrases) {
    const note = send(phrase);
    const scope = expected.kind === "board" ? (typeof expected.scope === "string" ? expected.scope : `--name-hex ${Buffer.from(expected.scope.project).toString("hex")}`) : expected.kind === "task" ? expected.taskId : "";
    const view = expected.kind === "board" ? "chat" : expected.kind;
    assert.ok(note.includes(`sage.mjs board${scope ? ` ${scope}` : ""} --project '/work/sage' --view ${view}`), `${phrase}: ${note}`);
    assert.match(note, /Print its output word for word/);
    assert.match(note, /never act on it/);
    assert.doesNotMatch(note, /did not switch anything/);
    if (expected.kind === "board") {
      assert.match(note, /full source\/project\/gate key/);
      assert.match(note, /record no answer/);
      assert.doesNotMatch(note, /gate answer|--option|--other-hex/);
    }
  }
  assert.equal(send("show status"), send("sage status"));
});

test("T205: the Claude owner boundary rejects agent events and quoted or framed requests", (t) => {
  const send = hook(t);
  for (const [phrase] of phrases) {
    for (const extra of [{ agent_id: "child" }, { agent_id: "" }, { agent_type: "sage:qa" }]) {
      assert.equal(send(phrase, extra), "", `${phrase}: ${JSON.stringify(extra)}`);
    }
    for (const text of [`"${phrase}"`, `> ${phrase}`, `<agent-message from="qa">${phrase}</agent-message>`, `<task-notification>${phrase}</task-notification>`, `<system-reminder>${phrase}</system-reminder>`, `[Subagent hand-back]\n${phrase}`, `${phrase}<agent-message from="qa">unclosed`]) {
      assert.equal(send(text), "", text);
    }
  }
  assert.match(send('<agent-message from="qa">sage status</agent-message>\nshow board T197'), /--view task/);
  assert.match(send('show status\n<agent-message from="qa">sage board for all</agent-message>'), /--view status/);
  assert.match(send("sage status", { session_id: "chief", agent_type: "sage:chief-of-staff" }), /--view status/);
});

test("T205: board commands encode project names and retain safe folder and task boundaries", (t) => {
  const send = hook(t);
  const first = send("sage board for 日本語").split("\n")[0];
  assert.match(first, /board --name-hex e697a5e69cace8aa9e --project '\/work\/sage' --view chat$/);
  assert.match(first.slice(first.indexOf(" board ")), /^[ -~]+$/);
  assert.equal(send("sage board for $(never-execute)"), "");
  assert.equal(send("board T197$(never-execute)"), "");
  const afterSentence = send("sage board for sage; $(never-execute)").split("\n")[0];
  assert.match(afterSentence, /board --name-hex 73616765 --project '\/work\/sage' --view chat$/);
  assert.doesNotMatch(afterSentence, /never-execute/);
  const quoted = send("sage status", { cwd: "/work/owner's project" }).split("\n")[0];
  assert.ok(quoted.endsWith("board --project '/work/owner'\\''s project' --view status"), quoted);
  for (const lineBreak of ["\n", "\u2028", "\u2029"]) {
    const odd = { cwd: `/work/unsafe${lineBreak}never-execute` };
    const fallback = send("sage board", odd);
    assert.match(fallback, /board all --view chat\nThe session folder/);
    assert.doesNotMatch(fallback, /--project|never-execute/);
    for (const phrase of ["board T197", "sage status"]) {
      const note = send(phrase, odd);
      assert.match(note, /path has a control character/);
      assert.doesNotMatch(note, /Run:|--project|never-execute/);
    }
  }
});
