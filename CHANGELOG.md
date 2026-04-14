# Changelog

All notable changes to CCGram are documented here.

## [1.2.0] - 2026-04-14

The biggest release yet. Universal terminal support, eight new hook integrations, a completely rewritten `/status`, and a sweep of critical hook-format fixes that were silently breaking question answering.

### Headline features

- **Direct question answering — no more keystroke injection.** `AskUserQuestion` answers now flow back to Claude Code through the `updatedInput` hook output, so Telegram answers land in any terminal: tmux, Ghostty, bare zsh, screen, anything. The AppleScript / tmux-send-keys path for questions is gone.
- **Ghostty integration.** `src/utils/ghostty-session-manager.ts` adds full Ghostty support via AppleScript — auto-detected when `TERM_PROGRAM=ghostty`. Keystroke injection, tab focus, and command routing all work the same as tmux. macOS only.
- **Rich `/status` command.** Completely rewritten using Claude Code's transcript JSONL. Now shows model, Claude Code version, git branch, session ID + slug, context window usage with auto-detected 1M mode, rate limit + reset time, last activity timestamp, and the last assistant message snippet. Works for **every** terminal type — Ghostty, tmux, PTY, bare.
- **Deep links.** New `/link <prompt>` command generates `claude-cli://open?q=...` URLs that open Claude Code anywhere with your prompt pre-filled.

### Eight new hook events

| Hook                 | What it gives you                                                       |
|----------------------|-------------------------------------------------------------------------|
| `PermissionDenied`   | Telegram retry button when auto-mode blocks a tool                      |
| `PreCompact`         | Block context compaction with one tap                                   |
| `PostCompact`        | Confirms compaction completed, with token savings                       |
| `Elicitation`        | Forwards MCP server input requests to Telegram (schema-aware, per-field) |
| `StopFailure`        | Instant alerts on API errors and rate limits                            |
| `TaskCreated`        | Notify when Claude creates a task                                       |
| `CwdChanged`         | Track when Claude changes working directory                             |
| `InstructionsLoaded` | Debug aid for CLAUDE.md / rules loading                                 |

### New Telegram commands

- `/link <prompt>` — generate a Claude Code deep link
- `/effort [workspace] low|medium|high` — set thinking effort
- `/model [workspace] <model>` — switch model (sonnet, opus, haiku)

### Permission improvements

- **Defer button** on permission prompts pauses the session for async approval (resume later with `claude --resume`)
- **Session title** support in permission and notification messages

### Rate limit visibility

- Hook payloads' `rate_limits` field now extracted and stored per-session in `session-map.json`
- `/status` displays current usage, percent, and reset time when available

### Conditional hooks

- Claude Code v2.1.85+ `if` field (jq expression) supported in `setup.ts` `HOOK_DEFINITIONS` for conditional hook execution — reduces unnecessary spawning

### Critical fixes

Four hook scripts had silently-malformed stdout shapes that Claude Code was ignoring without any error log. All audited against the official docs and corrected:

- **`question-notify.ts`** — was outputting `{questions: [{question, answer}]}` (an invented format). Now correctly echoes the original `questions` array plus a separate `answers` map keyed by question text, with `hookEventName: "PreToolUse"`. Multi-select answers join labels with commas. Symptom was "I answered in Telegram, then the question also popped up in the terminal."
- **`pre-compact-notify.ts`** — had `decision: "block"` nested inside `hookSpecificOutput`. Per spec, `decision` belongs at the top level. Block button now actually blocks compaction.
- **`permission-denied-notify.ts`** — was missing required `hookEventName: "PermissionDenied"`. Retry button now actually retries.
- **`elicitation-notify.ts`** — had a completely invented shape. Now parses MCP `requested_schema.properties` from stdin, prompts the user once per field via Telegram, and emits the proper `{action: "accept", content: {<field>: <value>}}`. Timeout/send failure now emits `action: "cancel"` instead of hanging the MCP tool call. Also corrected payload field name (`mcp_server_name` → was reading `mcp_server`).

### Other improvements

- Removed stale `!pending.tmuxSession` check from the `opt:` and `opt-submit:` callback handlers (leftover from the pre-`updatedInput` keystroke-injection era; was silently dropping responses in bare-terminal sessions)
- `enhanced-hook-notify.ts` extracts `last_assistant_message` directly from hook payloads (Claude Code v2.1.47+) with JSONL fallback for older versions
- Added `logger.info` on response writes for easier debugging
- Test suite grew from 84 → 120 tests across 6 suites (added `deep-link.test.js`, `ghostty-session-manager.test.js`, expanded `workspace-router.test.js` and `callback-parser.test.js`)

### Upgrade

```bash
npx @jsayubi/ccgram@latest init
```

The wizard merges the new hook entries into `~/.claude/settings.json` and refreshes `~/.ccgram/dist/`. Existing config (`.env`, session map, project history) is preserved.

**Full changelog:** https://github.com/jsayubi/ccgram/compare/v1.1.1...v1.2.0

---

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
