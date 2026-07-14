import type { RedisClientLike } from '../../shared/cache/redis-cache.js';
import type { SessionEntry } from '../../core/session/types.js';
import {
  deserializeSessionTailEntry,
  serializeSessionTailEntry,
  type SessionTailCachePort,
} from './session-tail-cache-port.js';

/**
 * Redis-backed session tail (psfn-framework-hgw3.5).
 *
 * Key scheme: one ZSET per channel at `psfn:session-tail:<channelKey>` with
 * score = entry id and member = serialized SessionEntry JSON (no `_hmac`).
 * A ZSET (rather than a LIST) was chosen because write-through appends are
 * fire-and-forget from multiple processes: arrival order at Redis is not
 * guaranteed to match entry-id order, and ZADD keyed by id is idempotent and
 * order-insensitive where RPUSH would interleave. No TTL — the tail is
 * bounded by ZREMRANGEBYRANK on every append instead.
 */
export const SESSION_TAIL_KEY_PREFIX = 'psfn:session-tail:';

export interface RedisSessionTailCacheOptions {
  client: RedisClientLike;
  maxEntriesPerChannel: number;
  keyPrefix?: string;
}

export class RedisSessionTailCache implements SessionTailCachePort {
  readonly maxEntriesPerChannel: number;
  private readonly client: RedisClientLike;
  private readonly keyPrefix: string;
  private connectPromise: Promise<unknown> | null = null;

  constructor(options: RedisSessionTailCacheOptions) {
    if (
      !Number.isInteger(options.maxEntriesPerChannel)
      || options.maxEntriesPerChannel <= 0
    ) {
      throw new Error('Session tail cache maxEntriesPerChannel must be a positive integer');
    }
    this.client = options.client;
    this.maxEntriesPerChannel = options.maxEntriesPerChannel;
    this.keyPrefix = options.keyPrefix ?? SESSION_TAIL_KEY_PREFIX;
  }

  private buildKey(channelKey: string): string {
    return `${this.keyPrefix}${channelKey}`;
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

  async getTail(channelKey: string): Promise<SessionEntry[]> {
    const reply = await this.send(['ZRANGE', this.buildKey(channelKey), '0', '-1']);
    if (reply === null || reply === undefined) return [];
    if (!Array.isArray(reply)) {
      throw new Error('Redis session tail ZRANGE returned a non-array reply');
    }
    return reply.map((member) => {
      if (typeof member !== 'string') {
        throw new Error('Redis session tail ZRANGE returned a non-string member');
      }
      return deserializeSessionTailEntry(member);
    });
  }

  async appendEntry(channelKey: string, entry: SessionEntry): Promise<void> {
    const key = this.buildKey(channelKey);
    await this.send(['ZADD', key, String(entry.id), serializeSessionTailEntry(entry)]);
    await this.send(['ZREMRANGEBYRANK', key, '0', String(-(this.maxEntriesPerChannel + 1))]);
  }

  async replaceTail(channelKey: string, entries: readonly SessionEntry[]): Promise<void> {
    const key = this.buildKey(channelKey);
    await this.send(['DEL', key]);
    const bounded = entries.slice(-this.maxEntriesPerChannel);
    if (bounded.length === 0) return;
    const args = ['ZADD', key];
    for (const entry of bounded) {
      args.push(String(entry.id), serializeSessionTailEntry(entry));
    }
    await this.send(args);
  }

  async invalidateChannel(channelKey: string): Promise<void> {
    await this.send(['DEL', this.buildKey(channelKey)]);
  }

  async close(): Promise<void> {
    if (this.client.quit && this.client.isOpen === true) {
      await this.client.quit();
    }
  }
}
