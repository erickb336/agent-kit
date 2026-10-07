# Native MCP policy adapter

`mcpPreToolResult(raw, context, loadPolicy)` adapts a native `PreToolUse` call to the shared hook event shape. Supply the current connection's initialize version and the callback's native thread ID as `{version, actor}`. Neither value can come from model arguments, a saved receipt or another connection.

The six input fields are `hook_event_name`, `session_id`, `turn_id`, `tool_name`, `tool_use_id` and `tool_input`. The adapter keeps the root session. It adds `agent_id` when the native actor differs from that root. Extra fields, invalid identity and unsupported versions deny before the policy loads. This maps a native actor; it does not prove a role, assignment, owner activation or completed work.

The loader supplies `evaluate(event, context)`. Its pass or deny result uses the existing pre-tool boundary. Loading errors, policy errors and invalid results become explicit denial JSON inside a successful MCP text result. A pass preserves ordinary Codex permissions. Never replace a denial with `isError: true`: the tested runtime permits the action after that protocol result.

The caller must restrict this entry point to the hidden native hook tool, obtain authentic context, bound transport input and deliver the returned content. This module does not implement an MCP server or install a hook. Native hook execution and transport failures remain outside the policy boundary. The full Sage workflow policy still needs integration.
