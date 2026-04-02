import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { PostTurnActionInferer } from '../agent/substrate-agent.js';
import { wirePostTurnActionRuntime } from '../bootstrap/post-turn-actions.js';
import { EventBus } from '../event-bus.js';
import { createIntentionAppraisalHooks, wireIntentionRuntime } from './runtime-wiring.js';
import { Scheduler } from '../scheduler/scheduler.js';
import { wireHeartbeatRuntime } from '../scheduler/heartbeat-runtime.js';
import { InternalStateComputer } from '../self-model/state.js';
import type { AgentResponse, SubstrateMessage } from '../types.js';

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

describe('intention appraisal runtime integration', () => {
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
            status: 'open',
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
            status: 'open',
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

  it('resurfaces pending follow-ups on the next external turn when appraisal chose that wake condition', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'psfn-intention-next-user-turn-'));
    const nowSpy = vi.spyOn(Date, 'now');
    const db = new Database(':memory:');

    try {
      nowSpy.mockReturnValue(1_700_000_400_000);
      const intentionRuntime = wireIntentionRuntime({ registerTool: vi.fn() } as any, db);
      const intentionHooks = createIntentionAppraisalHooks(
        intentionRuntime.concernStore,
        intentionRuntime.pendingFollowUpStore,
        intentionRuntime.careReminderStore,
      );
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
        complete: vi.fn()
          .mockResolvedValueOnce({
            content: JSON.stringify({
              decisions: [{
                type: 'followUp',
                priority: 'high',
                reason: 'Wait until the user comes back naturally.',
                timing: 'soon',
                followUp: {
                  content: 'Check in gently when they re-engage.',
                  wakeConditions: ['next_user_turn'],
                  contextSummary: 'They asked to revisit this after thinking it over.',
                },
              }],
            }),
            model: 'background-model',
            toolCalls: [],
            inputTokens: 48,
            outputTokens: 31,
            stopReason: 'stop',
          })
          .mockResolvedValueOnce({
            content: JSON.stringify({
              decisions: [{
                type: 'noop',
                priority: 'low',
                reason: 'No new follow-up needed from the model.',
                timing: 'none',
              }],
            }),
            model: 'background-model',
            toolCalls: [],
            inputTokens: 44,
            outputTokens: 18,
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
            status: 'open',
          }],
          emotionState: {
            getState: () => ({
              vad: { valence: -0.2, arousal: 0.3, dominance: -0.1 },
              mood: { valence: -0.15, arousal: 0.25, dominance: -0.05 },
              discrete: { concern: 0.7 },
              confidence: 0.8,
            }),
          },
          onIntentionFollowUpDecision: intentionHooks.onIntentionFollowUpDecision,
          getPendingFollowUpsForResurfacing: intentionHooks.getPendingFollowUpsForResurfacing,
          onIntentionFollowUpActivated: intentionHooks.onIntentionFollowUpActivated,
        },
      );

      expect(inferers).toHaveLength(1);
      const inferer = inferers[0]!;
      await inferer({
        message: makeMessage(),
        response: makeResponse(),
        turnMessages: [],
        turnId: 'turn-intention-next-user-turn-1' as any,
        completedAt: Date.now(),
      } as any);
      await Promise.resolve();
      await Promise.resolve();
      await scheduler.tick();

      expect(agentLoop.followUp).toHaveBeenCalledTimes(0);
      expect(intentionRuntime.pendingFollowUpStore.getPendingFollowUps()).toEqual([
        expect.objectContaining({
          content: 'Check in gently when they re-engage.',
          wakeConditions: ['next_user_turn'],
          contextSummary: 'They asked to revisit this after thinking it over.',
        }),
      ]);

      nowSpy.mockReturnValue(1_700_000_460_000);
      await inferer({
        message: {
          ...makeMessage(),
          id: 'msg-intention-runtime-2',
          content: 'I am back and still feeling uncertain.',
        },
        response: makeResponse(makeInternalState({
          vad: { valence: -0.22, arousal: 0.25, dominance: -0.08 },
          mood: { valence: -0.18, arousal: 0.2, dominance: -0.05 },
        })),
        turnMessages: [],
        turnId: 'turn-intention-next-user-turn-2' as any,
        completedAt: Date.now(),
      } as any);
      await Promise.resolve();
      await Promise.resolve();
      await scheduler.tick();

      expect(agentLoop.followUp).toHaveBeenCalledTimes(1);
      expect(agentLoop.followUp).toHaveBeenCalledWith(expect.objectContaining({
        channelId: 'api:test',
        channelType: 'api',
        content: 'Check in gently when they re-engage.',
      }));
      const activated = intentionRuntime.pendingFollowUpStore.list({ includeActivated: true })[0];
      expect(activated).toMatchObject({
        activatedAt: expect.any(String),
        activationReason: 'post_turn_action',
      });
    } finally {
      db.close();
      nowSpy.mockRestore();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('persists durable annual reminders across restart and requeues the next occurrence', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'psfn-intention-reminder-'));
    const nowSpy = vi.spyOn(Date, 'now');
    const dbPath = join(tempDir, 'intention.sqlite');
    const queuePath = join(tempDir, 'post-turn-actions.json');

    try {
      nowSpy.mockReturnValue(Date.parse('2026-03-30T12:00:00.000Z'));
      const firstDb = new Database(dbPath);
      const firstIntentionRuntime = wireIntentionRuntime({ registerTool: vi.fn() } as any, firstDb);
      const firstHooks = createIntentionAppraisalHooks(
        firstIntentionRuntime.concernStore,
        firstIntentionRuntime.pendingFollowUpStore,
        firstIntentionRuntime.careReminderStore,
      );

      const firstEventBus = new EventBus();
      const firstScheduler = new Scheduler(firstEventBus, {
        tickIntervalMs: 50,
        heartbeatIntervalMs: 1_000,
      });
      const firstInferers: PostTurnActionInferer[] = [];
      const firstAgentLoop = {
        handleMessage: vi.fn().mockResolvedValue({ content: 'ok' }),
        followUp: vi.fn(),
        waitForIdle: vi.fn().mockResolvedValue(undefined),
        registerPostTurnActionInferer: vi.fn((inferer: PostTurnActionInferer) => {
          firstInferers.push(inferer);
          return () => {};
        }),
      };
      const firstPostTurnActions = wirePostTurnActionRuntime({
        eventBus: firstEventBus,
        scheduler: firstScheduler,
        agentLoop: firstAgentLoop,
        intervalMs: 1,
        persistencePath: queuePath,
      });

      wireHeartbeatRuntime(
        { registerTool: vi.fn() },
        firstScheduler,
        firstAgentLoop,
        { send: vi.fn().mockResolvedValue(undefined) },
        tempDir,
        undefined,
        {
          eventBus: firstEventBus,
          postTurnActions: firstPostTurnActions,
          llmProvider: {
            stream: vi.fn(),
            complete: vi.fn().mockResolvedValue({
              content: JSON.stringify({
                decisions: [{
                  type: 'reminder',
                  priority: 'high',
                  reason: 'Store the birthday durably so it survives quiet periods.',
                  timing: 'scheduled',
                  dueAt: Date.parse('2026-04-01T09:00:00.000Z'),
                  reminder: {
                    kind: 'important_date',
                    classification: 'birthday',
                    title: 'Alex birthday',
                    content: 'Remember Alex birthday and plan a warm message.',
                    schedule: 'annual',
                  },
                }],
              }),
              model: 'background-model',
              toolCalls: [],
              inputTokens: 48,
              outputTokens: 31,
              stopReason: 'stop',
            }),
          } as any,
          sessionManager: {
            resolveSessionChannelId: (channelId: string) => channelId,
            getRecentMessages: vi.fn().mockReturnValue([]),
          } as any,
          emotionState: {
            getState: () => ({
              vad: { valence: -0.2, arousal: 0.3, dominance: -0.1 },
              mood: { valence: -0.15, arousal: 0.25, dominance: -0.05 },
              discrete: { concern: 0.7 },
              confidence: 0.8,
            }),
          },
          onIntentionReminderDecision: firstHooks.onIntentionReminderDecision,
          onIntentionReminderTriggered: firstHooks.onIntentionReminderTriggered,
        },
      );

      await firstInferers[0]!({
        message: makeMessage(),
        response: makeResponse(),
        turnMessages: [],
        turnId: 'turn-intention-reminder-1' as any,
        completedAt: Date.now(),
      } as any);
      await Promise.resolve();
      await Promise.resolve();
      await firstScheduler.tick();

      const createdReminder = firstIntentionRuntime.careReminderStore.getActiveCareReminders()[0];
      expect(createdReminder).toMatchObject({
        kind: 'important_date',
        classification: 'birthday',
        schedule: 'annual',
        provenanceSource: 'companion_appraisal',
      });
      expect(firstPostTurnActions.listQueued()).toHaveLength(1);
      firstDb.close();

      nowSpy.mockReturnValue(Date.parse('2026-04-01T09:05:00.000Z'));
      const secondDb = new Database(dbPath);
      const secondIntentionRuntime = wireIntentionRuntime({ registerTool: vi.fn() } as any, secondDb);
      const secondHooks = createIntentionAppraisalHooks(
        secondIntentionRuntime.concernStore,
        secondIntentionRuntime.pendingFollowUpStore,
        secondIntentionRuntime.careReminderStore,
      );
      const secondEventBus = new EventBus();
      const secondScheduler = new Scheduler(secondEventBus, {
        tickIntervalMs: 50,
        heartbeatIntervalMs: 1_000,
      });
      const secondAgentLoop = {
        handleMessage: vi.fn().mockResolvedValue({ content: 'ok' }),
        followUp: vi.fn(),
        waitForIdle: vi.fn().mockResolvedValue(undefined),
        registerPostTurnActionInferer: vi.fn(() => () => {}),
      };
      const secondPostTurnActions = wirePostTurnActionRuntime({
        eventBus: secondEventBus,
        scheduler: secondScheduler,
        agentLoop: secondAgentLoop,
        intervalMs: 1,
        persistencePath: queuePath,
      });

      wireHeartbeatRuntime(
        { registerTool: vi.fn() },
        secondScheduler,
        secondAgentLoop,
        { send: vi.fn().mockResolvedValue(undefined) },
        tempDir,
        undefined,
        {
          eventBus: secondEventBus,
          postTurnActions: secondPostTurnActions,
          llmProvider: {
            stream: vi.fn(),
            complete: vi.fn(),
          } as any,
          sessionManager: {
            resolveSessionChannelId: (channelId: string) => channelId,
            getRecentMessages: vi.fn().mockReturnValue([]),
          } as any,
          emotionState: {
            getState: () => ({
              vad: { valence: -0.2, arousal: 0.3, dominance: -0.1 },
              mood: { valence: -0.15, arousal: 0.25, dominance: -0.05 },
              discrete: { concern: 0.7 },
              confidence: 0.8,
            }),
          },
          onIntentionReminderDecision: secondHooks.onIntentionReminderDecision,
          onIntentionReminderTriggered: secondHooks.onIntentionReminderTriggered,
        },
      );

      await secondScheduler.tick();

      expect(secondAgentLoop.followUp).toHaveBeenCalledWith(expect.objectContaining({
        channelId: 'api:test',
        channelType: 'api',
        content: 'Remember Alex birthday and plan a warm message.',
      }));
      expect(secondPostTurnActions.listQueued()).toHaveLength(1);
      const requeued = secondIntentionRuntime.careReminderStore.getById(createdReminder!.id);
      expect(requeued).toMatchObject({
        id: createdReminder!.id,
        status: 'active',
        activationCount: 1,
        dueAt: '2027-04-01T09:00:00.000Z',
      });
      secondDb.close();
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
            status: 'open',
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
