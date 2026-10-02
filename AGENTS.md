# Working on agent-kit

- **Edit the sources only:** `principles/`, `writing/` and `preferences/`.
  - Never edit a generated file: a skill marked "Generated", or `instructions/core.md`.
  - Run `npm run build`, then `npm run check`. CI runs the check.
- **Principles:**
  - The body is 200 words or fewer.
  - The frontmatter has `id`, `name`, `applyWhen` and `source`.
  - Credit the source.
- **Skills:**
  - Use only the shared frontmatter keys: `name`, `description`, `license`, `allowed-tools`, `metadata`.
  - `name` equals the folder name.
- **Hooks** (`plugins/agent-kit/hooks/`):
  - The hook is hand-written, not generated. It reads each principle's text from its skill.
  - Run `npm test` after a change. The tests run the hook as both tools do.
- **`instructions/core.md`** stays under 8 KiB, because Codex shares a 32 KiB budget with each project's AGENTS.md.
- **Write** at 80% of Simplified Technical English (`writing/ste-80.md`).
