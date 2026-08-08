import type { SessionEntry } from '../../../core/session/types.js';
import { createComponentLogger } from '../../../shared/logger.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import {
  validateSessionTailWindow,
  type SessionTailCachePort,
  type SessionTailRow,
} from '../session-tail-cache-port.js';

const log = createComponentLogger('SessionStore:tail');

const TAIL_DEGRADED_WARN_INTERVAL_MS = 30_000;

export interface SessionTailOperationsOptions {
  tailCache: SessionTailCachePort | null;
  resolveChannelKey(channelId: string): string;
  getRecent(channelId: string, limit: number): SessionEntry[];
}

/**
 * Shared hot-tail cache operations for SessionStore (psfn-framework-hgw3.5).
 *
 * Owns Redis-backed tail writes, epoch fencing around journal rewrites,
 * degradation handling, and repopulation. All tail failures degrade to the
 * journal path rather than failing the caller.
 */
export class SessionTailOperations {
  private readonly tailCache: SessionTailCachePort | null;
  private readonly resolveChannelKey: (channelId: string) => string;
  private readonly getRecent: (channelId: string, limit: number) => SessionEntry[];
  /** Serializes fire-and-forget tail writes so per-channel ops keep call order. */
  private tailWriteChain: Promise<void> = Promise.resolve();
  /**
   * Channels whose Redis tail must not be trusted until repopulated: a tail
   * write failed (possible gap) or a journal rewrite invalidated the window.
   * Local-process poison flag backing the cross-process DEL.
   */
  private tailRefreshRequiredChannels = new Set<string>();
  private tailDegradedLastWarnAt = 0;
  private tailDegradedSuppressedCount = 0;

  constructor(options: SessionTailOperationsOptions) {
    this.tailCache = options.tailCache;
    this.resolveChannelKey = options.resolveChannelKey;
    this.getRecent = options.getRecent;
  }

  private resolveTailChannelKey(channelId: string): string {
    return this.resolveChannelKey(channelId);
  }

  /**
   * Redis degraded: LOUD warn, rate-limited per occurrence window. A companion
   * that stops replying because Redis blipped is worse than one on slow file
   * reads, so tail failures degrade to the journal path and are logged, never
   * hidden and never rethrown into the turn.
   */
  private markSessionTailDegraded(channelKey: string, operation: string, error: unknown): void {
    this.tailRefreshRequiredChannels.add(channelKey);
    const now = Date.now();
    if (now - this.tailDegradedLastWarnAt < TAIL_DEGRADED_WARN_INTERVAL_MS) {
      this.tailDegradedSuppressedCount += 1;
      return;
    }
    const suppressed = this.tailDegradedSuppressedCount;
    this.tailDegradedLastWarnAt = now;
    this.tailDegradedSuppressedCount = 0;
    log.warn('Session tail cache degraded; serving journal reads until the tail repopulates', {
      channelKey,
      operation,
      suppressedSinceLastWarn: suppressed,
      error: toErrorMessage(error),
    });
  }

  /**
   * Serialize fire-and-forget tail writes. The journal write already
   * succeeded by the time these run; a tail failure only poisons the channel
   * tail (forced refresh) and warns — it never fails the caller.
   */
  private queueSessionTailWrite(
    channelKey: string,
    operation: string,
    op: () => Promise<void>,
  ): void {
    this.tailWriteChain = this.tailWriteChain.then(async () => {
      try {
        await op();
      } catch (error) {
        this.markSessionTailDegraded(channelKey, operation, error);
      }
    });
  }

  /** Write-through after a durable journal append (write path holds the journal lock). */
  private writeSessionTailRowThrough(channelId: string, row: SessionTailRow): void {
    const port = this.tailCache;
    if (!port) return;
    const channelKey = this.resolveTailChannelKey(channelId);
    // Capture the epoch AT ENQUEUE time (the GET is issued now, while the row
    // data is fresh under the journal lock), never at write-execution time: a
    // queued append that captured pre-rewrite content must land under the
    // pre-rewrite epoch key, where a rewrite's fence bumps make it
    // structurally unreadable. Rejections surface when the queued op awaits
    // the promise; the no-op catch only prevents a spurious
    // unhandled-rejection between enqueue and execution.
    const epochAtEnqueue = port.getEpoch(channelKey);
    epochAtEnqueue.catch(() => { /* handled where awaited on the write chain */ });
    this.queueSessionTailWrite(channelKey, 'append', async () => {
      const epoch = await epochAtEnqueue;
      if (this.tailRefreshRequiredChannels.has(channelKey)) {
        // A prior tail write failed: the tail may hide a gap. Drop it before
        // appending so readers fall back to the journal until repopulation.
        await port.invalidateChannel(channelKey, epoch);
        this.tailRefreshRequiredChannels.delete(channelKey);
      }
      await port.appendRow(channelKey, epoch, row);
    });
  }

  writeSessionTailThrough(channelId: string, entry: SessionEntry): void {
    this.writeSessionTailRowThrough(channelId, { kind: 'message', entry });
  }

  /**
   * Non-message journal entries (compactions, extraction markers, shutdown
   * markers) consume entry ids too. Write an explicit id-gap placeholder so
   * the tail's ID CONTIGUITY invariant keeps holding: without it every
   * non-message append would read as a lost tail write and force a miss.
   */
  writeSessionTailGapThrough(channelId: string, id: number): void {
    this.writeSessionTailRowThrough(channelId, { kind: 'id_gap', id });
  }

  /**
   * Advance the shared per-channel tail epoch. Every journal REWRITE path
   * (CogSec tombstone/compaction rewrites, turn tombstones, post-repair
   * reloads) MUST await this before the rewrite completes: the epoch bump is
   * what makes every pre-rewrite tail row unreadable in EVERY process, so
   * security redactions can never be resurrected from Redis. Fail-closed: a
   * failed bump aborts the rewrite loudly instead of leaving other processes
   * able to serve pre-rewrite content.
   *
   * Queued tail writes are drained first so a repopulation captured before
   * the rewrite can only ever land under the old (fenced-off) epoch.
   */
  async bumpSessionTailEpoch(channelId: string, reason: string): Promise<void> {
    const port = this.tailCache;
    if (!port) return;
    const channelKey = this.resolveTailChannelKey(channelId);
    this.tailRefreshRequiredChannels.add(channelKey);
    await this.tailWriteChain;
    try {
      await port.bumpEpoch(channelKey);
    } catch (error) {
      throw new Error(
        `Session tail epoch bump failed for channel ${channelKey} (${reason}); `
        + `refusing to complete the journal rewrite while other processes could `
        + `serve the pre-rewrite tail: ${toErrorMessage(error)}`,
      );
    }
    this.tailRefreshRequiredChannels.delete(channelKey);
  }

  /**
   * Run a journal-rewrite body and GUARANTEE the post-rewrite epoch bump
   * executes once the journal mutation is durable — even when a step between
   * the rewrite and the bump throws (projection sync, index update, event
   * store bookkeeping). The body calls `markRewritten()` immediately after
   * the journal mutation lands; if it was called, the second fence runs on
   * BOTH the success and the failure path. `bumpSessionTailEpoch` poisons the
   * local tail (refresh flag) before attempting the INCR, so even a failed
   * bump leaves local state safe while still throwing loudly (fail-closed).
   */
  async withPostRewriteTailFence<T>(
    channelId: string,
    reason: string,
    body: (markRewritten: () => void) => T,
  ): Promise<T> {
    const state = { rewritten: false };
    let result: T;
    try {
      result = body(() => {
        state.rewritten = true;
      });
    } catch (error) {
      if (state.rewritten) {
        try {
          await this.bumpSessionTailEpoch(channelId, `${reason}:post`);
        } catch (bumpError) {
          // Neither failure may be swallowed: the caller sees both.
          throw new AggregateError(
            [error, bumpError],
            `Journal rewrite failed after mutating the journal AND the post-rewrite `
            + `tail fence failed for channel ${channelId} (${reason}): `
            + `${toErrorMessage(error)}; ${toErrorMessage(bumpError)}`,
          );
        }
      }
      throw error;
    }
    if (state.rewritten) {
      await this.bumpSessionTailEpoch(channelId, `${reason}:post`);
    }
    return result;
  }

  /** Rebuild the Redis tail from the journal-backed recent window (fire-and-forget). */
  private repopulateSessionTail(channelId: string, channelKey: string): void {
    const port = this.tailCache;
    if (!port) return;
    this.queueSessionTailWrite(channelKey, 'repopulate', async () => {
      // ORDER MATTERS: resolve the epoch BEFORE capturing the journal data,
      // then write to that captured epoch's key only. Under the two-bump
      // rewrite protocol this is airtight: data captured after an epoch read
      // that predates the post-rewrite bump lands under a key that bump
      // supersedes, and an epoch read after the post-rewrite bump can only
      // see post-rewrite journal state. Resolving the epoch at write time
      // (or capturing data before the epoch) would let a delayed
      // repopulation resurrect pre-rewrite content under the new epoch.
      const epoch = await port.getEpoch(channelKey);
      const entries = this.getRecent(channelId, port.maxEntriesPerChannel);
      const rows: SessionTailRow[] = [];
      let previousId: number | null = null;
      for (const entry of entries) {
        if (previousId !== null && entry.id - previousId > port.maxEntriesPerChannel) {
          // Absurd id jump (corrupt window): keep only the newest contiguous
          // run instead of synthesizing an unbounded placeholder range.
          rows.length = 0;
        } else if (previousId !== null) {
          for (let gapId = previousId + 1; gapId < entry.id; gapId += 1) {
            rows.push({ kind: 'id_gap', id: gapId });
          }
        }
        rows.push({ kind: 'message', entry });
        previousId = entry.id;
      }
      await port.replaceTail(channelKey, epoch, rows);
      this.tailRefreshRequiredChannels.delete(channelKey);
    });
  }

  /**
   * Fetch the shared hot tail for a capture read (psfn-framework-hgw3.5).
   * Returns null when the tail cache is disabled, degraded, poisoned,
   * epoch-fenced (a journal rewrite bumped the channel epoch, making every
   * pre-rewrite row unreadable), non-contiguous (a lost tail write from any
   * process leaves an id hole the max-id freshness check alone would miss),
   * or BEHIND the just-recorded entry id (`expectedMinEntryId`) — callers
   * then stay on the journal-backed path (byte-identical behavior) while the
   * tail repopulates in the background. Integrates with the hgw3.1
   * stale-window heal guard: `reloadChannelFromDisk` bumps the epoch, so a
   * heal recapture never re-reads the window that was just diagnosed as
   * stale.
   */
  async fetchSessionTailWindow(
    channelId: string,
    options: { expectedMinEntryId?: number } = {},
  ): Promise<SessionEntry[] | null> {
    const port = this.tailCache;
    if (!port) return null;
    const channelKey = this.resolveTailChannelKey(channelId);
    if (!this.tailRefreshRequiredChannels.has(channelKey)) {
      let messages: SessionEntry[] = [];
      let maxRowId: number | null = null;
      try {
        ({ messages, maxRowId } = validateSessionTailWindow(await port.getTail(channelKey)));
      } catch (error) {
        // Fall through to repopulation: duplicate/gapped windows and Redis
        // errors alike degrade loudly to the journal path. If Redis is down
        // the repopulation fails quietly on the queued chain and the channel
        // stays poisoned until it recovers.
        this.markSessionTailDegraded(channelKey, 'read', error);
        messages = [];
        maxRowId = null;
      }
      if (messages.length > 0 && maxRowId !== null) {
        if (options.expectedMinEntryId === undefined || maxRowId >= options.expectedMinEntryId) {
          return messages;
        }
        log.warn('Session tail cache is behind the just-recorded entry; falling back to journal reads and repopulating', {
          channelKey,
          tailMaxEntryId: maxRowId,
          expectedMinEntryId: options.expectedMinEntryId,
        });
      }
    }
    this.repopulateSessionTail(channelId, channelKey);
    return null;
  }

  /** Flush queued tail writes (tests and shutdown). */
  async flushSessionTailWrites(): Promise<void> {
    await this.tailWriteChain;
  }
}
