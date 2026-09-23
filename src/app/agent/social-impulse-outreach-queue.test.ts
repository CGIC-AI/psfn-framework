import { describe, expect, it, vi } from 'vitest';
import { Scheduler } from '../../core/scheduler/scheduler.js';
import { EventBus } from '../../shared/event-bus.js';
import { wirePostTurnActionRuntime } from '../startup/composition/post-turn-actions.js';
import { createSocialDesireEvaluationQueue } from './social-impulse-outreach-queue.js';

describe('social desire evaluation queue', () => {
  it('is admitted and drained by the real post-turn action runtime', async () => {
    const eventBus = new EventBus();
    const scheduler = new Scheduler(eventBus, { tickIntervalMs: 10, heartbeatIntervalMs: 1_000 });
    const actions = wirePostTurnActionRuntime({ eventBus, scheduler, agentLoop: {}, intervalMs: 1 });
    const evaluate = vi.fn(async () => undefined);
    const queue = createSocialDesireEvaluationQueue({ actions, evaluate });

    await queue.request('felt-impulse:would_message:1780000000000');
    // A replay of the same source is deduplicated, not evaluated twice.
    await queue.request('felt-impulse:would_message:1780000000000');
    const deadline = Date.now() + 5_000;
    while (evaluate.mock.calls.length === 0 && Date.now() < deadline) {
      await scheduler.tick();
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(evaluate).toHaveBeenCalledTimes(1);
    await expect(queue.request('  ')).rejects.toThrow(/exact source identity/);
  });
});
