# agent-kit

Principles, a writing standard, working preferences and skills for coding agents. One repository gives them to **Claude Code** and **Codex**.

## What it holds

| Folder | What it is |
| --- | --- |
| `principles/` | 16 short working principles. Fifteen are adapted from [pstack](https://github.com/cursor/plugins/tree/main/pstack) (MIT). |
| `writing/ste-80.md` | A writing standard: about 80% of ASD-STE100, Simplified Technical English. |
| `preferences/` | How I work with agents. |
| `plugins/agent-kit/skills/` | The skills both tools load: one for each principle, one for the writing standard, and my own skills. |
| `instructions/core.md` | The always-on file: the preferences and the writing standard. |

The files in `principles/`, `writing/` and `preferences/` are the sources. The skills and `core.md` are generated from them.

## Install

**Claude Code:**

1. Add the plugin:
   ```
   /plugin marketplace add erickb336/agent-kit
   /plugin install agent-kit@agent-kit
   ```
2. Clone this repository. Then add this line to `~/.claude/CLAUDE.md`, so the preferences and the writing standard apply to every session:
   ```
   @~/agent-kit/instructions/core.md
   ```

**Codex:**

1. Add the plugin:
   ```
   codex plugin marketplace add erickb336/agent-kit
   codex plugin add agent-kit@agent-kit
   ```
2. Clone this repository. Then link the always-on file:
   ```
   ln -s ~/agent-kit/instructions/core.md ~/.codex/AGENTS.md
   ```

## Change it

1. Edit a source file in `principles/`, `writing/` or `preferences/`. Or add your own skill as `plugins/agent-kit/skills/<name>/SKILL.md`.
2. Run `npm run build`, then `npm run check`.
3. For Codex to pick up the change, increase `version` in `plugins/agent-kit/.codex-plugin/plugin.json`.

A skill uses the shared format both tools read ([agentskills.io](https://agentskills.io/specification)):
- `name` is the folder name: lowercase words joined by hyphens.
- `description` says when to use the skill.

## Licence

MIT. The adapted principles keep pstack's MIT licence: see [principles/LICENSE-pstack](principles/LICENSE-pstack).
