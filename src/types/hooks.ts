/**
 * Claude Code hook stdin payload types.
 */

export interface HookStdinBase {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
  session_id?: string;
  hook_event_name?: string;
  transcript_path?: string;
}

export interface ToolInputBash {
  command: string;
  description?: string;
  timeout?: number;
}

export interface ToolInputEdit {
  file_path: string;
  old_string?: string;
  new_string?: string;
}

export interface ToolInputWrite {
  file_path: string;
  content: string;
}

export interface AskUserQuestionItem {
  question: string;
  header: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
}

export interface ToolInputAskUser {
  questions: AskUserQuestionItem[];
}

export interface PermissionHookOutput {
  hookSpecificOutput: {
    hookEventName: 'PermissionRequest';
    decision: {
      behavior: 'allow' | 'deny';
    };
  };
  systemMessage?: string;
}
