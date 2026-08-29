import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionEntry } from '../../../core/session/types.js';
import type {
  ConversationalActivityWorkItem,
  ConversationalActivityWorksetPort,
} from '../../../core/session/conversational-activity-workset.js';
import type { EpisodeSynthesisLaneConfig } from '../../../system/config/scheduler-config.js';
import {
  EpisodeSynthesisLane,
  EPISODE_SYNTHESIS_ACTION_KIND,
  type EpisodeSynthesisGateEvent,
} from './synthesis-lane.js';
import { collectDisclosureMemorySources } from '../retrieval/active-context-refresh.js';
import type { ScoredMemory } from '../retrieval/types.js';
import type { PurrMemory, MemoryProvenance } from '../types.js';
import {
  resetRuntimeChannelClassificationEpochs,
  setRuntimeChannelClassificationEpochs,
} from '../../../system/trust/runtime-classification-epochs.js';
import { DEMOTION_EPOCH_NOTICE_VERSION } from '../../../system/trust/context-envelope.js';
import { destinationEpochEligible } from '../../../core/cogsec/disclosure/decision.js';
import type { DisclosureDestinationConstraint } from '../../../core/cogsec/disclosure/contracts.js';
import {
  clearDiagnosticLogRingBufferForTests,
  getRecentDiagnosticLogRecords,
} from '../../../shared/logger.js';

function synthMemory(provenance: MemoryProvenance, extractedAt: number): ScoredMemory {
  const memory: PurrMemory = {
    id: 'mem-synth', text: 'synthetic', type: 'reflection',
    importance: 0.6, confidence: 0.8, emotionalValence: 0, salience: 0.6,
    sourceRef: 'source:test', extractedAt, lastAccessed: extractedAt, accessCount: 0,
    tags: [], sensitivity: 'public', provenance,
  };
  return { memory } as unknown as ScoredMemory;
}

const COMPANION_NAME = 'Companion';
const COMPANION_AUTHOR_ID = 'bot-companion-1';
const WATERMARK_END_MS = Date.parse('2026-06-01T10:00:00.000Z');

function gateConfig(overrides: Partial<EpisodeSynthesisLaneConfig> = {}): EpisodeSynthesisLaneConfig {
  return {
    daytimeSlots: ['09:00', '12:00', '15:00', '18:00'],
    timezone: 'local',
    turnThreshold: 24,
    minRelevantTurns: 10,
    transcriptMessageLimit: 96,
    maxEpisodesPerRun: 6,
    gapSplitMinutes: 45,
    maxEntriesPerEpisode: 14,
    minConversationalEntries: 2,
    minSingleEntryChars: 120,
    ...overrides,
  };
}

function makeEntry(overrides: Partial<SessionEntry> & { id: number }): SessionEntry {
  return {
    channelId: 'discord:room-1',
    role: 'user',
    content: 'just chatting about the weekend plans',
    authorId: 'user-a',
    authorName: 'Alice',
    timestamp: WATERMARK_END_MS + overrides.id * 60_000,
    ...overrides,
  } as SessionEntry;
}

function bystanderEntries(count: number, startId = 1): SessionEntry[] {
  return Array.from({ length: count }, (_, index) => makeEntry({
    id: startId + index,
    authorId: index % 2 === 0 ? 'user-a' : 'user-b',
    authorName: index % 2 === 0 ? 'Alice' : 'Bob',
    content: index % 2 === 0
      ? 'did you watch the game last night bob'
      : 'yeah alice the overtime was wild',
  }));
}

function mentionEntries(count: number, startId = 1): SessionEntry[] {
  return Array.from({ length: count }, (_, index) => makeEntry({
    id: startId + index,
    content: `hey ${COMPANION_NAME}, what do you think about topic ${index}?`,
  }));
}

function makeStatefulWorkset(sessionIds: readonly string[]): ConversationalActivityWorksetPort {
  const items = sessionIds.map((logicalSessionId, index): ConversationalActivityWorkItem => ({
    purpose: 'episodic_synthesis',
    logicalSessionId,
    revision: index + 1,
    activityKind: 'direct_message',
    checkpointRevision: 0,
  }));
  const checkpoints = new Map<string, number>();
  const claims = new Map<string, { claimantId: string; claimedAtMs: number; revision: number }>();
  return {
    enumerate: vi.fn(async () => items
      .filter(item => item.revision > (checkpoints.get(item.logicalSessionId) ?? 0))
      .map(item => ({
        ...item,
        checkpointRevision: checkpoints.get(item.logicalSessionId) ?? 0,
        ...(claims.get(item.logicalSessionId) ?? {}),
      }))),
    claim: vi.fn(async (input) => {
      const item = items.find(candidate => candidate.logicalSessionId === input.logicalSessionId);
      const activeClaim = claims.get(input.logicalSessionId);
      if (
        !item
        || item.revision !== input.revision
        || item.revision <= (checkpoints.get(item.logicalSessionId) ?? 0)
        || activeClaim
      ) {
        return null;
      }
      const claim = {
        claimantId: input.claimantId,
        claimedAtMs: WATERMARK_END_MS,
        revision: input.revision,
      };
      claims.set(input.logicalSessionId, claim);
      return {
        ...item,
        checkpointRevision: checkpoints.get(item.logicalSessionId) ?? 0,
        ...claim,
      };
    }),
    resumeClaim: vi.fn(async (input) => {
      const item = items.find(candidate => candidate.logicalSessionId === input.logicalSessionId);
      const claim = claims.get(input.logicalSessionId);
      if (!item || !claim || claim.claimantId !== input.claimantId) return null;
      return {
        ...item,
        checkpointRevision: checkpoints.get(item.logicalSessionId) ?? 0,
        ...claim,
      };
    }),
    checkpoint: vi.fn(async (input) => {
      const claim = claims.get(input.logicalSessionId);
      if (!claim || claim.claimantId !== input.claimantId || claim.revision !== input.revision) {
        throw new Error('checkpoint does not match claim');
      }
      checkpoints.set(input.logicalSessionId, input.revision);
      claims.delete(input.logicalSessionId);
    }),
  };
}

function makeHarness(options: {
  entries?: SessionEntry[];
  watermarkEndedAt?: string | null;
  scope?: 'direct' | 'group';
  config?: EpisodeSynthesisLaneConfig;
  memoryWriter?: { write: ReturnType<typeof vi.fn> };
  now?: () => number;
} = {}) {
  const entriesRef = { current: options.entries ?? [] };
  const sessionManager = {
    resolveSessionChannelId: vi.fn((channelId: string) => channelId),
    getRecentMessages: vi.fn(() => entriesRef.current),
    listRecentSessions: vi.fn().mockReturnValue([
      {
        channelId: 'discord:room-1',
        channelType: 'discord',
        messageCount: 10,
        lastActivityAt: WATERMARK_END_MS,
        lastRole: 'user',
      },
    ]),
  };
  const synthesizer = {
    run: vi.fn().mockResolvedValue({
      consideredEntries: 0,
      candidateEpisodeCount: 1,
      createdEpisodes: [],
      skippedEpisodeIds: [],
      linkedArcs: [],
    }),
  };
  const watermarkStore = {
    getProcessingWatermark: vi.fn(async () => (
      options.watermarkEndedAt === null
        ? undefined
        : {
          id: 'watermark-1',
          processor: 'episodic_synthesis',
          sourceRef: 'discord:room-1',
          processedEndedAt: options.watermarkEndedAt
            ?? new Date(WATERMARK_END_MS).toISOString(),
          updatedAt: new Date(WATERMARK_END_MS).toISOString(),
        }
    )),
  };
  const scopeClassifier = {
    classifyChannelMemoryScope: vi.fn(async () => options.scope ?? 'group'),
  };
  const workset = {
    enumerate: vi.fn(async () => {
      const sourceChannelId = entriesRef.current[0]?.channelId ?? 'discord:room-1';
      const logicalSessionId = sessionManager.resolveSessionChannelId(sourceChannelId);
      return [{
        purpose: 'episodic_synthesis' as const,
        logicalSessionId,
        revision: entriesRef.current.at(-1)?.id ?? 1,
        activityKind: logicalSessionId.startsWith('internal:free-time:')
          ? 'experiential_free_time' as const
          : options.scope === 'direct'
            ? 'direct_message' as const
            : 'group_conversation' as const,
        checkpointRevision: 0,
      }];
    }),
    claim: vi.fn(async (input: {
      purpose: 'episodic_synthesis';
      logicalSessionId: string;
      revision: number;
      claimantId: string;
    }) => ({
      ...input,
      activityKind: input.logicalSessionId.startsWith('internal:free-time:')
        ? 'experiential_free_time' as const
        : options.scope === 'direct'
          ? 'direct_message' as const
          : 'group_conversation' as const,
      checkpointRevision: 0,
      claimedAtMs: WATERMARK_END_MS,
    })),
    resumeClaim: vi.fn(),
    checkpoint: vi.fn().mockResolvedValue(undefined),
  };
  const gateEvents: EpisodeSynthesisGateEvent[] = [];
  const lane = new EpisodeSynthesisLane({
    sessionManager,
    synthesizer,
    watermarkStore: watermarkStore as never,
    workset,
    config: options.config ?? gateConfig(),
    scopeClassifier,
    companionNames: [COMPANION_NAME],
    companionAuthorIds: [COMPANION_AUTHOR_ID],
    ...(options.memoryWriter ? { memoryWriter: options.memoryWriter } : {}),
    onGateEvent: (event) => { gateEvents.push(event); },
    ...(options.now ? { now: options.now } : {}),
  });
  return { lane, entriesRef, sessionManager, synthesizer, watermarkStore, workset, scopeClassifier, gateEvents };
}

function timerAction() {
  return {
    id: 'gate-action-1',
    channelId: 'discord:room-1',
    sourceMessageId: 'timer-1',
    payload: {
      sessionId: 'discord:room-1',
      sourceChannelId: 'discord:room-1',
      trigger: 'timer',
      channelType: 'discord',
    },
  };
}

describe('EpisodeSynthesisLane', () => {
  beforeEach(() => {
    clearDiagnosticLogRingBufferForTests();
  });

  it('fails closed on invalid gate config', () => {
    expect(() => makeHarness({ config: gateConfig({ minRelevantTurns: 0 }) })).toThrow(
      'config.minRelevantTurns must be an integer >= 1',
    );
    expect(() => makeHarness({ config: gateConfig({ turnThreshold: 0 }) })).toThrow(
      'config.turnThreshold must be an integer >= 1',
    );
  });

  it('Gate 1: timer fire with no new messages performs zero synthesis work', async () => {
    // All entries predate the processing watermark.
    const staleEntries = mentionEntries(12).map(entry => ({
      ...entry,
      timestamp: WATERMARK_END_MS - entry.id * 60_000,
    }));
    const harness = makeHarness({ entries: staleEntries });

    await harness.lane.execute(timerAction());

    expect(harness.synthesizer.run).not.toHaveBeenCalled();
    expect(harness.scopeClassifier.classifyChannelMemoryScope).not.toHaveBeenCalled();
    expect(harness.gateEvents).toHaveLength(1);
    expect(harness.gateEvents[0]).toMatchObject({
      sessionId: 'discord:room-1',
      trigger: 'timer',
      outcome: 'skipped',
      reason: 'no_new_messages',
      newEntryCount: 0,
      minRelevantTurns: 10,
    });
    expect(getRecentDiagnosticLogRecords()[0]?.message).toContain('no new messages');
  });

  it('drains every changed session sequentially and checkpoints each success', async () => {
    const workItems = Array.from({ length: 25 }, (_, index) => ({
      purpose: 'episodic_synthesis' as const,
      logicalSessionId: `discord:drain-${String(index).padStart(2, '0')}`,
      revision: index + 1,
      activityKind: 'direct_message' as const,
      checkpointRevision: 0,
    }));
    const workset = {
      enumerate: vi.fn().mockResolvedValue(workItems),
      claim: vi.fn(async (input: {
        purpose: 'episodic_synthesis';
        logicalSessionId: string;
        revision: number;
        claimantId: string;
      }) => ({
        ...workItems.find(item => item.logicalSessionId === input.logicalSessionId)!,
        claimantId: input.claimantId,
        claimedAtMs: WATERMARK_END_MS,
      })),
      resumeClaim: vi.fn(),
      checkpoint: vi.fn().mockResolvedValue(undefined),
    };
    const active = { current: 0, maximum: 0 };
    const harness = makeHarness({ entries: mentionEntries(12) });
    harness.synthesizer.run.mockImplementation(async () => {
      active.current += 1;
      active.maximum = Math.max(active.maximum, active.current);
      await Promise.resolve();
      active.current -= 1;
      return {
        consideredEntries: 12,
        candidateEpisodeCount: 1,
        createdEpisodes: [],
        skippedEpisodeIds: [],
        linkedArcs: [],
      };
    });
    const lane = new EpisodeSynthesisLane({
      sessionManager: harness.sessionManager,
      synthesizer: harness.synthesizer,
      watermarkStore: harness.watermarkStore as never,
      workset,
      config: gateConfig(),
      scopeClassifier: harness.scopeClassifier,
      companionNames: [COMPANION_NAME],
      companionAuthorIds: [COMPANION_AUTHOR_ID],
    });

    await lane.execute(timerAction());

    expect(harness.synthesizer.run.mock.calls.map(([input]) => input.sessionId)).toEqual(
      workItems.map(item => item.logicalSessionId),
    );
    expect(active.maximum).toBe(1);
    expect(workset.checkpoint).toHaveBeenCalledTimes(25);
    expect(workset.checkpoint).toHaveBeenLastCalledWith({
      purpose: 'episodic_synthesis',
      logicalSessionId: 'discord:drain-24',
      revision: 25,
      claimantId: 'episode-synthesis-drain',
    });
  });

  it('does not synthesize an unchanged long conversation again on the next timer tick', async () => {
    const workset = makeStatefulWorkset(['discord:unchanged-long-conversation']);
    const harness = makeHarness({ entries: mentionEntries(24), scope: 'direct' });
    const lane = new EpisodeSynthesisLane({
      sessionManager: harness.sessionManager,
      synthesizer: harness.synthesizer,
      watermarkStore: harness.watermarkStore as never,
      workset,
      config: gateConfig(),
      scopeClassifier: harness.scopeClassifier,
    });

    await lane.execute(timerAction());
    await lane.execute(timerAction());

    expect(harness.synthesizer.run).toHaveBeenCalledTimes(1);
    expect(workset.enumerate).toHaveBeenCalledTimes(2);
    expect(workset.checkpoint).toHaveBeenCalledTimes(1);
  });

  it('leaves only failed work retryable and a restarted lane resumes it', async () => {
    const sessionIds = ['discord:episode-a', 'discord:episode-b', 'discord:episode-c'];
    const workset = makeStatefulWorkset(sessionIds);
    const first = makeHarness({ entries: mentionEntries(12), scope: 'direct' });
    first.synthesizer.run.mockImplementation(async ({ sessionId }: { sessionId: string }) => {
      if (sessionId === 'discord:episode-b') throw new Error('provider unavailable');
      return {
        consideredEntries: 12,
        candidateEpisodeCount: 1,
        createdEpisodes: [],
        skippedEpisodeIds: [],
        linkedArcs: [],
      };
    });
    const firstLane = new EpisodeSynthesisLane({
      sessionManager: first.sessionManager,
      synthesizer: first.synthesizer,
      watermarkStore: first.watermarkStore as never,
      workset,
      config: gateConfig(),
      scopeClassifier: first.scopeClassifier,
    });

    await expect(firstLane.execute(timerAction())).rejects.toThrow(
      'Episode synthesis drain failed for 1 session(s)',
    );
    expect(first.synthesizer.run.mock.calls.map(([input]) => input.sessionId)).toEqual(sessionIds);
    expect(await workset.enumerate('episodic_synthesis')).toEqual([
      expect.objectContaining({
        logicalSessionId: 'discord:episode-b',
        claimantId: 'episode-synthesis-drain',
      }),
    ]);

    const restarted = makeHarness({ entries: mentionEntries(12), scope: 'direct' });
    const restartedLane = new EpisodeSynthesisLane({
      sessionManager: restarted.sessionManager,
      synthesizer: restarted.synthesizer,
      watermarkStore: restarted.watermarkStore as never,
      workset,
      config: gateConfig(),
      scopeClassifier: restarted.scopeClassifier,
    });
    await restartedLane.execute(timerAction());

    expect(workset.resumeClaim).toHaveBeenCalledWith({
      purpose: 'episodic_synthesis',
      logicalSessionId: 'discord:episode-b',
      claimantId: 'episode-synthesis-drain',
    });
    expect(restarted.synthesizer.run).toHaveBeenCalledTimes(1);
    expect(restarted.synthesizer.run).toHaveBeenCalledWith({
      sessionId: 'discord:episode-b',
      sourceMessageId: 'timer-1',
    });
    await expect(workset.enumerate('episodic_synthesis')).resolves.toEqual([]);
  });

  it('offers fleet preemption only after a successful private session checkpoint', async () => {
    const sessionIds = ['discord:episode-a', 'discord:episode-b'];
    const workset = makeStatefulWorkset(sessionIds);
    const harness = makeHarness({ entries: mentionEntries(12), scope: 'direct' });
    const onSafeBoundary = vi.fn(async (input: {
      logicalSessionId: string;
      revision: number;
    }) => {
      expect(workset.checkpoint).toHaveBeenCalledWith({
        purpose: 'episodic_synthesis',
        logicalSessionId: input.logicalSessionId,
        revision: input.revision,
        claimantId: 'episode-synthesis-drain',
      });
      return 'yield' as const;
    });
    const lane = new EpisodeSynthesisLane({
      sessionManager: harness.sessionManager,
      synthesizer: harness.synthesizer,
      watermarkStore: harness.watermarkStore as never,
      workset,
      config: gateConfig(),
      scopeClassifier: harness.scopeClassifier,
    });

    await expect(lane.execute(timerAction(), { onSafeBoundary })).resolves.toEqual({
      outcome: 'yield',
    });

    expect(harness.synthesizer.run).toHaveBeenCalledTimes(1);
    expect(onSafeBoundary).toHaveBeenCalledWith({
      logicalSessionId: 'discord:episode-a',
      revision: 1,
    });
    await expect(workset.enumerate('episodic_synthesis')).resolves.toEqual([
      expect.objectContaining({ logicalSessionId: 'discord:episode-b' }),
    ]);
  });

  it('stops the drain when the fleet boundary loses authority after a private checkpoint', async () => {
    const workset = makeStatefulWorkset(['discord:episode-a', 'discord:episode-b']);
    const harness = makeHarness({ entries: mentionEntries(12), scope: 'direct' });
    const lane = new EpisodeSynthesisLane({
      sessionManager: harness.sessionManager,
      synthesizer: harness.synthesizer,
      watermarkStore: harness.watermarkStore as never,
      workset,
      config: gateConfig(),
      scopeClassifier: harness.scopeClassifier,
    });

    await expect(lane.execute(timerAction(), {
      onSafeBoundary: async () => { throw new Error('fleet fence lost'); },
    })).rejects.toThrow('fleet fence lost');

    expect(harness.synthesizer.run).toHaveBeenCalledTimes(1);
    expect(workset.checkpoint).toHaveBeenCalledOnce();
    await expect(workset.enumerate('episodic_synthesis')).resolves.toEqual([
      expect.objectContaining({ logicalSessionId: 'discord:episode-b' }),
    ]);
  });

  it('load: coalesces trigger pressure while keeping episode model concurrency at one', async () => {
    const sessionIds = Array.from({ length: 40 }, (_, index) => `discord:load-${index}`);
    const workset = makeStatefulWorkset(sessionIds);
    const harness = makeHarness({ entries: mentionEntries(12), scope: 'direct' });
    let activeCalls = 0;
    let maximumActiveCalls = 0;
    harness.synthesizer.run.mockImplementation(async () => {
      activeCalls += 1;
      maximumActiveCalls = Math.max(maximumActiveCalls, activeCalls);
      await new Promise<void>(resolve => queueMicrotask(resolve));
      activeCalls -= 1;
      return {
        consideredEntries: 12,
        candidateEpisodeCount: 1,
        createdEpisodes: [],
        skippedEpisodeIds: [],
        linkedArcs: [],
      };
    });
    const lane = new EpisodeSynthesisLane({
      sessionManager: harness.sessionManager,
      synthesizer: harness.synthesizer,
      watermarkStore: harness.watermarkStore as never,
      workset,
      config: gateConfig(),
      scopeClassifier: harness.scopeClassifier,
    });

    await Promise.all(Array.from({ length: 12 }, () => lane.execute(timerAction())));

    expect(harness.synthesizer.run).toHaveBeenCalledTimes(40);
    expect(maximumActiveCalls).toBe(1);
    expect(workset.enumerate).toHaveBeenCalledTimes(1);
    await expect(workset.enumerate('episodic_synthesis')).resolves.toEqual([]);
  });

  it('Gate 1 treats a future processing watermark as invalid so current traffic can recover the lane', async () => {
    const now = Date.parse('2026-06-01T12:00:00.000Z');
    const harness = makeHarness({
      entries: mentionEntries(12),
      watermarkEndedAt: '2026-07-15T00:00:00.000Z',
      now: () => now,
    });

    await harness.lane.execute(timerAction());

    expect(harness.synthesizer.run).toHaveBeenCalledTimes(1);
    expect(harness.gateEvents[0]).toMatchObject({
      outcome: 'processed',
      newEntryCount: 12,
      relevantTurnCount: 12,
    });
  });

  it('holds below the relevance minimum and processes the accumulated chunk next period (9 -> 25)', async () => {
    const harness = makeHarness({ entries: mentionEntries(9) });

    await harness.lane.execute(timerAction());
    expect(harness.synthesizer.run).not.toHaveBeenCalled();
    expect(harness.gateEvents[0]).toMatchObject({
      outcome: 'skipped',
      reason: 'below_relevance_minimum',
      relevantTurnCount: 9,
      minRelevantTurns: 10,
    });
    expect(getRecentDiagnosticLogRecords()[0]?.message).toContain('below the relevance minimum');

    // Synthesis never ran, so the watermark did not advance; the next period
    // sees the full accumulated chunk (9 held + 16 new = 25 relevant turns).
    harness.entriesRef.current = mentionEntries(25);
    await harness.lane.execute(timerAction());

    expect(harness.synthesizer.run).toHaveBeenCalledTimes(1);
    expect(harness.synthesizer.run).toHaveBeenCalledWith({
      sessionId: 'discord:room-1',
      sourceMessageId: 'timer-1',
    });
    expect(harness.gateEvents[1]).toMatchObject({
      outcome: 'processed',
      relevantTurnCount: 25,
      newEntryCount: 25,
    });
  });

  it('async group traffic around the companion produces no episode', async () => {
    const harness = makeHarness({ entries: bystanderEntries(20) });

    await harness.lane.execute(timerAction());

    expect(harness.synthesizer.run).not.toHaveBeenCalled();
    expect(harness.gateEvents[0]).toMatchObject({
      outcome: 'skipped',
      reason: 'below_relevance_minimum',
      newEntryCount: 20,
      relevantTurnCount: 0,
    });
  });

  it('direct-mention traffic above the threshold processes', async () => {
    const entries = [
      ...mentionEntries(8),
      // Companion replies count as conversation with her.
      makeEntry({ id: 9, role: 'assistant', authorId: COMPANION_AUTHOR_ID, content: 'I think the plan works.' }),
      // A reply to the companion is meaningful involvement.
      makeEntry({
        id: 10,
        content: 'that makes sense, thanks',
        metadata: JSON.stringify({ replyToAuthorId: COMPANION_AUTHOR_ID }),
      }),
      // Bystander noise does not count but does not block.
      ...bystanderEntries(5, 11),
    ];
    const harness = makeHarness({ entries });

    await harness.lane.execute(timerAction());

    expect(harness.synthesizer.run).toHaveBeenCalledTimes(1);
    expect(harness.gateEvents[0]).toMatchObject({
      outcome: 'processed',
      relevantTurnCount: 10,
      newEntryCount: 15,
    });
  });

  it('treats every conversational turn as relevant in direct (DM) scope', async () => {
    const harness = makeHarness({
      entries: bystanderEntries(12),
      scope: 'direct',
    });

    await harness.lane.execute(timerAction());

    expect(harness.synthesizer.run).toHaveBeenCalledTimes(1);
    expect(harness.gateEvents[0]).toMatchObject({
      outcome: 'processed',
      relevantTurnCount: 12,
    });
  });

  it('fires the turn-threshold trigger before the timer once enough turns accumulate', () => {
    const harness = makeHarness({ config: gateConfig({ turnThreshold: 5 }) });

    for (let turn = 1; turn <= 4; turn += 1) {
      expect(harness.lane.noteTurn({
        id: `m${turn}`,
        channelId: 'discord:room-1',
        channelType: 'discord',
      })).toBeNull();
    }
    const candidate = harness.lane.noteTurn({
      id: 'm5',
      channelId: 'discord:room-1',
      channelType: 'discord',
    });
    expect(candidate).toMatchObject({
      kind: EPISODE_SYNTHESIS_ACTION_KIND,
      dedupeKey: `${EPISODE_SYNTHESIS_ACTION_KIND}:drain`,
      payload: {
        sourceChannelId: 'discord:room-1',
        trigger: 'turn_threshold',
        channelType: 'discord',
      },
    });
    // Counter reset after the trigger.
    expect(harness.lane.noteTurn({
      id: 'm6',
      channelId: 'discord:room-1',
      channelType: 'discord',
    })).toBeNull();
    // Internal channels never count.
    expect(harness.lane.noteTurn({
      id: 'm7',
      channelId: 'internal:maintenance',
    })).toBeNull();
  });

  it('admits a real self-directed free-time arc to the episodic candidate lane', async () => {
    const channelId = 'internal:free-time:idle';
    const entries = Array.from({ length: 4 }, (_, index) => makeEntry({
      id: index + 1,
      channelId,
      role: index % 2 === 0 ? 'user' : 'assistant',
      authorId: index % 2 === 0 ? 'scheduler' : COMPANION_AUTHOR_ID,
      authorName: index % 2 === 0 ? 'Free Time' : COMPANION_NAME,
      content: index % 2 === 0
        ? 'Continue the watercolor project if that is what you want.'
        : 'I returned to the watercolor study and felt pleased by the softer edge this time.',
    }));
    const harness = makeHarness({
      entries,
      watermarkEndedAt: null,
      config: gateConfig({ minRelevantTurns: 4, turnThreshold: 2 }),
    });

    expect(harness.lane.noteTurn({ id: 'self-1', channelId, channelType: 'terminal' })).toBeNull();
    const candidate = harness.lane.noteTurn({ id: 'self-2', channelId, channelType: 'terminal' });
    expect(candidate).toMatchObject({
      kind: EPISODE_SYNTHESIS_ACTION_KIND,
      payload: { sourceChannelId: channelId, trigger: 'turn_threshold' },
    });

    await harness.lane.execute({
      id: 'self-episode-action',
      channelId,
      sourceMessageId: 'self-2',
      payload: {
        sessionId: channelId,
        sourceChannelId: channelId,
        trigger: 'turn_threshold',
        channelType: 'terminal',
      },
    });

    expect(harness.synthesizer.run).toHaveBeenCalledWith({
      sessionId: channelId,
      sourceMessageId: 'self-2',
    });
    expect(harness.gateEvents[0]).toMatchObject({
      sessionId: channelId,
      outcome: 'processed',
      relevantTurnCount: 4,
    });
  });

  it('emits one companion-level timer drain action', () => {
    const harness = makeHarness();
    expect(harness.lane.inferTimerAction()).toMatchObject({
      kind: EPISODE_SYNTHESIS_ACTION_KIND,
      payload: {
        trigger: 'timer',
      },
      dedupeKey: `${EPISODE_SYNTHESIS_ACTION_KIND}:drain`,
    });
  });

  it('rejects testing sessions at turn, timer, and execution boundaries', async () => {
    const sessionId = 'discord:testing:episode-harness';
    const harness = makeHarness({ entries: mentionEntries(12) });
    harness.sessionManager.resolveSessionChannelId.mockReturnValue(sessionId);

    expect(harness.lane.noteTurn({
      id: 'testing-turn',
      channelId: sessionId,
      channelType: 'discord',
    })).toBeNull();
    await harness.lane.execute({
      ...timerAction(),
      channelId: sessionId,
      payload: {
        ...timerAction().payload,
        sessionId,
        sourceChannelId: sessionId,
      },
    });

    expect(harness.synthesizer.run).not.toHaveBeenCalled();
    expect(harness.watermarkStore.getProcessingWatermark).not.toHaveBeenCalled();
    expect(harness.gateEvents[0]).toMatchObject({
      sessionId,
      outcome: 'skipped',
      reason: 'testing_session',
    });
    expect(getRecentDiagnosticLogRecords()[0]?.message).toContain('testing session');
  });

  it('writes deterministic behavioral summaries from high-confidence synthesis arcs', async () => {
    const memoryWriter = { write: vi.fn().mockResolvedValue({ action: 'created' }) };
    const harness = makeHarness({
      entries: mentionEntries(12),
      memoryWriter,
    });
    harness.synthesizer.run.mockResolvedValue({
      consideredEntries: 12,
      candidateEpisodeCount: 2,
      createdEpisodes: [],
      skippedEpisodeIds: [],
      linkedArcs: [{
        id: 'arc-recurrence-1',
        sourceEpisodeId: 'episode-1',
        targetEpisodeId: 'episode-2',
        arcKind: 'recurrence',
        confidence: 0.78,
        themes: ['atlas', 'validation'],
      }],
    });

    await harness.lane.execute(timerAction());

    expect(memoryWriter.write).toHaveBeenCalledTimes(1);
    expect(memoryWriter.write).toHaveBeenCalledWith(expect.objectContaining({
      type: 'reflection',
      text: expect.stringContaining('recurrence pattern'),
      provenanceRefs: expect.arrayContaining([
        'l01_episode_arc:arc-recurrence-1',
        'l01_episode:episode-1',
        'l01_episode:episode-2',
      ]),
      tags: expect.arrayContaining(['behavioral_summary', 'evidence_chain', 'episode_arc:recurrence']),
    }));
  });

  // psfn-framework-ca980 — a behavioral summary must carry the arc's episode
  // source-content time (target episode `endedAt`), not the deferred synthesis run
  // clock, so a room widened after that content denies the auto-share.
  it('stamps the arc target episode source-content end as the disclosure conversation time (ca980)', async () => {
    const CHANNEL = 'discord:room-1';
    const DEMOTION_1 = Date.parse('2026-02-01T00:00:00.000Z');
    const DEMOTION_2 = Date.parse('2026-04-01T00:00:00.000Z');
    // Target episode's newest source content lands BETWEEN the two demotions → epoch 1.
    const TARGET_ENDED_AT = new Date(DEMOTION_1 + 60_000).toISOString();

    const memoryWriter = { write: vi.fn().mockResolvedValue({ action: 'created' }) };
    const harness = makeHarness({ entries: mentionEntries(12), memoryWriter });
    harness.synthesizer.run.mockResolvedValue({
      consideredEntries: 12,
      candidateEpisodeCount: 2,
      // The arc's TARGET is always a just-created episode this run (see synthesis
      // buildArcInput); its endedAt is the resolvable source-content bound.
      createdEpisodes: [{ id: 'episode-2', endedAt: TARGET_ENDED_AT }],
      skippedEpisodeIds: [],
      linkedArcs: [{
        id: 'arc-recurrence-1',
        sourceEpisodeId: 'episode-1',
        targetEpisodeId: 'episode-2',
        arcKind: 'recurrence',
        confidence: 0.78,
        themes: ['atlas', 'validation'],
      }],
    });

    await harness.lane.execute(timerAction());

    expect(memoryWriter.write).toHaveBeenCalledTimes(1);
    const provenance = memoryWriter.write.mock.calls[0][0].provenance as MemoryProvenance;
    expect(provenance.sourceConversationAt).toBe(Date.parse(TARGET_ENDED_AT));
    expect(provenance.channelId).toBe(CHANNEL);

    try {
      const demotion = (at: number) => ({
        channelId: CHANNEL, from: 'invite_only' as const, to: 'public' as const,
        at: new Date(at).toISOString(), acceptedBy: 'operator:test',
        noticeVersion: DEMOTION_EPOCH_NOTICE_VERSION,
      });
      setRuntimeChannelClassificationEpochs([demotion(DEMOTION_1), demotion(DEMOTION_2)]);

      const sources = collectDisclosureMemorySources({
        selectedForPrompt: [synthMemory(provenance, DEMOTION_2 + 60_000)],
        emotionalContinuityMemories: [],
      });
      expect(sources[0].sourceChannelEpoch).toBe(1);
      const room1: DisclosureDestinationConstraint = {
        kind: 'public_room', channelIds: [CHANNEL], channelEpochs: { [CHANNEL]: 1 },
      };
      expect(destinationEpochEligible([room1], { kind: 'public_room', channelId: CHANNEL, currentEpoch: 2 })).toBe(false);

      // Control: post-widening episode content resolves epoch 2 and shares.
      const postWiden = collectDisclosureMemorySources({
        selectedForPrompt: [synthMemory(
          { channelId: CHANNEL, sourceConversationAt: DEMOTION_2 + 60_000 },
          DEMOTION_2 + 120_000,
        )],
        emotionalContinuityMemories: [],
      });
      expect(postWiden[0].sourceChannelEpoch).toBe(2);
      const room2: DisclosureDestinationConstraint = {
        kind: 'public_room', channelIds: [CHANNEL], channelEpochs: { [CHANNEL]: 2 },
      };
      expect(destinationEpochEligible([room2], { kind: 'public_room', channelId: CHANNEL, currentEpoch: 2 })).toBe(true);
    } finally {
      resetRuntimeChannelClassificationEpochs();
    }
  });

  it('fails closed (no conversation stamp) when the arc target episode is unresolvable (ca980)', async () => {
    const memoryWriter = { write: vi.fn().mockResolvedValue({ action: 'created' }) };
    const harness = makeHarness({ entries: mentionEntries(12), memoryWriter });
    harness.synthesizer.run.mockResolvedValue({
      consideredEntries: 12,
      candidateEpisodeCount: 2,
      createdEpisodes: [], // target 'episode-2' not present → no resolvable endedAt
      skippedEpisodeIds: [],
      linkedArcs: [{
        id: 'arc-recurrence-1', sourceEpisodeId: 'episode-1', targetEpisodeId: 'episode-2',
        arcKind: 'recurrence', confidence: 0.78, themes: ['atlas'],
      }],
    });

    await harness.lane.execute(timerAction());

    expect(memoryWriter.write).toHaveBeenCalledTimes(1);
    const provenance = memoryWriter.write.mock.calls[0][0].provenance as MemoryProvenance;
    expect(provenance.sourceConversationAt).toBeUndefined();
  });

  it('skips retired sessions with a typed reason', async () => {
    const harness = makeHarness({ entries: mentionEntries(12) });
    (harness.sessionManager as unknown as Record<string, unknown>).isSessionRetiredOrQuarantined
      = vi.fn(() => true);

    await harness.lane.execute(timerAction());

    expect(harness.synthesizer.run).not.toHaveBeenCalled();
    expect(harness.gateEvents[0]).toMatchObject({
      outcome: 'skipped',
      reason: 'session_retired',
    });
    expect(getRecentDiagnosticLogRecords()[0]?.message).toContain('retired or quarantined session');
  });
});
