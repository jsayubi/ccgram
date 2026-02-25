/**
 * Telegram inline keyboard callback_data parsed types.
 * Format: "type:promptId:action"
 */

export interface CallbackNew {
  type: 'new';
  projectName: string;
}

export interface CallbackPerm {
  type: 'perm';
  promptId: string;
  action: string;
}

export interface CallbackOpt {
  type: 'opt';
  promptId: string;
  optionIndex: number;
}

export interface CallbackOptSubmit {
  type: 'opt-submit';
  promptId: string;
}

export interface CallbackQperm {
  type: 'qperm';
  promptId: string;
  optionIndex: number;
}

export interface CallbackResumeProject {
  type: 'rp';
  projectName: string;
}

export interface CallbackResumeSession {
  type: 'rs';
  projectName: string;
  sessionIdx: number;
}

export interface CallbackResumeConfirm {
  type: 'rc';
  projectName: string;
  sessionIdx: number;
}

export type ParsedCallback =
  | CallbackNew
  | CallbackPerm
  | CallbackOpt
  | CallbackOptSubmit
  | CallbackQperm
  | CallbackResumeProject
  | CallbackResumeSession
  | CallbackResumeConfirm;
