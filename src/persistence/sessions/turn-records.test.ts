import { appendFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolSchema, TurnRecord } from '../../shared/contracts/runtime.js';
import type { TurnSnapshotRecord } from '../../core/turns/observability.js';
import type { TurnRecordStorePort } from './turn-record-store-port.js';
import { backfillLegacyTurnId } from '../../core/turns/id.js';
import { createTurnRecordSharedStore } from './turn-record-shared-store.js';
import { sanitizeChannelId } from './store-file-contracts.js';
import {
  appendTurnRecordWithRotation,
  createFilesystemTurnRecordStorePort,
  getQuarantinedTurnRecordLineCount,
  readRecentTurnRecordsAcrossSegments,
  type TurnRecordTailStats,
} from './turn-records.js';

/**
 * Deterministic fault injection for the concurrency tests: `node:fs` delegates
 * to the real implementation unless a specific failure is armed. openSync
 * ENOENT simulates a rotation deleting a listed file mid-read; linkSync EEXIST
 * (which first CREATES the destination, like the racing writer would) simulates
 * a concurrent rotation claiming the same segment number.
 */
const fsFaults = vi.hoisted(() => ({
  openSyncEnoent: { path: null as string | null, remaining: 0 },
  linkSyncClaim: { remaining: 0, claimContent: '' },
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const enoent = (path: unknown): NodeJS.ErrnoException => {
    const error = new Error(`ENOENT: no such file or directory, open '${String(path)}'`) as NodeJS.ErrnoException;
    error.code = 'ENOENT';
    return error;
  };
  return {
    ...actual,
    openSync: ((path, flags, mode) => {
      if (fsFaults.openSyncEnoent.remaining > 0 && String(path) === fsFaults.openSyncEnoent.path) {
        fsFaults.openSyncEnoent.remaining -= 1;
        throw enoent(path);
      }
      return actual.openSync(path, flags, mode);
    }) as typeof actual.openSync,
    linkSync: ((existingPath, newPath) => {
      if (fsFaults.linkSyncClaim.remaining > 0) {
        fsFaults.linkSyncClaim.remaining -= 1;
        // The racing writer claims the destination first...
        actual.writeFileSync(newPath, fsFaults.linkSyncClaim.claimContent, 'utf-8');
        // ...so the exclusive create observes EEXIST, exactly as on POSIX.
        const error = new Error(`EEXIST: file already exists, link '${String(existingPath)}' -> '${String(newPath)}'`) as NodeJS.ErrnoException;
        error.code = 'EEXIST';
        throw error;
      }
      return actual.linkSync(existingPath, newPath);
    }) as typeof actual.linkSync,
  };
});

afterEach(() => {
  fsFaults.openSyncEnoent.path = null;
  fsFaults.openSyncEnoent.remaining = 0;
  fsFaults.linkSyncClaim.remaining = 0;
  fsFaults.linkSyncClaim.claimContent = '';
});

const TURN_RECORDS_DIR = '_turn_records';

function activeSegmentPathFor(sessionsDir: string, channelId: string): string {
  return join(sessionsDir, TURN_RECORDS_DIR, `${sanitizeChannelId(channelId)}.jsonl`);
}

function createTurnRecord(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    schemaVersion: 1,
    turnId: '019d2326-d9e1-701d-bcee-250d2cbb0e4e',
    requestId: 'req-psfn-amica',
    channelId: 'psfn-amica:test:pi5',
    channelType: 'psfn-amica',
    startedAt: 1_742_000_000_000,
    completedAt: 1_742_000_000_500,
    status: 'completed',
    userMessage: {
      role: 'user',
      content: 'hello',
      timestamp: 1_742_000_000_000,
      authorId: 'pi5',
      authorName: 'Pi5',
    },
    assistantMessage: {
      role: 'assistant',
      content: 'ok',
      timestamp: 1_742_000_000_500,
      authorId: 'companion',
      authorName: 'Companion',
    },
    toolCalls: [],
    extractedMemoryIds: [],
    concernDeltaRefs: [],
    contactDeltaRefs: [],
    versionPointers: {
      model: 'psfn',
    },
    provenanceRefs: [],
    ...overrides,
  };
}

describe('turn-records', () => {
  it('persists and reads psfn-amica turn records', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-psfn-amica-turn-records-'));
    const record = createTurnRecord();
    const turnRecordStore: TurnRecordStorePort = createFilesystemTurnRecordStorePort(sessionsDir);

    turnRecordStore.appendTurnRecord(record);

    expect(turnRecordStore.readRecentTurnRecords(record.channelId, 5)).toEqual([record]);
  });

  it('round-trips a bounded background handoff and rejects cross-turn bindings', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-turn-records-background-handoff-'));
    const base = createTurnRecord();
    const job = {
      jobId: 'bgw_test',
      idempotencyKey: 'background-work:v1:test',
      logicalSessionId: base.channelId,
      kind: 'memory_extraction' as const,
      payload: { schemaVersion: 1, kind: 'memory_extraction' },
      payloadFingerprint: 'a'.repeat(64),
      sourceTurnId: base.turnId,
      sourceRequestId: base.requestId,
      sourceChannelId: base.channelId,
      createdAtMs: base.completedAt,
      maxAttempts: 5,
    };
    const record = createTurnRecord({
      backgroundWorkHandoff: { schemaVersion: 1, jobs: [job] },
    });
    const turnRecordStore = createFilesystemTurnRecordStorePort(sessionsDir);

    turnRecordStore.appendTurnRecord(record);
    expect(turnRecordStore.readRecentTurnRecords(record.channelId, 5)).toEqual([record]);
    expect(() => turnRecordStore.appendTurnRecord(createTurnRecord({
      turnId: backfillLegacyTurnId('different-turn'),
      backgroundWorkHandoff: { schemaVersion: 1, jobs: [job] },
    }))).toThrow('does not bind to its owning turn');
  });

  it('round-trips the typed content-free parent-turn continuation stop', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-turn-records-continuation-stop-'));
    const record = createTurnRecord({
      status: 'failed',
      assistantMessage: undefined,
      continuationStop: {
        schemaVersion: 1,
        reason: 'wall_clock_limit',
        outcome: 'failed',
        promptEntries: 9,
        maxPromptEntries: 36,
        elapsedMs: 300_000,
        maxWallTimeMs: 300_000,
      },
    });
    const turnRecordStore = createFilesystemTurnRecordStorePort(sessionsDir);

    turnRecordStore.appendTurnRecord(record);

    expect(turnRecordStore.readRecentTurnRecords(record.channelId, 5)).toEqual([record]);
    expect(JSON.stringify(record.continuationStop)).not.toContain(record.userMessage.content);
  });

  it('round-trips a durable satellite/place location', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-turn-records-location-'));
    const record = createTurnRecord({
      location: { placeId: 'living_room', satelliteId: 'pi-voice' },
    });
    const turnRecordStore = createFilesystemTurnRecordStorePort(sessionsDir);

    turnRecordStore.appendTurnRecord(record);

    const read = turnRecordStore.readRecentTurnRecords(record.channelId, 5);
    expect(read).toEqual([record]);
    expect(read[0]?.location).toEqual({ placeId: 'living_room', satelliteId: 'pi-voice' });
  });

  it('round-trips a durable ICP suppression correlation', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-turn-records-icp-correlation-'));
    const companionA = '11111111-1111-4111-8111-111111111111';
    const companionB = '22222222-2222-4222-8222-222222222222';
    const channelId = `companion-dm:${companionA}:${companionB}`;
    const turnId = '019d2326-d9e1-701d-bcee-250d2cbb0e4e';
    const requestId = 'companion-reply-11111111-1111-4111-8111-111111111111-prior-turn';
    const record = createTurnRecord({
      channelId,
      channelType: 'companion',
      turnId,
      requestId,
      assistantMessage: undefined,
      icpCorrelation: {
        conversationId: '33333333-3333-4333-8333-333333333333',
        rootInitiationId: '44444444-4444-4444-8444-444444444444',
        initiatedByCompanionId: companionA,
        localCompanionId: companionB,
        peerCompanionId: companionA,
        peerContactId: 'contact-a',
        channelId,
        turnId,
        messageId: requestId,
        requestId,
        chargeLane: 'companion_social',
        surface: 'companion_dm',
        costPurpose: 'conversation_turn',
        costOriginStage: 'reply',
        fatigueDecision: 'suppress',
        fatigueReasonCode: 'fatigue_exhausted',
      },
    });
    const turnRecordStore = createFilesystemTurnRecordStorePort(sessionsDir);

    turnRecordStore.appendTurnRecord(record);

    expect(turnRecordStore.readRecentTurnRecords(channelId, 5)).toEqual([record]);
  });

  it('round-trips logical session provenance and pages past the newest records', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'turn-records-session-provenance-'));
    const turnRecordStore = createFilesystemTurnRecordStorePort(sessionsDir);
    const records = Array.from({ length: 4 }, (_, index) => createTurnRecord({
      turnId: `019d2326-d9e1-701d-bcee-250d2cbb0e${index + 1}e`,
      requestId: `request-${index + 1}`,
      sessionId: 'session:logical-after-reset',
      completedAt: 1_700_000_000_100 + index,
    }));
    for (const record of records) turnRecordStore.appendTurnRecord(record);

    expect(turnRecordStore.readRecentTurnRecords(records[0]!.channelId, 2, 0)).toEqual(records.slice(2));
    expect(turnRecordStore.readRecentTurnRecords(records[0]!.channelId, 2, 2)).toEqual(records.slice(0, 2));
    expect(turnRecordStore.readRecentTurnRecords(records[0]!.channelId, 2, 4)).toEqual([]);
    expect(turnRecordStore.readRecentTurnRecords(records[0]!.channelId, 1)[0]?.sessionId)
      .toBe('session:logical-after-reset');
  });

  it('omits location for turns that carried no place binding (legacy rows load fine)', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-turn-records-nolocation-'));
    const record = createTurnRecord();
    const turnRecordStore = createFilesystemTurnRecordStorePort(sessionsDir);

    turnRecordStore.appendTurnRecord(record);

    const read = turnRecordStore.readRecentTurnRecords(record.channelId, 5);
    expect(read).toEqual([record]);
    expect(read[0]).not.toHaveProperty('location');
  });

  it('finds an old durable completion marker without a recent-record cap', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-turn-records-marker-'));
    const turnRecordStore = createFilesystemTurnRecordStorePort(sessionsDir, {
      segmentMaxBytes: 8,
    });
    const old = createTurnRecord({ turnId: backfillLegacyTurnId('old-completion-marker') });
    turnRecordStore.appendTurnRecord(old);
    for (let index = 0; index < 40; index += 1) {
      turnRecordStore.appendTurnRecord(createTurnRecord({
        turnId: backfillLegacyTurnId(`newer-turn-${index}`),
        requestId: `newer-request-${index}`,
        startedAt: old.startedAt + index + 1,
        completedAt: old.completedAt + index + 1,
      }));
    }

    expect(turnRecordStore.findTurnRecord(old.channelId, old.turnId)).toEqual(old);
  });

  it('round-trips assistant runtime fallback provenance', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-turn-records-runtime-fallback-'));
    const record = createTurnRecord({
      assistantMessage: {
        role: 'assistant',
        content: 'The image reader failed before I could inspect the attachment.',
        timestamp: 1_742_000_000_500,
        runtimeFallbackProvenance: {
          schemaVersion: 1,
          authoredBy: 'runtime',
          model: 'runtime-fallback',
          strategy: 'runtime_nonfabricating_notice',
        },
      },
    });
    const turnRecordStore = createFilesystemTurnRecordStorePort(sessionsDir);

    turnRecordStore.appendTurnRecord(record);

    expect(turnRecordStore.readRecentTurnRecords(record.channelId, 5)).toEqual([record]);
  });
});

const ROTATION_CHANNEL = 'psfn-amica:rotation:pi5';

function sequencedRecord(index: number, channelId = ROTATION_CHANNEL): TurnRecord {
  const startedAt = 1_742_000_000_000 + index * 1_000;
  return createTurnRecord({
    channelId,
    requestId: `req-${index}`,
    startedAt,
    completedAt: startedAt + 500,
    userMessage: {
      role: 'user',
      content: `message-${index}`,
      timestamp: startedAt,
      authorId: 'device',
      authorName: 'Device',
    },
    assistantMessage: {
      role: 'assistant',
      content: `reply-${index}`,
      timestamp: startedAt + 500,
      authorId: 'companion',
      authorName: 'Companion',
    },
  });
}

describe('turn-records rotation and bounded tail reads', () => {
  it('rotates past the cap and reads records spanning segment boundaries in order', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-turn-records-rotation-'));
    const store = createFilesystemTurnRecordStorePort(sessionsDir, { segmentMaxBytes: 10 });

    const records = [0, 1, 2, 3].map((i) => sequencedRecord(i));
    for (const record of records) store.appendTurnRecord(record);

    // A tiny cap forces a rotation on every append after the first, so multiple
    // numbered segments plus an active file must exist.
    const dir = join(sessionsDir, TURN_RECORDS_DIR);
    const sanitized = sanitizeChannelId(ROTATION_CHANNEL);
    const names = readdirSync(dir);
    expect(names).toContain(`${sanitized}.jsonl`);
    const segmentNames = names.filter((n) => /\.\d{5}\.jsonl$/.test(n));
    expect(segmentNames.length).toBeGreaterThanOrEqual(2);

    // The stream reads as one logical sequence across every segment, oldest-first.
    expect(store.readRecentTurnRecords(ROTATION_CHANNEL, 10)).toEqual(records);

    // A limit smaller than the total returns only the newest, still ordered.
    expect(store.readRecentTurnRecords(ROTATION_CHANNEL, 2)).toEqual([records[2], records[3]]);
  });

  it('reads correctly from a pre-existing file larger than the cap and rotates on next append', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-turn-records-oversized-'));
    // Build one oversized active file BEFORE any rotation knowledge exists.
    const bigStore = createFilesystemTurnRecordStorePort(sessionsDir, {
      segmentMaxBytes: 1024 * 1024,
    });
    const existing = [0, 1, 2, 3, 4].map((i) => sequencedRecord(i));
    for (const record of existing) bigStore.appendTurnRecord(record);

    const activePath = activeSegmentPathFor(sessionsDir, ROTATION_CHANNEL);
    const oversizedBytes = statSync(activePath).size;
    expect(oversizedBytes).toBeGreaterThan(0);

    // Reads work on the oversized file regardless of the (now smaller) cap.
    const smallCapStore = createFilesystemTurnRecordStorePort(sessionsDir, {
      segmentMaxBytes: 8,
    });
    expect(smallCapStore.readRecentTurnRecords(ROTATION_CHANNEL, 10)).toEqual(existing);

    // Next append notices the oversized active file and rotates it into a segment.
    const next = sequencedRecord(5);
    smallCapStore.appendTurnRecord(next);
    const dir = join(sessionsDir, TURN_RECORDS_DIR);
    const sanitized = sanitizeChannelId(ROTATION_CHANNEL);
    expect(readdirSync(dir).some((n) => new RegExp(`^${sanitized}\\.\\d{5}\\.jsonl$`).test(n))).toBe(true);
    expect(smallCapStore.readRecentTurnRecords(ROTATION_CHANNEL, 10)).toEqual([...existing, next]);
  });

  it('reads only a bounded number of bytes from the tail of a large file', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-turn-records-bounded-'));
    // No rotation: a single large file, so the tail read must not touch the head.
    const store = createFilesystemTurnRecordStorePort(sessionsDir, {
      segmentMaxBytes: 1024 * 1024 * 1024,
    });
    const total = 200;
    for (let i = 0; i < total; i++) store.appendTurnRecord(sequencedRecord(i));

    const activePath = activeSegmentPathFor(sessionsDir, ROTATION_CHANNEL);
    const fileSize = statSync(activePath).size;
    expect(fileSize).toBeGreaterThan(20_000);

    const stats: TurnRecordTailStats = { bytesRead: 0 };
    const read = readRecentTurnRecordsAcrossSegments(sessionsDir, ROTATION_CHANNEL, 2, {
      scanChunkBytes: 512,
      stats,
    });

    expect(read).toEqual([sequencedRecord(total - 2), sequencedRecord(total - 1)]);
    // Reading the last 2 of 200 records must scan far fewer bytes than the file.
    expect(stats.bytesRead).toBeGreaterThan(0);
    expect(stats.bytesRead).toBeLessThan(fileSize / 4);
    expect(stats.bytesRead).toBeLessThan(4_096);
  });

  it('quarantines a trailing partial line from an interrupted append, keeping valid records', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-turn-records-partial-'));
    const store = createFilesystemTurnRecordStorePort(sessionsDir);
    const good = sequencedRecord(0);
    store.appendTurnRecord(good);

    // Simulate a crash mid-append: a truncated JSON fragment with no trailing newline.
    const activePath = activeSegmentPathFor(sessionsDir, ROTATION_CHANNEL);
    appendFileSync(activePath, '{"schemaVersion":1,"turnId":"019d2326-d9e1', 'utf-8');

    // The valid record still loads; the partial is quarantined, not fatal.
    expect(store.readRecentTurnRecords(ROTATION_CHANNEL, 5)).toEqual([good]);
    expect(existsSync(`${activePath}.quarantine`)).toBe(true);
  });

  it('quarantines an interior corrupt line and continues reading surrounding records', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-turn-records-interior-'));
    const store = createFilesystemTurnRecordStorePort(sessionsDir);
    const first = sequencedRecord(0);
    const second = sequencedRecord(1);
    store.appendTurnRecord(first);

    // Inject a fully-terminated but unparseable line between two valid records.
    const activePath = activeSegmentPathFor(sessionsDir, ROTATION_CHANNEL);
    appendFileSync(activePath, 'this-is-not-json\n', 'utf-8');
    store.appendTurnRecord(second);

    expect(store.readRecentTurnRecords(ROTATION_CHANNEL, 5)).toEqual([first, second]);
    expect(existsSync(`${activePath}.quarantine`)).toBe(true);
  });

  it('increments the process-lifetime quarantine counter event when a line is quarantined', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-turn-records-quarantine-counter-'));
    const store = createFilesystemTurnRecordStorePort(sessionsDir);
    store.appendTurnRecord(sequencedRecord(0));
    const activePath = activeSegmentPathFor(sessionsDir, ROTATION_CHANNEL);
    appendFileSync(activePath, 'not-json-either\n', 'utf-8');

    const before = getQuarantinedTurnRecordLineCount();
    expect(store.readRecentTurnRecords(ROTATION_CHANNEL, 5)).toEqual([sequencedRecord(0)]);
    expect(getQuarantinedTurnRecordLineCount()).toBe(before + 1);
  });

  it('directly exercises rotation via appendTurnRecordWithRotation', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-turn-records-direct-'));
    appendTurnRecordWithRotation(sessionsDir, sequencedRecord(0), 8);
    appendTurnRecordWithRotation(sessionsDir, sequencedRecord(1), 8);

    const dir = join(sessionsDir, TURN_RECORDS_DIR);
    const sanitized = sanitizeChannelId(ROTATION_CHANNEL);
    expect(readdirSync(dir).filter((n) => new RegExp(`^${sanitized}\\.\\d{5}\\.jsonl$`).test(n)).length)
      .toBe(1);
    expect(readRecentTurnRecordsAcrossSegments(sessionsDir, ROTATION_CHANNEL, 5)).toEqual([
      sequencedRecord(0),
      sequencedRecord(1),
    ]);
  });
});
describe('turn-records rotation/read concurrency (hgw3 review findings)', () => {
  it('rotates around a pre-existing destination segment without clobbering it', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-turn-records-preexisting-'));
    const dir = join(sessionsDir, TURN_RECORDS_DIR);
    const sanitized = sanitizeChannelId(ROTATION_CHANNEL);

    // A completed segment already occupies the first number (e.g. written by
    // another process); its bytes must survive the next rotation untouched.
    const preexisting = `${JSON.stringify(sequencedRecord(90))}\n`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${sanitized}.00001.jsonl`), preexisting, 'utf-8');

    const store = createFilesystemTurnRecordStorePort(sessionsDir, { segmentMaxBytes: 8 });
    store.appendTurnRecord(sequencedRecord(0));
    store.appendTurnRecord(sequencedRecord(1)); // triggers rotation of record 0

    expect(readFileSync(join(dir, `${sanitized}.00001.jsonl`), 'utf-8')).toBe(preexisting);
    expect(readFileSync(join(dir, `${sanitized}.00002.jsonl`), 'utf-8')).toContain('"message-0"');
    expect(store.readRecentTurnRecords(ROTATION_CHANNEL, 10)).toEqual([
      sequencedRecord(90),
      sequencedRecord(0),
      sequencedRecord(1),
    ]);
  });

  it('retries with the next number when a concurrent writer claims the destination between scan and link', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-turn-records-linkrace-'));
    const dir = join(sessionsDir, TURN_RECORDS_DIR);
    const sanitized = sanitizeChannelId(ROTATION_CHANNEL);
    const store = createFilesystemTurnRecordStorePort(sessionsDir, { segmentMaxBytes: 8 });
    store.appendTurnRecord(sequencedRecord(0));

    // Arm the race: the first exclusive-create attempt finds the destination
    // freshly claimed by "another writer" and must NOT clobber it.
    const claimed = `${JSON.stringify(sequencedRecord(91))}\n`;
    fsFaults.linkSyncClaim.remaining = 1;
    fsFaults.linkSyncClaim.claimContent = claimed;

    store.appendTurnRecord(sequencedRecord(1)); // rotation collides, then retries

    expect(readFileSync(join(dir, `${sanitized}.00001.jsonl`), 'utf-8')).toBe(claimed);
    expect(readFileSync(join(dir, `${sanitized}.00002.jsonl`), 'utf-8')).toContain('"message-0"');
    expect(store.readRecentTurnRecords(ROTATION_CHANNEL, 10)).toEqual([
      sequencedRecord(91),
      sequencedRecord(0),
      sequencedRecord(1),
    ]);
  });

  it('completes an interrupted rotation (active hard-linked to a segment) without duplicating records', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-turn-records-interrupted-'));
    const dir = join(sessionsDir, TURN_RECORDS_DIR);
    const sanitized = sanitizeChannelId(ROTATION_CHANNEL);
    const store = createFilesystemTurnRecordStorePort(sessionsDir, { segmentMaxBytes: 8 });
    store.appendTurnRecord(sequencedRecord(0));

    // Simulate a crash between linkSync and unlinkSync: the active name and a
    // segment name now point at the same inode.
    const activePath = activeSegmentPathFor(sessionsDir, ROTATION_CHANNEL);
    linkSync(activePath, join(dir, `${sanitized}.00001.jsonl`));

    // Reads must not double-count the shared inode ((dev, ino) dedupe).
    expect(store.readRecentTurnRecords(ROTATION_CHANNEL, 10)).toEqual([sequencedRecord(0)]);

    // The next over-cap append completes the rotation (drops the active name)
    // instead of linking the same content under a second segment number.
    store.appendTurnRecord(sequencedRecord(1));
    expect(existsSync(join(dir, `${sanitized}.00002.jsonl`))).toBe(false);
    expect(store.readRecentTurnRecords(ROTATION_CHANNEL, 10)).toEqual([
      sequencedRecord(0),
      sequencedRecord(1),
    ]);
  });

  it('restarts a tail read when a listed file vanishes under a concurrent rotation (ENOENT)', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-turn-records-enoent-retry-'));
    const store = createFilesystemTurnRecordStorePort(sessionsDir, { segmentMaxBytes: 8 });
    const records = [0, 1, 2].map((i) => sequencedRecord(i));
    for (const record of records) store.appendTurnRecord(record);

    // First open of the active file fails as if a rotation just renamed it;
    // the retry re-lists segments and serves a coherent window.
    fsFaults.openSyncEnoent.path = activeSegmentPathFor(sessionsDir, ROTATION_CHANNEL);
    fsFaults.openSyncEnoent.remaining = 1;

    expect(store.readRecentTurnRecords(ROTATION_CHANNEL, 10)).toEqual(records);
  });

  it('fails loudly when a tail read keeps losing races with rotation past the retry bound', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-turn-records-enoent-loud-'));
    const store = createFilesystemTurnRecordStorePort(sessionsDir);
    store.appendTurnRecord(sequencedRecord(0));

    fsFaults.openSyncEnoent.path = activeSegmentPathFor(sessionsDir, ROTATION_CHANNEL);
    fsFaults.openSyncEnoent.remaining = 100;

    expect(() => store.readRecentTurnRecords(ROTATION_CHANNEL, 10))
      .toThrow(/kept losing races with segment rotation/);
  });
});

function buildToolDefinitions(marker: string): ToolSchema[] {
  return [
    {
      name: `fixture_tool_${marker}`,
      description: `Fixture tool ${marker} description.`,
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Generic fixture query.' } },
        required: ['query'],
      },
    },
  ];
}

function buildSnapshotWithPlan(record: TurnRecord, toolDefinitions: ToolSchema[]): TurnSnapshotRecord {
  return {
    turnId: record.turnId,
    requestId: record.requestId,
    channelId: record.channelId,
    capturedAt: record.startedAt,
    trustLevel: 'regular',
    plan: {
      schemaVersion: 1,
      blocks: [],
      variables: {},
      messages: [],
      toolDefinitions,
      scope: { scopeKey: 'dm:fixture', kind: 'dm' },
    } as unknown as TurnSnapshotRecord['plan'],
  };
}

function createSnapshotTurnRecord(
  toolDefinitions: ToolSchema[],
  overrides: Partial<TurnRecord> = {},
): TurnRecord {
  const record = createTurnRecord(overrides);
  return {
    ...record,
    observability: {
      stages: [],
      retrievals: [],
      snapshot: buildSnapshotWithPlan(record, toolDefinitions),
    },
  };
}

function tooldefsDir(sessionsDir: string): string {
  return join(sessionsDir, '_turn_records', '_shared', 'tooldefs');
}


describe('turn-records content-addressed tool definitions (bead hgw3.3)', () => {
  it('persists toolDefinitionsRef with the defs in the sidecar and resolves transparently on read', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-turn-records-tooldefs-'));
    const record = createSnapshotTurnRecord(buildToolDefinitions('alpha'));
    const store = createFilesystemTurnRecordStorePort(sessionsDir);

    store.appendTurnRecord(record);

    const rawLine = readFileSync(join(sessionsDir, '_turn_records', 'psfn-amica%3Atest%3Api5.jsonl'), 'utf-8');
    expect(rawLine).toContain('"toolDefinitionsRef"');
    expect(rawLine).not.toContain('fixture_tool_alpha');
    const sidecarFiles = readdirSync(tooldefsDir(sessionsDir));
    expect(sidecarFiles).toHaveLength(1);

    expect(store.readRecentTurnRecords(record.channelId, 5)).toEqual([record]);
  });

  it('stores identical tool-definition sets once and distinct sets separately', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-turn-records-tooldefs-dedupe-'));
    const store = createFilesystemTurnRecordStorePort(sessionsDir);
    const sharedDefs = buildToolDefinitions('shared');

    store.appendTurnRecord(createSnapshotTurnRecord(sharedDefs, { requestId: 'req-1' }));
    store.appendTurnRecord(createSnapshotTurnRecord(sharedDefs, {
      requestId: 'req-2',
      turnId: '019d2326-d9e1-701d-bcee-250d2cbb0e4f',
    }));
    expect(readdirSync(tooldefsDir(sessionsDir))).toHaveLength(1);

    store.appendTurnRecord(createSnapshotTurnRecord(buildToolDefinitions('other'), {
      requestId: 'req-3',
      turnId: '019d2326-d9e1-701d-bcee-250d2cbb0e50',
    }));
    expect(readdirSync(tooldefsDir(sessionsDir))).toHaveLength(2);
  });

  it('is write-once: an existing hash file is never rewritten, and hash mismatches fail loudly', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-turn-records-tooldefs-once-'));
    const sharedStore = createTurnRecordSharedStore(join(sessionsDir, '_turn_records'));
    const defs = buildToolDefinitions('immutable');

    const hash = sharedStore.internToolDefinitions(defs);
    const path = join(tooldefsDir(sessionsDir), `${hash}.json`);
    const sentinel = JSON.stringify(buildToolDefinitions('tampered'));
    writeFileSync(path, sentinel, 'utf-8');

    // Interning the same set again skips the write (the file already exists).
    expect(sharedStore.internToolDefinitions(defs)).toBe(hash);
    expect(readFileSync(path, 'utf-8')).toBe(sentinel);

    // A fresh store hits the disk and fails closed on the content mismatch.
    const freshStore = createTurnRecordSharedStore(join(sessionsDir, '_turn_records'));
    expect(() => freshStore.resolveToolDefinitions(hash)).toThrow(/corrupt/);
  });

  it('fails closed when interning against an existing sidecar whose content no longer matches its hash', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-turn-records-tooldefs-tampered-intern-'));
    const sharedStore = createTurnRecordSharedStore(join(sessionsDir, '_turn_records'));
    const defs = buildToolDefinitions('verified');

    const hash = sharedStore.internToolDefinitions(defs);
    writeFileSync(
      join(tooldefsDir(sessionsDir), `${hash}.json`),
      JSON.stringify(buildToolDefinitions('rewritten')),
      'utf-8',
    );

    // A fresh process (cache miss) must verify the existing file and refuse to
    // keep referencing content-addressed data that was rewritten underneath it.
    const freshStore = createTurnRecordSharedStore(join(sessionsDir, '_turn_records'));
    expect(() => freshStore.internToolDefinitions(defs))
      .toThrow(/corrupt.*does not match ref/);

    // Appends through a fresh port fail closed the same way instead of
    // emitting records whose ref every fresh reader would then choke on.
    const freshPort = createFilesystemTurnRecordStorePort(sessionsDir);
    expect(() => freshPort.appendTurnRecord(createSnapshotTurnRecord(defs)))
      .toThrow(/corrupt.*does not match ref/);
  });

  it('fails loudly on a dangling toolDefinitionsRef', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-turn-records-tooldefs-dangling-'));
    const record = createSnapshotTurnRecord(buildToolDefinitions('gone'));
    createFilesystemTurnRecordStorePort(sessionsDir).appendTurnRecord(record);

    const [sidecarFile] = readdirSync(tooldefsDir(sessionsDir));
    rmSync(join(tooldefsDir(sessionsDir), sidecarFile!));

    // Fresh port: no in-memory memoization of the interned set.
    const freshStore = createFilesystemTurnRecordStorePort(sessionsDir);
    expect(() => freshStore.readRecentTurnRecords(record.channelId, 5))
      .toThrow(/toolDefinitionsRef .* is dangling/);
  });

  it('rejects a record carrying both inline toolDefinitions and a ref', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-turn-records-tooldefs-ambiguous-'));
    const record = createSnapshotTurnRecord(buildToolDefinitions('both'));
    const store = createFilesystemTurnRecordStorePort(sessionsDir);
    store.appendTurnRecord(record);

    const path = join(sessionsDir, '_turn_records', 'psfn-amica%3Atest%3Api5.jsonl');
    const persisted = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    const snapshot = (persisted.observability as Record<string, unknown>).snapshot as Record<string, unknown>;
    const plan = snapshot.plan as Record<string, unknown>;
    plan.toolDefinitions = buildToolDefinitions('both');
    writeFileSync(path, `${JSON.stringify(persisted)}\n`, 'utf-8');

    expect(() => createFilesystemTurnRecordStorePort(sessionsDir).readRecentTurnRecords(record.channelId, 5))
      .toThrow(/both inline toolDefinitions/);
  });

  it('reads old fat records (inline defs, wire messages, activeTools) exactly as written', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-turn-records-fat-compat-'));
    const defs = buildToolDefinitions('fat');
    const record = createSnapshotTurnRecord(defs);
    const snapshot = record.observability!.snapshot! as TurnSnapshotRecord & Record<string, unknown>;
    snapshot.promptContext = {
      currentTurnInput: 'fixture input',
      providerObservability: {
        routeKind: 'registered_model',
        requestedProvider: 'fixture-provider',
        requestedModel: 'fixture-model',
        backendProvider: 'fixture-provider',
        backendModel: 'fixture-model',
        backendApi: 'anthropic-messages',
        systemRole: {
          transport: 'anthropic_system',
          supportsSystemRole: true,
          supportsDeveloperRole: false,
          usesOutOfBandSystemPrompt: false,
        },
        promptCaching: { configured: false, engaged: false },
        providerWireMessages: [
          { role: 'system', source: 'system_prompt', content: 'fixture system prompt' },
          { role: 'user', source: 'message', content: 'fixture input' },
        ],
      },
    };
    snapshot.toolContext = { activeTools: buildToolDefinitions('fat') };

    // Historical fat line: written directly, bypassing the slimming append.
    const path = join(sessionsDir, '_turn_records', 'psfn-amica%3Atest%3Api5.jsonl');
    mkdirSync(join(sessionsDir, '_turn_records'), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf-8');

    const [readBack] = createFilesystemTurnRecordStorePort(sessionsDir).readRecentTurnRecords(record.channelId, 5);
    expect(readBack).toEqual(record);
    const readSnapshot = readBack!.observability!.snapshot!;
    expect(readSnapshot.promptContext?.providerObservability?.providerWireMessages).toHaveLength(2);
    expect(readSnapshot.toolContext?.activeTools?.[0]?.name).toBe('fixture_tool_fat');
    expect(readSnapshot.plan?.toolDefinitions[0]?.name).toBe('fixture_tool_fat');
  });
});

function wirebodiesDir(sessionsDir: string): string {
  return join(sessionsDir, '_turn_records', '_shared', 'wirebodies');
}

function createWireCaptureTurnRecord(
  body: unknown,
  overrides: Partial<TurnRecord> = {},
): TurnRecord {
  const record = createSnapshotTurnRecord(buildToolDefinitions('wire'), overrides);
  const snapshot = record.observability!.snapshot! as TurnSnapshotRecord & Record<string, unknown>;
  snapshot.promptContext = {
    currentTurnInput: 'wire fixture input',
    providerObservability: {
      routeKind: 'registered_model',
      requestedProvider: 'fixture-provider',
      requestedModel: 'fixture-model',
      backendProvider: 'fixture-provider',
      backendModel: 'fixture-model',
      backendApi: 'anthropic-messages',
      systemRole: {
        transport: 'anthropic_system',
        supportsSystemRole: true,
        supportsDeveloperRole: false,
        usesOutOfBandSystemPrompt: false,
      },
      promptCaching: { configured: false, engaged: false },
      capturedWirePayload: {
        api: 'anthropic-messages',
        model: 'fixture-model',
        capturedAtMs: 1_700_000_000_000,
        byteLength: Buffer.byteLength(JSON.stringify(body), 'utf8'),
        toolCount: 2,
        body,
      },
    },
  };
  return record;
}

/**
 * Byte-identity is the turn-record STORE PORT contract: with no L0 access and no
 * redaction, the port round-trips the captured body verbatim from the sidecar.
 * CogSec redaction gating of the wire body (bead psfn-framework-eb14) lives one
 * layer up, at the SessionManager store read boundary (resolveTurnRecordSessionEntries
 * → gateRenderedViews), which owns L0 tombstone authority; a body is withheld
 * there only when a source L0 entry it embedded is redacted/removed. These
 * port-level tests therefore stay byte-identical — the gated contract reduces to
 * "verbatim" whenever nothing is redacted. See store-turn-record-session-refs.test.ts
 * for the redaction-gating coverage.
 */
describe('turn-records content-addressed captured wire payload (bead hgw3-80f6)', () => {
  const wireBody = {
    model: 'fixture-model',
    max_tokens: 1024,
    system: 'a big static system prompt',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'search', input_schema: {} }, { name: 'recall', input_schema: {} }],
  };

  it('persists bodyRef with the body in the sidecar, keeps the summary inline, and resolves on read', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-turn-records-wire-'));
    const record = createWireCaptureTurnRecord(wireBody);
    const store = createFilesystemTurnRecordStorePort(sessionsDir);

    store.appendTurnRecord(record);

    const rawLine = readFileSync(join(sessionsDir, '_turn_records', 'psfn-amica%3Atest%3Api5.jsonl'), 'utf-8');
    expect(rawLine).toContain('"bodyRef"');
    // The big body left the hot JSONL; the summary attestation stays inline.
    expect(rawLine).not.toContain('a big static system prompt');
    expect(rawLine).toContain('"byteLength"');
    expect(rawLine).toContain('"toolCount":2');
    expect(readdirSync(wirebodiesDir(sessionsDir))).toHaveLength(1);

    // Read restores the inline body transparently — byte-identical round-trip.
    expect(store.readRecentTurnRecords(record.channelId, 5)).toEqual([record]);
    const [readBack] = store.readRecentTurnRecords(record.channelId, 5);
    const captured = readBack!.observability!.snapshot!.promptContext?.providerObservability?.capturedWirePayload;
    expect(JSON.stringify(captured?.body)).toBe(JSON.stringify(wireBody));
  });

  it('resolves the bodyRef transparently via findTurnRecord too', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-turn-records-wire-find-'));
    const record = createWireCaptureTurnRecord(wireBody);
    const store = createFilesystemTurnRecordStorePort(sessionsDir);
    store.appendTurnRecord(record);
    expect(store.findTurnRecord(record.channelId, record.turnId)).toEqual(record);
  });

  it('fails loudly on a dangling bodyRef', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-turn-records-wire-dangling-'));
    const record = createWireCaptureTurnRecord(wireBody);
    createFilesystemTurnRecordStorePort(sessionsDir).appendTurnRecord(record);

    const [sidecarFile] = readdirSync(wirebodiesDir(sessionsDir));
    rmSync(join(wirebodiesDir(sessionsDir), sidecarFile!));

    const freshStore = createFilesystemTurnRecordStorePort(sessionsDir);
    expect(() => freshStore.readRecentTurnRecords(record.channelId, 5))
      .toThrow(/bodyRef .* is dangling/);
  });

  it('rejects a record carrying both an inline body and a bodyRef', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-turn-records-wire-ambiguous-'));
    const record = createWireCaptureTurnRecord(wireBody);
    const store = createFilesystemTurnRecordStorePort(sessionsDir);
    store.appendTurnRecord(record);

    const path = join(sessionsDir, '_turn_records', 'psfn-amica%3Atest%3Api5.jsonl');
    const persisted = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    const snapshot = (persisted.observability as Record<string, unknown>).snapshot as Record<string, unknown>;
    const promptContext = snapshot.promptContext as Record<string, unknown>;
    const providerObservability = promptContext.providerObservability as Record<string, unknown>;
    (providerObservability.capturedWirePayload as Record<string, unknown>).body = wireBody;
    writeFileSync(path, `${JSON.stringify(persisted)}\n`, 'utf-8');

    expect(() => createFilesystemTurnRecordStorePort(sessionsDir).readRecentTurnRecords(record.channelId, 5))
      .toThrow(/both an inline body and bodyRef/);
  });
});

function staticpromptsDir(sessionsDir: string): string {
  return join(sessionsDir, '_turn_records', '_shared', 'staticprompts');
}

function buildStaticPrefixTemplate(marker: string): string {
  // A realistically-sized, session-stable static prefix: the amplified,
  // byte-identical-across-turns material bead auiu content-addresses.
  return [
    `<character marker="${marker}">`,
    'You are a long-lived companion. Your identity lives in data, not weights.',
    ...Array.from({ length: 40 }, (_, index) => `Static operator directive line ${index}: {{companion_name}} holds continuity.`),
    '</character>',
  ].join('\n');
}

function createStaticPromptTurnRecord(
  template: string,
  overrides: Partial<TurnRecord> = {},
): TurnRecord {
  const record = createSnapshotTurnRecord(buildToolDefinitions('static'), overrides);
  const snapshot = record.observability!.snapshot! as TurnSnapshotRecord & Record<string, unknown>;
  snapshot.prompt = {
    staticPrefixTemplate: template,
    dynamicSuffixTemplate: 'Per-turn dynamic suffix for {{channel_id}}.',
    staticHash: 'fixture-static-hash',
    versionPointer: 'fixture-version-pointer',
  } as unknown as TurnSnapshotRecord['prompt'];
  return record;
}

describe('turn-records content-addressed static prompt prefix (bead auiu)', () => {
  it('persists staticPrefixTemplateRef, drops the inline template, and resolves byte-identically on read', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-turn-records-static-'));
    const template = buildStaticPrefixTemplate('alpha');
    const record = createStaticPromptTurnRecord(template);
    const store = createFilesystemTurnRecordStorePort(sessionsDir);

    store.appendTurnRecord(record);

    const rawLine = readFileSync(join(sessionsDir, '_turn_records', 'psfn-amica%3Atest%3Api5.jsonl'), 'utf-8');
    expect(rawLine).toContain('"staticPrefixTemplateRef"');
    // The big session-stable template left the hot JSONL.
    expect(rawLine).not.toContain('Static operator directive line 0');
    expect(rawLine).not.toContain(template);
    // The per-turn dynamic suffix stays inline (non-goal).
    expect(rawLine).toContain('Per-turn dynamic suffix');
    expect(readdirSync(staticpromptsDir(sessionsDir))).toHaveLength(1);

    // Read restores the inline template transparently — byte-identical round-trip.
    expect(store.readRecentTurnRecords(record.channelId, 5)).toEqual([record]);
    const [readBack] = store.readRecentTurnRecords(record.channelId, 5);
    expect(readBack!.observability!.snapshot!.prompt?.staticPrefixTemplate).toBe(template);
  });

  it('stores an identical static prefix once and distinct prefixes separately', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-turn-records-static-dedupe-'));
    const store = createFilesystemTurnRecordStorePort(sessionsDir);
    const shared = buildStaticPrefixTemplate('shared');

    store.appendTurnRecord(createStaticPromptTurnRecord(shared, { requestId: 'req-1' }));
    store.appendTurnRecord(createStaticPromptTurnRecord(shared, {
      requestId: 'req-2',
      turnId: '019d2326-d9e1-701d-bcee-250d2cbb0e4f',
    }));
    expect(readdirSync(staticpromptsDir(sessionsDir))).toHaveLength(1);

    store.appendTurnRecord(createStaticPromptTurnRecord(buildStaticPrefixTemplate('other'), {
      requestId: 'req-3',
      turnId: '019d2326-d9e1-701d-bcee-250d2cbb0e50',
    }));
    expect(readdirSync(staticpromptsDir(sessionsDir))).toHaveLength(2);
  });

  it('resolves the staticPrefixTemplateRef transparently via findTurnRecord too', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-turn-records-static-find-'));
    const record = createStaticPromptTurnRecord(buildStaticPrefixTemplate('find'));
    const store = createFilesystemTurnRecordStorePort(sessionsDir);
    store.appendTurnRecord(record);
    expect(store.findTurnRecord(record.channelId, record.turnId)).toEqual(record);
  });

  it('fails loudly on a dangling staticPrefixTemplateRef', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-turn-records-static-dangling-'));
    const record = createStaticPromptTurnRecord(buildStaticPrefixTemplate('gone'));
    createFilesystemTurnRecordStorePort(sessionsDir).appendTurnRecord(record);

    const [sidecarFile] = readdirSync(staticpromptsDir(sessionsDir));
    rmSync(join(staticpromptsDir(sessionsDir), sidecarFile!));

    const freshStore = createFilesystemTurnRecordStorePort(sessionsDir);
    expect(() => freshStore.readRecentTurnRecords(record.channelId, 5))
      .toThrow(/staticPrefixTemplateRef .* is dangling/);
  });

  it('rejects a record carrying both an inline template and a staticPrefixTemplateRef', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-turn-records-static-ambiguous-'));
    const record = createStaticPromptTurnRecord(buildStaticPrefixTemplate('both'));
    const store = createFilesystemTurnRecordStorePort(sessionsDir);
    store.appendTurnRecord(record);

    const path = join(sessionsDir, '_turn_records', 'psfn-amica%3Atest%3Api5.jsonl');
    const persisted = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    const snapshot = (persisted.observability as Record<string, unknown>).snapshot as Record<string, unknown>;
    (snapshot.prompt as Record<string, unknown>).staticPrefixTemplate = buildStaticPrefixTemplate('both');
    writeFileSync(path, `${JSON.stringify(persisted)}\n`, 'utf-8');

    expect(() => createFilesystemTurnRecordStorePort(sessionsDir).readRecentTurnRecords(record.channelId, 5))
      .toThrow(/both an inline staticPrefixTemplate/);
  });

  it('fails closed when interning against a static-prefix sidecar that was rewritten', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-turn-records-static-tampered-'));
    const sharedStore = createTurnRecordSharedStore(join(sessionsDir, '_turn_records'));
    const template = buildStaticPrefixTemplate('verified');

    const hash = sharedStore.internStaticPrompt(template);
    writeFileSync(
      join(staticpromptsDir(sessionsDir), `${hash}.json`),
      JSON.stringify(buildStaticPrefixTemplate('rewritten')),
      'utf-8',
    );

    const freshStore = createTurnRecordSharedStore(join(sessionsDir, '_turn_records'));
    expect(() => freshStore.internStaticPrompt(template))
      .toThrow(/corrupt.*does not match ref/);
    expect(() => freshStore.resolveStaticPrompt(hash)).toThrow(/corrupt/);
  });

  it('reads old fat records with an inline staticPrefixTemplate exactly as written', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-turn-records-static-fat-compat-'));
    const template = buildStaticPrefixTemplate('fat');
    const record = createStaticPromptTurnRecord(template);

    // Historical fat line: written directly, bypassing the slimming append.
    const path = join(sessionsDir, '_turn_records', 'psfn-amica%3Atest%3Api5.jsonl');
    mkdirSync(join(sessionsDir, '_turn_records'), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf-8');

    const [readBack] = createFilesystemTurnRecordStorePort(sessionsDir).readRecentTurnRecords(record.channelId, 5);
    expect(readBack).toEqual(record);
    expect(readBack!.observability!.snapshot!.prompt?.staticPrefixTemplate).toBe(template);
    // No sidecar was created for a directly-written fat record.
    expect(existsSync(staticpromptsDir(sessionsDir))).toBe(false);
  });
});
