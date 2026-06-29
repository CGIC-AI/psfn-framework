import { isRecord } from '../../../shared/utils/types.js';
// ── Admin Scheduler Service ──
// Wraps Scheduler + HeartbeatPolicyStore for the admin JSON API.
// Provides task CRUD and reflection template management.

import { join } from 'node:path';
import type { Scheduler } from '../../../core/scheduler/scheduler.js';
import { AMBIENT_PRESENCE_TASK_ID } from '../../../core/scheduler/ambient-presence.js';
import {
  HeartbeatPolicyStore,
  resolveConsolidatedReflectionTemplateId,
  type HeartbeatPolicy,
  type ReflectionDeliberationConfig,
  validateTemplate,
  type ReflectionTemplate,
  type ValidationError,
} from '../../../core/scheduler/heartbeat-policy.js';
import type {
  RecurringCadence,
  RecurringCadenceTimezone,
  ScheduledTask,
  TaskType,
} from '../../../core/scheduler/types.js';
import { resolveReflectionMetacognitionJournalPath } from '../../../persistence/layout.js';
import {
  ReflectionMetacognitionJournalStore,
  type ReflectionMutationSnapshot,
} from '../../../persistence/journals/reflection-metacognition-journal.js';
import { createComponentLogger } from '../../../shared/logger.js';

const log = createComponentLogger('AdminSchedulerService');
const REFLECTION_TASK_PREFIX = 'reflection:';
const DEFERRED_REFLECTION_TASK_PREFIX = 'reflection:deferred:';

export type AdminTaskCadence = RecurringCadence;

type ScheduledTaskWithCadence = ScheduledTask & { cadence?: unknown };

type CadenceValidationResult =
  | { ok: true; cadence: AdminTaskCadence }
  | { ok: false; message: string };


function isRecurringCadenceTimezone(value: unknown): value is RecurringCadenceTimezone {
  return value === 'local' || value === 'utc';
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cloneDeliberation(
  deliberation: ReflectionDeliberationConfig | undefined,
): ReflectionDeliberationConfig | undefined {
  if (!deliberation) return undefined;
  return {
    ...(deliberation.maxRounds !== undefined ? { maxRounds: deliberation.maxRounds } : {}),
    ...(deliberation.maxTotalTokens !== undefined ? { maxTotalTokens: deliberation.maxTotalTokens } : {}),
    ...(deliberation.maxWallTimeMs !== undefined ? { maxWallTimeMs: deliberation.maxWallTimeMs } : {}),
    ...(deliberation.voices !== undefined ? { voices: [...deliberation.voices] } : {}),
    ...(deliberation.inputUsdPerMillionTokens !== undefined
      ? { inputUsdPerMillionTokens: deliberation.inputUsdPerMillionTokens }
      : {}),
    ...(deliberation.outputUsdPerMillionTokens !== undefined
      ? { outputUsdPerMillionTokens: deliberation.outputUsdPerMillionTokens }
      : {}),
  };
}

function cloneReflectionTemplate(template: ReflectionTemplate): ReflectionTemplate {
  return {
    ...template,
    ...(template.cadence !== undefined ? { cadence: { ...template.cadence } } : {}),
    ...(template.deliberation !== undefined
      ? { deliberation: cloneDeliberation(template.deliberation) }
      : {}),
  };
}

function toReflectionMutationSnapshot(template: ReflectionTemplate): ReflectionMutationSnapshot {
  return JSON.parse(JSON.stringify(cloneReflectionTemplate(template))) as ReflectionMutationSnapshot;
}

function clonePolicy(policy: HeartbeatPolicy): HeartbeatPolicy {
  return {
    ...policy,
    templates: policy.templates.map(template => cloneReflectionTemplate(template)),
  };
}

function reflectionTemplateIdFromTaskId(taskId: string): string | null {
  if (!taskId.startsWith(REFLECTION_TASK_PREFIX)) {
    return null;
  }
  if (taskId.startsWith(DEFERRED_REFLECTION_TASK_PREFIX)) {
    return null;
  }
  const templateId = taskId.slice(REFLECTION_TASK_PREFIX.length).trim();
  if (templateId.length === 0) {
    return null;
  }
  return resolveConsolidatedReflectionTemplateId(templateId);
}

function validateCadence(input: unknown): CadenceValidationResult {
  if (!isRecord(input)) {
    return { ok: false, message: 'cadence must be an object' };
  }

  const allowedFields = new Set(['kind', 'hour', 'minute', 'timezone']);
  for (const key of Object.keys(input)) {
    if (!allowedFields.has(key)) {
      return { ok: false, message: `cadence.${key} is not supported` };
    }
  }

  const kind = input.kind;
  if (kind !== 'relative' && kind !== 'hourly' && kind !== 'daily') {
    return { ok: false, message: 'cadence.kind must be "relative", "hourly", or "daily"' };
  }

  if (kind === 'relative') {
    if (input.hour !== undefined || input.minute !== undefined || input.timezone !== undefined) {
      return { ok: false, message: 'relative cadence cannot include hour/minute/timezone' };
    }
    return { ok: true, cadence: { kind: 'relative' } };
  }

  const minuteValue = input.minute;
  if (typeof minuteValue !== 'number' || !Number.isInteger(minuteValue) || minuteValue < 0 || minuteValue > 59) {
    return { ok: false, message: 'cadence.minute must be an integer between 0 and 59' };
  }
  const minute = minuteValue;

  const timezone = input.timezone;
  if (!isRecurringCadenceTimezone(timezone)) {
    return { ok: false, message: 'cadence.timezone must be "local" or "utc"' };
  }

  const hourValue = input.hour;
  if (kind === 'daily') {
    if (typeof hourValue !== 'number' || !Number.isInteger(hourValue) || hourValue < 0 || hourValue > 23) {
      return { ok: false, message: 'cadence.hour must be an integer between 0 and 23 when cadence.kind is "daily"' };
    }
    const hour = hourValue;
    return {
      ok: true,
      cadence: {
        kind: 'daily',
        hour,
        minute,
        timezone,
      },
    };
  }

  if (hourValue !== undefined) {
    return { ok: false, message: 'cadence.hour is only allowed when cadence.kind is "daily"' };
  }

  return {
    ok: true,
    cadence: {
      kind: 'hourly',
      minute,
      timezone,
    },
  };
}

function readCadenceFromTask(task: ScheduledTask): AdminTaskCadence | undefined {
  if (task.type !== 'every') return undefined;

  const rawCadence = (task as ScheduledTaskWithCadence).cadence;
  if (rawCadence === undefined) return undefined;

  const validated = validateCadence(rawCadence);
  if (!validated.ok) {
    log.warn(`Task "${task.id}" has invalid cadence in runtime scheduler state`, {
      reason: validated.message,
    });
    return undefined;
  }

  return validated.cadence;
}

/** Wire-safe task shape (no handler function). */
export interface AdminScheduledTask {
  id: string;
  name: string;
  type: TaskType;
  intervalMs: number;
  runAt?: number;
  state: string;
  cadence?: AdminTaskCadence;
  lastRunAt?: number;
  lastFinishedAt?: number;
  lastOutcome?: string;
  lastError?: string;
  lastErrorAt?: number;
  lastDeniedReason?: string;
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
  const cadence = readCadenceFromTask(task);
  return {
    id: task.id,
    name: task.name,
    type: task.type,
    intervalMs: task.intervalMs,
    runAt: task.runAt,
    state: task.state,
    cadence,
    lastRunAt: task.lastRunAt,
    lastFinishedAt: task.lastFinishedAt,
    lastOutcome: task.lastOutcome,
    lastError: task.lastError,
    lastErrorAt: task.lastErrorAt,
    lastDeniedReason: task.lastDeniedReason,
  };
}

export class AdminSchedulerService {
  private policyStore: HeartbeatPolicyStore;
  private reflectionMetacognitionJournal: ReflectionMetacognitionJournalStore;

  constructor(
    private readonly scheduler: Scheduler,
    private readonly dataDir: string,
  ) {
    this.policyStore = new HeartbeatPolicyStore(join(dataDir, 'heartbeat-policy.json'));
    this.reflectionMetacognitionJournal = new ReflectionMetacognitionJournalStore(
      resolveReflectionMetacognitionJournalPath(dataDir),
    );
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

  private persistReflectionTaskSettings(
    taskId: string,
    updates: {
      intervalMs?: number;
      enabled?: boolean;
      name?: string;
      cadence?: AdminTaskCadence;
    },
  ): SchedulerMutationResult {
    const templateId = reflectionTemplateIdFromTaskId(taskId);
    if (!templateId) {
      return { ok: true, message: 'Task is not tied to a reflection template' };
    }

    if (
      updates.intervalMs === undefined
      && updates.enabled === undefined
      && updates.name === undefined
      && updates.cadence === undefined
    ) {
      return { ok: true, message: `No reflection settings changed for "${templateId}"` };
    }

    try {
      const policy = this.policyStore.load();
      const policyBefore = clonePolicy(policy);
      const idx = policy.templates.findIndex(t => t.id === templateId);
      if (idx === -1) {
        return { ok: false, message: `Reflection template "${templateId}" not found for task "${taskId}"` };
      }

      const template = policy.templates[idx];
      const templateBefore = cloneReflectionTemplate(template);
      if (updates.intervalMs !== undefined) template.intervalMs = updates.intervalMs;
      if (updates.enabled !== undefined) template.enabled = updates.enabled;
      if (updates.name !== undefined) template.name = updates.name;
      if (updates.cadence !== undefined) template.cadence = updates.cadence;

      policy.version += 1;
      policy.updatedAt = new Date().toISOString();
      policy.updatedBy = 'admin';
      this.policyStore.save(policy);
      void this.reflectionMetacognitionJournal.append({
        kind: 'reflection_mutation',
        occurredAt: policy.updatedAt,
        initiatorSurface: 'garden:scheduler_service',
        initiatedBy: 'garden_operator',
        reason: `Garden scheduler task update for reflection template "${templateId}"`,
        templateId,
        templateName: template.name,
        mutationBefore: toReflectionMutationSnapshot(templateBefore),
        mutationAfter: toReflectionMutationSnapshot(template),
      }).catch((error) => {
        this.policyStore.save(policyBefore);
        log.error(`Failed to persist reflection mutation audit for "${templateId}"`, {
          error: toErrorMessage(error),
        });
      });
      return { ok: true, message: `Reflection template "${templateId}" updated` };
    } catch (error) {
      return { ok: false, message: `Failed to persist reflection settings: ${toErrorMessage(error)}` };
    }
  }

  /** Update a task's cadence, interval, enabled state, or name. */
  updateTask(id: string, updates: {
    intervalMs?: number;
    enabled?: boolean;
    name?: string;
    cadence?: unknown;
  }): SchedulerMutationResult {
    const task = this.scheduler.getTask(id);
    if (!task) {
      return { ok: false, message: `Task "${id}" not found` };
    }
    const previousCadence = readCadenceFromTask(task) ?? { kind: 'relative' };

    const taskUpdates: {
      intervalMs?: number;
      state?: 'idle' | 'paused';
      name?: string;
      resetLastRun?: boolean;
      cadence?: AdminTaskCadence;
    } = {};

    if (updates.intervalMs !== undefined) {
      if (typeof updates.intervalMs !== 'number' || updates.intervalMs < 1000) {
        return { ok: false, message: 'intervalMs must be at least 1000 (1 second)' };
      }
      taskUpdates.intervalMs = updates.intervalMs;
      if (task.type === 'every') {
        taskUpdates.resetLastRun = true;
      }
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

    if (updates.cadence !== undefined) {
      if (task.type !== 'every') {
        return { ok: false, message: 'cadence can only be set for recurring tasks' };
      }
      const cadenceValidation = validateCadence(updates.cadence);
      if (!cadenceValidation.ok) {
        return { ok: false, message: cadenceValidation.message };
      }
      taskUpdates.cadence = cadenceValidation.cadence;
    }

    const reflectionSyncNeeded = reflectionTemplateIdFromTaskId(id) !== null && (
      updates.intervalMs !== undefined
      || updates.enabled !== undefined
      || updates.name !== undefined
      || updates.cadence !== undefined
    );

    const success = this.scheduler.updateTask(
      id,
      taskUpdates as Parameters<Scheduler['updateTask']>[1],
    );
    if (!success) {
      return { ok: false, message: `Failed to update task "${id}"` };
    }

    if (reflectionSyncNeeded) {
      const reflectionSyncResult = this.persistReflectionTaskSettings(id, {
        intervalMs: updates.intervalMs,
        enabled: updates.enabled,
        name: updates.name,
        cadence: taskUpdates.cadence,
      });
      if (!reflectionSyncResult.ok) {
        const rollback: Parameters<Scheduler['updateTask']>[1] = {};
        if (updates.intervalMs !== undefined) {
          rollback.intervalMs = task.intervalMs;
          rollback.resetLastRun = true;
        }
        if (updates.enabled !== undefined) {
          rollback.state = task.state;
        }
        if (updates.name !== undefined) {
          rollback.name = task.name;
        }
        if (updates.cadence !== undefined) {
          rollback.cadence = previousCadence;
        }

        const rollbackSuccess = this.scheduler.updateTask(id, rollback);
        if (!rollbackSuccess) {
          log.error(`Failed to rollback task "${id}" after reflection persistence error`, {
            rollback,
            reason: reflectionSyncResult.message,
          });
        }

        return { ok: false, message: reflectionSyncResult.message };
      }
    }

    log.info(`Task "${id}" updated`, taskUpdates);
    return { ok: true, message: `Task "${id}" updated` };
  }

  /** Create a new task. */
  createTask(input: {
    id: string;
    name: string;
    type: TaskType;
    intervalMs?: number;
    runAt?: number;
    cadence?: unknown;
  }): SchedulerMutationResult {
    if (!input.id || typeof input.id !== 'string') {
      return { ok: false, message: 'id is required' };
    }
    if (!input.name || typeof input.name !== 'string') {
      return { ok: false, message: 'name is required' };
    }
    if (!(['every', 'one-shot'] as string[]).includes(input.type)) {
      return { ok: false, message: 'type must be "every" or "one-shot"' };
    }

    if (this.scheduler.getTask(input.id)) {
      return { ok: false, message: `Task "${input.id}" already exists` };
    }

    let validatedCadence: AdminTaskCadence | undefined;
    if (input.type === 'every') {
      if (!input.intervalMs || input.intervalMs < 1000) {
        return { ok: false, message: 'intervalMs must be at least 1000ms for recurring tasks' };
      }
      if (input.cadence !== undefined) {
        const cadenceValidation = validateCadence(input.cadence);
        if (!cadenceValidation.ok) {
          return { ok: false, message: cadenceValidation.message };
        }
        validatedCadence = cadenceValidation.cadence;
      }
    }

    if (input.type === 'one-shot' && !input.runAt) {
      return { ok: false, message: 'runAt timestamp is required for one-shot tasks' };
    }
    if (input.type === 'one-shot' && input.cadence !== undefined) {
      return { ok: false, message: 'cadence can only be set for recurring tasks' };
    }

    try {
      const taskToRegister: ScheduledTask & { cadence?: AdminTaskCadence } = {
        id: input.id,
        name: input.name,
        type: input.type,
        intervalMs: input.intervalMs ?? 0,
        runAt: input.runAt,
        handler: () => {
          log.info(`Admin-created task "${input.name}" fired`);
        },
        state: 'idle',
        ...(validatedCadence ? { cadence: validatedCadence } : {}),
      };
      this.scheduler.register(taskToRegister);
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
      AMBIENT_PRESENCE_TASK_ID,
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
    const policyBefore = clonePolicy(policy);
    const templateId = resolveConsolidatedReflectionTemplateId(id.trim());
    const idx = policy.templates.findIndex(t => t.id === templateId);
    if (idx === -1) {
      return { ok: false, message: `Reflection template "${templateId}" not found` };
    }

    const validationErrors = validateTemplate(updates, false);
    if (validationErrors.length > 0) {
      return { ok: false, message: validationErrors.map(e => e.message).join('; '), errors: validationErrors };
    }

    const template = policy.templates[idx];
    const templateBefore = cloneReflectionTemplate(template);
    if (updates.name !== undefined) template.name = updates.name;
    if (updates.prompt !== undefined) template.prompt = updates.prompt;
    if (updates.intervalMs !== undefined) template.intervalMs = updates.intervalMs;
    if (updates.cadence !== undefined) template.cadence = updates.cadence;
    if (updates.enabled !== undefined) template.enabled = updates.enabled;
    if (updates.sendToDiscord !== undefined) template.sendToDiscord = updates.sendToDiscord;
    if (updates.internalStateInput !== undefined) template.internalStateInput = updates.internalStateInput;
    if (updates.mode !== undefined) template.mode = updates.mode;
    if (updates.deliberation !== undefined) template.deliberation = updates.deliberation;

    policy.version += 1;
    policy.updatedAt = new Date().toISOString();
    policy.updatedBy = 'admin';
    this.policyStore.save(policy);
    void this.reflectionMetacognitionJournal.append({
      kind: 'reflection_mutation',
      occurredAt: policy.updatedAt,
      initiatorSurface: 'garden:scheduler_service',
      initiatedBy: 'garden_operator',
      reason: `Garden scheduler reflection template update for "${templateId}"`,
      templateId,
      templateName: template.name,
      mutationBefore: toReflectionMutationSnapshot(templateBefore),
      mutationAfter: toReflectionMutationSnapshot(template),
    }).catch((error) => {
      this.policyStore.save(policyBefore);
      log.error(`Failed to persist reflection mutation audit for "${templateId}"`, {
        error: toErrorMessage(error),
      });
    });

    // Sync interval change to scheduler if this template has a corresponding task
    const taskId = `reflection:${templateId}`;
    if (updates.intervalMs !== undefined || updates.cadence !== undefined) {
      const schedulerUpdates: Parameters<Scheduler['updateTask']>[1] = {};
      if (updates.intervalMs !== undefined) {
        schedulerUpdates.intervalMs = updates.intervalMs;
        schedulerUpdates.resetLastRun = true;
      }
      if (updates.cadence !== undefined) {
        schedulerUpdates.cadence = updates.cadence;
      }
      this.scheduler.updateTask(taskId, schedulerUpdates);
    }
    if (updates.enabled !== undefined) {
      this.scheduler.updateTask(taskId, {
        state: updates.enabled ? 'idle' : 'paused',
      });
    }

    log.info(`Reflection template "${templateId}" updated via admin`);
    return { ok: true, message: `Reflection "${templateId}" updated` };
  }
}
