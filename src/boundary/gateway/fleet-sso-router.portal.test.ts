import { generateKeyPairSync } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createGatewayRequestCapabilitySigner,
  createRequestCapabilityVerifier,
} from '../fleet-auth/request-capability.js';
import { createCompanionId } from '../../shared/routing/companion-id.js';
import { GatewayFleetSsoRouter } from './fleet-sso-router.js';

const COMPANION_ID = createCompanionId('11111111-1111-4111-8111-111111111111');
const SESSION_TOKEN = 'S'.repeat(43);
const CANONICAL_ORIGIN = 'https://fleet.example.test';

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
  path: string,
  options: {
    method?: string;
    session?: string;
    localSession?: string;
    origin?: string;
    accept?: string;
  } = {},
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({
      hostname: '127.0.0.1',
      port,
      method: options.method ?? 'GET',
      path,
      headers: {
        host: 'fleet.example.test',
        'x-forwarded-host': 'fleet.example.test',
        'x-forwarded-proto': 'https',
        'x-forwarded-port': '443',
        'x-forwarded-for': '198.51.100.9',
        ...(options.session ? { cookie: `__Host-psfn_session=${options.session}` } : {}),
        ...(options.localSession
          ? { cookie: `psfn_local_operator_session=${options.localSession}` }
          : {}),
        ...(options.origin ? { origin: options.origin } : {}),
        ...(options.accept ? { accept: options.accept } : {}),
      },
    }, (response) => {
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

describe('unified-origin fleet portal routing', () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
      server.close(() => resolve());
    })));
  });

  async function start(options: {
    breakGlassLogin?: { loginPath: string };
    localOperatorLogin?: { loginPath: string; allowedOrigins: readonly string[] };
  } = {}): Promise<{
    port: number;
    resolveProjection: ReturnType<typeof vi.fn>;
    resolveModelUsageProjection: ReturnType<typeof vi.fn>;
    router: GatewayFleetSsoRouter;
  }> {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const signer = createGatewayRequestCapabilitySigner({
      issuer: 'portal-route-test',
      kid: 'portal-key',
      privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      ttlSeconds: 30,
      nowSeconds: () => 1_783_000_000,
    });
    const verifier = createRequestCapabilityVerifier({
      issuer: 'portal-route-test',
      maxTtlSeconds: 30,
      keys: [{
        issuer: 'portal-route-test',
        kid: 'portal-key',
        publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
        notBefore: '2026-07-16T00:00:00.000Z',
        notAfter: '2026-07-17T00:00:00.000Z',
        status: 'active',
      }],
    });
    const resolveProjection = vi.fn(async () => ({
      schemaVersion: 2 as const,
      generatedAt: '2026-07-16T20:00:00.000Z',
      session: { state: 'authenticated' as const },
      companions: [],
    }));
    const resolveModelUsageProjection = vi.fn(async () => ({
      schemaVersion: 1 as const,
      generatedAt: '2026-07-16T20:00:00.000Z',
      resolvedRange: {
        range: 'today' as const,
        timezone: 'UTC',
        sinceMs: 1_752_710_400_000,
        untilMs: 1_752_796_800_000,
        bucket: 'hour' as const,
        boundary: '[sinceMs, untilMs)' as const,
        calendarWeekStartsOn: 'monday' as const,
      },
      combined: {
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
      },
      companions: [],
    }));
    const router = new GatewayFleetSsoRouter({
      canonicalOrigin: CANONICAL_ORIGIN,
      trustProxy: true,
      broker: { resolveAuthorizationContext: async () => { throw new Error('not used'); } },
      signer,
      verifier,
      replay: { consume: async input => ({ outcome: 'consumed', result: input.consumeResult }) },
      portalProjection: { resolve: resolveProjection },
      portalUi: {
        isEnabled: () => true,
        servePage: (_request, response) => {
          response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          response.end('<!doctype html><title>Authenticated fleet portal</title>');
        },
        serveAsset: (_path, _request, response) => {
          response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
          response.end('export{}');
        },
      },
      modelUsageProjection: { resolve: resolveModelUsageProjection },
      upstreams: [{ companionId: COMPANION_ID, origin: new URL('http://127.0.0.1:3211') }],
      ...options,
    });
    const server = createServer((incoming, response) => { void router.handle(incoming, response); });
    servers.push(server);
    return {
      port: await listen(server),
      resolveProjection,
      resolveModelUsageProjection,
      router,
    };
  }

  it('renders the login landing without fleet disclosure and authenticates both portal surfaces', async () => {
    const harness = await start();
    expect(harness.router.matches('/')).toBe(true);
    expect(harness.router.matches('/v1/fleet/portal')).toBe(true);
    expect(harness.router.matches('/v1/fleet/portal/')).toBe(true);
    expect(harness.router.matches('/v1/fleet/model-usage')).toBe(true);
    expect(harness.router.matches('/fleet/status.json')).toBe(false);

    const root = await request(harness.port, '/');
    expect(root.status).toBe(302);
    expect(root.headers.location).toBe('/fleet');
    expect(root.headers['cache-control']).toBe('no-store');
    expect(root.body).toBe('');

    const authenticatedRoot = await request(harness.port, '/', { session: SESSION_TOKEN });
    expect(authenticatedRoot.status).toBe(302);
    expect(authenticatedRoot.headers.location).toBe('/fleet');

    expect((await request(harness.port, '/?unexpected=true')).status).toBe(404);
    expect((await request(harness.port, '/', { method: 'POST' })).status).toBe(404);

    const fleet = await request(harness.port, '/fleet', { accept: 'text/html' });
    expect(fleet.status).toBe(302);
    expect(fleet.headers.location).toBe('/v1/fleet-auth/login?return_to=%2Ffleet');
    expect(fleet.headers['cache-control']).toBe('no-store');
    expect(fleet.body).toBe('');
    expect(harness.resolveProjection).not.toHaveBeenCalled();

    const login = await request(harness.port, '/fleet/login');
    expect(login.status).toBe(200);
    expect(login.body).toContain('PSFN');
    expect(login.body).toContain('Login with Discord');
    expect(login.body).toContain('href="/v1/fleet-auth/login?return_to=%2Ffleet"');
    expect(login.body).not.toMatch(/Emergency administrator login|companion|version/iu);

    const authenticatedLogin = await request(harness.port, '/fleet/login', {
      session: SESSION_TOKEN,
    });
    expect(authenticatedLogin.status).toBe(200);
    expect(authenticatedLogin.body).toBe(login.body);
    expect(harness.resolveProjection).not.toHaveBeenCalled();

    const api = await request(harness.port, '/v1/fleet/portal');
    expect(api.status).toBe(401);
    expect(api.body).toBe('{"error":{"type":"fleet_portal_denied"}}');
    expect(api.headers.vary).toBe('Cookie');
    expect(api.headers['access-control-allow-origin']).toBeUndefined();
    expect(harness.resolveProjection).not.toHaveBeenCalled();

    const modelUsage = await request(harness.port, '/v1/fleet/model-usage');
    expect(modelUsage.status).toBe(401);
    expect(modelUsage.body).toBe('{"error":{"type":"fleet_model_usage_denied"}}');
    expect(harness.resolveModelUsageProjection).not.toHaveBeenCalled();

    const authenticatedPortal = await request(harness.port, '/fleet', {
      session: SESSION_TOKEN,
    });
    expect(authenticatedPortal.status).toBe(200);
    expect(authenticatedPortal.body).toContain('Authenticated fleet portal');
    expect(harness.resolveProjection).toHaveBeenCalledOnce();

    const rawStatus = await request(harness.port, '/fleet/status.json', {
      session: SESSION_TOKEN,
    });
    expect(rawStatus.status).toBe(404);
    expect(rawStatus.body).not.toMatch(/companionCount|gardenPort|recentViolationWindowMs/u);

    const authenticated = await request(harness.port, '/v1/fleet/portal', {
      session: SESSION_TOKEN,
    });
    expect(authenticated.status).toBe(200);
    expect(harness.resolveProjection).toHaveBeenCalledTimes(2);

    const authenticatedUsage = await request(
      harness.port,
      '/v1/fleet/model-usage?range=today&timezone=UTC',
      { session: SESSION_TOKEN },
    );
    expect(authenticatedUsage.status).toBe(200);
    expect(JSON.parse(authenticatedUsage.body)).toMatchObject({
      schemaVersion: 1,
      combined: { totalTokens: 0 },
      companions: [],
    });
    expect(harness.resolveModelUsageProjection).toHaveBeenCalledWith({
      sessionToken: SESSION_TOKEN,
      query: { range: 'today', timezone: 'UTC' },
    });
  });

  it('redirects an unauthenticated Garden page through login with its exact companion path', async () => {
    const harness = await start();
    const returnPath = `/companions/${COMPANION_ID}/garden/subsystem-health?tab=observer`;
    const page = await request(harness.port, returnPath, { accept: 'text/html' });

    expect(page.status).toBe(302);
    expect(page.headers.location).toBe(
      `/v1/fleet-auth/login?return_to=${encodeURIComponent(returnPath)}`,
    );
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.body).toBe('');

    const api = await request(
      harness.port,
      `/companions/${COMPANION_ID}/garden/api/admin/subsystem-health`,
      { accept: 'application/json' },
    );
    expect(api.status).toBe(401);
    expect(api.headers.location).toBeUndefined();
  });

  it('renders the break-glass entry only for an explicit login registration', async () => {
    const harness = await start({
      breakGlassLogin: { loginPath: '/v1/fleet-auth/emergency-login' },
    });
    const login = await request(harness.port, '/fleet/login');

    expect(login.status).toBe(200);
    expect(login.body).toContain(
      'href="/v1/fleet-auth/emergency-login">Emergency administrator login</a>',
    );
    await expect(start({
      breakGlassLogin: { loginPath: 'https://attacker.example.test/login' },
    })).rejects.toThrow('requires a strict same-origin path');
  });

  it('keeps canonical SSO primary and offers local operator login as a loopback fallback', async () => {
    const harness = await start({
      localOperatorLogin: {
        loginPath: '/v1/fleet-auth/local-operator-login',
        allowedOrigins: ['http://127.0.0.1:10053'],
      },
    });

    const fleet = await request(harness.port, '/fleet', { accept: 'text/html' });
    expect(fleet.status).toBe(302);
    expect(fleet.headers.location).toBe('/v1/fleet-auth/login?return_to=%2Ffleet');

    const gardenPath = `/companions/${COMPANION_ID}/garden/subsystem-health`;
    const garden = await request(harness.port, gardenPath, { accept: 'text/html' });
    expect(garden.status).toBe(302);
    expect(garden.headers.location).toBe(
      `/v1/fleet-auth/login?return_to=${encodeURIComponent(gardenPath)}`,
    );

    const login = await request(harness.port, '/fleet/login');
    expect(login.status).toBe(200);
    const ssoIndex = login.body.indexOf('href="/v1/fleet-auth/login?return_to=%2Ffleet"');
    const localIndex = login.body.indexOf('href="/v1/fleet-auth/local-operator-login"');
    expect(ssoIndex).toBeGreaterThan(-1);
    expect(localIndex).toBeGreaterThan(ssoIndex);
    expect(login.body).toContain('href="/v1/fleet-auth/local-operator-login"');
    expect(login.body).toContain('Local administrator login');
    expect(login.body).toContain('Login with Discord');

    const portal = await request(harness.port, '/fleet', {
      accept: 'text/html',
      localSession: SESSION_TOKEN,
      origin: 'http://127.0.0.1:10053',
    });
    expect(portal.status).toBe(200);
    expect(harness.resolveProjection).toHaveBeenCalledWith({ sessionToken: SESSION_TOKEN });

    const denied = await request(harness.port, '/fleet', {
      accept: 'text/html',
      localSession: SESSION_TOKEN,
      origin: 'http://127.0.0.1:10054',
    });
    expect(denied.status).toBe(400);
  });

  it('rejects cross-origin reads, aliases, and mutations before portal projection', async () => {
    const harness = await start();
    for (const path of [
      '/fleet',
      '/fleet/login',
      '/v1/fleet/portal',
    ]) {
      const denied = await request(harness.port, path, {
        origin: 'https://attacker.example.test',
      });
      expect(denied.status).toBe(400);
    }
    for (const input of [
      { path: '/v1/fleet/portal/', session: SESSION_TOKEN, expectedStatus: 404 },
      {
        // An encoded slash in a query value is a VALID target since the
        // hrmrq.27 outer-parser fix (encoded timezones must survive the door);
        // the portal route's own no-query guard still rejects it before the
        // projection — as not-found, no longer as malformed.
        path: '/v1/fleet/portal?return_to=%2Fcompanions',
        session: SESSION_TOKEN,
        expectedStatus: 404,
      },
      {
        path: '/v1/fleet/portal',
        method: 'POST',
        session: SESSION_TOKEN,
        expectedStatus: 404,
      },
    ]) {
      const denied = await request(harness.port, input.path, input);
      expect(denied.status).toBe(input.expectedStatus);
    }
    expect(harness.resolveProjection).not.toHaveBeenCalled();
  });
});
