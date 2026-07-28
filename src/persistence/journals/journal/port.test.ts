import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildCompactionJournalEntry, buildMessageJournalEntry } from './entries.js';
import { createFilesystemSessionArchivePort, createFilesystemSessionJournalPort } from './port.js';

describe('session journal port', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  it('round-trips JSONL journal files through the filesystem-backed port', () => {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-session-journal-port-'));
    dirs.push(dir);
    const port = createFilesystemSessionJournalPort();
    const filePath = join(dir, 'journal.jsonl');

    port.appendJournalEntry(filePath, buildMessageJournalEntry(1, {
      channelId: 'ch1',
      role: 'user',
      content: 'hello',
      timestamp: 1_000,
    }));
    port.appendJournalEntry(filePath, buildCompactionJournalEntry(2, 'ch1', 'summary', 1, 2_000));

    expect(port.quarantineSidecarPath(filePath)).toBe(`${filePath}.quarantine`);

    const first = port.readJournalFirstEntry(filePath);
    expect(first).not.toBeNull();
    expect(first).toMatchObject({
      id: 1,
      channelId: 'ch1',
      type: 'message',
    });

    const parsed = port.readJournalFile(filePath);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.maxId).toBe(2);
    expect(parsed.quarantined).toEqual([]);

    const metadata = port.scanJournalFileMetadata(filePath);
    expect(metadata.entryCount).toBe(2);
    expect(metadata.messageCount).toBe(1);
    expect(metadata.maxId).toBe(2);
    expect(metadata.quarantined).toEqual([]);

    const tail = port.readJournalTailEntries(filePath, { messageLimit: 1 });
    expect(tail.entries).toHaveLength(2);
    expect(tail.truncated).toBe(false);
    expect(tail.quarantined).toEqual([]);
  });

  it('writes imported L0 sessions through the archive port', () => {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-session-archive-port-'));
    dirs.push(dir);
    const port = createFilesystemSessionArchivePort();

    const written = port.writeImportedSession({
      sessionsDir: dir,
      channelId: 'api:l0-seed',
      seedTimestamp: 1_000,
      seedAuthorId: 'user-1',
      seedAuthorName: 'User One',
      messages: [
        {
          role: 'user',
          content: 'hello',
          timestamp: 1_000,
        },
        {
          role: 'assistant',
          content: 'hi',
          timestamp: 2_000,
        },
      ],
    });

    expect(written.entryCount).toBe(2);
    const archive = port.openArchive('api:l0-seed', written.filePath);
    const parsed = port.readJournalFile(archive);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0]).toMatchObject({
      channelId: 'api:l0-seed',
      type: 'message',
    });
  });

  it('reads a bounded page before an id across numbered journal segments', () => {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-session-journal-before-'));
    dirs.push(dir);
    const port = createFilesystemSessionJournalPort();
    const filePath = join(dir, 'journal.jsonl');
    const content = 'x'.repeat(4 * 1024);
    const writeMessages = (target: string, firstId: number, lastId: number): void => {
      const lines = [];
      for (let id = firstId; id <= lastId; id += 1) {
        lines.push(JSON.stringify(buildMessageJournalEntry(id, {
          channelId: 'ch1',
          role: id % 2 === 0 ? 'assistant' : 'user',
          content: `${content}-${id}`,
          timestamp: id * 1_000,
        })));
      }
      writeFileSync(target, `${lines.join('\n')}\n`, 'utf8');
    };

    for (let segment = 1; segment <= 5; segment += 1) {
      const firstId = (segment - 1) * 50 + 1;
      writeMessages(
        join(dir, `journal.${String(segment).padStart(5, '0')}.jsonl`),
        firstId,
        firstId + 49,
      );
    }
    writeMessages(filePath, 251, 260);

    const stats = { bytesRead: 0, readCalls: 0, filesRead: 0 };
    const page = port.readJournalEntriesBefore(filePath, {
      beforeId: 249,
      messageLimit: 3,
      scanChunkBytes: 256,
      stats,
    });

    expect(page.entries.map(entry => entry.id)).toEqual([245, 246, 247, 248]);
    expect(page.entries.filter(entry => entry.type === 'message').map(entry => entry.id)).toEqual([245, 246, 247, 248]);
    expect(page.truncated).toBe(true);
    expect(page.quarantined).toEqual([]);
    expect(stats.filesRead).toBeLessThanOrEqual(4);
    expect(stats.bytesRead).toBeLessThan(64 * 1024);
    expect(stats.readCalls).toBeLessThan(300);
  });

  it('keeps legacy unsegmented before-id reads byte-identical', () => {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-session-journal-before-legacy-'));
    dirs.push(dir);
    const port = createFilesystemSessionJournalPort();
    const filePath = join(dir, 'journal.jsonl');
    const entries = Array.from({ length: 10 }, (_, index) => buildMessageJournalEntry(index + 1, {
      channelId: 'ch1',
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `message-${index + 1}`,
      timestamp: (index + 1) * 1_000,
    }));
    writeFileSync(filePath, `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`, 'utf8');

    const page = port.readJournalEntriesBefore(filePath, {
      beforeId: 8,
      messageLimit: 3,
    });

    expect(page.entries).toEqual(entries.slice(3, 7));
    expect(page.truncated).toBe(true);
  });

  it('seeks to a deep unsegmented cursor without reading the archive prefix', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-session-journal-before-deep-'));
    dirs.push(dir);
    const port = createFilesystemSessionJournalPort();
    const filePath = join(dir, 'journal.jsonl');
    const content = 'x'.repeat(4 * 1024);
    const entries = Array.from({ length: 1_000 }, (_, index) => buildMessageJournalEntry(index + 1, {
      channelId: 'ch1',
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `${content}-${index + 1}`,
      timestamp: (index + 1) * 1_000,
    }));
    writeFileSync(filePath, `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`, 'utf8');

    const stats = { bytesRead: 0, readCalls: 0, filesRead: 0 };
    const page = port.readJournalEntriesBefore(filePath, {
      beforeId: 12,
      messageLimit: 3,
      scanChunkBytes: 256,
      stats,
    });

    expect(page.entries.map(entry => entry.id)).toEqual([8, 9, 10, 11]);
    expect(stats.bytesRead).toBeLessThan(128 * 1024);
    expect(stats.readCalls).toBeLessThan(300);

    const asyncStats = {
      bytesRead: 0,
      readCalls: 0,
      filesRead: 0,
      maxRetainedLineBytes: 0,
      eventLoopYields: 0,
    };
    const asyncPage = await port.readJournalEntriesBeforeAsync(filePath, {
      beforeId: 12,
      messageLimit: 3,
      scanChunkBytes: 256,
      stats: asyncStats,
    });
    expect(asyncPage.entries.map(entry => entry.id)).toEqual([8, 9, 10, 11]);
    expect(asyncStats.bytesRead).toBeLessThan(128 * 1024);
    expect(asyncStats.eventLoopYields).toBeGreaterThan(0);
  });

  it('finds a cursor across many sealed segments without opening every newer segment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-session-journal-before-many-segments-'));
    dirs.push(dir);
    const port = createFilesystemSessionJournalPort();
    const filePath = join(dir, 'journal.jsonl');
    const writeMessages = (target: string, firstId: number): void => {
      const entries = Array.from({ length: 10 }, (_, index) => buildMessageJournalEntry(firstId + index, {
        channelId: 'ch1',
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `message-${firstId + index}`,
        timestamp: (firstId + index) * 1_000,
      }));
      writeFileSync(target, `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
    };

    for (let segment = 1; segment <= 100; segment += 1) {
      writeMessages(join(dir, `journal.${String(segment).padStart(5, '0')}.jsonl`), (segment - 1) * 10 + 1);
    }
    writeMessages(filePath, 1_001);

    const stats = { bytesRead: 0, readCalls: 0, filesRead: 0 };
    const page = port.readJournalEntriesBefore(filePath, {
      beforeId: 16,
      messageLimit: 3,
      scanChunkBytes: 128,
      stats,
    });

    expect(page.entries.map(entry => entry.id)).toEqual([12, 13, 14, 15]);
    expect(stats.filesRead).toBeLessThan(20);
  });

  it('cooperatively rejects an oversized current seek row without retaining or truncating it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-session-journal-oversized-seek-'));
    dirs.push(dir);
    const port = createFilesystemSessionJournalPort();
    const filePath = join(dir, 'journal.jsonl');
    const oversized = buildMessageJournalEntry(1, {
      channelId: 'ch1',
      role: 'user',
      content: `private-current:${'x'.repeat(3 * 1024 * 1024)}`,
      timestamp: 1_000,
    });
    writeFileSync(filePath, `${JSON.stringify(oversized)}\n`, 'utf8');

    const stats = {
      bytesRead: 0,
      readCalls: 0,
      filesRead: 0,
      maxRetainedLineBytes: 0,
      eventLoopYields: 0,
    };
    let timerFired = false;
    const timer = new Promise<void>(resolve => {
      setTimeout(() => {
        timerFired = true;
        resolve();
      }, 0);
    });

    await expect(port.readJournalEntriesBeforeAsync(filePath, {
      beforeId: 2,
      messageLimit: 1,
      scanChunkBytes: 64 * 1024,
      stats,
    })).rejects.toMatchObject({
      code: 'EOVERFLOW',
      message: expect.stringContaining('refusing to truncate or retain it'),
    });
    await timer;

    expect(timerFired).toBe(true);
    expect(stats.eventLoopYields).toBeGreaterThan(0);
    expect(stats.maxRetainedLineBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(stats.bytesRead).toBeLessThanOrEqual((2 * 1024 * 1024) + (64 * 1024));

    const syncStats = {
      bytesRead: 0,
      readCalls: 0,
      filesRead: 0,
      maxRetainedLineBytes: 0,
    };
    expect(() => port.readJournalEntriesBefore(filePath, {
      beforeId: 2,
      messageLimit: 1,
      scanChunkBytes: 64 * 1024,
      stats: syncStats,
    })).toThrow(expect.objectContaining({ code: 'EOVERFLOW' }));
    expect(syncStats.maxRetainedLineBytes).toBeLessThanOrEqual(2 * 1024 * 1024);

    const repaired = buildMessageJournalEntry(1, {
      channelId: 'ch1',
      role: 'user',
      content: 'repaired current',
      timestamp: 1_000,
    });
    writeFileSync(filePath, `${JSON.stringify(repaired)}\n`, 'utf8');
    const retried = await port.readJournalEntriesBeforeAsync(filePath, {
      beforeId: 2,
      messageLimit: 1,
      scanChunkBytes: 127,
    });
    expect(retried.entries).toEqual([repaired]);
    expect(retried.quarantined).toEqual([]);
  });

  it('cooperatively rejects an oversized trusted predecessor and retries from clean state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-session-journal-oversized-predecessor-'));
    dirs.push(dir);
    const port = createFilesystemSessionJournalPort();
    const filePath = join(dir, 'journal.jsonl');
    const sealedPath = join(dir, 'journal.00001.jsonl');
    const first = {
      ...buildMessageJournalEntry(1, {
        channelId: 'ch1',
        role: 'user',
        content: 'sealed first',
        timestamp: 1_000,
      }),
      _hmac: 'sealed-first-hmac',
    };
    const oversizedPrevious = {
      ...buildMessageJournalEntry(2, {
        channelId: 'ch1',
        role: 'assistant',
        content: `private-predecessor:${'🜁'.repeat(800_000)}`,
        timestamp: 2_000,
      }),
      _hmac: 'oversized-predecessor-hmac',
    };
    const active = {
      ...buildMessageJournalEntry(3, {
        channelId: 'ch1',
        role: 'user',
        content: 'active current',
        timestamp: 3_000,
      }),
      _hmac: 'active-hmac',
    };
    writeFileSync(sealedPath, `${JSON.stringify(first)}\n${JSON.stringify(oversizedPrevious)}\n`, 'utf8');
    writeFileSync(filePath, `${JSON.stringify(active)}\n`, 'utf8');

    const stats = {
      bytesRead: 0,
      readCalls: 0,
      filesRead: 0,
      maxRetainedLineBytes: 0,
      eventLoopYields: 0,
    };
    let timerFired = false;
    const timer = new Promise<void>(resolve => {
      setTimeout(() => {
        timerFired = true;
        resolve();
      }, 0);
    });
    const trustCalls: Array<[number, string | null]> = [];
    const trustSeekEntry = (entry: { id: number }, previousHmac: string | null): boolean => {
      trustCalls.push([entry.id, previousHmac]);
      return true;
    };

    await expect(port.readJournalEntriesBeforeAsync(filePath, {
      beforeId: 4,
      messageLimit: 1,
      scanChunkBytes: 64 * 1024,
      stats,
      trustSeekEntry,
    })).rejects.toMatchObject({ code: 'EOVERFLOW' });
    await timer;
    expect(timerFired).toBe(true);
    expect(stats.eventLoopYields).toBeGreaterThan(0);
    expect(stats.maxRetainedLineBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(trustCalls).not.toContainEqual([3, 'oversized-predecessor-hmac']);

    const repairedPrevious = {
      ...oversizedPrevious,
      content: 'repaired predecessor',
      _hmac: 'repaired-predecessor-hmac',
    };
    writeFileSync(sealedPath, `${JSON.stringify(first)}\n${JSON.stringify(repairedPrevious)}\n`, 'utf8');
    trustCalls.length = 0;
    const retried = await port.readJournalEntriesBeforeAsync(filePath, {
      beforeId: 4,
      messageLimit: 1,
      scanChunkBytes: 127,
      trustSeekEntry,
    });

    expect(trustCalls).toContainEqual([3, 'repaired-predecessor-hmac']);
    expect(retried.entries.map(entry => entry.id)).toEqual([2, 3]);
    expect(retried.quarantined).toEqual([]);
  });

  it('preserves exact UTF-8 rows across cooperative seek chunk boundaries', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-session-journal-utf8-seek-'));
    dirs.push(dir);
    const port = createFilesystemSessionJournalPort();
    const filePath = join(dir, 'journal.jsonl');
    const unicodeContent = `boundary:${'🜁🜂🜃🜄'.repeat(5_000)}`;
    const entries = [
      buildMessageJournalEntry(1, {
        channelId: 'ch1',
        role: 'user',
        content: unicodeContent,
        timestamp: 1_000,
      }),
      buildMessageJournalEntry(2, {
        channelId: 'ch1',
        role: 'assistant',
        content: 'reply',
        timestamp: 2_000,
      }),
    ];
    writeFileSync(filePath, `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
    const stats = {
      bytesRead: 0,
      readCalls: 0,
      filesRead: 0,
      maxRetainedLineBytes: 0,
      eventLoopYields: 0,
    };

    const page = await port.readJournalEntriesBeforeAsync(filePath, {
      beforeId: 3,
      messageLimit: 2,
      scanChunkBytes: 127,
      stats,
    });

    expect(page.entries).toEqual(entries);
    expect(page.entries[0]?.content).toBe(unicodeContent);
    expect(stats.eventLoopYields).toBeGreaterThan(0);
    expect(stats.maxRetainedLineBytes).toBeGreaterThan(127);
  });

  it('retries an identity-fenced cooperative seek after active-file rotation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-session-journal-rotating-seek-'));
    dirs.push(dir);
    const port = createFilesystemSessionJournalPort();
    const filePath = join(dir, 'journal.jsonl');
    const sealedPath = join(dir, 'journal.00001.jsonl');
    const initial = [
      {
        ...buildMessageJournalEntry(1, {
          channelId: 'ch1',
          role: 'user',
          content: 'before rotation',
          timestamp: 1_000,
        }),
        _hmac: 'hmac-1',
      },
      {
        ...buildMessageJournalEntry(2, {
          channelId: 'ch1',
          role: 'assistant',
          content: 'rotation boundary',
          timestamp: 2_000,
        }),
        _hmac: 'hmac-2',
      },
    ];
    const active = {
      ...buildMessageJournalEntry(3, {
        channelId: 'ch1',
        role: 'user',
        content: 'after rotation',
        timestamp: 3_000,
      }),
      _hmac: 'hmac-3',
    };
    writeFileSync(filePath, `${initial.map(entry => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
    let rotated = false;
    let trustCalls = 0;

    const page = await port.readJournalEntriesBeforeAsync(filePath, {
      beforeId: 3,
      messageLimit: 1,
      scanChunkBytes: 127,
      trustSeekEntry: () => {
        trustCalls += 1;
        if (!rotated) {
          rotated = true;
          renameSync(filePath, sealedPath);
          writeFileSync(filePath, `${JSON.stringify(active)}\n`, 'utf8');
        }
        return true;
      },
    });

    expect(rotated).toBe(true);
    expect(trustCalls).toBeGreaterThan(1);
    expect(page.entries.map(entry => entry.id)).toEqual([1, 2]);
    expect(page.quarantined).toEqual([]);
  });

  it('treats sealed segments as canonical for replay, metadata, tails, fingerprints, and rewrites', () => {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-session-journal-canonical-segments-'));
    dirs.push(dir);
    const port = createFilesystemSessionArchivePort();
    const filePath = join(dir, 'journal.jsonl');
    const sealedPath = join(dir, 'journal.00001.jsonl');
    const entries = Array.from({ length: 6 }, (_, index) => buildMessageJournalEntry(index + 1, {
      channelId: 'ch1',
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `message-${index + 1}`,
      timestamp: (index + 1) * 1_000,
    }));
    writeFileSync(sealedPath, `${entries.slice(0, 4).map(entry => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
    writeFileSync(filePath, `${entries.slice(4).map(entry => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
    const archive = port.openArchive('ch1', filePath);

    expect(port.readJournalFile(archive).entries.map(entry => entry.id)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(port.scanJournalFileMetadata(archive)).toMatchObject({
      entryCount: 6,
      messageCount: 6,
      maxId: 6,
    });
    expect(port.readJournalTailEntries(archive, {
      messageLimit: 2,
      includeBoundaryEntry: true,
    }).entries.map(entry => entry.id)).toEqual([4, 5, 6]);
    const fingerprintBefore = port.fingerprintArchive(archive);
    writeFileSync(sealedPath, `${JSON.stringify(entries[0])}\n`, 'utf8');
    expect(port.fingerprintArchive(archive)).not.toBe(fingerprintBefore);

    port.writeJournalFile(archive, entries);
    expect(existsSync(sealedPath)).toBe(false);
    expect(port.readJournalFile(archive).entries.map(entry => entry.id)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
