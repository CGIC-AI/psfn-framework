// ── Scheduler ──
// The companion's internal clock. A base tick checks registered tasks for due status.
// Heartbeat is a special 'every' task — her self-check rhythm.

import type { EventBus } from '../../shared/event-bus.js';
import type {
  DailyRecurringCadence,
  FleetSlotStagger,
  HourlyRecurringCadence,
  RecurringCadence,
  ScheduledTask,
  ScheduledTaskHandler,
  SchedulerConfig,
  TaskState,
  WeeklyRecurringCadence,
} from './types.js';
import { staggerFleetOrdinalWithinWindow } from './fleet-maintenance-coordinator.js';
import {
  emitHealthEvent,
  hashHealthEventSubject,
  processObserverId,
  type HealthEventSource,
} from '../../shared/contracts/health-event.js';
import { DEFAULT_SCHEDULER_CONFIG } from './types.js';
import { createComponentLogger } from '../../shared/logger.js';
import {
  resolveActiveTimezone,
  zonedWallClockParts as zoneWallClockParts,
  zonedWallClockToEpoch,
} from '../../shared/time/active-timezone.js';
import type {
  EligibilityDecision,
  EligibilityGate,
  EligibilityRequirements,
} from '../../system/capabilities/eligibility.js';

const log = createComponentLogger('Scheduler');

type ScheduledTaskAvailability = 'idle' | 'do_not_disturb';

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
const WEEK_MS = 7 * DAY_MS;

// Floor for the adaptive next-wake delay. Guarantees the self-rescheduling timer
// can never spin into a busy-loop even when a task is already overdue: an overdue
// task wakes after at most this delay rather than immediately re-arming at 0ms.
const MIN_WAKE_MS = 50;

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

function validateFleetStagger(task: ScheduledTask): void {
  const stagger = task.fleetStagger;
  if (!stagger) return;
  if (task.type !== 'every' || !isWallClockCadence(task.cadence)) {
    throw new Error(`Task "${task.id}" fleetStagger requires a wall-clock recurring cadence`);
  }
  if (!Number.isSafeInteger(stagger.fleetSize) || stagger.fleetSize < 1) {
    throw new Error(`Task "${task.id}" fleetStagger.fleetSize must be a positive safe integer`);
  }
  if (
    !Number.isSafeInteger(stagger.manifestOrdinal)
    || stagger.manifestOrdinal < 0
    || stagger.manifestOrdinal >= stagger.fleetSize
  ) {
    throw new Error(`Task "${task.id}" fleetStagger.manifestOrdinal must identify a fleet member`);
  }
  if (!Number.isSafeInteger(stagger.windowMs) || stagger.windowMs < 1) {
    throw new Error(`Task "${task.id}" fleetStagger.windowMs must be a positive safe integer`);
  }
  // An offset reaching the next slot would make consecutive slots overlap and
  // silently skip runs, so the window must fit inside one cadence period.
  const periodMs = cadencePeriodMs(task.cadence);
  if (stagger.windowMs >= periodMs) {
    throw new Error(
      `Task "${task.id}" fleetStagger.windowMs (${stagger.windowMs}) must be shorter than its `
      + `${task.cadence.kind} cadence period (${periodMs})`,
    );
  }
}

function cadencePeriodMs(
  cadence: HourlyRecurringCadence | DailyRecurringCadence | WeeklyRecurringCadence,
): number {
  if (cadence.kind === 'hourly') return HOUR_MS;
  return cadence.kind === 'daily' ? DAY_MS : WEEK_MS;
}

function fleetStaggeredSlotStart(slotStart: number, stagger?: FleetSlotStagger): number {
  if (!stagger) return slotStart;
  return staggerFleetOrdinalWithinWindow({
    manifestOrdinal: stagger.manifestOrdinal,
    fleetSize: stagger.fleetSize,
    windowStartMs: slotStart,
    windowEndMs: slotStart + stagger.windowMs,
  });
}

function getNextSlotStart(
  currentSlotStart: number,
  cadence: HourlyRecurringCadence | DailyRecurringCadence | WeeklyRecurringCadence,
): number {
  if (cadence.kind === 'hourly') return currentSlotStart + HOUR_MS;
  const probe = currentSlotStart + (cadence.kind === 'daily' ? 36 * HOUR_MS : 8 * DAY_MS);
  const next = getCurrentSlotStart(probe, cadence);
  if (next <= currentSlotStart) {
    throw new Error('Scheduler failed to resolve the next wall-clock cadence slot');
  }
  return next;
}

function getCurrentStaggeredSlotStart(
  now: number,
  cadence: HourlyRecurringCadence | DailyRecurringCadence | WeeklyRecurringCadence,
  stagger?: FleetSlotStagger,
): number {
  return fleetStaggeredSlotStart(getCurrentSlotStart(now, cadence), stagger);
}

function getNextStaggeredSlotStart(
  now: number,
  cadence: HourlyRecurringCadence | DailyRecurringCadence | WeeklyRecurringCadence,
  stagger?: FleetSlotStagger,
): number {
  const currentBase = getCurrentSlotStart(now, cadence);
  const currentDue = fleetStaggeredSlotStart(currentBase, stagger);
  return currentDue > now
    ? currentDue
    : fleetStaggeredSlotStart(getNextSlotStart(currentBase, cadence), stagger);
}

function isWallClockTaskDue(
  now: number,
  lastRun: number,
  cadence: HourlyRecurringCadence | DailyRecurringCadence | WeeklyRecurringCadence,
  stagger?: FleetSlotStagger,
): boolean {
  const currentSlotStart = getCurrentStaggeredSlotStart(now, cadence, stagger);
  return now >= currentSlotStart && lastRun < currentSlotStart;
}

export interface SchedulerRuntimeOptions {
  eligibilityGate?: EligibilityGate;
  onEligibilityDecision?: (decision: EligibilityDecision) => void;
  runProtectedTask?: (
    state: ScheduledTaskAvailability,
    handler: () => void | Promise<void>,
  ) => Promise<void>;
  /**
   * Identity the scheduler stamps on its health events (bead
   * psfn-framework-7qeo1.24.1). The Scheduler class runs in more than one
   * process and knows neither which one nor whose companion it serves, so the
   * entrypoint that constructs it declares that here. Absent, the scheduler
   * still runs and still emits `schedule.task.failed` — it simply contributes
   * nothing to the health plane, which is the honest state for a scheduler no
   * entrypoint has claimed.
   */
  healthEventSource?: HealthEventSource;
  /**
   * Per-attempt handler budget (scheduler.json
   * `healthDetectors.stuckJobs.schedulerTaskBudgetMs` in the agent runtime).
   * When an attempt outlives it the scheduler aborts the handler's signal,
   * records the attempt failed with a `handler_budget_exceeded` annotation, and
   * moves on to the next due task. The task stays `active` — and therefore out
   * of rotation — until the aborted handler actually settles, so it can never
   * run concurrently with itself. Absent, handlers run unbounded.
   */
  taskBudgetMs?: number;
}

/** Error text recorded on an attempt that outlived the scheduler task budget. */
export const HANDLER_BUDGET_EXCEEDED = 'handler_budget_exceeded';

/** A budget-failed attempt whose handler has not settled yet. */
interface OverdueAttempt {
  entry: RuntimeScheduledTask;
  controller: AbortController;
}

export class Scheduler {
  private eventBus: EventBus;
  private config: SchedulerConfig;
  private eligibilityGate?: EligibilityGate;
  private onEligibilityDecision?: (decision: EligibilityDecision) => void;
  private runProtectedTask?: SchedulerRuntimeOptions['runProtectedTask'];
  private healthEventSource?: HealthEventSource;
  private taskBudgetMs?: number;
  private tasks = new Map<string, RuntimeScheduledTask>();
  /** Budget-failed attempts still settling, keyed by task id (never on the entry). */
  private overdueAttempts = new Map<string, OverdueAttempt>();
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
    this.healthEventSource = runtimeOptions.healthEventSource;
    if (runtimeOptions.taskBudgetMs !== undefined) {
      if (!Number.isSafeInteger(runtimeOptions.taskBudgetMs) || runtimeOptions.taskBudgetMs <= 0) {
        throw new Error('Scheduler taskBudgetMs must be a positive safe integer');
      }
      this.taskBudgetMs = runtimeOptions.taskBudgetMs;
    }
  }

  /** Task ids whose budget-failed handler is still settling. */
  listOverdueTaskIds(): string[] {
    return [...this.overdueAttempts.keys()];
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
   *
   * For wall-clock (hourly/daily/weekly) cadences, `lastRunAt` is the recovery
   * anchor: when a process registers AFTER the current slot with a prior
   * persisted run, the missed slot fires exactly once on the next tick (the
   * slot-start check treats any older last-run as "not yet run this slot").
   * Re-registration with an updated lastRunAt does not re-fire, so restart or
   * replay never duplicates a recovered slot.
   *
   * `phaseOffsetMs` (relative cadences with `skipFirstRun` only) delays the
   * first run — and therefore the whole poll phase — by the given offset, so
   * fleet members registered in the same instant do not poll in lockstep.
   */
  register(
    task: ScheduledTask | ProtectedScheduledTask,
    opts?: { skipFirstRun?: boolean; lastRunAt?: number; phaseOffsetMs?: number },
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
    validateFleetStagger(task);
    if (opts?.lastRunAt !== undefined) {
      if (!Number.isFinite(opts.lastRunAt) || opts.lastRunAt < 0) {
        throw new Error(`Task "${task.id}" lastRunAt must be a non-negative finite epoch`);
      }
      if (opts.skipFirstRun !== undefined) {
        throw new Error(`Task "${task.id}" cannot combine lastRunAt with skipFirstRun`);
      }
    }

    if (opts?.phaseOffsetMs !== undefined) {
      if (!Number.isSafeInteger(opts.phaseOffsetMs) || opts.phaseOffsetMs < 0) {
        throw new Error(`Task "${task.id}" phaseOffsetMs must be a non-negative safe integer`);
      }
      if (task.type !== 'every' || isWallClockCadence(task.cadence) || opts.skipFirstRun !== true) {
        throw new Error(
          `Task "${task.id}" phaseOffsetMs requires a relative "every" cadence registered with skipFirstRun`,
        );
      }
    }

    const now = Date.now();
    const seededLastRun = opts?.lastRunAt
      ?? (opts?.skipFirstRun ? now + (opts.phaseOffsetMs ?? 0) : 0);
    // Wall-clock cadences anchor to fixed slots, not a relative interval. A
    // persisted lastRunAt (state that outlived this process) must seed the
    // anchor so a restart that lands AFTER the slot recovers the missed slot
    // exactly once instead of silently skipping it. Without an explicit
    // lastRunAt the prior behavior is preserved: skipFirstRun/fresh
    // registration treats the cadence as just-satisfied (`now`) so it never
    // fires immediately on first registration.
    const lastRun = task.type === 'every' && isWallClockCadence(task.cadence)
      ? (opts?.lastRunAt !== undefined ? opts.lastRunAt : now)
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
        return isWallClockTaskDue(now, entry.lastRun, entry.cadence, entry.fleetStagger)
          ? now
          : getNextStaggeredSlotStart(now, entry.cadence, entry.fleetStagger);
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
          isDue = isWallClockTaskDue(now, entry.lastRun, entry.cadence, entry.fleetStagger);
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
      await this.runAttempt(id, entry);
    }
  }

  /**
   * Run one attempt. Ticks stay serial — lanes such as free time rely on one
   * handler finishing before the next due task starts — but a handler that
   * outlives the task budget is aborted, recorded failed, and detached so the
   * tick continues. The detached attempt keeps its task `active` until it
   * settles, which is what guarantees single-flight per task id.
   */
  private async runAttempt(id: string, entry: RuntimeScheduledTask): Promise<void> {
    const controller = new AbortController();
    const handler: ScheduledTaskHandler = entry.handler;
    // Start the handler synchronously (as before) while still turning a sync
    // throw into a rejected attempt.
    const startNow = (start: () => void | Promise<void>): Promise<void> => {
      try {
        return Promise.resolve(start());
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const invoke = (): Promise<void> => startNow(() => handler({ signal: controller.signal }));
    const protectedRun = entry.availability ? this.runProtectedTask : undefined;
    const availability = entry.availability;
    const attempt = protectedRun && availability
      ? startNow(() => protectedRun(availability, invoke))
      : invoke();
    const settled = attempt.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    const budgetMs = this.taskBudgetMs;
    let budgetTimer: ReturnType<typeof setTimeout> | undefined;
    const expired = budgetMs === undefined
      ? null
      : new Promise<'expired'>(resolve => {
          budgetTimer = setTimeout(() => resolve('expired'), budgetMs);
        });
    const first = expired ? await Promise.race([settled, expired]) : await settled;
    if (budgetTimer !== undefined) clearTimeout(budgetTimer);

    if (first === 'expired') {
      await this.failOverdueAttempt(id, entry, controller, budgetMs!);
      void settled
        .then(outcome => this.settleOverdueAttempt(id, entry, outcome))
        .catch((error: unknown) => {
          log.error('Budget-failed scheduler task settlement bookkeeping failed', {
            taskId: id,
            error: String(error),
          });
        });
      return;
    }

    if (first.ok) {
      entry.lastFinishedAt = Date.now();
      entry.lastOutcome = 'succeeded';
      await this.eventBus.emit('schedule.task.run', {
        taskId: id,
        taskName: entry.name,
        type: entry.type,
      });
    } else {
      await this.recordAttemptFailure(id, entry, String(first.error), Date.now());
    }
    entry.state = entry.type === 'one-shot' ? 'complete' : 'idle';
  }

  private async recordAttemptFailure(
    id: string,
    entry: RuntimeScheduledTask,
    errorText: string,
    failedAt: number,
    options: { finished?: boolean } = {},
  ): Promise<void> {
    if (options.finished !== false) entry.lastFinishedAt = failedAt;
    entry.lastOutcome = 'failed';
    entry.lastError = errorText;
    entry.lastErrorAt = failedAt;
    delete entry.lastDeniedReason;
    log.error(`Task "${entry.name}" error`, { error: errorText });
    await this.eventBus.emit('schedule.task.failed', {
      taskId: id,
      taskName: entry.name,
      type: entry.type,
      error: errorText,
      timestamp: failedAt,
    });
    // Scheduler health emitter. `schedule.task.failed` carries the rendered
    // error for the operator log; the health plane deliberately does not —
    // the task is identified only by a stable digest of its id, so a
    // detector can count repeats of the SAME task without the stream
    // learning a task name or an error string.
    await this.emitTaskFailureHealthEvent(id, failedAt);
  }

  /**
   * Budget expiry: ask the handler to stop and account for the attempt now.
   * `lastFinishedAt` stays unset — the handler has not finished — and the task
   * stays `active`, so `active` + `lastOutcome=failed` (with `lastErrorAt` at
   * or after `lastRunAt`) means "budget-failed, still settling".
   */
  private async failOverdueAttempt(
    id: string,
    entry: RuntimeScheduledTask,
    controller: AbortController,
    budgetMs: number,
  ): Promise<void> {
    const reason = `${HANDLER_BUDGET_EXCEEDED}: exceeded ${budgetMs}ms; handler aborted`;
    this.overdueAttempts.set(id, { entry, controller });
    controller.abort(new Error(reason));
    await this.recordAttemptFailure(id, entry, reason, Date.now(), { finished: false });
  }

  private settleOverdueAttempt(
    id: string,
    entry: RuntimeScheduledTask,
    outcome: { ok: true } | { ok: false; error: unknown },
  ): void {
    const overdue = this.overdueAttempts.get(id);
    if (overdue?.entry === entry) this.overdueAttempts.delete(id);
    const settledAt = Date.now();
    // The attempt was already accounted as failed at budget expiry; a late
    // settlement only records when the handler actually let go.
    log.warn('Budget-failed scheduler task settled', {
      taskId: id,
      taskName: entry.name,
      settledOk: outcome.ok,
      ...(outcome.ok ? {} : { error: String(outcome.error) }),
    });
    entry.lastFinishedAt = settledAt;
    if (this.tasks.get(id) !== entry) return;
    entry.state = entry.type === 'one-shot' ? 'complete' : 'idle';
    this.requestWake(this.taskNextDueAt(settledAt, entry));
  }

  /**
   * Never lets a telemetry fault mask the task fault being reported: the health
   * emit is awaited so tests are deterministic, but a failure inside it is
   * logged rather than rethrown out of the tick's catch block.
   */
  private async emitTaskFailureHealthEvent(taskId: string, observedAtMs: number): Promise<void> {
    const source = this.healthEventSource;
    if (!source) return;
    try {
      await emitHealthEvent(this.eventBus, {
        owner: source.owner,
        severity: 'degraded',
        code: 'scheduler_task_failed',
        provenance: {
          process: source.process,
          component: 'scheduler',
          observerId: processObserverId(),
          subjectHash: hashHealthEventSubject(taskId),
        },
        observedAtMs,
      });
    } catch (error) {
      log.error('Scheduler health event emission failed', { taskId, error: String(error) });
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
    handler: ScheduledTaskHandler,
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
