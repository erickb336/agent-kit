# Bundled MCP SDK

The Codex plugin includes the MCP SDK for its native hook server. The installed
plugin needs Node 20 or later. It needs no npm install.

For a source checkout, run `npm ci --ignore-scripts` before the build or checks.
The lockfile pins the build tools and all dependencies. CI uses the same command.
`npm run build` bundles `mcp-sdk.mjs` and copies each dependency license.
`npm run check` builds the expected content and rejects stale output.
The build dependencies also pin libraries embedded in the published SDK.
They supply the full license texts; they add no plugin installation step.
After an SDK update, review its bundled inputs and update the license list.

The SDK exports `McpServer`, `serveStdio`, and `z`. Native hook handlers read the
connection version from `server.server.getClientVersion()`. They read the actor
from `context.mcpReq._meta.threadId`. Neither value comes from tool arguments.
Missing identity must remain missing and must reach the policy denial boundary.

Hook tools use `_meta.ui.visibility: ["app"]`. They must stay separate from
model-visible tools so Codex starts the hook server before the first child call.
Server configuration still needs `required = true` and
`startup_readiness = "connection"`.

This bundle does not enable a server or change the installed hook manifest.
The server still needs complete role rules, lifecycle recovery, and a project
pilot before automatic Sage can ship. A transport error is not a policy denial;
handlers must return explicit native denial JSON as successful MCP content.
