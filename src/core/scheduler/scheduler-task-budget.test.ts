import { afterEach, describe, expect, it } from 'vitest';
import { EventBus } from '../../shared/event-bus.js';
import type { HealthEvent } from '../../shared/contracts/health-event.js';
import { HANDLER_BUDGET_EXCEEDED, Scheduler } from './scheduler.js';
import type { ScheduledTaskRun } from './types.js';

const COMPANION_ID = '11111111-1111-4111-8111-111111111111';
const BUDGET_MS = 25;

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('condition not reached');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function harness(options: { runProtectedTask?: boolean } = {}) {
  const eventBus = new EventBus();
  const failed: Array<{ taskId: string; error: string }> = [];
  const health: HealthEvent[] = [];
  const protectedStates: string[] = [];
  eventBus.on('schedule.task.failed', payload => {
    failed.push({ taskId: payload.taskId, error: payload.error });
  });
  eventBus.on('runtime.health.event', payload => {
    health.push(payload.event);
  });
  const scheduler = new Scheduler(eventBus, { tickIntervalMs: 1_000 }, {
    taskBudgetMs: BUDGET_MS,
    healthEventSource: {
      owner: { kind: 'companion', companionId: COMPANION_ID as never },
      process: 'agent',
    },
    ...(options.runProtectedTask
      ? {
          runProtectedTask: async (state, handler) => {
            protectedStates.push(state);
            await handler();
          },
        }
      : {}),
  });
  return { scheduler, failed, health, protectedStates };
}

describe('scheduler task budget', () => {
  const pending: Deferred[] = [];
  afterEach(() => {
    for (const entry of pending.splice(0)) entry.resolve();
  });

  it('aborts a hung handler, records the attempt failed, and keeps the tick moving', async () => {
    const { scheduler, failed, health } = harness();
    const hung = deferred();
    pending.push(hung);
    let hungRun: ScheduledTaskRun | undefined;
    let healthyRuns = 0;
    scheduler.register({
      id: 'hung',
      name: 'Hung',
      type: 'every',
      intervalMs: 1,
      handler: async run => {
        hungRun = run;
        await hung.promise;
      },
      state: 'idle',
    });
    scheduler.register({
      id: 'healthy',
      name: 'Healthy',
      type: 'every',
      intervalMs: 1,
      handler: () => {
        healthyRuns += 1;
      },
      state: 'idle',
    });

    await scheduler.tick();

    // The healthy task registered AFTER the hung one still ran this tick.
    expect(healthyRuns).toBe(1);
    expect(hungRun?.signal.aborted).toBe(true);
    const task = scheduler.getTask('hung')!;
    expect(task.state).toBe('active');
    expect(task.lastOutcome).toBe('failed');
    expect(task.lastError).toContain(HANDLER_BUDGET_EXCEEDED);
    expect(task.lastErrorAt).toBeGreaterThanOrEqual(task.lastRunAt!);
    expect(task.lastFinishedAt).toBeUndefined();
    expect(scheduler.listOverdueTaskIds()).toEqual(['hung']);
    expect(failed).toEqual([{ taskId: 'hung', error: expect.stringContaining(HANDLER_BUDGET_EXCEEDED) }]);
    expect(health.map(event => event.code)).toEqual(['scheduler_task_failed']);
    expect(scheduler.getTask('healthy')!.lastOutcome).toBe('succeeded');
  });

  it('never re-enters a task until its aborted handler settles, then returns it to idle', async () => {
    const { scheduler, failed } = harness();
    const hung = deferred();
    pending.push(hung);
    let starts = 0;
    scheduler.register({
      id: 'hung',
      name: 'Hung',
      type: 'every',
      intervalMs: 1,
      handler: async () => {
        starts += 1;
        await hung.promise;
      },
      state: 'idle',
    });

    await scheduler.tick();
    await new Promise(resolve => setTimeout(resolve, 5));
    await scheduler.tick();
    await scheduler.tick();
    expect(starts).toBe(1);
    expect(failed).toHaveLength(1);

    hung.resolve();
    await waitFor(() => scheduler.getTask('hung')!.state === 'idle');
    const settled = scheduler.getTask('hung')!;
    // The attempt stays accounted as failed; settlement only records when it let go.
    expect(settled.lastOutcome).toBe('failed');
    expect(settled.lastFinishedAt).toBeGreaterThanOrEqual(settled.lastErrorAt!);
    expect(scheduler.listOverdueTaskIds()).toEqual([]);

    await new Promise(resolve => setTimeout(resolve, 5));
    await scheduler.tick();
    expect(starts).toBe(2);
    expect(failed).toHaveLength(1);
  });

  it('lets a handler that honors the signal settle promptly with one failure record', async () => {
    const { scheduler, failed } = harness();
    scheduler.register({
      id: 'cooperative',
      name: 'Cooperative',
      type: 'one-shot',
      intervalMs: 0,
      runAt: Date.now(),
      handler: ({ signal }) => new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
      state: 'idle',
    });

    await scheduler.tick();
    await waitFor(() => scheduler.getTask('cooperative')!.state === 'complete');
    const task = scheduler.getTask('cooperative')!;
    expect(task.lastOutcome).toBe('failed');
    expect(task.lastError).toContain(HANDLER_BUDGET_EXCEEDED);
    // The abort rejection is the expected settlement, not a second failure.
    expect(failed).toHaveLength(1);
  });

  it('records nothing extra for a handler that finishes inside its budget', async () => {
    const { scheduler, failed } = harness();
    let seen: ScheduledTaskRun | undefined;
    scheduler.register({
      id: 'quick',
      name: 'Quick',
      type: 'every',
      intervalMs: 1,
      handler: run => {
        seen = run;
      },
      state: 'idle',
    });
    await scheduler.tick();
    await new Promise(resolve => setTimeout(resolve, BUDGET_MS * 2));
    const task = scheduler.getTask('quick')!;
    expect(task.state).toBe('idle');
    expect(task.lastOutcome).toBe('succeeded');
    expect(task.lastError).toBeUndefined();
    expect(seen?.signal.aborted).toBe(false);
    expect(failed).toEqual([]);
  });

  it('delivers the attempt signal through the protected availability wrapper', async () => {
    const { scheduler, protectedStates } = harness({ runProtectedTask: true });
    const hung = deferred();
    pending.push(hung);
    let seen: ScheduledTaskRun | undefined;
    scheduler.register({
      id: 'protected',
      name: 'Protected',
      type: 'every',
      intervalMs: 1,
      availability: 'do_not_disturb',
      handler: async run => {
        seen = run;
        await hung.promise;
      },
      state: 'idle',
    });
    await scheduler.tick();
    expect(protectedStates).toEqual(['do_not_disturb']);
    expect(seen?.signal.aborted).toBe(true);
    expect(scheduler.getTask('protected')!.state).toBe('active');
  });

  it('stops without waiting for a detached overdue handler', async () => {
    const { scheduler } = harness();
    const hung = deferred();
    pending.push(hung);
    scheduler.register({
      id: 'hung',
      name: 'Hung',
      type: 'every',
      intervalMs: 1,
      handler: async () => {
        await hung.promise;
      },
      state: 'idle',
    });
    scheduler.start();
    await waitFor(() => scheduler.listOverdueTaskIds().length === 1);
    await expect(scheduler.stop()).resolves.toBeUndefined();
  });

  it('rejects a non-positive or fractional budget', () => {
    for (const taskBudgetMs of [0, -1, 1.5, Number.NaN]) {
      expect(() => new Scheduler(new EventBus(), {}, { taskBudgetMs }))
        .toThrow('taskBudgetMs must be a positive safe integer');
    }
  });
});
