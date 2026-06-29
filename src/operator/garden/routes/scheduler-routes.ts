import { sendJson } from '../../../channels/backplane/http/primitives.js';
import type { ReflectionTemplate } from '../../../core/scheduler/heartbeat-policy.js';
import type { ScheduledTask, TaskType } from '../../../core/scheduler/types.js';
import type { AdminSchedulerApi } from '../admin-contract.js';
import { parseAdminJsonBody } from '../request-body.js';
import { exactPath, prefixedParamPath } from '../route-matchers.js';
import type { AdminApiRoute, AdminBodyReader } from './types.js';

export function buildAdminSchedulerRoutes(options: {
  scheduler?: AdminSchedulerApi | null;
  withBody: AdminBodyReader;
}): AdminApiRoute[] {
  const { scheduler, withBody } = options;

  return [
    // ── Scheduler ──
    {
      method: 'GET',
      match: exactPath('/api/admin/scheduler'),
      handle: (_req, res) => {
        if (!scheduler) {
          sendJson(res, 200, { tasks: [], reflections: [] });
          return;
        }
        if (scheduler.getFullData) {
          sendJson(res, 200, scheduler.getFullData());
        } else {
          const tasks = scheduler.listTasks().map(task => ({
            id: task.id,
            name: task.name,
            type: task.type,
            intervalMs: task.intervalMs,
            runAt: task.runAt,
            state: task.state,
            cadence: task.type === 'every'
              ? (task as ScheduledTask).cadence
              : undefined,
            lastRunAt: task.lastRunAt,
            lastFinishedAt: task.lastFinishedAt,
            lastOutcome: task.lastOutcome,
            lastError: task.lastError,
            lastErrorAt: task.lastErrorAt,
            lastDeniedReason: task.lastDeniedReason,
          }));
          sendJson(res, 200, { tasks, reflections: [] });
        }
      },
    },
    {
      method: 'PATCH',
      match: prefixedParamPath('/api/admin/scheduler/tasks/', 'taskId'),
      handle: (req, res, { taskId }) => {
        if (!scheduler?.updateTask) {
          sendJson(res, 400, { ok: false, message: 'Scheduler mutation not available' });
          return;
        }
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { ok: false, message: parsed.error });
            return;
          }
          const updates = parsed.value as {
            intervalMs?: number;
            enabled?: boolean;
            name?: string;
            cadence?: unknown;
          };
          const result = scheduler.updateTask!(taskId, updates);
          sendJson(res, result.ok ? 200 : 400, result);
        });
      },
    },
    {
      method: 'POST',
      match: exactPath('/api/admin/scheduler/tasks'),
      handle: (req, res) => {
        if (!scheduler?.createTask) {
          sendJson(res, 400, { ok: false, message: 'Scheduler mutation not available' });
          return;
        }
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { ok: false, message: parsed.error });
            return;
          }
          const input = parsed.value as {
            id: string;
            name: string;
            type: TaskType;
            intervalMs?: number;
            runAt?: number;
            cadence?: unknown;
          };
          const result = scheduler.createTask!(input);
          sendJson(res, result.ok ? 201 : 400, result);
        });
      },
    },
    {
      method: 'DELETE',
      match: prefixedParamPath('/api/admin/scheduler/tasks/', 'taskId'),
      handle: (_req, res, { taskId }) => {
        if (!scheduler?.removeTask) {
          sendJson(res, 400, { ok: false, message: 'Scheduler mutation not available' });
          return;
        }
        const result = scheduler.removeTask!(taskId);
        sendJson(res, result.ok ? 200 : 400, result);
      },
    },
    {
      method: 'PATCH',
      match: prefixedParamPath('/api/admin/scheduler/reflections/', 'reflectionId'),
      handle: (req, res, { reflectionId }) => {
        if (!scheduler?.updateReflection) {
          sendJson(res, 400, { ok: false, message: 'Reflection mutation not available' });
          return;
        }
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { ok: false, message: parsed.error });
            return;
          }
          const updates = parsed.value as Partial<ReflectionTemplate>;
          const result = scheduler.updateReflection!(reflectionId, updates);
          sendJson(res, result.ok ? 200 : 400, result);
        });
      },
    },
  ];
}
