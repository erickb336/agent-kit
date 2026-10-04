---
id: dictionary
name: The sage dictionary
applyWhen: any text an agent writes for a person in sage mode: briefs, reports, findings, pages and the README.
source: sage's own words, from the design of programs (task T9, run R40), approved by the owner
---

These are sage's approved words: one word for one thing, and one meaning for each word. Every brief, report, page and the README uses them. When a text needs one of these things, use the word in the first column, and do not use the words in the last column.

A part marked "coming with programs" describes programs, a feature that is approved but not built yet. It does not work today.

## Words

| Word | Meaning | Do not say |
| --- | --- | --- |
| **request** | What the owner asks for in the chat, in the owner's words, before sage frames it. | ask, ticket, issue, prompt |
| **program** | (Coming with programs.) A request that sage runs as two or more tasks for one goal, where at least one task waits for another. It has a goal, a done condition (a count of merged tasks), a breakdown that the owner approves, and one pilot task. | project (a project is one repository and its logbook), epic, initiative, plan, roadmap |
| **task** | One unit of work in one project, with one route and at most one pull request. Coming with programs: it is in at most one program, and it may wait for other tasks ("waits for": it starts only when they are merged). | job, ticket, issue, item, unit, phase, step |
| **step** | One block of a task's route, done by one agent role: design, arena, pe, build, code-review, security-review, ux-review, qa, investigate, evidence-review. | stage, phase; never "step" for a task of a program (the approved plan's "step 0 to 4" are tasks T4 to T8) |
| **route** | The ordered steps of one task, set by its size and risk flags. | pipeline, workflow, flow, process |
| **run** | One agent's work on one step of a task, from brief to report; it has an id such as R12. Coming with programs: also the PE check of a breakdown. | job, attempt, session, invocation, execution |
| **agent** | A Claude Code subagent that does one run; the role (implementer, qa, …) says what it does. | worker, bot, assistant, model (the model is the agent's model) |
| **chief** | The chief of staff: the main session that frames tasks, writes briefs, records the state and asks the owner; it changes no files. Coming with programs: it frames programs too. | orchestrator, manager, lead, coordinator, main agent |
| **brief** | What the chief gives an agent at the start of a run, in the ten fields (GOAL to STANDING). Coming with programs: a task that waits for others gets their final reports in full in CONTEXT. | prompt, instructions, ticket, spec |
| **report** | What an agent gives back at the end of a run, in the seven fields (STATUS to BRANCH). | summary, output, result (RESULT is one field of the report), handoff |
| **artifact** | A file or record that a run takes in or gives out and sage keeps: a brief, report, steer message, transcript, branch, commit or pull request. | deliverable, output, attachment, asset |
| **finding** | One problem that a review or QA reports, with a severity (high, medium or low), a triage and a status. | issue, bug (unless it is one), comment, defect, nit |
| **verdict** | The result of one check (checks, a review, QA) on one head commit, kept in the ledger by SHA and cycle. | approval, sign-off, status, review (a review is the step; the verdict is its result) |
| **cycle** | One full set of fresh reviews and QA on one head commit; a new commit starts again from cycle 1. | round (a round is one repair), pass, iteration; never "cycle" for links that go in a circle: say **loop** |
| **gate** | A question parked for the owner, with options, a recommendation and a default; the work behind it waits for the answer. Coming with programs: the owner approves a program's breakdown through a gate. | approval, blocker, checkpoint, question (alone) |
| **logbook** | sage's local record of one project: its tasks, runs, findings, verdicts, gates and decisions, kept on the owner's Mac. | store, database |

## Phrases

These are not new words. They are fixed phrases inside the lines above, so that the list stays at 16 words.

- **breakdown** (coming with programs): the content of a program that the owner approves (goal, done condition, tasks, "waits for" links, pilot, cost, questions). In the program line.
- **waits for** (coming with programs): the link from a task to a task or a pull request that must merge first. In the task line. A circle of such links is a **loop**, and sage refuses it.
- **pilot** (coming with programs): the one task of a program that runs end to end before any other task builds. In the program line.
- **done condition** (coming with programs): the count that ends a program, for example "6 of 6 tasks merged, each verified". In the program line.
- **round**: one repair of findings on a task. In the cycle line.

## Names

The names of sage's parts. They are not words of the list above, but the README's word table shows them too.

| Name | Meaning |
| --- | --- |
| **sage mode** | The mode in which a session is your chief of staff. A message that starts with "sage mode" turns it on. A message that starts with "sage mode off" turns it off. |
| **risk flag** | auth, data, schema, money, secrets or input. Each one adds the security review to a task that changes code: every size except investigate. |
| **ledger** | The record of all verdicts, by commit. The merge gate reads it. |
| **standing orders** | Short rules for a project that every brief carries word for word. |
| **arena** | N candidates for one design, scored and combined by a judge. |
| **autopilot** | Verified pull requests merge by themselves after 2 clean cycles. Off by default. A message that starts with "autopilot on" or "sage mode autopilot" turns it on. Any message that mentions autopilot with an off word turns it off. |
| **the dojo** | Everything that makes the agents good: the principles, checks, tests and skills. |
| **seal the lesson** | Give a mistake that comes back twice a lasting fix, from the most enforced kind down: a test or a check in code first; a principle or a standing order only when code cannot hold it. Each sealed lesson makes the dojo stronger. |

## The check

`npm run check` fails when a flagged word, or its plural, is in an agent file, a hand-written skill, the README, the design page or a README graphic. It does not fail on a word in quotes, in code or in a link URL, so a text can name a word to say that it is wrong. An allowed name passes when it is written exactly as here. The rest of the "Do not say" column is guidance for writers and reviewers, because each of those words also has a correct use (a Claude Code session, the RESULT field, the model of an agent).

**Flagged:** store, worker, orchestrator, epic, initiative, roadmap, ticket, stage, pipeline, deliverable, sign-off, blocker, checkpoint, coordinator, main agent, handoff, invocation, iteration, defect, nit, bot

**Allowed names:** Orchestrator (the owner's earlier project)
