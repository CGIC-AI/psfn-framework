import { createHash, randomUUID } from 'node:crypto';

import type { EventBus } from '../../../shared/event-bus.js';
import { createComponentLogger } from '../../../shared/logger.js';
import { emitTurnPerformance } from '../../../shared/telemetry/turn-performance.js';
import type { TurnPerformanceDeferReason } from '../../../shared/telemetry/turn-performance.js';
import type { BackgroundWorkStorePort } from './store-port.js';
import {
  BACKGROUND_WORK_KINDS,
  parseBackgroundWorkPayload,
  type BackgroundWorkKind,
  type BackgroundWorkPayload,
  type ClaimedBackgroundWorkJob,
  type EnqueueBackgroundWorkInput,
  type StoredBackgroundWorkJob,
} from './types.js';

const log = createComponentLogger('BackgroundWorkSupervisor');
const DEFAULT_MAX_CONCURRENT_SESSIONS = 4;
const DEFAULT_LEASE_DURATION_MS = 5 * 60_000;
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 5 * 60_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const DEFAULT_TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 60_000;
const TERMINAL_PURGE_BATCH_SIZE = 500;

export interface BackgroundWorkExecutionInput {
  job: ClaimedBackgroundWorkJob;
  payload: BackgroundWorkPayload;
}

export type BackgroundWorkExecutor = (
  input: BackgroundWorkExecutionInput,
) => Promise<void>;

export interface BackgroundWorkSupervisorOptions {
  store: BackgroundWorkStorePort;
  eventBus: EventBus;
  executor: BackgroundWorkExecutor;
  now?: () => number;
  leaseOwner?: string;
  maxConcurrentSessions?: number;
  leaseDurationMs?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  shutdownTimeoutMs?: number;
  terminalRetentionMs?: number;
  cleanupIntervalMs?: number;
}

export interface ForegroundWorkLease {
  readonly id: string;
  readonly logicalSessionId: string;
}

export class BackgroundWorkDeferredError extends Error {
  constructor(
    readonly reasonCode: 'foreground_active' | 'source_not_ready',
    readonly delayMs: number,
  ) {
    super(`Background work deferred: ${reasonCode}`);
    this.name = 'BackgroundWorkDeferredError';
  }
}

export class BackgroundWorkStaleError extends Error {
  constructor(readonly reasonCode: 'superseded') {
    super(`Background work stale: ${reasonCode}`);
    this.name = 'BackgroundWorkStaleError';
  }
}

export class BackgroundWorkPermanentError extends Error {
  constructor(readonly reasonCode: 'source_missing' | 'source_mismatch') {
    super(`Background work permanently failed: ${reasonCode}`);
    this.name = 'BackgroundWorkPermanentError';
  }
}

function normalizePositiveInteger(value: number | undefined, fallback: number, field: string): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return normalized;
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number, field: string): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return normalized;
}

function isBackgroundWorkKind(value: string): value is BackgroundWorkKind {
  return BACKGROUND_WORK_KINDS.some(kind => kind === value);
}

function telemetryDisposition(job: StoredBackgroundWorkJob): TurnPerformanceDeferReason {
  switch (job.state) {
    case 'queued': return job.reasonCode === 'foreground_active' ? 'resumed' : 'queued';
    case 'deferred': return 'rescheduled';
    case 'retry_wait': return 'retry_scheduled';
    case 'running': return 'started';
    case 'succeeded': return 'succeeded';
    case 'failed': return job.reasonCode === 'malformed_payload' || job.reasonCode === 'unknown_kind'
      ? 'malformed_dropped'
      : 'failed';
    case 'stale_discarded': return 'stale_discarded';
  }
}

export class BackgroundWorkSupervisor {
  private readonly store: BackgroundWorkStorePort;
  private readonly eventBus: EventBus;
  private readonly executor: BackgroundWorkExecutor;
  private readonly now: () => number;
  private readonly leaseOwner: string;
  private readonly maxConcurrentSessions: number;
  private readonly leaseDurationMs: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly terminalRetentionMs: number;
  private readonly cleanupIntervalMs: number;
  private readonly foregroundCounts = new Map<string, number>();
  private readonly foregroundLeases = new Map<string, ForegroundWorkLease>();
  private readonly running = new Map<string, {
    job: ClaimedBackgroundWorkJob;
    promise: Promise<void>;
  }>();
  private sessionTransitionTail: Promise<void> = Promise.resolve();
  private tickPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private stopping = false;
  private lastCleanupAtMs = Number.NEGATIVE_INFINITY;

  constructor(options: BackgroundWorkSupervisorOptions) {
    this.store = options.store;
    this.eventBus = options.eventBus;
    this.executor = options.executor;
    this.now = options.now ?? Date.now;
    this.leaseOwner = options.leaseOwner?.trim() || `background-supervisor:${randomUUID()}`;
    this.maxConcurrentSessions = normalizePositiveInteger(
      options.maxConcurrentSessions,
      DEFAULT_MAX_CONCURRENT_SESSIONS,
      'maxConcurrentSessions',
    );
    this.leaseDurationMs = normalizePositiveInteger(
      options.leaseDurationMs,
      DEFAULT_LEASE_DURATION_MS,
      'leaseDurationMs',
    );
    this.retryBaseDelayMs = normalizePositiveInteger(
      options.retryBaseDelayMs,
      DEFAULT_RETRY_BASE_DELAY_MS,
      'retryBaseDelayMs',
    );
    this.retryMaxDelayMs = normalizePositiveInteger(
      options.retryMaxDelayMs,
      DEFAULT_RETRY_MAX_DELAY_MS,
      'retryMaxDelayMs',
    );
    this.shutdownTimeoutMs = normalizeNonNegativeInteger(
      options.shutdownTimeoutMs,
      DEFAULT_SHUTDOWN_TIMEOUT_MS,
      'shutdownTimeoutMs',
    );
    this.terminalRetentionMs = normalizePositiveInteger(
      options.terminalRetentionMs,
      DEFAULT_TERMINAL_RETENTION_MS,
      'terminalRetentionMs',
    );
    this.cleanupIntervalMs = normalizePositiveInteger(
      options.cleanupIntervalMs,
      DEFAULT_CLEANUP_INTERVAL_MS,
      'cleanupIntervalMs',
    );
  }

  async enqueue(inputs: readonly EnqueueBackgroundWorkInput[]): Promise<void> {
    if (this.stopping) throw new Error('Background work supervisor is stopping');
    for (const input of inputs) {
      const result = await this.store.enqueue(input);
      this.emitJobTelemetry(result.job, result.outcome === 'deduplicated' ? 'deduplicated' : undefined);
      for (const staleJobId of result.staleDiscardedJobIds) {
        const stale = await this.store.get(staleJobId);
        if (stale) this.emitJobTelemetry(stale);
      }
      if (this.foregroundCounts.has(input.logicalSessionId)) {
        this.queueForegroundDeferral(input.logicalSessionId);
      }
    }
  }

  beginForeground(logicalSessionId: string): ForegroundWorkLease {
    const normalizedSessionId = logicalSessionId.trim();
    if (!normalizedSessionId) throw new Error('Foreground work requires a logical session id');
    const lease: ForegroundWorkLease = {
      id: randomUUID(),
      logicalSessionId: normalizedSessionId,
    };
    this.foregroundLeases.set(lease.id, lease);
    const current = this.foregroundCounts.get(normalizedSessionId) ?? 0;
    this.foregroundCounts.set(normalizedSessionId, current + 1);
    if (current === 0) {
      this.queueForegroundDeferral(normalizedSessionId);
    }
    return lease;
  }

  endForeground(lease: ForegroundWorkLease): void {
    if (!this.foregroundLeases.delete(lease.id)) return;
    const current = this.foregroundCounts.get(lease.logicalSessionId) ?? 0;
    if (current > 1) {
      this.foregroundCounts.set(lease.logicalSessionId, current - 1);
      return;
    }
    this.foregroundCounts.delete(lease.logicalSessionId);
    this.queueSessionTransition(async () => {
      const resumed = await this.store.resumeDeferredForSession({
        logicalSessionId: lease.logicalSessionId,
        nowMs: this.now(),
      });
      for (const job of resumed) this.emitJobTelemetry(job, 'resumed');
    });
  }

  async tick(): Promise<void> {
    if (this.stopping) return;
    if (this.tickPromise) return this.tickPromise;
    this.tickPromise = this.runTick().finally(() => { this.tickPromise = null; });
    return this.tickPromise;
  }

  async waitForIdle(): Promise<void> {
    await Promise.allSettled([...this.running.values()].map(entry => entry.promise));
  }

  async waitForSessionTransitions(): Promise<void> {
    await this.sessionTransitionTail;
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.stopPromise = (async () => {
      await this.tickPromise;
      await this.waitForSessionTransitions();
      const runningPromises = [...this.running.values()].map(entry => entry.promise);
      if (runningPromises.length > 0 && this.shutdownTimeoutMs > 0) {
        await Promise.race([
          Promise.allSettled(runningPromises),
          new Promise<void>(resolve => setTimeout(resolve, this.shutdownTimeoutMs)),
        ]);
      }
      await this.store.releaseClaims({
        leaseOwner: this.leaseOwner,
        nowMs: this.now(),
        reasonCode: 'shutdown',
      });
    })();
    return this.stopPromise;
  }

  private async runTick(): Promise<void> {
    const nowMs = this.now();
    const runningJobIds = [...this.running.keys()];
    if (runningJobIds.length > 0) {
      await this.store.renewClaims({
        leaseOwner: this.leaseOwner,
        jobIds: runningJobIds,
        nowMs,
        leaseDurationMs: this.leaseDurationMs,
      });
    }
    await this.store.recoverExpired({ nowMs });
    if (nowMs - this.lastCleanupAtMs >= this.cleanupIntervalMs) {
      await this.store.purgeTerminal({
        completedBeforeMs: Math.max(0, nowMs - this.terminalRetentionMs),
        limit: TERMINAL_PURGE_BATCH_SIZE,
      });
      this.lastCleanupAtMs = nowMs;
    }

    while (!this.stopping && this.running.size < this.maxConcurrentSessions) {
      const excludedSessions = new Set(this.foregroundCounts.keys());
      for (const entry of this.running.values()) {
        excludedSessions.add(entry.job.logicalSessionId);
      }
      const job = await this.store.claimNext({
        leaseOwner: this.leaseOwner,
        nowMs: this.now(),
        leaseDurationMs: this.leaseDurationMs,
        excludedLogicalSessionIds: [...excludedSessions],
      });
      if (!job) break;
      const promise = Promise.resolve().then(() => this.executeClaim(job))
        .catch((error) => {
          // A lease/CAS fence may have moved while the handler was running.
          // Leave the durable row for expiry recovery; never leak an unhandled
          // rejection from a scheduler-launched background promise.
          log.error('Background claim execution failed', {
            jobId: job.jobId,
            kind: job.kind,
            errorName: error instanceof Error ? error.name : 'UnknownError',
          });
        })
        .finally(() => {
          this.running.delete(job.jobId);
        });
      this.running.set(job.jobId, { job, promise });
    }
  }

  private async executeClaim(job: ClaimedBackgroundWorkJob): Promise<void> {
    if (this.foregroundCounts.has(job.logicalSessionId)) {
      await this.transitionClaimToDeferred(job, 'foreground_active', this.retryBaseDelayMs);
      return;
    }
    if (!isBackgroundWorkKind(job.kind)) {
      const malformed = await this.store.markClaimMalformed({
        jobId: job.jobId,
        leaseOwner: this.leaseOwner,
        expectedRevision: job.revision,
        reasonCode: 'unknown_kind',
        nowMs: this.now(),
      });
      this.emitJobTelemetry(malformed, undefined, this.executionDurationMs(job));
      return;
    }
    let payload: BackgroundWorkPayload;
    try {
      payload = parseBackgroundWorkPayload(job.kind, job.payload);
    } catch {
      const malformed = await this.store.markClaimMalformed({
        jobId: job.jobId,
        leaseOwner: this.leaseOwner,
        expectedRevision: job.revision,
        reasonCode: 'malformed_payload',
        nowMs: this.now(),
      });
      this.emitJobTelemetry(malformed, undefined, this.executionDurationMs(job));
      return;
    }

    this.emitJobTelemetry(job);
    try {
      await this.executor({ job, payload });
    } catch (error) {
      if (error instanceof BackgroundWorkDeferredError) {
        await this.transitionClaimToDeferred(job, error.reasonCode, error.delayMs);
        return;
      }
      if (error instanceof BackgroundWorkStaleError) {
        const stale = await this.store.markClaimStale({
          jobId: job.jobId,
          leaseOwner: this.leaseOwner,
          expectedRevision: job.revision,
          reasonCode: error.reasonCode,
          nowMs: this.now(),
        });
        this.emitJobTelemetry(stale, undefined, this.executionDurationMs(job));
        return;
      }
      if (error instanceof BackgroundWorkPermanentError) {
        const failed = await this.store.markClaimFailed({
          jobId: job.jobId,
          leaseOwner: this.leaseOwner,
          expectedRevision: job.revision,
          reasonCode: error.reasonCode,
          nowMs: this.now(),
        });
        this.emitJobTelemetry(failed, undefined, this.executionDurationMs(job));
        return;
      }
      const failed = await this.store.failOrRetry({
        jobId: job.jobId,
        leaseOwner: this.leaseOwner,
        expectedRevision: job.revision,
        nowMs: this.now(),
        retryAtMs: this.now() + this.retryDelayMs(job.attemptCount + 1),
      });
      this.emitJobTelemetry(failed, undefined, this.executionDurationMs(job));
      return;
    }

    try {
      const completed = await this.store.complete({
        jobId: job.jobId,
        leaseOwner: this.leaseOwner,
        expectedRevision: job.revision,
        nowMs: this.now(),
      });
      this.emitJobTelemetry(completed, undefined, this.executionDurationMs(job));
    } catch (error) {
      if (!this.stopping) throw error;
      log.debug('Background claim settled after shutdown release', { jobId: job.jobId });
    }
  }

  private async transitionClaimToDeferred(
    job: ClaimedBackgroundWorkJob,
    reasonCode: 'foreground_active' | 'source_not_ready',
    delayMs: number,
  ): Promise<void> {
    const nowMs = this.now();
    const deferred = await this.store.defer({
      jobId: job.jobId,
      leaseOwner: this.leaseOwner,
      expectedRevision: job.revision,
      reasonCode,
      availableAtMs: nowMs + Math.max(0, delayMs),
      nowMs,
    });
    this.emitJobTelemetry(deferred, undefined, this.executionDurationMs(job));
  }

  private retryDelayMs(attempt: number): number {
    return Math.min(
      this.retryMaxDelayMs,
      this.retryBaseDelayMs * (2 ** Math.max(0, attempt - 1)),
    );
  }

  private executionDurationMs(job: ClaimedBackgroundWorkJob): number {
    return Math.max(0, this.now() - job.updatedAtMs);
  }

  private queueSessionTransition(operation: () => Promise<void>): void {
    this.sessionTransitionTail = this.sessionTransitionTail
      .then(operation)
      .catch(() => {
        log.warn('Background session transition failed', {});
      });
  }

  private queueForegroundDeferral(logicalSessionId: string): void {
    this.queueSessionTransition(async () => {
      const nowMs = this.now();
      const deferred = await this.store.deferRunnableForSession({
        logicalSessionId,
        nowMs,
        resumeFallbackAtMs: nowMs + this.leaseDurationMs,
      });
      for (const job of deferred) this.emitJobTelemetry(job);
    });
  }

  private emitJobTelemetry(
    job: StoredBackgroundWorkJob,
    dispositionOverride?: TurnPerformanceDeferReason,
    durationMs?: number,
  ): void {
    const nowMs = this.now();
    const backgroundSessionIdHash = createHash('sha256')
      .update(job.logicalSessionId)
      .digest('hex');
    void this.store.countRunnable({ nowMs })
      .then(queueDepth => emitTurnPerformance(this.eventBus, {
        traceId: job.jobId,
        turnId: job.sourceTurnId,
        requestId: job.sourceRequestId,
        channelId: job.sourceChannelId,
        stage: 'background_job_state',
        backgroundContention: this.running.size >= this.maxConcurrentSessions,
        backgroundJobAgeMs: Math.max(0, nowMs - job.createdAtMs),
        backgroundSessionIdHash,
        backgroundJobAttemptCount: job.attemptCount,
        ...(durationMs !== undefined ? { durationMs } : {}),
        queueDepth,
        ...(isBackgroundWorkKind(job.kind) ? { backgroundJobKind: job.kind } : {}),
        backgroundJobState: job.state,
        backgroundJobReason: job.reasonCode,
        deferReason: dispositionOverride ?? telemetryDisposition(job),
      }))
      .catch(() => {
        log.debug('Background job telemetry emission failed', { jobId: job.jobId });
      });
  }
}
