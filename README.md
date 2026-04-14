<div align="center">

# CCGram

**Control Claude Code from Telegram — approve permissions, answer questions, resume sessions, and manage AI coding agents from your phone.**

[![CI](https://github.com/jsayubi/ccgram/actions/workflows/ci.yml/badge.svg)](https://github.com/jsayubi/ccgram/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@jsayubi/ccgram)](https://www.npmjs.com/package/@jsayubi/ccgram)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

</div>

---

CCGram is a self-hosted Telegram bot that bridges Claude Code to your phone. When Claude needs a permission, has a question, or finishes a task — you get a Telegram message with inline buttons to respond. Resume past conversations, start new sessions, and manage multiple AI coding agents — all without being at your keyboard.

```
Claude Code  →  ccgram hooks  →  Telegram bot  →  📱 your phone
     ↑                                ↓
     └─ updatedInput / tmux / Ghostty / PTY ─┘
```

## Features

- **Universal terminal support** — Works with tmux, Ghostty, bare zsh, screen — anything. Question answers flow back to Claude Code directly via the `updatedInput` hook output, no keystroke injection needed.
- **Permission approvals** — Allow, Deny, Always, or Defer with a single tap
- **Question answering** — Single-select, multi-select, and free-text questions answered via Telegram buttons
- **Rich `/status`** — Model, version, git branch, session ID, context window % (auto-detects 1M mode), rate limit + reset time, last activity, last assistant message — all from Claude Code's transcript
- **MCP elicitation forwarding** — Schema-aware MCP server input requests routed to Telegram, one prompt per form field
- **Smart notifications** — Task completions, errors, compaction, session lifecycle, subagent activity — silent at your terminal, instant when you're away
- **Remote command routing** — Send any command to any Claude session from Telegram
- **Session management** — List, switch, interrupt; resume past conversations with `/resume`
- **Project launcher** — Start Claude in any project directory with `/new myproject`
- **Deep links** — `/link <prompt>` generates `claude-cli://open?q=...` URLs
- **Smart routing** — Prefix matching, default workspace, reply-to routing
- **Ghostty support** — Auto-detected on macOS via `TERM_PROGRAM=ghostty`; full keystroke injection via AppleScript
- **tmux optional** — Falls back to a headless PTY session (`node-pty`) when tmux is unavailable
- **One-command setup** — Interactive wizard installs hooks, generates service file, starts bot

## Requirements

- [Node.js](https://nodejs.org) 18+
- A Telegram bot token (from [@BotFather](https://t.me/BotFather))
- Your Telegram chat ID (from [@userinfobot](https://t.me/userinfobot))
- A terminal — any of:
  - [tmux](https://github.com/tmux/tmux/wiki) (recommended; cross-platform)
  - [Ghostty](https://ghostty.org) (auto-detected on macOS via `TERM_PROGRAM`)
  - bare zsh / screen / anything else (PTY fallback via `node-pty`)

## Quick Start

```bash
npx @jsayubi/ccgram init
```

The setup wizard will:
1. Ask for your bot token and chat ID
2. Install the bot to `~/.ccgram/`
3. Merge the required hooks into `~/.claude/settings.json`
4. Generate and start a background service (launchd on macOS, systemd on Linux)

Then open Telegram and message your bot — Claude Code will now notify you remotely.

## How It Works

CCGram integrates with [Claude Code hooks](https://docs.anthropic.com/en/docs/claude-code/hooks) — shell scripts that Claude Code calls at key moments. Hooks send Telegram messages and, depending on the event, return your response to Claude Code directly via stdout (`updatedInput` for questions, `decision` for permissions) or inject keystrokes into the active session (tmux, Ghostty, or PTY).

### Hooks installed

| Hook | Event | What it does |
|------|-------|-------------|
| `permission-hook.js` | `PermissionRequest` | Sends a permission dialog with Allow / Deny / Always / Defer buttons. Blocks Claude until you respond. |
| `question-notify.js` | `PreToolUse` (AskUserQuestion) | Sends Claude's question with selectable options. Returns answer directly via `updatedInput` — works with any terminal. |
| `enhanced-hook-notify.js completed` | `Stop` | Notifies you when Claude finishes a task, including the last response text. |
| `enhanced-hook-notify.js waiting` | `Notification` | Notifies you when Claude is waiting for input. |
| `user-prompt-hook.js` | `UserPromptSubmit` | Tracks terminal activity so notifications are suppressed when you're actively working. |
| `enhanced-hook-notify.js session-start` | `SessionStart` | Notifies you when a new Claude session starts. |
| `enhanced-hook-notify.js session-end` | `SessionEnd` | Notifies you when a Claude session ends. |
| `enhanced-hook-notify.js subagent-done` | `SubagentStop` | Notifies you when a subagent task completes. |
| `permission-denied-notify.js` | `PermissionDenied` | Notifies when auto mode blocks a tool. Retry button lets you override. |
| `enhanced-hook-notify.js stop-failure` | `StopFailure` | Notifies you on API errors (rate limits, network issues). |
| `enhanced-hook-notify.js post-compact` | `PostCompact` | Notifies when context compaction completes, with token savings. |
| `pre-compact-notify.js` | `PreCompact` | Warns before compaction starts. Block button lets you preserve context. |
| `elicitation-notify.js` | `Elicitation` | Forwards MCP server input requests to Telegram. Reply with your answer. |
| `enhanced-hook-notify.js task-created` | `TaskCreated` | Notifies when Claude creates a new task. |
| `enhanced-hook-notify.js cwd-changed` | `CwdChanged` | Notifies when Claude changes working directory. |
| `enhanced-hook-notify.js instructions-loaded` | `InstructionsLoaded` | Notifies when CLAUDE.md or rules are loaded. |

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
  → question-notify sends options to Telegram
  → you tap an option
  → bot writes response file with your selection
  → hook returns answer via updatedInput to Claude
  → Claude receives answer directly (works with any terminal!)
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
| `/status [workspace]` | Rich status: model, version, branch, session ID, context %, rate limit, last activity, last message (and recent pane output for tmux/PTY) |
| `/stop [workspace]` | Send Ctrl+C to interrupt the running prompt |
| `/compact [workspace]` | Run `/compact` and wait for it to complete |
| `/effort [workspace] low\|medium\|high` | Set Claude's thinking effort level |
| `/model [workspace] <model>` | Switch Claude model (sonnet, opus, haiku) |
| `/link <prompt>` | Generate a deep link to open Claude Code with your prompt |

### Project launcher

| Command | Description |
|---------|-------------|
| `/new` | Show recent projects as buttons |
| `/new myproject` | Start Claude in `~/projects/myproject` (or wherever it's found) |

The `/new` command searches your configured `PROJECT_DIRS`, finds exact or prefix-matched directories, creates a tmux session (or PTY session if tmux is unavailable), starts Claude, and sets it as the default workspace.

### Resume past conversations

| Command | Description |
|---------|-------------|
| `/resume` | Show projects with past Claude sessions |
| `/resume myproject` | Jump straight to session picker for that project |

The `/resume` command reads directly from Claude Code's session storage (`~/.claude/projects/`), giving you access to your full conversation history — not just sessions started through the bot.

Each session shows a snippet of the first message for easy identification. Sessions are sorted by last activity.

**Active session protection:**
- If a session appears to be running in a terminal (JSONL file modified within 5 min), you get a warning before resuming to prevent dual-instance conflicts
- If a PTY session is running, you're warned that it will be terminated (PTY sessions can't be reattached)
- tmux sessions switch seamlessly — the bot injects `/exit` + `claude --resume` inline, keeping your terminal connected

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
npm test               # Run 120 tests (vitest)
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
│   ├── active-check.ts            # Detect terminal activity; suppress notifications when present
│   ├── pty-session-manager.ts     # Headless PTY backend via node-pty (tmux fallback)
│   ├── ghostty-session-manager.ts # Ghostty AppleScript backend (macOS, auto-detected)
│   ├── transcript-reader.ts       # Read Claude Code session JSONL for /status (model, context %, last message)
│   ├── deep-link.ts               # Generate claude-cli://open?q=... URLs for /link
│   ├── callback-parser.ts         # Parse Telegram callback_data strings
│   ├── http-request.ts            # Lightweight HTTPS wrapper (no axios)
│   ├── optional-require.ts        # Graceful optional dependency loading
│   └── paths.ts                   # PROJECT_ROOT + CCGRAM_HOME constants
├── types/                         # TypeScript interfaces
└── data/                          # Runtime data (session map, history)

workspace-telegram-bot.ts          # Main bot (long-polling, routing, callbacks, /status, /link, /effort, /model)
workspace-router.ts                # Session map, prefix matching, default workspace, rate limit storage
prompt-bridge.ts                   # File-based IPC via /tmp/claude-prompts/
permission-hook.ts                 # Blocking permission approval hook
permission-denied-notify.ts        # PermissionDenied hook with retry button
question-notify.ts                 # Blocking AskUserQuestion hook (returns updatedInput to Claude Code)
enhanced-hook-notify.ts            # Status notifications (Stop, Notification, SessionStart/End, SubagentStop, StopFailure, PostCompact, TaskCreated, CwdChanged, InstructionsLoaded)
pre-compact-notify.ts              # PreCompact hook with block button
elicitation-notify.ts              # MCP elicitation hook (schema-aware, per-field)
user-prompt-hook.ts                # UserPromptSubmit hook — writes terminal activity timestamp
setup.ts                           # Interactive setup wizard
cli.ts                             # ccgram CLI entry point
```

### Tests

```
test/
├── prompt-bridge.test.js          # 15 tests — IPC write/read/update/clean/expiry
├── workspace-router.test.js       # 43 tests — session map, prefix matching, defaults, reply-to, history, rate limits
├── callback-parser.test.js        # 27 tests — all callback_data formats (perm, opt, new, rp, rs, rc, perm-denied, pre-compact)
├── active-check.test.js           #  8 tests — terminal activity detection, thresholds
├── deep-link.test.js              # 11 tests — claude-cli:// URL generation, encoding, character limits
└── ghostty-session-manager.test.js # 16 tests — Ghostty AppleScript session management (mocked)
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

**Can I resume a conversation I started in the terminal?**
Yes. `/resume` reads from Claude Code's own session storage, so it sees every conversation — not just ones started through the bot. If the session is still running in your terminal, you'll get a warning before resuming to prevent conflicts.

**Do I need tmux?**
No. CCGram supports three injection backends and picks the right one automatically:
- **tmux** (default when running) — cross-platform, recommended
- **Ghostty** — auto-detected on macOS via `TERM_PROGRAM=ghostty`; uses AppleScript for keystroke injection and tab focus
- **PTY** (`node-pty`) — headless fallback when neither tmux nor Ghostty is available

For question answering specifically (the `AskUserQuestion` hook), CCGram returns answers to Claude Code directly via the `updatedInput` hook output — so it works on **any** terminal, including bare zsh, screen, or anything else, without keystroke injection at all.

To force a specific backend:
```bash
# in ~/.ccgram/.env
INJECTION_MODE=pty   # or tmux
```

Then restart the bot: `launchctl kickstart -k gui/$(id -u)/com.ccgram` (macOS) or `sudo systemctl restart ccgram` (Linux).

To use PTY mode, install the optional dependency: `npm install node-pty` inside `~/.ccgram/`.

Full remote control — permission approvals, question answering, `/new`, `/stop` — works identically in all modes.

**Is my bot token stored securely?**
The token is stored in `~/.ccgram/.env`, readable only by your user. It's never logged or transmitted beyond Telegram's API.

**What's the 64-byte callback limit?**
Telegram limits inline button callback data to 64 bytes. CCGram uses a compact `type:promptId:action` format to stay within this limit.

## License

MIT — see [LICENSE](LICENSE).

---

<div align="center">

Built for developers who run Claude Code unattended — approve permissions, resume conversations, and manage AI coding agents from anywhere.

[Report a bug](https://github.com/jsayubi/ccgram/issues) · [Request a feature](https://github.com/jsayubi/ccgram/issues)

</div>
