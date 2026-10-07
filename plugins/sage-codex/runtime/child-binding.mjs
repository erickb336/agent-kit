import { readAdmission, bindAdmission } from "../core/index.mjs";
import { readObservations, bindings as joinObservations } from "./events.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PATH = /^\/root(?:\/(?!root(?:\/|$))[a-z0-9_]+)+$/;
const refuse = () => { throw Error("Sage could not bind this native child."); };

/** identity must come from nativeChildStart on the current trusted hook connection. */
export function bindNativeChild({ directory, project, observationsDirectory }, identity) {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)
    || Object.keys(identity).length !== 5 || !["session", "child", "parent", "turn"].every(key => typeof identity[key] === "string" && UUID.test(identity[key]))
    || typeof identity.path !== "string" || !PATH.test(identity.path) || identity.child === identity.session
    || identity.child === identity.parent) refuse();
  const observations = readObservations(observationsDirectory);
  const joined = joinObservations(observations);
  const observed = joined.reservations.find(row => row.state === "bound" && row.child === identity.child);
  if (!observed || observed.session !== identity.session || observed.actor !== identity.parent || observed.path !== identity.path
    || !observations.some(row => row.kind === "child-start" && row.child === identity.child && row.turn === identity.turn)) refuse();
  const snapshot = readAdmission(directory);
  const session = `codex:${identity.session}`;
  const owner = snapshot.sessions.find(row => row.project === project && row.session === session);
  if (!owner) refuse();
  const scope = row => row.project === project && row.session === session && row.epoch === owner.epoch;
  const reservations = snapshot.reservations.filter(row => scope(row.assignment));
  const bindings = snapshot.bindings.filter(scope);
  const parentPath = (actor, seen = new Set()) => {
    if (actor === identity.session) return { path: "/root", role: "chief-of-staff" };
    if (seen.has(actor)) refuse();
    const bound = bindings.find(row => row.child === actor);
    const row = bound && reservations.find(row => row.assignment.id === bound.assignment);
    if (!row?.rolePlan || row.dispatch.tool !== "collaborationspawn_agent") refuse();
    const parent = parentPath(row.assignment.issuer, new Set([...seen, actor]));
    if (parent.role !== row.rolePlan.issuerRole) refuse();
    return { path: `${parent.path}/${row.dispatch.name}`, role: row.rolePlan.role };
  };
  const parent = parentPath(identity.parent);
  const name = identity.path.slice(identity.path.lastIndexOf("/") + 1);
  if (identity.path !== `${parent.path}/${name}`) refuse();
  const candidates = reservations.filter(row => row.assignment.issuer === identity.parent && row.dispatch.name === name
    && row.assignment.call === observed.call);
  if (candidates.length !== 1 || !candidates[0].rolePlan || candidates[0].dispatch.tool !== "collaborationspawn_agent"
    || candidates[0].rolePlan.issuerRole !== parent.role) refuse();
  const row = candidates[0];
  const requests = observations.filter(event => event.kind === "spawn-request" && event.actor === observed.actor && event.name === name);
  if (requests.length !== 1 || requests[0].call !== observed.call || row.dispatch.turn !== requests[0].turn) refuse();
  const result = bindAdmission(directory, { project, session, epoch: owner.epoch, assignment: row.assignment.id,
    issuer: identity.parent, call: row.assignment.call, child: identity.child, turn: identity.turn });
  return { ...result, assignment: row.assignment };
}
