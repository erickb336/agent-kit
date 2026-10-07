# Codex mode adapter

`updateOwnerMode(input, context, options)` connects native prompt identity, shared phrase rules, and the admission journal. The options are the configured `directory`, `project`, canonical `projectDirectory`, and trusted `sessionsDir`. Configure the admission store before use. Model arguments must not supply these options.

The adapter accepts only a verified root prompt in that exact project directory. It reads native metadata with the bounded identity reader and verifies the current MCP connection version and actor. Unrecognized identity returns `null`; storage and metadata errors throw. The hook entry must turn either failure into an explicit prompt refusal. Do not let a thrown error serve as the refusal.

The first on or off phrase records session identity with its requested initial mode. An initial off stays off and leaves a durable receipt. Later on or off phrases use checked journal transitions. A neutral prompt keeps the saved mode. An exact repeated mode prompt returns current state without reapplying its old state. Conflicting reuse of a mode turn is refused. No prompt text is stored.

Journal session keys have the `codex:` prefix. The project key remains caller-configured. `readMode(directory, project, nativeSession)` reads that exact scope and returns its owner, mode records, and current Sage flag. It grants no tool permission; verify native context at the tool boundary first. Child role and task rights remain separate checks.

The returned autopilot flag is always false for the manual-merge Codex beta. Shared phrase signals remain available for a clear user note. Changing mode does not release held reservations or prove child completion. A root that moves to another project directory requires explicit rebinding; this adapter does not transfer ownership automatically.

The installed manifest does not call this adapter yet. Production transport, role and lifecycle integration remain required before automatic Sage activation.
