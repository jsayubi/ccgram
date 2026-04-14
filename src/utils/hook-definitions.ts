/**
 * Single source of truth for the Claude Code hooks ccgram installs.
 *
 * Both the interactive `setup.ts` wizard and the `cli.ts` (`ccgram hooks`)
 * command import from here so they cannot drift apart again.
 */

export interface HookDefinition {
  /** Claude Code hook event name (e.g. "PermissionRequest"). */
  event: string;
  /** Script filename inside the dist/ directory (e.g. "permission-hook.js"). */
  script: string;
  /** Hook timeout in seconds. */
  timeout: number;
  /** CLI arg passed to the script, e.g. "completed" for the multi-mode enhanced-hook-notify.js. */
  args?: string;
  /** Tool/event matcher (e.g. "AskUserQuestion" for PreToolUse). */
  matcher?: string;
  /** Claude Code v2.1.85+ — conditional execution (jq expression). */
  if?: string;
}

/** Every hook ccgram installs. Order matches the order in which hooks fire. */
export const HOOK_DEFINITIONS: HookDefinition[] = [
  // Core hooks
  { event: 'PermissionRequest',  script: 'permission-hook.js',         timeout: 120 },
  { event: 'PreToolUse',         script: 'question-notify.js',         timeout: 120, matcher: 'AskUserQuestion' },
  { event: 'Stop',               script: 'enhanced-hook-notify.js',    args: 'completed',           timeout: 5 },
  { event: 'Notification',       script: 'enhanced-hook-notify.js',    args: 'waiting',             timeout: 5, matcher: 'permission_prompt' },
  { event: 'UserPromptSubmit',   script: 'user-prompt-hook.js',        timeout: 2 },
  { event: 'SessionStart',       script: 'enhanced-hook-notify.js',    args: 'session-start',       timeout: 5 },
  { event: 'SessionEnd',         script: 'enhanced-hook-notify.js',    args: 'session-end',         timeout: 5 },
  { event: 'SubagentStop',       script: 'enhanced-hook-notify.js',    args: 'subagent-done',       timeout: 5 },
  // Phase 2 (Claude Code v2.1.76+)
  { event: 'PermissionDenied',   script: 'permission-denied-notify.js', timeout: 30 },
  { event: 'StopFailure',        script: 'enhanced-hook-notify.js',    args: 'stop-failure',        timeout: 5 },
  { event: 'PostCompact',        script: 'enhanced-hook-notify.js',    args: 'post-compact',        timeout: 5 },
  { event: 'PreCompact',         script: 'pre-compact-notify.js',      timeout: 30 },
  { event: 'Elicitation',        script: 'elicitation-notify.js',      timeout: 120 },
  { event: 'TaskCreated',        script: 'enhanced-hook-notify.js',    args: 'task-created',        timeout: 5 },
  { event: 'CwdChanged',         script: 'enhanced-hook-notify.js',    args: 'cwd-changed',         timeout: 5 },
  { event: 'InstructionsLoaded', script: 'enhanced-hook-notify.js',    args: 'instructions-loaded', timeout: 5 },
];

/** Distinct script filenames referenced by HOOK_DEFINITIONS — used by installers to verify that every hook script is present in the install destination. */
export function uniqueHookScripts(): string[] {
  return Array.from(new Set(HOOK_DEFINITIONS.map(h => h.script)));
}
