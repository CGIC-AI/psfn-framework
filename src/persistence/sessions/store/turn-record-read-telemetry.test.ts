import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TurnRecord } from '../../../shared/contracts/runtime.js';
import type { SessionEntry } from '../../../core/session/types.js';
import {
  RECENT_ENTRIES_REF_FIELD,
  slimTurnRecordSessionEntriesForAppend,
} from '../turn-record-session-refs.js';

const loggerSpies = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../../shared/logger.js', () => ({
  createComponentLogger: () => loggerSpies,
}));

const { TurnRecordReadTelemetryWindow, resetTurnRecordReadTelemetryTotalsForTests } = await import(
  './turn-record-read-telemetry.js'
);
const { SessionTurnRecordOperations } = await import('./turn-record-operations.js');
type OperationsContext = ConstructorParameters<typeof SessionTurnRecordOperations>[0];

function events(name: string): Array<Record<string, unknown>> {
  return loggerSpies.info.mock.calls
    .filter(call => call[0] === name)
    .map(call => call[1] as Record<string, unknown>);
}

function entry(id: number, content: string, channelId = 'ch:a'): SessionEntry {
  return { id, channelId, role: 'user', content, timestamp: id * 1_000 };
}

/** Ref-backed record whose L0 window is gone, so every id heal-drops on read. */
function refBackedRecord(turnId: string, entryIds: readonly number[]): TurnRecord {
  const snapshot: Record<string, unknown> = {
    turnId,
    requestId: `req-${turnId}`,
    channelId: 'ch:a',
    capturedAt: 1,
    trustLevel: 'regular',
    sessionContext: {
      channelId: 'ch:a',
      recentEntries: entryIds.map(id => entry(id, `body-${id}`)),
    },
  };
  const fat = {
    schemaVersion: 1,
    turnId,
    requestId: `req-${turnId}`,
    channelId: 'ch:a',
    channelType: 'api',
    startedAt: 1,
    completedAt: 2,
    status: 'completed',
    userMessage: { role: 'user', content: 'x', timestamp: 1 },
    toolCalls: [],
    extractedMemoryIds: [],
    concernDeltaRefs: [],
    contactDeltaRefs: [],
    versionPointers: { model: 'test/model' },
    provenanceRefs: [],
    observability: { stages: [], retrievals: [], snapshot },
  } as unknown as TurnRecord;
  return slimTurnRecordSessionEntriesForAppend(fat);
}

function operationsOver(records: readonly TurnRecord[], overrides: Partial<OperationsContext> = {}) {
  const unreachable = (name: string) => () => {
    throw new Error(`unexpected context call: ${name}`);
  };
  const context = {
    sessionsDir: '/tmp/does-not-exist',
    journalRuntime: null,
    turnRecordStore: {
      readRecentTurnRecords: (_sessionId: string, limit: number) => records.slice(0, limit),
    },
    turnRecordEligibilityFence: null,
    recoveryAuthoritySnapshotHook: undefined,
    isCorruptRecoveryOwnerRetired: () => false,
    resolveSessionId: (channelId: string) => channelId,
    resolveExistingSession: () => null,
    getChannelIndexEntry: () => undefined,
    ensureChannelIndexEntry: unreachable('ensureChannelIndexEntry'),
    getLoadedCache: () => undefined,
    loadExistingChannelCache: () => null,
    ensureChannelFullyLoaded: () => null,
    resolveJournalAuthoritativeTurnTombstones: () => new Set<string>(),
    syncTranscriptProjectionForChannel: () => {},
    upsertChannelIndex: () => {},
    // L0 is gone: every id-backed recentEntry heal-drops.
    getEntriesInRange: () => [],
    refreshChannelIndexFromDisk: () => {},
    assertSessionWritable: () => {},
    ...overrides,
  } as unknown as OperationsContext;
  return new SessionTurnRecordOperations(context);
}

beforeEach(() => {
  loggerSpies.info.mockClear();
  loggerSpies.warn.mockClear();
  resetTurnRecordReadTelemetryTotalsForTests();
});

describe('TurnRecordReadTelemetryWindow (psfn-framework-ylu4i)', () => {
  it('emits nothing when a read window observed no heal or withhold', () => {
    new TurnRecordReadTelemetryWindow({ readOperation: 'findTurnRecord', channelId: 'ch:a' })
      .flush({ completed: true });
    expect(loggerSpies.info).not.toHaveBeenCalled();
  });

  it('coalesces many heal-drops into one aggregate with exact totals and category counts', () => {
    const window = new TurnRecordReadTelemetryWindow({
      readOperation: 'getRecentTurnRecords',
      channelId: 'ch:a',
      limit: 50,
    });
    for (let i = 1; i <= 1_000; i += 1) {
      window.onHealDrop({
        channelId: 'ch:a',
        entryId: i,
        source: i % 2 === 0 ? 'ref-backed' : 'inline-old-fat',
        turnId: `turn-${i % 10}`,
      });
      window.countResolvedRecord();
    }
    window.flush({ completed: true, exhausted: true });

    const emitted = events('turn_record_recent_entry_heal_drop');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      readOperation: 'getRecentTurnRecords',
      readChannelId: 'ch:a',
      readLimit: 50,
      recordsRead: 1_000,
      windowCompleted: true,
      historyExhausted: true,
      droppedEntries: 1_000,
      recordsAffected: 10,
      sourceCounts: { 'inline-old-fat': 500, 'ref-backed': 500 },
      first: { channelId: 'ch:a', turnId: 'turn-1', entryId: 1 },
      last: { channelId: 'ch:a', turnId: 'turn-0', entryId: 1_000 },
      healDropsThisProcess: 1_000,
    });
  });

  it('keeps full evidence for a single unexpected drop', () => {
    const window = new TurnRecordReadTelemetryWindow({ readOperation: 'findTurnRecord', channelId: 'ch:a' });
    window.onHealDrop({ channelId: 'ch:a', entryId: 7, source: 'ref-backed', turnId: 'turn-x' });
    window.countResolvedRecord();
    window.flush({ completed: true });

    const [emitted] = events('turn_record_recent_entry_heal_drop');
    expect(emitted).toMatchObject({
      droppedEntries: 1,
      recordsAffected: 1,
      sourceCounts: { 'ref-backed': 1 },
      first: { channelId: 'ch:a', turnId: 'turn-x', entryId: 7 },
      last: { channelId: 'ch:a', turnId: 'turn-x', entryId: 7 },
    });
    expect(emitted.readLimit).toBeUndefined();
    expect(emitted.historyExhausted).toBeUndefined();
  });

  it('aggregates continuity withholds by reason code and keeps source provenance', () => {
    const window = new TurnRecordReadTelemetryWindow({ readOperation: 'readSourceTurnRecordPage', channelId: 'ch:a', limit: 2 });
    window.onContinuityWithheld({
      channelId: 'ch:a', sourceChannelId: 'ch:origin', sourceEntryId: 3, reason: 'source_redacted', turnId: 't1',
    });
    window.onContinuityWithheld({
      channelId: 'ch:a', sourceChannelId: 'ch:origin', sourceEntryId: 4, reason: 'source_redacted', turnId: 't1',
    });
    window.onContinuityWithheld({
      channelId: 'ch:a', sourceChannelId: 'ch:origin', reason: 'missing_source_ref', turnId: 't2',
    });
    window.flush({ completed: true, exhausted: false });

    const emitted = events('turn_record_continuity_withheld');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      continuityEntriesWithheld: 3,
      recordsAffected: 2,
      reasonCounts: { source_redacted: 2, missing_source_ref: 1 },
      first: { channelId: 'ch:origin', turnId: 't1', entryId: 3 },
      last: { channelId: 'ch:origin', turnId: 't2' },
      historyExhausted: false,
      continuityEntriesWithheldThisProcess: 3,
    });
    expect((emitted[0].last as Record<string, unknown>).entryId).toBeUndefined();
  });

  it('emits one aggregate per telemetry kind that actually occurred', () => {
    const window = new TurnRecordReadTelemetryWindow({ readOperation: 'getRecentTurnRecords', channelId: 'ch:a', limit: 1 });
    window.onWireBodyWithheld({ channelId: 'ch:a', turnId: 't1' });
    window.onMessageWithheld({ channelId: 'ch:a', entryId: 2, surface: 'assistantMessage', turnId: 't1' });
    window.onMessageWithheld({ channelId: 'ch:a', entryId: 1, surface: 'userMessage', turnId: 't1' });
    window.flush({ completed: true });

    expect(events('turn_record_wire_body_withheld')).toHaveLength(1);
    expect(events('turn_record_recent_entry_heal_drop')).toHaveLength(0);
    expect(events('turn_record_continuity_withheld')).toHaveLength(0);
    expect(events('turn_record_message_withheld')[0]).toMatchObject({
      messagesWithheld: 2,
      surfaceCounts: { assistantMessage: 1, userMessage: 1 },
    });
  });

  it('does not mix accounting between concurrently open windows', () => {
    const left = new TurnRecordReadTelemetryWindow({ readOperation: 'getRecentTurnRecords', channelId: 'ch:left', limit: 1 });
    const right = new TurnRecordReadTelemetryWindow({ readOperation: 'getRecentSourceTurnRecords', channelId: 'ch:right', limit: 1 });
    left.onHealDrop({ channelId: 'ch:left', entryId: 1, source: 'ref-backed', turnId: 'l1' });
    right.onHealDrop({ channelId: 'ch:right', entryId: 2, source: 'inline-old-fat', turnId: 'r1' });
    left.onHealDrop({ channelId: 'ch:left', entryId: 3, source: 'ref-backed', turnId: 'l2' });
    right.flush({ completed: true });
    left.flush({ completed: true });

    const [rightEvent, leftEvent] = events('turn_record_recent_entry_heal_drop');
    expect(rightEvent).toMatchObject({
      readChannelId: 'ch:right', droppedEntries: 1, sourceCounts: { 'inline-old-fat': 1 },
    });
    expect(leftEvent).toMatchObject({
      readChannelId: 'ch:left', droppedEntries: 2, sourceCounts: { 'ref-backed': 2 },
    });
    // Process-lifetime totals stay a running sum across both windows.
    expect(rightEvent.healDropsThisProcess).toBe(1);
    expect(leftEvent.healDropsThisProcess).toBe(3);
  });

  it('flushes at most once per window', () => {
    const window = new TurnRecordReadTelemetryWindow({ readOperation: 'findTurnRecord', channelId: 'ch:a' });
    window.onWireBodyWithheld({ channelId: 'ch:a', turnId: 't1' });
    window.flush({ completed: true });
    window.flush({ completed: true });
    expect(events('turn_record_wire_body_withheld')).toHaveLength(1);
  });
});

describe('SessionTurnRecordOperations read-window telemetry (psfn-framework-ylu4i)', () => {
  it('emits O(1) aggregate events for a page of thousands of ref-missing rows', () => {
    const rows = Array.from({ length: 2_000 }, (_, i) => refBackedRecord(`turn-${i}`, [i * 2 + 1, i * 2 + 2]));
    const operations = operationsOver(rows);

    const resolved = operations.getRecentTurnRecords('ch:a', rows.length);

    expect(resolved).toHaveLength(rows.length);
    const emitted = events('turn_record_recent_entry_heal_drop');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      readOperation: 'getRecentTurnRecords',
      readChannelId: 'ch:a',
      readLimit: rows.length,
      recordsRead: rows.length,
      windowCompleted: true,
      historyExhausted: false,
      droppedEntries: 4_000,
      recordsAffected: 2_000,
      sourceCounts: { 'ref-backed': 4_000 },
    });
    // Healing itself is unchanged: every unresolvable id-backed entry is dropped.
    for (const record of resolved) {
      const snapshot = record.observability!.snapshot as unknown as Record<string, unknown>;
      const context = snapshot.sessionContext as Record<string, unknown>;
      expect(context.recentEntries).toEqual([]);
      expect(context[RECENT_ENTRIES_REF_FIELD]).toBeUndefined();
    }
  });

  it('emits one aggregate per read, not one per process, for repeated bounded reads', () => {
    const rows = [refBackedRecord('turn-a', [1]), refBackedRecord('turn-b', [2])];
    const operations = operationsOver(rows);

    operations.getRecentTurnRecords('ch:a', 2);
    operations.getRecentTurnRecords('ch:a', 2);

    const emitted = events('turn_record_recent_entry_heal_drop');
    expect(emitted).toHaveLength(2);
    expect(emitted[0]).toMatchObject({ droppedEntries: 2, healDropsThisProcess: 2 });
    expect(emitted[1]).toMatchObject({ droppedEntries: 2, healDropsThisProcess: 4 });
  });

  it('flushes the partial window and rethrows when a resolver fails part-way', () => {
    const corrupt = refBackedRecord('turn-corrupt', [9]);
    const snapshot = corrupt.observability!.snapshot as unknown as Record<string, unknown>;
    // Both an inline copy and a ref is structural corruption: the resolver throws.
    (snapshot.sessionContext as Record<string, unknown>).recentEntries = [entry(9, 'x')];
    const operations = operationsOver([refBackedRecord('turn-ok', [1]), corrupt]);

    expect(() => operations.getRecentTurnRecords('ch:a', 2)).toThrow(/both inline recentEntries/);

    const emitted = events('turn_record_recent_entry_heal_drop');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      droppedEntries: 1,
      recordsRead: 1,
      windowCompleted: false,
      first: { channelId: 'ch:a', turnId: 'turn-ok', entryId: 1 },
    });
  });
});
