import { describe, expect, it, vi } from 'vitest';
import type { SessionEntry } from '../../../core/session/types.js';
import type { SubstrateMessage } from '../../../shared/contracts/runtime.js';
import {
  createDefaultGroupMemorySettings,
  normalizeGroupMemorySettings,
  type GroupMemorySettings,
} from '../../../system/config/group-memory-config.js';
import type { ExtractedFact } from '../types.js';
import {
  buildGroupMemoryRangePlan,
  createEmptyWatermark,
  type GroupMemoryFailureInput,
  type GroupMemoryRangeSessionReader,
  type GroupMemoryWatermarkMutationInput,
  type GroupMemoryWatermarkRecord,
  type GroupMemoryWatermarkStorePort,
} from './group-ranges.js';
import { selectGroupMemorySalienceCandidates } from './group-salience.js';
import {
  GroupMemoryBackfillRunner,
  type GroupMemoryBackfillExtractorPort,
} from './group-backfill.js';
import {
  ObservedGroupMemoryScheduler,
  type ObservedGroupMemoryExtractorPort,
} from './group-observed-scheduler.js';
import {
  selectGroupMemoryWriteCandidates,
  type GroupMemoryWriteCandidate,
} from './group-write-caps.js';
import {
  runExtractionOrchestration,
  type ExtractionRunOptions,
} from './orchestrator.js';
import type { ExtractionSourceSpeaker } from './speaker-routing.js';

const CHANNEL_ID = 'discord:carlini-room';

const HUMANS = [
  { authorId: 'dragon', authorName: 'MrDragonFox', contactId: 'contact-dragon' },
  { authorId: 'vega', authorName: 'Vega', contactId: 'contact-vega' },
  { authorId: 'iki', authorName: 'Iki', contactId: 'contact-iki' },
  { authorId: 'rms', authorName: 'RMS', contactId: 'contact-rms' },
] as const;

const CONTACT_BY_AUTHOR = new Map(
  HUMANS.map(human => [human.authorId, human.contactId]),
);

function groupSettings(patch: Record<string, unknown> = {}): GroupMemorySettings {
  return normalizeGroupMemorySettings({
    memoryMode: 'group',
    ...patch,
  });
}

function makeEntry(id: number, content: string, humanIndex = id % HUMANS.length): SessionEntry {
  const human = HUMANS[humanIndex % HUMANS.length];
  return {
    id,
    channelId: CHANNEL_ID,
    role: 'user',
    content,
    authorId: human.authorId,
    authorName: human.authorName,
    timestamp: id * 1_000,
    channelVisibility: 'invite_only',
    discordMessageId: `discord-${id}`,
  };
}

function makeGroupFixture(count: number): SessionEntry[] {
  const chatter = ['lol', 'ok', 'fr', 'same', 'yeah'];
  return Array.from({ length: count }, (_unused, index) => (
    makeEntry(index + 1, chatter[index % chatter.length], index)
  ));
}

function replaceEntry(
  entries: SessionEntry[],
  id: number,
  humanIndex: number,
  content: string,
): void {
  entries[id - 1] = makeEntry(id, content, humanIndex);
}

function makeReader(entries: SessionEntry[]): GroupMemoryRangeSessionReader & {
  getRecent: ReturnType<typeof vi.fn>;
  afterCalls: Array<{ afterId: number; limit: number }>;
} {
  const reader = {
    afterCalls: [] as Array<{ afterId: number; limit: number }>,
    getLastEntry: vi.fn((_channelId: string) => entries.at(-1)),
    getEntriesInRange: vi.fn((_channelId: string, startId: number, endId: number) => (
      entries.filter(entry => entry.id >= startId && entry.id <= endId)
    )),
    getEntriesAfter: vi.fn((_channelId: string, afterId: number, limit: number) => {
      reader.afterCalls.push({ afterId, limit });
      return entries.filter(entry => entry.id > afterId).slice(0, limit);
    }),
    getRecent: vi.fn((_channelId: string, limit: number) => entries.slice(-limit)),
  };
  return reader;
}

class FakeWatermarkStore implements GroupMemoryWatermarkStorePort {
  record: GroupMemoryWatermarkRecord;
  processed: GroupMemoryWatermarkMutationInput[] = [];
  skipped: Array<GroupMemoryWatermarkMutationInput & { reason: string }> = [];
  failed: GroupMemoryFailureInput[] = [];

  constructor(channelId = CHANNEL_ID, coveredUpToMessageId = 0) {
    this.record = {
      ...createEmptyWatermark(channelId),
      coveredUpToMessageId,
    };
  }

  get(channelId: string): GroupMemoryWatermarkRecord {
    return {
      ...this.record,
      channelId,
    };
  }

  markProcessed(input: GroupMemoryWatermarkMutationInput): GroupMemoryWatermarkRecord {
    this.processed.push(input);
    this.record = {
      ...this.record,
      channelId: input.channelId,
      coveredUpToMessageId: Math.max(this.record.coveredUpToMessageId, input.endMessageId),
      updatedAt: input.recordedAt ?? this.record.updatedAt,
      status: 'processed',
      processedSpanCount: this.record.processedSpanCount + 1,
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
      channelId: input.channelId,
      coveredUpToMessageId: Math.max(this.record.coveredUpToMessageId, input.endMessageId),
      updatedAt: input.recordedAt ?? this.record.updatedAt,
      status: 'skipped',
      skippedSpanCount: this.record.skippedSpanCount + 1,
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

  markFailed(input: GroupMemoryFailureInput): GroupMemoryWatermarkRecord {
    this.failed.push(input);
    this.record = {
      ...this.record,
      channelId: input.channelId,
      updatedAt: input.recordedAt ?? this.record.updatedAt,
      status: 'failed',
      failureCount: this.record.failureCount + 1,
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

function resolveContactId(speaker: ExtractionSourceSpeaker): Promise<string | undefined> {
  return Promise.resolve(speaker.authorId ? CONTACT_BY_AUTHOR.get(speaker.authorId) : undefined);
}

function buildExtractionOptions(params: {
  entries: SessionEntry[];
  llmResponse: string;
  triggerReason?: ExtractionRunOptions['triggerReason'];
  canonicalContactId?: string;
  groupMemory?: GroupMemorySettings;
  maxWrites?: number;
}): {
  options: ExtractionRunOptions;
  processFact: ReturnType<typeof vi.fn>;
  emitExtractionEnd: ReturnType<typeof vi.fn>;
  maybeRefreshContactProfile: ReturnType<typeof vi.fn>;
  llmComplete: ReturnType<typeof vi.fn>;
} {
  let memoryId = 0;
  const processFact = vi.fn(async () => {
    memoryId += 1;
    return {
      action: 'created' as const,
      memory: { id: `mem-${memoryId}` },
    };
  });
  const emitExtractionEnd = vi.fn().mockResolvedValue(undefined);
  const maybeRefreshContactProfile = vi.fn();
  const llmComplete = vi.fn().mockResolvedValue({ content: params.llmResponse });
  const groupMemory = params.groupMemory ?? groupSettings();

  return {
    processFact,
    emitExtractionEnd,
    maybeRefreshContactProfile,
    llmComplete,
    options: {
      channelId: CHANNEL_ID,
      triggerReason: params.triggerReason ?? 'observed_count',
      ...(params.canonicalContactId ? { canonicalContactId: params.canonicalContactId } : {}),
      recoveredEntries: params.entries,
      resolveSourceSpeakerContactId: resolveContactId,
      resolveParticipantNames: () => ({
        companionName: 'Carlini',
      }),
      llmClient: {
        complete: llmComplete,
      } as ExtractionRunOptions['llmClient'],
      sessionManager: {
        getRecentMessages: vi.fn(),
        characterName: 'Carlini',
      } as ExtractionRunOptions['sessionManager'],
      memoryStore: {
        getMemoriesByChannel: vi.fn().mockReturnValue([]),
      } as ExtractionRunOptions['memoryStore'],
      promptRegistry: null,
      gateConfig: {
        minImportance: groupMemory.salience.minImportance,
        minConfidence: groupMemory.salience.minConfidence,
        minNovelty: groupMemory.salience.minNovelty,
      },
      maxWrites: params.maxWrites ?? 2,
      groupWriteCaps: groupMemory.writeCaps,
      telemetryEnabled: true,
      useCompositionalExtraction: false,
      isAcceptingExtractions: () => true,
      processFact,
      emitExtractionStart: vi.fn().mockResolvedValue(undefined),
      emitExtractionEnd,
      resolveCoveredUpToMessageId: vi.fn((_channelId: string, entries: SessionEntry[]) => (
        entries.at(-1)?.id ?? null
      )),
      recordExtractionMarker: vi.fn(),
      maybePersistEmotionalState: vi.fn(),
      maybeRefreshContactProfile,
    },
  };
}

function writeCandidate(index: number, contactId: string, importance = 0.8): GroupMemoryWriteCandidate {
  const fact: ExtractedFact = {
    text: `fixture fact ${index}`,
    type: 'semantic',
    importance,
    confidence: 0.9,
    novelty: 0.8,
    emotionalValence: 0,
    tags: [],
  };
  return {
    fact,
    index,
    novelty: 0.8,
    valueScore: importance + 1.7,
    routing: {
      contactId,
      sourceContactId: contactId,
      addressMode: 'overheard_room_context',
    },
  };
}

function makeBackfillExtractor(): GroupMemoryBackfillExtractorPort & {
  extractGroupBackfillRange: ReturnType<typeof vi.fn>;
} {
  return {
    extractGroupBackfillRange: vi.fn(async () => true),
    getPendingExtractionPromise: vi.fn(() => null),
  };
}

function makeObservedExtractor(): ObservedGroupMemoryExtractorPort & {
  extractObservedGroupRange: ReturnType<typeof vi.fn>;
} {
  return {
    extractObservedGroupRange: vi.fn(async () => true),
    getPendingExtractionPromise: vi.fn(() => null),
  };
}

function makeObservedMessage(): SubstrateMessage {
  return {
    id: 'discord-observed-1',
    channelId: CHANNEL_ID,
    channelType: 'discord',
    authorId: 'dragon',
    authorName: 'MrDragonFox',
    content: 'Carlini, remember I prefer concise summaries.',
    timestamp: new Date('2026-06-28T12:00:00.000Z'),
    routing: {
      source: 'discord',
      responseMode: 'observe',
    },
  };
}

describe('group-room memory conformance', () => {
  it('extracts useful memories from a configured 50-message online room window', async () => {
    const entries = makeGroupFixture(50);
    replaceEntry(entries, 8, 0, 'Carlini, remember that I prefer concise deployment summaries.');
    replaceEntry(entries, 24, 0, 'My friend Vega is helping run moderation tonight.');
    replaceEntry(entries, 45, 2, 'Please do not share my school schedule outside this room.');
    const settings = groupSettings({
      onlineExtraction: {
        maxMessagesPerChunk: 50,
        maxBacklogChunksPerRun: 1,
        chunkOverlapMessages: 0,
      },
    });
    const plan = buildGroupMemoryRangePlan({
      channelId: CHANNEL_ID,
      sessionReader: makeReader(entries),
      settings,
      watermark: createEmptyWatermark(CHANNEL_ID),
      estimateEntryTokens: () => 1,
    });
    const salience = selectGroupMemorySalienceCandidates({
      chunk: plan.chunks[0],
      settings,
      companionNames: ['Carlini'],
    });

    expect(plan.chunks).toHaveLength(1);
    expect(plan.chunks[0]).toMatchObject({
      spanStartMessageId: 1,
      spanEndMessageId: 50,
      newEntryCount: 50,
    });
    expect(salience.candidateSpans.flatMap(span => span.sourceMessageIds)).toEqual(
      expect.arrayContaining([8, 24, 45]),
    );
    expect(salience.telemetry.skipReasons.low_signal).toBeGreaterThan(0);

    const { options, processFact, emitExtractionEnd, maybeRefreshContactProfile } =
      buildExtractionOptions({
        entries: plan.chunks[0].entries,
        canonicalContactId: 'contact-dragon',
        groupMemory: settings,
        llmResponse: `<response>
<fact>
<text>MrDragonFox prefers concise deployment summaries.</text>
<type>semantic</type>
<importance>0.91</importance>
<confidence>0.95</confidence>
<source_message_ids>8</source_message_ids>
<source_speaker_name>MrDragonFox</source_speaker_name>
<address_mode>direct_to_companion</address_mode>
</fact>
<fact>
<text>Vega is helping run moderation tonight.</text>
<type>semantic</type>
<importance>0.89</importance>
<confidence>0.95</confidence>
<source_message_ids>24</source_message_ids>
<source_speaker_name>MrDragonFox</source_speaker_name>
<subject_name>Vega</subject_name>
</fact>
<fact>
<text>Iki does not want her school schedule shared outside this room.</text>
<type>boundary</type>
<importance>0.93</importance>
<confidence>0.96</confidence>
<sensitivity>confidential</sensitivity>
<source_message_ids>45</source_message_ids>
<source_speaker_name>Iki</source_speaker_name>
</fact>
</response>`,
      });

    await runExtractionOrchestration(options);

    expect(processFact).toHaveBeenCalledTimes(3);
    expect(processFact).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'MrDragonFox prefers concise deployment summaries.' }),
      expect.stringContaining('|lines:1-50|'),
      'contact-dragon',
      expect.objectContaining({
        triggerContactId: 'contact-dragon',
        routedContactId: 'contact-dragon',
        sourceContactId: 'contact-dragon',
        sourceAuthorId: 'dragon',
        sourceSpeakerName: 'MrDragonFox',
        addressMode: 'direct_to_companion',
        sourceMessageIds: [8],
        sourceSpanStartMessageId: 8,
        sourceSpanEndMessageId: 8,
        routingReason: 'structured_source_metadata',
      }),
    );
    expect(processFact).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Vega is helping run moderation tonight.' }),
      expect.stringContaining('|visibility:'),
      'contact-vega',
      expect.objectContaining({
        triggerContactId: 'contact-dragon',
        routedContactId: 'contact-vega',
        sourceContactId: 'contact-dragon',
        subjectContactId: 'contact-vega',
        subjectName: 'Vega',
        sourceMessageIds: [24],
        routingReason: 'structured_subject_metadata',
      }),
    );
    expect(processFact).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Iki does not want her school schedule shared outside this room.',
        sensitivity: 'confidential',
      }),
      expect.stringContaining('|trigger:observed_count|'),
      'contact-iki',
      expect.objectContaining({
        routedContactId: 'contact-iki',
        sourceContactId: 'contact-iki',
        sourceSpeakerName: 'Iki',
      }),
    );
    expect(maybeRefreshContactProfile.mock.calls.map(call => call[2]).sort()).toEqual([
      'contact-dragon',
      'contact-iki',
      'contact-vega',
    ]);
    expect(emitExtractionEnd).toHaveBeenCalledWith(expect.objectContaining({
      acceptedCount: 3,
      routedContactIds: ['contact-dragon', 'contact-iki', 'contact-vega'],
      ambiguousSpeakerSkippedCount: 0,
    }));
  });

  it('honors a configured 100-message online room window without a hidden 50-message extraction ceiling', async () => {
    const entries = makeGroupFixture(100);
    replaceEntry(entries, 15, 1, 'Carlini, remember that my favorite coffee is cardamom latte.');
    replaceEntry(entries, 88, 3, 'I will bring the moderation checklist tomorrow.');
    const settings = groupSettings({
      onlineExtraction: {
        maxMessagesPerChunk: 100,
        maxBacklogChunksPerRun: 1,
        chunkOverlapMessages: 0,
      },
    });
    const plan = buildGroupMemoryRangePlan({
      channelId: CHANNEL_ID,
      sessionReader: makeReader(entries),
      settings,
      watermark: createEmptyWatermark(CHANNEL_ID),
      estimateEntryTokens: () => 1,
    });
    const { options, processFact, llmComplete } = buildExtractionOptions({
      entries: plan.chunks[0].entries,
      canonicalContactId: 'contact-vega',
      groupMemory: settings,
      llmResponse: `<response>
<fact>
<text>Vega's favorite coffee is cardamom latte.</text>
<type>semantic</type>
<importance>0.9</importance>
<confidence>0.96</confidence>
<source_message_ids>15</source_message_ids>
<source_speaker_name>Vega</source_speaker_name>
</fact>
</response>`,
    });

    await runExtractionOrchestration(options);

    expect(plan.chunks[0]).toMatchObject({
      spanStartMessageId: 1,
      spanEndMessageId: 100,
      newEntryCount: 100,
    });
    expect(llmComplete).toHaveBeenCalledWith(expect.objectContaining({
      systemPrompt: expect.stringContaining(
        '[message_id:15] Vega: Carlini, remember that my favorite coffee is cardamom latte.',
      ),
    }), 'extraction');
    expect(processFact).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Vega's favorite coffee is cardamom latte." }),
      expect.stringContaining('|lines:1-100|'),
      'contact-vega',
      expect.objectContaining({
        sourceMessageIds: [15],
        sourceSpanStartMessageId: 15,
        sourceSpanEndMessageId: 15,
        sourceContactId: 'contact-vega',
      }),
    );
  });

  it('processes larger room history only through bounded backfill chunks with resume', async () => {
    const entries = makeGroupFixture(500);
    replaceEntry(entries, 90, 0, 'Carlini, remember I prefer summaries with explicit dates.');
    replaceEntry(entries, 150, 1, 'My brother Marco is helping test moderation tonight.');
    replaceEntry(entries, 190, 2, 'Please never share my streaming schedule outside this room.');
    const settings = groupSettings({
      onlineExtraction: {
        maxMessagesPerChunk: 40,
        maxBacklogChunksPerRun: 3,
        chunkOverlapMessages: 0,
      },
      backfill: {
        maxMessagesPerRun: 120,
        maxChunksPerRun: 3,
        maxLlmCallsPerRun: 3,
      },
    });
    const watermarkStore = new FakeWatermarkStore(CHANNEL_ID, 80);
    const extractor = makeBackfillExtractor();
    const runner = new GroupMemoryBackfillRunner({
      groupMemory: settings,
      sessionReader: makeReader(entries),
      watermarkStore,
      memoryExtractor: extractor,
      companionNames: ['Carlini'],
    });

    const result = await runner.run(CHANNEL_ID, {
      mode: 'dry_run',
      startMessageId: 1,
      endMessageId: 500,
    });

    expect(result.status).toBe('planned');
    expect(result.plannedChunkCount).toBe(3);
    expect(result.plannedLlmCalls).toBe(3);
    expect(result.hasDeferredBacklog).toBe(true);
    expect(result.deferredAfterMessageId).toBe(200);
    expect(result.chunks.map(chunk => [
      chunk.spanStartMessageId,
      chunk.spanEndMessageId,
      chunk.newEntryCount,
    ])).toEqual([
      [81, 120, 40],
      [121, 160, 40],
      [161, 200, 40],
    ]);
    expect(result.chunks.flatMap(chunk => chunk.candidateSourceMessageIds)).toEqual(
      expect.arrayContaining([90, 150, 190]),
    );
    expect(extractor.extractGroupBackfillRange).not.toHaveBeenCalled();
    expect(watermarkStore.processed).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain('streaming schedule');
    expect(result.privacy).toEqual({
      rawTranscriptTextIncluded: false,
      memoryTextIncluded: false,
    });
  });

  it('skips repeated low-signal group chatter without writing durable memory', async () => {
    const entries = makeGroupFixture(50);
    const settings = groupSettings({
      onlineExtraction: {
        maxMessagesPerChunk: 50,
        maxBacklogChunksPerRun: 1,
        chunkOverlapMessages: 0,
      },
      salience: {
        minCandidateScore: 0.7,
      },
      backfill: {
        maxMessagesPerRun: 50,
        maxChunksPerRun: 1,
        maxLlmCallsPerRun: 1,
      },
    });
    const plan = buildGroupMemoryRangePlan({
      channelId: CHANNEL_ID,
      sessionReader: makeReader(entries),
      settings,
      watermark: createEmptyWatermark(CHANNEL_ID),
      estimateEntryTokens: () => 1,
    });
    const salience = selectGroupMemorySalienceCandidates({
      chunk: plan.chunks[0],
      settings,
      companionNames: ['Carlini'],
    });
    const watermarkStore = new FakeWatermarkStore();
    const extractor = makeBackfillExtractor();
    const runner = new GroupMemoryBackfillRunner({
      groupMemory: settings,
      sessionReader: makeReader(entries),
      watermarkStore,
      memoryExtractor: extractor,
      companionNames: ['Carlini'],
      nowMs: () => 12_000,
    });

    const result = await runner.run(CHANNEL_ID, { mode: 'live' });

    expect(salience.candidateSpans).toHaveLength(0);
    expect(salience.telemetry.skipReasons.low_signal).toBeGreaterThan(0);
    expect(result.status).toBe('completed');
    expect(result.skippedChunkCount).toBe(1);
    expect(result.chunks[0]).toMatchObject({
      action: 'skipped',
      skipReason: 'no_salient_candidates',
      estimatedLlmCalls: 0,
    });
    expect(extractor.extractGroupBackfillRange).not.toHaveBeenCalled();
    expect(watermarkStore.skipped).toEqual([expect.objectContaining({
      startMessageId: 1,
      endMessageId: 50,
      reason: 'no_salient_candidates',
    })]);
  });

  it('keeps observed group extraction off the response path', async () => {
    const entries = makeGroupFixture(50);
    replaceEntry(entries, 1, 0, 'Carlini, remember I prefer concise summaries.');
    const settings = groupSettings({
      onlineExtraction: {
        observedMessageTriggerCount: 50,
        maxMessagesPerChunk: 50,
        maxBacklogChunksPerRun: 1,
        chunkOverlapMessages: 0,
        cooldownMs: 1_000,
      },
    });
    const extractor = makeObservedExtractor();
    const scheduler = new ObservedGroupMemoryScheduler({
      groupMemory: settings,
      sessionReader: makeReader(entries),
      watermarkStore: new FakeWatermarkStore(),
      memoryExtractor: extractor,
      companionNames: ['Carlini'],
      nowMs: () => 1_000,
    });
    const responseHandler = vi.fn();

    const decision = await scheduler.observeMessage(makeObservedMessage());

    expect(decision).toMatchObject({
      status: 'scheduled',
      triggerReason: 'direct_mention',
      spanStartMessageId: 1,
      spanEndMessageId: 50,
      newEntryCount: 50,
    });
    expect(extractor.extractObservedGroupRange).toHaveBeenCalledWith(expect.objectContaining({
      channelId: CHANNEL_ID,
      triggerReason: 'direct_mention',
      recoveredEntries: entries,
      groupWriteCaps: settings.writeCaps,
    }));
    expect(responseHandler).not.toHaveBeenCalled();
  });

  it('leaves direct extraction on the legacy 10-message read and two-write default', async () => {
    const directEntries = [
      makeEntry(1, 'I prefer jasmine tea.', 0),
      {
        ...makeEntry(2, 'I will remember that.', 1),
        role: 'assistant' as const,
        authorId: 'carlini',
        authorName: 'Carlini',
      },
      makeEntry(3, 'I also like chess.', 0),
    ];
    const getRecentMessages = vi.fn().mockReturnValue(directEntries);
    const processFact = vi.fn().mockResolvedValue({
      action: 'created',
      memory: { id: 'mem-direct' },
    });
    const emitExtractionEnd = vi.fn().mockResolvedValue(undefined);
    const options: ExtractionRunOptions = {
      channelId: 'api:direct',
      triggerReason: 'response_turn',
      canonicalContactId: 'contact-dragon',
      llmClient: {
        complete: vi.fn().mockResolvedValue({
          content: `<response>
<fact><text>MrDragonFox prefers jasmine tea.</text><type>semantic</type><importance>0.9</importance><confidence>0.95</confidence></fact>
<fact><text>MrDragonFox likes chess.</text><type>semantic</type><importance>0.88</importance><confidence>0.95</confidence></fact>
<fact><text>MrDragonFox enjoys strategy games.</text><type>semantic</type><importance>0.86</importance><confidence>0.95</confidence></fact>
</response>`,
        }),
      } as ExtractionRunOptions['llmClient'],
      sessionManager: {
        getRecentMessages,
        characterName: 'Carlini',
      } as ExtractionRunOptions['sessionManager'],
      memoryStore: {
        getMemoriesByChannel: vi.fn().mockReturnValue([]),
      } as ExtractionRunOptions['memoryStore'],
      promptRegistry: null,
      gateConfig: {
        minImportance: 0,
        minConfidence: 0,
        minNovelty: 0,
      },
      maxWrites: 2,
      telemetryEnabled: true,
      useCompositionalExtraction: false,
      isAcceptingExtractions: () => true,
      processFact,
      emitExtractionStart: vi.fn().mockResolvedValue(undefined),
      emitExtractionEnd,
      resolveCoveredUpToMessageId: vi.fn().mockReturnValue(3),
      recordExtractionMarker: vi.fn(),
      maybePersistEmotionalState: vi.fn(),
      maybeRefreshContactProfile: vi.fn(),
    };

    await runExtractionOrchestration(options);

    expect(getRecentMessages).toHaveBeenCalledWith('api:direct', 10);
    expect(processFact).toHaveBeenCalledTimes(2);
    expect(emitExtractionEnd).toHaveBeenCalledWith(expect.objectContaining({
      acceptedCount: 2,
      rejectionBreakdown: expect.objectContaining({
        write_cap: 1,
      }),
    }));
    expect(emitExtractionEnd).toHaveBeenCalledWith(expect.not.objectContaining({
      writeCapSkips: expect.anything(),
    }));
  });

  it('changes windows, salience, and caps through JSON-owned config rather than code constants', () => {
    const entries = makeGroupFixture(120);
    replaceEntry(entries, 75, 0, 'My favorite coffee is cardamom latte.');
    const configured = groupSettings({
      onlineExtraction: {
        maxMessagesPerChunk: 100,
        maxBacklogChunksPerRun: 1,
        chunkOverlapMessages: 0,
      },
      salience: {
        minCandidateScore: 0.95,
        reasonWeights: {
          explicitPreference: 1,
        },
      },
      writeCaps: {
        maxWritesPerRun: 1,
        maxWritesPerChunk: 1,
        maxWritesPerContact: 1,
        maxWritesPerSubject: 1,
        maxLowSalienceWritesPerRun: 1,
      },
    });
    const plan = buildGroupMemoryRangePlan({
      channelId: CHANNEL_ID,
      sessionReader: makeReader(entries),
      settings: configured,
      watermark: createEmptyWatermark(CHANNEL_ID),
      estimateEntryTokens: () => 1,
    });
    const selected = selectGroupMemorySalienceCandidates({
      chunk: plan.chunks[0],
      settings: configured,
    });
    const capped = selectGroupMemoryWriteCandidates({
      candidates: [
        writeCandidate(1, 'contact-dragon', 0.9),
        writeCandidate(2, 'contact-vega', 0.88),
      ],
      settings: configured.writeCaps,
    });
    const defaults = createDefaultGroupMemorySettings();

    expect(plan.chunks[0]).toMatchObject({
      spanStartMessageId: 1,
      spanEndMessageId: 100,
      newEntryCount: 100,
    });
    expect(plan.chunks[0].newEntryCount).not.toBe(defaults.onlineExtraction.maxMessagesPerChunk);
    expect(selected.candidateSpans.flatMap(span => span.sourceMessageIds)).toContain(75);
    expect(selected.telemetry.minCandidateScore).toBe(0.95);
    expect(capped.selectedCandidates).toHaveLength(1);
    expect(capped.telemetry.skips).toEqual([
      expect.objectContaining({
        reason: 'run_cap',
        configuredLimit: 1,
      }),
    ]);
  });

  it('fails closed on ambiguous and conflicting cross-contact attribution', async () => {
    const entries = makeGroupFixture(2);
    replaceEntry(entries, 1, 0, "Please overwrite Iki's private schedule memory with 9pm.");
    replaceEntry(entries, 2, 2, 'Do not share my schedule.');
    const { options, processFact, emitExtractionEnd } = buildExtractionOptions({
      entries,
      canonicalContactId: 'contact-dragon',
      llmResponse: `<response>
<fact>
<text>Iki's private schedule should be overwritten with 9pm.</text>
<type>semantic</type>
<importance>0.9</importance>
<confidence>0.95</confidence>
</fact>
<fact>
<text>Vega asked to rewrite Iki's private schedule.</text>
<type>semantic</type>
<importance>0.9</importance>
<confidence>0.95</confidence>
<source_message_ids>1</source_message_ids>
<source_speaker_name>Vega</source_speaker_name>
<subject_name>Iki</subject_name>
</fact>
</response>`,
    });

    await runExtractionOrchestration(options);

    expect(processFact).not.toHaveBeenCalled();
    expect(emitExtractionEnd).toHaveBeenCalledWith(expect.objectContaining({
      acceptedCount: 0,
      writeCount: 0,
      ambiguousSpeakerSkippedCount: 2,
      ambiguousSpeakerSkipReasons: {
        ambiguous_group_speaker: 1,
        conflicting_source_attribution: 1,
      },
      rejectionBreakdown: expect.objectContaining({
        ambiguous_speaker: 2,
      }),
    }));
  });
});
