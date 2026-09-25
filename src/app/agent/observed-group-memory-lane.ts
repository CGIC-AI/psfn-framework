import type { SubstrateMessage } from '../../shared/contracts/runtime.js';
import type { ObservedGroupMemoryScheduleDecision } from '../../faculties/memory/extraction/group-observed-scheduler.js';
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
 */

export interface ObservedGroupMemoryLaneScheduler {
  observeMessage(message: SubstrateMessage): Promise<ObservedGroupMemoryScheduleDecision>;
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
    const previous = this.tails.get(message.channelId) ?? Promise.resolve();
    const run = previous.then(() => this.schedule(message));
    this.tails.set(message.channelId, run);
    this.pending.add(run);
    void run.finally(() => {
      this.pending.delete(run);
      if (this.tails.get(message.channelId) === run) this.tails.delete(message.channelId);
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

  private async schedule(message: SubstrateMessage): Promise<void> {
    try {
      const decision = await this.deps.scheduler.observeMessage(message);
      if (decision.status === 'scheduled') {
        this.deps.audit.append('memory.group_observed.scheduled', {
          channelId: decision.channelId,
          messageId: message.id,
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
          messageId: message.id,
          watermarkLagMessageIds: decision.watermarkLagMessageIds,
          error: decision.error,
        });
        this.deps.audit.append('memory.group_observed.error', {
          channelId: decision.channelId,
          messageId: message.id,
          reason: decision.reason,
          error: decision.error,
        });
      }
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
}
