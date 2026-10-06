# Codex feasibility spike

Status: partial evidence; full runtime support is not established.

Latest: [prototype-results.md](prototype-results.md) records the working lifecycle and patch prototypes, 18 passing tests, and the remaining native gates.

Baseline: dec200c101dffbaae53338ba0e5dbef5624aa472. Available CLI: codex-cli 0.159.2 on Linux.

## Evidence

- npm run build and npm run check passed without tracked changes.
- node --test spikes/codex/replay.test.mjs passed all 3 tests.
- The replay denies unknown actor identity, maps a chief patch into the current edit policy, and reuses brief checks, slot reservation/binding and report validation/release.
- All changes are in this spike folder. No production adapter, dependency or policy fork was added.
- The complete baseline suite passed: 450 tests, no failures or cancellations. It took about 166 seconds. Earlier runs disconnected or hit a shorter time limit.
- Bounded read-only CLI hook probes stalled before any event was captured. An app-server probe completed initialize but did not complete thread/start before termination. No live tool or child lifecycle claim follows from the replay.
- The matching Codex release source was reviewed at rust-v0.159.2, commit ff6aec96948b70d94983af2641a6b67c94faeff5. It has child identity on ordinary tool hooks and a successful spawn result containing child identity. See [contract-review.md](contract-review.md) for the full matrix and source links.

## Quality findings

Sage's current handler is callable and its rules can be reused through a small translation boundary. That is useful evidence for a clean port, but the replay maps to Claude-shaped inputs and is deliberately not production architecture. A neutral event contract is justified only after the real event shapes are known.

The current revision also protects logbook writes and applies merge/push rules across several shell tools. A port must preserve those checks. Translating only Edit and Agent is insufficient.

The fixture supplies actor identity explicitly. It does not infer that a missing agent_id means chief. Patch path parsing, shell-result parsing, mode provenance, spawn-to-child correlation, cancellation and slot reconciliation remain unverified live. The current slot store binds the next pending slot on SubagentStart. Codex correlation must use the exact spawn call and result instead.

The release-source review found two additional scope requirements: failed generic tool calls do not dispatch PostToolUse in the path examined, and completed children can receive further work through lifecycle tools. Reliable failed-spawn recovery and capacity accounting for later child turns are full-mode release gates.

## Recommendation

Continue the investigation, not the production refactor. Shared policy reuse is promising. Full Sage mode remains gated on live captures. Do not add transcript heuristics, broad provider branches or a new supervisor to force compatibility.

Next capture: owner prompt, main/child shell and patch calls, two simultaneous spawns, failed spawn, child stop, later child work, closure/resumption, interruption and synthetic stop continuation. Record exact runtime version and sanitize event fixtures. Then replace synthetic arguments with captured schema and re-run the same rule checks.

## Reproduce

From the repo root:

```bash
node --test spikes/codex/replay.test.mjs
node --test spikes/codex/*.test.mjs
```

No installed hooks or user configuration are changed by the replay.
