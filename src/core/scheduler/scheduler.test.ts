import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventBus } from '../../shared/event-bus.js';
import { createEligibilityGate } from '../../system/capabilities/eligibility.js';
import { Scheduler } from './scheduler.js';
import type { ScheduledTask } from './types.js';

describe('Scheduler', () => {
  let eventBus: EventBus;
  let scheduler: Scheduler;

  beforeEach(() => {
    eventBus = new EventBus();
    scheduler = new Scheduler(eventBus, {
      tickIntervalMs: 100,
      heartbeatIntervalMs: 500,
    });
  });

  describe('task registration', () => {
    it('registers and lists tasks', () => {
      const task: ScheduledTask = {
        id: 'test-1',
        name: 'Test Task',
        type: 'every',
        intervalMs: 1000,
        handler: () => {},
        state: 'idle',
      };

      scheduler.register(task);
      expect(scheduler.taskCount).toBe(1);

      const listed = scheduler.listTasks();
      expect(listed).toHaveLength(1);
      expect(listed[0].id).toBe('test-1');
      expect(listed[0].name).toBe('Test Task');
    });

    it('throws on duplicate registration', () => {
      const task: ScheduledTask = {
        id: 'dup',
        name: 'Dup',
        type: 'every',
        intervalMs: 1000,
        handler: () => {},
        state: 'idle',
      };

      scheduler.register(task);
      expect(() => scheduler.register(task)).toThrow('already registered');
    });

    it('rejects recurring task registration with non-positive interval', () => {
      expect(() => scheduler.register({
        id: 'bad-every',
        name: 'Bad Every',
        type: 'every',
        intervalMs: 0,
        handler: () => {},
        state: 'idle',
      })).toThrow('intervalMs must be a positive finite number');
    });

    it('unregisters tasks', () => {
      scheduler.register({
        id: 'rm-me',
        name: 'Remove Me',
        type: 'every',
        intervalMs: 1000,
        handler: () => {},
        state: 'idle',
      });

      expect(scheduler.unregister('rm-me')).toBe(true);
      expect(scheduler.taskCount).toBe(0);
      expect(scheduler.unregister('nonexistent')).toBe(false);
    });

    it('retrieves a task by id', () => {
      scheduler.register({
        id: 'get-me',
        name: 'Get Me',
        type: 'every',
        intervalMs: 1000,
        handler: () => {},
        state: 'idle',
      });

      const task = scheduler.getTask('get-me');
      expect(task).toBeDefined();
      expect(task!.name).toBe('Get Me');
      expect(scheduler.getTask('nope')).toBeUndefined();
    });
  });

  describe('tick — every tasks', () => {
    it('runs a due "every" task on first tick', async () => {
      const fn = vi.fn();
      scheduler.register({
        id: 'every-1',
        name: 'Every 1s',
        type: 'every',
        intervalMs: 1000,
        handler: fn,
        state: 'idle',
      });

      await scheduler.tick();
      expect(fn).toHaveBeenCalledOnce();
    });

    it('does not re-run task before interval elapses', async () => {
      const fn = vi.fn();
      scheduler.register({
        id: 'every-slow',
        name: 'Slow',
        type: 'every',
        intervalMs: 999_999,
        handler: fn,
        state: 'idle',
      });

      await scheduler.tick(); // first run (lastRun === 0)
      expect(fn).toHaveBeenCalledOnce();

      await scheduler.tick(); // too soon
      expect(fn).toHaveBeenCalledOnce();
    });

    it('re-runs task after interval elapses', async () => {
      const fn = vi.fn();
      scheduler.register({
        id: 'every-fast',
        name: 'Fast',
        type: 'every',
        intervalMs: 1, // 1ms — always due
        handler: fn,
        state: 'idle',
      });

      await scheduler.tick();
      expect(fn).toHaveBeenCalledOnce();

      // Wait just a hair to ensure interval passes
      await new Promise(r => setTimeout(r, 5));
      await scheduler.tick();
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  describe('tick — wall-clock cadence', () => {
    it('aligns hourly cadence to wall-clock minute slots', async () => {
      const fn = vi.fn();
      const nowSpy = vi.spyOn(Date, 'now');
      try {
        nowSpy.mockReturnValue(new Date('2026-03-07T10:15:00.000Z').getTime());
        scheduler.register({
          id: 'hourly-top',
          name: 'Hourly Top',
          type: 'every',
          intervalMs: 60 * 60_000,
          cadence: { kind: 'hourly', minute: 0, timezone: 'utc' },
          handler: fn,
          state: 'idle',
        });

        await scheduler.tick();
        expect(fn).not.toHaveBeenCalled();

        nowSpy.mockReturnValue(new Date('2026-03-07T10:59:59.000Z').getTime());
        await scheduler.tick();
        expect(fn).not.toHaveBeenCalled();

        nowSpy.mockReturnValue(new Date('2026-03-07T11:00:00.000Z').getTime());
        await scheduler.tick();
        expect(fn).toHaveBeenCalledTimes(1);

        nowSpy.mockReturnValue(new Date('2026-03-07T11:25:00.000Z').getTime());
        await scheduler.tick();
        expect(fn).toHaveBeenCalledTimes(1);

        nowSpy.mockReturnValue(new Date('2026-03-07T12:00:00.000Z').getTime());
        await scheduler.tick();
        expect(fn).toHaveBeenCalledTimes(2);
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('fires daily cadence at fixed hour:minute slots', async () => {
      const fn = vi.fn();
      const nowSpy = vi.spyOn(Date, 'now');
      try {
        nowSpy.mockReturnValue(new Date('2026-03-07T04:00:00.000Z').getTime());
        scheduler.register({
          id: 'daily-fixed',
          name: 'Daily Fixed',
          type: 'every',
          intervalMs: 24 * 60 * 60_000,
          cadence: { kind: 'daily', hour: 6, minute: 30, timezone: 'utc' },
          handler: fn,
          state: 'idle',
        });

        await scheduler.tick();
        expect(fn).not.toHaveBeenCalled();

        nowSpy.mockReturnValue(new Date('2026-03-07T06:29:59.000Z').getTime());
        await scheduler.tick();
        expect(fn).not.toHaveBeenCalled();

        nowSpy.mockReturnValue(new Date('2026-03-07T06:30:00.000Z').getTime());
        await scheduler.tick();
        expect(fn).toHaveBeenCalledTimes(1);

        nowSpy.mockReturnValue(new Date('2026-03-08T06:29:59.000Z').getTime());
        await scheduler.tick();
        expect(fn).toHaveBeenCalledTimes(1);

        nowSpy.mockReturnValue(new Date('2026-03-08T06:30:00.000Z').getTime());
        await scheduler.tick();
        expect(fn).toHaveBeenCalledTimes(2);
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('does not fire wall-clock tasks immediately on startup', async () => {
      const fn = vi.fn();
      const nowSpy = vi.spyOn(Date, 'now');
      try {
        nowSpy.mockReturnValue(new Date('2026-03-07T10:05:00.000Z').getTime());
        scheduler.register({
          id: 'startup-hourly',
          name: 'Startup Hourly',
          type: 'every',
          intervalMs: 60 * 60_000,
          cadence: { kind: 'hourly', minute: 0, timezone: 'utc' },
          handler: fn,
          state: 'idle',
        });

        await scheduler.tick();
        expect(fn).not.toHaveBeenCalled();

        nowSpy.mockReturnValue(new Date('2026-03-07T10:59:59.000Z').getTime());
        await scheduler.tick();
        expect(fn).not.toHaveBeenCalled();

        nowSpy.mockReturnValue(new Date('2026-03-07T11:00:00.000Z').getTime());
        await scheduler.tick();
        expect(fn).toHaveBeenCalledOnce();
      } finally {
        nowSpy.mockRestore();
      }
    });
  });

  describe('tick — one-shot tasks', () => {
    it('runs a one-shot task when runAt is in the past', async () => {
      const fn = vi.fn();
      scheduler.register({
        id: 'shot-1',
        name: 'Fire Once',
        type: 'one-shot',
        intervalMs: 0,
        runAt: Date.now() - 1000, // already due
        handler: fn,
        state: 'idle',
      });

      await scheduler.tick();
      expect(fn).toHaveBeenCalledOnce();

      // After firing, state should be 'complete' — won't run again
      const task = scheduler.getTask('shot-1');
      expect(task!.state).toBe('complete');

      await scheduler.tick();
      expect(fn).toHaveBeenCalledOnce(); // still 1
    });

    it('does not run a one-shot before its time', async () => {
      const fn = vi.fn();
      scheduler.register({
        id: 'shot-future',
        name: 'Future Shot',
        type: 'one-shot',
        intervalMs: 0,
        runAt: Date.now() + 999_999,
        handler: fn,
        state: 'idle',
      });

      await scheduler.tick();
      expect(fn).not.toHaveBeenCalled();
    });
  });

  describe('paused tasks', () => {
    it('does not run paused tasks', async () => {
      const fn = vi.fn();
      scheduler.register({
        id: 'paused-1',
        name: 'Paused',
        type: 'every',
        intervalMs: 1,
        handler: fn,
        state: 'paused',
      });

      await scheduler.tick();
      expect(fn).not.toHaveBeenCalled();
    });
  });

  describe('event emission', () => {
    it('emits schedule.tick on every tick', async () => {
      const ticks: number[] = [];
      eventBus.on('schedule.tick', ({ timestamp }) => { ticks.push(timestamp); });

      await scheduler.tick();
      await scheduler.tick();
      expect(ticks).toHaveLength(2);
      expect(ticks[0]).toBeLessThanOrEqual(ticks[1]);
    });

    it('emits schedule.task.run when a task fires', async () => {
      const runs: Array<{ taskId: string; taskName: string; type: string }> = [];
      eventBus.on('schedule.task.run', (data) => { runs.push(data); });

      scheduler.register({
        id: 'emit-test',
        name: 'Emitter',
        type: 'every',
        intervalMs: 1,
        handler: () => {},
        state: 'idle',
      });

      await scheduler.tick();
      expect(runs).toHaveLength(1);
      expect(runs[0]).toEqual({
        taskId: 'emit-test',
        taskName: 'Emitter',
        type: 'every',
      });
    });

    it('emits schedule.task.denied when eligibility blocks a task', async () => {
      const deniedRuns: Array<{ taskId: string; reasonCode: string; missingTokens: string[] }> = [];
      eventBus.on('schedule.task.denied', (data) => {
        deniedRuns.push({
          taskId: data.taskId,
          reasonCode: data.reasonCode,
          missingTokens: data.missingTokens,
        });
      });

      const gate = createEligibilityGate(() => ({
        getTier: () => 'custom',
        getGrantedTokens: () => new Set(),
        has: () => false,
      }));
      const gatedScheduler = new Scheduler(
        eventBus,
        { tickIntervalMs: 100, heartbeatIntervalMs: 500 },
        { eligibilityGate: gate },
      );

      const handler = vi.fn();
      gatedScheduler.register({
        id: 'blocked-task',
        name: 'Blocked Task',
        type: 'every',
        intervalMs: 1,
        handler,
        eligibility: { requiredTokens: ['memory.write'] },
        state: 'idle',
      });

      await gatedScheduler.tick();

      expect(handler).not.toHaveBeenCalled();
      expect(deniedRuns).toEqual([{
        taskId: 'blocked-task',
        reasonCode: 'missing_capability_tokens',
        missingTokens: ['memory.write'],
      }]);
    });

    it('exposes runtime outcome metadata for successful task runs', async () => {
      const nowSpy = vi.spyOn(Date, 'now');
      try {
        nowSpy.mockReturnValue(1_700_000_000_000);
        scheduler.register({
          id: 'metadata-success',
          name: 'Metadata Success',
          type: 'every',
          intervalMs: 1,
          handler: () => {},
          state: 'idle',
        });

        await scheduler.tick();

        expect(scheduler.getTask('metadata-success')).toMatchObject({
          lastRunAt: 1_700_000_000_000,
          lastFinishedAt: 1_700_000_000_000,
          lastOutcome: 'succeeded',
        });
        expect(scheduler.getTask('metadata-success')?.lastError).toBeUndefined();
        expect(scheduler.getTask('metadata-success')?.lastDeniedReason).toBeUndefined();
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('exposes runtime outcome metadata for failed task runs', async () => {
      const nowSpy = vi.spyOn(Date, 'now');
      try {
        nowSpy.mockReturnValue(1_700_000_010_000);
        scheduler.register({
          id: 'metadata-failure',
          name: 'Metadata Failure',
          type: 'every',
          intervalMs: 1,
          handler: () => {
            throw new Error('scheduler test failure');
          },
          state: 'idle',
        });

        await scheduler.tick();

        expect(scheduler.getTask('metadata-failure')).toMatchObject({
          state: 'idle',
          lastRunAt: 1_700_000_010_000,
          lastFinishedAt: 1_700_000_010_000,
          lastOutcome: 'failed',
          lastError: 'Error: scheduler test failure',
          lastErrorAt: 1_700_000_010_000,
        });
        expect(scheduler.getTask('metadata-failure')?.lastDeniedReason).toBeUndefined();
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('exposes runtime outcome metadata for eligibility-denied task runs', async () => {
      const nowSpy = vi.spyOn(Date, 'now');
      try {
        nowSpy.mockReturnValue(1_700_000_020_000);
        const gate = createEligibilityGate(() => ({
          getTier: () => 'custom',
          getGrantedTokens: () => new Set(),
          has: () => false,
        }));
        const gatedScheduler = new Scheduler(
          eventBus,
          { tickIntervalMs: 100, heartbeatIntervalMs: 500 },
          { eligibilityGate: gate },
        );

        gatedScheduler.register({
          id: 'metadata-denied',
          name: 'Metadata Denied',
          type: 'every',
          intervalMs: 1,
          handler: vi.fn(),
          eligibility: { requiredTokens: ['memory.write'] },
          state: 'idle',
        });

        await gatedScheduler.tick();

        expect(gatedScheduler.getTask('metadata-denied')).toMatchObject({
          state: 'idle',
          lastRunAt: 1_700_000_020_000,
          lastFinishedAt: 1_700_000_020_000,
          lastOutcome: 'denied',
          lastDeniedReason: 'missing_capability_tokens',
        });
        expect(gatedScheduler.getTask('metadata-denied')?.lastError).toBeUndefined();
      } finally {
        nowSpy.mockRestore();
      }
    });
  });

  describe('updateTask', () => {
    it('modifies intervalMs', () => {
      scheduler.register({
        id: 'upd-interval',
        name: 'Updatable',
        type: 'every',
        intervalMs: 1000,
        handler: () => {},
        state: 'idle',
      });

      const result = scheduler.updateTask('upd-interval', { intervalMs: 5000 });
      expect(result).toBe(true);
      expect(scheduler.getTask('upd-interval')!.intervalMs).toBe(5000);
    });

    it('modifies state', () => {
      scheduler.register({
        id: 'upd-state',
        name: 'Updatable',
        type: 'every',
        intervalMs: 1000,
        handler: () => {},
        state: 'idle',
      });

      const result = scheduler.updateTask('upd-state', { state: 'paused' });
      expect(result).toBe(true);
      expect(scheduler.getTask('upd-state')!.state).toBe('paused');
    });

    it('modifies name', () => {
      scheduler.register({
        id: 'upd-name',
        name: 'Old Name',
        type: 'every',
        intervalMs: 1000,
        handler: () => {},
        state: 'idle',
      });

      const result = scheduler.updateTask('upd-name', { name: 'New Name' });
      expect(result).toBe(true);
      expect(scheduler.getTask('upd-name')!.name).toBe('New Name');
    });

    it('modifies runAt for one-shot tasks', () => {
      const runAt = Date.now() + 60_000;
      scheduler.register({
        id: 'upd-runAt',
        name: 'One Shot',
        type: 'one-shot',
        intervalMs: 0,
        runAt,
        handler: () => {},
        state: 'idle',
      });

      const nextRunAt = runAt + 60_000;
      const result = scheduler.updateTask('upd-runAt', { runAt: nextRunAt });
      expect(result).toBe(true);
      expect(scheduler.getTask('upd-runAt')!.runAt).toBe(nextRunAt);
    });

    it('returns false for nonexistent task', () => {
      const result = scheduler.updateTask('does-not-exist', { intervalMs: 5000 });
      expect(result).toBe(false);
    });

    it('rejects invalid recurring interval updates', () => {
      scheduler.register({
        id: 'upd-invalid',
        name: 'Updatable',
        type: 'every',
        intervalMs: 1_000,
        handler: () => {},
        state: 'idle',
      });

      const result = scheduler.updateTask('upd-invalid', { intervalMs: 0 });
      expect(result).toBe(false);
      expect(scheduler.getTask('upd-invalid')?.intervalMs).toBe(1_000);
    });
  });

  describe('skipFirstRun option', () => {
    it('skips first-tick execution when skipFirstRun is true', async () => {
      const fn = vi.fn();
      scheduler.register(
        {
          id: 'skip-first',
          name: 'Skip First',
          type: 'every',
          intervalMs: 999_999,
          handler: fn,
          state: 'idle',
        },
        { skipFirstRun: true },
      );

      await scheduler.tick();
      expect(fn).not.toHaveBeenCalled();
    });

    it('runs on first tick without skipFirstRun', async () => {
      const fn = vi.fn();
      scheduler.register({
        id: 'no-skip',
        name: 'No Skip',
        type: 'every',
        intervalMs: 999_999,
        handler: fn,
        state: 'idle',
      });

      await scheduler.tick();
      expect(fn).toHaveBeenCalledOnce();
    });
  });

  describe('heartbeat', () => {
    it('registers heartbeat as a special every task', () => {
      scheduler.registerHeartbeat(() => {});
      const task = scheduler.getTask('heartbeat');
      expect(task).toBeDefined();
      expect(task!.name).toBe('Heartbeat');
      expect(task!.type).toBe('every');
      expect(task!.intervalMs).toBe(500); // from config
    });

    it('heartbeat fires on tick', async () => {
      const fn = vi.fn();
      scheduler.registerHeartbeat(fn);

      await scheduler.tick();
      expect(fn).toHaveBeenCalledOnce();
    });

    it('applies updated heartbeat interval to registered heartbeat task', () => {
      scheduler.registerHeartbeat(() => {});
      scheduler.updateConfig({ heartbeatIntervalMs: 1_250 });
      expect(scheduler.getTask('heartbeat')?.intervalMs).toBe(1_250);
    });

    it('uses updated heartbeat interval for future heartbeat registration', () => {
      scheduler.updateConfig({ heartbeatIntervalMs: 2_000 });
      scheduler.registerHeartbeat(() => {});
      expect(scheduler.getTask('heartbeat')?.intervalMs).toBe(2_000);
    });
  });

  describe('error handling', () => {
    it('continues running other tasks if one throws', async () => {
      const fn1 = vi.fn(() => { throw new Error('boom'); });
      const fn2 = vi.fn();

      scheduler.register({
        id: 'fail',
        name: 'Failer',
        type: 'every',
        intervalMs: 1,
        handler: fn1,
        state: 'idle',
      });
      scheduler.register({
        id: 'ok',
        name: 'OK',
        type: 'every',
        intervalMs: 1,
        handler: fn2,
        state: 'idle',
      });

      // Suppress expected error log
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await scheduler.tick();
      spy.mockRestore();

      expect(fn1).toHaveBeenCalledOnce();
      expect(fn2).toHaveBeenCalledOnce();
    });

    it('resets "every" task to idle after error', async () => {
      scheduler.register({
        id: 'fail-reset',
        name: 'Fail Reset',
        type: 'every',
        intervalMs: 1,
        handler: () => { throw new Error('oops'); },
        state: 'idle',
      });

      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await scheduler.tick();
      spy.mockRestore();

      const task = scheduler.getTask('fail-reset');
      expect(task!.state).toBe('idle');
    });
  });

  describe('start/stop', () => {
    it('start creates a timer and stop clears it', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      scheduler.start();
      // Start again should be no-op
      scheduler.start();
      await scheduler.stop();
      // Stop again should be no-op
      await scheduler.stop();
      logSpy.mockRestore();
    });

    it('waits for in-flight tick work to drain during stop', async () => {
      let resolveTask: (() => void) | null = null;
      scheduler.register({
        id: 'drain-test',
        name: 'Drain Test',
        type: 'every',
        intervalMs: 1,
        handler: () => new Promise<void>((resolve) => {
          resolveTask = resolve;
        }),
        state: 'idle',
      });

      const tickPromise = scheduler.tick();
      await Promise.resolve();

      let stopped = false;
      const stopPromise = scheduler.stop().then(() => {
        stopped = true;
      });
      await Promise.resolve();

      expect(stopped).toBe(false);

      resolveTask?.();
      await tickPromise;
      await stopPromise;

      expect(stopped).toBe(true);
    });
  });
});
