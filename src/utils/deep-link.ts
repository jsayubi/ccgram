/**
 * Deep Link Utility — Generate Claude Code deep links.
 *
 * Claude Code supports `claude-cli://open?q=...` deep links (v2.1.85+).
 * - Up to 5,000 characters
 * - Multi-line support via %0A
 * - Opens in user's preferred terminal
 */

const MAX_PROMPT_LENGTH = 4500; // Leave room for URL overhead

/**
 * Generate a Claude Code deep link for the given prompt.
 * Returns null if prompt is too long.
 */
export function generateDeepLink(prompt: string): string | null {
  if (prompt.length > MAX_PROMPT_LENGTH) {
    return null;
  }
  const encoded = encodeURIComponent(prompt);
  return `claude-cli://open?q=${encoded}`;
}

/**
 * Generate a deep link with a specific working directory.
 */
export function generateDeepLinkWithCwd(prompt: string, cwd: string): string | null {
  if (prompt.length + cwd.length > MAX_PROMPT_LENGTH) {
    return null;
  }
  const encodedPrompt = encodeURIComponent(prompt);
  const encodedCwd = encodeURIComponent(cwd);
  return `claude-cli://open?q=${encodedPrompt}&cwd=${encodedCwd}`;
}

/**
 * Check if a prompt can be converted to a deep link.
 */
export function canGenerateDeepLink(prompt: string): boolean {
  return prompt.length <= MAX_PROMPT_LENGTH;
}
