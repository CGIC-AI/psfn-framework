import type { ReflectionTemplate } from '../../core/scheduler/reflection-policy.js';
import type { WakeWindowSnapshot } from '../../core/scheduler/temporal-wakeup.js';
import type { RecurringCadence, ScheduledTask, TaskType } from '../../core/scheduler/types.js';

export type AdminTaskCadence = RecurringCadence;

export interface AdminScheduledTaskView {
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

export interface AdminSchedulerApi {
  listTasks(): ScheduledTask[];
  getFullData?(): {
    tasks: AdminScheduledTaskView[];
    reflections: ReflectionTemplate[];
  };
  updateTask?(id: string, updates: {
    intervalMs?: number;
    enabled?: boolean;
    name?: string;
    cadence?: unknown;
  }): { ok: boolean; message: string };
  createTask?(input: {
    id: string;
    name: string;
    type: TaskType;
    intervalMs?: number;
    runAt?: number;
    cadence?: unknown;
  }): { ok: boolean; message: string };
  removeTask?(id: string): { ok: boolean; message: string };
  updateReflection?(id: string, updates: Partial<ReflectionTemplate>): { ok: boolean; message: string };
  /** Current habit wake-window estimate + data sufficiency (E7.2). */
  getWakeWindow?(): WakeWindowSnapshot | null;
}
