#!/usr/bin/env node

/**
 * Question Notify — Called by Claude Code's PreToolUse hook (matcher: AskUserQuestion).
 *
 * BLOCKING mode (v2.0): Sends Telegram notification with option buttons, polls for
 * user selection, then outputs `updatedInput` via stdout so Claude Code receives
 * the answer directly — no keystroke injection needed!
 *
 * This works with ANY terminal (tmux, Ghostty, bare terminal).
 *
 * Stdin JSON: { tool_name, tool_input, cwd, session_id, hook_event_name }
 * tool_input.questions: [{ question, header, options: [{ label, description }], multiSelect }]
 *
 * Stdout: { hookSpecificOutput: { updatedInput: { questions: [...] }, permissionDecision: "allow" } }
 */

import path from 'path';
import { PROJECT_ROOT } from './src/utils/paths';
require('dotenv').config({ path: path.join(PROJECT_ROOT, '.env'), quiet: true });

import fs from 'fs';
import https from 'https';
import { extractWorkspaceName, trackNotificationMessage } from './workspace-router';
import { generatePromptId, writePending, readResponse, cleanPrompt, PROMPTS_DIR } from './prompt-bridge';
import { isUserActiveAtTerminal } from './src/utils/active-check';
import type { AskUserQuestionItem, InlineKeyboardMarkup, InlineKeyboardButton, TelegramMessage } from './src/types';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Polling configuration (same as permission-hook.ts)
const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 90000; // 90 seconds

/** Output format for Claude Code's PreToolUse hook with updatedInput.
 *
 * For AskUserQuestion, the hook must:
 * 1. Include hookEventName: "PreToolUse"
 * 2. Echo back the original `questions` array unchanged
 * 3. Provide a separate `answers` object mapping question text → answer label
 *    (multi-select: join labels with commas)
 * 4. Set permissionDecision: "allow"
 */
interface QuestionHookOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'allow';
    updatedInput: {
      questions: AskUserQuestionItem[];
      answers: Record<string, string>;
    };
  };
}

// ── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const raw = await readStdin();

  // Skip Telegram notification if user is at terminal AND this wasn't Telegram-injected.
  // If the command came from Telegram, the question must go back to Telegram.
  const typingActivePath = path.join(PROJECT_ROOT, 'src/data', 'typing-active');
  const isTelegramInjected = fs.existsSync(typingActivePath);
  if (!isTelegramInjected && isUserActiveAtTerminal()) {
    // User is at terminal — let Claude Code show its native UI
    return;
  }

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

  // Detect session name (for session map, even though we don't inject keystrokes)
  const tmuxSession = detectSessionName(cwd);

  // Collect answers: map of question text → selected label(s)
  // Multi-select: join labels with commas (Claude Code format).
  const answers: Record<string, string> = {};

  // Process each question (usually just one)
  for (let qi = 0; qi < questions.length; qi++) {
    const q = questions[qi];
    const promptId = generatePromptId(); // Unique ID per question
    const questionText = q.question || 'Question';
    const options = q.options || [];
    const isLast = qi === questions.length - 1;
    const isMultiSelect = q.multiSelect || false;

    let messageText = `\u2753 *Question* — ${escapeMarkdown(workspace)}\n\n${escapeMarkdown(questionText)}`;

    if (options.length > 0) {
      // Build inline keyboard with numbered options
      const prefix = isMultiSelect ? '\u2610 ' : '';
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
      if (isMultiSelect) {
        keyboard.push([{ text: '\u2705 Submit', callback_data: `opt-submit:${promptId}` }]);
      }

      // Add option descriptions to the message
      const optionLines = options.map((opt, idx) =>
        `*${idx + 1}.* ${escapeMarkdown(opt.label)}${opt.description ? ` — _${escapeMarkdown(opt.description)}_` : ''}`
      );
      messageText += '\n\n' + optionLines.join('\n');

      // Write pending file so bot callback handler can write response
      writePending(promptId, {
        type: 'question',
        workspace,
        tmuxSession,
        questionText,
        options: options.map(o => o.label),
        multiSelect: isMultiSelect,
        selectedOptions: isMultiSelect ? options.map(() => false) : undefined,
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
        cleanPrompt(promptId);
        return; // Can't notify — exit without output
      }

      // Poll for response
      const response = await pollForResponse(promptId);

      if (response) {
        // Extract answer from response
        if (isMultiSelect) {
          // Multi-select: response.selectedLabels is string[] — join with commas
          const selectedLabels = (response.selectedLabels as string[]) || [];
          answers[questionText] = selectedLabels.join(',');
        } else {
          // Single-select: response.selectedLabel is string
          const selectedLabel = (response.selectedLabel as string) || '';
          answers[questionText] = selectedLabel;
        }
      } else {
        // Timed out — exit without output (Claude Code will show native UI on retry)
        cleanPrompt(promptId);
        return;
      }

      cleanPrompt(promptId);
    } else {
      // No options — free text question
      messageText += `\n\n_Reply to this message with your answer_`;

      writePending(promptId, {
        type: 'question-freetext',
        workspace,
        tmuxSession,
        questionText,
        isLast,
      });

      try {
        const result = await sendTelegram(messageText);
        if (result && result.message_id) {
          trackNotificationMessage(result.message_id, workspace, 'question-freetext');
        }
      } catch (err: unknown) {
        process.stderr.write(`[question-notify] Telegram send failed: ${(err as Error).message}\n`);
        cleanPrompt(promptId);
        return;
      }

      // Poll for response
      const response = await pollForResponse(promptId);

      if (response) {
        const textAnswer = (response.textAnswer as string) || '';
        answers[questionText] = textAnswer;
      } else {
        cleanPrompt(promptId);
        return;
      }

      cleanPrompt(promptId);
    }
  }

  // Output updatedInput to stdout so Claude Code receives the answers directly.
  // Format: echo back original questions + separate `answers` object.
  if (Object.keys(answers).length > 0) {
    const output: QuestionHookOutput = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: {
          questions,
          answers,
        },
      },
    };
    process.stdout.write(JSON.stringify(output) + '\n');
  }
}

// ── Polling ─────────────────────────────────────────────────────

function pollForResponse(promptId: string): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const responseFile = path.join(PROMPTS_DIR, `response-${promptId}.json`);
    const startTime = Date.now();

    const interval = setInterval(() => {
      // Check timeout
      if (Date.now() - startTime > POLL_TIMEOUT_MS) {
        clearInterval(interval);
        process.stderr.write(`[question-notify] Timed out waiting for response\n`);
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

function detectSessionName(cwd: string): string | null {
  // 1. Try tmux (existing behaviour)
  if (process.env.TMUX) {
    try {
      const { execSync } = require('child_process');
      return execSync('tmux display-message -p "#S"', { encoding: 'utf8' }).trim();
    } catch {}
  }
  // 2. Ghostty — derive from CWD (explicit for clarity, same result as fallback)
  if (process.env.TERM_PROGRAM === 'ghostty') {
    const raw = extractWorkspaceName(cwd);
    return raw ? raw.replace(/[.:\s]/g, '-') : null;
  }
  // 3. Derive from CWD — apply the same sanitization /new uses for session names
  // (dots, colons, spaces → hyphens) so the name matches the PTY handle key
  const raw = extractWorkspaceName(cwd);
  if (!raw) return null;
  return raw.replace(/[.:\s]/g, '-');
}

function escapeMarkdown(text: string): string {
  return text.replace(/([_*`\[])/g, '\\$1');
}

// ── Run ─────────────────────────────────────────────────────────

main().catch((err: Error) => {
  process.stderr.write(`[question-notify] Fatal: ${err.message}\n`);
});
