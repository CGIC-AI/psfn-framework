import type {
  BackgroundWorkReasonCode,
  ClaimedBackgroundWorkJob,
  EnqueueBackgroundWorkInput,
  StoredBackgroundWorkJob,
} from './types.js';

export interface BackgroundWorkJobEnqueueResult {
  outcome: 'enqueued' | 'deduplicated';
  job: StoredBackgroundWorkJob;
  staleDiscardedJobIds: string[];
}

export type BackgroundWorkEnqueueResult =
  | BackgroundWorkJobEnqueueResult
  | {
    /** Permanent turn-level ledger survived terminal job retention cleanup. */
    outcome: 'already_accepted';
    jobId: string;
    staleDiscardedJobIds: [];
  };

export type BackgroundWorkClaimFence = 'owned' | 'foreground_active' | 'lease_lost';

export interface BackgroundWorkStorePort {
  enqueue(input: EnqueueBackgroundWorkInput): Promise<BackgroundWorkJobEnqueueResult>;
  /** Atomic all-or-nothing enqueue for one canonical TurnRecord handoff. */
  enqueueBatch(inputs: readonly EnqueueBackgroundWorkInput[]): Promise<BackgroundWorkEnqueueResult[]>;
  beginForeground(input: {
    logicalSessionId: string;
    leaseOwner: string;
    leaseId: string;
    nowMs: number;
    leaseDurationMs: number;
  }): Promise<void>;
  renewForeground(input: {
    leaseOwner: string;
    leaseIds: readonly string[];
    nowMs: number;
    leaseDurationMs: number;
  }): Promise<string[]>;
  endForeground(input: {
    logicalSessionId: string;
    leaseOwner: string;
    leaseId: string;
    nowMs: number;
  }): Promise<boolean>;
  deferRunnableForSession(input: {
    logicalSessionId: string;
    nowMs: number;
    resumeFallbackAtMs: number;
  }): Promise<StoredBackgroundWorkJob[]>;
  resumeDeferredForSession(input: {
    logicalSessionId: string;
    nowMs: number;
  }): Promise<StoredBackgroundWorkJob[]>;
  claimNext(input: {
    leaseOwner: string;
    nowMs: number;
    leaseDurationMs: number;
    excludedLogicalSessionIds: readonly string[];
  }): Promise<ClaimedBackgroundWorkJob | null>;
  renewClaims(input: {
    leaseOwner: string;
    jobIds: readonly string[];
    nowMs: number;
    leaseDurationMs: number;
  }): Promise<string[]>;
  assertClaimOwned(input: {
    jobId: string;
    leaseOwner: string;
    expectedRevision: number;
    nowMs: number;
  }): Promise<boolean>;
  checkClaimFence(input: {
    jobId: string;
    leaseOwner: string;
    expectedRevision: number;
    nowMs: number;
  }): Promise<BackgroundWorkClaimFence>;
  beginEffect(input: {
    jobId: string;
    effectKey: string;
    leaseOwner: string;
    expectedRevision: number;
    nowMs: number;
  }): Promise<'execute' | 'applied' | 'outcome_unknown' | 'foreground_active' | 'lease_lost'>;
  completeEffect(input: {
    jobId: string;
    effectKey: string;
    leaseOwner: string;
    expectedRevision: number;
    nowMs: number;
  }): Promise<void>;
  abandonEffect(input: {
    jobId: string;
    effectKey: string;
    leaseOwner: string;
    expectedRevision: number;
    nowMs: number;
  }): Promise<void>;
  complete(input: {
    jobId: string;
    leaseOwner: string;
    expectedRevision: number;
    nowMs: number;
  }): Promise<StoredBackgroundWorkJob>;
  defer(input: {
    jobId: string;
    leaseOwner: string;
    expectedRevision: number;
    reasonCode: BackgroundWorkReasonCode;
    availableAtMs: number;
    nowMs: number;
  }): Promise<StoredBackgroundWorkJob>;
  failOrRetry(input: {
    jobId: string;
    leaseOwner: string;
    expectedRevision: number;
    nowMs: number;
    retryAtMs: number;
  }): Promise<StoredBackgroundWorkJob>;
  markClaimMalformed(input: {
    jobId: string;
    leaseOwner: string;
    expectedRevision: number;
    reasonCode: 'malformed_payload' | 'unknown_kind';
    nowMs: number;
  }): Promise<StoredBackgroundWorkJob>;
  markClaimFailed(input: {
    jobId: string;
    leaseOwner: string;
    expectedRevision: number;
    reasonCode: 'source_missing' | 'source_mismatch' | 'effect_outcome_unknown';
    nowMs: number;
  }): Promise<StoredBackgroundWorkJob>;
  markClaimStale(input: {
    jobId: string;
    leaseOwner: string;
    expectedRevision: number;
    reasonCode: 'source_missing' | 'source_mismatch' | 'superseded';
    nowMs: number;
  }): Promise<StoredBackgroundWorkJob>;
  releaseClaims(input: {
    leaseOwner: string;
    nowMs: number;
    reasonCode: 'shutdown';
  }): Promise<number>;
  recoverExpired(input: { nowMs: number }): Promise<number>;
  purgeTerminal(input: { completedBeforeMs: number; limit: number }): Promise<number>;
  countRunnable(input: { nowMs: number }): Promise<number>;
  get(jobId: string): Promise<StoredBackgroundWorkJob | null>;
  close(): Promise<void>;
}
