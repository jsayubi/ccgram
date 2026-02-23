import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { isUserActiveAtTerminal } from '../src/utils/active-check.js';

const LAST_MSG_FILE = '/tmp/claude_last_msg_time';

function nowSecs() {
  return Math.floor(Date.now() / 1000);
}

let savedContent = null;

beforeEach(() => {
  // Save existing file so we can restore it after the test
  try { savedContent = fs.readFileSync(LAST_MSG_FILE, 'utf8'); } catch { savedContent = null; }
  try { fs.unlinkSync(LAST_MSG_FILE); } catch {}
  delete process.env.ACTIVE_THRESHOLD_SECONDS;
});

afterEach(() => {
  try { fs.unlinkSync(LAST_MSG_FILE); } catch {}
  if (savedContent !== null) {
    fs.writeFileSync(LAST_MSG_FILE, savedContent);
  }
  delete process.env.ACTIVE_THRESHOLD_SECONDS;
});

describe('isUserActiveAtTerminal', () => {
  it('returns false when timestamp file does not exist', () => {
    expect(isUserActiveAtTerminal()).toBe(false);
  });

  it('returns true when timestamp is within the threshold', () => {
    fs.writeFileSync(LAST_MSG_FILE, String(nowSecs() - 60));
    expect(isUserActiveAtTerminal()).toBe(true);
  });

  it('returns false when timestamp is older than the threshold', () => {
    fs.writeFileSync(LAST_MSG_FILE, String(nowSecs() - 400));
    expect(isUserActiveAtTerminal()).toBe(false);
  });

  it('respects explicit threshold argument', () => {
    fs.writeFileSync(LAST_MSG_FILE, String(nowSecs() - 30));
    expect(isUserActiveAtTerminal(20)).toBe(false);
    expect(isUserActiveAtTerminal(60)).toBe(true);
  });

  it('threshold of 0 always returns false', () => {
    fs.writeFileSync(LAST_MSG_FILE, String(nowSecs()));
    expect(isUserActiveAtTerminal(0)).toBe(false);
  });

  it('reads ACTIVE_THRESHOLD_SECONDS from env when no argument is given', () => {
    fs.writeFileSync(LAST_MSG_FILE, String(nowSecs() - 5));
    process.env.ACTIVE_THRESHOLD_SECONDS = '10';
    expect(isUserActiveAtTerminal()).toBe(true);

    process.env.ACTIVE_THRESHOLD_SECONDS = '3';
    expect(isUserActiveAtTerminal()).toBe(false);
  });

  it('returns false for malformed timestamp', () => {
    fs.writeFileSync(LAST_MSG_FILE, 'not-a-number');
    expect(isUserActiveAtTerminal()).toBe(false);
  });

  it('returns false for empty file', () => {
    fs.writeFileSync(LAST_MSG_FILE, '');
    expect(isUserActiveAtTerminal()).toBe(false);
  });
});
