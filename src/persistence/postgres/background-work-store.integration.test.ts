import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createBackgroundWorkIdentity,
  fingerprintBackgroundWorkPayload,
  type AutoCompactionBackgroundPayload,
  type BackgroundWorkPayload,
  type ClaimedBackgroundWorkJob,
  type EnqueueBackgroundWorkInput,
  type MemoryExtractionBackgroundPayload,
} from '../../core/agent/background-work/types.js';
import { BackgroundWorkSupervisor } from '../../core/agent/background-work/supervisor.js';
import { EventBus } from '../../shared/event-bus.js';
import { createPostgresPool } from '../postgres.js';
import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import { PostgresBackgroundWorkStore } from './background-work-store.js';
import { PostgresTurnRecordEligibilityFence } from './turn-record-eligibility-fence.js';
import { SessionStore } from '../sessions/store.js';
import { createTurnId } from '../../core/turns/id.js';
import type { TurnRecord } from '../../shared/contracts/runtime.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function makeCanonicalTurnRecord(
  logicalSessionId: string,
  turnId: TurnRecord['turnId'],
  privateResponse: string,
): TurnRecord {
  return {
    schemaVersion: 1,
    turnId,
    requestId: `request-${turnId}`,
    sessionId: logicalSessionId,
    channelId: logicalSessionId,
    channelType: 'api',
    startedAt: 90,
    completedAt: 100,
    status: 'completed',
    userMessage: { role: 'user', content: 'private prompt', timestamp: 90 },
    assistantMessage: { role: 'assistant', content: privateResponse, timestamp: 100 },
    toolCalls: [],
    extractedMemoryIds: [],
    concernDeltaRefs: [],
    contactDeltaRefs: [],
    versionPointers: { model: 'test-model' },
    provenanceRefs: [],
  };
}

function makeInput(
  logicalSessionId: string,
  turnId: string,
  overrides: Partial<EnqueueBackgroundWorkInput> = {},
): EnqueueBackgroundWorkInput {
  const payload: MemoryExtractionBackgroundPayload = {
    schemaVersion: 1,
    kind: 'memory_extraction',
    source: {
      schemaVersion: 1,
      logicalSessionId,
      channelId: logicalSessionId,
      turnId,
      requestId: `request-${turnId}`,
      turnRecordFingerprint: 'a'.repeat(64),
      createdAtMs: 100,
    },
  };
  return {
    ...createBackgroundWorkIdentity({ logicalSessionId, turnId, kind: payload.kind }),
    logicalSessionId,
    kind: payload.kind,
    payload,
    payloadFingerprint: fingerprintBackgroundWorkPayload(payload),
    sourceTurnId: turnId,
    sourceRequestId: `request-${turnId}`,
    sourceChannelId: logicalSessionId,
    createdAtMs: 100,
    maxAttempts: 3,
    ...overrides,
  };
}

function makeCompactionInput(
  logicalSessionId: string,
  turnId: string,
  createdAtMs: number,
): EnqueueBackgroundWorkInput {
  const payload: AutoCompactionBackgroundPayload = {
    schemaVersion: 1,
    kind: 'auto_compaction',
    source: {
      schemaVersion: 1,
      logicalSessionId,
      channelId: logicalSessionId,
      turnId,
      requestId: `request-${turnId}`,
      turnRecordFingerprint: 'a'.repeat(64),
      createdAtMs,
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
    ...createBackgroundWorkIdentity({ logicalSessionId, turnId, kind: payload.kind }),
    logicalSessionId,
    kind: payload.kind,
    payload,
    payloadFingerprint: fingerprintBackgroundWorkPayload(payload),
    sourceTurnId: turnId,
    sourceRequestId: `request-${turnId}`,
    sourceChannelId: logicalSessionId,
    createdAtMs,
    maxAttempts: 3,
  };
}

function makeFourJobBatch(
  logicalSessionId: string,
  turnId: string,
): EnqueueBackgroundWorkInput[] {
  const memory = makeInput(logicalSessionId, turnId);
  const source = (memory.payload as MemoryExtractionBackgroundPayload).source;
  const payloads: BackgroundWorkPayload[] = [
    memory.payload,
    {
      schemaVersion: 1,
      kind: 'intention_post_turn_hooks',
      source,
    },
    {
      schemaVersion: 1,
      kind: 'emotion_appraisal',
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
    },
    makeCompactionInput(logicalSessionId, turnId, source.createdAtMs).payload,
  ];
  return payloads.map(payload => ({
    ...createBackgroundWorkIdentity({ logicalSessionId, turnId, kind: payload.kind }),
    logicalSessionId,
    kind: payload.kind,
    payload,
    payloadFingerprint: fingerprintBackgroundWorkPayload(payload),
    sourceTurnId: turnId,
    sourceRequestId: source.requestId,
    sourceChannelId: source.channelId,
    createdAtMs: source.createdAtMs,
    maxAttempts: 3,
  }));
}

async function waitForPostgresCondition(
  condition: () => Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await condition()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for Postgres test condition');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

describe('PostgresBackgroundWorkStore', () => {
  let harness: PostgresTestHarness;

  beforeAll(async () => {
    harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
  }, 90_000);

  afterAll(async () => {
    await harness.stop();
  }, 30_000);

  it('deduplicates exact snapshots and rejects conflicting key reuse', async () => {
    const database = await harness.createDatabase();
    const store = await PostgresBackgroundWorkStore.connect(database.databaseUrl, {
      schema: 'companion_a',
    });
    try {
      const input = makeInput('session-a', 'turn-a');
      expect((await store.enqueue(input)).outcome).toBe('enqueued');
      expect((await store.enqueue(input)).outcome).toBe('deduplicated');

      const conflictingPayload: MemoryExtractionBackgroundPayload = {
        ...input.payload as MemoryExtractionBackgroundPayload,
        canonicalContactId: 'different-contact',
      };
      await expect(store.enqueue({
        ...input,
        payload: conflictingPayload,
        payloadFingerprint: fingerprintBackgroundWorkPayload(conflictingPayload),
      })).rejects.toThrow('idempotency key reuse mismatch');

      await expect(store.enqueue({
        ...makeInput('session-b', 'turn-b'),
        payload: {
          ...makeInput('session-b', 'turn-b').payload,
          messageText: 'partner transcript must not enter the queue',
        } as EnqueueBackgroundWorkInput['payload'],
      })).rejects.toThrow('unsupported field messageText');
    } finally {
      await store.close();
    }
  });

  it('stores only scoped references and rejects unknown persisted kinds at the schema boundary', async () => {
    const database = await harness.createDatabase();
    const store = await PostgresBackgroundWorkStore.connect(database.databaseUrl, {
      schema: 'companion_a',
    });
    const inspectionPool = createPostgresPool(database.databaseUrl, {
      schema: 'companion_a',
      max: 1,
    });
    try {
      const input = makeInput('session-a', 'turn-a');
      await store.enqueue(input);
      const row = await inspectionPool.query<{ payload: unknown }>(
        'SELECT payload FROM agent_background_work_jobs WHERE job_id = $1',
        [input.jobId],
      );
      const serialized = JSON.stringify(row.rows[0]?.payload);
      expect(serialized).toContain('a'.repeat(64));
      expect(serialized).not.toContain('partner transcript');
      expect(serialized).not.toContain('messageText');

      await expect(inspectionPool.query(
        "UPDATE agent_background_work_jobs SET kind = 'unknown_kind' WHERE job_id = $1",
        [input.jobId],
      )).rejects.toThrow();
    } finally {
      await inspectionPool.end();
      await store.close();
    }
  });

  it('allows only one of two store instances to claim a durable job', async () => {
    const database = await harness.createDatabase();
    const first = await PostgresBackgroundWorkStore.connect(database.databaseUrl, {
      schema: 'companion_a',
    });
    const second = await PostgresBackgroundWorkStore.connect(database.databaseUrl, {
      schema: 'companion_a',
    });
    try {
      await first.enqueue(makeInput('session-a', 'turn-a'));
      const claims = await Promise.all([
        first.claimNext({
          leaseOwner: 'worker-a',
          nowMs: 100,
          leaseDurationMs: 1_000,
          excludedLogicalSessionIds: [],
        }),
        second.claimNext({
          leaseOwner: 'worker-b',
          nowMs: 100,
          leaseDurationMs: 1_000,
          excludedLogicalSessionIds: [],
        }),
      ]);
      expect(claims.filter(Boolean)).toHaveLength(1);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it('atomically rolls back the TurnRecord handoff after failures at job 1 and job 4', async () => {
    const database = await harness.createDatabase();
    for (const failAt of [1, 4]) {
      const schema = `failure_${String(failAt)}`;
      const store = await PostgresBackgroundWorkStore.connect(database.databaseUrl, { schema });
      const inspectionPool = createPostgresPool(database.databaseUrl, { schema, max: 1 });
      try {
        await inspectionPool.query(`
          CREATE FUNCTION fail_background_insert_${String(failAt)}() RETURNS trigger AS $$
          BEGIN
            IF (SELECT COUNT(*) FROM agent_background_work_jobs) >= ${String(failAt - 1)} THEN
              RAISE EXCEPTION 'injected failure after job ${String(failAt)}';
            END IF;
            RETURN NEW;
          END;
          $$ LANGUAGE plpgsql
        `);
        await inspectionPool.query(`
          CREATE TRIGGER fail_background_insert_${String(failAt)}
          BEFORE INSERT ON agent_background_work_jobs
          FOR EACH ROW EXECUTE FUNCTION fail_background_insert_${String(failAt)}()
        `);
        await expect(store.enqueueBatch(makeFourJobBatch('session-a', `turn-${String(failAt)}`)))
          .rejects.toThrow(`injected failure after job ${String(failAt)}`);
        const counts = await inspectionPool.query<{ jobs: string; handoffs: string }>(`
          SELECT
            (SELECT COUNT(*)::text FROM agent_background_work_jobs) AS jobs,
            (SELECT COUNT(*)::text FROM agent_background_work_handoffs) AS handoffs
        `);
        expect(counts.rows[0]).toEqual({ jobs: '0', handoffs: '0' });
      } finally {
        await Promise.all([inspectionPool.end(), store.close()]);
      }
    }
  });

  it('serializes concurrent schema migration startup under one advisory lock', async () => {
    const database = await harness.createDatabase();
    const stores = await Promise.all(Array.from({ length: 8 }, async () => (
      PostgresBackgroundWorkStore.connect(database.databaseUrl, { schema: 'migration_race' })
    )));
    const inspectionPool = createPostgresPool(database.databaseUrl, {
      schema: 'migration_race',
      max: 1,
    });
    try {
      const tables = await inspectionPool.query<{ count: string }>(`
        SELECT COUNT(*)::text AS count
        FROM information_schema.tables
        WHERE table_schema = 'migration_race'
          AND table_name IN (
            'agent_background_work_jobs',
            'agent_background_work_foreground_leases',
            'agent_background_work_handoffs',
            'agent_background_work_effect_receipts'
          )
      `);
      expect(tables.rows[0]?.count).toBe('4');
    } finally {
      await inspectionPool.end();
      await Promise.all(stores.map(store => store.close()));
    }
  });

  it('holds a replica-visible foreground fence until the owning turn ends', async () => {
    const database = await harness.createDatabase();
    const first = await PostgresBackgroundWorkStore.connect(database.databaseUrl, {
      schema: 'companion_a',
    });
    const second = await PostgresBackgroundWorkStore.connect(database.databaseUrl, {
      schema: 'companion_a',
    });
    try {
      const input = makeInput('session-a', 'turn-a');
      await first.enqueue(input);
      await first.beginForeground({
        logicalSessionId: input.logicalSessionId,
        leaseOwner: 'foreground-a',
        leaseId: 'foreground-lease-a',
        nowMs: 100,
        leaseDurationMs: 1_000,
      });
      expect(await second.claimNext({
        leaseOwner: 'worker-b',
        nowMs: 200,
        leaseDurationMs: 100,
        excludedLogicalSessionIds: [],
      })).toBeNull();
      expect(await first.endForeground({
        logicalSessionId: input.logicalSessionId,
        leaseOwner: 'foreground-a',
        leaseId: 'foreground-lease-a',
        nowMs: 300,
      })).toBe(true);
      await first.resumeDeferredForSession({
        logicalSessionId: input.logicalSessionId,
        nowMs: 300,
      });
      expect((await second.claimNext({
        leaseOwner: 'worker-b',
        nowMs: 300,
        leaseDurationMs: 100,
        excludedLogicalSessionIds: [],
      }))?.jobId).toBe(input.jobId);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it('serializes a claim behind an in-flight foreground acquisition for the same session', async () => {
    const database = await harness.createDatabase();
    const first = await PostgresBackgroundWorkStore.connect(database.databaseUrl, {
      schema: 'companion_a',
    });
    const second = await PostgresBackgroundWorkStore.connect(database.databaseUrl, {
      schema: 'companion_a',
    });
    const blockerPool = createPostgresPool(database.databaseUrl, {
      schema: 'companion_a',
      max: 1,
    });
    const blocker = await blockerPool.connect();
    try {
      const input = makeInput('session-a', 'turn-a');
      const otherBase = makeInput('session-b', 'turn-b');
      const otherPayload: MemoryExtractionBackgroundPayload = {
        ...otherBase.payload as MemoryExtractionBackgroundPayload,
        source: {
          ...(otherBase.payload as MemoryExtractionBackgroundPayload).source,
          createdAtMs: 200,
        },
      };
      const otherInput: EnqueueBackgroundWorkInput = {
        ...otherBase,
        payload: otherPayload,
        payloadFingerprint: fingerprintBackgroundWorkPayload(otherPayload),
        createdAtMs: 200,
      };
      await first.enqueue(input);
      await first.enqueue(otherInput);
      await blocker.query('BEGIN');
      await blocker.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`background-work:${input.logicalSessionId}`],
      );

      const foreground = first.beginForeground({
        logicalSessionId: input.logicalSessionId,
        leaseOwner: 'foreground-a',
        leaseId: 'foreground-lease-a',
        nowMs: 100,
        leaseDurationMs: 1_000,
      });
      await waitForPostgresCondition(async () => {
        const waiting = await blocker.query<{ count: string }>(`
          SELECT COUNT(*)::text AS count
          FROM pg_stat_activity
          WHERE application_name = 'psfn-background-work'
            AND wait_event_type = 'Lock'
            AND wait_event = 'advisory'
        `);
        return Number(waiting.rows[0]?.count ?? '0') >= 1;
      });

      expect(await second.claimNext({
        leaseOwner: 'worker-b',
        nowMs: 200,
        leaseDurationMs: 100,
        excludedLogicalSessionIds: [],
      })).toMatchObject({
        jobId: otherInput.jobId,
        logicalSessionId: otherInput.logicalSessionId,
      });
      expect(await first.get(input.jobId)).toMatchObject({ state: 'queued' });

      await blocker.query('COMMIT');
      await foreground;
      expect(await first.get(input.jobId)).toMatchObject({ state: 'deferred' });
      expect(await second.claimNext({
        leaseOwner: 'worker-b',
        nowMs: 101,
        leaseDurationMs: 100,
        excludedLogicalSessionIds: [],
      })).toBeNull();
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
      await Promise.all([blockerPool.end(), first.close(), second.close()]);
    }
  });

  it('linearizes foreground acquisition before a pending background effect boundary', async () => {
    const database = await harness.createDatabase();
    const store = await PostgresBackgroundWorkStore.connect(database.databaseUrl, {
      schema: 'companion_a',
    });
    const blockerPool = createPostgresPool(database.databaseUrl, {
      schema: 'companion_a',
      max: 1,
    });
    const blocker = await blockerPool.connect();
    try {
      const input = makeInput('session-a', 'turn-a');
      await store.enqueue(input);
      const claim = await store.claimNext({
        leaseOwner: 'worker-a',
        nowMs: 100,
        leaseDurationMs: 1_000,
        excludedLogicalSessionIds: [],
      });
      expect(claim).not.toBeNull();

      await blocker.query('BEGIN');
      await blocker.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`background-work:${input.logicalSessionId}`],
      );
      const foreground = store.beginForeground({
        logicalSessionId: input.logicalSessionId,
        leaseOwner: 'foreground-a',
        leaseId: 'foreground-lease-a',
        nowMs: 200,
        leaseDurationMs: 1_000,
      });
      await waitForPostgresCondition(async () => {
        const waiting = await blocker.query<{ count: string }>(`
          SELECT COUNT(*)::text AS count
          FROM pg_stat_activity
          WHERE application_name = 'psfn-background-work'
            AND wait_event_type = 'Lock'
            AND wait_event = 'advisory'
        `);
        return Number(waiting.rows[0]?.count ?? '0') >= 1;
      });
      const effectBoundary = store.beginEffect({
        jobId: claim!.jobId,
        effectKey: 'durable-sink',
        leaseOwner: claim!.leaseOwner,
        expectedRevision: claim!.revision,
        nowMs: 200,
      });

      await blocker.query('COMMIT');
      await foreground;
      await expect(effectBoundary).resolves.toBe('foreground_active');
      expect(await store.checkClaimFence({
        jobId: claim!.jobId,
        leaseOwner: claim!.leaseOwner,
        expectedRevision: claim!.revision,
        nowMs: 200,
      })).toBe('foreground_active');
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
      await Promise.all([blockerPool.end(), store.close()]);
    }
  });

  it('surfaces expired foreground ownership before a second replica executes an effect', async () => {
    const database = await harness.createDatabase();
    const firstStore = await PostgresBackgroundWorkStore.connect(database.databaseUrl, {
      schema: 'companion_a',
    });
    const secondStore = await PostgresBackgroundWorkStore.connect(database.databaseUrl, {
      schema: 'companion_a',
    });
    let now = 1_000;
    let foregroundEffectCapable = true;
    let secondReplicaEffects = 0;
    const first = new BackgroundWorkSupervisor({
      store: firstStore,
      eventBus: new EventBus(),
      leaseOwner: 'foreground-replica',
      leaseDurationMs: 30,
      now: () => now,
      executor: async () => undefined,
    });
    const second = new BackgroundWorkSupervisor({
      store: secondStore,
      eventBus: new EventBus(),
      leaseOwner: 'background-replica',
      leaseDurationMs: 30,
      now: () => now,
      executor: async ({ effects }) => {
        await effects.run('durable-sink', async () => {
          expect(foregroundEffectCapable).toBe(false);
          secondReplicaEffects += 1;
        });
      },
    });
    try {
      const foreground = first.beginForeground('session-a');
      await foreground.ready;
      foreground.signal.addEventListener('abort', () => {
        foregroundEffectCapable = false;
      }, { once: true });
      await second.enqueue([makeInput('session-a', 'turn-a')]);

      now = 1_031;
      await expect(first.tick()).rejects.toThrow('Foreground work lease ownership was lost');
      expect(foreground.signal.aborted).toBe(true);
      expect(foregroundEffectCapable).toBe(false);

      await second.tick();
      await second.waitForIdle();
      expect(secondReplicaEffects).toBe(0);
      await first.endForeground(foreground);
      await first.waitForSessionTransitions();
      await second.tick();
      await second.waitForIdle();
      expect(secondReplicaEffects).toBe(1);
    } finally {
      await Promise.allSettled([first.stop(), second.stop()]);
      await Promise.all([firstStore.close(), secondStore.close()]);
    }
  });

  it('keeps an observed expired foreground lease quarantined for one bounded crash window', async () => {
    const database = await harness.createDatabase();
    const first = await PostgresBackgroundWorkStore.connect(database.databaseUrl, {
      schema: 'companion_a',
    });
    const second = await PostgresBackgroundWorkStore.connect(database.databaseUrl, {
      schema: 'companion_a',
    });
    try {
      const input = makeInput('session-a', 'turn-a');
      await first.enqueue(input);
      await first.beginForeground({
        logicalSessionId: input.logicalSessionId,
        leaseOwner: 'foreground-a',
        leaseId: 'foreground-lease-a',
        nowMs: 100,
        leaseDurationMs: 10,
      });
      expect(await first.renewForeground({
        leaseOwner: 'foreground-a',
        leaseIds: ['foreground-lease-a'],
        nowMs: 111,
        leaseDurationMs: 10,
      })).toEqual([]);
      expect(await second.claimNext({
        leaseOwner: 'worker-b',
        nowMs: 111,
        leaseDurationMs: 10,
        excludedLogicalSessionIds: [],
      })).toBeNull();
      expect((await second.claimNext({
        leaseOwner: 'worker-b',
        nowMs: 122,
        leaseDurationMs: 10,
        excludedLogicalSessionIds: [],
      }))?.jobId).toBe(input.jobId);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it('preserves the original retry deadline across foreground defer and resume', async () => {
    const database = await harness.createDatabase();
    const store = await PostgresBackgroundWorkStore.connect(database.databaseUrl, {
      schema: 'companion_a',
    });
    try {
      const input = makeInput('session-a', 'turn-a');
      await store.enqueue(input);
      const claim = await store.claimNext({
        leaseOwner: 'worker-a',
        nowMs: 100,
        leaseDurationMs: 100,
        excludedLogicalSessionIds: [],
      });
      await store.failOrRetry({
        jobId: claim!.jobId,
        leaseOwner: claim!.leaseOwner,
        expectedRevision: claim!.revision,
        nowMs: 110,
        retryAtMs: 500,
      });
      await store.beginForeground({
        logicalSessionId: input.logicalSessionId,
        leaseOwner: 'foreground-a',
        leaseId: 'foreground-lease-a',
        nowMs: 200,
        leaseDurationMs: 1_000,
      });
      expect(await store.get(input.jobId)).toMatchObject({
        state: 'deferred',
        availableAtMs: 1_200,
        deferredFromState: 'retry_wait',
        deferredFromAvailableAtMs: 500,
      });
      await store.endForeground({
        logicalSessionId: input.logicalSessionId,
        leaseOwner: 'foreground-a',
        leaseId: 'foreground-lease-a',
        nowMs: 300,
      });
      await store.resumeDeferredForSession({ logicalSessionId: input.logicalSessionId, nowMs: 300 });
      expect(await store.get(input.jobId)).toMatchObject({
        state: 'retry_wait',
        availableAtMs: 500,
      });
      expect(await store.claimNext({
        leaseOwner: 'worker-b',
        nowMs: 499,
        leaseDurationMs: 100,
        excludedLogicalSessionIds: [],
      })).toBeNull();
      expect((await store.claimNext({
        leaseOwner: 'worker-b',
        nowMs: 500,
        leaseDurationMs: 100,
        excludedLogicalSessionIds: [],
      }))?.jobId).toBe(input.jobId);
    } finally {
      await store.close();
    }
  });

  it('fences an effect while worker A is held after the sink and makes a crash outcome terminal', async () => {
    const database = await harness.createDatabase();
    const first = await PostgresBackgroundWorkStore.connect(database.databaseUrl, {
      schema: 'companion_a',
    });
    const second = await PostgresBackgroundWorkStore.connect(database.databaseUrl, {
      schema: 'companion_a',
    });
    try {
      let sinkWrites = 0;
      const input = makeInput('session-a', 'turn-a');
      await first.enqueue(input);
      const claim = await first.claimNext({
        leaseOwner: 'worker-a',
        nowMs: 100,
        leaseDurationMs: 50,
        excludedLogicalSessionIds: [],
      });
      expect(await first.beginEffect({
        jobId: claim!.jobId,
        effectKey: 'durable-sink',
        leaseOwner: claim!.leaseOwner,
        expectedRevision: claim!.revision,
        nowMs: 100,
      })).toBe('execute');
      sinkWrites += 1;
      expect(await first.renewClaims({
        leaseOwner: claim!.leaseOwner,
        jobIds: [claim!.jobId],
        nowMs: 140,
        leaseDurationMs: 50,
      })).toEqual([claim!.jobId]);
      expect(await second.recoverExpired({ nowMs: 151 })).toBe(0);
      expect(await second.claimNext({
        leaseOwner: 'worker-b',
        nowMs: 151,
        leaseDurationMs: 50,
        excludedLogicalSessionIds: [],
      })).toBeNull();
      await first.completeEffect({
        jobId: claim!.jobId,
        effectKey: 'durable-sink',
        leaseOwner: claim!.leaseOwner,
        expectedRevision: claim!.revision,
        nowMs: 160,
      });
      await first.complete({
        jobId: claim!.jobId,
        leaseOwner: claim!.leaseOwner,
        expectedRevision: claim!.revision,
        nowMs: 160,
      });
      expect(sinkWrites).toBe(1);

      const crashedInput = makeInput('session-b', 'turn-b');
      await first.enqueue(crashedInput);
      const crashedClaim = await first.claimNext({
        leaseOwner: 'crashed-worker',
        nowMs: 200,
        leaseDurationMs: 10,
        excludedLogicalSessionIds: [],
      });
      expect(await first.beginEffect({
        jobId: crashedClaim!.jobId,
        effectKey: 'durable-sink',
        leaseOwner: crashedClaim!.leaseOwner,
        expectedRevision: crashedClaim!.revision,
        nowMs: 200,
      })).toBe('execute');
      sinkWrites += 1;
      expect(await second.recoverExpired({ nowMs: 211 })).toBe(1);
      expect(await second.get(crashedInput.jobId)).toMatchObject({
        state: 'failed',
        reasonCode: 'effect_outcome_unknown',
      });
      expect(await second.claimNext({
        leaseOwner: 'worker-b',
        nowMs: 211,
        leaseDurationMs: 10,
        excludedLogicalSessionIds: [],
      })).toBeNull();
      expect(sinkWrites).toBe(2);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it('linearizes claimed effects with tombstone and uniqueness revocation across stores', async () => {
    const database = await harness.createDatabase();
    const first = await PostgresBackgroundWorkStore.connect(database.databaseUrl, {
      schema: 'companion_a',
    });
    const second = await PostgresBackgroundWorkStore.connect(database.databaseUrl, {
      schema: 'companion_a',
    });
    const firstFencePool = createPostgresPool(database.databaseUrl, {
      schema: 'companion_a',
      max: 2,
    });
    const secondFencePool = createPostgresPool(database.databaseUrl, {
      schema: 'companion_a',
      max: 2,
    });
    const inspectionPool = createPostgresPool(database.databaseUrl, {
      schema: 'companion_a',
      max: 2,
    });
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-background-source-fence-'));
    const firstFence = new PostgresTurnRecordEligibilityFence(firstFencePool, 'companion_a');
    const secondFence = new PostgresTurnRecordEligibilityFence(secondFencePool, 'companion_a');
    const reader = new SessionStore(sessionsDir, { turnRecordEligibilityFence: firstFence });
    const writer = new SessionStore(sessionsDir, { turnRecordEligibilityFence: secondFence });
    const unfencedWriter = new SessionStore(sessionsDir);

    const prepareClaim = async (logicalSessionId: string, turnId: TurnRecord['turnId']) => {
      reader.append({
        channelId: logicalSessionId,
        role: 'user',
        content: 'session owner',
        timestamp: 50,
        turnId,
      });
      const record = makeCanonicalTurnRecord(
        logicalSessionId,
        turnId,
        `private-response-${logicalSessionId}`,
      );
      await reader.appendTurnRecord(record);
      const input = makeInput(logicalSessionId, turnId);
      await first.enqueue(input);
      const claim = await second.claimNext({
        leaseOwner: `worker-${logicalSessionId}`,
        nowMs: 100,
        leaseDurationMs: 10_000,
        excludedLogicalSessionIds: [],
      });
      expect(claim?.jobId).toBe(input.jobId);
      return { claim: claim!, record };
    };

    const persistClaimedEffect = async (
      claim: ClaimedBackgroundWorkJob,
      record: TurnRecord,
      beforePersist?: () => Promise<void>,
    ): Promise<boolean> => firstFence.withTurnRecordEligibilityFence({
      logicalSessionId: record.sessionId!,
      turnId: record.turnId,
    }, async () => {
      if (!reader.isSourceTurnRecordEligible(
        record.channelId,
        record.sessionId!,
        record.turnId,
      )) return false;
      expect(await first.assertClaimOwned({
        jobId: claim.jobId,
        leaseOwner: claim.leaseOwner,
        expectedRevision: claim.revision,
        nowMs: 101,
      })).toBe(true);
      expect(await first.beginEffect({
        jobId: claim.jobId,
        effectKey: 'private-excerpt',
        leaseOwner: claim.leaseOwner,
        expectedRevision: claim.revision,
        nowMs: 101,
      })).toBe('execute');
      await beforePersist?.();
      await inspectionPool.query(
        'INSERT INTO private_background_effects (turn_id, content) VALUES ($1, $2)',
        [record.turnId, record.assistantMessage!.content],
      );
      await first.completeEffect({
        jobId: claim.jobId,
        effectKey: 'private-excerpt',
        leaseOwner: claim.leaseOwner,
        expectedRevision: claim.revision,
        nowMs: 102,
      });
      return true;
    });

    try {
      await inspectionPool.query(`
        CREATE TABLE private_background_effects (
          turn_id TEXT PRIMARY KEY,
          content TEXT NOT NULL
        )
      `);

      // Effect wins: redaction waits, the effect commits while the source is
      // eligible, and only then may the writer revoke it.
      const effectFirst = await prepareClaim('session-effect-first', createTurnId());
      const effectEntered = deferred();
      const allowEffect = deferred();
      const effectPromise = persistClaimedEffect(
        effectFirst.claim,
        effectFirst.record,
        async () => {
          effectEntered.resolve();
          await allowEffect.promise;
        },
      );
      await effectEntered.promise;
      const redactionPromise = writer.redactTurn(
        effectFirst.record.sessionId!,
        effectFirst.record.turnId,
        { actor: 'test', reason: 'privacy revocation' },
      );
      allowEffect.resolve();
      expect(await effectPromise).toBe(true);
      await redactionPromise;

      // Revocation wins: the background consumer blocks on the same durable
      // fence, then observes the tombstone and persists no private content.
      const tombstoneFirst = await prepareClaim('session-tombstone-first', createTurnId());
      const tombstoneHeld = deferred();
      const allowTombstone = deferred();
      const tombstoneMutation = secondFence.withTurnRecordEligibilityFence({
        logicalSessionId: tombstoneFirst.record.sessionId!,
        turnId: tombstoneFirst.record.turnId,
      }, async () => {
        tombstoneHeld.resolve();
        await allowTombstone.promise;
        await unfencedWriter.redactTurn(
          tombstoneFirst.record.sessionId!,
          tombstoneFirst.record.turnId,
          { actor: 'test', reason: 'privacy revocation' },
        );
      });
      await tombstoneHeld.promise;
      const rejectedTombstoneEffect = persistClaimedEffect(
        tombstoneFirst.claim,
        tombstoneFirst.record,
      );
      allowTombstone.resolve();
      await tombstoneMutation;
      expect(await rejectedTombstoneEffect).toBe(false);

      // A duplicate canonical source is the equivalent uniqueness revocation:
      // once that writer wins the fence, no effect may consume either copy.
      const duplicateFirst = await prepareClaim('session-duplicate-first', createTurnId());
      const duplicateHeld = deferred();
      const allowDuplicate = deferred();
      const duplicateMutation = secondFence.withTurnRecordEligibilityFence({
        logicalSessionId: duplicateFirst.record.sessionId!,
        turnId: duplicateFirst.record.turnId,
      }, async () => {
        duplicateHeld.resolve();
        await allowDuplicate.promise;
        await unfencedWriter.appendTurnRecord(duplicateFirst.record);
      });
      await duplicateHeld.promise;
      const rejectedDuplicateEffect = persistClaimedEffect(
        duplicateFirst.claim,
        duplicateFirst.record,
      );
      allowDuplicate.resolve();
      await duplicateMutation;
      expect(await rejectedDuplicateEffect).toBe(false);

      const persisted = await inspectionPool.query<{ turn_id: string; content: string }>(
        'SELECT turn_id, content FROM private_background_effects ORDER BY turn_id',
      );
      expect(persisted.rows).toEqual([{
        turn_id: effectFirst.record.turnId,
        content: effectFirst.record.assistantMessage!.content,
      }]);
      expect(JSON.stringify(persisted.rows)).not.toContain(
        tombstoneFirst.record.assistantMessage!.content,
      );
      expect(JSON.stringify(persisted.rows)).not.toContain(
        duplicateFirst.record.assistantMessage!.content,
      );
    } finally {
      rmSync(sessionsDir, { recursive: true, force: true });
      await Promise.all([
        first.close(),
        second.close(),
        firstFencePool.end(),
        secondFencePool.end(),
        inspectionPool.end(),
      ]);
    }
  }, 30_000);

  it('keeps a permanent accepted-handoff ledger after terminal job cleanup', async () => {
    const database = await harness.createDatabase();
    const store = await PostgresBackgroundWorkStore.connect(database.databaseUrl, {
      schema: 'companion_a',
    });
    try {
      const input = makeInput('session-a', 'turn-a');
      expect((await store.enqueueBatch([input]))[0]?.outcome).toBe('enqueued');
      const claim = await store.claimNext({
        leaseOwner: 'worker-a',
        nowMs: 100,
        leaseDurationMs: 100,
        excludedLogicalSessionIds: [],
      });
      await store.complete({
        jobId: claim!.jobId,
        leaseOwner: claim!.leaseOwner,
        expectedRevision: claim!.revision,
        nowMs: 200,
      });
      expect(await store.purgeTerminal({ completedBeforeMs: 200, limit: 10 })).toBe(1);
      expect((await store.enqueueBatch([input]))[0]).toEqual({
        outcome: 'already_accepted',
        jobId: input.jobId,
        staleDiscardedJobIds: [],
      });
      expect(await store.get(input.jobId)).toBeNull();
    } finally {
      await store.close();
    }
  });

  it('recovers an expired lease with a bounded attempt and permits restart claim', async () => {
    const database = await harness.createDatabase();
    const store = await PostgresBackgroundWorkStore.connect(database.databaseUrl, {
      schema: 'companion_a',
    });
    try {
      const input = makeInput('session-a', 'turn-a');
      await store.enqueue(input);
      const firstClaim = await store.claimNext({
        leaseOwner: 'crashed-worker',
        nowMs: 100,
        leaseDurationMs: 10,
        excludedLogicalSessionIds: [],
      });
      expect(firstClaim?.state).toBe('running');
      expect(await store.recoverExpired({ nowMs: 111 })).toBe(1);
      expect((await store.get(input.jobId))?.state).toBe('retry_wait');
      expect((await store.get(input.jobId))?.attemptCount).toBe(1);

      const restartClaim = await store.claimNext({
        leaseOwner: 'restart-worker',
        nowMs: 111,
        leaseDurationMs: 10,
        excludedLogicalSessionIds: [],
      });
      expect(restartClaim?.jobId).toBe(input.jobId);
      expect(restartClaim?.leaseOwner).toBe('restart-worker');
    } finally {
      await store.close();
    }
  });

  it('defers foreground work until a crash-safe fallback and resumes only foreground deferrals', async () => {
    const database = await harness.createDatabase();
    const store = await PostgresBackgroundWorkStore.connect(database.databaseUrl, {
      schema: 'companion_a',
    });
    try {
      const foregroundInput = makeInput('session-a', 'turn-a');
      await store.enqueue(foregroundInput);
      const deferred = await store.deferRunnableForSession({
        logicalSessionId: 'session-a',
        nowMs: 110,
        resumeFallbackAtMs: 500,
      });
      expect(deferred).toHaveLength(1);
      expect(await store.claimNext({
        leaseOwner: 'worker-a',
        nowMs: 499,
        leaseDurationMs: 100,
        excludedLogicalSessionIds: [],
      })).toBeNull();
      expect(await store.resumeDeferredForSession({ logicalSessionId: 'session-a', nowMs: 200 }))
        .toHaveLength(1);
      expect((await store.claimNext({
        leaseOwner: 'worker-a',
        nowMs: 200,
        leaseDurationMs: 100,
        excludedLogicalSessionIds: [],
      }))?.jobId).toBe(foregroundInput.jobId);

      const sourceInput = makeInput('session-b', 'turn-b');
      await store.enqueue(sourceInput);
      const sourceClaim = await store.claimNext({
        leaseOwner: 'worker-b',
        nowMs: 200,
        leaseDurationMs: 100,
        excludedLogicalSessionIds: [],
      });
      expect(sourceClaim?.jobId).toBe(sourceInput.jobId);
      await store.defer({
        jobId: sourceClaim!.jobId,
        leaseOwner: sourceClaim!.leaseOwner,
        expectedRevision: sourceClaim!.revision,
        reasonCode: 'source_not_ready',
        availableAtMs: 600,
        nowMs: 210,
      });
      expect(await store.resumeDeferredForSession({ logicalSessionId: 'session-b', nowMs: 220 }))
        .toEqual([]);
      expect((await store.get(sourceInput.jobId))?.reasonCode).toBe('source_not_ready');
    } finally {
      await store.close();
    }
  });

  it('deterministically keeps the newest unstarted compaction regardless of enqueue order', async () => {
    const database = await harness.createDatabase();
    const store = await PostgresBackgroundWorkStore.connect(database.databaseUrl, {
      schema: 'companion_a',
    });
    try {
      const newer = makeCompactionInput('session-a', 'turn-newer', 200);
      const older = makeCompactionInput('session-a', 'turn-older', 100);
      await store.enqueue(newer);
      expect((await store.enqueue(older)).job.state).toBe('stale_discarded');
      expect((await store.get(newer.jobId))?.state).toBe('queued');

      const oldest = makeCompactionInput('session-b', 'turn-oldest', 100);
      const newest = makeCompactionInput('session-b', 'turn-newest', 200);
      await store.enqueue(oldest);
      const result = await store.enqueue(newest);
      expect(result.staleDiscardedJobIds).toEqual([oldest.jobId]);
      expect((await store.get(oldest.jobId))?.state).toBe('stale_discarded');
      expect((await store.get(newest.jobId))?.state).toBe('queued');
    } finally {
      await store.close();
    }
  });

  it('isolates companion schemas and purges bounded terminal history', async () => {
    const database = await harness.createDatabase();
    const first = await PostgresBackgroundWorkStore.connect(database.databaseUrl, {
      schema: 'companion_a',
    });
    const second = await PostgresBackgroundWorkStore.connect(database.databaseUrl, {
      schema: 'companion_b',
    });
    try {
      const input = makeInput('session-a', 'turn-a');
      await first.enqueue(input);
      expect(await second.get(input.jobId)).toBeNull();
      expect(await second.countRunnable({ nowMs: 100 })).toBe(0);

      const claim = await first.claimNext({
        leaseOwner: 'worker-a',
        nowMs: 100,
        leaseDurationMs: 1_000,
        excludedLogicalSessionIds: [],
      });
      expect(claim).not.toBeNull();
      await first.complete({
        jobId: claim!.jobId,
        leaseOwner: claim!.leaseOwner,
        expectedRevision: claim!.revision,
        nowMs: 200,
      });
      expect(await first.purgeTerminal({ completedBeforeMs: 200, limit: 10 })).toBe(1);
      expect(await first.get(input.jobId)).toBeNull();
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });
});
