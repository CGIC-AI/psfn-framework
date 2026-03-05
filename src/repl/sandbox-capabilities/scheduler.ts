import type { EventBus, EventName } from '../../event-bus.js';
import type { Scheduler } from '../../scheduler/scheduler.js';
import type { TaskState } from '../../scheduler/types.js';
import type { ContextGetter, ScheduleMutationResult, ScheduleView } from './contracts.js';
import { parseRunAt, REPL_EVENT_ALLOWLIST, nextReplTaskId, toTrimmedString, VALID_TASK_STATES } from './common.js';

export interface SchedulerCapabilities {
  schedule_list: () => ScheduleView[];
  schedule_add_every: (name: string, intervalMs: number, handler: unknown) => ScheduleMutationResult;
  schedule_add_once: (name: string, at: number | string | Date, handler: unknown) => ScheduleMutationResult;
  schedule_update: (
    id: string,
    updates: {
      intervalMs?: number;
      state?: string;
      name?: string;
      runAt?: number | string | Date;
    },
  ) => ScheduleMutationResult;
  event_emit: (eventName: string, data: unknown) => Promise<ScheduleMutationResult>;
}

interface CreateSchedulerCapabilitiesOptions {
  scheduler: Scheduler | null;
  eventBus: EventBus | null;
  getSandboxContext: ContextGetter;
}

export function createSchedulerCapabilities(options: CreateSchedulerCapabilitiesOptions): SchedulerCapabilities {
  const schedule_list = (): ScheduleView[] => {
    if (!options.scheduler) {
      return [];
    }
    return options.scheduler.listTasks().map(task => ({
      id: task.id,
      name: task.name,
      type: task.type,
      intervalMs: task.intervalMs,
      runAt: task.runAt,
      state: task.state,
    }));
  };

  const schedule_add_every = (
    name: string,
    intervalMs: number,
    handler: unknown,
  ): ScheduleMutationResult => {
    if (!options.scheduler) {
      return { ok: false, error: 'no scheduler' };
    }

    const taskName = toTrimmedString(name);
    if (!taskName) {
      return { ok: false, error: 'name is required' };
    }
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      return { ok: false, error: 'intervalMs must be > 0' };
    }
    if (typeof handler !== 'function') {
      return { ok: false, error: 'handler must be a function' };
    }

    const id = nextReplTaskId();
    options.scheduler.register({
      id,
      name: taskName,
      type: 'every',
      intervalMs,
      handler: async () => {
        await Promise.resolve((handler as () => unknown).call(options.getSandboxContext()));
      },
      state: 'idle',
    });

    return { ok: true, id };
  };

  const schedule_add_once = (
    name: string,
    at: number | string | Date,
    handler: unknown,
  ): ScheduleMutationResult => {
    if (!options.scheduler) {
      return { ok: false, error: 'no scheduler' };
    }

    const taskName = toTrimmedString(name);
    if (!taskName) {
      return { ok: false, error: 'name is required' };
    }
    if (typeof handler !== 'function') {
      return { ok: false, error: 'handler must be a function' };
    }

    const runAt = parseRunAt(at);
    if (runAt === null) {
      return { ok: false, error: 'invalid runAt time' };
    }

    const id = nextReplTaskId();
    options.scheduler.register({
      id,
      name: taskName,
      type: 'one-shot',
      intervalMs: 0,
      runAt,
      handler: async () => {
        await Promise.resolve((handler as () => unknown).call(options.getSandboxContext()));
      },
      state: 'idle',
    });

    return { ok: true, id };
  };

  const schedule_update = (
    id: string,
    updates: {
      intervalMs?: number;
      state?: string;
      name?: string;
      runAt?: number | string | Date;
    },
  ): ScheduleMutationResult => {
    if (!options.scheduler) {
      return { ok: false, error: 'no scheduler' };
    }

    const taskId = toTrimmedString(id);
    if (!taskId) {
      return { ok: false, error: 'task id is required' };
    }
    const next: { intervalMs?: number; state?: TaskState; name?: string; runAt?: number } = {};

    if (updates.intervalMs !== undefined) {
      if (!Number.isFinite(updates.intervalMs) || updates.intervalMs <= 0) {
        return { ok: false, error: 'intervalMs must be > 0' };
      }
      next.intervalMs = updates.intervalMs;
    }

    if (updates.state !== undefined) {
      if (typeof updates.state !== 'string' || !VALID_TASK_STATES.has(updates.state as TaskState)) {
        return { ok: false, error: `invalid state: ${updates.state}` };
      }
      next.state = updates.state as TaskState;
    }

    if (updates.name !== undefined) {
      if (typeof updates.name !== 'string') {
        return { ok: false, error: 'name must be a string' };
      }
      const taskName = updates.name.trim();
      if (!taskName) {
        return { ok: false, error: 'name must be non-empty' };
      }
      next.name = taskName;
    }

    if (updates.runAt !== undefined) {
      const runAt = parseRunAt(updates.runAt);
      if (runAt === null) {
        return { ok: false, error: 'invalid runAt time' };
      }
      next.runAt = runAt;
    }

    if (Object.keys(next).length === 0) {
      return { ok: false, error: 'no updates provided' };
    }

    const updated = options.scheduler.updateTask(taskId, next);
    return updated ? { ok: true } : { ok: false, error: `task "${taskId}" not found` };
  };

  const event_emit = async (eventName: string, data: unknown): Promise<ScheduleMutationResult> => {
    if (!options.eventBus) {
      return { ok: false, error: 'no event bus' };
    }

    const normalized = toTrimmedString(eventName);
    if (!normalized) {
      return { ok: false, error: 'eventName is required' };
    }
    if (!REPL_EVENT_ALLOWLIST.has(normalized as EventName)) {
      return { ok: false, error: `event "${normalized}" is not allowlisted` };
    }

    await options.eventBus.emit(normalized as EventName, data as never);
    return { ok: true };
  };

  return {
    schedule_list,
    schedule_add_every,
    schedule_add_once,
    schedule_update,
    event_emit,
  };
}
