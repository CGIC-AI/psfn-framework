import { describe, expect, it } from 'vitest';
import type { RedisClientLike } from '../../shared/cache/redis-cache.js';
import type { SessionEntry } from '../../core/session/types.js';
import {
  RedisSessionTailCache,
  SESSION_TAIL_EPOCH_KEY_PREFIX,
  SESSION_TAIL_KEY_PREFIX,
} from './redis-session-tail-cache.js';
import {
  deserializeSessionTailRow,
  serializeSessionTailRow,
  validateSessionTailWindow,
  type SessionTailRow,
} from './session-tail-cache-port.js';

// In-memory fake implementing just the commands the tail cache issues.
// No live Redis in unit tests (psfn-framework-hgw3.5 acceptance).
class FakeRedisClient implements RedisClientLike {
  isOpen = false;
  connectCount = 0;
  failNextIncr = false;
  /** Test hook: observe/mutate state as each command arrives (race injection). */
  onCommand: ((args: string[]) => void) | null = null;
  private zsets = new Map<string, Map<string, number>>();
  private strings = new Map<string, string>();

  setStringValue(key: string, value: string): void {
    this.strings.set(key, value);
  }

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
      if (this.strings.delete(key)) removed += 1;
    }
    return removed;
  }

  async *scanIterator(options: { MATCH: string }): AsyncGenerator<string> {
    const escaped = options.MATCH.replace(/[.+^${}()|[\]\\]/gu, '\\$&');
    const pattern = new RegExp(`^${escaped.replaceAll('*', '.*').replaceAll('?', '.')}$`, 'u');
    for (const key of [...this.strings.keys(), ...this.zsets.keys()]) {
      if (pattern.test(key)) yield key;
    }
  }

  membersInRankOrder(key: string): string[] {
    const zset = this.zsets.get(key);
    if (!zset) return [];
    return [...zset.entries()]
      .sort((left, right) => (left[1] - right[1]) || left[0].localeCompare(right[0]))
      .map(([member]) => member);
  }

  stringValue(key: string): string | undefined {
    return this.strings.get(key);
  }

  zsetKeys(): string[] {
    return [...this.zsets.keys()];
  }

  async sendCommand(args: string[]): Promise<unknown> {
    this.onCommand?.(args);
    const [command, key, ...rest] = args;
    switch (command) {
      case 'GET':
        return this.strings.get(key) ?? null;
      case 'INCR': {
        if (this.failNextIncr) {
          this.failNextIncr = false;
          throw new Error('fake INCR failure');
        }
        const next = Number(this.strings.get(key) ?? '0') + 1;
        this.strings.set(key, String(next));
        return next;
      }
      case 'PEXPIRE':
        return this.zsets.has(key) || this.strings.has(key) ? 1 : 0;
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

const SCOPE = 'fixture-companion';

function makeCache(client: FakeRedisClient, maxEntriesPerChannel: number, scope = SCOPE) {
  return new RedisSessionTailCache({ client, maxEntriesPerChannel, scope });
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

function messageRow(id: number, content?: string): SessionTailRow {
  return { kind: 'message', entry: makeEntry(id, content) };
}

function tailIds(rows: readonly SessionTailRow[]): number[] {
  return rows.map(row => (row.kind === 'message' ? row.entry.id : row.id));
}

describe('RedisSessionTailCache (psfn-framework-hgw3.5)', () => {
  it('rejects a non-positive bound at construction', () => {
    const client = new FakeRedisClient();
    expect(() => makeCache(client, 0)).toThrow(/positive integer/);
  });

  it('rejects a missing scope at construction (companion identity is required)', () => {
    const client = new FakeRedisClient();
    expect(() => makeCache(client, 4, '')).toThrow(/scope/);
    expect(() => makeCache(client, 4, '   ')).toThrow(/scope/);
  });

  it('appends through, connects lazily, and trims to the bound', async () => {
    const client = new FakeRedisClient();
    const cache = makeCache(client, 3);

    for (let id = 1; id <= 5; id += 1) {
      await cache.appendRow('ch-1', await cache.getEpoch('ch-1'), messageRow(id));
    }

    expect(client.connectCount).toBe(1);
    const tail = await cache.getTail('ch-1');
    expect(tailIds(tail)).toEqual([3, 4, 5]);
    expect(tail[0]).toEqual(messageRow(3));
  });

  it('keys one ZSET per scope, channel, and epoch under the documented prefixes', async () => {
    const client = new FakeRedisClient();
    const cache = makeCache(client, 8);

    await cache.appendRow('ch-a', await cache.getEpoch('ch-a'), messageRow(1));
    await cache.appendRow('ch-b', await cache.getEpoch('ch-b'), messageRow(1));

    expect(client.membersInRankOrder(`${SESSION_TAIL_KEY_PREFIX}${SCOPE}:ch-a:e0`)).toHaveLength(1);
    expect(client.membersInRankOrder(`${SESSION_TAIL_KEY_PREFIX}${SCOPE}:ch-b:e0`)).toHaveLength(1);
    expect(tailIds(await cache.getTail('ch-a'))).toEqual([1]);
  });

  it('isolates two scopes sharing one Redis and the same channel id', async () => {
    const client = new FakeRedisClient();
    const first = makeCache(client, 8, 'companion-one');
    const second = makeCache(client, 8, 'companion-two');

    await first.appendRow('shared-channel', await first.getEpoch('shared-channel'), messageRow(1, 'first scope content'));
    await second.appendRow('shared-channel', await second.getEpoch('shared-channel'), messageRow(1, 'second scope content'));

    const firstTail = await first.getTail('shared-channel');
    const secondTail = await second.getTail('shared-channel');
    expect(firstTail).toHaveLength(1);
    expect(secondTail).toHaveLength(1);
    expect(firstTail[0].kind === 'message' && firstTail[0].entry.content).toBe('first scope content');
    expect(secondTail[0].kind === 'message' && secondTail[0].entry.content).toBe('second scope content');

    // A bump in one scope must not fence the other.
    await first.bumpEpoch('shared-channel');
    expect(await first.getTail('shared-channel')).toEqual([]);
    expect(tailIds(await second.getTail('shared-channel'))).toEqual([1]);
  });

  it('bumpEpoch fences every previously written row away from readers', async () => {
    const client = new FakeRedisClient();
    const cache = makeCache(client, 8);

    await cache.appendRow('ch-1', await cache.getEpoch('ch-1'), messageRow(1));
    await cache.appendRow('ch-1', await cache.getEpoch('ch-1'), messageRow(2));
    expect(tailIds(await cache.getTail('ch-1'))).toEqual([1, 2]);

    const epoch = await cache.bumpEpoch('ch-1');
    expect(epoch).toBe(1);
    expect(client.stringValue(`${SESSION_TAIL_EPOCH_KEY_PREFIX}${SCOPE}:ch-1`)).toBe('1');

    // Epoch-mismatch rejection is structural: the new-epoch key is empty.
    expect(await cache.getTail('ch-1')).toEqual([]);

    // A second reader over the same Redis (fresh cache instance, no shared
    // in-process state) also sees the fence.
    const otherProcess = makeCache(client, 8);
    expect(await otherProcess.getTail('ch-1')).toEqual([]);

    // Writes after the bump land under the new epoch and are readable again.
    await cache.appendRow('ch-1', await cache.getEpoch('ch-1'), messageRow(3));
    expect(tailIds(await otherProcess.getTail('ch-1'))).toEqual([3]);
  });

  it('bumpEpoch throws on INCR failure (fail-closed redaction)', async () => {
    const client = new FakeRedisClient();
    const cache = makeCache(client, 8);
    await cache.appendRow('ch-1', await cache.getEpoch('ch-1'), messageRow(1));

    client.failNextIncr = true;
    await expect(cache.bumpEpoch('ch-1')).rejects.toThrow(/fake INCR failure/);
    // The tail was NOT silently dropped: fencing either happens or fails loudly.
    expect(tailIds(await cache.getTail('ch-1'))).toEqual([1]);
  });

  it('bumpEpoch garbage-collects the previous epoch key', async () => {
    const client = new FakeRedisClient();
    const cache = makeCache(client, 8);
    await cache.appendRow('ch-1', await cache.getEpoch('ch-1'), messageRow(1));
    expect(client.zsetKeys()).toContain(`${SESSION_TAIL_KEY_PREFIX}${SCOPE}:ch-1:e0`);

    await cache.bumpEpoch('ch-1');
    expect(client.zsetKeys()).not.toContain(`${SESSION_TAIL_KEY_PREFIX}${SCOPE}:ch-1:e0`);
  });

  it('returns rows in id order even when appends arrive out of order', async () => {
    const client = new FakeRedisClient();
    const cache = makeCache(client, 8);

    await cache.appendRow('ch-1', await cache.getEpoch('ch-1'), messageRow(7));
    await cache.appendRow('ch-1', await cache.getEpoch('ch-1'), messageRow(5));
    await cache.appendRow('ch-1', await cache.getEpoch('ch-1'), messageRow(6));

    const { messages } = validateSessionTailWindow(await cache.getTail('ch-1'));
    expect(messages.map(entry => entry.id)).toEqual([5, 6, 7]);
  });

  it('replaceTail swaps the window wholesale and applies the bound', async () => {
    const client = new FakeRedisClient();
    const cache = makeCache(client, 2);

    await cache.appendRow('ch-1', await cache.getEpoch('ch-1'), messageRow(1));
    await cache.replaceTail('ch-1', await cache.getEpoch('ch-1'), [messageRow(10), messageRow(11), messageRow(12)]);

    expect(tailIds(await cache.getTail('ch-1'))).toEqual([11, 12]);

    await cache.replaceTail('ch-1', await cache.getEpoch('ch-1'), []);
    expect(await cache.getTail('ch-1')).toEqual([]);
  });

  it('invalidateChannel drops the current-epoch channel tail', async () => {
    const client = new FakeRedisClient();
    const cache = makeCache(client, 4);

    await cache.appendRow('ch-1', await cache.getEpoch('ch-1'), messageRow(1));
    await cache.invalidateChannel('ch-1', await cache.getEpoch('ch-1'));

    expect(await cache.getTail('ch-1')).toEqual([]);
  });

  it('purges only one session tail key family across every epoch', async () => {
    const client = new FakeRedisClient();
    const cache = makeCache(client, 4);
    const otherScope = makeCache(client, 4, 'other-companion');
    const capturedEpoch = await cache.getEpoch('api:testing:purge-me');

    await cache.appendRow('api:testing:purge-me', capturedEpoch, messageRow(1));
    await cache.bumpEpoch('api:testing:purge-me');
    await cache.appendRow('api:testing:purge-me', capturedEpoch, messageRow(2));
    await cache.appendRow(
      'api:testing:purge-me',
      await cache.getEpoch('api:testing:purge-me'),
      messageRow(3),
    );
    await cache.appendRow('api:testing:keep-me', 0, messageRow(4));
    await otherScope.appendRow('api:testing:purge-me', 0, messageRow(5));

    await expect(cache.purgeChannelKeyFamily('api:testing:purge-me')).resolves.toBe(3);

    expect(client.stringValue(
      `${SESSION_TAIL_EPOCH_KEY_PREFIX}${SCOPE}:api:testing:purge-me`,
    )).toBeUndefined();
    expect(client.zsetKeys()).not.toContain(
      `${SESSION_TAIL_KEY_PREFIX}${SCOPE}:api:testing:purge-me:e0`,
    );
    expect(client.zsetKeys()).not.toContain(
      `${SESSION_TAIL_KEY_PREFIX}${SCOPE}:api:testing:purge-me:e1`,
    );
    expect(client.zsetKeys()).toContain(
      `${SESSION_TAIL_KEY_PREFIX}${SCOPE}:api:testing:keep-me:e0`,
    );
    expect(client.zsetKeys()).toContain(
      `${SESSION_TAIL_KEY_PREFIX}other-companion:api:testing:purge-me:e0`,
    );
  });

  it('serializes rows without integrity fields', async () => {
    const client = new FakeRedisClient();
    const cache = makeCache(client, 4);
    const tainted: SessionTailRow = {
      kind: 'message',
      entry: {
        ...makeEntry(1),
        _hmac: 'must-not-persist',
        _hmacKeyVersion: 3,
      } as unknown as SessionEntry,
    };

    await cache.appendRow('ch-1', await cache.getEpoch('ch-1'), tainted);

    const [member] = client.membersInRankOrder(`${SESSION_TAIL_KEY_PREFIX}${SCOPE}:ch-1:e0`);
    expect(member).not.toContain('_hmac');
    expect((await cache.getTail('ch-1'))[0]).toEqual(messageRow(1));
  });

  it('getTail treats an epoch change between the range read and the re-read as a miss (TOCTOU)', async () => {
    const client = new FakeRedisClient();
    const cache = makeCache(client, 8);
    await cache.appendRow('ch-1', await cache.getEpoch('ch-1'), messageRow(1));

    // Race injection: a concurrent rewrite fence (epoch bump in another
    // process) lands while this reader is between its first GET and its
    // ZRANGE. The double-read MUST reject the rows it fetched from the
    // superseded epoch and report a miss.
    client.onCommand = (args) => {
      if (args[0] === 'ZRANGE') {
        client.setStringValue(`${SESSION_TAIL_EPOCH_KEY_PREFIX}${SCOPE}:ch-1`, '1');
      }
    };
    expect(await cache.getTail('ch-1')).toEqual([]);

    // With no concurrent bump the same read serves the rows again.
    client.onCommand = null;
    client.setStringValue(`${SESSION_TAIL_EPOCH_KEY_PREFIX}${SCOPE}:ch-1`, '0');
    expect(tailIds(await cache.getTail('ch-1'))).toEqual([1]);
  });

  it('a write carrying a captured (pre-bump) epoch lands under the superseded key, never the new one', async () => {
    const client = new FakeRedisClient();
    const cache = makeCache(client, 8);

    // A writer captures the epoch with its data, then a rewrite fence lands
    // before the write executes (delayed queued write). The write must go to
    // the captured epoch's key — unreadable garbage — not the current one.
    const capturedEpoch = await cache.getEpoch('ch-1');
    await cache.bumpEpoch('ch-1');
    await cache.appendRow('ch-1', capturedEpoch, messageRow(1, 'stale pre-rewrite content'));
    await cache.replaceTail('ch-1', capturedEpoch, [messageRow(2, 'stale repopulation')]);

    expect(await cache.getTail('ch-1')).toEqual([]);
    expect(client.zsetKeys()).not.toContain(`${SESSION_TAIL_KEY_PREFIX}${SCOPE}:ch-1:e1`);

    // A write carrying the CURRENT epoch is readable as usual.
    await cache.appendRow('ch-1', await cache.getEpoch('ch-1'), messageRow(3));
    expect(tailIds(await cache.getTail('ch-1'))).toEqual([3]);
  });

  it('fails closed on corrupt members', async () => {
    const client = new FakeRedisClient();
    const cache = makeCache(client, 4);
    await client.sendCommand(['ZADD', `${SESSION_TAIL_KEY_PREFIX}${SCOPE}:ch-1:e0`, '1', 'not-json']);

    await expect(cache.getTail('ch-1')).rejects.toThrow(/not valid JSON/);
  });
});

describe('session tail row serialization', () => {
  it('round-trips a message row exactly', () => {
    const row = messageRow(42, 'round trip content');
    expect(deserializeSessionTailRow(serializeSessionTailRow(row))).toEqual(row);
  });

  it('round-trips an id-gap placeholder row', () => {
    const row: SessionTailRow = { kind: 'id_gap', id: 7 };
    expect(deserializeSessionTailRow(serializeSessionTailRow(row))).toEqual(row);
  });

  it('rejects payloads missing required fields or carrying integrity fields', () => {
    expect(() => deserializeSessionTailRow(JSON.stringify({ id: 1 })))
      .toThrow(/required SessionEntry fields/);
    expect(() => deserializeSessionTailRow(JSON.stringify({
      ...makeEntry(1),
      _hmac: 'sig',
    }))).toThrow(/integrity fields/);
    expect(() => deserializeSessionTailRow(JSON.stringify({ psfnSessionTailGap: true })))
      .toThrow(/valid entry id/);
  });

  it('validateSessionTailWindow sorts ascending and fails closed on duplicate ids', () => {
    const { messages } = validateSessionTailWindow([messageRow(3), { kind: 'id_gap', id: 2 }, messageRow(1)]);
    expect(messages.map(entry => entry.id)).toEqual([1, 3]);
    expect(() => validateSessionTailWindow([
      messageRow(2),
      messageRow(2, 'other'),
    ])).toThrow(/duplicate entry id 2/);
  });

  it('validateSessionTailWindow fails closed on a non-contiguous window', () => {
    expect(() => validateSessionTailWindow([messageRow(1), messageRow(3)]))
      .toThrow(/id gap between 1 and 3/);
    // An explicit placeholder makes the same window valid.
    const { messages, maxRowId } = validateSessionTailWindow([
      messageRow(1),
      { kind: 'id_gap', id: 2 },
      messageRow(3),
    ]);
    expect(messages.map(entry => entry.id)).toEqual([1, 3]);
    expect(maxRowId).toBe(3);
  });
});
