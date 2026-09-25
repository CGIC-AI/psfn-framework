import { describe, expect, it, vi } from 'vitest';
import { deferPreemptedTaskRetry } from './preempted-task-retry.js';

const PREEMPTED = Object.assign(
  new Error('Agent is already processing another prompt. Background run preempted by a foreground turn.'),
  { name: 'AgentRunPreemptedError' },
);

describe('deferPreemptedTaskRetry', () => {
  it('re-arms a preempted task as a one-shot retry of the same handler', () => {
    const register = vi.fn();
    const handler = vi.fn();

    expect(deferPreemptedTaskRetry({
      scheduler: { register },
      error: PREEMPTED,
      taskId: 'wake',
      taskName: 'Wake',
      retryDelayMs: 60_000,
      handler,
      eligibility: { requiredTokens: ['memory.write'] },
      now: () => 1_000,
    })).toBe(true);
    expect(register).toHaveBeenCalledWith({
      id: 'wake:preempted-retry',
      name: 'Wake (retry after preemption)',
      type: 'one-shot',
      intervalMs: 0,
      runAt: 61_000,
      handler,
      eligibility: { requiredTokens: ['memory.write'] },
      state: 'idle',
    });
  });

  it('leaves every other failure to the caller', () => {
    const register = vi.fn();
    expect(deferPreemptedTaskRetry({
      scheduler: { register },
      error: new Error('provider exploded'),
      taskId: 'wake',
      taskName: 'Wake',
      retryDelayMs: 60_000,
      handler: vi.fn(),
    })).toBe(false);
    expect(register).not.toHaveBeenCalled();
  });

  it('rejects a non-positive retry delay instead of retrying immediately', () => {
    expect(() => deferPreemptedTaskRetry({
      scheduler: { register: vi.fn() },
      error: PREEMPTED,
      taskId: 'wake',
      taskName: 'Wake',
      retryDelayMs: 0,
      handler: vi.fn(),
    })).toThrow('retry delay must be a positive duration');
  });
});
