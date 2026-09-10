import { describe, expect, it } from 'vitest';
import { WorldPlaneMapCache } from './world-plane-map.js';

const MAP = {
  world: 'commons',
  placeId: 'eidoverse:commons',
  places: [{ placeId: 'eidoverse:commons' }, { placeId: 'eidoverse:commons:plaza', region: 'plaza' }],
  terrain: { sizeM: 400 },
  tools: [{ name: 'look', description: 'Look around.' }, { name: 'walk_to' }],
  capturedAt: '2026-09-10T18:00:00.000Z',
};

describe('WorldPlaneMapCache (gs899, g8xyn)', () => {
  it('remembers a published map per world, finds hub places, and folds the room from a perception', () => {
    const cache = new WorldPlaneMapCache();
    expect(cache.remember(MAP)?.tools.map((tool) => tool.name)).toEqual(['look', 'walk_to']);
    expect(cache.findPlace('eidoverse:commons:plaza')).toEqual({ world: 'commons', placeId: 'eidoverse:commons:plaza', region: 'plaza' });
    expect(cache.findPlace('eidoverse:nowhere')).toBeUndefined();

    cache.rememberRoom('commons', { label: 'kitchen', labelled: true, waysOut: [], sealed: false }, '2026-09-10T18:01:00.000Z');
    expect(cache.get('commons')?.room?.label).toBe('kitchen');
    expect(cache.get('commons')?.places).toHaveLength(2);
    // Open ground clears the room without losing the map.
    cache.rememberRoom('commons', undefined, '2026-09-10T18:02:00.000Z');
    expect(cache.get('commons')?.room).toBeUndefined();
    expect(cache.get('commons')?.tools).toHaveLength(2);
  });

  it('forgets a stale map after the ttl and refuses a malformed world name', () => {
    let now = 1_000;
    const cache = new WorldPlaneMapCache({ ttlMs: 500, now: () => now });
    cache.remember(MAP);
    now = 1_400;
    expect(cache.get('commons')).toBeDefined();
    now = 1_600;
    expect(cache.get('commons')).toBeUndefined();
    expect(cache.remember({ ...MAP, world: 'Not A World' })).toBeUndefined();
  });
});
