import { describe, expect, it, vi } from 'vitest';

import { EventBus } from '../../../shared/event-bus.js';
import { buildSubsystemOutputRef } from '../../../shared/contracts/subsystem-output-refs.js';
import {
  runIntentionPostTurnHooks,
  type IntentionPostTurnHookContext,
} from '../substrate-agent/post-turn-actions.js';
import type {
  BackgroundWorkClaimFence,
  BackgroundWorkEnqueueResult,
  BackgroundWorkJobEnqueueResult,
  BackgroundWorkStorePort,
} from './store-port.js';
import {
  BackgroundWorkDeferredError,
  BackgroundWorkPermanentError,
  BackgroundWorkSupervisor,
  type BackgroundWorkSupervisorOptions,
} from './supervisor.js';
import type { BackgroundWorkSupervisorTuning } from './config.js';
import type {
  BackgroundWorkHandoffRecoveryInput,
  BackgroundWorkReasonCode,
  ClaimedBackgroundWorkJob,
  EnqueueBackgroundWorkInput,
  StoredBackgroundWorkJob,
} from './types.js';
import {
  createBackgroundWorkIdentity,
  fingerprintBackgroundWorkPayload,
  type AutoCompactionBackgroundPayload,
  type MemoryExtractionBackgroundPayload,
} from './types.js';

const TEST_BACKGROUND_WORK_SUPERVISOR_TUNING: BackgroundWorkSupervisorTuning = {
  maxConcurrentSessions: 4,
  leaseDurationMs: 300_000,
  retryBaseDelayMs: 1_000,
  retryMaxDelayMs: 300_000,
  shutdownTimeoutMs: 5_000,
  terminalRetentionMs: 604_800_000,
  cleanupIntervalMs: 3_600_000,
};

const TEST_BACKGROUND_WORK_WELFARE_POLICY: BackgroundWorkSupervisorOptions['welfare'] = {
  deferThreshold: 8,
  ageThresholdMs: 300_000,
  reserveSlots: 1,
};

type TestBackgroundWorkSupervisorOptions =
  Omit<BackgroundWorkSupervisorOptions, keyof BackgroundWorkSupervisorTuning | 'welfare'>
  & Partial<BackgroundWorkSupervisorTuning>
  & { welfare?: BackgroundWorkSupervisorOptions['welfare'] };

function createBackgroundWorkSupervisor(
  options: TestBackgroundWorkSupervisorOptions,
): BackgroundWorkSupervisor {
  return new BackgroundWorkSupervisor({
    ...TEST_BACKGROUND_WORK_SUPERVISOR_TUNING,
    welfare: TEST_BACKGROUND_WORK_WELFARE_POLICY,
    ...options,
  });
}

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

function backgroundWorkKindPriority(kind: string): number {
  if (kind === 'intention_post_turn_hooks') return 0;
  if (kind === 'emotion_appraisal') return 1;
  if (kind === 'memory_extraction') return 2;
  return 3;
}

function makeCompactionInput(sessionId: string, turnId: string): EnqueueBackgroundWorkInput {
  const payload: AutoCompactionBackgroundPayload = {
    schemaVersion: 1,
    kind: 'auto_compaction',
    source: {
      schemaVersion: 1,
      logicalSessionId: sessionId,
      channelId: sessionId,
      turnId,
      requestId: `request-${turnId}`,
      turnRecordFingerprint: 'a'.repeat(64),
      createdAtMs: 100,
    },
    systemPromptTokenCount: 10,
    memoriesTokenCount: 5,
    adaptiveProfile: {
      enabled: false,
      source: 'disabled',
      category: 'default',
      sessionHistoryBudgetPct: 6,
      memoryRetrievalBudgetPct: 2,
    },
    turnBudgetCharacteristics: {},
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

function makeIntentionContext(): IntentionPostTurnHookContext {
  return {
    message: {
      id: 'intention-source-1',
      channelId: 'session-a',
      channelType: 'api',
      authorId: 'partner-1',
      authorName: 'Partner',
      content: 'hello',
      timestamp: new Date(100),
    },
    response: {
      content: 'hi',
      channelId: 'session-a',
      metadata: {
        model: 'test',
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 1,
      },
    },
    turnMessages: [],
    turnId: '019d2326-d9e1-701d-bcee-250d2cbb0e4e',
    completedAt: 100,
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
    state: 'pending' | 'started' | 'applied';
    leaseOwner: string;
    revision: number;
  }>();
  private subsystemOutputRefs = new Map<string, Set<string>>();
  private foregroundRenewalLoss = false;
  private requeueFailuresRemaining = 0;

  failNextRequeuePreBoundaryClaims(count = 1): void {
    this.requeueFailuresRemaining = count;
  }

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
      deferCount: 0,
      welfareClaimed: false,
    };
    this.jobs.set(job.jobId, job);
    return { outcome: 'enqueued', job: { ...job }, staleDiscardedJobIds: [] };
  }

  async enqueueBatch(
    inputs: readonly EnqueueBackgroundWorkInput[],
  ): Promise<BackgroundWorkEnqueueResult[]> {
    return Promise.all(inputs.map(input => this.enqueue(input)));
  }

  async recoverBatch(
    input: BackgroundWorkHandoffRecoveryInput,
  ): Promise<BackgroundWorkEnqueueResult[]> {
    return this.enqueueBatch(input.jobs);
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
  }

  async renewForeground(input: {
    leaseOwner: string;
    leaseIds: readonly string[];
    nowMs: number;
    leaseDurationMs: number;
  }): Promise<string[]> {
    if (this.foregroundRenewalLoss) {
      this.foregroundRenewalLoss = false;
      for (const leaseId of input.leaseIds) {
        const lease = this.foreground.get(leaseId);
        if (lease?.leaseOwner === input.leaseOwner) {
          lease.expiresAtMs = input.nowMs + input.leaseDurationMs;
        }
      }
      return [];
    }
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
    const eligible = [...this.jobs.values()]
      .filter(job => ['queued', 'deferred', 'retry_wait'].includes(job.state))
      .filter(job => job.availableAtMs <= input.nowMs)
      // Only the foreground-exclusive kind yields to an active turn lease
      // (hrmrq.119); all other kinds claim concurrently with foreground work.
      .filter(job => job.kind !== 'auto_compaction'
        || ![...this.foreground.values()].some(lease => (
          lease.logicalSessionId === job.logicalSessionId && lease.expiresAtMs > input.nowMs
        )))
      .filter(job => !excluded.has(job.logicalSessionId) && !runningSessions.has(job.logicalSessionId));
    const sessionCandidates = new Map<string, StoredBackgroundWorkJob>();
    for (const job of eligible) {
      const current = sessionCandidates.get(job.logicalSessionId);
      if (!current || (
        job.updatedAtMs - current.updatedAtMs
        || job.createdAtMs - current.createdAtMs
        || backgroundWorkKindPriority(job.kind) - backgroundWorkKindPriority(current.kind)
        || job.jobId.localeCompare(current.jobId)
      ) < 0) {
        sessionCandidates.set(job.logicalSessionId, job);
      }
    }
    const candidate = [...sessionCandidates.values()]
      .sort((left, right) => (
        left.createdAtMs - right.createdAtMs
        || backgroundWorkKindPriority(left.kind) - backgroundWorkKindPriority(right.kind)
        || left.jobId.localeCompare(right.jobId)
      ))
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
      && (current.leaseExpiresAtMs ?? 0) > input.nowMs;
  }

  async checkClaimFence(input: {
    jobId: string;
    leaseOwner: string;
    expectedRevision: number;
    nowMs: number;
  }): Promise<BackgroundWorkClaimFence> {
    const current = this.jobs.get(input.jobId);
    if (current?.state !== 'running'
      || current.leaseOwner !== input.leaseOwner
      || current.revision !== input.expectedRevision
      || (current.leaseExpiresAtMs ?? 0) <= input.nowMs) return 'lease_lost';
    return current.kind === 'auto_compaction' && [...this.foreground.values()].some(lease => (
      lease.logicalSessionId === current.logicalSessionId && lease.expiresAtMs > input.nowMs
    )) ? 'foreground_active' : 'owned';
  }

  async beginEffect(input: {
    jobId: string;
    effectKey: string;
    leaseOwner: string;
    expectedRevision: number;
    nowMs: number;
  }): Promise<'execute' | 'applied' | 'outcome_unknown' | 'foreground_active' | 'lease_lost'> {
    const fence = await this.checkClaimFence(input);
    if (fence !== 'owned') return fence;
    const key = `${input.jobId}:${input.effectKey}`;
    const receipt = this.effects.get(key);
    if (!receipt) {
      this.effects.set(key, {
        state: 'pending',
        leaseOwner: input.leaseOwner,
        revision: input.expectedRevision,
      });
      return 'execute';
    }
    const owned = receipt.leaseOwner === input.leaseOwner && receipt.revision === input.expectedRevision;
    if (receipt.state === 'applied') return 'applied';
    if (receipt.state === 'started') return owned ? 'execute' : 'outcome_unknown';
    if (owned) return 'execute';
    // Stale pending receipt from an expired lease is re-taken (still pre-boundary).
    this.effects.set(key, {
      state: 'pending',
      leaseOwner: input.leaseOwner,
      revision: input.expectedRevision,
    });
    return 'execute';
  }

  async commitEffectBoundary(input: {
    jobId: string;
    effectKey: string;
    leaseOwner: string;
    expectedRevision: number;
    nowMs: number;
  }): Promise<'crossed' | 'applied' | 'foreground_active' | 'lease_lost'> {
    const fence = await this.checkClaimFence(input);
    if (fence === 'foreground_active') return 'foreground_active';
    if (fence !== 'owned') return 'lease_lost';
    const receipt = this.effects.get(`${input.jobId}:${input.effectKey}`);
    if (!receipt || receipt.leaseOwner !== input.leaseOwner
      || receipt.revision !== input.expectedRevision) return 'lease_lost';
    if (receipt.state === 'applied') return 'applied';
    receipt.state = 'started';
    return 'crossed';
  }

  async completeEffect(input: {
    jobId: string;
    effectKey: string;
    leaseOwner: string;
    expectedRevision: number;
    nowMs: number;
    outputRefs?: readonly string[];
  }): Promise<void> {
    if (!await this.assertClaimOwned(input)) throw new Error('effect completion conflict');
    const receipt = this.effects.get(`${input.jobId}:${input.effectKey}`);
    if (!receipt || receipt.leaseOwner !== input.leaseOwner
      || receipt.revision !== input.expectedRevision) throw new Error('effect receipt conflict');
    receipt.state = 'applied';
    const job = this.jobs.get(input.jobId)!;
    const key = [
      job.logicalSessionId,
      job.sourceChannelId,
      job.sourceTurnId,
      job.sourceRequestId,
    ].join('\u0000');
    const refs = this.subsystemOutputRefs.get(key) ?? new Set<string>();
    for (const ref of input.outputRefs ?? []) refs.add(ref);
    this.subsystemOutputRefs.set(key, refs);
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
    retryReasonCode?: 'handler_failed';
    terminalReasonCode?: 'handler_failed';
  }): Promise<StoredBackgroundWorkJob> {
    const current = this.requireClaim(input);
    const attemptCount = current.attemptCount + 1;
    const terminal = attemptCount >= current.maxAttempts;
    const next: StoredBackgroundWorkJob = {
      ...current,
      state: terminal ? 'failed' : 'retry_wait',
      reasonCode: terminal
        ? (input.terminalReasonCode ?? 'retry_exhausted')
        : (input.retryReasonCode ?? 'retry_scheduled'),
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
    reasonCode: 'source_not_ready' | 'source_missing' | 'source_mismatch' | 'effect_outcome_unknown';
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

  async requeuePreBoundaryClaims(input: {
    leaseOwner: string;
    nowMs: number;
    reasonCode: 'shutdown';
  }): Promise<StoredBackgroundWorkJob[]> {
    if (this.requeueFailuresRemaining > 0) {
      this.requeueFailuresRemaining -= 1;
      throw new Error('injected shutdown requeue failure');
    }
    const requeued: StoredBackgroundWorkJob[] = [];
    for (const job of [...this.jobs.values()]) {
      if (job.state !== 'running' || job.leaseOwner !== input.leaseOwner) continue;
      const crossed = [...this.effects.entries()].some(([key, receipt]) => (
        key.startsWith(`${job.jobId}:`) && (receipt.state === 'started' || receipt.state === 'applied')
      ));
      if (crossed) continue;
      for (const key of [...this.effects.keys()]) {
        if (key.startsWith(`${job.jobId}:`) && this.effects.get(key)?.state === 'pending') {
          this.effects.delete(key);
        }
      }
      const next: StoredBackgroundWorkJob = {
        ...job,
        state: 'queued',
        reasonCode: input.reasonCode,
        availableAtMs: input.nowMs,
        updatedAtMs: input.nowMs,
        revision: job.revision + 1,
      };
      delete next.leaseOwner;
      delete next.leaseExpiresAtMs;
      delete next.deferredFromState;
      delete next.deferredFromAvailableAtMs;
      this.jobs.set(job.jobId, next);
      requeued.push({ ...next });
    }
    return requeued;
  }

  async recoverExpired(): Promise<number> { return 0; }
  async purgeTerminal(): Promise<number> { return 0; }
  async countRunnable(input: { nowMs: number }): Promise<number> {
    return [...this.jobs.values()].filter(job => (
      ['queued', 'deferred', 'retry_wait'].includes(job.state) && job.availableAtMs <= input.nowMs
    )).length;
  }
  async countPending(): Promise<number> {
    return [...this.jobs.values()].filter(job => (
      ['queued', 'deferred', 'retry_wait', 'running'].includes(job.state)
    )).length;
  }
  async get(jobId: string): Promise<StoredBackgroundWorkJob | null> {
    const job = this.jobs.get(jobId);
    return job ? { ...job } : null;
  }

  async listSubsystemOutputRefs(input: {
    logicalSessionId: string;
    sourceChannelId: string;
    sourceTurnId: string;
    sourceRequestId: string;
  }): Promise<string[]> {
    const key = [
      input.logicalSessionId,
      input.sourceChannelId,
      input.sourceTurnId,
      input.sourceRequestId,
    ].join('\u0000');
    return [...(this.subsystemOutputRefs.get(key) ?? [])].sort();
  }
  async getSubsystemOutputProjection(input: {
    logicalSessionId: string;
    sourceChannelId: string;
    sourceTurnId: string;
    sourceRequestId: string;
  }) {
    const key = [
      input.logicalSessionId,
      input.sourceChannelId,
      input.sourceTurnId,
      input.sourceRequestId,
    ].join('\u0000');
    return {
      status: this.subsystemOutputRefs.has(key) ? 'applied' as const : 'pending' as const,
      outputRefs: [...(this.subsystemOutputRefs.get(key) ?? [])].sort(),
    };
  }
  async close(): Promise<void> {}

  corrupt(jobId: string, patch: Partial<StoredBackgroundWorkJob>): void {
    const current = this.jobs.get(jobId);
    if (!current) throw new Error(`missing fake job ${jobId}`);
    this.jobs.set(jobId, { ...current, ...patch });
  }

  forceForegroundRenewalLoss(): void {
    this.foregroundRenewalLoss = true;
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
  it('commits returned output refs once against the exact source-turn binding', async () => {
    const store = new MemoryBackgroundWorkStore();
    const memoryRef = buildSubsystemOutputRef('memory', 'memory-1');
    const contactRef = buildSubsystemOutputRef('contact', 'contact-1');
    const supervisor = createBackgroundWorkSupervisor({
      store,
      eventBus: new EventBus(),
      now: () => 1_000,
      executor: async ({ effects }) => {
        await effects.run('durable-sink', async (crossBoundary) => {
          await crossBoundary();
          return [contactRef, memoryRef, memoryRef];
        });
      },
    });
    const input = makeInput('session-a', 'turn-a');

    await supervisor.enqueue([input]);
    await supervisor.tick();
    await supervisor.waitForIdle();

    await expect(store.listSubsystemOutputRefs({
      logicalSessionId: input.logicalSessionId,
      sourceChannelId: input.sourceChannelId,
      sourceTurnId: input.sourceTurnId,
      sourceRequestId: input.sourceRequestId,
    })).resolves.toEqual([contactRef, memoryRef].sort());
    await expect(store.listSubsystemOutputRefs({
      logicalSessionId: input.logicalSessionId,
      sourceChannelId: input.sourceChannelId,
      sourceTurnId: input.sourceTurnId,
      sourceRequestId: 'wrong-request',
    })).resolves.toEqual([]);
  });

  it('runs different sessions concurrently while preserving one active job per session', async () => {
    const store = new MemoryBackgroundWorkStore();
    const slow = deferred();
    const started: string[] = [];
    const supervisor = createBackgroundWorkSupervisor({
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

  it('claims and completes queued autonomic work concurrently with an active foreground turn (hrmrq.119)', async () => {
    const store = new MemoryBackgroundWorkStore();
    const executor = vi.fn(async () => undefined);
    const supervisor = createBackgroundWorkSupervisor({
      store,
      eventBus: new EventBus(),
      now: () => 1_000,
      executor,
    });
    const input = makeInput('session-a', 'turn-a');
    const lease = supervisor.beginForeground('session-a');
    await lease.ready;
    await supervisor.enqueue([input]);

    // The turn is still active, yet the autonomic job runs to completion.
    await supervisor.tick();
    await supervisor.waitForIdle();
    expect(executor).toHaveBeenCalledTimes(1);
    expect((await store.get(input.jobId))?.state).toBe('succeeded');
    await supervisor.endForeground(lease);
  });

  it('holds queued auto_compaction untouched while a turn is active and claims it after release', async () => {
    const store = new MemoryBackgroundWorkStore();
    const executor = vi.fn(async () => undefined);
    const supervisor = createBackgroundWorkSupervisor({
      store,
      eventBus: new EventBus(),
      now: () => 1_000,
      executor,
    });
    const input = makeCompactionInput('session-a', 'turn-a');
    await supervisor.enqueue([input]);

    const lease = supervisor.beginForeground('session-a');
    await lease.ready;
    await supervisor.tick();
    expect(executor).not.toHaveBeenCalled();
    // The blocked job is merely not claimed — its row is never rewritten.
    expect(await store.get(input.jobId)).toMatchObject({ state: 'queued', revision: 1 });

    await supervisor.endForeground(lease);
    await supervisor.tick();
    await supervisor.waitForIdle();
    expect(executor).toHaveBeenCalledTimes(1);
    expect((await store.get(input.jobId))?.state).toBe('succeeded');
  });

  it('keeps the turn path free of job-row work regardless of queued depth (hrmrq.119)', async () => {
    const store = new MemoryBackgroundWorkStore();
    const inputs = Array.from({ length: 40 }, (_, index) => makeInput('session-a', `turn-${String(index)}`));
    for (const input of inputs) await store.enqueue(input);
    const beginSpy = vi.spyOn(store, 'beginForeground');
    const endSpy = vi.spyOn(store, 'endForeground');
    const supervisor = createBackgroundWorkSupervisor({
      store,
      eventBus: new EventBus(),
      now: () => 1_000,
      executor: async () => undefined,
    });

    const lease = supervisor.beginForeground('session-a');
    await lease.ready;
    await supervisor.endForeground(lease);

    // One lease insert and one lease delete — independent of the 40 queued jobs,
    // every one of which is left byte-for-byte untouched.
    expect(beginSpy).toHaveBeenCalledTimes(1);
    expect(endSpy).toHaveBeenCalledTimes(1);
    for (const input of inputs) {
      expect(await store.get(input.jobId)).toMatchObject({
        state: 'queued',
        reasonCode: 'enqueued',
        revision: 1,
        deferCount: 0,
      });
    }
  });

  it('claims accepted work immediately on enqueue without waiting for a scheduler tick (hwars.3)', async () => {
    const store = new MemoryBackgroundWorkStore();
    const executor = vi.fn(async () => undefined);
    const supervisor = createBackgroundWorkSupervisor({
      store,
      eventBus: new EventBus(),
      now: () => 1_000,
      executor,
    });
    const input = makeInput('session-a', 'turn-a');

    // No tick() anywhere: the enqueue itself must pump the claim pass.
    await supervisor.enqueue([input]);
    for (let i = 0; i < 10 && (await store.get(input.jobId))?.state !== 'succeeded'; i += 1) {
      await flush();
    }
    expect(executor).toHaveBeenCalledTimes(1);
    expect((await store.get(input.jobId))?.state).toBe('succeeded');
  });

  it('drains a deep single-session backlog continuously via settlement-chained claim passes', async () => {
    const store = new MemoryBackgroundWorkStore();
    const supervisor = createBackgroundWorkSupervisor({
      store,
      eventBus: new EventBus(),
      now: () => 1_000,
      executor: async () => undefined,
    });
    // Seeded directly on the store — pre-existing rows, no enqueue kick.
    const inputs = Array.from({ length: 5 }, (_, index) => makeInput('session-a', `turn-${String(index)}`));
    for (const input of inputs) await store.enqueue(input);

    // One running job per session means a single pass claims exactly one job;
    // ONE explicit tick must still drain all five through settlement chaining.
    await supervisor.tick();
    for (let i = 0; i < 40 && (await store.countPending()) > 0; i += 1) {
      await flush();
    }
    for (const input of inputs) {
      expect((await store.get(input.jobId))?.state).toBe('succeeded');
    }
  });

  it('rotates a just-deferred job behind untouched same-session work', async () => {
    const store = new MemoryBackgroundWorkStore();
    const inputs = [makeInput('session-a', 'turn-a'), makeInput('session-a', 'turn-b')];
    for (const input of inputs) await store.enqueue(input);
    const first = await store.claimNext({
      leaseOwner: 'worker-a',
      nowMs: 100,
      leaseDurationMs: 1_000,
      excludedLogicalSessionIds: [],
    });
    expect(first).not.toBeNull();
    const untouchedJobId = inputs.find(input => input.jobId !== first!.jobId)!.jobId;
    await store.defer({
      jobId: first!.jobId,
      leaseOwner: first!.leaseOwner,
      expectedRevision: first!.revision,
      reasonCode: 'source_not_ready',
      nowMs: 150,
      availableAtMs: 200,
    });

    const next = await store.claimNext({
      leaseOwner: 'worker-a',
      nowMs: 200,
      leaseDurationMs: 1_000,
      excludedLogicalSessionIds: [],
    });
    expect(next?.jobId).toBe(untouchedJobId);
  });

  it('makes steady autonomic progress in every turn window, including for jobs enqueued before the conversation', async () => {
    let now = 1_000;
    const store = new MemoryBackgroundWorkStore();
    const supervisor = createBackgroundWorkSupervisor({
      store,
      eventBus: new EventBus(),
      now: () => now,
      executor: async () => undefined,
    });
    // Pre-existing backlog: seeded on the store before any turn happens.
    const backlog = Array.from({ length: 5 }, (_, index) => makeInput('session-a', `turn-b${String(index)}`));
    for (const input of backlog) await store.enqueue(input);
    const allJobIds: string[] = backlog.map(input => input.jobId);
    const countSucceeded = async (): Promise<number> => {
      const jobs = await Promise.all(allJobIds.map(jobId => store.get(jobId)));
      return jobs.filter(job => job?.state === 'succeeded').length;
    };

    // Ten back-to-back turns with no idle gap: progress must be visible in
    // EVERY turn window and the pre-conversation backlog must complete during
    // the conversation, not after it ends. Slow is fine; stoppage is the
    // violation class.
    let succeededBefore = 0;
    for (let turn = 0; turn < 10; turn += 1) {
      const lease = supervisor.beginForeground('session-a');
      await lease.ready;
      const input = makeInput('session-a', `turn-${String(turn)}`);
      allJobIds.push(input.jobId);
      await supervisor.enqueue([input]);
      await supervisor.tick();
      await supervisor.waitForIdle();
      for (let i = 0; i < 40 && (await store.countPending()) > 0; i += 1) {
        await flush();
      }
      const succeeded = await countSucceeded();
      expect(succeeded).toBeGreaterThan(succeededBefore);
      succeededBefore = succeeded;
      await supervisor.endForeground(lease);
      now += 1_000;
    }
    expect(await countSucceeded()).toBe(allJobIds.length);
  });

  it('defers a claimed auto_compaction when foreground begins before its effect boundary, then resumes once', async () => {
    let now = 1_000;
    const store = new MemoryBackgroundWorkStore();
    const claimEnteredExecutor = deferred();
    const continueToEffect = deferred();
    const effect = vi.fn(async () => undefined);
    const supervisor = createBackgroundWorkSupervisor({
      store,
      eventBus: new EventBus(),
      now: () => now,
      executor: async ({ effects }) => {
        claimEnteredExecutor.resolve();
        await continueToEffect.promise;
        await effects.run('durable-sink', async () => effect());
      },
    });
    const input = makeCompactionInput('session-a', 'turn-a');
    await supervisor.enqueue([input]);

    await supervisor.tick();
    await claimEnteredExecutor.promise;
    const foreground = supervisor.beginForeground(input.logicalSessionId);
    await foreground.ready;
    continueToEffect.resolve();
    await supervisor.waitForIdle();

    expect(effect).not.toHaveBeenCalled();
    expect(await store.get(input.jobId)).toMatchObject({
      idempotencyKey: input.idempotencyKey,
      state: 'deferred',
      reasonCode: 'foreground_active',
    });

    await supervisor.endForeground(foreground);
    now = 2_000;
    await supervisor.tick();
    await supervisor.waitForIdle();
    expect(effect).toHaveBeenCalledTimes(1);
    expect(await store.get(input.jobId)).toMatchObject({
      idempotencyKey: input.idempotencyKey,
      state: 'succeeded',
    });
  });

  it('defers without consuming an attempt and resumes exactly once when a pre-boundary model call is preempted (mmo9.5.1)', async () => {
    let now = 1_000;
    const store = new MemoryBackgroundWorkStore();
    let attempts = 0;
    let writes = 0;
    const supervisor = createBackgroundWorkSupervisor({
      store,
      eventBus: new EventBus(),
      now: () => now,
      executor: async ({ effects }) => {
        attempts += 1;
        await effects.run('durable-sink', async (crossBoundary) => {
          if (attempts === 1) {
            // The pre-commitEffectBoundary model call was preempted for a
            // foreground acquire; the handler maps it to a defer. The boundary
            // is never crossed, so the pending receipt is abandoned and the job
            // requeues cleanly with no durable write.
            throw new BackgroundWorkDeferredError('foreground_active', 1_000);
          }
          await crossBoundary();
          writes += 1;
        });
      },
    });
    const input = makeInput('session-a', 'turn-a');
    await supervisor.enqueue([input]);

    await supervisor.tick();
    await supervisor.waitForIdle();

    expect(writes).toBe(0);
    expect(await store.get(input.jobId)).toMatchObject({
      state: 'deferred',
      reasonCode: 'foreground_active',
      attemptCount: 0,
    });

    now = 2_000;
    await supervisor.tick();
    await supervisor.waitForIdle();

    // The job resumes from a fresh pending receipt and writes exactly once — no
    // duplicate, and the preemption never counted as a failed attempt.
    expect(writes).toBe(1);
    expect(await store.get(input.jobId)).toMatchObject({
      state: 'succeeded',
      attemptCount: 0,
    });
  });

  it('fails closed via outcome_unknown when a preemption defer arrives AFTER the effect boundary (mmo9.5.1)', async () => {
    let now = 1_000;
    const store = new MemoryBackgroundWorkStore();
    let attempts = 0;
    let writes = 0;
    const supervisor = createBackgroundWorkSupervisor({
      store,
      eventBus: new EventBus(),
      now: () => now,
      executor: async ({ effects }) => {
        attempts += 1;
        await effects.run('durable-sink', async (crossBoundary) => {
          await crossBoundary();
          writes += 1;
          if (attempts === 1) {
            // Defense in depth: a preemption defer arriving AFTER the durable
            // write must NOT trigger a clean requeue-and-replay. The started
            // receipt fences the retry to outcome_unknown.
            throw new BackgroundWorkDeferredError('foreground_active', 1_000);
          }
        });
      },
    });
    const input = makeInput('session-a', 'turn-a');
    await supervisor.enqueue([input]);

    await supervisor.tick();
    await supervisor.waitForIdle();

    expect(writes).toBe(1);
    expect(await store.get(input.jobId)).toMatchObject({
      state: 'deferred',
      reasonCode: 'foreground_active',
    });

    now = 2_000;
    await supervisor.tick();
    await supervisor.waitForIdle();

    // The re-claim observes a `started` receipt it does not own -> outcome_unknown
    // -> fail closed. The durable write is never replayed.
    expect(writes).toBe(1);
    expect(await store.get(input.jobId)).toMatchObject({
      state: 'failed',
      reasonCode: 'effect_outcome_unknown',
    });
  });

  it('stops renewing a locally lost foreground lease after one quarantine window', async () => {
    vi.useFakeTimers();
    let now = 1_000;
    const store = new MemoryBackgroundWorkStore();
    const first = createBackgroundWorkSupervisor({
      store,
      eventBus: new EventBus(),
      leaseOwner: 'foreground-replica',
      leaseDurationMs: 30,
      now: () => now,
      executor: async () => undefined,
    });
    const effect = vi.fn(async () => undefined);
    const second = createBackgroundWorkSupervisor({
      store,
      eventBus: new EventBus(),
      leaseOwner: 'background-replica',
      leaseDurationMs: 30,
      now: () => now,
      executor: async ({ effects }) => {
        await effects.run('durable-sink', async () => effect());
      },
    });
    const foreground = first.beginForeground('session-a');
    try {
      await foreground.ready;
      store.forceForegroundRenewalLoss();
      now = 1_031;
      await expect(first.tick()).rejects.toThrow('Foreground work lease ownership was lost');
      expect(foreground.signal.aborted).toBe(true);

      const input = makeCompactionInput('session-a', 'turn-a');
      await second.enqueue([input]);
      await second.tick();
      await second.waitForIdle();
      expect(effect).not.toHaveBeenCalled();

      // Two later heartbeats must not renew the locally lost lease. A foreground
      // operation may ignore its abort signal, but another replica still recovers
      // after exactly the one durable quarantine window created above.
      now = 1_041;
      await first.tick();
      now = 1_051;
      await first.tick();
      now = 1_062;
      await second.tick();
      await second.waitForIdle();
      expect(effect).toHaveBeenCalledTimes(1);

      await first.endForeground(foreground);
      await first.endForeground(foreground);
      await second.tick();
      await second.waitForIdle();
      expect(effect).toHaveBeenCalledTimes(1);
    } finally {
      await Promise.allSettled([first.stop(), second.stop()]);
      vi.useRealTimers();
    }
  });

  it('commits an effect receipt once when foreground arrives after the effect boundary', async () => {
    const store = new MemoryBackgroundWorkStore();
    const effectStarted = deferred();
    const completeEffect = deferred();
    const effect = vi.fn(async () => {
      effectStarted.resolve();
      await completeEffect.promise;
    });
    const supervisor = createBackgroundWorkSupervisor({
      store,
      eventBus: new EventBus(),
      now: () => 1_000,
      executor: async ({ effects }) => {
        await effects.run('durable-sink', async () => effect());
      },
    });
    const input = makeCompactionInput('session-a', 'turn-a');
    await supervisor.enqueue([input]);
    await supervisor.tick();
    await effectStarted.promise;

    const foreground = supervisor.beginForeground(input.logicalSessionId);
    await foreground.ready;
    completeEffect.resolve();
    await supervisor.waitForIdle();

    expect(effect).toHaveBeenCalledTimes(1);
    expect(await store.get(input.jobId)).toMatchObject({ state: 'succeeded' });
    await supervisor.endForeground(foreground);
  });

  it('retries failures with bounded attempts and never hides the terminal state', async () => {
    let now = 1_000;
    const store = new MemoryBackgroundWorkStore();
    const executor = vi.fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue(undefined);
    const supervisor = createBackgroundWorkSupervisor({
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

  it('notifies the owner only after an ordinary failure exhausts its retry budget', async () => {
    let now = 1_000;
    const store = new MemoryBackgroundWorkStore();
    const onTerminalFailure = vi.fn();
    const supervisor = createBackgroundWorkSupervisor({
      store,
      eventBus: new EventBus(),
      now: () => now,
      retryBaseDelayMs: 100,
      onTerminalFailure,
      executor: vi.fn().mockRejectedValue(new Error('appraisal provider unavailable')),
    });
    const input = { ...makeInput('session-a', 'turn-terminal-appraisal'), maxAttempts: 2 };
    await store.enqueue(input);

    await supervisor.tick();
    await supervisor.waitForIdle();
    expect(await store.get(input.jobId)).toMatchObject({ state: 'retry_wait' });
    expect(onTerminalFailure).not.toHaveBeenCalled();

    now += 100;
    await supervisor.tick();
    await supervisor.waitForIdle();
    expect(await store.get(input.jobId)).toMatchObject({
      state: 'failed',
      reasonCode: 'retry_exhausted',
      attemptCount: 2,
    });
    expect(onTerminalFailure).toHaveBeenCalledOnce();
    expect(onTerminalFailure).toHaveBeenCalledWith(expect.objectContaining({
      jobId: input.jobId,
      reasonCode: 'retry_exhausted',
      payload: input.payload,
    }));
  });

  it('abandons a pre-write intention receipt and retries the hook once', async () => {
    let now = 1_000;
    let hookAttempts = 0;
    let sinkWrites = 0;
    const store = new MemoryBackgroundWorkStore();
    const supervisor = createBackgroundWorkSupervisor({
      store,
      eventBus: new EventBus(),
      now: () => now,
      retryBaseDelayMs: 100,
      executor: async ({ effects }) => {
        await runIntentionPostTurnHooks({
          hooks: [async (_context, hookEffects) => {
            hookAttempts += 1;
            if (hookAttempts === 1) throw new Error('connection unavailable before write');
            await hookEffects.crossBoundary();
            sinkWrites += 1;
          }],
          context: makeIntentionContext(),
          logger: { warn: vi.fn() },
          options: {
            propagateFailures: true,
            assertOwned: effects.assertOwned,
            runEffect: effects.run,
          },
        });
      },
    });
    const input = makeInput('session-a', 'turn-a');
    await supervisor.enqueue([input]);

    await supervisor.tick();
    await supervisor.waitForIdle();
    expect(await store.get(input.jobId)).toMatchObject({ state: 'retry_wait' });
    expect(sinkWrites).toBe(0);

    now += 100;
    await supervisor.tick();
    await supervisor.waitForIdle();
    expect(await store.get(input.jobId)).toMatchObject({ state: 'succeeded' });
    expect(hookAttempts).toBe(2);
    expect(sinkWrites).toBe(1);
  });

  it('fails an ambiguous post-write intention outcome without replaying the sink', async () => {
    let now = 1_000;
    let sinkWrites = 0;
    const store = new MemoryBackgroundWorkStore();
    const supervisor = createBackgroundWorkSupervisor({
      store,
      eventBus: new EventBus(),
      now: () => now,
      retryBaseDelayMs: 100,
      executor: async ({ effects }) => {
        await runIntentionPostTurnHooks({
          hooks: [async (_context, hookEffects) => {
            await hookEffects.crossBoundary();
            sinkWrites += 1;
            throw new Error('connection lost after write began');
          }],
          context: makeIntentionContext(),
          logger: { warn: vi.fn() },
          options: {
            propagateFailures: true,
            assertOwned: effects.assertOwned,
            runEffect: effects.run,
          },
        });
      },
    });
    const input = makeInput('session-a', 'turn-a');
    await supervisor.enqueue([input]);

    await supervisor.tick();
    await supervisor.waitForIdle();
    expect(await store.get(input.jobId)).toMatchObject({ state: 'retry_wait' });

    now += 100;
    await supervisor.tick();
    await supervisor.waitForIdle();
    expect(await store.get(input.jobId)).toMatchObject({
      state: 'failed',
      reasonCode: 'effect_outcome_unknown',
    });
    expect(sinkWrites).toBe(1);
  });

  it('durably requeues pre-boundary work on shutdown and a fresh supervisor completes it once', async () => {
    const store = new MemoryBackgroundWorkStore();
    let firstSinkWrites = 0;
    let secondSinkWrites = 0;
    const first = createBackgroundWorkSupervisor({
      store,
      eventBus: new EventBus(),
      leaseOwner: 'first',
      now: () => 1_000,
      shutdownTimeoutMs: 0,
      executor: async ({ effects, signal }) => {
        // A blocked provider/compute step that never crosses the effect
        // boundary; it unwinds only when shutdown aborts the claim signal.
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        });
        await effects.run('durable-sink', async (crossBoundary) => {
          await crossBoundary();
          firstSinkWrites += 1;
        });
      },
    });
    const input = makeInput('session-a', 'turn-a');
    await first.enqueue([input]);
    await first.tick();
    await flush();
    expect((await store.get(input.jobId))?.state).toBe('running');

    await first.stop();
    await first.waitForIdle();
    // Pre-boundary work is durably requeued under its claim token, not lost or
    // falsely completed. The old worker never crossed its boundary.
    expect(await store.get(input.jobId)).toMatchObject({ state: 'queued', reasonCode: 'shutdown' });
    expect(firstSinkWrites).toBe(0);

    const second = createBackgroundWorkSupervisor({
      store,
      eventBus: new EventBus(),
      leaseOwner: 'second',
      now: () => 2_000,
      executor: async ({ effects }) => {
        await effects.run('durable-sink', async (crossBoundary) => {
          await crossBoundary();
          secondSinkWrites += 1;
        });
      },
    });
    await second.tick();
    await second.waitForIdle();
    expect((await store.get(input.jobId))?.state).toBe('succeeded');
    expect(secondSinkWrites).toBe(1);
    expect(firstSinkWrites).toBe(0);
  });

  it('surfaces a shutdown requeue failure and permits a bounded retry without consuming an attempt', async () => {
    const store = new MemoryBackgroundWorkStore();
    const supervisor = createBackgroundWorkSupervisor({
      store,
      eventBus: new EventBus(),
      leaseOwner: 'first',
      now: () => 1_000,
      shutdownTimeoutMs: 0,
      executor: async ({ effects, signal }) => {
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        });
        await effects.run('durable-sink', async (crossBoundary) => {
          await crossBoundary();
        });
      },
    });
    const input = { ...makeInput('session-a', 'turn-a'), maxAttempts: 1 };
    await supervisor.enqueue([input]);
    await supervisor.tick();
    await flush();
    expect(await store.get(input.jobId)).toMatchObject({ state: 'running', attemptCount: 0 });

    store.failNextRequeuePreBoundaryClaims();
    await expect(supervisor.stop()).rejects.toThrow('injected shutdown requeue failure');
    expect(await store.get(input.jobId)).toMatchObject({ state: 'running', attemptCount: 0 });

    await supervisor.stop();
    expect(await store.get(input.jobId)).toMatchObject({
      state: 'queued',
      reasonCode: 'shutdown',
      attemptCount: 0,
    });
  });

  it('fails malformed persisted payloads closed without invoking a handler', async () => {
    const store = new MemoryBackgroundWorkStore();
    const executor = vi.fn(async () => undefined);
    const supervisor = createBackgroundWorkSupervisor({
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
    const supervisor = createBackgroundWorkSupervisor({
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
    const onTerminalFailure = vi.fn();
    const supervisor = createBackgroundWorkSupervisor({
      store,
      eventBus: new EventBus(),
      now: () => 1_000,
      onTerminalFailure,
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
    expect(onTerminalFailure).toHaveBeenCalledOnce();
    expect(onTerminalFailure).toHaveBeenCalledWith(expect.objectContaining({
      jobId: input.jobId,
      reasonCode: 'source_missing',
      payload: input.payload,
    }));
  });

  it('keeps quick source validation cycles at attempt zero and succeeds when the source arrives later', async () => {
    const store = new MemoryBackgroundWorkStore();
    let now = 100;
    let sourceReady = false;
    const supervisor = createBackgroundWorkSupervisor({
      store,
      eventBus: new EventBus(),
      now: () => now,
      executor: async () => {
        if (sourceReady) return;
        throw new BackgroundWorkDeferredError('source_not_ready', 250, 'source_missing');
      },
    });
    const input = makeInput('session-a', 'turn-source-arrives-late');
    await store.enqueue(input);

    for (let cycle = 1; cycle <= input.maxAttempts + 2; cycle += 1) {
      await supervisor.tick();
      await supervisor.waitForIdle();
      expect(await store.get(input.jobId)).toMatchObject({
        state: 'deferred',
        reasonCode: 'source_not_ready',
        attemptCount: 0,
      });
      now += 250;
    }

    sourceReady = true;
    now = 360_100;
    await supervisor.tick();
    await supervisor.waitForIdle();
    expect(await store.get(input.jobId)).toMatchObject({
      state: 'succeeded',
      attemptCount: 0,
    });
  });

  it('terminalizes a source validation failure after the job-creation grace', async () => {
    const store = new MemoryBackgroundWorkStore();
    const eventBus = new EventBus();
    const events: Array<Record<string, unknown>> = [];
    eventBus.on('agent.turn.performance', event => { events.push(event); });
    const supervisor = createBackgroundWorkSupervisor({
      store,
      eventBus,
      now: () => 60_100,
      executor: async () => {
        throw new BackgroundWorkDeferredError('source_not_ready', 250, 'source_missing');
      },
    });
    const input = makeInput('session-a', 'turn-live-oscillator');
    await store.enqueue(input);
    store.corrupt(input.jobId, { deferCount: 96 });

    await supervisor.tick();
    await supervisor.waitForIdle();

    expect(await store.get(input.jobId)).toMatchObject({
      state: 'failed',
      reasonCode: 'source_missing',
      attemptCount: 0,
    });
    await flush();
    expect(events).toContainEqual(expect.objectContaining({
      backgroundJobKind: 'memory_extraction',
      backgroundJobState: 'failed',
      backgroundJobReason: 'source_missing',
    }));
  });

  it('bounds handler-drain requeues instead of leaving them at attempt zero', async () => {
    const store = new MemoryBackgroundWorkStore();
    let now = 100;
    const onTerminalFailure = vi.fn();
    const supervisor = createBackgroundWorkSupervisor({
      store,
      eventBus: new EventBus(),
      now: () => now,
      onTerminalFailure,
      executor: async () => {
        throw new BackgroundWorkDeferredError('handler_failed', 50);
      },
    });
    const input = makeInput('session-a', 'turn-handler-keeps-draining');
    await store.enqueue(input);

    for (let attempt = 1; attempt <= input.maxAttempts; attempt += 1) {
      await supervisor.tick();
      await supervisor.waitForIdle();
      expect(onTerminalFailure).toHaveBeenCalledTimes(
        attempt === input.maxAttempts ? 1 : 0,
      );
      if (attempt < input.maxAttempts) now += 50;
    }

    expect(await store.get(input.jobId)).toMatchObject({
      state: 'failed',
      reasonCode: 'handler_failed',
      attemptCount: input.maxAttempts,
    });
    expect(onTerminalFailure).toHaveBeenCalledWith(expect.objectContaining({
      jobId: input.jobId,
      reasonCode: 'handler_failed',
      payload: input.payload,
    }));
  });

  it('emits content-free lifecycle telemetry with queue, attempt, age, duration, and a session hash', async () => {
    let now = 1_000;
    const store = new MemoryBackgroundWorkStore();
    const eventBus = new EventBus();
    const events: Array<Record<string, unknown>> = [];
    eventBus.on('agent.turn.performance', event => { events.push(event); });
    const supervisor = createBackgroundWorkSupervisor({
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
