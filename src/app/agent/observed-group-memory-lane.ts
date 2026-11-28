import type { Scheduler } from '../../core/scheduler/scheduler.js';
import type { SubstrateMessage } from '../../shared/contracts/runtime.js';
import type { ObservedGroupMemoryScheduleDecision } from '../../faculties/memory/extraction/group-observed-scheduler.js';
import type { GroupMemoryExtractionFailureRetryConfig } from '../../system/config/scheduler-config.js';
import { toErrorMessage } from '../../shared/utils/errors.js';

/**
 * Observed group-room memory work, off the observe path (psfn-framework-qvwem).
 *
 * Observing an ambient group line must not wait for memory extraction: the
 * extraction is a background-model call that took ~34 s in shakedown r2 and
 * made the gateway `handle` RPC (and the external adapter turn) time out.
 * The observe path therefore only ENQUEUES the scheduling here and returns.
 *
 * This lane is not fire-and-forget:
 * - per channel, observations are scheduled strictly in arrival order (one at
 *   a time), so the scheduler's watermark/in-flight/cooldown logic sees the
 *   same sequence it did when the observe path awaited it;
 * - every outcome is recorded (scheduled, extraction_failed, thrown errors) on
 *   the audit trail, never swallowed;
 * - shutdown stops intake and drains the queue with a bound.
 *
 * Durability: the source line is journaled by `observeMessage` BEFORE it is
 * enqueued, and the group watermark advances only when an extraction is
 * accepted. A span whose scheduling never ran (crash, drain timeout, stopped
 * lane) stays unprocessed backlog and is re-planned by the next observation
 * of the channel (the scheduler's `backlog_lag` trigger).
 *
 * Timed failure retry (d5e0p.15): a failed range is also re-attempted without
 * new traffic. The retry sweep enqueues each due channel on the same
 * per-channel queue, so a retry never races a live observation of that room.
 */

export interface ObservedGroupMemoryLaneScheduler {
  observeMessage(message: SubstrateMessage): Promise<ObservedGroupMemoryScheduleDecision>;
  listDueFailureRetries(): string[];
  retryFailedRange(channelId: string): Promise<ObservedGroupMemoryScheduleDecision>;
}

export interface ObservedGroupMemoryLaneAudit {
  append(event: string, details: Record<string, unknown>): void;
}

export interface ObservedGroupMemoryLaneLogger {
  warn(message: string, details?: Record<string, unknown>): void;
}

export class ObservedGroupMemoryLane {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly pending = new Set<Promise<void>>();
  private accepting = true;

  constructor(private readonly deps: {
    scheduler: ObservedGroupMemoryLaneScheduler;
    audit: ObservedGroupMemoryLaneAudit;
    log: ObservedGroupMemoryLaneLogger;
  }) {}

  /**
   * Queue the observation's memory scheduling behind earlier observations of
   * the same channel and return immediately. The returned promise settles when
   * this observation's scheduling finished (it never rejects); the observe
   * path does not await it.
   */
  enqueue(message: SubstrateMessage): Promise<void> {
    if (!this.accepting) {
      this.deps.audit.append('memory.group_observed.deferred', {
        channelId: message.channelId,
        messageId: message.id,
        reason: 'lane_stopped',
      });
      return Promise.resolve();
    }
    return this.enqueueChannelTask(message.channelId, () => this.schedule(message));
  }

  /**
   * Enqueue a timed retry for every channel whose failed range is due, behind
   * that channel's queued observations. Returns the number enqueued; resolves
   * when they have all run (never rejects).
   */
  async retryDueFailedRanges(): Promise<number> {
    if (!this.accepting) return 0;
    let channelIds: string[];
    try {
      channelIds = this.deps.scheduler.listDueFailureRetries();
    } catch (error) {
      const errorText = toErrorMessage(error);
      this.deps.log.warn('Observed group memory retry sweep failed', { error: errorText });
      this.deps.audit.append('memory.group_observed.error', { reason: 'failure_retry_sweep', error: errorText });
      return 0;
    }
    await Promise.all(channelIds.map(channelId => (
      this.enqueueChannelTask(channelId, () => this.retry(channelId))
    )));
    return channelIds.length;
  }

  private enqueueChannelTask(channelId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.tails.get(channelId) ?? Promise.resolve();
    const run = previous.then(task);
    this.tails.set(channelId, run);
    this.pending.add(run);
    void run.finally(() => {
      this.pending.delete(run);
      if (this.tails.get(channelId) === run) this.tails.delete(channelId);
    });
    return run;
  }

  /** Observations still queued or running. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Stop intake and wait (bounded) for queued scheduling to finish. Returns
   * false when the bound elapsed first; the unfinished spans stay backlog.
   */
  async stop(options: { timeoutMs: number }): Promise<boolean> {
    this.accepting = false;
    if (this.pending.size === 0) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), options.timeoutMs);
    });
    try {
      return await Promise.race([
        Promise.allSettled([...this.pending]).then(() => true as const),
        timedOut,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async retry(channelId: string): Promise<void> {
    try {
      const decision = await this.deps.scheduler.retryFailedRange(channelId);
      this.recordDecision(decision, { retry: true });
    } catch (schedulerError) {
      const errorText = toErrorMessage(schedulerError);
      this.deps.log.warn('Observed group memory failure retry failed', { channelId, error: errorText });
      this.deps.audit.append('memory.group_observed.error', { channelId, retry: true, error: errorText });
    }
  }

  private async schedule(message: SubstrateMessage): Promise<void> {
    try {
      const decision = await this.deps.scheduler.observeMessage(message);
      this.recordDecision(decision, { messageId: message.id });
    } catch (schedulerError) {
      const errorText = toErrorMessage(schedulerError);
      this.deps.log.warn('Observed group memory scheduling failed', {
        channelId: message.channelId,
        messageId: message.id,
        error: errorText,
      });
      this.deps.audit.append('memory.group_observed.error', {
        channelId: message.channelId,
        messageId: message.id,
        error: errorText,
      });
    }
  }

  private recordDecision(
    decision: ObservedGroupMemoryScheduleDecision,
    origin: { messageId: string } | { retry: true },
  ): void {
    if (decision.status === 'scheduled') {
      this.deps.audit.append('memory.group_observed.scheduled', {
        channelId: decision.channelId,
        ...origin,
        triggerReason: decision.triggerReason,
        spanStartMessageId: decision.spanStartMessageId,
        spanEndMessageId: decision.spanEndMessageId,
        newEntryCount: decision.newEntryCount,
        watermarkLagMessageIds: decision.watermarkLagMessageIds,
        hasDeferredBacklog: decision.hasDeferredBacklog,
      });
    } else if (decision.reason === 'extraction_failed') {
      this.deps.log.warn('Observed group memory extraction failed', {
        channelId: decision.channelId,
        ...origin,
        watermarkLagMessageIds: decision.watermarkLagMessageIds,
        error: decision.error,
      });
      this.deps.audit.append('memory.group_observed.error', {
        channelId: decision.channelId,
        ...origin,
        reason: decision.reason,
        error: decision.error,
      });
    }
  }
}

/**
 * Register the timed failure-retry sweep (d5e0p.15) with the runtime scheduler.
 * One sweep per agent process: the watermark file is per companion data dir.
 */
export function registerGroupMemoryFailureRetrySweep(
  scheduler: Pick<Scheduler, 'getTask' | 'register'>,
  lane: Pick<ObservedGroupMemoryLane, 'retryDueFailedRanges'>,
  failureRetry: GroupMemoryExtractionFailureRetryConfig,
): void {
  const taskId = 'memory.group-extraction-failure-retry';
  if (scheduler.getTask(taskId)) return;
  scheduler.register({
    id: taskId,
    name: 'Group-memory failure retry',
    description: 'Retry failed observed group-memory ranges on their bounded backoff without new traffic.',
    scheduleSource: 'scheduler.json groupMemoryExtraction.failureRetry.sweepIntervalMinutes',
    type: 'every',
    intervalMs: failureRetry.sweepIntervalMinutes * 60_000,
    state: 'idle',
    handler: async () => {
      await lane.retryDueFailedRanges();
    },
  });
}
