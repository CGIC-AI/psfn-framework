import { createComponentLogger } from '../../shared/logger.js';
import { isAgentProcessingPromptError } from '../../system/lifecycle/turn-contention.js';
import type { Scheduler } from './scheduler.js';
import type { EligibilityRequirements } from '../../system/capabilities/eligibility.js';
import type { ScheduledTaskHandler } from './types.js';

const log = createComponentLogger('PreemptedTaskRetry');

/**
 * tpkqi: a background task whose agent turn a foreground turn preempted (or
 * that found the agent run busy) did not fail — it yielded. The task is re-armed
 * as a one-shot retry of the same handler after `retryDelayMs`, logged at info,
 * instead of being recorded as a scheduler error and lost until its next
 * cadence slot (a whole day for the morning wake).
 *
 * Returns true when `error` was such a contention and a retry was armed; any
 * other error is left to the caller.
 */
export function deferPreemptedTaskRetry(input: {
  scheduler: Pick<Scheduler, 'register'>;
  error: unknown;
  taskId: string;
  taskName: string;
  retryDelayMs: number;
  handler: ScheduledTaskHandler;
  eligibility?: EligibilityRequirements;
  now?: () => number;
}): boolean {
  if (!isAgentProcessingPromptError(input.error)) return false;
  if (!Number.isFinite(input.retryDelayMs) || input.retryDelayMs <= 0) {
    throw new Error(`Preempted task "${input.taskId}" retry delay must be a positive duration`);
  }
  const runAt = (input.now ?? Date.now)() + input.retryDelayMs;
  const retryTaskId = `${input.taskId}:preempted-retry`;
  input.scheduler.register({
    id: retryTaskId,
    name: `${input.taskName} (retry after preemption)`,
    type: 'one-shot',
    intervalMs: 0,
    runAt,
    handler: input.handler,
    ...(input.eligibility ? { eligibility: input.eligibility } : {}),
    state: 'idle',
  });
  log.info('Background task preempted by a foreground turn; retry scheduled', {
    taskId: input.taskId,
    retryTaskId,
    retryAt: new Date(runAt).toISOString(),
  });
  return true;
}
