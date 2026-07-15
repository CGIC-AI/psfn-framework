import type {
  BackgroundWorkReasonCode,
  ClaimedBackgroundWorkJob,
  EnqueueBackgroundWorkInput,
  StoredBackgroundWorkJob,
} from './types.js';

export interface BackgroundWorkEnqueueResult {
  outcome: 'enqueued' | 'deduplicated';
  job: StoredBackgroundWorkJob;
  staleDiscardedJobIds: string[];
}

export interface BackgroundWorkStorePort {
  enqueue(input: EnqueueBackgroundWorkInput): Promise<BackgroundWorkEnqueueResult>;
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
  }): Promise<number>;
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
    reasonCode: 'source_missing' | 'source_mismatch';
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
