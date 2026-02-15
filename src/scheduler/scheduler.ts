// ── Scheduler ──
// PSFN's internal clock. A base tick checks registered tasks for due status.
// Heartbeat is a special 'every' task — her self-check rhythm.

import type { EventBus } from '../event-bus.js';
import type { ScheduledTask, SchedulerConfig, TaskState } from './types.js';
import { DEFAULT_SCHEDULER_CONFIG } from './types.js';
import { createComponentLogger } from '../logger.js';

const log = createComponentLogger('Scheduler');

export class Scheduler {
  private eventBus: EventBus;
  private config: SchedulerConfig;
  private tasks = new Map<string, ScheduledTask & { lastRun: number }>();
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  constructor(eventBus: EventBus, config?: Partial<SchedulerConfig>) {
    this.eventBus = eventBus;
    this.config = { ...DEFAULT_SCHEDULER_CONFIG, ...config };
  }

  register(task: ScheduledTask, opts?: { skipFirstRun?: boolean }): void {
    if (this.tasks.has(task.id)) {
      throw new Error(`Task "${task.id}" is already registered`);
    }
    const lastRun = opts?.skipFirstRun ? Date.now() : 0;
    this.tasks.set(task.id, { ...task, lastRun });
  }

  updateTask(id: string, updates: { intervalMs?: number; state?: TaskState; name?: string }): boolean {
    const entry = this.tasks.get(id);
    if (!entry) return false;
    if (updates.intervalMs !== undefined) entry.intervalMs = updates.intervalMs;
    if (updates.state !== undefined) entry.state = updates.state;
    if (updates.name !== undefined) entry.name = updates.name;
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
    this.tickTimer = setInterval(() => {
      this.tick().catch(err => {
        log.error('Tick error', { error: String(err) });
      });
    }, this.config.tickIntervalMs);
    log.info(`Started (tick=${this.config.tickIntervalMs}ms, ${this.tasks.size} tasks)`);
  }

  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
      log.info('Stopped');
    }
  }

  /** Run a single tick — check all tasks and fire those that are due. Exposed for testing. */
  async tick(): Promise<void> {
    const now = Date.now();
    await this.eventBus.emit('schedule.tick', { timestamp: now });

    for (const [id, entry] of this.tasks) {
      if (entry.state !== 'idle') continue;

      let isDue = false;

      if (entry.type === 'every') {
        isDue = entry.lastRun === 0 || (now - entry.lastRun >= entry.intervalMs);
      } else if (entry.type === 'one-shot') {
        isDue = entry.runAt !== undefined && now >= entry.runAt;
      }

      if (!isDue) continue;

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

  /** Register the heartbeat as a special 'every' task */
  registerHeartbeat(handler: () => void | Promise<void>): void {
    this.register({
      id: 'heartbeat',
      name: 'Heartbeat',
      type: 'every',
      intervalMs: this.config.heartbeatIntervalMs,
      handler,
      state: 'idle',
    });
  }

  get taskCount(): number {
    return this.tasks.size;
  }
}
