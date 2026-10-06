# Codex prototype results

October 6, 2026. Isolated branch: `spike/codex-feasibility`.

## Result

We have working local prototypes for exact spawn correlation, capacity tracking across later child turns, report repair, and whole-patch protection. They reuse Sage's existing report and file rules. No production hook, manifest, dependency, or state format was changed.

The new lifecycle model is 87 lines and the patch policy boundary is 43 lines. These sizes describe the spike only. They exclude native event decoding, durable storage, process locks, packaging, and live integration.

The prototype suite has 18 passing tests. One test checks all 180 orderings of two workers' begin/result/finish events in which each begin precedes its finish. Build and static checks pass. A fresh complete baseline run passed all 450 tests, with no failures or cancellations, in approximately 173 seconds.

## Which questions have working answers?

| Question | Prototype result | Remaining runtime dependency |
| --- | --- | --- |
| Will reversed spawn results bind the wrong slot? | No. Reservations use exact call IDs and results use exact child IDs. The ordering test passes. | Decode native spawn result envelopes and prove event delivery. |
| Can a worker finish before its spawn result? | Yes. Accepted completion is kept until its exact result binds; only that reservation is released. | Verify native child turn-begin and stop ordering. |
| Will duplicate events or a restart double-count capacity? | No in the model. Duplicate reservation/bind/stop/close events are harmless; a snapshot retains unknown occupancy. | Snapshot durability and locking between hook processes are not implemented in this in-memory spike. |
| Can a worker receive another task without bypassing the cap? | The model reserves again before later work. An old turn's stop cannot release the new reservation. | Map send_input's submission ID to the native child turn. Queued messages, interrupted work, and resume still need captures. |
| Does report repair need another slot? | No. A rejected report retains capacity, and its repair turn uses the same reservation. Sage's existing report gate supplies the decision. | Verify continuation provenance and native turn IDs. |
| Can a protected file hide inside a larger patch? | No in the tested decoder. Add/update/delete paths and both move paths reach Sage's existing file policy. One denied path denies the entire patch. | Conformance with Codex's complete patch grammar. Unsupported forms are currently refused. |
| Can a symlink or ../ path bypass logbook protection? | The tested paths are refused by Sage's existing canonical-path protection. | Concurrent file-system changes remain subject to the same limits as existing hooks. |
| Can unknown actors receive chief privileges? | The patch boundary rejects unknown actor identity. | Native classification of roots, managed children, and internal children still needs proof. |
| Can failed spawns recover capacity automatically? | **No complete solution yet.** An unknown outcome keeps capacity occupied, preventing over-allocation. A verified failure can release it in the model. | The examined Codex path supplies no failed-spawn hook. The adapter cannot invent the model's verified-failure input. |
| Can interruption or a failed close safely release capacity? | No release is made from interruption or unverified closure. Confirmed close releases only the known child. | Prove closure results and obtain supported reconciliation for missing results. |
| Can a synthetic continuation turn Sage on? | No new solution is claimed. | A verified prompt-origin contract or an explicit scoped startup activation path is still required. |
| Do installation and compaction work? | Not tested by these prototypes. | Fresh installation, trusted-hook loading, generated roles, and compaction captures remain release gates. |

## Code and reproduction

- `lifecycle.mjs`: an in-memory, session-scoped model. It contains no Codex or Claude tool names. The adapter would supply verified identities and outcomes. Project/global atomic limits still need the existing store or a reviewed shared store boundary.
- `patch-policy.mjs`: a strict path decoder and thin call into the existing Sage file policy. It deliberately rejects unsupported patch syntax.
- The matching test files exercise adversarial ordering and protected paths. `replay.test.mjs` retains the original three shared-rule checks.
- `runtime-probe.mjs`: a bounded native-process probe with a local deterministic Responses endpoint. It emits one fixed printf command and then a final message. It performs no delegated work and sends no requests to an external model.

Run the local prototypes:

```bash
node --test spikes/codex/*.test.mjs
```

Run the native baseline and capture probe on a working Codex installation:

```bash
SAGE_CODEX_BIN=/absolute/path/to/codex node spikes/codex/runtime-probe.mjs --no-hooks
SAGE_CODEX_BIN=/absolute/path/to/codex node spikes/codex/runtime-probe.mjs
```

The baseline disables hooks. The capture run trusts its own fixed hook script for that invocation. Both use read-only sandboxing, ignored user config, and in-memory auth. They leave installed hooks and user config untouched. Requests are consumed without saving their bodies or authorization headers. Probe artifacts are placed in a new temporary directory printed in the result. A timeout or missing expected hook event returns a failing exit code.

## Native result in this environment

The installed 0.159.2 CLI stalls before model responses and hook capture. The controlled baseline also stalls with hooks disabled. Earlier exploratory probes reached the local model catalog endpoint but still did not produce a Responses request. Changing inherited executor settings, disabling plugins/apps and shell snapshots, and using in-memory auth did not resolve startup. A 0.158.0 comparison also stalled.

This isolates the problem from Sage's hook logic, but does not identify its cause. The probe's model server is deterministic; even a successful run would verify runtime integration rather than real-model task quality. No native spawn, report, cancellation, installation, or compaction pass is claimed.

## Recommended scope

Keep the two-adapter/shared-policy design. Promote exact call correlation and whole-patch checks only after native fixtures pass. Do not copy the spike's in-memory store into production: review durable state and atomic limits separately.

Full orchestration stays gated on failed-spawn recovery, follow-up turn identity, prompt provenance, and live integration. A conservative refusal preserves the cap, but a permanently occupied slot is not a complete recovery solution. If native hooks cannot provide that evidence, ship the skills/principles/state subset and re-scope orchestration explicitly. Do not hide a supervisor or guessed timeout inside the adapter.
