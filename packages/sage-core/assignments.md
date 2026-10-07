# Assignment and report identity

This API joins an explicit report reference to a previously issued assignment. It does not authorize a caller, accept report content, finish a run, or release capacity.

`createAssignment(scope, dispatch)` gives each assignment a fresh ID. The scope contains the project logbook key, root session, and current epoch. The dispatch contains the task, run, issuer, and exact tool call. Task and run numbers are local to a project; they are not global identities.

The trusted adapter must establish the scope and issuer, then persist the assignment before it permits the dispatch. An epoch comes from session ownership and recovery policy. A resumed root ID alone does not establish the current epoch. This module does not implement that authority or storage protocol.

`correlateReport` takes five separate records:

- `scope`: the current authoritative project, session, and epoch.
- `assignment`: the persisted intent issued before dispatch.
- `binding`: the project, session, epoch, assignment ID, issuer, call, and child from verified runtime correlation.
- `native`: the session, child, and turn from the current runtime callback.
- `reference`: the assignment ID, task, and run declared in the report.

Never derive the binding from the sole pending task. Never take the native identity or current scope from report text. Missing, conflicting, or malformed identity causes an error. Initial child identity can be bound after dispatch through exact runtime observations. Persist that binding with its assignment and epoch. Reject ambiguous call reuse; matching strings alone do not prove that old runtime observations belong to a new epoch.

The result is a `report-submission` identity receipt. Duplicate input returns the same receipt. Separate reports in the same child turn can also have identical identity receipts. Retain each attempt and its content validation separately; receipt equality is not report equality. A receipt says that the named child submitted a reference to this assignment during this turn. It does not prove which input caused that turn, that the child consumed all queued messages, or that the report is correct.

Keep submissions separate from report validation, chief acceptance, native completion, and capacity. A stop callback can precede a continuation in the same turn. The adapter must retain the report's separate content check and any rejected attempts. Existing run, finding, and verdict rules remain responsible for task results. No installed hook calls this API yet.
