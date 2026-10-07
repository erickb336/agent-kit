import { RUNTIME_VERSION } from "./events.mjs";
import { preToolDecision } from "./pre-tool.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FIELDS = ["hook_event_name", "session_id", "turn_id", "tool_name", "tool_use_id", "tool_input"];
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);

/** Context comes from this native connection, never from model arguments or saved receipts. */
export async function mcpPreToolResult(raw, context, loadPolicy) {
  const output = await preToolDecision(raw, async () => {
    if (!record(context) || Object.keys(context).length !== 2
      || !Object.hasOwn(context, "version") || !Object.hasOwn(context, "actor")
      || context.version !== RUNTIME_VERSION || typeof context.actor !== "string" || !UUID.test(context.actor)) {
      throw Error("Native context is unavailable");
    }
    const native = { version: context.version, actor: context.actor };
    return { evaluate: async input => {
      if (Object.keys(input).length !== FIELDS.length || FIELDS.some(key => !Object.hasOwn(input, key))
        || !UUID.test(input.session_id) || !UUID.test(input.turn_id)) throw Error("Native input is invalid");
      const event = { ...input };
      if (native.actor !== input.session_id) event.agent_id = native.actor;
      const policy = await loadPolicy();
      return policy.evaluate(event, native);
    } };
  });
  // A protocol error is not a policy denial. Return denial JSON as successful MCP content.
  return { content: [{ type: "text", text: JSON.stringify(output) }] };
}
