import { createHash } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FleetAuthorizationDeniedError } from './fleet-authorization-context.js';
import type { FleetPortalProjection } from './fleet-portal-projection.js';
import {
  GatewayFleetPortalHttpRoutes,
  renderFleetPortalShell,
} from './fleet-portal-http-routes.js';
import { FLEET_PORTAL_CLIENT_SOURCE } from './fleet-portal-client.js';

const COMPANION_A = '11111111-1111-4111-8111-111111111111';
const COMPANION_B = '22222222-2222-4222-8222-222222222222';
const COMPANION_C = '33333333-3333-4333-8333-333333333333';
const COMPANION_D = '44444444-4444-4444-8444-444444444444';
const SESSION_TOKEN = 'S'.repeat(43);

function projection(
  companions: FleetPortalProjection['companions'] = [],
): FleetPortalProjection {
  return {
    schemaVersion: 1,
    generatedAt: '2026-07-16T20:00:00.000Z',
    session: { state: 'authenticated' },
    companions,
  };
}

function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  return once(server, 'listening').then(() => {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind TCP');
    return address.port;
  });
}

function request(
  port: number,
  method: string,
  path: string,
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({ hostname: '127.0.0.1', port, method, path }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    outgoing.once('error', reject);
    outgoing.end();
  });
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new Error('test response was not valid JSON');
  }
}

describe('authenticated fleet portal HTTP routes', () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
      server.close(() => resolve());
    })));
  });

  async function start(
    resolve: () => Promise<FleetPortalProjection>,
  ): Promise<{ port: number; resolve: ReturnType<typeof vi.fn> }> {
    const resolver = vi.fn(resolve);
    const routes = new GatewayFleetPortalHttpRoutes({ projection: { resolve: resolver } });
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
    return { port: await listen(server), resolve: resolver };
  }

  it('serves a projection containing only canonical same-origin Garden links', async () => {
    const value = projection([
      {
        companionId: COMPANION_A,
        availability: 'online',
        headless: false,
        gardenPath: `/companions/${COMPANION_A}/garden`,
      },
      {
        companionId: COMPANION_B,
        availability: 'offline',
        headless: false,
        gardenPath: `/companions/${COMPANION_B}/garden`,
      },
      { companionId: COMPANION_C, availability: 'degraded', headless: true },
      { companionId: COMPANION_D, availability: 'unknown', headless: false },
    ]);
    const harness = await start(async () => value);

    const api = await request(harness.port, 'GET', '/v1/fleet/portal');
    expect(api.status).toBe(200);
    expect(parseJson(api.body)).toEqual(value);
    expect(api.headers).toMatchObject({
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      'cross-origin-resource-policy': 'same-origin',
      'referrer-policy': 'no-referrer',
      vary: 'Cookie',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
    });
    expect(api.headers['access-control-allow-origin']).toBeUndefined();

    const page = await request(harness.port, 'GET', '/fleet');
    expect(page.status).toBe(200);
    expect(page.body).toContain(`href="/companions/${COMPANION_A}/garden"`);
    expect(page.body).not.toContain(`href="/companions/${COMPANION_B}/garden"`);
    expect(page.body).toContain('Offline');
    expect(page.body).toContain('Garden is offline');
    expect(page.body).toContain('Headless companion');
    expect(page.body).toContain('Garden access unavailable');
    expect(page.body).toContain('Some companions are unavailable.');
    expect(page.body).toContain('aria-disabled="true"');
    expect(page.headers).toMatchObject({
      'cache-control': 'no-store',
      'content-type': 'text/html; charset=utf-8',
      'cross-origin-resource-policy': 'same-origin',
      'referrer-policy': 'no-referrer',
      vary: 'Cookie',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
    });
    const scriptHash = createHash('sha256').update(FLEET_PORTAL_CLIENT_SOURCE).digest('base64');
    expect(page.headers['content-security-policy']).toContain(`script-src 'sha256-${scriptHash}'`);
    expect(harness.resolve).toHaveBeenCalledTimes(2);
    expect(harness.resolve).toHaveBeenNthCalledWith(1, { sessionToken: SESSION_TOKEN });
  });

  it('renders loading, denied, empty, unavailable, and action-disabled states accessibly', () => {
    const loading = renderFleetPortalShell({ state: 'loading' }).toString('utf8');
    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain('Loading companion access');

    const denied = renderFleetPortalShell({ state: 'denied' }).toString('utf8');
    expect(denied).toContain('Access unavailable');
    expect(denied).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/u);

    const empty = renderFleetPortalShell({ state: 'ready', projection: projection() }).toString('utf8');
    expect(empty).toContain('No companions are available for this account.');

    const unavailable = renderFleetPortalShell({ state: 'unavailable' }).toString('utf8');
    expect(unavailable).toContain('Fleet status is temporarily unavailable.');
    expect(unavailable).toContain('You can still sign out.');
    expect(unavailable).toContain('id="fleet-logout"');
  });

  it('collapses pending, tombstoned, unknown, and no-role authorization denial bytes', async () => {
    let reason: ConstructorParameters<typeof FleetAuthorizationDeniedError>[0] = 'principal_not_active';
    const harness = await start(async () => { throw new FleetAuthorizationDeniedError(reason); });
    const pending = await request(harness.port, 'GET', '/v1/fleet/portal');
    reason = 'role_absent';
    const noRole = await request(harness.port, 'GET', '/v1/fleet/portal');
    reason = 'principal_tombstoned';
    const tombstoned = await request(harness.port, 'GET', '/v1/fleet/portal');

    expect(pending.status).toBe(403);
    expect(noRole.status).toBe(403);
    expect(tombstoned.status).toBe(403);
    expect(pending.body).toBe(noRole.body);
    expect(noRole.body).toBe(tombstoned.body);
    expect(pending.body).not.toMatch(/pending|role|revoked|principal/u);

    const page = await request(harness.port, 'GET', '/fleet');
    expect(page.status).toBe(403);
    expect(page.body).toContain('Access unavailable');
  });

  it('redirects expired shell sessions and returns an indistinguishable API reauthentication state', async () => {
    const harness = await start(async () => {
      throw new FleetAuthorizationDeniedError('session_expired');
    });
    const api = await request(harness.port, 'GET', '/v1/fleet/portal');
    expect(api.status).toBe(401);
    expect(api.body).toBe('{"error":{"type":"fleet_portal_denied"}}');

    const page = await request(harness.port, 'GET', '/fleet');
    expect(page.status).toBe(303);
    expect(page.headers.location).toBe('/fleet/login');
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.headers.vary).toBe('Cookie');
  });

  it('keeps projection outages bounded while leaving the independent logout flow in the shell', async () => {
    const harness = await start(async () => { throw new Error('private database outage'); });
    const api = await request(harness.port, 'GET', '/v1/fleet/portal');
    expect(api.status).toBe(503);
    expect(api.body).toBe('{"error":{"type":"fleet_portal_unavailable"}}');
    expect(api.body).not.toContain('private database outage');

    const page = await request(harness.port, 'GET', '/fleet');
    expect(page.status).toBe(503);
    expect(page.body).toContain('Fleet status is temporarily unavailable.');
    expect(FLEET_PORTAL_CLIENT_SOURCE).toContain('/v1/fleet-auth/session/csrf');
    expect(FLEET_PORTAL_CLIENT_SOURCE).toContain('/v1/fleet/portal');
    expect(FLEET_PORTAL_CLIENT_SOURCE).toContain('/v1/fleet-auth/logout');
    expect(FLEET_PORTAL_CLIENT_SOURCE).toContain('AbortSignal.timeout');
    expect(FLEET_PORTAL_CLIENT_SOURCE).not.toMatch(/localStorage|sessionStorage|return_to/u);
  });

  it('maps a fail-closed authorization-store denial to the same bounded outage state', async () => {
    const harness = await start(async () => {
      throw new FleetAuthorizationDeniedError('authorization_store_error');
    });
    const api = await request(harness.port, 'GET', '/v1/fleet/portal');
    expect(api.status).toBe(503);
    expect(api.body).toBe('{"error":{"type":"fleet_portal_unavailable"}}');
    const page = await request(harness.port, 'GET', '/fleet');
    expect(page.status).toBe(503);
    expect(page.body).toContain('Fleet status is temporarily unavailable.');
  });

  it('rejects aliases, queries, unsafe compiler output, and every portal mutation method', async () => {
    const unsafe = projection([{
      companionId: COMPANION_A,
      availability: 'online',
      headless: false,
      gardenPath: 'https://private.example.test:3211/token',
    }]);
    const harness = await start(async () => unsafe);

    for (const [method, path] of [
      ['POST', '/v1/fleet/portal'],
      ['PUT', '/v1/fleet/portal'],
      ['PATCH', '/v1/fleet/portal'],
      ['DELETE', '/v1/fleet/portal'],
      ['GET', '/v1/fleet/portal?companionId=anything'],
      ['GET', '/v1/fleet/portal/'],
      ['POST', '/fleet'],
    ]) {
      const denied = await request(harness.port, method, path);
      expect(denied.status).toBe(404);
    }
    expect(harness.resolve).not.toHaveBeenCalled();

    const failClosed = await request(harness.port, 'GET', '/fleet');
    expect(failClosed.status).toBe(503);
    expect(failClosed.body).not.toContain('private.example.test');
    expect(failClosed.body).not.toContain('3211');
  });
});
