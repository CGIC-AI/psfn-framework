import { createHash, randomUUID } from 'node:crypto';

import type { EventBus } from '../../../shared/event-bus.js';
import { createComponentLogger } from '../../../shared/logger.js';
import { emitTurnPerformance } from '../../../shared/telemetry/turn-performance.js';
import type { TurnPerformanceDeferReason } from '../../../shared/telemetry/turn-performance.js';
import {
  MAINTENANCE_REFLECTION_RUNTIME_CLASS,
  resolveRuntimeLaneBudgetProfile,
} from '../worker-lanes.js';
import type { BackgroundWorkStorePort, BackgroundWorkWelfarePolicy } from './store-port.js';
import type { BackgroundWorkSupervisorTuning } from './config.js';
import {
  BACKGROUND_WORK_KINDS,
  assertClaimedBackgroundWorkBinding,
  parseBackgroundWorkPayload,
  type BackgroundWorkKind,
  type BackgroundWorkPayload,
  type ClaimedBackgroundWorkJob,
  type EnqueueBackgroundWorkInput,
  type StoredBackgroundWorkJob,
} from './types.js';

const log = createComponentLogger('BackgroundWorkSupervisor');
const TERMINAL_PURGE_BATCH_SIZE = 500;
// Anti-starvation welfare defaults (mmo9.7.4). Conservative: a background job
// must be foreground-deferred many times OR wait several minutes before it is
// admitted past the foreground exclusion, and only into a small bounded reserve.
// The reserve-slot default is sourced from the lane budget profile so the
// welfare-reserve policy has a single home (Law 12.4); a deployment may override
// all three through the scheduler owner file.
const DEFAULT_WELFARE_DEFER_THRESHOLD = 8;
const DEFAULT_WELFARE_AGE_THRESHOLD_MS = 5 * 60_000;
const DEFAULT_WELFARE_RESERVE_SLOTS = resolveRuntimeLaneBudgetProfile(
  MAINTENANCE_REFLECTION_RUNTIME_CLASS,
).welfareReserveSlots;

export interface BackgroundWorkExecutionInput {
  job: ClaimedBackgroundWorkJob;
  payload: BackgroundWorkPayload;
  effects: BackgroundWorkEffectRunner;
  /**
   * Aborts when the claim can no longer make forward progress safely — graceful
   * shutdown began or durable lease ownership was lost. Handlers may forward it
   * to cancellable provider/compute calls so pre-boundary work unwinds promptly
   * instead of waiting out the shutdown drain. Crossing the effect boundary is
   * still gated by the effect runner, never by this signal alone.
   */
  signal: AbortSignal;
}

export interface BackgroundWorkEffectRunner {
  assertOwned(): Promise<void>;
  run(effectKey: string, operation: (assertOwned: () => Promise<void>) => Promise<void>): Promise<void>;
}

export type BackgroundWorkExecutor = (
  input: BackgroundWorkExecutionInput,
) => Promise<void>;

export interface BackgroundWorkSupervisorOptions extends BackgroundWorkSupervisorTuning {
  store: BackgroundWorkStorePort;
  eventBus: EventBus;
  executor: BackgroundWorkExecutor;
  now?: () => number;
  leaseOwner?: string;
  /**
   * Anti-starvation welfare policy (mmo9.7.4). Owner-file backed (scheduler.json)
   * with conservative defaults. `reserveSlots: 0` disables welfare admission
   * entirely (fail-closed to pre-welfare FIFO behavior).
   */
  welfare?: Partial<BackgroundWorkWelfarePolicy>;
}

export interface ForegroundWorkLease {
  readonly id: string;
  readonly logicalSessionId: string;
  readonly ready: Promise<void>;
  /** Aborts when the durable foreground fence can no longer prove ownership. */
  readonly signal: AbortSignal;
}

interface ManagedForegroundWorkLease extends ForegroundWorkLease {
  readonly controller: AbortController;
}

export class ForegroundWorkLeaseLostError extends Error {
  constructor() {
    super('Foreground work lease ownership was lost');
    this.name = 'ForegroundWorkLeaseLostError';
  }
}

class BackgroundWorkLeaseLostError extends Error {
  constructor() {
    super('Background work lease ownership was lost');
    this.name = 'BackgroundWorkLeaseLostError';
  }
}

class BackgroundWorkEffectOutcomeUnknownError extends Error {
  constructor() {
    super('A prior background effect outcome is unknown');
    this.name = 'BackgroundWorkEffectOutcomeUnknownError';
  }
}

/**
 * Thrown from a pre-boundary fence when graceful shutdown begins. It proves the
 * claim never crossed its durable side-effect boundary, so the supervisor may
 * leave the row running for the pre-boundary requeue sweep instead of failing
 * it. It is never thrown once the boundary has been crossed.
 */
export class BackgroundWorkShutdownRequeueError extends Error {
  constructor() {
    super('Background work interrupted before its effect boundary by shutdown');
    this.name = 'BackgroundWorkShutdownRequeueError';
  }
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

function requirePositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value;
}

function requireNonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value;
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
  private readonly welfare: BackgroundWorkWelfarePolicy;
  private readonly foregroundCounts = new Map<string, number>();
  private readonly foregroundLeases = new Map<string, ManagedForegroundWorkLease>();
  private readonly readyForegroundLeaseIds = new Set<string>();
  private readonly running = new Map<string, {
    job: ClaimedBackgroundWorkJob;
    promise: Promise<void>;
    fence: { lost: boolean };
    controller: AbortController;
  }>();
  private sessionTransitionTail: Promise<void> = Promise.resolve();
  private tickPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private stopping = false;
  private lastCleanupAtMs = Number.NEGATIVE_INFINITY;
  private heartbeatPromise: Promise<void> | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(options: BackgroundWorkSupervisorOptions) {
    this.store = options.store;
    this.eventBus = options.eventBus;
    this.executor = options.executor;
    this.now = options.now ?? Date.now;
    this.leaseOwner = options.leaseOwner?.trim() || `background-supervisor:${randomUUID()}`;
    this.maxConcurrentSessions = requirePositiveInteger(
      options.maxConcurrentSessions,
      'maxConcurrentSessions',
    );
    this.leaseDurationMs = requirePositiveInteger(
      options.leaseDurationMs,
      'leaseDurationMs',
    );
    this.retryBaseDelayMs = requirePositiveInteger(
      options.retryBaseDelayMs,
      'retryBaseDelayMs',
    );
    this.retryMaxDelayMs = requirePositiveInteger(
      options.retryMaxDelayMs,
      'retryMaxDelayMs',
    );
    if (this.retryMaxDelayMs < this.retryBaseDelayMs) {
      throw new Error('retryMaxDelayMs must be greater than or equal to retryBaseDelayMs');
    }
    this.shutdownTimeoutMs = requireNonNegativeInteger(
      options.shutdownTimeoutMs,
      'shutdownTimeoutMs',
    );
    this.terminalRetentionMs = requirePositiveInteger(
      options.terminalRetentionMs,
      'terminalRetentionMs',
    );
    this.cleanupIntervalMs = requirePositiveInteger(
      options.cleanupIntervalMs,
      'cleanupIntervalMs',
    );
    const reserveSlots = normalizeNonNegativeInteger(
      options.welfare?.reserveSlots,
      DEFAULT_WELFARE_RESERVE_SLOTS,
      'welfare.reserveSlots',
    );
    this.welfare = reserveSlots === 0
      ? { deferThreshold: 1, ageThresholdMs: 0, reserveSlots: 0 }
      : {
        deferThreshold: normalizePositiveInteger(
          options.welfare?.deferThreshold,
          DEFAULT_WELFARE_DEFER_THRESHOLD,
          'welfare.deferThreshold',
        ),
        ageThresholdMs: normalizeNonNegativeInteger(
          options.welfare?.ageThresholdMs,
          DEFAULT_WELFARE_AGE_THRESHOLD_MS,
          'welfare.ageThresholdMs',
        ),
        reserveSlots,
      };
  }

  async enqueue(inputs: readonly EnqueueBackgroundWorkInput[]): Promise<void> {
    if (this.stopping) throw new Error('Background work supervisor is stopping');
    const results = await this.store.enqueueBatch(inputs);
    for (let index = 0; index < inputs.length; index += 1) {
      const input = inputs[index]!;
      const result = results[index]!;
      if (result.outcome === 'already_accepted') continue;
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
    let settleReady!: () => void;
    let rejectReady!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      settleReady = resolve;
      rejectReady = reject;
    });
    const controller = new AbortController();
    const lease: ManagedForegroundWorkLease = {
      id: randomUUID(),
      logicalSessionId: normalizedSessionId,
      ready,
      signal: controller.signal,
      controller,
    };
    this.foregroundLeases.set(lease.id, lease);
    const current = this.foregroundCounts.get(normalizedSessionId) ?? 0;
    this.foregroundCounts.set(normalizedSessionId, current + 1);
    void this.store.beginForeground({
      logicalSessionId: normalizedSessionId,
      leaseOwner: this.leaseOwner,
      leaseId: lease.id,
      nowMs: this.now(),
      leaseDurationMs: this.leaseDurationMs,
    }).then(() => {
      this.readyForegroundLeaseIds.add(lease.id);
      this.ensureHeartbeat();
      settleReady();
    }).catch((error) => {
      this.foregroundLeases.delete(lease.id);
      this.readyForegroundLeaseIds.delete(lease.id);
      const count = this.foregroundCounts.get(normalizedSessionId) ?? 0;
      if (count <= 1) this.foregroundCounts.delete(normalizedSessionId);
      else this.foregroundCounts.set(normalizedSessionId, count - 1);
      rejectReady(error);
    });
    return lease;
  }

  async endForeground(lease: ForegroundWorkLease): Promise<void> {
    await lease.ready;
    const managedLease = this.foregroundLeases.get(lease.id);
    if (!managedLease) return;
    this.foregroundLeases.delete(lease.id);
    this.readyForegroundLeaseIds.delete(lease.id);
    const current = this.foregroundCounts.get(lease.logicalSessionId) ?? 0;
    if (current > 1) {
      this.foregroundCounts.set(lease.logicalSessionId, current - 1);
      await this.store.endForeground({
        logicalSessionId: lease.logicalSessionId,
        leaseOwner: this.leaseOwner,
        leaseId: lease.id,
        nowMs: this.now(),
      });
      return;
    }
    this.foregroundCounts.delete(lease.logicalSessionId);
    const idle = await this.store.endForeground({
      logicalSessionId: lease.logicalSessionId,
      leaseOwner: this.leaseOwner,
      leaseId: lease.id,
      nowMs: this.now(),
    });
    if (idle) this.queueSessionTransition(async () => {
      const resumed = await this.store.resumeDeferredForSession({
        logicalSessionId: lease.logicalSessionId,
        nowMs: this.now(),
      });
      for (const job of resumed) this.emitJobTelemetry(job, 'resumed');
    });
    if (this.running.size === 0 && this.readyForegroundLeaseIds.size === 0) this.stopHeartbeat();
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
    // Signal every in-flight claim so cancellable provider/compute unwinds and
    // its next pre-boundary fence throws a requeue rather than crossing.
    for (const entry of this.running.values()) {
      if (!entry.controller.signal.aborted) entry.controller.abort();
    }
    const stopAttempt = (async () => {
      await this.tickPromise;
      await this.waitForSessionTransitions();
      const runningPromises = [...this.running.values()].map(entry => entry.promise);
      if (runningPromises.length > 0 && this.shutdownTimeoutMs > 0) {
        await Promise.race([
          Promise.allSettled(runningPromises),
          new Promise<void>(resolve => setTimeout(resolve, this.shutdownTimeoutMs)),
        ]);
      }
      // Durably requeue only pre-boundary work under its claim token before the
      // store closes. A claim that may have crossed its effect boundary keeps a
      // `started` receipt and is left running for fail-closed lease-expiry
      // recovery; the revision bump on requeued rows fences any worker still
      // in-flight from crossing after we release it.
      const requeued = await this.store.requeuePreBoundaryClaims({
        leaseOwner: this.leaseOwner,
        nowMs: this.now(),
        reasonCode: 'shutdown',
      });
      for (const job of requeued) this.emitJobTelemetry(job);
      this.stopHeartbeat();
    })();
    this.stopPromise = stopAttempt;
    try {
      await stopAttempt;
    } catch (error) {
      // Permit an explicit bounded retry by the shutdown owner. `stopping`
      // remains true, so no new claims or enqueue handoffs can enter between
      // attempts and the database must remain open until one succeeds.
      if (this.stopPromise === stopAttempt) this.stopPromise = null;
      throw error;
    }
  }

  private async runTick(): Promise<void> {
    const nowMs = this.now();
    await this.heartbeat();
    await this.store.recoverExpired({ nowMs });
    if (nowMs - this.lastCleanupAtMs >= this.cleanupIntervalMs) {
      await this.store.purgeTerminal({
        completedBeforeMs: Math.max(0, nowMs - this.terminalRetentionMs),
        limit: TERMINAL_PURGE_BATCH_SIZE,
      });
      this.lastCleanupAtMs = nowMs;
    }

    while (!this.stopping && this.running.size < this.maxConcurrentSessions) {
      // Split the exclusion set: a session running a claim is a HARD exclusion
      // (one running job per session is a durable invariant), while a session
      // that merely has foreground activity is a SOFT exclusion a welfare-aged
      // job may bypass into a bounded reserve slot (mmo9.7.4).
      const runningExcluded = new Set<string>();
      for (const entry of this.running.values()) {
        runningExcluded.add(entry.job.logicalSessionId);
      }
      const foregroundExcluded = new Set(this.foregroundCounts.keys());
      const job = await this.store.claimNext({
        leaseOwner: this.leaseOwner,
        nowMs: this.now(),
        leaseDurationMs: this.leaseDurationMs,
        excludedLogicalSessionIds: [...runningExcluded],
        foregroundExcludedLogicalSessionIds: [...foregroundExcluded],
        welfare: this.welfare,
      });
      if (!job) break;
      const fence = { lost: false };
      const controller = new AbortController();
      this.ensureHeartbeat();
      const promise = Promise.resolve().then(() => this.executeClaim(job, fence, controller))
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
          if (this.running.size === 0 && this.foregroundLeases.size === 0) this.stopHeartbeat();
        });
      this.running.set(job.jobId, { job, promise, fence, controller });
    }
  }

  private async executeClaim(
    job: ClaimedBackgroundWorkJob,
    fence: { lost: boolean },
    controller: AbortController,
  ): Promise<void> {
    // A welfare-admitted claim (mmo9.7.4) is deliberately immune to the
    // in-memory foreground re-defer here: it was aged past the threshold and
    // granted a protected completion in a bounded reserve slot, so re-deferring
    // it now would restart the preempt→defer→preempt starvation loop the welfare
    // path exists to break. Its durable effect fences are correspondingly immune
    // in the store. Non-welfare claims keep the original fail-safe re-defer.
    if (!job.welfareClaimed && this.foregroundCounts.has(job.logicalSessionId)) {
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
      assertClaimedBackgroundWorkBinding(job, payload);
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
      await this.executor({
        job,
        payload,
        effects: this.createEffectRunner(job, fence),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof BackgroundWorkShutdownRequeueError) {
        // Pre-boundary interruption: the claim never crossed its effect
        // boundary. Leave the row running for the shutdown requeue sweep, which
        // returns it to pending under a bumped revision. Never fail or retry it
        // here — that would count a shutdown as an attempt.
        log.debug('Background claim interrupted before effect boundary by shutdown', {
          jobId: job.jobId,
          kind: job.kind,
        });
        return;
      }
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
      if (error instanceof BackgroundWorkEffectOutcomeUnknownError) {
        const failed = await this.store.markClaimFailed({
          jobId: job.jobId,
          leaseOwner: this.leaseOwner,
          expectedRevision: job.revision,
          reasonCode: 'effect_outcome_unknown',
          nowMs: this.now(),
        });
        this.emitJobTelemetry(failed, undefined, this.executionDurationMs(job));
        return;
      }
      if (error instanceof BackgroundWorkLeaseLostError) return;
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

  private createEffectRunner(
    job: ClaimedBackgroundWorkJob,
    fence: { lost: boolean },
  ): BackgroundWorkEffectRunner {
    const assertLeaseOwned = async (): Promise<void> => {
      if (fence.lost) throw new BackgroundWorkLeaseLostError();
      const owned = await this.store.assertClaimOwned({
        jobId: job.jobId,
        leaseOwner: this.leaseOwner,
        expectedRevision: job.revision,
        nowMs: this.now(),
      });
      if (!owned) {
        fence.lost = true;
        throw new BackgroundWorkLeaseLostError();
      }
    };
    const assertEffectAllowed = async (): Promise<void> => {
      if (fence.lost) throw new BackgroundWorkLeaseLostError();
      const disposition = await this.store.checkClaimFence({
        jobId: job.jobId,
        leaseOwner: this.leaseOwner,
        expectedRevision: job.revision,
        nowMs: this.now(),
      });
      if (disposition === 'foreground_active') {
        throw new BackgroundWorkDeferredError('foreground_active', this.retryBaseDelayMs);
      }
      if (disposition === 'lease_lost') {
        fence.lost = true;
        throw new BackgroundWorkLeaseLostError();
      }
    };
    // Pre-boundary shutdown is a requeue, not a failure: it must abort the
    // handler before it can cross its effect boundary. Once the boundary has
    // been crossed this must not fire, or an in-progress write would be torn.
    const throwIfShuttingDown = (): void => {
      if (this.stopping) throw new BackgroundWorkShutdownRequeueError();
    };
    return {
      assertOwned: async () => {
        throwIfShuttingDown();
        await assertEffectAllowed();
      },
      run: async (effectKey, operation) => {
        throwIfShuttingDown();
        await assertEffectAllowed();
        // Open the effect as `pending`: the run has entered but no external
        // write has been attempted, so the job stays safely requeue-able until
        // the handler crosses its write boundary below.
        const disposition = await this.store.beginEffect({
          jobId: job.jobId,
          effectKey,
          leaseOwner: this.leaseOwner,
          expectedRevision: job.revision,
          nowMs: this.now(),
        });
        if (disposition === 'foreground_active') {
          throw new BackgroundWorkDeferredError('foreground_active', this.retryBaseDelayMs);
        }
        if (disposition === 'lease_lost') {
          fence.lost = true;
          throw new BackgroundWorkLeaseLostError();
        }
        if (disposition === 'applied') return;
        if (disposition === 'outcome_unknown') {
          throw new BackgroundWorkEffectOutcomeUnknownError();
        }
        // Holder object (matching the `fence` pattern) so the mutation inside
        // the `crossBoundary` closure is visible to the catch below.
        const boundary = { crossed: false };
        // The durable side-effect boundary. Handlers call this immediately
        // before their sink write; the first call promotes the receipt from
        // `pending` to `started` (outcome-ambiguous on interruption). Before the
        // crossing, shutdown unwinds to a requeue; after it, shutdown must not
        // interrupt the write, so only lease ownership is re-fenced.
        const crossBoundary = async (): Promise<void> => {
          if (fence.lost) throw new BackgroundWorkLeaseLostError();
          if (boundary.crossed) {
            await assertLeaseOwned();
            return;
          }
          throwIfShuttingDown();
          const commit = await this.store.commitEffectBoundary({
            jobId: job.jobId,
            effectKey,
            leaseOwner: this.leaseOwner,
            expectedRevision: job.revision,
            nowMs: this.now(),
          });
          if (commit === 'foreground_active') {
            throw new BackgroundWorkDeferredError('foreground_active', this.retryBaseDelayMs);
          }
          if (commit === 'lease_lost') {
            fence.lost = true;
            throw new BackgroundWorkLeaseLostError();
          }
          // 'crossed' (or the unreachable 'applied' — beginEffect already
          // returns early for an applied receipt, so this owner/revision cannot
          // observe one here). The boundary is now durably marked.
          boundary.crossed = true;
        };
        let operationCompleted = false;
        try {
          await operation(crossBoundary);
          operationCompleted = true;
          // Once the operation reports success, a later foreground arrival
          // cannot make that durable outcome un-happen. Fence only queue lease
          // ownership here so the receipt is committed exactly once.
          await assertLeaseOwned();
          await this.store.completeEffect({
            jobId: job.jobId,
            effectKey,
            leaseOwner: this.leaseOwner,
            expectedRevision: job.revision,
            nowMs: this.now(),
          });
        } catch (error) {
          // Abandon (delete the receipt) ONLY when the effect never crossed its
          // durable write boundary. A pre-boundary `pending` receipt carries no
          // durable-effect risk, so dropping it lets the job re-run cleanly. Once
          // the boundary is crossed the receipt is `started` — durable evidence
          // that a write may have happened — and MUST be left in place so a
          // retry fails closed via `outcome_unknown` rather than replaying the
          // write and duplicating the durable effect (u5bv.6). `abandonEffect`
          // also refuses to delete a `started` receipt at the store level; this
          // guard additionally avoids the pointless post-boundary DELETE.
          if (
            !boundary.crossed
            && !operationCompleted
            && !(error instanceof BackgroundWorkLeaseLostError)
          ) {
            await this.store.abandonEffect({
              jobId: job.jobId,
              effectKey,
              leaseOwner: this.leaseOwner,
              expectedRevision: job.revision,
              nowMs: this.now(),
            });
          }
          throw error;
        }
      },
    };
  }

  private async heartbeat(): Promise<void> {
    if (this.heartbeatPromise) return this.heartbeatPromise;
    this.heartbeatPromise = (async () => {
      const nowMs = this.now();
      const running = [...this.running.values()];
      if (running.length > 0) {
        let renewed: string[];
        try {
          renewed = await this.store.renewClaims({
            leaseOwner: this.leaseOwner,
            jobIds: running.map(entry => entry.job.jobId),
            nowMs,
            leaseDurationMs: this.leaseDurationMs,
          });
        } catch (error) {
          for (const entry of running) this.markClaimFenceLost(entry);
          throw error;
        }
        const renewedIds = new Set(renewed);
        for (const entry of running) {
          if (!renewedIds.has(entry.job.jobId)) this.markClaimFenceLost(entry);
        }
      }
      const foregroundLeaseIds = [...this.readyForegroundLeaseIds];
      if (foregroundLeaseIds.length > 0) {
        let renewed: Set<string>;
        try {
          renewed = new Set(await this.store.renewForeground({
            leaseOwner: this.leaseOwner,
            leaseIds: foregroundLeaseIds,
            nowMs,
            leaseDurationMs: this.leaseDurationMs,
          }));
        } catch (error) {
          for (const leaseId of foregroundLeaseIds) this.markForegroundLeaseLost(leaseId);
          throw error;
        }
        let lost = false;
        for (const leaseId of foregroundLeaseIds) {
          if (renewed.has(leaseId)) continue;
          this.markForegroundLeaseLost(leaseId);
          lost = true;
        }
        if (lost) {
          throw new ForegroundWorkLeaseLostError();
        }
      }
    })().finally(() => { this.heartbeatPromise = null; });
    return this.heartbeatPromise;
  }

  private ensureHeartbeat(): void {
    if (this.heartbeatTimer) return;
    const intervalMs = Math.max(10, Math.floor(this.leaseDurationMs / 3));
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeat().catch((error) => {
        log.error('Background lease heartbeat failed', {
          errorName: error instanceof Error ? error.name : 'UnknownError',
        });
      });
    }, intervalMs);
    this.heartbeatTimer.unref();
  }

  private stopHeartbeat(): void {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private markClaimFenceLost(entry: {
    fence: { lost: boolean };
    controller: AbortController;
  }): void {
    entry.fence.lost = true;
    if (!entry.controller.signal.aborted) entry.controller.abort();
  }

  private markForegroundLeaseLost(leaseId: string): void {
    // The store grants an observed-expired lease one durable quarantine
    // extension while omitting it from the renewed ids. Once that loss is
    // observed locally, the id must never be submitted to another heartbeat:
    // doing so would turn the bounded quarantine into an immortal lease.
    this.readyForegroundLeaseIds.delete(leaseId);
    const lease = this.foregroundLeases.get(leaseId);
    if (lease && !lease.signal.aborted) {
      lease.controller.abort(new ForegroundWorkLeaseLostError());
    }
    if (this.running.size === 0 && this.readyForegroundLeaseIds.size === 0) {
      this.stopHeartbeat();
    }
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
