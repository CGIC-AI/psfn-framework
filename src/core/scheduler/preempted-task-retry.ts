import type { PostTurnActionRuntime } from '../agent/post-turn-action-runtime.js';
import { MAINTENANCE_REFLECTION_RUNTIME_CLASS } from '../agent/worker-lanes.js';
import { createComponentLogger } from '../../shared/logger.js';
import { isAgentProcessingPromptError } from '../../system/lifecycle/turn-contention.js';
import { isRecord } from '../../shared/utils/types.js';

const log = createComponentLogger('PreemptedTaskRetry');

export interface DurablePreemptedTaskRetry {
  /**
   * When `error` is a preemption or busy-run contention, durably enqueue one
   * retry of the task for `scope` and return true. Any other error returns
   * false and stays with the caller. Fails closed when the durable queue
   * refuses the retry.
   */
  deferIfPreempted(error: unknown, scope: string): boolean;
}

/**
 * tpkqi: a scheduled background task whose agent turn a foreground turn
 * preempted (or that found the agent run busy) did not fail; it yielded. The
 * retry is a durable post-turn action (the persisted action queue) with a
 * not-before time, so it survives a restart. The queued retry runs `run`
 * with the scope it was deferred for; a retry that is itself preempted is
 * rescheduled durably by the queue's own contention handling, because `run`
 * lets the contention propagate.
 */
export function registerDurablePreemptedTaskRetry(input: {
  actions: Pick<PostTurnActionRuntime, 'enqueue' | 'registerHandler'>;
  taskId: string;
  retryDelayMs: () => number;
  run: (scope: string) => Promise<void>;
  now?: () => number;
}): DurablePreemptedTaskRetry {
  const now = input.now ?? Date.now;
  const kind = `scheduler.preempted_retry:${input.taskId}`;
  input.actions.registerHandler(kind, async (action) => {
    const scope = isRecord(action.payload) ? action.payload.scope : undefined;
    if (typeof scope !== 'string' || !scope.trim()) {
      throw new Error(`Preempted task retry "${action.id}" is missing payload.scope`);
    }
    await input.run(scope);
  }, { executionMode: 'foreground', runtimeClass: MAINTENANCE_REFLECTION_RUNTIME_CLASS });

  return {
    deferIfPreempted(error: unknown, scope: string): boolean {
      if (!isAgentProcessingPromptError(error)) return false;
      const retryDelayMs = input.retryDelayMs();
      if (!Number.isFinite(retryDelayMs) || retryDelayMs <= 0) {
        throw new Error(`Preempted task "${input.taskId}" retry delay must be a positive duration`);
      }
      const inferredAt = now();
      const runAt = inferredAt + retryDelayMs;
      const result = input.actions.enqueue({
        id: `${kind}:${scope}:${String(inferredAt)}`,
        kind,
        dedupeKey: `${kind}:${scope}`,
        payload: { scope },
        channelId: 'internal:scheduler',
        sourceMessageId: `${input.taskId}:${scope}`,
        inferredAt,
        runAt,
      });
      if (result === 'dropped_budget') {
        throw new Error(`Preempted task "${input.taskId}" retry could not be queued durably`, { cause: error });
      }
      log.info('Background task preempted by a foreground turn; durable retry queued', {
        taskId: input.taskId,
        scope,
        retryAt: new Date(runAt).toISOString(),
        enqueue: result,
      });
      return true;
    },
  };
}
