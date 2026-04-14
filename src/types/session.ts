/**
 * Session and workspace routing types.
 *
 * NOTE: SessionEntry.createdAt and expiresAt are in SECONDS (Unix epoch).
 * All other timestamps in the codebase use milliseconds.
 */

export interface RateLimitInfo {
  /** Requests remaining in current window */
  remaining?: number;
  /** Total requests allowed in window */
  limit?: number;
  /** Unix timestamp when limit resets (seconds) */
  resetsAt?: number;
  /** Last updated (Unix ms) */
  updatedAt: number;
}

export interface SessionEntry {
  type: string;
  /** Actual session mode — absent means 'tmux' for backwards compatibility */
  sessionType?: 'tmux' | 'pty' | 'ghostty';
  /** Unix timestamp in SECONDS */
  createdAt: number;
  /** Unix timestamp in SECONDS */
  expiresAt: number;
  cwd: string;
  sessionId: string | null;
  tmuxSession: string;
  description: string;
  /** Rate limit info from Claude Code (v2.1.80+) */
  rateLimit?: RateLimitInfo;
}

export interface SessionMap {
  [token: string]: SessionEntry;
}

export type ResolveType = 'exact' | 'prefix' | 'ambiguous' | 'none';

export interface ResolveExact {
  type: 'exact';
  match: { token: string; session: SessionEntry };
  workspace: string;
}

export interface ResolvePrefix {
  type: 'prefix';
  match: { token: string; session: SessionEntry };
  workspace: string;
}

export interface ResolveAmbiguous {
  type: 'ambiguous';
  matches: Array<{ workspace: string; token: string; session: SessionEntry }>;
}

export interface ResolveNone {
  type: 'none';
}

export type ResolveResult = ResolveExact | ResolvePrefix | ResolveAmbiguous | ResolveNone;

export interface DefaultWorkspaceFile {
  workspace: string;
}

export interface MessageWorkspaceEntry {
  workspace: string;
  type: string;
  timestamp: number; // ms
}

export interface MessageWorkspaceMap {
  [messageId: string]: MessageWorkspaceEntry;
}

export interface SessionHistoryEntry {
  id: string;        // Claude Code session UUID
  startedAt: number; // Unix ms
}

export interface ProjectHistoryEntry {
  path: string;
  lastUsed: number; // ms
  sessions?: SessionHistoryEntry[]; // newest first, max 5
}

export interface ProjectHistoryMap {
  [name: string]: ProjectHistoryEntry;
}
