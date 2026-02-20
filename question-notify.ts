#!/usr/bin/env node

/**
 * Question Notify — Called by Claude Code's PreToolUse hook (matcher: AskUserQuestion).
 *
 * Non-blocking: sends a Telegram message with option buttons, then returns
 * without stdout output. AskUserQuestion must be in the permissions allow
 * list (settings.json) so Claude Code handles permission automatically.
 * The bot callback handler later injects the selected option number via tmux.
 *
 * Stdin JSON: { tool_name, tool_input, cwd, session_id, hook_event_name }
 * tool_input.questions: [{ question, header, options: [{ label, description }], multiSelect }]
 *
 * Stdout: (none — intentionally omitted so Claude Code shows the interactive question UI)
 */

import path from 'path';
import { PROJECT_ROOT } from './src/utils/paths';
require('dotenv').config({ path: path.join(PROJECT_ROOT, '.env'), quiet: true });

import https from 'https';
import { extractWorkspaceName, trackNotificationMessage } from './workspace-router';
import { generatePromptId, writePending } from './prompt-bridge';
import type { AskUserQuestionItem, InlineKeyboardMarkup, InlineKeyboardButton, TelegramMessage } from './src/types';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // NOTE: We intentionally do NOT output permissionDecision to stdout.
  // If we output "allow" here, Claude Code bypasses the interactive
  // question UI entirely. This hook only sends the Telegram notification
  // for remote answering. Permission is handled by the PermissionRequest hook.
  //
  // We delay 2s so the permission notification (from PermissionRequest hook)
  // appears first in Telegram. The user must click Allow before answering.

  const raw = await readStdin();

  // Delay so permission notification appears first in Telegram
  await new Promise<void>(r => setTimeout(r, 2000));
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }

  const toolInput = (payload.tool_input || {}) as Record<string, unknown>;
  const cwd = (payload.cwd as string) || process.cwd();
  const workspace = extractWorkspaceName(cwd)!;

  // Extract questions from tool_input
  const questions = (toolInput.questions || []) as AskUserQuestionItem[];
  if (questions.length === 0) {
    return;
  }

  // Detect tmux session for keystroke injection
  const tmuxSession = detectTmuxSession();

  const totalQuestions = questions.length;

  // Process each question (usually just one)
  for (let qi = 0; qi < questions.length; qi++) {
    const q = questions[qi];
    const promptId = generatePromptId(); // Unique ID per question
    const questionText = q.question || 'Question';
    const options = q.options || [];
    const isLast = qi === totalQuestions - 1;

    let messageText = `\u2753 *Question* — ${escapeMarkdown(workspace)}\n\n${escapeMarkdown(questionText)}`;

    if (options.length > 0) {
      // Build inline keyboard with numbered options
      const prefix = q.multiSelect ? '\u2610 ' : '';
      const buttons: InlineKeyboardButton[] = options.map((opt, idx) => ({
        text: `${prefix}${idx + 1}. ${opt.label}`,
        callback_data: `opt:${promptId}:${idx + 1}`,
      }));

      // Arrange buttons in rows (max 2 per row for readability)
      const keyboard: InlineKeyboardButton[][] = [];
      for (let i = 0; i < buttons.length; i += 2) {
        keyboard.push(buttons.slice(i, i + 2));
      }
      // Add Submit button for multi-select questions
      if (q.multiSelect) {
        keyboard.push([{ text: '\u2705 Submit', callback_data: `opt-submit:${promptId}` }]);
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
        multiSelect: q.multiSelect || false,
        selectedOptions: q.multiSelect ? options.map(() => false) : undefined,
        isLast,
      });

      // Send Telegram message with inline keyboard
      try {
        const result = await sendTelegramWithKeyboard(messageText, { inline_keyboard: keyboard });
        if (result && result.message_id) {
          trackNotificationMessage(result.message_id, workspace, 'question');
        }
      } catch (err: unknown) {
        process.stderr.write(`[question-notify] Telegram send failed: ${(err as Error).message}\n`);
      }
    } else {
      // No options — free text question
      messageText += `\n\n_Reply to this message with your answer_`;

      writePending(promptId, {
        type: 'question-freetext',
        workspace,
        tmuxSession,
        questionText,
      });

      try {
        const result = await sendTelegram(messageText);
        if (result && result.message_id) {
          trackNotificationMessage(result.message_id, workspace, 'question-freetext');
        }
      } catch (err: unknown) {
        process.stderr.write(`[question-notify] Telegram send failed: ${(err as Error).message}\n`);
      }
    }
  }
}

// ── Telegram ────────────────────────────────────────────────────

function sendTelegramWithKeyboard(text: string, replyMarkup: InlineKeyboardMarkup): Promise<TelegramMessage | null> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: 'Markdown',
      reply_markup: replyMarkup,
    });

    const options: https.RequestOptions = {
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
      res.on('data', (chunk: string) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode! >= 200 && res.statusCode! < 300) {
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

function sendTelegram(text: string): Promise<TelegramMessage | null> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: 'Markdown',
    });

    const options: https.RequestOptions = {
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
      res.on('data', (chunk: string) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode! >= 200 && res.statusCode! < 300) {
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

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    let resolved = false;
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => { data += chunk; });
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

function detectTmuxSession(): string | null {
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

function escapeMarkdown(text: string): string {
  return text.replace(/([_*`\[])/g, '\\$1');
}

// ── Run ─────────────────────────────────────────────────────────

main().catch((err: Error) => {
  process.stderr.write(`[question-notify] Fatal: ${err.message}\n`);
});
