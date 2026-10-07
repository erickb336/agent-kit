# Native hook configuration

`serveConfiguredHooks(file, loadPolicy)` reads one explicit configuration file
before starting the hidden hook server. The installed entry supplies the file
path and the policy loader. Hook requests cannot select either one.

The JSON file has exactly two fields: `version` and `mode`. Version 1 keeps
the mode-only contract. Version 2 adds `observationsRoot` to the mode object.
Both versions require `directory`, `project`, `projectDirectory`, and `sessionsDir`.

- `directory` names an existing admission journal.
- `project` is an identity key already configured in that journal.
- `projectDirectory` names the canonical project checkout.
- `sessionsDir` names the canonical native Codex session directory.
- `observationsRoot` names an existing canonical directory for native event records.
  It must be separate from the admission journal: neither directory can contain
  the other. Event subdirectories would otherwise invalidate the journal.

All paths must be absolute and canonical. The journal and project directories
must already exist. The session directory may be absent under an existing
canonical profile directory: Codex starts MCP before creating this directory.
The reader never creates it. Prompt-time identity checks validate every actual
directory component and the transcript before accepting a request.
The reader refuses symbolic links, non-files, invalid UTF-8, files over 64 KiB,
unknown fields, unknown versions, and unconfigured journals or projects.
It reads state but creates no directory, changes no limit, and resets no mode.
The resulting values stay fixed for the connection; reconnect after a deliberate
configuration change.

A missing or invalid file produces one fixed diagnostic. The server still
returns explicit denials for prompt and tool callbacks. A model cannot repair
configuration by adding paths or code names to its tool arguments.

The launcher and configuration ancestors must remain under the owner's control.
Canonical path checks do not prevent another same-user process from replacing
an ancestor during a read. Setup must preserve Sage's existing project key
algorithm and storage defaults: `CODEX_HOME/sage`, with explicit `SAGE_HOME`
overrides. This module does not infer those choices or install global settings.
No installed manifest uses it yet. Full role policy and lifecycle recovery are
still required before activation.

`serveConfiguredPreparations(file)` starts the separate visible preparation
server from version 2 of the same file. The hidden server passes the complete
frozen configuration to its trusted policy loader. The visible server uses its
journal, project, and observation root. Version 1 cannot start a working
preparation connection because it does not name the event store.

Invalid configuration leaves the visible tool available but every preparation
fails with its fixed public error; no request can repair that connection.
Reconnect both servers after changing the file. Each server takes its own
startup snapshot, so editing the file between their starts can produce different
snapshots. Setup must publish configuration before starting either server and
restart both together. This reader does not coordinate cross-process restarts.
