import { join } from "node:path";
import { decodeEvent, observation, publish, RUNTIME_VERSION } from "./events.mjs";
import { nativeToolContext, nativeToolEvent } from "./native-tool.mjs";
import { readMode } from "./mode.mjs";
import { reservePreparedSpawn } from "./preparation.mjs";
import { boundChildInstructions } from "./instructions.mjs";

const refuse = () => { throw Error("Sage could not evaluate this native operation."); };
const decision = value => {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse();
  if (Object.keys(value).length === 1 && Object.hasOwn(value, "decision") && value.decision === "pass") return { decision: "pass" };
  if (Object.keys(value).length === 2 && Object.hasOwn(value, "decision") && Object.hasOwn(value, "reason")
    && value.decision === "deny" && typeof value.reason === "string" && value.reason.length > 0
    && value.reason.length <= 500 && value.reason.trim() === value.reason && !/\p{Cc}/u.test(value.reason)) {
    return { decision: "deny", reason: value.reason };
  }
  refuse();
};
const modeStamp = value => JSON.stringify([value.owner?.epoch, value.modes.at(-1)?.turn, value.sage]);

/** The launcher supplies fixed storage and a complete tool policy. There is no permissive default. */
export function createNativePolicy(options, evaluateTool) {
  if (!options || typeof evaluateTool !== "function"
    || !["directory", "project", "observationsRoot"].every(key => typeof options[key] === "string" && options[key])) refuse();
  const fixed = Object.freeze({ directory: options.directory, project: options.project, observationsRoot: options.observationsRoot });
  const mode = session => readMode(fixed.directory, fixed.project, session);
  const record = value => {
    const event = observation(value);
    publish(join(fixed.observationsRoot, event.session), event);
  };
  return Object.freeze({
    async evaluate(input, context) {
      const native = nativeToolContext(context);
      // The MCP boundary adds agent_id. Validate that derived field before rebuilding raw input.
      const snapshot = structuredClone(input);
      const child = native.actor !== snapshot.session_id;
      if (Object.hasOwn(snapshot, "agent_id") !== child || (child && snapshot.agent_id !== native.actor)) refuse();
      const { agent_id, ...raw } = snapshot;
      const event = nativeToolEvent(raw, native, "PreToolUse");
      const observed = decodeEvent(event, native);
      if (observed) record(observed); // Keep inactive and denied attempts; name reuse must stay visible.
      const before = mode(event.session_id);
      const checked = decision(await evaluateTool(structuredClone(event), Object.freeze({ ...native, sage: before.sage })));
      // A concurrent mode change cannot turn an earlier decision into current permission.
      if (modeStamp(before) !== modeStamp(mode(event.session_id))) refuse();
      if (checked.decision === "deny") return checked;
      if (before.sage && observed?.kind === "spawn-request") {
        const reserved = reservePreparedSpawn(raw, native, fixed);
        return reserved.decision === "permit-once" ? { decision: "pass" }
          : { decision: "deny", reason: "Sage already reserved this native dispatch." };
      }
      return checked;
    },
    recordDispatchResult(value) {
      const event = observation(value);
      if (!["spawn-result", "dispatch-result"].includes(event.kind)) refuse();
      record(event);
      return { decision: "recorded" };
    },
    startChild(identity) {
      // nativeChildStart has already authenticated this identity against the current connection.
      record({ schema: 1, runtime: RUNTIME_VERSION, kind: "child-start", ...identity });
      if (!mode(identity.session).sage) return { decision: "pass" };
      return boundChildInstructions({ directory: fixed.directory, project: fixed.project,
        observationsDirectory: join(fixed.observationsRoot, identity.session) }, identity);
    },
  });
}
