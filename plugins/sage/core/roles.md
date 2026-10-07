# Shared child instructions

`renderRoleInstructions(role, bindings)` renders the operating instructions for
one child role. Core owns the common text in `roles/`. Providers supply packaged
worktree, project-guidance, and delivery instructions where the template needs
them. An unknown role or missing binding is an error. Bindings are trusted
package data, not task fields or a way for an agent to choose its authority.

The shared roles are lead, implementer, PE, designer, arena judge, code reviewer,
security reviewer, UX reviewer, and QA. `renderChiefInstructions(bindings)` renders the shared chief workflow with
separate packaged provider bindings. It does not register a child role. The lead text describes the approved task workflow; it does
not add a lead registration or nested hooks to another provider.

`renderReportInstructions(bindings)` provides the common report fields and
evidence rules. A provider supplies its own report-gate statement. Instructions
alone do not enforce completion, accept a report, or release capacity.

The build resolves specialist and report markers in provider sources. Provider
frontmatter retains its own tool restrictions, model settings, and skill list.
Moving the shared text preserves all eight existing specialist files and the
report skill in the Claude build byte for byte.

The chief build marker keeps the existing Claude agent byte for byte. The Codex
chief document is prepared text only: no hook currently loads it. Its bindings
state which build routes are available and keep unsupported routes stopped.
They leave automatic merges off and do not inherit another provider's models,
logbook path, or standing approval to change branch protection. An owner adapter
must verify policy, state access, and lifecycle handling before it activates this text.
