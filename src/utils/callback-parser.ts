/**
 * Callback Data Parser
 *
 * Parses Telegram inline keyboard callback_data strings into
 * structured objects. Format: "type:promptId:action"
 *
 * Extracted from workspace-telegram-bot.js for testability.
 */

import type { ParsedCallback } from '../types';

/**
 * Parse a callback_data string into a structured object.
 *
 * Return shapes:
 *   { type: 'new',        projectName: string }
 *   { type: 'perm',       promptId: string, action: string }
 *   { type: 'opt',        promptId: string, optionIndex: number }
 *   { type: 'opt-submit', promptId: string }
 *   { type: 'qperm',      promptId: string, optionIndex: number }
 */
export function parseCallbackData(data: string | null | undefined): ParsedCallback | null {
  if (!data) return null;

  const parts = data.split(':');
  const type = parts[0];

  // new:<projectName> (rejoin in case name has colons)
  if (type === 'new') {
    const projectName = parts.slice(1).join(':');
    if (!projectName) return null;
    return { type: 'new', projectName };
  }

  // rp:<projectName> — resume project: show session list (rejoin like new:)
  if (type === 'rp') {
    const projectName = parts.slice(1).join(':');
    if (!projectName) return null;
    return { type: 'rp', projectName };
  }

  // rs:<projectName>:<sessionIdx> — resume specific session
  // rc:<projectName>:<sessionIdx> — confirmed resume (kill active + restart)
  // sessionIdx is always the last segment; projectName is everything between
  if (type === 'rs' || type === 'rc') {
    if (parts.length < 3) return null;
    const sessionIdx = parseInt(parts[parts.length - 1], 10);
    if (isNaN(sessionIdx)) return null;
    const projectName = parts.slice(1, parts.length - 1).join(':');
    if (!projectName) return null;
    return { type, projectName, sessionIdx } as ParsedCallback;
  }

  // opt-submit:<promptId> (only 2 parts)
  if (type === 'opt-submit') {
    if (parts.length < 2 || !parts[1]) return null;
    return { type: 'opt-submit', promptId: parts[1] };
  }

  // All other types need at least 3 parts: type:promptId:action
  if (parts.length < 3) return null;

  const promptId = parts[1];
  const action = parts[2];

  if (!promptId) return null;

  switch (type) {
    case 'perm':
      return { type: 'perm', promptId, action };
    case 'opt':
      return { type: 'opt', promptId, optionIndex: parseInt(action, 10) };
    case 'qperm':
      return { type: 'qperm', promptId, optionIndex: parseInt(action, 10) };
    default:
      return null;
  }
}
