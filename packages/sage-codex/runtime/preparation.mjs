import { createHash } from "node:crypto";
import { join } from "node:path";
import { readAdmission, prepareAdmission, reservePreparedAdmission } from "sage-core";
import { nativeToolContext, nativeToolEvent } from "./native-tool.mjs";
import { bindings, decodeEvent, publish, readObservations } from "./events.mjs";

const NAME = /^(?!root$)[a-z0-9_]{1,256}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const refuse = () => { throw Error("Sage could not verify this task preparation."); };

/** The current connection supplies the actor. Saved names and model arguments cannot select a role. */
function actorScope(options, native) {
  const state = readAdmission(options.directory);
  const own = state.sessions.find(row => row.project === options.project && row.session === `codex:${native.actor}`);
  if (own) return { scope: { project: own.project, session: own.session, epoch: own.epoch }, role: "chief-of-staff" };
  const candidates = state.bindings.filter(row => row.project === options.project && row.child === native.actor);
  if (candidates.length !== 1) refuse();
  const bound = candidates[0];
  const session = bound.session.slice(6);
  if (bound.session !== `codex:${session}` || !UUID.test(session)) refuse();
  const owner = state.sessions.find(row => row.project === options.project && row.session === bound.session && row.epoch === bound.epoch);
  const reservation = state.reservations.find(row => row.assignment.id === bound.assignment);
  if (!owner || !reservation || reservation.rolePlan?.role !== "lead" || reservation.rolePlan.issuerRole !== "chief-of-staff"
    || bound.issuer !== session || reservation.dispatch.tool !== "collaborationspawn_agent") refuse();
  const observations = readObservations(join(options.observationsRoot, session));
  const joined = bindings(observations).reservations.find(row => row.child === native.actor && row.state === "bound");
  if (!joined || joined.session !== session || joined.actor !== session || joined.call !== bound.call
    || joined.path !== `/root/${reservation.dispatch.name}`) refuse();
  const requests = observations.filter(row => row.kind === "spawn-request" && row.actor === session && row.name === reservation.dispatch.name);
  if (requests.length !== 1 || requests[0].call !== bound.call || requests[0].turn !== reservation.dispatch.turn
    || !observations.some(row => row.kind === "child-start" && row.child === native.actor && row.turn === bound.turn)) refuse();
  return { scope: { project: owner.project, session: owner.session, epoch: owner.epoch }, role: "lead" };
}

/** Fixed launcher options select storage. This operation saves work but never permits a native spawn. */
export function prepareNativeTask(input, context, options) {
  const native = nativeToolContext(context);
  const keys = ["task", "run", "name", "role", "brief"];
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== keys.length
    || keys.some(key => !Object.hasOwn(input, key)) || typeof input.name !== "string" || !NAME.test(input.name)) refuse();
  const { scope, role } = actorScope(options, native);
  const result = prepareAdmission(options.directory, scope,
    { task: input.task, run: input.run, issuer: native.actor, name: input.name },
    { issuerRole: role, role: input.role }, input.brief);
  const saved = result.preparation;
  return { decision: result.decision, preparation: saved.id, task: saved.task, run: saved.run, name: saved.name, role: saved.rolePlan.role };
}

/** Input is the raw native PreToolUse payload, before any derived agent_id is added. */
export function reservePreparedSpawn(input, context, options) {
  const native = nativeToolContext(context);
  const event = nativeToolEvent(input, native, "PreToolUse");
  const observed = decodeEvent(event, native);
  if (observed?.kind !== "spawn-request") refuse();
  // Keep rejected and inactive attempts too. They can make later path reuse ambiguous.
  publish(join(options.observationsRoot, observed.session), observed);
  const { scope, role } = actorScope(options, native);
  if (scope.session !== `codex:${observed.session}`) refuse();
  const prepared = readAdmission(options.directory).preparations.filter(row => row.project === scope.project
    && row.session === scope.session && row.epoch === scope.epoch && row.issuer === native.actor && row.name === observed.name);
  if (prepared.length !== 1) refuse();
  return reservePreparedAdmission(options.directory, scope,
    { preparation: prepared[0].id, issuer: native.actor, call: observed.call },
    { tool: input.tool_name, turn: observed.turn, name: observed.name,
      argumentsHash: createHash("sha256").update(JSON.stringify(input.tool_input)).digest("hex") }, role);
}
