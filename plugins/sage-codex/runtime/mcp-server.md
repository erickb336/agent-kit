# Native hook server

`serveHooks({ mode, loadPolicy })` connects the bundled SDK to the verified mode
adapter and tool policy boundary. The launcher supplies fixed project options
and a policy loader. Tool arguments cannot replace that configuration.

The server exposes one hidden hook tool, `sage_native_hook`. It snapshots the
native connection version and request actor before it loads the policy.
`UserPromptSubmit` uses the verified owner adapter. `PreToolUse` uses the tool
policy boundary. `PostToolUse` sends verified dispatch-result identity to the
trusted publication policy, as described in `post-tool.md`. It cannot undo a
completed tool. `SubagentStart` verifies native child identity before the policy
supplies instructions, as described in `child-start.md`. This event cannot stop
the child: admission belongs in the parent tool policy, and child tool calls
require a completed binding. Unknown events, missing modules, invalid input, and policy
errors return explicit denial JSON inside a successful MCP result. Error text
never enters that result. The server grants no native approval override.

The SDK validates the outer MCP request before this callback. Protocol errors
and transport failures remain outside the policy boundary. The launcher must
require connection readiness, as described in `mcp-sdk.md`.

No installed manifest starts this server yet. Its caller must supply the full
role policy before activation. The direct-edit policy alone is not enough.
The server does not configure the admission journal, start agents, release
reservations, or change autopilot. Those operations need their own verified
lifecycle and role rules.
