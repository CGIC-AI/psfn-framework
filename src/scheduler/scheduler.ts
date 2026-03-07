// ── Scheduler ──
// The companion's internal clock. A base tick checks registered tasks for due status.
// Heartbeat is a special 'every' task — her self-check rhythm.

import type { EventBus } from '../event-bus.js';
import type {
  DailyRecurringCadence,
  HourlyRecurringCadence,
  RecurringCadence,
  ScheduledTask,
  SchedulerConfig,
  TaskState,
} from './types.js';
import { DEFAULT_SCHEDULER_CONFIG } from './types.js';
import { createComponentLogger } from '../logger.js';
import type {
  EligibilityDecision,
  EligibilityGate,
  EligibilityRequirements,
} from '../capabilities/eligibility.js';

const log = createComponentLogger('Scheduler');

function isWallClockCadence(
  cadence: RecurringCadence | undefined,
): cadence is HourlyRecurringCadence | DailyRecurringCadence {
  return cadence?.kind === 'hourly' || cadence?.kind === 'daily';
}

function validateRecurringCadence(taskId: string, cadence: RecurringCadence | undefined): void {
  if (cadence === undefined || cadence.kind === 'relative') {
    return;
  }

  const isValidTimezone = cadence.timezone === 'local' || cadence.timezone === 'utc';
  if (!isValidTimezone) {
    throw new Error(`Task "${taskId}" cadence.timezone must be "local" or "utc"`);
  }

  if (cadence.kind === 'hourly') {
    if (!Number.isInteger(cadence.minute) || cadence.minute < 0 || cadence.minute > 59) {
      throw new Error(`Task "${taskId}" cadence.minute must be an integer between 0 and 59`);
    }
    return;
  }

  if (cadence.kind !== 'daily') {
    throw new Error(`Task "${taskId}" cadence.kind must be "relative", "hourly", or "daily"`);
  }

  if (!Number.isInteger(cadence.hour) || cadence.hour < 0 || cadence.hour > 23) {
    throw new Error(`Task "${taskId}" cadence.hour must be an integer between 0 and 23`);
  }
  if (!Number.isInteger(cadence.minute) || cadence.minute < 0 || cadence.minute > 59) {
    throw new Error(`Task "${taskId}" cadence.minute must be an integer between 0 and 59`);
  }
}

function getCurrentSlotStart(
  now: number,
  cadence: HourlyRecurringCadence | DailyRecurringCadence,
): number {
  const slot = new Date(now);

  if (cadence.kind === 'hourly') {
    if (cadence.timezone === 'utc') {
      slot.setUTCMinutes(cadence.minute, 0, 0);
      if (slot.getTime() > now) {
        slot.setUTCHours(slot.getUTCHours() - 1);
      }
      return slot.getTime();
    }

    slot.setMinutes(cadence.minute, 0, 0);
    if (slot.getTime() > now) {
      slot.setHours(slot.getHours() - 1);
    }
    return slot.getTime();
  }

  if (cadence.timezone === 'utc') {
    slot.setUTCHours(cadence.hour, cadence.minute, 0, 0);
    if (slot.getTime() > now) {
      slot.setUTCDate(slot.getUTCDate() - 1);
    }
    return slot.getTime();
  }

  slot.setHours(cadence.hour, cadence.minute, 0, 0);
  if (slot.getTime() > now) {
    slot.setDate(slot.getDate() - 1);
  }
  return slot.getTime();
}

function isWallClockTaskDue(
  now: number,
  lastRun: number,
  cadence: HourlyRecurringCadence | DailyRecurringCadence,
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
  private tasks = new Map<string, ScheduledTask & { lastRun: number }>();
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
      try {
        await entry.handler();
        await this.eventBus.emit('schedule.task.run', {
          taskId: id,
          taskName: entry.name,
          type: entry.type,
        });
      } catch (err) {
        log.error(`Task "${entry.name}" error`, { error: String(err) });
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
