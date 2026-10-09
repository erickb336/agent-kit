// Isolated native V2 transport check with simulated model responses; not a live Sage pilot.
// No timeout or process signal: retain the caller's tool session handle if the child stalls.
import http from "node:http";
import assert from "node:assert/strict";
import {readdirSync,readFileSync} from "node:fs";
import {setupCapture} from "./fixtures/codex-native/setup-capture.mjs";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

const MARKER = "sage-native-parent-ok";
const CHILD_MARKER = "sage-native-child-ok";
const CHILD_PROMPT = `Return exactly ${CHILD_MARKER}. Do not call any tool.`;
const binary = process.env.SAGE_CODEX_BIN ?? "codex";
const root = realpathSync(mkdtempSync(join(tmpdir(), "sage-codex-one-child-")));
const workspace = join(root, "workspace");
const baselineHome = join(root, "home");
const codexHome = join(root, "codex");
const temporary = join(root, "tmp");
for (const dir of [workspace, baselineHome, codexHome, temporary]) mkdirSync(dir);
const catalogPath = join(root, "model-catalog.json");
writeFileSync(catalogPath, JSON.stringify({ models: [{
  slug: "sage-native-parent", display_name: "Sage native lifecycle fixture",
  supported_reasoning_levels: [], shell_type: "disabled", visibility: "list",
  supported_in_api: true, priority: 1, support_verbosity: false,
  truncation_policy: { mode: "bytes", limit: 10000 }, experimental_supported_tools: [], tool_mode: "direct",
  model_messages: { instructions_template: "Follow the fixed native-agent probe task. Do not use shell or external tools." },
}] }));

// An allowlist excludes provider credentials, proxies, session transport, and user config.
const env = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: baselineHome,
  CODEX_HOME: codexHome,
  TMPDIR: temporary,
  LANG: "en_US.UTF-8",
};
const print = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const launch = (args) => spawn(binary, args, { cwd: workspace, env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
const binaryPaths = new Set();
for (const candidate of isAbsolute(binary) ? [binary] : env.PATH.split(delimiter).map((dir) => join(dir, binary))) {
  try { binaryPaths.add(candidate); binaryPaths.add(realpathSync(candidate)); } catch { /* Not this PATH entry. */ }
}
const diagnostic = (value) => {
  let text = value.slice(0, 4096);
  for (const path of new Set([root, realpathSync(root)])) text = text.split(path).join("[baseline-temp]");
  for (const path of binaryPaths) text = text.split(path).join("[codex-binary]");
  return text.trim();
};

const versionChild = launch(["--version"]);
let versionText = "";
let versionStderr = "";
versionChild.stdout.on("data", (data) => { versionText = (versionText + data).slice(0, 200); });
versionChild.stderr.on("data", (data) => { versionStderr = (versionStderr + data).slice(0, 4096); });
versionChild.stdin.on("error", () => {});
versionChild.stdin.end();
const versionResult = await new Promise((resolve) => {
  versionChild.once("error", () => resolve({ spawnFailed: true }));
  versionChild.once("close", (code, signal) => resolve({ code, signal }));
});
const version = /^codex-cli \d+\.\d+\.\d+(?:[-+.][A-Za-z0-9.-]+)?$/.test(versionText.trim()) ? versionText.trim() : null;
if (versionResult.code !== 0 || version !== "codex-cli 0.160.0") {
  print({ type: "result", verified: false, reason: "version_check_failed", diagnostic: diagnostic(versionStderr) });
  process.exitCode = 1;
} else {
  print({ type: "version", version });
  await setupCapture({root,codexHome,workspace,env,binary});
  let responseRequests = 0;
  let rejectedRequests = 0;
  let rootRequests = 0;
  let childRequests = 0;
  let rootThread;
  let childThread;
  let taskName;
  let childResponse;
  let childResponseSent = false;
  let nativeRunning = false;
  let nativeCompleted = false;
  let nativeWait = false;
  let childTaskSeen = false;
  let fixtureFailure;
  let releaseChildReady;
  const childReady = new Promise((resolve) => { releaseChildReady = resolve; });
  const pending = new Set();
  const calls = { spawn: "probe_spawn", running: "probe_running", wait: "probe_wait", completed: "probe_completed" };
  const knownCalls = new Set(Object.values(calls));
  const check = (condition, reason) => { if (!condition) throw new Error(reason); };
  const reject = (res) => {
    if (res.writableEnded) return;
    if (!res.headersSent) res.writeHead(400, { "Content-Type": "application/json", Connection: "close" });
    res.end(JSON.stringify({ error: { message: "Native lifecycle fixture validation failed" } }));
  };
  const failFixture = (reason) => {
    fixtureFailure ??= reason;
    print({ type: "fixture_failure", reason: fixtureFailure });
    releaseChildReady();
    for (const response of pending) reject(response);
  };
  const inspectRequest = (request) => {
    const outputs = {};
    const input = Array.isArray(request.input) ? request.input : [];
    for (const item of input) {
      if (item.type !== "function_call_output" || !knownCalls.has(item.call_id)) continue;
      check(!(item.call_id in outputs), "duplicate_native_tool_result");
      const output = typeof item.output === "string" ? item.output
        : Array.isArray(item.output) && item.output.length === 1 && item.output[0]?.type === "input_text" ? item.output[0].text : null;
      check(typeof output === "string", "unsupported_native_tool_result_encoding");
      try { outputs[item.call_id] = JSON.parse(output); } catch { throw new Error("native_tool_result_is_not_json"); }
    }
    const agentTools = [];
    for (const tool of request.tools ?? []) {
      if (tool.type === "namespace" && tool.name === "collaboration") {
        for (const member of tool.tools ?? []) if (member.type === "function") agentTools.push(member.name);
      }
    }
    const tasks=input.filter(item=>item.type==="agent_message");
    const task=tasks[0];
    const childPromptSeen=tasks.length===1 && task.author==="/root" && task.recipient==="/root/probe_child"
      && Array.isArray(task.content) && task.content.length===2
      && task.content[0].type==="input_text"
      && task.content[0].text==="Message Type: NEW_TASK\nTask name: /root/probe_child\nSender: /root\nPayload:\n"
      && task.content[1].type==="encrypted_content" && task.content[1].encrypted_content===CHILD_PROMPT;
    return { outputs, agentTools, childPromptSeen };
  };
  let responseId = 0;
  const respond = (res, item) => {
    if (fixtureFailure) { reject(res); return; }
    const id = `native_probe_${++responseId}`;
    const events = [{ type: "response.created", response: { id, status: "in_progress", output: [] } }];
    if (item.type === "message") {
      const part = item.content[0];
      const position = { item_id: item.id, output_index: 0, content_index: 0 };
      events.push(
        { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
        { type: "response.content_part.added", ...position, part: { ...part, text: "" } },
        { type: "response.output_text.delta", ...position, delta: part.text },
        { type: "response.output_text.done", ...position, text: part.text },
        { type: "response.content_part.done", ...position, part },
      );
    }
    events.push(
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id, status: "completed", output: [item], usage: { input_tokens: 0, input_tokens_details: null, output_tokens: 0, output_tokens_details: null, total_tokens: 0 } } },
    );
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "close" });
    for (const event of events) res.write(`event: ${event.type}
data: ${JSON.stringify(event)}

`);
    res.end();
  };
  const message = (text) => ({ id: `message_${text}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] });
  // This separate namespace field matches the current Responses protocol and upstream fixtures.
  const call = (call_id, name, args) => ({ type: "function_call", namespace: "collaboration", name, call_id, arguments: JSON.stringify(args) });
  const childEntry = (result) => {
    check(Array.isArray(result?.agents), "list_result_missing_agents");
    const matches = result.agents.filter((agent) => agent.agent_name === taskName);
    check(matches.length === 1, "list_result_does_not_identify_exact_spawned_task");
    return matches[0];
  };
  const server = http.createServer(async (req, res) => {
    pending.add(res);
    res.once("finish", () => pending.delete(res));
    try {
      if (fixtureFailure) { req.resume(); reject(res); return; }
      check(req.method === "POST" && (req.url ?? "").split("?")[0] === "/v1/responses", "unexpected_http_request");
      let body = "";
      for await (const chunk of req) {
        body += chunk.toString();
        check(body.length <= 2 * 1024 * 1024, "request_exceeds_fixture_bound");
      }
      let request;
      try { request = JSON.parse(body); } catch { throw new Error("invalid_request_json"); }
      body = "";
      const info = inspectRequest(request);
      request = null; // Retain only tool results, advertised names, and a fixed-task boolean.
      responseRequests++;
      const thread = req.headers["thread-id"];
      const subagent = req.headers["x-openai-subagent"];
      check(typeof thread === "string" && thread.length > 0, "missing_native_thread_header");
      if (subagent === "collab_spawn") {
        check(rootThread && thread !== rootThread && childRequests === 0, "unexpected_child_request_identity");
        check(info.childPromptSeen, "child_did_not_receive_fixed_task");
        childThread = thread;
        childRequests++;
        childTaskSeen = true;
        childResponse = res;
        print({ type: "evidence", event: "native_child_request_held", distinctThread: true, fixedTaskReceived: true });
        releaseChildReady();
        return;
      }
      check(!subagent, "unexpected_non_spawn_agent_request");
      rootThread ??= thread;
      check(thread === rootThread, "unexpected_root_thread_identity");
      rootRequests++;
      if (rootRequests === 1) {
        check(["spawn_agent", "list_agents", "wait_agent"].every((name) => info.agentTools.includes(name)), "required_native_tools_missing");
        respond(res, call(calls.spawn, "spawn_agent", { task_name: "probe_child", message: CHILD_PROMPT, fork_turns: "none" }));
      } else if (rootRequests === 2) {
        const result = info.outputs[calls.spawn];
        check(typeof result?.task_name === "string" && result.task_name === "/root/probe_child", "native_spawn_result_missing_expected_task");
        taskName = result.task_name;
        print({ type: "native_tool_result", tool: "spawn_agent", task_name: taskName });
        await childReady;
        if (fixtureFailure) { reject(res); return; }
        respond(res, call(calls.running, "list_agents", { path_prefix: taskName }));
      } else if (rootRequests === 3) {
        const agent = childEntry(info.outputs[calls.running]);
        check(agent.agent_status === "running" && childResponse && !childResponseSent, "native_child_not_running_while_response_held");
        nativeRunning = true;
        print({ type: "native_tool_result", tool: "list_agents", phase: "held", agent_name: taskName, agent_status: "running" });
        respond(res, call(calls.wait, "wait_agent", {}));
        respond(childResponse, message(CHILD_MARKER));
        childResponseSent = true;
      } else if (rootRequests === 4) {
        const result = info.outputs[calls.wait];
        check(result?.timed_out === false && result.message === "Wait completed.", "native_wait_did_not_observe_mailbox_activity");
        nativeWait = true;
        print({ type: "native_tool_result", tool: "wait_agent", timed_out: false, message: result.message });
        respond(res, call(calls.completed, "list_agents", { path_prefix: taskName }));
      } else if (rootRequests === 5) {
        const agent = childEntry(info.outputs[calls.completed]);
        check(agent.agent_status?.completed === CHILD_MARKER, "native_child_completion_marker_mismatch");
        nativeCompleted = true;
        print({ type: "native_tool_result", tool: "list_agents", phase: "completed", agent_name: taskName, agent_status: { completed: CHILD_MARKER } });
        respond(res, message(MARKER));
      } else {
        throw new Error("unexpected_extra_root_request");
      }
    } catch (error) {
      rejectedRequests++;
      failFixture(error instanceof Error ? diagnostic(error.message) : "unknown_fixture_failure");
    }
  });

  const listening = await new Promise((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(0, "127.0.0.1", () => resolve(true));
  });
  if (!listening) {
    print({ type: "result", verified: false, reason: "loopback_listener_failed" });
    process.exitCode = 1;
  } else {
    const args = ["exec", "--strict-config", "--skip-git-repo-check", "-C", workspace, "-s", "read-only", "--json"];
    const config = {
      model_provider: "sage_native_lifecycle",
      model: "sage-native-parent",
      model_catalog_json: catalogPath,
      cli_auth_credentials_store: "ephemeral",
      "features.hooks": true,
      "features.plugins": false,
      "features.remote_plugin": false,
      "features.apps": false,
      "features.shell_snapshot": false,
      "features.shell_tool": false,
      "features.enable_request_compression": false,
      "features.multi_agent": true,
      "features.multi_agent_v2": true,
      "agents.enabled": true,
      "agents.max_concurrent_threads_per_session": 5,
      allow_login_shell: false,
    };
    for (const [key, value] of Object.entries(config)) args.push("-c", `${key}=${JSON.stringify(value)}`);
    args.push("-c", `model_providers.sage_native_lifecycle={name="Sage native lifecycle",base_url="http://127.0.0.1:${server.address().port}/v1",wire_api="responses",requires_openai_auth=false,supports_websockets=false}`);
    args.push("-");

    const child = launch(args);
    let buffer = "";
    let malformedEvents = 0;
    let exactMessages = 0;
    let otherMessages = 0;
    let completedTurns = 0;
    let failedTurns = 0;
    let unexpectedItems = 0;
    let stderrBytes = 0;
    let stderrText = "";
    const eventTypes = new Set(["thread.started", "turn.started", "item.started", "item.updated", "item.completed", "turn.completed", "turn.failed", "error"]);
    const acceptLine = (line) => {
      if (!line.trim()) return;
      let event;
      try { event = JSON.parse(line); } catch { malformedEvents++; return; }
      const itemType = event.type === "item.completed" ? event.item?.type : undefined;
      const itemDiagnostic = itemType && !["agent_message", "reasoning"].includes(itemType)
        ? diagnostic(JSON.stringify({ type: itemType, level: event.item.level, message: event.item.message, text: event.item.text }))
        : undefined;
      print({ type: "event", event: eventTypes.has(event.type) ? event.type : "unknown", itemType, itemDiagnostic });
      if (event.type === "turn.completed") completedTurns++;
      if (event.type === "turn.failed" || event.type === "error") {
        failedTurns++;
        failFixture("native_root_error");
      }
      if (event.type === "item.completed" && event.item?.type === "error") failFixture("native_error_item");
      if (event.type === "item.completed" && event.item?.type === "agent_message") {
        if (event.item.text === MARKER) exactMessages++;
        else otherMessages++;
      } else if (event.type === "item.completed" && event.item?.type === "collab_tool_call"
        && ["spawn_agent", "wait"].includes(event.item.tool) && event.item.status === "completed") {
        // The native tool result in the next request supplies the stricter state assertion.
      } else if (event.type === "item.completed" && event.item?.type !== "reasoning") {
        unexpectedItems++;
      }
    };
    child.stdout.on("data", (data) => {
      buffer += data.toString();
      let end;
      while ((end = buffer.indexOf("\n")) !== -1) {
        acceptLine(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
      }
      if (buffer.length > 1024 * 1024) { malformedEvents++; buffer = ""; }
    });
    child.stderr.on("data", (data) => { stderrBytes += data.length; stderrText = (stderrText + data).slice(0, 4096); });
    child.stdin.on("error", () => {});
    child.stdin.end(`Run the fixed one-child native lifecycle probe. Finish with exactly ${MARKER}. Do not use shell tools.\n`);
    print({ type: "event", event: "baseline_started" });
    const result = await new Promise((resolve) => {
      child.once("error", () => resolve({ spawnFailed: true }));
      child.once("close", (code, signal) => resolve({ code, signaled: signal !== null }));
    });
    acceptLine(buffer);
    if (pending.size) failFixture("native_root_exited_with_held_response");
    await new Promise((resolve) => server.close(resolve));
    const verified = result.code === 0 && !fixtureFailure && rootRequests === 5 && childRequests === 1
      && rootThread !== childThread && childTaskSeen && childResponseSent && nativeRunning && nativeWait && nativeCompleted
      && exactMessages === 1 && otherMessages === 0 && completedTurns === 1 && failedTurns === 0
      && unexpectedItems === 0 && malformedEvents === 0 && rejectedRequests === 0;
    print({ type: "result", ...result, responseRequests, rootRequests, childRequests, childTaskSeen, childResponseSent,
      nativeRunning, nativeWait, nativeCompleted, exactMessages, otherMessages, completedTurns, failedTurns,
      unexpectedItems, malformedEvents, rejectedRequests, stderrBytes, fixtureFailure, verified,
      ...(!verified ? { diagnostic: diagnostic(stderrText) } : {}) });
    if (!verified) process.exitCode = 1;
    const rows=readdirSync(join(root,"events")).map(name=>JSON.parse(readFileSync(join(root,"events",name),"utf8")));
    const start=rows.filter(row=>row.hook_event_name==="SubagentStart");
    const stop=rows.filter(row=>row.hook_event_name==="SubagentStop");
    const before=rows.filter(row=>row.hook_event_name==="PreToolUse"&&row.tool_name==="collaborationspawn_agent");
    const after=rows.filter(row=>row.hook_event_name==="PostToolUse"&&row.tool_name==="collaborationspawn_agent");
    assert.equal(start.length,1);assert.equal(stop.length,1);assert.equal(before.length,1);assert.equal(after.length,1);
    assert.equal(start[0].captureError,undefined);
    assert.equal(start[0].agent_id,stop[0].agent_id);
    assert.equal(start[0].metadata.id,start[0].agent_id);
    assert.equal(start[0].metadata.session_id,before[0].session_id);
    assert.equal(before[0].tool_use_id,after[0].tool_use_id);
    assert.equal(after[0].resultTaskName,start[0].metadata.agent_path);
    print({type:"hook_evidence",spawnRequest:before.length,spawnResult:after.length,childStart:start.length,childStop:stop.length,exactIdentityJoin:true,simulatedModel:true,automaticSage:false,realModelConsumptionVerified:false});
  }
}
