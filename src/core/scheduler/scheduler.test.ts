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

    it('stagger wall-clock tasks deterministically inside the configured minute', async () => {
      const first = vi.fn();
      const third = vi.fn();
      const nowSpy = vi.spyOn(Date, 'now');
      try {
        nowSpy.mockReturnValue(Date.parse('2026-03-07T06:29:00.000Z'));
        scheduler.register({
          id: 'fleet-first',
          name: 'Fleet first',
          type: 'every',
          intervalMs: 24 * 60 * 60_000,
          cadence: { kind: 'daily', hour: 6, minute: 30, timezone: 'utc' },
          fleetStagger: { manifestOrdinal: 0, fleetSize: 3 },
          handler: first,
          state: 'idle',
        });
        scheduler.register({
          id: 'fleet-third',
          name: 'Fleet third',
          type: 'every',
          intervalMs: 24 * 60 * 60_000,
          cadence: { kind: 'daily', hour: 6, minute: 30, timezone: 'utc' },
          fleetStagger: { manifestOrdinal: 2, fleetSize: 3 },
          handler: third,
          state: 'idle',
        });

        nowSpy.mockReturnValue(Date.parse('2026-03-07T06:30:00.000Z'));
        await scheduler.tick();
        expect(first).toHaveBeenCalledOnce();
        expect(third).not.toHaveBeenCalled();

        nowSpy.mockReturnValue(Date.parse('2026-03-07T06:30:39.999Z'));
        await scheduler.tick();
        expect(third).not.toHaveBeenCalled();

        nowSpy.mockReturnValue(Date.parse('2026-03-07T06:30:40.000Z'));
        await scheduler.tick();
        expect(third).toHaveBeenCalledOnce();
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('rejects invalid fleet staggering metadata', () => {
      expect(() => scheduler.register({
        id: 'fleet-invalid',
        name: 'Fleet invalid',
        type: 'every',
        intervalMs: 24 * 60 * 60_000,
        cadence: { kind: 'daily', hour: 6, minute: 30, timezone: 'utc' },
        fleetStagger: { manifestOrdinal: 3, fleetSize: 3 },
        handler: () => {},
        state: 'idle',
      })).toThrow('fleetStagger.manifestOrdinal');
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

    it('fires weekly cadence at the next wall-clock slot after restart', async () => {
      const fn = vi.fn();
      const nowSpy = vi.spyOn(Date, 'now');
      const saturdayRestartAt = new Date('2026-03-07T12:00:00.000Z').getTime();
      const sundaySlotAt = new Date('2026-03-08T07:00:00.000Z').getTime();

      try {
        nowSpy.mockReturnValue(new Date('2026-03-02T12:00:00.000Z').getTime());
        scheduler.register(
          {
            id: 'weekly-review',
            name: 'Weekly Review',
            type: 'every',
            intervalMs: 7 * 24 * 60 * 60_000,
            cadence: { kind: 'weekly', dayOfWeek: 0, hour: 7, minute: 0, timezone: 'utc' },
            handler: fn,
            state: 'idle',
          },
          { skipFirstRun: true },
        );
        await scheduler.tick();
        expect(fn).not.toHaveBeenCalled();

        const restartedScheduler = new Scheduler(eventBus, {
          tickIntervalMs: 100,
          heartbeatIntervalMs: 500,
        });
        nowSpy.mockReturnValue(saturdayRestartAt);
        restartedScheduler.register(
          {
            id: 'weekly-review',
            name: 'Weekly Review',
            type: 'every',
            intervalMs: 7 * 24 * 60 * 60_000,
            cadence: { kind: 'weekly', dayOfWeek: 0, hour: 7, minute: 0, timezone: 'utc' },
            handler: fn,
            state: 'idle',
          },
          { skipFirstRun: true },
        );
        await restartedScheduler.tick();
        expect(fn).not.toHaveBeenCalled();

        nowSpy.mockReturnValue(new Date('2026-03-08T06:59:59.000Z').getTime());
        await restartedScheduler.tick();
        expect(fn).not.toHaveBeenCalled();

        expect(sundaySlotAt - saturdayRestartAt).toBeLessThan(7 * 24 * 60 * 60_000);
        nowSpy.mockReturnValue(sundaySlotAt);
        await restartedScheduler.tick();
        expect(fn).toHaveBeenCalledOnce();
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('recovers a missed wall-clock slot exactly once from a persisted lastRunAt', async () => {
      // Outcome A: a process registering AFTER the daily slot, seeded with the
      // prior persisted run (before this slot), must fire the missed slot once
      // on the first tick instead of silently skipping it.
      const fn = vi.fn();
      const nowSpy = vi.spyOn(Date, 'now');
      try {
        // Slot is 06:30 UTC; the process restarts at 12:00 (after the slot).
        // The persisted last run was the prior day's 06:31 slot run.
        nowSpy.mockReturnValue(new Date('2026-03-07T12:00:00.000Z').getTime());
        scheduler.register(
          {
            id: 'daily-recovery',
            name: 'Daily Recovery',
            type: 'every',
            intervalMs: 24 * 60 * 60_000,
            cadence: { kind: 'daily', hour: 6, minute: 30, timezone: 'utc' },
            handler: fn,
            state: 'idle',
          },
          { lastRunAt: new Date('2026-03-06T06:31:00.000Z').getTime() },
        );

        await scheduler.tick();
        expect(fn).toHaveBeenCalledOnce();

        // The recovered slot must not fire again on a subsequent tick within
        // the same slot (lastRun was advanced to now by the firing handler).
        await scheduler.tick();
        expect(fn).toHaveBeenCalledOnce();
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('does not re-fire a recovered wall-clock slot on restart/replay with an updated lastRunAt', async () => {
      // Outcome A: after the missed slot fires, the persisted anchor advances.
      // Re-registering (restart/replay) with that updated lastRunAt must not
      // duplicate the recovered slot.
      const fn = vi.fn();
      const nowSpy = vi.spyOn(Date, 'now');
      try {
        nowSpy.mockReturnValue(new Date('2026-03-07T12:00:00.000Z').getTime());
        const restartedScheduler = new Scheduler(eventBus, {
          tickIntervalMs: 100,
          heartbeatIntervalMs: 500,
        });
        // Updated anchor: the slot already ran this period (at 12:00, after the
        // 06:30 slot start), so the slot is satisfied and must not fire again.
        restartedScheduler.register(
          {
            id: 'daily-replay',
            name: 'Daily Replay',
            type: 'every',
            intervalMs: 24 * 60 * 60_000,
            cadence: { kind: 'daily', hour: 6, minute: 30, timezone: 'utc' },
            handler: fn,
            state: 'idle',
          },
          { lastRunAt: new Date('2026-03-07T12:00:00.000Z').getTime() },
        );

        await restartedScheduler.tick();
        expect(fn).not.toHaveBeenCalled();

        // The next legitimate slot (tomorrow 06:30) still fires normally.
        nowSpy.mockReturnValue(new Date('2026-03-08T06:30:00.000Z').getTime());
        await restartedScheduler.tick();
        expect(fn).toHaveBeenCalledOnce();
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('does not fire a recovered wall-clock slot when the persisted run is already in the current slot', async () => {
      // The prior persisted run already satisfied today's slot (ran at 07:00,
      // after the 06:30 slot start), so registering later the same day must not
      // re-fire — restart/replay must not duplicate a satisfied slot.
      const fn = vi.fn();
      const nowSpy = vi.spyOn(Date, 'now');
      try {
        nowSpy.mockReturnValue(new Date('2026-03-07T15:00:00.000Z').getTime());
        scheduler.register(
          {
            id: 'daily-satisfied',
            name: 'Daily Satisfied',
            type: 'every',
            intervalMs: 24 * 60 * 60_000,
            cadence: { kind: 'daily', hour: 6, minute: 30, timezone: 'utc' },
            handler: fn,
            state: 'idle',
          },
          { lastRunAt: new Date('2026-03-07T07:00:00.000Z').getTime() },
        );

        await scheduler.tick();
        expect(fn).not.toHaveBeenCalled();
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
      const failures: Array<{
        taskId: string;
        taskName: string;
        type: string;
        error: string;
        timestamp: number;
      }> = [];
      eventBus.on('schedule.task.failed', (event) => {
        failures.push(event);
      });
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
        expect(failures).toEqual([{
          taskId: 'metadata-failure',
          taskName: 'Metadata Failure',
          type: 'every',
          error: 'Error: scheduler test failure',
          timestamp: 1_700_000_010_000,
        }]);
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

  describe('lastRunAt option', () => {
    it('fires immediately when the persisted last run is older than the interval', async () => {
      const fn = vi.fn();
      scheduler.register(
        {
          id: 'seeded-overdue',
          name: 'Seeded Overdue',
          type: 'every',
          intervalMs: 60_000,
          handler: fn,
          state: 'idle',
        },
        { lastRunAt: Date.now() - 120_000 },
      );

      await scheduler.tick();
      expect(fn).toHaveBeenCalledOnce();
    });

    it('waits out the remaining interval when the persisted last run is recent', async () => {
      const fn = vi.fn();
      scheduler.register(
        {
          id: 'seeded-recent',
          name: 'Seeded Recent',
          type: 'every',
          intervalMs: 999_999,
          handler: fn,
          state: 'idle',
        },
        { lastRunAt: Date.now() - 1_000 },
      );

      await scheduler.tick();
      expect(fn).not.toHaveBeenCalled();
    });

    it('treats lastRunAt 0 as never run', async () => {
      const fn = vi.fn();
      scheduler.register(
        {
          id: 'seeded-never',
          name: 'Seeded Never',
          type: 'every',
          intervalMs: 999_999,
          handler: fn,
          state: 'idle',
        },
        { lastRunAt: 0 },
      );

      await scheduler.tick();
      expect(fn).toHaveBeenCalledOnce();
    });

    it('rejects a non-finite or negative lastRunAt', () => {
      const task: ScheduledTask = {
        id: 'seeded-invalid',
        name: 'Seeded Invalid',
        type: 'every',
        intervalMs: 1_000,
        handler: () => {},
        state: 'idle',
      };

      expect(() => scheduler.register(task, { lastRunAt: Number.NaN }))
        .toThrow(/lastRunAt must be a non-negative finite epoch/);
      expect(() => scheduler.register(task, { lastRunAt: -1 }))
        .toThrow(/lastRunAt must be a non-negative finite epoch/);
    });

    it('rejects combining lastRunAt with skipFirstRun', () => {
      expect(() => scheduler.register(
        {
          id: 'seeded-conflict',
          name: 'Seeded Conflict',
          type: 'every',
          intervalMs: 1_000,
          handler: () => {},
          state: 'idle',
        },
        { lastRunAt: Date.now(), skipFirstRun: true },
      )).toThrow(/cannot combine lastRunAt with skipFirstRun/);
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

  describe('adaptive next-wake (sub-tick scheduling)', () => {
    // Coarse ceiling of 60s — the old fixed setInterval floor. These prove the
    // self-rescheduling timer fires sub-minute work far ahead of that ceiling.
    const CEILING_MS = 60_000;
    // Slightly above the scheduler's internal ~50ms wake floor so the first
    // immediately-due run is observed without depending on the exact floor value.
    const MIN_WAKE_TOLERANCE_MS = 60;

    it('fires a one-shot due in 250ms well before the 60s ceiling', async () => {
      vi.useFakeTimers();
      try {
        const bus = new EventBus();
        const adaptive = new Scheduler(bus, {
          tickIntervalMs: CEILING_MS,
          heartbeatIntervalMs: 30 * 60_000,
        });
        const fn = vi.fn();
        adaptive.register({
          id: 'subtick-one-shot',
          name: 'Sub-tick One Shot',
          type: 'one-shot',
          intervalMs: 0,
          runAt: Date.now() + 250,
          handler: fn,
          state: 'idle',
        });

        adaptive.start();

        // Under the old fixed 60s setInterval this fires only at the 60s edge.
        await vi.advanceTimersByTimeAsync(300);
        expect(fn).toHaveBeenCalledOnce();

        await adaptive.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it('honors requestWake to fire a near-term one-shot registered after start', async () => {
      vi.useFakeTimers();
      try {
        const bus = new EventBus();
        const adaptive = new Scheduler(bus, {
          tickIntervalMs: CEILING_MS,
          heartbeatIntervalMs: 30 * 60_000,
        });

        adaptive.start();

        const fn = vi.fn();
        const runAt = Date.now() + 250;
        adaptive.register({
          id: 'late-one-shot',
          name: 'Late One Shot',
          type: 'one-shot',
          intervalMs: 0,
          runAt,
          handler: fn,
          state: 'idle',
        });
        adaptive.requestWake(runAt);

        await vi.advanceTimersByTimeAsync(300);
        expect(fn).toHaveBeenCalledOnce();

        await adaptive.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it('re-arms on register() alone so a near-term one-shot fires without an explicit requestWake', async () => {
      vi.useFakeTimers();
      try {
        const bus = new EventBus();
        const adaptive = new Scheduler(bus, {
          tickIntervalMs: CEILING_MS,
          heartbeatIntervalMs: 30 * 60_000,
        });

        adaptive.start();

        const fn = vi.fn();
        adaptive.register({
          id: 'auto-wake-one-shot',
          name: 'Auto Wake One Shot',
          type: 'one-shot',
          intervalMs: 0,
          runAt: Date.now() + 250,
          handler: fn,
          state: 'idle',
        });
        // No explicit requestWake here — register() must re-arm the adaptive wake
        // itself, or this would only fire at the 60s ceiling.
        await vi.advanceTimersByTimeAsync(300);
        expect(fn).toHaveBeenCalledOnce();

        await adaptive.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it('re-arms on updateTask() when a one-shot is moved to a nearer due time', async () => {
      vi.useFakeTimers();
      try {
        const bus = new EventBus();
        const adaptive = new Scheduler(bus, {
          tickIntervalMs: CEILING_MS,
          heartbeatIntervalMs: 30 * 60_000,
        });

        const fn = vi.fn();
        // Registered before start with a far-future runAt: the armed wake is the
        // coarse ceiling, not this task.
        adaptive.register({
          id: 'reschedule-one-shot',
          name: 'Reschedule One Shot',
          type: 'one-shot',
          intervalMs: 0,
          runAt: Date.now() + 10 * CEILING_MS,
          handler: fn,
          state: 'idle',
        });

        adaptive.start();

        // Move it to fire soon. updateTask() must re-arm the adaptive wake.
        adaptive.updateTask('reschedule-one-shot', { runAt: Date.now() + 250 });

        await vi.advanceTimersByTimeAsync(300);
        expect(fn).toHaveBeenCalledOnce();

        await adaptive.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it('arms exactly one wake when idle and re-arms one at the coarse boundary (no busy loop)', async () => {
      vi.useFakeTimers();
      try {
        const bus = new EventBus();
        const ticks: number[] = [];
        bus.on('schedule.tick', ({ timestamp }) => { ticks.push(timestamp); });
        const adaptive = new Scheduler(bus, {
          tickIntervalMs: CEILING_MS,
          heartbeatIntervalMs: 30 * 60_000,
        });

        adaptive.start();

        // Well before the coarse boundary: no ticks — the idle scheduler is not
        // spinning in a tight loop firing repeatedly.
        await vi.advanceTimersByTimeAsync(CEILING_MS - 1_000);
        expect(ticks).toHaveLength(0);

        // Crossing the boundary triggers exactly one tick; the timer re-arms once
        // more so the next boundary yields exactly one more — steady coarse cadence.
        await vi.advanceTimersByTimeAsync(1_000);
        expect(ticks).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(CEILING_MS);
        expect(ticks).toHaveLength(2);

        await adaptive.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps firing a periodic task on cadence via adaptive re-arming', async () => {
      vi.useFakeTimers();
      try {
        const bus = new EventBus();
        const adaptive = new Scheduler(bus, {
          tickIntervalMs: CEILING_MS,
          heartbeatIntervalMs: 30 * 60_000,
        });
        const fn = vi.fn();
        adaptive.register({
          id: 'periodic-500',
          name: 'Periodic 500ms',
          type: 'every',
          intervalMs: 500,
          handler: fn,
          state: 'idle',
        });

        adaptive.start();

        // First run: lastRun === 0 is immediately due, fired within the wake floor.
        await vi.advanceTimersByTimeAsync(MIN_WAKE_TOLERANCE_MS);
        expect(fn).toHaveBeenCalledOnce();

        await vi.advanceTimersByTimeAsync(500);
        expect(fn).toHaveBeenCalledTimes(2);

        await vi.advanceTimersByTimeAsync(500);
        expect(fn).toHaveBeenCalledTimes(3);

        await adaptive.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it('clears the timer on stop so no further ticks fire', async () => {
      vi.useFakeTimers();
      try {
        const bus = new EventBus();
        const ticks: number[] = [];
        bus.on('schedule.tick', ({ timestamp }) => { ticks.push(timestamp); });
        const adaptive = new Scheduler(bus, {
          tickIntervalMs: CEILING_MS,
          heartbeatIntervalMs: 30 * 60_000,
        });

        adaptive.start();
        await adaptive.stop();

        // No timer remains armed: advancing well past several ceilings fires nothing.
        await vi.advanceTimersByTimeAsync(CEILING_MS * 2);
        expect(ticks).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
