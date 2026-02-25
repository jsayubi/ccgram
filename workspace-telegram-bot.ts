#!/usr/bin/env node

// Node.js version check — must run before anything else
const [major] = process.versions.node.split('.').map(Number);
if (major < 18) {
    console.error(`CCGram requires Node.js >= 18.0.0 (you have ${process.version}).`);
    console.error('Upgrade: https://nodejs.org/ or use nvm: nvm install 18');
    process.exit(1);
}

/**
 * Workspace Telegram Bot — long-polling bot for remote Claude Code control.
 *
 * Commands:
 *   /<workspace> <command>   Route a command to the Claude session in that workspace
 *   /sessions                List all active sessions with workspace names
 *   /cmd <TOKEN> <command>   Token-based fallback for direct session access
 *   /help                    Show available commands
 *   /status [workspace]      Show tmux pane output for a workspace
 *   /stop [workspace]       Interrupt running prompt (Ctrl+C)
 *   /compact [workspace]     Compact context in a workspace session
 */

import path from 'path';
import { PROJECT_ROOT } from './src/utils/paths';
require('dotenv').config({ path: path.join(PROJECT_ROOT, '.env'), quiet: true });

import https from 'https';
import http from 'http';
import fs from 'fs';
import { exec, execSync } from 'child_process';
import {
  resolveWorkspace,
  listActiveSessions,
  readSessionMap,
  pruneExpired,
  extractWorkspaceName,
  isExpired,
  getDefaultWorkspace,
  setDefaultWorkspace,
  trackNotificationMessage,
  getWorkspaceForMessage,
  upsertSession,
  recordProjectUsage,
  getRecentProjects,
  getResumeableProjects,
  getClaudeSessionsForProject,
} from './workspace-router';
import {
  writeResponse,
  readPending,
  updatePending,
  cleanPrompt,
  PROMPTS_DIR,
} from './prompt-bridge';
import { parseCallbackData } from './src/utils/callback-parser';
import { ptySessionManager } from './src/utils/pty-session-manager';
import Logger from './src/core/logger';
import type {
  TelegramMessage,
  TelegramCallbackQuery,
  TelegramUpdate,
  InlineKeyboardMarkup,
  SessionEntry,
  ResolveResult,
  ParsedCallback,
} from './src/types';

const logger = new Logger('bot');

const INJECTION_MODE: string = process.env.INJECTION_MODE || 'tmux';

const TMUX_AVAILABLE: boolean = (() => {
  try { execSync('tmux -V', { stdio: 'ignore' }); return true; } catch { return false; }
})();

const BOT_TOKEN: string | undefined = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID: string | undefined = process.env.TELEGRAM_CHAT_ID;

if (!BOT_TOKEN || BOT_TOKEN === 'YOUR_BOT_TOKEN_HERE') {
  logger.error('TELEGRAM_BOT_TOKEN not configured in .env');
  logger.error('  Get your token from @BotFather: https://t.me/BotFather');
  process.exit(1);
}

if (!CHAT_ID || CHAT_ID === 'YOUR_CHAT_ID_HERE') {
  logger.error('TELEGRAM_CHAT_ID not configured in .env');
  logger.error('  Get your chat ID from @userinfobot: https://t.me/userinfobot');
  process.exit(1);
}

let lastUpdateId: number = 0;
let lastPollTime: number | null = null;   // timestamp of last successful getUpdates call
const startTime: number = Date.now();
const activeTypingIntervals: Map<string, { intervalId: NodeJS.Timeout; timeoutId: NodeJS.Timeout }> = new Map(); // workspace → intervalId

// ── Telegram API helpers ────────────────────────────────────────

function telegramAPI(method: string, body: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const payload: string = JSON.stringify(body);
    const options: https.RequestOptions = {
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: method === 'getUpdates' ? 35000 : 10000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer | string) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (!parsed.ok) {
            reject(new Error(`Telegram API error: ${parsed.description || data}`));
          } else {
            resolve(parsed.result);
          }
        } catch {
          reject(new Error(`Invalid JSON from Telegram: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Telegram request timed out'));
    });

    req.write(payload);
    req.end();
  });
}

function sendMessage(text: string): Promise<unknown> {
  return telegramAPI('sendMessage', {
    chat_id: CHAT_ID,
    text,
    parse_mode: 'Markdown',
  });
}

function sendHtmlMessage(text: string): Promise<unknown> {
  return telegramAPI('sendMessage', {
    chat_id: CHAT_ID,
    text,
    parse_mode: 'HTML',
  });
}

const TYPING_SIGNAL_PATH: string = path.join(PROJECT_ROOT, 'src/data', 'typing-active');

function startTypingIndicator(): void {
  stopTypingIndicator();
  try { fs.writeFileSync(TYPING_SIGNAL_PATH, String(Date.now())); } catch {}
  const tick = (): void => {
    if (!fs.existsSync(TYPING_SIGNAL_PATH)) {
      stopTypingIndicator();
      return;
    }
    telegramAPI('sendChatAction', { chat_id: CHAT_ID, action: 'typing' }).catch(() => {});
  };
  tick();
  const intervalId: NodeJS.Timeout = setInterval(tick, 4500);
  const timeoutId: NodeJS.Timeout = setTimeout(() => stopTypingIndicator(), 5 * 60 * 1000);
  activeTypingIntervals.set('_active', { intervalId, timeoutId });
}

function stopTypingIndicator(): void {
  const entry = activeTypingIntervals.get('_active');
  if (entry) {
    clearInterval(entry.intervalId);
    clearTimeout(entry.timeoutId);
    activeTypingIntervals.delete('_active');
  }
  try { fs.unlinkSync(TYPING_SIGNAL_PATH); } catch {}
}

async function registerBotCommands(): Promise<void> {
  const commands = [
    { command: 'new',      description: 'Start Claude in a project directory' },
    { command: 'resume',   description: 'Resume a past Claude conversation' },
    { command: 'sessions', description: 'List all active Claude sessions' },
    { command: 'use',      description: 'Set or show default workspace' },
    { command: 'status',   description: 'Show current session output' },
    { command: 'stop',     description: 'Interrupt the running prompt' },
    { command: 'compact',  description: 'Compact context in the current session' },
    { command: 'help',     description: 'Show available commands' },
  ];
  try {
    // Set for both scopes: all_private_chats takes priority over default in private chats.
    // If all_private_chats was ever set (e.g. via BotFather), default scope is blocked.
    await telegramAPI('setMyCommands', { commands, scope: { type: 'all_private_chats' } });
    await telegramAPI('setMyCommands', { commands, scope: { type: 'default' } });
    logger.info('Bot commands registered with Telegram');
  } catch (err: unknown) {
    logger.error(`Failed to register bot commands: ${(err as Error).message}`);
  }
}

function answerCallbackQuery(callbackQueryId: string, text?: string): Promise<unknown> {
  return telegramAPI('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text: text || '',
  });
}

function editMessageText(chatId: string, messageId: number, text: string, replyMarkup?: InlineKeyboardMarkup): Promise<unknown> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'Markdown',
  };
  if (replyMarkup) body.reply_markup = replyMarkup;
  return telegramAPI('editMessageText', body);
}

// ── Command handlers ────────────────────────────────────────────

async function handleHelp(): Promise<void> {
  const defaultWs: string | null = getDefaultWorkspace();
  const msg: string = [
    '*Claude Remote Control*',
    '',
    '`/<workspace> <command>` — Send command to workspace',
    '`/use <workspace>` — Set default workspace',
    '`/use` — Show current default',
    '`/use clear` — Clear default',
    '`/compact [workspace]` — Compact context in workspace',
    '`/new [project]` — Start Claude in a project (shows recent if no arg)',
    '`/resume [project]` — Resume a past Claude conversation',
    '`/sessions` — List active sessions',
    '`/status [workspace]` — Show tmux output',
    '`/stop [workspace]` — Interrupt running prompt',
    '`/cmd <TOKEN> <command>` — Token-based fallback',
    '`/help` — This message',
    '',
    '_Prefix matching:_ `/ass hello` matches `assistant`',
    '_Reply-to:_ Reply to any notification to route to that workspace',
    defaultWs ? `_Default:_ plain text routes to *${escapeMarkdown(defaultWs)}*` : '_Tip:_ Use `/use <workspace>` to send plain text without a prefix',
  ].join('\n');

  await sendMessage(msg);
}

async function handleSessions(): Promise<void> {
  pruneExpired();
  const sessions = listActiveSessions();

  if (sessions.length === 0) {
    await sendMessage('No active sessions.');
    return;
  }

  const lines: string[] = sessions.map((s) => {
    const icon: string = sessionIcon(s);
    return `${icon} *${escapeMarkdown(s.workspace)}* (${s.age})`;
  });

  let footer = '';
  const defaultWs: string | null = getDefaultWorkspace();
  if (defaultWs) {
    footer = `\n\n_Default workspace:_ *${escapeMarkdown(defaultWs)}*`;
  }

  await sendMessage(`*Active Sessions*\n\n${lines.join('\n')}${footer}`);
}

async function handleStatus(workspaceArg: string | null): Promise<void> {
  let workspace: string;
  if (workspaceArg) {
    workspace = workspaceArg;
  } else {
    const defaultWs: string | null = getDefaultWorkspace();
    if (defaultWs) {
      workspace = defaultWs;
    } else {
      await sendMessage('Usage: `/status <workspace>` or set a default with `/use`.');
      return;
    }
  }

  const resolved: ResolveResult = resolveWorkspace(workspace);

  if (resolved.type === 'none') {
    await sendMessage(`No active session for *${escapeMarkdown(workspace)}*.`);
    return;
  }

  if (resolved.type === 'ambiguous') {
    const names: string = resolved.matches.map(m => `\`${escapeMarkdown(m.workspace)}\``).join(', ');
    await sendMessage(`Multiple matches: ${names}. Be more specific.`);
    return;
  }

  const match = resolved.match;
  const resolvedName: string = resolved.workspace;
  const tmuxName: string = match.session.tmuxSession;

  try {
    const output: string = await sessionCaptureOutput(tmuxName);
    // Trim and take last 20 lines to avoid message length limits
    const trimmed: string = output.trim().split('\n').slice(-20).join('\n');
    const htmlMsg: string = `<b>${escapeHtml(resolvedName)}</b> session output:\n<pre>${escapeHtml(trimmed)}</pre>`;
    try {
      await sendHtmlMessage(htmlMsg);
    } catch {
      // Fallback to plain text if HTML fails
      await telegramAPI('sendMessage', { chat_id: CHAT_ID, text: `${resolvedName} session output:\n${trimmed}` });
    }
  } catch (err: unknown) {
    await sendMessage(`Could not read session \`${tmuxName}\`: ${(err as Error).message}`);
  }
}

async function handleStop(workspaceArg: string | null): Promise<void> {
  let workspace: string;
  if (workspaceArg) {
    workspace = workspaceArg;
  } else {
    const defaultWs: string | null = getDefaultWorkspace();
    if (defaultWs) {
      workspace = defaultWs;
    } else {
      await sendMessage('Usage: `/stop <workspace>` or set a default with `/use`.');
      return;
    }
  }

  const resolved: ResolveResult = resolveWorkspace(workspace);

  if (resolved.type === 'none') {
    await sendMessage(`No active session for *${escapeMarkdown(workspace)}*.`);
    return;
  }

  if (resolved.type === 'ambiguous') {
    const names: string = resolved.matches.map(m => `\`${escapeMarkdown(m.workspace)}\``).join(', ');
    await sendMessage(`Multiple matches: ${names}. Be more specific.`);
    return;
  }

  const resolvedName: string = resolved.workspace;
  const tmuxName: string = resolved.match.session.tmuxSession;

  if (!await sessionExists(tmuxName)) {
    await sendMessage(`Session \`${tmuxName}\` not found.`);
    return;
  }

  try {
    await sessionInterrupt(tmuxName);
    await sendMessage(`\u26d4 Sent interrupt to *${escapeMarkdown(resolvedName)}*`);
  } catch (err: unknown) {
    await sendMessage(`\u274c Failed to interrupt: ${(err as Error).message}`);
  }
}

async function handleCmd(token: string, command: string): Promise<void> {
  const map = readSessionMap();
  const session: SessionEntry | undefined = map[token];

  if (!session) {
    await sendMessage(`No session found for token \`${token}\`.`);
    return;
  }

  if (isExpired(session)) {
    await sendMessage(`Session \`${token}\` has expired.`);
    return;
  }

  await injectAndRespond(session, command, extractWorkspaceName(session.cwd) as string);
}

async function handleWorkspaceCommand(workspace: string, command: string): Promise<void> {
  const resolved: ResolveResult = resolveWorkspace(workspace);

  if (resolved.type === 'none') {
    await sendMessage(`No active session for *${escapeMarkdown(workspace)}*. Use /sessions to see available workspaces.`);
    return;
  }

  if (resolved.type === 'ambiguous') {
    const names: string = resolved.matches.map(m => `\`${escapeMarkdown(m.workspace)}\``).join(', ');
    await sendMessage(`Multiple matches: ${names}. Be more specific.`);
    return;
  }

  await injectAndRespond(resolved.match.session, command, resolved.workspace);
}

async function handleUse(arg: string | null): Promise<void> {
  // /use — show current default
  if (!arg) {
    const current: string | null = getDefaultWorkspace();
    if (current) {
      await sendMessage(`Default workspace: *${escapeMarkdown(current)}*\n\nPlain text messages will route here. Use \`/use clear\` to unset.`);
    } else {
      await sendMessage('No default workspace set. Use `/use <workspace>` to set one.');
    }
    return;
  }

  // /use clear | /use none — clear default
  if (arg === 'clear' || arg === 'none') {
    setDefaultWorkspace(null);
    await sendMessage('Default workspace cleared.');
    return;
  }

  // /use <workspace> — resolve and set
  const resolved: ResolveResult = resolveWorkspace(arg);

  if (resolved.type === 'none') {
    await sendMessage(`No active session for *${escapeMarkdown(arg)}*. Use /sessions to see available workspaces.`);
    return;
  }

  if (resolved.type === 'ambiguous') {
    const names: string = resolved.matches.map(m => `\`${escapeMarkdown(m.workspace)}\``).join(', ');
    await sendMessage(`Multiple matches: ${names}. Be more specific.`);
    return;
  }

  const fullName: string = resolved.workspace;
  setDefaultWorkspace(fullName);
  await sendMessage(`Default workspace set to *${escapeMarkdown(fullName)}*. Plain text messages will route here.`);
}

async function handleCompact(workspaceArg: string | null): Promise<void> {
  let workspace: string;
  if (workspaceArg) {
    workspace = workspaceArg;
  } else {
    const defaultWs: string | null = getDefaultWorkspace();
    if (defaultWs) {
      workspace = defaultWs;
    } else {
      await sendMessage('Usage: `/compact <workspace>` or set a default with `/use`.');
      return;
    }
  }

  const resolved: ResolveResult = resolveWorkspace(workspace);

  if (resolved.type === 'none') {
    await sendMessage(`No active session for *${escapeMarkdown(workspace)}*. Use /sessions to see available workspaces.`);
    return;
  }

  if (resolved.type === 'ambiguous') {
    const names: string = resolved.matches.map(m => `\`${escapeMarkdown(m.workspace)}\``).join(', ');
    await sendMessage(`Multiple matches: ${names}. Be more specific.`);
    return;
  }

  const tmuxName: string = resolved.match.session.tmuxSession;

  // Inject /compact into tmux
  const injected: boolean = await injectAndRespond(resolved.match.session, '/compact', resolved.workspace);
  if (!injected) return;

  // Two-phase polling to detect compact completion:
  // Phase 1: Wait for "Compacting" to appear (command started processing)
  // Phase 2: Wait for "Compacting" to disappear (command finished)

  let started = false;

  // Phase 1: Wait up to 10s for compact to start
  for (let i = 0; i < 5; i++) {
    await sleep(2000);
    try {
      const output: string = await sessionCaptureOutput(tmuxName);
      if (output.includes('Compacting')) {
        started = true;
        break;
      }
    } catch {
      break;
    }
  }

  if (!started) {
    // Command may have finished very quickly or failed to start
    try {
      const output: string = await sessionCaptureOutput(tmuxName);
      if (output.includes('Compacted')) {
        const lines: string = output.trim().split('\n').slice(-10).join('\n');
        await sendMessage(`\u2705 *${escapeMarkdown(resolved.workspace)}* compact done:\n\`\`\`\n${lines}\n\`\`\``);
      }
    } catch {
      // ignore
    }
    return;
  }

  // Phase 2: Wait up to 60s for "Compacting" to disappear (compact finished)
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    try {
      const output: string = await sessionCaptureOutput(tmuxName);
      if (!output.includes('Compacting')) {
        const lines: string = output.trim().split('\n').slice(-10).join('\n');
        await sendMessage(`\u2705 *${escapeMarkdown(resolved.workspace)}* compact done:\n\`\`\`\n${lines}\n\`\`\``);
        return;
      }
    } catch {
      break;
    }
  }

  // Timeout — show current session state
  try {
    const output: string = await sessionCaptureOutput(tmuxName);
    const trimmed: string = output.trim().split('\n').slice(-5).join('\n');
    await sendMessage(`\u23f3 *${escapeMarkdown(resolved.workspace)}* compact may still be running:\n\`\`\`\n${trimmed}\n\`\`\``);
  } catch {
    // ignore
  }
}

async function handleNew(nameArg: string | null): Promise<void> {
  if (!nameArg) {
    const recent = getRecentProjects(10);
    if (recent.length === 0) {
      const home: string = process.env.HOME as string;
      const dirs = process.env.PROJECT_DIRS
        ? process.env.PROJECT_DIRS.split(',').map(d => d.trim().replace(home, '~')).join(', ')
        : '~/projects, ~/tools';
      await sendMessage(`No project history yet.\n\nUse \`/new <project-name>\` to start.\nSearches: ${dirs}, ~/`);
      return;
    }
    const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
    for (let i = 0; i < recent.length; i += 2) {
      const row = recent.slice(i, i + 2).map(p => ({
        text: p.name,
        callback_data: `new:${p.name}`,
      }));
      keyboard.push(row);
    }
    await telegramAPI('sendMessage', {
      chat_id: CHAT_ID,
      text: '*Start Claude Session*\n\nSelect a project or use `/new <name>`:',
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard },
    });
    return;
  }
  await startProject(nameArg);
}

async function startProject(name: string): Promise<void> {
  const home: string = process.env.HOME as string;

  // 1. Find project directory — exact match first
  const configuredDirs = process.env.PROJECT_DIRS
    ? process.env.PROJECT_DIRS.split(',').map(d => d.trim()).filter(Boolean)
    : [path.join(home, 'projects'), path.join(home, 'tools')];
  const candidates: string[] = [
    ...configuredDirs.map(d => path.join(d, name)),
    path.join(home, name),
  ];
  let projectDir: string | null = null;
  for (const dir of candidates) {
    try { if (fs.statSync(dir).isDirectory()) { projectDir = dir; break; } }
    catch {}
  }

  // 2. If no exact match, prefix match against configured dirs ONLY
  //    (skip ~/ to avoid matching Desktop, Documents, Downloads, Library, etc.)
  if (!projectDir) {
    const searchDirs: string[] = configuredDirs;
    const matches: Array<{ name: string; path: string }> = [];
    for (const base of searchDirs) {
      try {
        const entries = fs.readdirSync(base, { withFileTypes: true });
        for (const e of entries) {
          if (e.isDirectory() && e.name.toLowerCase().startsWith(name.toLowerCase())) {
            matches.push({ name: e.name, path: path.join(base, e.name) });
          }
        }
      } catch {}
    }
    // Deduplicate by name (prefer ~/projects/ over ~/tools/)
    const unique = [...new Map(matches.map(m => [m.name, m])).values()];

    if (unique.length === 1) {
      projectDir = unique[0].path;
      name = unique[0].name;
    } else if (unique.length > 1) {
      // Show matches as inline buttons (max 10)
      const limited = unique.slice(0, 10);
      const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
      for (let i = 0; i < limited.length; i += 2) {
        keyboard.push(limited.slice(i, i + 2).map(m => ({
          text: m.name, callback_data: `new:${m.name}`,
        })));
      }
      await telegramAPI('sendMessage', {
        chat_id: CHAT_ID,
        text: `Multiple matches for *${escapeMarkdown(name)}*:`,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard },
      });
      return;
    }
  }

  if (!projectDir) {
    const searchedPaths = configuredDirs.map(d => d.replace(home, '~')).join(', ') + ', ~/';
    await sendMessage(`Project \`${escapeMarkdown(name)}\` not found.\n\nSearched: ${searchedPaths}`);
    return;
  }

  // 3. Sanitize tmux session name (dots, colons, spaces are invalid in tmux)
  const tmuxName: string = name.replace(/[.:\s]/g, '-');

  // 4. Check existing session (PTY or tmux)
  const alreadyRunning = await sessionExists(tmuxName);
  if (alreadyRunning) {
    upsertSession({ cwd: projectDir, tmuxSession: tmuxName, status: 'waiting', sessionId: null });
    recordProjectUsage(name, projectDir);
    setDefaultWorkspace(name);
    await sendMessage(`Session \`${tmuxName}\` already running.\nSet as default — send messages directly.`);
    return;
  }

  // 5. Create session — PTY or tmux
  const usePty = !TMUX_AVAILABLE || INJECTION_MODE === 'pty';

  if (!usePty) {
    // tmux path (existing behaviour)
    try {
      await tmuxExec(`tmux new-session -d -s "${tmuxName}" -c "${projectDir}"`);
      await sleep(300);
      await tmuxExec(`tmux send-keys -t "${tmuxName}" 'claude' C-m`);
    } catch (err: unknown) {
      await sendMessage(`Failed to start session: ${(err as Error).message}`);
      return;
    }

    upsertSession({ cwd: projectDir, tmuxSession: tmuxName, status: 'starting', sessionId: null, sessionType: 'tmux' });
    recordProjectUsage(name, projectDir);
    setDefaultWorkspace(name);

    const msg = await sendMessage(
      `Started Claude in *${escapeMarkdown(name)}*\n\n` +
      `*Path:* \`${projectDir}\`\n` +
      `*Session:* \`${tmuxName}\`\n\n` +
      `Default workspace set — send messages directly.`
    ) as TelegramMessage | undefined;
    if (msg && msg.message_id) {
      trackNotificationMessage(msg.message_id, name, 'new-session');
    }
  } else if (ptySessionManager.isAvailable()) {
    // PTY path — spawns 'claude' directly (no separate send-keys step)
    const ok = ptySessionManager.spawn(tmuxName, projectDir);
    if (!ok) { await sendMessage('Failed to spawn PTY session.'); return; }

    upsertSession({ cwd: projectDir, tmuxSession: tmuxName, status: 'starting', sessionId: null, sessionType: 'pty' });
    recordProjectUsage(name, projectDir);
    setDefaultWorkspace(name);

    const msg = await sendMessage(
      `Started Claude in *${escapeMarkdown(name)}*\n\n` +
      `*Path:* \`${projectDir}\`\n` +
      `*Session:* \`${tmuxName}\`\n\n` +
      `Default workspace set — send messages directly.\n\n` +
      `_Headless PTY mode — full Telegram control. Not attachable from terminal._`
    ) as TelegramMessage | undefined;
    if (msg && msg.message_id) {
      trackNotificationMessage(msg.message_id, name, 'new-session');
    }
  } else {
    await sendMessage(
      '\u26a0\ufe0f tmux not found and node-pty not installed.\n' +
      'Install tmux or run: `npm install node-pty` in ~/.ccgram/'
    );
  }
}

// ── Resume feature ───────────────────────────────────────────────

/** Format a Unix ms timestamp as a human-readable age (e.g. "2h ago"). */
function formatSessionAge(ms: number): string {
  const diff = Math.floor((Date.now() - ms) / 60000); // minutes
  if (diff < 1) return 'just now';
  if (diff < 60) return `${diff}m ago`;
  if (diff < 1440) return `${Math.floor(diff / 60)}h ago`;
  return `${Math.floor(diff / 1440)}d ago`;
}

async function handleResume(nameArg: string | null): Promise<void> {
  if (nameArg) {
    await resumeProject(nameArg);
    return;
  }

  const allProjects = getRecentProjects(20);
  const projects = allProjects
    .map(p => ({ ...p, sessions: getClaudeSessionsForProject(p.path, 1) }))
    .filter(p => p.sessions.length > 0);

  if (projects.length === 0) {
    await sendMessage(
      'No sessions to resume.\n\nUse `/new` to start one — session IDs are saved automatically.'
    );
    return;
  }

  const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let i = 0; i < projects.length; i += 2) {
    const row = projects.slice(i, i + 2).map(p => ({
      text: `${p.name} \u2022 ${formatSessionAge(p.sessions[0].lastActivity)}`,
      callback_data: `rp:${p.name}`,
    }));
    keyboard.push(row);
  }

  await telegramAPI('sendMessage', {
    chat_id: CHAT_ID,
    text: '*Resume Session*\n\nSelect a project:',
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard },
  });
}

async function resumeProject(projectName: string): Promise<void> {
  const allProjects = getRecentProjects(20);
  const project = allProjects.find(p => p.name === projectName);

  if (!project) {
    await sendMessage(
      `No project found for \`${escapeMarkdown(projectName)}\`.\n\nTry /resume to see available projects.`
    );
    return;
  }

  const sessions = getClaudeSessionsForProject(project.path, 5);

  if (sessions.length === 0) {
    await sendMessage(
      `No sessions found for \`${escapeMarkdown(projectName)}\`.\n\nUse /new to start one.`
    );
    return;
  }

  // Always show picker — one session per row (full width for snippet)
  const keyboard: Array<Array<{ text: string; callback_data: string }>> = sessions.map((s, idx) => [{
    text: `${formatSessionAge(s.lastActivity)}${s.snippet ? ' \u2022 ' + s.snippet : ''}`,
    callback_data: `rs:${projectName}:${idx}`,
  }]);

  await telegramAPI('sendMessage', {
    chat_id: CHAT_ID,
    text: `*Resume: ${escapeMarkdown(projectName)}*\n\nChoose a conversation:`,
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard },
  });
}

async function resumeSession(projectName: string, sessionIdx: number, force: boolean = false): Promise<void> {
  const allProjects = getRecentProjects(20);
  const project = allProjects.find(p => p.name === projectName);

  if (!project) {
    await sendMessage('Session not found. Try /resume again.');
    return;
  }

  const sessions = getClaudeSessionsForProject(project.path, 5);
  if (sessionIdx < 0 || sessionIdx >= sessions.length) {
    await sendMessage('Session not found. Try /resume again.');
    return;
  }

  const sessionId = sessions[sessionIdx].id;
  const tmuxName = projectName.replace(/[.:\s]/g, '-');
  const running = await sessionExists(tmuxName);

  // Look up the bot's tracked session for this workspace (used by multiple checks below)
  const map = running ? readSessionMap() : {};
  const currentEntry = running
    ? Object.values(map).find(s => s.tmuxSession === tmuxName && !isExpired(s))
    : undefined;
  const botOwnsThisSession = currentEntry?.sessionId === sessionId;

  // If the bot already has this exact session running, just re-route to it
  if (running && botOwnsThisSession) {
    upsertSession({ cwd: project.path, tmuxSession: tmuxName, status: 'waiting', sessionId });
    recordProjectUsage(projectName, project.path);
    setDefaultWorkspace(projectName);
    await sendMessage(`Session \`${tmuxName}\` already running.\nSet as default — send messages directly.`);
    return;
  }

  // Check if the JSONL file was written to very recently — the session may be
  // active in a direct terminal (not managed by the bot). Warn before creating
  // a second Claude instance on the same conversation.
  if (!force && !botOwnsThisSession) {
    const activeThresholdMs = 5 * 60 * 1000; // 5 minutes
    const age = Date.now() - sessions[sessionIdx].lastActivity;
    if (age < activeThresholdMs) {
      await telegramAPI('sendMessage', {
        chat_id: CHAT_ID,
        text: `\u26a0\ufe0f This session appears to be *active* (last activity ${formatSessionAge(sessions[sessionIdx].lastActivity)})\n\n` +
          `Claude Code may be running in a terminal. ` +
          `Resuming the same session in two places can cause conflicts.\n\n` +
          `_If you just finished this session, you can safely resume._`,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '\u25b6\ufe0f Resume anyway', callback_data: `rc:${projectName}:${sessionIdx}` },
          ]],
        },
      });
      return;
    }
  }

  // Handle bot-managed session that needs switching
  if (running && !botOwnsThisSession) {
    if (isPtySession(tmuxName)) {
      // PTY: headless, not reattachable — warn before killing
      if (!force) {
        await telegramAPI('sendMessage', {
          chat_id: CHAT_ID,
          text: `\u26a0\ufe0f *${escapeMarkdown(projectName)}* has an active PTY session\n\n` +
            `Resuming a different conversation will terminate it.\n\n` +
            `_PTY sessions cannot be reattached from a terminal. ` +
            `You will need to use /resume again if you want to return to the current conversation._`,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              { text: '\u25b6\ufe0f Resume anyway', callback_data: `rc:${projectName}:${sessionIdx}` },
            ]],
          },
        });
        return;
      }
      // Confirmed — kill the PTY so startProjectResume can respawn
      ptySessionManager.kill(tmuxName);
      await sleep(300);
    }
    // tmux: no warning needed — startProjectResume switches inline
  }

  await startProjectResume(projectName, project.path, sessionId);
}

async function startProjectResume(name: string, projectDir: string, sessionId: string): Promise<void> {
  const tmuxName: string = name.replace(/[.:\s]/g, '-');
  const shortId: string = sessionId.slice(0, 8);

  // If a tmux session is already running, switch Claude inline (exit + resume)
  // instead of killing the tmux session. This keeps the user's terminal attached.
  if (!isPtySession(tmuxName) && await sessionExists(tmuxName)) {
    try {
      // Double Ctrl+C: first interrupts any running Claude task,
      // second clears the input line if Claude returned to its prompt
      await tmuxExec(`tmux send-keys -t "${tmuxName}" C-c`);
      await sleep(500);
      await tmuxExec(`tmux send-keys -t "${tmuxName}" C-c`);
      await sleep(500);
      // Exit Claude — if Claude already exited, /exit is harmless in bash
      // (just an unknown command, won't affect the subsequent claude launch)
      await tmuxExec(`tmux send-keys -t "${tmuxName}" '/exit' C-m`);
      await sleep(2000);
      await tmuxExec(`tmux send-keys -t "${tmuxName}" 'claude --resume ${sessionId}' C-m`);
    } catch (err: unknown) {
      await sendMessage(`Failed to switch session: ${(err as Error).message}`);
      return;
    }

    upsertSession({ cwd: projectDir, tmuxSession: tmuxName, status: 'starting', sessionId, sessionType: 'tmux' });
    recordProjectUsage(name, projectDir);
    setDefaultWorkspace(name);

    const msg = await sendMessage(
      `Switched Claude session in *${escapeMarkdown(name)}*\n\n` +
      `*Path:* \`${projectDir}\`\n` +
      `*Session:* \`${tmuxName}\`\n` +
      `*Resumed:* \`${shortId}...\`\n\n` +
      `Default workspace set — send messages directly.`
    ) as TelegramMessage | undefined;
    if (msg && msg.message_id) {
      trackNotificationMessage(msg.message_id, name, 'resume-session');
    }
    return;
  }

  // No session running — create a new one
  const usePty = !TMUX_AVAILABLE || INJECTION_MODE === 'pty';

  if (!usePty) {
    try {
      await tmuxExec(`tmux new-session -d -s "${tmuxName}" -c "${projectDir}"`);
      await sleep(300);
      await tmuxExec(`tmux send-keys -t "${tmuxName}" 'claude --resume ${sessionId}' C-m`);
    } catch (err: unknown) {
      await sendMessage(`Failed to start session: ${(err as Error).message}`);
      return;
    }

    upsertSession({ cwd: projectDir, tmuxSession: tmuxName, status: 'starting', sessionId, sessionType: 'tmux' });
    recordProjectUsage(name, projectDir);
    setDefaultWorkspace(name);

    const msg = await sendMessage(
      `Resumed Claude in *${escapeMarkdown(name)}*\n\n` +
      `*Path:* \`${projectDir}\`\n` +
      `*Session:* \`${tmuxName}\`\n` +
      `*Resumed:* \`${shortId}...\`\n\n` +
      `Default workspace set — send messages directly.`
    ) as TelegramMessage | undefined;
    if (msg && msg.message_id) {
      trackNotificationMessage(msg.message_id, name, 'resume-session');
    }
  } else if (ptySessionManager.isAvailable()) {
    const ok = ptySessionManager.spawn(tmuxName, projectDir, ['--resume', sessionId]);
    if (!ok) { await sendMessage('Failed to spawn PTY session.'); return; }

    upsertSession({ cwd: projectDir, tmuxSession: tmuxName, status: 'starting', sessionId, sessionType: 'pty' });
    recordProjectUsage(name, projectDir);
    setDefaultWorkspace(name);

    const msg = await sendMessage(
      `Resumed Claude in *${escapeMarkdown(name)}*\n\n` +
      `*Path:* \`${projectDir}\`\n` +
      `*Session:* \`${tmuxName}\`\n` +
      `*Resumed:* \`${shortId}...\`\n\n` +
      `Default workspace set — send messages directly.\n\n` +
      `_Headless PTY mode — full Telegram control. Not attachable from terminal._`
    ) as TelegramMessage | undefined;
    if (msg && msg.message_id) {
      trackNotificationMessage(msg.message_id, name, 'resume-session');
    }
  } else {
    await sendMessage(
      '\u26a0\ufe0f tmux not found and node-pty not installed.\n' +
      'Install tmux or run: `npm install node-pty` in ~/.ccgram/'
    );
  }
}

async function injectAndRespond(session: SessionEntry, command: string, workspace: string): Promise<boolean> {
  const tmuxName: string = session.tmuxSession;

  if (!await sessionExists(tmuxName)) {
    await sendMessage(`\u26a0\ufe0f Session not found. Start Claude via /new for full remote control, or use tmux.`);
    return false;
  }

  try {
    if (isPtySession(tmuxName)) {
      // PTY: write raw bytes directly — no shell quoting needed
      ptySessionManager.write(tmuxName, '\x15');   // Ctrl+U: clear line
      await sleep(150);
      ptySessionManager.write(tmuxName, command);  // raw command text
      await sleep(150);
      ptySessionManager.write(tmuxName, '\r');     // Enter
    } else {
      // tmux: existing shell-escaped path
      const escapedCommand: string = command.replace(/'/g, "'\"'\"'");
      await tmuxExec(`tmux send-keys -t ${tmuxName} C-u`);
      await sleep(150);
      await tmuxExec(`tmux send-keys -t ${tmuxName} '${escapedCommand}'`);
      await sleep(150);
      await tmuxExec(`tmux send-keys -t ${tmuxName} C-m`);
    }
    startTypingIndicator();
    return true;
  } catch (err: unknown) {
    await sendMessage(`\u274c Failed: ${(err as Error).message}`);
    return false;
  }
}

function tmuxExec(cmd: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    exec(cmd, (err) => {
      if (err) reject(err);
      else resolve(true);
    });
  });
}

// ── PTY / tmux dispatch helpers ──────────────────────────────────

/** Is this session managed as a live PTY handle by this bot process? */
function isPtySession(sessionName: string): boolean {
  return ptySessionManager.has(sessionName);
}

/** Check session exists (PTY handle OR tmux session). */
async function sessionExists(name: string): Promise<boolean> {
  if (ptySessionManager.has(name)) return true;
  if (TMUX_AVAILABLE) {
    try { await tmuxExec(`tmux has-session -t ${name} 2>/dev/null`); return true; }
    catch { return false; }
  }
  return false;
}

/**
 * Send a named key (Down, Up, Enter, C-m, C-c, C-u, Space) to a session.
 * For PTY: translates to escape sequence via ptySessionManager.sendKey.
 * For tmux: passes key name directly to tmux send-keys.
 */
async function sessionSendKey(name: string, key: string): Promise<void> {
  if (isPtySession(name)) {
    ptySessionManager.sendKey(name, key);
  } else {
    await tmuxExec(`tmux send-keys -t ${name} ${key}`);
  }
  await sleep(100);
}

/** Capture session output (last 20 lines). */
async function sessionCaptureOutput(name: string): Promise<string> {
  if (isPtySession(name)) return ptySessionManager.capture(name, 20) ?? '';
  return capturePane(name);
}

/** Send Ctrl+C interrupt to a session. */
async function sessionInterrupt(name: string): Promise<void> {
  if (isPtySession(name)) ptySessionManager.interrupt(name);
  else await tmuxExec(`tmux send-keys -t ${name} C-c`);
}

/** Icon for /sessions listing based on session type and live status. */
function sessionIcon(s: { workspace: string; token: string; session: SessionEntry; age: string }): string {
  if (s.session.sessionType === 'pty') {
    return ptySessionManager.has(s.session.tmuxSession) ? '\u{1F916}' : '\u{1F4A4}'; // 🤖 or 💤
  }
  return s.session.description?.startsWith('waiting') ? '\u23f3' : '\u2705'; // ⏳ or ✅
}

// ── Callback query handler ───────────────────────────────────────

async function processCallbackQuery(query: TelegramCallbackQuery): Promise<void> {
  const chatId: string = String(query.message?.chat?.id);
  if (chatId !== String(CHAT_ID)) {
    logger.warn(`Ignoring callback from unauthorized chat: ${chatId}`);
    return;
  }

  const data: string = query.data || '';
  const messageId: number | undefined = query.message?.message_id;
  const originalText: string = query.message?.text || '';

  logger.info(`Callback: ${data}`);

  const parsed: ParsedCallback | null = parseCallbackData(data);
  if (!parsed) {
    await answerCallbackQuery(query.id, 'Invalid callback');
    return;
  }

  const { type } = parsed;

  // Handle new: callback (format: new:<projectName>)
  if (type === 'new') {
    const { projectName } = parsed;
    await answerCallbackQuery(query.id, `Starting ${projectName}...`);
    try {
      await editMessageText(chatId, messageId!, `${originalText}\n\n— Starting *${escapeMarkdown(projectName)}*...`);
    } catch {}
    await startProject(projectName);
    return;
  }

  // Handle rp: callback (format: rp:<projectName>) — show session picker or resume directly
  if (type === 'rp') {
    const { projectName } = parsed;
    await answerCallbackQuery(query.id, `Loading ${projectName}...`);
    try {
      await editMessageText(chatId, messageId!, `${originalText}\n\n— Loading sessions...`);
    } catch {}
    await resumeProject(projectName);
    return;
  }

  // Handle rs: callback (format: rs:<projectName>:<sessionIdx>) — resume specific session
  if (type === 'rs') {
    const { projectName, sessionIdx } = parsed;
    await answerCallbackQuery(query.id, 'Starting resume...');
    await resumeSession(projectName, sessionIdx);
    return;
  }

  // Handle rc: callback (format: rc:<projectName>:<sessionIdx>) — confirmed resume (kill active + restart)
  if (type === 'rc') {
    const { projectName, sessionIdx } = parsed;
    await answerCallbackQuery(query.id, 'Resuming...');
    try {
      await editMessageText(chatId, messageId!, `${originalText}\n\n\u2014 Resuming...`);
    } catch {}
    await resumeSession(projectName, sessionIdx, true);
    return;
  }

  const { promptId } = parsed;

  if (type === 'perm') {
    // Permission response: write response file for the polling hook
    const pending = readPending(promptId);

    if (!pending) {
      await answerCallbackQuery(query.id, 'Session not found');
      return;
    }

    const { action } = parsed;
    const label: string = action === 'allow' ? '\u2705 Allowed' : action === 'always' ? '\ud83d\udd13 Always Allowed' : '\u274c Denied';

    // Write response file — the permission-hook.js is polling for this
    try {
      writeResponse(promptId, { action });
      logger.info(`Wrote permission response for promptId=${promptId}: action=${action}`);
      await answerCallbackQuery(query.id, label);
    } catch (err: unknown) {
      logger.error(`Failed to write permission response: ${(err as Error).message}`);
      await answerCallbackQuery(query.id, 'Failed to save response');
      return;
    }

    // Edit message to show result and remove buttons
    try {
      await editMessageText(chatId, messageId!, `${originalText}\n\n— ${label}`);
    } catch (err: unknown) {
      logger.error(`Failed to edit message: ${(err as Error).message}`);
    }

  } else if (type === 'opt') {
    // Question option: inject keystroke via tmux
    const pending = readPending(promptId);

    if (!pending || !pending.tmuxSession) {
      await answerCallbackQuery(query.id, 'Session not found');
      return;
    }

    const optIdx: number = parsed.optionIndex - 1;
    const optionLabel: string = pending.options && (pending.options as string[])[optIdx]
      ? (pending.options as string[])[optIdx]
      : `Option ${parsed.optionIndex}`;

    // Multi-select: toggle selection state, update buttons, don't submit yet
    if (pending.multiSelect) {
      const selected: boolean[] = (pending.selectedOptions as boolean[]) || (pending.options as string[]).map(() => false);
      selected[optIdx] = !selected[optIdx];
      updatePending(promptId, { selectedOptions: selected });

      // Rebuild keyboard with updated checkboxes
      const buttons = (pending.options as string[]).map((label: string, idx: number) => ({
        text: `${selected[idx] ? '\u2611' : '\u2610'} ${idx + 1}. ${label}`,
        callback_data: `opt:${promptId}:${idx + 1}`,
      }));
      const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
      for (let i = 0; i < buttons.length; i += 2) {
        keyboard.push(buttons.slice(i, i + 2));
      }
      keyboard.push([{ text: '\u2705 Submit', callback_data: `opt-submit:${promptId}` }]);

      const checkLabel: string = selected[optIdx] ? '\u2611' : '\u2610';
      await answerCallbackQuery(query.id, `${checkLabel} ${optionLabel}`);

      // Edit message to show updated buttons
      try {
        await editMessageText(chatId, messageId!, originalText, { inline_keyboard: keyboard });
      } catch (err: unknown) {
        logger.error(`Failed to edit message: ${(err as Error).message}`);
      }
      return;
    }

    // Single-select: inject arrow keys + Enter into session
    // Claude Code's AskUserQuestion UI: first option pre-highlighted, Down (N-1) times + Enter
    const downPresses: number = optIdx;
    const tmuxSessOpt: string = pending.tmuxSession as string;
    try {
      for (let i = 0; i < downPresses; i++) {
        await sessionSendKey(tmuxSessOpt, 'Down');
      }
      await sessionSendKey(tmuxSessOpt, 'Enter');

      // For multi-question flows: after the last question, send an extra
      // Enter to confirm the preview/submit step
      if (pending.isLast) {
        await sleep(500);
        await sessionSendKey(tmuxSessOpt, 'Enter');
      }

      await answerCallbackQuery(query.id, `Selected: ${optionLabel}`);
      startTypingIndicator(); // ensure Stop hook routes response back to Telegram
    } catch (err: unknown) {
      logger.error(`Failed to inject keystroke: ${(err as Error).message}`);
      await answerCallbackQuery(query.id, 'Failed to send selection');
      return;
    }

    // Edit message to show selection and remove buttons
    try {
      await editMessageText(chatId, messageId!, `${originalText}\n\n— Selected: *${escapeMarkdown(optionLabel)}*`);
    } catch (err: unknown) {
      logger.error(`Failed to edit message: ${(err as Error).message}`);
    }

    cleanPrompt(promptId);

  } else if (type === 'opt-submit') {
    // Multi-select submit: inject Space toggles for selected options, then Enter
    const pending = readPending(promptId);

    if (!pending || !pending.tmuxSession) {
      await answerCallbackQuery(query.id, 'Session not found');
      return;
    }

    const selected: boolean[] = (pending.selectedOptions as boolean[]) || [];
    const selectedLabels: string[] = (pending.options as string[]).filter((_: string, idx: number) => selected[idx]);

    if (selectedLabels.length === 0) {
      await answerCallbackQuery(query.id, 'No options selected');
      return;
    }

    // Inject keystrokes: iterate each option from top, Space if selected, Down to next
    // Claude Code multi-select UI starts with cursor on first option
    // After the listed options, Claude Code adds an auto-generated "Other" option,
    // then Submit. So we need: options.length Downs + 1 more Down to skip "Other"
    const tmuxSessSubmit: string = pending.tmuxSession as string;
    try {
      for (let i = 0; i < (pending.options as string[]).length; i++) {
        if (selected[i]) {
          await sessionSendKey(tmuxSessSubmit, 'Space');
        }
        await sessionSendKey(tmuxSessSubmit, 'Down');
      }
      // Skip past the auto-added "Other" option to reach Submit
      await sessionSendKey(tmuxSessSubmit, 'Down');
      // Cursor is now on Submit — press Enter
      await sessionSendKey(tmuxSessSubmit, 'Enter');

      // For multi-question flows: extra Enter to confirm
      if (pending.isLast) {
        await sleep(500);
        await sessionSendKey(tmuxSessSubmit, 'Enter');
      }

      await answerCallbackQuery(query.id, `Submitted ${selectedLabels.length} options`);
      startTypingIndicator(); // ensure Stop hook routes response back to Telegram
    } catch (err: unknown) {
      logger.error(`Failed to inject keystrokes: ${(err as Error).message}`);
      await answerCallbackQuery(query.id, 'Failed to send selections');
      return;
    }

    // Edit message to show selections and remove buttons
    const selectionText: string = selectedLabels.map(l => `\u2022 ${escapeMarkdown(l)}`).join('\n');
    try {
      await editMessageText(chatId, messageId!, `${originalText}\n\n— Selected:\n${selectionText}`);
    } catch (err: unknown) {
      logger.error(`Failed to edit message: ${(err as Error).message}`);
    }

    cleanPrompt(promptId);

  } else if (type === 'qperm') {
    // Combined question+permission: allow permission AND inject answer keystroke
    const optIdx: number = parsed.optionIndex - 1;
    const pending = readPending(promptId);

    if (!pending) {
      await answerCallbackQuery(query.id, 'Session not found');
      return;
    }

    const optionLabel: string = pending.options && (pending.options as string[])[optIdx]
      ? (pending.options as string[])[optIdx]
      : `Option ${parsed.optionIndex}`;

    // 1. Write permission response (allow) — unblocks the permission hook
    try {
      writeResponse(promptId, { action: 'allow', selectedOption: parsed.optionIndex });
      logger.info(`Wrote qperm response for promptId=${promptId}: option=${parsed.optionIndex}`);
      await answerCallbackQuery(query.id, `Selected: ${optionLabel}`);
    } catch (err: unknown) {
      logger.error(`Failed to write qperm response: ${(err as Error).message}`);
      await answerCallbackQuery(query.id, 'Failed to save response');
      return;
    }

    // 2. Schedule keystroke injection after a delay (wait for question UI to appear)
    if (pending.tmuxSession) {
      const tmux: string = pending.tmuxSession as string;
      const downPresses: number = optIdx;
      setTimeout(async () => {
        try {
          for (let i = 0; i < downPresses; i++) {
            await sessionSendKey(tmux, 'Down');
          }
          await sessionSendKey(tmux, 'Enter');
          startTypingIndicator(); // ensure Stop hook routes response back to Telegram
          logger.info(`Injected question answer into ${tmux}: option ${parsed.optionIndex}`);
        } catch (err: unknown) {
          logger.error(`Failed to inject question answer: ${(err as Error).message}`);
        }
      }, 4000); // 4s delay for permission hook to return + question UI to render
    }

    // Edit message to show selection
    try {
      await editMessageText(chatId, messageId!, `${originalText}\n\n— Selected: *${escapeMarkdown(optionLabel)}*`);
    } catch (err: unknown) {
      logger.error(`Failed to edit message: ${(err as Error).message}`);
    }

  }
}

// ── Message router ──────────────────────────────────────────────

async function processMessage(msg: TelegramMessage): Promise<void> {
  stopTypingIndicator();
  // Only accept messages from the configured chat
  const chatId: string = String(msg.chat.id);
  if (chatId !== String(CHAT_ID)) {
    logger.warn(`Ignoring message from unauthorized chat: ${chatId}`);
    return;
  }

  const text: string = (msg.text || '').trim();
  if (!text) return;

  logger.info(`Received: ${text}`);

  // /help
  if (text === '/help' || text === '/start') {
    await handleHelp();
    return;
  }

  // /sessions
  if (text === '/sessions') {
    await handleSessions();
    return;
  }

  // /status [workspace]
  const statusMatch: RegExpMatchArray | null = text.match(/^\/status(?:\s+(\S+))?$/);
  if (statusMatch) {
    await handleStatus(statusMatch[1] || null);
    return;
  }

  // /stop [workspace]
  const stopMatch: RegExpMatchArray | null = text.match(/^\/stop(?:\s+(\S+))?$/);
  if (stopMatch) {
    await handleStop(stopMatch[1] || null);
    return;
  }

  // /use [workspace]
  const useMatch: RegExpMatchArray | null = text.match(/^\/use(?:\s+(.*))?$/);
  if (useMatch) {
    await handleUse(useMatch[1] ? useMatch[1].trim() : null);
    return;
  }

  // /compact [workspace]
  const compactMatch: RegExpMatchArray | null = text.match(/^\/compact(?:\s+(\S+))?$/);
  if (compactMatch) {
    await handleCompact(compactMatch[1] || null);
    return;
  }

  // /new [project]
  const newMatch: RegExpMatchArray | null = text.match(/^\/new(?:\s+(.+))?$/);
  if (newMatch) {
    await handleNew(newMatch[1] ? newMatch[1].trim() : null);
    return;
  }

  // /resume [project]
  const resumeMatch: RegExpMatchArray | null = text.match(/^\/resume(?:\s+(.+))?$/);
  if (resumeMatch) {
    await handleResume(resumeMatch[1] ? resumeMatch[1].trim() : null);
    return;
  }

  // /cmd TOKEN command
  const cmdMatch: RegExpMatchArray | null = text.match(/^\/cmd\s+(\S+)\s+(.+)/s);
  if (cmdMatch) {
    await handleCmd(cmdMatch[1], cmdMatch[2]);
    return;
  }

  // /<workspace> command  (anything starting with / that isn't a known command)
  const wsMatch: RegExpMatchArray | null = text.match(/^\/(\S+)\s+(.+)/s);
  if (wsMatch) {
    const workspace: string = wsMatch[1];
    const command: string = wsMatch[2];

    // Skip Telegram built-in bot commands that start with @
    if (workspace.includes('@')) return;

    await handleWorkspaceCommand(workspace, command);
    return;
  }

  // If just a slash command with no args, check if it's a workspace (with prefix matching)
  const bareWs: RegExpMatchArray | null = text.match(/^\/(\S+)$/);
  if (bareWs) {
    const resolved: ResolveResult = resolveWorkspace(bareWs[1]);
    if (resolved.type === 'exact' || resolved.type === 'prefix') {
      await handleStatus(resolved.workspace);
    } else if (resolved.type === 'ambiguous') {
      const names: string = resolved.matches.map(m => `\`${escapeMarkdown(m.workspace)}\``).join(', ');
      await sendMessage(`Multiple matches: ${names}. Be more specific.`);
    } else {
      await sendMessage(`Unknown command: \`${text}\`. Try /help`);
    }
    return;
  }

  // Plain text — try reply-to routing, then default workspace, then show hint
  const replyToId: number | undefined = msg.reply_to_message && msg.reply_to_message.message_id;
  if (replyToId) {
    const replyWorkspace: string | null = getWorkspaceForMessage(replyToId);
    if (replyWorkspace) {
      await handleWorkspaceCommand(replyWorkspace, text);
      return;
    }
  }

  const defaultWs: string | null = getDefaultWorkspace();
  if (defaultWs) {
    await handleWorkspaceCommand(defaultWs, text);
    return;
  }

  await sendMessage('Use `/help` to see available commands, or `/use <workspace>` to set a default.');
}

// ── Long polling loop ───────────────────────────────────────────

async function poll(): Promise<void> {
  while (true) {
    try {
      const updates = await telegramAPI('getUpdates', {
        offset: lastUpdateId + 1,
        timeout: 30,
        allowed_updates: ['message', 'callback_query'],
      }) as TelegramUpdate[];

      lastPollTime = Date.now();

      for (const update of updates) {
        lastUpdateId = update.update_id;

        if (update.callback_query) {
          try {
            await processCallbackQuery(update.callback_query);
          } catch (err: unknown) {
            logger.error(`Error processing callback query: ${(err as Error).message}`);
          }
        } else if (update.message) {
          try {
            await processMessage(update.message);
          } catch (err: unknown) {
            logger.error(`Error processing message: ${(err as Error).message}`);
          }
        }
      }
    } catch (err: unknown) {
      // Network error — back off and retry
      logger.error(`Polling error: ${(err as Error).message}`);
      await sleep(5000);
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────

function capturePane(tmuxSession: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(`tmux capture-pane -t ${tmuxSession} -p`, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

function escapeMarkdown(text: string): string {
  // Telegram Markdown v1 only needs these escaped
  return text.replace(/([_*`\[])/g, '\\$1');
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Health check server ──────────────────────────────────────────

function startHealthServer(port: number): void {
  const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
    if (req.url !== '/health') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const now: number = Date.now();
    const pollAge: number | null = lastPollTime ? now - lastPollTime : null;
    const stale: boolean = pollAge === null || pollAge > 60000;

    const sessions = listActiveSessions();
    let pendingCount = 0;
    try {
      const files: string[] = fs.readdirSync(PROMPTS_DIR).filter(f => f.startsWith('pending-'));
      pendingCount = files.length;
    } catch {}

    const body: string = JSON.stringify({
      status: stale ? 'unhealthy' : 'ok',
      uptime: Math.floor((now - startTime) / 1000),
      lastPollAge: pollAge !== null ? Math.floor(pollAge / 1000) : null,
      activeSessions: sessions.length,
      pendingPrompts: pendingCount,
    }, null, 2);

    res.writeHead(stale ? 503 : 200, { 'Content-Type': 'application/json' });
    res.end(body);
  });

  server.listen(port, '127.0.0.1', () => {
    logger.info(`Health endpoint: http://127.0.0.1:${port}/health`);
  });

  server.on('error', (err: Error) => {
    logger.warn(`Health server error: ${err.message}`);
  });
}

// ── Startup ─────────────────────────────────────────────────────

async function start(): Promise<void> {
  // Ensure data directory exists
  const dataDir: string = path.join(PROJECT_ROOT, 'src/data');
  fs.mkdirSync(dataDir, { recursive: true });

  const { version } = require(path.join(PROJECT_ROOT, 'package.json'));
  logger.info(`CCGram v${version} — Starting Telegram bot (long polling)...`);
  logger.info(`Chat ID: ${CHAT_ID}`);

  // Prune expired sessions on startup
  const pruned: number = pruneExpired();
  if (pruned > 0) {
    logger.info(`Pruned ${pruned} expired sessions`);
  }

  // Delete any existing webhook to ensure long polling works
  try {
    await telegramAPI('deleteWebhook', {});
    logger.info('Webhook cleared, using long polling');
  } catch (err: unknown) {
    logger.warn(`Could not delete webhook: ${(err as Error).message}`);
  }

  // Register bot commands with Telegram (populates the "/" menu in chat)
  await registerBotCommands();

  // Start optional health check server
  const healthPort: number = parseInt(process.env.HEALTH_PORT as string, 10);
  if (healthPort) {
    startHealthServer(healthPort);
  }

  await poll();
}

// Graceful shutdown
process.on('SIGINT', () => {
  logger.info('Shutting down...');
  process.exit(0);
});
process.on('SIGTERM', () => {
  logger.info('Shutting down...');
  process.exit(0);
});

start().catch((err: Error) => {
  logger.error(`Fatal: ${err.message}`);
  process.exit(1);
});
