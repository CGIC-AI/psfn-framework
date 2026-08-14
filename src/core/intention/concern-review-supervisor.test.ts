import { describe, expect, it, vi } from 'vitest';
import type { Scheduler } from '../scheduler/scheduler.js';
import {
  CONCERN_REVIEW_SUPERVISOR_TASK_ID,
  registerConcernReviewSupervisorTask,
} from './concern-review-supervisor.js';

describe('concern review supervisor task', () => {
  it('registers a restart-recoverable recurring scan and awaits temporal review', async () => {
    const register = vi.fn();
    const waitForInFlight = vi.fn().mockResolvedValue({
      status: 'completed',
      pendingCount: 0,
      reviewedCount: 1,
      outcomes: [],
    });
    registerConcernReviewSupervisorTask({
      scheduler: { register } as unknown as Scheduler,
      intervalMs: 60_000,
      worker: {
        retireStaleCandidates: vi.fn().mockResolvedValue(0),
        reviewTemporalPending: vi.fn(() => ({ status: 'started', pendingCount: 1 })),
        waitForInFlight,
      },
    });

    expect(register).toHaveBeenCalledOnce();
    const [task, options] = register.mock.calls[0]!;
    expect(task).toMatchObject({
      id: CONCERN_REVIEW_SUPERVISOR_TASK_ID,
      type: 'every',
      intervalMs: 60_000,
      state: 'idle',
    });
    expect(options).toBeUndefined();
    await task.handler();
    expect(waitForInFlight).toHaveBeenCalledOnce();
  });

  it('propagates review failure so the scheduler records and retries it', async () => {
    const register = vi.fn();
    registerConcernReviewSupervisorTask({
      scheduler: { register } as unknown as Scheduler,
      intervalMs: 60_000,
      worker: {
        retireStaleCandidates: vi.fn().mockResolvedValue(0),
        reviewTemporalPending: () => ({ status: 'started', pendingCount: 1 }),
        waitForInFlight: vi.fn().mockRejectedValue(new Error('review failed')),
      },
    });
    const [task] = register.mock.calls[0]!;

    await expect(task.handler()).rejects.toThrow('review failed');
  });
});
