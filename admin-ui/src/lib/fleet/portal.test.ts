import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  fetchFleetPortalProjection,
  parseFleetPortalProjection,
} from './portal';
import { isAbortError } from '../api/abort';

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
        posture: {
          status: 'available',
          updatedAt: '2026-07-18T11:59:00.000Z',
          charge: { state: 'pressured', utilizationPercent: 25 },
          fatigue: { state: 'clear', utilizationPercent: 0 },
        },
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
          posture: { status: 'unavailable' },
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
        posture: { status: 'unavailable' },
        gardenPath: `/companions/${COMPANION_B}/garden`,
      }],
    })).toThrow(/invalid companion/u);
    expect(() => parseFleetPortalProjection({
      ...base,
      companions: [
        {
          companionId: COMPANION_A,
          displayName: 'Canopy',
          availability: 'online',
          posture: { status: 'unavailable' },
        },
        {
          companionId: COMPANION_A,
          displayName: 'Duplicate',
          availability: 'offline',
          posture: { status: 'unavailable' },
        },
      ],
    })).toThrow(/invalid companion/u);
  });

  it('accepts stale/unavailable posture and rejects widened or uncapped metrics', () => {
    const base = {
      schemaVersion: 1,
      generatedAt: '2026-07-18T12:00:00.000Z',
      session: { state: 'authenticated' },
    };
    expect(parseFleetPortalProjection({
      ...base,
      companions: [{
        companionId: COMPANION_A,
        displayName: 'Canopy',
        availability: 'degraded',
        posture: {
          status: 'stale',
          updatedAt: '2026-07-18T11:00:00.000Z',
          charge: { state: 'exhausted', utilizationPercent: 100 },
          fatigue: { state: 'pressured', utilizationPercent: 67 },
        },
      }],
    }).companions[0]?.posture.status).toBe('stale');
    expect(() => parseFleetPortalProjection({
      ...base,
      companions: [{
        companionId: COMPANION_A,
        displayName: 'Canopy',
        availability: 'online',
        posture: {
          status: 'available',
          updatedAt: '2026-07-18T12:00:00.000Z',
          charge: { state: 'pressured', utilizationPercent: 101 },
          fatigue: { state: 'clear', utilizationPercent: 0 },
          rawLedgerEvent: {},
        },
      }],
    })).toThrow(/posture/i);
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

  it('does not redirect when a canceled fleet probe races with a 401', async () => {
    const location = { assign: vi.fn() };
    vi.stubGlobal('window', { location });
    const controller = new AbortController();
    let resolveRequest = (_response: Response) => {};
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => {
      resolveRequest = resolve;
    })));

    const request = fetchFleetPortalProjection(controller.signal);
    controller.abort();
    resolveRequest(new Response('{}', { status: 401 }));

    const error = await request.catch((reason: unknown) => reason);
    expect(isAbortError(error, controller.signal)).toBe(true);
    expect(location.assign).not.toHaveBeenCalled();
  });

  it('redirects only a non-aborted fleet 401 to login', async () => {
    const location = { assign: vi.fn() };
    vi.stubGlobal('window', { location });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })));

    await expect(fetchFleetPortalProjection()).rejects.toThrow('Fleet session expired');
    expect(location.assign).toHaveBeenCalledWith('/fleet/login');
  });

  it('renders charge, fatigue, timestamps, stale state, and honest unavailability', () => {
    const source = readFileSync(new URL('../../routes/fleet/+page.svelte', import.meta.url), 'utf8');
    for (const required of [
      'Posture unavailable',
      'No bounded charge or fatigue report has arrived.',
      'companion.posture.charge.state',
      'companion.posture.charge.utilizationPercent',
      'companion.posture.fatigue.state',
      'companion.posture.fatigue.utilizationPercent',
      "companion.posture.status === 'stale'",
      'new Date(companion.posture.updatedAt).toLocaleString()',
    ]) {
      expect(source).toContain(required);
    }
  });
});
