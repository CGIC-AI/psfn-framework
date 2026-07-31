import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
import {
  BackgroundWorkDeferredError,
  BackgroundWorkSupervisor,
  type BackgroundWorkSupervisorOptions,
} from '../../core/agent/background-work/supervisor.js';
import type { BackgroundWorkSupervisorTuning } from '../../core/agent/background-work/config.js';
import { EventBus } from '../../shared/event-bus.js';
import { createPostgresPool, ensurePostgresSchemaExists } from '../postgres.js';
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
import { buildSessionMetadataWithTurn } from '../../core/session/turn-provenance.js';
import { SessionManager } from '../../core/session/manager.js';
import { MemoryExtractor } from '../../faculties/memory/extraction.js';
import { buildSessionMetadataWithIcpCorrelation } from '../../core/session/icp-correlation-metadata.js';
import {
  CHANNEL as ICP_CHANNEL,
  SOURCE as ICP_SOURCE,
  correlation as icpCorrelation,
  recoveryResponse as icpRecoveryResponse,
} from '../../core/session/icp-recovery.test-fixtures.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import {
  runExtractionOrchestration,
  type ExtractionRunOptions,
} from '../../faculties/memory/extraction/orchestrator.js';
import { buildSubsystemOutputRef } from '../../shared/contracts/subsystem-output-refs.js';
import { schedulePostTurnWork } from '../../core/agent/substrate-agent/turn-execution/post-turn-scheduling.js';
import { executePostTurnBackgroundWork } from '../../core/agent/background-work/post-turn-runtime.js';
import { InMemoryMemoryStore } from '../../test-support/in-memory-memory-store.js';
import { createTestPostgresContactStore } from '../../test-support/postgres-contact-store.js';
import { createTestPostgresIntentionPorts } from '../../test-support/postgres-intention-ports.js';
import { createAutomatedConcernRuntime } from '../../core/intention/concern-candidates.js';
import { AdminSessionDataService } from '../../operator/garden/services/session-service.js';
import { ensureIntentionPostgresSchema } from '../../core/intention/postgres-adapters/connection.js';
import { PostgresActiveConcernStore } from '../../core/intention/postgres-adapters/concerns-adapter.js';
import { createConcernStorePort } from '../../core/intention/concern-store-port.js';

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
): EnqueueBackgroundWorkInput & { payload: AutoCompactionBackgroundPayload } {
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

  it('fails a privacy-unsafe persisted compaction payload without running its handler', async () => {
    const database = await harness.createDatabase();
    const store = await PostgresBackgroundWorkStore.connect(database.databaseUrl, {
      schema: 'companion_a',
    });
    const inspectionPool = createPostgresPool(database.databaseUrl, {
      schema: 'companion_a',
      max: 1,
    });
    const executor = vi.fn(async () => undefined);
    const supervisor = createBackgroundWorkSupervisor({
      store,
      eventBus: new EventBus(),
      leaseOwner: 'payload-validation-worker',
      now: () => 1_000,
      executor,
    });
    try {
      const input = makeCompactionInput('session-a', 'turn-a', 100);
      input.payload.turnBudgetCharacteristics.modelSelection = {
        purpose: 'chat',
        slotKey: 'chat-primary',
        provider: 'test-provider',
        model: 'test-model',
        contextWindow: 16_384,
      };
      input.payloadFingerprint = fingerprintBackgroundWorkPayload(input.payload);

      const malformedInput = structuredClone(input);
      (malformedInput.payload.turnBudgetCharacteristics.modelSelection as Record<string, unknown>)
        .partnerMessage = 'private partner text';
      malformedInput.payloadFingerprint = fingerprintBackgroundWorkPayload(malformedInput.payload);
      await expect(store.enqueue(malformedInput)).rejects.toThrow(
        'modelSelection contains unsupported field partnerMessage',
      );
      const beforeValidEnqueue = await inspectionPool.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM agent_background_work_jobs',
      );
      expect(beforeValidEnqueue.rows[0]?.count).toBe('0');

      await store.enqueue(input);

      const persisted = await inspectionPool.query<{ payload: unknown }>(
        'SELECT payload FROM agent_background_work_jobs WHERE job_id = $1',
        [input.jobId],
      );
      expect(persisted.rows[0]?.payload).toEqual(input.payload);
      expect(JSON.stringify(persisted.rows[0]?.payload)).not.toContain('private partner text');

      await inspectionPool.query(`
        UPDATE agent_background_work_jobs
        SET payload = jsonb_set(
          payload,
          '{turnBudgetCharacteristics,modelSelection,partnerMessage}',
          to_jsonb($2::text),
          true
        )
        WHERE job_id = $1
      `, [input.jobId, 'private partner text']);

      await supervisor.tick();
      await supervisor.waitForIdle();

      expect(executor).not.toHaveBeenCalled();
      expect(await store.get(input.jobId)).toMatchObject({
        state: 'failed',
        reasonCode: 'malformed_payload',
      });
    } finally {
      await supervisor.stop();
      await inspectionPool.end();
      await store.close();
    }
  });

  it('fails producer-impossible persisted compaction payloads without running their handler', async () => {
    const database = await harness.createDatabase();
    const store = await PostgresBackgroundWorkStore.connect(database.databaseUrl, {
      schema: 'companion_a',
    });
    const inspectionPool = createPostgresPool(database.databaseUrl, {
      schema: 'companion_a',
      max: 1,
    });
    const executor = vi.fn(async () => undefined);
    const supervisor = createBackgroundWorkSupervisor({
      store,
      eventBus: new EventBus(),
      leaseOwner: 'payload-shape-validation-worker',
      now: () => 1_000,
      executor,
    });
    const malformedPayloads: Array<[
      string,
      (payload: AutoCompactionBackgroundPayload) => void,
    ]> = [
      ['fractional session percentage', (payload) => {
        payload.adaptiveProfile.sessionHistoryBudgetPct = 6.5;
      }],
      ['fractional memory percentage', (payload) => {
        payload.adaptiveProfile.memoryRetrievalBudgetPct = 2.5;
      }],
      ['enabled disabled-source profile', (payload) => {
        payload.adaptiveProfile = {
          ...payload.adaptiveProfile,
          enabled: true,
          source: 'disabled',
          category: 'default',
        };
      }],
      ['categorized disabled-source profile', (payload) => {
        payload.adaptiveProfile = {
          ...payload.adaptiveProfile,
          enabled: false,
          source: 'disabled',
          category: 'task',
        };
      }],
      ['disabled default-source profile', (payload) => {
        payload.adaptiveProfile = {
          ...payload.adaptiveProfile,
          enabled: false,
          source: 'default',
          category: 'default',
        };
      }],
      ['categorized default-source profile', (payload) => {
        payload.adaptiveProfile = {
          ...payload.adaptiveProfile,
          enabled: true,
          source: 'default',
          category: 'task',
        };
      }],
      ['disabled adaptive-source profile', (payload) => {
        payload.adaptiveProfile = {
          ...payload.adaptiveProfile,
          enabled: false,
          source: 'adaptive',
          category: 'task',
        };
      }],
      ['default-category adaptive-source profile', (payload) => {
        payload.adaptiveProfile = {
          ...payload.adaptiveProfile,
          enabled: true,
          source: 'adaptive',
          category: 'default',
        };
      }],
      ['unsupported model purpose', (payload) => {
        payload.turnBudgetCharacteristics.modelSelection = {
          purpose: 'summary',
          slotKey: 'summary-primary',
          provider: 'test-provider',
          model: 'test-model',
          contextWindow: 16_384,
        };
      }],
    ];

    try {
      for (const [index, [label, mutate]] of malformedPayloads.entries()) {
        const input = makeCompactionInput(`session-${String(index)}`, `turn-${String(index)}`, 100);
        await store.enqueue(input);

        const malformedPayload = structuredClone(input.payload);
        mutate(malformedPayload);
        await inspectionPool.query(`
          UPDATE agent_background_work_jobs
          SET payload = $2::jsonb
          WHERE job_id = $1
        `, [input.jobId, JSON.stringify(malformedPayload)]);

        await supervisor.tick();
        await supervisor.waitForIdle();

        expect(executor, label).not.toHaveBeenCalled();
        expect(await store.get(input.jobId), label).toMatchObject({
          state: 'failed',
          reasonCode: 'malformed_payload',
        });
      }
    } finally {
      await supervisor.stop();
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

  it('runs role-bound migrations without database CREATE and never creates a missing tenant schema', async () => {
    const database = await harness.createDatabase();
    const adminPool = createPostgresPool(database.databaseUrl, { max: 1 });
    const tenantSchema = 'background_work_tenant';
    const tenantRole = 'background_work_tenant_role';
    const missingSchema = 'background_work_missing_tenant';
    const missingRole = 'background_work_missing_role';
    let store: PostgresBackgroundWorkStore | undefined;
    try {
      await adminPool.query(`CREATE ROLE "${tenantRole}" NOLOGIN NOINHERIT`);
      await adminPool.query(`CREATE SCHEMA "${tenantSchema}" AUTHORIZATION "${tenantRole}"`);
      await adminPool.query(`GRANT "${tenantRole}" TO CURRENT_USER`);
      const privileges = await adminPool.query<{ can_create_database_objects: boolean }>(`
        SELECT has_database_privilege($1, current_database(), 'CREATE')
          AS can_create_database_objects
      `, [tenantRole]);
      expect(privileges.rows[0]?.can_create_database_objects).toBe(false);

      store = await PostgresBackgroundWorkStore.connect(database.databaseUrl, {
        schema: tenantSchema,
        role: tenantRole,
      });
      await store.enqueue(makeInput('tenant-session', 'tenant-turn'));
      expect(await store.get(createBackgroundWorkIdentity({
        logicalSessionId: 'tenant-session',
        turnId: 'tenant-turn',
        kind: 'memory_extraction',
      }).jobId)).not.toBeNull();

      await adminPool.query(`CREATE ROLE "${missingRole}" NOLOGIN NOINHERIT`);
      await adminPool.query(`GRANT "${missingRole}" TO CURRENT_USER`);
      await expect(PostgresBackgroundWorkStore.connect(database.databaseUrl, {
        schema: missingSchema,
        role: missingRole,
      })).rejects.toThrow();
      const missing = await adminPool.query<{ exists: boolean }>(
        'SELECT to_regnamespace($1) IS NOT NULL AS exists',
        [missingSchema],
      );
      expect(missing.rows[0]?.exists).toBe(false);
    } finally {
      await store?.close();
      await adminPool.end();
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

  it('fails closed when a recovered turn reuses an accepted handoff with a different fingerprint', async () => {
    const database = await harness.createDatabase();
    const store = await PostgresBackgroundWorkStore.connect(database.databaseUrl, {
      schema: 'companion_a',
    });
    try {
      const accepted = makeFourJobBatch('session-a', 'turn-fingerprint');
      await store.enqueueBatch(accepted);
      await expect(store.enqueueBatch(accepted.map((input, index) => (
        index === 0 ? { ...input, maxAttempts: input.maxAttempts + 1 } : input
      )))).rejects.toThrow('Background work handoff replay fingerprint mismatch');
      expect((await Promise.all(accepted.map(input => store.get(input.jobId))))
        .filter((job) => job !== null)).toHaveLength(4);
    } finally {
      await store.close();
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

  it('holds a replica-visible compaction fence until the owning turn ends while autonomic work claims through it', async () => {
    const database = await harness.createDatabase();
    const first = await PostgresBackgroundWorkStore.connect(database.databaseUrl, {
      schema: 'companion_a',
    });
    const second = await PostgresBackgroundWorkStore.connect(database.databaseUrl, {
      schema: 'companion_a',
    });
    try {
      const compaction = makeCompactionInput('session-a', 'turn-a', 100);
      const memory = makeInput('session-a', 'turn-b');
      await first.enqueue(compaction);
      await first.enqueue(memory);
      await first.beginForeground({
        logicalSessionId: 'session-a',
        leaseOwner: 'foreground-a',
        leaseId: 'foreground-lease-a',
        nowMs: 100,
        leaseDurationMs: 1_000,
      });
      // The turn is active on this session, yet the autonomic memory job is
      // claimed by another replica and completes concurrently (hrmrq.119).
      const memoryClaim = await second.claimNext({
        leaseOwner: 'worker-b',
        nowMs: 200,
        leaseDurationMs: 100,
        excludedLogicalSessionIds: [],
      });
      expect(memoryClaim?.jobId).toBe(memory.jobId);
      await second.complete({
        jobId: memoryClaim!.jobId,
        leaseOwner: memoryClaim!.leaseOwner,
        expectedRevision: memoryClaim!.revision,
        nowMs: 250,
      });
      // Only the foreground-exclusive compaction stays fenced behind the turn.
      expect(await second.claimNext({
        leaseOwner: 'worker-b',
        nowMs: 260,
        leaseDurationMs: 100,
        excludedLogicalSessionIds: [],
      })).toBeNull();
      expect(await first.endForeground({
        logicalSessionId: 'session-a',
        leaseOwner: 'foreground-a',
        leaseId: 'foreground-lease-a',
        nowMs: 300,
      })).toBe(true);
      expect((await second.claimNext({
        leaseOwner: 'worker-b',
        nowMs: 300,
        leaseDurationMs: 100,
        excludedLogicalSessionIds: [],
      }))?.jobId).toBe(compaction.jobId);
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
      const input = makeCompactionInput('session-a', 'turn-a', 100);
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
      // Foreground acquisition records the lease only — the queued compaction
      // row is untouched, yet the live lease keeps it un-claimable.
      expect(await first.get(input.jobId)).toMatchObject({ state: 'queued', revision: 1 });
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
      const input = makeCompactionInput('session-a', 'turn-a', 100);
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

  it('lets a second supervisor claim after one lost-foreground quarantine window', async () => {
    const database = await harness.createDatabase();
    const firstStore = await PostgresBackgroundWorkStore.connect(database.databaseUrl, {
      schema: 'companion_a',
    });
    const secondStore = await PostgresBackgroundWorkStore.connect(database.databaseUrl, {
      schema: 'companion_a',
    });
    let now = 1_000;
    let foregroundEffectCapable = true;
    let firstReplicaEffects = 0;
    let secondReplicaEffects = 0;
    const first = createBackgroundWorkSupervisor({
      store: firstStore,
      eventBus: new EventBus(),
      leaseOwner: 'foreground-replica',
      leaseDurationMs: 300_000,
      now: () => now,
      executor: async ({ effects }) => {
        await effects.run('durable-sink', async () => {
          firstReplicaEffects += 1;
        });
      },
    });
    const second = createBackgroundWorkSupervisor({
      store: secondStore,
      eventBus: new EventBus(),
      leaseOwner: 'background-replica',
      leaseDurationMs: 300_000,
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
      await second.enqueue([makeCompactionInput('session-a', 'turn-a', 100)]);

      now = 301_001;
      await expect(first.tick()).rejects.toThrow('Foreground work lease ownership was lost');
      expect(foreground.signal.aborted).toBe(true);
      expect(foregroundEffectCapable).toBe(false);

      await second.tick();
      await second.waitForIdle();
      expect(secondReplicaEffects).toBe(0);

      // The foreground operation deliberately ignores abort. Later heartbeats
      // must not extend its lost lease beyond the one durable quarantine window.
      now = 401_001;
      await first.tick();
      now = 501_001;
      await first.tick();
      now = 601_002;
      await second.tick();
      await second.waitForIdle();
      expect(secondReplicaEffects).toBe(1);

      // A replacement foreground owner may arrive before the stale local turn
      // finally cleans up. Ending the lost lease is idempotent and must leave
      // that replacement fence intact.
      const replacementForeground = second.beginForeground('session-a');
      await replacementForeground.ready;
      await first.endForeground(foreground);
      await first.endForeground(foreground);
      await first.enqueue([makeCompactionInput('session-a', 'turn-b', 200)]);
      await first.tick();
      await first.waitForIdle();
      expect(firstReplicaEffects).toBe(0);

      await second.endForeground(replacementForeground);
      await first.tick();
      await first.waitForIdle();
      expect(firstReplicaEffects).toBe(1);
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
      const input = makeCompactionInput('session-a', 'turn-a', 100);
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

  it('preserves the original retry deadline across a foreground turn without touching the row', async () => {
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
      const retried = await store.failOrRetry({
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
      // A turn starting is invisible to the queue row (hrmrq.119): the retry
      // deadline and revision are exactly what failOrRetry left behind.
      expect(await store.get(input.jobId)).toMatchObject({
        state: 'retry_wait',
        availableAtMs: 500,
        revision: retried.revision,
      });
      expect(await store.claimNext({
        leaseOwner: 'worker-b',
        nowMs: 499,
        leaseDurationMs: 100,
        excludedLogicalSessionIds: [],
      })).toBeNull();
      // The retry claims on schedule even though the turn lease is still live:
      // backoff, not foreground presence, is the only thing that gated it.
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

  it('durably requeues a blocked pre-effect job on graceful shutdown and completes it exactly once', async () => {
    const database = await harness.createDatabase();
    const firstStore = await PostgresBackgroundWorkStore.connect(database.databaseUrl, {
      schema: 'companion_a',
    });
    const secondStore = await PostgresBackgroundWorkStore.connect(database.databaseUrl, {
      schema: 'companion_a',
    });
    const now = 1_000;
    let firstSinkWrites = 0;
    let secondSinkWrites = 0;
    const providerEntered = deferred();
    const first = createBackgroundWorkSupervisor({
      store: firstStore,
      eventBus: new EventBus(),
      leaseOwner: 'first-replica',
      leaseDurationMs: 60_000,
      shutdownTimeoutMs: 1_000,
      now: () => now,
      executor: async ({ effects, signal }) => {
        providerEntered.resolve();
        // Blocked provider/compute step with zero sink writes. It never reaches
        // its effect boundary; graceful shutdown aborts the claim signal.
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
    const second = createBackgroundWorkSupervisor({
      store: secondStore,
      eventBus: new EventBus(),
      leaseOwner: 'second-replica',
      leaseDurationMs: 60_000,
      now: () => now,
      executor: async ({ effects }) => {
        await effects.run('durable-sink', async (crossBoundary) => {
          await crossBoundary();
          secondSinkWrites += 1;
        });
      },
    });
    const jobId = makeInput('session-a', 'turn-a').jobId;
    try {
      await first.enqueue([makeInput('session-a', 'turn-a')]);
      await first.tick();
      await providerEntered.promise;
      expect(await firstStore.get(jobId)).toMatchObject({ state: 'running' });

      const stopStart = Date.now();
      await first.stop();
      await first.waitForIdle();
      // Bounded: the drain must not wait out anything close to a real lease.
      expect(Date.now() - stopStart).toBeLessThan(10_000);

      // Pre-effect work is durably requeued under its claim token, not lost as
      // effect_outcome_unknown, and the old worker performed no sink write.
      expect(await secondStore.get(jobId)).toMatchObject({
        state: 'queued',
        reasonCode: 'shutdown',
      });
      expect(firstSinkWrites).toBe(0);

      await second.tick();
      await second.waitForIdle();
      expect(await secondStore.get(jobId)).toMatchObject({ state: 'succeeded' });
      expect(secondSinkWrites).toBe(1);
      expect(firstSinkWrites).toBe(0);
    } finally {
      await Promise.allSettled([first.stop(), second.stop()]);
      await Promise.all([firstStore.close(), secondStore.close()]);
    }
  }, 30_000);

  it('keeps a max-attempt pre-boundary claim retryable when the first shutdown requeue fails', async () => {
    const database = await harness.createDatabase();
    const firstStore = await PostgresBackgroundWorkStore.connect(database.databaseUrl, {
      schema: 'companion_a',
    });
    const secondStore = await PostgresBackgroundWorkStore.connect(database.databaseUrl, {
      schema: 'companion_a',
    });
    const originalRequeue = firstStore.requeuePreBoundaryClaims.bind(firstStore);
    let requeueAttempts = 0;
    const requeueSpy = vi.spyOn(firstStore, 'requeuePreBoundaryClaims').mockImplementation(async input => {
      requeueAttempts += 1;
      if (requeueAttempts === 1) throw new Error('injected PostgreSQL requeue failure');
      return originalRequeue(input);
    });
    const providerEntered = deferred();
    const first = createBackgroundWorkSupervisor({
      store: firstStore,
      eventBus: new EventBus(),
      leaseOwner: 'first-replica',
      leaseDurationMs: 60_000,
      shutdownTimeoutMs: 1_000,
      now: () => 1_000,
      executor: async ({ effects, signal }) => {
        providerEntered.resolve();
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        });
        await effects.run('durable-sink', async (crossBoundary) => {
          await crossBoundary();
        });
      },
    });
    let sinkWrites = 0;
    const second = createBackgroundWorkSupervisor({
      store: secondStore,
      eventBus: new EventBus(),
      leaseOwner: 'second-replica',
      now: () => 2_000,
      executor: async ({ effects }) => {
        await effects.run('durable-sink', async (crossBoundary) => {
          await crossBoundary();
          sinkWrites += 1;
        });
      },
    });
    const input = { ...makeInput('session-a', 'turn-a'), maxAttempts: 1 };
    try {
      await first.enqueue([input]);
      await first.tick();
      await providerEntered.promise;
      expect(await firstStore.get(input.jobId)).toMatchObject({ state: 'running', attemptCount: 0 });

      await expect(first.stop()).rejects.toThrow('injected PostgreSQL requeue failure');
      expect(await firstStore.get(input.jobId)).toMatchObject({ state: 'running', attemptCount: 0 });

      await first.stop();
      expect(requeueAttempts).toBe(2);
      expect(await secondStore.get(input.jobId)).toMatchObject({
        state: 'queued',
        reasonCode: 'shutdown',
        attemptCount: 0,
      });

      await second.tick();
      await second.waitForIdle();
      expect(await secondStore.get(input.jobId)).toMatchObject({
        state: 'succeeded',
        attemptCount: 0,
      });
      expect(sinkWrites).toBe(1);
    } finally {
      requeueSpy.mockRestore();
      await Promise.allSettled([first.stop(), second.stop()]);
      await Promise.all([firstStore.close(), secondStore.close()]);
    }
  }, 30_000);

  it('leaves a drain-deferred durable extraction retryable and applies its exact effect once on retry', async () => {
    // Models the u5bv.11 durable receipt outcome end-to-end on a real store: a
    // queued bounded extraction that finds the extractor draining opens its
    // effect (`pending`) then fails closed as retryable BEFORE crossing the
    // boundary. The claim must defer (no consumed attempt), abandon the pending
    // receipt, and stay retryable — and a later accepting run must apply its
    // exact effect exactly once with no duplicate.
    const database = await harness.createDatabase();
    const store = await PostgresBackgroundWorkStore.connect(database.databaseUrl, {
      schema: 'companion_a',
    });
    let nowMs = 1_000;
    let attempts = 0;
    const sinkWrites: string[] = [];
    const supervisor = createBackgroundWorkSupervisor({
      store,
      eventBus: new EventBus(),
      leaseOwner: 'worker',
      leaseDurationMs: 60_000,
      now: () => nowMs,
      executor: async ({ effects }) => {
        attempts += 1;
        if (attempts === 1) {
          await effects.run('memory-extraction', async () => {
            // Drain requeue: the post-turn seam raises a retryable defer before
            // any fact write and before crossing the effect boundary.
            throw new BackgroundWorkDeferredError('source_not_ready', 250);
          });
          return;
        }
        await effects.run('memory-extraction', async (crossBoundary) => {
          await crossBoundary();
          sinkWrites.push('memory');
        });
      },
    });
    const jobId = makeInput('session-drain', 'turn-drain').jobId;
    try {
      await supervisor.enqueue([makeInput('session-drain', 'turn-drain')]);

      // Tick 1: the drain requeue defers the job with no applied effect and no
      // consumed attempt.
      await supervisor.tick();
      await supervisor.waitForIdle();
      expect(await store.get(jobId)).toMatchObject({
        state: 'deferred',
        reasonCode: 'source_not_ready',
        attemptCount: 0,
      });
      expect(sinkWrites).toEqual([]);

      // Tick 2 (after the defer window): the exact snapshot runs once, crosses
      // its boundary, and completes.
      nowMs = 2_000;
      await supervisor.tick();
      await supervisor.waitForIdle();
      expect(await store.get(jobId)).toMatchObject({ state: 'succeeded' });
      expect(sinkWrites).toEqual(['memory']);

      // Tick 3: a succeeded job never re-runs — no duplicate durable effect.
      nowMs = 3_000;
      await supervisor.tick();
      await supervisor.waitForIdle();
      expect(sinkWrites).toEqual(['memory']);
      expect(attempts).toBe(2);
    } finally {
      await supervisor.stop();
      await store.close();
    }
  }, 30_000);

  it('requeues only pre-boundary claims and leaves boundary-crossed claims fail-closed', async () => {
    const database = await harness.createDatabase();
    const store = await PostgresBackgroundWorkStore.connect(database.databaseUrl, {
      schema: 'companion_a',
    });
    try {
      const preInput = makeInput('session-pre', 'turn-pre');
      await store.enqueue(preInput);
      const preClaim = await store.claimNext({
        leaseOwner: 'worker',
        nowMs: 100,
        leaseDurationMs: 10_000,
        excludedLogicalSessionIds: [],
      });
      expect(preClaim?.jobId).toBe(preInput.jobId);
      // Pre-boundary: opened but never crossed (a `pending` receipt only).
      expect(await store.beginEffect({
        jobId: preClaim!.jobId,
        effectKey: 'durable-sink',
        leaseOwner: preClaim!.leaseOwner,
        expectedRevision: preClaim!.revision,
        nowMs: 100,
      })).toBe('execute');

      const crossedInput = makeInput('session-crossed', 'turn-crossed');
      await store.enqueue(crossedInput);
      const crossedClaim = await store.claimNext({
        leaseOwner: 'worker',
        nowMs: 100,
        leaseDurationMs: 10_000,
        excludedLogicalSessionIds: [],
      });
      expect(crossedClaim?.jobId).toBe(crossedInput.jobId);
      await store.beginEffect({
        jobId: crossedClaim!.jobId,
        effectKey: 'durable-sink',
        leaseOwner: crossedClaim!.leaseOwner,
        expectedRevision: crossedClaim!.revision,
        nowMs: 100,
      });
      expect(await store.commitEffectBoundary({
        jobId: crossedClaim!.jobId,
        effectKey: 'durable-sink',
        leaseOwner: crossedClaim!.leaseOwner,
        expectedRevision: crossedClaim!.revision,
        nowMs: 100,
      })).toBe('crossed');

      const requeued = await store.requeuePreBoundaryClaims({
        leaseOwner: 'worker',
        nowMs: 200,
        reasonCode: 'shutdown',
      });
      expect(requeued.map(job => job.jobId)).toEqual([preInput.jobId]);
      expect(await store.get(preInput.jobId)).toMatchObject({ state: 'queued', reasonCode: 'shutdown' });
      // The boundary-crossed claim is never released by the shutdown sweep.
      expect(await store.get(crossedInput.jobId)).toMatchObject({ state: 'running' });

      // It stays fail-closed on lease expiry: outcome remains unknown.
      expect(await store.recoverExpired({ nowMs: 10_200 })).toBe(1);
      expect(await store.get(crossedInput.jobId)).toMatchObject({
        state: 'failed',
        reasonCode: 'effect_outcome_unknown',
      });

      // The requeued pre-boundary job dropped its pending receipt and re-runs
      // cleanly for a fresh owner.
      expect(await store.claimNext({
        leaseOwner: 'fresh-worker',
        nowMs: 200,
        leaseDurationMs: 100,
        excludedLogicalSessionIds: [],
      })).toMatchObject({ jobId: preInput.jobId });
      expect(await store.beginEffect({
        jobId: preInput.jobId,
        effectKey: 'durable-sink',
        leaseOwner: 'fresh-worker',
        expectedRevision: (await store.get(preInput.jobId))!.revision,
        nowMs: 200,
      })).toBe('execute');
    } finally {
      await store.close();
    }
  }, 30_000);

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
      expect(await first.commitEffectBoundary({
        jobId: claim!.jobId,
        effectKey: 'durable-sink',
        leaseOwner: claim!.leaseOwner,
        expectedRevision: claim!.revision,
        nowMs: 100,
      })).toBe('crossed');
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
        projectsSubsystemOutputs: true,
      })).toBe('execute');
      // Cross the durable boundary before the sink write: a crash from here is
      // genuinely outcome-ambiguous and must stay terminal.
      expect(await first.commitEffectBoundary({
        jobId: crashedClaim!.jobId,
        effectKey: 'durable-sink',
        leaseOwner: crashedClaim!.leaseOwner,
        expectedRevision: crashedClaim!.revision,
        nowMs: 200,
      })).toBe('crossed');
      sinkWrites += 1;
      expect(await second.recoverExpired({ nowMs: 211 })).toBe(1);
      expect(await second.get(crashedInput.jobId)).toMatchObject({
        state: 'failed',
        reasonCode: 'effect_outcome_unknown',
      });
      await expect(second.listSubsystemOutputRefs({
        logicalSessionId: crashedInput.logicalSessionId,
        sourceChannelId: crashedInput.sourceChannelId,
        sourceTurnId: crashedInput.sourceTurnId,
        sourceRequestId: crashedInput.sourceRequestId,
      })).resolves.toEqual([]);
      await expect(second.getSubsystemOutputProjection({
        logicalSessionId: crashedInput.logicalSessionId,
        sourceChannelId: crashedInput.sourceChannelId,
        sourceTurnId: crashedInput.sourceTurnId,
        sourceRequestId: crashedInput.sourceRequestId,
      })).resolves.toEqual({ status: 'outcome_unknown', outputRefs: [] });
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

  it('never deletes a boundary-crossed effect receipt on abandon', async () => {
    const database = await harness.createDatabase();
    const store = await PostgresBackgroundWorkStore.connect(database.databaseUrl, {
      schema: 'companion_a',
    });
    const inspectionPool = createPostgresPool(database.databaseUrl, {
      schema: 'companion_a',
      max: 2,
    });
    try {
      // A boundary-crossed (`started`) receipt is durable evidence that a write
      // may have landed. A post-write handler exception requests abandon, but
      // deleting it would let a retry replay the write and duplicate the durable
      // effect (u5bv.6). abandonEffect must leave it in place.
      const crossedInput = makeInput('session-abandon-started', 'turn-abandon-started');
      await store.enqueue(crossedInput);
      const crossedClaim = await store.claimNext({
        leaseOwner: 'worker',
        nowMs: 100,
        leaseDurationMs: 10_000,
        excludedLogicalSessionIds: [],
      });
      await store.beginEffect({
        jobId: crossedClaim!.jobId,
        effectKey: 'durable-sink',
        leaseOwner: crossedClaim!.leaseOwner,
        expectedRevision: crossedClaim!.revision,
        nowMs: 100,
      });
      expect(await store.commitEffectBoundary({
        jobId: crossedClaim!.jobId,
        effectKey: 'durable-sink',
        leaseOwner: crossedClaim!.leaseOwner,
        expectedRevision: crossedClaim!.revision,
        nowMs: 100,
      })).toBe('crossed');
      await store.abandonEffect({
        jobId: crossedClaim!.jobId,
        effectKey: 'durable-sink',
        leaseOwner: crossedClaim!.leaseOwner,
        expectedRevision: crossedClaim!.revision,
        nowMs: 100,
      });
      const crossedReceipts = await inspectionPool.query<{ state: string }>(`
        SELECT state FROM agent_background_work_effect_receipts
        WHERE job_id = $1 AND effect_key = $2
      `, [crossedClaim!.jobId, 'durable-sink']);
      expect(crossedReceipts.rows).toEqual([{ state: 'started' }]);

      // A `pending` receipt, by contrast, proves no write was attempted, so it
      // is safely abandonable into a cleanly re-runnable state.
      const pendingInput = makeInput('session-abandon-pending', 'turn-abandon-pending');
      await store.enqueue(pendingInput);
      const pendingClaim = await store.claimNext({
        leaseOwner: 'worker',
        nowMs: 100,
        leaseDurationMs: 10_000,
        excludedLogicalSessionIds: [],
      });
      expect(await store.beginEffect({
        jobId: pendingClaim!.jobId,
        effectKey: 'durable-sink',
        leaseOwner: pendingClaim!.leaseOwner,
        expectedRevision: pendingClaim!.revision,
        nowMs: 100,
      })).toBe('execute');
      await store.abandonEffect({
        jobId: pendingClaim!.jobId,
        effectKey: 'durable-sink',
        leaseOwner: pendingClaim!.leaseOwner,
        expectedRevision: pendingClaim!.revision,
        nowMs: 100,
      });
      const pendingReceipts = await inspectionPool.query(`
        SELECT state FROM agent_background_work_effect_receipts
        WHERE job_id = $1 AND effect_key = $2
      `, [pendingClaim!.jobId, 'durable-sink']);
      expect(pendingReceipts.rows).toEqual([]);
    } finally {
      await inspectionPool.end();
      await store.close();
    }
  }, 30_000);

  it('writes a durable multi-write effect exactly once across a post-write exception and retry', async () => {
    const database = await harness.createDatabase();
    const store = await PostgresBackgroundWorkStore.connect(database.databaseUrl, {
      schema: 'companion_a',
    });
    const sinkPool = createPostgresPool(database.databaseUrl, {
      schema: 'companion_a',
      max: 2,
    });
    await sinkPool.query(`
      CREATE TABLE duplicate_probe_effects (
        id BIGSERIAL PRIMARY KEY,
        job_id TEXT NOT NULL
      )
    `);
    let sinkWrites = 0;
    let now = 1_000;
    const supervisor = createBackgroundWorkSupervisor({
      store,
      eventBus: new EventBus(),
      now: () => now,
      leaseOwner: 'worker',
      retryBaseDelayMs: 10,
      executor: async ({ job, effects }) => {
        await effects.run('durable-sink', async (crossBoundary) => {
          // First durable write of a multi-write effect: cross the boundary,
          // land one sink row, then throw as a later write in the same handler
          // fails. The receipt is now `started` (outcome-ambiguous).
          await crossBoundary();
          await sinkPool.query(
            'INSERT INTO duplicate_probe_effects (job_id) VALUES ($1)',
            [job.jobId],
          );
          sinkWrites += 1;
          throw new Error('mid-multi-write failure');
        });
      },
    });
    try {
      const input = makeInput('session-dup', 'turn-dup');
      await supervisor.enqueue([input]);
      await supervisor.tick();
      await supervisor.waitForIdle();
      // The first attempt landed exactly one row and then failed; the job is
      // scheduled for retry. A real supervisor + Postgres store + durable sink.
      expect(sinkWrites).toBe(1);

      now += 10_000;
      await supervisor.tick();
      await supervisor.waitForIdle();

      // The retry must fail closed on the surviving `started` receipt instead of
      // replaying the write: exactly one durable sink row across the retry.
      const rows = await sinkPool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM duplicate_probe_effects',
      );
      expect(rows.rows[0]!.n).toBe(1);
      expect(sinkWrites).toBe(1);
      expect(await store.get(input.jobId)).toMatchObject({
        state: 'failed',
        reasonCode: 'effect_outcome_unknown',
      });
    } finally {
      await supervisor.stop();
      await sinkPool.end();
      await store.close();
    }
  }, 30_000);

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
      if (!await reader.isSourceTurnRecordEligible(
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

      // A duplicate canonical source under a DIFFERENT claimed owner is the
      // equivalent uniqueness revocation. The append's owner-B fence must
      // serialize with a consumer holding owner A for the same TurnID.
      const duplicateFirst = await prepareClaim('session-duplicate-first', createTurnId());
      const consumerHeld = deferred();
      const allowConsumerRelease = deferred();
      const heldConsumer = firstFence.withTurnRecordEligibilityFence({
        logicalSessionId: duplicateFirst.record.sessionId!,
        turnId: duplicateFirst.record.turnId,
      }, async () => {
        consumerHeld.resolve();
        await allowConsumerRelease.promise;
      });
      await consumerHeld.promise;
      let crossOwnerAppendCompleted = false;
      const crossOwnerDuplicate = writer.appendTurnRecord({
        ...duplicateFirst.record,
        sessionId: 'session-duplicate-second-owner',
        requestId: `${duplicateFirst.record.requestId}-duplicate`,
      }).then(() => {
        crossOwnerAppendCompleted = true;
      });
      await new Promise(resolve => setImmediate(resolve));
      expect(crossOwnerAppendCompleted).toBe(false);
      allowConsumerRelease.resolve();
      await Promise.all([heldConsumer, crossOwnerDuplicate]);
      expect(crossOwnerAppendCompleted).toBe(true);

      const rejectedDuplicateEffect = persistClaimedEffect(
        duplicateFirst.claim,
        duplicateFirst.record,
      );
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

  it('rechecks a bounded cross-turn snapshot after every consumed TurnRecord fence is held', async () => {
    const database = await harness.createDatabase();
    const consumerPool = createPostgresPool(database.databaseUrl, {
      schema: 'companion_a',
      max: 2,
    });
    const writerPool = createPostgresPool(database.databaseUrl, {
      schema: 'companion_a',
      max: 2,
    });
    const inspectionPool = createPostgresPool(database.databaseUrl, {
      schema: 'companion_a',
      max: 2,
    });
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-background-consumed-fence-'));
    const consumerFence = new PostgresTurnRecordEligibilityFence(consumerPool, 'companion_a');
    const writerFence = new PostgresTurnRecordEligibilityFence(writerPool, 'companion_a');
    const consumer = new SessionStore(sessionsDir, { turnRecordEligibilityFence: consumerFence });
    const writer = new SessionStore(sessionsDir, { turnRecordEligibilityFence: writerFence });
    const unfencedWriter = new SessionStore(sessionsDir);
    const logicalSessionId = 'api:cross-turn-consumed-fence';
    const olderTurnId = createTurnId();
    const sourceTurnId = createTurnId();
    const privateOlderContent = 'PRIVATE-OLDER-TURN-MUST-NOT-SURVIVE';

    const appendTurn = async (
      turnId: TurnRecord['turnId'],
      content: string,
      timestamp: number,
    ): Promise<void> => {
      consumer.append({
        channelId: logicalSessionId,
        role: 'user',
        content,
        timestamp,
        metadata: buildSessionMetadataWithTurn(undefined, {
          turnId,
          requestId: `request-${turnId}`,
          role: 'user',
          actorKind: 'human',
        }),
      });
      await consumer.appendTurnRecord(makeCanonicalTurnRecord(
        logicalSessionId,
        turnId,
        `response-${turnId}`,
      ));
    };

    try {
      await ensurePostgresSchemaExists(inspectionPool, 'companion_a');
      await inspectionPool.query(`
        CREATE TABLE companion_a.cross_turn_derived_effects (
          id BIGSERIAL PRIMARY KEY,
          content TEXT NOT NULL
        )
      `);
      await appendTurn(olderTurnId, privateOlderContent, 50);
      await appendTurn(sourceTurnId, 'source turn B', 60);

      const redactionHeld = deferred();
      const allowRedaction = deferred();
      const redaction = writerFence.withTurnRecordEligibilityFence({
        logicalSessionId,
        turnId: olderTurnId,
      }, async () => {
        redactionHeld.resolve();
        await allowRedaction.promise;
        await unfencedWriter.redactTurn(logicalSessionId, olderTurnId, {
          actor: 'operator:test',
          reason: 'privacy revocation',
        });
      });
      await redactionHeld.promise;

      let initialReadCompleted = false;
      const staleAttempt = consumer.withStableTurnRecordEligibilitySnapshot(
        logicalSessionId,
        [sourceTurnId],
        () => {
          const entries = consumer.getRecent(logicalSessionId, 10);
          initialReadCompleted = true;
          return entries;
        },
        async (entries) => {
          await inspectionPool.query(
            'INSERT INTO companion_a.cross_turn_derived_effects (content) VALUES ($1)',
            [entries.map(entry => entry.content).join('|')],
          );
        },
      );
      expect(initialReadCompleted).toBe(true);
      allowRedaction.resolve();
      await redaction;
      await expect(staleAttempt).rejects.toThrow('TurnRecord eligibility snapshot changed');

      await consumer.withStableTurnRecordEligibilitySnapshot(
        logicalSessionId,
        [sourceTurnId],
        () => consumer.getRecent(logicalSessionId, 10),
        async (entries) => {
          await inspectionPool.query(
            'INSERT INTO companion_a.cross_turn_derived_effects (content) VALUES ($1)',
            [entries.map(entry => entry.content).join('|')],
          );
        },
      );

      const effects = await inspectionPool.query<{ content: string }>(
        'SELECT content FROM companion_a.cross_turn_derived_effects ORDER BY id',
      );
      expect(effects.rows).toHaveLength(1);
      expect(effects.rows[0]?.content).not.toContain(privateOlderContent);

      await writer.restoreTurn(logicalSessionId, olderTurnId, {
        actor: 'operator:test',
        reason: 'approved restore',
      });
      const effectEntered = deferred();
      const allowEffect = deferred();
      const effectFirst = consumer.withStableTurnRecordEligibilitySnapshot(
        logicalSessionId,
        [sourceTurnId],
        () => consumer.getRecent(logicalSessionId, 10),
        async () => {
          effectEntered.resolve();
          await allowEffect.promise;
        },
      );
      await effectEntered.promise;
      let restoreCompleted = false;
      const competingRestore = writer.restoreTurn(logicalSessionId, olderTurnId, {
        actor: 'operator:test',
        reason: 'second approved restore',
      }).then(() => { restoreCompleted = true; });
      await new Promise(resolve => setImmediate(resolve));
      expect(restoreCompleted).toBe(false);
      allowEffect.resolve();
      await Promise.all([effectFirst, competingRestore]);

      // Reverse caller order cannot create AB-BA because the Postgres adapter
      // canonicalizes every bounded set before acquiring it. Ten repetitions
      // stress the exact overlap pattern that would deadlock without that order.
      for (let iteration = 0; iteration < 10; iteration += 1) {
        const firstEntered = deferred();
        const releaseFirst = deferred();
        const first = consumerFence.withTurnRecordEligibilityFences([
          { logicalSessionId, turnId: sourceTurnId },
          { logicalSessionId, turnId: olderTurnId },
        ], async () => {
          firstEntered.resolve();
          await releaseFirst.promise;
        });
        await firstEntered.promise;
        const second = writerFence.withTurnRecordEligibilityFences([
          { logicalSessionId, turnId: olderTurnId },
          { logicalSessionId, turnId: sourceTurnId },
        ], async () => undefined);
        releaseFirst.resolve();
        await Promise.all([first, second]);
      }

      const unrelatedSessionCompleted = consumerFence.withTurnRecordEligibilityFences([
        { logicalSessionId, turnId: olderTurnId },
        { logicalSessionId, turnId: sourceTurnId },
      ], async () => writerFence.withTurnRecordEligibilityFences([{
        logicalSessionId: 'api:unrelated-session',
        turnId: createTurnId(),
      }], async () => true));
      await expect(unrelatedSessionCompleted).resolves.toBe(true);

      await writer.appendTurnRecord(makeCanonicalTurnRecord(
        logicalSessionId,
        olderTurnId,
        `response-${olderTurnId}`,
      ));
      let duplicateEffectRan = false;
      await expect(consumer.withStableTurnRecordEligibilitySnapshot(
        logicalSessionId,
        [sourceTurnId],
        () => consumer.getRecent(logicalSessionId, 10),
        async () => { duplicateEffectRan = true; },
      )).rejects.toThrow('Consumed TurnRecord is duplicated, tombstoned');
      expect(duplicateEffectRan).toBe(false);
    } finally {
      rmSync(sessionsDir, { recursive: true, force: true });
      await Promise.all([
        consumerPool.end(),
        writerPool.end(),
        inspectionPool.end(),
      ]);
    }
  }, 30_000);

  it('projects failed ICP output before choosing snapshot fences and rechecks delivery truth under lock', async () => {
    const database = await harness.createDatabase();
    const consumerPool = createPostgresPool(database.databaseUrl, {
      schema: 'companion_a',
      max: 2,
    });
    const writerPool = createPostgresPool(database.databaseUrl, {
      schema: 'companion_a',
      max: 2,
    });
    const inspectionPool = createPostgresPool(database.databaseUrl, {
      schema: 'companion_a',
      max: 2,
    });
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-background-icp-projected-fence-'));
    const consumerFence = new PostgresTurnRecordEligibilityFence(consumerPool, 'companion_a');
    const writerFence = new PostgresTurnRecordEligibilityFence(writerPool, 'companion_a');
    const consumerStore = new SessionStore(sessionsDir, {
      turnRecordEligibilityFence: consumerFence,
    });
    const writerStore = new SessionStore(sessionsDir, {
      turnRecordEligibilityFence: writerFence,
    });
    const config = {
      dataDir: sessionsDir,
      companionDataDir: sessionsDir,
      sessionMessageLimit: 30,
      memoryRetrievalLimit: 15,
      extractionInterval: 5,
      maintenanceIntervalMs: 300_000,
      defaultContextWindow: 128_000,
      extractionThresholdPct: 30,
      compactionThresholdPct: 70,
      modelRoster: {
        chat: { provider: 'test', model: 'test', contextWindow: 128_000, maxTokens: 4_096 },
      },
    } as SubstrateConfig;
    const consumer = new SessionManager(consumerStore, config);
    const writer = new SessionManager(writerStore, config);
    const failedTurnId = icpCorrelation.turnId;
    const successfulTurnId = createTurnId();
    const failedContent = 'FAILED ICP A MUST NOT ENTER THE PROJECTED POST-TURN SINK';

    try {
      await ensurePostgresSchemaExists(inspectionPool, 'companion_a');
      await inspectionPool.query(`
        CREATE TABLE companion_a.projected_background_effects (
          id BIGSERIAL PRIMARY KEY,
          content TEXT NOT NULL
        )
      `);
      consumer.recordAssistantMessage(
        ICP_CHANNEL,
        failedContent,
        'contact-peer',
        true,
        'contact-peer',
        {
          turnId: failedTurnId,
          requestId: ICP_SOURCE,
          sourceMessageId: ICP_SOURCE,
          metadata: buildSessionMetadataWithIcpCorrelation(
            undefined,
            icpCorrelation,
            { deliveryStatus: 'pending', recoveryResponse: icpRecoveryResponse },
          ),
        },
      );
      consumer.recordIcpDeliveryObservation({
        channelId: ICP_CHANNEL,
        sourceMessageId: ICP_SOURCE,
        status: 'failed',
        error: 'peer unavailable',
        recoveryResponse: icpRecoveryResponse,
      });
      consumer.recordUserMessage(
        ICP_CHANNEL,
        'successful B input',
        'human-b',
        'Human B',
        true,
        undefined,
        {
          turnId: successfulTurnId,
          requestId: `request-${successfulTurnId}`,
        },
      );
      const successfulEntryId = consumer.recordAssistantMessage(
        ICP_CHANNEL,
        'successful B output',
        undefined,
        true,
        undefined,
        {
          turnId: successfulTurnId,
          requestId: `request-${successfulTurnId}`,
        },
      );
      expect(successfulEntryId).not.toBeNull();
      await consumer.recordTurn(makeCanonicalTurnRecord(
        ICP_CHANNEL,
        failedTurnId,
        failedContent,
      ));
      await consumer.recordTurn(makeCanonicalTurnRecord(
        ICP_CHANNEL,
        successfulTurnId,
        'successful B output',
      ));

      const readSnapshot = () => consumer.getRecentMessagesAtOrBefore(
        ICP_CHANNEL,
        successfulEntryId!,
        10,
      );
      const effectEntered = deferred();
      const allowEffect = deferred();
      const effect = consumer.withStableRecordedTurnEligibilitySnapshot(
        ICP_CHANNEL,
        [successfulTurnId],
        readSnapshot,
        async (entries) => {
          effectEntered.resolve();
          await allowEffect.promise;
          await inspectionPool.query(
            'INSERT INTO companion_a.projected_background_effects (content) VALUES ($1)',
            [entries.map(entry => entry.content).join('|')],
          );
        },
      );
      await effectEntered.promise;

      let failedFenceCompleted = false;
      const failedFence = writerFence.withTurnRecordEligibilityFence({
        logicalSessionId: ICP_CHANNEL,
        turnId: failedTurnId,
      }, async () => { failedFenceCompleted = true; });
      let successfulFenceCompleted = false;
      const successfulFence = writerFence.withTurnRecordEligibilityFence({
        logicalSessionId: ICP_CHANNEL,
        turnId: successfulTurnId,
      }, async () => { successfulFenceCompleted = true; });
      try {
        await waitForPostgresCondition(async () => failedFenceCompleted);
        expect(successfulFenceCompleted).toBe(false);
      } finally {
        allowEffect.resolve();
        await Promise.all([effect, failedFence, successfulFence]);
      }

      const successfulFenceHeld = deferred();
      const releaseSuccessfulFence = deferred();
      const heldSuccessfulFence = writerFence.withTurnRecordEligibilityFence({
        logicalSessionId: ICP_CHANNEL,
        turnId: successfulTurnId,
      }, async () => {
        successfulFenceHeld.resolve();
        await releaseSuccessfulFence.promise;
      });
      await successfulFenceHeld.promise;
      let snapshotReads = 0;
      let changedSnapshotEffectRan = false;
      const changedSnapshot = consumer.withStableRecordedTurnEligibilitySnapshot(
        ICP_CHANNEL,
        [successfulTurnId],
        () => {
          snapshotReads += 1;
          return readSnapshot();
        },
        async () => { changedSnapshotEffectRan = true; },
      );
      expect(snapshotReads).toBe(1);
      writer.recordIcpDeliveryObservation({
        channelId: ICP_CHANNEL,
        sourceMessageId: ICP_SOURCE,
        status: 'delivered',
        gatewayMessageId: 'companion:projected-race-delivery',
        deliveredTo: ['22222222-2222-4222-8222-222222222222'],
        permitOutcome: 'consumed',
        recoveryResponse: icpRecoveryResponse,
      });
      const changedSnapshotRejection = expect(changedSnapshot).rejects.toThrow(
        'TurnRecord eligibility snapshot changed',
      );
      releaseSuccessfulFence.resolve();
      await heldSuccessfulFence;
      await changedSnapshotRejection;
      expect(snapshotReads).toBe(2);
      expect(changedSnapshotEffectRan).toBe(false);

      const effects = await inspectionPool.query<{ content: string }>(
        'SELECT content FROM companion_a.projected_background_effects ORDER BY id',
      );
      expect(effects.rows).toEqual([{
        content: 'successful B input|successful B output',
      }]);
      expect(JSON.stringify(effects.rows)).not.toContain(failedContent);
    } finally {
      rmSync(sessionsDir, { recursive: true, force: true });
      await Promise.all([
        consumerPool.end(),
        writerPool.end(),
        inspectionPool.end(),
      ]);
    }
  }, 30_000);

  it('keeps an empty bounded snapshot authoritative while live A/C history is redacted', async () => {
    const database = await harness.createDatabase();
    const consumerPool = createPostgresPool(database.databaseUrl, {
      schema: 'companion_a',
      max: 2,
    });
    const writerPool = createPostgresPool(database.databaseUrl, {
      schema: 'companion_a',
      max: 2,
    });
    const inspectionPool = createPostgresPool(database.databaseUrl, {
      schema: 'companion_a',
      max: 2,
    });
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-background-empty-snapshot-'));
    const consumer = new SessionStore(sessionsDir, {
      turnRecordEligibilityFence: new PostgresTurnRecordEligibilityFence(
        consumerPool,
        'companion_a',
      ),
    });
    const writer = new SessionStore(sessionsDir, {
      turnRecordEligibilityFence: new PostgresTurnRecordEligibilityFence(
        writerPool,
        'companion_a',
      ),
    });
    const logicalSessionId = 'api:empty-bounded-snapshot';
    const turnA = createTurnId();
    const sourceTurnB = createTurnId();
    const turnC = createTurnId();
    const privateTurnA = 'PRIVATE-TURN-A-MUST-NOT-REACH-THE-MEMORY-SINK';

    const appendTurn = async (
      turnId: TurnRecord['turnId'],
      content: string,
      timestamp: number,
    ): Promise<void> => {
      consumer.append({
        channelId: logicalSessionId,
        role: 'user',
        content,
        timestamp,
        authorName: 'Partner',
        metadata: buildSessionMetadataWithTurn(undefined, {
          turnId,
          requestId: `request-${turnId}`,
          role: 'user',
          actorKind: 'human',
        }),
      });
      await consumer.appendTurnRecord(makeCanonicalTurnRecord(
        logicalSessionId,
        turnId,
        `response-${turnId}`,
      ));
    };

    try {
      await ensurePostgresSchemaExists(inspectionPool, 'companion_a');
      await inspectionPool.query(`
        CREATE TABLE companion_a.empty_snapshot_memory_effects (
          id BIGSERIAL PRIMARY KEY,
          content TEXT NOT NULL
        )
      `);
      await appendTurn(turnA, privateTurnA, 50);
      await appendTurn(sourceTurnB, 'Authoritative source turn B has no recovered content.', 60);
      await appendTurn(turnC, 'Newer live turn C must remain outside the B fence.', 70);
      expect(consumer.getRecent(logicalSessionId, 10).map(entry => entry.content)).toEqual([
        privateTurnA,
        'Authoritative source turn B has no recovered content.',
        'Newer live turn C must remain outside the B fence.',
      ]);

      const liveHistoryRead = deferred();
      const redactionFinished = deferred();
      const getRecentMessages = vi.fn(() => {
        const entries = consumer.getRecent(logicalSessionId, 10);
        liveHistoryRead.resolve();
        return entries;
      });
      const complete = vi.fn(async () => {
        await redactionFinished.promise;
        return {
          content: `<response>
<fact>
<text>${privateTurnA}</text>
<type>semantic</type>
<importance>0.9</importance>
<confidence>0.95</confidence>
</fact>
</response>`,
        };
      });
      const processFact = vi.fn(async (fact: { text: string }) => {
        await inspectionPool.query(
          'INSERT INTO companion_a.empty_snapshot_memory_effects (content) VALUES ($1)',
          [fact.text],
        );
        return { action: 'created', memory: { id: 'memory-from-empty-snapshot' } };
      }) as ExtractionRunOptions['processFact'];

      const extraction = consumer.withStableTurnRecordEligibilitySnapshot(
        logicalSessionId,
        [sourceTurnB],
        () => [],
        async entries => runExtractionOrchestration({
          channelId: logicalSessionId,
          triggerReason: 'interval',
          turnId: sourceTurnB,
          sourceSessionId: logicalSessionId,
          recoveredEntries: [...entries],
          llmClient: { complete } as ExtractionRunOptions['llmClient'],
          sessionManager: {
            getRecentMessages,
            characterName: 'Purrsephone',
          } as ExtractionRunOptions['sessionManager'],
          memoryStore: {
            getMemoriesByChannel: vi.fn().mockResolvedValue([]),
          } as ExtractionRunOptions['memoryStore'],
          promptRegistry: null,
          gateConfig: { minImportance: 0, minConfidence: 0, minNovelty: 0 },
          maxWrites: 3,
          telemetryEnabled: true,
          useCompositionalExtraction: false,
          isAcceptingExtractions: () => true,
          processFact,
          emitExtractionStart: async () => undefined,
          emitExtractionEnd: async () => undefined,
          resolveCoveredUpToMessageId: (_channelId, entriesToCover) =>
            entriesToCover.at(-1)?.id ?? null,
          recordExtractionMarker: () => undefined,
          maybePersistEmotionalState: () => undefined,
          maybeRefreshContactProfile: () => undefined,
        }),
      );

      const firstOutcome = await Promise.race([
        liveHistoryRead.promise.then(() => 'live_history_read' as const),
        extraction.then(() => 'bounded_extraction_completed' as const),
      ]);
      await writer.redactTurn(logicalSessionId, turnA, {
        actor: 'operator:test',
        reason: 'privacy revocation during empty-snapshot extraction',
      });
      redactionFinished.resolve();
      await extraction;

      expect(firstOutcome).toBe('bounded_extraction_completed');
      expect(getRecentMessages).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
      expect(processFact).not.toHaveBeenCalled();
      const effects = await inspectionPool.query<{ content: string }>(
        'SELECT content FROM companion_a.empty_snapshot_memory_effects ORDER BY id',
      );
      expect(effects.rows).toEqual([]);
      expect(consumer.getRecent(logicalSessionId, 10).map(entry => entry.content))
        .not.toContain(privateTurnA);
    } finally {
      rmSync(sessionsDir, { recursive: true, force: true });
      await Promise.all([
        consumerPool.end(),
        writerPool.end(),
        inspectionPool.end(),
      ]);
    }
  }, 30_000);

  it('runs a delayed lower-gap durable snapshot after a higher out-of-order snapshot advanced coverage', async () => {
    const database = await harness.createDatabase();
    const consumerPool = createPostgresPool(database.databaseUrl, {
      schema: 'companion_a',
      max: 2,
    });
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-background-noncontiguous-'));
    const consumerStore = new SessionStore(sessionsDir, {
      turnRecordEligibilityFence: new PostgresTurnRecordEligibilityFence(
        consumerPool,
        'companion_a',
      ),
    });
    const config = {
      dataDir: sessionsDir,
      companionDataDir: sessionsDir,
      sessionMessageLimit: 30,
      memoryRetrievalLimit: 15,
      extractionInterval: 4,
      maintenanceIntervalMs: 300_000,
      defaultContextWindow: 128_000,
      extractionThresholdPct: 30,
      compactionThresholdPct: 70,
      modelRoster: {
        chat: { provider: 'test', model: 'test', contextWindow: 128_000, maxTokens: 4_096 },
      },
    } as SubstrateConfig;
    const consumer = new SessionManager(consumerStore, config);
    const channelId = 'api:noncontiguous-durable';

    try {
      // Record twenty real conversational turns; capture their live entry ids
      // (which are non-contiguous in a real store — turn/marker rows burn ids).
      const entryIds: number[] = [];
      for (let n = 1; n <= 20; n++) {
        const id = consumer.recordUserMessage(
          channelId,
          `I am planning a Kyoto trip detail ${n} for my vacation.`,
          `human-${n}`,
          `Human ${n}`,
          true,
          undefined,
          { turnId: createTurnId(), requestId: `req-noncontiguous-${n}` },
        );
        expect(id).not.toBeNull();
        entryIds.push(id!);
      }

      const llmClient = {
        complete: vi.fn().mockResolvedValue({ content: '<response></response>' }),
      } as never;
      const memoryStore = {
        getMemoriesByChannel: vi.fn().mockResolvedValue([]),
      } as never;
      const embeddingService = {
        embed: vi.fn().mockResolvedValue(new Float32Array(8)),
        embedBatch: vi.fn(),
        dims: 8,
      } as never;
      const eventBus = { emit: vi.fn().mockResolvedValue(undefined) } as never;
      const extractor = new MemoryExtractor(
        llmClient,
        consumer,
        memoryStore,
        embeddingService,
        eventBus,
        { extractionInterval: 4 },
      );

      // Fenced bounded snapshots exactly as the durable post-turn handler takes
      // them: getRecentMessagesAtOrBefore(anchor, 10).
      const snapshotEndingAt = (index: number) =>
        consumer.getRecentMessagesAtOrBefore(channelId, entryIds[index]!, 10);
      const runBounded = (index: number) => extractor.maybeExtract(
        channelId, undefined, undefined, undefined, undefined, undefined,
        snapshotEndingAt(index),
      );

      // B durably extracts the first four entries.
      await runBounded(3);
      // J runs out of order and durably extracts the last ten, advancing coverage
      // past the still-unprocessed 5-10 gap.
      await runBounded(19);
      expect(llmClient.complete).toHaveBeenCalledTimes(2);

      // The delayed C-E snapshot (ids 5-10, anchored at the tenth entry) must
      // still produce a real extraction receipt — the single-max watermark
      // reported zero uncovered here and completed as a durable no-op.
      await runBounded(9);
      expect(llmClient.complete).toHaveBeenCalledTimes(3);

      // Exactly once: reprocessing the same gap is now a durable no-op.
      await runBounded(9);
      expect(llmClient.complete).toHaveBeenCalledTimes(3);
    } finally {
      rmSync(sessionsDir, { recursive: true, force: true });
      await consumerPool.end();
    }
  }, 30_000);

  it('reaches a configured interval above ten from bounded post-turn snapshots', async () => {
    // Regression for psfn-framework-u5bv.10: with a fixed ten-entry bounded
    // snapshot a configured interval of 11-50 could never accumulate enough
    // uncovered entries to interval-fire, so every durable receipt completed as a
    // no-op and memory extraction silently never ran for those configs. The
    // snapshot must now follow the interval so it stays reachable, still firing
    // only from the fenced snapshot (never a newer live-history read) and
    // consuming each uncovered entry exactly once.
    const database = await harness.createDatabase();
    const consumerPool = createPostgresPool(database.databaseUrl, {
      schema: 'companion_a',
      max: 2,
    });
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-background-interval-reach-'));
    const consumerStore = new SessionStore(sessionsDir, {
      turnRecordEligibilityFence: new PostgresTurnRecordEligibilityFence(
        consumerPool,
        'companion_a',
      ),
    });
    const config = {
      dataDir: sessionsDir,
      companionDataDir: sessionsDir,
      sessionMessageLimit: 80,
      memoryRetrievalLimit: 15,
      extractionInterval: 25,
      maintenanceIntervalMs: 300_000,
      defaultContextWindow: 128_000,
      extractionThresholdPct: 30,
      compactionThresholdPct: 70,
      modelRoster: {
        chat: { provider: 'test', model: 'test', contextWindow: 128_000, maxTokens: 4_096 },
      },
    } as SubstrateConfig;
    const consumer = new SessionManager(consumerStore, config);
    const channelId = 'api:interval-reach-durable';

    try {
      const entryIds: number[] = [];
      for (let n = 1; n <= 26; n++) {
        const id = consumer.recordUserMessage(
          channelId,
          `I am mapping out a museum itinerary detail ${n} for the group visit.`,
          `human-${n}`,
          `Human ${n}`,
          true,
          undefined,
          { turnId: createTurnId(), requestId: `req-interval-reach-${n}` },
        );
        expect(id).not.toBeNull();
        entryIds.push(id!);
      }

      const llmClient = {
        complete: vi.fn().mockResolvedValue({ content: '<response></response>' }),
      } as never;
      const memoryStore = {
        getMemoriesByChannel: vi.fn().mockResolvedValue([]),
      } as never;
      const embeddingService = {
        embed: vi.fn().mockResolvedValue(new Float32Array(8)),
        embedBatch: vi.fn(),
        dims: 8,
      } as never;
      const eventBus = { emit: vi.fn().mockResolvedValue(undefined) } as never;
      const extractor = new MemoryExtractor(
        llmClient,
        consumer,
        memoryStore,
        embeddingService,
        eventBus,
        { extractionInterval: 25 },
      );

      // The handler sizes the bounded snapshot to the interval, not a fixed ten.
      const snapshotLimit = extractor.getBoundedExtractionSnapshotLimit();
      expect(snapshotLimit).toBe(25);

      // No live-history fallback: a fenced snapshot must never trigger a newer read.
      const liveSpy = vi.spyOn(consumer, 'getRecentMessages');

      // Exactly the durable post-turn handler's read, now interval-sized.
      const snapshotEndingAt = (index: number) =>
        consumer.getRecentMessagesAtOrBefore(channelId, entryIds[index]!, snapshotLimit);
      const runBounded = (index: number) => extractor.maybeExtract(
        channelId, undefined, undefined, undefined, undefined, undefined,
        snapshotEndingAt(index),
      );

      // Under the old fixed-ten window this snapshot held at most ten entries and
      // never reached twenty-five; a snapshot of only twenty-four uncovered
      // entries must still not fire (fires at the configured count, not earlier).
      await runBounded(23);
      expect(llmClient.complete).not.toHaveBeenCalled();

      // Twenty-five uncovered bounded entries reach the interval and fire once.
      await runBounded(24);
      expect(llmClient.complete).toHaveBeenCalledTimes(1);

      // Exactly once: the same fenced snapshot is now fully covered and re-running
      // it is a durable no-op, never double-counting the consumed entries.
      await runBounded(24);
      expect(llmClient.complete).toHaveBeenCalledTimes(1);

      expect(liveSpy).not.toHaveBeenCalled();
    } finally {
      rmSync(sessionsDir, { recursive: true, force: true });
      await consumerPool.end();
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

  it('projects a completed production turn through real extraction into Garden detail', async () => {
    const database = await harness.createDatabase();
    const backgroundStore = await PostgresBackgroundWorkStore.connect(database.databaseUrl, {
      schema: 'companion_a',
    });
    const fencePool = createPostgresPool(database.databaseUrl, {
      schema: 'companion_a',
      max: 2,
    });
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-output-projection-e2e-'));
    const sessionStore = new SessionStore(sessionsDir, {
      turnRecordEligibilityFence: new PostgresTurnRecordEligibilityFence(
        fencePool,
        'companion_a',
      ),
    });
    const config = {
      dataDir: sessionsDir,
      companionDataDir: sessionsDir,
      workspacePath: sessionsDir,
      sessionMessageLimit: 30,
      memoryRetrievalLimit: 15,
      extractionInterval: 1,
      maintenanceIntervalMs: 300_000,
      defaultContextWindow: 128_000,
      extractionThresholdPct: 30,
      compactionThresholdPct: 70,
      modelRoster: {
        chat: { provider: 'test', model: 'test', contextWindow: 128_000, maxTokens: 4_096 },
      },
    } as SubstrateConfig;
    const sessionManager = new SessionManager(sessionStore, config);
    const eventBus = new EventBus();
    const memoryBackend = new InMemoryMemoryStore();
    const memoryStore = memoryBackend.asPort();
    const { store: contactStore } = await createTestPostgresContactStore('primary-owner');
    const contact = await contactStore.upsert({
      displayName: 'Alex',
      relationshipType: 'friend',
    });
    const intention = createTestPostgresIntentionPorts({
      now: () => new Date('2026-07-16T12:00:00.000Z'),
    }).ports;
    const llmProvider = {
      complete: vi.fn(async () => ({
        content: `<response>
<fact>
<text>Alex felt worried and asked for a check in tomorrow about the appointment.</text>
<type>emotional</type>
<importance>0.9</importance>
<emotional_valence>-0.6</emotional_valence>
<confidence>0.95</confidence>
<tags>appointment,follow-up</tags>
</fact>
</response>`,
      })),
    } as unknown as LLMProviderPort;
    const concernRuntime = await createAutomatedConcernRuntime({
      eventBus,
      llmProvider,
      concernStore: intention.concernStore,
      now: () => new Date('2026-07-16T12:00:00.000Z'),
    });
    const extractor = new MemoryExtractor(
      llmProvider,
      sessionManager,
      memoryStore,
      {
        dims: 8,
        embed: vi.fn(async () => new Float32Array(8).fill(0.25)),
        embedBatch: vi.fn(),
      },
      { emit: vi.fn(async () => undefined) },
      {
        extractionInterval: 1,
        minImportance: 0,
        minConfidence: 0,
        minNovelty: 0,
        maxWrites: 3,
      },
      null,
      sessionStore,
      contactStore,
      { emitConcernCandidates: concernRuntime.extractionSink },
    );
    const supervisor = createBackgroundWorkSupervisor({
      store: backgroundStore,
      eventBus,
      leaseOwner: 'projection-e2e-worker',
      now: () => 2_000,
      executor: async (execution) => {
        if (execution.payload.kind !== 'memory_extraction') return;
        await executePostTurnBackgroundWork(execution, {
          sessionManager,
          llmProvider,
          getMemoryExtractor: () => extractor,
          runIntentionPostTurnHooks: async () => undefined,
          emotionRuntime: { triggerEmotionAppraisal: async () => undefined },
          getEmotionTemplateVariables: () => ({}),
          tuning: {
            extractionDrainRequeueDelayMs: 250,
            foregroundPreemptionDeferDelayMs: 250,
          },
          now: () => 2_000,
        });
      },
    });
    const channelId = 'api:output-projection-e2e';
    const turnId = createTurnId();
    const requestId = `request-${turnId}`;
    const userEntryId = sessionStore.append({
      channelId,
      role: 'user',
      content: 'I feel worried. Please check in tomorrow about the appointment.',
      authorId: 'primary-owner',
      authorName: 'Alex',
      timestamp: 1_000,
      metadata: buildSessionMetadataWithTurn(undefined, {
        turnId,
        requestId,
        role: 'user',
        actorKind: 'human',
      }),
    });
    const assistantEntryId = sessionStore.append({
      channelId,
      role: 'assistant',
      content: 'I will keep that in mind.',
      authorId: 'companion',
      authorName: 'Purrsephone',
      timestamp: 1_001,
      metadata: buildSessionMetadataWithTurn(undefined, {
        turnId,
        requestId,
        role: 'assistant',
        actorKind: 'companion',
      }),
    });
    const turnRecord = {
      ...makeCanonicalTurnRecord(channelId, turnId, 'I will keep that in mind.'),
      requestId,
      startedAt: 1_000,
      completedAt: 1_100,
      userMessage: {
        role: 'user' as const,
        content: 'I feel worried. Please check in tomorrow about the appointment.',
        timestamp: 1_000,
        authorId: 'primary-owner',
        authorName: 'Alex',
      },
      internalStateSnapshotRef: 'internal-state-v1:projection-e2e',
    };
    const enqueuedInputs: EnqueueBackgroundWorkInput[] = [];
    const internalState = {
      emotional: {
        vad: { valence: 0, arousal: 0, dominance: 0 },
        mood: { valence: 0, arousal: 0, dominance: 0 },
        discreteEmotions: {},
        confidence: 1,
        telemetry: {
          status: 'trusted',
          source: 'runtime_state',
          reasons: [],
          confidence: 1,
          weight: 1,
          observedAtMs: 1_000,
          validatedAtMs: 1_000,
          staleAfterMs: 60_000,
          provenance: [],
          rawSignal: { confidence: 1, topDiscreteLabels: [], strongestLabelScore: 0 },
        },
      },
      cognitive: { certaintyLevel: 1, topicEngagement: 1, processingQuality: 'fluent' },
      attention: { activeConcerns: [], salientEntities: [], conversationTrajectory: 'casual' },
      relational: {
        contactId: contact.id,
        trustLevel: 'regular',
        baselineValence: 0,
        moodDrift: 0,
        recentInteractionFrequency: 1,
        lastSeenDeltaSeconds: 0,
      },
      situated: { location: null },
    };

    try {
      await schedulePostTurnWork({
        runtime: {
          sessionManager,
          memoryExtractor: extractor,
          config,
          eventBus,
          inferPostTurnActions: async () => [],
          buildTurnRecord: () => turnRecord,
          enqueuePostTurnBackgroundWork: async (inputs) => {
            enqueuedInputs.push(...inputs);
            await supervisor.enqueue(inputs);
          },
          costTelemetry: { recordTurnUsage: async () => undefined },
          withCorrelationPurpose: (correlation: unknown) => correlation,
        } as never,
        message: {
          id: 'message-output-projection-e2e',
          channelId,
          channelType: 'api',
          authorId: 'primary-owner',
          authorName: 'Alex',
          content: turnRecord.userMessage.content,
          timestamp: new Date(1_000),
        },
        turnSessionIdentity: { logicalSessionId: channelId, sourceChannelId: channelId },
        response: {
          content: turnRecord.assistantMessage!.content,
          channelId,
          metadata: {
            model: 'test-model',
            inputTokens: 10,
            outputTokens: 5,
            durationMs: 100,
            turnId,
            requestId,
          },
        },
        turnMessages: [],
        turnId,
        requestId,
        startTime: 1_000,
        completedAt: 1_100,
        firstTokenAt: 1_050,
        turnUsage: { inputTokens: 10, outputTokens: 5 },
        context: { messages: [], manifest: {} } as never,
        taskKind: undefined,
        turnCorrelationBase: { turnId, requestId },
        userSessionEntryId: userEntryId,
        assistantSessionEntryId: assistantEntryId,
        promptMode: 'default',
        fullPrompt: 'test prompt',
        contextMessageCount: 1,
        memoryContextChars: 0,
        memoryContextBlock: '',
        trustLevel: 'regular',
        speakerRole: 'user',
        canonicalContactKey: contact.id,
        continuitySubjectKey: 'primary-owner',
        turnSnapshot: {} as never,
        internalStateSnapshotRef: turnRecord.internalStateSnapshotRef,
        internalState,
        templateVariables: {},
        emotionSessionId: channelId,
        channelMeta: { isDirectMessage: true, privacyLevel: 'private' },
        conversationScope: {} as never,
        turnBudgetCharacteristics: { messageText: turnRecord.userMessage.content },
        observability: {
          emitObservedTurnStage: vi.fn(),
          getObservedTurnStages: () => [],
          getObservedTurnRetrievals: () => [],
          getObservedTurnSnapshot: () => undefined,
          getRetrievalProvenanceRefs: () => [],
        },
      });

      const persisted = sessionManager.findSourceRecordedTurn(channelId, channelId, turnId)!;
      expect(persisted.extractedMemoryIds).toHaveLength(1);
      expect(persisted.concernDeltaRefs).toHaveLength(1);
      expect(persisted.contactDeltaRefs).toHaveLength(1);
      expect(JSON.stringify(persisted)).not.toContain('felt worried and asked');
      expect(sessionStore.getRecentTurnRecords(channelId, 10).map(record => record.turnId))
        .toEqual([turnId]);
      await expect(sessionManager.isSourceRecordedTurnEligible(
        channelId,
        channelId,
        turnId,
      )).resolves.toBe(true);
      await expect(sessionManager.withStableRecordedTurnEligibilitySnapshot(
        channelId,
        [turnId],
        () => sessionManager.getRecentMessagesAtOrBefore(channelId, assistantEntryId, 10),
        async entries => entries.map(entry => entry.id),
      )).resolves.toContain(assistantEntryId);

      for (let index = 0; index < 4; index += 1) {
        await supervisor.tick();
        await supervisor.waitForIdle();
      }
      await expect(Promise.all(enqueuedInputs.map(input => backgroundStore.get(input.jobId))))
        .resolves.toEqual(enqueuedInputs.map(() => expect.objectContaining({ state: 'succeeded' })));

      const service = new AdminSessionDataService({
        sessionStore,
        sessionManager,
        eventBus,
        memoryStore,
        concernStore: intention.concernStore,
        contactStore,
        subsystemOutputRefStore: backgroundStore,
      });
      const detail = await service.getSessionTurnDetail(channelId, turnId);
      expect(detail.turn.promptLoom?.subsystemOutputs.projectionStatus).toBe('applied');
      expect(detail.turn.promptLoom?.subsystemOutputs.memoryWrites)
        .toEqual([expect.objectContaining({ status: 'resolved' })]);
      expect(detail.turn.promptLoom?.subsystemOutputs.concernDeltas)
        .toEqual([expect.objectContaining({ status: 'resolved' })]);
      expect(detail.turn.promptLoom?.subsystemOutputs.contactDeltas)
        .toEqual([expect.objectContaining({ status: 'resolved' })]);
      expect(detail.turn.promptLoom?.subsystemOutputs.contactDeltas[0]?.value)
        .not.toHaveProperty('displayName');
    } finally {
      concernRuntime.dispose();
      await Promise.allSettled([supervisor.stop()]);
      await Promise.all([backgroundStore.close(), fencePool.end()]);
      rmSync(sessionsDir, { recursive: true, force: true });
    }
  }, 30_000);

  it('commits stable output refs with the applied receipt and retains them after job purge', async () => {
    const database = await harness.createDatabase();
    const store = await PostgresBackgroundWorkStore.connect(database.databaseUrl, {
      schema: 'companion_a',
    });
    const inspectionPool = createPostgresPool(database.databaseUrl, {
      schema: 'companion_a',
      max: 1,
    });
    try {
      const input = makeInput('session-output', 'turn-output');
      const memoryRef = buildSubsystemOutputRef('memory', 'memory-output-1');
      const concernRef = buildSubsystemOutputRef('concern', 'concern-output-1');
      const binding = {
        logicalSessionId: input.logicalSessionId,
        sourceChannelId: input.sourceChannelId,
        sourceTurnId: input.sourceTurnId,
        sourceRequestId: input.sourceRequestId,
      };
      await store.enqueue(input);
      await expect(store.getSubsystemOutputProjection(binding)).resolves.toEqual({
        status: 'pending',
        outputRefs: [],
      });
      const claim = await store.claimNext({
        leaseOwner: 'worker-output',
        nowMs: 100,
        leaseDurationMs: 100,
        excludedLogicalSessionIds: [],
      });
      expect(await store.beginEffect({
        jobId: claim!.jobId,
        effectKey: 'memory-extraction',
        leaseOwner: claim!.leaseOwner,
        expectedRevision: claim!.revision,
        nowMs: 100,
        projectsSubsystemOutputs: true,
      })).toBe('execute');
      expect(await store.commitEffectBoundary({
        jobId: claim!.jobId,
        effectKey: 'memory-extraction',
        leaseOwner: claim!.leaseOwner,
        expectedRevision: claim!.revision,
        nowMs: 101,
      })).toBe('crossed');
      await store.completeEffect({
        jobId: claim!.jobId,
        effectKey: 'memory-extraction',
        leaseOwner: claim!.leaseOwner,
        expectedRevision: claim!.revision,
        nowMs: 102,
        outputRefs: [memoryRef, concernRef, memoryRef],
      });
      expect(await store.beginEffect({
        jobId: claim!.jobId,
        effectKey: 'memory-extraction',
        leaseOwner: claim!.leaseOwner,
        expectedRevision: claim!.revision,
        nowMs: 103,
        projectsSubsystemOutputs: true,
      })).toBe('applied');
      await expect(store.getSubsystemOutputProjection(binding)).resolves.toEqual({
        status: 'applied',
        outputRefs: [concernRef, memoryRef].sort(),
      });
      await expect(store.listSubsystemOutputRefs(binding))
        .resolves.toEqual([concernRef, memoryRef].sort());
      await expect(store.listSubsystemOutputRefs({
        ...binding,
        sourceRequestId: 'wrong-request',
      })).resolves.toEqual([]);

      await store.complete({
        jobId: claim!.jobId,
        leaseOwner: claim!.leaseOwner,
        expectedRevision: claim!.revision,
        nowMs: 104,
      });
      expect(await store.purgeTerminal({ completedBeforeMs: 104, limit: 10 })).toBe(1);
      await expect(store.listSubsystemOutputRefs(binding))
        .resolves.toEqual([concernRef, memoryRef].sort());
      await expect(inspectionPool.query(`
        UPDATE agent_turn_subsystem_output_refs
        SET recorded_at_ms = recorded_at_ms + 1
      `)).rejects.toThrow('agent_turn_subsystem_output_refs is append-only');
      await expect(inspectionPool.query(`
        DELETE FROM agent_turn_subsystem_output_refs
      `)).rejects.toThrow('agent_turn_subsystem_output_refs is append-only');
      await expect(inspectionPool.query(`
        TRUNCATE agent_turn_subsystem_output_refs
      `)).rejects.toThrow('agent_turn_subsystem_output_refs is append-only');
      await expect(inspectionPool.query(`
        TRUNCATE agent_turn_subsystem_output_status
      `)).rejects.toThrow('agent_turn_subsystem_output_status is append-only');
    } finally {
      await Promise.all([store.close(), inspectionPool.end()]);
    }
  }, 30_000);

  it('serializes concurrent durable candidate promotions at the active concern cap', async () => {
    const database = await harness.createDatabase();
    const adminPool = createPostgresPool(database.databaseUrl, { max: 1 });
    await ensurePostgresSchemaExists(adminPool, 'companion_a');
    await adminPool.end();
    const pool = createPostgresPool(database.databaseUrl, {
      schema: 'companion_a',
      max: 4,
    });
    await ensureIntentionPostgresSchema(pool);
    let idCounter = 0;
    const concernStore = createConcernStorePort(new PostgresActiveConcernStore(
      pool,
      () => new Date('2026-07-16T12:00:00.000Z'),
      () => `concurrent-concern-${++idCounter}`,
    ));
    try {
      for (const text of [
        'Confirm Tuesday cardiology appointment logistics.',
        'Review database migration rollback checklist.',
        'Check whether voice latency regression returned.',
        'Track hydration routine after medication change.',
        'Revisit backup verification evidence tonight.',
        'Clarify calendar scheduling conflict with Sam.',
      ]) {
        await concernStore.create({ text, priority: 'low' });
      }
      const firstCandidate = await concernStore.create({
        text: 'Follow up concurrentcandidatealpha',
        priority: 'high',
        status: 'candidate',
      });
      const secondCandidate = await concernStore.create({
        text: 'Follow up concurrentcandidatebeta',
        priority: 'high',
        status: 'candidate',
      });

      const promotions = await Promise.allSettled([
        concernStore.transitionConcernStatus(firstCandidate.id, {
          status: 'active',
          transitionedAt: '2026-07-16T12:01:00.000Z',
        }),
        concernStore.transitionConcernStatus(secondCandidate.id, {
          status: 'active',
          transitionedAt: '2026-07-16T12:01:00.000Z',
        }),
      ]);

      expect(promotions.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(promotions.filter(result => result.status === 'rejected')).toHaveLength(1);
      expect(promotions.find(result => result.status === 'rejected')).toMatchObject({
        reason: expect.objectContaining({ message: 'Active concern cap reached (7)' }),
      });
      await expect(concernStore.getActiveConcerns()).resolves.toHaveLength(7);
      const candidateStatuses = await Promise.all([
        concernStore.getById(firstCandidate.id),
        concernStore.getById(secondCandidate.id),
      ]);
      expect(candidateStatuses.map(concern => concern?.status).sort()).toEqual(['active', 'candidate']);
    } finally {
      await pool.end();
    }
  }, 30_000);

  it('permits routine review of an admitted attention concern at the cap yet still rejects a fresh admission', async () => {
    const database = await harness.createDatabase();
    const adminPool = createPostgresPool(database.databaseUrl, { max: 1 });
    await ensurePostgresSchemaExists(adminPool, 'companion_a');
    await adminPool.end();
    const pool = createPostgresPool(database.databaseUrl, {
      schema: 'companion_a',
      max: 4,
    });
    await ensureIntentionPostgresSchema(pool);
    let idCounter = 0;
    const concernStore = createConcernStorePort(new PostgresActiveConcernStore(
      pool,
      () => new Date('2026-07-16T12:00:00.000Z'),
      () => `cap-review-concern-${++idCounter}`,
    ));
    try {
      const created: string[] = [];
      for (const text of [
        'Confirm Tuesday cardiology appointment logistics.',
        'Review database migration rollback checklist.',
        'Check whether voice latency regression returned.',
        'Track hydration routine after medication change.',
        'Revisit backup verification evidence tonight.',
        'Clarify calendar scheduling conflict with Sam.',
        'Prepare quarterly budget variance summary tonight.',
      ]) {
        const concern = await concernStore.create({ text, priority: 'low' });
        created.push(concern.id);
      }
      // The cap is now saturated at exactly 7 admitted attention concerns, and all
      // seven were created inside the trigger's 7-day admission window.
      await expect(concernStore.getActiveConcerns()).resolves.toHaveLength(7);

      // (a)/(c) Routine review of an already-admitted attention concern bumps
      // last_reviewed_at while status stays 'active'. Before the fix this UPDATE
      // re-evaluated the admission cap against the new timestamp and raised
      // 'Active concern cap reached (7)', which propagated out of routine review /
      // transitionConcernStatus and failed the intention_post_turn_hooks
      // background job. It must now succeed.
      const reviewedAt = '2026-07-16T12:05:00.000Z';
      const reviewed = await concernStore.transitionConcernStatus(created[0]!, {
        status: 'active',
        transitionedAt: reviewedAt,
      });
      expect(reviewed?.status).toBe('active');
      expect(reviewed?.lastReviewedAt).toBe(reviewedAt);
      // The review neither evicted nor admitted anything: the set is still 7.
      await expect(concernStore.getActiveConcerns()).resolves.toHaveLength(7);

      // Reviewing every admitted concern (the heartbeat-driven sweep shape) must
      // likewise never trip the cap.
      for (const id of created) {
        await expect(concernStore.transitionConcernStatus(id, {
          status: 'active',
          transitionedAt: '2026-07-16T12:07:00.000Z',
        })).resolves.toMatchObject({ status: 'active' });
      }
      await expect(concernStore.getActiveConcerns()).resolves.toHaveLength(7);

      // (b) A brand-new admission INTO attention while the cap is saturated must
      // still be rejected by the fail-closed DB trigger.
      const eighthCandidate = await concernStore.create({
        text: 'Follow up capreviewcandidateeighth',
        priority: 'high',
        status: 'candidate',
      });
      await expect(concernStore.transitionConcernStatus(eighthCandidate.id, {
        status: 'active',
        transitionedAt: '2026-07-16T12:08:00.000Z',
      })).rejects.toThrow('Active concern cap reached (7)');
      // The rejected candidate stays a candidate; the admitted set is unchanged.
      await expect(concernStore.getById(eighthCandidate.id)).resolves.toMatchObject({ status: 'candidate' });
      await expect(concernStore.getActiveConcerns()).resolves.toHaveLength(7);
    } finally {
      await pool.end();
    }
  }, 30_000);

  it('marks a live post-boundary projecting failure outcome-unknown immediately', async () => {
    const database = await harness.createDatabase();
    const store = await PostgresBackgroundWorkStore.connect(database.databaseUrl, {
      schema: 'companion_a',
    });
    const supervisor = createBackgroundWorkSupervisor({
      store,
      eventBus: new EventBus(),
      leaseOwner: 'worker-live-projection-failure',
      now: () => 100,
      executor: async ({ effects }) => {
        await effects.run('memory-extraction', async (crossBoundary) => {
          await crossBoundary();
          throw new Error('contact persistence failed after the effect boundary');
        }, { projectsSubsystemOutputs: true });
      },
    });
    try {
      const input = makeInput('session-live-projection-failure', 'turn-live-projection-failure');
      const binding = {
        logicalSessionId: input.logicalSessionId,
        sourceChannelId: input.sourceChannelId,
        sourceTurnId: input.sourceTurnId,
        sourceRequestId: input.sourceRequestId,
      };
      await supervisor.enqueue([input]);
      await supervisor.tick();
      await supervisor.waitForIdle();

      await expect(store.get(input.jobId)).resolves.toMatchObject({
        state: 'failed',
        reasonCode: 'effect_outcome_unknown',
        attemptCount: 1,
      });
      await expect(store.getSubsystemOutputProjection(binding)).resolves.toEqual({
        status: 'outcome_unknown',
        outputRefs: [],
      });
    } finally {
      await supervisor.stop();
      await store.close();
    }
  }, 30_000);

  it('marks terminal pre-boundary extraction failure distinctly from pending work', async () => {
    const database = await harness.createDatabase();
    const store = await PostgresBackgroundWorkStore.connect(database.databaseUrl, {
      schema: 'companion_a',
    });
    const supervisor = createBackgroundWorkSupervisor({
      store,
      eventBus: new EventBus(),
      leaseOwner: 'worker-pre-boundary-projection-failure',
      now: () => 100,
      executor: async () => {
        throw new Error('pre-boundary extraction failure');
      },
    });
    try {
      const input = {
        ...makeInput('session-pre-boundary-failure', 'turn-pre-boundary-failure'),
        maxAttempts: 1,
      };
      const binding = {
        logicalSessionId: input.logicalSessionId,
        sourceChannelId: input.sourceChannelId,
        sourceTurnId: input.sourceTurnId,
        sourceRequestId: input.sourceRequestId,
      };
      await supervisor.enqueue([input]);
      await supervisor.tick();
      await supervisor.waitForIdle();

      await expect(store.get(input.jobId)).resolves.toMatchObject({
        state: 'failed',
        reasonCode: 'retry_exhausted',
        attemptCount: 1,
      });
      await expect(store.getSubsystemOutputProjection(binding)).resolves.toEqual({
        status: 'failed',
        outputRefs: [],
      });
    } finally {
      await supervisor.stop();
      await store.close();
    }
  }, 30_000);

  it('distinguishes an applied empty subsystem projection from pending work', async () => {
    const database = await harness.createDatabase();
    const store = await PostgresBackgroundWorkStore.connect(database.databaseUrl, {
      schema: 'companion_a',
    });
    try {
      const input = makeInput('session-output-empty', 'turn-output-empty');
      const binding = {
        logicalSessionId: input.logicalSessionId,
        sourceChannelId: input.sourceChannelId,
        sourceTurnId: input.sourceTurnId,
        sourceRequestId: input.sourceRequestId,
      };
      await store.enqueue(input);
      await expect(store.getSubsystemOutputProjection(binding)).resolves.toEqual({
        status: 'pending',
        outputRefs: [],
      });
      const claim = await store.claimNext({
        leaseOwner: 'worker-output-empty',
        nowMs: 100,
        leaseDurationMs: 100,
        excludedLogicalSessionIds: [],
      });
      expect(await store.beginEffect({
        jobId: claim!.jobId,
        effectKey: 'memory-extraction',
        leaseOwner: claim!.leaseOwner,
        expectedRevision: claim!.revision,
        nowMs: 100,
        projectsSubsystemOutputs: true,
      })).toBe('execute');
      await store.completeEffect({
        jobId: claim!.jobId,
        effectKey: 'memory-extraction',
        leaseOwner: claim!.leaseOwner,
        expectedRevision: claim!.revision,
        nowMs: 101,
        outputRefs: [],
      });
      await expect(store.getSubsystemOutputProjection(binding)).resolves.toEqual({
        status: 'applied',
        outputRefs: [],
      });
    } finally {
      await store.close();
    }
  }, 30_000);

  it('recovers a pre-boundary expired lease without consuming its final attempt', async () => {
    const database = await harness.createDatabase();
    const store = await PostgresBackgroundWorkStore.connect(database.databaseUrl, {
      schema: 'companion_a',
    });
    try {
      const input = { ...makeInput('session-a', 'turn-a'), maxAttempts: 1 };
      await store.enqueue(input);
      const firstClaim = await store.claimNext({
        leaseOwner: 'crashed-worker',
        nowMs: 100,
        leaseDurationMs: 10,
        excludedLogicalSessionIds: [],
      });
      expect(firstClaim?.state).toBe('running');
      expect(await store.recoverExpired({ nowMs: 111 })).toBe(1);
      expect(await store.get(input.jobId)).toMatchObject({
        state: 'retry_wait',
        reasonCode: 'lease_expired',
        attemptCount: 0,
      });

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

  it('keeps every queued row untouched across begin/end foreground at any depth (hrmrq.119)', async () => {
    const database = await harness.createDatabase();
    const store = await PostgresBackgroundWorkStore.connect(database.databaseUrl, {
      schema: 'companion_a',
    });
    try {
      // A deep backlog on one session — the regression class was an O(depth)
      // bulk UPDATE on every turn boundary (TTFT tracked queue depth linearly).
      const inputs = Array.from({ length: 50 }, (_, index) => (
        makeInput('session-a', `turn-${String(index)}`)
      ));
      for (const input of inputs) await store.enqueue(input);

      await store.beginForeground({
        logicalSessionId: 'session-a',
        leaseOwner: 'foreground-a',
        leaseId: 'foreground-lease-a',
        nowMs: 200,
        leaseDurationMs: 1_000,
      });
      // Turn acquisition wrote the lease row only: all 50 job rows keep their
      // enqueue-time state, availability, and revision.
      for (const input of inputs) {
        expect(await store.get(input.jobId)).toMatchObject({
          state: 'queued',
          reasonCode: 'enqueued',
          availableAtMs: 100,
          revision: 1,
          deferCount: 0,
        });
      }
      // And the backlog is claimable DURING the turn — depth does not stall
      // behind conversation.
      const claimed = await store.claimNext({
        leaseOwner: 'worker-a',
        nowMs: 300,
        leaseDurationMs: 100,
        excludedLogicalSessionIds: [],
      });
      expect(claimed).not.toBeNull();
      expect(claimed?.welfareClaimed).toBe(false);

      await store.endForeground({
        logicalSessionId: 'session-a',
        leaseOwner: 'foreground-a',
        leaseId: 'foreground-lease-a',
        nowMs: 400,
      });
      // Release is equally row-free: everything not claimed is still pristine.
      for (const input of inputs) {
        if (input.jobId === claimed?.jobId) continue;
        expect(await store.get(input.jobId)).toMatchObject({
          state: 'queued',
          reasonCode: 'enqueued',
          availableAtMs: 100,
          revision: 1,
          deferCount: 0,
        });
      }
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

  // ── mmo9.7.4: anti-starvation welfare reserve ───────────────────────────────

  it('stamps preemption defer pressure (defer_count / first_deferred_at_ms) for welfare aging', async () => {
    const database = await harness.createDatabase();
    const store = await PostgresBackgroundWorkStore.connect(database.databaseUrl, { schema: 'companion_a' });
    try {
      const input = makeInput('session-a', 'turn-a');
      await store.enqueue(input);
      const fresh = await store.get(input.jobId);
      expect(fresh?.deferCount).toBe(0);
      expect(fresh?.firstDeferredAtMs).toBeUndefined();
      expect(fresh?.welfareClaimed).toBe(false);

      // A claim-level preemption defer (e.g. the provider gate yielded the
      // model call to a foreground turn) is the only remaining source of
      // welfare defer pressure — turn boundaries no longer stamp job rows.
      const claim = await store.claimNext({
        leaseOwner: 'worker-a',
        nowMs: 400,
        leaseDurationMs: 1_000,
        excludedLogicalSessionIds: [],
      });
      await store.defer({
        jobId: claim!.jobId,
        leaseOwner: claim!.leaseOwner,
        expectedRevision: claim!.revision,
        reasonCode: 'foreground_active',
        availableAtMs: 1_500,
        nowMs: 500,
      });
      const deferred = await store.get(input.jobId);
      expect(deferred?.state).toBe('deferred');
      expect(deferred?.deferCount).toBe(1);
      expect(deferred?.firstDeferredAtMs).toBe(500);
      expect(deferred?.welfareClaimed).toBe(false);
    } finally {
      await store.close();
    }
  });

  it('rescues a reflection job starved by repeated preemption backoff once it ages into a welfare slot', async () => {
    const database = await harness.createDatabase();
    const store = await PostgresBackgroundWorkStore.connect(database.databaseUrl, { schema: 'companion_a' });
    try {
      const input = makeInput('session-a', 'turn-a');
      await store.enqueue(input);
      // Sustained interactive load, modeled at the real contention point: the
      // claim ran, its model call yielded to a foreground turn at the provider
      // gate, and the resulting defer pushed availability far into the future.
      // A live turn lease stays active throughout — it must be irrelevant to
      // this non-compaction kind (hrmrq.119).
      await store.beginForeground({
        logicalSessionId: 'session-a',
        leaseOwner: 'foreground-a',
        leaseId: 'fg-lease-1',
        nowMs: 100,
        leaseDurationMs: 1_000_000,
      });
      const preempted = await store.claimNext({
        leaseOwner: 'worker',
        nowMs: 200,
        leaseDurationMs: 1_000,
        excludedLogicalSessionIds: [],
      });
      expect(preempted?.jobId).toBe(input.jobId);
      await store.defer({
        jobId: preempted!.jobId,
        leaseOwner: preempted!.leaseOwner,
        expectedRevision: preempted!.revision,
        reasonCode: 'foreground_active',
        availableAtMs: 10_000_000,
        nowMs: 300,
      });

      // BASE (welfare disabled): the backed-off job is unreachable no matter
      // how much time passes short of its pushed availability.
      for (const nowMs of [1_000, 100_000, 500_000]) {
        expect(await store.claimNext({
          leaseOwner: 'worker',
          nowMs,
          leaseDurationMs: 1_000,
          excludedLogicalSessionIds: [],
        })).toBeNull();
      }

      // AGED (welfare enabled): the identical call now admits the job into a
      // bounded welfare-reserve slot past its accrued backoff.
      const claimed = await store.claimNext({
        leaseOwner: 'worker',
        nowMs: 500_000,
        leaseDurationMs: 1_000,
        excludedLogicalSessionIds: [],
        // Unreachable defer count on purpose: eligibility here is by AGE only.
        welfare: { deferThreshold: 999, ageThresholdMs: 60_000, reserveSlots: 1 },
      });
      expect(claimed?.jobId).toBe(input.jobId);
      expect(claimed?.welfareClaimed).toBe(true);

      // The welfare-claimed job is immune to every foreground fence and runs to
      // a protected completion while the turn lease is still live.
      expect(await store.checkClaimFence({
        jobId: input.jobId,
        leaseOwner: claimed!.leaseOwner,
        expectedRevision: claimed!.revision,
        nowMs: 500_002,
      })).toBe('owned');
      await store.complete({
        jobId: input.jobId,
        leaseOwner: claimed!.leaseOwner,
        expectedRevision: claimed!.revision,
        nowMs: 500_003,
      });
      const done = await store.get(input.jobId);
      expect(done?.state).toBe('succeeded');
      expect(done?.welfareClaimed).toBe(false);
    } finally {
      await store.close();
    }
  });

  it('bounds concurrent welfare admissions to the reserve cap so aged jobs cannot flood', async () => {
    const database = await harness.createDatabase();
    const store = await PostgresBackgroundWorkStore.connect(database.databaseUrl, { schema: 'companion_a' });
    try {
      const a = makeInput('session-a', 'turn-a');
      const b = makeInput('session-b', 'turn-b');
      await store.enqueue(a);
      await store.enqueue(b);
      // Both jobs cross the defer threshold once: each was claimed, preempted
      // at its model call, and deferred with a far-future backoff.
      for (let preemption = 0; preemption < 2; preemption += 1) {
        const claim = await store.claimNext({
          leaseOwner: 'worker', nowMs: 150, leaseDurationMs: 1_000,
          excludedLogicalSessionIds: [],
        });
        expect(claim).not.toBeNull();
        await store.defer({
          jobId: claim!.jobId, leaseOwner: claim!.leaseOwner, expectedRevision: claim!.revision,
          reasonCode: 'foreground_active', availableAtMs: 10_000_000, nowMs: 160,
        });
      }
      const welfare = { deferThreshold: 1, ageThresholdMs: 10_000_000, reserveSlots: 1 };

      const first = await store.claimNext({
        leaseOwner: 'worker', nowMs: 200, leaseDurationMs: 1_000,
        excludedLogicalSessionIds: [], welfare,
      });
      expect(first?.welfareClaimed).toBe(true);

      // Reserve cap of 1 is now full (one welfare job running): the second aged
      // session cannot also be welfare-admitted.
      expect(await store.claimNext({
        leaseOwner: 'worker', nowMs: 201, leaseDurationMs: 1_000,
        excludedLogicalSessionIds: [], welfare,
      })).toBeNull();

      // Completing the first frees the reserve slot; the other aged job is then
      // admitted — eventual completion, one bounded slice at a time.
      await store.complete({
        jobId: first!.jobId, leaseOwner: first!.leaseOwner, expectedRevision: first!.revision, nowMs: 202,
      });
      const second = await store.claimNext({
        leaseOwner: 'worker', nowMs: 203, leaseDurationMs: 1_000,
        excludedLogicalSessionIds: [], welfare,
      });
      expect(second?.welfareClaimed).toBe(true);
      expect(second?.logicalSessionId).not.toBe(first?.logicalSessionId);
    } finally {
      await store.close();
    }
  });

  it('never welfare-admits a job without preemption defer pressure, so backoff stays authoritative', async () => {
    const database = await harness.createDatabase();
    const store = await PostgresBackgroundWorkStore.connect(database.databaseUrl, { schema: 'companion_a' });
    try {
      const input = makeInput('session-a', 'turn-a');
      await store.enqueue(input);
      // A source_not_ready defer carries no welfare pressure: defer_count stays
      // 0 and first_deferred_at_ms stays unset, so even a generous welfare
      // policy must not lift the job past its availability backoff.
      const claim = await store.claimNext({
        leaseOwner: 'worker', nowMs: 150, leaseDurationMs: 1_000,
        excludedLogicalSessionIds: [],
      });
      await store.defer({
        jobId: claim!.jobId, leaseOwner: claim!.leaseOwner, expectedRevision: claim!.revision,
        reasonCode: 'source_not_ready', availableAtMs: 10_000_000, nowMs: 160,
      });
      expect(await store.claimNext({
        leaseOwner: 'worker', nowMs: 5_000_000, leaseDurationMs: 1_000,
        excludedLogicalSessionIds: [],
        welfare: { deferThreshold: 1, ageThresholdMs: 1_000, reserveSlots: 1 },
      })).toBeNull();
    } finally {
      await store.close();
    }
  });

  it('never welfare-admits auto_compaction (it must not run concurrently with a foreground turn)', async () => {
    const database = await harness.createDatabase();
    const store = await PostgresBackgroundWorkStore.connect(database.databaseUrl, { schema: 'companion_a' });
    try {
      const input = makeCompactionInput('session-a', 'turn-a', 100);
      await store.enqueue(input);
      await store.beginForeground({
        logicalSessionId: 'session-a', leaseOwner: 'fg', leaseId: 'fg-a', nowMs: 100, leaseDurationMs: 1_000_000,
      });
      // Even heavily aged, an auto_compaction job is welfare-ineligible: it
      // rewrites the live session context and must wait for genuine idle.
      expect(await store.claimNext({
        leaseOwner: 'worker', nowMs: 5_000_000, leaseDurationMs: 1_000,
        excludedLogicalSessionIds: [],
        foregroundExcludedLogicalSessionIds: ['session-a'],
        welfare: { deferThreshold: 1, ageThresholdMs: 1_000, reserveSlots: 1 },
      })).toBeNull();
    } finally {
      await store.close();
    }
  });

  it('preserves FIFO availability across a foreground turn (no row is ever pushed forward)', async () => {
    const database = await harness.createDatabase();
    const store = await PostgresBackgroundWorkStore.connect(database.databaseUrl, { schema: 'companion_a' });
    try {
      const first = makeInput('session-a', 'turn-a');
      const secondBase = makeInput('session-a', 'turn-b');
      const secondPayload: MemoryExtractionBackgroundPayload = {
        ...(secondBase.payload as MemoryExtractionBackgroundPayload),
        source: { ...(secondBase.payload as MemoryExtractionBackgroundPayload).source, createdAtMs: 200 },
      };
      const second: EnqueueBackgroundWorkInput = {
        ...secondBase,
        payload: secondPayload,
        payloadFingerprint: fingerprintBackgroundWorkPayload(secondPayload),
        createdAtMs: 200,
      };
      await store.enqueue(first);
      await store.enqueue(second);

      await store.beginForeground({
        logicalSessionId: 'session-a', leaseOwner: 'fg', leaseId: 'fg-a', nowMs: 300, leaseDurationMs: 1_000,
      });
      // The turn never rewrites availability, so FIFO order by created_at is
      // intact and the older turn claims first — even mid-conversation.
      expect((await store.get(first.jobId))?.availableAtMs).toBe(100);
      expect((await store.get(second.jobId))?.availableAtMs).toBe(200);
      const claimed = await store.claimNext({
        leaseOwner: 'worker', nowMs: 301, leaseDurationMs: 1_000,
        excludedLogicalSessionIds: [],
      });
      expect(claimed?.jobId).toBe(first.jobId);
      expect(claimed?.welfareClaimed).toBe(false);
      expect(await store.endForeground({
        logicalSessionId: 'session-a', leaseOwner: 'fg', leaseId: 'fg-a', nowMs: 2_000,
      })).toBe(true);
    } finally {
      await store.close();
    }
  });
});
