/**
 * Transcript Reader — reads Claude Code session JSONL transcripts to surface
 * developer-useful status info (model, context %, last assistant message, etc.)
 *
 * Path: ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
 * Encoding: cwd with `/` replaced by `-` (so `/Users/foo/bar` → `-Users-foo-bar`)
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

/** Status fields parsed from a session transcript. */
export interface TranscriptStatus {
  model?: string;
  version?: string;
  gitBranch?: string;
  slug?: string;
  cwd?: string;
  sessionId?: string;
  /** Total prompt+output tokens from the most recent assistant turn. */
  contextTokens?: number;
  /** Inferred from model name; null if unknown. */
  contextLimit?: number | null;
  /** 0-100, omitted when contextLimit is null. */
  contextPct?: number;
  /** Plain-text snippet of the last assistant message, truncated. */
  lastAssistantMessage?: string;
  /** ISO timestamp of the last assistant message. */
  lastAssistantTimestamp?: string;
}

/** Encode a cwd into Claude Code's project directory name. */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/\//g, '-');
}

/** Build the full path to a session's JSONL transcript. */
export function getTranscriptPath(cwd: string, sessionId: string): string {
  const encoded = encodeCwd(cwd);
  return path.join(os.homedir(), '.claude', 'projects', encoded, `${sessionId}.jsonl`);
}

/**
 * Find the most recently modified transcript for a cwd when sessionId is unknown.
 * Returns null if no transcripts exist for that cwd.
 */
export function findLatestTranscript(cwd: string): { sessionId: string; path: string; mtimeMs: number } | null {
  const dir = path.join(os.homedir(), '.claude', 'projects', encodeCwd(cwd));
  if (!fs.existsSync(dir)) return null;

  let latest: { sessionId: string; path: string; mtimeMs: number } | null = null;
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.jsonl')) continue;
    const full = path.join(dir, entry);
    try {
      const mtimeMs = fs.statSync(full).mtimeMs;
      if (!latest || mtimeMs > latest.mtimeMs) {
        latest = { sessionId: entry.replace(/\.jsonl$/, ''), path: full, mtimeMs };
      }
    } catch {}
  }
  return latest;
}

/**
 * Inferred context window size for known model name patterns.
 * Returns null when we don't know the limit (caller should omit % display).
 *
 * Note: the [1m] suffix that enables 1M context is an API parameter — the model
 * field in transcripts does NOT include it. So we conservatively assume 200K
 * for Opus 4.6 unless we find a way to detect 1m mode.
 */
export function inferContextLimit(model: string | undefined): number | null {
  if (!model) return null;
  const m = model.toLowerCase();
  if (m.includes('opus-4-6') || m.includes('sonnet-4-6') || m.includes('haiku-4-5')) return 200000;
  if (m.includes('opus-4-5') || m.includes('sonnet-4-5') || m.includes('haiku-4-1')) return 200000;
  if (m.includes('opus') || m.includes('sonnet') || m.includes('haiku')) return 200000;
  return null;
}

/**
 * Sum the tokens that count toward the context window from a `usage` object.
 * Cache reads count — they are still in-context. Output tokens count too,
 * because they become part of the next turn's prompt.
 */
function sumContextTokens(usage: Record<string, unknown>): number {
  const input = (usage.input_tokens as number) || 0;
  const cacheRead = (usage.cache_read_input_tokens as number) || 0;
  const cacheCreate = (usage.cache_creation_input_tokens as number) || 0;
  const output = (usage.output_tokens as number) || 0;
  return input + cacheRead + cacheCreate + output;
}

/**
 * Read the tail of a JSONL file efficiently, returning up to `maxLines`
 * trailing lines as parsed JSON objects. Lines that fail to parse are skipped.
 */
function readTailLines(filePath: string, maxLines: number): Array<Record<string, unknown>> {
  const stat = fs.statSync(filePath);
  // Read up to ~256KB from the end — enough for ~hundreds of small entries.
  const readBytes = Math.min(stat.size, 262144);
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(readBytes);
    fs.readSync(fd, buf, 0, readBytes, stat.size - readBytes);
    const text = buf.toString('utf8');
    // Drop any partial first line if we didn't read from byte 0.
    const lines = text.split('\n');
    if (stat.size > readBytes) lines.shift();
    const tail = lines.slice(-maxLines).filter(l => l.trim().length > 0);
    const out: Array<Record<string, unknown>> = [];
    for (const line of tail) {
      try {
        out.push(JSON.parse(line));
      } catch {}
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Extract plain text from a Claude API `content` array, ignoring tool_use blocks.
 */
function extractAssistantText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object' && (block as Record<string, unknown>).type === 'text') {
      const text = (block as Record<string, unknown>).text;
      if (typeof text === 'string') parts.push(text);
    }
  }
  return parts.join('\n').trim();
}

/**
 * Read the latest status info from a session's transcript.
 * Returns null when the transcript file doesn't exist or is unreadable.
 *
 * `maxAssistantChars` truncates the last-message snippet to keep Telegram
 * messages under their 4096-char limit.
 */
export function readTranscriptStatus(
  cwd: string,
  sessionId: string | undefined,
  maxAssistantChars: number = 600
): TranscriptStatus | null {
  let filePath: string;
  let resolvedSessionId: string;

  if (sessionId) {
    filePath = getTranscriptPath(cwd, sessionId);
    resolvedSessionId = sessionId;
    if (!fs.existsSync(filePath)) {
      // Fall through to the latest-transcript fallback when the named session
      // is gone (e.g. user resumed and the bot has stale state).
      const latest = findLatestTranscript(cwd);
      if (!latest) return null;
      filePath = latest.path;
      resolvedSessionId = latest.sessionId;
    }
  } else {
    const latest = findLatestTranscript(cwd);
    if (!latest) return null;
    filePath = latest.path;
    resolvedSessionId = latest.sessionId;
  }

  let entries: Array<Record<string, unknown>>;
  try {
    entries = readTailLines(filePath, 100);
  } catch {
    return null;
  }
  if (entries.length === 0) return null;

  const status: TranscriptStatus = { sessionId: resolvedSessionId };

  // Walk backward to find the most recent assistant entry — that's where model
  // / usage / metadata live. Static metadata (cwd, version, gitBranch, slug)
  // is on every entry, so the last one is fine.
  const last = entries[entries.length - 1];
  if (typeof last.cwd === 'string') status.cwd = last.cwd;
  if (typeof last.version === 'string') status.version = last.version;
  if (typeof last.gitBranch === 'string') status.gitBranch = last.gitBranch;
  if (typeof last.slug === 'string') status.slug = last.slug;

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== 'assistant') continue;
    const message = (entry.message as Record<string, unknown>) || {};

    if (!status.model && typeof message.model === 'string') {
      status.model = message.model;
    }

    if (status.contextTokens === undefined) {
      const usage = message.usage as Record<string, unknown> | undefined;
      if (usage) {
        status.contextTokens = sumContextTokens(usage);
        // 1h ephemeral cache is only available in extended-context (1M) mode,
        // so its presence is a reliable signal that the limit is 1M.
        const cacheCreation = usage.cache_creation as Record<string, unknown> | undefined;
        const has1hCache = cacheCreation && (cacheCreation.ephemeral_1h_input_tokens as number) > 0;
        status.contextLimit = has1hCache ? 1000000 : inferContextLimit(status.model);
        if (status.contextLimit && status.contextLimit > 0) {
          // Don't cap — if tokens exceed the assumed limit, the user is on a
          // larger-context mode we couldn't detect; showing >100% is more honest
          // than silently flooring the value.
          status.contextPct = Math.round((status.contextTokens / status.contextLimit) * 100);
        }
      }
    }

    if (status.lastAssistantMessage === undefined) {
      const text = extractAssistantText(message);
      if (text.length > 0) {
        status.lastAssistantMessage = text.length > maxAssistantChars
          ? text.slice(0, maxAssistantChars).trimEnd() + '…'
          : text;
        if (typeof entry.timestamp === 'string') {
          status.lastAssistantTimestamp = entry.timestamp;
        }
      }
    }

    if (status.model && status.contextTokens !== undefined && status.lastAssistantMessage !== undefined) {
      break;
    }
  }

  return status;
}
