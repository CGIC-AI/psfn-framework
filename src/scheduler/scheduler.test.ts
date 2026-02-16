import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventBus } from '../event-bus.js';
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
    it('start creates a timer and stop clears it', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      scheduler.start();
      // Start again should be no-op
      scheduler.start();
      scheduler.stop();
      // Stop again should be no-op
      scheduler.stop();
      logSpy.mockRestore();
    });
  });
});
