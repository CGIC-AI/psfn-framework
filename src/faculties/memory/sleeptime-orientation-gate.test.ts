import { describe, it, expect, vi } from 'vitest';
import type { LLMProviderPort } from '../../core/agent/contracts.js';
import type { DeterministicGateEvent } from '../../shared/event-bus.js';
import type { EpisodicProcessingRestWindowConfig } from '../../system/config/scheduler-config.js';
import {
  SleeptimeMemoryAgent,
  SLEEPTIME_MEMORY_ACTION_KIND,
  type SleeptimeMemoryAgentOptions,
} from './sleeptime-agent.js';

const NOW_MS = Date.parse('2026-07-02T04:00:00.000Z');
const DAY_MS = 24 * 60 * 60_000;

function alwaysOpenRestWindow(): EpisodicProcessingRestWindowConfig {
  return {
    enabled: true,
    startLocalTime: '00:00',
    endLocalTime: '00:00',
    timeZone: 'UTC',
    inactivityThresholdMinutes: 60,
  };
}

function makeLLMProvider(): LLMProviderPort {
  return {
    stream: vi.fn(),
    complete: vi.fn(async () => ({
      content: JSON.stringify({
        orient: { persona: 'p', human: 'h', goals: 'g' },
        memory_writes: [],
      }),
      toolCalls: [],
      model: 'm',
      inputTokens: 1,
      outputTokens: 1,
      stopReason: 'done',
    })),
  } as unknown as LLMProviderPort;
}

function makeSnapshot(updatedAtMs: number) {
  return {
    version: 1,
    updatedAt: new Date(updatedAtMs).toISOString(),
    blocks: {
      // Non-empty: an already-oriented companion, so the baseline (updatedAt)
      // governs the gate rather than the first-rewrite fail-open path.
      persona: { label: 'persona', content: 'Existing persona.', maxChars: 2400 },
      human: { label: 'human', content: 'Existing human notes.', maxChars: 2400, trustLevel: 'trusted' },
      goals: { label: 'goals', content: 'Existing goals.', maxChars: 1600 },
    },
  };
}

function makeEntries(count: number, timestamp: number) {
  return Array.from({ length: count }, (_unused, index) => ({
    id: index + 1,
    channelId: 'terminal:test',
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message ${String(index)}`,
    timestamp,
  }));
}

function makeAgent(input: {
  updatedAtMs: number;
  entries: ReturnType<typeof makeEntries>;
  events: DeterministicGateEvent[];
}): { agent: SleeptimeMemoryAgent; llmProvider: LLMProviderPort; rethink: ReturnType<typeof vi.fn> } {
  const llmProvider = makeLLMProvider();
  const rethink = vi.fn();
  const options: SleeptimeMemoryAgentOptions = {
    llmProvider,
    sessionManager: {
      resolveSessionChannelId: vi.fn((channelId: string) => channelId),
      getRecentMessages: vi.fn().mockReturnValue(input.entries),
    },
    coreMemoryStore: {
      getSnapshot: vi.fn().mockReturnValue(makeSnapshot(input.updatedAtMs)),
      rethink,
    },
    memoryWriter: { write: vi.fn().mockResolvedValue({ action: 'created' }) },
    restWindow: alwaysOpenRestWindow(),
    orientationRewriteGate: { minNewEntriesSinceRewrite: 4, refreshAfterQuietDays: 7 },
    onGateEvent: (event) => input.events.push(event),
    now: () => NOW_MS,
  };
  return { agent: new SleeptimeMemoryAgent(options), llmProvider, rethink };
}

function makeAction() {
  return {
    id: 'sleeptime-action-1',
    kind: SLEEPTIME_MEMORY_ACTION_KIND,
    payload: { sessionId: 'terminal:test' },
    dedupeKey: `${SLEEPTIME_MEMORY_ACTION_KIND}:terminal:test`,
    channelId: 'terminal:test',
    sourceMessageId: 'msg-1',
    inferredAt: NOW_MS,
  };
}

describe('SleeptimeMemoryAgent orientation-rewrite gate (jpvd.4)', () => {
  it('skips the orient plan LLM call with zero spend when nothing changed', async () => {
    const events: DeterministicGateEvent[] = [];
    // Rewritten yesterday, only 2 new turns since => below the 4-turn minimum
    // and not stale (1 day < 7) => gate closed.
    const { agent, llmProvider, rethink } = makeAgent({
      updatedAtMs: NOW_MS - DAY_MS,
      entries: makeEntries(2, NOW_MS - 60_000),
      events,
    });

    await agent.execute(makeAction());

    expect(llmProvider.complete).not.toHaveBeenCalled();
    expect(rethink).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      lane: 'orientation_rewrite',
      outcome: 'skipped',
      reason: 'no_change',
      sessionId: 'terminal:test',
    });
    expect(events[0].inputs.newEntriesSinceRewrite).toBe(2);
  });

  it('runs the orient rewrite when enough new turns accumulated since the last rewrite', async () => {
    const events: DeterministicGateEvent[] = [];
    const { agent, llmProvider, rethink } = makeAgent({
      updatedAtMs: NOW_MS - DAY_MS,
      entries: makeEntries(5, NOW_MS - 60_000),
      events,
    });

    await agent.execute(makeAction());

    expect(llmProvider.complete).toHaveBeenCalledOnce();
    expect(rethink).toHaveBeenCalledOnce();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      lane: 'orientation_rewrite',
      outcome: 'ran',
      reason: 'evidence_of_change',
    });
  });

  it('re-opens on any activity once the last rewrite is stale beyond the quiet-day floor', async () => {
    const events: DeterministicGateEvent[] = [];
    // Only 1 new turn (below the 4 minimum) but the last rewrite is 30 days old.
    const { agent, llmProvider } = makeAgent({
      updatedAtMs: NOW_MS - 30 * DAY_MS,
      entries: makeEntries(1, NOW_MS - 60_000),
      events,
    });

    await agent.execute(makeAction());

    expect(llmProvider.complete).toHaveBeenCalledOnce();
    expect(events[0].outcome).toBe('ran');
  });
});
