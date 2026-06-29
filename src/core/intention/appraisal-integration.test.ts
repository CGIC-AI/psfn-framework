import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { PostTurnActionInferer } from '../agent/substrate-agent.js';
import { wireHeartbeatRuntime } from '../../app/startup/composition/parity.js';
import { wirePostTurnActionRuntime } from '../../app/startup/composition/post-turn-actions.js';
import { EventBus } from '../../shared/event-bus.js';
import { Scheduler } from '../scheduler/scheduler.js';
import { InternalStateComputer } from '../self-model/state.js';
import type { AgentResponse, InferredPostTurnAction, SubstrateMessage } from '../../shared/contracts/runtime.js';
import { INTENTION_OUTBOUND_MESSAGE_ACTION_KIND } from './appraisal.js';

function makeMessage(): SubstrateMessage {
  return {
    id: 'msg-intention-runtime-1',
    channelId: 'api:test',
    channelType: 'api',
    authorId: 'user-1',
    authorName: 'User',
    content: 'Can you check in with me tomorrow?',
    timestamp: new Date(),
  };
}

function makeInternalState(overrides?: {
  vad?: { valence: number; arousal: number; dominance: number };
  mood?: { valence: number; arousal: number; dominance: number };
}): ReturnType<InternalStateComputer['computeState']> {
  return new InternalStateComputer().computeState({
    emotionState: {
      vad: overrides?.vad ?? { valence: -0.2, arousal: 0.3, dominance: -0.1 },
      mood: overrides?.mood ?? { valence: -0.15, arousal: 0.25, dominance: -0.05 },
      discrete: { concern: 0.7 },
      confidence: 0.8,
    },
    activeConcerns: [{
      id: 'concern-runtime-1',
      text: 'Follow up soon',
      priority: 'high',
      source: 'agent',
      createdAt: '2026-03-01T00:00:00.000Z',
      expiresAt: '2026-03-02T00:00:00.000Z',
      contactId: 'contact-primary',
    }],
    trustLevel: 'primary',
    contactId: 'contact-primary',
    sessionMetrics: {
      userMessageText: 'Can you check in with me tomorrow?',
      responseText: 'Absolutely, I can follow up.',
      toolCallCount: 0,
      recentTurnCount: 4,
      lastSeenDeltaSeconds: 60,
    },
  });
}

function makeResponse(internalState = makeInternalState()): AgentResponse {
  return {
    channelId: 'api:test',
    content: 'Absolutely, I can follow up.',
    metadata: {
      model: 'chat-model',
      inputTokens: 100,
      outputTokens: 50,
      durationMs: 12,
      internalState,
    },
  };
}

function makeOutboundAction(
  payload: Record<string, unknown>,
): InferredPostTurnAction {
  return {
    id: 'outbound-action-1',
    kind: INTENTION_OUTBOUND_MESSAGE_ACTION_KIND,
    payload,
    dedupeKey: 'outbound-action-1',
    channelId: 'primary-dm',
    sourceMessageId: 'source-message-1',
    inferredAt: Date.now(),
  };
}

function makePendingFollowUp() {
  return {
    id: 'pending-follow-up-1',
    content: 'Check in about the doctor call.',
    priority: 'high' as const,
    timing: 'scheduled' as const,
    createdAt: '2026-06-16T12:00:00.000Z',
    dueAt: '2026-07-17T12:00:00.000Z',
    channelId: 'primary-dm',
    channelType: 'discord' as const,
    authorId: 'system:intention',
    authorName: 'Whisper',
  };
}

function registerOutboundHandlerHarness(options: {
  pendingFollowUp?: ReturnType<typeof makePendingFollowUp> & { activatedAt?: string };
  activeConcernIds?: string[];
}) {
  const tempDir = mkdtempSync(join(tmpdir(), 'psfn-intention-outbound-'));
  const eventBus = new EventBus();
  const scheduler = new Scheduler(eventBus, {
    tickIntervalMs: 50,
    heartbeatIntervalMs: 1_000,
  });
  const postTurnActions = {
    registerHandler: vi.fn().mockReturnValue(() => {}),
    listQueued: vi.fn().mockReturnValue([]),
    getStatus: vi.fn(),
  };
  const dispatch = vi.fn().mockResolvedValue({ outcome: 'sent' });
  const onIntentionFollowUpActivated = vi.fn();
  const pendingFollowUpStore = {
    enqueue: vi.fn(),
    peek: vi.fn().mockResolvedValue(options.pendingFollowUp ?? null),
    dequeue: vi.fn(),
    quarantine: vi.fn(),
    list: vi.fn(),
    listQuarantined: vi.fn(),
  };

  wireHeartbeatRuntime(
    { registerTool: vi.fn() },
    scheduler,
    {
      handleMessage: vi.fn(),
      followUp: vi.fn(),
      waitForIdle: vi.fn(),
      registerPostTurnActionInferer: vi.fn().mockReturnValue(() => {}),
    } as any,
    { send: vi.fn() },
    tempDir,
    undefined,
    {
      eventBus,
      postTurnActions: postTurnActions as any,
      llmProvider: { stream: vi.fn(), complete: vi.fn() } as any,
      proactiveOutbound: { dispatch },
      pendingFollowUpStore: pendingFollowUpStore as any,
      onIntentionFollowUpActivated,
      getActiveConcerns: () => (options.activeConcernIds ?? []).map(id => ({ id })),
    },
  );

  const outboundRegistration = postTurnActions.registerHandler.mock.calls.find(
    call => call[0] === INTENTION_OUTBOUND_MESSAGE_ACTION_KIND,
  );
  const handler = outboundRegistration?.[1] as ((action: InferredPostTurnAction) => Promise<{ detail?: string } | void>) | undefined;
  if (!handler) {
    rmSync(tempDir, { recursive: true, force: true });
    throw new Error('Outbound handler was not registered');
  }

  return {
    handler,
    dispatch,
    onIntentionFollowUpActivated,
    pendingFollowUpStore,
    cleanup: () => rmSync(tempDir, { recursive: true, force: true }),
  };
}

describe('intention appraisal runtime integration', () => {
  it('blocks stale outbound actions when their linked concern has been cleared', async () => {
    const harness = registerOutboundHandlerHarness({
      pendingFollowUp: makePendingFollowUp(),
      activeConcernIds: [],
    });
    try {
      const result = await harness.handler(makeOutboundAction({
        channelId: 'primary-dm',
        channelType: 'discord',
        content: 'Remember to call the doctor.',
        pendingFollowUpId: 'pending-follow-up-1',
        concernIds: ['cleared-concern-1'],
      }));

      expect(result).toEqual({ detail: 'blocked:stale_concern' });
      expect(harness.dispatch).not.toHaveBeenCalled();
      expect(harness.onIntentionFollowUpActivated).not.toHaveBeenCalled();
      expect(harness.pendingFollowUpStore.dequeue).not.toHaveBeenCalled();
    } finally {
      harness.cleanup();
    }
  });

  it('does not activate pending follow-ups after successful external outbound sends', async () => {
    const harness = registerOutboundHandlerHarness({
      pendingFollowUp: makePendingFollowUp(),
      activeConcernIds: ['active-concern-1'],
    });
    try {
      const result = await harness.handler(makeOutboundAction({
        channelId: 'primary-dm',
        channelType: 'discord',
        content: 'Remember to call the doctor.',
        pendingFollowUpId: 'pending-follow-up-1',
        concernIds: ['active-concern-1'],
      }));

      expect(result).toEqual({ detail: 'sent' });
      expect(harness.dispatch).toHaveBeenCalledTimes(1);
      expect(harness.onIntentionFollowUpActivated).not.toHaveBeenCalled();
      expect(harness.pendingFollowUpStore.dequeue).not.toHaveBeenCalled();
    } finally {
      harness.cleanup();
    }
  });

  it('dispatches follow-up actions asynchronously through post-turn runtime', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'psfn-intention-'));
    const nowSpy = vi.spyOn(Date, 'now');
    try {
      nowSpy.mockReturnValue(1_700_000_400_000);
      const eventBus = new EventBus();
      const scheduler = new Scheduler(eventBus, {
        tickIntervalMs: 50,
        heartbeatIntervalMs: 1_000,
      });
      const inferers: PostTurnActionInferer[] = [];
      const agentLoop = {
        handleMessage: vi.fn().mockResolvedValue({ content: 'ok' }),
        followUp: vi.fn(),
        waitForIdle: vi.fn().mockResolvedValue(undefined),
        registerPostTurnActionInferer: vi.fn((inferer: PostTurnActionInferer) => {
          inferers.push(inferer);
          return () => {};
        }),
      };
      const sender = {
        send: vi.fn().mockResolvedValue(undefined),
      };
      const llmProvider = {
        stream: vi.fn(),
        complete: vi.fn().mockResolvedValue({
          content: JSON.stringify({
            decisions: [{
              type: 'followUp',
              priority: 'high',
              reason: 'Proactive check-in requested by user.',
              timing: 'soon',
              followUp: {
                content: 'Quick follow-up: how are you doing today?',
              },
            }],
          }),
          model: 'background-model',
          toolCalls: [],
          inputTokens: 48,
          outputTokens: 31,
          stopReason: 'stop',
        }),
      };

      const postTurnActions = wirePostTurnActionRuntime({
        eventBus,
        scheduler,
        agentLoop,
        intervalMs: 1,
      });

      wireHeartbeatRuntime(
        { registerTool: vi.fn() },
        scheduler,
        agentLoop,
        sender,
        tempDir,
        undefined,
        {
          eventBus,
          postTurnActions,
          llmProvider: llmProvider as any,
          sessionManager: {
            resolveSessionChannelId: (channelId: string) => channelId,
            getRecentMessages: vi.fn().mockReturnValue([]),
          } as any,
          getActiveConcerns: () => [{
            title: 'Follow up soon',
            dueAt: Date.now() + 1_000,
            status: 'active',
          }],
          emotionState: {
            getState: () => ({
              vad: { valence: -0.2, arousal: 0.3, dominance: -0.1 },
              mood: { valence: -0.15, arousal: 0.25, dominance: -0.05 },
              discrete: { concern: 0.7 },
              confidence: 0.8,
            }),
          },
        },
      );

      expect(inferers).toHaveLength(1);
      const inferer = inferers[0]!;
      const message = makeMessage();
      const response = makeResponse();
      const inferred = await inferer({
        message,
        response,
        turnMessages: [],
        turnId: 'turn-intention-1' as any,
        completedAt: Date.now(),
      } as any);
      expect(inferred).toEqual([]);

      await Promise.resolve();
      await Promise.resolve();
      await scheduler.tick();

      expect(llmProvider.complete).toHaveBeenCalledTimes(1);
      expect(llmProvider.complete.mock.calls[0]?.[1]).toBe('background');
      const promptPayload = JSON.parse(
        String(llmProvider.complete.mock.calls[0]?.[0]?.messages?.[0]?.content ?? '{}'),
      ) as { internalState?: unknown };
      expect(promptPayload.internalState).toBeDefined();
      expect(agentLoop.waitForIdle).not.toHaveBeenCalled();

      await scheduler.tick();
      expect(agentLoop.followUp).not.toHaveBeenCalled();

      nowSpy.mockReturnValue(1_700_000_700_001);
      await scheduler.tick();
      expect(agentLoop.followUp).toHaveBeenCalledTimes(1);
      expect(agentLoop.followUp).toHaveBeenCalledWith(expect.objectContaining({
        channelId: 'api:test',
        channelType: 'api',
        content: 'Quick follow-up: how are you doing today?',
      }));
    } finally {
      nowSpy.mockRestore();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('reopens pending follow-ups immediately on internal background turns', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'psfn-intention-internal-'));
    const nowSpy = vi.spyOn(Date, 'now');
    try {
      nowSpy.mockReturnValue(1_700_000_400_000);
      const eventBus = new EventBus();
      const scheduler = new Scheduler(eventBus, {
        tickIntervalMs: 50,
        heartbeatIntervalMs: 1_000,
      });
      const inferers: PostTurnActionInferer[] = [];
      const agentLoop = {
        handleMessage: vi.fn().mockResolvedValue({ content: 'ok' }),
        followUp: vi.fn(),
        waitForIdle: vi.fn().mockResolvedValue(undefined),
        registerPostTurnActionInferer: vi.fn((inferer: PostTurnActionInferer) => {
          inferers.push(inferer);
          return () => {};
        }),
      };
      const sender = {
        send: vi.fn().mockResolvedValue(undefined),
      };
      const llmProvider = {
        stream: vi.fn(),
        complete: vi.fn().mockResolvedValue({
          content: JSON.stringify({
            decisions: [{
              type: 'followUp',
              priority: 'high',
              reason: 'Background check should surface the pending reminder now.',
              timing: 'soon',
              followUp: {
                content: 'Quick follow-up: how are you doing today?',
              },
            }],
          }),
          model: 'background-model',
          toolCalls: [],
          inputTokens: 48,
          outputTokens: 31,
          stopReason: 'stop',
        }),
      };

      const postTurnActions = wirePostTurnActionRuntime({
        eventBus,
        scheduler,
        agentLoop,
        intervalMs: 1,
      });

      wireHeartbeatRuntime(
        { registerTool: vi.fn() },
        scheduler,
        agentLoop,
        sender,
        tempDir,
        undefined,
        {
          eventBus,
          postTurnActions,
          llmProvider: llmProvider as any,
          sessionManager: {
            resolveSessionChannelId: (channelId: string) => channelId,
            getRecentMessages: vi.fn().mockReturnValue([]),
          } as any,
          getActiveConcerns: () => [{
            title: 'Follow up soon',
            dueAt: Date.now() + 1_000,
            status: 'active',
          }],
          emotionState: {
            getState: () => ({
              vad: { valence: -0.2, arousal: 0.3, dominance: -0.1 },
              mood: { valence: -0.15, arousal: 0.25, dominance: -0.05 },
              discrete: { concern: 0.7 },
              confidence: 0.8,
            }),
          },
        },
      );

      expect(inferers).toHaveLength(1);
      const inferer = inferers[0]!;
      await inferer({
        message: {
          ...makeMessage(),
          id: 'msg-intention-runtime-internal-1',
          channelId: 'internal:reflection:whisper',
          channelType: 'terminal',
        },
        response: makeResponse(),
        turnMessages: [],
        turnId: 'turn-intention-internal-1' as any,
        completedAt: Date.now(),
      } as any);

      await Promise.resolve();
      await Promise.resolve();
      await scheduler.tick();

      expect(llmProvider.complete).toHaveBeenCalledTimes(1);
      expect(agentLoop.followUp).toHaveBeenCalledTimes(1);
      expect(agentLoop.followUp).toHaveBeenCalledWith(expect.objectContaining({
        channelId: 'internal:reflection:whisper',
        channelType: 'terminal',
        content: 'Quick follow-up: how are you doing today?',
      }));
    } finally {
      nowSpy.mockRestore();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('defers intention follow-up execution until dueAt timestamp', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'psfn-intention-scheduled-'));
    const nowSpy = vi.spyOn(Date, 'now');

    try {
      nowSpy.mockReturnValue(1_700_000_500_000);
      const eventBus = new EventBus();
      const scheduler = new Scheduler(eventBus, {
        tickIntervalMs: 50,
        heartbeatIntervalMs: 1_000,
      });
      const inferers: PostTurnActionInferer[] = [];
      const agentLoop = {
        handleMessage: vi.fn().mockResolvedValue({ content: 'ok' }),
        followUp: vi.fn(),
        waitForIdle: vi.fn().mockResolvedValue(undefined),
        registerPostTurnActionInferer: vi.fn((inferer: PostTurnActionInferer) => {
          inferers.push(inferer);
          return () => {};
        }),
      };
      const sender = {
        send: vi.fn().mockResolvedValue(undefined),
      };
      const llmProvider = {
        stream: vi.fn(),
        complete: vi.fn().mockResolvedValue({
          content: JSON.stringify({
            decisions: [{
              type: 'followUp',
              priority: 'high',
              reason: 'User asked for later check-in.',
              timing: 'scheduled',
              dueAt: 1_700_000_500_300,
              followUp: {
                content: 'Scheduled follow-up: checking in now.',
              },
            }],
          }),
          model: 'background-model',
          toolCalls: [],
          inputTokens: 48,
          outputTokens: 31,
          stopReason: 'stop',
        }),
      };

      const postTurnActions = wirePostTurnActionRuntime({
        eventBus,
        scheduler,
        agentLoop,
        intervalMs: 1,
      });

      wireHeartbeatRuntime(
        { registerTool: vi.fn() },
        scheduler,
        agentLoop,
        sender,
        tempDir,
        undefined,
        {
          eventBus,
          postTurnActions,
          llmProvider: llmProvider as any,
          sessionManager: {
            resolveSessionChannelId: (channelId: string) => channelId,
            getRecentMessages: vi.fn().mockReturnValue([]),
          } as any,
          getActiveConcerns: () => [{
            title: 'Follow up soon',
            dueAt: Date.now() + 1_000,
            status: 'active',
          }],
          emotionState: {
            getState: () => ({
              vad: { valence: -0.2, arousal: 0.3, dominance: -0.1 },
              mood: { valence: -0.15, arousal: 0.25, dominance: -0.05 },
              discrete: { concern: 0.7 },
              confidence: 0.8,
            }),
          },
        },
      );

      expect(inferers).toHaveLength(1);
      const inferer = inferers[0]!;
      await inferer({
        message: makeMessage(),
        response: makeResponse(),
        turnMessages: [],
        turnId: 'turn-intention-scheduled-1' as any,
        completedAt: Date.now(),
      } as any);

      await new Promise(resolve => setTimeout(resolve, 60));
      await Promise.resolve();
      await Promise.resolve();

      nowSpy.mockReturnValue(1_700_000_500_250);
      await scheduler.tick();
      expect(agentLoop.followUp).toHaveBeenCalledTimes(0);

      for (let offset = 0; offset < 5 && agentLoop.followUp.mock.calls.length === 0; offset += 1) {
        nowSpy.mockReturnValue(1_700_000_500_360 + (offset * 60));
        await scheduler.tick();
        await Promise.resolve();
      }
      expect(agentLoop.followUp).toHaveBeenCalledTimes(1);
      expect(agentLoop.followUp).toHaveBeenCalledWith(expect.objectContaining({
        content: 'Scheduled follow-up: checking in now.',
      }));
    } finally {
      nowSpy.mockRestore();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('forces appraisal on sustained primary-contact negative mood without immediate foreground hijack', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'psfn-intention-motivation-'));
    const nowSpy = vi.spyOn(Date, 'now');
    try {
      nowSpy.mockReturnValue(1_700_000_500_000);
      const eventBus = new EventBus();
      const scheduler = new Scheduler(eventBus, {
        tickIntervalMs: 50,
        heartbeatIntervalMs: 1_000,
      });
      const inferers: PostTurnActionInferer[] = [];
      const agentLoop = {
        handleMessage: vi.fn().mockResolvedValue({ content: 'ok' }),
        followUp: vi.fn(),
        waitForIdle: vi.fn().mockResolvedValue(undefined),
        registerPostTurnActionInferer: vi.fn((inferer: PostTurnActionInferer) => {
          inferers.push(inferer);
          return () => {};
        }),
      };
      const sender = {
        send: vi.fn().mockResolvedValue(undefined),
      };
      const llmProvider = {
        stream: vi.fn(),
        complete: vi.fn().mockResolvedValue({
          content: JSON.stringify({
            decisions: [{
              type: 'followUp',
              priority: 'medium',
              reason: 'Sustained negative mood requires a proactive check-in.',
              timing: 'soon',
              followUp: {
                content: 'Checking in because your mood has stayed low.',
              },
            }],
          }),
          model: 'background-model',
          toolCalls: [],
          inputTokens: 44,
          outputTokens: 29,
          stopReason: 'stop',
        }),
      };
      const emotionSnapshots = [{
        vad: { valence: -0.2, arousal: 0.1, dominance: -0.1 },
        mood: { valence: -0.28, arousal: 0.05, dominance: -0.1 },
        discrete: { sadness: 0.6 },
        confidence: 0.9,
      }, {
        vad: { valence: -0.22, arousal: 0.09, dominance: -0.1 },
        mood: { valence: -0.29, arousal: 0.04, dominance: -0.1 },
        discrete: { sadness: 0.62 },
        confidence: 0.9,
      }];
      let emotionIndex = 0;
      const emotionState = {
        getState: vi.fn(() => {
          const snapshot = emotionSnapshots[Math.min(emotionIndex, emotionSnapshots.length - 1)];
          emotionIndex += 1;
          return snapshot;
        }),
      };

      const postTurnActions = wirePostTurnActionRuntime({
        eventBus,
        scheduler,
        agentLoop,
        intervalMs: 1,
      });

      wireHeartbeatRuntime(
        { registerTool: vi.fn() },
        scheduler,
        agentLoop,
        sender,
        tempDir,
        undefined,
        {
          eventBus,
          postTurnActions,
          llmProvider: llmProvider as any,
          sessionManager: {
            resolveSessionChannelId: (channelId: string) => channelId,
            getRecentMessages: vi.fn().mockReturnValue([]),
          } as any,
          emotionState,
          contactStore: {
            getById: () => ({ trustLevel: 'primary' }),
            getEmotionalTimeSeries: () => [],
          },
        },
      );

      expect(inferers).toHaveLength(1);
      const inferer = inferers[0]!;
      const firstMessage = {
        ...makeMessage(),
        id: 'msg-intention-motivation-1',
        content: 'I am feeling a bit off.',
      };
      const secondMessage = {
        ...makeMessage(),
        id: 'msg-intention-motivation-2',
        content: 'Still feeling the same low mood.',
      };
      const firstResponse = makeResponse(makeInternalState({
        vad: { valence: -0.2, arousal: 0.1, dominance: -0.1 },
        mood: { valence: -0.28, arousal: 0.05, dominance: -0.1 },
      }));
      const secondResponse = makeResponse(makeInternalState({
        vad: { valence: -0.22, arousal: 0.09, dominance: -0.1 },
        mood: { valence: -0.29, arousal: 0.04, dominance: -0.1 },
      }));

      await inferer({
        message: firstMessage,
        response: firstResponse,
        turnMessages: [],
        canonicalContactKey: 'contact-primary',
        turnId: 'turn-intention-motivation-1' as any,
        completedAt: Date.now(),
      } as any);
      await Promise.resolve();
      await Promise.resolve();
      await scheduler.tick();

      expect(llmProvider.complete).toHaveBeenCalledTimes(0);
      expect(agentLoop.followUp).toHaveBeenCalledTimes(0);

      await inferer({
        message: secondMessage,
        response: secondResponse,
        turnMessages: [],
        canonicalContactKey: 'contact-primary',
        turnId: 'turn-intention-motivation-2' as any,
        completedAt: Date.now(),
      } as any);
      await new Promise(resolve => setTimeout(resolve, 60));
      for (let index = 0; index < 3; index += 1) {
        await Promise.resolve();
        await scheduler.tick();
      }

      expect(llmProvider.complete).toHaveBeenCalledTimes(1);
      expect(agentLoop.followUp).toHaveBeenCalledTimes(0);

      nowSpy.mockReturnValue(1_700_000_800_001);
      await scheduler.tick();

      expect(agentLoop.followUp).toHaveBeenCalledTimes(1);
      expect(agentLoop.followUp).toHaveBeenCalledWith(expect.objectContaining({
        content: 'Checking in because your mood has stayed low.',
      }));
    } finally {
      nowSpy.mockRestore();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
