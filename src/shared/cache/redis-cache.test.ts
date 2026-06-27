import { describe, expect, it, vi } from 'vitest';
import {
  RedisAppCache,
  buildRedisClientOptions,
  resolveAppCacheRuntimeConfigFromEnv,
  type RedisClientLike,
} from './redis-cache.js';

function createFakeRedisClient(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const client: RedisClientLike = {
    isOpen: false,
    connect: vi.fn(async () => {
      client.isOpen = true;
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    sendCommand: vi.fn(async (args: string[]) => {
      if (args[0] !== 'SET') throw new Error(`unsupported command: ${args[0]}`);
      store.set(args[1], args[2]);
    }),
    del: vi.fn(async (key: string | string[]) => {
      const keys = Array.isArray(key) ? key : [key];
      let deleted = 0;
      for (const entry of keys) {
        if (store.delete(entry)) deleted += 1;
      }
      return deleted;
    }),
    scanIterator: async function* (options: { MATCH: string }) {
      const prefix = options.MATCH.endsWith('*')
        ? options.MATCH.slice(0, -1)
        : options.MATCH;
      for (const key of store.keys()) {
        if (key.startsWith(prefix)) {
          yield key;
        }
      }
    },
  };
  return { client, store };
}

describe('RedisAppCache', () => {
  it('uses a Redis client seam for hits, misses, ttl writes, and prefix invalidation', async () => {
    const { client, store } = createFakeRedisClient({
      'test:prompt:one': 'value',
      'test:prompt:two': 'value-2',
      'test:other:one': 'other',
    });
    const cache = new RedisAppCache({ client, keyPrefix: 'test:' });

    await expect(cache.get('prompt:one')).resolves.toBe('value');
    await expect(cache.get('missing')).resolves.toBeNull();
    await cache.set('prompt:ttl', 'ttl-value', { ttlMs: 500 });
    await expect(cache.invalidatePrefix('prompt:')).resolves.toBe(3);

    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.sendCommand).toHaveBeenCalledWith(['SET', 'test:prompt:ttl', 'ttl-value', 'PX', '500']);
    expect(store.has('test:prompt:one')).toBe(false);
    expect(store.has('test:other:one')).toBe(true);
    expect(cache.getStats()).toMatchObject({
      hits: 1,
      misses: 1,
      sets: 1,
      invalidations: 1,
      deletes: 3,
    });
  });

  it('requires explicit URL and credentials in Redis mode', () => {
    expect(() => resolveAppCacheRuntimeConfigFromEnv({
      PSFN_APP_CACHE_MODE: 'redis',
    })).toThrow('PSFN_REDIS_URL is required');

    expect(() => resolveAppCacheRuntimeConfigFromEnv({
      PSFN_APP_CACHE_MODE: 'redis',
      PSFN_REDIS_URL: 'redis://redis:6379',
    })).toThrow('PSFN_REDIS_PASSWORD');
  });

  it('rejects malformed Redis URL and TLS settings', () => {
    expect(() => resolveAppCacheRuntimeConfigFromEnv({
      PSFN_APP_CACHE_MODE: 'redis',
      PSFN_REDIS_URL: 'http://redis:6379',
      PSFN_REDIS_PASSWORD: 'secret',
    })).toThrow('redis:// or rediss://');

    expect(() => resolveAppCacheRuntimeConfigFromEnv({
      PSFN_APP_CACHE_MODE: 'redis',
      PSFN_REDIS_URL: 'redis://redis:6379',
      PSFN_REDIS_PASSWORD: 'secret',
      PSFN_REDIS_TLS_CA_CERT_PATH: '/certs/ca.pem',
    })).toThrow('requires a rediss://');

    expect(() => resolveAppCacheRuntimeConfigFromEnv({
      PSFN_APP_CACHE_MODE: 'redis',
      PSFN_REDIS_URL: 'rediss://redis:6379',
      PSFN_REDIS_PASSWORD: 'secret',
      PSFN_REDIS_TLS_REJECT_UNAUTHORIZED: 'sometimes',
    })).toThrow('must be true or false');
  });

  it('builds Redis client options without leaking dedicated credentials into logs', () => {
    const config = resolveAppCacheRuntimeConfigFromEnv({
      PSFN_APP_CACHE_MODE: 'redis',
      PSFN_REDIS_URL: 'rediss://cache.internal:6380',
      PSFN_REDIS_USERNAME: 'app',
      PSFN_REDIS_PASSWORD: 'secret',
      PSFN_REDIS_TLS_CA_CERT_PATH: '/certs/ca.pem',
    });

    expect(config.redis).toBeDefined();
    if (!config.redis) {
      throw new Error('expected Redis config');
    }
    const options = buildRedisClientOptions(config.redis, () => 'CERT');

    expect(options.url).toBe('rediss://app:secret@cache.internal:6380');
    expect(options.socket).toEqual({
      tls: true,
      rejectUnauthorized: true,
      ca: 'CERT',
    });
  });
});
