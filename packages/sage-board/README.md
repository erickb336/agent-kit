# Sage board service

The Sage board shows recorded tasks from explicit Claude and Codex logbook roots. It reads them without changing them.

The service runs independently of a chat session. Browser pages require a sign-in. Chat and offline views use the same task model.

## Start locally

Use Node.js 20 or later. Run these commands from the Sage checkout. Replace the source paths when your provider uses another root.

```sh
node packages/sage-board/cli.mjs board --setup --config "$HOME/.config/sage-board/board.json" --sources "[{\"id\":\"claude\",\"path\":\"$HOME/.claude/sage\"},{\"id\":\"codex\",\"path\":\"$HOME/.codex/sage\"}]" --pages "$HOME/.local/share/sage-board/pages"
node packages/sage-board/cli.mjs board --install --config "$HOME/.config/sage-board/board.json" --install-dir "$HOME/.local/share/sage-board/service" --login-file "$HOME/Library/LaunchAgents/dev.sage.board.plist"
node "$HOME/.local/share/sage-board/service/packages/sage-board/cli.mjs" board --serve --config "$HOME/.config/sage-board/board.json"
```

Open the printed localhost URL. Sign in as `sage`. Use the `secret` value from the private configuration file as the password. Keep that file private.

The default port is 43123. Setup accepts `--port` from 1024 to 65535. A busy port causes an error; the service does not choose another port.

The stable installation copies only board and core sources. It does not depend on a provider plugin cache. Stop the foreground service with Ctrl+C.

## Other views

Use the same command with `--status` for short text, or without a format option for the chat board. A project name selects that project. `T197` selects a task in the current checkout. If two sources contain that task, add `--scope <source/project-key>` from the choices in the error.

Use `--html --out <absolute-path.html>` for an offline file. The command prints its path. The file contains the selected tasks and their details. Each default export gets a fresh filename. An explicit output path refuses to overwrite a file.

## Optional login startup

The install command creates a private launchd file but does not start a service. On macOS, stop the foreground board first. Start login service with `launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/dev.sage.board.plist"`.

Inspect it with `launchctl print "gui/$(id -u)/dev.sage.board"`. Stop it with `launchctl bootout "gui/$(id -u)/dev.sage.board"`. Keep the installed Node executable available at the path recorded in the launchd file.

## Private phone access

Sign in to Tailscale on the Mac and phone. Add the Mac’s exact Tailscale DNS name to `allowedHosts` in the board configuration, then restart the service.

Forward HTTPS with `tailscale serve --bg --https=443 http://127.0.0.1:43123`. Open its printed HTTPS URL on the phone and use the board sign-in.

Use `tailscale serve status` to inspect the forwarding rule. To stop this forwarding rule, use `tailscale serve --bg --https=443 off`.

Use [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve) for private tailnet access. Do not use Funnel or bind the board to a LAN address.

Allow about five minutes for these steps when both devices already have Tailscale set up. This is a planning estimate; installation and sign-in take extra time.

## Limits and verification

The board displays recorded facts. Missing provider, head, completion, or budget evidence stays unknown. Inferred PR counts remain separate from recorded running agents.

Claude owner phrases can request the board and task views. Codex uses the manual skill commands until native owner phrase delivery is verified. The service does not start agent orchestration or autopilot.

Local tests exercise authentication, file updates, task routes, reconnects, offline export, and stable installation. Phone access, login startup, and browser appearance still need direct checks.
