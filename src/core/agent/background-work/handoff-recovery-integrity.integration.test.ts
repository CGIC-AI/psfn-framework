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
import { runSessionIntegrityRepair } from '../../../persistence/repair/integrity-repair.js';
import type { TurnRecordEligibilityFencePort } from '../../../persistence/sessions/turn-record-eligibility-fence-port.js';
import { SessionStore } from '../../../persistence/sessions/store.js';
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
  it('quarantines the exact malformed owner and resumes handoff recovery after restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'handoff-integrity-recovery-'));
    rootsToDelete.push(root);
    const sessionsDir = join(root, 'sessions');
    const backupDir = join(root, 'repair-backup');
    const channelId = 'api:production-handoff-owner';
    const keyring = buildSessionHmacKeyring({
      serializedKeys: 'v1:handoff-integrity-key',
      activeVersion: 'v1',
    })!;
    const record = makeBackgroundHandoffTurnRecord(channelId, 1_775_000_000_000);
    const store = new SessionStore(sessionsDir, {
      integrityKeyring: keyring,
      turnRecordEligibilityFence: createSerialTurnRecordEligibilityFence(),
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

    const journalPath = findSessionJournalPath(sessionsDir, 'production-handoff-owner');
    appendFileSync(journalPath, '{not-json}\n');
    const runtime = new BackgroundWorkHandoffRecoveryRuntime(manager);
    const preRepairEnqueue = vi.fn(async () => undefined);
    clearDiagnosticLogRingBufferForTests();

    await expect(runtime.recover(preRepairEnqueue)).resolves.toBeUndefined();
    await expect(runtime.recover(preRepairEnqueue)).resolves.toBeUndefined();
    expect(preRepairEnqueue).not.toHaveBeenCalled();
    expect(ebadmsgWarnings(channelId)).toHaveLength(2);

    const report = runSessionIntegrityRepair({
      sessionsDir,
      backupDir,
      keyring,
      reason: 'repair exact EBADMSG background-work owner',
      targetChannelIds: [channelId],
    });
    expect(report.journal).toMatchObject({
      scannedFiles: 1,
      modifiedFiles: 1,
      quarantinedRows: 1,
    });
    expect(readFileSync(join(backupDir, journalPath.split('/').at(-1)!), 'utf8'))
      .toContain('{not-json}');

    const restartedStore = new SessionStore(sessionsDir, {
      integrityKeyring: keyring,
      turnRecordEligibilityFence: createSerialTurnRecordEligibilityFence(),
    });
    const restartedManager = new SessionManager(restartedStore, makeConfig(root));
    const restartedRuntime = new BackgroundWorkHandoffRecoveryRuntime(restartedManager);
    const enqueue = vi.fn(async () => undefined);
    clearDiagnosticLogRingBufferForTests();

    await expect(restartedRuntime.recover(enqueue)).resolves.toBeUndefined();
    await expect(restartedRuntime.recover(enqueue)).resolves.toBeUndefined();

    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue.mock.calls[0]?.[0]).toHaveLength(1);
    expect(ebadmsgWarnings(channelId)).toEqual([]);
    expect(restartedStore.getRecent(channelId, 10).map(entry => entry.content))
      .toEqual(['retained source']);
  });
});
