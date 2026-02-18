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

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROMPTS_DIR = process.env.PROMPTS_DIR || '/tmp/claude-prompts';
const EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

/** Ensure the prompts directory exists. */
function ensureDir() {
  if (!fs.existsSync(PROMPTS_DIR)) {
    fs.mkdirSync(PROMPTS_DIR, { recursive: true });
  }
}

/** Generate a unique 8-char prompt ID. */
function generatePromptId() {
  return crypto.randomBytes(4).toString('hex');
}

/**
 * Write a pending prompt file.
 * @param {string} id — prompt ID
 * @param {object} data — { type, workspace, tmuxSession, question, options, ... }
 */
function writePending(id, data) {
  ensureDir();
  cleanExpired();
  const filePath = path.join(PROMPTS_DIR, `pending-${id}.json`);
  fs.writeFileSync(filePath, JSON.stringify({ ...data, createdAt: Date.now() }, null, 2));
}

/**
 * Write a response file (from bot callback).
 * @param {string} id — prompt ID
 * @param {object} data — { action, alwaysAllow?, selectedOption? }
 */
function writeResponse(id, data) {
  ensureDir();
  const filePath = path.join(PROMPTS_DIR, `response-${id}.json`);
  fs.writeFileSync(filePath, JSON.stringify({ ...data, respondedAt: Date.now() }, null, 2));
}

/**
 * Read a response file if it exists.
 * @param {string} id — prompt ID
 * @returns {object|null}
 */
function readResponse(id) {
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
 * @param {string} id — prompt ID
 * @returns {object|null}
 */
function readPending(id) {
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
 * @param {string} workspace
 * @returns {boolean}
 */
function hasPendingForWorkspace(workspace) {
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
function cleanExpired() {
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
 * @param {string} id
 */
function cleanPrompt(id) {
  const pending = path.join(PROMPTS_DIR, `pending-${id}.json`);
  const response = path.join(PROMPTS_DIR, `response-${id}.json`);
  try { fs.unlinkSync(pending); } catch {}
  try { fs.unlinkSync(response); } catch {}
}

/**
 * Update fields on an existing pending prompt file.
 * @param {string} id — prompt ID
 * @param {object} updates — fields to merge
 */
function updatePending(id, updates) {
  const existing = readPending(id);
  if (!existing) return;
  const filePath = path.join(PROMPTS_DIR, `pending-${id}.json`);
  fs.writeFileSync(filePath, JSON.stringify({ ...existing, ...updates }, null, 2));
}

module.exports = {
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
