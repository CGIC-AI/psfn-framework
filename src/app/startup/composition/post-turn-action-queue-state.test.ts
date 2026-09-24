import { describe, expect, it } from 'vitest';
import type { InferredPostTurnAction } from '../../../shared/contracts/runtime.js';
import { RUNTIME_LANE_CLASSES } from '../../../shared/contracts/runtime-lanes.js';
import {
  coalesceDeferredPostTurnQueueEntry,
  createDeferredPostTurnQueueEntry,
} from './post-turn-action-queue-state.js';

function action(id: string, inferredAt: number): InferredPostTurnAction {
  return {
    id,
    kind: 'memory.episode-synthesis.run',
    payload: {},
    dedupeKey: 'memory.episode-synthesis.run:session',
    channelId: 'api:test',
    sourceMessageId: `message-${id}`,
    inferredAt,
  };
}

function queued(attempt: number, nextRunAt: number) {
  return {
    ...createDeferredPostTurnQueueEntry(action('first', 100), {
      capability: 'generic',
      runtimeClass: RUNTIME_LANE_CLASSES.maintenanceReflection,
      nextRunAt,
      maxRetries: 3,
    }),
    attempt,
  };
}

describe('coalesceDeferredPostTurnQueueEntry retry budget (ritxj)', () => {
  it('keeps the attempt budget and backoff when newer demand folds into a retrying entry', () => {
    const { entry } = coalesceDeferredPostTurnQueueEntry({
      existing: queued(2, 10_000),
      incomingAction: action('newer', 200),
      currentRunMustFinish: false,
      incomingNextRunAt: 250,
      incomingMaxRetries: 3,
    });
    expect(entry.attempt).toBe(2);
    expect(entry.nextRunAt).toBe(10_000);
    // The newer demand is still what runs next.
    expect(entry.action.id).toBe('newer');
    expect(entry.coalescedCount).toBe(1);
  });

  it('still lets newer demand run sooner on an entry that has never failed', () => {
    const { entry } = coalesceDeferredPostTurnQueueEntry({
      existing: queued(0, 10_000),
      incomingAction: action('newer', 200),
      currentRunMustFinish: false,
      incomingNextRunAt: 250,
      incomingMaxRetries: 3,
    });
    expect(entry.attempt).toBe(0);
    expect(entry.nextRunAt).toBe(250);
  });
});
