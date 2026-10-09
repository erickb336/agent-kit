# Task board design (T205)

This is the approved design for issue #74. The implementation is under review. All 17 requirements remain in scope. The owner approved the recommended sample layout and recorded-data extension on 2026-10-08. Backend work may proceed; all runtime acceptance remains required.

## Experience

The board shows six state columns, dark by default. Each card opens a task page. On a phone, columns with a task that needs the owner come first. The text board and task detail remain available without a server. A single-file HTML export keeps all task details in that file.

A task page shows the loop, brief, runs, evidence, findings, artifacts and decisions. Missing evidence says unknown. A recorded run and work inferred from a PR have separate counts. Two roots may contain the same task ID; each task keeps its source identity.

Abandoned tasks remain available through task lookup, outside the active columns. Projects share a group only when their recorded identity matches. The owner approved these presentation choices for v1; later feedback can refine them.

## Packages and service

- Core reads explicit logbook roots and returns one shared model. It calls no provider API or Git command, takes no lock and writes no logbook.
- A separate provider-neutral board package owns the command, server, file watchers and optional login setup. It imports only the public core API.
- The server listens only on 127.0.0.1. The default configurable port is 43123. A busy port causes a clear failure; the server never stops another process or changes ports silently.
- A stable installed command supports optional per-user launchd startup. Provider cache changes must not replace the service.
- Tailscale Serve supplies private HTTPS phone access. No Funnel or LAN listener is used. A board secret protects every board, task and event request. Exact allowed hosts protect the browser boundary.
- The initial page contains its content without scripts. File events update an open page. Watch errors show stale data, not an empty board.

Read-only access can still expose private briefs and reports. A private tailnet can include other readers. The owner's PE instruction permits authentication when the review finds a risk. The browser sign-in prompt still needs phone and event-stream verification.

## Approved recorded-data choice

Current tables do not record the current PR head, open PR status or provider identity for every run. A branch name alone does not prove live activity. A reviewed SHA alone does not prove the current remote head.

The state tool adds minimal PR and run evidence records with source, observation time and task association. A separate state/provider writer records evidence. The board stays read-only. Old records without evidence show unknown.

Alternative: keep existing fields and show unknown or inferred values. This preserves honest display but does not complete the requested current-head and activity capability. The owner selected the recommended evidence records.

## Acceptance to preserve

| Requirements | Evidence required |
| --- | --- |
| 1–2 | Provider-neutral multi-root data; no logbook writes, locks or provider calls; escaped agent text. |
| 3–4 | One self-contained script-free export; exact six-column mapping; backlog PRs visible; seven-day Done window. |
| 5–6 | Complete cards and evidence-backed cycles, agents and owner reasons; matching project filters and counts. |
| 7–9 | Dark and light themes, AA contrast, reduced motion, phone order, numbered text board from the same data. |
| 10–11 | Task detail in HTML and text; all views use one shared model with source-qualified task identities. |
| 12–13 | Board/task-only service, no file browsing; event-driven updates, reconnects and explicit stale state. |
| 14–15 | Configurable loopback port, one start command, optional login setup, private HTTPS phone access and stop instructions. |
| 16–17 | Server-independent chat views; every requested board, task and status phrase; owner-text-only parsing and provider capability disclosure. |

Current board history writes, project-list initialization and Git-derived head checks cannot be reused in the new pure reader. Snapshot export is an explicit artifact write, separate from model reads and server operation.

## Verification limits

The design reviews inspected source and official Node, Apple and Tailscale documentation. They did not install a service, change a tailnet, read private logbooks or verify live phone access. The sample pages use invented data. Static checks confirm no scripts or external assets in the new samples. The earlier sample file was not rendered because the browser tool refused local-file URLs. Separate browser tests now exercise the implemented renderer with invented data and blocked network access.

Backend acceptance needs multi-root fixtures, exact-head changes, missing evidence, read-only spies, hostile text, server access checks, watcher replacement, script-free views and a real phone check. Local tests cover these behaviors; phone access and login startup remain unverified.
