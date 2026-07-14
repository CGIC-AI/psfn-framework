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
 * (one GET alongside the range read) and a bumped epoch makes every
 * pre-rewrite row structurally unreadable in every process: the new-epoch key
 * is empty, which is a miss + full repopulation at the current epoch. Stale
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
  private async readEpoch(channelKey: string): Promise<number> {
    const reply = await this.send(['GET', this.buildEpochKey(channelKey)]);
    if (reply === null || reply === undefined) return 0;
    if (typeof reply !== 'string' || !/^\d+$/.test(reply)) {
      throw new Error('Redis session tail epoch key holds a non-integer value');
    }
    return Number.parseInt(reply, 10);
  }

  async getTail(channelKey: string): Promise<SessionTailRow[]> {
    const epoch = await this.readEpoch(channelKey);
    const reply = await this.send(['ZRANGE', this.buildTailKey(channelKey, epoch), '0', '-1']);
    if (reply === null || reply === undefined) return [];
    if (!Array.isArray(reply)) {
      throw new Error('Redis session tail ZRANGE returned a non-array reply');
    }
    return reply.map((member) => {
      if (typeof member !== 'string') {
        throw new Error('Redis session tail ZRANGE returned a non-string member');
      }
      return deserializeSessionTailRow(member);
    });
  }

  async appendRow(channelKey: string, row: SessionTailRow): Promise<void> {
    const epoch = await this.readEpoch(channelKey);
    const key = this.buildTailKey(channelKey, epoch);
    await this.send(['ZADD', key, String(sessionTailRowId(row)), serializeSessionTailRow(row)]);
    await this.send(['ZREMRANGEBYRANK', key, '0', String(-(this.maxEntriesPerChannel + 1))]);
    await this.send(['PEXPIRE', key, String(SESSION_TAIL_KEY_TTL_MS)]);
  }

  async replaceTail(channelKey: string, rows: readonly SessionTailRow[]): Promise<void> {
    const epoch = await this.readEpoch(channelKey);
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

  async invalidateChannel(channelKey: string): Promise<void> {
    const epoch = await this.readEpoch(channelKey);
    await this.send(['DEL', this.buildTailKey(channelKey, epoch)]);
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
