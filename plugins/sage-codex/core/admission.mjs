// Atomic admission journal. Unknown work stays reserved until a later verified completion protocol.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, parse, resolve, sep } from "node:path";
import { createAssignment, parseAssignment } from "./assignments.mjs";
import { parseRolePlan, checkRoleReservation } from "./role-policy.mjs";
import { parseBrief } from "./brief.mjs";

const KEY = /^[A-Za-z0-9_.:-]{1,256}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_RECORDS = 4096, MAX_BYTES = 64 * 1024;
const refuse = (reason) => { throw new Error(`Admission: ${reason}`); };
const hash = (text) => createHash("sha256").update(text).digest("hex");
const json = (value) => JSON.stringify(value);
const fields = (value, keys) => {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) refuse("invalid record fields");
};
const word = (value, key, pattern = KEY) => typeof value === "string" && pattern.test(value) ? value : refuse(`invalid ${key}`);
const cap = (value) => Number.isInteger(value) && value >= 1 && value <= 50 ? value : refuse("capacity must be 1 through 50");
function configuration(input) {
  fields(input, ["total", "projects"]);
  if (!Array.isArray(input.projects) || !input.projects.length || input.projects.length > 50) refuse("invalid project limits");
  const projects = Array.from(input.projects, (row) => {
    fields(row, ["project", "limit"]);
    return { project: word(row.project, "project"), limit: cap(row.limit) };
  }).sort((a, b) => a.project < b.project ? -1 : a.project > b.project ? 1 : 0);
  if (new Set(projects.map((p) => p.project)).size !== projects.length) refuse("duplicate project limit");
  return { total: cap(input.total), projects };
}
function activation(input) {
  fields(input, ["project", "session", "activation"]);
  return { project: word(input.project, "project"), session: word(input.session, "session"), activation: word(input.activation, "activation", UUID) };
}
function modeChange(input) {
  fields(input, ["project", "session", "epoch", "after", "turn", "sage"]);
  if (typeof input.sage !== "boolean") refuse("invalid mode value");
  return { project: word(input.project, "project"), session: word(input.session, "session"),
    epoch: word(input.epoch, "epoch", UUID), after: word(input.after, "prior mode turn", UUID),
    turn: word(input.turn, "mode turn", UUID), sage: input.sage };
}
function dispatchIdentity(input) {
  fields(input, ["tool", "turn", "name", "argumentsHash"]);
  return { tool: word(input.tool, "tool"), turn: word(input.turn, "turn"), name: word(input.name, "name"),
    argumentsHash: word(input.argumentsHash, "argumentsHash", /^[0-9a-f]{64}$/) };
}
function childBinding(input) {
  fields(input, ["project", "session", "epoch", "assignment", "issuer", "call", "child", "turn"]);
  return { project: word(input.project, "project"), session: word(input.session, "session"),
    epoch: word(input.epoch, "epoch", UUID), assignment: word(input.assignment, "assignment", UUID),
    issuer: word(input.issuer, "issuer"), call: word(input.call, "call"),
    child: word(input.child, "child"), turn: word(input.turn, "turn") };
}
function preparation(input) {
  fields(input, ["project", "session", "epoch", "id", "task", "run", "issuer", "name", "rolePlan", "brief"]);
  const { name, rolePlan, brief, ...identity } = input;
  const { call, ...parsed } = parseAssignment({ ...identity, call: name });
  return { ...parsed, name: call, rolePlan: parseRolePlan(rolePlan), brief: parseBrief(brief) };
}
function action(input) {
  if (input?.kind === "configure") {
    fields(input, ["kind", "config"]);
    return { kind: "configure", config: configuration(input.config) };
  }
  if (input?.kind === "activate") {
    const hasMode = Object.hasOwn(input, "sage");
    fields(input, hasMode ? ["kind", "owner", "sage"] : ["kind", "owner"]);
    if (hasMode && typeof input.sage !== "boolean") refuse("invalid initial mode");
    fields(input.owner, ["project", "session", "activation", "epoch"]);
    const { epoch, ...request } = input.owner;
    return { kind: "activate", owner: { ...activation(request), epoch: word(epoch, "epoch", UUID) }, ...(hasMode ? { sage: input.sage } : {}) };
  }
  if (input?.kind === "mode") {
    fields(input, ["kind", "change"]);
    return { kind: "mode", change: modeChange(input.change) };
  }
  if (input?.kind === "prepare") {
    fields(input, ["kind", "preparation"]);
    return { kind: "prepare", preparation: preparation(input.preparation) };
  }
  if (input?.kind === "reserve") {
    const hasRole = Object.hasOwn(input, "rolePlan");
    const uniqueName = Object.hasOwn(input, "uniqueName");
    const hasBrief = Object.hasOwn(input, "brief");
    const hasPreparation = Object.hasOwn(input, "preparation");
    fields(input, ["kind", "assignment", "dispatch", ...(hasRole ? ["rolePlan"] : []), ...(uniqueName ? ["uniqueName"] : []), ...(hasBrief ? ["brief"] : []), ...(hasPreparation ? ["preparation"] : [])]);
    if (uniqueName && (!hasRole || input.uniqueName !== true)) refuse("invalid unique-name rule");
    if (hasBrief && (!hasRole || !uniqueName)) refuse("a brief requires a role and unique child name");
    if (hasPreparation && !hasBrief) refuse("prepared dispatch requires its saved brief");
    return { kind: "reserve", assignment: parseAssignment(input.assignment), dispatch: dispatchIdentity(input.dispatch),
      ...(hasRole ? { rolePlan: parseRolePlan(input.rolePlan) } : {}), ...(uniqueName ? { uniqueName: true } : {}), ...(hasBrief ? { brief: parseBrief(input.brief) } : {}),
      ...(hasPreparation ? { preparation: word(input.preparation, "preparation", UUID) } : {}) };
  }
  if (input?.kind === "bind-child") {
    fields(input, ["kind", "binding"]);
    return { kind: "bind-child", binding: childBinding(input.binding) };
  }
  return refuse("unknown action");
}
function apply(state, event) {
  const copy = structuredClone(state);
  if (event.kind === "configure") {
    if (copy.config) {
      if (json(copy.config) !== json(event.config)) refuse("configuration differs; reconciliation is required");
      return { state, result: copy.config, changed: false };
    }
    copy.config = event.config;
    return { state: copy, result: event.config, changed: true };
  }
  if (!copy.config) refuse("store is not configured");
  const value = event.kind === "activate" ? event.owner : event.kind === "mode" ? event.change : event.kind === "bind-child" ? event.binding : event.kind === "prepare" ? event.preparation : event.assignment;
  if (!copy.config.projects.some((p) => p.project === value.project)) refuse("project is not configured");
  const owner = copy.sessions.find((s) => s.project === value.project && s.session === value.session);
  if (event.kind === "activate") {
    if (owner) {
      if (owner.activation !== value.activation) refuse("session already has an owner; reconcile before a new activation");
      const initial = copy.modes.find(m => m.project === owner.project && m.session === owner.session && m.epoch === owner.epoch && m.after === null);
      if (initial.sage !== (event.sage ?? true)) refuse("activation has a different initial mode");
      return { state, result: owner, changed: false };
    }
    copy.sessions.push(value);
    copy.modes.push({ project: value.project, session: value.session, epoch: value.epoch,
      after: null, turn: value.activation, sage: event.sage ?? true });
    return { state: copy, result: value, changed: true };
  }
  if (!owner || owner.epoch !== value.epoch) refuse("assignment has no current session owner");
  const modes = copy.modes.filter(m => m.project === value.project && m.session === value.session && m.epoch === value.epoch);
  const mode = modes.at(-1);
  if (event.kind === "mode") {
    const previous = modes.find(m => m.turn === value.turn);
    if (previous) {
      if (json(previous) !== json(value)) refuse("turn already has a different mode request");
      return { state, result: { decision: "already-recorded", mode }, changed: false };
    }
    if (mode.turn !== value.after) refuse("mode changed; read the current mode before a new request");
    copy.modes.push(value);
    return { state: copy, result: { decision: "changed", mode: value }, changed: true };
  }
  if (event.kind === "prepare") {
    const previous = copy.preparations.find(row => ["project", "session", "epoch", "issuer", "name"].every(key => row[key] === value[key]));
    if (previous) {
      const { id: oldId, ...oldWork } = previous;
      const { id: newId, ...newWork } = value;
      if (json(oldWork) !== json(newWork)) refuse("child name already prepares different work");
      return { state, result: { decision: "already-prepared", preparation: previous }, changed: false };
    }
    if (!mode.sage) refuse("Sage mode is off");
    if (copy.preparations.some(row => row.id === value.id)) refuse("preparation ID already exists");
    if (copy.reservations.some(row => ["project", "session", "epoch", "issuer"].every(key => row.assignment[key] === value[key])
      && row.dispatch.name === value.name)) refuse("child dispatch name is already reserved");
    // Preparation checks the role relationship. Dispatch checks occupied slots again.
    checkRoleReservation([], value, value.rolePlan);
    copy.preparations.push(value);
    return { state: copy, result: { decision: "prepared", preparation: value }, changed: true };
  }
  if (event.kind === "bind-child") {
    const reserved = copy.reservations.find(row => row.assignment.id === value.assignment);
    if (!reserved || ["project", "session", "epoch", "issuer", "call"].some(key => reserved.assignment[key] !== value[key])) refuse("child binding has no matching reservation");
    if (!reserved.rolePlan) refuse("child binding requires a recorded role");
    if (value.child === value.issuer) refuse("issuer cannot bind itself as a child");
    const previous = copy.bindings.find(row => row.assignment === value.assignment);
    if (previous) {
      if (json(previous) !== json(value)) refuse("assignment already has a different child binding");
      return { state, result: { decision: "already-bound", binding: previous, role: reserved.rolePlan.role }, changed: false };
    }
    if (copy.reservations.filter(row => row.assignment.project === value.project && row.assignment.session === value.session
      && row.assignment.epoch === value.epoch && row.assignment.issuer === value.issuer
      && row.dispatch.name === reserved.dispatch.name).length !== 1) refuse("child dispatch name is ambiguous");
    if (copy.bindings.some(row => row.session === value.session && row.child === value.child)) refuse("child already belongs to another assignment");
    copy.bindings.push(value);
    return { state: copy, result: { decision: "bound", binding: value, role: reserved.rolePlan.role }, changed: true };
  }
  const prior = copy.reservations.find(({ assignment: a }) => a.project === value.project && a.session === value.session
    && a.epoch === value.epoch && a.issuer === value.issuer && a.call === value.call);
  if (prior) {
    if (["task", "run"].some((key) => prior.assignment[key] !== value[key]) || json(prior.dispatch) !== json(event.dispatch) || json(prior.rolePlan) !== json(event.rolePlan) || json(prior.brief) !== json(event.brief) || prior.preparation !== event.preparation) refuse("dispatch call already names different work");
    return { state, result: { decision: "already-reserved", assignment: prior.assignment }, changed: false };
  }
  if (!mode.sage) refuse("Sage mode is off");
  if (event.preparation) {
    const prepared = copy.preparations.find(row => row.id === event.preparation);
    if (!prepared || ["project", "session", "epoch", "task", "run", "issuer"].some(key => prepared[key] !== value[key])
      || prepared.name !== event.dispatch.name || json(prepared.rolePlan) !== json(event.rolePlan)
      || json(prepared.brief) !== json(event.brief)) refuse("dispatch differs from its preparation");
    if (copy.reservations.some(row => row.preparation === event.preparation)) refuse("preparation already has a dispatch");
  }
  if (copy.reservations.some(({ assignment: a }) => a.id === value.id)) refuse("assignment ID already exists");
  if (event.rolePlan) {
    if (event.uniqueName && copy.reservations.some(row => row.assignment.project === value.project && row.assignment.session === value.session
      && row.assignment.epoch === value.epoch && row.assignment.issuer === value.issuer
      && row.dispatch.name === event.dispatch.name)) refuse("child dispatch name is already reserved");
    checkRoleReservation(copy.reservations, value, event.rolePlan);
  }
  if (copy.reservations.length >= copy.config.total) refuse("total capacity is occupied");
  const projectLimit = copy.config.projects.find((p) => p.project === value.project).limit;
  if (copy.reservations.filter(({ assignment: a }) => a.project === value.project).length >= projectLimit) refuse("project capacity is occupied");
  copy.reservations.push({ assignment: value, dispatch: event.dispatch, ...(event.rolePlan ? { rolePlan: event.rolePlan } : {}), ...(event.brief ? { brief: event.brief } : {}), ...(event.preparation ? { preparation: event.preparation } : {}) });
  return { state: copy, result: { decision: "permit-once", assignment: value }, changed: true };
}
function syncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function directory(path, create) {
  if (!isAbsolute(path) || resolve(path) !== path) refuse("directory must be absolute and canonical");
  let parent = parse(path).root;
  for (const part of path.slice(parent.length).split(sep).filter(Boolean)) {
    const current = join(parent, part);
    try { if (!lstatSync(current).isDirectory()) refuse("directory is not a real directory"); }
    catch (error) {
      if (!create || error.code !== "ENOENT") throw error;
      try { mkdirSync(current, { mode: 0o700 }); } catch (e) { if (e.code !== "EEXIST") throw e; }
      if (!lstatSync(current).isDirectory()) refuse("directory is not a real directory");
    }
    if (create) syncDirectory(parent);
    parent = current;
  }
}
function bytesAt(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) refuse("invalid journal file");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const n = readSync(fd, buffer, size, buffer.length - size, size);
      if (!n) break;
      size += n;
    }
    if (size > MAX_BYTES) refuse("journal file exceeds bound");
    const bytes = buffer.subarray(0, size), text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) refuse("invalid journal UTF-8");
    return text;
  } finally { closeSync(fd); }
}
const filename = (revision) => `${String(revision).padStart(8, "0")}.json`;
const envelope = (revision, previous, data) => {
  const body = { schema: 1, revision, previous, data };
  return { ...body, hash: hash(json(body)) };
};
function read(dir) {
  directory(dir, false);
  let maximum = -1, entries = 0;
  const stream = opendirSync(dir);
  try {
    for (let entry; (entry = stream.readSync());) {
      if (++entries > MAX_RECORDS * 2) refuse("too many journal entries");
      if (/^\.pending-[0-9a-f-]{36}$/.test(entry.name)) continue;
      if (!entry.isFile() || !/^\d{8}\.json$/.test(entry.name)) refuse("unexpected journal entry");
      const revision = Number(entry.name.slice(0, 8));
      if (revision >= MAX_RECORDS) refuse("journal limit reached; reconciliation is required");
      maximum = Math.max(maximum, revision);
    }
  } finally { stream.closeSync(); }
  let state = { config: null, sessions: [], reservations: [], modes: [], bindings: [], preparations: [] }, previous = null;
  for (let revision = 0; revision <= maximum; revision++) {
    const bytes = bytesAt(join(dir, filename(revision)));
    let record;
    try { record = JSON.parse(bytes); } catch { refuse("journal record is not JSON"); }
    fields(record, ["schema", "revision", "previous", "data", "hash"]);
    const event = action(record.data);
    const expected = envelope(revision, previous, event);
    if (json(expected) + "\n" !== bytes) refuse("journal chain or record differs");
    const next = apply(state, event);
    if (!next.changed) refuse("journal contains a duplicate transition");
    state = next.state;
    previous = expected.hash;
  }
  return { state, revision: maximum + 1, previous };
}
function commit(dir, input, create = false) {
  const event = action(input);
  directory(dir, create);
  // Each lost publication means another whole record won. Recompute against that state.
  for (let attempt = 0; attempt < MAX_RECORDS; attempt++) {
    const snapshot = read(dir);
    const next = apply(snapshot.state, event);
    if (!next.changed) { syncDirectory(dir); return structuredClone(next.result); }
    if (snapshot.revision >= MAX_RECORDS) refuse("journal limit reached; reconciliation is required");
    const bytes = json(envelope(snapshot.revision, snapshot.previous, event)) + "\n";
    if (Buffer.byteLength(bytes) > MAX_BYTES) refuse("record exceeds bound");
    const pending = join(dir, `.pending-${randomUUID()}`);
    const fd = openSync(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    let won = false;
    try {
      try { linkSync(pending, join(dir, filename(snapshot.revision))); won = true; }
      catch (error) { if (error.code !== "EEXIST") throw error; }
      if (won) syncDirectory(dir);
    } finally { unlinkSync(pending); }
    if (won) return structuredClone(next.result);
  }
  return refuse("admission contention did not settle");
}

export const configureAdmission = (dir, config) => commit(dir, { kind: "configure", config }, true);
/** Activation must come from the trusted entry path, never a model-supplied ownership claim. */
export const activateAdmission = (dir, request, options = { sage: true }) => {
  fields(options, ["sage"]);
  return commit(dir, { kind: "activate", owner: { ...activation(request), epoch: randomUUID() }, sage: options.sage });
};
/** A verified owner prompt supplies the new turn and the expected previous mode turn. */
export const changeAdmissionMode = (dir, request) => commit(dir, { kind: "mode", change: request });
export const reserveAdmission = (dir, scope, request, dispatch) => commit(dir, { kind: "reserve", assignment: createAssignment(scope, request), dispatch });
/** The adapter must verify the issuer role before it requests this atomic reservation. */
export const reserveRoleAdmission = (dir, scope, request, dispatch, rolePlan) => commit(dir,
  { kind: "reserve", assignment: createAssignment(scope, request), dispatch, rolePlan: parseRolePlan(rolePlan), uniqueName: true });
/** Save role, brief, and capacity together before permitting the initial dispatch. */
export const reserveBriefAdmission = (dir, scope, request, dispatch, rolePlan, brief) => commit(dir,
  { kind: "reserve", assignment: createAssignment(scope, request), dispatch, rolePlan: parseRolePlan(rolePlan), uniqueName: true, brief: parseBrief(brief) });
/** Save instructions before the native dispatch call exists. No capacity or permission is granted. */
export function prepareAdmission(dir, scope, request, rolePlan, brief) {
  fields(request, ["task", "run", "issuer", "name"]);
  const { call, ...identity } = createAssignment(scope, { task: request.task, run: request.run, issuer: request.issuer, call: request.name });
  return commit(dir, { kind: "prepare", preparation: { ...identity, name: call, rolePlan, brief } });
}
/** The adapter verifies the current issuer and role, then supplies the actual native call and dispatch. */
export function reservePreparedAdmission(dir, scope, request, dispatch, issuerRole) {
  fields(request, ["preparation", "issuer", "call"]);
  word(request.preparation, "preparation", UUID);
  const prepared = readAdmission(dir).preparations.find(row => row.id === request.preparation);
  if (!prepared) refuse("preparation is unavailable");
  return commit(dir, { kind: "reserve", assignment: createAssignment(scope,
    { task: prepared.task, run: prepared.run, issuer: request.issuer, call: request.call }), dispatch,
    rolePlan: { issuerRole, role: prepared.rolePlan.role }, uniqueName: true, brief: prepared.brief, preparation: prepared.id });
}
/** Record a verified initial child identity. This neither permits dispatch nor releases capacity. */
export const bindAdmission = (dir, binding) => commit(dir, { kind: "bind-child", binding });
export function readAdmission(dir) {
  const { state } = read(dir);
  if (!state.config) refuse("store is not configured");
  return state;
}
