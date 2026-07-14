import { describe, expect, it } from 'vitest';
import type { RedisClientLike } from '../../shared/cache/redis-cache.js';
import type { SessionEntry } from '../../core/session/types.js';
import {
  RedisSessionTailCache,
  SESSION_TAIL_KEY_PREFIX,
} from './redis-session-tail-cache.js';
import {
  deserializeSessionTailEntry,
  normalizeSessionTailEntries,
  serializeSessionTailEntry,
} from './session-tail-cache-port.js';

// In-memory fake implementing just the ZSET commands the tail cache issues.
// No live Redis in unit tests (psfn-framework-hgw3.5 acceptance).
class FakeRedisClient implements RedisClientLike {
  isOpen = false;
  connectCount = 0;
  private zsets = new Map<string, Map<string, number>>();

  async connect(): Promise<unknown> {
    this.isOpen = true;
    this.connectCount += 1;
    return this;
  }

  async get(): Promise<string | null> {
    return null;
  }

  async del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      if (this.zsets.delete(key)) removed += 1;
    }
    return removed;
  }

  // eslint-disable-next-line require-yield -- fake never scans
  async *scanIterator(): AsyncGenerator<string> {
    return;
  }

  membersInRankOrder(key: string): string[] {
    const zset = this.zsets.get(key);
    if (!zset) return [];
    return [...zset.entries()]
      .sort((left, right) => (left[1] - right[1]) || left[0].localeCompare(right[0]))
      .map(([member]) => member);
  }

  async sendCommand(args: string[]): Promise<unknown> {
    const [command, key, ...rest] = args;
    switch (command) {
      case 'ZADD': {
        let zset = this.zsets.get(key);
        if (!zset) {
          zset = new Map();
          this.zsets.set(key, zset);
        }
        for (let index = 0; index < rest.length; index += 2) {
          zset.set(rest[index + 1], Number(rest[index]));
        }
        return rest.length / 2;
      }
      case 'ZRANGE': {
        if (rest[0] !== '0' || rest[1] !== '-1') {
          throw new Error(`FakeRedisClient only supports ZRANGE 0 -1, got ${rest.join(' ')}`);
        }
        return this.membersInRankOrder(key);
      }
      case 'ZREMRANGEBYRANK': {
        const members = this.membersInRankOrder(key);
        const start = Number(rest[0]);
        const rawStop = Number(rest[1]);
        const stop = rawStop < 0 ? members.length + rawStop : rawStop;
        const zset = this.zsets.get(key);
        if (!zset || stop < start) return 0;
        let removed = 0;
        for (let rank = start; rank <= stop && rank < members.length; rank += 1) {
          zset.delete(members[rank]);
          removed += 1;
        }
        return removed;
      }
      case 'DEL':
        return await this.del(key);
      default:
        throw new Error(`FakeRedisClient does not implement ${command}`);
    }
  }
}

function makeEntry(id: number, content = `message ${id}`): SessionEntry {
  return {
    id,
    channelId: 'fixture:channel',
    role: id % 2 === 0 ? 'assistant' : 'user',
    content,
    authorId: id % 2 === 0 ? 'fixture-companion' : 'fixture-contact',
    authorName: id % 2 === 0 ? 'FixtureCompanion' : 'FixtureContact',
    timestamp: 1_000 + id,
  };
}

describe('RedisSessionTailCache (psfn-framework-hgw3.5)', () => {
  it('rejects a non-positive bound at construction', () => {
    const client = new FakeRedisClient();
    expect(() => new RedisSessionTailCache({ client, maxEntriesPerChannel: 0 }))
      .toThrow(/positive integer/);
  });

  it('appends through, connects lazily, and trims to the bound', async () => {
    const client = new FakeRedisClient();
    const cache = new RedisSessionTailCache({ client, maxEntriesPerChannel: 3 });

    for (let id = 1; id <= 5; id += 1) {
      await cache.appendEntry('ch-1', makeEntry(id));
    }

    expect(client.connectCount).toBe(1);
    const tail = await cache.getTail('ch-1');
    expect(tail.map(entry => entry.id)).toEqual([3, 4, 5]);
    expect(tail[0]).toEqual(makeEntry(3));
  });

  it('keys one ZSET per channel under the documented prefix', async () => {
    const client = new FakeRedisClient();
    const cache = new RedisSessionTailCache({ client, maxEntriesPerChannel: 8 });

    await cache.appendEntry('ch-a', makeEntry(1));
    await cache.appendEntry('ch-b', makeEntry(1));

    expect(client.membersInRankOrder(`${SESSION_TAIL_KEY_PREFIX}ch-a`)).toHaveLength(1);
    expect(client.membersInRankOrder(`${SESSION_TAIL_KEY_PREFIX}ch-b`)).toHaveLength(1);
    expect((await cache.getTail('ch-a'))[0].id).toBe(1);
  });

  it('returns entries in id order even when appends arrive out of order', async () => {
    const client = new FakeRedisClient();
    const cache = new RedisSessionTailCache({ client, maxEntriesPerChannel: 8 });

    await cache.appendEntry('ch-1', makeEntry(7));
    await cache.appendEntry('ch-1', makeEntry(5));
    await cache.appendEntry('ch-1', makeEntry(6));

    const tail = normalizeSessionTailEntries(await cache.getTail('ch-1'));
    expect(tail.map(entry => entry.id)).toEqual([5, 6, 7]);
  });

  it('replaceTail swaps the window wholesale and applies the bound', async () => {
    const client = new FakeRedisClient();
    const cache = new RedisSessionTailCache({ client, maxEntriesPerChannel: 2 });

    await cache.appendEntry('ch-1', makeEntry(1));
    await cache.replaceTail('ch-1', [makeEntry(10), makeEntry(11), makeEntry(12)]);

    const tail = await cache.getTail('ch-1');
    expect(tail.map(entry => entry.id)).toEqual([11, 12]);

    await cache.replaceTail('ch-1', []);
    expect(await cache.getTail('ch-1')).toEqual([]);
  });

  it('invalidateChannel drops the channel tail', async () => {
    const client = new FakeRedisClient();
    const cache = new RedisSessionTailCache({ client, maxEntriesPerChannel: 4 });

    await cache.appendEntry('ch-1', makeEntry(1));
    await cache.invalidateChannel('ch-1');

    expect(await cache.getTail('ch-1')).toEqual([]);
  });

  it('serializes entries without integrity fields', async () => {
    const client = new FakeRedisClient();
    const cache = new RedisSessionTailCache({ client, maxEntriesPerChannel: 4 });
    const tainted = {
      ...makeEntry(1),
      _hmac: 'must-not-persist',
      _hmacKeyVersion: 3,
    } as unknown as SessionEntry;

    await cache.appendEntry('ch-1', tainted);

    const [member] = client.membersInRankOrder(`${SESSION_TAIL_KEY_PREFIX}ch-1`);
    expect(member).not.toContain('_hmac');
    expect((await cache.getTail('ch-1'))[0]).toEqual(makeEntry(1));
  });

  it('fails closed on corrupt members', async () => {
    const client = new FakeRedisClient();
    const cache = new RedisSessionTailCache({ client, maxEntriesPerChannel: 4 });
    await client.sendCommand(['ZADD', `${SESSION_TAIL_KEY_PREFIX}ch-1`, '1', 'not-json']);

    await expect(cache.getTail('ch-1')).rejects.toThrow(/not valid JSON/);
  });
});

describe('session tail entry serialization', () => {
  it('round-trips a SessionEntry exactly', () => {
    const entry = makeEntry(42, 'round trip content');
    expect(deserializeSessionTailEntry(serializeSessionTailEntry(entry))).toEqual(entry);
  });

  it('rejects payloads missing required fields or carrying integrity fields', () => {
    expect(() => deserializeSessionTailEntry(JSON.stringify({ id: 1 })))
      .toThrow(/required SessionEntry fields/);
    expect(() => deserializeSessionTailEntry(JSON.stringify({
      ...makeEntry(1),
      _hmac: 'sig',
    }))).toThrow(/integrity fields/);
  });

  it('normalizeSessionTailEntries sorts ascending and fails closed on duplicate ids', () => {
    expect(normalizeSessionTailEntries([makeEntry(3), makeEntry(1)]).map(entry => entry.id))
      .toEqual([1, 3]);
    expect(() => normalizeSessionTailEntries([makeEntry(2), { ...makeEntry(2), content: 'other' }]))
      .toThrow(/duplicate entry id 2/);
  });
});
