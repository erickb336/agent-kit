# Codex contract review

Date: October 6, 2026. Sage base: `dec200c101dffbaae53338ba0e5dbef5624aa472`.
Codex source: tag `rust-v0.159.2`, commit `ff6aec96948b70d94983af2641a6b67c94faeff5`.
The installed Linux CLI reports the same version. Source evidence is not a live test.

## Decision

The shared-policy design is still a good fit. The source has child identity, tool-call IDs, patch hooks, and report gates. A new policy engine or a general provider framework is not needed.

Full Sage mode is not yet a release commitment. Failed spawns and later child turns need more than a tool-name map. Keep the production refactor gated on those cases. A skills, principles, and state-tool milestone can proceed separately once its install path is checked.

## Evidence map

| Requirement | Release-source evidence | Result and remaining check |
| --- | --- | --- |
| Chief versus worker | Tool and prompt hook inputs have optional `agent_id` and `agent_type`. `hook_runtime.rs` fills them from a thread-spawned child's thread ID and role. Root inputs omit them. | Supported in source. Verify root, Sage child, and other internal child paths live. Missing fields alone are not a universal proof of chief identity. |
| Chief cannot edit | `apply_patch` has a canonical hook name and Edit/Write matcher aliases. | The replay reuses the chief denial. Live blocking still needs proof. |
| Protected logbook paths | Patch input uses the patch envelope rather than a single file path. | Parse every add/update/delete path and both sides of a move before applying shared file policy. Deny the entire patch if one path fails. A tool-name alias is insufficient. |
| Brief before spawn | `spawn_agent` exposes its arguments to PreToolUse. | Shared brief validation can run before creation. Test both message and structured-items input. |
| Call-to-child binding | Pre/PostToolUse include `tool_use_id`; the successful spawn result contains `agent_id`. SubagentStart has no originating tool-call ID. | Bind by the successful result, never by event arrival order. Capture the exact result envelope and ordering. |
| Failed spawn cleanup | The generic tool registry dispatches PostToolUse only when the result is successful. A failed `spawn_agent` returns an error. The hook event list has no PostToolUseFailure event. | A source-level gap for eager reservation cleanup. Failed shell calls use another path; their behavior does not establish failed-spawn behavior. Keep uncertain capacity occupied until a supported reconciliation proves it can be released. |
| Report before hand-back | SubagentStop has child ID, role, last assistant message, and a blocking result. | Compatible in source. Verify continuation and repeated-stop behavior live. |
| Further child work | Codex exposes send_input, resume_agent, wait, and close_agent in addition to spawn_agent. | A completed report can end a turn while the child remains available. Further work needs capacity accounting again. Map lifecycle operations, not only spawn. |
| Cancel and reconcile | Interrupt input has no child IDs or complete live-child list. Root Stop also lacks Claude's background-task list. | Do not feed an empty list into shared reconciliation or release slots just because time elapsed. Confirm close results and interrupted/failed close behavior. |
| Restore mode | The release includes PostCompact and SessionStart hook paths. | Review the release path and capture it before choosing restoration behavior. |
| Owner prompt | UserPromptSubmit has prompt text and child identity, but no explicit owner-versus-hook-continuation field. Inter-agent communication is excluded in the source path examined. | Prove synthetic continuation cannot switch mode. Keep Codex autopilot out of scope. |

## Small shared boundary

Keep runtime knowledge in two entry points. Each converts native data into a shared event and converts the policy decision back to native hook output.

The shared event needs a project/session key, actor, event kind, call ID, operation, affected paths, and optional result. Actor is chief, managed worker, or unknown. Unknown must not receive chief privileges. The operation distinguishes file changes, shell commands, spawn, child work, child completion, and confirmed closure. Do not spread Codex tool names through the rule code.

Keep brief fields, report fields, merge rules, logbook protection, and mode policy in one place. Capability checks belong at adapter startup. An unsupported runtime should produce a clear compatibility error before full mode starts.

## Lifecycle plan

1. Reserve capacity atomically before a permitted spawn. Key the reservation by session and call ID.
2. Record SubagentStart as a child observation. It cannot select a pending reservation by position.
3. Bind the reservation using the successful spawn result. Account for a child start, tool call, or stop arriving before that result.
4. Validate the report on child turn completion. Track whether the child can accept another turn separately from whether it occupies capacity now.
5. Before send_input or resume_agent starts more work on an idle child, reserve capacity and validate the task boundary. Live tests must determine which calls actually restart work.
6. Release capacity only on accepted completion or confirmed closure. Make duplicate events harmless. Preserve uncertain reservations on missing or malformed outcomes.

The unresolved failed-spawn path must not be patched with transcript scraping, a guessed timeout, or a hidden app-server supervisor. If native hooks cannot support reliable recovery, publish the useful subset and treat full orchestration as a separate decision.

## Required live checks

- Root and child shell/patch calls, including protected paths and multi-file moves.
- Two concurrent spawns with reversed completion order, then a child stopping before its spawn result is observed.
- Failed spawn, invalid role, runtime capacity denial, interruption during spawn, and failed closure.
- Completed child receiving another task; close and resume paths; no double counting or missed capacity.
- Repeated report rejection, compaction, and a Stop continuation containing a mode-on phrase.
- Fresh plugin install, vetted hook trust, existing Sage data, and unchanged Claude behavior.

Use sanitized captures as fixtures. Record runtime version, platform, event ordering, and the expected policy result. The three synthetic replay tests are useful but cannot replace these checks.

## Work and complexity

The previous 15–30 active agent-hour range remains a conditional estimate for a native-hook beta after these gates pass. It is not a quote for a supervisor or upstream runtime changes. Keep 3–6 hours as the estimate for the smaller skills/principles/state subset, subject to its install checks.

Expected production changes are: one shared hook-policy extraction, two runtime entry points, one patch-path decoder, a lifecycle correlation store, generated role/config output from shared sources, and install/documentation tests. There should be no provider branches in shared rules, duplicated role text, automatic data migration, or new service process.

The largest complexity cost is lifecycle state and recovery, not the number of adapters. Review that state machine before committing to full mode. Do not estimate production lines from this tiny replay.

## Sources

- [Hook input schemas](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/hooks/src/schema.rs)
- [Hook runtime and child identity](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/core/src/hook_runtime.rs)
- [Canonical tool names](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/core/src/tools/hook_names.rs)
- [Tool registry and success-only post hooks](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/core/src/tools/registry.rs)
- [Spawn result](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/core/src/tools/handlers/multi_agents/spawn.rs)
- [Child closure](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/core/src/tools/handlers/multi_agents/close_agent.rs)

## Local runtime attempts

Read-only CLI probes with a positional prompt and with explicit stdin were stopped after bounded waits. Removing inherited executor-reuse settings did not produce hook captures. An app-server probe completed initialize, but thread/start did not return before termination. No model task or child lifecycle was demonstrated. These results do not prove a Codex incompatibility; they leave the live gate open.
