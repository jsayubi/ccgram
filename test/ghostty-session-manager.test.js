import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GhosttySessionManager } from '../src/utils/ghostty-session-manager.js';

// Mock child_process so tests don't require a live Ghostty installation
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    execSync: vi.fn(),
    exec: vi.fn(),
  };
});

import { execSync, exec } from 'child_process';

describe('GhosttySessionManager', () => {
  let manager;
  let originalPlatform;

  beforeEach(() => {
    originalPlatform = process.platform;
    vi.clearAllMocks();
    manager = new GhosttySessionManager();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  describe('isAvailable()', () => {
    it('returns false on non-darwin platform', () => {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      expect(manager.isAvailable()).toBe(false);
      expect(execSync).not.toHaveBeenCalled();
    });

    it('returns false on win32 platform', () => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      expect(manager.isAvailable()).toBe(false);
    });

    it('returns true when osascript reports Ghostty is running', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      execSync.mockReturnValue('true\n');
      expect(manager.isAvailable()).toBe(true);
    });

    it('returns false when osascript reports Ghostty is not running', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      execSync.mockReturnValue('false\n');
      expect(manager.isAvailable()).toBe(false);
    });

    it('returns false when osascript throws', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      execSync.mockImplementation(() => { throw new Error('osascript failed'); });
      expect(manager.isAvailable()).toBe(false);
    });
  });

  describe('has()', () => {
    it('returns false before register()', () => {
      expect(manager.has('myproject')).toBe(false);
    });

    it('returns true after register()', () => {
      manager.register('myproject', '/Users/test/myproject');
      expect(manager.has('myproject')).toBe(true);
    });

    it('returns false after unregister()', () => {
      manager.register('myproject', '/Users/test/myproject');
      manager.unregister('myproject');
      expect(manager.has('myproject')).toBe(false);
    });
  });

  describe('register() and unregister()', () => {
    it('register() stores handle and allows retrieval via has()', () => {
      manager.register('proj-a', '/Users/test/proj-a');
      manager.register('proj-b', '/Users/test/proj-b');
      expect(manager.has('proj-a')).toBe(true);
      expect(manager.has('proj-b')).toBe(true);
      expect(manager.has('proj-c')).toBe(false);
    });

    it('register() updates existing handle with new cwd', () => {
      manager.register('proj', '/old/path');
      manager.register('proj', '/new/path');
      expect(manager.has('proj')).toBe(true);
      // Has should still return true after update
    });

    it('unregister() on unknown name does not throw', () => {
      expect(() => manager.unregister('nonexistent')).not.toThrow();
    });

    it('unregister() removes only the specified handle', () => {
      manager.register('proj-a', '/Users/test/proj-a');
      manager.register('proj-b', '/Users/test/proj-b');
      manager.unregister('proj-a');
      expect(manager.has('proj-a')).toBe(false);
      expect(manager.has('proj-b')).toBe(true);
    });
  });

  describe('sendKey() when manager unavailable', () => {
    it('returns false gracefully when no handle registered', async () => {
      const result = await manager.sendKey('unregistered-session', 'Down');
      expect(result).toBe(false);
    });

    it('returns false gracefully for interrupt when no handle registered', async () => {
      const result = await manager.interrupt('unregistered-session');
      expect(result).toBe(false);
    });
  });

  describe('write() when no handle registered', () => {
    it('returns false when session not registered', async () => {
      const result = await manager.write('unregistered', 'hello');
      expect(result).toBe(false);
    });
  });

  describe('capture() when no handle registered', () => {
    it('returns null when session not registered', async () => {
      const result = await manager.capture('unregistered');
      expect(result).toBeNull();
    });
  });
});
