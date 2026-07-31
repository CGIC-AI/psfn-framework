import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { BackgroundWorkSupervisorTuning } from '../../core/agent/background-work/config.js';
import {
  BackgroundWorkDeferredError,
  BackgroundWorkSupervisor,
  type BackgroundWorkSupervisorOptions,
} from '../../core/agent/background-work/supervisor.js';
import {
  createBackgroundWorkIdentity,
  fingerprintBackgroundWorkPayload,
  type BackgroundWorkPayload,
  type EnqueueBackgroundWorkInput,
} from '../../core/agent/background-work/types.js';
import {
  BackgroundWorkHealthAccumulator,
  type BackgroundWorkHealthUpdate,
} from '../../operator/garden/services/background-work-health.js';
import { EventBus } from '../../shared/event-bus.js';
import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import { createPostgresPool } from '../postgres.js';
import { PostgresBackgroundWorkStore } from './background-work-store.js';

const SUPERVISOR_TUNING: BackgroundWorkSupervisorTuning = {
  maxConcurrentSessions: 4,
  leaseDurationMs: 300_000,
  retryBaseDelayMs: 1_000,
  retryMaxDelayMs: 300_000,
  shutdownTimeoutMs: 5_000,
  terminalRetentionMs: 604_800_000,
  cleanupIntervalMs: 3_600_000,
};

const WELFARE_POLICY: BackgroundWorkSupervisorOptions['welfare'] = {
  deferThreshold: 100,
  ageThresholdMs: 60_000,
  reserveSlots: 0,
};

type LiveKind = 'memory_extraction' | 'intention_post_turn_hooks' | 'emotion_appraisal';

function createSupervisor(
  options: Pick<BackgroundWorkSupervisorOptions, 'store' | 'eventBus' | 'executor' | 'now'>,
): BackgroundWorkSupervisor {
  return new BackgroundWorkSupervisor({
    ...SUPERVISOR_TUNING,
    welfare: WELFARE_POLICY,
    ...options,
  });
}

function makeLiveInput(
  logicalSessionId: string,
  turnId: string,
  kind: LiveKind,
  createdAtMs: number,
  maxAttempts = 3,
): EnqueueBackgroundWorkInput {
  const source = {
    schemaVersion: 1 as const,
    logicalSessionId,
    channelId: logicalSessionId,
    turnId,
    requestId: `request-${turnId}`,
    turnRecordFingerprint: 'a'.repeat(64),
    createdAtMs,
  };
  const payload: BackgroundWorkPayload = kind === 'memory_extraction'
    ? { schemaVersion: 1, kind, source }
    : kind === 'intention_post_turn_hooks'
      ? { schemaVersion: 1, kind, source }
      : {
          schemaVersion: 1,
          kind,
          source,
          emotionSessionId: logicalSessionId,
          internalStateSnapshotRef: 'internal-state-v1:test',
          appraisalState: {
            schemaVersion: 1,
            emotional: {
              vad: { valence: 0, arousal: 0, dominance: 0 },
              mood: { valence: 0, arousal: 0, dominance: 0 },
              discreteEmotions: {},
              confidence: 1,
              telemetry: { status: 'trusted', source: 'runtime_state', reasons: [], weight: 1 },
            },
            cognitive: { certaintyLevel: 1, topicEngagement: 1, processingQuality: 'fluent' },
            attention: {
              activeConcernCount: 0,
              salientEntityCount: 0,
              conversationTrajectory: 'casual',
            },
            relational: { contactId: null, trustLevel: 'regular', moodDrift: 0 },
          },
          personalityOwnerRef: 'character-card',
          personalityProjectionHash: 'b'.repeat(64),
        };
  return {
    ...createBackgroundWorkIdentity({ logicalSessionId, turnId, kind }),
    logicalSessionId,
    kind,
    payload,
    payloadFingerprint: fingerprintBackgroundWorkPayload(payload),
    sourceTurnId: turnId,
    sourceRequestId: source.requestId,
    sourceChannelId: source.channelId,
    createdAtMs,
    maxAttempts,
  };
}

function makeTurnBatch(
  logicalSessionId: string,
  prefix: string,
  index: number,
  createdAtMs: number,
  kinds: readonly LiveKind[],
): EnqueueBackgroundWorkInput[] {
  const turnId = `${prefix}-${String(index)}`;
  return kinds.map(kind => makeLiveInput(logicalSessionId, turnId, kind, createdAtMs));
}

async function enqueueLegalBatches(
  store: PostgresBackgroundWorkStore,
  batches: readonly EnqueueBackgroundWorkInput[][],
): Promise<void> {
  for (let offset = 0; offset < batches.length; offset += 32) {
    await Promise.all(batches.slice(offset, offset + 32).map(batch => store.enqueueBatch(batch)));
  }
}

async function waitForCondition(
  condition: () => Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await condition()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for live-drain condition');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

describe('Postgres background-work live drain regression', () => {
  let harness: PostgresTestHarness | undefined;

  beforeAll(async () => {
    harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
  }, 90_000);

  afterAll(async () => {
    await harness?.stop();
  });

  it('rotates a bounded validation retry behind an untouched runnable sibling', async () => {
    if (!harness) throw new Error('Postgres test harness did not start');
    const database = await harness.createDatabase();
    const store = await PostgresBackgroundWorkStore.connect(database.databaseUrl, {
      schema: 'companion_a',
    });
    try {
      const inputs = [
        makeLiveInput('session-a', 'turn-a', 'memory_extraction', 100),
        makeLiveInput('session-a', 'turn-b', 'memory_extraction', 100),
      ];
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
    } finally {
      await store.close();
    }
  });

  it('drains the 814 legacy and 66 new live shapes with the source oscillator present', async () => {
    if (!harness) throw new Error('Postgres test harness did not start');
    const database = await harness.createDatabase();
    const store = await PostgresBackgroundWorkStore.connect(database.databaseUrl, {
      schema: 'companion_a',
    });
    const inspectionPool = createPostgresPool(database.databaseUrl, {
      schema: 'companion_a',
      max: 1,
    });
    let restartedStore: PostgresBackgroundWorkStore | undefined;
    let supervisor: BackgroundWorkSupervisor | undefined;
    try {
      const sessionId = 'api:testing-harness';
      const legacyBatches = Array.from({ length: 272 }, (_, index) => makeTurnBatch(
        sessionId,
        'legacy',
        index,
        100,
        index < 271
          ? ['memory_extraction', 'intention_post_turn_hooks', 'emotion_appraisal']
          : ['memory_extraction'],
      ));
      const newBatches = Array.from({ length: 22 }, (_, index) => makeTurnBatch(
        sessionId,
        'new',
        index,
        200,
        ['memory_extraction', 'intention_post_turn_hooks', 'emotion_appraisal'],
      ));
      const legacy = legacyBatches.flat();
      const newlyEnqueued = newBatches.flat();
      const oscillator = makeLiveInput(
        sessionId,
        '019fb146-7d79-76a9-b92c-3f46aedef6c9',
        'emotion_appraisal',
        0,
        5,
      );
      await enqueueLegalBatches(store, [...legacyBatches, ...newBatches]);
      await store.enqueue(oscillator);

      const liveNowMs = 108_000_000;
      await inspectionPool.query(`
        UPDATE agent_background_work_jobs
        SET state = 'queued',
            reason_code = 'foreground_active',
            deferred_from_state = NULL,
            deferred_from_available_at_ms = NULL,
            available_at_ms = 100,
            updated_at_ms = 100,
            defer_count = CASE WHEN kind = 'memory_extraction' THEN 278 ELSE 277 END,
            first_deferred_at_ms = 100,
            revision = revision + 1
        WHERE job_id = ANY($1::text[])
      `, [legacy.map(input => input.jobId)]);
      await inspectionPool.query(`
        UPDATE agent_background_work_jobs
        SET state = 'deferred',
            reason_code = 'source_not_ready',
            attempt_count = 0,
            max_attempts = 5,
            available_at_ms = $2::bigint,
            updated_at_ms = $2::bigint - 250,
            deferred_from_state = 'queued',
            deferred_from_available_at_ms = NULL,
            defer_count = 96,
            first_deferred_at_ms = 100,
            revision = 201107
        WHERE job_id = $1
      `, [oscillator.jobId, liveNowMs]);

      const shape = await inspectionPool.query<{
        kind: LiveKind;
        state: 'queued' | 'deferred';
        reason_code: 'foreground_active' | 'enqueued' | 'source_not_ready';
        count: string;
        max_defer: string;
        dfa_rows: string;
      }>(`
        SELECT kind, state, reason_code, COUNT(*)::text AS count,
               MAX(defer_count)::text AS max_defer,
               COUNT(deferred_from_available_at_ms)::text AS dfa_rows
        FROM agent_background_work_jobs
        GROUP BY kind, state, reason_code
        ORDER BY kind, state, reason_code
      `);
      expect(shape.rows).toEqual([
        { kind: 'emotion_appraisal', state: 'deferred', reason_code: 'source_not_ready', count: '1', max_defer: '96', dfa_rows: '0' },
        { kind: 'emotion_appraisal', state: 'queued', reason_code: 'enqueued', count: '22', max_defer: '0', dfa_rows: '0' },
        { kind: 'emotion_appraisal', state: 'queued', reason_code: 'foreground_active', count: '271', max_defer: '277', dfa_rows: '0' },
        { kind: 'intention_post_turn_hooks', state: 'queued', reason_code: 'enqueued', count: '22', max_defer: '0', dfa_rows: '0' },
        { kind: 'intention_post_turn_hooks', state: 'queued', reason_code: 'foreground_active', count: '271', max_defer: '277', dfa_rows: '0' },
        { kind: 'memory_extraction', state: 'queued', reason_code: 'enqueued', count: '22', max_defer: '0', dfa_rows: '0' },
        { kind: 'memory_extraction', state: 'queued', reason_code: 'foreground_active', count: '272', max_defer: '278', dfa_rows: '0' },
      ]);
      expect(newlyEnqueued).toHaveLength(66);

      await store.close();
      restartedStore = await PostgresBackgroundWorkStore.connect(database.databaseUrl, {
        schema: 'companion_a',
      });

      const executionOrder: string[] = [];
      const health = new BackgroundWorkHealthAccumulator();
      const latestHealth = new Map<string, BackgroundWorkHealthUpdate>();
      const eventBus = new EventBus();
      eventBus.on('agent.turn.performance', (event) => {
        const update = health.observe(event, liveNowMs);
        if (update) latestHealth.set(update.laneId, update);
      });
      supervisor = createSupervisor({
        store: restartedStore,
        eventBus,
        now: () => liveNowMs,
        executor: async ({ job }) => {
          executionOrder.push(job.jobId);
          if (job.jobId === oscillator.jobId) {
            throw new BackgroundWorkDeferredError('source_not_ready', 250, 'source_missing');
          }
        },
      });
      await supervisor.tick();
      await waitForCondition(async () => (await restartedStore!.countPending()) === 0, 40_000);
      await waitForCondition(() => Promise.resolve(
        [...latestHealth.values()].reduce((total, update) => total + update.counts.terminal, 0) === 881,
      ), 40_000);

      expect(executionOrder.indexOf(oscillator.jobId)).toBeGreaterThanOrEqual(880);
      expect(await restartedStore.get(oscillator.jobId)).toMatchObject({
        state: 'failed',
        reasonCode: 'source_missing',
        attemptCount: 0,
        maxAttempts: 5,
      });
      expect(await restartedStore.countPending()).toBe(0);
      expect(latestHealth.get('background_work:memory_extraction')?.counts).toEqual({
        succeeded: 294,
        failed: 0,
        terminal: 294,
        successRatePct: 100,
      });
      expect(latestHealth.get('background_work:intention_post_turn_hooks')?.counts).toEqual({
        succeeded: 293,
        failed: 0,
        terminal: 293,
        successRatePct: 100,
      });
      expect(latestHealth.get('background_work:emotion_appraisal')?.counts).toEqual({
        succeeded: 293,
        failed: 1,
        terminal: 294,
        successRatePct: 99.66,
      });
    } finally {
      const teardownErrors: unknown[] = [];
      if (supervisor) {
        try {
          await supervisor.stop();
        } catch (error) {
          teardownErrors.push(error);
        }
      }
      const closeResults = await Promise.allSettled([
        inspectionPool.end(),
        store.close(),
        ...(restartedStore ? [restartedStore.close()] : []),
      ]);
      for (const result of closeResults) {
        if (result.status === 'rejected') teardownErrors.push(result.reason);
      }
      if (teardownErrors.length > 0) {
        throw new AggregateError(teardownErrors, 'Background-work live-drain teardown failed');
      }
    }
  }, 60_000);
});
