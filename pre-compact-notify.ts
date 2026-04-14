#!/usr/bin/env node

/**
 * Pre-Compact Notify — Called by Claude Code's PreCompact hook.
 *
 * BLOCKING mode: Notifies user before context compaction, allows them to
 * block it if they want to preserve context.
 *
 * Stdin JSON: { cwd, session_id, tokens_current, ... }
 * Stdout: { hookSpecificOutput: { decision: "block" } } — to prevent compaction
 *         (or exit silently to allow compaction)
 */

import path from 'path';
import { PROJECT_ROOT } from './src/utils/paths';
require('dotenv').config({ path: path.join(PROJECT_ROOT, '.env'), quiet: true });

import fs from 'fs';
import https from 'https';
import { extractWorkspaceName, trackNotificationMessage } from './workspace-router';
import { generatePromptId, writePending, cleanPrompt, PROMPTS_DIR } from './prompt-bridge';
import { isUserActiveAtTerminal } from './src/utils/active-check';
import type { InlineKeyboardMarkup, InlineKeyboardButton, TelegramMessage } from './src/types';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Polling configuration
const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 30000; // 30 seconds to decide

/** Output format for blocking compaction */
interface PreCompactOutput {
  hookSpecificOutput: {
    decision: 'block';
  };
}

// ── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const raw = await readStdin();

  // Skip Telegram notification if user is at terminal AND this wasn't Telegram-injected
  const typingActivePath = path.join(PROJECT_ROOT, 'src/data', 'typing-active');
  const isTelegramInjected = fs.existsSync(typingActivePath);
  if (!isTelegramInjected && isUserActiveAtTerminal()) {
    // User is at terminal — let compaction proceed automatically
    return;
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }

  const cwd = (payload.cwd as string) || process.cwd();
  const workspace = extractWorkspaceName(cwd)!;
  const tokensCurrent = payload.tokens_current as number | undefined;

  const promptId = generatePromptId();

  let messageText = `\u{1F4E6} *Context Compaction* — ${escapeMarkdown(workspace)}\n\n`;
  messageText += `Context is getting large and will be compacted.`;
  if (tokensCurrent) {
    messageText += `\n\n_Current tokens: ${tokensCurrent.toLocaleString()}_`;
  }

  // Build inline keyboard with Proceed/Block buttons
  const keyboard: InlineKeyboardButton[][] = [
    [
      { text: '\u2705 Proceed', callback_data: `pre-compact:${promptId}:proceed` },
      { text: '\u{1F6D1} Block', callback_data: `pre-compact:${promptId}:block` },
    ],
  ];

  // Write pending file
  writePending(promptId, {
    type: 'pre-compact',
    workspace,
    tokensCurrent,
  });

  // Send Telegram message
  try {
    const result = await sendTelegramWithKeyboard(messageText, { inline_keyboard: keyboard });
    if (result && result.message_id) {
      trackNotificationMessage(result.message_id, workspace, 'pre-compact');
    }
  } catch (err: unknown) {
    process.stderr.write(`[pre-compact-notify] Telegram send failed: ${(err as Error).message}\n`);
    cleanPrompt(promptId);
    return; // Let compaction proceed on send failure
  }

  // Poll for response
  const response = await pollForResponse(promptId);
  cleanPrompt(promptId);

  if (response && response.action === 'block') {
    const output: PreCompactOutput = {
      hookSpecificOutput: {
        decision: 'block',
      },
    };
    process.stdout.write(JSON.stringify(output) + '\n');
  }
  // If proceed or timeout, exit silently — compaction proceeds
}

// ── Polling ─────────────────────────────────────────────────────

function pollForResponse(promptId: string): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const responseFile = path.join(PROMPTS_DIR, `response-${promptId}.json`);
    const startTime = Date.now();

    const interval = setInterval(() => {
      if (Date.now() - startTime > POLL_TIMEOUT_MS) {
        clearInterval(interval);
        process.stderr.write(`[pre-compact-notify] Timed out — allowing compaction\n`);
        resolve(null);
        return;
      }

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

function escapeMarkdown(text: string): string {
  return text.replace(/([_*`\[])/g, '\\$1');
}

// ── Run ─────────────────────────────────────────────────────────

main().catch((err: Error) => {
  process.stderr.write(`[pre-compact-notify] Fatal: ${err.message}\n`);
});
