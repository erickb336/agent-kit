// Native PreToolUse decision boundary. No installed hook calls this module yet.
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value, limit) => typeof value === "string" && value.length > 0 && value.length <= limit && !/\p{Cc}/u.test(value);
const deny = (reason = "Sage could not verify this tool call.") => ({
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
});

/** Load inside the boundary: a dependency error must become a native denial. */
export async function preToolDecision(raw, loadPolicy) {
  try {
    if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > 1024 * 1024) return deny();
    const input = JSON.parse(raw);
    if (!record(input) || input.hook_event_name !== "PreToolUse" || !record(input.tool_input)
      || !["session_id", "turn_id", "tool_use_id", "tool_name"].every((key) => text(input[key], 256))) return deny();
    const policy = await loadPolicy();
    const result = await policy.evaluate(input);
    if (!record(result)) return deny();
    const keys = Object.keys(result);
    // An explicit native "allow" would bypass normal approvals. Pass emits no decision.
    if (result.decision === "pass" && keys.length === 1 && keys[0] === "decision") return {};
    if (result.decision === "deny" && keys.length === 2 && keys.includes("decision") && keys.includes("reason")
      && text(result.reason, 500) && result.reason.trim() === result.reason) return deny(result.reason);
    return deny();
  } catch {
    // Errors can contain private paths or tool input. Return only a fixed message.
    return deny();
  }
}
