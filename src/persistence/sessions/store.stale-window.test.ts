import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from './store.js';
import { createCompactionBoundaryStore } from '../../core/session/manager/compaction-boundary-store.js';

// psfn-framework-hgw3.1: multiple processes (agent, gateway, garden) mount the
// same sessions dir with independent SessionStore instances. A fullyLoaded
// in-memory cache must never be served after another instance appended to the
// journal file, or the capture window silently loses the newest turn(s) and
// the model regenerates the previous reply. Two stores over one dir simulate
// the cross-process topology.
describe('SessionStore stale fullyLoaded window (psfn-framework-hgw3.1)', () => {
  let dir: string;
  let writerStore: SessionStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'psfn-session-stale-'));
    writerStore = new SessionStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function appendMessage(
    store: SessionStore,
    channelId: string,
    role: 'user' | 'assistant',
    content: string,
    timestamp: number,
  ): number {
    return store.append({
      channelId,
      role,
      content,
      timestamp,
      authorId: role === 'user' ? 'contact-1' : 'companion',
      authorName: role === 'user' ? 'FixtureContact' : 'FixtureCompanion',
    });
  }

  it('getEntriesInRange serves entries appended by another store instance after full load', () => {
    appendMessage(writerStore, 'ch-range', 'user', 'earlier question', 1_000);
    appendMessage(writerStore, 'ch-range', 'assistant', 'earlier answer', 2_000);
    appendMessage(writerStore, 'ch-range', 'user', 'follow-up question', 3_000);

    // Second instance over the same dir (cross-process simulation); fully
    // load its in-memory cache for the channel.
    const readerStore = new SessionStore(dir);
    expect(readerStore.getEntriesInRange('ch-range', 1, Number.MAX_SAFE_INTEGER)).toHaveLength(3);

    const externalId = appendMessage(writerStore, 'ch-range', 'assistant', 'follow-up answer', 4_000);

    const entries = readerStore.getEntriesInRange('ch-range', 1, Number.MAX_SAFE_INTEGER);
    expect(entries.map(entry => entry.id)).toContain(externalId);
    expect(entries.at(-1)?.content).toBe('follow-up answer');
  });

  it('getRecent fullyLoaded fast path serves entries appended by another store instance', () => {
    appendMessage(writerStore, 'ch-recent', 'user', 'first message', 1_000);
    appendMessage(writerStore, 'ch-recent', 'assistant', 'first reply', 2_000);

    // Force a second instance onto the fullyLoaded fast path.
    const readerStore = new SessionStore(dir);
    expect(readerStore.getEntriesInRange('ch-recent', 1, Number.MAX_SAFE_INTEGER)).toHaveLength(2);
    expect(readerStore.getRecent('ch-recent', 10)).toHaveLength(2);

    appendMessage(writerStore, 'ch-recent', 'user', 'second message', 3_000);
    const externalId = appendMessage(writerStore, 'ch-recent', 'assistant', 'second reply', 4_000);

    const recent = readerStore.getRecent('ch-recent', 10);
    expect(recent.map(entry => entry.id)).toContain(externalId);
    expect(recent.at(-1)?.content).toBe('second reply');
  });

  it('compaction-boundary getRecent window includes the previous turn recorded by another instance', () => {
    // Live failure shape: a channel WITH compaction summaries reads through
    // getEntriesInRange(coveredUpTo + 1, MAX) and served a window frozen at
    // the previous turn's user entry, missing the assistant reply that was
    // already on disk.
    const firstUserId = appendMessage(writerStore, 'ch-boundary', 'user', 'opening message', 1_000);
    const firstAssistantId = appendMessage(writerStore, 'ch-boundary', 'assistant', 'opening reply', 2_000);
    writerStore.insertCompaction('ch-boundary', 'summary of the opening exchange', firstAssistantId);
    const previousUserId = appendMessage(writerStore, 'ch-boundary', 'user', 'previous turn question', 3_000);

    const readerStore = new SessionStore(dir);
    const boundaryReader = createCompactionBoundaryStore(readerStore);
    const beforeExternalAppend = boundaryReader.getRecent('ch-boundary', 50);
    expect(beforeExternalAppend.map(entry => entry.id)).toEqual([previousUserId]);

    // Another process records the assistant reply and the next user message.
    const previousAssistantId = appendMessage(
      writerStore, 'ch-boundary', 'assistant', 'previous turn reply', 4_000,
    );
    const currentUserId = appendMessage(writerStore, 'ch-boundary', 'user', 'current turn question', 5_000);

    const window = boundaryReader.getRecent('ch-boundary', 50);
    expect(window.map(entry => entry.id)).toEqual([previousUserId, previousAssistantId, currentUserId]);
    expect(window.map(entry => entry.id)).not.toContain(firstUserId);
  });

  it('getCompactionSummaries sees a compaction inserted by another store instance', () => {
    appendMessage(writerStore, 'ch-compaction', 'user', 'message before compaction', 1_000);
    const assistantId = appendMessage(writerStore, 'ch-compaction', 'assistant', 'reply before compaction', 2_000);

    const readerStore = new SessionStore(dir);
    expect(readerStore.getCompactionSummaries('ch-compaction')).toHaveLength(0);

    writerStore.insertCompaction('ch-compaction', 'externally inserted summary', assistantId);

    const summaries = readerStore.getCompactionSummaries('ch-compaction');
    expect(summaries).toHaveLength(1);
    expect(summaries[0].coveredUpTo).toBe(assistantId);
  });

  it('tail-path getRecent stays fresh when the channel index file is clobbered back to stale metadata', () => {
    // Any process rewrites _channel_index.json whole-file from its in-memory
    // map; a stale rewrite reverts lightweight metadata. The limit-cache
    // fingerprint must not treat the reverted metadata as current when the
    // archive file itself has moved.
    for (let index = 0; index < 12; index += 1) {
      appendMessage(
        writerStore,
        'ch-tail',
        index % 2 === 0 ? 'user' : 'assistant',
        `tail message ${index + 1}`,
        1_000 + index,
      );
    }
    // Lightweight tail read (messageCount > limit) populates recentEntriesByLimit.
    const readerStore = new SessionStore(dir);
    expect(readerStore.getRecent('ch-tail', 5)).toHaveLength(5);

    const indexPath = join(dir, '_channel_index.json');
    const staleIndexBytes = readFileSync(indexPath, 'utf8');
    const externalId = appendMessage(writerStore, 'ch-tail', 'assistant', 'newest tail reply', 5_000);
    writeFileSync(indexPath, staleIndexBytes, 'utf8');

    const recent = readerStore.getRecent('ch-tail', 5);
    expect(recent.map(entry => entry.id)).toContain(externalId);
    expect(recent.at(-1)?.content).toBe('newest tail reply');
  });

  it('reloadChannelFromDisk drops the in-memory view and reports the on-disk max ids', () => {
    appendMessage(writerStore, 'ch-reload', 'user', 'reload seed message', 1_000);
    const readerStore = new SessionStore(dir);
    expect(readerStore.getEntriesInRange('ch-reload', 1, Number.MAX_SAFE_INTEGER)).toHaveLength(1);

    const externalId = appendMessage(writerStore, 'ch-reload', 'assistant', 'reload external reply', 2_000);

    const reloaded = readerStore.reloadChannelFromDisk('ch-reload');
    expect(reloaded).not.toBeNull();
    expect(reloaded?.maxEntryId).toBe(externalId);
    expect(reloaded?.lastMessageEntryId).toBe(externalId);
    expect(readerStore.getRecent('ch-reload', 10).at(-1)?.id).toBe(externalId);

    expect(readerStore.reloadChannelFromDisk('ch-missing')).toBeNull();
  });
});
