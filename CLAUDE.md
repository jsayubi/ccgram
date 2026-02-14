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
| `enhanced-hook-notify.js` | Stop, Notification | Non-blocking | Status notifications (completed/waiting) |
| `claude-hook-notify.js` | (legacy) | Non-blocking | Multi-channel notification fallback |

### Core Modules
| File | Purpose |
|------|---------|
| `workspace-telegram-bot.js` | Long-polling Telegram bot, handles callbacks and commands |
| `prompt-bridge.js` | File-based IPC via `/tmp/claude-prompts/` (pending/response JSON) |
| `workspace-router.js` | Maps workspace names to tmux sessions via session-map.json |
| `claude-remote.js` | Main CLI entry point (`notify`, `test`, `status`, `config`, etc.) |
| `smart-monitor.js` | Tmux pane monitoring for completion/waiting detection |

### Config & Data
| Path | Purpose |
|------|---------|
| `.env` | Bot tokens, chat IDs, SMTP config (from `.env.example`) |
| `config/default.json` | Default settings (language, sounds) |
| `config/channels.json` | Channel definitions (Telegram, LINE, Email, Desktop) |
| `src/data/session-map.json` | Workspace-to-tmux session mapping |
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
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow" | "deny" | "ask"
  }
}
```

## IPC Flow (Permission)

1. `permission-hook.js` receives stdin JSON from Claude Code
2. Generates promptId, writes `pending-<id>.json` to `/tmp/claude-prompts/`
3. Sends Telegram message with inline keyboard buttons
4. Polls for `response-<id>.json` (500ms interval, 90s timeout)
5. Bot receives callback, writes `response-<id>.json` with `{ action: "allow"|"deny"|"always" }`
6. Hook reads response, outputs decision to stdout
7. Claude Code reads stdout and applies decision

## IPC Flow (Question)

1. `question-notify.js` sends Telegram message with option buttons
2. Returns `"allow"` immediately (non-blocking)
3. Bot receives callback, injects option number via `tmux send-keys -t SESSION 'N' C-m`

## Telegram Bot Commands

- `/<workspace> <message>` - Send command to workspace session
- `/sessions` - List active sessions
- `/status <workspace>` - Show tmux pane output
- `/cmd <TOKEN> <command>` - Direct token-based command
- `/help` - Show help

## Callback Data Format

Telegram inline keyboard callbacks use: `type:promptId:action`
- `perm:<id>:allow|deny|always` - Permission responses (writes response file)
- `opt:<id>:N` - Question option N (injects tmux keystroke)

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
- The `readStdin()` pattern needs a 500ms timeout with `stdin.destroy()` and double-resolve guard.
- Telegram callback_data has a 64-byte limit - keep `type:id:action` format compact.

### Testing
- `permission-hook-simple-test.js` - Immediate "allow" response, for isolating hook format issues
- `test-telegram-notification.js` - Tests Telegram API connectivity
- `test-real-notification.js` - Tests actual notification flow
