#!/usr/bin/env node

/**
 * Permission Hook — Called by Claude Code's PermissionRequest hook.
 *
 * Blocking approach:
 *   1. Sends a Telegram message with inline keyboard buttons
 *   2. Polls for a response file written by the bot's callback handler
 *   3. Outputs the permission decision via stdout
 *   4. Exits cleanly
 *
 * Stdin JSON: { tool_name, tool_input, cwd, session_id, hook_event_name }
 * Stdout JSON: { hookSpecificOutput: { hookEventName, decision: { behavior } } }
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });

const fs = require('fs');
const https = require('https');
const { execSync } = require('child_process');
const { extractWorkspaceName, trackNotificationMessage } = require('./workspace-router');
const { generatePromptId, writePending, cleanPrompt, PROMPTS_DIR } = require('./prompt-bridge');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 90000; // 90 seconds max wait

// Debug logging to file (since stdout is for Claude Code)
const LOG_FILE = path.join(__dirname, 'logs', 'permission-hook-debug.log');
function debugLog(msg) {
  const ts = new Date().toISOString();
  try {
    fs.appendFileSync(LOG_FILE, `${ts} ${msg}\n`);
  } catch {}
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
  const raw = await readStdin();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return; // Can't parse — exit without decision
  }

  const toolName = payload.tool_name || 'Unknown';

  // AskUserQuestion: exit silently so Claude Code shows the interactive
  // question/permission UI in the terminal. The question-notify.js PreToolUse
  // hook sends the Telegram notification. Clicking an option injects arrow
  // keys + Enter which both selects the answer AND grants permission.
  if (toolName === 'AskUserQuestion') {
    return;
  }

  const toolInput = payload.tool_input || {};
  const cwd = payload.cwd || process.cwd();
  const workspace = extractWorkspaceName(cwd);
  const promptId = generatePromptId();
  const tmuxSession = detectTmuxSession();

  const isPlan = toolName === 'ExitPlanMode';

  // Build Telegram message and keyboard
  let messageText;
  let keyboard;

  if (isPlan) {
    // Plan approval — try to capture plan content from tmux
    let planContent = '';
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
          { text: '✅ Approve', callback_data: `perm:${promptId}:allow` },
          { text: '❌ Reject', callback_data: `perm:${promptId}:deny` },
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

  // Write pending file so bot callback handler can write the response
  writePending(promptId, {
    type: isPlan ? 'plan' : 'permission',
    workspace,
    toolName,
    toolInput,
    tmuxSession,
  });

  // Send Telegram message with inline keyboard
  debugLog(`[${promptId}] Sending Telegram message for ${toolName}...`);
  try {
    const result = await sendTelegramWithKeyboard(messageText, keyboard);
    debugLog(`[${promptId}] Telegram message sent`);
    if (result && result.message_id) {
      trackNotificationMessage(result.message_id, workspace, 'permission');
    }
  } catch (err) {
    debugLog(`[${promptId}] Telegram send failed: ${err.message}`);
    process.stderr.write(`[permission-hook] Telegram send failed: ${err.message}\n`);
    cleanPrompt(promptId);
    return; // Can't notify — exit without decision
  }

  // Poll for response file
  debugLog(`[${promptId}] Starting to poll for response...`);
  const response = await pollForResponse(promptId);

  if (response) {
    const action = response.action || 'allow';
    debugLog(`[${promptId}] Got response: action=${action}`);
    let decision;
    if (action === 'deny') {
      decision = 'deny';
    } else if (action === 'always') {
      decision = 'allow';
    } else {
      decision = 'allow';
    }

    const output = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: {
          behavior: decision,
        },
      },
    });

    debugLog(`[${promptId}] Writing to stdout: ${output}`);
    process.stdout.write(output + '\n');
    debugLog(`[${promptId}] Stdout written`);
  } else {
    debugLog(`[${promptId}] No response received (timed out or error)`);
  }

  // Clean up
  cleanPrompt(promptId);
  debugLog(`[${promptId}] Cleaned up, letting process exit naturally`);
}

// ── Polling ─────────────────────────────────────────────────────

function pollForResponse(promptId) {
  return new Promise((resolve) => {
    const responseFile = path.join(PROMPTS_DIR, `response-${promptId}.json`);
    const startTime = Date.now();

    const interval = setInterval(() => {
      // Check timeout
      if (Date.now() - startTime > POLL_TIMEOUT_MS) {
        clearInterval(interval);
        process.stderr.write(`[permission-hook] Timed out waiting for response\n`);
        resolve(null);
        return;
      }

      // Check for response file
      try {
        if (fs.existsSync(responseFile)) {
          const raw = fs.readFileSync(responseFile, 'utf8');
          const data = JSON.parse(raw);
          clearInterval(interval);
          resolve(data);
        }
      } catch {
        // File not ready yet or parse error — keep polling
      }
    }, POLL_INTERVAL_MS);
  });
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
      timeout: 5000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed.result || null);
          } catch {
            resolve(null);
          }
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
    let resolved = false;
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => {
      if (!resolved) { resolved = true; resolve(data); }
    });
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        process.stdin.destroy();
        resolve(data || '{}');
      }
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
  lines = lines.map(l => l
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1B\][^\x07]*\x07/g, '')
  );
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  while (lines.length && !lines[0].trim()) lines.shift();
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
});
