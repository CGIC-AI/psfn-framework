// ── Scheduler ──
// The companion's internal clock. A base tick checks registered tasks for due status.
// Heartbeat is a special 'every' task — her self-check rhythm.

import type { EventBus } from '../../shared/event-bus.js';
import type {
  DailyRecurringCadence,
  HourlyRecurringCadence,
  RecurringCadence,
  ScheduledTask,
  SchedulerConfig,
  TaskState,
  WeeklyRecurringCadence,
} from './types.js';
import { DEFAULT_SCHEDULER_CONFIG } from './types.js';
import { createComponentLogger } from '../../shared/logger.js';
import { resolveActiveTimezone } from '../../shared/time/active-timezone.js';
import type {
  EligibilityDecision,
  EligibilityGate,
  EligibilityRequirements,
} from '../../system/capabilities/eligibility.js';

const log = createComponentLogger('Scheduler');

type RuntimeScheduledTask = ScheduledTask & { lastRun: number };

function isWallClockCadence(
  cadence: RecurringCadence | undefined,
): cadence is HourlyRecurringCadence | DailyRecurringCadence | WeeklyRecurringCadence {
  return cadence?.kind === 'hourly' || cadence?.kind === 'daily' || cadence?.kind === 'weekly';
}

function validateRecurringCadence(taskId: string, cadence: RecurringCadence | undefined): void {
  if (cadence === undefined || cadence.kind === 'relative') {
    return;
  }

  const timezone = (cadence as { timezone?: unknown }).timezone;
  if (timezone !== 'local' && timezone !== 'utc') {
    throw new Error(`Task "${taskId}" cadence.timezone must be "local" or "utc"`);
  }

  if (cadence.kind === 'hourly') {
    if (!Number.isInteger(cadence.minute) || cadence.minute < 0 || cadence.minute > 59) {
      throw new Error(`Task "${taskId}" cadence.minute must be an integer between 0 and 59`);
    }
    return;
  }

  if (cadence.kind === 'weekly') {
    if (!Number.isInteger(cadence.dayOfWeek) || cadence.dayOfWeek < 0 || cadence.dayOfWeek > 6) {
      throw new Error(`Task "${taskId}" cadence.dayOfWeek must be an integer between 0 and 6`);
    }
  }

  if (!Number.isInteger(cadence.hour) || cadence.hour < 0 || cadence.hour > 23) {
    throw new Error(`Task "${taskId}" cadence.hour must be an integer between 0 and 23`);
  }
  if (!Number.isInteger(cadence.minute) || cadence.minute < 0 || cadence.minute > 59) {
    throw new Error(`Task "${taskId}" cadence.minute must be an integer between 0 and 59`);
  }
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

interface ZoneWallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

// Wall-clock parts for an instant as observed in `timeZone` (DST-aware via Intl).
function zoneWallClockParts(epochMs: number, timeZone: string): ZoneWallClock {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      weekday: 'short',
    })
      .formatToParts(new Date(epochMs))
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAY_INDEX[parts.weekday as string] ?? 0,
  };
}

// Offset (ms) of `timeZone` at `epochMs`: (wall-clock-as-if-UTC) − epoch.
function zoneOffsetMs(epochMs: number, timeZone: string): number {
  const p = zoneWallClockParts(epochMs, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - epochMs;
}

// Epoch ms for a wall-clock time in `timeZone`. The second offset lookup refines
// the guess across DST transitions; nonexistent spring-forward wall times resolve
// deterministically to the pre-transition offset instant.
function zonedWallClockToEpoch(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offset = zoneOffsetMs(asUtc, timeZone);
  const epoch = asUtc - offset;
  const refinedOffset = zoneOffsetMs(epoch, timeZone);
  return refinedOffset === offset ? epoch : asUtc - refinedOffset;
}

// Wall-clock slot boundaries computed in the active timezone (or UTC), using Intl
// rather than process-local Date math so the slot is correct regardless of the
// process TZ. `cadence.timezone === 'local'` resolves to the settings-owned
// active timezone; `'utc'` pins to UTC.
function getCurrentSlotStart(
  now: number,
  cadence: HourlyRecurringCadence | DailyRecurringCadence | WeeklyRecurringCadence,
): number {
  const timeZone = cadence.timezone === 'utc' ? 'UTC' : resolveActiveTimezone();
  const nowParts = zoneWallClockParts(now, timeZone);

  if (cadence.kind === 'hourly') {
    const slot = zonedWallClockToEpoch(
      timeZone,
      nowParts.year,
      nowParts.month,
      nowParts.day,
      nowParts.hour,
      cadence.minute,
    );
    // Wall-clock hourly slots recur every physical hour, so a single physical
    // hour step lands on the previous slot even across DST transitions.
    return slot > now ? slot - HOUR_MS : slot;
  }

  if (cadence.kind === 'weekly') {
    const daysSinceSlot = (nowParts.weekday - cadence.dayOfWeek + 7) % 7;
    const slotDate = zoneWallClockParts(now - daysSinceSlot * DAY_MS, timeZone);
    const slot = zonedWallClockToEpoch(
      timeZone,
      slotDate.year,
      slotDate.month,
      slotDate.day,
      cadence.hour,
      cadence.minute,
    );
    if (slot <= now) {
      return slot;
    }
    const priorDate = zoneWallClockParts(now - (daysSinceSlot + 7) * DAY_MS, timeZone);
    return zonedWallClockToEpoch(
      timeZone,
      priorDate.year,
      priorDate.month,
      priorDate.day,
      cadence.hour,
      cadence.minute,
    );
  }

  const slot = zonedWallClockToEpoch(
    timeZone,
    nowParts.year,
    nowParts.month,
    nowParts.day,
    cadence.hour,
    cadence.minute,
  );
  if (slot <= now) {
    return slot;
  }
  const priorDate = zoneWallClockParts(now - DAY_MS, timeZone);
  return zonedWallClockToEpoch(
    timeZone,
    priorDate.year,
    priorDate.month,
    priorDate.day,
    cadence.hour,
    cadence.minute,
  );
}

export { getCurrentSlotStart };

function isWallClockTaskDue(
  now: number,
  lastRun: number,
  cadence: HourlyRecurringCadence | DailyRecurringCadence | WeeklyRecurringCadence,
): boolean {
  const currentSlotStart = getCurrentSlotStart(now, cadence);
  return now >= currentSlotStart && lastRun < currentSlotStart;
}

export interface SchedulerRuntimeOptions {
  eligibilityGate?: EligibilityGate;
  onEligibilityDecision?: (decision: EligibilityDecision) => void;
}

export class Scheduler {
  private eventBus: EventBus;
  private config: SchedulerConfig;
  private eligibilityGate?: EligibilityGate;
  private onEligibilityDecision?: (decision: EligibilityDecision) => void;
  private tasks = new Map<string, RuntimeScheduledTask>();
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private tickInFlight: Promise<void> | null = null;
  private stopDrainPromise: Promise<void> | null = null;
  private stopping = false;

  constructor(
    eventBus: EventBus,
    config?: Partial<SchedulerConfig>,
    runtimeOptions: SchedulerRuntimeOptions = {},
  ) {
    this.eventBus = eventBus;
    this.config = { ...DEFAULT_SCHEDULER_CONFIG, ...config };
    this.eligibilityGate = runtimeOptions.eligibilityGate;
    this.onEligibilityDecision = runtimeOptions.onEligibilityDecision;
  }

  updateConfig(config: Partial<SchedulerConfig>): void {
    const next = { ...this.config, ...config };
    const tickChanged = next.tickIntervalMs !== this.config.tickIntervalMs;
    const heartbeatChanged = next.heartbeatIntervalMs !== this.config.heartbeatIntervalMs;

    this.config = next;

    if (heartbeatChanged) {
      this.updateTask('heartbeat', { intervalMs: this.config.heartbeatIntervalMs });
    }

    if (tickChanged && this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
      this.start();
    }
  }

  register(task: ScheduledTask, opts?: { skipFirstRun?: boolean }): void {
    if (this.tasks.has(task.id)) {
      throw new Error(`Task "${task.id}" is already registered`);
    }
    if (task.type === 'every' && (!Number.isFinite(task.intervalMs) || task.intervalMs <= 0)) {
      throw new Error(`Task "${task.id}" intervalMs must be a positive finite number`);
    }
    if (task.type === 'every') {
      validateRecurringCadence(task.id, task.cadence);
    } else if (task.cadence !== undefined) {
      throw new Error(`Task "${task.id}" cadence is only supported for "every" tasks`);
    }

    const now = Date.now();
    const lastRun = task.type === 'every' && isWallClockCadence(task.cadence)
      ? now
      : (opts?.skipFirstRun ? now : 0);
    this.tasks.set(task.id, { ...task, lastRun });
  }

  updateTask(
    id: string,
    updates: {
      intervalMs?: number;
      state?: TaskState;
      name?: string;
      runAt?: number;
      cadence?: RecurringCadence;
      resetLastRun?: boolean;
    },
  ): boolean {
    const entry = this.tasks.get(id);
    if (!entry) return false;
    if (updates.intervalMs !== undefined) {
      if (entry.type === 'every' && (!Number.isFinite(updates.intervalMs) || updates.intervalMs <= 0)) {
        return false;
      }
      entry.intervalMs = updates.intervalMs;
      if (updates.resetLastRun) {
        entry.lastRun = Date.now();
      }
    }
    if (updates.cadence !== undefined) {
      if (entry.type !== 'every') {
        return false;
      }
      try {
        validateRecurringCadence(id, updates.cadence);
      } catch {
        return false;
      }
      entry.cadence = updates.cadence;
      if (isWallClockCadence(updates.cadence)) {
        entry.lastRun = Date.now();
      }
    }
    if (updates.state !== undefined) entry.state = updates.state;
    if (updates.name !== undefined) entry.name = updates.name;
    if (updates.runAt !== undefined) entry.runAt = updates.runAt;
    return true;
  }

  unregister(id: string): boolean {
    return this.tasks.delete(id);
  }

  getTask(id: string): ScheduledTask | undefined {
    const entry = this.tasks.get(id);
    if (!entry) return undefined;
    const { lastRun: _, ...task } = entry;
    return task;
  }

  listTasks(): ScheduledTask[] {
    return [...this.tasks.values()].map(({ lastRun: _, ...task }) => task);
  }

  start(): void {
    if (this.tickTimer) return;
    this.stopping = false;
    this.tickTimer = setInterval(() => {
      if (this.stopping) return;
      this.tick().catch(err => {
        log.error('Tick error', { error: String(err) });
      });
    }, this.config.tickIntervalMs);
    log.info(`Started (tick=${this.config.tickIntervalMs}ms, ${this.tasks.size} tasks)`);
  }

  async stop(): Promise<void> {
    if (this.stopDrainPromise) {
      await this.stopDrainPromise;
      return;
    }

    this.stopping = true;
    const hadTimer = this.tickTimer !== null;
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }

    const drainTarget = this.tickInFlight;
    if (!hadTimer && !drainTarget) return;

    this.stopDrainPromise = (async () => {
      if (drainTarget) {
        try {
          await drainTarget;
        } catch (error) {
          log.warn('Tick drain failed during stop; continuing scheduler shutdown', {
            error: String(error),
          });
        }
      }
      log.info('Stopped');
    })().finally(() => {
      this.stopDrainPromise = null;
    });

    await this.stopDrainPromise;
  }

  /** Run a single tick — check all tasks and fire those that are due. Exposed for testing. */
  async tick(): Promise<void> {
    if (this.tickInFlight) {
      return this.tickInFlight;
    }

    const run = this.runTick().finally(() => {
      if (this.tickInFlight === run) {
        this.tickInFlight = null;
      }
    });
    this.tickInFlight = run;
    return run;
  }

  private async runTick(): Promise<void> {
    const now = Date.now();
    await this.eventBus.emit('schedule.tick', { timestamp: now });

    for (const [id, entry] of this.tasks) {
      if (entry.state !== 'idle') continue;

      let isDue = false;

      if (entry.type === 'every') {
        if (isWallClockCadence(entry.cadence)) {
          isDue = isWallClockTaskDue(now, entry.lastRun, entry.cadence);
        } else {
          isDue = entry.lastRun === 0 || (now - entry.lastRun >= entry.intervalMs);
        }
      } else {
        isDue = entry.runAt !== undefined && now >= entry.runAt;
      }

      if (!isDue) continue;

      const eligibilityDecision = this.evaluateTaskEligibility(id, entry);
      if (eligibilityDecision && !eligibilityDecision.allowed) {
        const deniedAt = Date.now();
        log.warn('Task blocked by eligibility gate', {
          taskId: id,
          taskName: entry.name,
          reasonCode: eligibilityDecision.reasonCode,
          tier: eligibilityDecision.tier,
          missingTokens: eligibilityDecision.missingTokens,
          requiredTokens: eligibilityDecision.requiredTokens,
          minimumTier: eligibilityDecision.minimumTier,
        });
        entry.lastRun = now;
        entry.lastRunAt = now;
        entry.lastFinishedAt = deniedAt;
        entry.lastOutcome = 'denied';
        delete entry.lastError;
        delete entry.lastErrorAt;
        entry.lastDeniedReason = eligibilityDecision.reasonCode;
        if (entry.type === 'one-shot') {
          entry.state = 'complete';
        }
        await this.eventBus.emit('schedule.task.denied', {
          taskId: id,
          taskName: entry.name,
          type: entry.type,
          reasonCode: eligibilityDecision.reasonCode,
          tier: eligibilityDecision.tier,
          missingTokens: eligibilityDecision.missingTokens,
          requiredTokens: eligibilityDecision.requiredTokens,
          ...(eligibilityDecision.minimumTier
            ? { minimumTier: eligibilityDecision.minimumTier }
            : {}),
        });
        continue;
      }

      entry.state = 'active';
      entry.lastRun = now;
      entry.lastRunAt = now;
      delete entry.lastFinishedAt;
      delete entry.lastOutcome;
      delete entry.lastError;
      delete entry.lastErrorAt;
      delete entry.lastDeniedReason;
      try {
        await entry.handler();
        entry.lastFinishedAt = Date.now();
        entry.lastOutcome = 'succeeded';
        await this.eventBus.emit('schedule.task.run', {
          taskId: id,
          taskName: entry.name,
          type: entry.type,
        });
      } catch (err) {
        const errorText = String(err);
        entry.lastFinishedAt = Date.now();
        entry.lastOutcome = 'failed';
        entry.lastError = errorText;
        entry.lastErrorAt = entry.lastFinishedAt;
        delete entry.lastDeniedReason;
        log.error(`Task "${entry.name}" error`, { error: errorText });
      }

      if (entry.type === 'one-shot') {
        entry.state = 'complete';
      } else {
        entry.state = 'idle';
      }
    }
  }

  private evaluateTaskEligibility(
    taskId: string,
    task: ScheduledTask,
  ): EligibilityDecision | null {
    if (!this.eligibilityGate) return null;
    const decision = this.eligibilityGate.evaluate(
      {
        kind: 'scheduler.task',
        taskId,
        taskName: task.name,
        taskType: task.type,
      },
      task.eligibility ?? {},
    );
    this.onEligibilityDecision?.(decision);
    return decision;
  }

  /** Register the heartbeat as a special 'every' task */
  registerHeartbeat(
    handler: () => void | Promise<void>,
    eligibility?: EligibilityRequirements,
  ): void {
    this.register({
      id: 'heartbeat',
      name: 'Heartbeat',
      type: 'every',
      intervalMs: this.config.heartbeatIntervalMs,
      handler,
      ...(eligibility ? { eligibility } : {}),
      state: 'idle',
    });
  }

  get taskCount(): number {
    return this.tasks.size;
  }
}
