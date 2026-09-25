import { describe, expect, it, vi } from 'vitest';
import type { PostTurnActionHandler } from '../agent/post-turn-action-runtime.js';
import { registerDurablePreemptedTaskRetry } from './preempted-task-retry.js';

const PREEMPTED = Object.assign(
  new Error('Agent is already processing another prompt. Background run preempted by a foreground turn.'),
  { name: 'AgentRunPreemptedError' },
);

function fakeActions(result: 'queued' | 'dropped_budget' = 'queued') {
  const handlers = new Map<string, PostTurnActionHandler>();
  return {
    handlers,
    enqueue: vi.fn(() => result),
    registerHandler: vi.fn((kind: string, handler: PostTurnActionHandler) => {
      handlers.set(kind, handler);
      return () => undefined;
    }),
  };
}

describe('registerDurablePreemptedTaskRetry', () => {
  it('queues one durable retry with a not-before time and runs it with its scope', async () => {
    const actions = fakeActions();
    const run = vi.fn(async () => undefined);
    const retry = registerDurablePreemptedTaskRetry({
      actions,
      taskId: 'wake',
      retryDelayMs: () => 60_000,
      run,
      now: () => 1_000,
    });

    expect(retry.deferIfPreempted(PREEMPTED, '2026-09-25')).toBe(true);
    expect(actions.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'scheduler.preempted_retry:wake',
      dedupeKey: 'scheduler.preempted_retry:wake:2026-09-25',
      payload: { scope: '2026-09-25' },
      runAt: 61_000,
    }));

    const handler = actions.handlers.get('scheduler.preempted_retry:wake')!;
    await handler({ id: 'a', payload: { scope: '2026-09-25' } } as never);
    expect(run).toHaveBeenCalledWith('2026-09-25');
  });

  it('leaves every other failure to the caller', () => {
    const actions = fakeActions();
    const retry = registerDurablePreemptedTaskRetry({
      actions, taskId: 'wake', retryDelayMs: () => 60_000, run: vi.fn(),
    });
    expect(retry.deferIfPreempted(new Error('provider exploded'), 'x')).toBe(false);
    expect(actions.enqueue).not.toHaveBeenCalled();
  });

  it('fails closed when the durable queue refuses the retry or the delay is not positive', () => {
    const refused = registerDurablePreemptedTaskRetry({
      actions: fakeActions('dropped_budget'), taskId: 'wake', retryDelayMs: () => 60_000, run: vi.fn(),
    });
    expect(() => refused.deferIfPreempted(PREEMPTED, 'x')).toThrow('could not be queued durably');
    const zero = registerDurablePreemptedTaskRetry({
      actions: fakeActions(), taskId: 'wake', retryDelayMs: () => 0, run: vi.fn(),
    });
    expect(() => zero.deferIfPreempted(PREEMPTED, 'x')).toThrow('positive duration');
  });
});
