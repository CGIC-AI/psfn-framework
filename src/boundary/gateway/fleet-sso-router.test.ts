import { generateKeyPairSync } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  buildFleetSsoProxyRequestHeaders,
  fleetGardenUpgradeClose,
  GatewayFleetSsoRouter,
  resolveFleetSsoBrowserOrigin,
} from './fleet-sso-router.js';
import { resolveFleetSsoGardenUpstreams } from '../fleet-auth/fleet-sso-transport.js';
import {
  createGatewayRequestCapabilitySigner,
  createRequestCapabilityVerifier,
} from '../fleet-auth/request-capability.js';
import {
  FleetAuthorizationDeniedError,
  type FleetAuthorizationContext,
} from './fleet-authorization-context.js';
import { createCompanionId } from '../../shared/routing/companion-id.js';
import { buildGardenCapabilityHeaders } from '../fleet-auth/garden-capability-context.js';
import {
  admitFleetGardenRequest,
  InMemoryRequestCapabilityReplayPort,
} from '../../operator/garden/garden-admission.js';
import {
  clearGardenDenialsForTests,
  getGardenDenialsLastHour,
} from '../../operator/garden/garden-denial-observability.js';

describe('Fleet Garden WebSocket rejection close contract', () => {
  it.each([
    [400, 4400, 'Invalid Garden stream request'],
    [401, 4401, 'Garden stream authentication required'],
    [404, 4404, 'Garden stream unavailable'],
    [503, 4503, 'Garden stream service unavailable'],
  ] as const)('maps HTTP %s to close code %s with a browser-visible reason', (status, code, reason) => {
    expect(fleetGardenUpgradeClose(status)).toEqual({ code, reason });
  });

  it('rejects a revoked session during the HTTP upgrade instead of opening then closing', async () => {
    const canonicalOrigin = 'https://fleet.example.test';
    const companionId = createCompanionId('11111111-1111-4111-8111-111111111111');
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const broker = {
      resolveAuthorizationContext: vi.fn(async () => {
        throw new FleetAuthorizationDeniedError('session_revoked');
      }),
    };
    const router = new GatewayFleetSsoRouter({
      canonicalOrigin,
      trustProxy: true,
      broker,
      signer: createGatewayRequestCapabilitySigner({
        issuer: 'fleet-upgrade-revocation-test',
        kid: 'fleet-upgrade-revocation-key',
        privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
        ttlSeconds: 30,
      }),
      verifier: createRequestCapabilityVerifier({
        issuer: 'fleet-upgrade-revocation-test',
        maxTtlSeconds: 30,
        keys: [{
          issuer: 'fleet-upgrade-revocation-test',
          kid: 'fleet-upgrade-revocation-key',
          publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
          notBefore: '2020-01-01T00:00:00.000Z',
          notAfter: '2040-01-01T00:00:00.000Z',
          status: 'active',
        }],
      }),
      replay: { consume: vi.fn() },
      portalProjection: { resolve: vi.fn() },
      upstreams: [{ companionId, origin: new URL('http://127.0.0.1:3211') }],
    });
    const rejectedUpgradeServer = (
      router as unknown as {
        rejectedUpgradeServer: { handleUpgrade: (...args: unknown[]) => void };
      }
    ).rejectedUpgradeServer;
    const openedThenClosed = vi
      .spyOn(rejectedUpgradeServer, 'handleUpgrade')
      .mockImplementation(() => undefined);
    const socket = {
      destroyed: false,
      end: vi.fn(),
    };
    const incoming = {
      url: `/companions/${companionId}/garden/api/admin/events`,
      headers: {
        host: 'fleet.example.test',
        cookie: `__Host-psfn_session=${'r'.repeat(43)}`,
        origin: canonicalOrigin,
        'x-forwarded-host': 'fleet.example.test',
        'x-forwarded-proto': 'https',
        'x-forwarded-port': '443',
        'x-forwarded-for': '198.51.100.9',
      },
      socket: {},
    } as IncomingMessage;

    router.handleUpgrade(incoming, socket as never, Buffer.alloc(0));

    await vi.waitFor(() => expect(socket.end).toHaveBeenCalledOnce());
    expect(socket.end).toHaveBeenCalledWith(expect.stringMatching(/^HTTP\/1\.1 404 /u));
    expect(openedThenClosed).not.toHaveBeenCalled();
  });
});

function request(headers: IncomingMessage['headers'], encrypted = false): Pick<IncomingMessage, 'headers' | 'socket'> {
  return {
    headers,
    socket: { encrypted } as IncomingMessage['socket'],
  };
}

describe('unified Fleet SSO origin provenance', () => {
  const canonicalOrigin = 'https://fleet.example.test';

  it('accepts only the exact direct TLS Host without forwarded metadata', () => {
    expect(resolveFleetSsoBrowserOrigin(
      request({ host: 'fleet.example.test' }, true),
      { canonicalOrigin, trustProxy: false },
    )).toBe(canonicalOrigin);
    expect(() => resolveFleetSsoBrowserOrigin(
      request({ host: 'fleet.example.test', 'x-forwarded-proto': 'https' }, true),
      { canonicalOrigin, trustProxy: false },
    )).toThrow(/Forwarded origin metadata is forbidden/u);
    expect(() => resolveFleetSsoBrowserOrigin(
      request({ host: 'attacker.example.test' }, true),
      { canonicalOrigin, trustProxy: false },
    )).toThrow(/provenance is invalid/u);
  });

  it('serves the login landing before an unauthenticated Companion UI request can reach upstream', async () => {
    const companionId = createCompanionId('11111111-1111-4111-8111-111111111111');
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const broker = { resolveAuthorizationContext: vi.fn() };
    const router = new GatewayFleetSsoRouter({
      canonicalOrigin,
      trustProxy: true,
      broker,
      signer: createGatewayRequestCapabilitySigner({
        issuer: 'companion-ui-auth-test',
        kid: 'companion-ui-auth-key',
        privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
        ttlSeconds: 30,
      }),
      verifier: createRequestCapabilityVerifier({
        issuer: 'companion-ui-auth-test',
        maxTtlSeconds: 30,
        keys: [{
          issuer: 'companion-ui-auth-test',
          kid: 'companion-ui-auth-key',
          publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
          notBefore: '2020-01-01T00:00:00.000Z',
          notAfter: '2040-01-01T00:00:00.000Z',
          status: 'active',
        }],
      }),
      replay: { consume: vi.fn() },
      portalProjection: { resolve: vi.fn() },
      upstreams: [{ companionId, origin: new URL('http://127.0.0.1:3211') }],
      companionUi: {
        companionId,
        origin: new URL('http://127.0.0.1:3212'),
      },
    });
    const incoming = Readable.from([]) as IncomingMessage;
    incoming.method = 'GET';
    incoming.url = '/companion-ui/chat?conversation=private';
    incoming.headers = {
      host: 'fleet.example.test',
      'x-forwarded-host': 'fleet.example.test',
      'x-forwarded-proto': 'https',
      'x-forwarded-port': '443',
      'x-forwarded-for': '198.51.100.9',
    };
    Object.defineProperty(incoming, 'socket', { value: {} });
    const writeHead = vi.fn();
    const end = vi.fn();
    const response = {
      destroyed: false,
      writableEnded: false,
      writeHead,
      end,
    } as unknown as ServerResponse;

    await router.handle(incoming, response);

    expect(writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
      'Content-Type': 'text/html; charset=utf-8',
    }));
    expect(end).toHaveBeenCalledWith(expect.any(Buffer));
    expect(broker.resolveAuthorizationContext).not.toHaveBeenCalled();
  });

  it('distinguishes a denied Companion UI session from an authorization outage', async () => {
    const companionId = createCompanionId('11111111-1111-4111-8111-111111111111');
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const broker = {
      resolveAuthorizationContext: vi.fn(async () => {
        throw new FleetAuthorizationDeniedError('session_revoked');
      }),
    };
    const router = new GatewayFleetSsoRouter({
      canonicalOrigin,
      trustProxy: true,
      broker,
      signer: createGatewayRequestCapabilitySigner({
        issuer: 'companion-ui-forged-cookie-test',
        kid: 'companion-ui-forged-cookie-key',
        privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
        ttlSeconds: 30,
      }),
      verifier: createRequestCapabilityVerifier({
        issuer: 'companion-ui-forged-cookie-test',
        maxTtlSeconds: 30,
        keys: [{
          issuer: 'companion-ui-forged-cookie-test',
          kid: 'companion-ui-forged-cookie-key',
          publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
          notBefore: '2020-01-01T00:00:00.000Z',
          notAfter: '2040-01-01T00:00:00.000Z',
          status: 'active',
        }],
      }),
      replay: { consume: vi.fn() },
      portalProjection: { resolve: vi.fn() },
      upstreams: [{ companionId, origin: new URL('http://127.0.0.1:3211') }],
      companionUi: {
        companionId,
        origin: new URL('http://127.0.0.1:3212'),
      },
    });
    const incoming = Readable.from([]) as IncomingMessage;
    incoming.method = 'GET';
    incoming.url = '/companion-ui/app.js';
    incoming.headers = {
      host: 'fleet.example.test',
      'x-forwarded-host': 'fleet.example.test',
      'x-forwarded-proto': 'https',
      'x-forwarded-port': '443',
      'x-forwarded-for': '198.51.100.9',
      cookie: `__Host-psfn_session=${'f'.repeat(43)}`,
    };
    Object.defineProperty(incoming, 'socket', { value: {} });
    const writeHead = vi.fn();
    const end = vi.fn();
    const response = {
      destroyed: false,
      writableEnded: false,
      writeHead,
      end,
    } as unknown as ServerResponse;

    await router.handle(incoming, response);

    expect(broker.resolveAuthorizationContext).toHaveBeenCalledWith(expect.objectContaining({
      sessionToken: 'f'.repeat(43),
      companionId,
      action: 'companion.read',
    }));
    expect(writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
      'Content-Type': 'text/html; charset=utf-8',
    }));
    expect(end).toHaveBeenCalledWith(expect.any(Buffer));

    broker.resolveAuthorizationContext.mockRejectedValueOnce(
      new Error('fleet authorization database unavailable'),
    );
    const outageRequest = Readable.from([]) as IncomingMessage;
    outageRequest.method = incoming.method;
    outageRequest.url = incoming.url;
    outageRequest.headers = incoming.headers;
    Object.defineProperty(outageRequest, 'socket', { value: {} });
    const outageWriteHead = vi.fn();
    const outageEnd = vi.fn();
    const outageResponse = {
      destroyed: false,
      writableEnded: false,
      writeHead: outageWriteHead,
      end: outageEnd,
    } as unknown as ServerResponse;

    await router.handle(outageRequest, outageResponse);

    expect(outageWriteHead).toHaveBeenCalledWith(503, expect.objectContaining({
      'Content-Type': 'application/json; charset=utf-8',
    }));
    expect(outageEnd).toHaveBeenCalledWith(
      Buffer.from(JSON.stringify({ error: { type: 'fleet_sso_unavailable' } }), 'utf8'),
    );
  });

  it('admits fleet Garden chat with one server-derived companion target', async () => {
    const companionId = '11111111-1111-4111-8111-111111111111';
    const nowSeconds = 1_783_000_000;
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const signer = createGatewayRequestCapabilitySigner({
      issuer: 'fleet-chat-test',
      kid: 'fleet-chat-key',
      privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      ttlSeconds: 30,
      nowSeconds: () => nowSeconds,
    });
    const verifier = createRequestCapabilityVerifier({
      issuer: 'fleet-chat-test',
      maxTtlSeconds: 30,
      keys: [{
        issuer: 'fleet-chat-test',
        kid: 'fleet-chat-key',
        publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
        notBefore: '2026-07-01T00:00:00.000Z',
        notAfter: '2026-07-03T00:00:00.000Z',
        status: 'active',
      }],
    });
    const authorization: FleetAuthorizationContext = Object.freeze({
      principalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      providerSubject: Object.freeze({ provider: 'discord', subjectId: 'subject-a' }),
      companionId,
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
      authorization: Object.freeze({ action: 'companion.interact', decision: 'allow' }),
      authority: Object.freeze({ authorityGeneration: 1, globalAuthEpoch: 1 }),
      provenance: Object.freeze({
        source: 'gateway_fleet_authorization_snapshot',
        authorizationEventId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        resolvedAt: new Date(nowSeconds * 1_000).toISOString(),
      }),
    });
    const router = new GatewayFleetSsoRouter({
      canonicalOrigin,
      trustProxy: true,
      broker: { resolveAuthorizationContext: vi.fn(async () => authorization) },
      signer,
      verifier,
      replay: { consume: async input => ({ outcome: 'consumed', result: input.consumeResult }) },
      portalProjection: { resolve: vi.fn(async () => { throw new Error('not used'); }) },
      upstreams: [{ companionId, origin: new URL('http://127.0.0.1:3211') }],
      nowSeconds: () => nowSeconds,
    });
    const body = Buffer.from(JSON.stringify({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hello' }],
    }));
    const incoming = Readable.from([body]) as IncomingMessage;
    incoming.method = 'POST';
    incoming.url = `/companions/${companionId}/garden/v1/chat/completions`;
    incoming.headers = {
      host: 'fleet.example.test',
      'x-forwarded-host': 'fleet.example.test',
      'x-forwarded-proto': 'https',
      'x-forwarded-port': '443',
      'x-forwarded-for': '198.51.100.9',
      cookie: `__Host-psfn_session=${'s'.repeat(43)}`,
      'content-type': 'application/json',
      'content-length': String(body.byteLength),
    };
    Object.defineProperty(incoming, 'socket', { value: {} });
    const response = {
      destroyed: false,
      writableEnded: false,
      writeHead: vi.fn(),
      end: vi.fn(),
    } as unknown as ServerResponse;
    const handler = vi.fn(async (admission) => {
      expect(admission.companionId).toBe(companionId);
      expect(admission.authorization).toBe(authorization);
      expect(admission.body).toEqual(body);
    });
    router.registerGardenChatHandler(handler);

    await router.handle(incoming, response);

    expect(response.writeHead).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledOnce();
  });

  it('records a browser-principal escalation denial at the unified-origin door', async () => {
    const companionId = createCompanionId('11111111-1111-4111-8111-111111111111');
    const nowSeconds = 1_783_000_000;
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const authorization: FleetAuthorizationContext = Object.freeze({
      principalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      providerSubject: Object.freeze({ provider: 'discord', subjectId: 'subject-a' }),
      companionId,
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
      authorization: Object.freeze({ action: 'memory.reveal', decision: 'allow' }),
      authority: Object.freeze({ authorityGeneration: 1, globalAuthEpoch: 1 }),
      provenance: Object.freeze({
        source: 'gateway_fleet_authorization_snapshot',
        authorizationEventId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        resolvedAt: new Date(nowSeconds * 1_000).toISOString(),
      }),
    });
    const consumeGrant = vi.fn(async () => ({
      grantId: '99999999-9999-4999-8999-999999999999',
      principalId: authorization.principalId,
      browserSessionId: authorization.session.recordId,
      companionId: companionId as string,
      action: 'memory.reveal' as const,
      routeId: 'POST /api/admin/memory/:id/reveal',
      scopeDigest: 'c'.repeat(64),
      assuranceRequirement: 'escalated' as const,
      expiresAt: new Date((nowSeconds + 300) * 1_000),
    }));
    const replay = vi.fn(async () => ({ outcome: 'mismatch' as const }));
    const denialLogger = { warn: vi.fn() };
    clearGardenDenialsForTests();
    const router = new GatewayFleetSsoRouter({
      canonicalOrigin,
      trustProxy: true,
      broker: { resolveAuthorizationContext: vi.fn(async () => authorization) },
      signer: createGatewayRequestCapabilitySigner({
        issuer: 'fleet-jit-test',
        kid: 'fleet-jit-key',
        privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
        ttlSeconds: 30,
        nowSeconds: () => nowSeconds,
      }),
      verifier: createRequestCapabilityVerifier({
        issuer: 'fleet-jit-test',
        maxTtlSeconds: 30,
        keys: [{
          issuer: 'fleet-jit-test',
          kid: 'fleet-jit-key',
          publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
          notBefore: '2026-07-01T00:00:00.000Z',
          notAfter: '2026-07-03T00:00:00.000Z',
          status: 'active',
        }],
      }),
      replay: { consume: replay },
      escalation: { consumeGrant },
      portalProjection: { resolve: vi.fn(async () => { throw new Error('not used'); }) },
      upstreams: [{ companionId, origin: new URL('http://127.0.0.1:3211') }],
      nowSeconds: () => nowSeconds,
      denialLogger,
    });
    // The reveal surface carries no request body: the audited grant, not a
    // browser-supplied envelope, is what opens it.
    const body = Buffer.alloc(0);
    const incoming = Readable.from([body]) as IncomingMessage;
    incoming.method = 'POST';
    incoming.url = `/companions/${companionId}/garden/api/admin/memory/memory-a/reveal`;
    incoming.headers = {
      host: 'fleet.example.test',
      'x-forwarded-host': 'fleet.example.test',
      'x-forwarded-proto': 'https',
      'x-forwarded-port': '443',
      'x-forwarded-for': '198.51.100.9',
      cookie: `__Host-psfn_session=${'s'.repeat(43)}`,
      'content-type': 'application/json',
      'content-length': String(body.byteLength),
    };
    Object.defineProperty(incoming, 'socket', { value: {} });
    let finishListener: (() => void) | undefined;
    const response = {
      statusCode: 200,
      destroyed: false,
      writableEnded: false,
      once: vi.fn((event: string, listener: () => void) => {
        if (event === 'finish') finishListener = listener;
      }),
      writeHead: vi.fn((status: number) => {
        response.statusCode = status;
      }),
      end: vi.fn(() => {
        response.writableEnded = true;
        finishListener?.();
      }),
    } as unknown as ServerResponse;

    await router.handle(incoming, response);

    expect(consumeGrant).not.toHaveBeenCalled();
    expect(replay).not.toHaveBeenCalled();
    expect(response.writeHead).toHaveBeenCalledWith(403, expect.any(Object));
    expect(denialLogger.warn).toHaveBeenCalledWith('Fleet Garden request denied', {
      reasonCode: 'escalation_grant_required',
      reason: 'escalation_grant_required',
      status: 403,
      routeId: 'POST /api/admin/memory/:id/reveal',
      action: 'memory.reveal',
      principalId: authorization.principalId,
    });
    expect(denialLogger.warn).toHaveBeenCalledOnce();
    expect(getGardenDenialsLastHour()).toBe(1);

    clearGardenDenialsForTests();
    denialLogger.warn.mockClear();
    const delegatedRequest = Readable.from([]) as IncomingMessage;
    delegatedRequest.method = 'GET';
    delegatedRequest.url = '/v1/fleet/portal';
    delegatedRequest.headers = {
      host: 'fleet.example.test',
      'x-forwarded-host': 'fleet.example.test',
      'x-forwarded-proto': 'https',
      'x-forwarded-port': '443',
      'x-forwarded-for': '198.51.100.9',
    };
    Object.defineProperty(delegatedRequest, 'socket', { value: {} });
    let delegatedFinishListener: (() => void) | undefined;
    const delegatedResponse = {
      statusCode: 200,
      destroyed: false,
      writableEnded: false,
      once: vi.fn((event: string, listener: () => void) => {
        if (event === 'finish') delegatedFinishListener = listener;
      }),
      writeHead: vi.fn((status: number) => {
        delegatedResponse.statusCode = status;
      }),
      end: vi.fn(() => {
        delegatedResponse.writableEnded = true;
        delegatedFinishListener?.();
      }),
    } as unknown as ServerResponse;

    await router.handle(delegatedRequest, delegatedResponse);

    expect(delegatedResponse.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
    expect(denialLogger.warn).toHaveBeenCalledWith('Fleet Garden request denied', {
      reasonCode: 'capability_required',
      reason: 'response_denied',
      status: 401,
      routeId: 'GET /v1/fleet/portal',
      action: 'unresolved',
      principalId: 'unknown',
    });
    expect(getGardenDenialsLastHour()).toBe(1);
    clearGardenDenialsForTests();
  });

  it('mints the normal single-use capability tail for an allowlisted testing-harness request', async () => {
    const companionId = createCompanionId('11111111-1111-4111-8111-111111111111');
    const nowSeconds = Math.floor(Date.now() / 1_000);
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const baseSigner = createGatewayRequestCapabilitySigner({
      issuer: 'fleet-harness-test',
      kid: 'fleet-harness-key',
      privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      ttlSeconds: 30,
      nowSeconds: () => nowSeconds,
      generateJti: () => 'testing-harness-request-once',
    });
    let signedInput: Parameters<typeof baseSigner.signTestingHarness>[0] | undefined;
    let issuedToken: string | undefined;
    const signTestingHarness = vi.fn((
      input: Parameters<typeof baseSigner.signTestingHarness>[0],
    ) => {
      signedInput = input;
      issuedToken = baseSigner.signTestingHarness(input);
      return issuedToken;
    });
    const audit = vi.fn(async () => ({
      authorizationEventId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      authorityGeneration: 7,
      globalAuthEpoch: 11,
      occurredAt: new Date(nowSeconds * 1_000),
    }));
    const replay = vi.fn(async (input: Parameters<NonNullable<ConstructorParameters<typeof GatewayFleetSsoRouter>[0]['replay']['consume']>>[0]) => ({
      outcome: 'consumed' as const,
      result: input.consumeResult,
    }));
    const broker = { resolveAuthorizationContext: vi.fn(async () => {
      throw new Error('browser broker must not run for the testing harness');
    }) };
    const requestVerifier = createRequestCapabilityVerifier({
      issuer: 'fleet-harness-test',
      maxTtlSeconds: 30,
      keys: [{
        issuer: 'fleet-harness-test',
        kid: 'fleet-harness-key',
        publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
        notBefore: '2020-01-01T00:00:00.000Z',
        notAfter: '2040-01-01T00:00:00.000Z',
        status: 'active',
      }],
    });
    const router = new GatewayFleetSsoRouter({
      canonicalOrigin,
      trustProxy: true,
      broker,
      signer: { ...baseSigner, signTestingHarness },
      verifier: requestVerifier,
      replay: { consume: replay },
      portalProjection: { resolve: vi.fn(async () => { throw new Error('not used'); }) },
      upstreams: [{ companionId, origin: new URL('http://127.0.0.1:3211') }],
      testingHarness: {
        apiKey: 'dedicated-testing-harness-key',
        policy: {
          enabled: true,
          principalId: 'testing-harness',
          operatorGrantId: 'testing-harness-garden-grant',
          role: 'admin',
          allowedActions: ['settings.write'],
        },
        audit: { record: audit },
      },
      nowSeconds: () => nowSeconds,
    });
    const body = Buffer.from('configJson=%7B%22mode%22%3A%22local%22%7D');
    const incoming = Readable.from([body]) as IncomingMessage;
    incoming.method = 'POST';
    incoming.url = `/companions/${companionId}/garden/api/admin/settings/backup`;
    incoming.headers = {
      host: 'fleet.example.test',
      'x-forwarded-host': 'fleet.example.test',
      'x-forwarded-proto': 'https',
      'x-forwarded-port': '443',
      'x-forwarded-for': '198.51.100.9',
      authorization: 'Bearer dedicated-testing-harness-key',
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': String(body.byteLength),
    };
    Object.defineProperty(incoming, 'socket', { value: {} });
    const response = {
      destroyed: false,
      writableEnded: false,
      writeHead: vi.fn(),
      end: vi.fn(),
    } as unknown as ServerResponse;

    await router.handle(incoming, response);

    expect(broker.resolveAuthorizationContext).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'settings.write',
      companionId,
      principalId: 'testing-harness',
      provider: 'testing_harness',
    }));
    expect(signTestingHarness).toHaveBeenCalledWith(expect.objectContaining({
      authContext: expect.objectContaining({
        principalId: 'testing-harness',
        provider: 'testing_harness',
        operatorGrantId: 'testing-harness-garden-grant',
        // A plain oauth-assurance route never gets a silently elevated tier from
        // the synthetic door, and an absent roster fails closed to multi_admin.
        sessionAssurance: 'oauth',
        fleetAccessMode: 'multi_admin',
      }),
    }));
    expect(replay).toHaveBeenCalledOnce();
    expect(response.writeHead).toHaveBeenCalledWith(502, expect.any(Object));

    expect(buildFleetSsoProxyRequestHeaders(incoming.headers)).toEqual(expect.not.objectContaining({
      authorization: expect.anything(),
      cookie: expect.anything(),
    }));
    expect(issuedToken).toBeDefined();
    expect(signedInput).toBeDefined();
    const admitted = await admitFleetGardenRequest({
      admission: {
        kind: 'fleet-principal',
        audience: 'operator',
        companionId,
        verifier: requestVerifier,
        replay: new InMemoryRequestCapabilityReplayPort(),
        testingHarness: { enabled: true },
      },
      rawTarget: '/api/admin/settings/backup',
      method: 'POST',
      headers: {
        ...buildGardenCapabilityHeaders({
          token: issuedToken!,
          context: {
            requestId: signedInput!.requestId,
            decisionId: signedInput!.decisionId,
            versions: signedInput!.versions,
          },
        }),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    expect(admitted).toMatchObject({
      decision: 'allow',
      verified: {
        audience: 'testing-harness',
        action: 'settings.write',
        authContext: { provider: 'testing_harness', principalId: 'testing-harness' },
      },
    });
  });

  it('rejects a testing-harness action outside the configured allowlist before audit or signing', async () => {
    const companionId = createCompanionId('11111111-1111-4111-8111-111111111111');
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const signer = createGatewayRequestCapabilitySigner({
      issuer: 'fleet-harness-test',
      kid: 'fleet-harness-key',
      privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      ttlSeconds: 30,
    });
    const signTestingHarness = vi.fn(signer.signTestingHarness);
    const audit = vi.fn();
    const router = new GatewayFleetSsoRouter({
      canonicalOrigin,
      trustProxy: true,
      broker: { resolveAuthorizationContext: vi.fn() },
      signer: { ...signer, signTestingHarness },
      verifier: createRequestCapabilityVerifier({
        issuer: 'fleet-harness-test',
        maxTtlSeconds: 30,
        keys: [{
          issuer: 'fleet-harness-test',
          kid: 'fleet-harness-key',
          publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
          notBefore: '2020-01-01T00:00:00.000Z',
          notAfter: '2040-01-01T00:00:00.000Z',
          status: 'active',
        }],
      }),
      replay: { consume: vi.fn() },
      portalProjection: { resolve: vi.fn() },
      upstreams: [{ companionId, origin: new URL('http://127.0.0.1:3211') }],
      testingHarness: {
        apiKey: 'dedicated-testing-harness-key',
        policy: {
          enabled: true,
          principalId: 'testing-harness',
          operatorGrantId: 'testing-harness-garden-grant',
          role: 'admin',
          allowedActions: ['settings.read'],
        },
        audit: { record: audit },
      },
    });
    const body = Buffer.from('{}');
    const incoming = Readable.from([body]) as IncomingMessage;
    incoming.method = 'POST';
    incoming.url = `/companions/${companionId}/garden/api/admin/privacy-break-glass/memory/item/confirm`;
    incoming.headers = {
      host: 'fleet.example.test',
      'x-forwarded-host': 'fleet.example.test',
      'x-forwarded-proto': 'https',
      'x-forwarded-port': '443',
      'x-forwarded-for': '198.51.100.9',
      authorization: 'Bearer dedicated-testing-harness-key',
      'content-type': 'application/json',
      'content-length': String(body.byteLength),
    };
    Object.defineProperty(incoming, 'socket', { value: {} });
    const response = {
      destroyed: false,
      writableEnded: false,
      writeHead: vi.fn(),
      end: vi.fn(),
    } as unknown as ServerResponse;

    await router.handle(incoming, response);

    expect(audit).not.toHaveBeenCalled();
    expect(signTestingHarness).not.toHaveBeenCalled();
    expect(response.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
  });

  it('builds the fleet-cost roster only from per-companion models.read decisions', async () => {
    const companionA = createCompanionId('11111111-1111-4111-8111-111111111111');
    const companionB = createCompanionId('22222222-2222-4222-8222-222222222222');
    const companionC = createCompanionId('33333333-3333-4333-8333-333333333333');
    const nowSeconds = 1_783_000_000;
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const contextFor = (companionId: string): FleetAuthorizationContext => ({
      principalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      providerSubject: { provider: 'discord', subjectId: 'subject-a' },
      companionId,
      contact: { bindingId: `binding-${companionId}`, contactId: `contact-${companionId}`, bindingVersion: 1 },
      operator: { grantId: `grant-${companionId}`, role: 'admin', grantVersion: 1 },
      session: {
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
      },
      authorization: { action: 'models.read', decision: 'allow' },
      authority: { authorityGeneration: 1, globalAuthEpoch: 1 },
      provenance: {
        source: 'gateway_fleet_authorization_snapshot',
        authorizationEventId: `event-${companionId}`,
        resolvedAt: new Date(nowSeconds * 1_000).toISOString(),
      },
    });
    const resolveAuthorizationContext = vi.fn(async (input: unknown) => {
      const companionId = (input as { companionId?: string }).companionId;
      if (companionId !== companionB) throw new Error('not authorized');
      return contextFor(companionB);
    });
    const router = new GatewayFleetSsoRouter({
      canonicalOrigin,
      trustProxy: true,
      broker: { resolveAuthorizationContext },
      signer: createGatewayRequestCapabilitySigner({
        issuer: 'fleet-cost-test',
        kid: 'fleet-cost-key',
        privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
        ttlSeconds: 30,
        nowSeconds: () => nowSeconds,
      }),
      verifier: createRequestCapabilityVerifier({
        issuer: 'fleet-cost-test',
        maxTtlSeconds: 30,
        keys: [{
          issuer: 'fleet-cost-test',
          kid: 'fleet-cost-key',
          publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
          notBefore: '2026-07-01T00:00:00.000Z',
          notAfter: '2026-07-03T00:00:00.000Z',
          status: 'active',
        }],
      }),
      replay: { consume: async input => ({ outcome: 'consumed', result: input.consumeResult }) },
      portalProjection: { resolve: vi.fn(async () => { throw new Error('not used'); }) },
      upstreams: [companionA, companionB, companionC].map((companionId, index) => ({
        companionId,
        origin: new URL(`http://127.0.0.1:${3211 + index}`),
      })),
      nowSeconds: () => nowSeconds,
    });
    const resolveRoster = (
      router as unknown as {
        resolveFleetModelUsageRoster(
          sessionToken: string,
          selectedCompanionId: typeof companionA,
          selectedContext: FleetAuthorizationContext,
        ): Promise<readonly string[]>;
      }
    ).resolveFleetModelUsageRoster.bind(router);

    await expect(resolveRoster('s'.repeat(43), companionA, contextFor(companionA)))
      .resolves.toEqual([companionA, companionB]);
    expect(resolveAuthorizationContext).toHaveBeenCalledTimes(2);
    expect(resolveAuthorizationContext).toHaveBeenCalledWith(expect.objectContaining({
      companionId: companionB,
      action: 'models.read',
    }));
    expect(resolveAuthorizationContext).toHaveBeenCalledWith(expect.objectContaining({
      companionId: companionC,
      action: 'models.read',
    }));
  });

  it('accepts one explicit HTTPS proxy shape and rejects spoofed/mixed variants', () => {
    const exactHeaders = {
      host: 'fleet.example.test',
      'x-forwarded-host': 'fleet.example.test',
      'x-forwarded-proto': 'https',
      'x-forwarded-port': '443',
      'x-forwarded-for': '198.51.100.9',
    };
    expect(resolveFleetSsoBrowserOrigin(
      request(exactHeaders),
      { canonicalOrigin, trustProxy: true },
    )).toBe(canonicalOrigin);
    for (const headers of [
      { ...exactHeaders, 'x-forwarded-host': 'attacker.example.test' },
      { ...exactHeaders, 'x-forwarded-proto': 'http' },
      { ...exactHeaders, 'x-forwarded-for': '198.51.100.9, 203.0.113.8' },
      { ...exactHeaders, forwarded: 'host=attacker.example.test;proto=https' },
    ]) {
      expect(() => resolveFleetSsoBrowserOrigin(
        request(headers),
        { canonicalOrigin, trustProxy: true },
      )).toThrow();
    }
  });

  it('derives one exact loopback Garden from a one-entry fleet manifest', () => {
    expect(resolveFleetSsoGardenUpstreams({
      fleet: {
        persistenceRoot: '/runtime',
        workspacesRoot: '/runtime/workspaces',
        sharedWorkspacePath: '/runtime/shared',
        companions: [{
          companionId: createCompanionId('11111111-1111-4111-8111-111111111111'),
          companionDataDir: '/runtime/companions/one',
          characterCardPath: '/runtime/companions/one/character-card.json',
          personalWorkspacePath: '/runtime/workspaces/one',
          postgresSchema: 'companion_one',
        }],
      },
      fleetGardenPort: 3001,
      env: {},
    })).toMatchObject([{
      companionId: '11111111-1111-4111-8111-111111111111',
      origin: new URL('http://127.0.0.1:3001'),
      companionScopedTarget: true,
    }]);
  });
});
