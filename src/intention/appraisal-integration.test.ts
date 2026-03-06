import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { PostTurnActionInferer } from '../agent/substrate-agent.js';
import { wireHeartbeatRuntime } from '../bootstrap/parity.js';
import { wirePostTurnActionRuntime } from '../bootstrap/post-turn-actions.js';
import { EventBus } from '../event-bus.js';
import { Scheduler } from '../scheduler/scheduler.js';
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

function makeResponse(): AgentResponse {
  return {
    channelId: 'api:test',
    content: 'Absolutely, I can follow up.',
    metadata: {
      model: 'chat-model',
      inputTokens: 100,
      outputTokens: 50,
      durationMs: 12,
    },
  };
}

describe('intention appraisal runtime integration', () => {
  it('dispatches follow-up actions asynchronously through post-turn runtime', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'psfn-intention-'));
    try {
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
      expect(agentLoop.waitForIdle).not.toHaveBeenCalled();
      expect(agentLoop.followUp).toHaveBeenCalledTimes(1);
      expect(agentLoop.followUp).toHaveBeenCalledWith(expect.objectContaining({
        channelId: 'api:test',
        channelType: 'api',
        content: 'Quick follow-up: how are you doing today?',
      }));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
