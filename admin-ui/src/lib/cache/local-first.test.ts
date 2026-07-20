import { describe, expect, it, vi } from 'vitest';
import { isRecord } from '../../../../src/shared/utils/types.js';
import {
  LocalFirstResource,
  type ConditionalFetchRequest,
  type ConditionalFetchResponse,
  type GardenCacheStorage,
} from './local-first';

interface TestSnapshot {
  items: Array<{ id: string; updatedAt: number }>;
}

class MemoryGardenCacheStorage implements GardenCacheStorage {
  private readonly values = new Map<string, unknown>();

  async read(key: string): Promise<unknown> {
    return this.values.get(key);
  }

  async write(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  async remove(key: string): Promise<void> {
    this.values.delete(key);
  }
}

function isTestSnapshot(value: unknown): value is TestSnapshot {
  return isRecord(value)
    && Array.isArray(value.items)
    && value.items.every(item => (
      isRecord(item)
      && typeof item.id === 'string'
      && typeof item.updatedAt === 'number'
      && Number.isFinite(item.updatedAt)
    ));
}

function dataResponse(data: TestSnapshot, etag: string): ConditionalFetchResponse {
  return { kind: 'data', data, etag };
}

describe('LocalFirstResource', () => {
  it('persists a snapshot and renders it before repeat-navigation revalidation finishes', async () => {
    const storage = new MemoryGardenCacheStorage();
    const initial = { items: [{ id: 'cached', updatedAt: 1 }] };
    const fresh = { items: [{ id: 'fresh', updatedAt: 2 }] };
    const seed = new LocalFirstResource({
      key: 'queue:test',
      storage,
      validate: isTestSnapshot,
      fetch: async () => dataResponse(initial, '"v1"'),
    });
    await seed.revalidate();

    let resolveFetch: ((response: ConditionalFetchResponse) => void) | undefined;
    const resource = new LocalFirstResource({
      key: 'queue:test',
      storage,
      validate: isTestSnapshot,
      fetch: () => new Promise(resolve => {
        resolveFetch = resolve;
      }),
    });
    const observed: Array<{ data: TestSnapshot; source: string }> = [];
    const loading = resource.load((data, source) => observed.push({ data, source }));

    await Promise.resolve();
    await Promise.resolve();
    expect(observed).toEqual([{ data: initial, source: 'cache' }]);

    if (!resolveFetch) throw new Error('Revalidation did not start');
    resolveFetch(dataResponse(fresh, '"v2"'));
    await loading;
    expect(observed).toEqual([
      { data: initial, source: 'cache' },
      { data: fresh, source: 'network' },
    ]);

    const reloaded = new LocalFirstResource({
      key: 'queue:test',
      storage,
      validate: isTestSnapshot,
      fetch: async () => ({ kind: 'not_modified', etag: '"v2"' }),
    });
    await expect(reloaded.read()).resolves.toMatchObject({ data: fresh, etag: '"v2"' });
  });

  it('sends the stored ETag and keeps the cached body on an unchanged response', async () => {
    const storage = new MemoryGardenCacheStorage();
    const initial = { items: [{ id: 'same', updatedAt: 1 }] };
    const requests: ConditionalFetchRequest[] = [];
    const resource = new LocalFirstResource({
      key: 'queue:test',
      storage,
      validate: isTestSnapshot,
      fetch: async (request) => {
        requests.push(request);
        return requests.length === 1
          ? dataResponse(initial, '"same"')
          : { kind: 'not_modified', etag: '"same"' };
      },
    });

    await resource.revalidate();
    const unchanged = await resource.revalidate();

    expect(requests[1]).toEqual({ etag: '"same"', forceFull: false });
    expect(unchanged).toMatchObject({ data: initial, source: 'not_modified' });
  });

  it('performs an explicit unconditioned full refetch when the merge cursor is stale', async () => {
    const storage = new MemoryGardenCacheStorage();
    const initial = { items: [{ id: 'old', updatedAt: 1 }] };
    const changed = { items: [{ id: 'changed', updatedAt: 2 }] };
    const full = { items: [{ id: 'full', updatedAt: 3 }] };
    const requests: ConditionalFetchRequest[] = [];
    const fetch = vi.fn(async (request: ConditionalFetchRequest): Promise<ConditionalFetchResponse> => {
      requests.push(request);
      if (requests.length === 1) return dataResponse(initial, '"v1"');
      if (request.forceFull) return dataResponse(full, '"v3"');
      return dataResponse(changed, '"v2"');
    });
    const resource = new LocalFirstResource({
      key: 'transcript:test',
      storage,
      validate: isTestSnapshot,
      cursor: data => data.items.at(-1)?.id ?? null,
      merge: () => ({ kind: 'stale_cursor' }),
      fetch,
    });

    await resource.revalidate();
    const result = await resource.revalidate();

    expect(requests[1]).toEqual({ cursor: 'old', etag: '"v1"', forceFull: false });
    expect(requests[2]).toEqual({ forceFull: true });
    expect(result).toMatchObject({ data: full, source: 'full_refetch' });
  });

  it('rejects and removes malformed persisted records instead of rendering them', async () => {
    const storage = new MemoryGardenCacheStorage();
    await storage.write('companion:single-companion:queue:test', {
      schemaVersion: 1,
      savedAt: Date.now(),
      etag: '"bad"',
      data: { items: [{ id: 42 }] },
    });
    const resource = new LocalFirstResource({
      key: 'queue:test',
      storage,
      validate: isTestSnapshot,
      fetch: async () => dataResponse({ items: [] }, '"empty"'),
    });

    await expect(resource.read()).resolves.toBeNull();
    await expect(storage.read('companion:single-companion:queue:test'))
      .resolves.toBeUndefined();
  });
});
