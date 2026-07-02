import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SessionEntry } from '../../../core/session/types.js';
import {
  createDefaultGroupMemorySettings,
  type GroupMemorySettings,
} from '../../../system/config/group-memory-config.js';
import {
  buildGroupMemoryRangePlan,
  createEmptyWatermark,
  JsonGroupMemoryWatermarkStore,
  type GroupMemoryRangeSessionReader,
} from './group-ranges.js';

function makeEntry(id: number, overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    id,
    channelId: 'discord-room',
    role: 'user',
    content: `message ${id}`,
    authorId: `user-${id % 3}`,
    authorName: `User ${id % 3}`,
    timestamp: id * 1_000,
    ...overrides,
  };
}

function makeEntries(count: number): SessionEntry[] {
  return Array.from({ length: count }, (_unused, index) => makeEntry(index + 1));
}

function makeReader(entries: SessionEntry[]): GroupMemoryRangeSessionReader & {
  recentCallCount: number;
  rangeCalls: Array<{ startId: number; endId: number }>;
  afterCalls: Array<{ afterId: number; limit: number }>;
} {
  const reader = {
    recentCallCount: 0,
    rangeCalls: [] as Array<{ startId: number; endId: number }>,
    afterCalls: [] as Array<{ afterId: number; limit: number }>,
    getLastEntry: () => entries.at(-1),
    getEntriesInRange: (_channelId: string, startId: number, endId: number) => {
      reader.rangeCalls.push({ startId, endId });
      return entries.filter(entry => entry.id >= startId && entry.id <= endId);
    },
    getEntriesAfter: (_channelId: string, afterId: number, limit: number) => {
      reader.afterCalls.push({ afterId, limit });
      return entries.filter(entry => entry.id > afterId).slice(0, limit);
    },
    getRecent: () => {
      reader.recentCallCount += 1;
      return [];
    },
  };
  return reader;
}

function settings(overrides: Partial<GroupMemorySettings['onlineExtraction']>): GroupMemorySettings {
  const defaults = createDefaultGroupMemorySettings();
  return {
    ...defaults,
    onlineExtraction: {
      ...defaults.onlineExtraction,
      ...overrides,
    },
  };
}

describe('group memory range planning', () => {
  it('selects a configured 50-message online window without tail sampling', () => {
    const entries = makeEntries(120);
    const reader = makeReader(entries);
    const plan = buildGroupMemoryRangePlan({
      channelId: 'discord-room',
      sessionReader: reader,
      settings: settings({
        maxMessagesPerChunk: 50,
        maxBacklogChunksPerRun: 1,
        chunkOverlapMessages: 5,
      }),
      watermark: createEmptyWatermark('discord-room'),
      estimateEntryTokens: () => 1,
    });

    expect(plan.chunks).toHaveLength(1);
    expect(plan.chunks[0].spanStartMessageId).toBe(1);
    expect(plan.chunks[0].spanEndMessageId).toBe(50);
    expect(plan.chunks[0].newEntryCount).toBe(50);
    expect(plan.hasDeferredBacklog).toBe(true);
    expect(plan.deferredAfterMessageId).toBe(50);
    expect(reader.afterCalls).toEqual([{ afterId: 0, limit: 51 }]);
    expect(reader.recentCallCount).toBe(0);
  });

  it('selects a configured 100-message online window', () => {
    const entries = makeEntries(120);
    const reader = makeReader(entries);
    const plan = buildGroupMemoryRangePlan({
      channelId: 'discord-room',
      sessionReader: reader,
      settings: settings({
        maxMessagesPerChunk: 100,
        maxBacklogChunksPerRun: 1,
        chunkOverlapMessages: 5,
      }),
      watermark: createEmptyWatermark('discord-room'),
      estimateEntryTokens: () => 1,
    });

    expect(plan.chunks).toHaveLength(1);
    expect(plan.chunks[0].spanEndMessageId).toBe(100);
    expect(plan.chunks[0].newEntryCount).toBe(100);
    expect(plan.hasDeferredBacklog).toBe(true);
    expect(reader.afterCalls).toEqual([{ afterId: 0, limit: 101 }]);
  });

  it('splits larger backlog into configured bounded chunks and defers the rest', () => {
    const entries = makeEntries(260);
    const reader = makeReader(entries);
    const plan = buildGroupMemoryRangePlan({
      channelId: 'discord-room',
      sessionReader: reader,
      settings: settings({
        maxMessagesPerChunk: 75,
        maxBacklogChunksPerRun: 2,
        chunkOverlapMessages: 5,
      }),
      watermark: createEmptyWatermark('discord-room'),
      estimateEntryTokens: () => 1,
    });

    expect(plan.chunks).toHaveLength(2);
    expect(plan.chunks.map(chunk => chunk.newEntryCount)).toEqual([75, 75]);
    expect(plan.chunks.map(chunk => chunk.spanEndMessageId)).toEqual([75, 150]);
    expect(plan.hasDeferredBacklog).toBe(true);
    expect(plan.deferredAfterMessageId).toBe(150);
    expect(reader.afterCalls).toEqual([{ afterId: 0, limit: 151 }]);
  });

  it('preserves attribution and metadata fields in range chunks', () => {
    const entries = [
      makeEntry(1),
      makeEntry(2, {
        authorId: 'human-2',
        authorName: 'Human Two',
        channelVisibility: 'invite_only',
        discordMessageId: 'discord-msg-2',
        metadata: JSON.stringify({ source: 'fixture' }),
      }),
    ];
    const reader = makeReader(entries);
    const plan = buildGroupMemoryRangePlan({
      channelId: 'discord-room',
      sessionReader: reader,
      settings: settings({
        maxMessagesPerChunk: 50,
        maxBacklogChunksPerRun: 1,
        chunkOverlapMessages: 1,
      }),
      watermark: {
        ...createEmptyWatermark('discord-room'),
        coveredUpToMessageId: 1,
      },
      estimateEntryTokens: () => 1,
    });

    expect(plan.chunks).toHaveLength(1);
    expect(plan.chunks[0].newEntries[0]).toMatchObject({
      id: 2,
      role: 'user',
      authorId: 'human-2',
      authorName: 'Human Two',
      timestamp: 2_000,
      channelVisibility: 'invite_only',
      discordMessageId: 'discord-msg-2',
      metadata: JSON.stringify({ source: 'fixture' }),
    });
    expect(plan.chunks[0].overlapEntryCount).toBe(1);
    expect(plan.chunks[0].entries.map(entry => entry.id)).toEqual([1, 2]);
  });

  it('respects configured token ceilings while still making progress', () => {
    const entries = [
      makeEntry(1, { content: '12345' }),
      makeEntry(2, { content: '12345' }),
      makeEntry(3, { content: '12345' }),
    ];
    const reader = makeReader(entries);
    const plan = buildGroupMemoryRangePlan({
      channelId: 'discord-room',
      sessionReader: reader,
      settings: settings({
        maxMessagesPerChunk: 50,
        maxEstimatedTokensPerChunk: 10,
        maxBacklogChunksPerRun: 2,
        chunkOverlapMessages: 0,
      }),
      watermark: createEmptyWatermark('discord-room'),
      estimateEntryTokens: () => 6,
    });

    expect(plan.chunks).toHaveLength(2);
    expect(plan.chunks.map(chunk => chunk.newEntryCount)).toEqual([1, 1]);
    expect(plan.hasDeferredBacklog).toBe(true);
  });

  it('persists processed, skipped, and failed watermark state without advancing on failure', () => {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-group-watermark-'));
    try {
      const store = new JsonGroupMemoryWatermarkStore(join(dir, 'group-memory-watermarks.json'));

      const processed = store.markProcessed({
        channelId: 'discord-room',
        startMessageId: 1,
        endMessageId: 50,
        entryCount: 50,
        recordedAt: 1_000,
      });
      expect(processed.coveredUpToMessageId).toBe(50);
      expect(processed.status).toBe('processed');
      expect(processed.processedSpanCount).toBe(1);

      const failed = store.markFailed({
        channelId: 'discord-room',
        startMessageId: 51,
        endMessageId: 75,
        entryCount: 25,
        recordedAt: 2_000,
        error: 'llm timeout',
      });
      expect(failed.coveredUpToMessageId).toBe(50);
      expect(failed.status).toBe('failed');
      expect(failed.lastFailure).toMatchObject({
        startMessageId: 51,
        endMessageId: 75,
        retryCount: 1,
      });

      const failedAgain = store.markFailed({
        channelId: 'discord-room',
        startMessageId: 51,
        endMessageId: 75,
        entryCount: 25,
        recordedAt: 3_000,
        error: 'llm timeout again',
      });
      expect(failedAgain.coveredUpToMessageId).toBe(50);
      expect(failedAgain.lastFailure?.retryCount).toBe(2);

      const skipped = store.markSkipped({
        channelId: 'discord-room',
        startMessageId: 51,
        endMessageId: 75,
        entryCount: 25,
        recordedAt: 4_000,
        reason: 'low signal',
      });
      expect(skipped.coveredUpToMessageId).toBe(75);
      expect(skipped.status).toBe('skipped');
      expect(skipped.lastSkippedSpan).toMatchObject({
        reason: 'low signal',
        startMessageId: 51,
        endMessageId: 75,
      });

      const reloaded = new JsonGroupMemoryWatermarkStore(join(dir, 'group-memory-watermarks.json'));
      expect(reloaded.get('discord-room')).toEqual(skipped);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns no chunks when the watermark already covers the head', () => {
    const entries = makeEntries(10);
    const reader = makeReader(entries);
    const plan = buildGroupMemoryRangePlan({
      channelId: 'discord-room',
      sessionReader: reader,
      watermark: {
        ...createEmptyWatermark('discord-room'),
        coveredUpToMessageId: 10,
      },
    });

    expect(plan.chunks).toEqual([]);
    expect(plan.hasDeferredBacklog).toBe(false);
    expect(reader.afterCalls).toEqual([]);
  });
});
