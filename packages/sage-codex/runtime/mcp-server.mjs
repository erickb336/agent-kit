import { McpServer, serveStdio, z } from "./mcp-sdk.mjs";

const reason = "Sage could not verify this hook request.";
const denied = event => event === "PreToolUse" ? {
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
} : { decision: "block", reason };
const result = output => ({ content: [{ type: "text", text: JSON.stringify(output) }] });

/** Configuration and policy loaders come from the server launcher, never tool arguments. */
export function createHookServer({ mode, loadPolicy } = {}) {
  // Copy the configured values so a caller cannot change an active connection's binding.
  const configuredMode = mode && Object.freeze({ directory: mode.directory, project: mode.project,
    projectDirectory: mode.projectDirectory, sessionsDir: mode.sessionsDir });
  const server = new McpServer({ name: "sage-native-hooks", version: "0.1.0" });
  server.registerTool("sage_native_hook", {
    description: "Evaluate a native Sage hook request.",
    inputSchema: z.object({}).passthrough(),
    _meta: { ui: { visibility: ["app"] } },
  }, async (input, context) => {
    // Snapshot trusted transport values before loading or evaluating any policy.
    const native = { version: server.server.getClientVersion()?.version, actor: context.mcpReq._meta?.threadId };
    try {
      const raw = JSON.stringify(input);
      if (Buffer.byteLength(raw, "utf8") > 1024 * 1024) return result(denied(input.hook_event_name));
      if (input.hook_event_name === "PreToolUse") {
        const { mcpPreToolResult } = await import("./mcp-policy.mjs");
        return await mcpPreToolResult(raw, native, loadPolicy);
      }
      if (input.hook_event_name === "SubagentStart") {
        const { childStartOutput } = await import("./child-start.mjs");
        return result(await childStartOutput(input, native, configuredMode, loadPolicy));
      }
      if (input.hook_event_name === "UserPromptSubmit") {
        const { updateOwnerMode } = await import("./mode.mjs");
        const updated = updateOwnerMode(input, native, configuredMode);
        return result(updated ? {} : denied(input.hook_event_name));
      }
    } catch {
      // Errors may contain private input or paths. A successful MCP result must carry the denial.
    }
    return result(denied(input.hook_event_name));
  });
  return server;
}

/** Start one hidden hook server per native connection; the caller owns trusted configuration. */
export function serveHooks(options) {
  return serveStdio(() => createHookServer(options));
}
