# Atomic admission

This store records session ownership and reserves capacity before a dispatch. It covers only sessions that use this same canonical local directory. It does not enforce role permissions, validate native identity, release capacity, or recover a session automatically.

The trusted adapter uses five operations:

1. `configureAdmission(directory, {total, projects})` fixes the store and project limits. Each project entry has `project` and `limit`. Repeated equal configuration is safe; changed limits require reconciliation.
2. `activateAdmission(directory, {project, session, activation}, {sage})` records scoped session identity and creates its epoch. The third argument defaults to `{sage: true}`. Use `{sage: false}` to record an initial verified off request without enabling Sage. The adapter must obtain activation authority through the verified entry path. The same request returns the same owner. Another activation cannot replace it.
3. `reserveAdmission(directory, scope, request, dispatch)` saves an assignment and consumes its single dispatch permit atomically. Scope and request use the assignment API. Dispatch contains the native `tool`, parent `turn`, requested child `name`, and `argumentsHash` of all relevant native arguments.
4. `changeAdmissionMode(directory, {project, session, epoch, after, turn, sage})` records a verified owner mode request. `after` must name the current mode turn; `turn` names this prompt, and `sage` is boolean.
5. `readAdmission(directory)` returns the configuration, session records, held reservations, and mode records.

Only a newly committed reservation returns `decision: "permit-once"`. An exact retry returns `"already-reserved"` with the saved assignment. It must not permit another native call. Changed arguments, tool, turn, name, task, or run are refused. After an uncertain result, keep the reservation held; do not invent another call identity to repeat the same work.

All reserved assignments count toward both limits. A report submission, native stop, elapsed time, or new activation does not release one. Project and session names are identity keys, not paths. The adapter must validate issuer rights separately and convert every refusal or storage error into an explicit native denial. Throwing from a hook alone might not deny the tool.

The journal consists of immutable, numbered, hash-linked records. Each reader checks the complete prefix and its state transitions. A writer syncs the pending record before linking it to the next revision. Only one concurrent writer can publish that revision. A loser reads again and rechecks capacity. Directory sync precedes permission, including when a retry finds an existing reservation. A failure after publication keeps the record and its reservation.

The journal permits 4,096 records and 64 KiB per record. Unpublished pending files do not change state, but count toward the scan bound. Gaps, invalid files, conflicting records, exhausted bounds, or excessive contention cause refusal. No PID probe, process signal, timeout expiry, or shared mutable lock file is used.

This requires a local filesystem with atomic hard links and directory sync. The containing directory must remain controlled by the caller. Hostile replacement of ancestor directories by another same-user process is outside this API's boundary. Tests cover local concurrency and an injected sync failure; they do not simulate physical power loss. Production activation, native denial, completion, and recovery need their own integration checks. No installed hook calls this API yet.


## Mode continuity

Activation uses its requested initial mode and the activation ID as its first mode turn. The default is on. An explicit initial off still leaves a durable request receipt. A later change must name the same owner epoch and the expected prior mode turn. Concurrent changes cannot both replace that turn. Read current state after a conflict; do not automatically turn a stale request into a new one.

An exact retry returns `already-recorded` and the current mode, which may differ from its old request. It never reapplies that request. Reusing a turn with different fields is refused. A new transition returns `changed` and its mode record. Mode records retain identity and booleans only, never prompt text.

Off mode refuses new admission without releasing any held reservation. An exact reservation retry still returns its saved receipt, never another dispatch permit. On restores admission under the existing limits and epoch. Neither transition revokes an already-issued native call, proves a child stopped, or permits a merge. Autopilot remains separate. The adapter must partition native session identity by provider and verify ownership before it calls this API.

The journal reader reconstructs mode from activation and subsequent changes after restart. The same atomic publication and sync rules cover these records. Existing records without an explicit initial mode retain their original on meaning. Older readers refuse the new activation fields or an unknown mode record, so update participating adapters together before sharing a store. No installed automatic hook uses this API yet.
