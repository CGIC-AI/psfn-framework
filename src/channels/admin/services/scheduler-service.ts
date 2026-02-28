// ── Admin Scheduler Service ──
// Wraps Scheduler + HeartbeatPolicyStore for the admin JSON API.
// Provides task CRUD and reflection template management.

import { join } from 'node:path';
import type { Scheduler } from '../../../scheduler/scheduler.js';
import {
  HeartbeatPolicyStore,
  validateTemplate,
  type ReflectionTemplate,
  type ValidationError,
} from '../../../scheduler/heartbeat-policy.js';
import type { ScheduledTask, TaskType } from '../../../scheduler/types.js';
import { createComponentLogger } from '../../../logger.js';

const log = createComponentLogger('AdminSchedulerService');

/** Wire-safe task shape (no handler function). */
export interface AdminScheduledTask {
  id: string;
  name: string;
  type: TaskType;
  intervalMs: number;
  runAt?: number;
  state: string;
}

/** Full scheduler + reflections response. */
export interface AdminSchedulerFullData {
  tasks: AdminScheduledTask[];
  reflections: ReflectionTemplate[];
}

/** Result of a mutation operation. */
export interface SchedulerMutationResult {
  ok: boolean;
  message: string;
}

/** Serialize a ScheduledTask to wire-safe shape. */
function toAdminTask(task: ScheduledTask): AdminScheduledTask {
  return {
    id: task.id,
    name: task.name,
    type: task.type,
    intervalMs: task.intervalMs,
    runAt: task.runAt,
    state: task.state,
  };
}

export class AdminSchedulerService {
  private policyStore: HeartbeatPolicyStore;

  constructor(
    private readonly scheduler: Scheduler,
    private readonly dataDir: string,
  ) {
    this.policyStore = new HeartbeatPolicyStore(join(dataDir, 'heartbeat-policy.json'));
  }

  /** List all tasks and reflection templates. */
  getFullData(): AdminSchedulerFullData {
    const tasks = this.scheduler.listTasks().map(toAdminTask);
    const policy = this.policyStore.load();
    return { tasks, reflections: policy.templates };
  }

  /** List tasks only (satisfies AdminSchedulerApi). */
  listTasks(): ScheduledTask[] {
    return this.scheduler.listTasks();
  }

  /** Update a task's interval or enabled state. */
  updateTask(id: string, updates: {
    intervalMs?: number;
    enabled?: boolean;
    name?: string;
  }): SchedulerMutationResult {
    const task = this.scheduler.getTask(id);
    if (!task) {
      return { ok: false, message: `Task "${id}" not found` };
    }

    const taskUpdates: { intervalMs?: number; state?: 'idle' | 'paused'; name?: string } = {};

    if (updates.intervalMs !== undefined) {
      if (typeof updates.intervalMs !== 'number' || updates.intervalMs < 1000) {
        return { ok: false, message: 'intervalMs must be at least 1000 (1 second)' };
      }
      taskUpdates.intervalMs = updates.intervalMs;
    }

    if (updates.enabled !== undefined) {
      // Only toggle between idle and paused for 'every' tasks
      if (task.type === 'every') {
        taskUpdates.state = updates.enabled ? 'idle' : 'paused';
      }
    }

    if (updates.name !== undefined) {
      taskUpdates.name = updates.name;
    }

    const success = this.scheduler.updateTask(id, taskUpdates);
    if (!success) {
      return { ok: false, message: `Failed to update task "${id}"` };
    }

    log.info(`Task "${id}" updated`, taskUpdates);
    return { ok: true, message: `Task "${id}" updated` };
  }

  /** Create a new one-shot task (recurring tasks are system-registered only). */
  createTask(input: {
    id: string;
    name: string;
    type: TaskType;
    intervalMs?: number;
    runAt?: number;
  }): SchedulerMutationResult {
    if (!input.id || typeof input.id !== 'string') {
      return { ok: false, message: 'id is required' };
    }
    if (!input.name || typeof input.name !== 'string') {
      return { ok: false, message: 'name is required' };
    }
    if (input.type !== 'every' && input.type !== 'one-shot') {
      return { ok: false, message: 'type must be "every" or "one-shot"' };
    }

    if (this.scheduler.getTask(input.id)) {
      return { ok: false, message: `Task "${input.id}" already exists` };
    }

    if (input.type === 'every') {
      if (!input.intervalMs || input.intervalMs < 1000) {
        return { ok: false, message: 'intervalMs must be at least 1000ms for recurring tasks' };
      }
    }

    if (input.type === 'one-shot' && !input.runAt) {
      return { ok: false, message: 'runAt timestamp is required for one-shot tasks' };
    }

    try {
      this.scheduler.register({
        id: input.id,
        name: input.name,
        type: input.type,
        intervalMs: input.intervalMs ?? 0,
        runAt: input.runAt,
        handler: () => {
          log.info(`Admin-created task "${input.name}" fired`);
        },
        state: 'idle',
      });
      log.info(`Task "${input.id}" created via admin`, { type: input.type });
      return { ok: true, message: `Task "${input.id}" created` };
    } catch (err) {
      return { ok: false, message: String(err instanceof Error ? err.message : err) };
    }
  }

  /** Remove a non-system task. */
  removeTask(id: string): SchedulerMutationResult {
    const task = this.scheduler.getTask(id);
    if (!task) {
      return { ok: false, message: `Task "${id}" not found` };
    }

    // Protect core system tasks
    const protectedTasks = new Set([
      'heartbeat',
      'salience-decay',
      'maintenance',
    ]);
    if (protectedTasks.has(id)) {
      return { ok: false, message: `Task "${id}" is a system task and cannot be removed` };
    }

    const success = this.scheduler.unregister(id);
    if (!success) {
      return { ok: false, message: `Failed to remove task "${id}"` };
    }

    log.info(`Task "${id}" removed via admin`);
    return { ok: true, message: `Task "${id}" removed` };
  }

  /** Update a reflection template. */
  updateReflection(
    id: string,
    updates: Partial<ReflectionTemplate>,
  ): SchedulerMutationResult & { errors?: ValidationError[] } {
    const policy = this.policyStore.load();
    const idx = policy.templates.findIndex(t => t.id === id);
    if (idx === -1) {
      return { ok: false, message: `Reflection template "${id}" not found` };
    }

    const validationErrors = validateTemplate(updates, false);
    if (validationErrors.length > 0) {
      return { ok: false, message: validationErrors.map(e => e.message).join('; '), errors: validationErrors };
    }

    const template = policy.templates[idx];
    if (updates.name !== undefined) template.name = updates.name;
    if (updates.prompt !== undefined) template.prompt = updates.prompt;
    if (updates.intervalMs !== undefined) template.intervalMs = updates.intervalMs;
    if (updates.enabled !== undefined) template.enabled = updates.enabled;
    if (updates.sendToDiscord !== undefined) template.sendToDiscord = updates.sendToDiscord;
    if (updates.mode !== undefined) template.mode = updates.mode;
    if (updates.deliberation !== undefined) template.deliberation = updates.deliberation;

    policy.version += 1;
    policy.updatedAt = new Date().toISOString();
    policy.updatedBy = 'admin';
    this.policyStore.save(policy);

    // Sync interval change to scheduler if this template has a corresponding task
    const taskId = `reflection:${id}`;
    if (updates.intervalMs !== undefined) {
      this.scheduler.updateTask(taskId, { intervalMs: updates.intervalMs });
    }
    if (updates.enabled !== undefined) {
      this.scheduler.updateTask(taskId, {
        state: updates.enabled ? 'idle' : 'paused',
      });
    }

    log.info(`Reflection template "${id}" updated via admin`);
    return { ok: true, message: `Reflection "${id}" updated` };
  }
}
