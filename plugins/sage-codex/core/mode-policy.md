# Shared mode phrases

`modeSignals({owner, text, outside, all})` reads Sage's existing mode phrases. It returns five boolean signals: `sageOff`, `sageOn`, `autopilotOff`, `autopilotOn`, and `modeWord`. It does not change state, grant merge permission, or authenticate the prompt.

The provider establishes prompt origin first. `text` is the owner's candidate command text, `outside` includes text outside provider frames, and `all` is the whole prompt. With `owner: false`, no signal can enable a mode or disable Sage's gates. Untrusted text can still request that autopilot stop.

A caller applies Sage off before Sage on, then autopilot off before autopilot on. Autopilot on requires active Sage mode. Preserve state when no signal changes it. The Claude hook retains its existing transitions and notes through this API. If that hook cannot load the policy, it keeps the current Sage mode and turns autopilot off.

Codex must use verified owner input before calling this function. The native test combines `nativeOwnerPrompt`, these shared signals, and the direct-edit rule: the on phrase denies a chief patch, and an off phrase on resume permits a patch. A temporary fixture file carries the active value across resume, so the off check starts from active mode. This file is not a production mode store. The check does not prove production persistence, child inheritance, compaction recovery, or an installed automatic workflow. Automatic merging remains outside the Codex beta.
