/**
 * IPC types for file-based prompt bridge communication.
 * Files live in /tmp/claude-prompts/ as pending-<id>.json / response-<id>.json.
 */

export interface PendingBase {
  workspace: string;
  tmuxSession: string | null;
  createdAt: number; // ms timestamp (Date.now())
}

export interface PendingPermission extends PendingBase {
  type: 'permission';
  toolName: string;
  toolInput: Record<string, unknown>;
}

export interface PendingPlan extends PendingBase {
  type: 'plan';
  toolName: string;
  toolInput: Record<string, unknown>;
}

export interface PendingQuestion extends PendingBase {
  type: 'question';
  questionText: string;
  options: string[];
  multiSelect: boolean;
  selectedOptions?: boolean[];
  isLast: boolean;
}

export interface PendingQuestionFreeText extends PendingBase {
  type: 'question-freetext';
  questionText: string;
}

export type PendingPrompt =
  | PendingPermission
  | PendingPlan
  | PendingQuestion
  | PendingQuestionFreeText;

export interface ResponsePermission {
  action: 'allow' | 'deny' | 'always';
  respondedAt: number; // ms timestamp
}

export interface ResponseQperm {
  action: 'allow';
  selectedOption: number;
  respondedAt: number; // ms timestamp
}

export type PromptResponse = ResponsePermission | ResponseQperm;
