# Root prompt classification

`ownerPrompt(input, {version, metadata})` recognizes the captured local Codex 0.160.0 root `UserPromptSubmit` path. It returns the root session, prompt turn and original text. It returns `null` for other events, child fields, unknown fields, unsupported versions, malformed input, or mismatched metadata.

The caller must receive input from the native hook, verify the running runtime, and read the first session metadata record from the hook's validated transcript path. Arbitrary JSON is not authenticated by this function. The metadata creation version cannot prove the current executable version. Keep this adapter disabled when the caller cannot establish that context.

The metadata must explicitly identify the root as both `id` and `session_id`. Parent or agent-path fields cause refusal, including null fields. Only the eight captured prompt fields are accepted. A future native field requires review before activation can use it.

Native fixtures distinguish the initial root prompt from child final reports and a Stop continuation. They do not prove every input API or resumed-session authority. This function is not a substitute for those checks.

The function does not interpret mode phrases, retain text, create ownership, reserve capacity, or release work. Shared phrase policy must decide whether owner text actually requests a mode change. Quotes and questions remain text here. Forwarded prompt text is limited to one MiB; the hook entry must also bound its input read. No installed hook calls this module yet.
