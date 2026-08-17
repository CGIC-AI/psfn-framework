import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSessionHmacKeyring } from '../../../persistence/journals/journal-utils.js';
import {
  BACKGROUND_WORK_HANDOFF_RECOVERY_DISPOSITION_AUDIT_EVENT,
  createBackgroundWorkHandoffRecoveryDisposition,
} from '../../../persistence/repair/background-work-handoff-recovery-disposition.js';
import type { TurnRecordEligibilityFencePort } from '../../../persistence/sessions/turn-record-eligibility-fence-port.js';
import { SessionStore } from '../../../persistence/sessions/store.js';
import {
  createKeyringIntegrityProvider,
  sanitizeChannelId,
} from '../../../persistence/sessions/store-primitives.js';
import {
  clearDiagnosticLogRingBufferForTests,
  getRecentDiagnosticLogRecords,
} from '../../../shared/logger.js';
import type { TurnRecord } from '../../../shared/contracts/runtime.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import { SessionManager } from '../../session/manager.js';
import { createTurnId } from '../../turns/id.js';
import {
  createBackgroundWorkIdentity,
  fingerprintBackgroundWorkPayload,
  fingerprintBackgroundWorkTurnRecord,
  type MemoryExtractionBackgroundPayload,
} from './types.js';
import { BackgroundWorkHandoffRecoveryRuntime } from './handoff-recovery-runtime.js';

const rootsToDelete: string[] = [];

afterEach(() => {
  clearDiagnosticLogRingBufferForTests();
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

function makeBackgroundHandoffTurnRecord(channelId: string, completedAt: number): TurnRecord {
  const turnId = createTurnId(completedAt);
  const record: TurnRecord = {
    schemaVersion: 1,
    turnId,
    requestId: `request-${turnId}`,
    sessionId: channelId,
    channelId,
    channelType: 'api',
    startedAt: completedAt - 10,
    completedAt,
    status: 'completed',
    userMessage: { role: 'user', content: 'retained source', timestamp: completedAt - 10 },
    assistantMessage: { role: 'assistant', content: 'retained reply', timestamp: completedAt },
    toolCalls: [],
    extractedMemoryIds: [],
    concernDeltaRefs: [],
    contactDeltaRefs: [],
    versionPointers: { model: 'test/model' },
    provenanceRefs: [],
  };
  const payload: MemoryExtractionBackgroundPayload = {
    schemaVersion: 1,
    kind: 'memory_extraction',
    source: {
      schemaVersion: 1,
      logicalSessionId: channelId,
      channelId,
      turnId,
      requestId: record.requestId,
      turnRecordFingerprint: fingerprintBackgroundWorkTurnRecord(record),
      createdAtMs: completedAt,
    },
  };
  record.backgroundWorkHandoff = {
    schemaVersion: 1,
    jobs: [{
      ...createBackgroundWorkIdentity({
        logicalSessionId: channelId,
        turnId,
        kind: payload.kind,
      }),
      logicalSessionId: channelId,
      kind: payload.kind,
      payload,
      payloadFingerprint: fingerprintBackgroundWorkPayload(payload),
      sourceTurnId: turnId,
      sourceRequestId: record.requestId,
      sourceChannelId: channelId,
      createdAtMs: completedAt,
      maxAttempts: 5,
    }],
  };
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

function ebadmsgWarnings(channelId: string): ReturnType<typeof getRecentDiagnosticLogRecords> {
  return getRecentDiagnosticLogRecords().filter(record => (
    record.component === 'SessionStore'
    && record.message.includes(channelId)
    && record.message.includes('EBADMSG')
  ));
}

describe('background-work handoff integrity recovery', () => {
  it('fails explicitly when EBADMSG disposition produces no durable repair evidence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'handoff-noop-ebadmsg-'));
    rootsToDelete.push(root);
    const sessionsDir = join(root, 'sessions');
    const channelId = 'api:valid-noop-owner';
    const keyring = buildSessionHmacKeyring({
      serializedKeys: 'v1:noop-handoff-key',
      activeVersion: 'v1',
    })!;
    const store = new SessionStore(sessionsDir, { integrityKeyring: keyring });
    store.append({
      channelId,
      role: 'user',
      content: 'valid source',
      timestamp: 1_775_050_000_000,
    });
    const auditRecords: Array<{ event: string; details: Record<string, unknown> }> = [];
    const disposition = createBackgroundWorkHandoffRecoveryDisposition({
      sessionsDir,
      backupRootDir: join(root, 'repair-backups'),
      integrityProvider: createKeyringIntegrityProvider(keyring)!,
      audit: {
        append: (event, details) => { auditRecords.push({ event, details }); },
      },
    });

    await expect(disposition.quarantineCorruptOwner({
      errno: 'EBADMSG',
      ownerSessionId: channelId,
    })).rejects.toMatchObject({
      name: 'BackgroundWorkHandoffRecoveryDispositionUnresolvedError',
      code: 'EUNRESOLVED',
    });
    expect(auditRecords.at(-1)).toEqual({
      event: BACKGROUND_WORK_HANDOFF_RECOVERY_DISPOSITION_AUDIT_EVENT,
      details: {
        outcome: 'unresolved',
        errno: 'EBADMSG',
        ownerSessionId: channelId,
        modifiedFiles: 0,
        modifiedEntries: 0,
        quarantinedRows: 0,
      },
    });
  });

  it('quarantines a structurally invalid TurnRecord row and continues healthy handoffs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'handoff-turn-record-quarantine-'));
    rootsToDelete.push(root);
    const sessionsDir = join(root, 'sessions');
    const corruptChannelId = 'api:corrupt-turn-record-owner';
    const healthyChannelId = 'api:healthy-turn-record-owner';
    const corruptRecord = makeBackgroundHandoffTurnRecord(
      corruptChannelId,
      1_775_100_000_000,
    );
    const healthyRecord = makeBackgroundHandoffTurnRecord(
      healthyChannelId,
      1_775_100_000_100,
    );
    const store = new SessionStore(sessionsDir, {
      turnRecordEligibilityFence: createSerialTurnRecordEligibilityFence(),
    });
    const manager = new SessionManager(store, makeConfig(root));
    for (const record of [corruptRecord, healthyRecord]) {
      manager.recordUserMessage(
        record.channelId,
        'retained source',
        'partner',
        'Partner',
        true,
        undefined,
        { turnId: record.turnId, requestId: record.requestId },
      );
      await manager.recordTurn(record);
    }

    const turnRecordPath = join(
      sessionsDir,
      '_turn_records',
      `${sanitizeChannelId(corruptChannelId)}.jsonl`,
    );
    appendFileSync(turnRecordPath, '{not-a-turn-record}\n');
    const enqueue = vi.fn(async () => undefined);

    await expect(new BackgroundWorkHandoffRecoveryRuntime(manager).recover(enqueue))
      .resolves.toBeUndefined();
    expect(enqueue.mock.calls.flatMap(call => call[0]).map(job => job.sourceChannelId).sort())
      .toEqual([corruptChannelId, healthyChannelId].sort());

    const quarantinePath = `${turnRecordPath}.quarantine`;
    const firstEvidence = readFileSync(quarantinePath, 'utf8');
    expect(firstEvidence).not.toContain('{not-a-turn-record}');
    expect(firstEvidence.trim().split('\n').map(line => JSON.parse(line)))
      .toEqual([expect.objectContaining({
        channelId: corruptChannelId,
        rawLength: '{not-a-turn-record}'.length,
        reason: 'invalid_turn_record_recovery_row',
      })]);

    const restartedManager = new SessionManager(
      new SessionStore(sessionsDir, {
        turnRecordEligibilityFence: createSerialTurnRecordEligibilityFence(),
      }),
      makeConfig(root),
    );
    const restartedEnqueue = vi.fn(async () => undefined);
    await expect(new BackgroundWorkHandoffRecoveryRuntime(restartedManager)
      .recover(restartedEnqueue)).resolves.toBeUndefined();

    expect(restartedEnqueue.mock.calls.flatMap(call => call[0])
      .map(job => job.sourceChannelId).sort())
      .toEqual([corruptChannelId, healthyChannelId].sort());
    expect(readFileSync(quarantinePath, 'utf8')).toBe(firstEvidence);
  });

  it('quarantines the exact malformed owner and resumes handoff recovery after restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'handoff-integrity-recovery-'));
    rootsToDelete.push(root);
    const sessionsDir = join(root, 'sessions');
    const backupRootDir = join(root, 'repair-backups');
    const channelId = 'api:production-handoff-owner';
    const healthyChannelId = 'api:production-healthy-owner';
    const keyring = buildSessionHmacKeyring({
      serializedKeys: 'v1:handoff-integrity-key',
      activeVersion: 'v1',
    })!;
    const integrityProvider = createKeyringIntegrityProvider(keyring)!;
    const record = makeBackgroundHandoffTurnRecord(channelId, 1_775_000_000_000);
    const healthyRecord = makeBackgroundHandoffTurnRecord(
      healthyChannelId,
      1_775_000_000_100,
    );
    const store = new SessionStore(sessionsDir, {
      integrityKeyring: keyring,
      turnRecordEligibilityFence: createSerialTurnRecordEligibilityFence(),
      backgroundWorkHandoffRecoveryDisposition: createBackgroundWorkHandoffRecoveryDisposition({
        sessionsDir,
        backupRootDir,
        integrityProvider,
      }),
    });
    const manager = new SessionManager(store, makeConfig(root));
    manager.recordUserMessage(
      channelId,
      'retained source',
      'partner',
      'Partner',
      true,
      undefined,
      { turnId: record.turnId, requestId: record.requestId },
    );
    await manager.recordTurn(record);
    manager.recordUserMessage(
      healthyChannelId,
      'retained healthy source',
      'partner',
      'Partner',
      true,
      undefined,
      { turnId: healthyRecord.turnId, requestId: healthyRecord.requestId },
    );
    await manager.recordTurn(healthyRecord);

    const journalPath = findSessionJournalPath(sessionsDir, 'production-handoff-owner');
    appendFileSync(journalPath, '{not-json}\n');
    const runtime = new BackgroundWorkHandoffRecoveryRuntime(manager);
    const preRepairEnqueue = vi.fn(async () => undefined);
    clearDiagnosticLogRingBufferForTests();

    await expect(runtime.recover(preRepairEnqueue)).resolves.toBeUndefined();
    expect(preRepairEnqueue).toHaveBeenCalledOnce();
    expect(preRepairEnqueue.mock.calls[0]?.[0][0]?.sourceChannelId).toBe(healthyChannelId);
    expect(ebadmsgWarnings(channelId)).toHaveLength(1);

    const dispositionDir = join(backupRootDir, readdirSync(backupRootDir)[0]!);
    const receipts = readFileSync(join(dispositionDir, 'quarantine-receipts.jsonl'), 'utf8');
    expect(receipts).not.toContain('{not-json}');
    expect(receipts.trim().split('\n').map(line => JSON.parse(line))).toEqual([
      expect.objectContaining({ phase: 'prepared', reason: 'invalid_json' }),
      expect.objectContaining({ phase: 'completed', rowCount: 1 }),
    ]);

    const restartedStore = new SessionStore(sessionsDir, {
      integrityKeyring: keyring,
      turnRecordEligibilityFence: createSerialTurnRecordEligibilityFence(),
      backgroundWorkHandoffRecoveryDisposition: createBackgroundWorkHandoffRecoveryDisposition({
        sessionsDir,
        backupRootDir,
        integrityProvider,
      }),
    });
    const restartedManager = new SessionManager(restartedStore, makeConfig(root));
    const restartedRuntime = new BackgroundWorkHandoffRecoveryRuntime(restartedManager);
    const enqueue = vi.fn(async () => undefined);
    clearDiagnosticLogRingBufferForTests();

    await expect(restartedRuntime.recover(enqueue)).resolves.toBeUndefined();
    await expect(restartedRuntime.recover(enqueue)).resolves.toBeUndefined();

    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue.mock.calls.flatMap(call => call[0]).map(job => job.sourceChannelId).sort())
      .toEqual([channelId, healthyChannelId].sort());
    expect(ebadmsgWarnings(channelId)).toEqual([]);
    expect(readdirSync(backupRootDir)).toHaveLength(1);
    expect(restartedStore.getRecent(channelId, 10).map(entry => entry.content))
      .toEqual(['retained source']);
  });
});
