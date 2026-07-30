import type { IncomingMessage, ServerResponse } from 'node:http';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAdminPlacesRoutes } from '../api-routes-places.js';
import { checkAdminRequestAuth } from '../server-auth.js';
import { createAdminPlacesService } from './places-service.js';
import { createCompanionId } from '../../../shared/routing/companion-id.js';
import { GatewaySystemDataWriter } from '../../../boundary/gateway/system-data-writer.js';

const ENDPOINT = {
  endpointId: 'ep-1',
  displayName: 'Primary',
  claimTypes: ['voice'],
  promptChannelType: 'voice',
  auth: { mode: 'api_key', apiKeyPrincipalIds: ['principal-1'] },
  defaultIdentity: {
    authorId: 'author-1',
    authorName: 'Resident',
    canonicalContactId: 'contact-1',
    channelPrivacy: 'private',
  },
  maxCapabilities: ['text'],
  telemetryScopes: ['presence'],
};

const COMPANION_A = createCompanionId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
const NO_COMPANIONS = [];

const SATELLITES = {
  schemaVersion: 1,
  enabled: true,
  satellites: [
    {
      satelliteId: 'sat-kitchen',
      displayName: 'Kitchen Hub',
      mobility: 'static',
      placeId: 'place-kitchen',
      sharedDevice: {
        primaryCompanionId: COMPANION_A,
        observationRecipients: [{ companionId: COMPANION_A, scopes: ['presence'] }],
        emanationMemberIds: [COMPANION_A],
        responseLease: { durationMs: 5_000, activeConversationTtlMs: 60_000 },
      },
      endpoints: [ENDPOINT],
    },
    {
      satelliteId: 'sat-roamer',
      displayName: 'Roaming Tablet',
      mobility: 'portable',
      endpoints: [{ ...ENDPOINT, defaultIdentity: { ...ENDPOINT.defaultIdentity, authorId: 'author-2', canonicalContactId: 'contact-2' } }],
    },
  ],
};

const PLACES = {
  schemaVersion: 1,
  sites: [
    { siteId: 'site-home', displayName: 'Home', kind: 'physical' },
    { siteId: 'site-overlay', displayName: 'Home Overlay', kind: 'virtual' },
  ],
  places: [
    {
      placeId: 'place-kitchen',
      siteId: 'site-home',
      displayName: 'Kitchen',
      kind: 'physical',
      affordances: [
        { affordanceId: 'aff-light', role: 'effector', kind: 'light', backend: 'ha', entityId: 'light.kitchen', control: ['on', 'off'] },
        { affordanceId: 'aff-presence', role: 'perceiver', kind: 'presence', backend: 'satellite' },
      ],
    },
    { placeId: 'place-living', siteId: 'site-home', displayName: 'Living Room', kind: 'physical', affordances: [] },
    {
      placeId: 'place-kitchen-overlay',
      siteId: 'site-overlay',
      displayName: 'Kitchen Overlay',
      kind: 'virtual',
      mirrorsPlaceId: 'place-kitchen',
      affordances: [],
    },
  ],
};

let dataDir: string;
let gatewayDataDir: string;

function seedRoot(
  root: string,
  satellites: unknown = SATELLITES,
  places: unknown = PLACES,
): void {
  writeFileSync(join(root, 'satellites.json'), JSON.stringify(satellites), 'utf8');
  writeFileSync(join(root, 'places.json'), JSON.stringify(places), 'utf8');
}

function seed(satellites: unknown = SATELLITES, places: unknown = PLACES): void {
  seedRoot(dataDir, satellites, places);
}

function readSatellites(): {
  satellites: Array<{
    satelliteId: string;
    placeId?: string;
    sharedDevice?: { primaryCompanionId: string };
  }>;
} {
  return JSON.parse(readFileSync(join(dataDir, 'satellites.json'), 'utf8'));
}

function createSystemDataWriter(systemDataDir: string): GatewaySystemDataWriter {
  return new GatewaySystemDataWriter({
    configStore: {
      saveRuntimeSettings: vi.fn(),
      saveModels: vi.fn(),
      saveProviders: vi.fn(),
      saveChannelsOwnerFile: vi.fn(),
      saveTrustPolicy: vi.fn(),
      saveIntakePolicy: vi.fn(),
      savePartnerAffectShadow: vi.fn(),
      saveBackup: vi.fn(),
    },
    systemDataDir,
  });
}

function createPlacesService(
  fleetCompanionIds: readonly typeof COMPANION_A[] = NO_COMPANIONS,
) {
  return createAdminPlacesService({
    dataDir,
    fleetCompanionIds,
    systemDataWriter: createSystemDataWriter(dataDir),
  });
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'psfn-places-'));
  gatewayDataDir = mkdtempSync(join(tmpdir(), 'psfn-places-gateway-'));
});

afterEach(() => {
  chmodSync(dataDir, 0o755);
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(gatewayDataDir, { recursive: true, force: true });
});

class CapturingResponse {
  status = 0;
  headers: Record<string, string> = {};
  body = '';
  writeHead(status: number, headers?: Record<string, string>): this {
    this.status = status;
    this.headers = headers ?? {};
    return this;
  }
  end(body?: string): this {
    this.body = body ?? '';
    return this;
  }
}

function makeRequest(url: string): IncomingMessage {
  return { url, headers: { host: 'localhost' } } as IncomingMessage;
}

const withBody = (_req: IncomingMessage, _res: ServerResponse, cb: (body: string) => void): void => {
  cb((_req as unknown as { _body?: string })._body ?? '');
};

async function invokeRoute(
  routes: ReturnType<typeof buildAdminPlacesRoutes>,
  method: string,
  path: string,
  body?: string,
): Promise<CapturingResponse> {
  const route = routes.find(candidate => candidate.method === method && candidate.match(path));
  const response = new CapturingResponse();
  const params = route?.match(path) ?? {};
  const req = makeRequest(path) as unknown as { _body?: string };
  if (body !== undefined) req._body = body;
  route?.handle(req as unknown as IncomingMessage, response as unknown as ServerResponse, params);
  await new Promise(resolve => setImmediate(resolve));
  return response;
}

describe('AdminPlacesService', () => {
  it('joins places, affordances, and bound satellites', async () => {
    seed();
    const data = await createPlacesService().listPlaces();
    expect(data.places.map(p => p.placeId)).toEqual([
      'place-kitchen',
      'place-living',
      'place-kitchen-overlay',
    ]);
    const kitchen = data.places.find(p => p.placeId === 'place-kitchen')!;
    expect(kitchen.affordances.map(a => a.affordanceId)).toEqual(['aff-light', 'aff-presence']);
    expect(kitchen.satellites.map(s => s.satelliteId)).toEqual(['sat-kitchen']);
    expect(kitchen.twinPlaceId).toBe('place-kitchen-overlay');
    const overlay = data.places.find(p => p.placeId === 'place-kitchen-overlay')!;
    expect(overlay.mirrorsPlaceId).toBe('place-kitchen');
    expect(overlay.twinPlaceId).toBe('place-kitchen');
    expect(data.unboundSatellites.map(s => s.satelliteId)).toEqual(['sat-roamer']);
    expect(data.danglingSatellites).toEqual([]);
  });

  it('degrades to an empty registry when the owner files are absent', async () => {
    const data = await createPlacesService().listPlaces();
    expect(data.sites).toEqual([]);
    expect(data.places).toEqual([]);
    expect(data.unboundSatellites).toEqual([]);
  });

  it('re-binds a satellite to a known place and persists it', async () => {
    seed();
    const service = createPlacesService();
    const result = await service.rebindSatellite({ satelliteId: 'sat-roamer', placeId: 'place-living' });
    expect(result.placeId).toBe('place-living');
    expect(readSatellites().satellites.find(s => s.satelliteId === 'sat-roamer')?.placeId).toBe('place-living');
    const living = result.places.places.find(p => p.placeId === 'place-living')!;
    expect(living.satellites.map(s => s.satelliteId)).toEqual(['sat-roamer']);
    expect(result.places.unboundSatellites).toEqual([]);
  });

  it('unbinds a satellite when placeId is null', async () => {
    seed();
    const service = createPlacesService();
    const result = await service.rebindSatellite({ satelliteId: 'sat-kitchen', placeId: null });
    expect(result.placeId).toBeNull();
    expect(readSatellites().satellites.find(s => s.satelliteId === 'sat-kitchen')?.placeId).toBeUndefined();
    expect(result.places.unboundSatellites.map(s => s.satelliteId)).toContain('sat-kitchen');
  });

  it('fails closed on an unknown placeId and leaves the owner file untouched', async () => {
    seed();
    const before = readFileSync(join(dataDir, 'satellites.json'), 'utf8');
    const service = createPlacesService();
    await expect(service.rebindSatellite({ satelliteId: 'sat-roamer', placeId: 'place-ghost' }))
      .rejects.toThrow(/does not exist in places.json/);
    expect(readFileSync(join(dataDir, 'satellites.json'), 'utf8')).toBe(before);
  });

  it('fails closed on an unknown satellite', async () => {
    seed();
    await expect(createPlacesService()
      .rebindSatellite({ satelliteId: 'sat-nope', placeId: 'place-living' }))
      .rejects.toThrow(/unknown satellite/);
  });

  it('fails closed when re-binding a satellite to a virtual place', async () => {
    seed();
    await expect(createPlacesService()
      .rebindSatellite({ satelliteId: 'sat-roamer', placeId: 'place-kitchen-overlay' }))
      .rejects.toThrow(/must be physical/u);
  });

  it('fails closed with a gateway remedy when the system-data writer is unavailable', async () => {
    seed();
    const service = createAdminPlacesService({
      dataDir,
      fleetCompanionIds: NO_COMPANIONS,
    });

    await expect(service.rebindSatellite({
      satelliteId: 'sat-roamer',
      placeId: 'place-living',
    })).rejects.toThrow(/gateway system-data writer.*system\.data\.write/iu);
    expect(readSatellites().satellites.find(
      satellite => satellite.satelliteId === 'sat-roamer',
    )?.placeId).toBeUndefined();
  });

  it('preserves the governed shared-device policy while changing only placeId', async () => {
    seed();
    const service = createPlacesService([COMPANION_A]);

    await service.rebindSatellite({
      satelliteId: 'sat-kitchen',
      placeId: 'place-living',
    });
    expect(readSatellites().satellites.find(
      satellite => satellite.satelliteId === 'sat-kitchen',
    )?.sharedDevice?.primaryCompanionId).toBe(COMPANION_A);
  });
});

describe('buildAdminPlacesRoutes', () => {
  it('serves GET /api/admin/places', async () => {
    seed();
    const routes = buildAdminPlacesRoutes({
      placesService: createPlacesService(),
      withBody,
    });
    const res = await invokeRoute(routes, 'GET', '/api/admin/places');
    expect(res.status).toBe(200);
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(JSON.parse(res.body).places).toHaveLength(3);
  });

  it('re-binds via PATCH /api/admin/places/satellites/:satelliteId/binding', async () => {
    seed();
    const routes = buildAdminPlacesRoutes({
      placesService: createPlacesService(),
      withBody,
    });
    const res = await invokeRoute(
      routes,
      'PATCH',
      '/api/admin/places/satellites/sat-roamer/binding',
      JSON.stringify({ placeId: 'place-living' }),
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).placeId).toBe('place-living');
  });

  it('re-binds through the gateway when the agent system-data root is read-only', async () => {
    seed();
    seedRoot(gatewayDataDir);
    chmodSync(dataDir, 0o555);
    const systemDataWriter = createSystemDataWriter(gatewayDataDir);
    const routes = buildAdminPlacesRoutes({
      placesService: createAdminPlacesService({
        dataDir,
        fleetCompanionIds: NO_COMPANIONS,
        systemDataWriter,
      }),
      withBody,
    });

    const res = await invokeRoute(
      routes,
      'PATCH',
      '/api/admin/places/satellites/sat-roamer/binding',
      JSON.stringify({ placeId: 'place-living' }),
    );

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      satelliteId: 'sat-roamer',
      placeId: 'place-living',
    });
    expect(JSON.parse(readFileSync(join(gatewayDataDir, 'satellites.json'), 'utf8'))
      .satellites.find((satellite: { satelliteId: string }) => satellite.satelliteId === 'sat-roamer'))
      .toMatchObject({ placeId: 'place-living' });
    expect(readSatellites().satellites.find(
      satellite => satellite.satelliteId === 'sat-roamer',
    )?.placeId).toBeUndefined();
  });

  it('rejects the retired companionId binding field via PATCH', async () => {
    seed();
    const routes = buildAdminPlacesRoutes({
      placesService: createPlacesService([COMPANION_A]),
      withBody,
    });
    const res = await invokeRoute(
      routes,
      'PATCH',
      '/api/admin/places/satellites/sat-roamer/binding',
      JSON.stringify({ companionId: COMPANION_A }),
    );

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/unknown key.*companionId/i);
  });

  it('rejects a PATCH re-bind to an unknown place with 400', async () => {
    seed();
    const routes = buildAdminPlacesRoutes({
      placesService: createPlacesService(),
      withBody,
    });
    const res = await invokeRoute(
      routes,
      'PATCH',
      '/api/admin/places/satellites/sat-roamer/binding',
      JSON.stringify({ placeId: 'place-ghost' }),
    );
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/does not exist/);
  });
});

describe('places surface auth', () => {
  it('rejects an admin request without the operator token', () => {
    const res = new CapturingResponse();
    const req = { url: '/api/admin/places', headers: {} } as IncomingMessage;
    const ok = checkAdminRequestAuth(req, res as unknown as ServerResponse, 'operator-secret');
    expect(ok).toBe(false);
    expect(res.status).toBe(401);
  });

  it('allows an admin request bearing the operator token', () => {
    const res = new CapturingResponse();
    const req = { url: '/api/admin/places', headers: { authorization: 'Bearer operator-secret' } } as IncomingMessage;
    expect(checkAdminRequestAuth(req, res as unknown as ServerResponse, 'operator-secret')).toBe(true);
  });
});
