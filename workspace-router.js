#!/usr/bin/env node

/**
 * Workspace Router - Maps workspace names to Claude Code sessions.
 *
 * Reads the session map and resolves human-friendly project names
 * (e.g. "wp-super-ai") to active tmux sessions so commands can be
 * routed without memorising tokens.
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });

const SESSION_MAP_PATH = process.env.SESSION_MAP_PATH
  || path.join(__dirname, 'src/data/session-map.json');
const SESSION_TIMEOUT_HOURS = parseInt(process.env.SESSION_TIMEOUT, 10) || 24;

/**
 * Extract a short project name from a cwd path.
 * "/Users/aliayubi/projects/wp-super-ai" -> "wp-super-ai"
 */
function extractWorkspaceName(cwd) {
  if (!cwd) return null;
  return path.basename(cwd);
}

/** Read the session map from disk. */
function readSessionMap() {
  try {
    const raw = fs.readFileSync(SESSION_MAP_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return {};
    }
    console.error(`[workspace-router] Failed to read session map: ${err.message}`);
    return {};
  }
}

/** Write the session map to disk. */
function writeSessionMap(map) {
  const dir = path.dirname(SESSION_MAP_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(SESSION_MAP_PATH, JSON.stringify(map, null, 2), 'utf8');
}

/** Check whether a session has expired. */
function isExpired(session) {
  const now = Math.floor(Date.now() / 1000);
  return session.expiresAt && session.expiresAt < now;
}

/**
 * Find the most recent non-expired session whose workspace name matches.
 * Returns { token, session } or null.
 */
function findSessionByWorkspace(workspaceName) {
  const map = readSessionMap();
  let best = null;

  for (const [token, session] of Object.entries(map)) {
    if (isExpired(session)) continue;

    const name = extractWorkspaceName(session.cwd);
    if (name && name.toLowerCase() === workspaceName.toLowerCase()) {
      if (!best || session.createdAt > best.session.createdAt) {
        best = { token, session };
      }
    }
  }

  return best;
}

/**
 * List all active (non-expired) sessions grouped by workspace.
 * Returns an array of { workspace, token, session, age }.
 */
function listActiveSessions() {
  const map = readSessionMap();
  const now = Math.floor(Date.now() / 1000);
  const results = [];

  // Keep only the most recent session per workspace
  const byWorkspace = new Map();

  for (const [token, session] of Object.entries(map)) {
    if (isExpired(session)) continue;
    const workspace = extractWorkspaceName(session.cwd) || 'unknown';

    const existing = byWorkspace.get(workspace);
    if (!existing || session.createdAt > existing.session.createdAt) {
      byWorkspace.set(workspace, { token, session });
    }
  }

  for (const [workspace, { token, session }] of byWorkspace) {
    const ageSec = now - session.createdAt;
    results.push({
      workspace,
      token,
      session,
      age: formatAge(ageSec),
    });
  }

  // Sort newest first
  results.sort((a, b) => b.session.createdAt - a.session.createdAt);
  return results;
}

/**
 * Register or update a session in the map.
 * Called by the hook notifier when Claude starts/stops.
 */
function upsertSession({ cwd, tmuxSession, status, sessionId }) {
  const map = readSessionMap();
  const workspace = extractWorkspaceName(cwd);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + SESSION_TIMEOUT_HOURS * 3600;

  // Try to find an existing session for this workspace + tmux combo
  let existingToken = null;
  for (const [token, sess] of Object.entries(map)) {
    if (sess.cwd === cwd && sess.tmuxSession === tmuxSession && !isExpired(sess)) {
      existingToken = token;
      break;
    }
  }

  const token = existingToken || generateToken();

  map[token] = {
    type: 'pty',
    createdAt: existingToken ? map[existingToken].createdAt : now,
    expiresAt,
    cwd,
    sessionId: sessionId || map[existingToken]?.sessionId || null,
    tmuxSession: tmuxSession || `claude-${workspace}`,
    description: `${status} - ${workspace}`,
  };

  writeSessionMap(map);
  return { token, workspace };
}

/** Remove expired sessions from the map. */
function pruneExpired() {
  const map = readSessionMap();
  let pruned = 0;
  for (const [token, session] of Object.entries(map)) {
    if (isExpired(session)) {
      delete map[token];
      pruned++;
    }
  }
  if (pruned > 0) {
    writeSessionMap(map);
  }
  return pruned;
}

// ── Helpers ──────────────────────────────────────────────────────

function generateToken() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let token = '';
  for (let i = 0; i < 8; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
}

function formatAge(seconds) {
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

module.exports = {
  extractWorkspaceName,
  readSessionMap,
  writeSessionMap,
  findSessionByWorkspace,
  listActiveSessions,
  upsertSession,
  pruneExpired,
  isExpired,
  SESSION_MAP_PATH,
};
