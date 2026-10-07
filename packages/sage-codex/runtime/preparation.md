# Native task preparation

`servePreparations(options)` exposes one model-visible tool, `sage_prepare_task`,
in a separate MCP server. Keep the hidden hook server required, with connection
startup readiness. A visible tool on that server can delay a child's hooks.

The launcher fixes `directory`, `project`, and `observationsRoot`. The last path
contains one observation directory per native root UUID. These paths must be
trusted local storage. The preparation server never accepts paths, sessions,
issuer IDs, or ownership claims from tool arguments.

The tool accepts a task ID, run ID, unique child name, requested role, and all
ten brief fields. Native connection metadata supplies the runtime version and
actor. An activated owner acts as chief. A lead needs its saved assignment and
child binding, plus matching request, result, and start observations. Ambiguous
path reuse refuses the request. Specialists cannot prepare children.

The tool saves the instructions through core and returns a preparation receipt.
It starts no agent and occupies no capacity. The returned name selects the work
for a later native spawn by the same actor in the same project and owner epoch.
Retries cannot replace instructions. A receipt is not spawn permission.

`reservePreparedSpawn(rawInput, nativeContext, options)` handles the actual
native PreToolUse spawn. Pass the raw payload before adding a derived `agent_id`.
It records the request, including rejected or inactive attempts, then checks the
actor and consumes the matching preparation through core. Only `permit-once`
can pass the spawn. An `already-reserved` result must not grant another dispatch.
The command hook must retain its normal native permission checks.

Tool input validation and preparation failures return a fixed visible error.
The SDK can reject malformed outer requests before the handler. This visible
error response is separate from the successful MCP denial required by hooks.

This server is not installed. Setup and full policy assembly remain required.
Callers must capture every dispatch continuously, including mode-off and resumed
sessions. A missing callback cannot be detected from saved observations alone.
Child delivery before result publication, compaction, lifecycle recovery, and
capacity release still need integration. Neither server repairs capture gaps or
establishes authority from a saved name alone.

## Native verification

An isolated Codex 0.160.0 check uses the packaged preparation server and hidden
hook server. The owner prepares and spawns a lead. That lead prepares and spawns
QA. Both children receive their complete saved brief and role in their first
model request. The journal links two preparations to two native dispatches and
records each actual issuer. The check uses local mock responses and a test
policy; it does not establish a production project workflow.

The mock model catalog must declare `multi_agent_version: "v2"`. Without that
capability, native Codex omits collaboration tools from the lead. The initial
nested check caught that fixture error. Codex's pinned
[tool-selection source](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/core/src/tools/spec_plan.rs)
requires this capability for a V2 child's collaboration tools. Installation must
verify the selected model's capabilities too.
