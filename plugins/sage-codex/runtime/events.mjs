// Codex 0.160.0 identity observations. This module does not grant permission or release capacity.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, parse, resolve, sep } from "node:path";

export const RUNTIME_VERSION = "0.160.0";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAME = /^(?!root$)[a-z0-9_]+$/;
const TASK = /^\/root(?:\/(?!root(?:\/|$))[a-z0-9_]+)+$/;
const ID = /^[A-Za-z0-9_.:-]{1,256}$/;
// Preserve a declared target, including relative names. This is not a resolved child identity.
const TARGET = /^[A-Za-z0-9_./:-]{1,4096}$/;
const MAX_BYTES = 16 * 1024;
const MAX_EVENTS = 4096;
const refuse = (message) => { throw new Error(`Codex event store: ${message}`); };
const value = (input, key, pattern) => typeof input[key] === "string" && pattern.test(input[key]) ? input[key] : refuse(`invalid ${key}`);

/** Keep only identity fields. Unknown events and unsupported runtime versions never become evidence. */
export function decodeEvent(input, { version, metadata } = {}) {
  if (version !== RUNTIME_VERSION) refuse("unsupported runtime version");
  if (!input || typeof input !== "object" || Array.isArray(input)) refuse("invalid hook input");
  const event = input.hook_event_name;
  if (!["PreToolUse", "PostToolUse", "SubagentStart", "SubagentStop"].includes(event)) return null;
  if (["PreToolUse", "PostToolUse"].includes(event) && !["collaborationspawn_agent", "collaborationsend_message", "collaborationfollowup_task"].includes(input.tool_name)) return null;
  const base = { schema: 1, runtime: version, session: value(input, "session_id", UUID) };
  const turn = value(input, "turn_id", ID);
  if (event === "SubagentStart") {
    const child = value(input, "agent_id", UUID);
    if (!metadata || typeof metadata !== "object") refuse("child metadata is missing");
    if (value(metadata, "id", UUID) !== child || value(metadata, "session_id", UUID) !== base.session) refuse("child metadata identity differs");
    return observation({ ...base, kind: "child-start", child, parent: value(metadata, "parent_thread_id", UUID), path: value(metadata, "agent_path", TASK), turn });
  }
  if (event === "SubagentStop") return observation({ ...base, kind: "child-stop", child: value(input, "agent_id", UUID), turn });
  const actor = input.agent_id === undefined ? base.session : value(input, "agent_id", UUID);
  const call = value(input, "tool_use_id", ID);
  if (input.tool_name !== "collaborationspawn_agent") {
    if (event === "PostToolUse" && input.tool_response !== "") refuse("unrecognized dispatch result");
    return observation({ ...base, kind: event === "PreToolUse" ? "dispatch-request" : "dispatch-result", actor, call, turn,
      mode: input.tool_name === "collaborationsend_message" ? "message" : "task", target: value(input.tool_input ?? {}, "target", TARGET) });
  }
  if (event === "PreToolUse") return observation({ ...base, kind: "spawn-request", actor, call, turn, name: value(input.tool_input ?? {}, "task_name", NAME) });
  let result = input.tool_response;
  if (typeof result === "string") {
    if (Buffer.byteLength(result) > MAX_BYTES) refuse("spawn result is too large");
    try { result = JSON.parse(result); } catch { refuse("spawn result is not JSON"); }
  }
  if (!result || typeof result !== "object") refuse("spawn result is missing");
  return observation({ ...base, kind: "spawn-result", actor, call, turn, path: value(result, "task_name", TASK) });
}

/** A canonical record has no prompt, transcript, tool command, timestamp, or arbitrary extra field. */
export function observation(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || input.schema !== 1 || input.runtime !== RUNTIME_VERSION) refuse("unsupported observation");
  const out = { schema: 1, runtime: RUNTIME_VERSION, session: value(input, "session", UUID), kind: input.kind };
  const schemas = {
    "spawn-request": { actor: UUID, call: ID, turn: ID, name: NAME },
    "spawn-result": { actor: UUID, call: ID, turn: ID, path: TASK },
    "child-start": { child: UUID, parent: UUID, path: TASK, turn: ID },
    "child-stop": { child: UUID, turn: ID },
    "dispatch-request": { actor: UUID, call: ID, turn: ID, mode: /^(message|task)$/, target: TARGET },
    "dispatch-result": { actor: UUID, call: ID, turn: ID, mode: /^(message|task)$/, target: TARGET },
  };
  if (typeof input.kind !== "string" || !Object.hasOwn(schemas, input.kind)) refuse("unknown observation kind");
  const fields = schemas[input.kind];
  for (const [key, pattern] of Object.entries(fields)) out[key] = value(input, key, pattern);
  if (Object.keys(input).some((key) => !Object.hasOwn(out, key))) refuse("unexpected observation field");
  return out;
}
const encoded = (event) => {
  const bytes = `${JSON.stringify(observation(event))}\n`;
  if (Buffer.byteLength(bytes) > MAX_BYTES) refuse("observation is too large");
  return bytes;
};
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const directory = (path, create) => {
  if (!isAbsolute(path) || resolve(path) !== path) refuse("directory must be absolute and canonical");
  let parent = parse(path).root;
  for (const part of path.slice(parent.length).split(sep).filter(Boolean)) {
    const current = join(parent, part);
    try { if (!lstatSync(current).isDirectory()) refuse("directory must be a real directory, with no symbolic links"); }
    catch (error) {
      if (!create || error.code !== "ENOENT") throw error;
      try { mkdirSync(current, { mode: 0o700 }); }
      catch (creation) { if (creation.code !== "EEXIST") throw creation; }
      if (!lstatSync(current).isDirectory()) refuse("directory must be a real directory");
    }
    // Another writer may have created this entry but not synced it yet.
    if (create) syncDirectory(parent);
    parent = current;
  }
};
const syncDirectory = (path) => {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
};
function readRecord(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) refuse("invalid record file");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const n = readSync(fd, buffer, size, buffer.length - size, size);
      if (!n) break;
      size += n;
    }
    if (size > MAX_BYTES) refuse("record grew beyond the limit");
    return buffer.subarray(0, size).toString("utf8");
  } finally { closeSync(fd); }
}

/** Publish one immutable fact. A crash before publication leaves an ignored pending file. */
export function publish(directoryPath, input) {
  const bytes = encoded(input);
  directory(directoryPath, true);
  const name = `${digest(bytes)}.json`;
  const target = join(directoryPath, name);
  const pending = join(directoryPath, `.pending-${randomUUID()}`);
  const fd = openSync(pending, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  try {
    try { linkSync(pending, target); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (readRecord(target) !== bytes) refuse("published record differs");
    }
    syncDirectory(directoryPath);
  } finally { unlinkSync(pending); }
  return name;
}

/** Read a snapshot. Missing or invalid published data is an error, never an empty success. */
export function readObservations(directoryPath) {
  directory(directoryPath, false);
  const records = [];
  const stream = opendirSync(directoryPath);
  let count = 0;
  try {
    for (let entry; (entry = stream.readSync());) {
      if (++count > MAX_EVENTS * 2) refuse("too many directory entries; reconciliation is required");
      if (/^\.pending-[0-9a-f-]{36}$/.test(entry.name)) continue;
      if (records.length === MAX_EVENTS) refuse("too many records; reconciliation is required");
      records.push(entry);
    }
  } finally { stream.closeSync(); }
  return records.sort((a, b) => a.name.localeCompare(b.name)).map((entry) => {
    if (!entry.isFile() || !/^[0-9a-f]{64}\.json$/.test(entry.name)) refuse("unexpected published entry");
    const bytes = readRecord(join(directoryPath, entry.name));
    if (`${digest(bytes)}.json` !== entry.name) refuse("record hash differs");
    let parsed;
    try { parsed = JSON.parse(bytes); } catch { refuse("record is not JSON"); }
    const record = observation(parsed);
    if (encoded(record) !== bytes) refuse("record is not canonical");
    return record;
  });
}

/** Reconcile by exact identity, never arrival order. Even a stopped child remains held here. */
export function bindings(inputs) {
  if (!Array.isArray(inputs) || inputs.length > MAX_EVENTS) refuse("invalid observation set");
  const events = [...new Map(inputs.map((input) => { const e = observation(input); return [encoded(e), e]; })).values()];
  if (new Set(events.map((e) => e.session)).size > 1) refuse("mixed root sessions");
  const groups = new Map();
  for (const e of events.filter((e) => e.kind.startsWith("spawn-"))) {
    const key = JSON.stringify([e.session, e.actor, e.call]);
    if (!groups.has(key)) groups.set(key, { session: e.session, actor: e.actor, call: e.call, requests: [], results: [] });
    groups.get(key)[e.kind === "spawn-request" ? "requests" : "results"].push(e);
  }
  const starts = events.filter((e) => e.kind === "child-start");
  const session = events[0]?.session;
  const actorPath = (actor, seen = new Set()) => {
    if (actor === session) return { path: "/root" };
    if (seen.has(actor)) return { conflict: true };
    const own = starts.filter((e) => e.child === actor);
    if (!own.length) return null;
    if (own.length !== 1 || starts.filter((e) => e.path === own[0].path).length !== 1) return { conflict: true };
    const start = own[0];
    const parent = actorPath(start.parent, new Set([...seen, actor]));
    if (!parent || parent.conflict) return parent;
    if (start.path.slice(0, start.path.lastIndexOf("/")) !== parent.path) return { conflict: true };
    return { path: start.path };
  };
  const used = new Set();
  const reservations = [...groups.values()].map((g) => {
    const row = { session: g.session, actor: g.actor, call: g.call, state: "pending", held: true };
    const conflict = (reason) => ({ ...row, state: "conflict", reason });
    if (g.requests.length > 1 || g.results.length > 1) return conflict("conflicting call records");
    if (!g.requests.length || !g.results.length) return row;
    const request = g.requests[0], result = g.results[0];
    const parent = actorPath(g.actor);
    if (!parent) return row;
    if (parent.conflict || result.path !== `${parent.path}/${request.name}`) return conflict("task path differs from parent identity");
    if (request.turn !== result.turn || result.path.split("/").at(-1) !== request.name) return conflict("spawn result differs from request");
    // A reused path or child ID has no safe generation choice without further runtime evidence.
    const samePathResults = events.filter((e) => e.kind === "spawn-result" && e.path === result.path);
    if (samePathResults.length !== 1) return conflict("task path has multiple spawn calls");
    const candidates = starts.filter((e) => e.parent === g.actor && e.path === result.path);
    if (!candidates.length) return row;
    if (candidates.length !== 1) return conflict("task path has multiple child starts");
    const start = candidates[0];
    if (starts.filter((e) => e.child === start.child).length !== 1 || start.child === g.actor || start.child === g.session) return conflict("child identity is ambiguous");
    used.add(start.child);
    return { ...row, state: "bound", child: start.child, path: start.path,
      stopTurns: events.filter((e) => e.kind === "child-stop" && e.child === start.child).map((e) => e.turn).sort() };
  }).sort((a, b) => JSON.stringify([a.actor, a.call]).localeCompare(JSON.stringify([b.actor, b.call])));
  const unboundChildren = [...new Set(events.filter((e) => e.kind.startsWith("child-") && !used.has(e.child)).map((e) => e.child))].sort();
  const dispatchGroups = new Map();
  for (const e of events.filter((e) => e.kind.startsWith("dispatch-"))) {
    const key = JSON.stringify([e.session, e.actor, e.call]);
    if (!dispatchGroups.has(key)) dispatchGroups.set(key, { session: e.session, actor: e.actor, call: e.call, requests: [], results: [] });
    dispatchGroups.get(key)[e.kind === "dispatch-request" ? "requests" : "results"].push(e);
  }
  const dispatches = [...dispatchGroups.values()].map((g) => {
    const row = { session: g.session, actor: g.actor, call: g.call, state: "pending", attributed: false };
    if (g.requests.length > 1 || g.results.length > 1) return { ...row, state: "conflict" };
    if (!g.requests.length || !g.results.length) return row;
    const request = g.requests[0], result = g.results[0];
    if (["turn", "mode", "target"].some((key) => request[key] !== result[key])) return { ...row, state: "conflict" };
    return { ...row, state: "accepted", turn: request.turn, mode: request.mode, target: request.target };
  }).sort((a, b) => JSON.stringify([a.actor, a.call]).localeCompare(JSON.stringify([b.actor, b.call])));
  // An empty success result does not identify a recipient turn or prove queued input was consumed.
  return { reservations, unboundChildren, dispatches,
    unresolved: events.length === 0 || reservations.some((r) => r.state !== "bound") || unboundChildren.length > 0 || dispatches.length > 0 };
}
