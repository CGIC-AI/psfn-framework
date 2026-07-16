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

/**
 * Bounded anti-starvation welfare policy (mmo9.7.4). A runnable job crosses the
 * welfare threshold once it has accrued `deferThreshold` foreground defers OR its
 * first foreground defer is at least `ageThresholdMs` old; such a job may then be
 * admitted past the foreground exclusion into one of `reserveSlots` globally
 * bounded welfare slots. This is a reservation in the EXISTING claimNext choke,
 * not a second scheduler (Law 12.4). A `reserveSlots` of 0 disables welfare
 * admission entirely (fail-closed to pre-welfare FIFO behavior).
 */
export interface BackgroundWorkWelfarePolicy {
  deferThreshold: number;
  ageThresholdMs: number;
  reserveSlots: number;
}

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
    /**
     * Hard exclusion: sessions with a job this owner is already running. Never
     * bypassed (one running job per session is a durable invariant).
     */
    excludedLogicalSessionIds: readonly string[];
    /**
     * Foreground-active sessions. Normally excluded, but a welfare-eligible job
     * (mmo9.7.4) may bypass this into a bounded welfare-reserve slot so sustained
     * foreground turns cannot starve it forever. Optional — omission preserves
     * the pre-welfare behavior where the durable foreground-lease exclusion is
     * the only foreground gate.
     */
    foregroundExcludedLogicalSessionIds?: readonly string[];
    /** Anti-starvation welfare policy (mmo9.7.4). Absent/0-slot disables welfare admission. */
    welfare?: BackgroundWorkWelfarePolicy;
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
  /**
   * Open an effect at its durable phase boundary. Writes a `pending` receipt
   * (run entered, no external write attempted yet — the job is still safely
   * requeue-able) and returns `execute`, or the terminal replay disposition for
   * an incumbent receipt. The `pending` phase is promoted to `started` only when
   * the handler crosses its write boundary via {@link commitEffectBoundary}.
   */
  beginEffect(input: {
    jobId: string;
    effectKey: string;
    leaseOwner: string;
    expectedRevision: number;
    nowMs: number;
  }): Promise<'execute' | 'applied' | 'outcome_unknown' | 'foreground_active' | 'lease_lost'>;
  /**
   * Cross the durable side-effect boundary for an already-open (`pending`)
   * effect. Promotes the receipt to `started` under the same per-session lock
   * that foreground acquisition takes, so "effect boundary crossed" and
   * "foreground active" form one total order. Idempotent for a receipt this
   * owner/revision already promoted.
   */
  commitEffectBoundary(input: {
    jobId: string;
    effectKey: string;
    leaseOwner: string;
    expectedRevision: number;
    nowMs: number;
  }): Promise<'crossed' | 'applied' | 'foreground_active' | 'lease_lost'>;
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
  /**
   * Durably requeue this owner's running claims that are still pre-boundary —
   * i.e. have no `started`/`applied` effect receipt — during graceful shutdown.
   * A claim whose handler may have crossed its effect boundary (a `started`
   * receipt exists) is left running for lease-expiry recovery so its outcome
   * stays fail-closed. The revision bump fences any still-in-flight worker: its
   * next {@link commitEffectBoundary} will fail ownership before it can write.
   * Returns the requeued jobs so the supervisor can emit lifecycle telemetry.
   */
  requeuePreBoundaryClaims(input: {
    leaseOwner: string;
    nowMs: number;
    reasonCode: 'shutdown';
  }): Promise<StoredBackgroundWorkJob[]>;
  recoverExpired(input: { nowMs: number }): Promise<number>;
  purgeTerminal(input: { completedBeforeMs: number; limit: number }): Promise<number>;
  countRunnable(input: { nowMs: number }): Promise<number>;
  get(jobId: string): Promise<StoredBackgroundWorkJob | null>;
  close(): Promise<void>;
}
