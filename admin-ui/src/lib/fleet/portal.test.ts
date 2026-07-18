import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchFleetPortalProjection,
  parseFleetPortalProjection,
} from './portal';

const COMPANION_A = '11111111-1111-4111-8111-111111111111';
const COMPANION_B = '22222222-2222-4222-8222-222222222222';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Garden fleet portal client', () => {
  it('accepts only the bounded authorized status contract', () => {
    expect(parseFleetPortalProjection({
      schemaVersion: 1,
      generatedAt: '2026-07-18T12:00:00.000Z',
      session: { state: 'authenticated' },
      companions: [{
        companionId: COMPANION_A,
        displayName: 'Canopy',
        availability: 'online',
        gardenPath: `/companions/${COMPANION_A}/garden`,
      }],
    }).companions).toHaveLength(1);

    for (const widened of [
      { port: 3211 },
      { stateReason: 'private' },
      { lastSeenAt: '2026-07-18T12:00:00.000Z' },
      { recentViolationCount: 1 },
    ]) {
      expect(() => parseFleetPortalProjection({
        schemaVersion: 1,
        generatedAt: '2026-07-18T12:00:00.000Z',
        session: { state: 'authenticated' },
        companions: [{
          companionId: COMPANION_A,
          displayName: 'Canopy',
          availability: 'online',
          gardenPath: `/companions/${COMPANION_A}/garden`,
          ...widened,
        }],
      })).toThrow(/widened/u);
    }
  });

  it('rejects non-canonical, colliding, and oversized rosters', () => {
    const base = {
      schemaVersion: 1,
      generatedAt: '2026-07-18T12:00:00.000Z',
      session: { state: 'authenticated' },
    };
    expect(() => parseFleetPortalProjection({
      ...base,
      companions: [{
        companionId: COMPANION_A,
        displayName: 'Canopy',
        availability: 'online',
        gardenPath: `/companions/${COMPANION_B}/garden`,
      }],
    })).toThrow(/invalid companion/u);
    expect(() => parseFleetPortalProjection({
      ...base,
      companions: [
        { companionId: COMPANION_A, displayName: 'Canopy', availability: 'online' },
        { companionId: COMPANION_A, displayName: 'Duplicate', availability: 'offline' },
      ],
    })).toThrow(/invalid companion/u);
  });

  it('loads the cookie-authenticated no-store fleet projection', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-07-18T12:00:00.000Z',
      session: { state: 'authenticated' },
      companions: [],
    }), { status: 200, headers: { 'content-type': 'application/json' } })));

    await expect(fetchFleetPortalProjection()).resolves.toMatchObject({ companions: [] });
    expect(fetch).toHaveBeenCalledWith('/v1/fleet/portal', expect.objectContaining({
      cache: 'no-store',
      credentials: 'include',
    }));
  });
});

