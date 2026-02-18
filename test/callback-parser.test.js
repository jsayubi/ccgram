import { describe, it, expect } from 'vitest';
import { parseCallbackData } from '../src/utils/callback-parser.js';

describe('parseCallbackData', () => {
  it('parses perm:id:allow', () => {
    const result = parseCallbackData('perm:abc123:allow');
    expect(result).toEqual({ type: 'perm', promptId: 'abc123', action: 'allow' });
  });

  it('parses perm:id:deny', () => {
    const result = parseCallbackData('perm:abc123:deny');
    expect(result).toEqual({ type: 'perm', promptId: 'abc123', action: 'deny' });
  });

  it('parses perm:id:always', () => {
    const result = parseCallbackData('perm:abc123:always');
    expect(result).toEqual({ type: 'perm', promptId: 'abc123', action: 'always' });
  });

  it('parses opt:id:N with integer optionIndex', () => {
    const result = parseCallbackData('opt:abc123:2');
    expect(result).toEqual({ type: 'opt', promptId: 'abc123', optionIndex: 2 });
  });

  it('parses opt-submit:id (2 parts only)', () => {
    const result = parseCallbackData('opt-submit:abc123');
    expect(result).toEqual({ type: 'opt-submit', promptId: 'abc123' });
  });

  it('parses new:projectName', () => {
    const result = parseCallbackData('new:my-project');
    expect(result).toEqual({ type: 'new', projectName: 'my-project' });
  });

  it('parses new: with colons in project name', () => {
    const result = parseCallbackData('new:my:project:name');
    expect(result).toEqual({ type: 'new', projectName: 'my:project:name' });
  });

  it('parses qperm:id:N', () => {
    const result = parseCallbackData('qperm:abc123:1');
    expect(result).toEqual({ type: 'qperm', promptId: 'abc123', optionIndex: 1 });
  });

  it('returns null for empty string', () => {
    expect(parseCallbackData('')).toBeNull();
  });

  it('returns null for null/undefined', () => {
    expect(parseCallbackData(null)).toBeNull();
    expect(parseCallbackData(undefined)).toBeNull();
  });

  it('returns null for unknown type', () => {
    expect(parseCallbackData('unknown:abc:123')).toBeNull();
  });

  it('returns null for too few parts (non opt-submit)', () => {
    expect(parseCallbackData('perm:abc123')).toBeNull();
    expect(parseCallbackData('opt:abc123')).toBeNull();
  });

  it('returns null for new: with no project name', () => {
    expect(parseCallbackData('new:')).toBeNull();
  });

  it('returns null for opt-submit with no promptId', () => {
    expect(parseCallbackData('opt-submit:')).toBeNull();
  });
});
