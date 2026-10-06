---
name: sage-help
description: "Help with sage: how to set it up, switch sage mode and autopilot, read the board, answer the chief's questions, pick a skill or a principle, fix a run that went wrong, and find where sage keeps its files. The user types /sage:sage-help (or /sage-help) with a question. Load it only when the user types it; do not load it on your own. Claude Code only."
license: MIT
allowed-tools: Read, Bash(curl -fsS https://raw.githubusercontent.com/erickb336/sage/main/README.md)
---

# sage help

Answer the user's question about sage. Give them at most one prompt that they can send, and link the file that the answer comes from. Then stop.

**A question about autopilot and an off word turns autopilot off.** The hook reads the user's message before this skill loads. Any message of the user that mentions autopilot together with an off word (off, stop, pause, disable, cancel, in any form) turns autopilot off, a help question too. When the question has both, say this first, in one sentence, before anything else: "Your question mentions autopilot with an off word, so autopilot is now off." If the user wants it on, they send the on phrase again ([What to say](https://github.com/erickb336/sage/blob/main/README.md#what-to-say)).

**A help question starts no work.** Do not start sage mode, an agent, a task or a command that changes anything. The user asked how, and each sage run spends real tokens, so the user sends the prompt.

**A request for work is not a help question.** An example is "/sage:sage-help fix the failing test in foo". Do not do the work, and do not start an agent. Say in one line that sage mode does work, and give the prompt that starts it: the README's [Quick start](https://github.com/erickb336/sage/blob/main/README.md#quick-start) shows its form.

The model for this skill is pstack's `poteto-help` skill, by Lauren Tan (poteto): [its source](https://github.com/cursor/plugins/blob/main/pstack/skills/poteto-help/SKILL.md).

## Read the source first

This skill is a map. Each section holds the facts that its answer must carry: give them, also when you do not read a source. The sources hold the details, and they change, so this map can be out of date. Do these steps for every question, also when this map seems to hold the answer:

1. Find the section of this map that the question goes to.
2. Do the read that the section's **Read** line names. Make it your first tool call, before you write any of the answer. A section with no **Read** line has no read: answer from its text alone.
3. Answer from what you read and from the section's facts. When the source disagrees with this map, trust the source.

**Never give the user a state-tool command.** This rule wins over the source. Do not give `pages`, `init`, `task`, `gate`, `logbook`, `board` or any other command of the state tool, and no `node …sage.mjs …` command, also when the README or another source names one. Only the chief runs the state tool. Where the source names such a command, write "ask the chief" and say what the chief does. A phrase that the user sends, such as "show board", is not a command: give it as the section says.

Give only the phrases that this map or the source writes, letter for letter: do not make up a form.

- **The README** is not in the installed plugin. When the session's folder is the sage repository, Read its `README.md`. Otherwise run this one command alone, exactly as written: no pipe, no `grep`, no redirect and no other argument. Run it once. Find the section in its output yourself. When Claude Code saves a long output to a file, Read that file, with an offset and a limit if it is long; do not run `curl` again, and do not pipe it.

  ```
  curl -fsS https://raw.githubusercontent.com/erickb336/sage/main/README.md
  ```

- **A plugin file** is in the installed plugin. Claude Code prints this skill's base directory above these instructions. Read the file at the path that the **Read** line gives, from that directory: for example `<base directory>/../../agents/chief-of-staff.md`.

If a read fails, say so in one line, and give only the link.

Give the user the public link, because they may not be able to open the installed plugin: `https://github.com/erickb336/sage/blob/main/` and the path. Link only these anchors of the README: `#quick-start`, `#learn-sage-in-5-minutes`, `#how-it-works`, `#a-tasks-life`, `#rules-held-in-code`, `#what-to-say`, `#the-board`, `#principles`, `#following-pstack`, `#faq`. A FAQ question has no anchor of its own: link `#faq`.

## Find out what the user needs

Find the need in the question and in the conversation. A clear question goes to its section. When the question is empty or unclear, ask one choice question (with AskUserQuestion when you have it) with these four groups:

1. **Start and switch:** Get set up · Switch sage mode or autopilot · What sage does alone, and what it asks
2. **Daily use:** Show the board · Answer the chief's questions · Pick a skill or a principle
3. **When something goes wrong:** Fix a run that went wrong
4. **Where things are:** Where sage keeps things

When the picked group has two or more sections, ask a second choice question with its sections as the options. A group with one section goes to it. Answer only the section that the user picks. Without AskUserQuestion, write the four groups as a numbered list, and ask the user to reply with a number.

## Get set up

**Read:** the README, sections "Quick start" and "FAQ".

Install the plugin, then start a new session: a session that is already open does not get the new skills and hooks. The [Quick start](https://github.com/erickb336/sage/blob/main/README.md#quick-start) has the install commands for the terminal and the desktop app, and how to update. The [FAQ](https://github.com/erickb336/sage/blob/main/README.md#faq) says which projects fit and what sage costs.

## Switch sage mode or autopilot

**Read:** the README, section "What to say".

sage mode makes the session the user's chief of staff. Autopilot lets verified pull requests merge without the user. Autopilot is off until the user turns it on. Each one switches on only at the start of the user's own message: "sage mode" (then a full stop, a comma, a colon or a line break) and "sage mode off" for the mode, and "autopilot on" for autopilot, which needs sage mode on. An off word with autopilot works anywhere in the user's message. The other forms and the exact rules are in [What to say](https://github.com/erickb336/sage/blob/main/README.md#what-to-say): link that table, and do not copy it.

## Show the board

**Read:** the README, section "The board".

The board is a short view of every project's logbook: what needs the user, the agents running now, and each active task. A message that starts with "show board" prints it for this project, "show board for all" for every project, and "show board for <project>" for one project. [The board](https://github.com/erickb336/sage/blob/main/README.md#the-board) gives the other forms and what each part shows. "status" in sage mode gives only the status lines of this session's project.

## Answer the chief's questions

**Read:** the README, section "Learn sage in 5 minutes" (step 3).

The chief asks at most once per task, in one batch of product questions. Each question has options, a recommendation and a default. The user picks an option on the choice card, or answers in their own words, and the chief records the answer as theirs. An open question also shows under "Needs you" on the board. [Learn sage in 5 minutes](https://github.com/erickb336/sage/blob/main/README.md#learn-sage-in-5-minutes) (step 3) gives the exceptions that can ask again.

## What sage does alone, and what it asks

**Read:** the README, section "FAQ" (the question "Is it safe to let it work alone?").

The chief decides the engineering choices, runs the team, and tells the user the results with evidence. The user decides the product questions. With autopilot on, a verified pull request merges after its clean cycles.

Every answer from this section carries these two facts, in these words:

- "The chief's instructions say that a deploy, deleting data, and closing a pull request that is not sage's always need your yes, also on autopilot. That rule is not yet held in code."
- "The hook refuses every force-push, also on autopilot."

This section answers a question; it has no prompt to send. Do not give one. Link these two sources and no other:

- [The chief's instructions](https://github.com/erickb336/sage/blob/main/plugins/sage/agents/chief-of-staff.md): what the chief always asks first, also on autopilot.
- [FAQ](https://github.com/erickb336/sage/blob/main/README.md#faq), the question "Is it safe to let it work alone?": what the hook holds, and that the rule above is not yet in code.

## Pick a skill or a principle

**Read:** the README, section "Principles", and the `SKILL.md` of the skill that you name, at `<base directory>/../<skill>/SKILL.md`.

sage mode is the default answer for real work: the chief runs the agents and the principles when the steps need them. Name a skill only when the user wants it alone. A plugin skill has the form `/sage:<skill>`.

| The user wants to | Skill |
| --- | --- |
| Get work done by a team of agents | sage mode ([Quick start](https://github.com/erickb336/sage/blob/main/README.md#quick-start)) |
| Follow, steer or start sessions from a phone | [`/sage:remote-control`](https://github.com/erickb336/sage/blob/main/plugins/sage/skills/remote-control/SKILL.md) |
| Write text that a person reads on the first pass | [`writing-standard`](https://github.com/erickb336/sage/blob/main/plugins/sage/skills/writing-standard/SKILL.md) |
| Use sage's approved words | [`dictionary`](https://github.com/erickb336/sage/blob/main/plugins/sage/skills/dictionary/SKILL.md) |
| Apply one working rule, such as "prove it works" | a `principle-<name>` skill ([Principles](https://github.com/erickb336/sage/blob/main/README.md#principles)) |
| Find their way around sage | `/sage:sage-help` |

For a skill that is not in this table, read its description in its `SKILL.md` and route by it. Two skills are for sage itself, not for the user: `sage` (the chief's state tool) and `report` (the end of each agent's run).

A hook gives each principle at the moment that it applies, so the user seldom loads one. To ask for one, the user names it in the request, for example "apply prove it works".

## Fix a run that went wrong

**Read:** the README, sections "What to say" and "A task's life".

| The user sees | What to do |
| --- | --- |
| A mode did not switch | The phrase must start the user's own message. A message sent while Claude works cannot start sage mode or autopilot, and cannot end sage mode; it can only stop autopilot. Send it again when Claude is idle. See the text under [What to say](https://github.com/erickb336/sage/blob/main/README.md#what-to-say). |
| Merges must stop now | Send a message that mentions autopilot with an off word. Pull requests then wait for the user. |
| The user wants a normal session again | Send the off phrase of sage mode ([What to say](https://github.com/erickb336/sage/blob/main/README.md#what-to-say)). |
| A task waits and nothing moves | Show the board: an open question under "Needs you" holds the task until the user answers. A task in the held state waits for the user: for an answer to a product question, or, after 3 repair rounds that did not make it clean, for the user to choose what comes next. The chief asks one question with options, a recommendation and a default; the user picks one or answers in their own words. A task in the replan state waits for a new plan. Link [the chief's instructions](https://github.com/erickb336/sage/blob/main/plugins/sage/agents/chief-of-staff.md), step 4 (an escalation when the tool says held or replan). |
| A pull request does not merge | A merge needs its clean cycles on the exact head commit. A new commit starts again from cycle 1 ([A task's life](https://github.com/erickb336/sage/blob/main/README.md#a-tasks-life)). Tell the chief what to do with it in your own words. |
| An agent must stop | There is no fixed phrase: the user tells the chief in their own words. Give this example as the prompt, letter for letter: "stop the run on T3" (the user replaces T3 with the task id). The agent's slot frees as soon as the agent ends, fails or is stopped ([Rules held in code](https://github.com/erickb336/sage/blob/main/README.md#rules-held-in-code)). |
| A new version of sage has no effect | Start a new session ([Quick start](https://github.com/erickb336/sage/blob/main/README.md#quick-start), "To update sage"). |

## Where sage keeps things

This section has no read: the README and the chief's instructions name state-tool commands here. Answer from this text alone. Give these paths, and no state-tool command (see the rule above).

- **The logbook** of each project, in `~/.claude/sage/<project>-<hash>/`: its tasks, runs, findings, verdicts, the user's answers and the decision trail.
- **The hook's state**, in `~/.claude/sage/.hooks/`: the modes, autopilot and the agent slots.
- **The pages folder** of each task, in `~/sage-worktrees/<project>-<hash>/pages/<task>/`, outside the logbook: research pages, designs and findings pages.

To see the exact folders, the user sends this prompt, in the form of the README's Quick start (replace T3 with the task id):

```
sage mode. Make the pages folder of T3, and print its path and the path of this project's logbook.
```

Link [How it works](https://github.com/erickb336/sage/blob/main/README.md#how-it-works): the paths are below the loop graphic.

## Close calls

- **The board or "status":** the board reads every project's logbook; "status" gives the lines of one project.
- **The off phrase of sage mode, or autopilot off:** autopilot off stops only the merges; the off phrase of sage mode ends the mode, and autopilot goes off with it.
- **Not in sage:** pstack's own modes, poteto mode, orchestrate and autopilot (sage mode replaces them; see [Following pstack](https://github.com/erickb336/sage/blob/main/README.md#following-pstack)). sage's own autopilot is a different thing: the switch above. sage does not run in Codex ([FAQ](https://github.com/erickb336/sage/blob/main/README.md#faq)).

## Reply

When the question mentions autopilot with an off word, the first sentence says that autopilot is now off. Then lead with the answer, in two to five sentences. Give at most one prompt that the user can send, in a code block, and none when the section says so. End with the public link of the file that the answer comes from. Write at 80% of Simplified Technical English, with sage's approved words. Keep it short unless the user asks for the whole map.
