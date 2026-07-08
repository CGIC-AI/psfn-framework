import { describe, expect, it, vi } from 'vitest';
import type { SessionEntry } from '../../../core/session/types.js';
import type { EpisodeSynthesisLaneConfig } from '../../../system/config/scheduler-config.js';
import {
  EpisodeSynthesisLane,
  EPISODE_SYNTHESIS_ACTION_KIND,
  type EpisodeSynthesisGateEvent,
} from './synthesis-lane.js';

const COMPANION_NAME = 'Purrsephone';
const COMPANION_AUTHOR_ID = 'bot-companion-1';
const WATERMARK_END_MS = Date.parse('2026-06-01T10:00:00.000Z');

function gateConfig(overrides: Partial<EpisodeSynthesisLaneConfig> = {}): EpisodeSynthesisLaneConfig {
  return {
    timerIntervalMinutes: 30,
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

function makeHarness(options: {
  entries?: SessionEntry[];
  watermarkEndedAt?: string | null;
  scope?: 'direct' | 'group';
  config?: EpisodeSynthesisLaneConfig;
  memoryWriter?: { write: ReturnType<typeof vi.fn> };
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
  const gateEvents: EpisodeSynthesisGateEvent[] = [];
  const lane = new EpisodeSynthesisLane({
    sessionManager,
    synthesizer,
    watermarkStore: watermarkStore as never,
    config: options.config ?? gateConfig(),
    scopeClassifier,
    companionNames: [COMPANION_NAME],
    companionAuthorIds: [COMPANION_AUTHOR_ID],
    ...(options.memoryWriter ? { memoryWriter: options.memoryWriter } : {}),
    onGateEvent: (event) => { gateEvents.push(event); },
  });
  return { lane, entriesRef, sessionManager, synthesizer, watermarkStore, scopeClassifier, gateEvents };
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
      dedupeKey: `${EPISODE_SYNTHESIS_ACTION_KIND}:discord:room-1`,
      payload: {
        sessionId: 'discord:room-1',
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
      channelId: 'internal:reflection:whisper',
    })).toBeNull();
  });

  it('emits one timer gate-evaluation action per recent session', () => {
    const harness = makeHarness();
    const actions = harness.lane.inferTimerActions();
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      kind: EPISODE_SYNTHESIS_ACTION_KIND,
      payload: {
        sessionId: 'discord:room-1',
        trigger: 'timer',
      },
    });
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
  });
});
