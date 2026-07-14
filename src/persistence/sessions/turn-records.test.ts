import { appendFileSync, existsSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TurnRecord } from '../../shared/contracts/runtime.js';
import type { TurnRecordStorePort } from './turn-record-store-port.js';
import { sanitizeChannelId } from './store-file-contracts.js';
import {
  appendTurnRecordWithRotation,
  createFilesystemTurnRecordStorePort,
  readRecentTurnRecordsAcrossSegments,
  type TurnRecordTailStats,
} from './turn-records.js';

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

  it('omits location for turns that carried no place binding (legacy rows load fine)', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-turn-records-nolocation-'));
    const record = createTurnRecord();
    const turnRecordStore = createFilesystemTurnRecordStorePort(sessionsDir);

    turnRecordStore.appendTurnRecord(record);

    const read = turnRecordStore.readRecentTurnRecords(record.channelId, 5);
    expect(read).toEqual([record]);
    expect(read[0]).not.toHaveProperty('location');
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
