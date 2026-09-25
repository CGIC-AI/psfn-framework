// psfn-framework-p39zg + psfn-framework-zc6uo: a fleet deployment with NO
// human SSO provider (`provider.kind: none`) must boot from its owner file and
// give the ADMIN_TOKEN operator every fleet surface — Fleet portal / ICP
// readiness, lifecycle routes, Garden admin and Garden chat — through the
// unified origin, while every OAuth entry point fails closed with a typed
// `provider_disabled` error.
import { generateKeyPairSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IncomingHttpHeaders, IncomingMessage, RequestOptions, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FleetAuthHttpRoutes } from '../../channels/api/server/fleet-auth-routes.js';
import { createCompanionId } from '../../shared/routing/companion-id.js';
import {
  validateFleetAuthConfig,
  type FleetAuthConfig,
} from '../../system/config/fleet-auth-config.js';
import {
  createGatewayRequestCapabilitySigner,
  createRequestCapabilityVerifier,
} from '../fleet-auth/request-capability.js';
import { GatewayFleetAuthBroker, type FleetAuthBrokerStore } from './fleet-auth-broker.js';
import type { FleetPortalProjection } from './fleet-portal-projection.js';
import { GatewayFleetSsoRouter, type FleetGardenChatAdmission } from './fleet-sso-router.js';
import { noSsoOwnerFile } from '../../test-support/fixtures/fleet-auth-no-sso-owner-file.js';

const { httpRequest } = vi.hoisted(() => ({ httpRequest: vi.fn() }));

vi.mock('node:http', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:http')>(),
  request: httpRequest,
}));

const COMPANION_ID = createCompanionId('11111111-1111-4111-8111-111111111111');
const CANONICAL_ORIGIN = 'https://fleet.example.test';
const ADMIN_TOKEN = 'fleet-admin-token-for-no-sso-tests';
const NOW_SECONDS = 1_783_000_000;

function gatewayRequest(options: {
  method: string;
  path: string;
  headers?: IncomingHttpHeaders;
  body?: Buffer;
}): IncomingMessage {
  const body = options.body ?? Buffer.alloc(0);
  const incoming = Readable.from(body.byteLength > 0 ? [body] : []) as IncomingMessage;
  incoming.method = options.method;
  incoming.url = options.path;
  incoming.headers = {
    host: 'fleet.example.test',
    'x-forwarded-host': 'fleet.example.test',
    'x-forwarded-proto': 'https',
    'x-forwarded-port': '443',
    'x-forwarded-for': '198.51.100.9',
    ...(body.byteLength > 0 ? { 'content-length': String(body.byteLength) } : {}),
    ...options.headers,
  };
  Object.defineProperty(incoming, 'socket', { value: {} });
  return incoming;
}

function responseProbe() {
  let responseBody = Buffer.alloc(0);
  const headers: Record<string, unknown> = {};
  const response = {
    statusCode: 200,
    destroyed: false,
    writableEnded: false,
    headersSent: false,
    setHeader: vi.fn((name: string, value: unknown) => { headers[name.toLowerCase()] = value; }),
    getHeader: vi.fn((name: string) => headers[name.toLowerCase()]),
    writeHead: vi.fn((status: number, head?: Record<string, unknown>) => {
      response.statusCode = status;
      for (const [name, value] of Object.entries(head ?? {})) headers[name.toLowerCase()] = value;
    }),
    end: vi.fn((body?: Buffer | string) => {
      responseBody = body === undefined ? Buffer.alloc(0) : Buffer.from(body);
      response.writableEnded = true;
    }),
  };
  return {
    response,
    header: (name: string) => headers[name.toLowerCase()],
    body: () => responseBody.toString('utf8'),
  };
}

function mockSuccessfulProxy(): { headers: () => IncomingHttpHeaders } {
  let capturedHeaders: IncomingHttpHeaders = {};
  httpRequest.mockImplementationOnce((options: RequestOptions, callback?: (response: unknown) => void) => {
    capturedHeaders = options.headers ?? {};
    const request = new EventEmitter() as EventEmitter & Record<string, unknown>;
    request.write = vi.fn();
    request.destroy = vi.fn();
    request.end = vi.fn(() => queueMicrotask(() => {
      const upstream = new EventEmitter() as EventEmitter & Record<string, unknown>;
      upstream.statusCode = 200;
      upstream.headers = { 'content-type': 'application/json' };
      upstream.pipe = vi.fn(() => queueMicrotask(() => upstream.emit('end')));
      callback?.(upstream);
    }));
    return request;
  });
  return { headers: () => capturedHeaders };
}

function adminPortalProjection(): FleetPortalProjection {
  return {
    schemaVersion: 3,
    generatedAt: new Date(NOW_SECONDS * 1_000).toISOString(),
    session: { state: 'authenticated' },
    icp: { state: 'inactive_singleton', activity: { status: 'not_applicable' } },
    companions: [{
      companionId: COMPANION_ID,
      displayName: 'Test Companion',
      health: { agentRpc: 'up', adminTransport: 'unknown', channels: 'unknown' },
      posture: { status: 'unavailable' },
      icp: { state: 'not_applicable', reason: 'singleton_fleet', lifecycle: 'member' },
      gardenPath: `/companions/${COMPANION_ID}/garden`,
    }],
  };
}

function createNoSsoRouter(config: FleetAuthConfig, options: { companionUi?: boolean } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const audit = {
    record: vi.fn(async () => ({
      authorizationEventId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      authorityGeneration: 4,
      globalAuthEpoch: 6,
      occurredAt: new Date(NOW_SECONDS * 1_000),
    })),
  };
  const lifecycleHandle = vi.fn(async (input: { response: ServerResponse }) => {
    input.response.writeHead(200);
    input.response.end();
  });
  const resolveAdminToken = vi.fn(async () => adminPortalProjection());
  const resolveAdminTokenUsage = vi.fn(async () => ({ schemaVersion: 1, generatedAt: 'now' }));
  const router = new GatewayFleetSsoRouter({
    canonicalOrigin: config.canonicalOrigin,
    trustProxy: true,
    adminToken: ADMIN_TOKEN,
    adminTokenAudit: audit,
    ssoLoginEnabled: config.provider.kind === 'discord',
    broker: { resolveAuthorizationContext: vi.fn(async () => { throw new Error('no SSO sessions exist'); }) },
    signer: createGatewayRequestCapabilitySigner({
      issuer: 'fleet-no-sso-test',
      kid: 'fleet-no-sso-key',
      privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      ttlSeconds: 30,
      nowSeconds: () => NOW_SECONDS,
    }),
    verifier: createRequestCapabilityVerifier({
      issuer: 'fleet-no-sso-test',
      maxTtlSeconds: 30,
      keys: [{
        issuer: 'fleet-no-sso-test',
        kid: 'fleet-no-sso-key',
        publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
        notBefore: '2026-07-01T00:00:00.000Z',
        notAfter: '2026-07-03T00:00:00.000Z',
        status: 'active',
      }],
    }),
    replay: { consume: async input => ({ outcome: 'consumed', result: input.consumeResult }) },
    portalProjection: { resolve: vi.fn(), resolveAdminToken },
    modelUsageProjection: { resolve: vi.fn(), resolveAdminToken: resolveAdminTokenUsage },
    upstreams: [{ companionId: COMPANION_ID, origin: new URL('http://127.0.0.1:3219') }],
    lifecycleRoutes: {
      matches: (rawPath: string) => rawPath.startsWith('/v1/fleet/lifecycle/'),
      handle: lifecycleHandle,
    },
    nowSeconds: () => NOW_SECONDS,
    denialLogger: { warn: vi.fn() },
    ...(options.companionUi
      ? { companionUi: { companionId: COMPANION_ID, origin: new URL('http://127.0.0.1:3212') } }
      : {}),
  } as ConstructorParameters<typeof GatewayFleetSsoRouter>[0]);
  return { router, audit, lifecycleHandle, resolveAdminToken, resolveAdminTokenUsage };
}

const ADMIN_BEARER = { authorization: `Bearer ${ADMIN_TOKEN}` };

describe('fleet with no SSO provider: full ADMIN_TOKEN access', () => {
  afterEach(() => {
    httpRequest.mockReset();
  });

  const config = validateFleetAuthConfig(noSsoOwnerFile(CANONICAL_ORIGIN), 'fleet-auth.json');

  it('validates the owner file without any Discord OAuth values', () => {
    expect(config.provider).toEqual({ kind: 'none' });
    expect(JSON.stringify(config)).not.toContain('FLEET_AUTH_DISCORD_CLIENT_SECRET');
  });

  it('rejects every OAuth entry point with a typed provider_disabled error', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const store = {} as FleetAuthBrokerStore;
    expect(() => new GatewayFleetAuthBroker({
      config,
      store,
      oauthClientSecret: 'stray-client-secret',
      sessionPepper: 'session-pepper-at-least-thirty-two-bytes',
      fetchImpl,
    })).toThrow(/must not receive an OAuth client secret/);
    const broker = new GatewayFleetAuthBroker({
      config,
      store,
      sessionPepper: 'session-pepper-at-least-thirty-two-bytes',
      fetchImpl,
    });
    const routes = new FleetAuthHttpRoutes({
      broker,
      canonicalOrigin: config.canonicalOrigin,
      callbackPath: config.callbackPath,
      trustProxy: true,
    });
    for (const target of ['/v1/fleet-auth/login?return_to=%2Ffleet', `${config.callbackPath}?state=s&code=c`]) {
      const probe = responseProbe();
      const url = new URL(target, CANONICAL_ORIGIN);
      await routes.handle(
        gatewayRequest({ method: 'GET', path: target }),
        probe.response as never,
        url,
      );
      expect(probe.response.statusCode).toBe(404);
      expect(JSON.parse(probe.body())).toMatchObject({ error: { type: 'provider_disabled' } });
    }
    expect(fetchImpl).not.toHaveBeenCalled();

    // A browser navigation to the SSO entry lands on the key sign-in instead.
    const browser = responseProbe();
    await routes.handle(
      gatewayRequest({ method: 'GET', path: '/v1/fleet-auth/login?return_to=%2Ffleet', headers: { accept: 'text/html' } }),
      browser.response as never,
      new URL('/v1/fleet-auth/login?return_to=%2Ffleet', CANONICAL_ORIGIN),
    );
    expect(browser.response.statusCode).toBe(303);
    expect(browser.header('location')).toBe('/fleet/login');
  });

  it('keeps browsers off the disabled Discord login and offers only the administrator form', async () => {
    const { router } = createNoSsoRouter(config);
    const redirect = responseProbe();
    await router.handle(
      gatewayRequest({ method: 'GET', path: '/fleet', headers: { accept: 'text/html' } }),
      redirect.response as never,
    );
    expect(redirect.response.statusCode).toBe(302);
    expect(redirect.header('location')).toBe('/fleet/login');

    const landing = responseProbe();
    await router.handle(gatewayRequest({ method: 'GET', path: '/fleet/login' }), landing.response as never);
    expect(landing.response.statusCode).toBe(200);
    expect(landing.body()).not.toContain('Login with Discord');
    expect(landing.body()).toContain('Login with administrator token');
  });

  it('serves the Fleet portal and ICP readiness API to the ADMIN_TOKEN bearer', async () => {
    const { router, resolveAdminToken } = createNoSsoRouter(config);
    const probe = responseProbe();
    await router.handle(
      gatewayRequest({
        method: 'GET',
        path: '/v1/fleet/portal',
        headers: { accept: 'application/json', ...ADMIN_BEARER },
      }),
      probe.response as never,
    );
    expect(probe.response.statusCode).toBe(200);
    expect(JSON.parse(probe.body())).toMatchObject({ schemaVersion: 3, icp: { state: 'inactive_singleton' } });
    expect(resolveAdminToken).toHaveBeenCalledOnce();
  });

  it('serves the fleet usage summary to the ADMIN_TOKEN key and 401s anonymous callers', async () => {
    const { router, resolveAdminTokenUsage } = createNoSsoRouter(config);
    const probe = responseProbe();
    await router.handle(
      gatewayRequest({
        method: 'GET',
        path: '/v1/fleet/model-usage?range=week',
        headers: { accept: 'application/json', cookie: `psfn_token=${ADMIN_TOKEN}` },
      }),
      probe.response as never,
    );
    expect(probe.response.statusCode).toBe(200);
    expect(resolveAdminTokenUsage).toHaveBeenCalledWith(expect.objectContaining({ range: 'week' }));
    const anonymous = responseProbe();
    await router.handle(
      gatewayRequest({ method: 'GET', path: '/v1/fleet/model-usage?range=week', headers: { accept: 'application/json' } }),
      anonymous.response as never,
    );
    expect(anonymous.response.statusCode).toBe(401);
  });

  it('serves the browser Companion UI to the ADMIN_TOKEN cookie instead of the login landing', async () => {
    const { router } = createNoSsoRouter(config, { companionUi: true });
    const serve = vi.spyOn(router as unknown as { serveCompanionUi: () => Promise<void> }, 'serveCompanionUi')
      .mockResolvedValue(undefined);
    const keyed = responseProbe();
    await router.handle(
      gatewayRequest({ method: 'GET', path: '/companion-ui/', headers: { cookie: `psfn_token=${ADMIN_TOKEN}` } }),
      keyed.response as never,
    );
    expect(serve).toHaveBeenCalledOnce();
    const anonymous = responseProbe();
    await router.handle(gatewayRequest({ method: 'GET', path: '/companion-ui/' }), anonymous.response as never);
    expect(serve).toHaveBeenCalledOnce();
    expect(anonymous.body()).toContain('Login with administrator token');
  });

  it('signs the key operator out by clearing the HttpOnly key cookie and the door marker', async () => {
    const { router } = createNoSsoRouter(config);
    const probe = responseProbe();
    await router.handle(
      gatewayRequest({ method: 'POST', path: '/fleet/logout', headers: { origin: CANONICAL_ORIGIN } }),
      probe.response as never,
    );
    expect(probe.response.statusCode).toBe(204);
    expect(probe.header('set-cookie')).toEqual([
      expect.stringMatching(/^psfn_token=; .*Max-Age=0/u),
      expect.stringMatching(/^garden_operator_door=; .*Max-Age=0/u),
    ]);
    const foreign = responseProbe();
    await router.handle(
      gatewayRequest({ method: 'POST', path: '/fleet/logout', headers: { origin: 'https://evil.example.test' } }),
      foreign.response as never,
    );
    expect(foreign.response.statusCode).toBe(400);
  });

  it('routes the lifecycle UI routes to the ADMIN_TOKEN operator and 401s anonymous callers', async () => {
    const { router, lifecycleHandle } = createNoSsoRouter(config);
    const admitted = responseProbe();
    await router.handle(
      gatewayRequest({ method: 'GET', path: '/v1/fleet/lifecycle/plans', headers: ADMIN_BEARER }),
      admitted.response as never,
    );
    expect(admitted.response.statusCode).toBe(200);
    expect(lifecycleHandle).toHaveBeenCalledWith(expect.objectContaining({
      requester: { kind: 'operator', actor: 'operator:admin-token' },
    }));

    const anonymous = responseProbe();
    await router.handle(
      gatewayRequest({ method: 'GET', path: '/v1/fleet/lifecycle/plans' }),
      anonymous.response as never,
    );
    expect(anonymous.response.statusCode).toBe(401);
    expect(lifecycleHandle).toHaveBeenCalledOnce();
  });

  it('proxies Garden admin with an audited capability carrying the audited authority versions', async () => {
    const { router, audit } = createNoSsoRouter(config);
    const upstream = mockSuccessfulProxy();
    const probe = responseProbe();
    await router.handle(
      gatewayRequest({
        method: 'GET',
        path: `/companions/${COMPANION_ID}/garden/api/admin/tools/adaptive`,
        headers: ADMIN_BEARER,
      }),
      probe.response as never,
    );
    expect(probe.response.statusCode).toBe(200);
    expect(audit.record).toHaveBeenCalledOnce();
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      companionId: COMPANION_ID,
      principalId: 'admin-token-operator',
      provider: 'admin_token',
    }));
    expect(upstream.headers()).toMatchObject({
      'x-psfn-request-capability': expect.any(String),
      'x-psfn-capability-context': expect.any(String),
    });
    expect(upstream.headers()).not.toHaveProperty('authorization');
  });

  it('admits Garden chat for the ADMIN_TOKEN operator as an audited admin-token principal', async () => {
    const { router, audit } = createNoSsoRouter(config);
    const admissions: FleetGardenChatAdmission[] = [];
    router.registerGardenChatHandler(async (admission) => {
      admissions.push(admission);
      admission.response.writeHead(200);
      admission.response.end();
    });
    const body = Buffer.from(JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }));
    const probe = responseProbe();
    await router.handle(
      gatewayRequest({
        method: 'POST',
        path: `/companions/${COMPANION_ID}/garden/v1/chat/completions`,
        headers: { ...ADMIN_BEARER, origin: CANONICAL_ORIGIN, 'content-type': 'application/json' },
        body,
      }),
      probe.response as never,
    );
    expect(probe.response.statusCode).toBe(200);
    expect(admissions).toHaveLength(1);
    expect(admissions[0]!.authorization.provenance.source).toBe('gateway_admin_token');
    expect(admissions[0]!.authorization.authorization.action).toBe('companion.interact');
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'companion.interact' }));
  });

  it('refuses to start the ADMIN_TOKEN door without durable audit wiring', () => {
    expect(() => new GatewayFleetSsoRouter({
      canonicalOrigin: CANONICAL_ORIGIN,
      trustProxy: true,
      adminToken: ADMIN_TOKEN,
      upstreams: [{ companionId: COMPANION_ID, origin: new URL('http://127.0.0.1:3219') }],
    } as unknown as ConstructorParameters<typeof GatewayFleetSsoRouter>[0]))
      .toThrow(/ADMIN_TOKEN door requires durable authorization audit wiring/);
  });
});
