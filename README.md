<div align="center">

# CCGram

**Control Claude Code from Telegram — approve permissions, answer questions, and manage AI sessions from your phone.**

[![CI](https://github.com/jsayubi/ccgram/actions/workflows/ci.yml/badge.svg)](https://github.com/jsayubi/ccgram/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/ccgram)](https://www.npmjs.com/package/ccgram)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

</div>

---

CCGram is a self-hosted Telegram bot that bridges Claude Code to your phone. When Claude needs a permission, has a question, or finishes a task — you get a Telegram message with inline buttons to respond. You never need to be at your keyboard.

```
Claude Code  →  ccgram hooks  →  Telegram bot  →  📱 your phone
     ↑                                ↓
     └──── tmux or PTY injection ─────┘
```

## Features

- **Permission approvals** — Allow, Deny, or Always allow with a single tap
- **Question answering** — Select from Claude's options via inline buttons (single and multi-select)
- **Smart notifications** — Task completions, session start/end, and subagent activity — silent when you're at your terminal, instant when you're away
- **Remote command routing** — Send any command to any Claude session from Telegram
- **Session management** — List, switch between, and interrupt active sessions
- **Project launcher** — Start Claude in any project directory with `/new myproject`
- **Smart routing** — Prefix matching, default workspace, reply-to routing
- **Typing indicator** — See when the bot is waiting for Claude to respond
- **tmux optional** — Falls back to a headless PTY session (`node-pty`) when tmux is unavailable
- **One-command setup** — Interactive wizard installs hooks, generates service file, starts bot

## Requirements

- [Node.js](https://nodejs.org) 18+
- A Telegram bot token (from [@BotFather](https://t.me/BotFather))
- Your Telegram chat ID (from [@userinfobot](https://t.me/userinfobot))
- [tmux](https://github.com/tmux/tmux/wiki) _(optional — falls back to headless PTY via `node-pty` when absent)_

## Quick Start

```bash
npx ccgram init
```

The setup wizard will:
1. Ask for your bot token and chat ID
2. Install the bot to `~/.ccgram/`
3. Merge the required hooks into `~/.claude/settings.json`
4. Generate and start a background service (launchd on macOS, systemd on Linux)

Then open Telegram and message your bot — Claude Code will now notify you remotely.

## How It Works

CCGram integrates with [Claude Code hooks](https://docs.anthropic.com/en/docs/claude-code/hooks) — shell scripts that Claude Code calls at key moments. Each hook script sends a Telegram message and, when you respond, injects keystrokes back into the tmux session running Claude.

### Hooks installed

| Hook | Event | What it does |
|------|-------|-------------|
| `permission-hook.js` | `PermissionRequest` | Sends a permission dialog with Allow / Deny / Always buttons. Blocks Claude until you respond. |
| `question-notify.js` | `PreToolUse` (AskUserQuestion) | Sends Claude's question with selectable options. Your tap injects the selection via tmux/PTY. |
| `enhanced-hook-notify.js completed` | `Stop` | Notifies you when Claude finishes a task, including the last response text. |
| `enhanced-hook-notify.js waiting` | `Notification` | Notifies you when Claude is waiting for input. |
| `user-prompt-hook.js` | `UserPromptSubmit` | Tracks terminal activity so notifications are suppressed when you're actively working. |
| `enhanced-hook-notify.js session-start` | `SessionStart` | Notifies you when a new Claude session starts. |
| `enhanced-hook-notify.js session-end` | `SessionEnd` | Notifies you when a Claude session ends, with the final response. |
| `enhanced-hook-notify.js subagent-done` | `SubagentStop` | Notifies you when a subagent task completes. |

> **Smart suppression** — all notifications (including permissions) are automatically silenced when you've sent a message to Claude within the last 5 minutes. The moment you step away, Telegram takes over. Telegram-injected commands always get their response back to Telegram regardless.

### Permission flow

```
Claude requests permission
  → hook generates promptId, writes pending file
  → Telegram message with inline buttons sent to your phone
  → you tap Allow / Deny
  → bot writes response file
  → hook reads response, returns decision to Claude
  → Claude continues
```

### Question flow

```
Claude asks a question (AskUserQuestion)
  → Claude shows question UI in terminal
  → question-notify sends options to Telegram
  → you tap an option
  → bot injects arrow keys + Enter via tmux or PTY
  → Claude's question UI captures the keystrokes
```

## Bot Commands

### Session management

| Command | Description |
|---------|-------------|
| `/sessions` | List all active Claude sessions with status and age |
| `/use <workspace>` | Set default workspace — plain text messages route there |
| `/use` | Show current default workspace |
| `/use clear` | Clear the default workspace |

### Workspace control

| Command | Description |
|---------|-------------|
| `/<workspace> <command>` | Send a command to a specific Claude session |
| `/status [workspace]` | Show the last 20 lines of tmux pane output |
| `/stop [workspace]` | Send Ctrl+C to interrupt the running prompt |
| `/compact [workspace]` | Run `/compact` and wait for it to complete |

### Project launcher

| Command | Description |
|---------|-------------|
| `/new` | Show recent projects as buttons |
| `/new myproject` | Start Claude in `~/projects/myproject` (or wherever it's found) |

The `/new` command searches your configured `PROJECT_DIRS`, finds exact or prefix-matched directories, creates a tmux session (or PTY session if tmux is unavailable), starts Claude, and sets it as the default workspace.

### Smart routing

**Prefix matching** — workspace names can be abbreviated. `/ass hello` routes to `assistant` if it's unique. Ambiguous prefixes show a list to choose from.

**Reply-to routing** — reply to any bot notification (permission, question, or status message) to route your reply to that workspace.

**Default workspace** — after `/use myproject`, plain text messages route there automatically.

## Configuration

CCGram is configured via `~/.ccgram/.env`. Run `ccgram init` to generate it interactively, or edit it manually:

```bash
# Required
TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=your_bot_token_here
TELEGRAM_CHAT_ID=your_chat_id_here

# Project directories to scan (for /new command and session listing)
PROJECT_DIRS=~/projects,~/tools

# Suppress notifications when you're actively at the terminal
# Default: 300 seconds (5 minutes). Set to 0 to always notify.
ACTIVE_THRESHOLD_SECONDS=300
```

### Advanced options

```bash
# Allow only specific Telegram user IDs (comma-separated)
TELEGRAM_WHITELIST=123456789,987654321

# Use webhooks instead of long-polling (requires public URL)
TELEGRAM_WEBHOOK_URL=https://example.com/webhook
TELEGRAM_WEBHOOK_PORT=3001

# Force IPv4 for Telegram API (useful on some VPS providers)
TELEGRAM_FORCE_IPV4=false

# Tmux keystroke injection mode
INJECTION_MODE=tmux   # tmux (default) or pty

# Custom session map path
SESSION_MAP_PATH=~/.ccgram/src/data/session-map.json

# Logging
LOG_LEVEL=info        # debug, info, warn, error
```

## Service Management

`ccgram init` generates and starts a background service automatically.

### macOS (launchd)

```bash
# Restart
launchctl kickstart -k gui/$(id -u)/com.ccgram

# Stop / Start
launchctl stop com.ccgram
launchctl start com.ccgram

# Logs
tail -f ~/.ccgram/logs/bot-stdout.log
tail -f ~/.ccgram/logs/bot-stderr.log
```

### Linux (systemd)

```bash
sudo systemctl status ccgram
sudo systemctl restart ccgram
journalctl -u ccgram -f
```

## Installation Details

`ccgram init` installs the bot to `~/.ccgram/` — a persistent directory that survives `npx` cleanup and system updates. The hooks in `~/.claude/settings.json` always point to this location.

```
~/.ccgram/
├── dist/                    # Compiled JavaScript (hook scripts + bot)
├── config/                  # Default config templates
├── src/data/
│   ├── session-map.json     # Workspace → tmux session mapping
│   ├── default-workspace.json
│   ├── project-history.json # Recent projects for /new
│   └── message-workspace-map.json   # reply-to routing (24h TTL)
├── logs/
│   ├── bot-stdout.log
│   └── bot-stderr.log
└── .env                     # Your configuration
```

## Development

```bash
git clone https://github.com/jsayubi/ccgram
cd ccgram
npm install
cp .env.example .env         # Add your bot token and chat ID
npm run build
node dist/workspace-telegram-bot.js
```

```bash
npm run build          # Compile TypeScript → dist/
npm run build:watch    # Watch mode
npm test               # Run 57 tests (vitest)
```

**Note:** Claude Code hooks run from `~/.ccgram/dist/`, not the repo's `dist/`. After changing hook scripts during development, sync them:

```bash
cp -r dist/ ~/.ccgram/dist/
```

End users don't need this — `ccgram init` handles it automatically.

### Architecture

```
src/
├── utils/
│   ├── active-check.ts        # Detect terminal activity; suppress notifications when present
│   ├── pty-session-manager.ts # Headless PTY backend via node-pty (tmux fallback)
│   ├── callback-parser.ts     # Parse Telegram callback_data strings
│   ├── http-request.ts        # Lightweight HTTPS wrapper (no axios)
│   ├── optional-require.ts    # Graceful optional dependency loading
│   └── paths.ts               # PROJECT_ROOT + CCGRAM_HOME constants
├── types/                     # TypeScript interfaces
└── data/                      # Runtime data (session map, history)

workspace-telegram-bot.ts      # Main bot (long-polling, routing, callbacks)
workspace-router.ts            # Session map, prefix matching, default workspace
prompt-bridge.ts               # File-based IPC via /tmp/claude-prompts/
permission-hook.ts             # Blocking permission approval hook
question-notify.ts             # Non-blocking question notification hook
enhanced-hook-notify.ts        # Status notification hook (Stop, Notification, SessionStart, SessionEnd, SubagentStop)
user-prompt-hook.ts            # UserPromptSubmit hook — writes terminal activity timestamp
setup.ts                       # Interactive setup wizard
cli.ts                         # ccgram CLI entry point
```

### Tests

```
test/
├── prompt-bridge.test.js     # 15 tests — IPC write/read/update/clean/expiry
├── workspace-router.test.js  # 28 tests — session map, prefix matching, defaults, reply-to
└── callback-parser.test.js   # 14 tests — all callback_data formats
```

Tests use isolated temp directories and run with `npm test` (vitest, no configuration needed).

### Dependencies

**Core:** Only `dotenv` is required. The bot runs on Node.js built-ins.

**Optional** (graceful degradation if missing):
- `express` — webhook servers
- `node-pty` — PTY relay mode
- `nodemailer`, `node-imap`, `mailparser` — email relay
- `pino`, `pino-pretty` — structured logging (falls back to console)

## FAQ

**Do I need a public server?**
No. CCGram uses Telegram's long-polling API — it works behind NAT, on a laptop, or anywhere with outbound HTTPS.

**What if I'm already at my terminal?**
All notifications — including permission requests — are suppressed automatically when you've sent a message to Claude within the last 5 minutes. The threshold is configurable via `ACTIVE_THRESHOLD_SECONDS`. Step away for more than 5 minutes and Telegram instantly takes over.

**Can I use it with multiple projects at once?**
Yes. Each Claude session maps to a named tmux or PTY session. Use `/sessions` to see all active sessions, or `/use <workspace>` to set a default for plain text routing.

**Do I need tmux?**
No. When tmux is not detected, CCGram automatically falls back to headless PTY sessions powered by [`node-pty`](https://github.com/microsoft/node-pty). No configuration required — it activates on its own.

To use PTY mode:
1. Install the optional dependency: `npm install node-pty` inside `~/.ccgram/`
2. PTY activates automatically when `tmux` is not running, or force it explicitly:
   ```bash
   # in ~/.ccgram/.env
   INJECTION_MODE=pty
   ```
3. Restart the bot: `launchctl kickstart -k gui/$(id -u)/com.ccgram` (macOS) or `sudo systemctl restart ccgram` (Linux)

Full remote control — permission approvals, question answering, `/new`, `/stop` — works identically in both modes.

**Is my bot token stored securely?**
The token is stored in `~/.ccgram/.env`, readable only by your user. It's never logged or transmitted beyond Telegram's API.

**What's the 64-byte callback limit?**
Telegram limits inline button callback data to 64 bytes. CCGram uses a compact `type:promptId:action` format to stay within this limit.

## License

MIT — see [LICENSE](LICENSE).

---

<div align="center">

Built for developers who let Claude Code run overnight and want to stay in control from anywhere.

[Report a bug](https://github.com/jsayubi/ccgram/issues) · [Request a feature](https://github.com/jsayubi/ccgram/issues)

</div>
