import { describe, it, expect, vi } from 'vitest';
import type { AgentResponse, InferredPostTurnAction, SubstrateMessage } from '../types.js';
import { EventBus } from '../event-bus.js';
import { Scheduler } from '../scheduler/scheduler.js';
import { wirePostTurnActionRuntime } from './post-turn-actions.js';

function makeMessage(): SubstrateMessage {
  return {
    id: 'msg-1',
    channelId: 'test-channel',
    channelType: 'terminal',
    authorId: 'user-1',
    authorName: 'Test User',
    content: 'hello',
    timestamp: new Date(),
  };
}

function makeResponse(): AgentResponse {
  return {
    content: 'ok',
    channelId: 'test-channel',
    metadata: {
      model: 'mock-model',
      inputTokens: 1,
      outputTokens: 1,
      durationMs: 1,
    },
  };
}

function makeAction(overrides: Partial<InferredPostTurnAction> = {}): InferredPostTurnAction {
  return {
    id: 'action-1',
    kind: 'heartbeat.run_template',
    payload: { templateId: 'whisper' },
    dedupeKey: 'heartbeat.run_template:whisper',
    channelId: 'test-channel',
    sourceMessageId: 'msg-1',
    inferredAt: Date.now(),
    ...overrides,
  };
}

describe('wirePostTurnActionRuntime', () => {
  it('deduplicates queued actions and executes once after idle', async () => {
    const eventBus = new EventBus();
    const scheduler = new Scheduler(eventBus, {
      tickIntervalMs: 100,
      heartbeatIntervalMs: 1_000,
    });
    const agentLoop = {
      waitForIdle: vi.fn().mockResolvedValue(undefined),
    };
    const runtime = wirePostTurnActionRuntime({
      eventBus,
      scheduler,
      agentLoop,
      intervalMs: 10,
    });
    const handler = vi.fn().mockResolvedValue(undefined);
    runtime.registerHandler('heartbeat.run_template', handler);

    const phases: string[] = [];
    eventBus.on('agent.post_turn.action.telemetry', ({ phase }) => {
      phases.push(phase);
    });

    await eventBus.emit('agent.post_turn.actions.inferred', {
      message: makeMessage(),
      response: makeResponse(),
      actions: [
        makeAction({ id: 'action-a', dedupeKey: 'dedupe:key' }),
        makeAction({ id: 'action-b', dedupeKey: 'dedupe:key' }),
      ],
    });

    expect(runtime.listQueued()).toHaveLength(1);

    await scheduler.tick();

    expect(agentLoop.waitForIdle).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(runtime.listQueued()).toHaveLength(0);
    expect(phases).toContain('queued');
    expect(phases).toContain('deduplicated');
    expect(phases).toContain('started');
    expect(phases).toContain('succeeded');
  });

  it('retries failures with bounded attempts and then marks failed', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    try {
      nowSpy.mockReturnValue(1_700_000_000_000);

      const eventBus = new EventBus();
      const scheduler = new Scheduler(eventBus, {
        tickIntervalMs: 100,
        heartbeatIntervalMs: 1_000,
      });
      const agentLoop = {
        waitForIdle: vi.fn().mockResolvedValue(undefined),
      };
      const runtime = wirePostTurnActionRuntime({
        eventBus,
        scheduler,
        agentLoop,
        intervalMs: 1,
        baseRetryDelayMs: 100,
        maxRetryDelayMs: 100,
      });
      const handler = vi
        .fn()
        .mockRejectedValueOnce(new Error('first failure'))
        .mockRejectedValueOnce(new Error('second failure'));
      runtime.registerHandler('heartbeat.run_template', handler);

      const phases: string[] = [];
      eventBus.on('agent.post_turn.action.telemetry', ({ phase }) => {
        phases.push(phase);
      });

      await eventBus.emit('agent.post_turn.actions.inferred', {
        message: makeMessage(),
        response: makeResponse(),
        actions: [
          makeAction({
            id: 'retry-action',
            dedupeKey: 'retry:key',
            maxRetries: 1,
          }),
        ],
      });

      nowSpy.mockReturnValue(1_700_000_000_001);
      await scheduler.tick();
      expect(handler).toHaveBeenCalledTimes(1);
      expect(runtime.listQueued()).toHaveLength(1);

      nowSpy.mockReturnValue(1_700_000_000_050);
      await scheduler.tick();
      expect(handler).toHaveBeenCalledTimes(1);
      expect(runtime.listQueued()).toHaveLength(1);

      nowSpy.mockReturnValue(1_700_000_000_101);
      await scheduler.tick();
      expect(handler).toHaveBeenCalledTimes(2);
      expect(runtime.listQueued()).toHaveLength(0);
      expect(phases).toContain('retry_scheduled');
      expect(phases).toContain('failed');
    } finally {
      nowSpy.mockRestore();
    }
  });
});
