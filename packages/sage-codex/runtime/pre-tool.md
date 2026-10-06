# Native pre-tool decisions

`preToolDecision(raw, loadPolicy)` converts one raw JSON `PreToolUse` input into native output. The caller supplies a fixed loader that resolves a module with `evaluate(input)`. Never choose the module from hook input. Load the policy inside this function so import errors cannot escape the decision boundary.

The policy returns exactly one of these values:

- `{decision: "pass"}` produces `{}`. Codex keeps its normal permission checks. Sage never emits native `allow`.
- `{decision: "deny", reason: "A short reason."}` produces an explicit native denial.

Invalid JSON, missing common input fields, input over one MiB, loading errors, policy errors and unsupported results produce a fixed denial. Error details do not enter the output. The policy validates tool-specific fields, native identity, ownership, and permission to act. The size limit bounds parsing; the caller must also bound its input stream.

This boundary covers only `PreToolUse`. The caller must write the returned JSON to standard output. A process that cannot start, an error while loading this boundary itself, a failed output write, a disabled hook or a native timeout can still prevent that denial. Do not claim complete enforcement from this function. No installed hook or manifest calls it yet.
