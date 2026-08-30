import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fromAny } from '@total-typescript/shoehorn';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CogSecEventStore } from '../../../core/cogsec/events.js';
import { sessionIntegrityCaseId } from '../../../core/cogsec/session-integrity-incident.js';
import {
  buildSessionHmacKeyring,
} from '../../../persistence/journals/journal-utils.js';
import {
  resolveCogSecEventsPath,
  resolveSessionsDir,
} from '../../../persistence/layout.js';
import { createDefaultPostgresSessionAdapters } from '../../../persistence/sessions/postgres-adapters.js';
import { createKeyringIntegrityProvider } from '../../../persistence/sessions/store-primitives.js';
import { composeSessionRuntimeAsync } from './composition.js';

vi.mock('../../../persistence/sessions/postgres-adapters.js', async () => {
  const journalPort = await vi.importActual<typeof import('../../../persistence/journals/journal/port.js')>(
    '../../../persistence/journals/journal/port.js',
  );
  const turnRecords = await vi.importActual<typeof import('../../../persistence/sessions/turn-records.js')>(
    '../../../persistence/sessions/turn-records.js',
  );
  const createTranscriptProjection = () => ({
    upsertSessionEntry: vi.fn(),
    replaceChannelEntries: vi.fn(),
    countProjectedMessages: vi.fn(() => 0),
    markProjectionDrift: vi.fn(),
    clearProjectionDrift: vi.fn(),
    listProjectionDrift: vi.fn(() => []),
    flushPendingWrites: vi.fn(async () => undefined),
    searchByKeywords: vi.fn(async () => []),
  });

  return {
    createDefaultPostgresSessionAdapters: vi.fn(async (
      _databaseUrl: string,
      options: { sessionsDir: string },
    ) => {
      const transcriptProjection = createTranscriptProjection();
      return {
        sessionArchivePort: journalPort.createFilesystemSessionArchivePort(),
        transcriptProjection,
        transcriptSearch: transcriptProjection,
        turnRecordStore: turnRecords.createFilesystemTurnRecordStorePort(options.sessionsDir),
        turnRecordEligibilityFence: {
          withTurnRecordEligibilityFence: async (
            _key: unknown,
            operation: () => Promise<unknown>,
          ) => operation(),
          withTurnRecordEligibilityFences: async (
            _keys: readonly unknown[],
            operation: () => Promise<unknown>,
          ) => operation(),
        },
        conversationalActivityWorkset: {
          enumerate: vi.fn(async () => []),
          claim: vi.fn(async () => null),
          resumeClaim: vi.fn(async () => null),
          checkpointStage: vi.fn(async () => undefined),
          recordFailure: vi.fn(async () => undefined),
          checkpoint: vi.fn(async () => undefined),
        },
      };
    }),
  };
});

function productionConfig(companionDataDir: string) {
  return fromAny({
    companionDataDir,
    dataDir: companionDataDir,
    persistenceBackend: 'postgres',
    postgresDatabaseUrl: 'postgres://postgres:secret@localhost:5432/psfn_test',
    companionId: 'companion-test',
  });
}

function nextSeededRandom(state: { value: number }): number {
  state.value = (state.value * 1_664_525 + 1_013_904_223) >>> 0;
  return state.value;
}

function findJournalPath(sessionsDir: string, channelId: string): string {
  const filename = readdirSync(sessionsDir).find((candidate) => {
    if (!candidate.endsWith('.jsonl')) return false;
    return readFileSync(join(sessionsDir, candidate), 'utf8')
      .includes(`\"channelId\":\"${channelId}\"`);
  });
  if (!filename) throw new Error(`Missing generated journal for ${channelId}`);
  return join(sessionsDir, filename);
}

function tamperPayloadByte(
  journalPath: string,
  entryIndex: number,
  payload: string,
  random: number,
): void {
  const journal = readFileSync(journalPath);
  const lines = journal.toString('utf8').trimEnd().split('\n');
  const line = lines[entryIndex];
  if (!line) throw new Error(`Missing generated journal entry ${entryIndex}`);
  const payloadOffset = line.indexOf(payload);
  if (payloadOffset < 0) throw new Error(`Missing generated payload for entry ${entryIndex}`);

  const lineByteOffset = Buffer.byteLength(lines.slice(0, entryIndex).join('\n'))
    + (entryIndex === 0 ? 0 : 1);
  const payloadByteOffset = Buffer.byteLength(line.slice(0, payloadOffset));
  const randomPayloadOffset = random % Buffer.byteLength(payload);
  const absoluteOffset = lineByteOffset + payloadByteOffset + randomPayloadOffset;
  journal[absoluteOffset] = journal[absoluteOffset] === 0x78 ? 0x79 : 0x78;
  writeFileSync(journalPath, journal);
}

describe('production session integrity composition (bead psfn-framework-owffl.5)', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots.length = 0;
    vi.mocked(createDefaultPostgresSessionAdapters).mockClear();
  });

  it('rejects a null integrity provider before production can construct the store', async () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-production-integrity-fitness-'));
    roots.push(root);

    await expect(composeSessionRuntimeAsync(fromAny({
      runtimeMode: 'production',
      config: productionConfig(join(root, 'companion-data')),
      sessionIntegrityProvider: null,
      sessionIntegrityOperatorAlert: {
        notifier: { notify: vi.fn() },
        companionName: 'Test Companion',
      },
      automataRetentionCompanionId: 'companion-test',
    }))).rejects.toThrow('Production session composition requires a non-null integrity provider');

    expect(createDefaultPostgresSessionAdapters).not.toHaveBeenCalled();
  });

  it('detects seeded random byte tampering and dispatches the operator notification', async () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-production-integrity-tamper-'));
    roots.push(root);
    const companionDataDir = join(root, 'companion-data');
    const sessionsDir = resolveSessionsDir(companionDataDir);
    const keyring = buildSessionHmacKeyring({
      serializedKeys: 'v1:production-composition-proof-key',
      activeVersion: 'v1',
    });
    const integrityProvider = createKeyringIntegrityProvider(keyring);
    if (!integrityProvider) throw new Error('Expected a generated integrity provider');
    const notify = vi.fn(async () => ({ status: 'sent' as const, topic: 'operator-alerts' }));
    const operatorAlert = {
      notifier: { notify },
      companionName: 'Test Companion',
    };

    const writer = await composeSessionRuntimeAsync({
      runtimeMode: 'production',
      config: productionConfig(companionDataDir),
      sessionIntegrityProvider: integrityProvider,
      sessionIntegrityOperatorAlert: operatorAlert,
      automataRetentionCompanionId: 'companion-test',
    });
    const randomState = { value: 0x5eed_2026 };
    const vectors = Array.from({ length: 8 }, (_, channelIndex) => {
      const channelId = `api:tamper-proof-${channelIndex}`;
      const payloads = Array.from(
        { length: 9 },
        (__, entryIndex) => `generatedpayload${channelIndex}x${entryIndex}xabcdefghijklmnopqrstuvwxyz`,
      );
      for (const [entryIndex, payload] of payloads.entries()) {
        writer.sessionStore.append({
          channelId,
          role: entryIndex % 2 === 0 ? 'user' : 'assistant',
          content: payload,
          timestamp: 1_800_000_000_000 + channelIndex * 100 + entryIndex,
        });
      }
      const tamperedEntryIndex = nextSeededRandom(randomState) % payloads.length;
      tamperPayloadByte(
        findJournalPath(sessionsDir, channelId),
        tamperedEntryIndex,
        payloads[tamperedEntryIndex]!,
        nextSeededRandom(randomState),
      );
      return { channelId, payloads, tamperedEntryIndex };
    });

    const reader = await composeSessionRuntimeAsync({
      runtimeMode: 'production',
      config: productionConfig(companionDataDir),
      sessionIntegrityProvider: integrityProvider,
      sessionIntegrityOperatorAlert: operatorAlert,
      automataRetentionCompanionId: 'companion-test',
    });

    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(vectors.length));
    await vi.waitFor(() => {
      const events = new CogSecEventStore(resolveCogSecEventsPath(companionDataDir)).listEvents();
      expect(events).toHaveLength(vectors.length);
      expect(events.every(event => event.operatorAlertDeliveryStatus === 'delivered')).toBe(true);
    });

    const events = new CogSecEventStore(resolveCogSecEventsPath(companionDataDir)).listEvents();
    for (const vector of vectors) {
      const event = events.find(candidate => candidate.caseId === sessionIntegrityCaseId(vector.channelId));
      const failedEntryId = vector.tamperedEntryIndex + 1;
      expect(event).toMatchObject({
        type: 'session_integrity',
        sourceChannelId: vector.channelId,
        affectedMessageRanges: [{
          sourceChannelId: vector.channelId,
          logicalSessionId: vector.channelId,
          startEntryId: failedEntryId,
          endEntryId: failedEntryId,
        }],
        operatorAlertDeliveryStatus: 'delivered',
      });
      const entries = reader.sessionStore.getRecent(vector.channelId, vector.payloads.length);
      expect(entries.slice(0, vector.tamperedEntryIndex).every(
        entry => !entry.content.includes('<unverified_history'),
      )).toBe(true);
      expect(entries[vector.tamperedEntryIndex]?.content).toContain('<unverified_history');
    }
    expect(JSON.stringify(notify.mock.calls)).not.toContain('generatedpayload');
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      sender: {
        kind: 'system',
        provenance: 'system.operator_alert.session_integrity',
      },
      priority: 5,
      message: expect.stringContaining('First failed entry:'),
    }));
  });
});
