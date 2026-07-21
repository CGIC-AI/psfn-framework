import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildMessageJournalEntry, buildTurnTombstoneJournalEntry } from '../../journals/journal/entries.js';
import { createFilesystemSessionArchivePort } from '../../journals/journal/port.js';
import { buildSessionHmacKeyring, signJournalEntry } from '../../journals/journal-utils.js';
import { SessionJournalRuntime } from './journal-runtime.js';
import { createKeyringIntegrityProvider, type ChannelCache, type ChannelIndexEntry } from '../store-primitives.js';
import type { JournalEntry, SessionEntry } from '../../../core/session/types.js';
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
      compactionArchivePaths: new Set(),
      turnTombstones: new Set<string>(),
      activeTurnTombstoneCount: 0,
      nextId: 1,
      lastHmac: null,
      lastExtractionCoveredUpTo: 0,
      lastJournalEntry: null,
      archivePaths: [filePath],
      resolvedPath: filePath,
      messageCount: 0,
      lastTimestamp: 0,
      lastMessageTimestamp: 0,
      lastMessageRole: null,
      lastMessageAuthorName: undefined,
      lastMessagePreview: '',
      fullyLoaded: true,
      archiveFingerprint: null,
      recentEntriesByLimit: new Map(),
    } satisfies ChannelCache;
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
    });

    expect(appendSpy).toHaveBeenCalledWith(archive, expect.objectContaining({
      id: 1,
      channelId: 'ch1',
      type: 'message',
    }));
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
      compactionArchivePaths: new Set(),
      turnTombstones: new Set<string>(),
      activeTurnTombstoneCount: 0,
      nextId: 1,
      lastHmac: null,
      lastExtractionCoveredUpTo: 0,
      lastJournalEntry: null,
      archivePaths: [filePath],
      resolvedPath: filePath,
      messageCount: 0,
      lastTimestamp: 0,
      lastMessageTimestamp: 0,
      lastMessageRole: null,
      lastMessageAuthorName: undefined,
      lastMessagePreview: '',
      fullyLoaded: true,
      archiveFingerprint: null,
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
      ['ch-projection', {
        filename: filePath.split('/').at(-1)!,
        filenames: [filePath.split('/').at(-1)!],
        messageCount: 1,
      }],
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

  it('renders one full unverified_history notice when a failed run begins with a non-rendered entry (bead g59z)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-session-journal-g59z-'));
    dirs.push(dir);
    const channelId = 'ch-g59z';
    const filePath = join(dir, 'session.jsonl');
    const keyring = buildSessionHmacKeyring({ serializedKeys: 'v1:g59z-test-key', activeVersion: 'v1' });
    if (!keyring) throw new Error('Expected a test keyring');

    let previousHmac: string | null = null;
    const sign = (entry: JournalEntry): JournalEntry => {
      const result = signJournalEntry(entry, keyring, previousHmac);
      previousHmac = result._hmac ?? previousHmac;
      return result;
    };

    // A contiguous HMAC-failed run that BEGINS with a non-rendered entry type
    // (a tombstone, which never emits an unverified_history wrapper) followed by
    // a rendered failed message. The message must still show the FULL notice.
    const tombstone = sign(buildTurnTombstoneJournalEntry(1, channelId, {
      turnId: 'turn:nonexistent',
      action: 'redact',
      timestamp: 1_000,
      actor: 'admin:test',
      reason: 'privacy request',
    }));
    const message = sign(buildMessageJournalEntry(2, {
      channelId,
      role: 'user',
      content: 'secret content that failed verification',
      timestamp: 2_000,
    }));
    // Tamper both after signing so each fails HMAC as one contiguous run.
    const tamperedTombstone: JournalEntry = { ...tombstone, timestamp: 9_999 };
    const tamperedMessage: JournalEntry = { ...message, content: 'tampered secret content' };

    const port = createFilesystemSessionArchivePort();
    const provider = createKeyringIntegrityProvider(keyring);
    if (!provider) throw new Error('Expected an integrity provider');
    const runtime = new SessionJournalRuntime(provider, port);
    const archive = runtime.openArchive(channelId, filePath);
    port.writeJournalFile(archive, [tamperedTombstone, tamperedMessage]);

    const cache = runtime.loadChannel(archive);
    const rendered = cache.entries.map(entry => entry.content).join('\n');
    // The leading tombstone must NOT have consumed the run's single notice, so
    // the first rendered failed message shows the full boilerplate, not a bare
    // continuation tag.
    expect(rendered).toContain('<unverified_history>');
    expect(rendered).not.toContain('<unverified_history continued>');
    expect(rendered.match(/<unverified_history>/g)).toHaveLength(1);
  });

  it('retries a full chain load when the archive generation changes during the read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-session-chain-generation-'));
    dirs.push(dir);
    const port = createFilesystemSessionArchivePort();
    const runtime = new SessionJournalRuntime(null, port);
    const archive = runtime.openArchive('ch-generation', join(dir, 'session.jsonl'));
    port.writeJournalFile(archive, [buildMessageJournalEntry(1, {
      channelId: 'ch-generation',
      role: 'user',
      content: 'stable after retry',
      timestamp: 1_000,
    })]);
    const generations = ['generation-1', 'generation-2', 'generation-2', 'generation-2'];
    const fingerprintSpy = vi.spyOn(port, 'fingerprintArchive')
      .mockImplementation(() => generations.shift() ?? 'generation-2');

    expect(runtime.loadChannel(archive).entries.map(entry => entry.content)).toEqual([
      'stable after retry',
    ]);
    expect(fingerprintSpy).toHaveBeenCalledTimes(4);
  });

  it('retries a tail read when the archive generation changes during the read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-session-tail-generation-'));
    dirs.push(dir);
    const port = createFilesystemSessionArchivePort();
    const runtime = new SessionJournalRuntime(null, port);
    const archive = runtime.openArchive('ch-tail-generation', join(dir, 'session.jsonl'));
    port.writeJournalFile(archive, [buildMessageJournalEntry(1, {
      channelId: 'ch-tail-generation',
      role: 'assistant',
      content: 'tail stable after retry',
      timestamp: 1_000,
    })]);
    const generations = ['generation-1', 'generation-2', 'generation-2', 'generation-2'];
    const fingerprintSpy = vi.spyOn(port, 'fingerprintArchive')
      .mockImplementation(() => generations.shift() ?? 'generation-2');

    expect(runtime.readRecentEntriesFromTail(archive, 1).map(entry => entry.content)).toEqual([
      'tail stable after retry',
    ]);
    expect(fingerprintSpy).toHaveBeenCalledTimes(4);
  });
});
