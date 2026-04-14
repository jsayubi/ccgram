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
  findSessionByTmuxName,
  getSessionRateLimit,
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
import { ghosttySessionManager } from './src/utils/ghostty-session-manager';
import { generateDeepLink, canGenerateDeepLink } from './src/utils/deep-link';
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

/**
 * Determine the active injection backend.
 * Respects INJECTION_MODE env var, falls back in order: ghostty → pty → tmux.
 */
function getEffectiveMode(): 'tmux' | 'ghostty' | 'pty' {
  if (INJECTION_MODE === 'ghostty' && ghosttySessionManager.isAvailable()) return 'ghostty';
  if (INJECTION_MODE === 'pty' && ptySessionManager.isAvailable()) return 'pty';
  if (TMUX_AVAILABLE && INJECTION_MODE !== 'pty' && INJECTION_MODE !== 'ghostty') return 'tmux';
  if (ghosttySessionManager.isAvailable()) return 'ghostty';
  if (ptySessionManager.isAvailable()) return 'pty';
  return 'tmux';
}

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
    { command: 'link',     description: 'Generate deep link to open Claude' },
    { command: 'sessions', description: 'List all active Claude sessions' },
    { command: 'use',      description: 'Set or show default workspace' },
    { command: 'status',   description: 'Show current session output' },
    { command: 'stop',     description: 'Interrupt the running prompt' },
    { command: 'compact',  description: 'Compact context in the current session' },
    { command: 'effort',   description: 'Set thinking effort (low/medium/high)' },
    { command: 'model',    description: 'Switch Claude model (sonnet/opus/haiku)' },
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

/**
 * Helper to resolve workspace from arg or default.
 * Returns the resolved result with workspace and session.
 */
function resolveDefaultWorkspace(): ResolveResult {
  const defaultWs = getDefaultWorkspace();
  if (!defaultWs) {
    return { type: 'none' };
  }
  return resolveWorkspace(defaultWs);
}

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
    '`/link <prompt>` — Generate deep link to open Claude',
    '`/effort [workspace] low|medium|high` — Set thinking effort',
    '`/model [workspace] <model>` — Switch Claude model',
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

async function handleLink(prompt: string): Promise<void> {
  if (!prompt) {
    await sendMessage('Usage: `/link <prompt>`\n\nGenerates a clickable link that opens Claude Code with your prompt.');
    return;
  }

  if (!canGenerateDeepLink(prompt)) {
    await sendMessage('\u26a0\ufe0f Prompt too long for deep link (max ~4500 characters).');
    return;
  }

  const deepLink = generateDeepLink(prompt);
  if (!deepLink) {
    await sendMessage('\u26a0\ufe0f Failed to generate deep link.');
    return;
  }

  // Send the deep link as a clickable button
  const keyboard = {
    inline_keyboard: [[
      { text: '\ud83d\udcbb Open in Claude Code', url: deepLink },
    ]],
  };

  await telegramAPI('sendMessage', {
    chat_id: CHAT_ID,
    text: `*Deep Link Generated*\n\n_Tap the button to open Claude Code with:_\n\`${escapeMarkdown(prompt.slice(0, 100))}${prompt.length > 100 ? '...' : ''}\``,
    parse_mode: 'Markdown',
    reply_markup: keyboard,
  });
}

/**
 * /effort [workspace] low|medium|high — Set Claude's thinking effort level
 */
async function handleEffort(args: string): Promise<void> {
  const validLevels = ['low', 'medium', 'high'];

  if (!args) {
    await sendMessage('Usage: `/effort [workspace] low|medium|high`\n\nSet Claude\'s thinking effort level.');
    return;
  }

  const parts = args.split(/\s+/);
  let workspaceArg: string | null = null;
  let level: string;

  // Check if first arg is a valid level or a workspace
  if (validLevels.includes(parts[0].toLowerCase())) {
    level = parts[0].toLowerCase();
  } else if (parts.length >= 2 && validLevels.includes(parts[1].toLowerCase())) {
    workspaceArg = parts[0];
    level = parts[1].toLowerCase();
  } else {
    await sendMessage(`Invalid effort level. Use: \`low\`, \`medium\`, or \`high\``);
    return;
  }

  // Resolve workspace
  const resolved = workspaceArg ? resolveWorkspace(workspaceArg) : resolveDefaultWorkspace();
  if (resolved.type === 'none') {
    await sendMessage(workspaceArg
      ? `No session found for workspace \`${escapeMarkdown(workspaceArg)}\``
      : 'No default workspace set. Use `/use <workspace>` first.');
    return;
  }
  if (resolved.type === 'ambiguous') {
    const names = resolved.matches.map(m => `\`${escapeMarkdown(m.workspace)}\``).join(', ');
    await sendMessage(`Multiple matches: ${names}. Be more specific.`);
    return;
  }

  const session = resolved.match!.session;
  const workspace = resolved.workspace;
  const slashCommand = `/effort ${level}`;

  const injected = await injectAndRespond(session, slashCommand, workspace);
  if (injected) {
    startTypingIndicator();
    await sendMessage(`\u2699\ufe0f Effort set to *${level}* in *${escapeMarkdown(workspace)}*`);
  }
}

/**
 * /model [workspace] <model> — Switch Claude model
 */
async function handleModel(args: string): Promise<void> {
  if (!args) {
    await sendMessage('Usage: `/model [workspace] <model>`\n\nSwitch Claude model (e.g., `sonnet`, `opus`, `haiku`).');
    return;
  }

  const parts = args.split(/\s+/);
  let workspaceArg: string | null = null;
  let model: string;

  // If 2+ parts, first might be workspace
  if (parts.length >= 2) {
    // Try to resolve first part as workspace
    const maybeWs = resolveWorkspace(parts[0]);
    if (maybeWs.type === 'exact' || maybeWs.type === 'prefix') {
      workspaceArg = parts[0];
      model = parts.slice(1).join(' ');
    } else {
      model = parts.join(' ');
    }
  } else {
    model = parts[0];
  }

  // Resolve workspace
  const resolved = workspaceArg ? resolveWorkspace(workspaceArg) : resolveDefaultWorkspace();
  if (resolved.type === 'none') {
    await sendMessage(workspaceArg
      ? `No session found for workspace \`${escapeMarkdown(workspaceArg)}\``
      : 'No default workspace set. Use `/use <workspace>` first.');
    return;
  }
  if (resolved.type === 'ambiguous') {
    const names = resolved.matches.map(m => `\`${escapeMarkdown(m.workspace)}\``).join(', ');
    await sendMessage(`Multiple matches: ${names}. Be more specific.`);
    return;
  }

  const session = resolved.match!.session;
  const workspace = resolved.workspace;
  const slashCommand = `/model ${model}`;

  const injected = await injectAndRespond(session, slashCommand, workspace);
  if (injected) {
    startTypingIndicator();
    await sendMessage(`\ud83e\udde0 Model switched to *${escapeMarkdown(model)}* in *${escapeMarkdown(workspace)}*`);
  }
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
    const output: string = await sessionCaptureOutput(tmuxName, match.session);
    // Trim and take last 20 lines to avoid message length limits
    const trimmed: string = output.trim().split('\n').slice(-20).join('\n');

    // Build rate limit info if available
    let rateLimitInfo = '';
    const rateLimit = getSessionRateLimit(resolvedName);
    if (rateLimit && rateLimit.remaining !== undefined) {
      const pct = rateLimit.limit ? Math.round((rateLimit.remaining / rateLimit.limit) * 100) : null;
      const pctStr = pct !== null ? ` (${pct}%)` : '';
      let resetStr = '';
      if (rateLimit.resetsAt) {
        const resetDate = new Date(rateLimit.resetsAt * 1000);
        const now = new Date();
        const diffMs = resetDate.getTime() - now.getTime();
        if (diffMs > 0) {
          const mins = Math.ceil(diffMs / 60000);
          resetStr = mins > 60 ? ` \u2022 resets in ${Math.round(mins / 60)}h` : ` \u2022 resets in ${mins}m`;
        }
      }
      rateLimitInfo = `\n\n<i>\u{1F4CA} Rate limit: ${rateLimit.remaining}/${rateLimit.limit || '?'}${pctStr}${resetStr}</i>`;
    }

    const htmlMsg: string = `<b>${escapeHtml(resolvedName)}</b> session output:\n<pre>${escapeHtml(trimmed)}</pre>${rateLimitInfo}`;
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

  if (!await sessionExists(tmuxName, resolved.match.session)) {
    await sendMessage(`Session \`${tmuxName}\` not found.`);
    return;
  }

  try {
    await sessionInterrupt(tmuxName, resolved.match.session);
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
  const compactSession = resolved.match.session;

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
      const output: string = await sessionCaptureOutput(tmuxName, compactSession);
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
      const output: string = await sessionCaptureOutput(tmuxName, compactSession);
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
      const output: string = await sessionCaptureOutput(tmuxName, compactSession);
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
    const output: string = await sessionCaptureOutput(tmuxName, compactSession);
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

  // 4. Check existing session (PTY, Ghostty, or tmux)
  const existingEntry = Object.values(readSessionMap()).find(s => s.tmuxSession === tmuxName && !isExpired(s));
  const alreadyRunning = existingEntry
    ? await sessionExists(tmuxName, existingEntry)
    : await sessionExists(tmuxName);
  if (alreadyRunning) {
    upsertSession({ cwd: projectDir, tmuxSession: tmuxName, status: 'waiting', sessionId: null });
    recordProjectUsage(name, projectDir);
    setDefaultWorkspace(name);
    await sendMessage(`Session \`${tmuxName}\` already running.\nSet as default — send messages directly.`);
    return;
  }

  // 5. Create session — Ghostty, PTY, or tmux
  const mode = getEffectiveMode();

  if (mode === 'tmux') {
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
  } else if (mode === 'ghostty') {
    // Ghostty path — opens a new tab in the front Ghostty window
    const ok = await ghosttySessionManager.openNewTab(projectDir, 'claude');
    if (!ok) { await sendMessage('Failed to open Ghostty tab.'); return; }

    ghosttySessionManager.register(tmuxName, projectDir);
    upsertSession({ cwd: projectDir, tmuxSession: tmuxName, status: 'starting', sessionId: null, sessionType: 'ghostty' });
    recordProjectUsage(name, projectDir);
    setDefaultWorkspace(name);

    const msg = await sendMessage(
      `Started Claude in *${escapeMarkdown(name)}*\n\n` +
      `*Path:* \`${projectDir}\`\n` +
      `*Session:* \`${tmuxName}\`\n\n` +
      `Default workspace set — send messages directly.\n\n` +
      `_Ghostty tab — visible in your Ghostty window._`
    ) as TelegramMessage | undefined;
    if (msg && msg.message_id) {
      trackNotificationMessage(msg.message_id, name, 'new-session');
    }
  } else if (mode === 'pty') {
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
      '\u26a0\ufe0f No injection backend available.\n' +
      'Install tmux, run Ghostty, or run: `npm install node-pty` in ~/.ccgram/'
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

  // Look up the bot's tracked session BEFORE checking sessionExists
  const map = readSessionMap();
  const currentEntry = Object.values(map).find(s => s.tmuxSession === tmuxName && !isExpired(s));
  const running = currentEntry
    ? await sessionExists(tmuxName, currentEntry)
    : (isPtySession(tmuxName) || (TMUX_AVAILABLE && await sessionExists(tmuxName)));
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
    } else if (currentEntry && isGhosttySession(currentEntry)) {
      // Ghostty: old tab stays open idle — warn before opening a new tab
      if (!force) {
        await telegramAPI('sendMessage', {
          chat_id: CHAT_ID,
          text: `\u26a0\ufe0f *${escapeMarkdown(projectName)}* has an active Ghostty session\n\n` +
            `Resuming will open a new tab. The existing tab will stay open but idle.\n\n` +
            `_You can close the old tab manually._`,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              { text: '\u25b6\ufe0f Resume anyway', callback_data: `rc:${projectName}:${sessionIdx}` },
            ]],
          },
        });
        return;
      }
      // Confirmed — unregister handle so startProjectResume opens a fresh tab
      ghosttySessionManager.unregister(tmuxName);
    }
    // tmux: no warning needed — startProjectResume switches inline
  }

  await startProjectResume(projectName, project.path, sessionId);
}

async function startProjectResume(name: string, projectDir: string, sessionId: string): Promise<void> {
  const tmuxName: string = name.replace(/[.:\s]/g, '-');
  const shortId: string = sessionId.slice(0, 8);

  // Look up the current session entry BEFORE checking sessionExists
  const map = readSessionMap();
  const currentEntry = Object.values(map).find(s => s.tmuxSession === tmuxName && !isExpired(s));
  const running = currentEntry
    ? await sessionExists(tmuxName, currentEntry)
    : (isPtySession(tmuxName) || (TMUX_AVAILABLE && await sessionExists(tmuxName)));

  // If a tmux session is already running (and not PTY/Ghostty), switch Claude inline
  // (exit + resume) instead of killing the tmux session. This keeps the terminal attached.
  if (!isPtySession(tmuxName) && !(currentEntry && isGhosttySession(currentEntry)) && running) {
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

  // No session running (or was PTY/Ghostty that's been killed) — create a new one
  const mode = getEffectiveMode();

  if (mode === 'tmux') {
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
  } else if (mode === 'ghostty') {
    const ok = await ghosttySessionManager.openNewTab(projectDir, `claude --resume ${sessionId}`);
    if (!ok) { await sendMessage('Failed to open Ghostty tab.'); return; }

    ghosttySessionManager.register(tmuxName, projectDir);
    upsertSession({ cwd: projectDir, tmuxSession: tmuxName, status: 'starting', sessionId, sessionType: 'ghostty' });
    recordProjectUsage(name, projectDir);
    setDefaultWorkspace(name);

    const msg = await sendMessage(
      `Resumed Claude in *${escapeMarkdown(name)}*\n\n` +
      `*Path:* \`${projectDir}\`\n` +
      `*Session:* \`${tmuxName}\`\n` +
      `*Resumed:* \`${shortId}...\`\n\n` +
      `Default workspace set — send messages directly.\n\n` +
      `_Ghostty tab — visible in your Ghostty window._`
    ) as TelegramMessage | undefined;
    if (msg && msg.message_id) {
      trackNotificationMessage(msg.message_id, name, 'resume-session');
    }
  } else if (mode === 'pty') {
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
      '\u26a0\ufe0f No injection backend available.\n' +
      'Install tmux, run Ghostty, or run: `npm install node-pty` in ~/.ccgram/'
    );
  }
}

async function injectAndRespond(session: SessionEntry, command: string, workspace: string): Promise<boolean> {
  const tmuxName: string = session.tmuxSession;

  if (!await sessionExists(tmuxName, session)) {
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
    } else if (isGhosttySession(session)) {
      // Ghostty: inject via AppleScript input text
      ghosttySessionManager.register(tmuxName, session.cwd);
      await ghosttySessionManager.sendKey(tmuxName, 'C-u');  // Ctrl+U: clear line
      await sleep(150);
      await ghosttySessionManager.writeLine(tmuxName, command); // text + send key "return" atomically
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

// ── PTY / tmux / Ghostty dispatch helpers ────────────────────────

/** Is this session managed as a live PTY handle by this bot process? */
function isPtySession(sessionName: string): boolean {
  return ptySessionManager.has(sessionName);
}

/** Is this session a Ghostty session (by stored sessionType)? */
function isGhosttySession(session: SessionEntry): boolean {
  return session.sessionType === 'ghostty';
}

/** Check session exists (PTY handle, Ghostty, OR tmux session). */
async function sessionExists(name: string, session?: SessionEntry): Promise<boolean> {
  if (ptySessionManager.has(name)) return true;
  if (session && isGhosttySession(session)) {
    ghosttySessionManager.register(name, session.cwd);
    return ghosttySessionManager.isAvailable();
  }
  if (TMUX_AVAILABLE) {
    try { await tmuxExec(`tmux has-session -t ${name} 2>/dev/null`); return true; }
    catch { return false; }
  }
  return false;
}

/**
 * Send a named key (Down, Up, Enter, C-m, C-c, C-u, Space) to a session.
 * For PTY: translates to escape sequence via ptySessionManager.sendKey.
 * For Ghostty: translates via ghosttySessionManager.sendKey (ANSI or modifiers).
 * For tmux: passes key name directly to tmux send-keys.
 */
async function sessionSendKey(name: string, key: string, session?: SessionEntry): Promise<void> {
  if (isPtySession(name)) {
    ptySessionManager.sendKey(name, key);
  } else if ((session && isGhosttySession(session)) || ghosttySessionManager.has(name)) {
    if (session) ghosttySessionManager.register(name, session.cwd);
    await ghosttySessionManager.sendKey(name, key);
  } else {
    await tmuxExec(`tmux send-keys -t ${name} ${key}`);
  }
  await sleep(100);
}

/** Capture session output. */
async function sessionCaptureOutput(name: string, session?: SessionEntry): Promise<string> {
  if (isPtySession(name)) return ptySessionManager.capture(name, 20) ?? '';
  if ((session && isGhosttySession(session)) || ghosttySessionManager.has(name)) {
    if (session) ghosttySessionManager.register(name, session.cwd);
    return await ghosttySessionManager.capture(name) ?? '(Ghostty scrollback capture unavailable)';
  }
  return capturePane(name);
}

/** Send Ctrl+C interrupt to a session. */
async function sessionInterrupt(name: string, session?: SessionEntry): Promise<void> {
  if (isPtySession(name)) ptySessionManager.interrupt(name);
  else if ((session && isGhosttySession(session)) || ghosttySessionManager.has(name)) {
    if (session) ghosttySessionManager.register(name, session.cwd);
    await ghosttySessionManager.interrupt(name);
  } else {
    await tmuxExec(`tmux send-keys -t ${name} C-c`);
  }
}

/** Icon for /sessions listing based on session type and live status. */
function sessionIcon(s: { workspace: string; token: string; session: SessionEntry; age: string }): string {
  if (s.session.sessionType === 'ghostty') return '\u{1F47B}'; // 👻
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
    const label: string = action === 'allow' ? '\u2705 Allowed'
      : action === 'always' ? '\ud83d\udd13 Always Allowed'
      : action === 'defer' ? '\u23F8 Deferred'
      : '\u274c Denied';

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

    // Single-select: write response file so hook can return updatedInput
    // (No keystroke injection needed — hook polls for this file)
    writeResponse(promptId, {
      action: 'answer',
      selectedOption: parsed.optionIndex,
      selectedLabel: optionLabel,
    });

    await answerCallbackQuery(query.id, `Selected: ${optionLabel}`);

    // Edit message to show selection and remove buttons
    try {
      await editMessageText(chatId, messageId!, `${originalText}\n\n\u2714 Selected: *${escapeMarkdown(optionLabel)}*`);
    } catch (err: unknown) {
      logger.error(`Failed to edit message: ${(err as Error).message}`);
    }

    // Note: hook will clean up the prompt files after reading the response

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

    // Multi-select submit: write response file so hook can return updatedInput
    // (No keystroke injection needed — hook polls for this file)
    const selectedIndices: number[] = selected
      .map((sel: boolean, idx: number) => sel ? idx + 1 : null)
      .filter((idx): idx is number => idx !== null);

    writeResponse(promptId, {
      action: 'answer',
      selectedOptions: selectedIndices,
      selectedLabels,
    });

    await answerCallbackQuery(query.id, `Submitted ${selectedLabels.length} options`);

    // Edit message to show selections and remove buttons
    const selectionText: string = selectedLabels.map(l => `\u2022 ${escapeMarkdown(l)}`).join('\n');
    try {
      await editMessageText(chatId, messageId!, `${originalText}\n\n\u2714 Selected:\n${selectionText}`);
    } catch (err: unknown) {
      logger.error(`Failed to edit message: ${(err as Error).message}`);
    }

    // Note: hook will clean up the prompt files after reading the response

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
      const sessionEntryQperm = findSessionByTmuxName(tmux);
      setTimeout(async () => {
        try {
          for (let i = 0; i < downPresses; i++) {
            await sessionSendKey(tmux, 'Down', sessionEntryQperm);
          }
          await sessionSendKey(tmux, 'Enter', sessionEntryQperm);
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

  } else if (type === 'perm-denied') {
    // Permission denied retry/dismiss
    const { action } = parsed;
    const label: string = action === 'retry' ? '\ud83d\udd04 Retrying...' : '\u274c Dismissed';

    // Write response file for the polling hook
    try {
      writeResponse(promptId, { action });
      logger.info(`Wrote perm-denied response for promptId=${promptId}: action=${action}`);
      await answerCallbackQuery(query.id, label);
    } catch (err: unknown) {
      logger.error(`Failed to write perm-denied response: ${(err as Error).message}`);
      await answerCallbackQuery(query.id, 'Failed to save response');
      return;
    }

    // Edit message to show result and remove buttons
    try {
      await editMessageText(chatId, messageId!, `${originalText}\n\n— ${label}`);
    } catch (err: unknown) {
      logger.error(`Failed to edit message: ${(err as Error).message}`);
    }

  } else if (type === 'pre-compact') {
    // Pre-compact proceed/block
    const { action } = parsed;
    const label: string = action === 'block' ? '\ud83d\uded1 Blocked' : '\u2705 Proceeding...';

    // Write response file for the polling hook
    try {
      writeResponse(promptId, { action });
      logger.info(`Wrote pre-compact response for promptId=${promptId}: action=${action}`);
      await answerCallbackQuery(query.id, label);
    } catch (err: unknown) {
      logger.error(`Failed to write pre-compact response: ${(err as Error).message}`);
      await answerCallbackQuery(query.id, 'Failed to save response');
      return;
    }

    // Edit message to show result and remove buttons
    try {
      await editMessageText(chatId, messageId!, `${originalText}\n\n— ${label}`);
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

  // /link <prompt>
  const linkMatch: RegExpMatchArray | null = text.match(/^\/link(?:\s+(.+))?$/s);
  if (linkMatch) {
    await handleLink(linkMatch[1] ? linkMatch[1].trim() : '');
    return;
  }

  // /effort [workspace] low|medium|high
  const effortMatch: RegExpMatchArray | null = text.match(/^\/effort(?:\s+(.+))?$/);
  if (effortMatch) {
    await handleEffort(effortMatch[1] ? effortMatch[1].trim() : '');
    return;
  }

  // /model [workspace] <model>
  const modelMatch: RegExpMatchArray | null = text.match(/^\/model(?:\s+(.+))?$/);
  if (modelMatch) {
    await handleModel(modelMatch[1] ? modelMatch[1].trim() : '');
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
