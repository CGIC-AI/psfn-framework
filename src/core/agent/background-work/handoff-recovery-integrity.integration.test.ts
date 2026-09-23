import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
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
import { BackgroundWorkHandoffRecoveryDispositionStore } from '../../../persistence/repair/background-work-handoff-recovery-disposition-store.js';
import { readCorruptTurnRecordRecoveryEvidence } from '../../../persistence/sessions/background-work-handoff-recovery-owner-evidence.js';
import {
  createKeyringIntegrityProvider,
  sanitizeChannelId,
} from '../../../persistence/sessions/store-primitives.js';
import {
  clearDiagnosticLogRingBufferForTests,
  getRecentDiagnosticLogRecords,
} from '../../../shared/logger.js';
import type { TurnRecord } from '../../../shared/contracts/runtime.js';
import type { JournalEntry } from '../../session/types.js';
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

function makeBackgroundHandoffTurnRecord(
  channelId: string,
  completedAt: number,
  logicalSessionId = channelId,
): TurnRecord {
  const turnId = createTurnId(completedAt);
  const record: TurnRecord = {
    schemaVersion: 1,
    turnId,
    requestId: `request-${turnId}`,
    sessionId: logicalSessionId,
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
      logicalSessionId,
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
        logicalSessionId,
        turnId,
        kind: payload.kind,
      }),
      logicalSessionId,
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

function signedJournalEntry(
  integrityProvider: NonNullable<ReturnType<typeof createKeyringIntegrityProvider>>,
  input: JournalEntry,
  previousHmac: string | null,
): JournalEntry {
  return integrityProvider.sign(input, previousHmac);
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

function createExactLineageFixture(rowOwner: 'logical' | 'sibling' | 'foreign' = 'logical') {
  const root = mkdtempSync(join(tmpdir(), 'handoff-exact-lineage-'));
  rootsToDelete.push(root);
  const sessionsDir = join(root, 'sessions');
  mkdirSync(sessionsDir);
  const channelId = 'api:lineage';
  const oldFilename = '20260301_api-lineage_partner_000001.jsonl';
  const filename = '20260302_api-lineage_partner_000002.jsonl';
  const sessionId = `${channelId}#${filename.slice(0, -'.jsonl'.length)}`;
  const siblingId = `${channelId}#${oldFilename.slice(0, -'.jsonl'.length)}`;
  const rowChannelId = rowOwner === 'logical' ? sessionId
    : rowOwner === 'sibling' ? siblingId : 'api:foreign-owner';
  const keyring = buildSessionHmacKeyring({
    serializedKeys: 'v1:exact-lineage-test-key', activeVersion: 'v1',
  })!;
  const integrityProvider = createKeyringIntegrityProvider(keyring)!;
  const retained = makeBackgroundHandoffTurnRecord(channelId, 1_775_060_000_000, sessionId);
  const redacted = makeBackgroundHandoffTurnRecord(channelId, 1_775_060_000_100, sessionId);
  const older = integrityProvider.sign({
    type: 'message', id: 1, channelId, role: 'user', content: 'Older session.', timestamp: 1,
  }, null);
  writeFileSync(join(sessionsDir, oldFilename), `${JSON.stringify(older)}\n`);
  const entries: JournalEntry[] = [];
  const append = (entry: JournalEntry): void => {
    entries.push(integrityProvider.sign(entry, entries.at(-1)?._hmac ?? null));
  };
  for (const record of [retained, redacted]) {
    append({
      type: 'message', id: entries.length + 1, channelId, role: 'user',
      content: 'Retained conversation source.', timestamp: record.completedAt,
      metadata: JSON.stringify({ turn: {
        schemaVersion: 1, turnId: record.turnId, requestId: record.requestId, role: 'user',
      } }),
    });
  }
  for (let index = 0; index < 6; index += 1) {
    append({
      type: 'message', id: entries.length + 1, channelId: rowChannelId,
      role: 'system', content: 'Native session-scoped continuity input.',
      timestamp: retained.completedAt + 200 + index,
    });
  }
  append({
    type: 'marker', id: entries.length + 1, channelId: rowChannelId,
    marker: 'graceful_shutdown', timestamp: retained.completedAt + 300,
  });
  append({
    type: 'tombstone', id: entries.length + 1, channelId: rowChannelId,
    tombstoneTargetType: 'turn', tombstoneTargetId: redacted.turnId,
    tombstoneAction: 'redact', timestamp: retained.completedAt + 400,
  });
  append({
    type: 'tombstone', id: entries.length + 1, channelId: rowChannelId,
    tombstoneTargetType: 'turn', tombstoneTargetId: redacted.turnId,
    tombstoneAction: 'restore', timestamp: retained.completedAt + 500,
  });
  // A forged exact-owner restore must never cancel the preceding signed redact.
  entries.at(-1)!._hmac = '0'.repeat(64);
  const journalPath = join(sessionsDir, filename);
  writeFileSync(journalPath, `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`);
  const store = new SessionStore(sessionsDir, {
    integrityKeyring: keyring,
    turnRecordEligibilityFence: createSerialTurnRecordEligibilityFence(),
  });
  return { root, store, channelId, sessionId, retained, redacted, journalPath, keyring, integrityProvider };
}

describe('background-work handoff integrity recovery', () => {
  it('recovers exact logical-owner system history without weakening signed tombstone authority', async () => {
    const fixture = createExactLineageFixture();
    await fixture.store.appendTurnRecord(fixture.retained);
    await fixture.store.appendTurnRecord(fixture.redacted);
    const before = readFileSync(fixture.journalPath, 'utf8');

    const primed = await fixture.store.primeTurnTombstoneAuthority();
    expect(primed.deferred).toEqual([]);
    expect(primed.primed).toBe(2);
    const enqueue = vi.fn(async () => undefined);
    const manager = new SessionManager(fixture.store, makeConfig(fixture.root));
    await new BackgroundWorkHandoffRecoveryRuntime(manager).recover(enqueue);

    expect(enqueue.mock.calls.flatMap(call => call[0].jobs).map(job => job.sourceTurnId))
      .toEqual([fixture.retained.turnId]);
    expect(ebadmsgWarnings(fixture.channelId)).toEqual([]);
    expect(readFileSync(fixture.journalPath, 'utf8')).toBe(before);
  });

  it.each(['sibling', 'foreign'] as const)('rejects a signed %s owner even in the same physical journal', async (rowOwner) => {
    const fixture = createExactLineageFixture(rowOwner);
    await fixture.store.appendTurnRecord(fixture.retained);
    const skipped: unknown[] = [];
    const recovered: TurnRecord[] = [];

    for await (const record of fixture.store.streamRecoverableBackgroundWorkTurnRecords(
      [fixture.channelId], { onEvidenceOwnerSkipped: skip => skipped.push(skip) },
    )) recovered.push(record);

    expect(recovered).toEqual([]);
    expect(skipped).toEqual([expect.objectContaining({
      errno: 'EBADMSG', ownerSessionId: fixture.sessionId,
    })]);
    const primed = await fixture.store.primeTurnTombstoneAuthority();
    expect(primed.deferred).toEqual([expect.objectContaining({
      sessionId: fixture.sessionId, reason: 'EBADMSG',
    })]);
  });

  it('keeps a prior generation retirement intact while a native shutdown makes corrected lineage recoverable', async () => {
    const fixture = createExactLineageFixture();
    await fixture.store.appendTurnRecord(fixture.retained);
    const backupRootDir = join(fixture.root, 'backups');
    const skip = readCorruptTurnRecordRecoveryEvidence(
      fixture.sessionId, fixture.channelId, [fixture.journalPath],
    );
    if (!skip) throw new Error('Expected exact source generation');
    const ledger = new BackgroundWorkHandoffRecoveryDispositionStore(backupRootDir);
    ledger.retire(skip);
    const ledgerPath = join(backupRootDir, 'background-work-handoff-recovery-dispositions.jsonl');
    const beforeLedger = readFileSync(ledgerPath, 'utf8');
    const store = new SessionStore(join(fixture.root, 'sessions'), {
      integrityKeyring: fixture.keyring,
      turnRecordEligibilityFence: createSerialTurnRecordEligibilityFence(),
      backgroundWorkHandoffRecoveryDisposition: createBackgroundWorkHandoffRecoveryDisposition({
        sessionsDir: join(fixture.root, 'sessions'),
        backupRootDir,
        integrityProvider: fixture.integrityProvider,
      }),
    });
    const collect = async (): Promise<TurnRecord[]> => {
      const records: TurnRecord[] = [];
      for await (const record of store.streamRecoverableBackgroundWorkTurnRecords([fixture.channelId])) {
        records.push(record);
      }
      return records;
    };

    expect(await collect()).toEqual([]);
    store.getRecent(fixture.sessionId, 1);
    expect(store.markGracefulShutdownForActiveChannels()).toContain(fixture.sessionId);
    expect((await collect()).map(record => record.turnId)).toEqual([fixture.retained.turnId]);
    expect(readFileSync(ledgerPath, 'utf8')).toBe(beforeLedger);
    expect(ledger.has(skip)).toBe(true);
  });

  it('durably retires only the unchanged zero-repair EBADMSG owner and continues recovery', async () => {
    const root = mkdtempSync(join(tmpdir(), 'handoff-noop-ebadmsg-'));
    rootsToDelete.push(root);
    const sessionsDir = join(root, 'sessions');
    const backupRootDir = join(root, 'repair-backups');
    const corruptChannelId = 'api:valid-noop-owner';
    const healthyChannelId = 'api:valid-noop-sibling';
    const keyring = buildSessionHmacKeyring({
      serializedKeys: 'v1:noop-handoff-key',
      activeVersion: 'v1',
    })!;
    const integrityProvider = createKeyringIntegrityProvider(keyring)!;
    const auditRecords: Array<{ event: string; details: Record<string, unknown> }> = [];
    const disposition = createBackgroundWorkHandoffRecoveryDisposition({
      sessionsDir,
      backupRootDir,
      integrityProvider,
      audit: {
        append: (event, details) => { auditRecords.push({ event, details }); },
      },
    });
    const store = new SessionStore(sessionsDir, {
      integrityKeyring: keyring,
      turnRecordEligibilityFence: createSerialTurnRecordEligibilityFence(),
      backgroundWorkHandoffRecoveryDisposition: disposition,
    });
    const manager = new SessionManager(store, makeConfig(root));
    const corruptRecord = makeBackgroundHandoffTurnRecord(
      corruptChannelId,
      1_775_050_000_000,
    );
    const healthyRecord = makeBackgroundHandoffTurnRecord(
      healthyChannelId,
      1_775_050_000_100,
    );
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

    const journalPath = findSessionJournalPath(sessionsDir, 'valid-noop-owner');
    const lastEntry = JSON.parse(
      readFileSync(journalPath, 'utf8').trim().split('\n').at(-1)!,
    ) as JournalEntry;
    const mismatchedEntry = integrityProvider.sign({
      type: 'message',
      id: lastEntry.id + 1,
      channelId: 'api:wrong-physical-owner',
      role: 'system',
      content: 'raw mismatched owner evidence remains preserved',
      timestamp: 1_775_050_000_010,
    }, lastEntry._hmac ?? null);
    appendFileSync(journalPath, `${JSON.stringify(mismatchedEntry)}\n`);
    const rawCorruptOwner = readFileSync(journalPath, 'utf8');
    const enqueue = vi.fn(async () => undefined);
    clearDiagnosticLogRingBufferForTests();

    await expect(new BackgroundWorkHandoffRecoveryRuntime(manager).recover(enqueue))
      .resolves.toBeUndefined();
    expect(enqueue.mock.calls.flatMap(call => call[0].jobs).map(job => job.sourceChannelId))
      .toEqual([healthyChannelId]);
    expect(readFileSync(journalPath, 'utf8')).toBe(rawCorruptOwner);
    expect(ebadmsgWarnings(corruptChannelId)).toHaveLength(1);

    const dispositionPath = join(
      backupRootDir,
      'background-work-handoff-recovery-dispositions.jsonl',
    );
    const firstDisposition = readFileSync(dispositionPath, 'utf8');
    expect(firstDisposition).not.toContain(corruptChannelId);
    expect(firstDisposition).not.toContain('raw mismatched owner evidence');
    expect(firstDisposition.trim().split('\n').map(line => JSON.parse(line)))
      .toEqual([expect.objectContaining({
        schemaVersion: 1,
        errno: 'EBADMSG',
      })]);
    expect(auditRecords).toContainEqual({
      event: BACKGROUND_WORK_HANDOFF_RECOVERY_DISPOSITION_AUDIT_EVENT,
      details: expect.objectContaining({
        outcome: 'retired_unchanged_owner',
        errno: 'EBADMSG',
        ownerSessionId: corruptChannelId,
        modifiedFiles: 0,
        modifiedEntries: 0,
        quarantinedRows: 0,
      }),
    });

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
    const restartedEnqueue = vi.fn(async () => undefined);
    clearDiagnosticLogRingBufferForTests();

    await expect(restartedRuntime.recover(restartedEnqueue)).resolves.toBeUndefined();
    await expect(restartedRuntime.recover(restartedEnqueue)).resolves.toBeUndefined();
    expect(restartedEnqueue.mock.calls.flatMap(call => call[0].jobs)
      .map(job => job.sourceChannelId)).toEqual([healthyChannelId]);
    expect(ebadmsgWarnings(corruptChannelId)).toEqual([]);
    expect(readFileSync(dispositionPath, 'utf8')).toBe(firstDisposition);
    expect(readFileSync(journalPath, 'utf8')).toBe(rawCorruptOwner);

    const laterEntry = integrityProvider.sign({
      type: 'message',
      id: mismatchedEntry.id + 1,
      channelId: corruptChannelId,
      role: 'user',
      content: 'later generation remains preserved',
      timestamp: 1_775_050_000_020,
    }, mismatchedEntry._hmac ?? null);
    appendFileSync(journalPath, `${JSON.stringify(laterEntry)}\n`);
    const laterRawOwner = readFileSync(journalPath, 'utf8');
    const changedStore = new SessionStore(sessionsDir, {
      integrityKeyring: keyring,
      turnRecordEligibilityFence: createSerialTurnRecordEligibilityFence(),
      backgroundWorkHandoffRecoveryDisposition: createBackgroundWorkHandoffRecoveryDisposition({
        sessionsDir,
        backupRootDir,
        integrityProvider,
      }),
    });
    clearDiagnosticLogRingBufferForTests();

    await expect(new BackgroundWorkHandoffRecoveryRuntime(
      new SessionManager(changedStore, makeConfig(root)),
    ).recover(async () => undefined)).resolves.toBeUndefined();

    expect(ebadmsgWarnings(corruptChannelId)).toHaveLength(1);
    expect(readFileSync(journalPath, 'utf8')).toBe(laterRawOwner);
    expect(readFileSync(dispositionPath, 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('retires only the routed logical owner chain when a physical channel has siblings', async () => {
    const root = mkdtempSync(join(tmpdir(), 'handoff-routed-owner-'));
    rootsToDelete.push(root);
    const sessionsDir = join(root, 'sessions');
    const backupRootDir = join(root, 'repair-backups');
    const physicalChannelId = 'api:shared-physical-owner';
    const selectedPath = join(
      sessionsDir,
      '20260817_api-shared-physical-owner_partner_000001.jsonl',
    );
    const siblingPath = join(
      sessionsDir,
      '20260817_api-shared-physical-owner_partner_000002.jsonl',
    );
    mkdirSync(sessionsDir, { recursive: true });
    const keyring = buildSessionHmacKeyring({
      serializedKeys: 'v1:routed-owner-key',
      activeVersion: 'v1',
    })!;
    const integrityProvider = createKeyringIntegrityProvider(keyring)!;
    const selectedFirst = signedJournalEntry(integrityProvider, {
      type: 'message',
      id: 1,
      channelId: physicalChannelId,
      role: 'user',
      content: 'selected physical history',
      timestamp: 1_775_060_000_000,
    }, null);
    const selectedMismatch = signedJournalEntry(integrityProvider, {
      type: 'message',
      id: 2,
      channelId: 'api:wrong-routed-owner',
      role: 'system',
      content: 'selected raw mismatch remains preserved',
      timestamp: 1_775_060_000_010,
    }, selectedFirst._hmac ?? null);
    const siblingFirst = signedJournalEntry(integrityProvider, {
      type: 'message',
      id: 1,
      channelId: physicalChannelId,
      role: 'user',
      content: 'sibling repairable history',
      timestamp: 1_775_060_000_100,
    }, null);
    writeFileSync(selectedPath, `${JSON.stringify(selectedFirst)}\n${JSON.stringify(selectedMismatch)}\n`);
    writeFileSync(siblingPath, `${JSON.stringify(siblingFirst)}\n{not-json}\n`);
    const selectedBefore = readFileSync(selectedPath, 'utf8');
    const siblingBefore = readFileSync(siblingPath, 'utf8');
    const disposition = createBackgroundWorkHandoffRecoveryDisposition({
      sessionsDir,
      backupRootDir,
      integrityProvider,
    });
    const store = new SessionStore(sessionsDir, {
      integrityKeyring: keyring,
      turnRecordEligibilityFence: createSerialTurnRecordEligibilityFence(),
      backgroundWorkHandoffRecoveryDisposition: disposition,
    });
    const routedOwner = store.listChannels().find(channel => (
      channel.channelId === physicalChannelId
      && channel.sessionId.includes('000001')
    ));
    expect(routedOwner).toBeDefined();
    expect(routedOwner!.sessionId).not.toBe(physicalChannelId);
    const record = makeBackgroundHandoffTurnRecord(
      physicalChannelId,
      1_775_060_000_000,
      routedOwner!.sessionId,
    );
    const manager = new SessionManager(store, makeConfig(root));
    await manager.recordTurn(record);
    clearDiagnosticLogRingBufferForTests();

    await expect(new BackgroundWorkHandoffRecoveryRuntime(manager)
      .recover(async () => undefined)).resolves.toBeUndefined();

    expect(readFileSync(selectedPath, 'utf8')).toBe(selectedBefore);
    expect(readFileSync(siblingPath, 'utf8')).toBe(siblingBefore);
    const dispositionPath = join(
      backupRootDir,
      'background-work-handoff-recovery-dispositions.jsonl',
    );
    expect(readFileSync(dispositionPath, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('does not latch a replacement generation written during the retirement lookup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'handoff-retired-owner-race-'));
    rootsToDelete.push(root);
    const sessionsDir = join(root, 'sessions');
    const channelId = 'api:retired-owner-race';
    const keyring = buildSessionHmacKeyring({
      serializedKeys: 'v1:retired-owner-race-key',
      activeVersion: 'v1',
    })!;
    const integrityProvider = createKeyringIntegrityProvider(keyring)!;
    let journalPath = '';
    let replacementEntry: JournalEntry | null = null;
    let generationAFingerprint = '';
    let replacementWritten = false;
    const retirementChecks = vi.fn((skip: { sourceFingerprint: string }) => {
      if (!replacementWritten) {
        generationAFingerprint = skip.sourceFingerprint;
        appendFileSync(journalPath, `${JSON.stringify(replacementEntry)}\n`);
        replacementWritten = true;
        return true;
      }
      return false;
    });
    const quarantine = vi.fn(async () => undefined);
    const store = new SessionStore(sessionsDir, {
      integrityKeyring: keyring,
      turnRecordEligibilityFence: createSerialTurnRecordEligibilityFence(),
      backgroundWorkHandoffRecoveryDisposition: {
        isCorruptOwnerRetired: retirementChecks,
        quarantineCorruptOwner: quarantine,
      },
    });
    const manager = new SessionManager(store, makeConfig(root));
    const record = makeBackgroundHandoffTurnRecord(channelId, 1_775_070_000_000);
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
    journalPath = findSessionJournalPath(sessionsDir, 'retired-owner-race');
    const lastEntry = JSON.parse(
      readFileSync(journalPath, 'utf8').trim().split('\n').at(-1)!,
    ) as JournalEntry;
    const generationAEntry = signedJournalEntry(integrityProvider, {
      type: 'message',
      id: lastEntry.id + 1,
      channelId: 'api:retired-owner-race-wrong',
      role: 'system',
      content: 'generation A structural poison',
      timestamp: 1_775_070_000_010,
    }, lastEntry._hmac ?? null);
    appendFileSync(journalPath, `${JSON.stringify(generationAEntry)}\n`);
    replacementEntry = signedJournalEntry(integrityProvider, {
      type: 'message',
      id: generationAEntry.id + 1,
      channelId,
      role: 'system',
      content: 'generation B replacement evidence',
      timestamp: 1_775_070_000_020,
    }, generationAEntry._hmac ?? null);
    const runtime = new BackgroundWorkHandoffRecoveryRuntime(manager);

    await expect(runtime.recover(async () => undefined)).resolves.toBeUndefined();
    await expect(runtime.recover(async () => undefined)).resolves.toBeUndefined();

    expect(retirementChecks).toHaveBeenCalledTimes(3);
    expect(quarantine).toHaveBeenCalledTimes(2);
    const quarantinedFingerprints = quarantine.mock.calls
      .map(([skip]) => skip.sourceFingerprint);
    expect(generationAFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(quarantinedFingerprints[0]).not.toBe(generationAFingerprint);
    expect(quarantinedFingerprints[0]).toBe(quarantinedFingerprints[1]);
    expect(readFileSync(journalPath, 'utf8')).toContain('generation B replacement evidence');
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
    expect(enqueue.mock.calls.flatMap(call => call[0].jobs).map(job => job.sourceChannelId).sort())
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

    expect(restartedEnqueue.mock.calls.flatMap(call => call[0].jobs)
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
    expect(preRepairEnqueue.mock.calls[0]?.[0].jobs[0]?.sourceChannelId).toBe(healthyChannelId);
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
    expect(enqueue.mock.calls.flatMap(call => call[0].jobs).map(job => job.sourceChannelId).sort())
      .toEqual([channelId, healthyChannelId].sort());
    expect(ebadmsgWarnings(channelId)).toEqual([]);
    expect(readdirSync(backupRootDir)).toHaveLength(1);
    expect(restartedStore.getRecent(channelId, 10).map(entry => entry.content))
      .toEqual(['retained source']);
  });
});
