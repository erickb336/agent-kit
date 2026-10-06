# Pair a native observation with a waiting guard

`createPairing` coordinates two inputs inside one live connection. It accepts a call once, when its session, turn, call, actor, tool and input hash match. Either input can arrive first. The caller must verify the runtime and authenticate both inputs before it uses this module.

`observe(evidence)` records the native observation. `request(evidence)` returns a result promise and a cancel function. The result is `pass` or `deny`. A pass preserves normal Codex approval checks; it is not a Sage policy approval. The transport must also check the response nonce and evaluate Sage policy.

A duplicate native observation ends the pending call in denial, even if both observations match. A duplicate guard denies both pending waiters. The transport must cancel a request when the guard disconnects or its deadline expires. Cancellation, a mismatch or a consumed result makes that key unavailable for the rest of the connection. No late input can reopen it. Cancellation after a completed pass cannot retract that result.

The connection retains at most 1,024 call keys by default. The caller can select a limit from 1 through 4,096. When the limit is full, new calls deny. Consumed keys are never evicted to make room. `close()` denies pending calls and permanently closes the instance. A new instance has no evidence from the previous connection.

This module does not route guards to connections, authenticate socket peers, read input streams, hash tool input, set deadlines or enforce a policy. The native fixture exercises it; no installed hook calls it. Connection replacement and concurrent child routing still need verification before installation.
