# sage

Principles, a writing standard and **sage mode** for coding agents. **Claude Code** gets all of it. **Codex** gets the principles, the writing standard and the principle hooks: the parts that are verified there.

- **Principles.** 25 short working principles, kept up to date with [pstack](https://github.com/cursor/plugins/tree/main/pstack) by a weekly sync. 16 are my own versions; the other 9 are pstack's text as it is.
- **Hooks** give a principle to the agent at the moment it applies, and stop it once when it changed code and ran no check.
- **Sage mode.** Say "sage mode" in any Claude Code session, and the session becomes your chief of staff. It runs a team of specialist agents, asks you only the product questions, and shows you results, not code. There is no app: it works on your desktop, in a terminal, or from your phone through Remote Control.

> **Sage mode is early.** One dry run is done ([the report](docs/runs/dry-run-1.html)). A pilot on a real project comes next. The design is in [docs/design/sage-mode.html](docs/design/sage-mode.html).

## Install

**Claude Code:**

1. Add the plugin:
   ```
   /plugin marketplace add erickb336/sage
   /plugin install sage@sage
   ```
2. Clone this repository, for example to `~/sage`. Then add this line to `~/.claude/CLAUDE.md`, with the path to your clone, so the preferences and the writing standard apply to every session:
   ```
   @~/sage/instructions/core.md
   ```
3. Optional: to follow, steer and start sessions from the Claude app on your phone, run `/sage:remote-control`. See [Remote Control](#remote-control).

**Codex:**

1. Add the plugin:
   ```
   codex plugin marketplace add erickb336/sage
   codex plugin add sage@sage
   ```
2. Link the always-on file from your clone:
   ```
   ln -s ~/sage/instructions/core.md ~/.codex/AGENTS.md
   ```
3. Trust the hooks: in Codex, open `/hooks` and trust the sage hooks. Codex does not run a plugin's hooks until you trust them, and again after each update that changes them.

## Sage mode (Claude Code)

```
You ──request──▶ Chief of staff ──brief──▶ Design ─▶ Build ─▶ Review ─▶ QA ─▶ Pull request
     ◀─questions, results──┘    ◀──report + evidence───────────────────────┘      │
                     │                                            autopilot: merge after 2 clean cycles
                     └── a lesson comes back twice ──▶ improve the kitchen (test, lint, check, skill)
```

| Say | What happens |
| --- | --- |
| `sage mode` | The session becomes your chief of staff. |
| `sage mode off` | It is a normal session again. |
| `autopilot on` / `autopilot off` | A verified pull request merges by itself after 2 clean cycles, or waits for you. |
| `arena` or `arena 4` | N agents on a mix of Claude models design the next thing; a judge scores them and grafts the best parts into one. |

- **The team:** a chief of staff that never edits files, a PE, a designer, implementers, code, security and UX reviewers, QA and an arena judge (`plugins/sage/agents/`).
- **Routes sized to the task:** a tiny fix gets a build and its checks; a large feature gets a design, a PE check, your approval, the build, three reviews and QA.
- **Rules in code, not only in prompts.** The sage hook and the state tool hold them:
  - The chief never edits files, and every brief and report has all its fields.
  - At most 3 sage agents run at once.
  - Nobody force-pushes or pushes to main.
  - Every finding is triaged. A repair round needs a medium or high finding, and repairs are bounded.
  - A merge needs the checked head SHA, with its clean cycles in the ledger.
- **State in files:** `~/.claude/sage/<project>-<hash>/` holds the tasks, runs, findings, the verdict ledger, your questions and the decision trail. Any session can pick up the work.

To make every session in a folder start as the chief of staff, put this in the folder's `.claude/settings.json`:

```json
{ "agent": "sage:chief-of-staff" }
```

## Principles and hooks

A skill works only when the agent decides to load it, and agents seldom do. So the plugin also has hooks. A hook runs at a fixed moment, and the agent does not choose it. The same principle hook works in Claude Code and in Codex. It adds each principle once per session.

| Moment | Principles |
| --- | --- |
| The request asks for a design, a plan or a new feature | exhaust-the-design-space, experience-first, foundational-thinking |
| The request asks for a refactor or a cleanup | subtract-before-you-add, laziness-protocol, migrate-callers-then-delete-legacy-apis |
| The agent is about to change a test file | test-behavior-not-implementation |
| The agent is about to write a document (`.md`, `.txt`) | contextualize-and-write-for-the-reader |
| The agent is about to commit | sequence-verifiable-units |
| A check fails (a test, a build, a type check or a lint) | fix-root-causes |
| Two changes in a row do not make the same check pass | attack-the-premise |

The hook also has **one gate**. When the agent tries to finish, the code changed in this turn, and no check ran after the change, the hook stops the agent once and gives it prove-it-works. The agent must run a check or say what it did not verify.

The other principles stay on the skill list, and sage's agents load the ones their role needs. The writing standard is always on through `core.md`.

**Limits.** The hook finds a request by its words, so it can miss one. The gate works only in a git repository. Codex does not give hooks the exit code, so in Codex the hook finds a failed check from the failure lines that common test tools print. To turn the principle hooks off for a session, set `AGENT_KIT_HOOKS=off` (the name stays from the kit's first name, agent-kit; Orchestrator uses it for its workers).

## Following pstack

pstack changes often, so you don't follow it by hand:

1. `upstream/pstack/` holds pstack's principles and its MIT licence, at the commit in `upstream/pstack.json`.
2. The build takes each pstack principle as it is, unless `principles/` has an override with the same id. An override records the fingerprint of the pstack text it was reviewed against (`upstream:`).
3. Every Monday, a workflow runs `npm run sync`, rebuilds, and runs the checks and tests. The update merges by itself, unless pstack changed a principle that you override. Then its pull request waits for you, with the change listed.

Only principles come in for now. pstack's modes (poteto mode, orchestrate, autopilot) stay out, because sage mode is the orchestration layer here. Each other pstack skill comes in only when it works in Claude Code and has a test.

## Remote Control (Claude Code)

| Command | What it does |
| --- | --- |
| `/sage:remote-control` | Turns Remote Control on for every new session. |
| `/sage:remote-control off` / `status` | Turns it off, or shows the setting. |
| `/sage:remote-control server ~/workspace` | Runs a Remote Control server in `~/workspace`, now and at each login (macOS). From the phone, you can then start sessions that open in that folder. |
| `/sage:remote-control server off` / `status` | Stops the server and removes its login item, or shows whether the phone can see it ("Ready"). |

The skill cannot change the desktop app. There, turn on **Settings → Claude Code → Connect new sessions to Remote Control** once. Before the first `server`, do three things once, in the macOS Terminal app:

1. Run `claude auth login`. A `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` does not work for Remote Control. If your `~/.zshrc` sets it, run step 3 as `env -u CLAUDE_CODE_OAUTH_TOKEN claude remote-control`.
2. Run `claude` in the server's folder, and answer Yes to the trust question.
3. Run `claude remote-control` in the same folder, answer `y` to "Enable Remote Control?", then press Ctrl+C.

While the server runs, your claude.ai account can start sessions on your computer, and they can reach everything in the folder.

## What is where

| Path | What it is |
| --- | --- |
| `principles/` | Your principles: your own, and your overrides of pstack's. |
| `upstream/pstack/` | pstack's principles, kept up to date by the sync. |
| `writing/ste-80.md` | The writing standard: about 80% of ASD-STE100, Simplified Technical English. |
| `preferences/` | How I work with agents. |
| `plugins/sage/skills/` | The skills: one per principle (generated), the writing standard (generated), `remote-control`, and sage mode's `sage` (the state tool) and `report`. |
| `plugins/sage/agents/` | Sage mode's team (Claude Code only). |
| `plugins/sage/hooks/` | `hooks.json`: the principle hooks, for both tools. `claude.json`: the sage mode hook, for Claude Code only. |
| `instructions/core.md` | The always-on file: the preferences and the writing standard (generated). |
| `docs/` | The design of sage mode and the dry run reports. |

## Change it

1. Edit a source in `principles/`, `writing/` or `preferences/`, or an agent in `plugins/sage/agents/`. To override a pstack principle, add `principles/<id>.md` with `source: pstack principle-<id>` and its `upstream:` fingerprint.
2. Run `npm run build`, then `npm run check` and `npm test`. CI runs the check and the tests.
3. For Codex to pick up the change, increase `version` in `plugins/sage/.codex-plugin/plugin.json`.

## Thanks

Thank you to [Lauren Tan (poteto)](https://github.com/poteto) for [pstack](https://github.com/cursor/plugins/tree/main/pstack) and poteto mode. Its principles inspired this kit, and sage mode takes many of its ideas: the coordinator that never writes code, the brief, the ledger by head SHA, the arena, and the trust ladder. Sage mode also takes the lessons of my [Orchestrator](https://github.com/erickb336/orchestrator).

## Licence

MIT. pstack's text keeps pstack's MIT licence: see [upstream/pstack/LICENSE](upstream/pstack/LICENSE) and [principles/LICENSE-pstack](principles/LICENSE-pstack).
