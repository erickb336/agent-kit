<a href="docs/assets/hero-light.svg">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/hero-dark.svg">
  <img alt="sage: your chief of staff for Claude Code. Start a message with “sage mode”. A hooded toad sage with glowing gold eyes, the chief of staff, meditates in front of a big moon in a misty mountain world. Around it, its team on an arrowed loop: designer, PE, implementer, arena judge, code reviewer, security reviewer, UX reviewer and QA." src="docs/assets/hero-light.svg" width="100%">
</picture>
</a>

<p align="center">
  <a href="https://github.com/erickb336/sage/actions/workflows/check.yml"><img alt="checks" src="https://github.com/erickb336/sage/actions/workflows/check.yml/badge.svg"></a>
  <img alt="Claude Code plugin" src="https://img.shields.io/badge/Claude%20Code-plugin-E5600B">
  <img alt="MIT licence" src="https://img.shields.io/badge/licence-MIT-21160F">
</p>

**sage is a Claude Code plugin that turns any session into your chief of staff.** Start a message with "sage mode", say what you want, and a team of specialist agents designs, builds, reviews and proves the work. You answer only the product questions, and you look at results, not code.

It also gives every session 25 short working principles at the moment they apply.

> **Built on [pstack](https://github.com/cursor/plugins/tree/main/pstack) by [Lauren Tan (poteto)](https://github.com/poteto).** sage follows pstack's principles by itself, every week, and sage mode takes its ideas from poteto mode. The name is a nod to Sage Mode in *Naruto*. See [Credits](#credits).

**Contents:** [Why "sage"?](#why-sage) · [Quick start](#quick-start) · [Learn sage in 5 minutes](#learn-sage-in-5-minutes) · [How it works](#how-it-works) · [Concepts](#concepts) · [What to say](#what-to-say) · [Principles](#principles) · [Following pstack](#following-pstack) · [Remote Control](#remote-control) · [FAQ](#faq) · [Under the hood](#under-the-hood) · [Credits](#credits)

## Why "sage"?

In *Naruto*, a sage stays still to gather natural energy. In Sage Mode, the sage sees and senses more than in normal combat.

sage mode works the same way:

- **The chief of staff stays still.** It never edits a file. It frames the work, writes the briefs and keeps the record.
- **It gathers natural energy.** Here, that energy is the team's work: specialists work in parallel, each in its own git worktree.
- **It sees the whole.** It groups related work, puts tasks that share code in order, and gives a mistake that repeats a lasting fix.

The idea of a mode that you switch on by name comes from pstack's **poteto mode**.

And the toad? In the story, toads teach Sage Mode. So sage's mascot is a toad sage: an original drawing of a hooded toad that meditates while its team works.

## Quick start

**1. Install** (in a Claude Code terminal):

```
/plugin marketplace add erickb336/sage
/plugin install sage@sage
```

In the desktop app, run `claude plugin marketplace add erickb336/sage` and then `claude plugin install sage@sage` in a terminal. The `/plugin` dialog opens only in a terminal.

**To update sage**, run `claude plugin update sage@sage`. The update applies to every running session at its next event: each hook event runs the newest installed sage. This holds for sessions that started on this version of sage or a later one. A new hook event or matcher needs a restart, and so do the instructions that a session already read (its skills and agent texts).

**2. Start a new session** in a project folder, or in a folder of projects such as `~/workspace`.

**3. Switch it on:** start a message with "sage mode", then say what you want.

```
sage mode. Ramen Finder: add a favourites list, and fix this week's crash.
```

<a href="docs/assets/tip-start-light.svg">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/tip-start-dark.svg">
  <img alt="The toad sage's tip: start a message with “sage mode” to switch it on, and with “sage mode off” to switch it off. In the middle of a sentence, it does nothing." src="docs/assets/tip-start-light.svg" width="100%">
</picture>
</a>

That's all. The chief of staff interrupts you at most once per task: one batch of product questions, each with its recommendation and a default. Irreversible actions still get their own yes. Then the chief comes back with results and pull requests. From your phone, it works the same through [Remote Control](#remote-control).

## Learn sage in 5 minutes

This is one session, step by step. It is an illustration with sample data.

<a href="docs/assets/walkthrough-light.svg">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/walkthrough-dark.svg">
  <img alt="Learn sage in 5 minutes: an illustrative sage mode session about a made-up app, Ramen Finder, with sample data. You: “sage mode. Ramen Finder: add a favourites list, and fix this week's crash.” The chief frames T1, favourites, as large with the data flag, and T2, the crash, as small with the input flag, and starts T2. It asks one question for T1: sync favourites across devices? Recommended, and the default if you don't answer: not now. You answer “not now”. T2 goes through build, code review, security review and QA; repair round 1 fixes an empty search that still crashed. T2 is verified: QA ran the app and passed. Not checked: the tablet layout. Pull request #41 is ready for you. Five numbered notes match the steps below." src="docs/assets/walkthrough-light.svg" width="100%">
</picture>
</a>

1. **Switch it on.** Start a message with "sage mode", then your request. sage mode stays on until you start a message with "sage mode off".
2. **The chief frames each task.** It gives each task a size (tiny, small, large or investigate) and risk flags, such as `data` for personal data or `input` for outside input. The size and the flags give the task its [route](#routes): the steps it must go through.
3. **One batch of questions, at most.** The chief interrupts you at most once per task. It puts all the product questions of the task in that one batch, and each part comes with a recommendation and a default. A product question is one whose answer you would notice: what you see, which data is kept, who can do what. Four exceptions can interrupt you again:
   - An irreversible action always gets its own yes.
   - A new fact that changes an earlier answer can bring the question back.
   - A large task's design gets your approval after the PE check.
   - An escalation: the work finds something that the chief cannot decide alone. For example:
     - The task is held or needs a new plan.
     - An agent stops at a new product question.
     - A finding needs a decision.
     - The arena candidates do not converge.

   Engineering choices, such as file formats and names, are the chief's. It decides them and logs them.
4. **The team works.** For each step, the chief starts a fresh agent with a full brief. Reviews and QA report findings. A medium or high finding goes back to an implementer for a repair, at most 3 rounds. After a repair, only the roles that found the problems re-check the repair's diff. A new medium or low finding from a round goes to a follow-up task; a high one blocks. Then the task needs its clean cycles on the final commit: 1 for a tiny or small task, 2 for a large task or a task with a risk flag.
5. **You get results.** You get evidence (the commands that ran, screenshots), what was not checked, and a pull request. You merge it, or autopilot merges it.

**Try it yourself.** Pick one small, real bug in a project that has tests and a GitHub remote. Start a session from your phone, start your message with "sage mode", and describe the bug. Then look at the result, not the code.

<a href="docs/assets/tip-try-light.svg">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/tip-try-dark.svg">
  <img alt="The toad sage's tip: try it on one small, real bug, from your phone. Then look at the result, not the code." src="docs/assets/tip-try-light.svg" width="100%">
</picture>
</a>

## How it works

<a href="docs/assets/loop-light.svg">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/loop-dark.svg">
  <img alt="How sage works: you, the chief of staff, the team (design, build, review, QA), the pull request, the logbook, and the outer loop that seals each lesson." src="docs/assets/loop-light.svg" width="100%">
</picture>
</a>

There are two loops:

- **The inner loop** turns a request into verified work. The chief briefs the team. The team designs, builds, reviews and tests. Findings go back to the build. A clean result becomes a pull request.
- **The outer loop** [seals the lesson](#concepts): it gives a mistake that comes back twice a lasting fix, from the most enforced kind down: a test or a check in code first; a principle or a standing order only when code cannot hold it. Each sealed lesson makes [the dojo](#concepts) stronger. The dojo is everything that makes the agents good: the principles, checks, tests and skills.

<a href="docs/assets/tip-seal-light.svg">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/tip-seal-dark.svg">
  <img alt="The toad sage's tip: seal the lesson. Give a mistake that comes back twice a lasting fix: a test or a check in code first; a principle or a standing order only when code cannot hold it. That is how the dojo gets stronger." src="docs/assets/tip-seal-light.svg" width="100%">
</picture>
</a>

The state lives in the logbook: plain files in `~/.claude/sage/<project>-<hash>/`. It holds the tasks, the agent runs, the findings, the verdicts, your answers and the decision trail. So you can leave and come back from another device, and a new session continues the work. Two more folders hold the rest: the hook keeps the mode, autopilot and the agent slots in `~/.claude/sage/.hooks/`, and agents save their pages (research, designs) in `~/sage-worktrees/<project>-<hash>/pages/<task>/`, outside the logbook (`sage pages <task>` makes and prints the folder).

### The team

| Agent | What it does | Changes files? |
| --- | --- | --- |
| **Chief of staff** | Frames the work, picks routes, writes briefs, records results, asks you the questions | No |
| **Designer** | A clickable prototype with sample data, and every state of each screen | Yes, in its own worktree |
| **PE** (principal engineer) | Checks a plan or a design before the build: feasibility, data, risks, cost | No |
| **Implementer** | Builds one task, runs the checks, opens the pull request, repairs findings | Yes, in its own worktree |
| **Code reviewer** | Correctness, data safety, regressions, test evidence | No |
| **Security reviewer** | Input at the boundaries, injection, secrets, access | No |
| **UX reviewer** | The flow, the states, the copy and accessibility | No |
| **QA** | Runs the checks and the real app, and tries to break it | No |
| **Arena judge** | Scores an arena's candidates and grafts the best parts into one | Yes, the final version |

Only one agent writes on a branch at a time. Reviewers start fresh, so they don't share the builder's blind spots.

### Routes

Each task gets the least route for its size. The chief can add steps, never remove these.

<a href="docs/assets/routes-light.svg">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/routes-dark.svg">
  <img alt="Routes by size. Tiny: build. Small: build, code review, QA. Large: design, PE check, you approve, build, code review, security review, UX review, QA. Investigate: gather evidence, evidence review, a proposal to you. A risk flag adds the security review to every size except investigate, which changes no code." src="docs/assets/routes-light.svg" width="100%">
</picture>
</a>

### A task's life

<a href="docs/assets/lifecycle-light.svg">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/lifecycle-dark.svg">
  <img alt="A task's states: framed, briefed, building, reviewing, verifying, verified, merged. A product question moves a building task to held until your answer. Findings to fix, or a QA fail, move it from verifying to repairing, and the next round goes back to reviewing, at most 3 rounds. Verified needs 1 clean cycle; autopilot merges after 1 for a tiny or small task, 2 for a large or risky one." src="docs/assets/lifecycle-light.svg" width="100%">
</picture>
</a>

A **cycle** is one full set of fresh reviews and QA on one commit. A task is **verified** after 1 clean cycle. With autopilot on, it **merges** after its clean cycles on the same commit: 1 for a tiny or small task, 2 for a large task or any task with a risk flag.

### Rules held in code

A rule written only in a prompt fades over a long session. So sage keeps its important rules in code: a hook that checks each action, and a state tool that refuses a wrong move.

| Rule | Why |
| --- | --- |
| The chief of staff never edits a file. | It keeps the big picture; the team does the details. |
| Every brief has all its fields; every report has its evidence. | A vague brief fails quietly. A claim without evidence is not a result. |
| At most 3 sage agents run at once for a project (`max_agents`; `config cap.<project>=n` sets one project's own cap), and at most 12 across all projects (`cap_total`). A slot frees as soon as its agent ends, fails or is stopped. | Cost and focus. Several sessions share the total. |
| One writer per branch. Nobody force-pushes or pushes to main. A push is only `git push [-u] origin <branch>`, with the branch's own name. | Parallel writers conflict. Work reaches main only through a pull request. |
| An agent never runs `git stash`, in any form. To test old code, it uses `git worktree add --detach <scratch> <sha>` or `git show <sha>:<path>`. | Every worktree of a repo shares one stash list, so another agent can pop or drop the work. |
| An agent never lists or signals the real processes (`ps`, `pgrep`, `pkill`, `kill`, `killall`, `lsof`, `top`, `htop`, `fuser`, `pidof`, and `kill-port` or `fkill` through `npx`, `npm exec`, `pnpm dlx` or `bunx`). Such a program passes only as a fake in the temp folder, found through PATH and links. A bare `kill` is the shell's builtin, so it never passes. The hook finds the program after shell keywords (`while`, `if`, `do`, `!`, `{`), redirections (`2>/dev/null ps`), wrappers and their options, inside a shell's `-c` text or stdin, and in the arms of a `case`. The arguments of a script (`bash ./x.sh kill`) and a `case` pattern are not programs. To stop its own server or background job, an agent uses TaskStop, or runs it as a background task. | An agent that reads or signals the real process list can stop your own programs. A `process.kill` inside a script is not visible to the hook. |
| A task's branch, and the branch of a writer run, is a plain task branch such as `claude/t12`: letters, digits and `. _ / -`. It is never main, master or HEAD in any case, and never a name under `refs/`, `heads/`, `remotes/` or `origin/`. | Git reads those names as main or as another ref, so a writer could reach main without a pull request. |
| Agents save their pages (research, designs, findings pages) in the task's pages folder, outside the logbook. `pages <task>` makes the folder (only you can open it) and prints it; `pages <task> record <file>` logs a page in it with its sha256. It takes only a regular file of at most 16 MiB inside that folder, with no control character in its name. | A sandboxed agent cannot write the logbook, and the sha256 shows later that the page did not change. |
| Every finding is triaged: fix, dismiss with a reason, or ask you. | No finding is dropped. |
| A repair round needs a medium or high finding; at most 3 rounds. | Loops must end. A low finding alone isn't worth a round. |
| A repair round re-checks only the repair's diff, with the roles that found the problems. A new medium or low finding goes to a follow-up task; a high one blocks. | A round that re-reviews the whole branch finds new scope, not the fix. |
| A merge needs the exact checked commit, with its clean cycles in the ledger. | A new commit is not checked until it is reviewed again. |

**The limits of the hook.** The hook catches mistakes and the normal habits of an agent, such as a quoted branch name or a short ref like `heads/main`. It does three things:

1. **It refuses.** The merge rule and the push rule are allow-lists: a command that merges or pushes passes only in its one form, and each refusal names that form.
   - A push names `origin` and the literal name of a branch that is not main or master. `HEAD`, `@`, a pattern, a variable or a refspec with `:` or `+` is refused.
   - The hook reads the branch of the checkout where the push runs (the `-C` folder, a `cd` before it, or the session's folder), and refuses a push from main or master.
   - A git push of main is refused. So is a `gh api` command that names main or master on a `git/refs` endpoint, also behind `env`, `command`, a `NAME=value` or a path to `gh`.
   - When the hook cannot read a command, it refuses the command.
2. **It asks you in one case.** For a blank project, the chief creates main or master on GitHub for the first time. Only this whole command, from the main session, asks you: `gh api --hostname github.com -X POST repos/<owner>/<repo>/git/refs -f ref=refs/heads/main -f sha=<full commit id>`. An agent never gets this exception. The hook checks on GitHub, not in the local repo, that the branch is absent and that the commit has no parent. Then Claude Code's permission prompt shows you the repository, the commit, its number of files and its top-level names.
3. **The lock is GitHub branch protection.** After the first main or master, sage tries to turn it on, so that the branch changes only through pull requests. GitHub offers it for public repos, and for private repos on paid plans.

The limits, said once: the hook and the lock stop mistakes, not an agent that acts on purpose. An agent can hide a merge or a push from the hook, for example with a git editor or a git hook that runs a shell, a file that a later command runs, or a command name split across variables. An agent that holds your GitHub token can remove the protection or merge a pull request. The guard against that is identity: agents get a GitHub identity that cannot merge or change main. That identity is planned and not built yet.

### The arena

When a design has no clear answer, the chief can run an **arena**. You can also ask for one: "arena" or "arena 4".

<a href="docs/assets/arena-light.svg">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/arena-dark.svg">
  <img alt="The arena: one brief and a hidden rubric, three candidates on a mix of Claude models, an arena judge, one final version." src="docs/assets/arena-light.svg" width="100%">
</picture>
</a>

1. The chief writes a rubric: 3 to 6 criteria that a judge can grade. The candidates don't see it.
2. N candidates (3 by default) get the same brief, each with a different angle, on a mix of Claude models.
3. The arena judge scores each one, picks a base, and grafts the best parts of the others into it.
4. The final version goes through reviews and QA like any build. The candidates never merge.

## Concepts

<!-- The word table comes from writing/dictionary.md: edit it there, then run npm run build. -->

| Word | Meaning |
| --- | --- |
| **Request** | What the owner asks for in the chat, in the owner's words, before sage frames it. |
| **Program** | (Coming with programs.) A request that sage runs as two or more tasks for one goal, where at least one task waits for another. It has a goal, a done condition (a count of merged tasks), a breakdown that the owner approves, and one pilot task. |
| **Task** | One unit of work in one project, with one route and at most one pull request. Coming with programs: it is in at most one program, and it may wait for other tasks ("waits for": it starts only when they are merged). |
| **Step** | One block of a task's route, done by one agent role: design, arena, pe, build, code-review, security-review, ux-review, qa, investigate, evidence-review. |
| **Route** | The ordered steps of one task, set by its size and risk flags. |
| **Run** | One agent's work on one step of a task, from brief to report; it has an id such as R12. Coming with programs: also the PE check of a breakdown. |
| **Agent** | A Claude Code subagent that does one run; the role (implementer, qa, …) says what it does. |
| **Chief** | The chief of staff: the main session that frames tasks, writes briefs, records the state and asks the owner; it changes no files. Coming with programs: it frames programs too. |
| **Brief** | What the chief gives an agent at the start of a run, in the ten fields (GOAL to STANDING). Coming with programs: a task that waits for others gets their final reports in full in CONTEXT. |
| **Report** | What an agent gives back at the end of a run, in the seven fields (STATUS to BRANCH). |
| **Artifact** | A file or record that a run takes in or gives out and sage keeps: a brief, report, steer message, transcript, branch, commit or pull request. |
| **Finding** | One problem that a review or QA reports, with a severity (high, medium or low), a triage and a status. |
| **Verdict** | The result of one check (checks, a review, QA) on one head commit, kept in the ledger by SHA and cycle. |
| **Cycle** | One full set of fresh reviews and QA on one head commit; a new commit starts again from cycle 1. |
| **Gate** | A question parked for the owner, with options, a recommendation and a default; the work behind it waits for the answer. Coming with programs: the owner approves a program's breakdown through a gate. |
| **Logbook** | sage's local record of one project: its tasks, runs, findings, verdicts, gates and decisions, kept on the owner's Mac. |
| **Agent time** | The wall-clock hours of agent runs, given with their tokens. The default for every time figure: give it with its basis and a range. |
| **Human time** | The time of the owner's own actions only: reviews, approvals, merges and setup. Give it with its basis and a range. |
| **Sage mode** | The mode in which a session is your chief of staff. A message that starts with "sage mode" turns it on. A message that starts with "sage mode off" turns it off. |
| **Risk flag** | auth, data, schema, money, secrets or input. Each one adds the security review to a task that changes code: every size except investigate. |
| **Ledger** | The record of all verdicts, by commit. The merge check reads it. |
| **Standing orders** | Short rules for a project that every brief carries word for word. |
| **Arena** | N candidates for one design, scored and combined by a judge. |
| **Autopilot** | Verified pull requests merge by themselves after their clean cycles: 1 for a tiny or small task, 2 for a large task or a task with a risk flag. Off by default. A message of the owner that starts with "autopilot on" or "sage mode autopilot" turns it on. Your own text that mentions autopilot with an off word turns it off, also between two frames and in a message queued while Claude works. A queued message is yours only as a whole system reminder outside every other frame. It can stop autopilot, but it cannot start autopilot or sage mode: send an on again when Claude is idle. Inside an agent's report or a notice, only a line that starts with "autopilot off" or "sage mode off" turns it off. Text inside an agent's report, a notice or another session's message never turns it on. |
| **The dojo** | Everything that makes the agents good: the principles, checks, tests and skills. |
| **Seal the lesson** | Give a mistake that comes back twice a lasting fix, from the most enforced kind down: a test or a check in code first; a principle or a standing order only when code cannot hold it. Each sealed lesson makes the dojo stronger. |

<!-- The end of the word table. -->

sage uses each word in one meaning only. The [dictionary](writing/dictionary.md) also gives the words not to say; `npm run check` fails on the worst of them.

## What to say

| Say | What happens |
| --- | --- |
| `sage mode.` + a request, at the start of a message | The session becomes your chief of staff and starts the work. |
| Your answer to a question, for example `no` | The chief applies your decision and goes on. |
| `status` | Where each task is: running, waiting for you, verified. |
| `arena` or `arena 4` | The next design goes to N candidates and a judge. |
| A message that starts with `autopilot on`, or with `sage mode` followed by `autopilot`: `sage mode autopilot`, `sage mode on, autopilot on` | Verified pull requests merge by themselves after their clean cycles. |
| Your message that mentions autopilot with an off word, for example `autopilot off`, `stop autopilot` or `pause autopilot` | Verified pull requests wait for you again. |
| `sage mode off` at the start of a message | A normal session again. |

Only your own text switches a mode on, or sage mode off. Claude Code does not tell the hook who wrote a prompt, so the hook reads the frames that Claude Code puts around text that you did not type: an agent's report, a task notification, a message from another session and a system reminder. Text inside them never switches a mode on, also when it quotes you. When Claude Code joins your message to one of them, your part counts. When Claude Code queues your message while it works, it counts as yours only as a whole system reminder outside every other frame: the same shape inside an agent's report counts as the report. A message that you send while Claude works can stop autopilot, but it cannot start autopilot or sage mode, or end sage mode: an agent can write the same shape, and the hook cannot tell the two apart. Send it again when Claude is idle. When the hook cannot read the frames, for example a frame that does not close, nothing in that prompt switches a mode on. Inside a frame, only a line that starts with "autopilot off" or "sage mode off" switches autopilot off, because the frames themselves have off words such as "not". A "sage mode off" that you did not write switches only autopilot off. In your message, only its start switches a mode: "sage mode" (or "sage mode on"), "sage mode off" and "autopilot on". A mention in the middle of a sentence switches nothing, so you can talk about them freely. Put a full stop, a comma, a colon or a line break after "sage mode" or "autopilot on": "autopilot on?" and "autopilot on main" switch nothing. A "?" on the line of "sage mode off" keeps sage mode on, but autopilot goes off. Autopilot off works anywhere in your own text, also between two frames: any message that mentions autopilot together with an off word, such as off, stop, pause, disable or cancel, in any form, switches it off, because a missed "off" lets merges go on. Off wins over on: "autopilot on, don't stop until done" leaves autopilot off. "turn on autopilot" and "enable autopilot" switch nothing.

To make every session in a folder start in sage mode, put this in the folder's `.claude/settings.json`:

```json
{ "agent": "sage:chief-of-staff" }
```

## Principles

A principle is a short rule for one kind of moment, for example "test behaviour, not implementation" when you change a test. There are 25. My own versions win over pstack's where both exist.

Agents seldom load a skill by themselves, so a **hook** gives the principle at the moment it applies, once per session.

| The moment | The principles it gets |
| --- | --- |
| The request asks for a design, a plan or a new feature | exhaust-the-design-space, experience-first, foundational-thinking |
| The request asks for a refactor or a cleanup | subtract-before-you-add, laziness-protocol, migrate-callers-then-delete-legacy-apis |
| The agent is about to change a test file | test-behavior-not-implementation |
| The agent is about to write a document | contextualize-and-write-for-the-reader |
| The agent is about to commit | sequence-verifiable-units |
| A check fails | fix-root-causes |
| Two changes in a row do not make the same check pass | attack-the-premise |

The hook also has **one check**, the stop check. When the agent tries to finish, the code changed, and no check ran after the change, it stops the agent once. The agent must run a check or say what it did not verify.

<details>
<summary><strong>All 25 principles</strong></summary>

| Principle | Apply when | Text |
| --- | --- | --- |
| attack-the-premise | two or more fixes that share one premise failed the same check | mine |
| boundary-discipline | writing or reviewing validation, error handling or adapters | mine |
| build-the-lever | any non-trivial work: build the tool that does it or proves it | pstack |
| contextualize-and-write-for-the-reader | writing anything that someone reads later | mine |
| encode-lessons-in-structure | you write the same instruction a second time | mine |
| exhaust-the-design-space | a new interaction or architecture has no precedent | mine |
| experience-first | a product, UX or scope trade-off comes up | mine |
| explain-the-number | before you trust or report a number you measured | pstack |
| fix-root-causes | debugging a failure or repairing a finding | mine |
| foundational-thinking | before writing logic: types, data, order of work | mine |
| guard-the-context-window | the context fills up with large outputs or many reads | pstack |
| laziness-protocol | refactoring, judging a diff's size, or adding a layer | mine |
| make-operations-idempotent | commands and loops that must survive crashes and retries | pstack |
| migrate-callers-then-delete-legacy-apis | a new internal API replaces an old one | mine |
| minimize-reader-load | code is hard to follow | mine |
| model-the-domain | stateful logic, or the same shape assumed in many files | pstack |
| never-block-on-the-human | tempted to ask "should I?" about reversible work | mine |
| outcome-oriented-execution | a planned rewrite or migration in phases | pstack |
| prove-it-works | before declaring a task done | mine |
| redesign-from-first-principles | a new requirement meets an existing design | pstack |
| separate-before-serializing-shared-state | several actors may write the same file, branch or key | pstack |
| sequence-verifiable-units | multi-step work, and the order of commits | mine |
| subtract-before-you-add | ordering an addition, a refactor or a rewrite | mine |
| test-behavior-not-implementation | writing, changing or keeping a test | mine |
| type-system-discipline | designing types or code in a typed language | pstack |

"mine" is my rewrite of pstack's principle, or my own (contextualize-and-write-for-the-reader). "pstack" is pstack's text as it is.

</details>

## Following pstack

pstack changes often. sage follows it so that you don't have to.

<a href="docs/assets/pstack-light.svg">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/pstack-dark.svg">
  <img alt="Following pstack: a weekly sync into upstream/pstack, local versions in principles/ that win, one build, the sage plugin. If pstack changed a local version, the update waits for review; otherwise it merges." src="docs/assets/pstack-light.svg" width="100%">
</picture>
</a>

1. `upstream/pstack/` holds pstack's principles and its MIT licence, at the commit in `upstream/pstack.json`.
2. The build takes each pstack principle as it is, unless `principles/` has my version with the same name.
3. Every Monday, a workflow brings pstack up to date, rebuilds, and runs the checks and tests. The update merges by itself, unless pstack changed a principle that I rewrote. Then its pull request waits for me, with the change listed.

Only principles come in for now. pstack's own modes (poteto mode, orchestrate, autopilot) stay out, because sage mode is the orchestration layer here. Each other pstack skill comes in only when it works in Claude Code and has a test.

## Remote Control

With Remote Control, you can follow, steer and start Claude Code sessions from the Claude app on your phone. The `remote-control` skill sets it up.

| Command | What it does |
| --- | --- |
| `/sage:remote-control` | Turns Remote Control on for every new session. |
| `/sage:remote-control off` / `status` | Turns it off, or shows the setting. |
| `/sage:remote-control server ~/workspace` | Runs a Remote Control server in `~/workspace`, now and at each login (macOS). From the phone, you can then start sessions in that folder. |
| `/sage:remote-control server off` / `status` | Stops the server and removes its login item, or shows whether the phone can see it ("Ready"). |

In the desktop app, also turn on **Settings → Claude Code → Connect new sessions to Remote Control**. Before the first `server`, do three things once, in the macOS Terminal app:

1. Run `claude auth login`. A `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` does not work for Remote Control. If your `~/.zshrc` sets it, run step 3 as `env -u CLAUDE_CODE_OAUTH_TOKEN claude remote-control`.
2. Run `claude` in the server's folder, and answer Yes to the trust question.
3. Run `claude remote-control` in the same folder, answer `y` to "Enable Remote Control?", then press Ctrl+C.

While the server runs, your claude.ai account can start sessions on your computer, and they can reach everything in the folder.

## FAQ

**What does it cost?** It uses your Claude plan's usage limits, or API credits. Every agent is a separate run. In [the first dry run](docs/runs/dry-run-1.html), a small bug fix with a security risk took 15 agent runs, about $2.60 at API prices, before the fixes that came from that run. I don't have numbers from real projects yet.

**Is it safe to let it work alone?** Each agent works in its own git worktree. Nothing reaches main except through a pull request, and the hook blocks force-pushes. Autopilot is off until you turn it on. It switches on only when a message starts with "autopilot on", or with "sage mode" followed by "autopilot", for example "sage mode autopilot" or "sage mode on, autopilot on". Any message of yours that mentions autopilot together with an off word, such as off, stop, pause, disable or cancel, in any form, switches it off, also when the message turns it on. In an agent's report or a notification, only a line that starts with "autopilot off" does. Text inside an agent's report, a task notification or another session's message never switches it on, and when the hook cannot read a prompt's frames, nothing in that prompt switches it on. When Claude Code joins your message to one of them, or queues your message as a whole system reminder outside them, your part counts. The hook lets a merge through only as the one merge command on its own: it refuses a merge through the GitHub API, a variable, a script or another program, and any command that names a merge outside the text of a harmless command, such as a commit message or a pull request body. The chief's instructions say that a deploy or deleting data always needs you, also on autopilot; that rule is not yet held in code.

**Which projects fit?** A project with tests and a GitHub remote. Without tests, QA can only check by running the app. Without a remote, the work stops at a verified branch.

**Does it work in Codex?** Sage is for Claude Code.

**How mature is it?** Early. It has done one dry run on a demo project ([the report](docs/runs/dry-run-1.html)). A pilot on a real project comes next. The full design is in [docs/design/sage-mode.html](docs/design/sage-mode.html).

## Under the hood

| Path | What it is |
| --- | --- |
| `plugins/sage/agents/` | Sage mode's team. |
| `plugins/sage/skills/` | The skills: one per principle (generated), the writing standard (generated), `remote-control`, the state tool `sage`, and `report`. |
| `plugins/sage/hooks/` | `hooks.json`: the principle hooks. `claude.json`: the sage mode hook. |
| `principles/` | My principles: my own, and my versions of pstack's. |
| `upstream/pstack/` | pstack's principles, kept up to date by the sync. |
| `writing/ste-80.md` | The writing standard: about 80% of ASD-STE100, Simplified Technical English. |
| `preferences/`, `instructions/core.md` | How I work with agents, and the always-on file made from it. |
| `docs/` | The design, the dry run reports, and the README's graphics. |
| `scripts/graphics.mjs` | Draws the graphics in this README, the toad sage too, in light and dark. |

**Change it:**

1. Edit a source: `principles/`, `writing/`, `preferences/`, or an agent in `plugins/sage/agents/`. To override a pstack principle, add `principles/<name>.md` with `source: pstack principle-<name>` and its `upstream:` fingerprint.
2. Run `npm run build`, then `npm run check` and `npm test`. CI runs the check and the tests. After a change to a graphic, run `npm run graphics`.

## Credits

- **[pstack](https://github.com/cursor/plugins/tree/main/pstack) and poteto mode, by [Lauren Tan (poteto)](https://github.com/poteto).** sage's principles come from pstack, and sage mode takes its main ideas from poteto mode: the "coordinator" that never writes code, the brief, the ledger of verdicts by commit, the arena, and the trust ladder. Thank you, Lauren. I adopted pstack the day I found it.
- **Sage Mode in *Naruto*, by Masashi Kishimoto**, gave the name and the look: the orange markings and the toad-like eye. The graphics and the toad sage mascot are original drawings, and no character from the series appears. sage is a fan's nod and is not affiliated with *Naruto* or its owners.
- **My [Orchestrator](https://github.com/erickb336/orchestrator)** taught the lessons that sage keeps in code.
- **Anthropic's and Cognition's writing on multi-agent systems** shaped the rules: one writer at a time, fresh reviewers, and evidence before a claim.

## Licence

MIT. pstack's text keeps pstack's MIT licence: see [upstream/pstack/LICENSE](upstream/pstack/LICENSE) and [principles/LICENSE-pstack](principles/LICENSE-pstack).
