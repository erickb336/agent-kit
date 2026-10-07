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


## Role reservations

`reserveRoleAdmission(directory, scope, request, dispatch, rolePlan)` applies the
lead-build rules in the same atomic transaction as project and total capacity.
`rolePlan` has exactly `issuerRole` and `role`. The adapter must establish the
issuer's role from verified native binding and saved assignment evidence.
An agent's name, tool arguments, or message cannot establish that role.

Only the chief can start leads. A lead can start implementer, code-reviewer,
security-reviewer, ux-reviewer, and qa. Specialists cannot start agents.
The chief may still start the existing specialist roles directly for framing
and other current workflows. The chief itself is the owner session, never a
child role.

The project holds at most three leads across its participating sessions. Each
lead holds at most three children in its session and epoch. All reservations
also count toward project and total limits, so the lowest applicable limit wins.
No stop, report, or mode change releases these slots. Completion and recovery
still need their separate protocol.

Legacy reservations retain their original shape and consume normal capacity.
Their role is unknown, so each also counts as a possible lead for the three-lead
limit. They confer no role authority. The legacy reservation API remains for
existing callers; an adapter that enforces roles must use `reserveRoleAdmission`.
A retry cannot change or remove a recorded role plan, and it never permits a
second dispatch. Older readers reject role-bearing records rather than ignore
the new rule. Update all participants before sharing this journal.

This API checks supplied role facts; it does not authenticate them. Native role
binding, readable briefs, report acceptance, and launcher integration remain
required before automatic Sage activation. Claude hook wiring stays in its
separate lead-build issue.

## Initial child binding

`bindAdmission(directory, binding)` records which verified child belongs to an
admitted assignment. The binding carries project, session, epoch, assignment ID,
issuer, dispatch call, child identity, and initial callback turn. It must match a
reservation with a saved role. The result reports that role from the reservation;
a caller cannot supply a replacement role. `readAdmission` now also returns
`bindings`.

Publication enforces one initial binding per assignment and one assignment per
child within a provider session. Exact retries return the saved binding. Changed
identities, reused child names, and self-binding fail. New role reservations
cannot reuse a child name under the same issuer and scope. Older roleless APIs
can still record ambiguous names; those records cannot produce a child binding.
New role reservations carry an explicit unique-name rule. Older records retain
both their bytes and their replay behavior, including reused names. An ambiguous
old name cannot receive a new binding. An existing exact binding receipt remains
readable after a later legacy name collision. Older readers reject the new rule
and binding events.

Binding records an already-admitted child even when Sage mode is now off. It does
not grant another spawn permit, allow work, release capacity, accept a report,
or prove that a brief arrived. The trusted adapter must authenticate the child,
namespace sessions by provider, verify the parent and child address, and apply
current mode and task policy before allowing tools. Initial binding does not
implement later tasks, agent reuse, or recovery.

## Durable task briefs

`reserveBriefAdmission` takes the same arguments as `reserveRoleAdmission`, then
a structured brief. It saves the assignment, role, brief, and capacity in one
journal event before it returns the single dispatch permit. Every brief has the
existing ten Sage fields, each with nonempty text. Its canonical JSON is at most
32 KiB, uses valid Unicode text, and contains no NUL bytes. `parseBrief` validates and copies those fields;
`renderBrief` produces their text in the fixed field order.

An exact retry retains the saved brief. Changing it, adding it to an earlier
reservation, or dropping it through an older API fails. Older reservations retain
their format and remain readable. They do not acquire instructions automatically.
Invalid briefs and capacity failures publish no reservation.

The bound Codex result includes the saved brief when present. A trusted delivery
policy must use that brief, rather than a fresh model-supplied replacement. Brief
text is task context, not role authority or permission to run a command. Native
context limits must fit the rendered brief and the role instructions together.
The visible preparation tool, instruction assembly, and complete delivery policy
remain integration work. State files stay private to the local Sage store.

## Prepare a task before dispatch

`prepareAdmission(directory, scope, request, rolePlan, brief)` saves the task,
run, issuer, unique child name, role plan, and complete brief. The request has
`task`, `run`, `issuer`, and `name`. The trusted adapter supplies the current
scope and issuer role. A preparation ID is a reference, not proof of authority.

Preparation creates no assignment, occupies no agent slot, and grants no spawn
permission. It checks the role relationship and requires Sage mode. An exact
retry returns the original preparation, even after mode turns off. A changed
task, role, run, or brief needs a new child name. The journal bounds apply to
preparations too; this API does not provide deletion or reclamation.

`reservePreparedAdmission(directory, scope, request, dispatch, issuerRole)`
consumes the saved work at the actual native dispatch. Its request has
`preparation`, `issuer`, and `call`. The adapter must establish these values
from trusted runtime evidence and verify the current issuer role again.
The transaction checks scope, issuer, child name, role, mode, and capacity.
It copies the saved brief and links the resulting assignment to its preparation.
Only one call can consume a preparation. An exact retry returns the existing
assignment and grants no additional permission.

Legacy events retain their bytes and semantics. Callers that use the older
reservation APIs do not automatically enforce preparation. A production adapter
must use the prepared path consistently. The model-visible preparation server,
its native identity checks, and the spawn correlation policy remain separate
integration work. These core APIs do not start native agents.
