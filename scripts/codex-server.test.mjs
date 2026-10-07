import "./test-env.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { ROOT } from "./build.mjs";

const session = "d72422c7-509c-43aa-8c42-827c556f8a57";
const childActor = "f22422c7-509c-43aa-8c42-827c556f8a58";
const turns = ["e22422c7-509c-43aa-8c42-827c556f8a57", "e22422c7-509c-43aa-8c42-827c556f8a58", "e22422c7-509c-43aa-8c42-827c556f8a59"];

function fixture(t, policy = "normal") {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "sage-native-server-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const plugin = join(dir, "plugin");
  cpSync(join(ROOT, "plugins/sage-codex"), plugin, { recursive: true });
  assert.ok(existsSync(join(plugin, "runtime/mcp-server.mjs")), "the native server ships in the plugin");
  const sessions = join(dir, "sessions"); mkdirSync(sessions);
  const transcript = join(sessions, "root.jsonl");
  writeFileSync(transcript, JSON.stringify({ type: "session_meta", payload: { id: session, session_id: session, cli_version: "0.160.0" } }) + "\n");
  const mode = { directory: join(dir, "admission"), project: "fixture", projectDirectory: dir, sessionsDir: sessions };
  const entry = join(dir, "server.mjs");
  writeFileSync(entry, `
    import { configureAdmission } from './plugin/core/index.mjs';
    import { readMode } from './plugin/runtime/mode.mjs';
    import { directEditDecision } from './plugin/runtime/file-policy.mjs';
    import { serveHooks } from './plugin/runtime/mcp-server.mjs';
    const mode = ${JSON.stringify(mode)};
    configureAdmission(mode.directory, { total: 3, projects: [{ project: 'fixture', limit: 3 }] });
    serveHooks({ mode, loadPolicy: async () => {
      if (${JSON.stringify(policy)} === 'throw') throw Error('private loader detail');
      return { evaluate: (input, native) => ${JSON.stringify(policy)} === 'invalid' ? { decision: 'allow' }
        : directEditDecision(input, { sage: readMode(mode.directory, mode.project, input.session_id).sage, chief: native.actor === input.session_id }) };
    } });
  `);
  return { dir, plugin, mode, entry, prompt: (text, turn = turns[0]) => ({ cwd: dir, hook_event_name: "UserPromptSubmit", model: "fixture",
    permission_mode: "default", prompt: text, session_id: session, transcript_path: transcript, turn_id: turn }) };
}
const patch = (turn = turns[0]) => ({ hook_event_name: "PreToolUse", session_id: session, turn_id: turn,
  tool_name: "apply_patch", tool_use_id: "call-1", tool_input: { patch: "fixed input" } });

async function connect(t, fixture, version = "0.160.0", expectedStderr = "", toolName = "sage_native_hook") {
  const child = spawn(process.execPath, [fixture.entry], { cwd: fixture.dir, stdio: ["pipe", "pipe", "pipe"], shell: false });
  t.after(() => child.stdin.end());
  let stderr = "", nextId = 0;
  const pending = new Map();
  const closed = new Promise(resolve => child.once("close", (code, signal) => {
    for (const { reject } of pending.values()) reject(Error("server closed before response"));
    resolve({ code, signal });
  }));
  child.stderr.on("data", data => { stderr += data; });
  createInterface({ input: child.stdout }).on("line", line => {
    try { const reply = JSON.parse(line); pending.get(reply.id)?.resolve(reply); pending.delete(reply.id); }
    catch (error) { for (const { reject } of pending.values()) reject(error); child.stdin.end(); }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId; pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const init = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "codex", version } });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const listed = await request("tools/list", {});
  assert.equal(listed.result.tools.length, 1);
  assert.equal(listed.result.tools[0].name, toolName);
  if (toolName === "sage_native_hook") assert.deepEqual(listed.result.tools[0]._meta.ui.visibility, ["app"]);
  else assert.equal(listed.result.tools[0]._meta?.ui?.visibility, undefined);
  return {
    call: async (input, actor = session) => {
      const response = await request("tools/call", { name: toolName, arguments: input, _meta: { threadId: actor } });
      assert.equal(response.error, undefined);
      if (toolName === "sage_native_hook") assert.equal(response.result.isError, undefined, "policy denials must be successful MCP results");
      else if (response.result.isError) return { error: response.result.content[0].text };
      assert.doesNotMatch(JSON.stringify(response), /private loader detail/);
      return JSON.parse(response.result.content[0].text);
    },
    close: async () => { child.stdin.end(); assert.deepEqual(await closed, { code: 0, signal: null }); assert.equal(stderr, expectedStderr); },
  };
}

test("packaged native server persists owner mode and keeps native child identity across connections", async t => {
  const f = fixture(t);
  for (const [index, text] of ["sage mode", "continue", "sage mode off"].entries()) {
    const client = await connect(t, f);
    assert.deepEqual(await client.call(f.prompt(text, turns[index])), {});
    const output = await client.call(patch(turns[index]));
    if (index < 2) assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
    else assert.deepEqual(output, {});
    assert.deepEqual(await client.call(patch(turns[index]), childActor), {});
    await client.close();
  }
  const { readAdmission } = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
  assert.deepEqual(readAdmission(f.mode.directory).modes.map(row => row.sage), [true, false]);
});

test("packaged native server explicitly blocks unverified and unsupported prompt requests", async t => {
  const f = fixture(t);
  const client = await connect(t, f);
  for (const [input, actor] of [[f.prompt("sage mode"), childActor], [f.prompt("sage mode"), null],
    [{ ...f.prompt("sage mode"), cwd: "/wrong-project" }, session], [{ hook_event_name: "Unknown" }, session],
    [{ ...f.prompt("sage mode"), prompt: "x".repeat(1024 * 1024 + 1) }, session]]) {
    assert.deepEqual(await client.call(input, actor), { decision: "block", reason: "Sage could not verify this hook request." });
  }
  await client.close();
  const unsupported = await connect(t, f, "unsupported");
  assert.equal((await unsupported.call(f.prompt("sage mode"))).decision, "block");
  assert.equal((await unsupported.call(patch())).hookSpecificOutput.permissionDecision, "deny");
  await unsupported.close();
  const { readAdmission } = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
  assert.deepEqual(readAdmission(f.mode.directory).sessions, []);
});

test("packaged native server denies failed and invalid tool policies without leaking errors", async t => {
  for (const policy of ["throw", "invalid"]) {
    const f = fixture(t, policy); const client = await connect(t, f);
    assert.equal((await client.call(patch())).hookSpecificOutput.permissionDecision, "deny");
    assert.equal((await client.call({ hook_event_name: "PreToolUse" })).hookSpecificOutput.permissionDecision, "deny");
    await client.close();
  }
});

test("packaged native server turns missing policy modules into explicit denials", async t => {
  const f = fixture(t);
  // Load the server first, then remove modules before their lazy import.
  const client = await connect(t, f);
  rmSync(join(f.plugin, "runtime/mcp-policy.mjs"));
  assert.equal((await client.call(patch())).hookSpecificOutput.permissionDecision, "deny");
  // mode.mjs was imported by the fixture launcher, so test its first lazy dependency instead.
  const source = readFileSync(f.entry, "utf8");
  await client.close();
  writeFileSync(f.entry, source.replace("import { readMode } from './plugin/runtime/mode.mjs';", "const readMode = () => ({ sage: false });"));
  rmSync(join(f.plugin, "runtime/mode.mjs"));
  const next = await connect(t, f);
  assert.equal((await next.call(f.prompt("sage mode"))).decision, "block");
  await next.close();
});


async function configured(t) {
  const f = fixture(t);
  const core = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
  core.configureAdmission(f.mode.directory, { total: 3, projects: [{ project: "fixture", limit: 3 }] });
  const configFile = join(f.dir, "native.json");
  const config = { version: 1, mode: { ...f.mode } };
  writeFileSync(configFile, JSON.stringify(config));
  const api = await import(pathToFileURL(join(f.plugin, "runtime/configuration.mjs")));
  const entry = readFileSync(f.entry, "utf8")
    .replace("import { serveHooks } from './plugin/runtime/mcp-server.mjs';", "import { serveConfiguredHooks } from './plugin/runtime/configuration.mjs';")
    .replace("serveHooks({ mode, loadPolicy: async () => {", `serveConfiguredHooks(${JSON.stringify(configFile)}, async mode => {`)
    .replace("    } });", "    });");
  writeFileSync(f.entry, entry);
  return { ...f, ...api, configFile, config };
}
const configDenied = error => error.message === "Sage native hook configuration is unavailable.";

test("native launcher configuration reads fixed project settings without changing the journal", async t => {
  const f = await configured(t);
  const before = readdirSync(f.mode.directory).sort().map(name => [name, readFileSync(join(f.mode.directory, name), "utf8")]);
  const mode = f.readHookConfiguration(f.configFile);
  assert.deepEqual(mode, f.mode);
  assert.equal(Object.isFrozen(mode), true);
  assert.deepEqual(readdirSync(f.mode.directory).sort().map(name => [name, readFileSync(join(f.mode.directory, name), "utf8")]), before);
  const client = await connect(t, f);
  assert.deepEqual(await client.call(f.prompt("sage mode")), {});
  assert.equal((await client.call(patch())).hookSpecificOutput.permissionDecision, "deny");
  // A connection keeps its verified configuration even if the file changes later.
  writeFileSync(f.configFile, "invalid");
  assert.deepEqual(await client.call(f.prompt("sage mode off", turns[1])), {});
  assert.deepEqual(await client.call(patch(turns[1])), {});
  await client.close();
});

test("native launcher configuration rejects unknown fields and unconfigured paths without creating state", async t => {
  const f = await configured(t);
  const missing = join(f.dir, "must-not-be-created");
  for (const config of [null, [], {}, { ...f.config, version: 2 }, { ...f.config, loader: "untrusted.mjs" },
    { ...f.config, mode: { ...f.mode, extra: true } }, { ...f.config, mode: { ...f.mode, project: "other" } },
    { ...f.config, mode: { ...f.mode, directory: missing } }, { ...f.config, mode: { ...f.mode, directory: f.dir } },
    { ...f.config, mode: { ...f.mode, sessionsDir: f.configFile } }, { ...f.config, mode: { ...f.mode, projectDirectory: "." } }]) {
    writeFileSync(f.configFile, JSON.stringify(config));
    assert.throws(() => f.readHookConfiguration(f.configFile), configDenied);
  }
  assert.equal(existsSync(missing), false);
});

test("native launcher configuration rejects links, oversized files, invalid bytes, and non-files", async t => {
  const f = await configured(t);
  const linked = join(f.dir, "linked.json"); symlinkSync(f.configFile, linked);
  const linkedDir = join(f.dir, "linked-directory"); symlinkSync(f.dir, linkedDir, "dir");
  for (const path of [linked, join(linkedDir, "native.json"), f.dir, "native.json"]) {
    assert.throws(() => f.readHookConfiguration(path), configDenied);
  }
  writeFileSync(f.configFile, JSON.stringify({ ...f.config, mode: { ...f.mode, sessionsDir: linkedDir } }));
  assert.throws(() => f.readHookConfiguration(f.configFile), configDenied);
  for (const bytes of [Buffer.from([0xff]), Buffer.from("{}".padEnd(64 * 1024 + 1, " "))]) {
    writeFileSync(f.configFile, bytes);
    assert.throws(() => f.readHookConfiguration(f.configFile), configDenied);
  }
});

test("invalid native launcher configuration blocks prompts and tools until a new connection", async t => {
  const f = await configured(t);
  const marker = join(f.dir, "loader-called");
  writeFileSync(f.entry, "import {writeFileSync} from 'node:fs';\n" + readFileSync(f.entry, "utf8")
    .replace("async mode => {", `async mode => { writeFileSync(${JSON.stringify(marker)}, 'called');`));
  writeFileSync(f.configFile, "invalid");
  const client = await connect(t, f, "0.160.0", "Sage native hook configuration is unavailable.\n");
  assert.equal((await client.call(f.prompt("sage mode"))).decision, "block");
  assert.equal((await client.call(patch())).hookSpecificOutput.permissionDecision, "deny");
  writeFileSync(f.configFile, JSON.stringify(f.config));
  assert.equal((await client.call(f.prompt("sage mode"))).decision, "block");
  assert.equal((await client.call(patch())).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(existsSync(marker), false, "invalid configuration must not invoke policy loading");
  await client.close();
  const repaired = await connect(t, f);
  assert.deepEqual(await repaired.call(f.prompt("sage mode")), {});
  assert.equal((await repaired.call(patch())).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(readFileSync(marker, "utf8"), "called");
  await repaired.close();
});


test("native launcher configuration permits a not-yet-created session directory but rejects dangling links", async t => {
  const f = await configured(t);
  rmSync(f.mode.sessionsDir, { recursive: true });
  assert.deepEqual(f.readHookConfiguration(f.configFile), f.mode);
  assert.equal(existsSync(f.mode.sessionsDir), false, "configuration must not create the native session directory");
  symlinkSync(join(f.dir, "absent-target"), f.mode.sessionsDir, "dir");
  assert.throws(() => f.readHookConfiguration(f.configFile), configDenied);
  writeFileSync(f.configFile, JSON.stringify({ ...f.config, mode: { ...f.mode, sessionsDir: f.mode.sessionsDir + "/" } }));
  assert.throws(() => f.readHookConfiguration(f.configFile), configDenied);
});

function childFixture(t, outcome = { decision: "deliver", brief: "Role: implementer\nTask: the fixed fixture task." }) {
  const f = fixture(t);
  const transcript = join(f.mode.sessionsDir, "child.jsonl");
  const metadata = { id: childActor, session_id: session, parent_thread_id: session,
    agent_path: "/root/fixture", cli_version: "0.160.0" };
  const writeMetadata = (value = metadata, turn = turns[0]) => writeFileSync(transcript,
    JSON.stringify({ type: "session_meta", payload: value }) + "\n"
    + JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: turn } }) + "\n");
  writeMetadata();
  const marker = join(f.dir, "start-policy.json");
  writeFileSync(f.entry, "import { writeFileSync } from 'node:fs';\n" + readFileSync(f.entry, "utf8")
    .replace("return { evaluate:", `return { startChild: identity => {
      if (!Object.isFrozen(identity)) throw Error('private unfrozen identity');
      writeFileSync(${JSON.stringify(marker)}, JSON.stringify(identity));
      return ${JSON.stringify(outcome)};
    }, evaluate:`));
  return { ...f, transcript, metadata, marker, writeMetadata, start: () => ({ hook_event_name: "SubagentStart",
    session_id: session, turn_id: turns[0], agent_id: childActor, transcript_path: transcript }) };
}

test("packaged child start delivers policy instructions only after native identity verification", async t => {
  const f = childFixture(t); const client = await connect(t, f);
  assert.deepEqual(await client.call(f.start(), childActor), { hookSpecificOutput: {
    hookEventName: "SubagentStart", additionalContext: "Role: implementer\nTask: the fixed fixture task." } });
  assert.deepEqual(JSON.parse(readFileSync(f.marker, "utf8")), { session, child: childActor,
    parent: session, path: "/root/fixture", turn: turns[0] });
  await client.close();
});

test("packaged child start rejects mismatched native actors and metadata before policy invocation", async t => {
  const f = childFixture(t); const client = await connect(t, f);
  for (const [input, actor] of [[f.start(), session], [f.start(), null],
    [{ ...f.start(), role: "lead" }, childActor], [{ ...f.start(), turn_id: "invalid" }, childActor],
    [{ ...f.start(), transcript_path: f.prompt("test").transcript_path }, childActor]]) {
    assert.equal((await client.call(input, actor)).decision, "block");
    assert.equal(existsSync(f.marker), false);
  }
  for (const change of [{ cli_version: "old" }, { session_id: childActor }, { id: session },
    { parent_thread_id: childActor }, { parent_thread_id: null }, { agent_path: "/root" }]) {
    f.writeMetadata({ ...f.metadata, ...change });
    assert.equal((await client.call(f.start(), childActor)).decision, "block");
    assert.equal(existsSync(f.marker), false);
  }
  f.writeMetadata();
  await client.close();
  const unsupported = await connect(t, f, "old");
  assert.equal((await unsupported.call(f.start(), childActor)).decision, "block");
  assert.equal(existsSync(f.marker), false);
  await unsupported.close();
});

test("packaged child start refuses missing identity and invalid briefs without protocol errors", async t => {
  for (const outcome of [null, { decision: "allow" }, { decision: "deliver", brief: "" },
    { decision: "deliver", brief: "x".repeat(64 * 1024 + 1) }, { decision: "deliver", brief: "x\0y" },
    { decision: "pass", brief: "unexpected" }]) {
    const f = childFixture(t, outcome); const client = await connect(t, f);
    assert.deepEqual(await client.call(f.start(), childActor), { decision: "block", reason: "Sage could not verify this hook request." });
    await client.close();
  }
  const f = childFixture(t); const client = await connect(t, f);
  rmSync(f.transcript);
  assert.equal((await client.call(f.start(), childActor)).decision, "block");
  assert.equal(existsSync(f.marker), false);
  await client.close();
});

test("packaged child start supports explicit no-instruction policy and contains loader failures", async t => {
  const f = childFixture(t, { decision: "pass" }); const client = await connect(t, f);
  assert.deepEqual(await client.call(f.start(), childActor), {});
  await client.close();
  for (const replacement of ["throw Error('private loader detail');", "return {};",
    "return { startChild() { throw Error('private loader detail'); } };"]) {
    const failed = childFixture(t);
    writeFileSync(failed.entry, readFileSync(failed.entry, "utf8").replace("loadPolicy: async () => {", `loadPolicy: async () => { ${replacement}`));
    const next = await connect(t, failed);
    assert.equal((await next.call(failed.start(), childActor)).decision, "block");
    await next.close();
  }
});

test("packaged child start uses child metadata and native turn when history contains parent records", async t => {
  const f = childFixture(t);
  writeFileSync(f.transcript, JSON.stringify({ type: "session_meta", payload: f.metadata }) + "\n"
    + JSON.stringify({ type: "session_meta", payload: { id: session, session_id: session, cli_version: "0.160.0" } }) + "\n"
    + JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: turns[0] } }) + "\n");
  const client = await connect(t, f);
  const result = await client.call({ ...f.start(), turn_id: turns[1] }, childActor);
  assert.equal(result.hookSpecificOutput?.additionalContext, "Role: implementer\nTask: the fixed fixture task.");
  assert.equal(JSON.parse(readFileSync(f.marker, "utf8")).turn, turns[1]);
  await client.close();
});

const postSpawn = () => ({ hook_event_name: "PostToolUse", session_id: session, turn_id: turns[0],
  tool_name: "collaborationspawn_agent", tool_use_id: "spawn-1", tool_input: { task_name: "qa", message: "private task" },
  tool_response: JSON.stringify({ task_name: "/root/qa", detail: "private result" }) });

test("packaged native server records post-tool identity with a durable idempotent receipt", async t => {
  const f = fixture(t); const observations = join(f.dir, "observations");
  writeFileSync(f.entry, "import { publish } from './plugin/runtime/events.mjs';\n" + readFileSync(f.entry, "utf8")
    .replace("return { evaluate:", `return { recordDispatchResult: record => {
      publish(${JSON.stringify(observations)}, record); return { decision: 'recorded' };
    }, evaluate:`));
  const client = await connect(t, f);
  for (const actor of [session, session, childActor]) assert.deepEqual(await client.call(postSpawn(), actor), {});
  await client.close();
  const { readObservations } = await import(pathToFileURL(join(f.plugin, "runtime/events.mjs")));
  const records = readObservations(observations);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map(row => row.actor).sort(), [session, childActor].sort());
  assert(records.every(row => row.kind === "spawn-result" && row.session === session && row.call === "spawn-1"));
  assert.doesNotMatch(JSON.stringify(records), /private/);
});

test("packaged native server contains post-tool validation, loading, and publication failures", async t => {
  const f = fixture(t, "throw"); const client = await connect(t, f);
  for (const [input, actor] of [[postSpawn(), session], [postSpawn(), null],
    [{ ...postSpawn(), agent_id: childActor }, session], [{ ...postSpawn(), tool_response: "malformed" }, session]]) {
    assert.deepEqual(await client.call(input, actor), { decision: "block", reason: "Sage could not verify this hook request." });
  }
  await client.close();
  const missing = fixture(t); rmSync(join(missing.plugin, "runtime/post-tool.mjs"));
  const next = await connect(t, missing);
  assert.equal((await next.call(postSpawn())).decision, "block");
  await next.close();
  const failed = fixture(t);
  writeFileSync(failed.entry, readFileSync(failed.entry, "utf8").replace("return { evaluate:",
    "return { recordDispatchResult() { throw Error('private loader detail'); }, evaluate:"));
  const failedClient = await connect(t, failed);
  assert.equal((await failedClient.call(postSpawn())).decision, "block");
  await failedClient.close();
});

test("packaged child start rejects inherited policy fields instead of delivering an invalid brief", async t => {
  for (const expression of ["Object.assign(Object.create({decision:'deliver'}),{brief:'invalid inherited decision',extra:true})",
    "Object.assign(Object.create({brief:'invalid inherited brief'}),{decision:'deliver',extra:true})"]) {
    const f = childFixture(t);
    writeFileSync(f.entry, readFileSync(f.entry, "utf8").replace(
      'return {"decision":"deliver","brief":"Role: implementer\\nTask: the fixed fixture task."};', `return ${expression};`));
    const client = await connect(t, f);
    assert.equal((await client.call(f.start(), childActor)).decision, "block");
    await client.close();
  }
});

async function preparationServerFixture(t) {
  const f = fixture(t);
  assert.ok(existsSync(join(f.plugin, "runtime/preparation-server.mjs")), "the separate preparation server must ship");
  const core = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
  const events = await import(pathToFileURL(join(f.plugin, "runtime/events.mjs")));
  const api = await import(pathToFileURL(join(f.plugin, "runtime/preparation.mjs")));
  const options = { directory: f.mode.directory, project: f.mode.project, observationsRoot: join(f.dir, "observations") };
  core.configureAdmission(options.directory, { total: 5, projects: [{ project: options.project, limit: 5 }] });
  const owner = core.activateAdmission(options.directory, { project: options.project, session: `codex:${session}`, activation: turns[0] });
  const scope = { project: owner.project, session: owner.session, epoch: owner.epoch };
  writeFileSync(f.entry, `import { servePreparations } from './plugin/runtime/preparation-server.mjs'; servePreparations(${JSON.stringify(options)});`);
  const brief = Object.fromEntries(["GOAL", "SCOPE", "CONTEXT", "DECISIONS", "ACCEPTANCE", "VERIFY", "BUDGET", "FORBIDDEN", "REPORT", "STANDING"].map(key => [key, "Complete the fixture task."]));
  const input = { task: "T1", run: "R1", name: "fixture_lead", role: "lead", brief };
  const native = actor => ({ version: "0.160.0", actor });
  const spawnInput = (name = input.name, call = "spawn-1") => ({ hook_event_name: "PreToolUse", session_id: session,
    turn_id: turns[0], tool_name: "collaborationspawn_agent", tool_use_id: call, tool_input: { task_name: name, message: "opaque native input" } });
  const bindLead = () => {
    api.prepareNativeTask(input, native(session), options);
    const admitted = api.reservePreparedSpawn(spawnInput(), native(session), options);
    events.publish(join(options.observationsRoot, session), { schema: 1, runtime: "0.160.0", session,
      kind: "spawn-result", actor: session, call: "spawn-1", turn: turns[0], path: "/root/fixture_lead" });
    events.publish(join(options.observationsRoot, session), { schema: 1, runtime: "0.160.0", session,
      kind: "child-start", child: childActor, parent: session, path: "/root/fixture_lead", turn: turns[1] });
    core.bindAdmission(options.directory, { ...scope, assignment: admitted.assignment.id, issuer: session,
      call: "spawn-1", child: childActor, turn: turns[1] });
  };
  const connectVisible = version => connect(t, f, version, "", "sage_prepare_task");
  return { ...f, core, events, api, options, scope, input, native, spawnInput, bindLead, connectVisible };
}

test("visible preparation server saves the native owner's brief without dispatch or capacity", async t => {
  const f = await preparationServerFixture(t); const client = await f.connectVisible();
  const saved = await client.call(f.input);
  assert.equal(saved.decision, "prepared");
  assert.deepEqual(Object.keys(saved).sort(), ["decision", "preparation", "task", "run", "name", "role"].sort());
  assert.equal(saved.name, f.input.name);
  assert.equal((await client.call(f.input)).preparation, saved.preparation);
  await client.close();
  const state = f.core.readAdmission(f.options.directory);
  assert.equal(state.preparations.length, 1);
  assert.equal(state.preparations[0].issuer, session);
  assert.deepEqual(state.preparations[0].brief, f.input.brief);
  assert.deepEqual(state.reservations, []);
  assert.equal(existsSync(f.options.observationsRoot), false);
});

test("visible preparation server refuses forged identity unsupported versions and invalid work", async t => {
  const f = await preparationServerFixture(t); const client = await f.connectVisible();
  for (const [input, actor] of [[f.input, childActor], [f.input, null], [{ ...f.input, issuer: session }, session],
    [{ ...f.input, role: "chief-of-staff" }, session], [{ ...f.input, name: "root" }, session],
    [{ ...f.input, name: "../other" }, session], [{ ...f.input, brief: { ...f.input.brief, GOAL: "" } }, session],
    [{ ...f.input, brief: { ...f.input.brief, GOAL: "x".repeat(32769) } }, session]]) {
    assert.equal(typeof (await client.call(input, actor)).error, "string");
  }
  await client.close();
  const unsupported = await f.connectVisible("old");
  assert.equal(typeof (await unsupported.call(f.input)).error, "string"); await unsupported.close();
  assert.deepEqual(f.core.readAdmission(f.options.directory).preparations, []);
});

test("visible preparation server uses a verified lead binding and rejects ambiguous native history", async t => {
  const f = await preparationServerFixture(t); f.bindLead(); const client = await f.connectVisible();
  const task = { ...f.input, name: "qa_child", role: "qa" };
  assert.equal((await client.call(task, childActor)).decision, "prepared");
  assert.equal(typeof (await client.call({ ...task, name: "nested_lead", role: "lead" }, childActor)).error, "string");
  f.events.publish(join(f.options.observationsRoot, session), { schema: 1, runtime: "0.160.0", session,
    kind: "spawn-request", actor: session, call: "reused-path", turn: turns[2], name: "fixture_lead" });
  assert.equal(typeof (await client.call({ ...task, name: "another_qa" }, childActor)).error, "string");
  await client.close();
  assert.equal(f.core.readAdmission(f.options.directory).preparations.length, 2);
});

test("native prepared spawn consumes only matching authenticated work and keeps rejected observations", async t => {
  const f = await preparationServerFixture(t); const client = await f.connectVisible();
  const saved = await client.call(f.input); await client.close();
  assert.throws(() => f.api.reservePreparedSpawn(f.spawnInput(), f.native(childActor), f.options));
  const first = f.api.reservePreparedSpawn(f.spawnInput(), f.native(session), f.options);
  assert.equal(first.decision, "permit-once");
  assert.equal(f.api.reservePreparedSpawn(f.spawnInput(), f.native(session), f.options).decision, "already-reserved");
  assert.throws(() => f.api.reservePreparedSpawn(f.spawnInput(f.input.name, "another-call"), f.native(session), f.options), /already has a dispatch/);
  assert.throws(() => f.api.reservePreparedSpawn(f.spawnInput("unprepared", "unknown"), f.native(session), f.options));
  const state = f.core.readAdmission(f.options.directory);
  assert.equal(state.reservations.length, 1); assert.equal(state.reservations[0].preparation, saved.preparation);
  assert.deepEqual(state.reservations[0].brief, f.input.brief);
  const observed = f.events.readObservations(join(f.options.observationsRoot, session));
  assert.equal(observed.length, 4);
  assert.doesNotMatch(JSON.stringify(observed), /opaque native input/);
});

test("native prepared spawn refuses mode-off and changed scope and keeps the prepared work", async t => {
  const f = await preparationServerFixture(t);
  f.api.prepareNativeTask(f.input, f.native(session), f.options);
  const other = "d72422c7-509c-43aa-8c42-827c556f8a58";
  assert.throws(() => f.api.reservePreparedSpawn({ ...f.spawnInput(), session_id: other }, f.native(session), f.options));
  f.core.changeAdmissionMode(f.options.directory, { ...f.scope, after: turns[0], turn: turns[1], sage: false });
  assert.throws(() => f.api.reservePreparedSpawn(f.spawnInput(), f.native(session), f.options), /mode is off/);
  const client = await f.connectVisible();
  assert.equal(typeof (await client.call({ ...f.input, name: "other" })).error, "string");
  assert.equal((await client.call(f.input)).decision, "already-prepared"); await client.close();
  assert.equal(f.core.readAdmission(f.options.directory).preparations.length, 1);
  assert.deepEqual(f.core.readAdmission(f.options.directory).reservations, []);
});

test("visible preparation server contains missing modules and unavailable storage", async t => {
  for (const failure of ["module", "journal"]) {
    const f = await preparationServerFixture(t); const client = await f.connectVisible();
    if (failure === "module") rmSync(join(f.plugin, "runtime/preparation.mjs"));
    else writeFileSync(join(f.options.directory, "00000000.json"), "private storage error");
    const output = await client.call(f.input);
    assert.deepEqual(output, { error: "Sage could not prepare this task. Check the active role, task brief, and unique agent name." });
    await client.close();
  }
  const specialist = await preparationServerFixture(t); specialist.input.role = "qa"; specialist.bindLead();
  const client = await specialist.connectVisible();
  assert.equal(typeof (await client.call({ ...specialist.input, name: "third_layer" }, childActor)).error, "string");
  await client.close();
  assert.equal(specialist.core.readAdmission(specialist.options.directory).preparations.length, 1);
});

async function sharedConfiguration(t) {
  const f = await configured(t);
  const observationsRoot = join(f.dir, "observations"); mkdirSync(observationsRoot);
  const config = { version: 2, mode: { ...f.mode, observationsRoot } };
  writeFileSync(f.configFile, JSON.stringify(config));
  const preparationEntry = join(f.dir, "preparation.mjs");
  writeFileSync(preparationEntry, `import { serveConfiguredPreparations } from './plugin/runtime/configuration.mjs'; serveConfiguredPreparations(${JSON.stringify(f.configFile)});`);
  return { ...f, config, preparationEntry };
}

test("shared server configuration fixes the same journal project and event store for both launchers", async t => {
  const f = await sharedConfiguration(t);
  assert.deepEqual(f.readHookConfiguration(f.configFile), f.config.mode);
  assert.equal(Object.isFrozen(f.readHookConfiguration(f.configFile)), true);
  const loaded = join(f.dir, "loaded-config.json");
  writeFileSync(f.entry, "import { writeFileSync } from 'node:fs';\n" + readFileSync(f.entry, "utf8")
    .replace("async mode => {", `async mode => { writeFileSync(${JSON.stringify(loaded)}, JSON.stringify(mode));`));
  const hooks = await connect(t, f);
  assert.deepEqual(await hooks.call(f.prompt("sage mode")), {});
  const visible = await connect(t, { ...f, entry: f.preparationEntry }, "0.160.0", "", "sage_prepare_task");
  // Both connections retain their startup values after the file changes.
  writeFileSync(f.configFile, "invalid");
  const core = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
  const brief = Object.fromEntries(core.BRIEF_FIELDS.map(field => [field, "Fixed fixture value."]));
  const prepared = await visible.call({ task: "T1", run: "R1", name: "lead_1", role: "lead", brief });
  assert.equal(prepared.decision, "prepared");
  const state = core.readAdmission(f.mode.directory);
  assert.equal(state.preparations.length, 1);
  assert.equal(state.preparations[0].project, f.mode.project);
  assert.equal(state.reservations.length, 0);
  assert.deepEqual(readdirSync(f.config.mode.observationsRoot), []);
  assert.equal((await hooks.call(patch())).hookSpecificOutput.permissionDecision, "deny");
  assert.deepEqual(JSON.parse(readFileSync(loaded, "utf8")), f.config.mode);
  await visible.close(); await hooks.close();
});

test("shared server configuration rejects missing linked or unknown observation settings", async t => {
  const f = await sharedConfiguration(t);
  const root = f.config.mode.observationsRoot;
  const linked = join(f.dir, "linked-observations"); symlinkSync(root, linked, "dir");
  const missing = join(f.dir, "missing-observations");
  for (const config of [{ ...f.config, version: 3 },
    { version: 1, mode: f.config.mode }, { version: 2, mode: f.mode },
    ...[linked, missing, f.configFile, "relative", f.mode.directory, f.dir].map(observationsRoot => ({ ...f.config, mode: { ...f.config.mode, observationsRoot } }))]) {
    writeFileSync(f.configFile, JSON.stringify(config));
    assert.throws(() => f.readHookConfiguration(f.configFile), configDenied);
  }
  assert.equal(existsSync(missing), false);
});

test("shared server configuration leaves invalid preparation connections unavailable until restart", async t => {
  const f = await sharedConfiguration(t);
  assert.equal(typeof f.serveConfiguredPreparations, "function");
  const core = await import(pathToFileURL(join(f.plugin, "core/index.mjs")));
  const hooks = await connect(t, f);
  await hooks.call(f.prompt("sage mode")); await hooks.close();
  const input = { task: "T1", run: "R1", name: "lead_1", role: "lead",
    brief: Object.fromEntries(core.BRIEF_FIELDS.map(field => [field, "Fixed fixture value."])) };
  writeFileSync(f.configFile, JSON.stringify({ version: 1, mode: f.mode }));
  const visible = await connect(t, { ...f, entry: f.preparationEntry }, "0.160.0", "Sage native hook configuration is unavailable.\n", "sage_prepare_task");
  assert.match((await visible.call(input)).error, /could not prepare/);
  writeFileSync(f.configFile, JSON.stringify(f.config));
  assert.match((await visible.call(input)).error, /could not prepare/);
  assert.equal(core.readAdmission(f.mode.directory).preparations.length, 0);
  await visible.close();
  const repaired = await connect(t, { ...f, entry: f.preparationEntry }, "0.160.0", "", "sage_prepare_task");
  assert.equal((await repaired.call(input)).decision, "prepared");
  await repaired.close();
});

async function composedPolicyFixture(t) {
  const f = await preparationServerFixture(t);
  const module = join(f.plugin, "runtime/policy.mjs");
  assert.ok(existsSync(module), "the composed native policy must ship");
  const { createNativePolicy } = await import(pathToFileURL(module));
  const { nativeToolEvent } = await import(pathToFileURL(join(f.plugin, "runtime/native-tool.mjs")));
  const evaluate = (policy, input = f.spawnInput(), actor = session) => policy.evaluate(nativeToolEvent(input, f.native(actor), "PreToolUse"), f.native(actor));
  const identity = { session, child: childActor, parent: session, path: "/root/fixture_lead", turn: turns[1] };
  const result = { schema: 1, runtime: "0.160.0", session, kind: "spawn-result", actor: session, call: "spawn-1", turn: turns[0], path: identity.path };
  return { ...f, createNativePolicy, evaluate, identity, result };
}

test("composed native policy connects configured preparation spawn and nested child instructions", async t => {
  const f = await composedPolicyFixture(t);
  mkdirSync(f.options.observationsRoot);
  const config = join(f.dir, "policy.json");
  writeFileSync(config, JSON.stringify({ version: 2, mode: { ...f.mode, observationsRoot: f.options.observationsRoot } }));
  const hiddenEntry = join(f.dir, "hidden.mjs");
  writeFileSync(hiddenEntry, `import { serveConfiguredHooks } from './plugin/runtime/configuration.mjs';
    import { createNativePolicy } from './plugin/runtime/policy.mjs';
    serveConfiguredHooks(${JSON.stringify(config)}, options => createNativePolicy(options, (input, context) =>
      input.tool_name === 'apply_patch' && context.sage && context.actor === input.session_id
        ? { decision: 'deny', reason: 'The fixture chief cannot edit.' } : { decision: 'pass' }));`);
  writeFileSync(f.entry, `import { serveConfiguredPreparations } from './plugin/runtime/configuration.mjs'; serveConfiguredPreparations(${JSON.stringify(config)});`);
  const visible = await f.connectVisible();
  const hooks = await connect(t, { ...f, entry: hiddenEntry });
  const qa = "a22422c7-509c-43aa-8c42-827c556f8a59";
  const start = (child, parent, path, turn) => {
    const transcript = join(f.mode.sessionsDir, `${child}.jsonl`);
    writeFileSync(transcript, JSON.stringify({ type: "session_meta", payload: { id: child, session_id: session,
      parent_thread_id: parent, agent_path: path, cli_version: "0.160.0" } }) + "\n");
    return { hook_event_name: "SubagentStart", session_id: session, agent_id: child, turn_id: turn, transcript_path: transcript };
  };
  for (const [request, actor, child, path, turn] of [
    [f.input, session, childActor, "/root/fixture_lead", turns[1]],
    [{ ...f.input, name: "qa_child", role: "qa" }, childActor, qa, "/root/fixture_lead/qa_child", turns[2]],
  ]) {
    assert.equal((await visible.call(request, actor)).decision, "prepared");
    const spawn = f.spawnInput(request.name, request.name);
    assert.deepEqual(await hooks.call(spawn, actor), {});
    assert.equal((await hooks.call(spawn, actor)).hookSpecificOutput.permissionDecision, "deny");
    assert.deepEqual(await hooks.call({ ...spawn, hook_event_name: "PostToolUse", tool_response: { task_name: path } }, actor), {});
    const delivered = await hooks.call(start(child, actor, path, turn), child);
    assert.match(delivered.hookSpecificOutput.additionalContext, new RegExp(`Role: ${request.role}`));
    assert.match(delivered.hookSpecificOutput.additionalContext, /# Task brief/);
    assert.match(delivered.hookSpecificOutput.additionalContext, /Complete the fixture task/);
  }
  assert.equal((await hooks.call(patch())).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(f.core.readAdmission(f.options.directory).reservations.length, 2);
  assert.equal(f.core.readAdmission(f.options.directory).bindings.length, 2);
  assert.equal(f.events.readObservations(join(f.options.observationsRoot, session)).length, 6);
  await visible.close(); await hooks.close();
});

test("composed native policy captures inactive and denied attempts without consuming capacity", async t => {
  const f = await composedPolicyFixture(t);
  f.api.prepareNativeTask(f.input, f.native(session), f.options);
  const denied = f.createNativePolicy(f.options, () => ({ decision: "deny", reason: "Fixture denial." }));
  assert.deepEqual(await f.evaluate(denied), { decision: "deny", reason: "Fixture denial." });
  assert.equal(f.core.readAdmission(f.options.directory).reservations.length, 0);
  f.core.changeAdmissionMode(f.options.directory, { ...f.scope, after: turns[0], turn: turns[1], sage: false });
  const policy = f.createNativePolicy(f.options, () => ({ decision: "pass" }));
  assert.deepEqual(await f.evaluate(policy, f.spawnInput("inactive", "off-call")), { decision: "pass" });
  assert.deepEqual(policy.startChild(f.identity), { decision: "pass" });
  assert.deepEqual(policy.recordDispatchResult(f.result), { decision: "recorded" });
  assert.deepEqual(f.events.readObservations(join(f.options.observationsRoot, session)).map(row => row.kind).sort(),
    ["child-start", "spawn-request", "spawn-request", "spawn-result"]);
  assert.equal(f.core.readAdmission(f.options.directory).reservations.length, 0);
  assert.equal(f.core.readAdmission(f.options.directory).bindings.length, 0);
});

test("composed native policy requires exact tool decisions and authenticated derived actors", async t => {
  const f = await composedPolicyFixture(t);
  assert.throws(() => f.createNativePolicy(f.options));
  f.api.prepareNativeTask(f.input, f.native(session), f.options);
  for (const value of [Object.assign(Object.create({ decision: "pass" }), { unrelated: true }), undefined, {}, { decision: "allow" }, { decision: "pass", extra: true }, { decision: "deny", reason: "" }]) {
    const policy = f.createNativePolicy(f.options, () => value);
    await assert.rejects(f.evaluate(policy));
  }
  const policy = f.createNativePolicy(f.options, () => { throw Error("private detail"); });
  await assert.rejects(f.evaluate(policy));
  const passing = f.createNativePolicy(f.options, () => ({ decision: "pass" }));
  await assert.rejects(passing.evaluate({ ...f.spawnInput(), agent_id: childActor }, f.native(session)));
  await assert.rejects(passing.evaluate(f.spawnInput(), f.native(childActor)));
  await assert.rejects(passing.evaluate(f.spawnInput(), { ...f.native(session), version: "unsupported" }));
  assert.equal(f.core.readAdmission(f.options.directory).reservations.length, 0);
});

test("composed native policy keeps the admitted input private and refuses a changed mode", async t => {
  const f = await composedPolicyFixture(t);
  f.api.prepareNativeTask(f.input, f.native(session), f.options);
  const options = { ...f.options };
  const policy = f.createNativePolicy(options, input => {
    input.tool_input.task_name = "mutated";
    return { decision: "pass" };
  });
  options.directory = "not-the-journal";
  assert.deepEqual(await f.evaluate(policy), { decision: "pass" });
  assert.equal(f.core.readAdmission(f.options.directory).reservations[0].dispatch.name, f.input.name);
  assert.equal((await f.evaluate(policy)).decision, "deny");
  const changed = f.createNativePolicy(f.options, () => {
    f.core.changeAdmissionMode(f.options.directory, { ...f.scope, after: turns[0], turn: turns[1], sage: false });
    return { decision: "pass" };
  });
  await assert.rejects(f.evaluate(changed, f.spawnInput("next", "next-call")));
  assert.equal(f.core.readAdmission(f.options.directory).reservations.length, 1);
});

test("composed native policy holds incomplete child evidence until the matching result is recorded", async t => {
  const f = await composedPolicyFixture(t);
  f.api.prepareNativeTask(f.input, f.native(session), f.options);
  const policy = f.createNativePolicy(f.options, () => ({ decision: "pass" }));
  await f.evaluate(policy);
  assert.throws(() => policy.startChild(f.identity));
  assert.equal(f.core.readAdmission(f.options.directory).reservations.length, 1);
  assert.equal(f.core.readAdmission(f.options.directory).bindings.length, 0);
  assert.throws(() => policy.recordDispatchResult({ ...f.result, kind: "spawn-request", name: "invalid" }));
  policy.recordDispatchResult(f.result);
  assert.equal(policy.startChild(f.identity).decision, "deliver");
  assert.equal(f.core.readAdmission(f.options.directory).bindings.length, 1);
  // A new call reusing the path makes further delivery ambiguous, even though it was denied.
  const denied = f.createNativePolicy(f.options, () => ({ decision: "deny", reason: "Fixture denial." }));
  await f.evaluate(denied, f.spawnInput(f.input.name, "reused-call"));
  assert.throws(() => policy.startChild(f.identity));
  assert.equal(f.core.readAdmission(f.options.directory).reservations.length, 1);
});
