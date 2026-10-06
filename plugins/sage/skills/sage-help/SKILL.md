---
name: sage-help
description: "Help with sage: how to set it up, switch sage mode and autopilot, read the board, answer the chief's questions, pick a skill or a principle, fix a run that went wrong, and find where sage keeps its files. The user types /sage-help with a question. Load it only when the user types /sage-help; do not load it on your own. Claude Code only."
license: MIT
allowed-tools: Read, Bash(curl -fsS https://raw.githubusercontent.com/erickb336/sage/main/*)
---

# sage help

Answer the user's question about sage. Give them one prompt that they can send, and link the file that the answer comes from. Then stop.

**A help question starts no work.** Do not start sage mode, an agent, a task or a command that changes anything. The user asked how, and each sage run spends real tokens, so the user sends the prompt.

**A request for work is not a help question.** An example is "/sage-help fix the failing test in foo". Do not do the work, and do not start an agent. Say in one line that sage mode does work, and give the prompt that starts it: the README's [Quick start](https://github.com/erickb336/sage/blob/main/README.md#quick-start) shows its form.

The model for this skill is pstack's `poteto-help` skill, by Lauren Tan (poteto): [its source](https://github.com/cursor/plugins/blob/main/pstack/skills/poteto-help/SKILL.md).

## The files own the answers

This skill is a map. The files below hold the details, and they change. Before you answer, read the section that this map links, and when it disagrees with this map, trust it. Give only the phrases that this map or that section writes, letter for letter: do not make up a form.

- **The README** is not in the installed plugin. Read the copy in the session's folder when it is the sage repository. Otherwise get the public copy: `curl -fsS https://raw.githubusercontent.com/erickb336/sage/main/README.md`.
- **The agents and skills** are in the installed plugin: `${CLAUDE_SKILL_DIR}/../<skill>/SKILL.md` and `${CLAUDE_SKILL_DIR}/../../agents/<agent>.md`.

Give the user the public link, because they may not be able to open the installed plugin: `https://github.com/erickb336/sage/blob/main/` and the path, with the README's section anchor.

## Find out what the user needs

Find the need in the question and in the conversation. A clear question goes to its section. When the question is empty or unclear, ask one multiple-choice question (with AskUserQuestion when you have it) with these options, and answer only the section that the user picks:

1. Get set up
2. Switch sage mode or autopilot
3. Show the board
4. Answer the chief's questions
5. What sage does alone, and what it asks
6. Pick a skill or a principle
7. Fix a run that went wrong
8. Where sage keeps things

## Get set up

Install the plugin, then start a new session: a session that is already open does not get the new skills and hooks. The [Quick start](https://github.com/erickb336/sage/blob/main/README.md#quick-start) has the install commands for the terminal and the desktop app, and how to update. The [FAQ](https://github.com/erickb336/sage/blob/main/README.md#faq) says which projects fit and what sage costs.

## Switch sage mode or autopilot

sage mode makes the session the user's chief of staff. Autopilot lets verified pull requests merge without the user. Autopilot is off until the user turns it on. Each one switches only on a phrase at the start of the user's own message: "sage mode" (then a full stop, a comma, a colon or a line break) and "sage mode off" for the mode, and "autopilot on" for autopilot, which needs sage mode on. The other forms and the exact rules are in [What to say](https://github.com/erickb336/sage/blob/main/README.md#what-to-say): link that table, and do not copy it.

Tell the user about one effect. A message that mentions autopilot together with an off word turns autopilot off, wherever the words are in the message. That includes a /sage-help question about how to turn it off.

## Show the board

The board is a short view of every project's logbook: what needs the user, the agents running now, and each active task. A message that starts with "show board" prints it for this project, "show board for all" for every project, and "show board for <project>" for one project. [The board](https://github.com/erickb336/sage/blob/main/README.md#the-board) gives the other forms and what each part shows. "status" in sage mode gives only the status lines of this session's project.

## Answer the chief's questions

The chief asks at most once per task, in one batch of product questions. Each question has options, a recommendation and a default. The user picks an option on the choice card, or answers in their own words, and the chief records the answer as theirs. An open question also shows under "Needs you" on the board. [Learn sage in 5 minutes](https://github.com/erickb336/sage/blob/main/README.md#learn-sage-in-5-minutes) (step 3) gives the exceptions that can ask again.

## What sage does alone, and what it asks

The chief decides the engineering choices, runs the team, and tells the user the results with evidence. The user decides the product questions. An irreversible action always gets its own yes, also on autopilot: for example a deploy or deleting data. With autopilot on, a verified pull request merges after its clean cycles. The sources:

- [Rules held in code](https://github.com/erickb336/sage/blob/main/README.md#rules-held-in-code): the rules that the hook and the state tool enforce, and their limits.
- [The chief's instructions](https://github.com/erickb336/sage/blob/main/plugins/sage/agents/chief-of-staff.md): what the chief always asks first.
- [A task's life](https://github.com/erickb336/sage/blob/main/README.md#a-tasks-life): the states and the clean cycles before a merge.

## Pick a skill or a principle

sage mode is the default answer for real work: the chief runs the agents and the principles when the steps need them. Name a skill only when the user wants it alone.

| The user wants to | Skill |
| --- | --- |
| Get work done by a team of agents | sage mode ([Quick start](https://github.com/erickb336/sage/blob/main/README.md#quick-start)) |
| Follow, steer or start sessions from a phone | [`/sage:remote-control`](https://github.com/erickb336/sage/blob/main/plugins/sage/skills/remote-control/SKILL.md) |
| Write text that a person reads on the first pass | [`writing-standard`](https://github.com/erickb336/sage/blob/main/plugins/sage/skills/writing-standard/SKILL.md) |
| Use sage's approved words | [`dictionary`](https://github.com/erickb336/sage/blob/main/plugins/sage/skills/dictionary/SKILL.md) |
| Apply one working rule, such as "prove it works" | a `principle-<name>` skill ([Principles](https://github.com/erickb336/sage/blob/main/README.md#principles)) |
| Find their way around sage | `/sage-help` |

For a skill that is not in this table, read its description in its `SKILL.md` and route by it. Two skills are for sage itself, not for the user: `sage` (the chief's state tool) and `report` (the end of each agent's run).

A hook gives each principle at the moment that it applies, so the user seldom loads one. To ask for one, the user names it in the request, for example "apply prove it works".

## Fix a run that went wrong

| The user sees | What to do |
| --- | --- |
| A mode did not switch | The phrase must start the user's own message, and a message sent while Claude works cannot switch a mode on. See the text under [What to say](https://github.com/erickb336/sage/blob/main/README.md#what-to-say). |
| Merges must stop now | Send a message that mentions autopilot with an off word. Pull requests then wait for the user. |
| The user wants a normal session again | Send the off phrase of sage mode ([What to say](https://github.com/erickb336/sage/blob/main/README.md#what-to-say)). |
| A task waits and nothing moves | Show the board: an open question under "Needs you" holds the task until the user answers. A task in the held state waits for a new plan ([A task's life](https://github.com/erickb336/sage/blob/main/README.md#a-tasks-life)). |
| A pull request does not merge | A merge needs its clean cycles on the exact head commit. A new commit starts again from cycle 1 ([A task's life](https://github.com/erickb336/sage/blob/main/README.md#a-tasks-life)). Tell the chief what to do with it in your own words. |
| An agent must stop | Tell the chief in your own words, for example "stop the run on T3". The chief stops it and records it. |
| A new version of sage has no effect | Start a new session ([Quick start](https://github.com/erickb336/sage/blob/main/README.md#quick-start), "To update sage"). |

## Where sage keeps things

- **The logbook** of each project: its tasks, runs, findings, verdicts, the user's answers and the decision trail.
- **The hook's state**: the modes, autopilot and the agent slots.
- **The pages folder** of each task: research pages, designs and findings pages, outside the logbook.

The paths are in [How it works](https://github.com/erickb336/sage/blob/main/README.md#how-it-works), below the loop graphic. The state tool's `pages` command is in [its skill](https://github.com/erickb336/sage/blob/main/plugins/sage/skills/sage/SKILL.md).

## Close calls

- **The board or "status":** the board reads every project's logbook; "status" gives the lines of one project.
- **The off phrase of sage mode, or autopilot off:** autopilot off stops only the merges; the off phrase of sage mode ends the mode, and autopilot goes off with it.
- **Not in sage:** pstack's poteto mode and its playbooks (sage mode replaces them; see [Following pstack](https://github.com/erickb336/sage/blob/main/README.md#following-pstack)). sage does not run in Codex ([FAQ](https://github.com/erickb336/sage/blob/main/README.md#faq)).

## Reply

Lead with the answer, in two to five sentences. Give at most one prompt that the user can send, in a code block. End with the public link of the file that the answer comes from. Write at 80% of Simplified Technical English, with sage's approved words. Keep it short unless the user asks for the whole map.
