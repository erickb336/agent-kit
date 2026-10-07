# Shared command reader

`shellCommands(text)` reads shell text into commands, words, redirections,
heredoc bodies, and links between pipes and substitutions. `programsRun(text,
cwd, path)` uses that structure to identify program words and resolve literal
executable paths. Neither function executes the supplied text or starts a process.

This is the existing Claude reader, moved without parser changes. The Claude
hook imports it through the public core entry point and keeps its exported
functions. If the shared reader is unavailable, recognized command tools receive
an explicit denial. Non-command events keep their existing handling.

Both provider bundles include the reader. Sharing it does not make it a complete
shell interpreter or command policy. It does not expand variables, inspect script
contents, or implement PowerShell grammar. Existing wrapper and quoting behavior
remains unchanged. The queued PowerShell, brace/glob, and command-policy issues
remain separate. A Codex tool adapter must identify the actual command fields
and shell before applying the appropriate policy; parsing alone grants no permission.
