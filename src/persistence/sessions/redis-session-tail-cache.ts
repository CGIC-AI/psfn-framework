import type { RedisClientLike } from '../../shared/cache/redis-cache.js';
import { createComponentLogger } from '../../shared/logger.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import {
  deserializeSessionTailRow,
  serializeSessionTailRow,
  sessionTailRowId,
  type SessionTailCachePort,
  type SessionTailRow,
} from './session-tail-cache-port.js';

const log = createComponentLogger('RedisSessionTailCache');

/**
 * Redis-backed session tail (psfn-framework-hgw3.5).
 *
 * Key scheme (all keys carry the deployment/companion scope so two companions
 * sharing one Redis can never read each other's tails):
 * - epoch:  `psfn:session-tail-epoch:<scope>:<channelKey>` — plain integer,
 *   INCRed by every journal rewrite path before the rewrite completes;
 * - tail:   `psfn:session-tail:<scope>:<channelKey>:e<epoch>` — one ZSET per
 *   channel AND epoch with score = entry id and member = serialized
 *   SessionTailRow JSON (no `_hmac`).
 *
 * Because the tail key embeds the epoch, readers resolve the current epoch
 * (GET before the range read, re-GET after it — a changed epoch is a miss)
 * and a bumped epoch makes every pre-rewrite row structurally unreadable in
 * every process: the new-epoch key is empty, which is a miss + full
 * repopulation at the current epoch. Writers pass the epoch they CAPTURED
 * when they captured their data (never resolved at write-execution time), so
 * a delayed write can only ever land under an already-superseded key. Stale
 * epoch keys are DELed on bump and additionally expire via TTL so leaked
 * keys (a straggler write racing a bump) are garbage collected.
 *
 * A ZSET (rather than a LIST) was chosen because write-through appends are
 * fire-and-forget from multiple processes: arrival order at Redis is not
 * guaranteed to match entry-id order, and ZADD keyed by id is idempotent and
 * order-insensitive where RPUSH would interleave. The tail is bounded by
 * ZREMRANGEBYRANK on every append.
 */
export const SESSION_TAIL_KEY_PREFIX = 'psfn:session-tail:';
export const SESSION_TAIL_EPOCH_KEY_PREFIX = 'psfn:session-tail-epoch:';

/**
 * TTL refreshed on every tail write. Correctness never depends on it (epoch
 * fencing does that); it only garbage-collects abandoned epoch keys.
 */
export const SESSION_TAIL_KEY_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const REDIS_PURGE_LIMITS = {
  scanCount: 100,
  deleteBatchSize: 100,
} as const;

function escapeRedisGlobLiteral(value: string): string {
  return value.replace(/[\\*?[\]]/gu, '\\$&');
}

function normalizeScannedKeys(item: string | readonly string[]): string[] {
  const keys = typeof item === 'string' ? [item] : [...item];
  for (const key of keys) {
    if (typeof key !== 'string') {
      throw new Error('Redis session tail SCAN returned a non-string key');
    }
  }
  return keys;
}

export interface RedisSessionTailCacheOptions {
  client: RedisClientLike;
  maxEntriesPerChannel: number;
  /**
   * Stable per-deployment/companion identity (COMPANION_ID). Required so tail
   * and epoch keys are companion-scoped on a shared Redis.
   */
  scope: string;
  keyPrefix?: string;
  epochKeyPrefix?: string;
}

export class RedisSessionTailCache implements SessionTailCachePort {
  readonly maxEntriesPerChannel: number;
  private readonly client: RedisClientLike;
  private readonly scope: string;
  private readonly keyPrefix: string;
  private readonly epochKeyPrefix: string;
  private connectPromise: Promise<unknown> | null = null;

  constructor(options: RedisSessionTailCacheOptions) {
    if (
      !Number.isInteger(options.maxEntriesPerChannel)
      || options.maxEntriesPerChannel <= 0
    ) {
      throw new Error('Session tail cache maxEntriesPerChannel must be a positive integer');
    }
    const scope = options.scope.trim();
    if (!scope) {
      throw new Error('Session tail cache scope (companion identity) is required');
    }
    this.client = options.client;
    this.maxEntriesPerChannel = options.maxEntriesPerChannel;
    // Encode the scope so it can never contain the `:` separator: two
    // different scopes must never produce overlapping key spaces.
    this.scope = encodeURIComponent(scope);
    this.keyPrefix = options.keyPrefix ?? SESSION_TAIL_KEY_PREFIX;
    this.epochKeyPrefix = options.epochKeyPrefix ?? SESSION_TAIL_EPOCH_KEY_PREFIX;
  }

  private buildEpochKey(channelKey: string): string {
    return `${this.epochKeyPrefix}${this.scope}:${channelKey}`;
  }

  private buildTailKey(channelKey: string, epoch: number): string {
    return `${this.keyPrefix}${this.scope}:${channelKey}:e${epoch}`;
  }

  private async ensureConnected(): Promise<void> {
    if (this.client.isOpen === true) return;
    // Single-flight while a connect is in flight; reset after settle so a
    // failed connect does not wedge every future operation (same contract as
    // RedisAppCache).
    this.connectPromise ??= this.client.connect().finally(() => {
      this.connectPromise = null;
    });
    await this.connectPromise;
  }

  private async send(args: string[]): Promise<unknown> {
    if (!this.client.sendCommand) {
      throw new Error('Redis session tail cache client does not support sendCommand');
    }
    await this.ensureConnected();
    return await this.client.sendCommand(args);
  }

  /** Current epoch for a channel; a missing key reads as epoch 0. */
  async getEpoch(channelKey: string): Promise<number> {
    const reply = await this.send(['GET', this.buildEpochKey(channelKey)]);
    if (reply === null || reply === undefined) return 0;
    if (typeof reply !== 'string' || !/^\d+$/.test(reply)) {
      throw new Error('Redis session tail epoch key holds a non-integer value');
    }
    return Number.parseInt(reply, 10);
  }

  async getTail(channelKey: string): Promise<SessionTailRow[]> {
    const epoch = await this.getEpoch(channelKey);
    const reply = await this.send(['ZRANGE', this.buildTailKey(channelKey, epoch), '0', '-1']);
    if (reply === null || reply === undefined) return [];
    if (!Array.isArray(reply)) {
      throw new Error('Redis session tail ZRANGE returned a non-array reply');
    }
    // Double-read validation: GET epoch + ZRANGE is a TOCTOU pair. If a
    // rewrite fence (epoch bump) landed between the two, the rows above came
    // from a superseded epoch and may contain pre-rewrite content. Re-resolve
    // the epoch and treat any change as a miss (empty window) — the caller
    // degrades to the journal path and repopulates at the current epoch.
    const epochAfterRead = await this.getEpoch(channelKey);
    if (epochAfterRead !== epoch) return [];
    return reply.map((member) => {
      if (typeof member !== 'string') {
        throw new Error('Redis session tail ZRANGE returned a non-string member');
      }
      return deserializeSessionTailRow(member);
    });
  }

  async appendRow(channelKey: string, epoch: number, row: SessionTailRow): Promise<void> {
    const key = this.buildTailKey(channelKey, epoch);
    await this.send(['ZADD', key, String(sessionTailRowId(row)), serializeSessionTailRow(row)]);
    await this.send(['ZREMRANGEBYRANK', key, '0', String(-(this.maxEntriesPerChannel + 1))]);
    await this.send(['PEXPIRE', key, String(SESSION_TAIL_KEY_TTL_MS)]);
  }

  async replaceTail(channelKey: string, epoch: number, rows: readonly SessionTailRow[]): Promise<void> {
    const key = this.buildTailKey(channelKey, epoch);
    await this.send(['DEL', key]);
    const bounded = rows.slice(-this.maxEntriesPerChannel);
    if (bounded.length === 0) return;
    const args = ['ZADD', key];
    for (const row of bounded) {
      args.push(String(sessionTailRowId(row)), serializeSessionTailRow(row));
    }
    await this.send(args);
    await this.send(['PEXPIRE', key, String(SESSION_TAIL_KEY_TTL_MS)]);
  }

  async invalidateChannel(channelKey: string, epoch: number): Promise<void> {
    await this.send(['DEL', this.buildTailKey(channelKey, epoch)]);
  }

  /**
   * Maintenance-only exact-session purge. The sole wildcard is the epoch
   * suffix beneath this companion + channel key family; every SCAN result is
   * revalidated before deletion so no neighboring session or companion key
   * can be removed.
   */
  async purgeChannelKeyFamily(channelKey: string): Promise<number> {
    await this.ensureConnected();
    const exactTailPrefix = this.buildTailKey(channelKey, 0).slice(0, -1);
    const match = `${escapeRedisGlobLiteral(exactTailPrefix)}*`;
    const epochKey = this.buildEpochKey(channelKey);
    const keys = new Set<string>([epochKey]);
    for await (const item of this.client.scanIterator({
      MATCH: match,
      COUNT: REDIS_PURGE_LIMITS.scanCount,
    })) {
      for (const key of normalizeScannedKeys(item)) {
        const suffix = key.startsWith(exactTailPrefix)
          ? key.slice(exactTailPrefix.length)
          : '';
        if (/^\d+$/u.test(suffix)) keys.add(key);
      }
    }

    let removed = 0;
    const pending = [...keys];
    for (let offset = 0; offset < pending.length; offset += REDIS_PURGE_LIMITS.deleteBatchSize) {
      removed += await this.client.del(
        ...pending.slice(offset, offset + REDIS_PURGE_LIMITS.deleteBatchSize),
      );
    }
    return removed;
  }

  async bumpEpoch(channelKey: string): Promise<number> {
    const reply = await this.send(['INCR', this.buildEpochKey(channelKey)]);
    if (typeof reply !== 'number' || !Number.isInteger(reply) || reply <= 0) {
      throw new Error('Redis session tail epoch INCR returned a non-integer reply');
    }
    // Fencing is complete once the INCR lands: readers resolve the new epoch
    // and the old key is unreachable. Deleting it is pure garbage collection
    // (TTL also covers it), so a failed DEL is logged, never rethrown into
    // the rewrite that just fenced successfully.
    try {
      await this.send(['DEL', this.buildTailKey(channelKey, reply - 1)]);
    } catch (error) {
      log.warn('Session tail epoch bump succeeded but stale-key cleanup failed; TTL will collect it', {
        channelKey,
        epoch: reply,
        error: toErrorMessage(error),
      });
    }
    return reply;
  }

  async close(): Promise<void> {
    if (this.client.quit && this.client.isOpen === true) {
      await this.client.quit();
    }
  }
}
