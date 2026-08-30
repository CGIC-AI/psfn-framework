import { generateKeyPairSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IncomingHttpHeaders, IncomingMessage, RequestOptions } from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createGatewayRequestCapabilitySigner,
  createRequestCapabilityVerifier,
} from '../fleet-auth/request-capability.js';
import { createCompanionId } from '../../shared/routing/companion-id.js';
import type { FleetAuthorizationContext } from './fleet-authorization-context.js';
import { GatewayFleetSsoRouter } from './fleet-sso-router.js';

const { httpRequest } = vi.hoisted(() => ({ httpRequest: vi.fn() }));

vi.mock('node:http', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:http')>(),
  request: httpRequest,
}));

const COMPANION_ID = createCompanionId('11111111-1111-4111-8111-111111111111');
const CANONICAL_ORIGIN = 'https://fleet.example.test';
const HARNESS_KEY = 'dedicated-testing-harness-key';
const ADMIN_TOKEN = 'fleet-admin-token-for-tests';
const SETTINGS_BODY = Buffer.from('configJson=%7B%22mode%22%3A%22local%22%7D');
const SETTINGS_PATH = `/companions/${COMPANION_ID}/garden/api/admin/settings/backup`;
const ADAPTIVE_TOOLS_PATH = `/companions/${COMPANION_ID}/garden/api/admin/tools/adaptive`;

interface ResponseProbe {
  readonly response: {
    statusCode: number;
    destroyed: boolean;
    writableEnded: boolean;
    writeHead: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
  body(): string;
}

function responseProbe(): ResponseProbe {
  let responseBody = Buffer.alloc(0);
  const response = {
    statusCode: 200,
    destroyed: false,
    writableEnded: false,
    writeHead: vi.fn((status: number) => {
      response.statusCode = status;
    }),
    end: vi.fn((body?: Buffer) => {
      responseBody = body ?? Buffer.alloc(0);
      response.writableEnded = true;
    }),
  };
  return {
    response,
    body: () => responseBody.toString('utf8'),
  };
}

function incomingRequest(options: { authenticated?: boolean } = {}): IncomingMessage {
  const incoming = Readable.from([SETTINGS_BODY]) as IncomingMessage;
  incoming.method = 'POST';
  incoming.url = SETTINGS_PATH;
  incoming.headers = {
    host: 'fleet.example.test',
    'x-forwarded-host': 'fleet.example.test',
    'x-forwarded-proto': 'https',
    'x-forwarded-port': '443',
    'x-forwarded-for': '198.51.100.9',
    ...(options.authenticated ? { authorization: `Bearer ${HARNESS_KEY}` } : {}),
    'content-type': 'application/x-www-form-urlencoded',
    'content-length': String(SETTINGS_BODY.byteLength),
  };
  Object.defineProperty(incoming, 'socket', { value: {} });
  return incoming;
}

function adaptiveToolsRequest(headers: IncomingHttpHeaders = {}): IncomingMessage {
  const incoming = Readable.from([]) as IncomingMessage;
  incoming.method = 'GET';
  incoming.url = ADAPTIVE_TOOLS_PATH;
  incoming.headers = {
    host: 'fleet.example.test',
    'x-forwarded-host': 'fleet.example.test',
    'x-forwarded-proto': 'https',
    'x-forwarded-port': '443',
    'x-forwarded-for': '198.51.100.9',
    ...headers,
  };
  Object.defineProperty(incoming, 'socket', { value: {} });
  return incoming;
}

function gardenEventsUpgrade(headers: IncomingHttpHeaders = {}): IncomingMessage {
  const incoming = Readable.from([]) as IncomingMessage;
  incoming.method = 'GET';
  incoming.url = `/companions/${COMPANION_ID}/garden/api/admin/events`;
  incoming.headers = {
    host: 'fleet.example.test',
    origin: CANONICAL_ORIGIN,
    connection: 'Upgrade',
    upgrade: 'websocket',
    'x-forwarded-host': 'fleet.example.test',
    'x-forwarded-proto': 'wss',
    'x-forwarded-port': '443',
    'x-forwarded-for': '198.51.100.9',
    ...headers,
  };
  Object.defineProperty(incoming, 'socket', { value: {} });
  return incoming;
}

function adminLoginRequest(token: string): IncomingMessage {
  const body = Buffer.from(`token=${encodeURIComponent(token)}`);
  const incoming = Readable.from([body]) as IncomingMessage;
  incoming.method = 'POST';
  incoming.url = '/fleet/login';
  incoming.headers = {
    host: 'fleet.example.test',
    'x-forwarded-host': 'fleet.example.test',
    'x-forwarded-proto': 'https',
    'x-forwarded-port': '443',
    'x-forwarded-for': '198.51.100.9',
    'content-type': 'application/x-www-form-urlencoded',
    'content-length': String(body.byteLength),
  };
  Object.defineProperty(incoming, 'socket', { value: {} });
  return incoming;
}

function ssoAuthorization(nowSeconds: number): FleetAuthorizationContext {
  return Object.freeze({
    principalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    providerSubject: Object.freeze({ provider: 'discord', subjectId: 'subject-a' }),
    companionId: COMPANION_ID,
    contact: Object.freeze({
      bindingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      contactId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      bindingVersion: 1,
    }),
    operator: Object.freeze({
      grantId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      role: 'owner',
      grantVersion: 1,
    }),
    session: Object.freeze({
      recordId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      audience: 'fleet',
      assurance: 'oauth',
      authnVersion: 1,
      authzVersion: 1,
      bindingVersion: 1,
      grantVersion: 1,
      policyVersion: 1,
      provider: 'discord',
      providerSubjectId: 'subject-a',
    }),
    authorization: Object.freeze({ action: 'action_pipe.read', decision: 'allow' }),
    authority: Object.freeze({ authorityGeneration: 1, globalAuthEpoch: 1 }),
    provenance: Object.freeze({
      source: 'gateway_fleet_authorization_snapshot',
      authorizationEventId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      resolvedAt: new Date(nowSeconds * 1_000).toISOString(),
    }),
  });
}

function createRouter(
  upstreamPort: number,
  denialLogger: { warn: ReturnType<typeof vi.fn> },
  options: {
    allowedActions?: readonly ['settings.write'] | readonly ['settings.read'];
    oversizedCapability?: boolean;
    broker?: { resolveAuthorizationContext: ReturnType<typeof vi.fn> };
    adminToken?: string;
  } = {},
): GatewayFleetSsoRouter {
  const nowSeconds = 1_783_000_000;
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const signer = createGatewayRequestCapabilitySigner({
    issuer: 'fleet-upstream-test',
    kid: 'fleet-upstream-key',
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    ttlSeconds: 30,
    nowSeconds: () => nowSeconds,
  });
  return new GatewayFleetSsoRouter({
    canonicalOrigin: CANONICAL_ORIGIN,
    trustProxy: true,
    broker: options.broker ?? { resolveAuthorizationContext: vi.fn() },
    signer: options.oversizedCapability
      ? { ...signer, signTestingHarness: () => 'x'.repeat(65_537) }
      : signer,
    verifier: createRequestCapabilityVerifier({
      issuer: 'fleet-upstream-test',
      maxTtlSeconds: 30,
      keys: [{
        issuer: 'fleet-upstream-test',
        kid: 'fleet-upstream-key',
        publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
        notBefore: '2026-07-01T00:00:00.000Z',
        notAfter: '2026-07-03T00:00:00.000Z',
        status: 'active',
      }],
    }),
    replay: { consume: async input => ({ outcome: 'consumed', result: input.consumeResult }) },
    portalProjection: { resolve: vi.fn() },
    modelUsageProjection: { resolve: vi.fn() },
    upstreams: [{
      companionId: COMPANION_ID,
      origin: new URL(`http://127.0.0.1:${upstreamPort}`),
    }],
    testingHarness: {
      apiKey: HARNESS_KEY,
      policy: {
        enabled: true,
        principalId: 'testing-harness',
        operatorGrantId: 'testing-harness-garden-grant',
        role: 'admin',
        allowedActions: options.allowedActions ?? ['settings.write'],
      },
      audit: { record: vi.fn(async () => ({
        authorizationEventId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        authorityGeneration: 7,
        globalAuthEpoch: 11,
        occurredAt: new Date(nowSeconds * 1_000),
      })) },
    },
    nowSeconds: () => nowSeconds,
    denialLogger,
    ...(options.adminToken ? { adminToken: options.adminToken } : {}),
  } as ConstructorParameters<typeof GatewayFleetSsoRouter>[0]);
}

function mockSuccessfulProxy(): { headers: () => IncomingHttpHeaders } {
  let capturedHeaders: IncomingHttpHeaders = {};
  httpRequest.mockImplementationOnce((options: RequestOptions, callback?: (response: unknown) => void) => {
    capturedHeaders = options.headers ?? {};
    const request = new EventEmitter() as EventEmitter & {
      write: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
      destroy: ReturnType<typeof vi.fn>;
    };
    request.write = vi.fn();
    request.destroy = vi.fn();
    request.end = vi.fn(() => queueMicrotask(() => {
      const response = new EventEmitter() as EventEmitter & {
        statusCode: number;
        headers: IncomingHttpHeaders;
        pipe: ReturnType<typeof vi.fn>;
      };
      response.statusCode = 200;
      response.headers = { 'content-type': 'application/json' };
      response.pipe = vi.fn(() => queueMicrotask(() => response.emit('end')));
      callback?.(response);
    }));
    return request;
  });
  return { headers: () => capturedHeaders };
}

function mockSuccessfulUpgrade(): { headers: () => IncomingHttpHeaders } {
  let capturedHeaders: IncomingHttpHeaders = {};
  httpRequest.mockImplementationOnce((options: RequestOptions) => {
    capturedHeaders = options.headers ?? {};
    const request = new EventEmitter() as EventEmitter & { end: ReturnType<typeof vi.fn> };
    request.end = vi.fn(() => queueMicrotask(() => request.emit(
      'upgrade',
      { rawHeaders: [] },
      { write: vi.fn(), pipe: vi.fn() },
      Buffer.alloc(0),
    )));
    return request;
  });
  return { headers: () => capturedHeaders };
}

function mockProxyRequest(
  failure: 'connect_refused' | 'setup_error' | 'socket_error' | 'timeout',
): void {
  httpRequest.mockImplementationOnce(() => {
    if (failure === 'setup_error') {
      throw Object.assign(new Error('TLS certificate missing'), { code: 'ENOENT' });
    }
    const request = new EventEmitter() as EventEmitter & {
      write: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
      destroy: ReturnType<typeof vi.fn>;
    };
    request.write = vi.fn();
    request.destroy = vi.fn((error: Error) => queueMicrotask(() => request.emit('error', error)));
    request.end = vi.fn(() => queueMicrotask(() => {
      if (failure === 'timeout') {
        request.emit('timeout');
        return;
      }
      request.emit('error', Object.assign(
        new Error(failure === 'connect_refused' ? 'connect refused' : 'socket failed'),
        failure === 'connect_refused' ? { code: 'ECONNREFUSED' } : { code: 'EPIPE' },
      ));
    }));
    return request;
  });
}

describe('Fleet SSO Garden upstream failures', () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it('reports a refused Garden connection as availability with its cause in the structured log', async () => {
    mockProxyRequest('connect_refused');
    const denialLogger = { warn: vi.fn() };
    const router = createRouter(3211, denialLogger);
    const probe = responseProbe();

    await router.handle(incomingRequest({ authenticated: true }), probe.response as never);

    expect(probe.response.statusCode).toBe(502);
    expect(JSON.parse(probe.body())).toEqual({
      error: { type: 'garden_upstream_unavailable' },
    });
    expect(denialLogger.warn).toHaveBeenCalledWith(
      'Fleet Garden upstream unavailable',
      expect.objectContaining({
        cause: 'connect_refused',
        status: 502,
        routeId: 'POST /api/admin/settings/backup',
      }),
    );
  });

  it('reports a Garden timeout as availability with its cause in the structured log', async () => {
    mockProxyRequest('timeout');
    const denialLogger = { warn: vi.fn() };
    const router = createRouter(3211, denialLogger);
    const probe = responseProbe();

    await router.handle(incomingRequest({ authenticated: true }), probe.response as never);

    expect(probe.response.statusCode).toBe(502);
    expect(JSON.parse(probe.body())).toEqual({
      error: { type: 'garden_upstream_unavailable' },
    });
    expect(denialLogger.warn).toHaveBeenCalledWith(
      'Fleet Garden upstream unavailable',
      expect.objectContaining({
        cause: 'timeout',
        status: 502,
        routeId: 'POST /api/admin/settings/backup',
      }),
    );
  });

  it('names a non-refusal Garden socket failure separately', async () => {
    mockProxyRequest('socket_error');
    const denialLogger = { warn: vi.fn() };
    const router = createRouter(3211, denialLogger);
    const probe = responseProbe();

    await router.handle(incomingRequest({ authenticated: true }), probe.response as never);

    expect(denialLogger.warn).toHaveBeenCalledWith(
      'Fleet Garden upstream unavailable',
      expect.objectContaining({ cause: 'socket_error', status: 502 }),
    );
  });

  it('does not misreport a coded synchronous setup failure as a socket error', async () => {
    mockProxyRequest('setup_error');
    const denialLogger = { warn: vi.fn() };
    const router = createRouter(3211, denialLogger);
    const probe = responseProbe();

    await router.handle(incomingRequest({ authenticated: true }), probe.response as never);

    expect(denialLogger.warn).toHaveBeenCalledWith(
      'Fleet Garden upstream unavailable',
      expect.objectContaining({
        cause: 'setup_error',
        errorCode: 'ENOENT',
        status: 502,
      }),
    );
  });

  it('keeps a genuine authentication denial classified as a denial', async () => {
    const denialLogger = { warn: vi.fn() };
    const router = createRouter(3211, denialLogger);
    const probe = responseProbe();

    await router.handle(incomingRequest(), probe.response as never);

    expect(probe.response.statusCode).toBe(401);
    expect(JSON.parse(probe.body())).toEqual({
      error: { type: 'fleet_sso_request_denied' },
    });
  });

  it('keeps an explicit 503 capability denial classified as a denial', async () => {
    const denialLogger = { warn: vi.fn() };
    const router = createRouter(3211, denialLogger, { oversizedCapability: true });
    const probe = responseProbe();

    await router.handle(incomingRequest({ authenticated: true }), probe.response as never);

    expect(probe.response.statusCode).toBe(503);
    expect(JSON.parse(probe.body())).toEqual({
      error: { type: 'fleet_sso_request_denied' },
    });
    expect(denialLogger.warn).toHaveBeenCalledWith(
      'Fleet Garden request denied',
      expect.objectContaining({ reasonCode: 'capability_invalid', status: 503 }),
    );
  });

  it('keeps a declared route hidden when the testing-harness door denies it', async () => {
    const denialLogger = { warn: vi.fn() };
    const router = createRouter(3211, denialLogger, { allowedActions: ['settings.read'] });
    const probe = responseProbe();

    await router.handle(incomingRequest({ authenticated: true }), probe.response as never);

    expect(probe.response.statusCode).toBe(404);
    expect(JSON.parse(probe.body())).toEqual({ error: { type: 'not_found' } });
  });
});

describe('Fleet Garden dual admin admission', () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it.each([
    ['bearer', { authorization: `Bearer ${ADMIN_TOKEN}` }],
    ['cookie', { cookie: `psfn_token=${ADMIN_TOKEN}` }],
  ] as const)('accepts a valid ADMIN_TOKEN from a %s and replaces it with a fleet capability', async (_kind, headers) => {
    const upstream = mockSuccessfulProxy();
    const router = createRouter(3211, { warn: vi.fn() }, { adminToken: ADMIN_TOKEN });
    const probe = responseProbe();

    await router.handle(adaptiveToolsRequest(headers), probe.response as never);

    expect(probe.response.statusCode).toBe(200);
    expect(upstream.headers()).toMatchObject({
      'x-psfn-request-capability': expect.any(String),
      'x-psfn-capability-context': expect.any(String),
    });
    expect(upstream.headers()).not.toHaveProperty('authorization');
    expect(upstream.headers()).not.toHaveProperty('cookie');
  });

  it('lets a fresh browser exchange ADMIN_TOKEN for the accepted HttpOnly cookie at Gateway', async () => {
    const router = createRouter(3211, { warn: vi.fn() }, { adminToken: ADMIN_TOKEN });
    const probe = responseProbe();

    await router.handle(adminLoginRequest(ADMIN_TOKEN), probe.response as never);

    expect(probe.response.statusCode).toBe(302);
    expect(probe.response.writeHead).toHaveBeenCalledWith(302, expect.objectContaining({
      Location: '/fleet',
      'Set-Cookie': `psfn_token=${ADMIN_TOKEN}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400`,
    }));
    expect(httpRequest).not.toHaveBeenCalled();
  });

  it('routes an unauthenticated Garden navigation to the dual login landing', async () => {
    const router = createRouter(3211, { warn: vi.fn() }, { adminToken: ADMIN_TOKEN });
    const probe = responseProbe();
    const request = adaptiveToolsRequest({ accept: 'text/html' });

    await router.handle(request, probe.response as never);

    expect(probe.response.statusCode).toBe(302);
    expect(probe.response.writeHead).toHaveBeenCalledWith(302, expect.objectContaining({
      Location: '/fleet/login',
    }));
  });

  it('keeps an invalid browser token at the Gateway login boundary', async () => {
    const router = createRouter(3211, { warn: vi.fn() }, { adminToken: ADMIN_TOKEN });
    const probe = responseProbe();

    await router.handle(adminLoginRequest('invalid-admin-token'), probe.response as never);

    expect(probe.response.statusCode).toBe(401);
    expect(probe.body()).toContain('Invalid administrator token.');
    expect(probe.response.writeHead).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ 'Set-Cookie': expect.any(String) }),
    );
    expect(httpRequest).not.toHaveBeenCalled();
  });

  it('continues accepting a valid fleet SSO session when ADMIN_TOKEN is configured', async () => {
    const upstream = mockSuccessfulProxy();
    const nowSeconds = 1_783_000_000;
    const broker = { resolveAuthorizationContext: vi.fn(async () => ssoAuthorization(nowSeconds)) };
    const router = createRouter(3211, { warn: vi.fn() }, { adminToken: ADMIN_TOKEN, broker });
    const probe = responseProbe();

    await router.handle(adaptiveToolsRequest({
      cookie: `__Host-psfn_session=${'s'.repeat(43)}`,
    }), probe.response as never);

    expect(probe.response.statusCode).toBe(200);
    expect(broker.resolveAuthorizationContext).toHaveBeenCalledOnce();
    expect(upstream.headers()).toMatchObject({
      'x-psfn-request-capability': expect.any(String),
      'x-psfn-capability-context': expect.any(String),
    });
    expect(upstream.headers()).not.toHaveProperty('cookie');
  });

  it.each([
    ['invalid token', { authorization: 'Bearer invalid-admin-token' }],
    ['missing credential', {}],
  ] as const)('fails closed for an %s', async (_kind, headers) => {
    const router = createRouter(3211, { warn: vi.fn() }, { adminToken: ADMIN_TOKEN });
    const probe = responseProbe();

    await router.handle(adaptiveToolsRequest(headers), probe.response as never);

    expect(probe.response.statusCode).toBe(401);
    expect(httpRequest).not.toHaveBeenCalled();
  });

  it('uses the same token-to-capability admission for Garden WebSocket upgrades', async () => {
    const upstream = mockSuccessfulUpgrade();
    const router = createRouter(3211, { warn: vi.fn() }, { adminToken: ADMIN_TOKEN });
    const socket = {
      destroyed: false,
      write: vi.fn(),
      pipe: vi.fn(),
      end: vi.fn(),
    };

    router.handleUpgrade(
      gardenEventsUpgrade({ authorization: `Bearer ${ADMIN_TOKEN}` }),
      socket as never,
      Buffer.alloc(0),
    );

    await vi.waitFor(() => expect(socket.write).toHaveBeenCalled());
    expect(upstream.headers()).toMatchObject({
      'x-psfn-request-capability': expect.any(String),
      'x-psfn-capability-context': expect.any(String),
      connection: 'Upgrade',
      upgrade: 'websocket',
    });
    expect(upstream.headers()).not.toHaveProperty('authorization');
    expect(upstream.headers()).not.toHaveProperty('cookie');
  });

  it('rejects an invalid token before a Garden WebSocket upgrade reaches upstream', async () => {
    const router = createRouter(3211, { warn: vi.fn() }, { adminToken: ADMIN_TOKEN });
    const socket = { destroyed: false, end: vi.fn() };

    router.handleUpgrade(
      gardenEventsUpgrade({ authorization: 'Bearer invalid-admin-token' }),
      socket as never,
      Buffer.alloc(0),
    );

    await vi.waitFor(() => expect(socket.end).toHaveBeenCalled());
    expect(socket.end).toHaveBeenCalledWith(expect.stringMatching(/^HTTP\/1\.1 401 /u));
    expect(httpRequest).not.toHaveBeenCalled();
  });
});
