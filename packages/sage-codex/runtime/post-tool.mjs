import { decodeEvent } from "./events.mjs";
import { nativeToolContext, nativeToolEvent } from "./native-tool.mjs";

/** A result is evidence of completed dispatch, never permission to run it again. */
export async function postToolOutput(input, context, loadPolicy) {
  const native = nativeToolContext(context);
  const event = nativeToolEvent(input, native, "PostToolUse");
  const observation = decodeEvent(event, { version: native.version });
  if (!observation) return {};
  const policy = await loadPolicy();
  const receipt = await policy.recordDispatchResult(Object.freeze(observation));
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)
    || Object.keys(receipt).length !== 1 || !Object.hasOwn(receipt, "decision") || receipt.decision !== "recorded") throw Error("Dispatch result was not recorded");
  return {};
}
