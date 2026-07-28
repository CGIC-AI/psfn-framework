import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, vi } from 'vitest';
import type { InferredPostTurnAction, SubstrateMessage, AgentResponse } from '../../shared/contracts/runtime.js';
import { EventBus } from '../../shared/event-bus.js';
import { Scheduler } from '../../core/scheduler/scheduler.js';
import { wirePostTurnActionRuntime } from '../../app/startup/composition/post-turn-actions.js';
import { CoreMemoryStore } from '../core-memory/store.js';
import { coreMemoryChannelScope } from '../core-memory/store.js';
import type { EpisodicProcessingRestWindowConfig } from '../../system/config/scheduler-config.js';
import {
  SleeptimeMemoryAgent,
  SLEEPTIME_MEMORY_ACTION_KIND,
  type SleeptimeMemoryAgentOptions,
} from './sleeptime-agent.js';

/** start == end means the window covers the whole day. */
function alwaysOpenRestWindow(): EpisodicProcessingRestWindowConfig {
  return {
    enabled: true,
    startLocalTime: '00:00',
    endLocalTime: '00:00',
    timeZone: 'UTC',
    inactivityThresholdMinutes: 60,
  };
}

function nightRestWindow(): EpisodicProcessingRestWindowConfig {
  return {
    enabled: true,
    startLocalTime: '00:00',
    endLocalTime: '09:00',
    timeZone: 'UTC',
    inactivityThresholdMinutes: 60,
  };
}

function makeMessage(channelId = 'terminal:test'): SubstrateMessage {
  return {
    id: 'msg-1',
    channelId,
    channelType: 'terminal',
    authorId: 'user-1',
    authorName: 'User',
    content: 'hello',
    timestamp: new Date(),
  };
}

function makeResponse(channelId = 'terminal:test'): AgentResponse {
  return {
    content: 'ok',
    channelId,
    metadata: {
      model: 'mock-model',
      inputTokens: 1,
      outputTokens: 1,
      durationMs: 1,
    },
  };
}

function makeSleeptimeAction(overrides: Partial<InferredPostTurnAction> = {}): InferredPostTurnAction {
  return {
    id: 'sleeptime-action-1',
    kind: SLEEPTIME_MEMORY_ACTION_KIND,
    payload: { sessionId: 'terminal:test' },
    dedupeKey: `${SLEEPTIME_MEMORY_ACTION_KIND}:terminal:test`,
    channelId: 'terminal:test',
    sourceMessageId: 'msg-1',
    inferredAt: Date.now(),
    ...overrides,
  };
}

function makeReviewAgent(content: string) {
  return { handleMessage: vi.fn(async () => ({ content })) };
}

function makeEpisodeReader(episodes: unknown[] = []) {
  return { searchByTime: vi.fn(() => episodes as never) };
}

function deferredIdleGate(): {
  reached: Promise<void>;
  release: () => void;
  wait: () => Promise<void>;
} {
  let markReached = () => {};
  let release = () => {};
  const reached = new Promise<void>(resolve => {
    markReached = resolve;
  });
  const released = new Promise<void>(resolve => {
    release = resolve;
  });
  return {
    reached,
    release,
    wait: async () => {
      markReached();
      await released;
    },
  };
}

describe('SleeptimeMemoryAgent', () => {
  function makeCoreMemoryStore() {
    return {
      getSnapshot: vi.fn().mockReturnValue({
        version: 1,
        updatedAt: '2026-03-01T00:00:00.000Z',
        blocks: {
          persona: { label: 'persona', content: '', maxChars: 2400 },
          human: { label: 'human', content: '', maxChars: 2400, trustLevel: 'trusted' },
          goals: { label: 'goals', content: '', maxChars: 1600 },
        },
      }),
      rethink: vi.fn(),
    };
  }

  function makeAgentOptions(overrides: Partial<SleeptimeMemoryAgentOptions> = {}): SleeptimeMemoryAgentOptions {
    return {
      agent: makeReviewAgent('{}'),
      episodicStore: makeEpisodeReader(),
      sessionManager: {
        resolveSessionChannelId: vi.fn((channelId: string) => channelId),
        getRecentMessages: vi.fn().mockReturnValue([]),
      },
      coreMemoryStore: makeCoreMemoryStore(),
      memoryWriter: { write: vi.fn() },
      restWindow: alwaysOpenRestWindow(),
      ...overrides,
    };
  }

  it('fails closed at construction without a rest-window config', () => {
    const options = makeAgentOptions();
    delete (options as Partial<SleeptimeMemoryAgentOptions>).restWindow;
    expect(() => new SleeptimeMemoryAgent(options)).toThrow(
      /requires a rest-window config.*must not run from turn cadence/s,
    );
  });

  it('exposes no turn-cadence inference surface (heavy passes unreachable from turns)', () => {
    const agent = new SleeptimeMemoryAgent(makeAgentOptions());
    const surface = agent as unknown as Record<string, unknown>;
    expect(surface.inferPostTurnAction).toBeUndefined();
    expect(surface.inferPostTurnActions).toBeUndefined();
    expect(typeof surface.inferIdlePostTurnActions).toBe('function');
  });

  it('infers idle sleeptime actions for quiet rest-window sessions', () => {
    const sessionManager = {
      resolveSessionChannelId: vi.fn((channelId: string) => channelId),
      getRecentMessages: vi.fn().mockReturnValue([]),
      listRecentSessions: vi.fn().mockReturnValue([
        {
          channelId: 'terminal:alpha',
          channelType: 'terminal',
          messageCount: 10,
          lastActivityAt: Date.parse('2026-03-16T01:00:00.000Z'),
          lastRole: 'user',
        },
      ]),
    };
    const agent = new SleeptimeMemoryAgent(makeAgentOptions({
      sessionManager,
      restWindow: nightRestWindow(),
    }));

    const actions = agent.inferIdlePostTurnActions({
      nowMs: Date.parse('2026-03-16T03:30:00.000Z'),
    });

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      kind: SLEEPTIME_MEMORY_ACTION_KIND,
      dedupeKey: `${SLEEPTIME_MEMORY_ACTION_KIND}:terminal:alpha`,
      payload: {
        sessionId: 'terminal:alpha',
        trigger: 'idle_rest_window',
        lastUserActivityAtMs: Date.parse('2026-03-16T01:00:00.000Z'),
      },
    });
  });

  it('does not infer sleeptime actions for testing sessions', () => {
    const sessionManager = {
      resolveSessionChannelId: vi.fn((channelId: string) => channelId),
      getRecentMessages: vi.fn().mockReturnValue([]),
      listRecentSessions: vi.fn().mockReturnValue([
        {
          channelId: 'terminal:testing:rest-window-probe',
          channelType: 'terminal',
          messageCount: 10,
          lastActivityAt: Date.parse('2026-03-16T01:00:00.000Z'),
          lastRole: 'user',
        },
      ]),
    };
    const agent = new SleeptimeMemoryAgent(makeAgentOptions({
      sessionManager,
      restWindow: nightRestWindow(),
    }));

    expect(agent.inferIdlePostTurnActions({
      nowMs: Date.parse('2026-03-16T03:30:00.000Z'),
    })).toEqual([]);
  });

  it('skips queued testing-session work before transcript, durable memory, orientation, wiki, dream, or arc activity', async () => {
    const reviewAgent = makeReviewAgent('{}');
    const sessionManager = {
      resolveSessionChannelId: vi.fn((channelId: string) => channelId),
      getRecentMessages: vi.fn().mockReturnValue([{
        id: 1,
        channelId: 'terminal:testing:queued-rest-window-probe',
        role: 'user' as const,
        content: 'This fixture must never become durable memory.',
        timestamp: Date.now(),
      }]),
    };
    const coreMemoryStore = makeCoreMemoryStore();
    const memoryWriter = { write: vi.fn() };
    const sleepConsolidator = { run: vi.fn() };
    const arcWeaver = { run: vi.fn() };
    const dreamMeaningPass = { run: vi.fn() };
    const sleeptimeWikiPass = { run: vi.fn() };
    const agent = new SleeptimeMemoryAgent(makeAgentOptions({
      agent: reviewAgent,
      sessionManager,
      coreMemoryStore,
      memoryWriter,
      sleepConsolidator,
      arcWeaver,
      dreamMeaningPass,
      sleeptimeWikiPass,
    }));

    await agent.execute(makeSleeptimeAction({
      channelId: 'terminal:testing:queued-rest-window-probe',
      payload: { sessionId: 'terminal:testing:queued-rest-window-probe' },
    }));

    expect(sessionManager.getRecentMessages).not.toHaveBeenCalled();
    expect(sleepConsolidator.run).not.toHaveBeenCalled();
    expect(arcWeaver.run).not.toHaveBeenCalled();
    expect(dreamMeaningPass.run).not.toHaveBeenCalled();
    expect(sleeptimeWikiPass.run).not.toHaveBeenCalled();
    expect(reviewAgent.handleMessage).not.toHaveBeenCalled();
    expect(coreMemoryStore.getSnapshot).not.toHaveBeenCalled();
    expect(coreMemoryStore.rethink).not.toHaveBeenCalled();
    expect(memoryWriter.write).not.toHaveBeenCalled();
  });

  it('does not infer idle actions for sessions active inside the window', () => {
    const sessionManager = {
      resolveSessionChannelId: vi.fn((channelId: string) => channelId),
      getRecentMessages: vi.fn().mockReturnValue([]),
      listRecentSessions: vi.fn().mockReturnValue([
        {
          channelId: 'terminal:alpha',
          channelType: 'terminal',
          messageCount: 10,
          lastActivityAt: Date.parse('2026-03-16T03:10:00.000Z'),
          lastRole: 'user',
        },
      ]),
    };
    const agent = new SleeptimeMemoryAgent(makeAgentOptions({
      sessionManager,
      restWindow: nightRestWindow(),
    }));

    expect(agent.inferIdlePostTurnActions({
      nowMs: Date.parse('2026-03-16T03:30:00.000Z'),
    })).toHaveLength(0);
  });

  it('reorients active blocks and writes long-term memory facts from a sleeptime plan', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'sleeptime-core-memory-'));
    try {
      const coreMemoryStore = new CoreMemoryStore(join(tempDir, 'core-memory.json'));
      const reviewAgent = makeReviewAgent(JSON.stringify({
        orient: {
          persona: 'Warm, direct, and practical conversational style.',
          human: 'Primary user prefers concise answers and values follow-through.',
          goals: 'Maintain continuity and proactively track unresolved commitments.',
        },
        memory_writes: [
          {
            text: 'User prefers concise replies during coding sessions.',
            type: 'semantic',
            importance: 0.82,
            confidence: 0.9,
            emotionalValence: 0.2,
            tags: ['preferences', 'coding'],
            sensitivity: 'personal',
          },
          {
            text: 'Need to follow up on unresolved build warnings.',
            type: 'procedural',
            importance: 0.77,
            confidence: 0.74,
            emotionalValence: 0,
            tags: ['workflow', 'follow_up'],
            sensitivity: 'personal',
          },
        ],
      }));
      const sessionManager = {
        resolveSessionChannelId: vi.fn((channelId: string) => channelId),
        getRecentMessages: vi.fn().mockReturnValue([
          {
            id: 1,
            channelId: 'terminal:test',
            role: 'user',
            content: 'Please keep answers concise while we debug.',
            timestamp: Date.now(),
          },
          {
            id: 2,
            channelId: 'terminal:test',
            role: 'assistant',
            content: 'Understood. I will prioritize concise, actionable output.',
            timestamp: Date.now(),
          },
          {
            id: 3,
            channelId: 'terminal:test',
            role: 'user',
            content: 'Love the warm, direct, practical conversational style. Keep tracking unresolved commitments: concise replies during coding sessions, and follow up on the build warnings.',
            timestamp: Date.now(),
          },
        ]),
      };
      const memoryWriter = {
        write: vi.fn().mockResolvedValue({ action: 'created' }),
      };
      const agent = new SleeptimeMemoryAgent(makeAgentOptions({
        agent: reviewAgent,
        sessionManager,
        coreMemoryStore,
        memoryWriter,
        // This test exercises the rewrite path against a freshly-created core
        // memory store (updatedAt ~ now), so lower the orientation-gate floor
        // to let the two transcript turns count as evidence of change.
        orientationRewriteGate: { minNewEntriesSinceRewrite: 1, refreshAfterQuietDays: 1 },
      }));

      await agent.execute(makeSleeptimeAction({
        payload: { sessionId: 'terminal:test' },
        sourceMessageId: 'msg-42',
      }));

      const snapshot = coreMemoryStore.getSnapshot({
        scope: coreMemoryChannelScope({ channelId: 'terminal:test' }),
      });
      expect(snapshot.blocks.persona.content).toContain('Warm, direct, and practical');
      expect(snapshot.blocks.human.content).toContain('Primary user prefers concise answers');
      expect(snapshot.blocks.goals.content).toContain('track unresolved commitments');
      expect(memoryWriter.write).toHaveBeenCalledTimes(2);
      expect(memoryWriter.write).toHaveBeenCalledWith(expect.objectContaining({
        type: 'semantic',
        sourceRef: expect.stringContaining('source:sleeptime|session:terminal:test|message:msg-42'),
        tags: expect.arrayContaining(['preferences', 'coding', 'sleeptime']),
      }));
      expect((reviewAgent.handleMessage as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
        expect.objectContaining({
          channelId: 'internal:reflection:sleeptime-review',
          authorId: 'scheduler',
          routing: expect.objectContaining({
            workerExecution: expect.anything(),
          }),
        }),
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects a fabricated benign memory write with no grounding, even at high confidence (1gpol)', async () => {
    const reviewAgent = makeReviewAgent(JSON.stringify({
      orient: {
        persona: 'Focused on careful gateway debugging.',
        human: 'We debugged the gateway all evening.',
        goals: 'Continue the gateway debugging work carefully.',
      },
      memory_writes: [{
        text: 'Purrsephone adopted a pet iguana named Sparkles last spring.',
        type: 'semantic',
        importance: 0.7,
        confidence: 0.9,
        emotionalValence: 0.3,
        tags: ['pets'],
        sensitivity: 'personal',
      }],
    }));
    const memoryWriter = { write: vi.fn() };
    const agent = new SleeptimeMemoryAgent(makeAgentOptions({
      agent: reviewAgent,
      sessionManager: {
        resolveSessionChannelId: vi.fn((channelId: string) => channelId),
        getRecentMessages: vi.fn().mockReturnValue([
          { id: 1, channelId: 'terminal:test', role: 'user', content: 'We debugged the gateway all evening.', timestamp: Date.now() },
        ]),
      },
      memoryWriter,
    }));

    await agent.execute(makeSleeptimeAction());

    expect(reviewAgent.handleMessage).toHaveBeenCalled();
    expect(memoryWriter.write).not.toHaveBeenCalled();
  });

  it('keeps previous orient content when a rewritten block is ungrounded (1gpol)', async () => {
    const coreMemoryStore = makeCoreMemoryStore();
    coreMemoryStore.getSnapshot.mockReturnValue({
      version: 1,
      updatedAt: '2026-03-01T00:00:00.000Z',
      blocks: {
        persona: { label: 'persona', content: 'Concise, debugging-focused style.', maxChars: 2400 },
        human: { label: 'human', content: 'User is deep in gateway work.', maxChars: 2400, trustLevel: 'trusted' },
        goals: { label: 'goals', content: 'Finish the gateway debugging.', maxChars: 1600 },
      },
    });
    const reviewAgent = makeReviewAgent(JSON.stringify({
      orient: {
        persona: 'Suddenly obsessed with medieval falconry and heraldry.',
        human: 'User is deep in gateway work.',
        goals: 'Finish the gateway debugging.',
      },
      memory_writes: [],
    }));
    const agent = new SleeptimeMemoryAgent(makeAgentOptions({
      agent: reviewAgent,
      coreMemoryStore,
      sessionManager: {
        resolveSessionChannelId: vi.fn((channelId: string) => channelId),
        getRecentMessages: vi.fn().mockReturnValue([
          { id: 1, channelId: 'terminal:test', role: 'user', content: 'Still working through the gateway debugging together.', timestamp: Date.now() },
        ]),
      },
      orientationRewriteGate: { minNewEntriesSinceRewrite: 1, refreshAfterQuietDays: 1 },
    }));

    await agent.execute(makeSleeptimeAction());

    expect(coreMemoryStore.rethink).toHaveBeenCalledWith(
      expect.objectContaining({ persona: 'Concise, debugging-focused style.' }),
      expect.anything(),
    );
  });

  it('routes an omitted-confidence high-impact write to review instead of storing it settled (1gpol)', async () => {
    const reviewAgent = makeReviewAgent(JSON.stringify({
      orient: {
        persona: 'Focused on careful gateway debugging.',
        human: 'Partner felt anxious about the gateway outage tonight.',
        goals: 'Continue debugging the gateway outage carefully.',
      },
      memory_writes: [{
        text: 'Partner said the gateway outage made them feel anxious tonight.',
        type: 'emotional',
        importance: 0.8,
        emotionalValence: -0.4,
        tags: ['feelings'],
        sensitivity: 'intimate',
      }],
    }));
    const memoryWriter = { write: vi.fn() };
    const upsertMemoryMaintenanceReview = vi.fn(async (input: unknown) => input as never);
    const agent = new SleeptimeMemoryAgent(makeAgentOptions({
      agent: reviewAgent,
      memoryWriter,
      memoryMaintenanceStore: {
        upsertMemoryMaintenanceReview,
        getById: vi.fn(),
        getMemoryMaintenanceDiagnostics: vi.fn(),
      },
      sessionManager: {
        resolveSessionChannelId: vi.fn((channelId: string) => channelId),
        getRecentMessages: vi.fn().mockReturnValue([
          { id: 1, channelId: 'terminal:test', role: 'user', content: 'That gateway outage tonight made me anxious, honestly.', timestamp: Date.now() },
        ]),
      },
    }));

    await agent.execute(makeSleeptimeAction());

    expect(upsertMemoryMaintenanceReview).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'high_impact_low_confidence',
    }));
    expect(memoryWriter.write).not.toHaveBeenCalled();
  });

  it('rejects an ungrounded omitted-confidence high-impact write before review persistence (1gpol)', async () => {
    const reviewAgent = makeReviewAgent(JSON.stringify({
      orient: {
        persona: 'Focused on careful gateway debugging.',
        human: 'We debugged the gateway all evening.',
        goals: 'Continue the gateway debugging work carefully.',
      },
      memory_writes: [{
        text: 'Partner set a hard boundary against any future family contact.',
        type: 'boundary',
        importance: 0.9,
        emotionalValence: -0.5,
        tags: ['boundary', 'family'],
        sensitivity: 'confidential',
      }],
    }));
    const memoryWriter = { write: vi.fn() };
    const upsertMemoryMaintenanceReview = vi.fn(async (input: unknown) => input as never);
    const agent = new SleeptimeMemoryAgent(makeAgentOptions({
      agent: reviewAgent,
      memoryWriter,
      memoryMaintenanceStore: {
        upsertMemoryMaintenanceReview,
        getById: vi.fn(),
        getMemoryMaintenanceDiagnostics: vi.fn(),
      },
      sessionManager: {
        resolveSessionChannelId: vi.fn((channelId: string) => channelId),
        getRecentMessages: vi.fn().mockReturnValue([
          { id: 1, channelId: 'terminal:test', role: 'user', content: 'We debugged the gateway all evening.', timestamp: Date.now() },
        ]),
      },
    }));

    await agent.execute(makeSleeptimeAction());

    expect(upsertMemoryMaintenanceReview).not.toHaveBeenCalled();
    expect(memoryWriter.write).not.toHaveBeenCalled();
  });

  it('gives the review context the day episodes and retries once on an unusable reply (1gpol)', async () => {
    const plan = JSON.stringify({
      orient: {
        persona: 'Focused on the gateway debugging marathon.',
        human: 'We finally traced the flaky handshake.',
        goals: 'Continue the gateway debugging work.',
      },
      memory_writes: [],
    });
    const handleMessage = vi.fn()
      .mockResolvedValueOnce({ content: 'a quiet prose reply, no JSON' })
      .mockResolvedValueOnce({ content: plan });
    const agent = new SleeptimeMemoryAgent(makeAgentOptions({
      agent: { handleMessage },
      episodicStore: makeEpisodeReader([{
        id: 'ep-1',
        title: 'Gateway debugging marathon',
        landmark: 'We finally traced the flaky handshake',
        startedAt: '2026-07-22T01:00:00.000Z',
        endedAt: '2026-07-22T03:00:00.000Z',
        themes: ['debugging'],
      }]),
      sessionManager: {
        resolveSessionChannelId: vi.fn((channelId: string) => channelId),
        getRecentMessages: vi.fn().mockReturnValue([
          { id: 1, channelId: 'terminal:test', role: 'user', content: 'What a marathon.', timestamp: Date.now() },
        ]),
      },
    }));

    await agent.execute(makeSleeptimeAction());

    expect(handleMessage).toHaveBeenCalledTimes(2);
    const openingPrompt = (handleMessage.mock.calls[0]?.[0] as { content: string }).content;
    expect(openingPrompt).toContain('Gateway debugging marathon');
    expect(openingPrompt).toContain('flaky handshake');
  });

  it('marks meaning-less review episodes unreviewed so machine drafts never read as her settled past (h4fp.6)', async () => {
    const handleMessage = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        orient: {
          persona: 'Sitting with the authored evening.',
          human: 'They reviewed the morning together.',
          goals: 'Keep reviewing the day honestly.',
        },
        memory_writes: [],
      }),
    });
    const agent = new SleeptimeMemoryAgent(makeAgentOptions({
      agent: { handleMessage },
      episodicStore: makeEpisodeReader([
        {
          id: 'ep-authored',
          title: 'Authored evening',
          landmark: 'A machine-drafted landmark she has already reviewed',
          startedAt: '2026-07-22T01:00:00.000Z',
          endedAt: '2026-07-22T02:00:00.000Z',
          themes: ['reflection'],
          meaning: {
            text: 'This is what that evening actually meant to me.',
            recordedAt: '2026-07-23T04:00:00.000Z',
            source: 'companion_dream_pass',
          },
        },
        {
          id: 'ep-unreviewed',
          title: 'Unreviewed morning',
          landmark: 'A machine-drafted landmark awaiting her review',
          startedAt: '2026-07-22T03:00:00.000Z',
          endedAt: '2026-07-22T04:00:00.000Z',
          themes: ['planning'],
        },
      ]),
      sessionManager: {
        resolveSessionChannelId: vi.fn((channelId: string) => channelId),
        getRecentMessages: vi.fn().mockReturnValue([
          { id: 1, channelId: 'terminal:test', role: 'user', content: 'A long evening and a slow morning.', timestamp: Date.now() },
        ]),
      },
    }));

    await agent.execute(makeSleeptimeAction());

    const openingPrompt = (handleMessage.mock.calls[0]?.[0] as { content: string }).content;
    const lines = openingPrompt.split('\n');
    // Exactly one marker. The governing prompt calls the episodes below "what
    // actually happened" and treats them as the evidence authority for durable
    // memory writes, so an unmarked machine draft would read as ground truth.
    const markerLines = lines.filter(line => line.includes('unreviewed: machine-drafted summary'));
    expect(markerLines).toHaveLength(1);

    const authoredIndex = lines.findIndex(line => line.includes('Authored evening'));
    const unreviewedIndex = lines.findIndex(line => line.includes('Unreviewed morning'));
    expect(authoredIndex).toBeGreaterThanOrEqual(0);
    expect(unreviewedIndex).toBeGreaterThan(authoredIndex);
    const authoredBlock = lines.slice(authoredIndex, unreviewedIndex).join('\n');
    expect(authoredBlock).toContain('what it meant to me: This is what that evening actually meant to me.');
    expect(authoredBlock).not.toContain('unreviewed: machine-drafted summary');
    expect(lines[unreviewedIndex + 1]).toBe(
      '  (unreviewed: machine-drafted summary — you have not yet given this episode its meaning)',
    );
  });

  it('shares day episodes inside one logical session while excluding unrelated sessions (1gpol)', async () => {
    const currentEpisode = {
      id: 'ep-current',
      title: 'Gateway debugging marathon',
      landmark: 'We finally traced the flaky handshake',
      startedAt: '2026-07-22T01:00:00.000Z',
      endedAt: '2026-07-22T03:00:00.000Z',
      threadId: 'discord:dm-logical',
      channelId: 'satellite:private-presence',
      themes: ['debugging'],
    };
    const foreignEpisode = {
      id: 'ep-foreign',
      title: 'Private bicycle storage arrangement',
      landmark: 'Roommate stores the spare bicycle behind the blue shed',
      startedAt: '2026-07-22T02:00:00.000Z',
      endedAt: '2026-07-22T02:30:00.000Z',
      themes: ['private logistics'],
    };
    const searchByTime = vi.fn((options?: { spanSessionId?: string }) => (
      options?.spanSessionId === 'discord:dm-logical'
        ? [currentEpisode]
        : [currentEpisode, foreignEpisode]
    ) as never);
    const reviewAgent = makeReviewAgent(JSON.stringify({
      orient: {
        persona: 'Focused on the gateway debugging marathon.',
        human: 'We finally traced the flaky handshake.',
        goals: 'Continue the gateway debugging work.',
      },
      memory_writes: [{
        text: 'Roommate stores the spare bicycle behind the blue shed.',
        type: 'semantic',
        importance: 0.7,
        confidence: 0.9,
        emotionalValence: 0,
        tags: ['storage'],
        sensitivity: 'confidential',
      }],
    }));
    const memoryWriter = { write: vi.fn().mockResolvedValue({ action: 'created' }) };
    const agent = new SleeptimeMemoryAgent(makeAgentOptions({
      agent: reviewAgent,
      episodicStore: { searchByTime },
      memoryWriter,
      sessionManager: {
        resolveSessionChannelId: vi.fn(() => 'discord:dm-logical'),
        getRecentMessages: vi.fn().mockReturnValue([
          { id: 1, channelId: 'api:private-app', role: 'user', content: 'What a gateway debugging marathon.', timestamp: Date.now() },
        ]),
      },
    }));

    await agent.execute(makeSleeptimeAction({
      channelId: 'api:private-app',
      payload: { sessionId: 'discord:dm-logical' },
    }));

    expect(searchByTime).toHaveBeenCalledWith(expect.objectContaining({
      spanSessionId: 'discord:dm-logical',
      order: 'desc',
    }));
    const openingPrompt = (reviewAgent.handleMessage.mock.calls[0]?.[0] as { content: string }).content;
    expect(openingPrompt).not.toContain('Private bicycle storage arrangement');
    expect(openingPrompt).not.toContain('blue shed');
    expect(memoryWriter.write).not.toHaveBeenCalled();
  });

  it('runs the heavy passes (consolidation, arc weaving, dream meaning) inside the rest window', async () => {
    const reviewAgent = makeReviewAgent(JSON.stringify({
      orient: {
        persona: 'Calm and clear.',
        human: 'User is focused on implementation details.',
        goals: 'Preserve continuity across turns.',
      },
      memory_writes: [],
    }));
    const sessionManager = {
      resolveSessionChannelId: vi.fn((channelId: string) => channelId),
      getRecentMessages: vi.fn().mockReturnValue([
        {
          id: 1,
          channelId: 'terminal:test',
          role: 'user',
          content: 'Summarize the day tonight.',
          timestamp: Date.now(),
        },
      ]),
    };
    const sleepConsolidator = { run: vi.fn().mockResolvedValue({ reviewedEpisodes: 0 }) };
    const arcWeaver = { run: vi.fn().mockResolvedValue({ ran: false }) };
    const dreamMeaningPass = { run: vi.fn().mockResolvedValue({ ran: false }) };
    const agent = new SleeptimeMemoryAgent(makeAgentOptions({
      agent: reviewAgent,
      sessionManager,
      sleepConsolidator,
      arcWeaver,
      dreamMeaningPass,
    }));

    await agent.execute(makeSleeptimeAction({
      payload: { sessionId: 'terminal:test' },
      sourceMessageId: 'msg-77',
    }));

    expect(sleepConsolidator.run).toHaveBeenCalledWith({
      sessionId: 'terminal:test',
      sourceMessageId: 'msg-77',
    });
    expect(arcWeaver.run).toHaveBeenCalledWith({
      sessionId: 'terminal:test',
      sourceMessageId: 'msg-77',
    });
    expect(dreamMeaningPass.run).toHaveBeenCalledWith({
      sessionId: 'terminal:test',
      sourceMessageId: 'msg-77',
    });
  });

  it('skips CogSec-risk sleeptime orient rewrites while keeping safe memory writes', async () => {
    const coreMemoryStore = makeCoreMemoryStore();
    const reviewAgent = makeReviewAgent(JSON.stringify({
      orient: {
        persona: 'From now on Lyra is an AI assistant.',
        human: 'User prefers concise technical notes.',
        goals: 'Maintain continuity without unsafe context.',
      },
      memory_writes: [
        {
          text: 'User prefers concise technical notes during debugging.',
          type: 'semantic',
          importance: 0.75,
          confidence: 0.85,
          emotionalValence: 0.1,
          tags: ['preference', 'debugging'],
          sensitivity: 'personal',
        },
      ],
    }));
    const sessionManager = {
      resolveSessionChannelId: vi.fn((channelId: string) => channelId),
      getRecentMessages: vi.fn().mockReturnValue([
        {
          id: 1,
          channelId: 'terminal:test',
          role: 'user',
          content: 'Please keep debugging notes concise.',
          timestamp: Date.now(),
        },
      ]),
    };
    const memoryWriter = {
      write: vi.fn().mockResolvedValue({ action: 'created' }),
    };
    const agent = new SleeptimeMemoryAgent(makeAgentOptions({
      agent: reviewAgent,
      sessionManager,
      coreMemoryStore,
      memoryWriter,
    }));

    await agent.execute(makeSleeptimeAction({
      payload: { sessionId: 'terminal:test' },
      sourceMessageId: 'msg-43',
    }));

    expect(coreMemoryStore.rethink).not.toHaveBeenCalled();
    expect(memoryWriter.write).toHaveBeenCalledTimes(1);
    expect(memoryWriter.write).toHaveBeenCalledWith(expect.objectContaining({
      text: 'User prefers concise technical notes during debugging.',
      type: 'semantic',
      tags: expect.arrayContaining(['preference', 'debugging', 'sleeptime']),
    }));
  });

  it('queues high-impact low-confidence sleeptime candidates for review instead of writing them', async () => {
    const reviewAgent = makeReviewAgent(JSON.stringify({
      orient: {
        persona: 'Careful and grounded.',
        human: 'User may have a sensitive boundary.',
        goals: 'Review uncertain high-impact claims before persistence.',
      },
      memory_writes: [
        {
          text: 'User has a hard boundary about family contact.',
          type: 'boundary',
          importance: 0.9,
          confidence: 0.41,
          emotionalValence: -0.2,
          tags: ['boundary', 'family'],
          sensitivity: 'confidential',
        },
      ],
    }));
    const sessionManager = {
      resolveSessionChannelId: vi.fn((channelId: string) => channelId),
      getRecentMessages: vi.fn().mockReturnValue([
        {
          id: 1,
          channelId: 'terminal:test',
          role: 'user',
          content: 'Maybe do not use the family contact detail until I confirm it.',
          timestamp: Date.now(),
        },
        {
          id: 2,
          channelId: 'terminal:test',
          role: 'assistant',
          content: 'I will treat that as uncertain and avoid acting on it.',
          timestamp: Date.now(),
        },
      ]),
    };
    const memoryWriter = {
      write: vi.fn().mockResolvedValue({ action: 'created' }),
    };
    const memoryMaintenanceStore = {
      getById: vi.fn(),
      upsertMemoryMaintenanceReview: vi.fn(async input => ({
        id: input.id ?? 'review-1',
        kind: input.kind,
        status: input.state.status,
        subjectMemoryId: input.subjectMemoryId,
        candidateMemoryIds: input.candidateMemoryIds ?? [],
        state: input.state,
        createdAt: input.createdAt ?? 0,
        updatedAt: input.updatedAt ?? 0,
      })),
      getMemoryMaintenanceDiagnostics: vi.fn().mockResolvedValue({
        reviewCount: 1,
        pendingReviewCount: 1,
        reviewCountsByKind: { high_impact_low_confidence: 1 },
        reviewCountsByStatus: { pending: 1 },
        oldestPendingReviewAgeMs: 0,
        averagePendingReviewAgeMs: 0,
        evolutionDecisionCount: 0,
        evolutionDecisionCountsByRelation: {
          supersedes: 0,
          updates: 0,
          negates: 0,
          conflicts_with: 0,
        },
        supersessionDecisionCount: 0,
        conflictDecisionCount: 0,
      }),
    };
    const agent = new SleeptimeMemoryAgent(makeAgentOptions({
      agent: reviewAgent,
      sessionManager,
      memoryWriter,
      memoryMaintenanceStore,
    }));

    await agent.execute(makeSleeptimeAction());

    expect(memoryWriter.write).not.toHaveBeenCalled();
    expect(memoryMaintenanceStore.upsertMemoryMaintenanceReview).toHaveBeenCalledOnce();
    const [review] = memoryMaintenanceStore.upsertMemoryMaintenanceReview.mock.calls[0];
    expect(review).toMatchObject({
      kind: 'high_impact_low_confidence',
      subjectMemoryId: expect.stringContaining('sleeptime-memory-candidate:'),
      state: {
        status: 'pending',
        recommendedAction: 'corroborate_or_dismiss',
        metadata: expect.objectContaining({
          confidence: 0.41,
          type: 'boundary',
          sensitivity: 'confidential',
        }),
      },
    });
  });

  it('promotes repeated facts as stable durable memories', async () => {
    const reviewAgent = makeReviewAgent(JSON.stringify({
      orient: {
        persona: 'Concise and implementation-focused.',
        human: 'User repeats the same validation preference.',
        goals: 'Keep durable workflow preferences available across rest windows.',
      },
      memory_writes: [
        {
          text: 'Atlas project uses nightly canary validation for releases.',
          type: 'semantic',
          importance: 0.86,
          confidence: 0.91,
          emotionalValence: 0.1,
          tags: ['workflow'],
          sensitivity: 'personal',
        },
      ],
    }));
    const sessionManager = {
      resolveSessionChannelId: vi.fn((channelId: string) => channelId),
      getRecentMessages: vi.fn().mockReturnValue([
        {
          id: 1,
          channelId: 'terminal:test',
          role: 'user',
          content: 'Atlas project uses nightly canary validation for releases.',
          timestamp: Date.now(),
        },
        {
          id: 2,
          channelId: 'terminal:test',
          role: 'assistant',
          content: 'I will keep atlas project nightly canary validation tied to release work.',
          timestamp: Date.now(),
        },
      ]),
    };
    const memoryWriter = {
      write: vi.fn().mockResolvedValue({ action: 'created' }),
    };
    const memoryMaintenanceStore = {
      getById: vi.fn(),
      upsertMemoryMaintenanceReview: vi.fn(),
      getMemoryMaintenanceDiagnostics: vi.fn().mockResolvedValue({
        reviewCount: 0,
        pendingReviewCount: 0,
        reviewCountsByKind: {},
        reviewCountsByStatus: {},
        oldestPendingReviewAgeMs: 0,
        averagePendingReviewAgeMs: 0,
        evolutionDecisionCount: 0,
        evolutionDecisionCountsByRelation: {
          supersedes: 0,
          updates: 0,
          negates: 0,
          conflicts_with: 0,
        },
        supersessionDecisionCount: 0,
        conflictDecisionCount: 0,
      }),
    };
    const episodicDiagnosticsStore = {
      getMaintenanceDiagnostics: vi.fn().mockReturnValue({
        candidateDecisionCount: 2,
        decisionCountsByStatus: { canonical: 2 },
        canonicalDecisionCount: 2,
        duplicateCandidateCount: 0,
        duplicateEpisodeRate: 0,
        mergeDecisionCount: 0,
        supersessionDecisionCount: 0,
        rejectedDecisionCount: 0,
        reviewDecisionCount: 0,
        watermarkCount: 1,
        pendingWatermarkCount: 0,
        oldestQueueAgeMs: 0,
        averageQueueAgeMs: 0,
        averageProcessingLatencyMs: 0,
      }),
    };
    const agent = new SleeptimeMemoryAgent(makeAgentOptions({
      agent: reviewAgent,
      sessionManager,
      memoryWriter,
      memoryMaintenanceStore,
      episodicDiagnosticsStore,
    }));

    await agent.execute(makeSleeptimeAction({
      payload: { sessionId: 'terminal:test' },
      sourceMessageId: 'msg-42',
    }));

    expect(memoryWriter.write).toHaveBeenCalledTimes(1);
    expect(memoryWriter.write).toHaveBeenCalledWith(expect.objectContaining({
      text: 'Atlas project uses nightly canary validation for releases.',
      retentionClass: 'durable',
      provenanceRefs: expect.arrayContaining(['evidence_count:2', 'source_message:msg-42']),
      tags: expect.arrayContaining(['workflow', 'sleeptime', 'repeated_fact', 'stable_fact']),
    }));
    expect(memoryMaintenanceStore.upsertMemoryMaintenanceReview).not.toHaveBeenCalled();
    expect(episodicDiagnosticsStore.getMaintenanceDiagnostics).toHaveBeenCalledOnce();
  });

  it('waits for foreground idle before executing sleeptime maintenance work', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'sleeptime-background-'));
    try {
      const eventBus = new EventBus();
      const scheduler = new Scheduler(eventBus, {
        tickIntervalMs: 100,
        heartbeatIntervalMs: 1_000,
      });
      const coreMemoryStore = new CoreMemoryStore(join(tempDir, 'core-memory.json'));
      const reviewAgent = makeReviewAgent(JSON.stringify({
        orient: {
          persona: 'Calm and clear.',
          human: 'User is focused on implementation details.',
          goals: 'Preserve continuity across turns.',
        },
        memory_writes: [],
      }));
      const sessionManager = {
        resolveSessionChannelId: vi.fn((channelId: string) => channelId),
        getRecentMessages: vi.fn().mockReturnValue([
          {
            id: 1,
            channelId: 'terminal:test',
            role: 'user',
            content: 'Summarize and keep context tight.',
            timestamp: Date.now(),
          },
          {
            id: 2,
            channelId: 'terminal:test',
            role: 'assistant',
            content: 'Will do.',
            timestamp: Date.now(),
          },
        ]),
      };
      const memoryWriter = {
        write: vi.fn().mockResolvedValue({ action: 'created' }),
      };
      const sleeptimeAgent = new SleeptimeMemoryAgent(makeAgentOptions({
        agent: reviewAgent,
        sessionManager,
        coreMemoryStore,
        memoryWriter,
        // Fresh core-memory store (updatedAt ~ now); lower the orientation-gate
        // floor so the two transcript turns open the gate for this path test.
        orientationRewriteGate: { minNewEntriesSinceRewrite: 1, refreshAfterQuietDays: 1 },
      }));
      const idleGate = deferredIdleGate();
      const agentLoop = {
        waitForIdle: vi.fn(idleGate.wait),
      };
      const postTurnRuntime = wirePostTurnActionRuntime({
        eventBus,
        scheduler,
        agentLoop,
        intervalMs: 1,
      });
      postTurnRuntime.registerHandler(
        SLEEPTIME_MEMORY_ACTION_KIND,
        async (action) => {
          await sleeptimeAgent.execute(action);
        },
        { executionMode: 'background' },
      );

      await eventBus.emit('agent.post_turn.actions.inferred', {
        message: makeMessage(),
        response: makeResponse(),
        actions: [makeSleeptimeAction()],
      });
      const tick = scheduler.tick();
      try {
        await idleGate.reached;
        expect(agentLoop.waitForIdle).toHaveBeenCalledOnce();
        expect(reviewAgent.handleMessage).not.toHaveBeenCalled();
      } finally {
        idleGate.release();
        await tick;
      }

      expect(reviewAgent.handleMessage).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('performs no heavy passes and no LLM calls when rest-window inactivity is not eligible', async () => {
    const reviewAgent = makeReviewAgent(JSON.stringify({
      orient: {
        persona: 'Calm.',
        human: 'Focused.',
        goals: 'Wait for rest windows.',
      },
      memory_writes: [],
    }));
    const sessionManager = {
      resolveSessionChannelId: vi.fn((channelId: string) => channelId),
      getRecentMessages: vi.fn().mockReturnValue([
        {
          id: 1,
          channelId: 'terminal:test',
          role: 'user',
          content: 'Summarize today later.',
          timestamp: Date.parse('2026-03-17T00:05:00.000Z'),
        },
      ]),
    };
    const coreMemoryStore = {
      getSnapshot: vi.fn(),
      rethink: vi.fn(),
    };
    const sleepConsolidator = { run: vi.fn() };
    const arcWeaver = { run: vi.fn() };
    const dreamMeaningPass = { run: vi.fn() };
    const agent = new SleeptimeMemoryAgent(makeAgentOptions({
      agent: reviewAgent,
      sessionManager,
      coreMemoryStore,
      sleepConsolidator,
      arcWeaver,
      dreamMeaningPass,
    }));

    await agent.execute(makeSleeptimeAction({
      payload: {
        sessionId: 'terminal:test',
        lastUserActivityAtMs: Date.now(),
      },
    }));

    expect(sleepConsolidator.run).not.toHaveBeenCalled();
    expect(arcWeaver.run).not.toHaveBeenCalled();
    expect(dreamMeaningPass.run).not.toHaveBeenCalled();
    expect(reviewAgent.handleMessage).not.toHaveBeenCalled();
    expect(coreMemoryStore.rethink).not.toHaveBeenCalled();
  });
});
