import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  fetchFleetCardDetails,
  fetchFleetPortalProjection,
  parseFleetPortalProjection,
  resolveFleetCardHealth,
  selectFirstReferenceAvatar,
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
      schemaVersion: 2,
      generatedAt: '2026-07-18T12:00:00.000Z',
      session: { state: 'authenticated' },
      companions: [{
        companionId: COMPANION_A,
        displayName: 'Canopy',
        health: { agentRpc: 'up', adminTransport: 'unknown', channels: 'up' },
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
        schemaVersion: 2,
        generatedAt: '2026-07-18T12:00:00.000Z',
        session: { state: 'authenticated' },
        companions: [{
          companionId: COMPANION_A,
          displayName: 'Canopy',
          health: { agentRpc: 'up', adminTransport: 'unknown', channels: 'up' },
          posture: { status: 'unavailable' },
          gardenPath: `/companions/${COMPANION_A}/garden`,
          ...widened,
        }],
      })).toThrow(/widened/u);
    }
  });

  it('rejects non-canonical, colliding, and oversized rosters', () => {
    const base = {
      schemaVersion: 2,
      generatedAt: '2026-07-18T12:00:00.000Z',
      session: { state: 'authenticated' },
    };
    expect(() => parseFleetPortalProjection({
      ...base,
      companions: [{
        companionId: COMPANION_A,
        displayName: 'Canopy',
        health: { agentRpc: 'up', adminTransport: 'unknown', channels: 'up' },
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
          health: { agentRpc: 'up', adminTransport: 'unknown', channels: 'up' },
          posture: { status: 'unavailable' },
        },
        {
          companionId: COMPANION_A,
          displayName: 'Duplicate',
          health: { agentRpc: 'down', adminTransport: 'unknown', channels: 'unknown' },
          posture: { status: 'unavailable' },
        },
      ],
    })).toThrow(/invalid companion/u);
  });

  it('accepts stale/unavailable posture and rejects widened or uncapped metrics', () => {
    const base = {
      schemaVersion: 2,
      generatedAt: '2026-07-18T12:00:00.000Z',
      session: { state: 'authenticated' },
    };
    expect(parseFleetPortalProjection({
      ...base,
      companions: [{
        companionId: COMPANION_A,
        displayName: 'Canopy',
        health: { agentRpc: 'up', adminTransport: 'unknown', channels: 'down' },
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
        health: { agentRpc: 'up', adminTransport: 'unknown', channels: 'up' },
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
      schemaVersion: 2,
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

  it('canonicalizes a nonstandard fetch rejection from a canceled fleet probe', async () => {
    const location = { assign: vi.fn() };
    vi.stubGlobal('window', { location });
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise<Response>(
      (_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('signal aborted without reason', 'NetworkError'));
        });
      },
    )));

    const request = fetchFleetPortalProjection(controller.signal);
    controller.abort();

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

  it('keeps agent, admin transport, and channels independent and fail-closed', () => {
    const companion = parseFleetPortalProjection({
      schemaVersion: 2,
      generatedAt: '2026-07-18T12:00:00.000Z',
      session: { state: 'authenticated' },
      companions: [{
        companionId: COMPANION_A,
        displayName: 'Canopy',
        health: { agentRpc: 'up', adminTransport: 'unknown', channels: 'up' },
        posture: { status: 'unavailable' },
        gardenPath: `/companions/${COMPANION_A}/garden`,
      }],
    }).companions[0]!;

    expect(resolveFleetCardHealth(companion, { adminTransport: 'down' })).toEqual({
      agentRpc: 'up',
      adminTransport: 'down',
      channels: 'up',
    });
    expect(resolveFleetCardHealth({
      ...companion,
      health: { agentRpc: 'unknown', adminTransport: 'unknown', channels: 'unknown' },
    })).toEqual({
      agentRpc: 'unknown',
      adminTransport: 'unknown',
      channels: 'unknown',
    });
  });

  it('selects the first reference image and falls back when none exists', () => {
    const gardenPath = `/companions/${COMPANION_A}/garden`;
    expect(selectFirstReferenceAvatar([
      { id: 'first reference' },
      { id: 'second-reference' },
    ], gardenPath)).toBe(
      `${gardenPath}/api/admin/image-references/first%20reference/blob`,
    );
    expect(selectFirstReferenceAvatar([], gardenPath)).toBeUndefined();
  });

  it('uses authorized reference-image routes for avatar and admin health', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      references: [{ id: 'ref-1' }, { id: 'ref-2' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const companion = {
      companionId: COMPANION_A,
      displayName: 'Canopy',
      health: {
        agentRpc: 'up' as const,
        adminTransport: 'unknown' as const,
        channels: 'up' as const,
      },
      posture: { status: 'unavailable' as const },
      gardenPath: `/companions/${COMPANION_A}/garden`,
    };

    await expect(fetchFleetCardDetails(companion)).resolves.toEqual({
      adminTransport: 'up',
      avatarUrl: `${companion.gardenPath}/api/admin/image-references/ref-1/blob`,
    });
    expect(fetch).toHaveBeenCalledWith(
      `${companion.gardenPath}/api/admin/image-references`,
      expect.objectContaining({ credentials: 'include', cache: 'no-store' }),
    );

    for (const status of [502, 503, 504]) {
      vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status }));
      await expect(fetchFleetCardDetails(companion)).resolves.toEqual({
        adminTransport: 'down',
      });
    }
  });

  it('degrades a malformed successful admin response without failing the fleet view', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>proxy response</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })));
    const companion = {
      companionId: COMPANION_A,
      displayName: 'Canopy',
      health: {
        agentRpc: 'up' as const,
        adminTransport: 'unknown' as const,
        channels: 'up' as const,
      },
      posture: { status: 'unavailable' as const },
      gardenPath: `/companions/${COMPANION_A}/garden`,
    };

    await expect(fetchFleetCardDetails(companion)).resolves.toEqual({
      adminTransport: 'unknown',
    });
  });

  it('hosts fleet usage and cost rendering with explicit loading and unavailable states', () => {
    const fleetPage = readFileSync(
      new URL('../../routes/fleet/+page.svelte', import.meta.url),
      'utf8',
    );
    const usagePanel = readFileSync(
      new URL('../components/fleet/FleetCostUsage.svelte', import.meta.url),
      'utf8',
    );
    const usageSummary = readFileSync(
      new URL('../components/fleet/FleetUsageSummary.svelte', import.meta.url),
      'utf8',
    );
    const costResults = readFileSync(
      new URL('../components/fleet/FleetCostResults.svelte', import.meta.url),
      'utf8',
    );
    const legacyCostRoute = readFileSync(
      new URL('../../routes/fleet-costs/LazyPageContent.svelte', import.meta.url),
      'utf8',
    );
    expect(fleetPage).toContain('<FleetCostUsage mode="fleet" {projection} />');
    expect(fleetPage).toContain('<FleetUsageSummary {companionNames} />');
    expect(fleetPage.indexOf('<FleetUsageSummary {companionNames} />'))
      .toBeLessThan(fleetPage.indexOf('{#if loading}'));
    for (const required of [
      'getAuthorizedFleetModelUsage(requireAuthorizedGardenPath(), query)',
      'Private usage contributes to fleet',
    ]) {
      expect(usagePanel).toContain(required);
    }
    expect(costResults).toContain('Fleet costs unavailable');
    expect(costResults).toContain('privacy-preserving headline total');
    for (const required of [
      'Loading authorized fleet usage…',
      'Fleet usage unavailable',
      'fetchFleetModelUsageProjection({',
      "range: 'today'",
      'projection.combined.totalTokens',
      'companion.usage.inputTokens',
      'companion.usage.cacheWriteTokens',
    ]) {
      expect(usageSummary).toContain(required);
    }
    expect(legacyCostRoute).toContain('href="/fleet#fleet-costs"');
    expect(legacyCostRoute).toContain('Fleet costs moved');
  });
});
