# Separate provider packages

Sage has one shared implementation of its principles, logbook rules and board, with separate Claude Code and Codex plugins. Each installed plugin is self-contained. Neither plugin contains the other provider's hooks, launcher, manifest or role instructions.

This change implements the first Codex milestone: skills, advice hooks and manual logbook commands. It does **not** enable Sage's chief workflow in Codex. The lifecycle investigation remains in [draft PR #55](https://github.com/erickb336/sage/pull/55).

## Source and install boundaries

| Source package | Responsibility | Install output |
| --- | --- | --- |
| `packages/sage-core` | Principle selection, change fingerprints, task routes, findings, review verdicts, merge eligibility, locking and board rendering | Identical `core/` files bundled in each plugin |
| `packages/sage-claude` | Claude event translation, launcher, orchestration hooks, agents, commands, model defaults and storage default | `plugins/sage` |
| `packages/sage-codex` | Codex event translation, native manifest, manual logbook skill and storage default | `plugins/sage-codex` |

Providers import the public `sage-core` entry point. Core never imports either provider. `createStateTool` creates an instance with a default-root function, allowed models and model defaults; it does not change process environment or share mutable provider configuration. The board receives that instance's operations, replacing the previous circular module imports.

`applyPrinciples` accepts a small normalized event and returns added context or a stop decision. Each adapter owns native field names and response JSON. Codex only sends advice events; it never invokes the shared stop gate.

The root's `principles/`, `writing/`, `preferences/` and pinned `upstream/pstack/` remain the authoring inputs for core's shared skills. `scripts/build.mjs` generates them once, then assembles both outputs. These inputs belong with `sage-core` when repositories split. Claude roles stay in the Claude source package until Codex can use and enforce them; there is no copied Codex role set to maintain.

Each provider pins core's exact version in its package manifest. Build checks the pin, resolves only the public import to the bundled `core/index.mjs`, includes both MIT licenses and writes a version record in `build.json`. No npm install, network lookup or second plugin is needed at runtime. Generated plugin files are committed so existing marketplace installs work directly from Git.

The existing Claude marketplace name, plugin name, source path and command paths stay stable. The Codex marketplace now points to `plugins/sage-codex`. An installer may still fetch the whole Git repository while downloading a plugin. Separate distribution repositories or release archives are needed to isolate those downloaded bytes as well.

## Feature scope

| Capability | Claude Code | Codex initial milestone |
| --- | --- | --- |
| Principles and writing skills | Existing behavior | 29 skills, including manual Sage entry |
| Design/refactor advice | Existing behavior | `UserPromptSubmit` |
| Test/document/README advice | Existing behavior | Every `apply_patch` header, including move destinations |
| Commit advice | Existing behavior | Native hook tool name `Bash` |
| Failed-check advice | Existing behavior | Disabled: shell hook output is not a reliable exit status |
| Stop gate and compaction recovery | Existing behavior | Disabled pending native captures |
| Manual logbook and board | Shared core | Shared core |
| Chief, roles, agent caps, report gates, edit/Git enforcement, autopilot | Existing behavior | Not exposed or enabled |

Codex's patch decoder selects advice; it is not a write authorization parser. Unknown tools/events produce no result. Advice state is partitioned by provider and a hash of session/child identity. Concurrent advice callbacks can repeat a hint; no capacity or authorization decision depends on that state.

Claude keeps its current models and `CLAUDE_CONFIG_DIR` / `~/.claude/sage` default. Codex accepts only `inherit` and uses `CODEX_HOME` / `~/.codex/sage`. `SAGE_HOME` remains an explicit override. There is no automatic migration or mixed-provider orchestration. The data format, project keys, task rules and locking stay shared. Error examples use neutral `sage/t1` branch names; existing branch names remain valid.

## Try the Codex package

Requires Node.js 20 or later. Native discovery was checked with Codex CLI **0.159.2** on Linux and **0.160.0** on macOS. A discovery check does not prove native hook delivery. Treat this as an initial preview until a fresh install and real session pass on the target machine.

From a checkout of this branch, first build:

```sh
npm run build
```

Register the local marketplace from that checkout:

```sh
codex plugin marketplace add .
```

Install its Codex entry:

```sh
codex plugin add sage@sage
```

Start a new Codex session with its hook features enabled:

```sh
codex --enable codex_hooks --enable plugin_hooks
```

Review and trust Sage's hook commands through Codex's hook controls when requested. Sage does not bypass hook trust or change global configuration itself. Use the `sage` skill for manual logbook commands. A design request or a patch to a test file should add principle context once per session/child. Check this in the target client before relying on automatic advice; skills and manual commands remain usable separately.

The native `.codex-plugin/plugin.json` is intentional. In release `rust-v0.159.2`, a portable root manifest discovers skills but the loader excludes its hooks. `plugin/read` verified 29 skills and both hooks after switching to the native manifest. See the release's [plugin manager](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/core-plugins/src/manager.rs) and [loader](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/core-plugins/src/loader.rs).

## Verification and release gates

Run `npm run build`, `npm run check` and `npm test`. The existing suite exercises Claude's runtime paths. New tests execute both assembled plugins from isolated copies, run their logbook/board commands, check model and data-root separation, exercise Codex hooks as subprocesses, and cover multi-file/move advice, unknown input, disabled hooks and child-state isolation. Package checks reject stale or unexpected files. CI runs the check before the tests, without rebuilding first. A regression test changes only the generated Claude hook and verifies that the check fails.

When merging changes authored before this extraction, carry each change into its new source before building. Claude hook and skill changes belong under `packages/sage-claude/`; shared state and board changes belong under `packages/sage-core/`. Building from old package sources would overwrite a change made only under `plugins/sage/`. This branch includes the main-branch mode fixes through PR #54 and the earlier PR #33 hook fix.

For read-only native discovery, with a Codex binary on PATH:

```sh
npm run check:codex
```

Or set `SAGE_CODEX_BIN` to its absolute path for this command. This check asks the app server to read the local plugin and verifies the complete skill inventory and both hook declarations. It installs nothing and starts no model turn. The environment's full Codex session startup stalled in the earlier probe even with hooks disabled, so native event delivery, hook trust, fresh installation and compaction remain unverified. Do not treat discovery plus subprocess tests as an end-to-end runtime pass.

Full Codex Sage mode still needs verified failed-spawn reconciliation, child-turn correlation across later work, interruption/closure handling, prompt provenance and persistent capacity accounting. Keep it unavailable until those gates pass; do not add guessed leases, transcript inference or a supervisor to hide missing runtime evidence.

## Future repository split

Move the packages to `sage-core`, `sage-claude` and `sage-codex`. Move the shared authoring inputs and their generator with core; the current root build is the monorepo assembly step. Publish a versioned core artifact with its generated skills and public API, replace the local assembly input with that pinned artifact, and keep the provider outputs the same. Providers continue to bundle core so users install one plugin. Add release checks for each provider against its pinned core and deliberately update the pin when adopting core changes.

This change adds no provider registry, daemon, plugin-to-plugin runtime dependency, third-party npm dependency or model-name translation table. Extraction moves the existing state and board implementation; provider-specific code remains at the boundary.
