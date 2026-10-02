# agent-kit

Principles, a writing standard, working preferences and skills for coding agents. One repository gives them to **Claude Code** and **Codex**.

## What it holds

| Folder | What it is |
| --- | --- |
| `principles/` | 16 short working principles. Fifteen are adapted from [pstack](https://github.com/cursor/plugins/tree/main/pstack) (MIT). |
| `writing/ste-80.md` | A writing standard: about 80% of ASD-STE100, Simplified Technical English. |
| `preferences/` | How I work with agents. |
| `plugins/agent-kit/skills/` | The skills both tools load: one for each principle, one for the writing standard, and my own skills. |
| `plugins/agent-kit/hooks/` | The hooks: they give a principle to the agent when it applies (see [Hooks](#hooks)). |
| `instructions/core.md` | The always-on file: the preferences and the writing standard. |

The files in `principles/`, `writing/` and `preferences/` are the sources. The skills and `core.md` are generated from them.

## Install

**Claude Code:**

1. Add the plugin:
   ```
   /plugin marketplace add erickb336/agent-kit
   /plugin install agent-kit@agent-kit
   ```
2. Clone this repository, for example to `~/agent-kit`. Then add this line to `~/.claude/CLAUDE.md`, with the path to your clone, so the preferences and the writing standard apply to every session:
   ```
   @~/agent-kit/instructions/core.md
   ```

**Codex:**

1. Add the plugin:
   ```
   codex plugin marketplace add erickb336/agent-kit
   codex plugin add agent-kit@agent-kit
   ```
2. Link the always-on file from your clone:
   ```
   ln -s ~/agent-kit/instructions/core.md ~/.codex/AGENTS.md
   ```
3. Trust the hooks: in Codex, open `/hooks` and trust the agent-kit hooks. Codex does not run a plugin's hooks until you trust them. Trust them again after each update that changes them.

## Hooks

A skill works only when the agent decides to load it, and agents seldom do. So the plugin also has hooks. A hook runs at a fixed moment, and the agent does not choose it. The same hook works in Claude Code and in Codex.

The hook adds a principle's text to the agent's context at the moment the principle applies. It adds each principle once per session.

| Moment | Principles |
| --- | --- |
| The request asks for a design, a plan or a new feature | exhaust-the-design-space, experience-first, foundational-thinking |
| The request asks for a refactor or a cleanup | subtract-before-you-add, laziness-protocol, migrate-callers-then-delete-legacy-apis |
| The agent is about to change a test file | test-behavior-not-implementation |
| The agent is about to write a document (`.md`, `.txt`) | contextualize-and-write-for-the-reader |
| The agent is about to commit | sequence-verifiable-units |
| A check fails (a test, a build, a type check or a lint) | fix-root-causes |
| Two changes in a row do not make the same check pass | attack-the-premise |

The hook also has **one gate**. When the agent tries to finish, the code changed in this turn, and no check ran after the change, the hook stops the agent once and gives it prove-it-works. The agent must run a check or say what it did not verify. The second time, the agent can finish.

The other principles have no moment that a hook can see. They stay on the skill list. The writing standard is always on through `core.md`.

**Limits**

- The hook finds a request by its words, so it can miss a request or add a principle when it is not needed.
- The gate works only in a git repository. It counts a test, build, type check or lint command, or a look in a browser or simulator, as a check.
- Codex does not give hooks the exit code. In Codex, the hook finds a failed check from the failure lines that common test tools print.

To turn the hooks off for a session, set `AGENT_KIT_HOOKS=off`. Orchestrator does this for its workers, because it gives each step its principles itself.

## Change it

1. Edit a source file in `principles/`, `writing/` or `preferences/`. Or add your own skill as `plugins/agent-kit/skills/<name>/SKILL.md`. To give a principle at a new moment, edit `MOMENTS` in `plugins/agent-kit/hooks/principles-hook.mjs`.
2. Run `npm run build`, then `npm run check` and `npm test`.
3. For Codex to pick up the change, increase `version` in `plugins/agent-kit/.codex-plugin/plugin.json`.

A skill uses the shared format both tools read ([agentskills.io](https://agentskills.io/specification)):
- `name` is the folder name: lowercase words joined by hyphens.
- `description` says when to use the skill.

## Thanks

Thank you to [Lauren Tan (poteto)](https://github.com/poteto) for [pstack](https://github.com/cursor/plugins/tree/main/pstack). Its principles inspired this kit. I loved them and adopted them the day I found them. Fifteen of the principles here are adapted from pstack, with credit in each file.

## Licence

MIT. The adapted principles keep pstack's MIT licence: see [principles/LICENSE-pstack](principles/LICENSE-pstack).
