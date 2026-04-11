import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildMessageJournalEntry } from '../../journals/journal/entries.js';
import { createFilesystemSessionArchivePort } from '../../journals/journal/port.js';
import { SessionJournalRuntime } from './journal-runtime.js';
import type { ChannelCache, ChannelIndexEntry } from '../store-primitives.js';
import type { SessionEntry } from '../../../core/session/types.js';
import type { TranscriptProjectionPort } from '../transcript-projection-port.js';

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
    const port = createFilesystemSessionArchivePort();
    const appendSpy = vi.spyOn(port, 'appendJournalEntry');
    const tailSpy = vi.spyOn(port, 'readJournalTailEntries');
    const runtime = new SessionJournalRuntime(null, port);
    const archive = runtime.openArchive('ch1', filePath);
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
      lastMessageTimestamp: 0,
      lastMessageRole: null,
      lastMessageAuthorName: undefined,
      lastMessagePreview: '',
      fullyLoaded: true,
      recentEntriesByLimit: new Map(),
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
      archive,
      journal: buildMessageJournalEntry(1, entry),
      upsertChannelIndex,
    });

    expect(appendSpy).toHaveBeenCalledWith(archive, expect.objectContaining({
      id: 1,
      channelId: 'ch1',
      type: 'message',
    }));
    expect(upsertChannelIndex).toHaveBeenCalledTimes(1);

    const recent = runtime.readRecentEntriesFromTail(archive, 1);
    expect(tailSpy).toHaveBeenCalledWith(archive, {
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

  it('marks projection drift instead of failing authoritative replay when backfill fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-session-journal-runtime-backfill-'));
    dirs.push(dir);
    const port = createFilesystemSessionArchivePort();
    const runtime = new SessionJournalRuntime(null, port);
    const archive = runtime.createArchive(dir, 'ch-projection', { timestamp: 1_000 });
    const filePath = runtime.resolveArchivePath(archive);
    const cache = {
      channelId: 'ch-projection',
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
      lastMessageTimestamp: 0,
      lastMessageRole: null,
      lastMessageAuthorName: undefined,
      lastMessagePreview: '',
      fullyLoaded: true,
      recentEntriesByLimit: new Map(),
    } satisfies ChannelCache;

    runtime.writeJournalEntry({
      cache,
      archive,
      journal: buildMessageJournalEntry(1, {
        channelId: 'ch-projection',
        role: 'user',
        content: 'projection replay source of truth',
        timestamp: 1_000,
      }),
      upsertChannelIndex: vi.fn(),
    });

    const projection: TranscriptProjectionPort = {
      upsertSessionEntry: vi.fn(),
      replaceChannelEntries: vi.fn(() => {
        throw new Error('projection backfill offline');
      }),
      countProjectedMessages: vi.fn(() => 0),
      markProjectionDrift: vi.fn(),
      clearProjectionDrift: vi.fn(),
      listProjectionDrift: vi.fn(() => []),
    };
    const channelIndex = new Map<string, ChannelIndexEntry>([
      ['ch-projection', { filename: filePath.split('/').at(-1)!, messageCount: 1 }],
    ]);

    expect(() => {
      runtime.backfillTranscriptProjectionFromDisk({
        transcriptProjection: projection,
        channelIndex,
        sessionsDir: dir,
      });
    }).not.toThrow();
    expect(projection.replaceChannelEntries).toHaveBeenCalledWith(
      'ch-projection',
      [
        expect.objectContaining({
          channelId: 'ch-projection',
          content: 'projection replay source of truth',
        }),
      ],
    );
    expect(projection.markProjectionDrift).toHaveBeenCalledWith(
      'ch-projection',
      'projection backfill offline',
    );
  });
});
