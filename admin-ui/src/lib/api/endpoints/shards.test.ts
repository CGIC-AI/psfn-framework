import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getShardConfiguration,
  getShardFoldReview,
  listParentShards,
  resolveShardFoldReview,
  updateShardConfiguration,
} from './shards';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parent-scoped shard endpoints', () => {
  it('encodes shard IDs into detail, snapshot, override, and review routes', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await listParentShards();
    await getShardFoldReview('shard a');
    await getShardConfiguration('shard a');
    await updateShardConfiguration('shard a', {
      model: { provider: 'test', model: 'bounded-model' },
      workerBudget: { maxTurns: 2 },
    });
    await resolveShardFoldReview('shard a', 'approve', 'reviewed');

    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit | undefined]>;
    expect(calls.map(([path]) => path)).toEqual([
      '/api/admin/shards',
      '/api/admin/shards/shard%20a',
      '/api/admin/shards/shard%20a/configuration',
      '/api/admin/shards/shard%20a/configuration',
      '/api/admin/shards/shard%20a/review',
    ]);
    expect(calls[3]?.[1]).toMatchObject({
      method: 'PATCH',
      body: JSON.stringify({
        model: { provider: 'test', model: 'bounded-model' },
        workerBudget: { maxTurns: 2 },
      }),
    });
  });
});
