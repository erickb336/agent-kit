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
| `task add --title "<t>" --size tiny\|small\|large\|investigate [--risk auth,data,schema,money,secrets,input] [--add <blocks> --why "<reason>"]` | Frames a task and its route. The size gives the least route. A risk adds the security review. |
| `task <T> set state=<state> [branch=<b>] [pr=<n>]` | Moves the task. The tool refuses a move that the design does not allow, and "verifying" while a finding is open. |
| `round <T>` | Starts a repair round on the open findings marked fix. After the last round, or when a round did not fix its findings, it holds or re-plans the task. |
| `run add <T> --role <role> [--branch <b>] [--candidate <k>]` · `run done <R> --status done\|blocked\|question\|failed [--tokens <n>] [--report <path>]` | Records an agent run. One writer (implementer, designer) per branch. |
| `finding add <T> --source <role> --severity high\|medium\|low --summary "<s>" [--key <K>]` | Records a finding. A known key opens it again. |
| `finding triage <T> <K> fix\|dismiss\|ask [--reason "<r>"]` · `finding close <T> <K>` | Triage every finding. A dismissal needs its reason. Close a fix after a review confirms it. |
| `verdict <T> --sha <sha> --kind <kind> [--cycle <n>] [--pr <n>] [--run <R>]` | Records a verdict on a head SHA. Kinds: checks-pass, review-clean, security-clean, ux-clean, qa-pass, checks-fail, findings, qa-fail. |
| `gate add <T> --question "<q>" --options "<a\|b>" --recommend <a> [--default <a>]` · `gate answer <G> <answer>` | Parks a question for the user, with your recommendation and the default. |
| `log <T\|-> "<decision>" --why "<reason>"` | Adds a line to the decision trail. |
| `status` | Prints the status lines and writes `status.md`. End each report to the user with them. |
| `merge-check --sha <sha>` | Says if the SHA may merge: no open findings, checks-pass, and the route's verdicts in enough clean cycles. |
| `config [key=n ...]` | Prints or sets max_agents, autopilot_cycles, max_rounds and arena for all projects. |

## Cycles and merges

- A cycle is one full set of fresh reviews and QA on one head SHA. Record each verdict with `--cycle <n>`.
- With autopilot on, merge with `gh pr merge <n> --squash --delete-branch --match-head-commit <sha>`. The sage hook runs `merge-check` first and refuses a SHA that is not ready.
- A new commit is a new SHA. Its verdicts start again from cycle 1.
