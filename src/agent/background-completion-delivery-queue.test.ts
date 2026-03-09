import { describe, expect, it } from 'vitest';
import {
  BackgroundCompletionDeliveryQueue,
  type BackgroundCompletionDeliveryQueueEntry,
} from './background-completion-delivery-queue.js';

interface TestDelivery extends BackgroundCompletionDeliveryQueueEntry {
  content: string;
}

describe('BackgroundCompletionDeliveryQueue', () => {
  it('enqueues and dequeues deliveries by session', () => {
    const queue = new BackgroundCompletionDeliveryQueue<TestDelivery>();
    queue.enqueue({
      continuationId: 'c1',
      deliverySessionId: 'terminal:session-a',
      content: 'A',
    });
    queue.enqueue({
      continuationId: 'c2',
      deliverySessionId: 'terminal:session-a',
      content: 'B',
    });

    expect(queue.sizeForSession('terminal:session-a')).toBe(2);
    expect(queue.dequeue('terminal:session-a')).toEqual([
      expect.objectContaining({ continuationId: 'c1', content: 'A' }),
      expect.objectContaining({ continuationId: 'c2', content: 'B' }),
    ]);
    expect(queue.sizeForSession('terminal:session-a')).toBe(0);
  });

  it('deduplicates by continuation id by replacing queued delivery', () => {
    const queue = new BackgroundCompletionDeliveryQueue<TestDelivery>();
    queue.enqueue({
      continuationId: 'c1',
      deliverySessionId: 'terminal:session-a',
      content: 'old',
    });
    queue.enqueue({
      continuationId: 'c1',
      deliverySessionId: 'terminal:session-a',
      content: 'new',
    });

    expect(queue.sizeForSession('terminal:session-a')).toBe(1);
    expect(queue.dequeue('terminal:session-a')).toEqual([
      expect.objectContaining({ continuationId: 'c1', content: 'new' }),
    ]);
  });

  it('cancels queued continuation delivery and keeps unrelated entries', () => {
    const queue = new BackgroundCompletionDeliveryQueue<TestDelivery>();
    queue.enqueue({
      continuationId: 'c1',
      deliverySessionId: 'terminal:session-a',
      content: 'one',
    });
    queue.enqueue({
      continuationId: 'c2',
      deliverySessionId: 'terminal:session-a',
      content: 'two',
    });

    const result = queue.cancel('c1');
    expect(result).toEqual({
      cancelled: true,
      queueDepth: 1,
    });
    expect(queue.dequeue('terminal:session-a')).toEqual([
      expect.objectContaining({ continuationId: 'c2', content: 'two' }),
    ]);
  });
});
