#!/usr/bin/env node

/**
 * Enhanced Hook Notifier — called by Claude Code hooks (Stop / Notification).
 *
 * Reads the hook JSON payload from stdin, extracts the workspace name,
 * updates the session map, and sends a Telegram notification.
 *
 * Usage (in ~/.claude/settings.json hooks):
 *   node /path/to/ccgram/enhanced-hook-notify.js completed
 *   node /path/to/ccgram/enhanced-hook-notify.js waiting
 */

import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT } from './src/utils/paths';
require('dotenv').config({ path: path.join(PROJECT_ROOT, '.env'), quiet: true });

import https from 'https';
import Logger from './src/core/logger';
import { upsertSession, extractWorkspaceName, trackNotificationMessage } from './workspace-router';
import { hasPendingForWorkspace } from './prompt-bridge';
import type { TelegramMessage } from './src/types';

const logger = new Logger('hook:enhanced');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_ENABLED = process.env.TELEGRAM_ENABLED === 'true';

const STATUS_ARG = process.argv[2] || 'completed'; // "completed" | "waiting"

// ── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let payload: Record<string, unknown>;
  try {
    const raw = await readStdin();
    payload = JSON.parse(raw);
  } catch {
    // If no stdin or invalid JSON, build a minimal payload from env
    payload = {};
  }

  const cwd = (payload.cwd as string) || process.env.CLAUDE_CWD || process.cwd();
  const workspace = extractWorkspaceName(cwd)!;
  const tmuxSession = detectTmuxSession();
  const sessionId = (payload.session_id as string) || null;

  // Update session map
  try {
    upsertSession({
      cwd,
      tmuxSession: tmuxSession || `claude-${workspace}`,
      status: STATUS_ARG,
      sessionId,
    });
  } catch (err: unknown) {
    logger.error(`Failed to update session map: ${(err as Error).message}`);
  }

  // Send Telegram notification
  if (TELEGRAM_ENABLED && BOT_TOKEN && CHAT_ID) {
    // Dedup: if a richer prompt (permission/question) is already pending for this
    // workspace, skip the basic "Waiting for input" notification
    if (STATUS_ARG === 'waiting' && hasPendingForWorkspace(workspace)) {
      try { fs.unlinkSync(path.join(PROJECT_ROOT, 'src/data', 'typing-active')); } catch {}
      return;
    }

    const icon = STATUS_ARG === 'completed' ? '\u2705' : '\u23f3';
    const label = STATUS_ARG === 'completed' ? 'Task completed' : 'Waiting for input';
    let message = `${icon} ${label} in <b>${escapeHtml(workspace)}</b>`;

    // Extract response text from transcript file
    // Brief delay to let Claude Code flush the current response to the transcript
    if (payload.transcript_path) {
      await new Promise<void>(r => setTimeout(r, 1500));
      try {
        const responseText = extractLastResponse(payload.transcript_path as string);
        if (responseText) {
          const truncated = responseText.length > 3500
            ? responseText.slice(0, 3497) + '...'
            : responseText;
          message += `\n\n${markdownToHtml(truncated)}`;
        }
      } catch {}
    }

    // Remove typing signal file BEFORE sending, so the bot's interval tick
    // doesn't re-assert typing during the async Telegram send
    try {
      fs.unlinkSync(path.join(PROJECT_ROOT, 'src/data', 'typing-active'));
    } catch {}

    try {
      const result = await sendTelegram(message, 'HTML');
      if (result && result.message_id) {
        trackNotificationMessage(result.message_id, workspace, `hook-${STATUS_ARG}`);
      }
    } catch {
      // HTML failed — send as plain text
      try {
        const plain = message.replace(/<[^>]+>/g, '');
        const result = await sendTelegram(plain, false);
        if (result && result.message_id) {
          trackNotificationMessage(result.message_id, workspace, `hook-${STATUS_ARG}`);
        }
      } catch (err2: unknown) {
        logger.error(`Telegram send failed: ${(err2 as Error).message}`);
      }
    }
  }
}

// ── Telegram ────────────────────────────────────────────────────

function sendTelegram(text: string, parseMode: string | false = 'Markdown'): Promise<TelegramMessage | null> {
  return new Promise((resolve, reject) => {
    const msgPayload: Record<string, unknown> = { chat_id: CHAT_ID, text };
    if (parseMode) msgPayload.parse_mode = parseMode;
    const body = JSON.stringify(msgPayload);

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

function extractLastResponse(transcriptPath: string): string | null {
  const data = fs.readFileSync(transcriptPath, 'utf8').trimEnd();
  const lines = data.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.type === 'assistant' && entry.message?.content) {
        const texts = entry.message.content
          .filter((c: Record<string, unknown>) => c.type === 'text')
          .map((c: Record<string, unknown>) => c.text);
        if (texts.length > 0) return texts.join('\n\n');
      }
    } catch {}
  }
  return null;
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    let resolved = false;
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => { data += chunk; });
    process.stdin.on('end', () => {
      if (!resolved) { resolved = true; resolve(data); }
    });

    // If no data arrives within 500ms, resolve and destroy stdin
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
  // If running inside tmux, grab the session name
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

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function markdownToHtml(text: string): string {
  let html = escapeHtml(text);
  // Code blocks: ```...``` → <pre>...</pre>
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_: string, __: string, code: string) => `<pre>${code.trim()}</pre>`);
  // Inline code: `...` → <code>...</code>
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Bold: **...** → <b>...</b>
  html = html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  // Italic: *...* → <i>...</i>
  html = html.replace(/\*(.+?)\*/g, '<i>$1</i>');
  // Bullets: - item → • item
  html = html.replace(/^[-*]\s+/gm, '\u2022 ');
  // Strip headers: ## text → text
  html = html.replace(/^#{1,6}\s+/gm, '');
  return html;
}

// ── Run ─────────────────────────────────────────────────────────

main().catch((err: Error) => {
  logger.error(`Fatal: ${err.message}`);
  process.exit(1);
});
