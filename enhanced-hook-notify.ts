#!/usr/bin/env node

/**
 * Enhanced Hook Notifier — called by Claude Code hooks.
 *
 * Handles: Stop (completed), Notification (waiting), SessionStart,
 *          SessionEnd, SubagentStop (subagent-done).
 *
 * Usage (in ~/.claude/settings.json hooks):
 *   node /path/to/ccgram/dist/enhanced-hook-notify.js completed
 *   node /path/to/ccgram/dist/enhanced-hook-notify.js waiting
 *   node /path/to/ccgram/dist/enhanced-hook-notify.js session-start
 *   node /path/to/ccgram/dist/enhanced-hook-notify.js session-end
 *   node /path/to/ccgram/dist/enhanced-hook-notify.js subagent-done
 */

import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT } from './src/utils/paths';
require('dotenv').config({ path: path.join(PROJECT_ROOT, '.env'), quiet: true });

import https from 'https';
import Logger from './src/core/logger';
import { upsertSession, extractWorkspaceName, trackNotificationMessage } from './workspace-router';
import { hasPendingForWorkspace } from './prompt-bridge';
import { isUserActiveAtTerminal } from './src/utils/active-check';
import type { TelegramMessage } from './src/types';

const logger = new Logger('hook:enhanced');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_ENABLED = process.env.TELEGRAM_ENABLED === 'true';

const STATUS_ARG = process.argv[2] || 'completed';

// ── Status configuration ─────────────────────────────────────────

interface StatusConfig {
  icon: string;
  label: string;
  /** When true, notification fires even if user is active at terminal */
  alwaysNotify: boolean;
  /** When true, register/update the session map entry */
  upsertSession: boolean;
}

const STATUS_CONFIG: Record<string, StatusConfig> = {
  'completed':     { icon: '\u2705', label: 'Task completed',    alwaysNotify: false, upsertSession: true  },
  'waiting':       { icon: '\u23f3', label: 'Waiting for input', alwaysNotify: false, upsertSession: true  },
  'session-start': { icon: '\u{1F7E2}', label: 'Session started',   alwaysNotify: false, upsertSession: true  },
  'session-end':   { icon: '\u{1F534}', label: 'Session ended',     alwaysNotify: false, upsertSession: false },
  'subagent-done': { icon: '\u{1F916}', label: 'Subagent finished', alwaysNotify: false, upsertSession: true  },
};

// ── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let payload: Record<string, unknown>;
  try {
    const raw = await readStdin();
    payload = JSON.parse(raw);
  } catch {
    payload = {};
  }

  const cwd = (payload.cwd as string) || process.env.CLAUDE_CWD || process.cwd();
  const workspace = extractWorkspaceName(cwd)!;
  const tmuxSession = detectSessionName(cwd);
  const sessionId = (payload.session_id as string) || null;

  const config = STATUS_CONFIG[STATUS_ARG] ?? STATUS_CONFIG['waiting'];

  // Update session map (skip for session-end — session is over)
  if (config.upsertSession) {
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
  }

  // If the bot injected this command from Telegram, typing-active exists — always notify
  // so the response goes back to Telegram regardless of terminal activity.
  const typingActivePath = path.join(PROJECT_ROOT, 'src/data', 'typing-active');
  const isTelegramInjected = fs.existsSync(typingActivePath);

  // Suppress notification if user is actively at terminal AND this wasn't Telegram-injected
  if (!config.alwaysNotify && !isTelegramInjected && isUserActiveAtTerminal()) {
    try { fs.unlinkSync(typingActivePath); } catch {}
    return;
  }

  // Send Telegram notification
  if (TELEGRAM_ENABLED && BOT_TOKEN && CHAT_ID) {
    // Dedup: if a richer prompt (permission/question) is already pending for this
    // workspace, skip the basic "Waiting for input" notification
    if (STATUS_ARG === 'waiting' && hasPendingForWorkspace(workspace)) {
      try { fs.unlinkSync(typingActivePath); } catch {}
      return;
    }

    let message = `${config.icon} ${config.label} in <b>${escapeHtml(workspace)}</b>`;

    // Append Claude's last response text (skip for session-start — nothing said yet)
    if (STATUS_ARG !== 'session-start') {
      const responseText = getResponseText(payload);
      if (responseText) {
        const truncated = responseText.length > 3500
          ? responseText.slice(0, 3497) + '...'
          : responseText;
        message += `\n\n${markdownToHtml(truncated)}`;
      }
    }

    // Remove typing signal file BEFORE sending
    try { fs.unlinkSync(typingActivePath); } catch {}

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

// ── Response text extraction ─────────────────────────────────────

/**
 * Get Claude's last response text from the hook payload.
 * Prefers last_assistant_message (v2.1.47+), falls back to transcript parsing.
 * For SubagentStop, also tries agent_transcript_path.
 */
function getResponseText(payload: Record<string, unknown>): string | null {
  // Direct field — available in Claude Code v2.1.47+
  const direct = payload.last_assistant_message as string | undefined;
  if (direct) return direct;

  // Transcript fallback for older Claude Code versions
  const agentTranscript = payload.agent_transcript_path as string | undefined;
  if (agentTranscript) {
    try { return extractLastResponse(agentTranscript); } catch {}
  }
  const transcript = payload.transcript_path as string | undefined;
  if (transcript) {
    try { return extractLastResponse(transcript); } catch {}
  }
  return null;
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
  // 1. Try tmux (preferred — gives actual session name)
  if (process.env.TMUX) {
    try {
      const { execSync } = require('child_process');
      return execSync('tmux display-message -p "#S"', { encoding: 'utf8' }).trim();
    } catch {}
  }
  // 2. Derive from CWD — sanitize so it matches PTY handle key format
  const raw = extractWorkspaceName(cwd);
  if (!raw) return null;
  return raw.replace(/[.:\s]/g, '-');
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
