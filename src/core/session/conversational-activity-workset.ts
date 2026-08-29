import type { ProcessableConversationKind } from './conversational-activity.js';

export const CONVERSATIONAL_ACTIVITY_PURPOSES = [
  'episodic_synthesis',
  'sleeptime_consolidation',
] as const;

export type ConversationalActivityPurpose =
  (typeof CONVERSATIONAL_ACTIVITY_PURPOSES)[number];

export interface ConversationalActivityWorkItem {
  purpose: ConversationalActivityPurpose;
  logicalSessionId: string;
  revision: number;
  activityKind: ProcessableConversationKind;
  occurredAtMs: number;
  checkpointRevision: number;
  completedStages: string[];
  claimantId?: string;
  claimedAtMs?: number;
  lastFailure?: ConversationalActivityFailure;
}

export interface ConversationalActivityFailure {
  stage: string;
  message: string;
  failedAtMs: number;
}

export interface ClaimedConversationalActivityWorkItem
  extends ConversationalActivityWorkItem {
  claimantId: string;
  claimedAtMs: number;
}

export interface ConversationalActivityClaimInput {
  purpose: ConversationalActivityPurpose;
  logicalSessionId: string;
  revision: number;
  claimantId: string;
}

export interface ConversationalActivityResumeInput {
  purpose: ConversationalActivityPurpose;
  logicalSessionId: string;
  claimantId: string;
}

export type ConversationalActivityCheckpointInput = ConversationalActivityClaimInput;

export interface ConversationalActivityStageCheckpointInput
  extends ConversationalActivityCheckpointInput {
  stage: string;
}

export interface ConversationalActivityFailureInput
  extends ConversationalActivityStageCheckpointInput {
  message: string;
}

export interface ConversationalActivityWorksetPort {
  /** Enumerate every changed logical session; intentionally has no limit. */
  enumerate(purpose: ConversationalActivityPurpose): Promise<ConversationalActivityWorkItem[]>;
  claim(input: ConversationalActivityClaimInput): Promise<ClaimedConversationalActivityWorkItem | null>;
  resumeClaim(input: ConversationalActivityResumeInput): Promise<ClaimedConversationalActivityWorkItem | null>;
  checkpointStage(input: ConversationalActivityStageCheckpointInput): Promise<void>;
  recordFailure(input: ConversationalActivityFailureInput): Promise<void>;
  checkpoint(input: ConversationalActivityCheckpointInput): Promise<void>;
}
