import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createBackgroundWorkIdentity,
  fingerprintBackgroundWorkPayload,
  type AutoCompactionBackgroundPayload,
  type EnqueueBackgroundWorkInput,
  type MemoryExtractionBackgroundPayload,
} from '../../core/agent/background-work/types.js';
import { createPostgresPool } from '../postgres.js';
import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import { PostgresBackgroundWorkStore } from './background-work-store.js';

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
      turnRecordFingerprint: `record-${turnId}`,
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
      turnRecordFingerprint: `record-${turnId}`,
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
      expect(serialized).toContain('record-turn-a');
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
