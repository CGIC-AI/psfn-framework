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
  options: { method?: string; session?: string; origin?: string } = {},
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
        ...(options.origin ? { origin: options.origin } : {}),
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

  async function start(): Promise<{
    port: number;
    resolveProjection: ReturnType<typeof vi.fn>;
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
      schemaVersion: 1 as const,
      generatedAt: '2026-07-16T20:00:00.000Z',
      session: { state: 'authenticated' as const },
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
      upstreams: [{ companionId: COMPANION_ID, origin: new URL('http://127.0.0.1:3211') }],
    });
    const server = createServer((incoming, response) => { void router.handle(incoming, response); });
    servers.push(server);
    return { port: await listen(server), resolveProjection, router };
  }

  it('uses only the fixed login return and authenticates both portal surfaces', async () => {
    const harness = await start();
    expect(harness.router.matches('/v1/fleet/portal')).toBe(true);
    expect(harness.router.matches('/v1/fleet/portal/')).toBe(true);

    const fleet = await request(harness.port, '/fleet');
    expect(fleet.status).toBe(303);
    expect(fleet.headers.location).toBe('/fleet/login');

    const login = await request(harness.port, '/fleet/login');
    expect(login.status).toBe(303);
    expect(login.headers.location).toBe('/v1/fleet-auth/login?return_to=%2Ffleet');

    const api = await request(harness.port, '/v1/fleet/portal');
    expect(api.status).toBe(401);
    expect(api.body).toBe('{"error":{"type":"fleet_portal_denied"}}');
    expect(api.headers.vary).toBe('Cookie');
    expect(api.headers['access-control-allow-origin']).toBeUndefined();
    expect(harness.resolveProjection).not.toHaveBeenCalled();

    const authenticated = await request(harness.port, '/v1/fleet/portal', {
      session: SESSION_TOKEN,
    });
    expect(authenticated.status).toBe(200);
    expect(harness.resolveProjection).toHaveBeenCalledOnce();
  });

  it('rejects cross-origin reads, aliases, and mutations before portal projection', async () => {
    const harness = await start();
    for (const input of [
      { path: '/v1/fleet/portal', origin: 'https://attacker.example.test' },
      { path: '/v1/fleet/portal/', session: SESSION_TOKEN },
      { path: '/v1/fleet/portal?return_to=%2Fcompanions', session: SESSION_TOKEN },
      { path: '/v1/fleet/portal', method: 'POST', session: SESSION_TOKEN },
    ]) {
      const denied = await request(harness.port, input.path, input);
      expect([400, 404]).toContain(denied.status);
    }
    expect(harness.resolveProjection).not.toHaveBeenCalled();
  });
});
