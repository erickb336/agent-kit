# Native pre-tool decisions

`preToolDecision(raw, loadPolicy)` converts one raw JSON `PreToolUse` input into native output. The caller supplies a fixed loader that resolves a module with `evaluate(input)`. Never choose the module from hook input. Load the policy inside this function so import errors cannot escape the decision boundary.

The policy returns exactly one of these values:

- `{decision: "pass"}` produces `{}`. Codex keeps its normal permission checks. Sage never emits native `allow`.
- `{decision: "deny", reason: "A short reason."}` produces an explicit native denial.

Invalid JSON, missing common input fields, input over one MiB, loading errors, policy errors and unsupported results produce a fixed denial. Error details do not enter the output. The policy validates tool-specific fields, native identity, ownership, and permission to act. The size limit bounds parsing; the caller must also bound its input stream.

This boundary covers only `PreToolUse`. The caller must write the returned JSON to standard output. A process that cannot start, an error while loading this boundary itself, a failed output write, a disabled hook or a native timeout can still prevent that denial. Do not claim complete enforcement from this function. No installed hook or manifest calls it yet.

## Native MCP delivery

A local stdio MCP hook can return this boundary's JSON as one text content block in a successful tool result. The tested Codex 0.160.0 runtime applies its explicit denial. Keep the hook tool hidden from model calls. Take the actor from the native callback's thread metadata and the runtime version from the current connection's initialization. Neither field comes from model tool arguments.

Isolated native tests use a fixed harmless control tool and the source boundary. A pass runs the control once. Explicit denial, removal of the tool name, a throwing loader and a throwing policy each prevent execution. Two concurrent root sessions pass or deny independently, both before and after resume with new connections. These tests verify delivery of fixed policy decisions; they do not prove the full Sage workflow policy.

An MCP result with `isError: true` does not become a native denial: the control still runs. The boundary must catch policy errors and return valid denial JSON. A hook that cannot run or deliver its result remains outside its control. Never report such a failure as a blocked action.

Use this direct native hook path for policy integration. A separate command guard needs connection identity that the tested interfaces do not expose. A prototype with per-call sockets allowed a new guard to consume an old pending observation. The unused pairing module was therefore removed. Its test evidence remains in the local development record; it is not part of the supported adapter.
