import { chiefEditDenied } from "../core/index.mjs";

/** This is one policy check, not a complete tool policy. Mode and chief identity must be verified by the caller. */
export function directEditDecision(input, context) {
  if (input.tool_name !== "apply_patch") return { decision: "pass" };
  return chiefEditDenied(context)
    ? { decision: "deny", reason: "Sage mode is on. The chief must give file changes to an implementer." }
    : { decision: "pass" };
}
