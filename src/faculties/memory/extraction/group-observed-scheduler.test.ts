import { describe, expect, it, vi } from 'vitest';
import type { SubstrateMessage } from '../../../shared/contracts/runtime.js';
import type { SessionEntry } from '../../../core/session/types.js';
import {
  createDefaultGroupMemorySettings,
  type GroupMemorySettings,
} from '../../../system/config/group-memory-config.js';
import {
  createEmptyWatermark,
  type GroupMemoryWatermarkMutationInput,
  type GroupMemoryWatermarkRecord,
  type GroupMemoryWatermarkStorePort,
  type GroupMemoryFailureInput,
} from './group-ranges.js';
import {
  ObservedGroupMemoryScheduler,
  type ObservedGroupMemoryExtractorPort,
} from './group-observed-scheduler.js';

function makeEntry(id: number, overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    id,
    channelId: 'discord-room',
    role: 'user',
    content: `chatter ${id}`,
    authorId: `user-${id % 3}`,
    authorName: `User ${id % 3}`,
    timestamp: id * 1_000,
    ...overrides,
  };
}

function makeMessage(overrides: Partial<SubstrateMessage> = {}): SubstrateMessage {
  return {
    id: 'discord-message-1',
    channelId: 'discord-room',
    channelType: 'discord',
    authorId: 'user-1',
    authorName: 'User One',
    content: 'hello',
    timestamp: new Date('2026-06-28T00:00:00.000Z'),
    routing: {
      source: 'discord',
      responseMode: 'observe',
    },
    ...overrides,
  };
}

function settings(overrides: {
  onlineExtraction?: Partial<GroupMemorySettings['onlineExtraction']>;
  salience?: Partial<GroupMemorySettings['salience']>;
} = {}): GroupMemorySettings {
  const defaults = createDefaultGroupMemorySettings();
  return {
    ...defaults,
    memoryMode: 'group',
    onlineExtraction: {
      ...defaults.onlineExtraction,
      observedMessageTriggerCount: 2,
      observedTimeTriggerMs: 60_000,
      maxMessagesPerChunk: 2,
      maxEstimatedTokensPerChunk: 10_000,
      chunkOverlapMessages: 0,
      cooldownMs: 5_000,
      backlogLagTriggerMessages: 100,
      maxBacklogChunksPerRun: 1,
      ...(overrides.onlineExtraction ?? {}),
    },
    salience: {
      ...defaults.salience,
      minCandidateScore: 10,
      maxCandidateSpansPerChunk: 8,
      neighboringContextMessages: 0,
      ...(overrides.salience ?? {}),
    },
  };
}

function makeReader(entries: SessionEntry[]) {
  const reader = {
    recentCalls: [] as Array<{ channelId: string; limit: number }>,
    afterCalls: [] as Array<{ channelId: string; afterId: number; limit: number }>,
    rangeCalls: [] as Array<{ channelId: string; startId: number; endId: number }>,
    getRecent: vi.fn((channelId: string, limit: number) => {
      reader.recentCalls.push({ channelId, limit });
      return entries.slice(-limit);
    }),
    getLastEntry: vi.fn(() => entries.at(-1)),
    getEntriesAfter: vi.fn((channelId: string, afterId: number, limit: number) => {
      reader.afterCalls.push({ channelId, afterId, limit });
      return entries
        .filter(entry => entry.id > afterId)
        .slice(0, limit);
    }),
    getEntriesInRange: vi.fn((channelId: string, startId: number, endId: number) => {
      reader.rangeCalls.push({ channelId, startId, endId });
      return entries.filter(entry => entry.id >= startId && entry.id <= endId);
    }),
  };
  return reader;
}

function makeWatermarkStore(initialCovered = 0): GroupMemoryWatermarkStorePort & {
  processed: GroupMemoryWatermarkMutationInput[];
  failed: GroupMemoryFailureInput[];
} {
  let current: GroupMemoryWatermarkRecord = {
    ...createEmptyWatermark('discord-room'),
    coveredUpToMessageId: initialCovered,
  };
  const store = {
    processed: [] as GroupMemoryWatermarkMutationInput[],
    failed: [] as GroupMemoryFailureInput[],
    get: vi.fn((channelId: string) => ({
      ...current,
      channelId,
    })),
    markProcessed: vi.fn((input: GroupMemoryWatermarkMutationInput) => {
      store.processed.push(input);
      current = {
        ...current,
        channelId: input.channelId,
        coveredUpToMessageId: Math.max(current.coveredUpToMessageId, input.endMessageId),
        updatedAt: input.recordedAt ?? current.updatedAt,
        status: 'processed',
        processedSpanCount: current.processedSpanCount + 1,
        lastProcessedSpan: {
          startMessageId: input.startMessageId,
          endMessageId: input.endMessageId,
          entryCount: input.entryCount,
          recordedAt: input.recordedAt ?? 0,
        },
      };
      return current;
    }),
    markSkipped: vi.fn((input: GroupMemoryWatermarkMutationInput & { reason: string }) => {
      current = {
        ...current,
        channelId: input.channelId,
        coveredUpToMessageId: Math.max(current.coveredUpToMessageId, input.endMessageId),
        updatedAt: input.recordedAt ?? current.updatedAt,
        status: 'skipped',
        skippedSpanCount: current.skippedSpanCount + 1,
        lastSkippedSpan: {
          startMessageId: input.startMessageId,
          endMessageId: input.endMessageId,
          entryCount: input.entryCount,
          recordedAt: input.recordedAt ?? 0,
          reason: input.reason,
        },
      };
      return current;
    }),
    markFailed: vi.fn((input: GroupMemoryFailureInput) => {
      store.failed.push(input);
      current = {
        ...current,
        channelId: input.channelId,
        updatedAt: input.recordedAt ?? current.updatedAt,
        status: 'failed',
        failureCount: current.failureCount + 1,
        lastFailure: {
          startMessageId: input.startMessageId,
          endMessageId: input.endMessageId,
          entryCount: input.entryCount,
          recordedAt: input.recordedAt ?? 0,
          error: input.error,
          retryCount: 1,
        },
      };
      return current;
    }),
  };
  return store;
}

function makeExtractor(): ObservedGroupMemoryExtractorPort & {
  extractObservedGroupRange: ReturnType<typeof vi.fn>;
} {
  return {
    extractObservedGroupRange: vi.fn(async () => true),
    getPendingExtractionPromise: vi.fn(() => null),
  };
}

describe('observed group memory scheduler', () => {
  it('schedules observed extraction from configured message-count thresholds', async () => {
    const entries = [makeEntry(1), makeEntry(2)];
    const reader = makeReader(entries);
    const watermarkStore = makeWatermarkStore();
    const extractor = makeExtractor();
    const scheduler = new ObservedGroupMemoryScheduler({
      groupMemory: settings(),
      sessionReader: reader,
      watermarkStore,
      memoryExtractor: extractor,
      nowMs: () => 1_000,
    });

    const decision = await scheduler.observeMessage(makeMessage());

    expect(decision).toMatchObject({
      status: 'scheduled',
      triggerReason: 'observed_count',
      spanStartMessageId: 1,
      spanEndMessageId: 2,
      newEntryCount: 2,
    });
    expect(reader.recentCalls).toEqual([{ channelId: 'discord-room', limit: 75 }]);
    expect(reader.afterCalls).toEqual([{ channelId: 'discord-room', afterId: 0, limit: 3 }]);
    expect(extractor.extractObservedGroupRange).toHaveBeenCalledWith(expect.objectContaining({
      channelId: 'discord-room',
      triggerReason: 'observed_count',
      recoveredEntries: entries,
    }));
    expect(watermarkStore.processed).toHaveLength(1);
  });

  it('honors non-default configured count and chunk sizes without code changes', async () => {
    const entries = [makeEntry(1), makeEntry(2)];
    const underThreshold = new ObservedGroupMemoryScheduler({
      groupMemory: settings({
        onlineExtraction: {
          observedMessageTriggerCount: 3,
          maxMessagesPerChunk: 1,
          maxBacklogChunksPerRun: 1,
        },
      }),
      sessionReader: makeReader(entries),
      watermarkStore: makeWatermarkStore(),
      memoryExtractor: makeExtractor(),
      nowMs: () => 1_000,
    });

    await expect(underThreshold.observeMessage(makeMessage())).resolves.toMatchObject({
      status: 'skipped',
      reason: 'threshold_not_met',
    });

    const reader = makeReader(entries);
    const configuredThreshold = new ObservedGroupMemoryScheduler({
      groupMemory: settings({
        onlineExtraction: {
          observedMessageTriggerCount: 2,
          maxMessagesPerChunk: 1,
          maxBacklogChunksPerRun: 1,
        },
      }),
      sessionReader: reader,
      watermarkStore: makeWatermarkStore(),
      memoryExtractor: makeExtractor(),
      nowMs: () => 1_000,
    });

    await expect(configuredThreshold.observeMessage(makeMessage())).resolves.toMatchObject({
      status: 'scheduled',
      triggerReason: 'observed_count',
      spanStartMessageId: 1,
      spanEndMessageId: 1,
      newEntryCount: 1,
      hasDeferredBacklog: true,
    });
    expect(reader.afterCalls).toEqual([{ channelId: 'discord-room', afterId: 0, limit: 2 }]);
  });

  it('schedules time-triggered extraction using the configured observed time threshold', async () => {
    const entries = [makeEntry(1)];
    const reader = makeReader(entries);
    const extractor = makeExtractor();
    let now = 1_000;
    const scheduler = new ObservedGroupMemoryScheduler({
      groupMemory: settings({
        onlineExtraction: {
          observedMessageTriggerCount: 99,
          observedTimeTriggerMs: 1_000,
        },
      }),
      sessionReader: reader,
      watermarkStore: makeWatermarkStore(),
      memoryExtractor: extractor,
      nowMs: () => now,
    });

    await expect(scheduler.observeMessage(makeMessage())).resolves.toMatchObject({
      status: 'skipped',
      reason: 'threshold_not_met',
    });

    now = 2_100;
    await expect(scheduler.observeMessage(makeMessage())).resolves.toMatchObject({
      status: 'scheduled',
      triggerReason: 'observed_time',
    });
  });

  it('uses direct mentions and high-salience signals as separate trigger reasons', async () => {
    const directMentionScheduler = new ObservedGroupMemoryScheduler({
      groupMemory: settings({
        onlineExtraction: { observedMessageTriggerCount: 99 },
        salience: { minCandidateScore: 0.7 },
      }),
      sessionReader: makeReader([
        makeEntry(1, { content: 'Carlini, remember I prefer short updates.' }),
      ]),
      watermarkStore: makeWatermarkStore(),
      memoryExtractor: makeExtractor(),
      companionNames: ['Carlini'],
      nowMs: () => 1_000,
    });
    await expect(directMentionScheduler.observeMessage(makeMessage())).resolves.toMatchObject({
      status: 'scheduled',
      triggerReason: 'direct_mention',
    });

    const highSalienceScheduler = new ObservedGroupMemoryScheduler({
      groupMemory: settings({
        onlineExtraction: { observedMessageTriggerCount: 99 },
        salience: { minCandidateScore: 0.7 },
      }),
      sessionReader: makeReader([
        makeEntry(1, { content: 'My favorite coffee is a cardamom latte.' }),
      ]),
      watermarkStore: makeWatermarkStore(),
      memoryExtractor: makeExtractor(),
      companionNames: ['Carlini'],
      nowMs: () => 1_000,
    });
    await expect(highSalienceScheduler.observeMessage(makeMessage())).resolves.toMatchObject({
      status: 'scheduled',
      triggerReason: 'high_salience',
    });
  });

  it('applies configured cooldowns without dropping backlog state', async () => {
    const entries = [makeEntry(1), makeEntry(2)];
    const reader = makeReader(entries);
    const extractor = makeExtractor();
    const watermarkStore = makeWatermarkStore();
    let now = 1_000;
    const scheduler = new ObservedGroupMemoryScheduler({
      groupMemory: settings({
        onlineExtraction: {
          observedMessageTriggerCount: 2,
          cooldownMs: 5_000,
        },
      }),
      sessionReader: reader,
      watermarkStore,
      memoryExtractor: extractor,
      nowMs: () => now,
    });

    await expect(scheduler.observeMessage(makeMessage())).resolves.toMatchObject({
      status: 'scheduled',
      triggerReason: 'observed_count',
    });

    entries.push(makeEntry(3), makeEntry(4));
    now = 2_000;
    await expect(scheduler.observeMessage(makeMessage({ id: 'discord-message-2' }))).resolves.toMatchObject({
      status: 'skipped',
      reason: 'cooldown',
      cooldownRemainingMs: 4_000,
    });
    expect(extractor.extractObservedGroupRange).toHaveBeenCalledTimes(1);
    expect(watermarkStore.processed).toHaveLength(1);
  });

  it('does not advance the watermark when the extractor rejects a job', async () => {
    const entries = [makeEntry(1), makeEntry(2)];
    const watermarkStore = makeWatermarkStore();
    const extractor: ObservedGroupMemoryExtractorPort = {
      extractObservedGroupRange: vi.fn(async () => false),
      getPendingExtractionPromise: vi.fn(() => null),
    };
    const scheduler = new ObservedGroupMemoryScheduler({
      groupMemory: settings(),
      sessionReader: makeReader(entries),
      watermarkStore,
      memoryExtractor: extractor,
      nowMs: () => 1_000,
    });

    await expect(scheduler.observeMessage(makeMessage())).resolves.toMatchObject({
      status: 'skipped',
      reason: 'extractor_rejected',
    });
    expect(watermarkStore.processed).toHaveLength(0);
  });
});
