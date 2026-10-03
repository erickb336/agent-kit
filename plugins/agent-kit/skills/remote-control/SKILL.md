---
name: remote-control
description: "Set up Remote Control, so that the user can follow, steer and start Claude Code sessions from the Claude app on a phone. It turns Remote Control on for every new session, and it can run a server in a folder (such as ~/workspace) that starts at each login. Use when the user asks to reach sessions or start new ones from a phone, or to set up, check or undo Remote Control. Claude Code only."
license: MIT
---

# Remote Control by default

This skill makes Claude Code sessions reachable from the Claude app on the user's phone. It is for Claude Code only: Codex has no Remote Control.

| Argument | What it does |
| --- | --- |
| `on` (the default) | Turns Remote Control on for every new session. |
| `off` | Turns it off for new sessions. |
| `status` | Shows the setting. Changes nothing. |
| `server <folder>` | Runs a Remote Control server in the folder, now and at each login (macOS). The user can then start new sessions from the phone. Each session opens in that folder. |
| `server off` | Stops the server and removes its login item. |
| `server status` | Shows the server's state, its folder and its last log lines. |

## Steps

1. Read the user's argument. With no argument, use `on`.
2. Run the script with the argument. For example:
   ```bash
   node "${CLAUDE_SKILL_DIR}/remote-control.mjs" server ~/workspace
   ```
3. If the script fails, give the user its message and the fix from "When the server does not start". Do not edit the settings or the login item by hand.
4. Tell the user the line that the script printed. Then:
   - for `on`: the change applies to sessions that start after now. Give the step in the desktop app, and say that `server` lets them start sessions from the phone.
   - for `off`: they can turn off the desktop switch in the same place.
   - for `server <folder>`: on the phone, open the Claude app, tap **Code**, choose this computer and start a session. The session opens in the folder and can reach everything in it.

## The step in the desktop app

The script cannot change the desktop app. The user does this once: **Settings → Claude Code → Connect new sessions to Remote Control**.

## When the server does not start

The script waits 8 seconds. If the server stopped, the script removes the login item and prints the server's last message.

| The message says | The fix (the user does it once) |
| --- | --- |
| "must be logged in", or "full-scope login token" | Open the macOS Terminal app, not a terminal inside the Claude app, and run `claude auth login`. A token from the desktop app or from `claude setup-token` does not work for Remote Control. |
| The folder is not trusted | In the Terminal app, run `claude` in the folder, answer Yes to the trust question, then `/exit`. |

Then run `server <folder>` again.

## What the script changes

- `on` and `off` set `remoteControlAtStartup` in `~/.claude/settings.json`, or in `$CLAUDE_CONFIG_DIR/settings.json`. `/config` uses the same key and file. The script keeps every other setting. It writes nothing when the file is not valid JSON. A project's own settings, or an organisation's policy, can still turn Remote Control off.
- `server` writes the login item `~/Library/LaunchAgents/io.github.erickb336.agent-kit.remote-control.plist`. It runs `claude remote-control` in the folder, with the user's PATH. launchd starts it again if it stops, at most once a minute. The log is `~/Library/Logs/agent-kit-remote-control.log`.

## Limits

- The user needs a Pro, Max, Team or Enterprise plan.
- The computer must be awake and online. If the network is down for about 10 minutes, the server stops, and launchd starts it again.
- All the sessions share the folder. Two sessions that change the same project at the same time can change the same files. In a git repository, a session can work in its own worktree when the user asks for it.
- While the server runs, the user's claude.ai account can start sessions on this computer. `server off` stops that.
