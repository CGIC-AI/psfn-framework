import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, vi } from 'vitest';
import type { LLMProvider } from '../../core/agent/contracts.js';
import type { InferredPostTurnAction, SubstrateMessage, AgentResponse } from '../../shared/contracts/runtime.js';
import { EventBus } from '../../shared/event-bus.js';
import { Scheduler } from '../../core/scheduler/scheduler.js';
import { wirePostTurnActionRuntime } from '../../app/startup/composition/post-turn-actions.js';
import { CoreMemoryStore } from '../core-memory/store.js';
import {
  SleeptimeMemoryAgent,
  SLEEPTIME_MEMORY_ACTION_KIND,
} from './sleeptime-agent.js';

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

function makeLLMProvider(content: string): LLMProvider {
  return {
    stream: vi.fn(async () => ({
      content: '',
      toolCalls: [],
      model: 'unused',
      inputTokens: 0,
      outputTokens: 0,
      stopReason: 'done',
    })),
    complete: vi.fn(async () => ({
      content,
      toolCalls: [],
      model: 'context-model',
      inputTokens: 64,
      outputTokens: 42,
      stopReason: 'done',
    })),
  };
}

describe('SleeptimeMemoryAgent', () => {
  it('triggers post-turn actions on configured cadence for external sessions', () => {
    const llmProvider = makeLLMProvider('{}');
    const sessionManager = {
      resolveSessionChannelId: vi.fn((channelId: string) => channelId),
      getRecentMessages: vi.fn().mockReturnValue([]),
    };
    const coreMemoryStore = {
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
    const memoryWriter = {
      write: vi.fn(),
    };
    const agent = new SleeptimeMemoryAgent({
      llmProvider,
      sessionManager,
      coreMemoryStore,
      memoryWriter,
      cadenceTurns: 3,
    });

    expect(agent.inferPostTurnAction({ id: 'm1', channelId: 'terminal:alpha' })).toBeNull();
    expect(agent.inferPostTurnAction({ id: 'm2', channelId: 'terminal:alpha' })).toBeNull();
    const third = agent.inferPostTurnAction({ id: 'm3', channelId: 'terminal:alpha' });
    expect(third).toMatchObject({
      kind: SLEEPTIME_MEMORY_ACTION_KIND,
      dedupeKey: `${SLEEPTIME_MEMORY_ACTION_KIND}:terminal:alpha`,
      payload: {
        sessionId: 'terminal:alpha',
        cadenceTurn: 3,
      },
    });
    expect(agent.inferPostTurnAction({ id: 'm4', channelId: 'internal:reflection:whisper' })).toBeNull();
  });

  it('rewrites core memory and writes memory facts from a sleeptime plan', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'sleeptime-core-memory-'));
    try {
      const coreMemoryStore = new CoreMemoryStore(join(tempDir, 'core-memory.json'));
      const llmProvider = makeLLMProvider(JSON.stringify({
        core_memory: {
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
        ]),
      };
      const memoryWriter = {
        write: vi.fn().mockResolvedValue({ action: 'created' }),
      };
      const agent = new SleeptimeMemoryAgent({
        llmProvider,
        sessionManager,
        coreMemoryStore,
        memoryWriter,
        cadenceTurns: 1,
      });

      await agent.execute(makeSleeptimeAction({
        payload: { sessionId: 'terminal:test' },
        sourceMessageId: 'msg-42',
      }));

      const snapshot = coreMemoryStore.getSnapshot();
      expect(snapshot.blocks.persona.content).toContain('Warm, direct, and practical');
      expect(snapshot.blocks.human.content).toContain('Primary user prefers concise answers');
      expect(snapshot.blocks.goals.content).toContain('track unresolved commitments');
      expect(memoryWriter.write).toHaveBeenCalledTimes(2);
      expect(memoryWriter.write).toHaveBeenCalledWith(expect.objectContaining({
        type: 'semantic',
        sourceRef: expect.stringContaining('source:sleeptime|session:terminal:test|message:msg-42'),
        tags: expect.arrayContaining(['preferences', 'coding', 'sleeptime']),
      }));
      expect((llmProvider.complete as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
        expect.objectContaining({
          correlation: expect.objectContaining({
            callType: 'memory',
            purpose: 'memory.sleeptime.plan',
            originType: 'memory',
            originStage: 'memory.sleeptime.plan',
            channelId: 'terminal:test',
          }),
        }),
        'memory',
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('executes sleeptime actions in background mode without waiting for idle foreground turns', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'sleeptime-background-'));
    try {
      const eventBus = new EventBus();
      const scheduler = new Scheduler(eventBus, {
        tickIntervalMs: 100,
        heartbeatIntervalMs: 1_000,
      });
      const coreMemoryStore = new CoreMemoryStore(join(tempDir, 'core-memory.json'));
      const llmProvider = makeLLMProvider(JSON.stringify({
        core_memory: {
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
      const sleeptimeAgent = new SleeptimeMemoryAgent({
        llmProvider,
        sessionManager,
        coreMemoryStore,
        memoryWriter,
      });
      const agentLoop = {
        waitForIdle: vi.fn().mockImplementation(() => new Promise<void>(() => {})),
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
      await scheduler.tick();

      expect(agentLoop.waitForIdle).not.toHaveBeenCalled();
      expect((llmProvider.complete as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
