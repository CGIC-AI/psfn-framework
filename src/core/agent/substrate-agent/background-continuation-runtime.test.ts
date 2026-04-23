import { describe, expect, it } from 'vitest';
import { BackgroundCompletionDeliveryQueue } from '../background-completion-delivery-queue.js';
import {
  dequeueBackgroundContinuationDeliveries,
  queueBackgroundContinuationCompletion,
  type BackgroundContinuationTaskRecord,
  type PendingBackgroundContinuationDelivery,
} from './background-continuation-runtime.js';

describe('background continuation runtime', () => {
  function makeMessage(index: number) {
    return {
      id: `deferred-tool-handoff:action-${index}`,
      channelId: 'terminal:session-a',
      channelType: 'terminal' as const,
      authorId: 'system:test',
      authorName: 'System',
      content: `background continuation ${index}`,
      timestamp: new Date(`2026-04-23T12:00:0${index}Z`),
    };
  }

  it('bounds queued continuation deliveries per session and degrades trimmed predecessors', () => {
    const backgroundContinuationTasks = new Map<string, BackgroundContinuationTaskRecord>();
    const pendingBackgroundContinuationDeliveries = new BackgroundCompletionDeliveryQueue<
      PendingBackgroundContinuationDelivery
    >();

    const first = queueBackgroundContinuationCompletion({
      deferredContinuationId: 'continuation-1',
      message: makeMessage(1),
      response: {
        content: 'first completion',
        channelId: 'terminal:session-a',
        metadata: {
          model: 'mock',
          inputTokens: 1,
          outputTokens: 1,
          durationMs: 1,
        },
      },
      taskKind: 'deferred_tool_handoff',
      intent: 'deferred_tool_handoff',
      resolveSessionChannelId: (channelId) => channelId,
      backgroundContinuationTasks,
      pendingBackgroundContinuationDeliveries,
      now: () => Date.parse('2026-04-23T12:00:05Z'),
    });
    const second = queueBackgroundContinuationCompletion({
      deferredContinuationId: 'continuation-2',
      message: makeMessage(2),
      response: {
        content: 'second completion',
        channelId: 'terminal:session-a',
        metadata: {
          model: 'mock',
          inputTokens: 1,
          outputTokens: 1,
          durationMs: 1,
        },
      },
      taskKind: 'deferred_tool_handoff',
      intent: 'deferred_tool_handoff',
      resolveSessionChannelId: (channelId) => channelId,
      backgroundContinuationTasks,
      pendingBackgroundContinuationDeliveries,
      now: () => Date.parse('2026-04-23T12:00:06Z'),
    });
    const third = queueBackgroundContinuationCompletion({
      deferredContinuationId: 'continuation-3',
      message: makeMessage(3),
      response: {
        content: 'third completion',
        channelId: 'terminal:session-a',
        metadata: {
          model: 'mock',
          inputTokens: 1,
          outputTokens: 1,
          durationMs: 1,
        },
      },
      taskKind: 'deferred_tool_handoff',
      intent: 'deferred_tool_handoff',
      resolveSessionChannelId: (channelId) => channelId,
      backgroundContinuationTasks,
      pendingBackgroundContinuationDeliveries,
      now: () => Date.parse('2026-04-23T12:00:07Z'),
    });

    expect(first.runtimeClass).toBe('background_continuation');
    expect(first.queueDepth).toBe(1);
    expect(second.queueDepth).toBe(2);
    expect(third.queueDepth).toBe(2);
    expect(third.droppedContinuationIds).toEqual(['continuation-1']);
    expect(backgroundContinuationTasks.get('continuation-1')).toMatchObject({
      runtimeClass: 'background_continuation',
      notifyUser: false,
      notificationReason: 'suppress_lane_budget',
    });
    expect(backgroundContinuationTasks.get('continuation-3')).toMatchObject({
      runtimeClass: 'background_continuation',
      notifyUser: true,
      droppedContinuationIds: ['continuation-1'],
    });
  });

  it('delivers bounded continuation batches across foreground turns', () => {
    const pendingBackgroundContinuationDeliveries = new BackgroundCompletionDeliveryQueue<
      PendingBackgroundContinuationDelivery
    >();
    pendingBackgroundContinuationDeliveries.enqueue({
      runtimeClass: 'background_continuation',
      continuationId: 'continuation-2',
      sourceMessageId: 'deferred-tool-handoff:action-2',
      deliverySessionId: 'terminal:session-a',
      content: 'second completion',
      completedAt: Date.parse('2026-04-23T12:00:06Z'),
      origin: 'user_delegated',
      urgency: 'normal',
      channelContext: 'session',
      completionAgeMs: 4_000,
      stale: false,
      taskKind: 'deferred_tool_handoff',
      intent: 'deferred_tool_handoff',
      notificationReason: 'notify_deferred_user_task',
    }, { maxDepth: 2 });
    pendingBackgroundContinuationDeliveries.enqueue({
      runtimeClass: 'background_continuation',
      continuationId: 'continuation-3',
      sourceMessageId: 'deferred-tool-handoff:action-3',
      deliverySessionId: 'terminal:session-a',
      content: 'third completion',
      completedAt: Date.parse('2026-04-23T12:00:07Z'),
      origin: 'user_delegated',
      urgency: 'normal',
      channelContext: 'session',
      completionAgeMs: 4_000,
      stale: false,
      taskKind: 'deferred_tool_handoff',
      intent: 'deferred_tool_handoff',
      notificationReason: 'notify_deferred_user_task',
    }, { maxDepth: 2 });

    const firstForegroundDrain = dequeueBackgroundContinuationDeliveries(
      pendingBackgroundContinuationDeliveries,
      'terminal:session-a',
      1,
    );
    const secondForegroundDrain = dequeueBackgroundContinuationDeliveries(
      pendingBackgroundContinuationDeliveries,
      'terminal:session-a',
      1,
    );

    expect(firstForegroundDrain).toEqual([
      expect.objectContaining({
        continuationId: 'continuation-2',
        runtimeClass: 'background_continuation',
      }),
    ]);
    expect(secondForegroundDrain).toEqual([
      expect.objectContaining({
        continuationId: 'continuation-3',
        runtimeClass: 'background_continuation',
      }),
    ]);
    expect(dequeueBackgroundContinuationDeliveries(
      pendingBackgroundContinuationDeliveries,
      'terminal:session-a',
      1,
    )).toEqual([]);
  });
});
