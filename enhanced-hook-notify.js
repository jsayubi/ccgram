#!/usr/bin/env node

/**
 * Enhanced Hook Notifier — called by Claude Code hooks (Stop / Notification).
 *
 * Reads the hook JSON payload from stdin, extracts the workspace name,
 * updates the session map, and sends a Telegram notification.
 *
 * Usage (in ~/.claude/settings.json hooks):
 *   node /Users/aliayubi/tools/claude-remote/enhanced-hook-notify.js completed
 *   node /Users/aliayubi/tools/claude-remote/enhanced-hook-notify.js waiting
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });

const https = require('https');
const { upsertSession, extractWorkspaceName, trackNotificationMessage } = require('./workspace-router');
const { hasPendingForWorkspace } = require('./prompt-bridge');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_ENABLED = process.env.TELEGRAM_ENABLED === 'true';

const STATUS_ARG = process.argv[2] || 'completed'; // "completed" | "waiting"

// ── Main ────────────────────────────────────────────────────────

async function main() {
  let payload;
  try {
    const raw = await readStdin();
    payload = JSON.parse(raw);
  } catch (err) {
    // If no stdin or invalid JSON, build a minimal payload from env
    payload = {};
  }

  const cwd = payload.cwd || process.env.CLAUDE_CWD || process.cwd();
  const workspace = extractWorkspaceName(cwd);
  const tmuxSession = detectTmuxSession();
  const sessionId = payload.session_id || null;

  // Update session map
  try {
    upsertSession({
      cwd,
      tmuxSession: tmuxSession || `claude-${workspace}`,
      status: STATUS_ARG,
      sessionId,
    });
  } catch (err) {
    console.error(`[hook-notify] Failed to update session map: ${err.message}`);
  }

  // Send Telegram notification
  if (TELEGRAM_ENABLED && BOT_TOKEN && CHAT_ID) {
    // Dedup: if a richer prompt (permission/question) is already pending for this
    // workspace, skip the basic "Waiting for input" notification
    if (STATUS_ARG === 'waiting' && hasPendingForWorkspace(workspace)) {
      return;
    }

    const icon = STATUS_ARG === 'completed' ? '\u2705' : '\u23f3';
    const label = STATUS_ARG === 'completed' ? 'Task completed' : 'Waiting for input';
    let message = `${icon} ${label} in *${escapeMarkdown(workspace)}*`;

    // Extract Claude's last response from the transcript file
    if (payload.transcript_path) {
      try {
        const responseText = extractLastResponse(payload.transcript_path);
        if (responseText) {
          const truncated = responseText.length > 3000
            ? responseText.slice(0, 2997) + '...'
            : responseText;
          message += `\n\n${escapeMarkdown(truncated)}`;
        }
      } catch (err) {
        console.error(`[hook-notify] transcript read error: ${err.message}`);
      }
    }

    try {
      const result = await sendTelegram(message);
      if (result && result.message_id) {
        trackNotificationMessage(result.message_id, workspace, `hook-${STATUS_ARG}`);
      }
    } catch (err) {
      // Markdown parse failed — retry without parse_mode
      try {
        const plainMsg = message.replace(/[*_`\[\]]/g, '');
        const result = await sendTelegram(plainMsg, false);
        if (result && result.message_id) {
          trackNotificationMessage(result.message_id, workspace, `hook-${STATUS_ARG}`);
        }
      } catch (err2) {
        console.error(`[hook-notify] Telegram send failed: ${err2.message}`);
      }
    }
  }
}

// ── Telegram ────────────────────────────────────────────────────

function sendTelegram(text, useMarkdown = true) {
  return new Promise((resolve, reject) => {
    const payload = { chat_id: CHAT_ID, text };
    if (useMarkdown) payload.parse_mode = 'Markdown';
    const body = JSON.stringify(payload);

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

function extractLastResponse(transcriptPath) {
  const data = fs.readFileSync(transcriptPath, 'utf8').trimEnd();
  const lines = data.split('\n');

  // Walk backwards to find the last assistant message with text content
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.type === 'assistant' && entry.message?.content) {
        const texts = entry.message.content
          .filter(c => c.type === 'text')
          .map(c => c.text);
        if (texts.length > 0) {
          return texts.join('\n\n');
        }
      }
    } catch {}
  }
  return null;
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    let resolved = false;
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
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

function detectTmuxSession() {
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

function escapeMarkdown(text) {
  // Telegram Markdown v1 only needs these escaped
  return text.replace(/([_*`\[])/g, '\\$1');
}

// ── Run ─────────────────────────────────────────────────────────

main().catch((err) => {
  console.error(`[hook-notify] Fatal: ${err.message}`);
  process.exit(1);
});
