#!/usr/bin/env node

/**
 * UserPromptSubmit hook — called by Claude Code whenever the user submits a prompt.
 *
 * Writes the current Unix timestamp to /tmp/claude_last_msg_time so that
 * active-check.ts can detect when the user is actively working at the terminal
 * and suppress redundant Telegram notifications.
 *
 * Must be fast — registered with timeout: 2 in settings.json.
 * No stdout output. No Telegram calls.
 */

import path from 'path';
import { PROJECT_ROOT } from './src/utils/paths';
require('dotenv').config({ path: path.join(PROJECT_ROOT, '.env'), quiet: true });

import fs from 'fs';

const LAST_MSG_FILE = '/tmp/claude_last_msg_time';

// Write current Unix timestamp immediately
try {
  fs.writeFileSync(LAST_MSG_FILE, String(Math.floor(Date.now() / 1000)));
} catch {
  // Non-fatal — active-check will just assume user is inactive
}

// Drain stdin using the standard hook pattern (data not needed)
let resolved = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  if (!resolved) { resolved = true; process.stdin.destroy(); }
});
setTimeout(() => {
  if (!resolved) { resolved = true; process.stdin.destroy(); }
}, 500);
