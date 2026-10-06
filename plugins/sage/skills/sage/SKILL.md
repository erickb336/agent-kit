---
name: sage
description: "The state tool of sage mode: records tasks, routes, agent runs, findings, verdicts by head SHA and the user's gates in ~/.claude/sage/<project>/. Use in sage mode for every change of a task's state, and before any merge. Claude Code only."
license: MIT
---

# The sage state tool

The chief of staff keeps the work in the project's logbook, not in the conversation. Then a session on the phone or the desktop can continue it. Each command prints one line. A refused command prints the reason and exits with 1: do what the reason says, and do not work around it.

Run it as `node ${CLAUDE_SKILL_DIR}/sage.mjs <command> --project <path to the project>`: node and the absolute path, without quotes. In the sandbox, only this form runs outside it; a quoted path, a variable, a `cd … &&` or a pipe stays inside, and the logbook write fails.

Each option takes a value: `--name value`, or `--name=value` for a value that starts with `--`. A command refuses an option that it does not take, and names the options that it takes. It refuses an option given twice.

## Commands

| Command | Does |
| --- | --- |
| `init` | Makes the project's logbook and its standing orders. A new logbook has each table with only its header line. `init` writes tasks.tsv last, so a folder with tasks.tsv has every table. On an existing logbook it makes no table: a lost one refuses (see "The logbook check"). It adds the logbook's folder to the known project list, `projects.tsv` in the sage root, under the root's lock; it never removes a line. It checks the list and takes the root's lock before it writes the logbook, so a refusal there (a busy lock, a damaged or missing list) makes nothing. |
| `projects rebuild --accept-listing yes` | Writes the known project list again: each folder of the sage root with tasks.tsv or ledger.tsv (`how` is `rebuild`), and prints each one. Run it only when the user asks for it, and show the user the listing: a folder that no project uses may be forged, so the user removes it and runs the rebuild again. A `projects.tsv` that is a folder refuses; a link is replaced by a regular file. |
| `logbook` · `logbook repair --accept-loss <table>[,<table>...]` | Prints the logbook's folder. `repair` starts each named table that fails the logbook check again, without rows. Run it only after the user accepts the loss of their rows. Name every damaged table in one command, joined by commas (`--accept-loss tasks,ledger`): a repair refuses when another table fails too, and names the command with both. The old file stays beside each as `<table>.tsv.lost-<n>`, and the decision trail records each repair before the table starts again. A named table that passes the check refuses the whole command. |
| `standing` · `standing add "<order>"` | Prints the standing orders as written, or adds one. Paste them into every brief. Tabs stay, CRLF line ends print as plain lines, and hidden characters are removed (see "Hidden characters"). |
| `task add --title "<t>" --size tiny\|small\|large\|investigate [--risk auth,data,schema,money,secrets,input] [--add <blocks> --why "<reason>"]` | Frames a task and its route. The size gives the least route. A risk adds the security review. An investigation takes no build block: a build that it needs is its own task. |
| `task <T> set state=<state> [branch=<b>] [pr=<n>]` | Moves the task. The tool refuses a move that the design does not allow, and "verifying" or "concluded" while a finding is open. A PR number is only digits. A branch (here and in `run add --branch`) is letters, digits and `. _ / -`, such as `claude/t12` or `tool/t12-short-name`: not main, master, HEAD or `refs/…`, and not a name that starts with `-` or holds `..` or `@{`. `branch=` clears it. An investigation takes no PR number; `pr=` clears one. |
| `round <T>` | Starts a repair round on the open findings marked fix, and names the roles to re-run on the repair's diff: the sources of those findings. After the last round, or when a round did not fix its findings, it holds or re-plans the task. |
| `run add <T> --role <role> [--branch <b>] [--candidate <k>]` · `run done <R> --status done\|blocked\|question\|failed [--tokens <n>] [--report <path>]` | Records an agent run. One writer (implementer, designer) per branch: finish the running one first, or use another branch. `run add` prints the model of the run (`R12 running · qa on T3 · model fable`) and records it in the runs column `model`: pass it as the `model` of the agent call. No model on the line means the agent's own model: pass none. An arena candidate `<k>` takes the k-th model of arena_models; any other run takes `model.<role>.<size>` (the task's size), else `model.<role>`. |
| `finding add <T> --source <role> --severity high\|medium\|low --summary "<s>" [--key <K>]` | Records a finding. A known key opens it again, with the new severity, source and summary; the decision trail keeps the old summary. Without `--summary`, a known key keeps its summary; an empty one is refused. Without `--key`, the finding gets a new key. |
| `finding triage <T> <K> fix\|dismiss\|ask [--reason "<r>"]` · `finding close <T> <K>` | Triage every finding. A dismissal needs its reason. Close a fix after a review confirms it. |
| `finding move <T> <K> --to "<title>" [--size tiny\|small\|large]` | Moves an open medium or low finding to a new follow-up task (small by default), which it frames. The finding gets the new task's key, and the decision trail records the move. A high finding cannot move: it blocks its task until it is fixed. |
| `verdict <T> --sha <sha> --kind <kind> [--cycle <n>] [--pr <n>] [--run <R>]` | Records a verdict on a head SHA. Give the full 40-character SHA (`git rev-parse <branch>`): a short one is refused, and capitals are the same SHA. A task without a build block records its verdicts without `--sha`. Kinds: checks-pass, review-clean, security-clean, ux-clean, qa-pass, evidence-clean, checks-fail, findings, qa-fail. Record the findings first: `findings` and `qa-fail` need an open medium or high finding, and their refusal says to record it first. |
| `gate add <T> --question "<q>" --options "<a\|b>" --recommend <a> [--default <a>]` · `gate answer <G> --option <n> --project <folder>` · `gate answer <G> --other-hex <hex> --project <folder>` | Parks a question for the user, with your recommendation and the default. The recommendation and the default are options, by text or number; options that differ only in case or hidden characters are refused. The answer is the number of an option as the board shows it (1, 2, …), never its text, so no agent-written text goes into a command. For the user's own words, use `--other-hex` with the UTF-8 bytes of the words in lower-case hex, so that the command holds only 0-9 and a-f; the gate keeps them as `other: <words>`. An option may not read as `other:`, also with other case, width, hidden characters or a space before the colon. Give the `--project` of the gate's own project: two projects can each have a G1. `init` and `task add` write the project's folder to `checkout.txt` in its logbook, so a session of another project can answer its gates. |
| `log <T\|-> "<decision>" --why "<reason>"` | Adds a line to the decision trail. Put the id that the decision is about first ("R1 stopped by hand"): only the first word counts as an id, so an id later in the text can come back. |
| `pages <T>` · `pages <T> record <file>` | Makes (mode 700) and prints the folder where agents save the task's pages (research, designs, findings pages): `~/sage-worktrees/<project>-<hash>/pages/<T>/`, under the logbook's own folder name, so two projects with the same name never share it (`$SAGE_WORKTREES` overrides `~/sage-worktrees`). It is outside the logbook, so a sandboxed agent may write there. `record` adds the page's path and sha256 to the decision trail; the file must be a regular file of at most 16 MiB in that folder, not a link, a named pipe or a device, and its name has no control character (a tab or a line break). Give that folder in the brief of each agent that saves a page. |
| `status` | Prints the status lines. Each change also writes them to `status.md`. End each report to the user with them. |
| `merge-check --sha <sha> [--pr <n>] [--cycles <n>]` | Says if the full SHA may merge. Each task that has verdicts on it, in every project's logbook, must pass on its own verdicts: no open findings, checks-pass, and its route's verdicts in the clean cycles of its size and risk (see "Cycles and merges"). `--cycles` raises the count of every task to at least that number; it never lowers a task's own count. A logbook that is a link to a folder counts too. With `--pr`, each task of that pull request must pass too, and the pull request must have one. A refusal lists every task that fails and its way out. A task of the pull request that is no longer part of it: clear its PR with `task <T> set pr=`. A logbook (a folder with tasks.tsv) that fails the logbook check refuses every merge and names the file. A folder outside the known project list (`projects.tsv`) that has verdicts on the SHA refuses the merge and is named. `init` adds only a project's own folder, so for a renamed folder or a link the user gives the folder back its name, runs `projects rebuild`, or removes the folder. The first command of this version, the merge check too, finds neither `projects.tsv` nor `projects.made` and lists each folder with tasks.tsv or ledger.tsv once (`how` is `migration`); it writes `projects.made` first. After that, a missing `projects.tsv` refuses every merge and every `init` until the user restores it or runs `projects rebuild`. A `projects.tsv` that is a link, not a regular file, or has no header line refuses every merge and names the rebuild. |
| `config [key=n ...]` | Prints or sets max_agents, cycles.small, cycles.large, cycles.risk, max_rounds, arena and cap_total for all projects, and `cap.<project>=n` for one project's agent cap (the project's name is its main checkout's folder name, as a slug: `cap.sage=5`). Each is a whole number of 1 or more; cycles.large and cycles.risk are 2 or more (the owner's floor: only a code change lowers it). The limit is 10 for the cycles and max_rounds, and 50 for the others, so that a typo cannot block every merge or start too many agents. One rule reads every count in `config.json`. The count is a number, or a string of a number with spaces or leading zeros allowed (`2.5`, `"03"`, `" 3"`). A cycles count rounds up, and any other count rounds down (`2.5` reads as 3 cycles, but as 2 agents). Below its floor a count reads as the floor (`0` or `-1` reads as 1, and cycles.large of 1 as 2). Above its limit, a cycles count keeps its value (a merge never gets easier), and the merge check's reason names the key and its value in `config.json`; any other count reads as the limit. So a count in `config.json` never starts more agents or rounds, or asks fewer cycles, than written. A cycles key with no number (`"abc"`, `true`, `[3]`, `1e400`) refuses every merge: `config` prints it as `invalid`, and the merge check names the key; set it with `config` or remove it. Any other count that is missing or has no number (`"3x"`) gives its default. max_agents is the cap of a project without its own; cap_total (default 12) caps the agents of all projects together, and it wins. A change keeps the other keys in `config.json`, also those of a newer version; it refuses when `config.json` is a link or not a regular file. An older sage's `autopilot_cycles` in `config.json` counts as cycles.large when cycles.large is absent, never below the floor; one with no number is an invalid cycles.large. When autopilot turns on, its note names a cycles key with no number instead of the counts. It also sets an agent role's model: `model.<role>.<size>=<model>` for one size of task, or `model.<role>=<model>` for every size. A role is pe, designer, implementer, code-reviewer, security-reviewer, ux-reviewer, qa or arena-judge; a size is tiny, small, large or investigate; a model is opus, sonnet, haiku or fable. By default the code, security and UX reviews and QA of a tiny or small task use fable (gate G17), and every other run uses the agent's own model. `model.qa.small=inherit` clears a key: then `model.qa` counts, else the agent's own model. A bad model, or one in `config.json`, gives the default. The model keys print after the numbers. |

## Cycles and merges

- A cycle is one full set of fresh reviews and QA on one head SHA. Record each verdict with `--cycle <n>`.
- A cycle is clean when no medium or high finding of the task is open. A review or QA that found only low findings records its clean verdict, not `findings` or `qa-fail`: the tool refuses those without an open medium or high finding. Before the merge, fix, move or dismiss each low finding with a reason: an open finding blocks the merge.
- A `findings`, `qa-fail` or `checks-fail` verdict blocks its SHA: repair, then review the new SHA.
- A merge needs the task's clean cycles on its head SHA: 1 for every task (`cycles.small`), 2 for a large task (`cycles.large`), and 2 for any task with a risk flag (`cycles.risk`); the largest count that applies wins. Verified needs 1 for every task.
- A repair round re-runs only the roles that `round` names, on the repair's diff. The re-check confirms each fix (`finding close`) or opens the finding again; it records no verdict. Then the task needs its clean cycles on the final SHA, with every role.
- A new medium or low finding that a round raises goes to a follow-up task with `finding move`, not to another round. A high finding always blocks.
- With autopilot on, merge with `gh pr merge <n> --squash --delete-branch --match-head-commit <sha>`. The sage hook runs `merge-check` first and refuses a SHA that is not ready.
- A new commit is a new SHA. Its verdicts start again from cycle 1.
- Every task with verdicts on a SHA counts, also an abandoned one. When two tasks share a pull request, record each verdict under both. To leave an old task's verdicts behind, push a new commit.

## What the hook refuses an agent

- `git stash` in any form, also with `-C` or `--git-dir`: every worktree shares one stash list. Use `git worktree add --detach <scratch> <sha>` or `git show <sha>:<path>`.
- A program that lists or signals processes (`ps`, `pgrep`, `pkill`, `kill`, `killall`, `lsof`, `top`), unless it resolves to a fake in the temp folder. Put a fake `ps` first on PATH that prints a start time in the past, and run a fake `kill` by its path. The chief is not limited.

## How an investigation ends

- An investigate task has no build block, so it ends at `concluded`, not at verified. Its last states are reviewing → verifying → concluded.
- `concluded` needs no open findings, and the task's latest verdict must be `evidence-clean`. Record it with `verdict <T> --kind evidence-clean --run <R>`, without `--sha`.
- A task with a build block cannot use `concluded`.

## Several sessions on one project

- Several chief sessions may share one project's logbook. Each command that changes the logbook holds its lock while it runs.
- A command waits up to 3 s for the lock. Then it refuses with `the logbook is busy: pid <n> on <host> has held <path> for <n> s`, or with `<path> has no valid owner file`. Nothing changed: run the command again.
- The next command clears a lock that a crashed command left. A lock from another machine, a live process that is not sage, or an odd owner file stays. Remove the folder in the message only when no sage command runs.
- The next command also removes the temp folder (`.lock.<id>`) of a command that was killed while it waited.
- `status`, `logbook`, `standing` and `merge-check` take no lock. They work while another command runs.
- The sessions may run two versions of sage. A version refuses to change a logbook whose tables have columns that it does not know: its write would lose them. The refusal says to update the sage plugin and restart the session, and that `status`, `logbook`, `standing` and `merge-check` still work.
- A command refuses, before any change, when status.md or standing.md is not a regular file, also a link to nothing.

## The logbook check

One check guards the merge check and every write, `init` on an existing logbook too. Each of the six tables must be:

- there (not deleted, and not a link to nothing);
- a regular file that the tool can read;
- not empty (not 0 bytes, and not only blank lines);
- with its header line: the first line names each of its columns. A BOM and CRLF line ends from an editor are read as a plain file.

A table that fails refuses every merge and every write, and the refusal names the file. No command makes a lost table again or repairs it in silence. The ways out:

- Restore the file from a copy.
- A table that cannot be read (EACCES): fix its permissions. Do not remove it: its rows are there.
- If no copy is left and the user accepts the loss: `logbook repair --accept-loss <table>`. Run the command that the refusal prints. When a second table fails too, the repair refuses and prints the command with both tables: run that one.

After a repair of tasks.tsv, the verdicts of its lost tasks stay in ledger.tsv. The merge check refuses their SHA, says that tasks.tsv was started again, and asks for a new commit with its verdicts under a task that the logbook has.

Limit: a table cut to only its header line is a table without rows. The check cannot tell it from a new table.

A folder without tasks.tsv is no logbook: `init` has not finished it. `init` finishes it when its tables have no rows. When they have rows, its task list is lost, and `init` refuses: restore tasks.tsv, or repair it.

## Hidden characters

The tool keeps no hidden character in a cell, and removes them from the standing orders. Hidden characters are those that a person does not see but a terminal or an agent acts on:

- the control characters (C0, DEL and C1), except a tab and a line end in the standing orders;
- the bidi embeddings, overrides, isolates and marks (U+202A to U+202E, U+2066 to U+2069, U+200E, U+200F, U+061C);
- the zero-width characters (U+200B to U+200D, U+2060, U+FEFF);
- the variation selectors (U+FE00 to U+FE0F, U+E0100 to U+E01EF);
- the tag characters (U+E0000 to U+E007F), text that only an agent reads.

Other text stays: each script, and emoji. A zero-width joiner or non-joiner between two letters stays: Persian and Indic text needs it. A zero-width joiner between two emoji stays, so a joined emoji stays whole, and the emoji selector (U+FE0F) stays after an emoji or a keycap base (`1️⃣`). A subdivision flag (England, Scotland, Wales) shows as a black flag.

The tool prints each hidden character in an id, a column or a path as `\xNN` or `\u{N}`. For a project path with a control character, it prints no command to paste.
