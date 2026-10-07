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

async function connect(t, fixture, version = "0.160.0", expectedStderr = "") {
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
  assert.deepEqual(listed.result.tools[0]._meta.ui.visibility, ["app"]);
  return {
    call: async (input, actor = session) => {
      const response = await request("tools/call", { name: "sage_native_hook", arguments: input, _meta: { threadId: actor } });
      assert.equal(response.error, undefined);
      assert.equal(response.result.isError, undefined, "policy denials must be successful MCP results");
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
