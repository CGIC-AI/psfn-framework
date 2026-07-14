import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
});
