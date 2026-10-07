import { McpServer, serveStdio, z } from "./mcp-sdk.mjs";

/** Keep visible tools off the hidden hook server so native children start their hooks eagerly. */
export function createPreparationServer(options = {}) {
  const fixed = Object.freeze({ directory: options.directory, project: options.project, observationsRoot: options.observationsRoot });
  const server = new McpServer({ name: "sage-preparation", version: "0.1.0" });
  server.registerTool("sage_prepare_task", {
    description: "Save a complete Sage task brief before spawning a named agent. Preparation does not start the agent or reserve capacity. Use the returned name for the later spawn.",
    inputSchema: z.object({ task: z.string(), run: z.string(), name: z.string(), role: z.string(),
      brief: z.object({ GOAL: z.string(), SCOPE: z.string(), CONTEXT: z.string(), DECISIONS: z.string(),
        ACCEPTANCE: z.string(), VERIFY: z.string(), BUDGET: z.string(), FORBIDDEN: z.string(), REPORT: z.string(), STANDING: z.string() }).strict() }).strict(),
  }, async (input, context) => {
    const native = { version: server.server.getClientVersion()?.version, actor: context.mcpReq._meta?.threadId };
    try {
      if (Buffer.byteLength(JSON.stringify(input), "utf8") > 64 * 1024) throw Error("Invalid request size");
      const { prepareNativeTask } = await import("./preparation.mjs");
      const output = prepareNativeTask(input, native, fixed);
      return { content: [{ type: "text", text: JSON.stringify(output) }] };
    } catch {
      return { isError: true, content: [{ type: "text", text: "Sage could not prepare this task. Check the active role, task brief, and unique agent name." }] };
    }
  });
  return server;
}

export function servePreparations(options) {
  return serveStdio(() => createPreparationServer(options));
}
