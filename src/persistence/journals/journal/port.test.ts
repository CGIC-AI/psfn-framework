import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildCompactionJournalEntry, buildMessageJournalEntry } from './entries.js';
import { createFilesystemSessionJournalPort } from './port.js';

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
});
