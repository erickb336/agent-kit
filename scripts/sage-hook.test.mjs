// Runs the sage hook as Claude Code does: one JSON event on stdin, one JSON answer (or nothing) on stdout.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HOOK = fileURLToPath(new URL("../plugins/sage/hooks/sage-hook.mjs", import.meta.url));
const TOOL = fileURLToPath(new URL("../plugins/sage/skills/sage/sage.mjs", import.meta.url));
const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const BRIEF = ["GOAL fix it", "SCOPE src/", "CONTEXT none", "DECISIONS none", "ACCEPTANCE it works", "VERIFY npm test", "BUDGET 20 turns", "FORBIDDEN no merge", "REPORT the usual", "STANDING 1. work in your worktree"].join("\n");

/** A session with its own hook state and sage home. send() returns the hook's answer, or undefined. */
function session(env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sage-hook-"));
  const vars = { ...process.env, SAGE_HOOKS_STATE: join(dir, "state"), SAGE_HOME: join(dir, "home"), ...env };
  const send = (event) => {
    const r = spawnSync("node", [HOOK], { input: JSON.stringify({ session_id: "s1", ...event }), encoding: "utf8", env: vars });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout ? JSON.parse(r.stdout) : undefined;
  };
  const sendAsync = (event) =>
    new Promise((done) => {
      const p = spawn("node", [HOOK], { env: vars });
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.on("close", () => done(out ? JSON.parse(out) : undefined));
      p.stdin.end(JSON.stringify({ session_id: "s1", ...event }));
    });
  const sage = (...args) => spawnSync("node", [TOOL, ...args, "--project", dir], { encoding: "utf8", env: vars }).stdout.trim();
  return { dir, send, sendAsync, sage, vars };
}

const prompt = (text) => ({ hook_event_name: "UserPromptSubmit", prompt: text });
const tool = (tool_name, tool_input, extra = {}) => ({ hook_event_name: "PreToolUse", tool_name, tool_input, ...extra });
const edit = (extra) => tool("Edit", { file_path: "/x/a.js" }, extra);
const bash = (command) => tool("Bash", { command });
const spawnAgent = (subagent_type, prompt, id = "tu1") => tool("Agent", { subagent_type, prompt, description: "d" }, { tool_use_id: id });
const context = (out) => out?.hookSpecificOutput?.additionalContext ?? "";
const denied = (out) => (out?.hookSpecificOutput?.permissionDecision === "deny" ? out.hookSpecificOutput.permissionDecisionReason : undefined);

test("sage mode makes the session the chief of staff, and only subagents may change files", () => {
  const s = session();
  assert.equal(denied(s.send(edit())), undefined, "before sage mode, the session may edit");
  const on = context(s.send(prompt("sage mode. Ramen Finder: fix the crash reports")));
  assert.match(on, /sage mode is on/);
  assert.match(on, /# Chief of staff \(sage mode\)/);
  assert.match(on, /The state tool: node ".*skills\/sage\/sage\.mjs" <command> --project <path>\. Each shell call starts fresh, so write this full command every time/);
  assert.match(on, /Load these skills now: sage:sage, sage:principle-never-block-on-the-human/);
  assert.doesNotMatch(on, /^disallowedTools:/m, "the agent's frontmatter is left out");
  assert.match(denied(s.send(edit())), /Give this change to a sage:implementer/);
  assert.equal(s.send(edit({ agent_id: "a1", agent_type: "sage:implementer" })), undefined, "an implementer may edit");
  assert.equal(s.send(prompt("also add CSV export")), undefined, "the instructions come once");
  s.send({ hook_event_name: "PostCompact" });
  assert.match(context(s.send(prompt("what is left?"))), /# Chief of staff/, "and again after a compaction");
  assert.match(context(s.send(prompt("sage mode off"))), /sage mode is off/);
  assert.equal(s.send(edit()), undefined);
});

test("a session that starts as the chief-of-staff agent is in sage mode without the phrase", () => {
  const s = session();
  assert.match(denied(s.send(edit({ agent_type: "sage:chief-of-staff" }))), /you do not change files yourself/);
});

test("a brief to a sage agent needs every field; other agents and other sessions are not checked", () => {
  const s = session();
  assert.equal(s.send(spawnAgent("sage:implementer", "fix it")), undefined, "outside sage mode");
  s.send(prompt("sage mode"));
  assert.match(denied(s.send(spawnAgent("sage:implementer", "GOAL fix it\nSCOPE src/"))), /the brief has no CONTEXT, DECISIONS, ACCEPTANCE, VERIFY, BUDGET, FORBIDDEN, REPORT, STANDING/);
  assert.equal(s.send(spawnAgent("sage:implementer", BRIEF)), undefined);
  assert.equal(s.send(spawnAgent("Explore", "where is the date parser?", "tu2")), undefined);
});

test("at most max_agents sage agents run at once, also when the chief starts them in one message", async () => {
  const s = session();
  s.send(prompt("sage mode"));
  const four = await Promise.all([1, 2, 3, 4].map((n) => s.sendAsync(spawnAgent("sage:qa", BRIEF, `tu${n}`))));
  assert.equal(four.filter((out) => !denied(out)).length, 3, "exactly 3 of 4 simultaneous spawns pass");
  assert.match(four.map(denied).find(Boolean), /3 sage agents are running, and the cap is 3/);

  const allowed = [1, 2, 3, 4].filter((n, i) => !denied(four[i]));
  allowed.forEach((n, i) => s.send({ hook_event_name: "SubagentStart", agent_id: `ag${i}`, agent_type: "sage:qa" }));
  assert.ok(denied(s.send(spawnAgent("sage:qa", BRIEF, "tu5"))), "still full after the agents start");
  s.send({ hook_event_name: "SubagentStop", agent_id: "ag0", agent_type: "sage:qa" });
  assert.equal(s.send(spawnAgent("sage:qa", BRIEF, "tu6")), undefined, "a finished agent frees its slot");
  assert.ok(denied(s.send(spawnAgent("sage:qa", BRIEF, "tu7"))));
  s.send({ hook_event_name: "PostToolUseFailure", tool_name: "Agent", tool_use_id: "tu6" });
  assert.equal(s.send(spawnAgent("sage:qa", BRIEF, "tu8")), undefined, "a spawn that failed frees its slot");
});

test("the cap comes from the sage config", () => {
  const s = session();
  s.sage("config", "max_agents=1");
  s.send(prompt("sage mode"));
  assert.equal(s.send(spawnAgent("sage:pe", BRIEF, "tu1")), undefined);
  assert.match(denied(s.send(spawnAgent("sage:pe", BRIEF, "tu2"))), /the cap is 1/);
});

test("in sage mode nobody force-pushes or pushes to main", () => {
  const s = session();
  s.send(prompt("sage mode"));
  assert.match(denied(s.send(bash("git push --force origin claude/t1"))), /never force-pushes/);
  assert.match(denied(s.send(bash("git -C /x push -f"))), /never force-pushes/);
  assert.match(denied(s.send(bash("git push origin HEAD:main"))), /only through a pull request/);
  assert.match(denied(s.send(bash("git push -u origin master"))), /only through a pull request/);
  assert.equal(s.send(bash("git push -u origin claude/t1")), undefined);
  assert.equal(s.send(bash("git push origin feature/main-fix")), undefined);
});

test("a merge needs autopilot on, the checked head SHA, and its clean cycles in the ledger", () => {
  const s = session();
  const merge = (args = `--match-head-commit ${SHA}`) => denied(s.send(bash(`gh pr merge 41 --squash --delete-branch ${args}`)));
  assert.equal(merge(), undefined, "outside sage mode the hook does not judge merges");
  s.send(prompt("autopilot on"));
  s.send(prompt("sage mode"));
  assert.match(merge(), /autopilot is off, so the user merges/, "autopilot on before sage mode does not count");
  assert.match(context(s.send(prompt("autopilot on"))), /autopilot is on\. A pull request merges after 2 clean cycles/);
  assert.match(merge(""), /add --match-head-commit/);
  assert.match(merge(), /^sage: the merge check refuses: no verdicts recorded/);

  s.sage("init");
  s.sage("task", "add", "--title", "t", "--size", "small");
  for (const cycle of ["1", "2"]) for (const kind of ["checks-pass", "review-clean", "qa-pass"]) s.sage("verdict", "T1", "--sha", SHA, "--kind", kind, "--cycle", cycle, "--pr", "41");
  assert.equal(merge(), undefined, "2 clean cycles on the SHA");
  assert.equal(merge(`--match-head-commit=${SHA}`), undefined);
  assert.match(context(s.send(prompt("autopilot off"))), /autopilot is off/);
  assert.match(merge(), /autopilot is off/, "the kill switch");
});

test("the autopilot note comes only when autopilot goes from on to off, so never outside sage mode", () => {
  const s = session();
  assert.equal(s.send(prompt("the autopilot module has no tests")), undefined, "outside sage mode a mention adds nothing");
  s.send(prompt("sage mode"));
  assert.equal(s.send(prompt("stop autopilot")), undefined, "autopilot is already off");
  s.send(prompt("autopilot on"));
  assert.equal(context(s.send(prompt("the autopilot module has no tests"))), "sage: autopilot is off. Work stops at verified, and the user merges.");
  assert.equal(s.send(prompt("autopilot off")), undefined, "and only once");
});

test("SAGE_HOOKS=off turns the hook off", () => {
  const s = session({ SAGE_HOOKS: "off" });
  assert.equal(s.send(prompt("sage mode")), undefined);
  assert.equal(s.send(edit()), undefined);
});

test("a sage agent finishes only with the full report; the second stop goes through", () => {
  const s = session();
  const stop = (message, extra = {}) => s.send({ hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "sage:qa", last_assistant_message: message, ...extra });
  const blocked = stop("All good, it works.");
  assert.equal(blocked.decision, "block");
  assert.match(blocked.reason, /your report has no STATUS, RESULT, EVIDENCE, FINDINGS, QUESTIONS, NOT VERIFIED, BRANCH/);
  assert.equal(stop("All good.", { stop_hook_active: true }), undefined, "the second stop goes through");
  const full = "**STATUS** done\n**RESULT** PASS\n**EVIDENCE** npm test: 12 pass\n| FINDINGS | none |\nQUESTIONS none\nNOT VERIFIED the iPad layout\nBRANCH claude/t1 a1b2c3d";
  assert.equal(stop(full), undefined, "Markdown around the fields is fine");
  assert.equal(s.send({ hook_event_name: "SubagentStop", agent_id: "ag2", agent_type: "Explore", last_assistant_message: "found it" }), undefined, "other agents are not checked");
});

test("a report gate that blocks keeps the agent's slot until it really stops", () => {
  const s = session();
  s.sage("config", "max_agents=1");
  s.send(prompt("sage mode"));
  assert.equal(s.send(spawnAgent("sage:qa", BRIEF, "tu1")), undefined);
  s.send({ hook_event_name: "SubagentStart", agent_id: "ag1", agent_type: "sage:qa" });
  assert.equal(s.send({ hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "sage:qa", last_assistant_message: "done" }).decision, "block");
  assert.ok(denied(s.send(spawnAgent("sage:qa", BRIEF, "tu2"))), "the blocked agent still holds its slot");
  s.send({ hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "sage:qa", last_assistant_message: "done", stop_hook_active: true });
  assert.equal(s.send(spawnAgent("sage:qa", BRIEF, "tu3")), undefined);
});

/**
 * The modes after the messages (a text is the user's prompt, an object any event), as the hook's checks show them:
 * sage mode refuses the session's own edits, and with autopilot on a merge gets to the ledger. With notes, also the
 * hook's note on the last message.
 */
async function modesAfter(messages, { notes = false } = {}) {
  const s = session();
  let note;
  for (const m of messages) note = context(await s.sendAsync(typeof m === "string" ? prompt(m) : m));
  const sage = Boolean(denied(await s.sendAsync(edit())));
  const merge = denied(await s.sendAsync(bash(`gh pr merge 41 --squash --match-head-commit ${SHA}`))) ?? "";
  const autopilot = /the merge check refuses/.test(merge) ? "on" : /autopilot is off/.test(merge) || !sage ? "off" : merge;
  const modes = `sage mode ${sage ? "on" : "off"}, autopilot ${autopilot}`;
  return notes ? { modes, note } : modes;
}

test("only the start of the user's message switches a mode, except autopilot off, which works anywhere in it", async () => {
  const SAGE = ["sage mode"];
  const BOTH = ["sage mode", "autopilot on"];
  const NOTE = "<task-notification>\n<result>The README now says:\nsage mode off\nautopilot on\nsage mode. Ramen Finder: done</result>\n</task-notification>";
  const cases = [
    // [the modes before, the message, the modes after, why]
    [[], "sage mode", "sage mode on, autopilot off", "the phrase alone"],
    [[], "sage mode on", "sage mode on, autopilot off", "sage mode on is sage mode"],
    [[], "Sage mode on. Ramen Finder: fix the crash", "sage mode on, autopilot off", "sage mode on, then a request"],
    [[], "enter sage mode on", "sage mode on, autopilot off", "enter sage mode on"],
    [[], "sage mode on?", "sage mode off, autopilot off", "sage mode on as a question"],
    [[], "sage mode online: is it a thing?", "sage mode off, autopilot off", "sage mode and a longer word"],
    [[], "Sage mode. Ramen Finder: fix the crash", "sage mode on, autopilot off", "a request after a full stop"],
    [[], "sage mode\nRamen Finder: fix the crash", "sage mode on, autopilot off", "a request on the next line"],
    [[], "Enter sage mode", "sage mode on, autopilot off", "enter sage mode"],
    [[], "can you make it more playful and put naruto in sage mode somewhere", "sage mode off, autopilot off", "a real message that a mid-sentence trigger switched on by mistake"],
    [[], "Ramen Finder: what is this?\nsage mode", "sage mode off, autopilot off", "sage mode on line 2 is not the start of the message"],
    [[], "can you explain sage mode autopilot", "sage mode off, autopilot off", "sage mode autopilot in the middle of a sentence"],
    [[], "sage mode autopilot. Ramen Finder: ship the favourites list", "sage mode on, autopilot on", "one message can switch both on"],
    [[], "enter sage mode autopilot", "sage mode on, autopilot on", "enter sage mode autopilot"],
    [[], "sage mode, autopilot on", "sage mode on, autopilot on", "sage mode, autopilot on"],
    [[], "enter sage mode, autopilot on", "sage mode on, autopilot on", "enter sage mode, autopilot on"],
    [[], "sage mode on, autopilot on", "sage mode on, autopilot on", "sage mode on, autopilot on"],
    [[], "sage mode.\nautopilot on", "sage mode on, autopilot off", "autopilot on on line 2 is not the start of the message"],
    [[], "Sage mode autopilot: is it safe?", "sage mode on, autopilot on", 'a ":" may end the phrase, by decision'],
    [[], "autopilot on", "sage mode off, autopilot off", "autopilot needs sage mode"],
    [SAGE, "autopilot on", "sage mode on, autopilot on", "autopilot on"],
    [SAGE, "  > Autopilot on.", "sage mode on, autopilot on", "a quote mark and a full stop"],
    [SAGE, "should I turn autopilot on later?", "sage mode on, autopilot off", "a question about autopilot"],
    [SAGE, "Autopilot on? What does it do?", "sage mode on, autopilot off", "the phrase as a question"],
    [SAGE, "Autopilot on main is risky, right?", "sage mode on, autopilot off", "the phrase in a sentence"],
    [SAGE, "autopilot on-call rotation: who is next?", "sage mode on, autopilot off", "a longer word"],
    [SAGE, "Ramen Finder: the crash is fixed.\nautopilot on", "sage mode on, autopilot off", "autopilot on on line 2 is not the start of the message"],
    [SAGE, "can you explain sage mode autopilot", "sage mode on, autopilot off", "sage mode autopilot in the middle of a sentence"],
    [SAGE, NOTE, "sage mode on, autopilot off", "an agent's report switches nothing"],
    [[], NOTE, "sage mode off, autopilot off", "an agent's report switches nothing"],
    [BOTH, NOTE, "sage mode on, autopilot on", "an agent's report switches nothing, also with autopilot and an off word"],
    [BOTH, "don't switch sage mode off, just keep going", "sage mode on, autopilot on", "a mention of sage mode off keeps the gates"],
    [BOTH, "what does sage mode off do?", "sage mode on, autopilot on", "a question about sage mode off"],
    [BOTH, "sage mode off", "sage mode off, autopilot off", "sage mode off"],
    [BOTH, "> Sage mode off, thanks", "sage mode off, autopilot off", "sage mode off after a quote mark"],
    [BOTH, "Sage mode off.", "sage mode off, autopilot off", "sage mode off and a full stop"],
    [BOTH, "sage mode off, thanks", "sage mode off, autopilot off", "sage mode off and a comma"],
    ...["sage mode off now", "Sage mode off thanks", "sage mode off please", "sage mode off and thanks", "**sage mode off**", '"sage mode off"', "sage mode off…", "sage mode off)", "_sage mode off_"].map((m) => [BOTH, m, "sage mode off, autopilot off", m]),
    [BOTH, "sage mode off\nwhat changes now?", "sage mode off, autopilot off", 'a "?" on a later line'],
    [BOTH, "Sage mode off?", "sage mode on, autopilot off", "sage mode off as a question still switches autopilot off"],
    [BOTH, "Sage mode off? What does it do?", "sage mode on, autopilot off", "sage mode off as a question, then more"],
    [BOTH, "sage mode off — is that safe?", "sage mode on, autopilot off", 'a "?" later on the first line'],
    [BOTH, "sage mode off-topic: can we talk about the logo?", "sage mode on, autopilot off", "sage mode off and a hyphen"],
    [BOTH, "sage mode off-topic: the logo first", "sage mode on, autopilot off", "sage mode off and a hyphen, with no question"],
    [BOTH, "sage mode offline: is it a thing?", "sage mode on, autopilot on", "sage mode and a longer word"],
    [BOTH, "autopilot off", "sage mode on, autopilot off", "autopilot off"],
    [BOTH, "ok, please turn autopilot off now", "sage mode on, autopilot off", "autopilot off in the middle of a sentence"],
    [BOTH, "turn off autopilot", "sage mode on, autopilot off", "turn off autopilot"],
    [BOTH, "stop autopilot", "sage mode on, autopilot off", "stop autopilot"],
    ...["disable autopilot", "pause autopilot", "switch off autopilot", "end autopilot", "turn off the autopilot", "stop the autopilot", "autopilot is now off", "autopilot disabled", "autopilot, off", "autopilot = off", "no autopilot please"].map((m) => [BOTH, m, "sage mode on, autopilot off", m]),
    [BOTH, "Autopilot: off", "sage mode on, autopilot off", "autopilot: off"],
    [BOTH, "autopilot is off now", "sage mode on, autopilot off", "autopilot is off"],
    [BOTH, "autopilot  off", "sage mode on, autopilot off", "two spaces"],
    [BOTH, "autopilot off", "sage mode on, autopilot off", "a no-break space"],
    ...["kill autopilot", "cancel autopilot", "deactivate autopilot", "halt autopilot", "no more autopilot", "auto-pilot off", "auto pilot off", "turn off auto-pilot", "set autopilot to off", "autopilot should be off", "autopilot is turned off", "autopilot -> off", "autopilot—off", "autopilot stop", "hold off on autopilot", "autopilot stopped", "there is no autopilot here"].map((m) => [BOTH, m, "sage mode on, autopilot off", m]),
    // The whole message counts, not one sentence: autopilot and an off word anywhere in it switch autopilot off.
    ...["I'm worried about autopilot. Please turn it off.", "Autopilot? Off.", "Autopilot. Turn it off.", "Autopilot. Stop it.", "autopilot\noff", "Autopilot\r\nOff", "turn off\nautopilot", "stop\nautopilot"].map((m) => [BOTH, m, "sage mode on, autopilot off", m]),
    [BOTH, "Autopilot stays on. Stop the build only if it fails", "sage mode on, autopilot off", "the off word is in the next sentence"],
    [BOTH, "autopilot is fine\nstop the build if it fails", "sage mode on, autopilot off", "the off word is on the next line"],
    // Each form of an off word.
    ...["Disabling autopilot.", "Stopping autopilot now", "autopilot paused", "autopilot is paused", "autopilot cancelled", "autopilot canceled", "autopilot killed", "autopilot ended", "autopilot halted", "autopilot deactivated", "abort autopilot", "quit autopilot", "exit autopilot", "suspend autopilot", "don't use autopilot", "do not use autopilot", "without autopilot", "autopilots off", "autopilot=false"].map((m) => [BOTH, m, "sage mode on, autopilot off", m]),
    [BOTH, "autopilot on, don't stop until done", "sage mode on, autopilot off", "off wins over on in the same message"],
    [SAGE, "sage mode autopilot. Stop when the tests pass", "sage mode on, autopilot off", "off wins over on in the same message"],
    [[], "no autopilot", "sage mode off, autopilot off", "an autopilot off switches nothing on"],
    [[], "the autopilot module has no tests", "sage mode off, autopilot off", "an autopilot off outside sage mode switches nothing on"],
    [SAGE, "turn on autopilot", "sage mode on, autopilot off", "only a message that starts with autopilot on switches it on"],
    [SAGE, "enable autopilot", "sage mode on, autopilot off", "only a message that starts with autopilot on switches it on"],
  ];
  const results = await Promise.all(cases.map(([before, message]) => modesAfter([...before, message])));
  const wrong = cases.flatMap(([, message, expected, why], i) => (results[i] === expected ? [] : [`${why}: ${JSON.stringify(message)} gives "${results[i]}", not "${expected}"`]));
  assert.deepEqual(wrong, [], "each case shows its message and both results");
});

// The frames that Claude Code 2.1.288 puts around a prompt that the user did not type: a hand-back from another
// session, a queued agent message and a task notification. Only their shapes are real; the ids and texts are made up.
const indent = (text) => text.split("\n").map((line) => `  ${line}`).join("\n");
const FRAMES = {
  "another session": (body) => `Another Claude session sent a message:\n<agent-message from="a0f1e2d3c4b5a6978">\n[A line from Claude Code about the hand-back.]\n${indent(body)}\n</agent-message>`,
  "agent message": (body) => `<agent-message from="a8b7c6d5e4f3a2b10">\n${indent(body)}\n</agent-message>`,
  "task notification": (body) => `<task-notification>\n<task-id>b1c2d3e4f5a6b7c8d</task-id>\n<status>completed</status>\n<summary>Agent "Fix the Ramen Finder search" completed</summary>\n<result>${body}</result>\n</task-notification>`,
};

test("only the user's own messages switch a mode: an agent's report, a task notification or another session's message switches nothing", async () => {
  const PHRASES = ["sage mode", "sage mode off", "autopilot on", "autopilot off", "sage mode autopilot"];
  const BODIES = {
    "at the start of the report": (phrase) => `${phrase}\nRamen Finder: the empty search no longer crashes.`,
    "in a quote of the user": (phrase) => `STATUS done\nRESULT the user wrote:\n> ${phrase}\nThe README says so now.`,
  };
  const STATES = {
    "no mode": [[], "sage mode off, autopilot off"],
    "sage mode": [["sage mode"], "sage mode on, autopilot off"],
    "sage mode and autopilot": [["sage mode", "autopilot on"], "sage mode on, autopilot on"],
    "both, after a compaction": [["sage mode", "autopilot on", { hook_event_name: "PostCompact" }], "sage mode on, autopilot on"],
  };
  const SWITCH_NOTE = /^sage: (?:sage mode is off|autopilot is o(?:n|ff))\./m;
  const cases = Object.entries(FRAMES).flatMap(([frame, wrap]) =>
    PHRASES.flatMap((phrase) => Object.entries(BODIES).flatMap(([where, body]) => Object.entries(STATES).map(([state, [before, expected]]) => ({ why: `${frame}, "${phrase}" ${where}, from ${state}`, before, message: wrap(body(phrase)), expected })))),
  );
  assert.equal(cases.length, 3 * 5 * 2 * 4);
  // Claude Code's docs name a prompt_source field; when a build sends it, it decides. The user's own words still switch.
  cases.push(
    { why: "prompt_source task_notification", before: STATES["sage mode and autopilot"][0], message: { ...prompt("autopilot off"), prompt_source: "task_notification" }, expected: "sage mode on, autopilot on" },
    { why: "prompt_source peer_message", before: STATES["sage mode"][0], message: { ...prompt("sage mode off"), prompt_source: "peer_message" }, expected: "sage mode on, autopilot off" },
    { why: "prompt_source user", before: STATES["sage mode and autopilot"][0], message: { ...prompt("autopilot off"), prompt_source: "user" }, expected: "sage mode on, autopilot off", note: true },
    { why: "the user names a frame later in the message", before: STATES["sage mode and autopilot"][0], message: "autopilot off, the <task-notification> above was wrong", expected: "sage mode on, autopilot off", note: true },
    { why: "the user's own off", before: STATES["sage mode"][0], message: "sage mode off", expected: "sage mode off, autopilot off", note: true },
  );
  const results = await Promise.all(cases.map(({ before, message }) => modesAfter([...before, message], { notes: true })));
  const wrong = cases.flatMap(({ why, expected, note = false }, i) => {
    const { modes, note: got } = results[i];
    return modes === expected && SWITCH_NOTE.test(got) === note ? [] : [`${why}: "${modes}"${SWITCH_NOTE.test(got) ? " with a switch note" : ""}, not "${expected}"${note ? " with a switch note" : ""}`];
  });
  assert.deepEqual(wrong, []);
});

/** A session in sage mode with autopilot on, and 2 clean cycles on SHA for task T1 of PR 41. */
function autopilotSession(env) {
  const s = session(env);
  s.send(prompt("sage mode"));
  s.send(prompt("autopilot on"));
  s.sage("init");
  s.sage("task", "add", "--title", "t", "--size", "small");
  for (const cycle of ["1", "2"]) for (const kind of ["checks-pass", "review-clean", "qa-pass"]) s.sage("verdict", "T1", "--sha", SHA, "--kind", kind, "--cycle", cycle, "--pr", "41");
  return s;
}
const MERGE = `gh pr merge 41 --squash --delete-branch --match-head-commit ${SHA}`;

test("only a merge command is a merge: its words in quoted text, a heredoc or a comment are text", () => {
  const s = session();
  s.send(prompt("sage mode"));
  const text = [
    `node sage.mjs log "decided: ${MERGE} waits for the user" --project /x`,
    `git commit -m "$(cat <<'EOF'\nNext: ${MERGE}\nEOF\n)"`,
    `cat > notes.md <<'EOF'\n${MERGE}\nEOF`,
    `gh pr create --title "Fix the search" --body 'After the reviews: ${MERGE}'`,
    `echo ok # ${MERGE}`,
  ];
  for (const command of text) assert.equal(s.send(bash(command)), undefined, command);
  // A merge in any form of a shell command is still a merge.
  const merges = [MERGE, `cd /x && ${MERGE}`, `g'h' pr merge 41 --match-head-commit ${SHA}`, `echo "$(${MERGE})"`, `sudo ${MERGE}`, `GH_TOKEN=x ${MERGE}`];
  for (const command of merges) assert.match(denied(s.send(bash(command))) ?? "", /autopilot is off/, command);
  // A command that the hook cannot read well enough is refused.
  const unsure = [`bash -c "${MERGE}"`, `sh <<'EOF'\n${MERGE}\nEOF`, `node -e "require('child_process').execSync('${MERGE}')"`, `echo "${MERGE}`];
  for (const command of unsure) assert.match(denied(s.send(bash(command))) ?? "", /the merge check cannot tell whether this command merges/, command);
});

test("a merge through the GitHub API is a merge too, and the hook refuses it", () => {
  const api = [
    `gh api -X PUT repos/o/r/pulls/41/merge -f sha=${SHA}`,
    "gh api --method=PUT /repos/o/r/pulls/41/merge",
    "gh api -XPUT repos/o/r/pulls/41/merge",
    'curl -X PUT -H "Authorization: Bearer x" https://api.github.com/repos/o/r/pulls/41/merge',
    `gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: "x"}) { clientMutationId } }'`,
  ];
  const off = session();
  off.send(prompt("sage mode"));
  for (const command of api) assert.match(denied(off.send(bash(command))) ?? "", /autopilot is off/, command);
  const s = autopilotSession();
  assert.equal(s.send(bash(MERGE)), undefined, "the merge command passes");
  for (const command of api) assert.match(denied(s.send(bash(command))) ?? "", /not through the GitHub API/, command);
});

test("one merge and one --match-head-commit per command: gh uses the last flag", () => {
  const s = autopilotSession();
  const OTHER = "b".repeat(40);
  assert.equal(s.send(bash(MERGE)), undefined);
  assert.match(denied(s.send(bash(`${MERGE} --match-head-commit ${OTHER}`))) ?? "", /give --match-head-commit once, not 2 times/);
  assert.match(denied(s.send(bash(`${MERGE} --match-head-commit=${OTHER}`))) ?? "", /give --match-head-commit once/);
  assert.match(denied(s.send(bash(`${MERGE} && gh pr merge 42 --squash --match-head-commit ${OTHER}`))) ?? "", /one merge per command; this command has 2/);
  assert.match(denied(s.send(bash(`${MERGE}; gh api -X PUT repos/o/r/pulls/42/merge`))) ?? "", /one merge per command/);
});

test("the merge check gets the pull request's number from the merge command", () => {
  const s = autopilotSession();
  s.sage("task", "T1", "set", "pr=40");
  assert.match(denied(s.send(bash(MERGE))) ?? "", /^sage: the merge check refuses: no task of PR 41 has verdicts on a1b2c3d/);
  assert.equal(s.send(bash(`gh pr merge 40 --squash --match-head-commit ${SHA}`)), undefined);
  assert.equal(s.send(bash(`gh pr merge https://github.com/o/r/pull/40 --squash --match-head-commit ${SHA}`)), undefined);
  assert.match(denied(s.send(bash(`gh pr merge --squash --match-head-commit ${SHA}`))) ?? "", /name the pull request by its number/);
});

test("the head SHA may be in capitals, but it must be all 40 characters", () => {
  const s = autopilotSession();
  assert.equal(s.send(bash(`gh pr merge 41 --squash --match-head-commit ${SHA.toUpperCase()}`)), undefined, "the ledger holds it in lowercase");
  assert.match(denied(s.send(bash(`gh pr merge 41 --squash --match-head-commit ${SHA.slice(0, 7)}`))) ?? "", /needs the full 40-character head SHA that the ledger verified, not "a1b2c3d"/);
});

test("the merge check refuses a merge when it cannot run, and the hook still answers nothing to other commands", () => {
  // The state tool does not load.
  const s = autopilotSession();
  const plugin = realpathSync(mkdtempSync(join(tmpdir(), "sage-plugin-")));
  mkdirSync(join(plugin, "hooks"));
  mkdirSync(join(plugin, "skills/sage"), { recursive: true });
  copyFileSync(HOOK, join(plugin, "hooks/sage-hook.mjs"));
  writeFileSync(join(plugin, "skills/sage/sage.mjs"), 'throw new Error("a broken state tool");\n');
  const send = (event, env = s.vars) => spawnSync("node", [join(plugin, "hooks/sage-hook.mjs")], { input: JSON.stringify({ session_id: "s1", ...event }), encoding: "utf8", env });
  const broken = send(bash(MERGE));
  assert.equal(broken.status, 0, broken.stderr);
  assert.match(denied(JSON.parse(broken.stdout || "{}")) ?? "", /the merge check refuses: it could not run \(a broken state tool\)/);
  const other = send(bash("git status"));
  assert.deepEqual([other.stdout, other.status], ["", 0]);
  // The hook cannot save its state.
  const file = join(mkdtempSync(join(tmpdir(), "sage-file-")), "not-a-folder");
  writeFileSync(file, "");
  const r = spawnSync("node", [HOOK], { input: JSON.stringify({ session_id: "s2", agent_type: "sage:chief-of-staff", ...bash(MERGE) }), encoding: "utf8", env: { ...s.vars, SAGE_HOOKS_STATE: join(file, "state") } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(denied(JSON.parse(r.stdout || "{}")) ?? "", /the merge check could not run \(ENOTDIR/);
});

test("the hook runs also when its path goes through a symbolic link", () => {
  const s = session();
  s.send(prompt("sage mode"));
  const link = join(mkdtempSync(join(tmpdir(), "sage-link-")), "sage");
  symlinkSync(fileURLToPath(new URL("../plugins/sage", import.meta.url)), link);
  const r = spawnSync("node", [join(link, "hooks/sage-hook.mjs")], { input: JSON.stringify({ session_id: "s1", ...bash(MERGE) }), encoding: "utf8", env: s.vars });
  assert.match(denied(JSON.parse(r.stdout || "{}")) ?? "", /autopilot is off/);
});

test("a refusal says merge check, and escapes the control characters of its reason", () => {
  const home = join(mkdtempSync(join(tmpdir(), "sage-esc-")), "home\u001b[31m");
  writeFileSync(home, ""); // a file, so the merge check cannot read it, and names it
  const s = session({ SAGE_HOME: home });
  s.send(prompt("sage mode"));
  s.send(prompt("autopilot on"));
  const reason = denied(s.send(bash(MERGE))) ?? "";
  assert.match(reason, /^sage: the merge check refuses: /);
  assert.match(reason, /home\\u001b\[31m/);
  assert.doesNotMatch(reason, /\u001b/);
});
