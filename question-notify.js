#!/usr/bin/env node

/**
 * Question Notify — Called by Claude Code's PreToolUse hook (matcher: AskUserQuestion).
 *
 * Non-blocking: sends a Telegram message with option buttons, then returns
 * immediately with "allow" so the tool runs. The bot callback handler later
 * injects the selected option number via tmux.
 *
 * Stdin JSON: { tool_name, tool_input, cwd, session_id, hook_event_name }
 * tool_input.questions: [{ question, header, options: [{ label, description }], multiSelect }]
 *
 * Stdout JSON: { "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "allow" } }
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });

const https = require('https');
const { extractWorkspaceName } = require('./workspace-router');
const { generatePromptId, writePending } = require('./prompt-bridge');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ── Main ────────────────────────────────────────────────────────

async function main() {
  // Always allow the tool — output immediately so we don't block
  const allowOutput = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
    },
  });

  const raw = await readStdin();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.stdout.write(allowOutput);
    return;
  }

  const toolInput = payload.tool_input || {};
  const cwd = payload.cwd || process.cwd();
  const workspace = extractWorkspaceName(cwd);

  // Extract questions from tool_input
  const questions = toolInput.questions || [];
  if (questions.length === 0) {
    process.stdout.write(allowOutput);
    return;
  }

  // Detect tmux session for keystroke injection
  const tmuxSession = detectTmuxSession();

  // Process each question (usually just one)
  for (const q of questions) {
    const promptId = generatePromptId(); // Unique ID per question
    const questionText = q.question || 'Question';
    const options = q.options || [];

    let messageText = `❓ *Question* — ${escapeMarkdown(workspace)}\n\n${escapeMarkdown(questionText)}`;

    if (options.length > 0) {
      // Build inline keyboard with numbered options
      const buttons = options.map((opt, idx) => ({
        text: `${idx + 1}. ${opt.label}`,
        callback_data: `opt:${promptId}:${idx + 1}`,
      }));

      // Arrange buttons in rows (max 2 per row for readability)
      const keyboard = [];
      for (let i = 0; i < buttons.length; i += 2) {
        keyboard.push(buttons.slice(i, i + 2));
      }

      // Add option descriptions to the message
      const optionLines = options.map((opt, idx) =>
        `*${idx + 1}.* ${escapeMarkdown(opt.label)}${opt.description ? ` — _${escapeMarkdown(opt.description)}_` : ''}`
      );
      messageText += '\n\n' + optionLines.join('\n');

      // Write pending file so bot callback handler knows the tmux session
      writePending(promptId, {
        type: 'question',
        workspace,
        tmuxSession,
        questionText,
        options: options.map(o => o.label),
      });

      // Send Telegram message with inline keyboard
      try {
        await sendTelegramWithKeyboard(messageText, { inline_keyboard: keyboard });
      } catch (err) {
        process.stderr.write(`[question-notify] Telegram send failed: ${err.message}\n`);
      }
    } else {
      // No options — free text question
      messageText += `\n\n_Reply with_ \`/${escapeMarkdown(workspace)} your answer\``;

      writePending(promptId, {
        type: 'question-freetext',
        workspace,
        tmuxSession,
        questionText,
      });

      try {
        await sendTelegram(messageText);
      } catch (err) {
        process.stderr.write(`[question-notify] Telegram send failed: ${err.message}\n`);
      }
    }
  }

  // Output allow — don't block the tool
  process.stdout.write(allowOutput);
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
      const { execSync } = require('child_process');
      return execSync('tmux display-message -p "#S"', { encoding: 'utf8' }).trim();
    } catch {
      return null;
    }
  }
  return null;
}

function escapeMarkdown(text) {
  return text.replace(/([_*`\[])/g, '\\$1');
}

// ── Run ─────────────────────────────────────────────────────────

main().catch((err) => {
  process.stderr.write(`[question-notify] Fatal: ${err.message}\n`);
  // Still output allow so we don't block the tool
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
    },
  }));
  process.exit(1);
});
