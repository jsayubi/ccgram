#!/usr/bin/env node

/**
 * Permission Hook — Called by Claude Code's PermissionRequest hook.
 *
 * Handles both tool permission requests and plan approval (ExitPlanMode).
 * Sends a Telegram message with inline keyboard buttons, then polls
 * for a response file written by the bot's callback query handler.
 *
 * Stdin JSON: { tool_name, tool_input, cwd, session_id, hook_event_name }
 * Stdout JSON: { "hookSpecificOutput": { "hookEventName": "PermissionRequest", "permissionDecision": "allow"|"deny", "alwaysAllow"?: true } }
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });

const https = require('https');
const { execSync } = require('child_process');
const { extractWorkspaceName } = require('./workspace-router');
const {
  generatePromptId,
  writePending,
  readResponse,
  cleanPrompt,
} = require('./prompt-bridge');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 120000; // 120 seconds

let outputSent = false; // Guard against double stdout output (e.g. SIGTERM race)

// ── Main ────────────────────────────────────────────────────────

async function main() {
  const raw = await readStdin();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    outputDeny();
    return;
  }

  const toolName = payload.tool_name || 'Unknown';
  const toolInput = payload.tool_input || {};
  const cwd = payload.cwd || process.cwd();
  const workspace = extractWorkspaceName(cwd);
  const promptId = generatePromptId();

  const isPlan = toolName === 'ExitPlanMode';

  // Build Telegram message and keyboard
  let messageText;
  let keyboard;

  if (isPlan) {
    // Plan approval — try to capture plan content from tmux
    let planContent = '';
    const tmuxSession = detectTmuxSession();
    if (tmuxSession) {
      try {
        const paneOutput = execSync(
          `tmux capture-pane -t ${tmuxSession} -p -S -50 2>/dev/null`,
          { encoding: 'utf8', timeout: 3000 }
        );
        planContent = cleanPlanOutput(paneOutput);
      } catch {}
    }

    messageText = `📋 *Plan Approval* — ${escapeMarkdown(workspace)}`;
    if (planContent) {
      const truncated = planContent.length > 2500
        ? planContent.slice(0, 2497) + '...'
        : planContent;
      messageText += `\n\n${truncated}`;
    }

    keyboard = {
      inline_keyboard: [
        [
          { text: '✅ Approve', callback_data: `plan:${promptId}:approve` },
          { text: '❌ Reject', callback_data: `plan:${promptId}:reject` },
        ],
      ],
    };
  } else {
    // Tool permission request
    const toolDescription = formatToolDescription(toolName, toolInput);

    messageText = `🔐 *Permission* — ${escapeMarkdown(workspace)}\n\n*Tool:* ${escapeMarkdown(toolName)}`;
    if (toolDescription) {
      const truncated = toolDescription.length > 2500
        ? toolDescription.slice(0, 2497) + '...'
        : toolDescription;
      messageText += `\n${truncated}`;
    }

    keyboard = {
      inline_keyboard: [
        [
          { text: '✅ Allow', callback_data: `perm:${promptId}:allow` },
          { text: '❌ Deny', callback_data: `perm:${promptId}:deny` },
          { text: '🔓 Always', callback_data: `perm:${promptId}:always` },
        ],
      ],
    };
  }

  // Write pending file for bot callback routing
  writePending(promptId, {
    type: isPlan ? 'plan' : 'permission',
    workspace,
    toolName,
    toolInput,
    tmuxSession: detectTmuxSession(),
  });

  // Send Telegram message with inline keyboard
  try {
    await sendTelegramWithKeyboard(messageText, keyboard);
  } catch (err) {
    process.stderr.write(`[permission-hook] Telegram send failed: ${err.message}\n`);
    outputDeny();
    cleanPrompt(promptId);
    return;
  }

  // Poll for response
  const response = await pollForResponse(promptId);

  if (response) {
    if (response.action === 'allow') {
      outputAllow(response.alwaysAllow || false);
    } else {
      outputDeny();
    }
  } else {
    // Timeout — deny and notify
    outputDeny();
    try {
      await sendTelegram(`⏰ *Timed out* — ${escapeMarkdown(workspace)}\n\nPermission denied automatically after timeout.`);
    } catch {}
  }

  cleanPrompt(promptId);
}

// ── Polling ─────────────────────────────────────────────────────

function pollForResponse(promptId) {
  return new Promise((resolve) => {
    const startTime = Date.now();

    const interval = setInterval(() => {
      const response = readResponse(promptId);
      if (response) {
        clearInterval(interval);
        resolve(response);
        return;
      }

      if (Date.now() - startTime >= POLL_TIMEOUT_MS) {
        clearInterval(interval);
        resolve(null);
      }
    }, POLL_INTERVAL_MS);

    // Handle SIGTERM gracefully
    process.on('SIGTERM', () => {
      clearInterval(interval);
      cleanPrompt(promptId);
      outputDeny();
      process.exit(0);
    });
  });
}

// ── Output ──────────────────────────────────────────────────────

function outputAllow(alwaysAllow) {
  if (outputSent) return;
  outputSent = true;
  const decision = {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      permissionDecision: 'allow',
    },
  };
  if (alwaysAllow) {
    decision.hookSpecificOutput.alwaysAllow = true;
  }
  process.stdout.write(JSON.stringify(decision));
}

function outputDeny() {
  if (outputSent) return;
  outputSent = true;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      permissionDecision: 'deny',
    },
  }));
}

// ── Telegram ────────────────────────────────────────────────────

function sendTelegramWithKeyboard(text, replyMarkup) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: 'Markdown',
      reply_markup: replyMarkup,
    });

    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 10000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error(`Telegram API ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Telegram request timed out'));
    });

    req.write(body);
    req.end();
  });
}

function sendTelegram(text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: 'Markdown',
    });

    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 5000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error(`Telegram API ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Telegram request timed out'));
    });

    req.write(body);
    req.end();
  });
}

// ── Helpers ──────────────────────────────────────────────────────

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => {
      if (!data) resolve('{}');
    }, 500);
  });
}

function detectTmuxSession() {
  if (process.env.TMUX) {
    try {
      return execSync('tmux display-message -p "#S"', { encoding: 'utf8' }).trim();
    } catch {
      return null;
    }
  }
  return null;
}

function formatToolDescription(toolName, toolInput) {
  if (toolName === 'Bash' && toolInput.command) {
    const cmd = toolInput.command;
    const truncated = cmd.length > 500 ? cmd.slice(0, 497) + '...' : cmd;
    return `*Command:* \`${escapeMarkdown(truncated)}\``;
  }
  if (toolName === 'Edit' && toolInput.file_path) {
    return `*File:* \`${escapeMarkdown(toolInput.file_path)}\``;
  }
  if (toolName === 'Write' && toolInput.file_path) {
    return `*File:* \`${escapeMarkdown(toolInput.file_path)}\``;
  }
  if (toolName === 'Read' && toolInput.file_path) {
    return `*File:* \`${escapeMarkdown(toolInput.file_path)}\``;
  }
  // Generic: show first key-value pair
  const keys = Object.keys(toolInput);
  if (keys.length > 0) {
    const key = keys[0];
    const val = String(toolInput[key]).slice(0, 200);
    return `*${escapeMarkdown(key)}:* \`${escapeMarkdown(val)}\``;
  }
  return '';
}

function cleanPlanOutput(raw) {
  let lines = raw.split('\n');
  // Strip ANSI codes
  lines = lines.map(l => l
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1B\][^\x07]*\x07/g, '')
  );
  // Remove empty trailing lines
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  while (lines.length && !lines[0].trim()) lines.shift();
  // Filter noise
  lines = lines.filter(l => {
    const t = l.trim();
    if (!t) return true;
    if (/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(t)) return false;
    if (/^(Clauding|Working|Waiting|Processing)/i.test(t)) return false;
    if (/^.+\|.+\|.+\|.+\$/.test(t)) return false;
    return true;
  });
  return lines.join('\n').trim();
}

function escapeMarkdown(text) {
  return text.replace(/([_*`\[])/g, '\\$1');
}

// ── Run ─────────────────────────────────────────────────────────

main().catch((err) => {
  process.stderr.write(`[permission-hook] Fatal: ${err.message}\n`);
  outputDeny();
  process.exit(1);
});
