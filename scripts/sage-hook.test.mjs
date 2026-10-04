// Runs the sage hook as Claude Code does: one JSON event on stdin, one JSON answer (or nothing) on stdout.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
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
  assert.match(merge(), /the merge gate refuses: no verdicts recorded/);

  s.sage("init");
  s.sage("task", "add", "--title", "t", "--size", "small");
  for (const cycle of ["1", "2"]) for (const kind of ["checks-pass", "review-clean", "qa-pass"]) s.sage("verdict", "T1", "--sha", SHA, "--kind", kind, "--cycle", cycle);
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

/** The modes after the messages, as the gates show them: sage mode refuses the session's own edits, and with autopilot on a merge gets to the ledger check. */
async function modesAfter(messages) {
  const s = session();
  for (const text of messages) await s.sendAsync(prompt(text));
  const sage = Boolean(denied(await s.sendAsync(edit())));
  const merge = denied(await s.sendAsync(bash(`gh pr merge 41 --squash --match-head-commit ${SHA}`))) ?? "";
  const autopilot = /the merge gate refuses/.test(merge) ? "on" : /autopilot is off/.test(merge) || !sage ? "off" : merge;
  return `sage mode ${sage ? "on" : "off"}, autopilot ${autopilot}`;
}

test("only the start of a message switches a mode, except autopilot off, which works anywhere", async () => {
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
    [BOTH, NOTE, "sage mode on, autopilot off", "an agent's report with autopilot and an off word switches autopilot off, like any message"],
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
