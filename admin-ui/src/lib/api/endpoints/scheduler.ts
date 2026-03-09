import { apiGet, apiPatch, apiPost, apiDelete } from '$lib/api/client';
import type {
  AdminSchedulerData,
  RecurringCadence,
  SchedulerMutationResult,
  ReflectionTemplate,
  TaskType,
} from '$lib/types';

/**
 * Fetch scheduler tasks and reflection templates from the admin API.
 * Endpoint: GET /api/admin/scheduler
 */
export function getSchedulerData(): Promise<AdminSchedulerData> {
  return apiGet<AdminSchedulerData>('/api/admin/scheduler');
}

/**
 * Update a scheduler task (interval, enabled state, name).
 * Endpoint: PATCH /api/admin/scheduler/tasks/:id
 */
export function updateSchedulerTask(
  taskId: string,
  updates: { intervalMs?: number; enabled?: boolean; name?: string; cadence?: RecurringCadence },
): Promise<SchedulerMutationResult> {
  return apiPatch<SchedulerMutationResult>(
    `/api/admin/scheduler/tasks/${encodeURIComponent(taskId)}`,
    updates,
  );
}

/**
 * Create a new scheduler task.
 * Endpoint: POST /api/admin/scheduler/tasks
 */
export function createSchedulerTask(input: {
  id: string;
  name: string;
  type: TaskType;
  intervalMs?: number;
  runAt?: number;
  cadence?: RecurringCadence;
}): Promise<SchedulerMutationResult> {
  return apiPost<SchedulerMutationResult>('/api/admin/scheduler/tasks', input);
}

/**
 * Remove a scheduler task.
 * Endpoint: DELETE /api/admin/scheduler/tasks/:id
 */
export function removeSchedulerTask(taskId: string): Promise<SchedulerMutationResult> {
  return apiDelete<SchedulerMutationResult>(
    `/api/admin/scheduler/tasks/${encodeURIComponent(taskId)}`,
  );
}

/**
 * Update a reflection template (prompt, interval, enabled, etc).
 * Endpoint: PATCH /api/admin/scheduler/reflections/:id
 */
export function updateReflectionTemplate(
  templateId: string,
  updates: Partial<ReflectionTemplate>,
): Promise<SchedulerMutationResult> {
  return apiPatch<SchedulerMutationResult>(
    `/api/admin/scheduler/reflections/${encodeURIComponent(templateId)}`,
    updates,
  );
}
