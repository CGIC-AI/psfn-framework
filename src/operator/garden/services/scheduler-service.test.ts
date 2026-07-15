import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Scheduler } from '../../../core/scheduler/scheduler.js';
import type { ScheduledTask } from '../../../core/scheduler/types.js';
import {
  resolveHeartbeatPolicyPath,
  resolveReflectionMetacognitionJournalPath,
} from '../../../persistence/layout.js';
import { AdminSchedulerService } from './scheduler-service.js';
import type { HeartbeatPolicy } from '../../../core/scheduler/heartbeat-policy.js';

function makeTask(overrides: Partial<ScheduledTask> & { id: string; name: string }): ScheduledTask {
  const task: ScheduledTask = {
    id: overrides.id,
    name: overrides.name,
    type: overrides.type ?? 'every',
    intervalMs: overrides.intervalMs ?? 3_600_000,
    handler: overrides.handler ?? (() => {}),
    state: overrides.state ?? 'idle',
  };
  if (overrides.runAt !== undefined) task.runAt = overrides.runAt;
  if (overrides.cadence) task.cadence = overrides.cadence;
  if (overrides.lastRunAt !== undefined) task.lastRunAt = overrides.lastRunAt;
  if (overrides.lastFinishedAt !== undefined) task.lastFinishedAt = overrides.lastFinishedAt;
  if (overrides.lastOutcome !== undefined) task.lastOutcome = overrides.lastOutcome;
  if (overrides.lastError !== undefined) task.lastError = overrides.lastError;
  if (overrides.lastErrorAt !== undefined) task.lastErrorAt = overrides.lastErrorAt;
  if (overrides.lastDeniedReason !== undefined) task.lastDeniedReason = overrides.lastDeniedReason;
  if (overrides.description !== undefined) task.description = overrides.description;
  if (overrides.scheduleSource !== undefined) task.scheduleSource = overrides.scheduleSource;
  if (overrides.operations !== undefined) task.operations = overrides.operations;
  return task;
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

  it('uses the runtime heartbeat policy path under companion state', () => {
    const { scheduler } = createSchedulerStub();
    const service = new AdminSchedulerService(scheduler, tempDir);

    const gardenStorePath = (service as unknown as {
      policyStore: { filePath: string };
    }).policyStore.filePath;

    expect(gardenStorePath).toBe(resolveHeartbeatPolicyPath(tempDir));

    service.getFullData();

    expect(existsSync(resolveHeartbeatPolicyPath(tempDir))).toBe(true);
    expect(existsSync(join(tempDir, 'heartbeat-policy.json'))).toBe(false);
  });

  it('normalizes legacy whisper reflection tasks to the consolidated daily reflection template on task updates', () => {
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

    const policyPath = resolveHeartbeatPolicyPath(tempDir);
    const persisted = JSON.parse(readFileSync(policyPath, 'utf-8')) as HeartbeatPolicy;
    const daily = persisted.templates.find(template => template.id === 'daily-review');
    expect(daily).toBeDefined();
    expect(daily?.enabled).toBe(false);

    const data = service.getFullData();
    expect(data.reflections.find(template => template.id === 'daily-review')?.enabled).toBe(false);

    const metacognitionRaw = readFileSync(resolveReflectionMetacognitionJournalPath(tempDir), 'utf-8').trim();
    const metacognitionEntry = JSON.parse(metacognitionRaw.split('\n').at(-1) ?? '{}') as {
      kind: string;
      initiatorSurface: string;
      initiatedBy: string;
      reason?: string;
      templateId?: string;
      mutationBefore?: { enabled?: boolean };
      mutationAfter?: { enabled?: boolean };
    };
    expect(metacognitionEntry.kind).toBe('reflection_mutation');
    expect(metacognitionEntry.initiatorSurface).toBe('garden:scheduler_service');
    expect(metacognitionEntry.initiatedBy).toBe('garden_operator');
    expect(metacognitionEntry.reason).toBe('Garden scheduler task update for reflection template "daily-review"');
    expect(metacognitionEntry.templateId).toBe('daily-review');
    expect(metacognitionEntry.mutationBefore?.enabled).toBe(true);
    expect(metacognitionEntry.mutationAfter?.enabled).toBe(false);
  });

  it('normalizes legacy whisper reflection ids to the consolidated daily reflection when mutating directly', () => {
    const { scheduler } = createSchedulerStub();
    const service = new AdminSchedulerService(scheduler, tempDir);

    const result = service.updateReflection('whisper', {
      name: 'Updated Daily Reflection',
    });

    expect(result).toEqual({
      ok: true,
      message: 'Reflection "daily-review" updated',
    });

    const policyPath = resolveHeartbeatPolicyPath(tempDir);
    const persisted = JSON.parse(readFileSync(policyPath, 'utf-8')) as HeartbeatPolicy;
    const daily = persisted.templates.find(template => template.id === 'daily-review');
    expect(daily?.name).toBe('Updated Daily Reflection');

    const metacognitionRaw = readFileSync(resolveReflectionMetacognitionJournalPath(tempDir), 'utf-8').trim();
    const metacognitionEntry = JSON.parse(metacognitionRaw.split('\n').at(-1) ?? '{}') as {
      kind: string;
      initiatorSurface: string;
      initiatedBy: string;
      reason?: string;
      templateId?: string;
      mutationBefore?: { name?: string };
      mutationAfter?: { name?: string };
    };
    expect(metacognitionEntry.kind).toBe('reflection_mutation');
    expect(metacognitionEntry.initiatorSurface).toBe('garden:scheduler_service');
    expect(metacognitionEntry.initiatedBy).toBe('garden_operator');
    expect(metacognitionEntry.reason).toBe('Garden scheduler reflection template update for "daily-review"');
    expect(metacognitionEntry.templateId).toBe('daily-review');
    expect(metacognitionEntry.mutationBefore?.name).toBe('Daily Reflection');
    expect(metacognitionEntry.mutationAfter?.name).toBe('Updated Daily Reflection');
  });

  it('persists weekly cadence updates for reflection tasks', () => {
    const { scheduler, tasks } = createSchedulerStub([
      makeTask({
        id: 'reflection:weekly-review',
        name: 'Weekly Reflection',
        intervalMs: 7 * 24 * 60 * 60_000,
      }),
    ]);
    const service = new AdminSchedulerService(scheduler, tempDir);

    const result = service.updateTask('reflection:weekly-review', {
      cadence: {
        kind: 'weekly',
        dayOfWeek: 0,
        hour: 7,
        minute: 0,
        timezone: 'local',
      },
    });

    expect(result).toEqual({
      ok: true,
      message: 'Task "reflection:weekly-review" updated',
    });
    expect(tasks.get('reflection:weekly-review')?.cadence).toEqual({
      kind: 'weekly',
      dayOfWeek: 0,
      hour: 7,
      minute: 0,
      timezone: 'local',
    });

    const persisted = JSON.parse(
      readFileSync(resolveHeartbeatPolicyPath(tempDir), 'utf-8'),
    ) as HeartbeatPolicy;
    expect(persisted.templates.find(template => template.id === 'weekly-review')?.cadence).toEqual({
      kind: 'weekly',
      dayOfWeek: 0,
      hour: 7,
      minute: 0,
      timezone: 'local',
    });
  });

  it('makes owner-file-backed tasks fully read-only in the runtime scheduler surface', () => {
    const { scheduler, tasks } = createSchedulerStub([
      makeTask({
        id: 'owner-backed-probe',
        name: 'Owner-backed Probe',
        scheduleSource: 'scheduler.json > backgroundMaintenance.intervalMs',
      }),
    ]);
    const service = new AdminSchedulerService(scheduler, tempDir);
    const expected = {
      ok: false,
      message:
        'Task "owner-backed-probe" is read-only because its schedule is owned by '
        + 'scheduler.json > backgroundMaintenance.intervalMs; '
        + 'edit the canonical owner in Settings and restart to apply it',
    };

    expect(service.updateTask('owner-backed-probe', { intervalMs: 60_000 })).toEqual(expected);
    expect(service.updateTask('owner-backed-probe', { cadence: { kind: 'relative' } })).toEqual(expected);
    expect(service.updateTask('owner-backed-probe', { enabled: false })).toEqual(expected);
    expect(service.updateTask('owner-backed-probe', { name: 'Runtime Alias' })).toEqual(expected);
    expect(service.removeTask('owner-backed-probe')).toEqual(expected);
    expect(tasks.get('owner-backed-probe')).toMatchObject({
      name: 'Owner-backed Probe',
      intervalMs: 3_600_000,
      state: 'idle',
    });
  });

  it('includes scheduler runtime outcome metadata in full data', () => {
    const { scheduler } = createSchedulerStub([
      makeTask({
        id: 'runtime-metadata',
        name: 'Runtime Metadata',
        lastRunAt: 1_700_000_000_000,
        lastFinishedAt: 1_700_000_010_000,
        lastOutcome: 'failed',
        lastError: 'Task failed during test',
        lastErrorAt: 1_700_000_010_000,
      }),
    ]);
    const service = new AdminSchedulerService(scheduler, tempDir);

    expect(service.getFullData().tasks.find(task => task.id === 'runtime-metadata')).toMatchObject({
      id: 'runtime-metadata',
      lastRunAt: 1_700_000_000_000,
      lastFinishedAt: 1_700_000_010_000,
      lastOutcome: 'failed',
      lastError: 'Task failed during test',
      lastErrorAt: 1_700_000_010_000,
    });
  });

  it('exposes the bundled task description, canonical cadence owner, and exact operation manifest', () => {
    const { scheduler } = createSchedulerStub([
      makeTask({
        id: 'background-maintenance',
        name: 'Bundled Background Maintenance',
        description: 'Runs only the operations listed here.',
        scheduleSource: 'scheduler.json > backgroundMaintenance.intervalMs',
        operations: [
          {
            id: 'salience-decay',
            name: 'Memory Salience Decay',
            description: 'Apply durable-memory decay.',
          },
          {
            id: 'ambient-presence',
            name: 'Ambient Presence',
            description: 'Check quiet-time presence eligibility.',
          },
        ],
      }),
    ]);
    const service = new AdminSchedulerService(scheduler, tempDir);

    expect(service.getFullData().tasks[0]).toMatchObject({
      description: 'Runs only the operations listed here.',
      scheduleSource: 'scheduler.json > backgroundMaintenance.intervalMs',
      operations: [
        { id: 'salience-decay', name: 'Memory Salience Decay' },
        { id: 'ambient-presence', name: 'Ambient Presence' },
      ],
    });
  });
});
