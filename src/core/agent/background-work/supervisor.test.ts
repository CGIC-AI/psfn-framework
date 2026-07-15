import { describe, expect, it, vi } from 'vitest';

import { EventBus } from '../../../shared/event-bus.js';
import type {
  BackgroundWorkEnqueueResult,
  BackgroundWorkJobEnqueueResult,
  BackgroundWorkStorePort,
} from './store-port.js';
import {
  BackgroundWorkPermanentError,
  BackgroundWorkSupervisor,
} from './supervisor.js';
import type {
  BackgroundWorkReasonCode,
  ClaimedBackgroundWorkJob,
  EnqueueBackgroundWorkInput,
  StoredBackgroundWorkJob,
} from './types.js';
import {
  createBackgroundWorkIdentity,
  fingerprintBackgroundWorkPayload,
  type MemoryExtractionBackgroundPayload,
} from './types.js';

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
}

function makeInput(sessionId: string, turnId: string): EnqueueBackgroundWorkInput {
  const payload: MemoryExtractionBackgroundPayload = {
    schemaVersion: 1,
    kind: 'memory_extraction',
    source: {
      schemaVersion: 1,
      logicalSessionId: sessionId,
      channelId: sessionId,
      turnId,
      requestId: `request-${turnId}`,
      turnRecordFingerprint: 'a'.repeat(64),
      createdAtMs: 100,
    },
  };
  return {
    ...createBackgroundWorkIdentity({ logicalSessionId: sessionId, turnId, kind: payload.kind }),
    logicalSessionId: sessionId,
    kind: payload.kind,
    payload,
    payloadFingerprint: fingerprintBackgroundWorkPayload(payload),
    sourceTurnId: turnId,
    sourceRequestId: `request-${turnId}`,
    sourceChannelId: sessionId,
    createdAtMs: 100,
    maxAttempts: 3,
  };
}

class MemoryBackgroundWorkStore implements BackgroundWorkStorePort {
  private jobs = new Map<string, StoredBackgroundWorkJob>();
  private foreground = new Map<string, {
    logicalSessionId: string;
    leaseOwner: string;
    expiresAtMs: number;
  }>();
  private effects = new Map<string, {
    state: 'started' | 'applied';
    leaseOwner: string;
    revision: number;
  }>();

  async enqueue(input: EnqueueBackgroundWorkInput): Promise<BackgroundWorkJobEnqueueResult> {
    const incumbent = [...this.jobs.values()].find(job => job.idempotencyKey === input.idempotencyKey);
    if (incumbent) {
      if (incumbent.payloadFingerprint !== input.payloadFingerprint) {
        throw new Error('idempotency mismatch');
      }
      return { outcome: 'deduplicated', job: { ...incumbent }, staleDiscardedJobIds: [] };
    }
    const job: StoredBackgroundWorkJob = {
      ...input,
      payloadSchemaVersion: 1,
      state: 'queued',
      reasonCode: 'enqueued',
      attemptCount: 0,
      availableAtMs: input.createdAtMs,
      updatedAtMs: input.createdAtMs,
      revision: 1,
    };
    this.jobs.set(job.jobId, job);
    return { outcome: 'enqueued', job: { ...job }, staleDiscardedJobIds: [] };
  }

  async enqueueBatch(
    inputs: readonly EnqueueBackgroundWorkInput[],
  ): Promise<BackgroundWorkEnqueueResult[]> {
    return Promise.all(inputs.map(input => this.enqueue(input)));
  }

  async beginForeground(input: {
    logicalSessionId: string;
    leaseOwner: string;
    leaseId: string;
    nowMs: number;
    leaseDurationMs: number;
  }): Promise<void> {
    this.foreground.set(input.leaseId, {
      logicalSessionId: input.logicalSessionId,
      leaseOwner: input.leaseOwner,
      expiresAtMs: input.nowMs + input.leaseDurationMs,
    });
    await this.deferRunnableForSession({
      logicalSessionId: input.logicalSessionId,
      nowMs: input.nowMs,
      resumeFallbackAtMs: input.nowMs,
    });
  }

  async renewForeground(input: {
    leaseOwner: string;
    leaseIds: readonly string[];
    nowMs: number;
    leaseDurationMs: number;
  }): Promise<string[]> {
    const renewed: string[] = [];
    for (const leaseId of input.leaseIds) {
      const lease = this.foreground.get(leaseId);
      if (!lease || lease.leaseOwner !== input.leaseOwner) continue;
      lease.expiresAtMs = input.nowMs + input.leaseDurationMs;
      renewed.push(leaseId);
    }
    return renewed;
  }

  async endForeground(input: {
    logicalSessionId: string;
    leaseOwner: string;
    leaseId: string;
    nowMs: number;
  }): Promise<boolean> {
    const lease = this.foreground.get(input.leaseId);
    if (!lease || lease.logicalSessionId !== input.logicalSessionId
      || lease.leaseOwner !== input.leaseOwner) throw new Error('foreground conflict');
    this.foreground.delete(input.leaseId);
    return ![...this.foreground.values()].some(candidate => (
      candidate.logicalSessionId === input.logicalSessionId
      && candidate.expiresAtMs > input.nowMs
    ));
  }

  async deferRunnableForSession(input: {
    logicalSessionId: string;
    nowMs: number;
    resumeFallbackAtMs: number;
  }): Promise<StoredBackgroundWorkJob[]> {
    return this.transitionSession(
      input.logicalSessionId,
      ['queued', 'retry_wait'],
      'deferred',
      'foreground_active',
      input.nowMs,
      input.resumeFallbackAtMs,
    );
  }

  async resumeDeferredForSession(input: {
    logicalSessionId: string;
    nowMs: number;
  }): Promise<StoredBackgroundWorkJob[]> {
    return this.transitionSession(
      input.logicalSessionId,
      ['deferred'],
      'queued',
      'foreground_active',
      input.nowMs,
      input.nowMs,
    );
  }

  async claimNext(input: {
    leaseOwner: string;
    nowMs: number;
    leaseDurationMs: number;
    excludedLogicalSessionIds: readonly string[];
  }): Promise<ClaimedBackgroundWorkJob | null> {
    const excluded = new Set(input.excludedLogicalSessionIds);
    const runningSessions = new Set([...this.jobs.values()]
      .filter(job => job.state === 'running')
      .map(job => job.logicalSessionId));
    const candidate = [...this.jobs.values()]
      .filter(job => ['queued', 'deferred', 'retry_wait'].includes(job.state))
      .filter(job => job.availableAtMs <= input.nowMs)
      .filter(job => ![...this.foreground.values()].some(lease => (
        lease.logicalSessionId === job.logicalSessionId && lease.expiresAtMs > input.nowMs
      )))
      .filter(job => !excluded.has(job.logicalSessionId) && !runningSessions.has(job.logicalSessionId))
      .sort((left, right) => left.createdAtMs - right.createdAtMs || left.jobId.localeCompare(right.jobId))
      .at(0);
    if (!candidate) return null;
    const claimed: ClaimedBackgroundWorkJob = {
      ...candidate,
      state: 'running',
      reasonCode: 'started',
      leaseOwner: input.leaseOwner,
      leaseExpiresAtMs: input.nowMs + input.leaseDurationMs,
      updatedAtMs: input.nowMs,
      revision: candidate.revision + 1,
    };
    this.jobs.set(claimed.jobId, claimed);
    return { ...claimed };
  }

  async renewClaims(input: {
    leaseOwner: string;
    jobIds: readonly string[];
    nowMs: number;
    leaseDurationMs: number;
  }): Promise<string[]> {
    const renewed: string[] = [];
    for (const jobId of input.jobIds) {
      const current = this.jobs.get(jobId);
      if (!current || current.state !== 'running' || current.leaseOwner !== input.leaseOwner) continue;
      this.jobs.set(jobId, {
        ...current,
        leaseExpiresAtMs: input.nowMs + input.leaseDurationMs,
        updatedAtMs: input.nowMs,
      });
      renewed.push(jobId);
    }
    return renewed;
  }

  async assertClaimOwned(input: {
    jobId: string;
    leaseOwner: string;
    expectedRevision: number;
    nowMs: number;
  }): Promise<boolean> {
    const current = this.jobs.get(input.jobId);
    return current?.state === 'running'
      && current.leaseOwner === input.leaseOwner
      && current.revision === input.expectedRevision
      && (current.leaseExpiresAtMs ?? 0) > input.nowMs
      && ![...this.foreground.values()].some(lease => (
        lease.logicalSessionId === current.logicalSessionId && lease.expiresAtMs > input.nowMs
      ));
  }

  async beginEffect(input: {
    jobId: string;
    effectKey: string;
    leaseOwner: string;
    expectedRevision: number;
    nowMs: number;
  }): Promise<'execute' | 'applied' | 'outcome_unknown'> {
    if (!await this.assertClaimOwned(input)) throw new Error('effect lease lost');
    const key = `${input.jobId}:${input.effectKey}`;
    const receipt = this.effects.get(key);
    if (!receipt) {
      this.effects.set(key, {
        state: 'started',
        leaseOwner: input.leaseOwner,
        revision: input.expectedRevision,
      });
      return 'execute';
    }
    if (receipt.state === 'applied') return 'applied';
    return receipt.leaseOwner === input.leaseOwner && receipt.revision === input.expectedRevision
      ? 'execute'
      : 'outcome_unknown';
  }

  async completeEffect(input: {
    jobId: string;
    effectKey: string;
    leaseOwner: string;
    expectedRevision: number;
    nowMs: number;
  }): Promise<void> {
    if (!await this.assertClaimOwned(input)) throw new Error('effect completion conflict');
    const receipt = this.effects.get(`${input.jobId}:${input.effectKey}`);
    if (!receipt || receipt.leaseOwner !== input.leaseOwner
      || receipt.revision !== input.expectedRevision) throw new Error('effect receipt conflict');
    receipt.state = 'applied';
  }

  async abandonEffect(input: {
    jobId: string;
    effectKey: string;
    leaseOwner: string;
    expectedRevision: number;
    nowMs: number;
  }): Promise<void> {
    if (await this.assertClaimOwned(input)) {
      this.effects.delete(`${input.jobId}:${input.effectKey}`);
    }
  }

  async complete(input: {
    jobId: string;
    leaseOwner: string;
    expectedRevision: number;
    nowMs: number;
  }): Promise<StoredBackgroundWorkJob> {
    return this.transitionClaim(input, 'succeeded', 'completed');
  }

  async defer(input: {
    jobId: string;
    leaseOwner: string;
    expectedRevision: number;
    reasonCode: BackgroundWorkReasonCode;
    availableAtMs: number;
    nowMs: number;
  }): Promise<StoredBackgroundWorkJob> {
    return this.transitionClaim(input, 'deferred', input.reasonCode, input.availableAtMs);
  }

  async failOrRetry(input: {
    jobId: string;
    leaseOwner: string;
    expectedRevision: number;
    nowMs: number;
    retryAtMs: number;
  }): Promise<StoredBackgroundWorkJob> {
    const current = this.requireClaim(input);
    const attemptCount = current.attemptCount + 1;
    const terminal = attemptCount >= current.maxAttempts;
    const next: StoredBackgroundWorkJob = {
      ...current,
      state: terminal ? 'failed' : 'retry_wait',
      reasonCode: terminal ? 'retry_exhausted' : 'retry_scheduled',
      attemptCount,
      availableAtMs: input.retryAtMs,
      updatedAtMs: input.nowMs,
      ...(terminal ? { completedAtMs: input.nowMs } : {}),
      revision: current.revision + 1,
    };
    delete next.leaseOwner;
    delete next.leaseExpiresAtMs;
    delete next.deferredFromState;
    this.jobs.set(next.jobId, next);
    return { ...next };
  }

  async markClaimMalformed(input: {
    jobId: string;
    leaseOwner: string;
    expectedRevision: number;
    reasonCode: 'malformed_payload' | 'unknown_kind';
    nowMs: number;
  }): Promise<StoredBackgroundWorkJob> {
    return this.transitionClaim(input, 'failed', input.reasonCode);
  }

  async markClaimFailed(input: {
    jobId: string;
    leaseOwner: string;
    expectedRevision: number;
    reasonCode: 'source_missing' | 'source_mismatch' | 'effect_outcome_unknown';
    nowMs: number;
  }): Promise<StoredBackgroundWorkJob> {
    return this.transitionClaim(input, 'failed', input.reasonCode);
  }

  async markClaimStale(input: {
    jobId: string;
    leaseOwner: string;
    expectedRevision: number;
    reasonCode: 'source_missing' | 'source_mismatch' | 'superseded';
    nowMs: number;
  }): Promise<StoredBackgroundWorkJob> {
    return this.transitionClaim(input, 'stale_discarded', input.reasonCode);
  }

  async releaseClaims(input: {
    leaseOwner: string;
    nowMs: number;
    reasonCode: 'shutdown';
  }): Promise<number> {
    let count = 0;
    for (const job of [...this.jobs.values()]) {
      if (job.state !== 'running' || job.leaseOwner !== input.leaseOwner) continue;
      const next = { ...job, state: 'deferred' as const, reasonCode: input.reasonCode, revision: job.revision + 1 };
      delete next.leaseOwner;
      delete next.leaseExpiresAtMs;
      this.jobs.set(job.jobId, next);
      count += 1;
    }
    return count;
  }

  async recoverExpired(): Promise<number> { return 0; }
  async purgeTerminal(): Promise<number> { return 0; }
  async countRunnable(input: { nowMs: number }): Promise<number> {
    return [...this.jobs.values()].filter(job => (
      ['queued', 'deferred', 'retry_wait'].includes(job.state) && job.availableAtMs <= input.nowMs
    )).length;
  }
  async get(jobId: string): Promise<StoredBackgroundWorkJob | null> {
    const job = this.jobs.get(jobId);
    return job ? { ...job } : null;
  }
  async close(): Promise<void> {}

  corrupt(jobId: string, patch: Partial<StoredBackgroundWorkJob>): void {
    const current = this.jobs.get(jobId);
    if (!current) throw new Error(`missing fake job ${jobId}`);
    this.jobs.set(jobId, { ...current, ...patch });
  }

  private transitionSession(
    logicalSessionId: string,
    expectedStates: StoredBackgroundWorkJob['state'][],
    state: StoredBackgroundWorkJob['state'],
    reasonCode: BackgroundWorkReasonCode,
    nowMs: number,
    availableAtMs?: number,
  ): StoredBackgroundWorkJob[] {
    const changed: StoredBackgroundWorkJob[] = [];
    for (const current of [...this.jobs.values()]) {
      if (current.logicalSessionId !== logicalSessionId || !expectedStates.includes(current.state)) continue;
      const restoredState = state === 'queued' && current.deferredFromState
        ? current.deferredFromState
        : state;
      const next = {
        ...current,
        state: restoredState,
        reasonCode,
        updatedAtMs: nowMs,
        ...(state === 'deferred'
          ? { deferredFromState: current.state === 'retry_wait' ? 'retry_wait' as const : 'queued' as const }
          : {}),
        ...(availableAtMs !== undefined && reasonCode !== 'foreground_active'
          ? { availableAtMs }
          : {}),
        revision: current.revision + 1,
      };
      if (state !== 'deferred') delete next.deferredFromState;
      this.jobs.set(next.jobId, next);
      changed.push({ ...next });
    }
    return changed;
  }

  private requireClaim(input: {
    jobId: string;
    leaseOwner: string;
    expectedRevision: number;
  }): StoredBackgroundWorkJob {
    const current = this.jobs.get(input.jobId);
    if (!current || current.state !== 'running' || current.leaseOwner !== input.leaseOwner
      || current.revision !== input.expectedRevision) {
      throw new Error('claim conflict');
    }
    return current;
  }

  private transitionClaim(
    input: { jobId: string; leaseOwner: string; expectedRevision: number; nowMs: number },
    state: StoredBackgroundWorkJob['state'],
    reasonCode: BackgroundWorkReasonCode,
    availableAtMs?: number,
  ): StoredBackgroundWorkJob {
    const current = this.requireClaim(input);
    const next: StoredBackgroundWorkJob = {
      ...current,
      state,
      reasonCode,
      availableAtMs: availableAtMs ?? current.availableAtMs,
      updatedAtMs: input.nowMs,
      ...(['succeeded', 'failed', 'stale_discarded'].includes(state)
        ? { completedAtMs: input.nowMs }
        : {}),
      revision: current.revision + 1,
      ...(state === 'deferred' ? { deferredFromState: 'queued' as const } : {}),
    };
    delete next.leaseOwner;
    delete next.leaseExpiresAtMs;
    if (state !== 'deferred') delete next.deferredFromState;
    this.jobs.set(next.jobId, next);
    return { ...next };
  }
}

async function flush(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

describe('BackgroundWorkSupervisor', () => {
  it('runs different sessions concurrently while preserving one active job per session', async () => {
    const store = new MemoryBackgroundWorkStore();
    const slow = deferred();
    const started: string[] = [];
    const supervisor = new BackgroundWorkSupervisor({
      store,
      eventBus: new EventBus(),
      now: () => 1_000,
      maxConcurrentSessions: 2,
      executor: async ({ job }) => {
        started.push(job.logicalSessionId);
        if (job.logicalSessionId === 'session-a') await slow.promise;
      },
    });
    await supervisor.enqueue([makeInput('session-a', 'turn-a')]);
    await supervisor.enqueue([makeInput('session-b', 'turn-b')]);

    await supervisor.tick();
    await flush();

    expect(started).toEqual(expect.arrayContaining(['session-a', 'session-b']));
    expect((await store.get(makeInput('session-b', 'turn-b').jobId))?.state).toBe('succeeded');
    expect((await store.get(makeInput('session-a', 'turn-a').jobId))?.state).toBe('running');
    slow.resolve();
    await supervisor.waitForIdle();
    expect((await store.get(makeInput('session-a', 'turn-a').jobId))?.state).toBe('succeeded');
  });

  it('durably defers unstarted same-session work during foreground activity and resumes it', async () => {
    const store = new MemoryBackgroundWorkStore();
    const executor = vi.fn(async () => undefined);
    const supervisor = new BackgroundWorkSupervisor({
      store,
      eventBus: new EventBus(),
      now: () => 1_000,
      executor,
    });
    const input = makeInput('session-a', 'turn-a');
    await supervisor.enqueue([input]);

    const lease = supervisor.beginForeground('session-a');
    await lease.ready;
    await supervisor.waitForSessionTransitions();
    await supervisor.tick();
    expect(executor).not.toHaveBeenCalled();
    expect((await store.get(input.jobId))?.state).toBe('deferred');

    await supervisor.endForeground(lease);
    await supervisor.waitForSessionTransitions();
    await supervisor.tick();
    await supervisor.waitForIdle();
    expect(executor).toHaveBeenCalledTimes(1);
    expect((await store.get(input.jobId))?.state).toBe('succeeded');
  });

  it('retries failures with bounded attempts and never hides the terminal state', async () => {
    let now = 1_000;
    const store = new MemoryBackgroundWorkStore();
    const executor = vi.fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue(undefined);
    const supervisor = new BackgroundWorkSupervisor({
      store,
      eventBus: new EventBus(),
      now: () => now,
      retryBaseDelayMs: 100,
      executor,
    });
    const input = makeInput('session-a', 'turn-a');
    await supervisor.enqueue([input]);

    await supervisor.tick();
    await supervisor.waitForIdle();
    expect((await store.get(input.jobId))?.state).toBe('retry_wait');
    now += 100;
    await supervisor.tick();
    await supervisor.waitForIdle();
    expect((await store.get(input.jobId))?.state).toBe('succeeded');
    expect(executor).toHaveBeenCalledTimes(2);
  });

  it('does not release a claim while its handler can still write during bounded shutdown', async () => {
    const store = new MemoryBackgroundWorkStore();
    const blocked = deferred();
    const supervisor = new BackgroundWorkSupervisor({
      store,
      eventBus: new EventBus(),
      now: () => 1_000,
      shutdownTimeoutMs: 0,
      executor: async () => blocked.promise,
    });
    const input = makeInput('session-a', 'turn-a');
    await supervisor.enqueue([input]);
    await supervisor.tick();
    await flush();

    await supervisor.stop();
    expect((await store.get(input.jobId))?.state).toBe('running');
    blocked.resolve();
    await supervisor.waitForIdle();
    expect((await store.get(input.jobId))?.state).toBe('succeeded');
  });

  it('fails malformed persisted payloads closed without invoking a handler', async () => {
    const store = new MemoryBackgroundWorkStore();
    const executor = vi.fn(async () => undefined);
    const supervisor = new BackgroundWorkSupervisor({
      store,
      eventBus: new EventBus(),
      now: () => 1_000,
      executor,
    });
    const input = makeInput('session-a', 'turn-a');
    await supervisor.enqueue([input]);
    store.corrupt(input.jobId, { payload: { schemaVersion: 1, kind: input.kind } });

    await supervisor.tick();
    await supervisor.waitForIdle();

    expect(executor).not.toHaveBeenCalled();
    expect(await store.get(input.jobId)).toMatchObject({
      state: 'failed',
      reasonCode: 'malformed_payload',
    });
  });

  it('recomputes claim-time fingerprints and rejects valid payloads rebound to another session', async () => {
    const store = new MemoryBackgroundWorkStore();
    const executor = vi.fn(async () => undefined);
    const supervisor = new BackgroundWorkSupervisor({
      store,
      eventBus: new EventBus(),
      now: () => 1_000,
      executor,
    });
    const input = makeInput('session-a', 'turn-a');
    await supervisor.enqueue([input]);
    const reboundPayload: MemoryExtractionBackgroundPayload = {
      ...input.payload as MemoryExtractionBackgroundPayload,
      source: {
        ...(input.payload as MemoryExtractionBackgroundPayload).source,
        logicalSessionId: 'session-b',
      },
    };
    store.corrupt(input.jobId, {
      payload: reboundPayload,
      payloadFingerprint: fingerprintBackgroundWorkPayload(reboundPayload),
    });

    await supervisor.tick();
    await supervisor.waitForIdle();

    expect(executor).not.toHaveBeenCalled();
    expect(await store.get(input.jobId)).toMatchObject({
      state: 'failed',
      reasonCode: 'malformed_payload',
    });
  });

  it('records a permanent source failure as failed, never stale-discarded', async () => {
    const store = new MemoryBackgroundWorkStore();
    const supervisor = new BackgroundWorkSupervisor({
      store,
      eventBus: new EventBus(),
      now: () => 1_000,
      executor: async () => {
        throw new BackgroundWorkPermanentError('source_missing');
      },
    });
    const input = makeInput('session-a', 'turn-a');
    await supervisor.enqueue([input]);

    await supervisor.tick();
    await supervisor.waitForIdle();

    expect(await store.get(input.jobId)).toMatchObject({
      state: 'failed',
      reasonCode: 'source_missing',
    });
  });

  it('emits content-free lifecycle telemetry with queue, attempt, age, duration, and a session hash', async () => {
    let now = 1_000;
    const store = new MemoryBackgroundWorkStore();
    const eventBus = new EventBus();
    const events: Array<Record<string, unknown>> = [];
    eventBus.on('agent.turn.performance', event => { events.push(event); });
    const supervisor = new BackgroundWorkSupervisor({
      store,
      eventBus,
      now: () => now,
      executor: async () => { now = 1_025; },
    });
    const input = makeInput('private-session-name', 'turn-a');
    await supervisor.enqueue([input]);
    await supervisor.tick();
    await supervisor.waitForIdle();
    await flush();

    const completed = events.find(event => event.backgroundJobState === 'succeeded');
    expect(completed).toMatchObject({
      backgroundJobKind: 'memory_extraction',
      backgroundJobReason: 'completed',
      backgroundJobAttemptCount: 0,
      backgroundJobAgeMs: 925,
      durationMs: 25,
      queueDepth: 0,
    });
    expect(completed?.backgroundSessionIdHash).toMatch(/^[a-f0-9]{64}$/);
    expect(completed?.backgroundSessionIdHash).not.toBe('private-session-name');
    expect(JSON.stringify(events)).not.toContain('turnRecordFingerprint');
    expect(JSON.stringify(events)).not.toContain('payload');
  });
});
