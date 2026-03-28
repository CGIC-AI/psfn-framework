import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Scheduler } from '../../../scheduler/scheduler.js';
import type { ScheduledTask } from '../../../scheduler/types.js';
import { AdminSchedulerService } from './scheduler-service.js';
import type { HeartbeatPolicy } from '../../../scheduler/heartbeat-policy.js';

function makeTask(overrides: Partial<ScheduledTask> & { id: string; name: string }): ScheduledTask {
  return {
    id: overrides.id,
    name: overrides.name,
    type: overrides.type ?? 'every',
    intervalMs: overrides.intervalMs ?? 3_600_000,
    runAt: overrides.runAt,
    handler: overrides.handler ?? (() => {}),
    state: overrides.state ?? 'idle',
    ...(overrides.cadence ? { cadence: overrides.cadence } : {}),
  } as ScheduledTask;
}

function createSchedulerStub(initialTasks: ScheduledTask[] = []) {
  const tasks = new Map(initialTasks.map(task => [task.id, task]));
  const scheduler = {
    listTasks: () => [...tasks.values()],
    getTask: (id: string) => tasks.get(id),
    updateTask: (id: string, updates: Partial<ScheduledTask>) => {
      const task = tasks.get(id);
      if (!task) return false;
      Object.assign(task, updates);
      return true;
    },
    register: (task: ScheduledTask) => {
      tasks.set(task.id, task);
    },
    unregister: (id: string) => tasks.delete(id),
  } as unknown as Scheduler;

  return { scheduler, tasks };
}

describe('AdminSchedulerService', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'psfn-admin-scheduler-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('normalizes legacy whisper reflection tasks to the canonical musing template on task updates', () => {
    const { scheduler } = createSchedulerStub([
      makeTask({
        id: 'reflection:whisper',
        name: 'Whisper',
        cadence: { kind: 'hourly', minute: 0, timezone: 'local' },
      }),
    ]);
    const service = new AdminSchedulerService(scheduler, tempDir);

    const result = service.updateTask('reflection:whisper', {
      enabled: false,
    });

    expect(result).toEqual({
      ok: true,
      message: 'Task "reflection:whisper" updated',
    });

    const policyPath = join(tempDir, 'heartbeat-policy.json');
    const persisted = JSON.parse(readFileSync(policyPath, 'utf-8')) as HeartbeatPolicy;
    const musing = persisted.templates.find(template => template.id === 'musing');
    expect(musing).toBeDefined();
    expect(musing?.enabled).toBe(false);

    const data = service.getFullData();
    expect(data.reflections.find(template => template.id === 'musing')?.enabled).toBe(false);
  });

  it('normalizes legacy whisper reflection ids when mutating reflection templates directly', () => {
    const { scheduler } = createSchedulerStub();
    const service = new AdminSchedulerService(scheduler, tempDir);

    const result = service.updateReflection('whisper', {
      name: 'Updated Musing',
    });

    expect(result).toEqual({
      ok: true,
      message: 'Reflection "musing" updated',
    });

    const policyPath = join(tempDir, 'heartbeat-policy.json');
    const persisted = JSON.parse(readFileSync(policyPath, 'utf-8')) as HeartbeatPolicy;
    const musing = persisted.templates.find(template => template.id === 'musing');
    expect(musing?.name).toBe('Updated Musing');
  });
});
