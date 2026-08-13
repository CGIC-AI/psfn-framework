import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createBackgroundWorkIdentity,
  fingerprintBackgroundWorkPayload,
  fingerprintBackgroundWorkTurnRecord,
  stableBackgroundWorkStringify,
} from '../../core/agent/background-work/types.js';
import { resolveSessionsDir } from '../../persistence/layout.js';
import { sanitizeChannelId } from '../../persistence/sessions/store-file-contracts.js';
import {
  createFilesystemTurnRecordStorePort,
} from '../../persistence/sessions/turn-records.js';
import type { TurnRecord } from '../../shared/contracts/runtime.js';
import { runTurnRecordBackgroundWorkMigrationCli } from './migrate-turn-record-background-work.js';

describe('TurnRecord background-work migration CLI', () => {
  const scratchDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const scratchDir of scratchDirs) {
      rmSync(scratchDir, { force: true, recursive: true });
    }
    scratchDirs.length = 0;
  });

  it('durably retires the exact legacy job, preserves its sibling, and is idempotent', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-turn-record-background-work-migration-'));
    const backupDir = mkdtempSync(join(tmpdir(), 'psfn-turn-record-background-work-backup-'));
    scratchDirs.push(dataDir, backupDir);
    const sessionsDir = resolveSessionsDir(dataDir);
    const store = createFilesystemTurnRecordStorePort(sessionsDir);
    const record = makeTurnRecordWithLegacyAndCurrentJobs();
    store.appendTurnRecord(record);
    const activePath = join(
      sessionsDir,
      '_turn_records',
      `${sanitizeChannelId(record.channelId)}.jsonl`,
    );
    const originalBytes = readFileSync(activePath, 'utf8');
    const logger = { error: vi.fn(), log: vi.fn() };
    const exit = (code: number): never => { throw new Error(`unexpected exit ${code}`); };

    const dryRun = await runTurnRecordBackgroundWorkMigrationCli(
      ['--data-dir', dataDir],
      { exit, logger },
    );
    expect(dryRun).toMatchObject({
      filesModified: 0,
      filesScanned: 1,
      mode: 'dry-run',
      recordsRepaired: 0,
      remainingLegacyJobs: 1,
      retiredLegacyJobs: 0,
    });
    expect(readFileSync(activePath, 'utf8')).toBe(originalBytes);

    const applied = await runTurnRecordBackgroundWorkMigrationCli(
      ['--data-dir', dataDir, '--backup-dir', backupDir, '--apply'],
      { exit, logger },
    );
    expect(applied).toMatchObject({
      filesModified: 1,
      filesScanned: 1,
      mode: 'apply',
      recordsRepaired: 1,
      remainingLegacyJobs: 0,
      retiredLegacyJobs: 1,
    });
    expect(readFileSync(join(backupDir, basename(activePath)), 'utf8')).toBe(originalBytes);
    const migrated = JSON.parse(readFileSync(activePath, 'utf8')) as TurnRecord;
    expect(migrated.backgroundWorkHandoff?.jobs.map(job => job.kind))
      .toEqual(['memory_extraction']);

    const recovered: TurnRecord[] = [];
    for await (const candidate of store.streamTurnRecordsForRecovery!([record.channelId])) {
      recovered.push(candidate);
    }
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.backgroundWorkHandoff?.jobs.map(job => job.kind))
      .toEqual(['memory_extraction']);

    const second = await runTurnRecordBackgroundWorkMigrationCli(
      ['--data-dir', dataDir, '--backup-dir', backupDir, '--apply'],
      { exit, logger },
    );
    expect(second).toMatchObject({
      filesModified: 0,
      recordsRepaired: 0,
      remainingLegacyJobs: 0,
      retiredLegacyJobs: 0,
    });
  });

  it('refuses an apply with affected rows until a backup target is explicit', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-turn-record-background-work-no-backup-'));
    scratchDirs.push(dataDir);
    const sessionsDir = resolveSessionsDir(dataDir);
    createFilesystemTurnRecordStorePort(sessionsDir)
      .appendTurnRecord(makeTurnRecordWithLegacyAndCurrentJobs());

    const exit = vi.fn();
    await expect(runTurnRecordBackgroundWorkMigrationCli(
      ['--data-dir', dataDir, '--apply'],
      { exit, logger: { error: vi.fn(), log: vi.fn() } },
    )).rejects.toThrow('--backup-dir is required');
    expect(exit).toHaveBeenCalledWith(1);
  });
});

function makeTurnRecordWithLegacyAndCurrentJobs(): TurnRecord {
  const record: TurnRecord = {
    schemaVersion: 1,
    turnId: '019d2326-d9e1-701d-bcee-250d2cbb0e4e',
    requestId: 'request-migration',
    sessionId: 'session-migration',
    channelId: 'api:migration',
    channelType: 'api',
    startedAt: 90,
    completedAt: 100,
    status: 'completed',
    userMessage: { role: 'user', content: 'private prompt', timestamp: 90 },
    assistantMessage: { role: 'assistant', content: 'private response', timestamp: 100 },
    toolCalls: [],
    extractedMemoryIds: [],
    concernDeltaRefs: [],
    contactDeltaRefs: [],
    versionPointers: { model: 'test-model' },
    provenanceRefs: [],
  };
  const source = {
    schemaVersion: 1 as const,
    logicalSessionId: record.sessionId!,
    channelId: record.channelId,
    turnId: record.turnId,
    requestId: record.requestId,
    turnRecordFingerprint: fingerprintBackgroundWorkTurnRecord(record),
    createdAtMs: record.completedAt,
  };
  const legacyPayload = {
    schemaVersion: 1 as const,
    kind: 'emotion_appraisal' as const,
    source,
    emotionSessionId: record.sessionId!,
    internalStateSnapshotRef: 'internal-state-v1:legacy-appraisal',
    appraisalState: {
      schemaVersion: 1 as const,
      emotional: {
        vad: { valence: 0.2, arousal: 0.3, dominance: 0.4 },
        mood: { valence: 0.1, arousal: 0.2, dominance: 0.3 },
        discreteEmotions: { joy: 0.7 },
        confidence: 0.8,
        telemetry: {
          status: 'trusted' as const,
          source: 'runtime_state' as const,
          reasons: [],
          weight: 1,
        },
      },
      cognitive: { certaintyLevel: 0.6, topicEngagement: 0.7, processingQuality: 'fluent' as const },
      attention: {
        activeConcernCount: 2,
        salientEntityCount: 1,
        conversationTrajectory: 'deepening' as const,
      },
      relational: { contactId: 'contact-1', trustLevel: 'regular' as const, moodDrift: 0.1 },
    },
    personalityOwnerRef: 'character-card' as const,
    personalityProjectionHash: 'a'.repeat(64),
  };
  const memoryPayload = {
    schemaVersion: 1 as const,
    kind: 'memory_extraction' as const,
    source,
    canonicalContactId: 'contact-1',
  };
  record.backgroundWorkHandoff = {
    schemaVersion: 1,
    jobs: [legacyPayload, memoryPayload].map(payload => ({
      ...createBackgroundWorkIdentity({
        logicalSessionId: record.sessionId!,
        turnId: record.turnId,
        kind: payload.kind,
      }),
      logicalSessionId: record.sessionId!,
      kind: payload.kind,
      payload,
      payloadFingerprint: createHash('sha256')
        .update(stableBackgroundWorkStringify(payload))
        .digest('hex'),
      sourceTurnId: record.turnId,
      sourceRequestId: record.requestId,
      sourceChannelId: record.channelId,
      createdAtMs: record.completedAt,
      maxAttempts: 3,
    })),
  };
  // Ensure the current sibling uses the same canonical producer helper as the
  // live queue boundary. The legacy payload intentionally cannot use it.
  record.backgroundWorkHandoff.jobs[1]!.payloadFingerprint =
    fingerprintBackgroundWorkPayload(memoryPayload);
  return record;
}
