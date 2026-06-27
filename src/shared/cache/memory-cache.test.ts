import { describe, expect, it } from 'vitest';
import { createMemoryAppCache } from './memory-cache.js';

describe('MemoryAppCache', () => {
  it('tracks hit and miss counters', async () => {
    const cache = createMemoryAppCache();

    await expect(cache.get('missing')).resolves.toBeNull();
    await cache.set('prompt:one', 'value');
    await expect(cache.get('prompt:one')).resolves.toBe('value');

    expect(cache.getStats()).toMatchObject({
      hits: 1,
      misses: 1,
      sets: 1,
    });
  });

  it('expires entries by ttl', async () => {
    let now = 1000;
    const cache = createMemoryAppCache({ nowMs: () => now });

    await cache.set('prompt:ttl', 'value', { ttlMs: 50 });
    await expect(cache.get('prompt:ttl')).resolves.toBe('value');

    now = 1051;
    await expect(cache.get('prompt:ttl')).resolves.toBeNull();
    expect(cache.getStats()).toMatchObject({
      hits: 1,
      misses: 1,
    });
  });

  it('invalidates matching prefixes only', async () => {
    const cache = createMemoryAppCache();
    await cache.set('prompt:a', 'one');
    await cache.set('prompt:b', 'two');
    await cache.set('other:a', 'three');

    await expect(cache.invalidatePrefix('prompt:')).resolves.toBe(2);
    await expect(cache.get('prompt:a')).resolves.toBeNull();
    await expect(cache.get('prompt:b')).resolves.toBeNull();
    await expect(cache.get('other:a')).resolves.toBe('three');

    expect(cache.getStats()).toMatchObject({
      invalidations: 1,
      deletes: 2,
    });
  });
});
