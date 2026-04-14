import { describe, it, expect } from 'vitest';
import { generateDeepLink, generateDeepLinkWithCwd, canGenerateDeepLink } from '../dist/src/utils/deep-link.js';

describe('deep-link utility', () => {
  describe('generateDeepLink', () => {
    it('should generate a valid deep link for a simple prompt', () => {
      const link = generateDeepLink('Fix the bug');
      expect(link).toBe('claude-cli://open?q=Fix%20the%20bug');
    });

    it('should handle multi-line prompts', () => {
      const link = generateDeepLink('Fix the bug\nin line 42');
      expect(link).toBe('claude-cli://open?q=Fix%20the%20bug%0Ain%20line%2042');
    });

    it('should handle special characters', () => {
      const link = generateDeepLink('Fix: "bug" & <issue>');
      expect(link).toContain('claude-cli://open?q=');
      expect(link).toContain(encodeURIComponent('Fix: "bug" & <issue>'));
    });

    it('should return null for prompts that are too long', () => {
      const longPrompt = 'x'.repeat(5000);
      const link = generateDeepLink(longPrompt);
      expect(link).toBeNull();
    });

    it('should handle prompts at the edge of the limit', () => {
      const edgePrompt = 'x'.repeat(4500);
      const link = generateDeepLink(edgePrompt);
      expect(link).not.toBeNull();
    });
  });

  describe('generateDeepLinkWithCwd', () => {
    it('should include cwd parameter', () => {
      const link = generateDeepLinkWithCwd('Fix bug', '/Users/test/project');
      expect(link).toContain('q=Fix%20bug');
      expect(link).toContain('cwd=');
      expect(link).toContain(encodeURIComponent('/Users/test/project'));
    });

    it('should return null if combined length is too long', () => {
      const longPrompt = 'x'.repeat(4000);
      const longCwd = 'y'.repeat(1000);
      const link = generateDeepLinkWithCwd(longPrompt, longCwd);
      expect(link).toBeNull();
    });
  });

  describe('canGenerateDeepLink', () => {
    it('should return true for short prompts', () => {
      expect(canGenerateDeepLink('Fix the bug')).toBe(true);
    });

    it('should return false for long prompts', () => {
      expect(canGenerateDeepLink('x'.repeat(5000))).toBe(false);
    });

    it('should return true at exactly the limit', () => {
      expect(canGenerateDeepLink('x'.repeat(4500))).toBe(true);
    });

    it('should return false just over the limit', () => {
      expect(canGenerateDeepLink('x'.repeat(4501))).toBe(false);
    });
  });
});
