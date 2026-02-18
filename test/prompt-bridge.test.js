import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let testDir;
let bridge;

beforeEach(async () => {
  // Create isolated temp directory for each test
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-bridge-test-'));
  process.env.PROMPTS_DIR = testDir;

  // Reset module cache so prompt-bridge reads the new PROMPTS_DIR
  vi.resetModules();
  bridge = await import('../prompt-bridge.js');
});

afterEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
  delete process.env.PROMPTS_DIR;
});

describe('generatePromptId', () => {
  it('returns an 8-character hex string', () => {
    const id = bridge.generatePromptId();
    expect(id).toMatch(/^[0-9a-f]{8}$/);
  });

  it('returns unique IDs', () => {
    const ids = new Set(Array.from({ length: 20 }, () => bridge.generatePromptId()));
    expect(ids.size).toBe(20);
  });
});

describe('writePending / readPending', () => {
  it('roundtrips data correctly', () => {
    const id = 'test0001';
    const data = { type: 'permission', workspace: 'my-project', tmuxSession: 'claude-my-project' };
    bridge.writePending(id, data);

    const result = bridge.readPending(id);
    expect(result.type).toBe('permission');
    expect(result.workspace).toBe('my-project');
    expect(result.tmuxSession).toBe('claude-my-project');
    expect(result.createdAt).toBeTypeOf('number');
  });

  it('returns null for nonexistent ID', () => {
    expect(bridge.readPending('nonexistent')).toBeNull();
  });
});

describe('writeResponse / readResponse', () => {
  it('roundtrips data correctly', () => {
    const id = 'test0002';
    bridge.writeResponse(id, { action: 'allow' });

    const result = bridge.readResponse(id);
    expect(result.action).toBe('allow');
    expect(result.respondedAt).toBeTypeOf('number');
  });

  it('returns null for nonexistent ID', () => {
    expect(bridge.readResponse('nonexistent')).toBeNull();
  });
});

describe('updatePending', () => {
  it('merges fields into existing pending file', () => {
    const id = 'test0003';
    bridge.writePending(id, { type: 'question', workspace: 'proj', options: ['a', 'b'] });
    bridge.updatePending(id, { selectedOptions: [true, false] });

    const result = bridge.readPending(id);
    expect(result.selectedOptions).toEqual([true, false]);
    expect(result.type).toBe('question');
    expect(result.options).toEqual(['a', 'b']);
  });

  it('does nothing for nonexistent ID', () => {
    // Should not throw
    bridge.updatePending('nonexistent', { foo: 'bar' });
  });
});

describe('cleanPrompt', () => {
  it('removes both pending and response files', () => {
    const id = 'test0004';
    bridge.writePending(id, { type: 'permission' });
    bridge.writeResponse(id, { action: 'deny' });

    expect(bridge.readPending(id)).not.toBeNull();
    expect(bridge.readResponse(id)).not.toBeNull();

    bridge.cleanPrompt(id);

    expect(bridge.readPending(id)).toBeNull();
    expect(bridge.readResponse(id)).toBeNull();
  });

  it('does not throw for nonexistent ID', () => {
    bridge.cleanPrompt('nonexistent');
  });
});

describe('hasPendingForWorkspace', () => {
  it('returns true when a matching pending prompt exists', () => {
    bridge.writePending('test0005', { workspace: 'assistant', type: 'permission' });
    expect(bridge.hasPendingForWorkspace('assistant')).toBe(true);
  });

  it('returns false when no pending prompt exists', () => {
    expect(bridge.hasPendingForWorkspace('nonexistent')).toBe(false);
  });

  it('returns false when a response already exists for the prompt', () => {
    bridge.writePending('test0006', { workspace: 'proj', type: 'permission' });
    bridge.writeResponse('test0006', { action: 'allow' });
    expect(bridge.hasPendingForWorkspace('proj')).toBe(false);
  });
});

describe('cleanExpired', () => {
  it('removes files older than expiry threshold', () => {
    const id = 'test0007';
    const filePath = path.join(testDir, `pending-${id}.json`);
    fs.writeFileSync(filePath, JSON.stringify({ workspace: 'old', createdAt: 0 }));

    // Set mtime to 10 minutes ago (beyond 5-min expiry)
    const oldTime = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(filePath, oldTime, oldTime);

    bridge.cleanExpired();

    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('keeps recent files', () => {
    const id = 'test0008';
    bridge.writePending(id, { workspace: 'recent', type: 'permission' });

    bridge.cleanExpired();

    expect(bridge.readPending(id)).not.toBeNull();
  });
});
