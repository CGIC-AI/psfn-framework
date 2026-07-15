import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { JournalEntry, SessionEntryRole } from '../../core/session/types.js';
import { createTurnId } from '../../core/turns/id.js';
import type { TurnID, TurnRecord } from '../../shared/contracts/runtime.js';
import {
  buildCompactionJournalEntry,
  buildMessageJournalEntry,
  buildSessionHmacKeyring,
  buildTurnTombstoneJournalEntry,
  signJournalEntry,
} from '../journals/journal-utils.js';
import {
  createFilesystemSessionArchivePort,
  createFilesystemSessionJournalPort,
} from '../journals/journal/port.js';
import type { JournalBoundedReadStats } from '../journals/journal/types.js';
import type { SessionHmacKeyring } from '../journals/journal/types.js';
import { SessionStore } from './store.js';
import { makeRolledFilePath } from './store/channel-filenames.js';

interface BoundedReadFixture {
  dir: string;
  channelId: string;
  filePaths: [string, string, string];
  keyring: SessionHmacKeyring;
  messageTurnIds: TurnID[];
  records: TurnRecord[];
  store: SessionStore;
  fullReadPaths: () => string[];
}

const dirs: string[] = [];

function turnMetadata(turnId: TurnID, role: SessionEntryRole): string {
  return JSON.stringify({
    turn: {
      schemaVersion: 1,
      turnId,
      requestId: `req-${turnId}`,
      role,
    },
  });
}

function buildTurnRecord(channelId: string, turnId: TurnID, index: number): TurnRecord {
  return {
    schemaVersion: 1,
    turnId,
    requestId: `req-${index}`,
    channelId,
    channelType: 'api',
    startedAt: index * 100,
    completedAt: index * 100 + 50,
    status: 'completed',
    userMessage: { role: 'user', content: `prompt-${index}`, timestamp: index * 100 },
    assistantMessage: { role: 'assistant', content: `reply-${index}`, timestamp: index * 100 + 50 },
    toolCalls: [],
    extractedMemoryIds: [],
    concernDeltaRefs: [],
    contactDeltaRefs: [],
    versionPointers: { model: 'test/model' },
    provenanceRefs: [],
  };
}

function createBoundedReadFixture(): BoundedReadFixture {
  const dir = mkdtempSync(join(tmpdir(), 'psfn-session-bounded-chain-'));
  dirs.push(dir);
  const channelId = 'api:bounded-chain';
  const rootPath = join(dir, '20260715_api-bounded-chain_user_000001.jsonl');
  const secondPath = makeRolledFilePath(rootPath, 2);
  const thirdPath = makeRolledFilePath(rootPath, 3);
  const messageTurnIds = Array.from({ length: 8 }, () => createTurnId());
  const keyring = buildSessionHmacKeyring({
    serializedKeys: 'v1:bounded-chain-test-key',
    activeVersion: 'v1',
  });
  if (!keyring) throw new Error('Expected a test keyring');

  let previousHmac: string | null = null;
  const signed = (entry: JournalEntry): JournalEntry => {
    const result = signJournalEntry(entry, keyring, previousHmac);
    previousHmac = result._hmac ?? previousHmac;
    return result;
  };
  const message = (id: number, turnIndex: number): JournalEntry => signed(buildMessageJournalEntry(id, {
    channelId,
    role: id % 2 === 0 ? 'assistant' : 'user',
    content: `message-${id}`,
    timestamp: id * 1_000,
    metadata: turnMetadata(messageTurnIds[turnIndex]!, id % 2 === 0 ? 'assistant' : 'user'),
  }));
  const firstEntries = [message(1, 0), message(2, 1), message(3, 2)];
  const secondEntries = [
    message(4, 3),
    signed(buildCompactionJournalEntry(5, channelId, 'bounded summary', 4, 5_000)),
    message(6, 4),
  ];
  const thirdEntries = [
    message(7, 5),
    message(8, 6),
    message(9, 7),
    signed(buildTurnTombstoneJournalEntry(10, channelId, {
      turnId: messageTurnIds[6]!,
      action: 'redact',
      timestamp: 10_000,
      actor: 'admin:test',
      reason: 'privacy request',
    })),
    signed(buildTurnTombstoneJournalEntry(11, channelId, {
      turnId: messageTurnIds[1]!,
      action: 'redact',
      timestamp: 11_000,
      actor: 'admin:test',
      reason: 'cross-segment privacy request',
    })),
  ];
  const writeEntries = (filePath: string, entries: readonly JournalEntry[]) => {
    writeFileSync(filePath, `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
  };
  writeEntries(rootPath, firstEntries);
  writeEntries(secondPath, secondEntries);
  writeEntries(thirdPath, thirdEntries);

  const records = messageTurnIds.map((turnId, index) => buildTurnRecord(channelId, turnId, index + 1));
  const archivePort = createFilesystemSessionArchivePort();
  const readJournalFile = vi.spyOn(archivePort, 'readJournalFile');
  const store = new SessionStore(dir, {
    integrityKeyring: keyring,
    sessionArchivePort: archivePort,
    turnRecordStore: {
      appendTurnRecord: vi.fn(),
      readRecentTurnRecords: (_sessionId, limit) => records.slice(-limit),
    },
  });
  readJournalFile.mockClear();

  return {
    dir,
    channelId,
    filePaths: [rootPath, secondPath, thirdPath],
    keyring,
    messageTurnIds,
    records,
    store,
    fullReadPaths: () => readJournalFile.mock.calls.map(([archive]) => archivePort.resolveArchivePath(archive)),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

describe('SessionStore bounded logical-archive reads', () => {
  it('canonically returns wrapped unsigned legacy rows instead of treating the archive as empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-session-bounded-unsigned-'));
    dirs.push(dir);
    const channelId = 'api:bounded-unsigned';
    const filePath = join(dir, '20260715_api-bounded-unsigned_user_000001.jsonl');
    const keyring = buildSessionHmacKeyring({
      serializedKeys: 'v1:bounded-unsigned-test-key',
      activeVersion: 'v1',
    });
    if (!keyring) throw new Error('Expected a test keyring');
    const entries = [1, 2, 3].map(id => buildMessageJournalEntry(id, {
      channelId,
      role: id % 2 === 0 ? 'assistant' : 'user',
      content: `unsigned-${id}`,
      timestamp: id * 1_000,
    }));
    writeFileSync(filePath, `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
    const store = new SessionStore(dir, { integrityKeyring: keyring });

    const range = store.getEntriesInRange(channelId, 1, 3);
    expect(range.map(entry => entry.id)).toEqual([1, 2, 3]);
    expect(range.every(entry => entry.content.includes('<unverified_history>'))).toBe(true);
  });

  it('canonically reads a later segment whose first signed row was tampered', () => {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-session-bounded-tampered-leading-'));
    dirs.push(dir);
    const channelId = 'api:bounded-tampered-leading';
    const rootPath = join(dir, '20260715_api-bounded-tampered-leading_user_000001.jsonl');
    const secondPath = makeRolledFilePath(rootPath, 2);
    const keyring = buildSessionHmacKeyring({
      serializedKeys: 'v1:bounded-tampered-leading-test-key',
      activeVersion: 'v1',
    });
    if (!keyring) throw new Error('Expected a test keyring');
    let previousHmac: string | null = null;
    const signed = (id: number): JournalEntry => {
      const entry = signJournalEntry(buildMessageJournalEntry(id, {
        channelId,
        role: id % 2 === 0 ? 'assistant' : 'user',
        content: `signed-${id}`,
        timestamp: id * 1_000,
      }), keyring, previousHmac);
      previousHmac = entry._hmac ?? previousHmac;
      return entry;
    };
    const firstEntries = [signed(1), signed(2)];
    const secondEntries = [signed(3), signed(4)];
    secondEntries[0] = { ...secondEntries[0]!, content: 'tampered-leading-secret' };
    writeFileSync(rootPath, `${firstEntries.map(entry => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
    writeFileSync(secondPath, `${secondEntries.map(entry => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
    const store = new SessionStore(dir, { integrityKeyring: keyring });

    const range = store.getEntriesInRange(channelId, 3, 4);
    expect(range.map(entry => entry.id)).toEqual([3, 4]);
    expect(range[0]?.content).toContain('<unverified_history>');
    expect(range[1]?.content).toBe('signed-4');
  });

  it('canonically quarantines a malformed leading row without hiding later valid rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-session-bounded-malformed-leading-'));
    dirs.push(dir);
    const channelId = 'api:bounded-malformed-leading';
    const filePath = join(dir, '20260715_api-bounded-malformed-leading_user_000001.jsonl');
    const keyring = buildSessionHmacKeyring({
      serializedKeys: 'v1:bounded-malformed-leading-test-key',
      activeVersion: 'v1',
    });
    if (!keyring) throw new Error('Expected a test keyring');
    let previousHmac: string | null = null;
    const entries = [1, 2].map((id) => {
      const entry = signJournalEntry(buildMessageJournalEntry(id, {
        channelId,
        role: id % 2 === 0 ? 'assistant' : 'user',
        content: `valid-${id}`,
        timestamp: id * 1_000,
      }), keyring, previousHmac);
      previousHmac = entry._hmac ?? previousHmac;
      return entry;
    });
    writeFileSync(filePath, `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
    // Materialize a valid index first, then corrupt only the physical leading
    // row while keeping the index fingerprint current. This forces the range
    // probe itself to reject the boundary and enter canonical quarantine.
    new SessionStore(dir, { integrityKeyring: keyring });
    writeFileSync(
      filePath,
      `{malformed-leading-row\n${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`,
      'utf8',
    );
    const fileStats = statSync(filePath);
    const indexPath = join(dir, '_channel_index.json');
    const index = JSON.parse(readFileSync(indexPath, 'utf8')) as {
      channels: Record<string, { archiveFingerprint?: string }>;
    };
    const indexed = index.channels[channelId];
    if (!indexed) throw new Error('Expected channel index entry');
    indexed.archiveFingerprint = `${filePath}=${[
      fileStats.dev,
      fileStats.ino,
      fileStats.size,
      fileStats.mtimeMs,
      fileStats.ctimeMs,
    ].join(':')}`;
    writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
    rmSync(`${filePath}.quarantine`, { force: true });
    const store = new SessionStore(dir, { integrityKeyring: keyring });

    expect(store.getEntriesInRange(channelId, 1, 2).map(entry => entry.content))
      .toEqual(['valid-1', 'valid-2']);
    expect(existsSync(`${filePath}.quarantine`)).toBe(true);
    expect(readFileSync(`${filePath}.quarantine`, 'utf8')).toContain('{malformed-leading-row');
  });

  it('reads an id range from only the segment that can contain it', () => {
    const fixture = createBoundedReadFixture();

    expect(fixture.store.getEntriesInRange(fixture.channelId, 4, 6).map(entry => entry.id))
      .toEqual([4, 6]);
    expect(fixture.fullReadPaths()).toEqual([]);
  });

  it('reads all compaction summaries without replaying message-only segments', () => {
    const fixture = createBoundedReadFixture();

    expect(fixture.store.getCompactionSummaries(fixture.channelId)).toEqual([{
      id: 5,
      channelId: fixture.channelId,
      summary: 'bounded summary',
      coveredUpTo: 4,
      createdAt: 5_000,
    }]);
    expect(fixture.fullReadPaths()).toEqual([fixture.filePaths[1]]);
  });

  it('fills a tombstoned recent window from older segments without a full replay', () => {
    const fixture = createBoundedReadFixture();

    expect(fixture.store.count(fixture.channelId)).toBe(6);
    expect(fixture.store.getRecent(fixture.channelId, 3).map(entry => entry.id))
      .toEqual([6, 7, 9]);
    expect(fixture.fullReadPaths()).toEqual([]);
  });

  it('filters recent turn records from indexed tombstone authority without replaying L0', () => {
    const fixture = createBoundedReadFixture();

    expect(fixture.store.getRecentTurnRecords(fixture.channelId, 3).map(record => record.turnId))
      .toEqual([
        fixture.messageTurnIds[4],
        fixture.messageTurnIds[5],
        fixture.messageTurnIds[7],
      ]);
    expect(fixture.fullReadPaths()).toEqual([]);
  });

  it('keeps journal redactions authoritative when index-only corruption removes every tombstone', () => {
    const fixture = createBoundedReadFixture();
    const indexPath = join(fixture.dir, '_channel_index.json');
    const index = JSON.parse(readFileSync(indexPath, 'utf8')) as {
      channels: Record<string, {
        activeTurnTombstoneCount?: number;
        activeTurnTombstoneIds?: string[];
      }>;
    };
    const entry = index.channels[fixture.channelId];
    if (!entry) throw new Error('Expected channel index entry');
    entry.activeTurnTombstoneCount = 0;
    entry.activeTurnTombstoneIds = [];
    writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8');

    const reloaded = new SessionStore(fixture.dir, {
      integrityKeyring: fixture.keyring,
      turnRecordStore: {
        appendTurnRecord: vi.fn(),
        readRecentTurnRecords: (_sessionId, limit) => fixture.records.slice(-limit),
      },
    });

    expect(reloaded.getRecent(fixture.channelId, 8).map(message => message.id))
      .toEqual([1, 3, 4, 6, 7, 9]);
    expect(reloaded.getEntriesInRange(fixture.channelId, 1, 9).map(message => message.id))
      .toEqual([1, 3, 4, 6, 7, 9]);
    expect(reloaded.getRecentTurnRecords(fixture.channelId, 8).map(record => record.turnId))
      .toEqual([
        fixture.messageTurnIds[0],
        fixture.messageTurnIds[2],
        fixture.messageTurnIds[3],
        fixture.messageTurnIds[4],
        fixture.messageTurnIds[5],
        fixture.messageTurnIds[7],
      ]);
  });

  it('reads a deep range from a legacy single-file archive with byte I/O proportional to the window', () => {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-session-bounded-single-'));
    dirs.push(dir);
    const channelId = 'api:bounded-single';
    const filePath = join(dir, '20260715_api-bounded-single_user_000001.jsonl');
    const keyring = buildSessionHmacKeyring({
      serializedKeys: 'v1:bounded-single-test-key',
      activeVersion: 'v1',
    });
    if (!keyring) throw new Error('Expected a test keyring');

    let previousHmac: string | null = null;
    const entries = Array.from({ length: 5_000 }, (_, index) => {
      const id = index + 1;
      const signed = signJournalEntry(buildMessageJournalEntry(id, {
        channelId,
        role: id % 2 === 0 ? 'assistant' : 'user',
        content: `message-${id}-${'x'.repeat(128)}`,
        timestamp: id * 1_000,
      }), keyring, previousHmac);
      previousHmac = signed._hmac ?? previousHmac;
      return signed;
    });
    writeFileSync(filePath, `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`, 'utf8');

    const stats: JournalBoundedReadStats = { bytesRead: 0, readCalls: 0, filesRead: 0 };
    const journalPort = createFilesystemSessionJournalPort();
    const readJournalEntriesBefore = journalPort.readJournalEntriesBefore;
    journalPort.readJournalEntriesBefore = (path, options) => readJournalEntriesBefore(path, {
      ...options,
      scanChunkBytes: 4 * 1_024,
      stats,
    });
    const archivePort = createFilesystemSessionArchivePort(journalPort);
    const readJournalFile = vi.spyOn(archivePort, 'readJournalFile');
    const store = new SessionStore(dir, {
      integrityKeyring: keyring,
      sessionArchivePort: archivePort,
    });
    readJournalFile.mockClear();

    expect(store.getEntriesInRange(channelId, 4_000, 4_002).map(entry => entry.id))
      .toEqual([4_000, 4_001, 4_002]);
    expect(readJournalFile).not.toHaveBeenCalled();
    expect(stats.bytesRead).toBeGreaterThan(0);
    expect(stats.bytesRead).toBeLessThan(statSync(filePath).size / 4);
  });
});
