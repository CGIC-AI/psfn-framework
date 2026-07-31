import { generateKeyPairSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createGatewayRequestCapabilitySigner,
  createRequestCapabilityVerifier,
} from '../fleet-auth/request-capability.js';
import { createCompanionId } from '../../shared/routing/companion-id.js';
import { GatewayFleetSsoRouter } from './fleet-sso-router.js';

const { httpRequest } = vi.hoisted(() => ({ httpRequest: vi.fn() }));

vi.mock('node:http', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:http')>(),
  request: httpRequest,
}));

const COMPANION_ID = createCompanionId('11111111-1111-4111-8111-111111111111');
const CANONICAL_ORIGIN = 'https://fleet.example.test';
const HARNESS_KEY = 'dedicated-testing-harness-key';
const SETTINGS_BODY = Buffer.from('configJson=%7B%22mode%22%3A%22local%22%7D');
const SETTINGS_PATH = `/companions/${COMPANION_ID}/garden/api/admin/settings/backup`;

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

function createRouter(
  upstreamPort: number,
  denialLogger: { warn: ReturnType<typeof vi.fn> },
  options: {
    allowedActions?: readonly ['settings.write'] | readonly ['settings.read'];
    oversizedCapability?: boolean;
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
    broker: { resolveAuthorizationContext: vi.fn() },
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
  });
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
    vi.clearAllMocks();
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
