import { RUNTIME_VERSION } from "./events.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FIELDS = ["hook_event_name", "session_id", "turn_id", "tool_name", "tool_use_id", "tool_input"];
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = value => typeof value === "string" && value.length > 0 && value.length <= 256 && !/\p{Cc}/u.test(value);

export function nativeToolContext(context) {
  if (!record(context) || Object.keys(context).length !== 2
    || !Object.hasOwn(context, "version") || !Object.hasOwn(context, "actor")
    || context.version !== RUNTIME_VERSION || typeof context.actor !== "string" || !UUID.test(context.actor)) {
    throw Error("Native context is unavailable");
  }
  return Object.freeze({ version: context.version, actor: context.actor });
}

/** Derive the actor from the current transport, never from model-supplied hook fields. */
export function nativeToolEvent(input, context, eventName) {
  const native = nativeToolContext(context);
  if (!["PreToolUse", "PostToolUse"].includes(eventName)) throw Error("Native event is unsupported");
  const fields = eventName === "PostToolUse" ? [...FIELDS, "tool_response"] : FIELDS;
  if (!record(input) || Object.keys(input).length !== fields.length || fields.some(key => !Object.hasOwn(input, key))
    || input.hook_event_name !== eventName || !["session_id", "turn_id", "tool_name", "tool_use_id"].every(key => text(input[key]))
    || !UUID.test(input.session_id) || !UUID.test(input.turn_id) || !record(input.tool_input)) throw Error("Native input is invalid");
  return { ...input, ...(native.actor === input.session_id ? {} : { agent_id: native.actor }) };
}
