import type {
  AutomataArtifactRef,
  AutomataRunStatus,
  ProductionAutomataClassId,
} from './registry-contract.js';
import type {
  AutomataSessionClassification,
  SessionClassification,
} from './session-classification.js';

export type AutomataRetentionReason =
  | 'eligible'
  | 'proof_missing'
  | 'target_mismatch'
  | 'generation_not_terminal'
  | 'run_not_terminal'
  | 'pending_work'
  | 'pending_handoff'
  | 'artifact_custody_pending'
  | 'promotion_receipt_missing'
  | 'review_pending'
  | 'retention_window_open'
  | 'shard_unfolded'
  | 'target_changed'
  | 'evidence_unresolvable'
  | 'purge_incomplete'
  | 'purge_failed'
  | 'already_purged';

export type AutomataSessionPurgeSurface =
  | 'journals'
  | 'journal_rolls'
  | 'channel_index'
  | 'transcript_projection'
  | 'turn_records'
  | 'redis_tail_pointers';

export interface PromotionCompleteReceipt {
  disposition: 'promoted';
  receiptRefs: string[];
  copiedEvidenceRefs: string[];
}

export interface NothingToPromoteReceipt {
  disposition: 'nothing_to_promote';
  receiptRef: string;
}

export type AutomataPromotionReceipt =
  | PromotionCompleteReceipt
  | NothingToPromoteReceipt;

/**
 * Snapshot supplied from durable run, handoff, promotion, and review truth.
 * targetRevision must change whenever any represented proof changes.
 */
export interface AutomataRetentionProof {
  companionId: string;
  sessionId: string;
  runId: string;
  automatonClass: ProductionAutomataClassId;
  workerGeneration: number;
  generationState: 'active' | 'terminal';
  runStatus: AutomataRunStatus;
  pendingWorkCount: number;
  handoffState: 'pending' | 'recorded' | 'not_required';
  artifacts: AutomataArtifactRef[];
  promotionReceipt?: AutomataPromotionReceipt;
  reviewState: 'pending' | 'clear';
  foldState: 'not_required' | 'pending' | 'folded' | 'rejected';
  targetRevision: string;
}

export interface AutomataRetentionProofPort {
  loadProof(classification: AutomataSessionClassification): Promise<AutomataRetentionProof | null>;
}

export interface PermanentReferenceCustodyPort {
  assertResolvable(references: readonly string[]): Promise<void>;
}

export interface ExactSessionPurgeInput {
  companionId: string;
  sessionId: string;
  runId: string;
  targetRevision: string;
  preserveReferences: readonly string[];
}

export interface ExactSessionPurgeSurfaceReport {
  surface: AutomataSessionPurgeSurface;
  status: 'removed' | 'already_absent';
  removedCount: number;
}

export interface ExactSessionPurgeReport {
  companionId: string;
  sessionId: string;
  runId: string;
  targetRevision: string;
  status: 'purged' | 'already_purged';
  surfaces: ExactSessionPurgeSurfaceReport[];
  verifiedPreservedReferences: string[];
}

/**
 * Production implementations are a recovery-safe exact-session saga. They may
 * stage across files/Postgres/Redis, but must be restart-idempotent and return
 * only after every required surface is absent and every preserve ref resolves.
 */
export interface ExactSessionPurgePort {
  purgeExactSession(input: ExactSessionPurgeInput): Promise<ExactSessionPurgeReport>;
}

export type AutomataRetentionAuditKind =
  | 'retained'
  | 'purge_started'
  | 'purged'
  | 'retryable_failure';

export interface AutomataRetentionAuditEvent {
  schemaVersion: 1;
  eventId: string;
  attemptId: string;
  companionId: string;
  sessionId: string;
  runId: string;
  automatonClass: ProductionAutomataClassId;
  workerGeneration: number;
  kind: AutomataRetentionAuditKind;
  reason: AutomataRetentionReason;
  occurredAtMs: number;
  targetRevision?: string;
  removedCounts?: Partial<Record<AutomataSessionPurgeSurface, number>>;
  preservedReferenceCount?: number;
  errorDigest?: string;
}

export interface AutomataRetentionStorePort {
  recordClassification(classification: SessionClassification): Promise<void>;
  listDueAutomataSessions(
    companionId: string,
    nowMs: number,
    limit: number,
  ): Promise<AutomataSessionClassification[]>;
  hasPurgeReceipt(companionId: string, sessionId: string): Promise<boolean>;
  appendAuditEvent(event: AutomataRetentionAuditEvent): Promise<void>;
}

export interface AutomataRetentionDecision {
  eligible: boolean;
  reason: AutomataRetentionReason;
  preserveReferences: string[];
}

export interface AutomataRetentionRunResult {
  sessionId: string;
  outcome: 'purged' | 'retained' | 'retryable_failure' | 'already_purged';
  reason: AutomataRetentionReason;
}
