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

    // Capture tmux pane output to include Claude's response
    const tmuxName = tmuxSession || `claude-${workspace}`;
    try {
      const paneOutput = await captureTmuxPane(tmuxName);
      if (paneOutput) {
        const cleaned = cleanTmuxOutput(paneOutput);
        if (cleaned) {
          // Telegram message limit is 4096 chars; keep output under 3000
          const truncated = cleaned.length > 3000
            ? '...' + cleaned.slice(-2997)
            : cleaned;
          message += `\n\n${truncated}`;
        }
      }
    } catch (err) {
      // tmux capture failed — send notification without output
    }

    try {
      const result = await sendTelegram(message);
      if (result && result.message_id) {
        trackNotificationMessage(result.message_id, workspace, `hook-${STATUS_ARG}`);
      }
    } catch (err) {
      console.error(`[hook-notify] Telegram send failed: ${err.message}`);
    }
  }
}

// ── Telegram ────────────────────────────────────────────────────

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

function captureTmuxPane(sessionName) {
  const { execSync } = require('child_process');
  return new Promise((resolve) => {
    try {
      const output = execSync(`tmux capture-pane -t ${sessionName} -p 2>/dev/null`, {
        encoding: 'utf8',
        timeout: 3000,
      });
      resolve(output);
    } catch {
      resolve(null);
    }
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

/**
 * Clean raw tmux pane output into readable Telegram text.
 * Strips ANSI codes, terminal UI chrome, and extracts Claude's last response.
 * Preserves paragraph breaks (blank lines) for readability.
 */
function cleanTmuxOutput(raw) {
  let lines = raw.split('\n');

  // Strip ANSI escape codes
  lines = lines.map(l => l
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1B\][^\x07]*\x07/g, '')
  );

  // Find the last user prompt to isolate Claude's final response.
  // Walk backwards to find the prompt line (❯ user input).
  let responseStart = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    // Match user input prompt: "❯ something" or "> something"
    if (/^❯\s+\S/.test(trimmed) || /^>\s+\S/.test(trimmed)) {
      responseStart = i + 1;
      break;
    }
  }

  let response = lines.slice(responseStart);

  // Strip from bottom: remove noise, but capture status bar and toolbar for footer
  let capturedStatusBar = null;
  let capturedToolbar = null;

  while (response.length) {
    const last = response[response.length - 1].trim();
    if (!last || /^❯\s*$/.test(last)) {
      // Empty lines and bare prompt — discard
      response.pop();
    } else if (/^.+\|.+\|.+\|/.test(last)) {
      // Status bar: "workspace | model | % left | time | cost" — capture
      capturedStatusBar = capturedStatusBar || last;
      response.pop();
    } else if (/^[▶►]{1,2}\s/.test(last) || /accept edits|shift\+tab to cycle/i.test(last)) {
      // Toolbar: "▶▶ accept edits on (shift+tab to cycle)" — capture
      capturedToolbar = capturedToolbar || last;
      response.pop();
    } else if (
      /^Frosting/i.test(last) ||
      /running\s+(stop\s+)?hooks/i.test(last) ||
      /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(last) ||
      /^[·•]\s*(Mulling|Thinking|Reasoning)/i.test(last) ||
      /^(Clauding|Working|Waiting|Processing)/i.test(last)
    ) {
      // Pure noise — discard
      response.pop();
    } else {
      break;
    }
  }

  // Clean each line but preserve blank lines for paragraph spacing
  response = response.map(l => {
    return l
      .replace(/^[│┃]\s?/, '')         // box-drawing left borders
      .replace(/[●◉⬤]\s?/g, '')        // dot indicators
      .replace(/^\s*[─━═]{3,}\s*$/, '') // horizontal rules
      .replace(/^\s*\d+\s*\/\s*\d+\s*$/, ''); // pagination "1/3"
  });

  // Remove lines that are pure noise, but keep blank lines intact
  response = response.filter(l => {
    const t = l.trim();
    // Keep blank lines for paragraph breaks
    if (!t) return true;
    // Skip spinners and status indicators
    if (/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(t)) return false;
    if (/^(Clauding|Working|Waiting|Processing)/i.test(t)) return false;
    if (/^Frosting/i.test(t)) return false;
    if (/running\s+(stop\s+)?hooks/i.test(t)) return false;
    // Thinking indicators: · Mulling..., · Thinking...
    if (/^[·•]\s*(Mulling|Thinking|Reasoning)/i.test(t)) return false;
    // Status bar and toolbar (already captured for footer)
    if (/^.+\|.+\|.+\|/.test(t)) return false;
    if (/^[▶►]{1,2}\s/.test(t)) return false;
    if (/accept edits|shift\+tab to cycle/i.test(t)) return false;
    return true;
  });

  // Collapse 3+ consecutive blank lines into 2 (one paragraph break)
  const collapsed = [];
  let blankCount = 0;
  for (const line of response) {
    if (!line.trim()) {
      blankCount++;
      if (blankCount <= 2) collapsed.push(line);
    } else {
      blankCount = 0;
      collapsed.push(line);
    }
  }

  // Trim leading/trailing blank lines
  while (collapsed.length && !collapsed[0].trim()) collapsed.shift();
  while (collapsed.length && !collapsed[collapsed.length - 1].trim()) collapsed.pop();

  if (collapsed.length === 0 && !capturedStatusBar && !capturedToolbar) return null;

  let result = collapsed.join('\n');

  // Append captured status bar and toolbar as a clean footer
  if (capturedStatusBar || capturedToolbar) {
    if (result) result += '\n\n';
    if (capturedStatusBar) result += `─ ${capturedStatusBar}`;
    if (capturedStatusBar && capturedToolbar) result += '\n';
    if (capturedToolbar) result += capturedToolbar;
  }

  return result || null;
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
