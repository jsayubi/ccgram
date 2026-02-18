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

const DATA_DIR = process.env.CCGRAM_DATA_DIR || path.join(__dirname, 'src/data');
const SESSION_MAP_PATH = process.env.SESSION_MAP_PATH
  || path.join(DATA_DIR, 'session-map.json');
const SESSION_TIMEOUT_HOURS = parseInt(process.env.SESSION_TIMEOUT, 10) || 24;

/**
 * Extract a short project name from a cwd path.
 * "/home/user/projects/my-project" -> "my-project"
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
  recordProjectUsage(workspace, cwd);
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

// ── Prefix / Fuzzy Workspace Resolution ─────────────────────────

const DEFAULT_WORKSPACE_PATH = process.env.DEFAULT_WORKSPACE_PATH || path.join(DATA_DIR, 'default-workspace.json');
const MESSAGE_WORKSPACE_MAP_PATH = process.env.MESSAGE_WORKSPACE_MAP_PATH || path.join(DATA_DIR, 'message-workspace-map.json');

/**
 * Resolve a workspace name by exact match, then prefix match.
 * Returns one of:
 *   { type: 'exact',     match: { token, session } }
 *   { type: 'prefix',    match: { token, session }, workspace: string }
 *   { type: 'ambiguous', matches: [{ workspace, token, session }] }
 *   { type: 'none' }
 */
function resolveWorkspace(name) {
  const map = readSessionMap();
  const lower = name.toLowerCase();

  // Build deduplicated workspace → { token, session } map (newest wins)
  const byWorkspace = new Map();
  for (const [token, session] of Object.entries(map)) {
    if (isExpired(session)) continue;
    const ws = extractWorkspaceName(session.cwd);
    if (!ws) continue;
    const existing = byWorkspace.get(ws.toLowerCase());
    if (!existing || session.createdAt > existing.session.createdAt) {
      byWorkspace.set(ws.toLowerCase(), { workspace: ws, token, session });
    }
  }

  // Exact match (case-insensitive)
  const exact = byWorkspace.get(lower);
  if (exact) {
    return { type: 'exact', match: { token: exact.token, session: exact.session }, workspace: exact.workspace };
  }

  // Prefix match
  const prefixMatches = [];
  for (const [wsLower, entry] of byWorkspace) {
    if (wsLower.startsWith(lower)) {
      prefixMatches.push(entry);
    }
  }

  if (prefixMatches.length === 1) {
    const m = prefixMatches[0];
    return { type: 'prefix', match: { token: m.token, session: m.session }, workspace: m.workspace };
  }

  if (prefixMatches.length > 1) {
    return {
      type: 'ambiguous',
      matches: prefixMatches.map(m => ({ workspace: m.workspace, token: m.token, session: m.session })),
    };
  }

  return { type: 'none' };
}

// ── Default Workspace ───────────────────────────────────────────

function getDefaultWorkspace() {
  try {
    const raw = fs.readFileSync(DEFAULT_WORKSPACE_PATH, 'utf8');
    const data = JSON.parse(raw);
    return data.workspace || null;
  } catch {
    return null;
  }
}

function setDefaultWorkspace(name) {
  const dir = path.dirname(DEFAULT_WORKSPACE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (name) {
    fs.writeFileSync(DEFAULT_WORKSPACE_PATH, JSON.stringify({ workspace: name }, null, 2), 'utf8');
  } else {
    // Clear default
    try { fs.unlinkSync(DEFAULT_WORKSPACE_PATH); } catch {}
  }
}

// ── Message-to-Workspace Tracking (for reply-to routing) ────────

const MESSAGE_MAP_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

function readMessageMap() {
  try {
    const raw = fs.readFileSync(MESSAGE_WORKSPACE_MAP_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeMessageMap(map) {
  const dir = path.dirname(MESSAGE_WORKSPACE_MAP_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(MESSAGE_WORKSPACE_MAP_PATH, JSON.stringify(map, null, 2), 'utf8');
}

/**
 * Track which Telegram message_id belongs to which workspace.
 * Prunes entries older than 24 hours on each write.
 */
function trackNotificationMessage(messageId, workspace, type) {
  if (!messageId || !workspace) return;
  const map = readMessageMap();
  const now = Date.now();

  // Prune old entries
  for (const [id, entry] of Object.entries(map)) {
    if (now - entry.timestamp > MESSAGE_MAP_MAX_AGE_MS) {
      delete map[id];
    }
  }

  map[String(messageId)] = { workspace, type, timestamp: now };
  writeMessageMap(map);
}

/**
 * Look up which workspace a Telegram message belongs to.
 * Returns the workspace name or null.
 */
function getWorkspaceForMessage(messageId) {
  if (!messageId) return null;
  const map = readMessageMap();
  const entry = map[String(messageId)];
  if (!entry) return null;
  if (Date.now() - entry.timestamp > MESSAGE_MAP_MAX_AGE_MS) return null;
  return entry.workspace;
}

// ── Project History (persists across session expiry/pruning) ─────

const PROJECT_HISTORY_PATH = process.env.PROJECT_HISTORY_PATH || path.join(DATA_DIR, 'project-history.json');

function readProjectHistory() {
  try {
    return JSON.parse(fs.readFileSync(PROJECT_HISTORY_PATH, 'utf8'));
  } catch { return {}; }
}

function recordProjectUsage(name, projectPath) {
  const history = readProjectHistory();
  history[name] = { path: projectPath, lastUsed: Date.now() };
  const entries = Object.entries(history).sort((a, b) => b[1].lastUsed - a[1].lastUsed);
  const trimmed = Object.fromEntries(entries.slice(0, 50));
  const dir = path.dirname(PROJECT_HISTORY_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(PROJECT_HISTORY_PATH, JSON.stringify(trimmed, null, 2), 'utf8');
}

const PINNED_PROJECTS = ['assistant', 'ccgram'];

function getRecentProjects(limit = 10) {
  const home = process.env.HOME || require('os').homedir();
  const history = readProjectHistory();

  // 1. Scan project directories and get modification times
  const projects = new Map(); // name → { path, lastActive }

  const scanDirs = [
    path.join(home, 'projects'),
    path.join(home, 'tools'),
  ];

  for (const base of scanDirs) {
    try {
      const entries = fs.readdirSync(base, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const fullPath = path.join(base, e.name);
        try {
          const mtime = fs.statSync(fullPath).mtimeMs;
          const existing = projects.get(e.name);
          if (!existing || mtime > existing.lastActive) {
            projects.set(e.name, { path: fullPath, lastActive: mtime });
          }
        } catch {}
      }
    } catch {}
  }

  // Also check ~/assistant directly (not under ~/projects/ or ~/tools/)
  try {
    const assistantPath = path.join(home, 'assistant');
    const mtime = fs.statSync(assistantPath).mtimeMs;
    const existing = projects.get('assistant');
    if (!existing || mtime > existing.lastActive) {
      projects.set('assistant', { path: assistantPath, lastActive: mtime });
    }
  } catch {}

  // 2. Merge with project history (use whichever timestamp is more recent)
  for (const [name, data] of Object.entries(history)) {
    const existing = projects.get(name);
    if (existing) {
      existing.lastActive = Math.max(existing.lastActive, data.lastUsed);
    } else {
      // History entry for a directory not in scan dirs — only include if path still exists
      try {
        if (fs.statSync(data.path).isDirectory()) {
          projects.set(name, { path: data.path, lastActive: data.lastUsed });
        }
      } catch {}
    }
  }

  // 3. Separate pinned from unpinned
  const pinned = [];
  const unpinned = [];
  for (const [name, data] of projects) {
    if (PINNED_PROJECTS.includes(name)) {
      pinned.push({ name, path: data.path });
    } else {
      unpinned.push({ name, path: data.path, lastActive: data.lastActive });
    }
  }

  // 4. Sort pinned in defined order, unpinned by lastActive descending
  pinned.sort((a, b) => PINNED_PROJECTS.indexOf(a.name) - PINNED_PROJECTS.indexOf(b.name));
  unpinned.sort((a, b) => b.lastActive - a.lastActive);

  // 5. Combine: pinned first, then unpinned, limited to N
  const result = [...pinned, ...unpinned].slice(0, limit);
  return result.map(({ name, path: p }) => ({ name, path: p }));
}

module.exports = {
  extractWorkspaceName,
  readSessionMap,
  writeSessionMap,
  findSessionByWorkspace,
  resolveWorkspace,
  listActiveSessions,
  upsertSession,
  pruneExpired,
  isExpired,
  getDefaultWorkspace,
  setDefaultWorkspace,
  trackNotificationMessage,
  getWorkspaceForMessage,
  recordProjectUsage,
  getRecentProjects,
  SESSION_MAP_PATH,
};
