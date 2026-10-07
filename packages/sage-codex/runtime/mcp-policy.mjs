import { nativeToolContext, nativeToolEvent } from "./native-tool.mjs";
import { preToolDecision } from "./pre-tool.mjs";

/** Context comes from this native connection, never from model arguments or saved receipts. */
export async function mcpPreToolResult(raw, context, loadPolicy) {
  const output = await preToolDecision(raw, async () => {
    const native = nativeToolContext(context);
    return { evaluate: async input => {
      const event = nativeToolEvent(input, native, "PreToolUse");
      const policy = await loadPolicy();
      return policy.evaluate(event, native);
    } };
  });
  // A protocol error is not a policy denial. Return denial JSON as successful MCP content.
  return { content: [{ type: "text", text: JSON.stringify(output) }] };
}
