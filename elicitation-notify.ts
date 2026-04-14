#!/usr/bin/env node

/**
 * Elicitation Notify — Called by Claude Code's Elicitation hook.
 *
 * BLOCKING mode: Forwards MCP server input requests to Telegram, polls for
 * user response, then outputs the answer via stdout.
 *
 * Stdin JSON: { mcp_server, prompt, cwd, session_id, ... }
 * Stdout: { hookSpecificOutput: { response: "user input" } }
 */

import path from 'path';
import { PROJECT_ROOT } from './src/utils/paths';
require('dotenv').config({ path: path.join(PROJECT_ROOT, '.env'), quiet: true });

import fs from 'fs';
import https from 'https';
import { extractWorkspaceName, trackNotificationMessage } from './workspace-router';
import { generatePromptId, writePending, cleanPrompt, PROMPTS_DIR } from './prompt-bridge';
import { isUserActiveAtTerminal } from './src/utils/active-check';
import type { TelegramMessage } from './src/types';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Polling configuration
const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 120000; // 2 minutes for user input

/** Output format for elicitation response */
interface ElicitationOutput {
  hookSpecificOutput: {
    response: string;
  };
}

// ── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const raw = await readStdin();

  // Skip Telegram notification if user is at terminal AND this wasn't Telegram-injected
  const typingActivePath = path.join(PROJECT_ROOT, 'src/data', 'typing-active');
  const isTelegramInjected = fs.existsSync(typingActivePath);
  if (!isTelegramInjected && isUserActiveAtTerminal()) {
    return;
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }

  const mcpServer = (payload.mcp_server as string) || 'Unknown MCP';
  const prompt = (payload.prompt as string) || 'Input required';
  const cwd = (payload.cwd as string) || process.cwd();
  const workspace = extractWorkspaceName(cwd)!;

  const promptId = generatePromptId();

  let messageText = `\u{1F50C} *MCP Input Required* — ${escapeMarkdown(workspace)}\n\n`;
  messageText += `*Server:* \`${escapeMarkdown(mcpServer)}\`\n\n`;
  messageText += `${escapeMarkdown(prompt)}\n\n`;
  messageText += `_Reply to this message with your answer_`;

  // Write pending file
  writePending(promptId, {
    type: 'elicitation',
    workspace,
    mcpServer,
    prompt,
  });

  // Send Telegram message
  try {
    const result = await sendTelegram(messageText);
    if (result && result.message_id) {
      trackNotificationMessage(result.message_id, workspace, 'elicitation');
    }
  } catch (err: unknown) {
    process.stderr.write(`[elicitation-notify] Telegram send failed: ${(err as Error).message}\n`);
    cleanPrompt(promptId);
    return;
  }

  // Poll for response
  const response = await pollForResponse(promptId);
  cleanPrompt(promptId);

  if (response && response.textAnswer) {
    const output: ElicitationOutput = {
      hookSpecificOutput: {
        response: response.textAnswer as string,
      },
    };
    process.stdout.write(JSON.stringify(output) + '\n');
  }
  // If no response, exit silently — MCP will handle timeout
}

// ── Polling ─────────────────────────────────────────────────────

function pollForResponse(promptId: string): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const responseFile = path.join(PROMPTS_DIR, `response-${promptId}.json`);
    const startTime = Date.now();

    const interval = setInterval(() => {
      if (Date.now() - startTime > POLL_TIMEOUT_MS) {
        clearInterval(interval);
        process.stderr.write(`[elicitation-notify] Timed out waiting for response\n`);
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

function escapeMarkdown(text: string): string {
  return text.replace(/([_*`\[])/g, '\\$1');
}

// ── Run ─────────────────────────────────────────────────────────

main().catch((err: Error) => {
  process.stderr.write(`[elicitation-notify] Fatal: ${err.message}\n`);
});
