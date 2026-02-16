#!/usr/bin/env node

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

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });

const https = require('https');
const fs = require('fs');
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
  upsertSession,
  recordProjectUsage,
  getRecentProjects,
} = require('./workspace-router');
const {
  writeResponse,
  readPending,
  updatePending,
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
const activeTypingIntervals = new Map(); // workspace → intervalId

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

function sendHtmlMessage(text) {
  return telegramAPI('sendMessage', {
    chat_id: CHAT_ID,
    text,
    parse_mode: 'HTML',
  });
}

const TYPING_SIGNAL_PATH = path.join(__dirname, 'src/data', 'typing-active');

function startTypingIndicator() {
  stopTypingIndicator();
  try { fs.writeFileSync(TYPING_SIGNAL_PATH, String(Date.now())); } catch {}
  const tick = () => {
    if (!fs.existsSync(TYPING_SIGNAL_PATH)) {
      stopTypingIndicator();
      return;
    }
    telegramAPI('sendChatAction', { chat_id: CHAT_ID, action: 'typing' }).catch(() => {});
  };
  tick();
  const intervalId = setInterval(tick, 4500);
  const timeoutId = setTimeout(() => stopTypingIndicator(), 5 * 60 * 1000);
  activeTypingIntervals.set('_active', { intervalId, timeoutId });
}

function stopTypingIndicator() {
  const entry = activeTypingIntervals.get('_active');
  if (entry) {
    clearInterval(entry.intervalId);
    clearTimeout(entry.timeoutId);
    activeTypingIntervals.delete('_active');
  }
  try { fs.unlinkSync(TYPING_SIGNAL_PATH); } catch {}
}

function answerCallbackQuery(callbackQueryId, text) {
  return telegramAPI('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text: text || '',
  });
}

function editMessageText(chatId, messageId, text, replyMarkup) {
  const body = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'Markdown',
  };
  if (replyMarkup) body.reply_markup = replyMarkup;
  return telegramAPI('editMessageText', body);
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
    '`/new [project]` — Start Claude in a project (shows recent if no arg)',
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

async function handleStatus(workspaceArg) {
  let workspace;
  if (workspaceArg) {
    workspace = workspaceArg;
  } else {
    const defaultWs = getDefaultWorkspace();
    if (defaultWs) {
      workspace = defaultWs;
    } else {
      await sendMessage('Usage: `/status <workspace>` or set a default with `/use`.');
      return;
    }
  }

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
    // Trim and take last 20 lines to avoid message length limits
    const trimmed = output.trim().split('\n').slice(-20).join('\n');
    const htmlMsg = `<b>${escapeHtml(resolvedName)}</b> tmux output:\n<pre>${escapeHtml(trimmed)}</pre>`;
    try {
      await sendHtmlMessage(htmlMsg);
    } catch {
      // Fallback to plain text if HTML fails
      await telegramAPI('sendMessage', { chat_id: CHAT_ID, text: `${resolvedName} tmux output:\n${trimmed}` });
    }
  } catch (err) {
    await sendMessage(`Could not read tmux session \`${tmuxName}\`: ${err.message}`);
  }
}

async function handleStop(workspaceArg) {
  let workspace;
  if (workspaceArg) {
    workspace = workspaceArg;
  } else {
    const defaultWs = getDefaultWorkspace();
    if (defaultWs) {
      workspace = defaultWs;
    } else {
      await sendMessage('Usage: `/stop <workspace>` or set a default with `/use`.');
      return;
    }
  }

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

  const resolvedName = resolved.workspace;
  const tmuxName = resolved.match.session.tmuxSession;

  try {
    await tmuxExec(`tmux has-session -t ${tmuxName} 2>/dev/null`);
  } catch {
    await sendMessage(`Tmux session \`${tmuxName}\` not found. Is Claude running in *${escapeMarkdown(resolvedName)}*?`);
    return;
  }

  try {
    await tmuxExec(`tmux send-keys -t ${tmuxName} C-c`);
    await sendMessage(`\u26d4 Sent interrupt to *${escapeMarkdown(resolvedName)}*`);
  } catch (err) {
    await sendMessage(`\u274c Failed to interrupt: ${err.message}`);
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

async function handleNew(nameArg) {
  if (!nameArg) {
    const recent = getRecentProjects(10);
    if (recent.length === 0) {
      await sendMessage('No project history yet.\n\nUse `/new <project-name>` to start.\nSearches: `~/projects/<name>`, `~/<name>`, `~/tools/<name>`');
      return;
    }
    const keyboard = [];
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

async function startProject(name) {
  const home = process.env.HOME;

  // 1. Find project directory — exact match first
  const candidates = [
    path.join(home, 'projects', name),
    path.join(home, name),
    path.join(home, 'tools', name),
  ];
  let projectDir = null;
  for (const dir of candidates) {
    try { if (fs.statSync(dir).isDirectory()) { projectDir = dir; break; } }
    catch {}
  }

  // 2. If no exact match, prefix match against ~/projects/ and ~/tools/ ONLY
  //    (skip ~/ to avoid matching Desktop, Documents, Downloads, Library, etc.)
  if (!projectDir) {
    const searchDirs = [
      path.join(home, 'projects'),
      path.join(home, 'tools'),
    ];
    const matches = [];
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
      const keyboard = [];
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
    await sendMessage(`Project \`${escapeMarkdown(name)}\` not found.\n\nSearched: ~/projects/, ~/, ~/tools/`);
    return;
  }

  // 3. Sanitize tmux session name (dots, colons, spaces are invalid in tmux)
  const tmuxName = name.replace(/[.:\s]/g, '-');

  // 4. Check if tmux session already exists
  try {
    await tmuxExec(`tmux has-session -t "${tmuxName}" 2>/dev/null`);
    // Already running — just register, set default, tell user
    upsertSession({ cwd: projectDir, tmuxSession: tmuxName, status: 'waiting', sessionId: null });
    recordProjectUsage(name, projectDir);
    setDefaultWorkspace(name);
    await sendMessage(`Session \`${tmuxName}\` already running.\nSet as default — send messages directly.`);
    return;
  } catch {} // Doesn't exist — create it

  // 5. Create tmux session and start claude
  try {
    await tmuxExec(`tmux new-session -d -s "${tmuxName}" -c "${projectDir}"`);
    await sleep(300);
    await tmuxExec(`tmux send-keys -t "${tmuxName}" 'claude' C-m`);
  } catch (err) {
    await sendMessage(`Failed to start session: ${err.message}`);
    return;
  }

  // 6. Pre-register session + record history + set as default
  upsertSession({ cwd: projectDir, tmuxSession: tmuxName, status: 'starting', sessionId: null });
  recordProjectUsage(name, projectDir);
  setDefaultWorkspace(name);

  // 7. Track confirmation message for reply-to routing
  const msg = await sendMessage(
    `Started Claude in *${escapeMarkdown(name)}*\n\n` +
    `*Path:* \`${projectDir}\`\n` +
    `*Session:* \`${tmuxName}\`\n\n` +
    `Default workspace set — send messages directly.`
  );
  if (msg && msg.message_id) {
    trackNotificationMessage(msg.message_id, name, 'new-session');
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
    startTypingIndicator();
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
  const type = parts[0];

  // Handle new: callback (format: new:<projectName>)
  if (type === 'new') {
    const projectName = parts.slice(1).join(':'); // rejoin in case name had colons
    await answerCallbackQuery(query.id, `Starting ${projectName}...`);
    try {
      await editMessageText(chatId, messageId, `${originalText}\n\n— Starting *${escapeMarkdown(projectName)}*...`);
    } catch {}
    await startProject(projectName);
    return;
  }

  if (parts.length < 3 && type !== 'opt-submit') {
    await answerCallbackQuery(query.id, 'Invalid callback');
    return;
  }

  const promptId = parts[1];
  const action = parts[2]; // undefined for opt-submit, which is fine

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

    const optIdx = parseInt(optionNumber, 10) - 1;
    const optionLabel = pending.options && pending.options[optIdx]
      ? pending.options[optIdx]
      : `Option ${optionNumber}`;

    // Multi-select: toggle selection state, update buttons, don't submit yet
    if (pending.multiSelect) {
      const selected = pending.selectedOptions || pending.options.map(() => false);
      selected[optIdx] = !selected[optIdx];
      updatePending(promptId, { selectedOptions: selected });

      // Rebuild keyboard with updated checkboxes
      const buttons = pending.options.map((label, idx) => ({
        text: `${selected[idx] ? '☑' : '☐'} ${idx + 1}. ${label}`,
        callback_data: `opt:${promptId}:${idx + 1}`,
      }));
      const keyboard = [];
      for (let i = 0; i < buttons.length; i += 2) {
        keyboard.push(buttons.slice(i, i + 2));
      }
      keyboard.push([{ text: '✅ Submit', callback_data: `opt-submit:${promptId}` }]);

      const checkLabel = selected[optIdx] ? '☑' : '☐';
      await answerCallbackQuery(query.id, `${checkLabel} ${optionLabel}`);

      // Edit message to show updated buttons
      try {
        await editMessageText(chatId, messageId, originalText, { inline_keyboard: keyboard });
      } catch (err) {
        logger.error(`Failed to edit message: ${err.message}`);
      }
      return;
    }

    // Single-select: inject arrow keys + Enter into tmux
    // Claude Code's AskUserQuestion UI: first option pre-highlighted, Down (N-1) times + Enter
    const downPresses = optIdx;
    try {
      for (let i = 0; i < downPresses; i++) {
        await tmuxExec(`tmux send-keys -t ${pending.tmuxSession} Down`);
        await sleep(100);
      }
      await tmuxExec(`tmux send-keys -t ${pending.tmuxSession} Enter`);

      // For multi-question flows: after the last question, send an extra
      // Enter to confirm the preview/submit step
      if (pending.isLast) {
        await sleep(500);
        await tmuxExec(`tmux send-keys -t ${pending.tmuxSession} Enter`);
      }

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

  } else if (type === 'opt-submit') {
    // Multi-select submit: inject Space toggles for selected options, then Enter
    const pending = readPending(promptId);

    if (!pending || !pending.tmuxSession) {
      await answerCallbackQuery(query.id, 'Session not found');
      return;
    }

    const selected = pending.selectedOptions || [];
    const selectedLabels = pending.options.filter((_, idx) => selected[idx]);

    if (selectedLabels.length === 0) {
      await answerCallbackQuery(query.id, 'No options selected');
      return;
    }

    // Inject keystrokes: iterate each option from top, Space if selected, Down to next
    // Claude Code multi-select UI starts with cursor on first option
    // After the listed options, Claude Code adds an auto-generated "Other" option,
    // then Submit. So we need: options.length Downs + 1 more Down to skip "Other"
    try {
      for (let i = 0; i < pending.options.length; i++) {
        if (selected[i]) {
          await tmuxExec(`tmux send-keys -t ${pending.tmuxSession} Space`);
          await sleep(100);
        }
        await tmuxExec(`tmux send-keys -t ${pending.tmuxSession} Down`);
        await sleep(100);
      }
      // Skip past the auto-added "Other" option to reach Submit
      await tmuxExec(`tmux send-keys -t ${pending.tmuxSession} Down`);
      await sleep(100);
      // Cursor is now on Submit — press Enter
      await tmuxExec(`tmux send-keys -t ${pending.tmuxSession} Enter`);

      // For multi-question flows: extra Enter to confirm
      if (pending.isLast) {
        await sleep(500);
        await tmuxExec(`tmux send-keys -t ${pending.tmuxSession} Enter`);
      }

      await answerCallbackQuery(query.id, `Submitted ${selectedLabels.length} options`);
    } catch (err) {
      logger.error(`Failed to inject tmux keystrokes: ${err.message}`);
      await answerCallbackQuery(query.id, 'Failed to send selections');
      return;
    }

    // Edit message to show selections and remove buttons
    const selectionText = selectedLabels.map(l => `• ${escapeMarkdown(l)}`).join('\n');
    try {
      await editMessageText(chatId, messageId, `${originalText}\n\n— Selected:\n${selectionText}`);
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
  stopTypingIndicator();
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

  // /status [workspace]
  const statusMatch = text.match(/^\/status(?:\s+(\S+))?$/);
  if (statusMatch) {
    await handleStatus(statusMatch[1] || null);
    return;
  }

  // /stop [workspace]
  const stopMatch = text.match(/^\/stop(?:\s+(\S+))?$/);
  if (stopMatch) {
    await handleStop(stopMatch[1] || null);
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

  // /new [project]
  const newMatch = text.match(/^\/new(?:\s+(.+))?$/);
  if (newMatch) {
    await handleNew(newMatch[1] ? newMatch[1].trim() : null);
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

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
