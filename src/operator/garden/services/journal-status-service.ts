import { getCurrentSlotStart } from '../../../core/scheduler/scheduler.js';
import type { RecurringCadence, ScheduledTask } from '../../../core/scheduler/types.js';
import type {
  AdminReflectionDailyJournalApi,
  AdminReflectionJournalApi,
  AdminReflectionMetacognitionJournalApi,
  AdminScheduledTaskView,
  AdminSchedulerApi,
  AdminValuesJournalApi,
} from '../admin-contract.js';

const CONCERN_ROUTE_TEMPLATE_ID = 'concern_route';
const REFLECTION_JOURNAL_COUNT_LIMIT = Number.MAX_SAFE_INTEGER;

export type AdminJournalStreamId =
  | 'values'
  | 'metacognition'
  | 'daily'
  | 'reflection'
  | 'concerns';

export type AdminJournalRunHealth =
  | 'healthy'
  | 'running'
  | 'missed'
  | 'failed'
  | 'denied'
  | 'paused'
  | 'never_run'
  | 'unavailable';

export interface AdminJournalStreamStatus {
  available: boolean;
  count: number | null;
  latestAt: string | null;
}

export interface AdminJournalTaskStatus {
  taskId: string;
  health: AdminJournalRunHealth;
  state: string | null;
  lastRunAt: string | null;
  lastFinishedAt: string | null;
  lastOutcome: string | null;
  lastErrorAt: string | null;
  lastDeniedReason: string | null;
  attentionRequired: boolean;
}

export interface AdminJournalStatusData {
  generatedAt: string;
  streams: Record<AdminJournalStreamId, AdminJournalStreamStatus>;
  tasks: {
    daily: AdminJournalTaskStatus;
    weekly: AdminJournalTaskStatus;
  };
  attentionCount: number;
}

export interface BuildAdminJournalStatusOptions {
  valuesJournal?: AdminValuesJournalApi | null;
  reflectionMetacognitionJournal?: AdminReflectionMetacognitionJournalApi | null;
  reflectionDailyJournal?: AdminReflectionDailyJournalApi | null;
  reflectionJournal?: AdminReflectionJournalApi | null;
  scheduler?: AdminSchedulerApi | null;
  now?: () => number;
}

function isoOrNull(value: number | undefined): string | null {
  return value === undefined || !Number.isFinite(value)
    ? null
    : new Date(value).toISOString();
}

function latestIso(values: readonly string[]): string | null {
  let latest: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp) && timestamp > latestMs) {
      latestMs = timestamp;
      latest = value;
    }
  }
  return latest;
}

function unavailableStream(): AdminJournalStreamStatus {
  return { available: false, count: null, latestAt: null };
}

function populatedStream(entries: readonly { at: string }[]): AdminJournalStreamStatus {
  return {
    available: true,
    count: entries.length,
    latestAt: latestIso(entries.map(entry => entry.at)),
  };
}

function schedulerTasks(scheduler: AdminSchedulerApi | null | undefined): Array<
  AdminScheduledTaskView | ScheduledTask
> {
  if (!scheduler) return [];
  return scheduler.listTasks();
}

function taskMissedCurrentSlot(
  task: AdminScheduledTaskView | ScheduledTask,
  nowMs: number,
): boolean {
  if (task.lastRunAt === undefined) return true;
  const cadence = task.cadence as RecurringCadence | undefined;
  if (cadence && cadence.kind !== 'relative') {
    return task.lastRunAt < getCurrentSlotStart(nowMs, cadence);
  }
  return task.intervalMs > 0 && task.lastRunAt + task.intervalMs < nowMs;
}

function buildTaskStatus(
  tasks: ReadonlyArray<AdminScheduledTaskView | ScheduledTask>,
  taskId: string,
  nowMs: number,
): AdminJournalTaskStatus {
  const task = tasks.find(candidate => candidate.id === taskId);
  let health: AdminJournalRunHealth;
  if (!task) {
    health = 'unavailable';
  } else if (task.state === 'paused') {
    health = 'paused';
  } else if (task.state === 'active') {
    health = 'running';
  } else if (task.lastOutcome === 'failed') {
    health = 'failed';
  } else if (task.lastOutcome === 'denied') {
    health = 'denied';
  } else if (task.lastRunAt === undefined) {
    health = 'never_run';
  } else if (taskMissedCurrentSlot(task, nowMs)) {
    health = 'missed';
  } else {
    health = 'healthy';
  }

  return {
    taskId,
    health,
    state: task?.state ?? null,
    lastRunAt: isoOrNull(task?.lastRunAt),
    lastFinishedAt: isoOrNull(task?.lastFinishedAt),
    lastOutcome: task?.lastOutcome ?? null,
    lastErrorAt: isoOrNull(task?.lastErrorAt),
    lastDeniedReason: task?.lastDeniedReason ?? null,
    attentionRequired: health !== 'healthy' && health !== 'running',
  };
}

export function buildAdminJournalStatus(
  options: BuildAdminJournalStatusOptions,
): AdminJournalStatusData {
  const nowMs = (options.now ?? Date.now)();
  if (!Number.isFinite(nowMs)) throw new Error('Journal status timestamp must be finite');

  const valuesEntries = options.valuesJournal?.list();
  const metacognitionEntries = options.reflectionMetacognitionJournal?.listRecent();
  const dailyEntries = options.reflectionDailyJournal?.listRecent();
  const reflectionEntries = options.reflectionJournal?.listRecent({
    limit: REFLECTION_JOURNAL_COUNT_LIMIT,
  });
  const reflections = reflectionEntries?.filter(
    entry => entry.templateId !== CONCERN_ROUTE_TEMPLATE_ID,
  );
  const concerns = reflectionEntries?.filter(
    entry => entry.templateId === CONCERN_ROUTE_TEMPLATE_ID,
  );
  const tasks = schedulerTasks(options.scheduler);
  const dailyTask = buildTaskStatus(tasks, 'reflection:daily-review', nowMs);
  const weeklyTask = buildTaskStatus(tasks, 'reflection:weekly-review', nowMs);

  return {
    generatedAt: new Date(nowMs).toISOString(),
    streams: {
      values: valuesEntries
        ? populatedStream(valuesEntries.map(entry => ({ at: entry.createdAt })))
        : unavailableStream(),
      metacognition: metacognitionEntries
        ? populatedStream(metacognitionEntries.map(entry => ({ at: entry.occurredAt })))
        : unavailableStream(),
      daily: dailyEntries
        ? populatedStream(dailyEntries.map(entry => ({ at: entry.createdAt })))
        : unavailableStream(),
      reflection: reflections
        ? populatedStream(reflections.map(entry => ({ at: entry.createdAt })))
        : unavailableStream(),
      concerns: concerns
        ? populatedStream(concerns.map(entry => ({ at: entry.createdAt })))
        : unavailableStream(),
    },
    tasks: { daily: dailyTask, weekly: weeklyTask },
    attentionCount: Number(dailyTask.attentionRequired) + Number(weeklyTask.attentionRequired),
  };
}
