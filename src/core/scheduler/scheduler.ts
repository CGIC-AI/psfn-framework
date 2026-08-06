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

export type ScheduledTaskAvailability = 'idle' | 'do_not_disturb';

export interface ProtectedScheduledTask extends ScheduledTask {
  /** Coarse channel availability projected for the full handler lifetime. */
  availability: ScheduledTaskAvailability;
}

type RuntimeScheduledTask = ScheduledTask & {
  lastRun: number;
  availability?: ScheduledTaskAvailability;
};

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

// Floor for the adaptive next-wake delay. Guarantees the self-rescheduling timer
// can never spin into a busy-loop even when a task is already overdue: an overdue
// task wakes after at most this delay rather than immediately re-arming at 0ms.
const MIN_WAKE_MS = 50;

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
  runProtectedTask?: (
    state: ScheduledTaskAvailability,
    handler: () => void | Promise<void>,
  ) => Promise<void>;
}

export class Scheduler {
  private eventBus: EventBus;
  private config: SchedulerConfig;
  private eligibilityGate?: EligibilityGate;
  private onEligibilityDecision?: (decision: EligibilityDecision) => void;
  private runProtectedTask?: SchedulerRuntimeOptions['runProtectedTask'];
  private tasks = new Map<string, RuntimeScheduledTask>();
  private tickTimer: ReturnType<typeof setTimeout> | null = null;
  /** Absolute epoch (ms) the currently armed wake will fire at, or null when disarmed. */
  private wakeAt: number | null = null;
  /** True between start() and stop(); gates arming so the timer self-reschedules only while active. */
  private running = false;
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
    this.runProtectedTask = runtimeOptions.runProtectedTask;
  }

  updateConfig(config: Partial<SchedulerConfig>): void {
    const next = { ...this.config, ...config };
    const heartbeatChanged = next.heartbeatIntervalMs !== this.config.heartbeatIntervalMs;

    this.config = next;

    if (heartbeatChanged) {
      this.updateTask('heartbeat', { intervalMs: this.config.heartbeatIntervalMs });
    }

    // Re-arm so a changed coarse ceiling (tickIntervalMs) and any heartbeat cadence
    // change take effect immediately. Clears the existing timer before re-arming.
    if (this.running) {
      this.clearWakeTimer();
      this.armNextWake(Date.now());
    }
  }

  /**
   * `lastRunAt` seeds the task's last-run epoch from state that outlived this
   * process (e.g. a persisted backup watermark), so an interval task resumes its
   * real cadence instead of restarting it at every boot. Pass `0` for "never
   * ran" — the task is then due on the first tick. It is mutually exclusive with
   * `skipFirstRun`, which is the in-memory-only "start the interval now" seed.
   */
  register(
    task: ScheduledTask | ProtectedScheduledTask,
    opts?: { skipFirstRun?: boolean; lastRunAt?: number },
  ): void {
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
    if (opts?.lastRunAt !== undefined) {
      if (!Number.isFinite(opts.lastRunAt) || opts.lastRunAt < 0) {
        throw new Error(`Task "${task.id}" lastRunAt must be a non-negative finite epoch`);
      }
      if (opts.skipFirstRun !== undefined) {
        throw new Error(`Task "${task.id}" cannot combine lastRunAt with skipFirstRun`);
      }
    }

    const now = Date.now();
    const seededLastRun = opts?.lastRunAt ?? (opts?.skipFirstRun ? now : 0);
    const lastRun = task.type === 'every' && isWallClockCadence(task.cadence)
      ? now
      : seededLastRun;
    const entry: RuntimeScheduledTask = { ...task, lastRun };
    this.tasks.set(task.id, entry);
    // Re-arm the adaptive wake if this task is due sooner than the currently
    // armed wake. requestWake no-ops while stopped or when already waking at/
    // before the computed due time, so register-before-start is unaffected.
    this.requestWake(this.taskNextDueAt(now, entry));
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
    // Re-arm the adaptive wake if the update moved this task's due time nearer
    // than the currently armed wake. requestWake handles the earlier-than-armed
    // decision and no-ops while stopped.
    this.requestWake(this.taskNextDueAt(Date.now(), entry));
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
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    this.armNextWake(Date.now());
    log.info(`Started (tick=${this.config.tickIntervalMs}ms, ${this.tasks.size} tasks)`);
  }

  /**
   * Request an earlier wake than the one currently armed. Used when a near-term
   * task (e.g. a sub-second one-shot or defer) is registered or updated so the
   * self-rescheduling timer does not wait until its next computed boundary.
   * No-op when the scheduler is stopped or already waking at/before `atMs`.
   */
  requestWake(atMs: number): void {
    if (!this.running || this.stopping) return;
    if (this.wakeAt !== null && this.wakeAt <= atMs) return;
    this.armNextWake(Date.now(), atMs);
  }

  private clearWakeTimer(): void {
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }
    this.wakeAt = null;
  }

  /**
   * Absolute epoch (ms) when a single idle task next wants to run. Non-idle tasks
   * never contribute (Infinity). Wall-clock cadences resolve only to minute
   * precision, so they contribute the coarse ceiling when not yet due; the ceiling
   * re-check honors their existing granularity.
   */
  private taskNextDueAt(now: number, entry: RuntimeScheduledTask): number {
    if (entry.state !== 'idle') return Number.POSITIVE_INFINITY;
    if (entry.type === 'every') {
      if (isWallClockCadence(entry.cadence)) {
        return isWallClockTaskDue(now, entry.lastRun, entry.cadence)
          ? now
          : now + this.config.tickIntervalMs;
      }
      return entry.lastRun === 0 ? now : entry.lastRun + entry.intervalMs;
    }
    return entry.runAt !== undefined ? entry.runAt : Number.POSITIVE_INFINITY;
  }

  /**
   * Earliest absolute epoch (ms) the scheduler should next wake at: the minimum
   * over all idle tasks' next-due times, an optional near-term hint, and the coarse
   * ceiling safety net (tickIntervalMs). Never returns beyond the ceiling.
   */
  private computeNextWakeAt(now: number, hintAt?: number): number {
    let earliest = now + this.config.tickIntervalMs;
    if (hintAt !== undefined && hintAt < earliest) {
      earliest = hintAt;
    }
    for (const entry of this.tasks.values()) {
      const due = this.taskNextDueAt(now, entry);
      if (due < earliest) earliest = due;
    }
    return earliest;
  }

  /**
   * Arm the self-rescheduling wake timer for the next due task, clamped to
   * [MIN_WAKE_MS, tickIntervalMs]. The floor prevents a busy-loop on overdue tasks;
   * the ceiling keeps a coarse safety-net wake. Skips arming while a tick is in
   * flight — that tick re-arms on completion and will observe any new near-term task.
   */
  private armNextWake(now: number, hintAt?: number): void {
    if (!this.running || this.stopping) return;
    if (this.tickInFlight) return;

    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }

    const ceiling = this.config.tickIntervalMs;
    const floor = Math.min(MIN_WAKE_MS, ceiling);
    const rawDelay = this.computeNextWakeAt(now, hintAt) - now;
    const delay = Math.max(floor, Math.min(rawDelay, ceiling));

    this.wakeAt = now + delay;
    this.tickTimer = setTimeout(() => {
      this.tickTimer = null;
      this.wakeAt = null;
      if (this.stopping || !this.running) return;
      this.tick()
        .catch(err => {
          log.error('Tick error', { error: String(err) });
        })
        .finally(() => {
          this.armNextWake(Date.now());
        });
    }, delay);
  }

  async stop(): Promise<void> {
    if (this.stopDrainPromise) {
      await this.stopDrainPromise;
      return;
    }

    this.stopping = true;
    this.running = false;
    const hadTimer = this.tickTimer !== null;
    this.clearWakeTimer();

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
        if (entry.availability && this.runProtectedTask) {
          await this.runProtectedTask(entry.availability, entry.handler);
        } else {
          await entry.handler();
        }
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
        await this.eventBus.emit('schedule.task.failed', {
          taskId: id,
          taskName: entry.name,
          type: entry.type,
          error: errorText,
          timestamp: entry.lastFinishedAt,
        });
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
