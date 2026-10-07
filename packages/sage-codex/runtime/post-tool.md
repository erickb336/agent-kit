# Native dispatch results

The hidden server handles captured Codex 0.160.0 `PostToolUse` callbacks. It checks
the current connection version and actor with the same boundary used before a
tool call. The native actor identifies the caller even for nested agents. Extra
actor fields in the hook input are refused.

For a spawn, message, or followup result, the adapter decodes the existing bounded
identity record and calls the trusted policy's `recordDispatchResult` method.
Only a `{ decision: "recorded" }` receipt succeeds. The policy must publish the
record durably before returning that receipt. The method receives frozen identity
fields, not the message, command, or whole native result. Unrelated tools require
no dispatch observation and do not load this policy method.

Missing methods, invalid results, and exceptions produce the server's fixed hook
failure response. A post-tool response cannot undo the tool that already ran.
An absent result must therefore leave assignment binding unverified. Capturing a
result alone does not authorize a child, release capacity, or prove report acceptance.

The full launcher still needs continuous authenticated request, result, and child
capture across mode changes and resume. It also needs a defined delivery path
when a child starts before its result is published. No installed hook enables
this runtime yet.
