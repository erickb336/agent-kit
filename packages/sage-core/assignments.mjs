// Assignment identity only. A matching submission is not an accepted report or a completed run.
import { randomUUID } from "node:crypto";

const KEY = /^[A-Za-z0-9_.:-]{1,256}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TASK = /^T[1-9][0-9]*$/;
const RUN = /^R[1-9][0-9]*$/;
const SCOPE = { project: KEY, session: KEY, epoch: UUID };
const INTENT = { ...SCOPE, id: UUID, task: TASK, run: RUN, issuer: KEY, call: KEY };
const refuse = (reason) => { throw new Error(`Assignment: ${reason}`); };
const record = (input, fields) => {
  if (!input || typeof input !== "object" || Array.isArray(input)) refuse("expected identity record");
  if (Object.keys(input).some((key) => !Object.hasOwn(fields, key))) refuse("unexpected identity field");
  return Object.fromEntries(Object.entries(fields).map(([key, pattern]) => {
    if (typeof input[key] !== "string" || !pattern.test(input[key])) refuse(`invalid ${key}`);
    return [key, input[key]];
  }));
};
const same = (a, b, keys, reason) => { if (keys.some((key) => a[key] !== b[key])) refuse(reason); };

/** The trusted caller supplies scope and issuer, persists this intent, then permits dispatch. */
export function createAssignment(scope, dispatch) {
  return { ...record(scope, SCOPE), id: randomUUID(), ...record(dispatch, { task: TASK, run: RUN, issuer: KEY, call: KEY }) };
}

/** Native identity and a report's reference are separate inputs. Neither can supply authority. */
export function correlateReport({ scope, assignment, binding, native, reference }) {
  const current = record(scope, SCOPE);
  const intent = parseAssignment(assignment);
  const bound = record(binding, { ...SCOPE, assignment: UUID, issuer: KEY, call: KEY, child: KEY });
  const origin = record(native, { session: KEY, child: KEY, turn: KEY });
  const report = record(reference, { assignment: UUID, task: TASK, run: RUN });
  same(current, intent, Object.keys(SCOPE), "assignment is outside the current scope");
  same(current, bound, Object.keys(SCOPE), "binding is outside the current scope");
  if (bound.assignment !== intent.id) refuse("binding belongs to another assignment");
  same(intent, bound, ["issuer", "call"], "binding differs from the assignment dispatch");
  same(bound, origin, ["session", "child"], "report came from another child or session");
  if (bound.child === bound.issuer) refuse("issuer cannot report as its own child");
  if (report.assignment !== intent.id) refuse("report names another assignment");
  same(intent, report, ["task", "run"], "report names another task or run");
  return { schema: 1, kind: "report-submission", ...current, assignment: intent.id,
    task: intent.task, run: intent.run, issuer: intent.issuer, call: intent.call, child: origin.child, turn: origin.turn };
}

// Internal core decoder for assignments read from the admission journal.
export const parseAssignment = (input) => record(input, INTENT);
