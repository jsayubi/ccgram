import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let testDir;
let router;

beforeEach(async () => {
  // Create isolated temp directory for all data files
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-router-test-'));

  process.env.SESSION_MAP_PATH = path.join(testDir, 'session-map.json');
  process.env.CCGRAM_DATA_DIR = testDir;
  process.env.DEFAULT_WORKSPACE_PATH = path.join(testDir, 'default-workspace.json');
  process.env.MESSAGE_WORKSPACE_MAP_PATH = path.join(testDir, 'message-workspace-map.json');
  process.env.PROJECT_HISTORY_PATH = path.join(testDir, 'project-history.json');

  // Reset module cache so workspace-router reads new env vars
  vi.resetModules();
  router = await import('../workspace-router.js');
});

afterEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
  delete process.env.SESSION_MAP_PATH;
  delete process.env.CCGRAM_DATA_DIR;
  delete process.env.DEFAULT_WORKSPACE_PATH;
  delete process.env.MESSAGE_WORKSPACE_MAP_PATH;
  delete process.env.PROJECT_HISTORY_PATH;
});

describe('extractWorkspaceName', () => {
  it('extracts basename from a path', () => {
    expect(router.extractWorkspaceName('/home/user/projects/my-project')).toBe('my-project');
  });

  it('handles single directory', () => {
    expect(router.extractWorkspaceName('/assistant')).toBe('assistant');
  });

  it('returns null for empty/null input', () => {
    expect(router.extractWorkspaceName(null)).toBeNull();
    expect(router.extractWorkspaceName('')).toBeNull();
  });
});

describe('isExpired', () => {
  it('returns true for expired session', () => {
    const session = { expiresAt: Math.floor(Date.now() / 1000) - 100 };
    expect(router.isExpired(session)).toBe(true);
  });

  it('returns false for valid session', () => {
    const session = { expiresAt: Math.floor(Date.now() / 1000) + 3600 };
    expect(router.isExpired(session)).toBe(false);
  });

  it('returns falsy when no expiresAt', () => {
    expect(router.isExpired({})).toBeFalsy();
  });
});

describe('readSessionMap / writeSessionMap', () => {
  it('returns empty object when no map exists', () => {
    expect(router.readSessionMap()).toEqual({});
  });

  it('roundtrips data', () => {
    const map = { TOKEN1: { cwd: '/foo', createdAt: 100 } };
    router.writeSessionMap(map);
    expect(router.readSessionMap()).toEqual(map);
  });
});

// Helper: write a session map with known entries
function seedSessions(entries) {
  const now = Math.floor(Date.now() / 1000);
  const map = {};
  for (const [token, workspace, opts = {}] of entries) {
    map[token] = {
      type: 'pty',
      createdAt: opts.createdAt || now,
      expiresAt: opts.expired ? now - 100 : now + 86400,
      cwd: `/home/user/projects/${workspace}`,
      tmuxSession: `claude-${workspace}`,
      description: `running - ${workspace}`,
    };
  }
  router.writeSessionMap(map);
}

describe('resolveWorkspace', () => {
  it('returns exact match', () => {
    seedSessions([['T1', 'assistant']]);
    const result = router.resolveWorkspace('assistant');
    expect(result.type).toBe('exact');
    expect(result.workspace).toBe('assistant');
  });

  it('returns exact match case-insensitively', () => {
    seedSessions([['T1', 'Assistant']]);
    const result = router.resolveWorkspace('assistant');
    expect(result.type).toBe('exact');
  });

  it('returns prefix match for unique prefix', () => {
    seedSessions([['T1', 'assistant']]);
    const result = router.resolveWorkspace('ass');
    expect(result.type).toBe('prefix');
    expect(result.workspace).toBe('assistant');
  });

  it('returns ambiguous when prefix matches multiple', () => {
    seedSessions([['T1', 'app-frontend'], ['T2', 'app-backend']]);
    const result = router.resolveWorkspace('app');
    expect(result.type).toBe('ambiguous');
    expect(result.matches).toHaveLength(2);
  });

  it('returns none when nothing matches', () => {
    seedSessions([['T1', 'assistant']]);
    const result = router.resolveWorkspace('zzz');
    expect(result.type).toBe('none');
  });

  it('skips expired sessions', () => {
    seedSessions([['T1', 'assistant', { expired: true }]]);
    const result = router.resolveWorkspace('assistant');
    expect(result.type).toBe('none');
  });
});

describe('findSessionByWorkspace', () => {
  it('finds matching session', () => {
    seedSessions([['T1', 'ccgram']]);
    const result = router.findSessionByWorkspace('ccgram');
    expect(result).not.toBeNull();
    expect(result.token).toBe('T1');
  });

  it('returns most recent when multiple sessions for same workspace', () => {
    const now = Math.floor(Date.now() / 1000);
    seedSessions([
      ['T1', 'ccgram', { createdAt: now - 100 }],
      ['T2', 'ccgram', { createdAt: now }],
    ]);
    const result = router.findSessionByWorkspace('ccgram');
    expect(result.token).toBe('T2');
  });

  it('returns null when not found', () => {
    expect(router.findSessionByWorkspace('nonexistent')).toBeNull();
  });
});

describe('upsertSession', () => {
  it('creates a new session', () => {
    const result = router.upsertSession({
      cwd: '/home/user/projects/test-proj',
      tmuxSession: 'claude-test-proj',
      status: 'running',
    });
    expect(result.workspace).toBe('test-proj');
    expect(result.token).toMatch(/^[A-Z0-9]{8}$/);

    const map = router.readSessionMap();
    expect(Object.keys(map)).toHaveLength(1);
  });

  it('reuses token for same cwd + tmuxSession', () => {
    const first = router.upsertSession({
      cwd: '/home/user/projects/proj',
      tmuxSession: 'claude-proj',
      status: 'running',
    });
    const second = router.upsertSession({
      cwd: '/home/user/projects/proj',
      tmuxSession: 'claude-proj',
      status: 'running',
    });
    expect(second.token).toBe(first.token);

    const map = router.readSessionMap();
    expect(Object.keys(map)).toHaveLength(1);
  });
});

describe('pruneExpired', () => {
  it('removes expired sessions', () => {
    seedSessions([
      ['T1', 'old', { expired: true }],
      ['T2', 'new'],
    ]);
    const pruned = router.pruneExpired();
    expect(pruned).toBe(1);

    const map = router.readSessionMap();
    expect(map['T1']).toBeUndefined();
    expect(map['T2']).toBeDefined();
  });

  it('returns 0 when nothing to prune', () => {
    seedSessions([['T1', 'active']]);
    expect(router.pruneExpired()).toBe(0);
  });
});

describe('listActiveSessions', () => {
  it('lists non-expired sessions deduplicated by workspace', () => {
    const now = Math.floor(Date.now() / 1000);
    seedSessions([
      ['T1', 'proj', { createdAt: now - 100 }],
      ['T2', 'proj', { createdAt: now }],
      ['T3', 'other'],
    ]);
    const sessions = router.listActiveSessions();
    expect(sessions).toHaveLength(2);
    // Should pick newest session for 'proj'
    const proj = sessions.find(s => s.workspace === 'proj');
    expect(proj.token).toBe('T2');
  });
});

describe('default workspace', () => {
  it('returns null when no default set', () => {
    expect(router.getDefaultWorkspace()).toBeNull();
  });

  it('roundtrips set/get', () => {
    router.setDefaultWorkspace('assistant');
    expect(router.getDefaultWorkspace()).toBe('assistant');
  });

  it('clears when set to null', () => {
    router.setDefaultWorkspace('assistant');
    router.setDefaultWorkspace(null);
    expect(router.getDefaultWorkspace()).toBeNull();
  });
});

describe('message-to-workspace tracking', () => {
  it('tracks and retrieves message workspace', () => {
    router.trackNotificationMessage(12345, 'assistant', 'permission');
    expect(router.getWorkspaceForMessage(12345)).toBe('assistant');
  });

  it('returns null for unknown message', () => {
    expect(router.getWorkspaceForMessage(99999)).toBeNull();
  });

  it('returns null for null/undefined messageId', () => {
    expect(router.getWorkspaceForMessage(null)).toBeNull();
    expect(router.getWorkspaceForMessage(undefined)).toBeNull();
  });
});
