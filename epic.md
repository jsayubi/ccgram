# Epic: CCGram Launch Readiness

## Goal
Make CCGram easy to install, reliable across machines, and ready for public GitHub launch.

---

## Story 1: Zero-Failure Install ✅

**As a** developer who found CCGram on GitHub,
**I want** `npm install` to succeed on my machine without needing Python, Xcode, or build tools,
**So that** I can start using the bot in under 2 minutes.

### Context
`node-pty` requires native compilation via `node-gyp`. If Python or build tools are missing, `npm install` fails entirely. The core Telegram bot doesn't use `node-pty` or any npm dependency — it only uses Node.js built-ins (`fs`, `https`, `path`, `child_process`, `crypto`).

### Acceptance Criteria
- [x] `node-pty` moved to `optionalDependencies` (or removed)
- [x] All non-core deps moved to `optionalDependencies` (`dotenv` kept as sole dependency)
- [x] `npm install` succeeds on a clean macOS machine without build tools
- [x] Relay/email/LINE features gracefully check for their deps at runtime and show a helpful error if missing
- [ ] Verified: `git clone && npm install` works on a fresh Linux machine with only Node.js installed

### Tasks
- [x] Restructure `package.json`: `dotenv` as sole dependency, 9 packages to `optionalDependencies`, removed phantom deps (`execa`, `imapflow`)
- [x] Created `src/utils/optional-require.js` shared helper with `optionalRequire()` and `getUUID()` (crypto fallback)
- [x] Add runtime dep guards in 7 files: `relay-pty.js`, `email-listener.js`, `smtp.js`, `telegram.js`, `telegram/webhook.js`, `line.js`, `line/webhook.js`
- [x] Pino fallback logger in `relay-pty.js` for when pino/pino-pretty are unavailable
- [ ] Test clean install on Linux

---

## Story 2: Obvious Entry Point ✅

**As a** new user,
**I want** a single `npm start` command to run the bot,
**So that** I don't have to guess which of the 8 scripts in `package.json` to run.

### Context
Current scripts: `setup`, `config`, `daemon:start`, `daemon:stop`, `daemon:status`, `relay:pty`, `relay:start`, `telegram`, `line`, `webhooks`. No `start`. A new user cloning the repo has no idea which one launches the Telegram bot.

### Acceptance Criteria
- [x] `npm start` launches the Telegram bot
- [ ] README Quick Start says `npm start`
- [x] Bot prints a clear startup message: `CCGram v1.0.0 — Starting Telegram bot (long polling)...`

### Tasks
- [x] Add `"start": "node workspace-telegram-bot.js"` to `package.json` scripts
- [x] Add startup banner log with version from `package.json`

---

## Story 3: No Crash on Fresh Clone ✅

**As a** user running CCGram for the first time,
**I want** the bot to start without errors,
**So that** I don't have to debug missing directories or files.

### Context
`src/data/` is gitignored. On a fresh clone, the directory doesn't exist. The first `fs.writeFileSync('src/data/session-map.json', ...)` throws `ENOENT` and crashes.

### Acceptance Criteria
- [x] `src/data/` is auto-created on startup if missing
- [x] `src/data/.gitkeep` exists in the repo so git tracks the empty directory
- [x] `/tmp/claude-prompts/` is auto-created by prompt-bridge if missing (already existed)
- [x] Bot starts cleanly from a fresh `git clone` with no pre-existing data files

### Tasks
- [x] Add `fs.mkdirSync(dataDir, { recursive: true })` to bot `start()` function
- [x] `workspace-router.js` and `prompt-bridge.js` already create dirs before writes (verified)
- [x] Add `src/data/.gitkeep` to repo

---

## Story 4: Simple Configuration ✅

**As a** new user,
**I want** to configure the bot by filling in 2 values, not 143 lines,
**So that** I can get started without reading a wall of config options.

### Context
Current `.env.example` is 143 lines with Chinese comments covering Email, LINE, SMTP, IMAP, relay, and Gmail setup. A Telegram user needs exactly: `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.

### Acceptance Criteria
- [x] `.env.example` contains only the 2 required Telegram fields with English comments
- [x] Full config file preserved as `.env.full-example` for power users
- [x] Comments explain how to get each value (BotFather link, userinfobot link)
- [x] Bot validates env vars on startup and prints actionable error if missing

### Tasks
- [x] Create minimal `.env.example` (bot token + chat ID, English, with help links)
- [x] Rename current `.env.example` to `.env.full-example`
- [x] Improved startup validation with BotFather/userinfobot links in error messages
- [ ] Remove Chinese-only comments from all config files (or add English equivalents)

---

## Story 5: One-Command Hook Setup

**As a** new user,
**I want** to set up Claude Code hooks without manually editing JSON files,
**So that** I don't make path errors or miss a required hook.

### Context
Users must manually add 3 hooks to `~/.claude/settings.json` with absolute paths to the CCGram install directory. Getting paths wrong is the #1 setup support question. The existing `setup.js` handles this but needs updating for the new hook files.

### Acceptance Criteria
- [x] `npm run setup` generates correct hooks JSON with the user's actual install path
- [x] Setup offers to merge hooks into `~/.claude/settings.json` (with backup)
- [x] Setup validates that tmux is installed and accessible
- [x] Setup verifies the Telegram bot token works (quick API call)
- [ ] README provides a manual copy-paste block as fallback

### Tasks
- [x] Update `setup.js` to generate hooks for `permission-hook.js`, `enhanced-hook-notify.js`, `question-notify.js`
- [x] Add settings.json merge logic with backup (`settings.json.bak`)
- [x] Add tmux check: `which tmux` or `tmux -V`
- [x] Add bot token validation: call `getMe` API and print bot username
- [x] Generate copy-paste hooks JSON block in setup output

---

## Story 6: Correct Engine Requirement

**As a** user with an older Node.js version,
**I want** a clear error telling me to upgrade,
**So that** I don't debug cryptic runtime errors from unsupported APIs.

### Context
`package.json` says `>=14` but `crypto.randomUUID()` (used in `prompt-bridge.js`) requires Node >=19. Node 14 and 16 are EOL. Node 18 is current LTS.

### Acceptance Criteria
- [ ] `engines.node` set to `>=18.0.0`
- [ ] Bot checks Node version on startup and prints clear upgrade message if too old
- [ ] All Node.js APIs used are available in Node 18+

### Tasks
- [ ] Update `engines.node` to `>=18.0.0` in `package.json`
- [ ] Audit codebase for APIs requiring Node >18 (e.g., `crypto.randomUUID` is 19+, may need polyfill or replace with `uuid` module)
- [ ] Add version check at top of `workspace-telegram-bot.js`

---

## Story 7: Updated Package Identity

**As a** user or contributor,
**I want** `package.json` to reflect CCGram, not the upstream fork,
**So that** it's clear this is a distinct project.

### Context
Package name is still `claude-code-remote`, repo URL points to upstream, description mentions "Smart Notification System", author is "Claude-Code-Remote Team".

### Acceptance Criteria
- [ ] Package name: `ccgram`
- [ ] Description: "Control Claude Code from Telegram"
- [ ] Author: correct
- [ ] Repository URL: `github.com/jsayubi/ccgram`
- [ ] Homepage: `https://ccgram.com`
- [ ] Keywords updated for discoverability

### Tasks
- [ ] Update `name`, `description`, `author`, `repository`, `bugs`, `homepage` in `package.json`
- [ ] Update `keywords`: `ccgram`, `claude-code`, `telegram-bot`, `remote-control`, `ai-coding`, `developer-tools`, `claude`, `anthropic`
- [ ] Commit `package-lock.json` for reproducible installs

---

## Story 8: Basic Test Coverage

**As a** contributor,
**I want** tests for core modules,
**So that** I can submit PRs without accidentally breaking existing functionality.

### Context
No test framework. Only ad-hoc scripts (`test-telegram-notification.js`, `test-injection.js`). Core modules like `prompt-bridge.js`, `workspace-router.js`, and the callback parser have no automated tests.

### Acceptance Criteria
- [ ] Test framework installed (Vitest — zero config, fast)
- [ ] Unit tests for `prompt-bridge.js`: write/read/update/clean cycle
- [ ] Unit tests for `workspace-router.js`: session mapping, prefix matching, expiry
- [ ] Unit tests for callback parser: `opt:id:1`, `opt-submit:id`, `perm:id:allow`
- [ ] `npm test` runs all tests
- [ ] CI runs tests on push

### Tasks
- [ ] Add `vitest` as devDependency
- [ ] Write tests for `prompt-bridge.js` (5-8 tests)
- [ ] Write tests for `workspace-router.js` (5-8 tests)
- [ ] Write tests for callback data parsing (5-6 tests)
- [ ] Add `"test": "vitest run"` to `package.json`
- [ ] Update GitHub Actions CI to run tests

---

## Story 9: Cross-Platform Compatibility

**As a** Linux user,
**I want** CCGram to work on my Ubuntu/Debian server,
**So that** I can run it on my dev server alongside Claude Code.

### Context
Currently tested only on macOS. `launchd` is macOS-only. Some paths may be macOS-specific. Linux users need `systemd` service instructions or a simple process manager alternative.

### Acceptance Criteria
- [ ] Bot runs on macOS and Linux (Ubuntu 22+, Debian 12+)
- [ ] README includes Linux setup instructions (systemd unit file or `pm2`)
- [ ] No macOS-specific paths hardcoded in shared code
- [ ] tmux dependency is clearly documented (required on all platforms)

### Tasks
- [ ] Audit codebase for macOS-specific paths or commands
- [ ] Create `ccgram.service` systemd unit file template
- [ ] Add Linux section to README Quick Start
- [ ] Test on Ubuntu (fresh VM or Docker)
- [ ] Document tmux installation: `brew install tmux` (macOS), `apt install tmux` (Linux)

---

## Story 10: Clean Codebase for Open Source

**As a** potential contributor browsing the repo,
**I want** a clean, well-organized codebase,
**So that** I can understand the project and feel confident contributing.

### Context
Upstream fork has legacy files, Chinese-only comments in config, test scripts mixed with source code, and unused channel implementations that add complexity.

### Acceptance Criteria
- [ ] No personal tokens, paths, or credentials in any committed file
- [ ] All user-facing strings and comments in English (i18n files can remain multilingual)
- [ ] Test scripts moved to `test/` directory
- [ ] Unused or legacy files removed (`.backup` files, old scripts)
- [ ] Clear separation: core bot files at root, channels in `src/channels/`, relay in `src/relay/`

### Tasks
- [ ] Security audit: scan for tokens, API keys, personal paths in all committed files
- [ ] Move test scripts to `test/` directory
- [ ] Remove unused legacy files (identify via git log)
- [ ] Add English comments to all config files
- [ ] Verify `.gitignore` covers: `.env`, `logs/`, `src/data/*.json`, `/tmp/`, `*.log`

---

## Story 11: TypeScript Migration

**As a** maintainer and contributor,
**I want** the codebase to use TypeScript,
**So that** type errors are caught at compile time instead of at runtime in production.

### Context
The codebase is 100% JavaScript with no type annotations. The main bot file alone is 1,100+ lines. Real bugs have already been caused by type mismatches — the workspace name mismatch (bot created `typing-assistant`, hook returned `claude-remote`) would have been caught by a typed `workspace: string` interface. Callback data parsing, pending file shapes, and tmux session objects are all stringly-typed and fragile.

### Acceptance Criteria
- [ ] All core files converted to TypeScript (`.ts`)
- [ ] Interfaces defined for: pending prompt, session map entry, callback data, workspace config
- [ ] `tsconfig.json` with strict mode enabled
- [ ] Build step outputs CommonJS `.js` to `dist/`
- [ ] `npm start` runs the compiled output
- [ ] Source maps enabled for debugging

### Tasks
- [ ] Add `typescript` and `@types/node` as devDependencies
- [ ] Create `tsconfig.json` (target ES2022, module CommonJS, strict: true, outDir: dist/)
- [ ] Define core interfaces: `PendingPrompt`, `SessionEntry`, `WorkspaceConfig`, `CallbackAction`
- [ ] Convert `prompt-bridge.js` → `prompt-bridge.ts` (smallest, good starting point)
- [ ] Convert `workspace-router.js` → `workspace-router.ts`
- [ ] Convert hook files: `permission-hook.ts`, `enhanced-hook-notify.ts`, `question-notify.ts`
- [ ] Convert `workspace-telegram-bot.js` → `workspace-telegram-bot.ts`
- [ ] Add `"build": "tsc"` and update `"start": "node dist/workspace-telegram-bot.js"`
- [ ] Update CI to include build step

### Key Types to Define
```typescript
interface PendingPrompt {
  type: 'permission' | 'question';
  workspace: string;
  tmuxSession: string;
  options?: string[];
  multiSelect?: boolean;
  selectedOptions?: boolean[];
  questionText?: string;
  isLast?: boolean;
}

interface SessionEntry {
  tmuxSession: string;
  project: string;
  cwd: string;
  lastActive: number;
}

type CallbackAction =
  | { type: 'perm'; promptId: string; action: 'allow' | 'deny' }
  | { type: 'opt'; promptId: string; optionIndex: number }
  | { type: 'opt-submit'; promptId: string };
```

---

## Story 12: Structured Logging

**As a** user debugging an issue,
**I want** consistent, filterable log output,
**So that** I can quickly find what went wrong without reading walls of unstructured text.

### Context
The core bot uses `console.log` and `console.error` with ad-hoc formatting. Hook scripts write to stderr. `pino` is in `package.json` but only used by upstream relay code, not by the core Telegram bot or hooks.

### Acceptance Criteria
- [ ] All log output goes through a single logger module
- [ ] Log levels: `debug`, `info`, `warn`, `error`
- [ ] `LOG_LEVEL` env var controls verbosity (default: `info`)
- [ ] Logs include timestamp, level, and component name (e.g., `[bot]`, `[hook:permission]`)
- [ ] Debug mode shows tmux commands, API calls, file IPC details
- [ ] Production mode is clean and quiet (only errors and important events)

### Tasks
- [ ] Create `src/logger.js` — lightweight wrapper (no external deps needed, use `console` with formatting)
- [ ] Replace all `console.log`/`console.error` in `workspace-telegram-bot.js` with logger
- [ ] Replace all `console.error` in hook files with logger
- [ ] Add component tags: `bot`, `hook:perm`, `hook:notify`, `hook:question`, `router`, `bridge`
- [ ] Add `LOG_LEVEL` to `.env.example` with comment

---

## Story 13: Replace Axios with Native Fetch

**As a** maintainer,
**I want** to use Node.js built-in `fetch` instead of `axios`,
**So that** I can remove an external dependency and keep the stack lean.

### Context
`axios` is only used by upstream relay/channel code — the core bot already uses native `https` for Telegram API calls. Node 18+ has stable global `fetch`. Removing `axios` eliminates one more install-time dependency and reduces `node_modules` size.

### Acceptance Criteria
- [ ] All `axios` usage replaced with native `fetch` or `https`
- [ ] `axios` removed from `package.json`
- [ ] All HTTP calls have proper error handling and timeouts
- [ ] No behavior changes in API interactions

### Tasks
- [ ] Audit all `axios` imports (currently in relay and channel files)
- [ ] Replace with `fetch` (Node 18+ global) or existing `https` helper
- [ ] Add request timeout handling (AbortController with setTimeout)
- [ ] Remove `axios` from `package.json`
- [ ] Test all HTTP-dependent features

---

## Story 14: Consolidate Duplicate Dependencies

**As a** maintainer,
**I want** to remove redundant packages,
**So that** the dependency tree is clean and there are no conflicting implementations.

### Context
- **`node-imap`** (last updated 2017, unmaintained) and **`imapflow`** (actively maintained, modern async API) both do IMAP. Only one is needed.
- **`execa`** is used for child process execution, but Node's built-in `child_process.execSync` / `exec` handles all current use cases in the core bot.
- **`uuid`** is used for ID generation, but `crypto.randomUUID()` (Node 19+) or a simple `crypto.randomBytes(16).toString('hex')` (Node 14+) would suffice.

### Acceptance Criteria
- [ ] `node-imap` removed, `imapflow` is the single IMAP library
- [ ] `uuid` usage replaced with `crypto.randomUUID()` (already done in `prompt-bridge.js`)
- [ ] `execa` evaluated — keep only if its features (better error handling, piping) are actually needed
- [ ] No duplicate functionality across remaining deps

### Tasks
- [ ] Remove `node-imap` from `package.json`
- [ ] Update `src/relay/relay-pty.js` and `src/relay/email-listener.js` to use `imapflow`
- [ ] Audit `execa` usage — replace with `child_process` if only basic exec is needed
- [ ] Audit `uuid` usage — replace with `crypto.randomUUID()` where possible
- [ ] Run `npm ls --all` and check for unnecessary transitive deps

---

## Story 15: NPM Publishing / npx Support

**As a** developer,
**I want** to install CCGram with `npm install -g ccgram` or run `npx ccgram init`,
**So that** I don't need to clone a repo and manage updates manually.

### Context
Currently the only install method is `git clone`. Publishing to npm enables one-command install, automatic updates via `npm update`, and `npx` for zero-install setup. Since the core bot has zero npm deps, the published package would be very lightweight.

### Acceptance Criteria
- [ ] `ccgram` package published to npm registry
- [ ] `npx ccgram init` runs interactive setup
- [ ] `npx ccgram start` starts the bot
- [ ] `npx ccgram hooks` prints the Claude hooks JSON for copy-paste
- [ ] Package size under 100KB (no `node_modules` bundled)
- [ ] Version follows semver

### Tasks
- [ ] Add `"bin": { "ccgram": "./cli.js" }` to `package.json`
- [ ] Create `cli.js` entry point with subcommands: `init`, `start`, `hooks`, `status`
- [ ] Set `"files"` array to include only necessary files (exclude tests, docs, examples)
- [ ] Register `ccgram` name on npm
- [ ] Add `"prepublishOnly": "npm test"` script
- [ ] Set up npm publish workflow in GitHub Actions

---

## Story 16: Health Check & Status Endpoint

**As a** user running CCGram as a background service,
**I want** a way to check if the bot is healthy,
**So that** I can monitor it and get alerts if it stops working.

### Context
The bot runs as a long-polling process. If the Telegram API connection drops or the process hangs, there's no external way to detect it. A simple HTTP health endpoint would enable monitoring via uptime tools, systemd watchdog, or custom scripts.

### Acceptance Criteria
- [ ] Optional HTTP health endpoint on configurable port (default: disabled)
- [ ] Returns: uptime, last poll time, active workspaces, pending prompts count
- [ ] `HEALTH_PORT` env var to enable (e.g., `HEALTH_PORT=8080`)
- [ ] Works with standard monitoring tools (returns 200 OK with JSON)

### Tasks
- [ ] Add lightweight HTTP server (Node built-in `http`, no express needed)
- [ ] Track last successful Telegram poll timestamp
- [ ] Expose `/health` endpoint with status JSON
- [ ] Add `HEALTH_PORT` to `.env.full-example`
- [ ] Return 503 if last poll was >60s ago (stale connection)

---

## Priority Order

| Priority | Story | Effort | Impact |
|----------|-------|--------|--------|
| P0 | ~~Story 1: Zero-Failure Install~~ | ~~1 hour~~ | ✅ Done |
| P0 | ~~Story 2: Obvious Entry Point~~ | ~~10 min~~ | ✅ Done |
| P0 | ~~Story 3: No Crash on Fresh Clone~~ | ~~15 min~~ | ✅ Done |
| P0 | ~~Story 4: Simple Configuration~~ | ~~30 min~~ | ✅ Done |
| P1 | Story 5: One-Command Hook Setup | 2 hours | Biggest remaining friction |
| P1 | Story 6: Correct Engine Requirement | 30 min | Prevents cryptic errors |
| P1 | Story 7: Updated Package Identity | 15 min | Correct branding |
| P1 | Story 14: Consolidate Duplicate Deps | 1 hour | Clean dep tree |
| P2 | Story 8: Basic Test Coverage | 3 hours | Contributor confidence |
| P2 | Story 9: Cross-Platform Compatibility | 2 hours | Expands audience |
| P2 | Story 10: Clean Codebase | 2 hours | Professional impression |
| P2 | Story 12: Structured Logging | 2 hours | Debuggability |
| P2 | Story 13: Replace Axios with Fetch | 1 hour | Remove external dep |
| P3 | Story 11: TypeScript Migration | 2-3 days | Long-term maintainability |
| P3 | Story 15: NPM Publishing / npx | 3 hours | Zero-clone install |
| P3 | Story 16: Health Check Endpoint | 1 hour | Production monitoring |

P0 stories (1-4) can be done in an afternoon and cover 80% of the install friction.
