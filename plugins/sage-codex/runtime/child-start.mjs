import { decodeEvent, RUNTIME_VERSION } from "./events.mjs";
import { readSessionIdentity } from "./identity.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FIELDS = ["hook_event_name", "session_id", "turn_id", "agent_id", "transcript_path"];
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const refuse = () => { throw Error("Sage could not verify this child start."); };

/** Native connection identity and the configured session directory are trusted launcher inputs. */
export function nativeChildStart(input, context, { sessionsDir } = {}) {
  if (!record(context) || Object.keys(context).length !== 2
    || context.version !== RUNTIME_VERSION || !UUID.test(context.actor ?? "")
    || !record(input) || Object.keys(input).length !== FIELDS.length
    || FIELDS.some(key => !Object.hasOwn(input, key)) || input.hook_event_name !== "SubagentStart"
    || input.agent_id !== context.actor || input.agent_id === input.session_id
    || typeof input.turn_id !== "string" || !UUID.test(input.turn_id)) refuse();
  const metadata = readSessionIdentity(input.transcript_path, { sessionsDir });
  if (metadata.cli_version !== RUNTIME_VERSION) refuse();
  const observation = decodeEvent(input, { version: context.version, metadata });
  if (observation.parent === observation.child) refuse();
  return Object.freeze({ session: observation.session, child: observation.child,
    parent: observation.parent, path: observation.path, turn: input.turn_id });
}

/** Delivery is not admission: SubagentStart cannot stop native child execution. */
export async function childStartOutput(input, context, mode, loadPolicy) {
  const identity = nativeChildStart(input, context, mode);
  const policy = await loadPolicy();
  const output = await policy.startChild(identity);
  if (!record(output) || !Object.hasOwn(output, "decision")) refuse();
  if (output.decision === "pass" && Object.keys(output).length === 1) return {};
  if (Object.keys(output).length !== 2 || !Object.hasOwn(output, "brief") || output.decision !== "deliver"
    || typeof output.brief !== "string" || output.brief.trim().length === 0
    || Buffer.byteLength(output.brief, "utf8") > 64 * 1024 || output.brief.includes("\0")) refuse();
  return { hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext: output.brief } };
}
