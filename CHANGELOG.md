# Changelog

All notable changes to CCGram are documented here.

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
