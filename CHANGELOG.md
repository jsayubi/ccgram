# Changelog

All notable changes to CCGram are documented here.

## [1.1.0] - 2026-02-24

### Features
- **`/resume` command** — resume past Claude Code conversations from Telegram, reading directly from Claude Code's session storage (`~/.claude/projects/`)
- **Session picker with snippets** — shows the first user message from each session for easy identification; empty stub sessions (no user messages) are automatically filtered out
- **Smart active-session detection** — warns before resuming a session that appears to be running in a direct terminal (based on JSONL file mtime within 5 minutes), preventing dual-instance conflicts
- **PTY resume warning** — shows confirmation prompt before killing a headless PTY session (which cannot be reattached from terminal)
- **tmux inline session switching** — when switching to a different Claude session in tmux, injects `/exit` + `claude --resume` into the existing session instead of killing it, keeping the user's terminal attached
- **PTY `--resume` support** — `ptySessionManager.spawn()` now accepts CLI args (e.g. `['--resume', '<id>']`)
- **`rc:` callback type** — confirmation flow for destructive resume operations (PTY kill, active-session override)

### Improvements
- Bot command menu now registers on both `all_private_chats` and `default` scopes (fixes menu not appearing when previously set via BotFather)
- `/help` output now includes `/resume` command
- `recordProjectUsage()` tracks session IDs in `project-history.json` (deduped, capped at 5 per project)
- 84 tests across 4 suites (up from 65)

---

## [1.0.2] - 2026-02-23

### Security
- Removed legacy AppleScript GUI automation files (`claude-automation`, `simple-automation`, `command-relay`, `taskping-daemon`) — dead code never used in production that triggered a socket.dev "Obfuscated code" alert due to embedded osascript keystroke injection

---

## [1.0.1] - 2026-02-23

### Security
- Removed `node-imap` from `optionalDependencies` — eliminates a high-severity ReDoS vulnerability chain (`node-imap` → `utf7` → `semver`). Users who need IMAP email relay can still install it manually: `npm install node-imap` inside `~/.ccgram/`

### Fixes
- Renamed package to `@jsayubi/ccgram` (npm blocked `ccgram` due to similarity with existing package `cc-gram`)
- Fixed `vitest.config.js` → `vitest.config.mjs` for ESM compatibility on Node 18
- Fixed invalid JSON in `config/email-template.json` (trailing comments after closing brace)

---

## [1.0.0] - 2026-02-23

Initial public release.

### Features

- **Telegram bot** with long-polling and inline keyboard support
- **PermissionRequest hook** — blocking approval via Telegram buttons (Allow / Deny / Always)
- **AskUserQuestion hook** — single-select and multi-select option buttons injected via tmux/PTY
- **Stop / Notification hooks** — completion and waiting notifications with Claude's last response (Telegram HTML formatted)
- **SessionStart / SessionEnd / SubagentStop hooks** — session lifecycle notifications
- **UserPromptSubmit hook** — terminal activity tracking for smart notification suppression
- **Smart suppression** — notifications silenced when user is actively at the terminal (configurable threshold, default 5 min); always fires when command is Telegram-injected
- **tmux integration** — keystroke injection for command routing and question answering
- **PTY fallback** — headless `node-pty` sessions when tmux is unavailable
- **Workspace routing** — prefix-matched workspace names, default workspace, reply-to routing
- **`/new` command** — start Claude in a project directory with recent-project history
- **`/compact` command** — compact Claude context in any session
- **`/status`, `/stop`, `/sessions`** commands
- **Typing indicator** — repeating `sendChatAction: typing` while a command runs
- **File-based IPC** — `/tmp/claude-prompts/` for permission polling (auto-cleaned after 5 min)
- **macOS launchd** and **Linux systemd** service support
- **`ccgram init`** — automated install: copies dist, writes hooks to `~/.claude/settings.json`, creates launchd/systemd service
- **TypeScript** codebase with 100% CommonJS output; zero required dependencies beyond `dotenv`
- **65 tests** across 4 suites (prompt-bridge, workspace-router, callback-parser, active-check)

### Architecture

- Hook scripts communicate with Claude Code via stdout (blocking) or fire-and-forget (non-blocking)
- Bot and hooks share data via JSON files in `~/.ccgram/src/data/`
- All optional dependencies (express, node-pty, pino, nodemailer) degrade gracefully via `optionalRequire()`
