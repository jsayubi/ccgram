#!/usr/bin/env node

/**
 * Prompt Bridge — File-based IPC for Claude Code interactive prompts.
 *
 * Manages /tmp/claude-prompts/ directory with pending/response files
 * so that hooks (permission-hook.js, question-notify.js) can communicate
 * with the Telegram bot's callback query handler.
 *
 * File format:
 *   pending-<id>.json   — written by hook, read by bot callback handler
 *   response-<id>.json  — written by bot callback handler, read by hook
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const PROMPTS_DIR = process.env.PROMPTS_DIR || '/tmp/claude-prompts';
const EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

/** Ensure the prompts directory exists. */
function ensureDir(): void {
  if (!fs.existsSync(PROMPTS_DIR)) {
    fs.mkdirSync(PROMPTS_DIR, { recursive: true });
  }
}

/** Generate a unique 8-char prompt ID. */
function generatePromptId(): string {
  return crypto.randomBytes(4).toString('hex');
}

/**
 * Write a pending prompt file.
 */
function writePending(id: string, data: Record<string, unknown>): void {
  ensureDir();
  cleanExpired();
  const filePath = path.join(PROMPTS_DIR, `pending-${id}.json`);
  fs.writeFileSync(filePath, JSON.stringify({ ...data, createdAt: Date.now() }, null, 2));
}

/**
 * Write a response file (from bot callback).
 */
function writeResponse(id: string, data: Record<string, unknown>): void {
  ensureDir();
  const filePath = path.join(PROMPTS_DIR, `response-${id}.json`);
  fs.writeFileSync(filePath, JSON.stringify({ ...data, respondedAt: Date.now() }, null, 2));
}

/**
 * Read a response file if it exists.
 */
function readResponse(id: string): Record<string, unknown> | null {
  const filePath = path.join(PROMPTS_DIR, `response-${id}.json`);
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Read a pending prompt file.
 */
function readPending(id: string): Record<string, unknown> | null {
  const filePath = path.join(PROMPTS_DIR, `pending-${id}.json`);
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Check if there's a pending prompt for a given workspace.
 * Used by enhanced-hook-notify.js for deduplication.
 */
function hasPendingForWorkspace(workspace: string): boolean {
  ensureDir();
  try {
    const files = fs.readdirSync(PROMPTS_DIR);
    for (const file of files) {
      if (!file.startsWith('pending-')) continue;
      try {
        const raw = fs.readFileSync(path.join(PROMPTS_DIR, file), 'utf8');
        const data = JSON.parse(raw);
        // Only count non-expired pending files
        if (data.workspace === workspace && (Date.now() - data.createdAt) < EXPIRY_MS) {
          // Check that no response exists for this prompt
          const id = file.replace('pending-', '').replace('.json', '');
          if (!readResponse(id)) {
            return true;
          }
        }
      } catch {
        // Skip malformed files
      }
    }
  } catch {
    // Directory read failed
  }
  return false;
}

/**
 * Remove pending and response files older than EXPIRY_MS.
 */
function cleanExpired(): void {
  try {
    if (!fs.existsSync(PROMPTS_DIR)) return;
    const files = fs.readdirSync(PROMPTS_DIR);
    const now = Date.now();

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const filePath = path.join(PROMPTS_DIR, file);
      try {
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > EXPIRY_MS) {
          fs.unlinkSync(filePath);
        }
      } catch {
        // Skip if file was already removed
      }
    }
  } catch {
    // Directory doesn't exist or isn't readable
  }
}

/**
 * Remove pending and response files for a given prompt ID.
 */
function cleanPrompt(id: string): void {
  const pending = path.join(PROMPTS_DIR, `pending-${id}.json`);
  const response = path.join(PROMPTS_DIR, `response-${id}.json`);
  try { fs.unlinkSync(pending); } catch {}
  try { fs.unlinkSync(response); } catch {}
}

/**
 * Update fields on an existing pending prompt file.
 */
function updatePending(id: string, updates: Record<string, unknown>): void {
  const existing = readPending(id);
  if (!existing) return;
  const filePath = path.join(PROMPTS_DIR, `pending-${id}.json`);
  fs.writeFileSync(filePath, JSON.stringify({ ...existing, ...updates }, null, 2));
}

export {
  generatePromptId,
  writePending,
  updatePending,
  writeResponse,
  readResponse,
  readPending,
  hasPendingForWorkspace,
  cleanExpired,
  cleanPrompt,
  PROMPTS_DIR,
};
