import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildMessageJournalEntry } from '../../journals/journal/entries.js';
import { createFilesystemSessionJournalPort } from '../../journals/journal/port.js';
import { SessionJournalRuntime } from './journal-runtime.js';
import type { ChannelCache } from '../store-primitives.js';
import type { SessionEntry } from '../../../core/session/types.js';

describe('SessionJournalRuntime', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  it('uses the injected journal port for persistence and tail reads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-session-journal-runtime-'));
    dirs.push(dir);
    const filePath = join(dir, 'session.jsonl');
    const port = createFilesystemSessionJournalPort();
    const appendSpy = vi.spyOn(port, 'appendJournalEntry');
    const tailSpy = vi.spyOn(port, 'readJournalTailEntries');
    const runtime = new SessionJournalRuntime(null, port);
    const cache = {
      channelId: 'ch1',
      entries: [],
      compactions: [],
      turnTombstones: new Set<string>(),
      activeTurnTombstoneCount: 0,
      nextId: 1,
      lastHmac: null,
      lastExtractionCoveredUpTo: 0,
      lastJournalEntry: null,
      resolvedPath: filePath,
      messageCount: 0,
      lastTimestamp: 0,
      fullyLoaded: true,
    } satisfies ChannelCache;
    const upsertChannelIndex = vi.fn();
    const entry: Omit<SessionEntry, 'id'> = {
      channelId: 'ch1',
      role: 'user',
      content: 'hello',
      timestamp: 1_000,
    };

    runtime.writeJournalEntry({
      cache,
      journal: buildMessageJournalEntry(1, entry),
      upsertChannelIndex,
    });

    expect(appendSpy).toHaveBeenCalledWith(filePath, expect.objectContaining({
      id: 1,
      channelId: 'ch1',
      type: 'message',
    }));
    expect(upsertChannelIndex).toHaveBeenCalledTimes(1);

    const recent = runtime.readRecentEntriesFromTail('ch1', filePath, 1);
    expect(tailSpy).toHaveBeenCalledWith(filePath, {
      messageLimit: 1,
      includeBoundaryEntry: true,
    });
    expect(recent).toHaveLength(1);
    expect(recent[0]).toMatchObject({
      id: 1,
      channelId: 'ch1',
      content: 'hello',
    });
  });
});
