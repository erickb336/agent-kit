---
name: sage
description: "The state tool of sage mode: records tasks, routes, agent runs, findings, verdicts by head SHA and the user's gates in ~/.claude/sage/<project>/. Use in sage mode for every change of a task's state, and before any merge. Claude Code only."
license: MIT
---

# The sage state tool

The chief of staff keeps the work in the store, not in the conversation. Then a session on the phone or the desktop can continue it. Each command prints one line. A refused command prints the reason and exits with 1: do what the reason says, and do not work around it.

Run it as `node "${CLAUDE_SKILL_DIR}/sage.mjs" <command> --project <path to the project>`.

## Commands

| Command | Does |
| --- | --- |
| `init` | Makes the project's store and its standing orders. |
| `standing` · `standing add "<order>"` | Prints the standing orders, or adds one. Paste them into every brief. |
| `task add --title "<t>" --size tiny\|small\|large\|investigate [--risk auth,data,schema,money,secrets,input] [--add <blocks> --why "<reason>"]` | Frames a task and its route. The size gives the least route. A risk adds the security review. An investigation takes no build block: a build that it needs is its own task. |
| `task <T> set state=<state> [branch=<b>] [pr=<n>]` | Moves the task. The tool refuses a move that the design does not allow, and "verifying" or "concluded" while a finding is open. |
| `round <T>` | Starts a repair round on the open findings marked fix. After the last round, or when a round did not fix its findings, it holds or re-plans the task. |
| `run add <T> --role <role> [--branch <b>] [--candidate <k>]` · `run done <R> --status done\|blocked\|question\|failed [--tokens <n>] [--report <path>]` | Records an agent run. One writer (implementer, designer) per branch. |
| `finding add <T> --source <role> --severity high\|medium\|low --summary "<s>" [--key <K>]` | Records a finding. A known key opens it again, with the new severity, source and summary; the decision trail keeps the old summary. Without `--key`, the finding gets a new key. |
| `finding triage <T> <K> fix\|dismiss\|ask [--reason "<r>"]` · `finding close <T> <K>` | Triage every finding. A dismissal needs its reason. Close a fix after a review confirms it. |
| `verdict <T> --sha <sha> --kind <kind> [--cycle <n>] [--pr <n>] [--run <R>]` | Records a verdict on a head SHA. Give the full 40-character SHA (`git rev-parse <branch>`): a short one is refused. A task without a build block records its verdicts without `--sha`. Kinds: checks-pass, review-clean, security-clean, ux-clean, qa-pass, evidence-clean, checks-fail, findings, qa-fail. |
| `gate add <T> --question "<q>" --options "<a\|b>" --recommend <a> [--default <a>]` · `gate answer <G> <answer>` | Parks a question for the user, with your recommendation and the default. |
| `log <T\|-> "<decision>" --why "<reason>"` | Adds a line to the decision trail. |
| `status` | Prints the status lines. Each change also writes them to `status.md`. End each report to the user with them. |
| `merge-check --sha <sha> [--pr <n>]` | Says if the full SHA may merge. Each task that has verdicts on it, in every project's logbook, must pass on its own verdicts: no open findings, checks-pass, and its route's verdicts in enough clean cycles. With `--pr`, each task of that pull request must pass too, and the pull request must have one. A refusal lists every task that fails. |
| `config [key=n ...]` | Prints or sets max_agents, autopilot_cycles, max_rounds and arena for all projects. Each is a whole number of 1 or more. A missing or bad value in `config.json` gives its default. |

## Cycles and merges

- A cycle is one full set of fresh reviews and QA on one head SHA. Record each verdict with `--cycle <n>`.
- With autopilot on, merge with `gh pr merge <n> --squash --delete-branch --match-head-commit <sha>`. The sage hook runs `merge-check` first and refuses a SHA that is not ready.
- A new commit is a new SHA. Its verdicts start again from cycle 1.
- Every task with verdicts on a SHA counts, also an abandoned one. When two tasks share a pull request, record each verdict under both. To leave an old task's verdicts behind, push a new commit.

## How an investigation ends

- An investigate task has no build block, so it ends at `concluded`, not at verified. Its last states are reviewing → verifying → concluded.
- `concluded` needs no open findings, and the task's latest verdict must be `evidence-clean`. Record it with `verdict <T> --kind evidence-clean --run <R>`, without `--sha`.
- A task with a build block cannot use `concluded`.

## Several sessions on one project

- Several chief sessions may share one project's store. Each command that changes the store holds the store's lock while it runs.
- A command waits up to 3 s for the lock. Then it refuses with `the store is busy: pid <n> on <host> has held <path> for <n> s`, or with `<path> has no valid owner file`. Nothing changed: run the command again.
- The next command clears a lock that a crashed command left. A lock from another machine, a live process that is not sage, or an odd owner file stays. Remove the folder in the message only when no sage command runs.
- The next command also removes the temp folder (`.lock.<id>`) of a command that was killed while it waited.
- `status`, `store`, `standing` and `merge-check` take no lock. They work while another command runs.
