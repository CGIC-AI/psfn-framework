import { createHash } from 'node:crypto';
import {
  appendFileSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildSessionHmacKeyring } from '../../../persistence/journals/journal-utils.js';
import { createPostgresPool } from '../../../persistence/postgres.js';
import { PostgresBackgroundWorkStore } from '../../../persistence/postgres/background-work-store.js';
import { createBackgroundWorkHandoffRecoveryDisposition } from '../../../persistence/repair/background-work-handoff-recovery-disposition.js';
import { SessionStore } from '../../../persistence/sessions/store.js';
import {
  createKeyringIntegrityProvider,
} from '../../../persistence/sessions/store-primitives.js';
import type { TurnRecordEligibilityFencePort } from '../../../persistence/sessions/turn-record-eligibility-fence-port.js';
import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../../test-support/postgres-test-harness.js';
import type {
  TurnRecord,
  TurnRecordBackgroundWorkJob,
} from '../../../shared/contracts/runtime.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import { SessionManager } from '../../session/manager.js';
import { createTurnId } from '../../turns/id.js';
import { BackgroundWorkHandoffRecoveryRuntime } from './handoff-recovery-runtime.js';
import {
  createBackgroundWorkIdentity,
  fingerprintBackgroundWorkHandoff,
  fingerprintBackgroundWorkPayload,
  fingerprintBackgroundWorkTurnRecord,
  stableBackgroundWorkStringify,
  type AutoCompactionBackgroundPayload,
  type BackgroundWorkPayload,
  type EnqueueBackgroundWorkInput,
  type MemoryExtractionBackgroundPayload,
} from './types.js';

const rootsToDelete: string[] = [];
let harness: PostgresTestHarness;

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
}, 90_000);

afterAll(async () => {
  await harness.stop();
}, 30_000);

afterEach(() => {
  for (const root of rootsToDelete) rmSync(root, { recursive: true, force: true });
  rootsToDelete.length = 0;
});

function makeConfig(dataDir: string): SubstrateConfig {
  return {
    primaryModel: 'test-model',
    primaryProvider: 'test',
    extractionModel: 'test-model',
    extractionProvider: 'test',
    discordToken: '',
    discordBotId: '',
    characterCardPath: '',
    dataDir,
    databasePath: '',
    sessionHistoryBudgetPct: 6,
    memoryRetrievalBudgetPct: 2,
    sessionMessageLimit: 50,
    memoryRetrievalLimit: 15,
    extractionInterval: 5,
    primaryMaxTokens: 16_384,
    extractionMaxTokens: 8_192,
    maintenanceIntervalMs: 300_000,
    defaultContextWindow: 128_000,
    extractionThresholdPct: 30,
    compactionThresholdPct: 70,
    compactionEmotionalSalienceThresholdPct: 75,
    modelRoster: {
      chat: {
        model: 'test-model',
        provider: 'test',
        maxTokens: 16_384,
        contextWindow: 1_000,
      },
    },
  };
}

function createSerialTurnRecordEligibilityFence(): TurnRecordEligibilityFencePort {
  let tail = Promise.resolve();
  const runExclusive = async <T>(operation: () => Promise<T>): Promise<T> => {
    const prior = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try {
      return await operation();
    } finally {
      release();
    }
  };
  return {
    withTurnRecordEligibilityFence: (_key, operation) => runExclusive(operation),
    withTurnRecordEligibilityFences: (_keys, operation) => runExclusive(operation),
  };
}

function makeRecord(channelId: string, completedAt: number): TurnRecord {
  const turnId = createTurnId(completedAt);
  return {
    schemaVersion: 1,
    turnId,
    requestId: `request-${turnId}`,
    sessionId: channelId,
    channelId,
    channelType: 'api',
    startedAt: completedAt - 10,
    completedAt,
    status: 'completed',
    userMessage: { role: 'user', content: 'source', timestamp: completedAt - 10 },
    assistantMessage: { role: 'assistant', content: 'reply', timestamp: completedAt },
    toolCalls: [],
    extractedMemoryIds: [],
    concernDeltaRefs: [],
    contactDeltaRefs: [],
    versionPointers: { model: 'test/model' },
    provenanceRefs: [],
  };
}

function bindJob(
  record: TurnRecord,
  payload: BackgroundWorkPayload,
): EnqueueBackgroundWorkInput {
  const logicalSessionId = record.sessionId ?? record.channelId;
  return {
    ...createBackgroundWorkIdentity({
      logicalSessionId,
      turnId: record.turnId,
      kind: payload.kind,
    }),
    logicalSessionId,
    kind: payload.kind,
    payload,
    payloadFingerprint: fingerprintBackgroundWorkPayload(payload),
    sourceTurnId: record.turnId,
    sourceRequestId: record.requestId,
    sourceChannelId: record.channelId,
    createdAtMs: record.completedAt,
    maxAttempts: 3,
  };
}

function makeLegacyFourJobRecord(
  channelId: string,
  completedAt: number,
): {
  record: TurnRecord;
  originalManifestFingerprint: string;
  obsoleteJobId: string;
  retainedJobIds: string[];
} {
  const record = makeRecord(channelId, completedAt);
  const logicalSessionId = record.sessionId ?? record.channelId;
  const source = {
    schemaVersion: 1 as const,
    logicalSessionId,
    channelId: record.channelId,
    turnId: record.turnId,
    requestId: record.requestId,
    turnRecordFingerprint: fingerprintBackgroundWorkTurnRecord(record),
    createdAtMs: record.completedAt,
  };
  const memory: MemoryExtractionBackgroundPayload = {
    schemaVersion: 1,
    kind: 'memory_extraction',
    source,
  };
  const compaction: AutoCompactionBackgroundPayload = {
    schemaVersion: 1,
    kind: 'auto_compaction',
    source,
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
  const currentEmotion: Extract<BackgroundWorkPayload, { kind: 'emotion_appraisal' }> = {
    schemaVersion: 1,
    kind: 'emotion_appraisal',
    source,
    emotionSessionId: logicalSessionId,
    internalStateSnapshotRef: 'internal-state-v1:legacy-recovery',
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
    driftDecision: {
      schemaVersion: 1,
      mode: 'drift_only',
      baselineVad: { valence: -0.5, arousal: 0, dominance: 0 },
      targetVad: { valence: 0, arousal: 0, dominance: 0 },
      vadDelta: 0.5,
      threshold: 0.35,
    },
    personalityOwnerRef: 'character-card',
    personalityProjectionHash: 'b'.repeat(64),
  };
  const currentJobs = [
    bindJob(record, memory),
    bindJob(record, { schemaVersion: 1, kind: 'intention_post_turn_hooks', source }),
    bindJob(record, currentEmotion),
    bindJob(record, compaction),
  ];
  const { driftDecision: _retired, ...legacyEmotionPayload } = currentEmotion;
  const legacyEmotionJob: TurnRecordBackgroundWorkJob = {
    ...currentJobs[2]!,
    payload: legacyEmotionPayload,
    payloadFingerprint: createHash('sha256')
      .update(stableBackgroundWorkStringify(legacyEmotionPayload))
      .digest('hex'),
  };
  const originalJobs: TurnRecordBackgroundWorkJob[] = [
    currentJobs[0]!,
    currentJobs[1]!,
    legacyEmotionJob,
    currentJobs[3]!,
  ];
  record.backgroundWorkHandoff = { schemaVersion: 1, jobs: originalJobs };
  return {
    record,
    obsoleteJobId: legacyEmotionJob.jobId,
    retainedJobIds: originalJobs
      .filter(job => job.kind !== 'emotion_appraisal')
      .map(job => job.jobId),
    originalManifestFingerprint: fingerprintBackgroundWorkHandoff(
      originalJobs as EnqueueBackgroundWorkInput[],
    ),
  };
}

function makeCurrentIntentionRecord(channelId: string, completedAt: number): TurnRecord {
  const record = makeRecord(channelId, completedAt);
  const logicalSessionId = record.sessionId ?? record.channelId;
  const payload: Extract<BackgroundWorkPayload, { kind: 'intention_post_turn_hooks' }> = {
    schemaVersion: 1,
    kind: 'intention_post_turn_hooks',
    source: {
      schemaVersion: 1,
      logicalSessionId,
      channelId: record.channelId,
      turnId: record.turnId,
      requestId: record.requestId,
      turnRecordFingerprint: fingerprintBackgroundWorkTurnRecord(record),
      createdAtMs: record.completedAt,
    },
  };
  record.backgroundWorkHandoff = { schemaVersion: 1, jobs: [bindJob(record, payload)] };
  return record;
}

function findSessionJournalPath(sessionsDir: string, channelFragment: string): string {
  const filename = readdirSync(sessionsDir).find(candidate => (
    candidate.endsWith('.jsonl')
    && !candidate.startsWith('_')
    && !candidate.startsWith('user_')
    && candidate.includes(channelFragment)
  ));
  expect(filename).toBeDefined();
  return join(sessionsDir, filename!);
}

describe('legacy background-work receipt recovery', () => {
  it('re-proves exact legacy siblings on the next tick after a transient enqueue failure', async () => {
    const database = await harness.createDatabase();
    const schema = 'legacy_receipt_transient_retry';
    const backgroundStore = await PostgresBackgroundWorkStore.connect(database.databaseUrl, {
      schema,
    });
    const inspectionPool = createPostgresPool(database.databaseUrl, { schema, max: 1 });
    const root = mkdtempSync(join(tmpdir(), 'legacy-receipt-transient-retry-'));
    rootsToDelete.push(root);
    const sessionsDir = join(root, 'sessions');
    const manager = new SessionManager(new SessionStore(sessionsDir, {
      turnRecordEligibilityFence: createSerialTurnRecordEligibilityFence(),
    }), makeConfig(root));
    const legacy = makeLegacyFourJobRecord('api:legacy-transient-owner', 1_775_100_000_000);
    try {
      manager.recordUserMessage(
        legacy.record.channelId,
        'source',
        'partner',
        'Partner',
        true,
        undefined,
        { turnId: legacy.record.turnId, requestId: legacy.record.requestId },
      );
      await manager.recordTurn(legacy.record);
      await inspectionPool.query(`
        INSERT INTO agent_background_work_handoffs (
          logical_session_id, source_turn_id, manifest_fingerprint, accepted_at_ms
        ) VALUES ($1, $2, $3, $4)
      `, [
        legacy.record.sessionId,
        legacy.record.turnId,
        legacy.originalManifestFingerprint,
        legacy.record.completedAt,
      ]);

      const attempts: string[][] = [];
      const enqueueRecovery = async (
        input: Parameters<PostgresBackgroundWorkStore['recoverBatch']>[0],
      ): Promise<void> => {
        attempts.push(input.jobs.map(job => job.jobId));
        if (attempts.length === 1) throw new Error('injected legacy receipt recovery outage');
        await backgroundStore.recoverBatch(input);
      };
      const runtime = new BackgroundWorkHandoffRecoveryRuntime(manager);

      await expect(runtime.recover(enqueueRecovery))
        .rejects.toThrow('injected legacy receipt recovery outage');
      await expect(runtime.recover(enqueueRecovery)).resolves.toBeUndefined();

      expect(attempts).toEqual([legacy.retainedJobIds, legacy.retainedJobIds]);
      expect(await backgroundStore.get(legacy.obsoleteJobId)).toBeNull();
    } finally {
      await Promise.all([inspectionPool.end(), backgroundStore.close()]);
    }
  });

  it('terminates beyond retry capacity, reaches a later handoff and disposes EBADMSG once', async () => {
    const database = await harness.createDatabase();
    const schema = 'legacy_receipt_recovery';
    const backgroundStore = await PostgresBackgroundWorkStore.connect(database.databaseUrl, {
      schema,
    });
    const inspectionPool = createPostgresPool(database.databaseUrl, { schema, max: 1 });
    const root = mkdtempSync(join(tmpdir(), 'legacy-receipt-recovery-'));
    rootsToDelete.push(root);
    const sessionsDir = join(root, 'sessions');
    const backupRootDir = join(root, 'repair-backups');
    const keyring = buildSessionHmacKeyring({
      serializedKeys: 'v1:legacy-receipt-recovery-key',
      activeVersion: 'v1',
    })!;
    const integrityProvider = createKeyringIntegrityProvider(keyring)!;
    const makeManager = () => new SessionManager(new SessionStore(sessionsDir, {
      integrityKeyring: keyring,
      turnRecordEligibilityFence: createSerialTurnRecordEligibilityFence(),
      backgroundWorkHandoffRecoveryDisposition: createBackgroundWorkHandoffRecoveryDisposition({
        sessionsDir,
        backupRootDir,
        integrityProvider,
      }),
    }), makeConfig(root));
    const manager = makeManager();
    const legacy = Array.from({ length: 33 }, (_, index) => makeLegacyFourJobRecord(
      'api:legacy-receipt-owner',
      1_775_200_000_000 + index,
    ));
    const later = makeCurrentIntentionRecord('api:later-current-owner', 1_775_200_001_000);
    const corruptOwner = 'api:legacy-receipt-corrupt-owner';
    const corruptRecord = makeCurrentIntentionRecord(corruptOwner, 1_775_200_001_100);
    try {
      for (const item of legacy) {
        manager.recordUserMessage(
          item.record.channelId,
          'source',
          'partner',
          'Partner',
          true,
          undefined,
          { turnId: item.record.turnId, requestId: item.record.requestId },
        );
        await manager.recordTurn(item.record);
        await inspectionPool.query(`
          INSERT INTO agent_background_work_handoffs (
            logical_session_id, source_turn_id, manifest_fingerprint, accepted_at_ms
          ) VALUES ($1, $2, $3, $4)
        `, [
          item.record.sessionId,
          item.record.turnId,
          item.originalManifestFingerprint,
          item.record.completedAt,
        ]);
      }
      manager.recordUserMessage(
        later.channelId,
        'source',
        'partner',
        'Partner',
        true,
        undefined,
        { turnId: later.turnId, requestId: later.requestId },
      );
      await manager.recordTurn(later);
      manager.recordUserMessage(
        corruptOwner,
        'source',
        'partner',
        'Partner',
        true,
        undefined,
        { turnId: corruptRecord.turnId, requestId: corruptRecord.requestId },
      );
      await manager.recordTurn(corruptRecord);
      appendFileSync(findSessionJournalPath(sessionsDir, 'legacy-receipt-corrupt-owner'), '{bad-json}\n');

      const enqueueRecovery = async (
        input: Parameters<PostgresBackgroundWorkStore['recoverBatch']>[0],
      ): Promise<void> => {
        await backgroundStore.recoverBatch(input);
      };
      const runtime = new BackgroundWorkHandoffRecoveryRuntime(manager);
      await expect(runtime.recover(enqueueRecovery)).resolves.toBeUndefined();
      await expect(runtime.recover(enqueueRecovery)).resolves.toBeUndefined();

      const laterJob = later.backgroundWorkHandoff!.jobs[0]!;
      expect(await backgroundStore.get(laterJob.jobId)).not.toBeNull();
      expect(await Promise.all(legacy.map(item => backgroundStore.get(item.obsoleteJobId))))
        .toEqual(Array.from({ length: 33 }, () => null));
      expect(readdirSync(backupRootDir)).toHaveLength(1);

      const restartedRuntime = new BackgroundWorkHandoffRecoveryRuntime(makeManager());
      await expect(restartedRuntime.recover(enqueueRecovery)).resolves.toBeUndefined();
      await expect(restartedRuntime.recover(enqueueRecovery)).resolves.toBeUndefined();
      expect(readdirSync(backupRootDir)).toHaveLength(1);
      expect((await inspectionPool.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM agent_background_work_handoffs',
      )).rows[0]?.count).toBe('35');
    } finally {
      await Promise.all([inspectionPool.end(), backgroundStore.close()]);
    }
  });
});
