# Codex event records

This module stores native identity observations for the Codex adapter. It is a foundation for automatic Sage support. No installed hook calls it yet.

The supported input is the captured Codex 0.160.0 hook format. The caller must verify the runtime version. A supplied version string alone is not proof. The caller must read and validate the child metadata from the native transcript before it calls `decodeEvent`.

The module retains only identity fields. It does not retain commands, briefs, conversation text, timestamps, or credentials.

## Publication and reading

Use a separate canonical directory for each root session. All directory components must be real directories, without symbolic links. On POSIX, use the resolved temporary directory in tests.

`publish` validates and encodes a record, syncs a private temporary file, and publishes it through a hard link. An identical duplicate is safe. A conflicting existing file causes an error. Each record has its own name, derived from its content. Newly created directory entries and published records receive filesystem sync calls.

`readObservations` streams the directory and reads each published record within a fixed byte bound. It rejects changed hashes, unknown fields, links, non-files, and excessive entries. A partial unpublished file has a separate name and does not count as evidence. It still counts toward the scan limit. This module never removes abandoned files or old records automatically.

These operations require a local filesystem with hard links and directory sync. Tests cover macOS. The filesystem tests do not simulate power loss. The containing directory must remain controlled by the caller. This API is not a security boundary against another process that can replace its ancestor directories or remove its records.

## Identity and capacity

`bindings` joins a spawn request, its successful result, and a child start by exact identity. It validates the root session, call, actor, parent path, child, and task path. The observations can arrive in any order. Repeated identical observations do not add another child.

The returned `dispatches` also pair message and followup requests with their exact successful tool replies. Each accepted row keeps the sender, parent call, parent turn, mode, and declared target. Pending and conflicting details remain in the stored observations. A declared relative name or UUID is not a resolved child binding. Unknown result shapes are rejected. Message text is never retained.

An accepted dispatch is not proof that the child consumed its input or started a particular turn. Native checks show that an idle child can retain a message and receive it alongside a later task. Dispatch rows stay unattributed, and their presence keeps the snapshot unresolved. A stop cannot clear them. Future task and queue reconciliation must supply that evidence.

Missing records remain pending. Conflicting records and ambiguous path reuse remain unresolved. An empty set also remains unresolved. A snapshot can omit a concurrent new record; readers must not treat this snapshot as a transaction that reserves capacity.

Every reservation remains held, including after a child stop. A stop records a child turn; it does not prove an accepted report or that later work is absent. This module grants no permission, starts no agent, and releases no capacity.

The next adapter work must establish authoritative session initialization, atomic capacity reservations, later-task attribution, report acceptance, failure recovery, interruption, and restart. Integrate that policy before enabling automatic Sage hooks.
