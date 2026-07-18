import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FleetAuthorizationDeniedError } from './fleet-authorization-context.js';
import type { FleetGardenUiAssetsPort } from './fleet-garden-ui-assets.js';
import { GatewayFleetPortalHttpRoutes } from './fleet-portal-http-routes.js';
import type { FleetPortalProjection } from './fleet-portal-projection.js';

const SESSION_TOKEN = 'S'.repeat(43);
const COMPANION_A = '11111111-1111-4111-8111-111111111111';
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});
function projection(): FleetPortalProjection {
  return {
    schemaVersion: 1,
    generatedAt: '2026-07-18T12:00:00.000Z',
    session: { state: 'authenticated' },
    companions: [{
      companionId: COMPANION_A,
      displayName: 'Canopy',
      availability: 'online',
      gardenPath: `/companions/${COMPANION_A}/garden`,
    }],
  };
}

function fakeUi(): FleetGardenUiAssetsPort & {
  servePage: ReturnType<typeof vi.fn>;
  serveAsset: ReturnType<typeof vi.fn>;
} {
  return {
    isEnabled: () => true,
    servePage: vi.fn((_request, response) => {
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/html; charset=utf-8',
      });
      response.end('<!doctype html><title>Garden bundle</title>');
    }),
    serveAsset: vi.fn((_path, _request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/javascript' });
      response.end('export{}');
    }),
  };
}

async function start(
  resolve: () => Promise<FleetPortalProjection>,
  ui = fakeUi(),
): Promise<{ port: number; ui: ReturnType<typeof fakeUi> }> {
  const routes = new GatewayFleetPortalHttpRoutes({ projection: { resolve }, ui });
  const server = createServer((incoming, response) => {
    const target = new URL(incoming.url ?? '/', 'http://portal.test');
    void routes.handle({
      request: incoming,
      response,
      sessionToken: SESSION_TOKEN,
      rawPath: target.pathname,
      rawQuery: target.search.slice(1),
    });
  });
  servers.push(server);
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  return { port: (server.address() as AddressInfo).port, ui };
}

async function request(port: number, path: string): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({ host: '127.0.0.1', port, path }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    outgoing.on('error', reject);
    outgoing.end();
  });
}

describe('gateway fleet portal routes', () => {
  it('serves the same Garden bundle after resolving the live authorized projection', async () => {
    const resolve = vi.fn(async () => projection());
    const harness = await start(resolve);
    const response = await request(harness.port, '/fleet');

    expect(response.status).toBe(200);
    expect(response.body).toContain('Garden bundle');
    expect(response.body).not.toContain(COMPANION_A);
    expect(resolve).toHaveBeenCalledWith({ sessionToken: SESSION_TOKEN });
    expect(harness.ui.servePage).toHaveBeenCalledOnce();
  });

  it('returns only the bounded no-store projection from the JSON route', async () => {
    const harness = await start(async () => projection());
    const response = await request(harness.port, '/v1/fleet/portal');

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual(projection());
    expect(response.headers).toMatchObject({
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      'referrer-policy': 'no-referrer',
      vary: 'Cookie',
    });
  });

  it('serves content-hashed bundle assets without resolving roster data', async () => {
    const resolve = vi.fn(async () => projection());
    const harness = await start(resolve);
    const response = await request(harness.port, '/fleet/_app/immutable/entry/start.js');

    expect(response.status).toBe(200);
    expect(response.body).toBe('export{}');
    expect(resolve).not.toHaveBeenCalled();
    expect(harness.ui.serveAsset).toHaveBeenCalledOnce();
  });

  it('collapses authorization denial and infrastructure failure details', async () => {
    const denied = await start(async () => {
      throw new FleetAuthorizationDeniedError('principal_not_active');
    });
    const deniedResponse = await request(denied.port, '/fleet');
    expect(deniedResponse.status).toBe(403);
    expect(deniedResponse.body).toBe('{"error":{"type":"fleet_portal_denied"}}');

    const unavailable = await start(async () => {
      throw new Error('private database hostname');
    });
    const unavailableResponse = await request(unavailable.port, '/fleet');
    expect(unavailableResponse.status).toBe(503);
    expect(unavailableResponse.body).not.toContain('private database hostname');
  });

  it('redirects stale sessions and rejects aliases, queries, and mutations', async () => {
    const stale = await start(async () => {
      throw new FleetAuthorizationDeniedError('session_expired');
    });
    const redirect = await request(stale.port, '/fleet');
    expect(redirect.status).toBe(303);
    expect(redirect.headers.location).toBe('/fleet/login');

    const harness = await start(async () => projection());
    expect((await request(harness.port, '/fleet?target=anything')).status).toBe(404);
    expect((await request(harness.port, '/v1/fleet/portal/')).status).toBe(404);
  });
});
