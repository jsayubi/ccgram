# Claude Code Remote

Remote notification and control system for Claude Code via Telegram, with file-based IPC and tmux integration.

## Architecture

```
Claude Code Hooks  -->  Hook Scripts  -->  Telegram Bot  -->  User
                         |                     |
                    /tmp/claude-prompts/   tmux send-keys
                    (file-based IPC)       (keystroke injection)
```

**Two hook execution models:**
- **Blocking** (`permission-hook.js`): Sends Telegram message, polls for response file, returns decision via stdout
- **Non-blocking** (`question-notify.js`, `enhanced-hook-notify.js`): Sends notification, returns immediately, bot injects keystrokes via tmux

## Key Files

### Hook Scripts (called by Claude Code)
| File | Hook Type | Model | Purpose |
|------|-----------|-------|---------|
| `permission-hook.js` | PermissionRequest | Blocking | Permission approval via Telegram buttons |
| `question-notify.js` | PreToolUse (AskUserQuestion) | Non-blocking | Question notifications with option buttons |
| `enhanced-hook-notify.js` | Stop, Notification | Non-blocking | Status notifications (completed/waiting) with response text from transcript (HTML formatted) |
| `claude-hook-notify.js` | (legacy) | Non-blocking | Multi-channel notification fallback |

### Core Modules
| File | Purpose |
|------|---------|
| `workspace-telegram-bot.js` | Long-polling Telegram bot, handles callbacks, commands, and smart routing |
| `prompt-bridge.js` | File-based IPC via `/tmp/claude-prompts/` (pending/response JSON) |
| `workspace-router.js` | Maps workspace names to tmux sessions, prefix resolution, default workspace, message tracking |
| `claude-remote.js` | Main CLI entry point (`notify`, `test`, `status`, `config`, etc.) |
| `smart-monitor.js` | Tmux pane monitoring for completion/waiting detection |

### Config & Data
| Path | Purpose |
|------|---------|
| `.env` | Bot tokens, chat IDs, SMTP config (from `.env.example`) |
| `config/default.json` | Default settings (language, sounds) |
| `config/channels.json` | Channel definitions (Telegram, LINE, Email, Desktop) |
| `src/data/session-map.json` | Workspace-to-tmux session mapping |
| `src/data/default-workspace.json` | Persisted default workspace for `/use` command |
| `src/data/message-workspace-map.json` | Telegram message_id → workspace mapping for reply-to routing (24h TTL) |
| `src/data/project-history.json` | Persistent project usage history `{ name: { path, lastUsed } }` — merged with directory scan results |
| `/tmp/claude-prompts/` | Runtime IPC directory (auto-cleaned after 5 min) |

## Hook Output Formats

**CRITICAL: Each hook type uses a DIFFERENT format. Always verify against docs.**

### PermissionRequest (permission-hook.js)
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": { "behavior": "allow" | "deny" }
  }
}
```

### PreToolUse (question-notify.js)
No stdout output — intentionally omitted so Claude Code shows the interactive question UI.
If `permissionDecision: "allow"` is returned, Claude Code bypasses the question UI entirely.

## IPC Flow (Permission)

1. `permission-hook.js` receives stdin JSON from Claude Code
2. Generates promptId, writes `pending-<id>.json` to `/tmp/claude-prompts/`
3. Sends Telegram message with inline keyboard buttons
4. Polls for `response-<id>.json` (500ms interval, 90s timeout)
5. Bot receives callback, writes `response-<id>.json` with `{ action: "allow"|"deny"|"always" }`
6. Hook reads response, outputs decision to stdout
7. Claude Code reads stdout and applies decision

## IPC Flow (Question / AskUserQuestion)

1. `permission-hook.js` exits silently for AskUserQuestion (no stdout), so Claude Code shows the combined question/permission UI in the terminal
2. `question-notify.js` sends Telegram message(s) with option buttons (no stdout output, 2s delay so permission UI renders first)
3. User taps an option in Telegram → bot injects arrow Down keys + Enter via tmux (selects answer AND grants permission in one action)
4. For multi-question flows: last question's callback sends an extra Enter to submit the preview/confirmation step
5. Pending files include `isLast` flag to track the final question in a batch

## Telegram Bot Commands

- `/<workspace> <message>` - Send command to workspace session (supports prefix matching)
- `/use <workspace>` - Set default workspace for plain text routing (prefix matching supported)
- `/use` - Show current default workspace
- `/use clear` / `/use none` - Clear default workspace
- `/compact [workspace]` - Compact context in workspace (injects `/compact` slash command)
- `/new [project]` - Start Claude in a project directory (shows recent projects if no arg; scans ~/projects/ and ~/tools/ directories, merges with history, pins `assistant` and `claude-remote` at top)
- `/sessions` - List active sessions (shows default workspace)
- `/status [workspace]` - Show tmux pane output (HTML formatted, defaults to default workspace)
- `/stop [workspace]` - Interrupt running prompt (sends Ctrl+C to tmux)
- `/cmd <TOKEN> <command>` - Direct token-based command
- `/help` - Show help

### Smart Routing

**Prefix matching**: Workspace names can be abbreviated — `/ass hello` matches `assistant`. If the prefix is ambiguous (matches multiple workspaces), the bot lists the matches.

**Default workspace**: `/use assistant` sets a default. Plain text messages (no `/` prefix) route to the default workspace automatically.

**Reply-to routing**: Replying to any bot notification (permission, question, or status) routes the reply text to that notification's workspace. All hooks track their sent `message_id` in `src/data/message-workspace-map.json`.

**Routing priority** (in `processMessage()`):
1. Built-in commands: `/help`, `/start`, `/sessions`, `/status`, `/stop`, `/use`, `/compact`
2. `/new [project]` — start Claude in a project directory
3. `/cmd TOKEN command` — direct token routing
4. `/<workspace> command` — prefix-resolved workspace routing
5. `/<workspace>` (bare) — prefix-resolved status
6. Plain text with reply-to a tracked message — route to that workspace
7. Plain text with default workspace set — route there
8. Plain text fallback — show help hint

**Typing indicator**: After injecting a command, the bot sends a repeating `sendChatAction: typing` every 4.5s. It stops when: the hook removes the signal file (`src/data/typing-<workspace>`), the user sends a new message, or the 5-minute safety timeout expires.

## Callback Data Format

Telegram inline keyboard callbacks use: `type:promptId:action`
- `perm:<id>:allow|deny|always` - Permission responses (writes response file)
- `opt:<id>:N` - Question option N (injects arrow Down keys + Enter via tmux)
- `qperm:<id>:N` - Combined permission+question (writes permission response + delayed keystroke injection)
- `new:<projectName>` - Start Claude session in a project directory

## Development

### Service Management
The bot runs as a launchd service (`~/Library/LaunchAgents/com.claude.remote.plist`) with `KeepAlive: true`.

```bash
# Restart bot
launchctl kickstart -k gui/$(id -u)/com.claude.remote

# View bot logs
tail -f logs/bot-stdout.log

# View permission hook debug log
tail -f logs/permission-hook-debug.log
```

### Hook Settings (in ~/.claude/settings.json)
```json
{
  "hooks": {
    "PermissionRequest": [{ "hooks": [{ "type": "command", "command": "node .../permission-hook.js", "timeout": 120 }] }],
    "PreToolUse": [{ "matcher": "AskUserQuestion", "hooks": [{ "type": "command", "command": "node .../question-notify.js", "timeout": 5 }] }]
  }
}
```

### Important Gotchas
- Do NOT use `process.exit(0)` after writing to stdout in hooks - it truncates pipe buffers. Let the process exit naturally.
- Always destroy `process.stdin` in hooks to prevent the event loop from hanging.
- PermissionRequest uses `decision.behavior`, PreToolUse uses `permissionDecision` - they are DIFFERENT formats.
- **AskUserQuestion special case**: PermissionRequest hook MUST exit silently (no stdout) for AskUserQuestion. Returning `"allow"` causes Claude Code to auto-complete the question with empty answers. The question/permission UI is combined — arrow keys + Enter both selects the answer and grants permission.
- **PreToolUse for AskUserQuestion**: Do NOT output `permissionDecision: "allow"` — it bypasses the interactive question UI entirely.
- The `readStdin()` pattern needs a 500ms timeout with `stdin.destroy()` and double-resolve guard.
- Telegram callback_data has a 64-byte limit - keep `type:id:action` format compact.

### Testing
- `permission-hook-simple-test.js` - Immediate "allow" response, for isolating hook format issues
- `test-telegram-notification.js` - Tests Telegram API connectivity
- `test-real-notification.js` - Tests actual notification flow
