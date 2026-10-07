# Native child instructions

The hidden server accepts the captured Codex 0.160.0 `SubagentStart` callback.
It checks the connection actor, the root session, the child, the current callback turn,
and the transcript metadata under the configured sessions directory. It gives
only the frozen identity fields to the trusted policy's `startChild` method.
The policy must bind that identity to an admitted assignment before it returns
`{ decision: "deliver", brief }`. An explicit `{ decision: "pass" }` supplies no
instructions. The first transcript record identifies the child. Later records
can contain inherited parent history, so they do not supply the current turn.
The policy must match the callback identity to its assignment scope and binding.
Missing methods, invalid results, and exceptions return the fixed
hook failure response without private error details.

The brief is nonempty text, at most 64 KiB, without NUL bytes. The launcher must
set a native context limit that carries the complete brief. The response uses
`hookSpecificOutput.additionalContext`; no brief enters a real shell.

A native check observed this text in the child's first model request. A second
check showed that `decision: "block"` at child start does not stop that request.
This event is a delivery path, not an admission gate. The parent tool policy must
approve the spawn first. The child tool policy must refuse work until the binding
is complete. Never enable automatic Sage with this delivery adapter alone.

Durable brief storage, assignment binding, instruction restoration after
compaction, and the complete dispatch policy remain integration work. The current
native evidence uses an isolated profile and local mock model responses.
