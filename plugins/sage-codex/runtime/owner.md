# Root prompt classification

`ownerPrompt(input, {version, metadata})` recognizes the captured local Codex 0.160.0 root `UserPromptSubmit` path. It returns the root session, prompt turn and original text. It returns `null` for other events, child fields, unknown fields, unsupported versions, malformed input, or mismatched metadata.

The caller must receive input from the native hook, verify the running runtime, and read the first session metadata record from the hook's validated transcript path. Arbitrary JSON is not authenticated by this function. The metadata creation version cannot prove the current executable version. Keep this adapter disabled when the caller cannot establish that context.

The metadata must explicitly identify the root as both `id` and `session_id`. Parent or agent-path fields cause refusal, including null fields. Only the eight captured prompt fields are accepted. A future native field requires review before activation can use it.

Native fixtures distinguish the initial root prompt from child final reports and a Stop continuation. They do not prove every input API or resumed-session authority. This function is not a substitute for those checks.

The function does not interpret mode phrases, retain text, create ownership, reserve capacity, or release work. Shared phrase policy must decide whether owner text actually requests a mode change. Quotes and questions remain text here. Forwarded prompt text is limited to one MiB; the hook entry must also bound its input read. No installed hook calls this module yet.


## Fresh runtime evidence

`freshRuntime(input, {metadata})` recognizes the captured seven-field root `SessionStart` with source `startup`. It requires matching root metadata and the supported creation version. It returns the session and version, or `null`. Native source maps new history to startup, resumed history to resume, and forked history to fork or resume. A new session writes its metadata with the creating runtime's version.

This is evidence at fresh creation, not permanent runtime authority. The caller must receive the native callback and use the bounded metadata reader. Arbitrary JSON remains unauthenticated. Never reconstruct this evidence from a saved header alone. A later SessionStart must invalidate previous runtime authority before any new decision; resume, fork, clear, and unknown starts require separate verification. This function does not persist authority or implement that invalidation. No installed hook calls it.

Sources: [session history and start source](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/core/src/session/session.rs), [metadata creation](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/rollout/src/recorder.rs).


## Initial turn boundary

A native fault test proves that an exception before resume invalidation leaves a saved session receipt usable. Codex continues to the next prompt after that hook failure. Do not use `freshRuntime` alone as persisted authority.

`initialRuntime` adds the first native turn from `readInitialSession` to fresh startup evidence. `initialOwnerPrompt` requires that session and turn to match the prompt. A saved receipt cannot authorize a resumed prompt with a different turn, even if invalidation fails. These functions still require native callback provenance and a trusted transcript directory. They do not authenticate arbitrary caller-supplied objects.

This boundary supports only initial-turn activation. Later prompts, child turns, restored in-flight turns, and full restart recovery require separate evidence. It is not full Sage session continuity. No installed hook calls these functions.
