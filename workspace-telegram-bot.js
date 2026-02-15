#!/usr/bin/env node

/**
 * Workspace Telegram Bot — long-polling bot for remote Claude Code control.
 *
 * Commands:
 *   /<workspace> <command>   Route a command to the Claude session in that workspace
 *   /sessions                List all active sessions with workspace names
 *   /cmd <TOKEN> <command>   Token-based fallback for direct session access
 *   /help                    Show available commands
 *   /status <workspace>      Show tmux pane output for a workspace
 *   /compact [workspace]     Compact context in a workspace session
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });

const https = require('https');
const { exec } = require('child_process');
const {
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
} = require('./workspace-router');
const {
  writeResponse,
  readPending,
  cleanPrompt,
} = require('./prompt-bridge');
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!BOT_TOKEN || BOT_TOKEN === 'YOUR_BOT_TOKEN_HERE') {
  console.error('[telegram-bot] TELEGRAM_BOT_TOKEN not configured in .env');
  process.exit(1);
}

if (!CHAT_ID || CHAT_ID === 'YOUR_CHAT_ID_HERE') {
  console.error('[telegram-bot] TELEGRAM_CHAT_ID not configured in .env');
  process.exit(1);
}

let lastUpdateId = 0;

const logger = {
  info: (...args) => console.log(new Date().toISOString(), '[INFO]', ...args),
  warn: (...args) => console.warn(new Date().toISOString(), '[WARN]', ...args),
  error: (...args) => console.error(new Date().toISOString(), '[ERROR]', ...args),
  debug: (...args) => {
    if (process.env.LOG_LEVEL === 'debug') {
      console.log(new Date().toISOString(), '[DEBUG]', ...args);
    }
  },
};

// ── Telegram API helpers ────────────────────────────────────────

function telegramAPI(method, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options = {
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
      res.on('data', (chunk) => { data += chunk; });
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

function sendMessage(text) {
  return telegramAPI('sendMessage', {
    chat_id: CHAT_ID,
    text,
    parse_mode: 'Markdown',
  });
}

function answerCallbackQuery(callbackQueryId, text) {
  return telegramAPI('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text: text || '',
  });
}

function editMessageText(chatId, messageId, text) {
  return telegramAPI('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'Markdown',
  });
}

// ── Command handlers ────────────────────────────────────────────

async function handleHelp() {
  const defaultWs = getDefaultWorkspace();
  const msg = [
    '*Claude Remote Control*',
    '',
    '`/<workspace> <command>` — Send command to workspace',
    '`/use <workspace>` — Set default workspace',
    '`/use` — Show current default',
    '`/use clear` — Clear default',
    '`/compact [workspace]` — Compact context in workspace',
    '`/sessions` — List active sessions',
    '`/status <workspace>` — Show tmux output',
    '`/cmd <TOKEN> <command>` — Token-based fallback',
    '`/help` — This message',
    '',
    '_Prefix matching:_ `/ass hello` matches `assistant`',
    '_Reply-to:_ Reply to any notification to route to that workspace',
    defaultWs ? `_Default:_ plain text routes to *${escapeMarkdown(defaultWs)}*` : '_Tip:_ Use `/use <workspace>` to send plain text without a prefix',
  ].join('\n');

  await sendMessage(msg);
}

async function handleSessions() {
  pruneExpired();
  const sessions = listActiveSessions();

  if (sessions.length === 0) {
    await sendMessage('No active sessions.');
    return;
  }

  const lines = sessions.map((s) => {
    const statusIcon = s.session.description?.startsWith('waiting') ? '\u23f3' : '\u2705';
    return `${statusIcon} *${escapeMarkdown(s.workspace)}* (${s.age})`;
  });

  let footer = '';
  const defaultWs = getDefaultWorkspace();
  if (defaultWs) {
    footer = `\n\n_Default workspace:_ *${escapeMarkdown(defaultWs)}*`;
  }

  await sendMessage(`*Active Sessions*\n\n${lines.join('\n')}${footer}`);
}

async function handleStatus(workspace) {
  const resolved = resolveWorkspace(workspace);

  if (resolved.type === 'none') {
    await sendMessage(`No active session for *${escapeMarkdown(workspace)}*.`);
    return;
  }

  if (resolved.type === 'ambiguous') {
    const names = resolved.matches.map(m => `\`${escapeMarkdown(m.workspace)}\``).join(', ');
    await sendMessage(`Multiple matches: ${names}. Be more specific.`);
    return;
  }

  const match = resolved.match;
  const resolvedName = resolved.workspace;
  const tmuxName = match.session.tmuxSession;

  try {
    const output = await capturePane(tmuxName);
    // Trim and take last 15 lines to avoid message length limits
    const trimmed = output.trim().split('\n').slice(-15).join('\n');
    await sendMessage(`*${escapeMarkdown(resolvedName)}* tmux output:\n\`\`\`\n${trimmed}\n\`\`\``);
  } catch (err) {
    await sendMessage(`Could not read tmux session \`${tmuxName}\`: ${err.message}`);
  }
}

async function handleCmd(token, command) {
  const map = readSessionMap();
  const session = map[token];

  if (!session) {
    await sendMessage(`No session found for token \`${token}\`.`);
    return;
  }

  if (isExpired(session)) {
    await sendMessage(`Session \`${token}\` has expired.`);
    return;
  }

  await injectAndRespond(session, command, extractWorkspaceName(session.cwd));
}

async function handleWorkspaceCommand(workspace, command) {
  const resolved = resolveWorkspace(workspace);

  if (resolved.type === 'none') {
    await sendMessage(`No active session for *${escapeMarkdown(workspace)}*. Use /sessions to see available workspaces.`);
    return;
  }

  if (resolved.type === 'ambiguous') {
    const names = resolved.matches.map(m => `\`${escapeMarkdown(m.workspace)}\``).join(', ');
    await sendMessage(`Multiple matches: ${names}. Be more specific.`);
    return;
  }

  await injectAndRespond(resolved.match.session, command, resolved.workspace);
}

async function handleUse(arg) {
  // /use — show current default
  if (!arg) {
    const current = getDefaultWorkspace();
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
  const resolved = resolveWorkspace(arg);

  if (resolved.type === 'none') {
    await sendMessage(`No active session for *${escapeMarkdown(arg)}*. Use /sessions to see available workspaces.`);
    return;
  }

  if (resolved.type === 'ambiguous') {
    const names = resolved.matches.map(m => `\`${escapeMarkdown(m.workspace)}\``).join(', ');
    await sendMessage(`Multiple matches: ${names}. Be more specific.`);
    return;
  }

  const fullName = resolved.workspace;
  setDefaultWorkspace(fullName);
  await sendMessage(`Default workspace set to *${escapeMarkdown(fullName)}*. Plain text messages will route here.`);
}

async function handleCompact(workspaceArg) {
  let workspace;
  if (workspaceArg) {
    workspace = workspaceArg;
  } else {
    const defaultWs = getDefaultWorkspace();
    if (defaultWs) {
      workspace = defaultWs;
    } else {
      await sendMessage('Usage: `/compact <workspace>` or set a default with `/use`.');
      return;
    }
  }

  const resolved = resolveWorkspace(workspace);

  if (resolved.type === 'none') {
    await sendMessage(`No active session for *${escapeMarkdown(workspace)}*. Use /sessions to see available workspaces.`);
    return;
  }

  if (resolved.type === 'ambiguous') {
    const names = resolved.matches.map(m => `\`${escapeMarkdown(m.workspace)}\``).join(', ');
    await sendMessage(`Multiple matches: ${names}. Be more specific.`);
    return;
  }

  const tmuxName = resolved.match.session.tmuxSession;

  // Inject /compact into tmux
  const injected = await injectAndRespond(resolved.match.session, '/compact', resolved.workspace);
  if (!injected) return;

  // Two-phase polling to detect compact completion:
  // Phase 1: Wait for "Compacting" to appear (command started processing)
  // Phase 2: Wait for "Compacting" to disappear (command finished)

  let started = false;

  // Phase 1: Wait up to 10s for compact to start
  for (let i = 0; i < 5; i++) {
    await sleep(2000);
    try {
      const output = await capturePane(tmuxName);
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
      const output = await capturePane(tmuxName);
      if (output.includes('Compacted')) {
        const lines = output.trim().split('\n').slice(-10).join('\n');
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
      const output = await capturePane(tmuxName);
      if (!output.includes('Compacting')) {
        const lines = output.trim().split('\n').slice(-10).join('\n');
        await sendMessage(`\u2705 *${escapeMarkdown(resolved.workspace)}* compact done:\n\`\`\`\n${lines}\n\`\`\``);
        return;
      }
    } catch {
      break;
    }
  }

  // Timeout — show current pane state
  try {
    const output = await capturePane(tmuxName);
    const trimmed = output.trim().split('\n').slice(-5).join('\n');
    await sendMessage(`\u23f3 *${escapeMarkdown(resolved.workspace)}* compact may still be running:\n\`\`\`\n${trimmed}\n\`\`\``);
  } catch {
    // ignore
  }
}

async function injectAndRespond(session, command, workspace) {
  const tmuxName = session.tmuxSession;

  // Check tmux session exists
  try {
    await tmuxExec(`tmux has-session -t ${tmuxName} 2>/dev/null`);
  } catch {
    await sendMessage(`Tmux session \`${tmuxName}\` not found. Is Claude running in *${escapeMarkdown(workspace)}*?`);
    return false;
  }

  // Inject command directly via 3-step tmux send-keys (no confirmation polling)
  const escapedCommand = command.replace(/'/g, "'\"'\"'");
  try {
    await tmuxExec(`tmux send-keys -t ${tmuxName} C-u`);
    await sleep(150);
    await tmuxExec(`tmux send-keys -t ${tmuxName} '${escapedCommand}'`);
    await sleep(150);
    await tmuxExec(`tmux send-keys -t ${tmuxName} C-m`);

    const sent = await sendMessage(`\u2705 Sent to *${escapeMarkdown(workspace)}*: ${escapeMarkdown(command)}`);
    // Track the confirmation message so reply-to routing works on it too
    if (sent && sent.message_id) {
      trackNotificationMessage(sent.message_id, workspace, 'bot-confirm');
    }
    return true;
  } catch (err) {
    await sendMessage(`\u274c Failed: ${err.message}`);
    return false;
  }
}

function tmuxExec(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, (err) => {
      if (err) reject(err);
      else resolve(true);
    });
  });
}

// ── Callback query handler ───────────────────────────────────────

async function processCallbackQuery(query) {
  const chatId = String(query.message?.chat?.id);
  if (chatId !== String(CHAT_ID)) {
    logger.warn(`Ignoring callback from unauthorized chat: ${chatId}`);
    return;
  }

  const data = query.data || '';
  const messageId = query.message?.message_id;
  const originalText = query.message?.text || '';

  logger.info(`Callback: ${data}`);

  const parts = data.split(':');
  if (parts.length < 3) {
    await answerCallbackQuery(query.id, 'Invalid callback');
    return;
  }

  const [type, promptId, action] = parts;

  if (type === 'perm') {
    // Permission response: write response file for the polling hook
    const pending = readPending(promptId);

    if (!pending) {
      await answerCallbackQuery(query.id, 'Session not found');
      return;
    }

    const label = action === 'allow' ? '✅ Allowed' : action === 'always' ? '🔓 Always Allowed' : '❌ Denied';

    // Write response file — the permission-hook.js is polling for this
    try {
      writeResponse(promptId, { action });
      logger.info(`Wrote permission response for promptId=${promptId}: action=${action}`);
      await answerCallbackQuery(query.id, label);
    } catch (err) {
      logger.error(`Failed to write permission response: ${err.message}`);
      await answerCallbackQuery(query.id, 'Failed to save response');
      return;
    }

    // Edit message to show result and remove buttons
    try {
      await editMessageText(chatId, messageId, `${originalText}\n\n— ${label}`);
    } catch (err) {
      logger.error(`Failed to edit message: ${err.message}`);
    }

  } else if (type === 'opt') {
    // Question option: inject keystroke via tmux
    const optionNumber = action; // "1", "2", etc.
    const pending = readPending(promptId);

    if (!pending || !pending.tmuxSession) {
      await answerCallbackQuery(query.id, 'Session not found');
      return;
    }

    const optionLabel = pending.options && pending.options[parseInt(optionNumber, 10) - 1]
      ? pending.options[parseInt(optionNumber, 10) - 1]
      : `Option ${optionNumber}`;

    // Inject option selection via arrow keys + Enter into tmux
    // Claude Code's AskUserQuestion UI uses an interactive selector:
    // first option is pre-highlighted, so Down (N-1) times + Enter
    const downPresses = parseInt(optionNumber, 10) - 1;
    try {
      for (let i = 0; i < downPresses; i++) {
        await tmuxExec(`tmux send-keys -t ${pending.tmuxSession} Down`);
        await sleep(100);
      }
      await tmuxExec(`tmux send-keys -t ${pending.tmuxSession} Enter`);
      await answerCallbackQuery(query.id, `Selected: ${optionLabel}`);
    } catch (err) {
      logger.error(`Failed to inject tmux keystroke: ${err.message}`);
      await answerCallbackQuery(query.id, 'Failed to send selection');
      return;
    }

    // Edit message to show selection and remove buttons
    try {
      await editMessageText(chatId, messageId, `${originalText}\n\n— Selected: *${escapeMarkdown(optionLabel)}*`);
    } catch (err) {
      logger.error(`Failed to edit message: ${err.message}`);
    }

    cleanPrompt(promptId);

  } else if (type === 'qperm') {
    // Combined question+permission: allow permission AND inject answer keystroke
    const optionNumber = action; // "1", "2", etc.
    const pending = readPending(promptId);

    if (!pending) {
      await answerCallbackQuery(query.id, 'Session not found');
      return;
    }

    const optionLabel = pending.options && pending.options[parseInt(optionNumber, 10) - 1]
      ? pending.options[parseInt(optionNumber, 10) - 1]
      : `Option ${optionNumber}`;

    // 1. Write permission response (allow) — unblocks the permission hook
    try {
      writeResponse(promptId, { action: 'allow', selectedOption: optionNumber });
      logger.info(`Wrote qperm response for promptId=${promptId}: option=${optionNumber}`);
      await answerCallbackQuery(query.id, `Selected: ${optionLabel}`);
    } catch (err) {
      logger.error(`Failed to write qperm response: ${err.message}`);
      await answerCallbackQuery(query.id, 'Failed to save response');
      return;
    }

    // 2. Schedule keystroke injection after a delay (wait for question UI to appear)
    if (pending.tmuxSession) {
      const tmux = pending.tmuxSession;
      const downPresses = parseInt(optionNumber, 10) - 1;
      setTimeout(async () => {
        try {
          for (let i = 0; i < downPresses; i++) {
            await tmuxExec(`tmux send-keys -t ${tmux} Down`);
            await sleep(100);
          }
          await tmuxExec(`tmux send-keys -t ${tmux} Enter`);
          logger.info(`Injected question answer into ${tmux}: option ${optionNumber}`);
        } catch (err) {
          logger.error(`Failed to inject question answer: ${err.message}`);
        }
      }, 4000); // 4s delay for permission hook to return + question UI to render
    }

    // Edit message to show selection
    try {
      await editMessageText(chatId, messageId, `${originalText}\n\n— Selected: *${escapeMarkdown(optionLabel)}*`);
    } catch (err) {
      logger.error(`Failed to edit message: ${err.message}`);
    }

  } else {
    await answerCallbackQuery(query.id, 'Unknown action');
  }
}

// ── Message router ──────────────────────────────────────────────

async function processMessage(msg) {
  // Only accept messages from the configured chat
  const chatId = String(msg.chat.id);
  if (chatId !== String(CHAT_ID)) {
    logger.warn(`Ignoring message from unauthorized chat: ${chatId}`);
    return;
  }

  const text = (msg.text || '').trim();
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

  // /status <workspace>
  const statusMatch = text.match(/^\/status\s+(\S+)/);
  if (statusMatch) {
    await handleStatus(statusMatch[1]);
    return;
  }

  // /use [workspace]
  const useMatch = text.match(/^\/use(?:\s+(.*))?$/);
  if (useMatch) {
    await handleUse(useMatch[1] ? useMatch[1].trim() : null);
    return;
  }

  // /compact [workspace]
  const compactMatch = text.match(/^\/compact(?:\s+(\S+))?$/);
  if (compactMatch) {
    await handleCompact(compactMatch[1] || null);
    return;
  }

  // /cmd TOKEN command
  const cmdMatch = text.match(/^\/cmd\s+(\S+)\s+(.+)/s);
  if (cmdMatch) {
    await handleCmd(cmdMatch[1], cmdMatch[2]);
    return;
  }

  // /<workspace> command  (anything starting with / that isn't a known command)
  const wsMatch = text.match(/^\/(\S+)\s+(.+)/s);
  if (wsMatch) {
    const workspace = wsMatch[1];
    const command = wsMatch[2];

    // Skip Telegram built-in bot commands that start with @
    if (workspace.includes('@')) return;

    await handleWorkspaceCommand(workspace, command);
    return;
  }

  // If just a slash command with no args, check if it's a workspace (with prefix matching)
  const bareWs = text.match(/^\/(\S+)$/);
  if (bareWs) {
    const resolved = resolveWorkspace(bareWs[1]);
    if (resolved.type === 'exact' || resolved.type === 'prefix') {
      await handleStatus(resolved.workspace);
    } else if (resolved.type === 'ambiguous') {
      const names = resolved.matches.map(m => `\`${escapeMarkdown(m.workspace)}\``).join(', ');
      await sendMessage(`Multiple matches: ${names}. Be more specific.`);
    } else {
      await sendMessage(`Unknown command: \`${text}\`. Try /help`);
    }
    return;
  }

  // Plain text — try reply-to routing, then default workspace, then show hint
  const replyToId = msg.reply_to_message && msg.reply_to_message.message_id;
  if (replyToId) {
    const replyWorkspace = getWorkspaceForMessage(replyToId);
    if (replyWorkspace) {
      await handleWorkspaceCommand(replyWorkspace, text);
      return;
    }
  }

  const defaultWs = getDefaultWorkspace();
  if (defaultWs) {
    await handleWorkspaceCommand(defaultWs, text);
    return;
  }

  await sendMessage('Use `/help` to see available commands, or `/use <workspace>` to set a default.');
}

// ── Long polling loop ───────────────────────────────────────────

async function poll() {
  while (true) {
    try {
      const updates = await telegramAPI('getUpdates', {
        offset: lastUpdateId + 1,
        timeout: 30,
        allowed_updates: ['message', 'callback_query'],
      });

      for (const update of updates) {
        lastUpdateId = update.update_id;

        if (update.callback_query) {
          try {
            await processCallbackQuery(update.callback_query);
          } catch (err) {
            logger.error(`Error processing callback query: ${err.message}`);
          }
        } else if (update.message) {
          try {
            await processMessage(update.message);
          } catch (err) {
            logger.error(`Error processing message: ${err.message}`);
          }
        }
      }
    } catch (err) {
      // Network error — back off and retry
      logger.error(`Polling error: ${err.message}`);
      await sleep(5000);
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────

function capturePane(tmuxSession) {
  return new Promise((resolve, reject) => {
    exec(`tmux capture-pane -t ${tmuxSession} -p`, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

function escapeMarkdown(text) {
  // Telegram Markdown v1 only needs these escaped
  return text.replace(/([_*`\[])/g, '\\$1');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Startup ─────────────────────────────────────────────────────

async function start() {
  logger.info('Starting Workspace Telegram Bot (long polling)...');
  logger.info(`Chat ID: ${CHAT_ID}`);

  // Prune expired sessions on startup
  const pruned = pruneExpired();
  if (pruned > 0) {
    logger.info(`Pruned ${pruned} expired sessions`);
  }

  // Delete any existing webhook to ensure long polling works
  try {
    await telegramAPI('deleteWebhook', {});
    logger.info('Webhook cleared, using long polling');
  } catch (err) {
    logger.warn(`Could not delete webhook: ${err.message}`);
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

start().catch((err) => {
  logger.error(`Fatal: ${err.message}`);
  process.exit(1);
});
