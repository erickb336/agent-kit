# Claude parity audit for issue #88

This audit compares repository behavior with the prepared Codex runtime. It is a source audit, not a live Claude or installed Codex pilot.

| Area | Claude baseline | Codex gap and required result |
| --- | --- | --- |
| Owner activation | Hook checks owner text, toggles Sage, delivers chief instructions once | Prepared owner identity/mode adapter is not installed; wire verified activation and instruction delivery |
| Off | Mode hook clears Sage, instruction-given and autopilot flags; direct chief edits resume | Match this transition; do not add native interruption to mode-off |
| Compaction | PostCompact clears instruction-given; next prompt restores chief instructions | Add native compaction restoration without a second owner activation |
| Chief authority | Chief delegates file edits; only state tool writes logbook | Prepared patch check alone is incomplete; cover all supported write and command paths |
| Routes | Shared chief names least routes by size and added risk reviews | Use the same shared routes, task states and product gates; complete installed chief workflow |
| Brief | Ten fields required before spawn | Immutable prepared briefs exist; join every admitted native dispatch to its exact saved brief |
| Roles and limits | Chief starts leads; leads start permitted children; project/total/lead/child caps | Shared admission exists but installed enforcement and complete lifecycle release are missing |
| Native start/result | Hook binds slots and handles spawn results/failures | Prepared event joins require verified result and child identity; establish delivery order through actual transport |
| Report stop | First incomplete report blocks; second stop proceeds to avoid an endless loop | Preserve bounded correction behavior; terminal completion is not acceptance of an incomplete report |
| Slot release | Subagent stop, failed dispatch and registry reconciliation; lease expiry also exists | Native stop/result evidence must identify the exact assignment; no stale event can release a newer slot |
| Reports/verdicts | Chief records run result, findings and exact-head verdicts using state commands | Add verified report intake and durable records; child claims do not directly write the logbook |
| Reviews/repairs | Shared rounds, held/replan and clean cycles; a new head restarts cycles | Use shared state/merge-check behavior, including blocking verdict regression |
| Manual merging | Autopilot starts off; verified work waits for owner merge | First delivery stage matches this behavior |
| Autopilot | Explicit owner on; chief merges only after exact-head gates; children never merge | Prepared Codex adapter always false; a separate stage is required for full parity |
| Board/status | Shared rich board and status dispatch, source-qualified questions | Model is shared; installed Codex phrase delivery remains unverified |
| Arena/models | Shared chief describes candidate/judge workflow; provider binds model settings | Preserve arena workflow, use Codex model names and supported native configuration |

## Interpretation boundaries

Parity means the same owner experience, task routes and shared rules through each provider's supported transport. It does not mean copying Claude-specific metadata, tool names or process leases into Codex.

The report hook's second-stop escape prevents a continuation loop. It does not provide evidence that missing report fields became valid. Separate report acceptance from the native terminal result and capacity accounting.

Claude's lease expiry and registry cleanup cannot be assumed to map to Codex. Issue #88 explicitly requires authoritative lifecycle evidence and protection against stale releases. Verify the Codex-native mechanism while preserving the owner's limits and visible task behavior.

## First implementation unit

Produce a reproducible isolated native transport probe for the supported installed runtime. Record owner prompt identity, dispatch/result/start/stop ordering, denial behavior and compaction. Do not activate the automatic workflow until those boundaries and the complete tool policy pass.

Current local CLI reports version 0.160.0, matching the prepared adapter's exact version. Generated native schemas expose turn interruption keyed by both thread and turn, and a separate turn-completed notification. Schema presence is not proof that an active child stopped.

## Baseline source pointers

- `packages/sage-claude/hooks/sage-hook.mjs`: mode switching, compaction, brief/report validation and slot lifecycle.
- `packages/sage-core/roles/chief-of-staff.md`: routes, reports, repairs, cycles, owner gates and arena.
- `packages/sage-claude/chief-bindings.json`: provider dispatch and autopilot behavior.
- `packages/sage-codex/runtime/mode.mjs`, `policy.mjs`, `events.mjs`: prepared native integration and current omissions.

## Native transport result

The isolated 0.160.0 probe observed one spawn request, matching successful result, child start and child stop. It verified the same child/session/path identities, a running child while its model response was held, and the exact terminal completion marker. No real model or owner logbook participated.

The native task arrived as an `agent_message` with an opaque payload. The fixture compares exact transport bytes; it cannot prove real-model consumption. Earlier fixture failures came from a noncanonical temporary path and an incorrect user-message assertion. Both were corrected before the successful result.

Run `node scripts/probe-codex-lifecycle.mjs` with fake process tools first on PATH. It requires Codex 0.160.0 and a loopback listener. It creates an isolated temporary profile and trusts only the test observer there. It does not trust or change hooks in the owner's profile.

Denial enforcement, event ordering under races, compaction, subsequent child tasks and real-model consumption remain separate checks. This result does not activate Sage.
