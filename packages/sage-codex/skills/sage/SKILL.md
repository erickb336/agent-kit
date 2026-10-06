---
name: sage
description: "Use Sage's manual task logbook and board in Codex. Apply when the user asks to track tasks, record findings or view progress. Agent orchestration and autopilot are not available."
license: MIT
---

# Sage for Codex

Use the principle and writing skills in this plugin. The hooks add advice when a request asks for a design or a refactor, when a patch changes a test or document, and before a commit.

This version supports a **manual logbook**. It does not run the Sage chief, enforce agent limits, collect reports, block merges or run autopilot. Do not claim these rules are enforced. If the user asks for Sage mode, explain this limit before offering the manual commands. Use Codex's selected model; do not translate model names from another provider.

Run the state tool beside this skill. Resolve `sage.mjs` from this skill's directory, then use its full path:

```sh
node <skill-directory>/sage.mjs init --project <project>
node <skill-directory>/sage.mjs task add --title "Describe the task" --size small --project <project>
node <skill-directory>/sage.mjs status --project <project>
node <skill-directory>/sage.mjs board this --project <project>
```

Run the command without arguments for its command list. The logbook lives below `$CODEX_HOME/sage`, or `~/.codex/sage` when `CODEX_HOME` is unset. `SAGE_HOME` overrides that path. Keep the default separate from other providers; share a logbook only when the user asks. All changes to a logbook must use this tool.

The hooks do not infer check results from shell output. Run the checks that fit the change and report the command, result and anything left unverified. The plugin does not stop an unchecked turn.
