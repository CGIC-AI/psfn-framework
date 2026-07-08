import { describe, expect, it, vi } from 'vitest';
import type { SessionEntry } from '../../../core/session/types.js';
import {
  createDefaultGroupMemorySettings,
  type GroupMemorySettings,
} from '../../../system/config/group-memory-config.js';
import {
  createEmptyWatermark,
  type GroupMemoryRangeSessionReader,
  type GroupMemoryWatermarkMutationInput,
  type GroupMemoryWatermarkRecord,
  type GroupMemoryWatermarkStorePort,
} from './group-ranges.js';
import {
  GroupMemoryBackfillRunner,
  type GroupMemoryBackfillExtractorPort,
} from './group-backfill.js';

const CHANNEL_ID = 'discord:backfill-room';

function makeEntry(id: number, content = 'lol'): SessionEntry {
  return {
    id,
    channelId: CHANNEL_ID,
    role: 'user',
    content,
    authorId: `human-${id % 4}`,
    authorName: `Human ${id % 4}`,
    timestamp: id * 1_000,
  };
}

function makeEntries(count: number): SessionEntry[] {
  return Array.from({ length: count }, (_unused, index) => makeEntry(index + 1));
}

function makeReader(entries: SessionEntry[]): GroupMemoryRangeSessionReader & {
  getRecent: ReturnType<typeof vi.fn>;
} {
  return {
    getLastEntry: vi.fn(() => entries.at(-1)),
    getEntriesInRange: vi.fn((_channelId: string, startId: number, endId: number) => (
      entries.filter(entry => entry.id >= startId && entry.id <= endId)
    )),
    getEntriesAfter: vi.fn((_channelId: string, afterId: number, limit: number) => (
      entries.filter(entry => entry.id > afterId).slice(0, limit)
    )),
    getRecent: vi.fn((_channelId: string, limit: number) => entries.slice(-limit)),
  };
}

function makeSettings(overrides: {
  maxMessagesPerRun?: number;
  maxChunksPerRun?: number;
  maxLlmCallsPerRun?: number;
  maxMessagesPerChunk?: number;
} = {}): GroupMemorySettings {
  const defaults = createDefaultGroupMemorySettings();
  return {
    ...defaults,
    memoryMode: 'group',
    onlineExtraction: {
      ...defaults.onlineExtraction,
      maxMessagesPerChunk: overrides.maxMessagesPerChunk ?? 75,
      maxBacklogChunksPerRun: 4,
    },
    backfill: {
      ...defaults.backfill,
      maxMessagesPerRun: overrides.maxMessagesPerRun ?? 50,
      maxChunksPerRun: overrides.maxChunksPerRun ?? 2,
      maxLlmCallsPerRun: overrides.maxLlmCallsPerRun ?? 2,
    },
  };
}

class FakeWatermarkStore implements GroupMemoryWatermarkStorePort {
  record: GroupMemoryWatermarkRecord;
  processed: GroupMemoryWatermarkMutationInput[] = [];
  skipped: Array<GroupMemoryWatermarkMutationInput & { reason: string }> = [];
  failed: Array<GroupMemoryWatermarkMutationInput & { error: string }> = [];

  constructor(coveredUpToMessageId = 0) {
    this.record = {
      ...createEmptyWatermark(CHANNEL_ID),
      coveredUpToMessageId,
    };
  }

  get(): GroupMemoryWatermarkRecord {
    return this.record;
  }

  markProcessed(input: GroupMemoryWatermarkMutationInput): GroupMemoryWatermarkRecord {
    this.processed.push(input);
    this.record = {
      ...this.record,
      coveredUpToMessageId: Math.max(this.record.coveredUpToMessageId, input.endMessageId),
      status: 'processed',
      processedSpanCount: this.record.processedSpanCount + 1,
      updatedAt: input.recordedAt ?? 0,
      lastProcessedSpan: {
        startMessageId: input.startMessageId,
        endMessageId: input.endMessageId,
        entryCount: input.entryCount,
        recordedAt: input.recordedAt ?? 0,
      },
    };
    return this.record;
  }

  markSkipped(input: GroupMemoryWatermarkMutationInput & { reason: string }): GroupMemoryWatermarkRecord {
    this.skipped.push(input);
    this.record = {
      ...this.record,
      coveredUpToMessageId: Math.max(this.record.coveredUpToMessageId, input.endMessageId),
      status: 'skipped',
      skippedSpanCount: this.record.skippedSpanCount + 1,
      updatedAt: input.recordedAt ?? 0,
      lastSkippedSpan: {
        startMessageId: input.startMessageId,
        endMessageId: input.endMessageId,
        entryCount: input.entryCount,
        recordedAt: input.recordedAt ?? 0,
        reason: input.reason,
      },
    };
    return this.record;
  }

  markFailed(input: GroupMemoryWatermarkMutationInput & { error: string }): GroupMemoryWatermarkRecord {
    this.failed.push(input);
    this.record = {
      ...this.record,
      status: 'failed',
      failureCount: this.record.failureCount + 1,
      updatedAt: input.recordedAt ?? 0,
      lastFailure: {
        startMessageId: input.startMessageId,
        endMessageId: input.endMessageId,
        entryCount: input.entryCount,
        recordedAt: input.recordedAt ?? 0,
        error: input.error,
        retryCount: 1,
      },
    };
    return this.record;
  }
}

function makeExtractor(): GroupMemoryBackfillExtractorPort & {
  extractGroupBackfillRange: ReturnType<typeof vi.fn>;
} {
  return {
    extractGroupBackfillRange: vi.fn(async () => true),
    getPendingExtractionPromise: vi.fn(() => null),
  };
}

describe('GroupMemoryBackfillRunner', () => {
  it('dry-runs a bounded configured window without writing or advancing the watermark', async () => {
    const entries = makeEntries(120);
    entries[9] = makeEntry(10, 'Carlini, remember I prefer jasmine tea.');
    entries[79] = makeEntry(80, 'My favorite coffee is cardamom latte.');
    const extractor = makeExtractor();
    const watermarkStore = new FakeWatermarkStore();
    const runner = new GroupMemoryBackfillRunner({
      groupMemory: makeSettings({ maxMessagesPerRun: 50, maxChunksPerRun: 1, maxLlmCallsPerRun: 1 }),
      sessionReader: makeReader(entries),
      watermarkStore,
      memoryExtractor: extractor,
      companionNames: ['Carlini'],
    });

    const result = await runner.run(CHANNEL_ID, {
      mode: 'dry_run',
      startMessageId: 1,
      endMessageId: 120,
    });

    expect(result.status).toBe('planned');
    expect(result.plannedChunkCount).toBe(1);
    expect(result.plannedLlmCalls).toBe(1);
    expect(result.chunks[0]).toEqual(expect.objectContaining({
      spanStartMessageId: 1,
      spanEndMessageId: 50,
      action: 'planned',
      candidateSourceMessageIds: expect.arrayContaining([10]),
    }));
    expect(extractor.extractGroupBackfillRange).not.toHaveBeenCalled();
    expect(watermarkStore.processed).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain('jasmine tea');
    expect(result.privacy).toEqual({
      rawTranscriptTextIncluded: false,
      memoryTextIncluded: false,
    });
  });

  it('live-runs through the extractor and advances the watermark only after success', async () => {
    const entries = makeEntries(60);
    entries[9] = makeEntry(10, 'Carlini, remember I prefer jasmine tea.');
    const extractor = makeExtractor();
    const watermarkStore = new FakeWatermarkStore();
    const runner = new GroupMemoryBackfillRunner({
      groupMemory: makeSettings({ maxMessagesPerRun: 50, maxChunksPerRun: 1, maxLlmCallsPerRun: 1 }),
      sessionReader: makeReader(entries),
      watermarkStore,
      memoryExtractor: extractor,
      companionNames: ['Carlini'],
      nowMs: () => 9_000,
    });

    const result = await runner.run(CHANNEL_ID, {
      mode: 'live',
      startMessageId: 1,
      endMessageId: 60,
    });

    expect(result.status).toBe('completed');
    expect(result.processedChunkCount).toBe(1);
    expect(result.executedLlmCalls).toBe(1);
    expect(extractor.extractGroupBackfillRange).toHaveBeenCalledWith(expect.objectContaining({
      channelId: CHANNEL_ID,
      groupWriteCaps: expect.objectContaining({ maxWritesPerBackfillRun: expect.any(Number) }),
      recoveredEntries: expect.arrayContaining([expect.objectContaining({ id: 10 })]),
    }));
    const recoveredEntries = extractor.extractGroupBackfillRange.mock.calls[0][0].recoveredEntries as SessionEntry[];
    expect(recoveredEntries.length).toBeLessThan(50);
    expect(watermarkStore.processed).toEqual([expect.objectContaining({
      startMessageId: 1,
      endMessageId: 50,
      entryCount: 50,
      recordedAt: 9_000,
    })]);
  });

  it('resumes from the stored group-memory watermark', async () => {
    const entries = makeEntries(120);
    entries[79] = makeEntry(80, 'My favorite coffee is cardamom latte.');
    const runner = new GroupMemoryBackfillRunner({
      groupMemory: makeSettings({ maxMessagesPerRun: 50, maxChunksPerRun: 1, maxLlmCallsPerRun: 1 }),
      sessionReader: makeReader(entries),
      watermarkStore: new FakeWatermarkStore(50),
      memoryExtractor: makeExtractor(),
    });

    const result = await runner.run(CHANNEL_ID, {
      mode: 'dry_run',
      startMessageId: 1,
      endMessageId: 120,
    });

    expect(result.chunks[0]).toEqual(expect.objectContaining({
      spanStartMessageId: 51,
      spanEndMessageId: 100,
      candidateSourceMessageIds: expect.arrayContaining([80]),
    }));
  });

  it('skips no-salience live chunks and records resumable skipped spans without extraction', async () => {
    const extractor = makeExtractor();
    const watermarkStore = new FakeWatermarkStore();
    const runner = new GroupMemoryBackfillRunner({
      groupMemory: makeSettings({ maxMessagesPerRun: 50, maxChunksPerRun: 1, maxLlmCallsPerRun: 1 }),
      sessionReader: makeReader(makeEntries(50)),
      watermarkStore,
      memoryExtractor: extractor,
      nowMs: () => 10_000,
    });

    const result = await runner.run(CHANNEL_ID, { mode: 'live' });

    expect(result.status).toBe('completed');
    expect(result.skippedChunkCount).toBe(1);
    expect(result.chunks[0]).toEqual(expect.objectContaining({
      action: 'skipped',
      skipReason: 'no_salient_candidates',
      estimatedLlmCalls: 0,
    }));
    expect(extractor.extractGroupBackfillRange).not.toHaveBeenCalled();
    expect(watermarkStore.skipped).toEqual([expect.objectContaining({
      startMessageId: 1,
      endMessageId: 50,
      reason: 'no_salient_candidates',
      recordedAt: 10_000,
    })]);
  });

  it('rejects explicit command limits that exceed JSON policy ceilings', async () => {
    const runner = new GroupMemoryBackfillRunner({
      groupMemory: makeSettings({ maxMessagesPerRun: 50 }),
      sessionReader: makeReader(makeEntries(60)),
      watermarkStore: new FakeWatermarkStore(),
      memoryExtractor: makeExtractor(),
    });

    await expect(runner.run(CHANNEL_ID, {
      mode: 'dry_run',
      maxMessagesPerRun: 51,
    })).rejects.toThrow('maxMessagesPerRun');
  });
});
