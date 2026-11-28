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
  /**
   * Consecutive recorded failures of the current claim chain. Absent means
   * none; reset only when the claim checkpoints or a newer revision is claimed.
   */
  failureCount?: number;
  /** Earliest instant a failed, still-held claim may be retried. */
  retryAfterMs?: number;
}

/**
 * A session whose bounded retries were exhausted. The claim was released
 * without advancing the checkpoint, so its unprocessed source stays intact:
 * newer activity (a revision above `quarantinedRevision`) or an operator
 * release makes it eligible again.
 */
export interface QuarantinedConversationalActivityWorkItem
  extends ConversationalActivityWorkItem {
  quarantinedRevision: number;
  quarantinedAtMs: number;
}

interface ConversationalActivityFailure {
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
  /** Hold the claim until this instant before the next retry (absent: no hold). */
  retryAfterMs?: number;
}

export interface ConversationalActivitySessionInput {
  purpose: ConversationalActivityPurpose;
  logicalSessionId: string;
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

/**
 * Claim lifecycle beyond success: give a claim back without evaluating it, and
 * bound a claim that keeps failing. Neither ever advances the checkpoint, so a
 * session's unprocessed source is never discarded by failure handling.
 */
export interface ConversationalActivityClaimRecoveryPort {
  /** Release an active claim unevaluated; the session stays eligible. */
  releaseClaim(input: ConversationalActivityCheckpointInput): Promise<void>;
  /**
   * Release an exhausted claim into quarantine at its claimed revision. The
   * recorded failure stays visible; enumerate() skips the session until newer
   * activity arrives or an operator releases it.
   */
  quarantineClaim(input: ConversationalActivityCheckpointInput): Promise<void>;
  listQuarantined(
    purpose: ConversationalActivityPurpose,
  ): Promise<QuarantinedConversationalActivityWorkItem[]>;
  /** Operator recovery: clear a quarantine so the next drain retries it. */
  releaseQuarantine(input: ConversationalActivitySessionInput): Promise<boolean>;
}

export type RecoverableConversationalActivityWorksetPort =
  ConversationalActivityWorksetPort & ConversationalActivityClaimRecoveryPort;
