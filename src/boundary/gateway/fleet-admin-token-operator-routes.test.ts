// psfn-framework-jxthv: every operator-facing Garden mutation must be reachable
// through the audited ADMIN_TOKEN door on a fleet with no SSO configured —
// not "most of them". This enumerates the canonical route catalogue, drives
// each mutation through the gateway door and the Garden admission, and then
// asserts the Garden-side operator gates (escalated assurance, subject
// binding, service boundary, contact mutation actor) accept the audited
// admin-token operator. Anonymous callers still fail closed.
import { generateKeyPairSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IncomingHttpHeaders, IncomingMessage, RequestOptions } from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCompanionId } from '../../shared/routing/companion-id.js';
import {
  createGatewayRequestCapabilitySigner,
  createRequestCapabilityVerifier,
} from '../fleet-auth/request-capability.js';
import {
  GARDEN_ROUTE_CAPABILITIES,
  type GardenRouteCapability,
} from '../fleet-auth/garden-route-capabilities.js';
import { admitFleetGardenRequest } from '../../operator/garden/garden-admission.js';
import {
  createFleetGardenRequestContext,
  gardenRequestServiceBoundaryDenial,
  hasEscalatedOperatorAssurance,
  isAuditedAdminTokenOperator,
  isSubjectBoundFleetRequest,
  resolveFleetGardenContactMutationActor,
} from '../../operator/garden/garden-request-context.js';
import { GatewayFleetSsoRouter } from './fleet-sso-router.js';

const { httpRequest } = vi.hoisted(() => ({ httpRequest: vi.fn() }));

vi.mock('node:http', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:http')>(),
  request: httpRequest,
}));

const COMPANION_ID = createCompanionId('11111111-1111-4111-8111-111111111111');
const CANONICAL_ORIGIN = 'https://fleet.example.test';
const ADMIN_TOKEN = 'fleet-admin-token-for-route-enumeration';
const NOW_SECONDS = 1_783_000_000;
const ISSUER = 'fleet-admin-token-routes-test';

/**
 * Mutations the ADMIN_TOKEN operator cannot perform because they are
 * inherently the subject's OWN proof of controlling an identity (the Discord
 * OAuth callback of the account being linked). Nothing else may be listed:
 * the operator approves ceremonies but never impersonates the subject's proof.
 * The fleet-auth identity ceremonies themselves
 * (`/v1/fleet-auth/lifecycle/{binding,provider,role}/complete`) are operator-
 * approvable (psfn-framework-ja7n0); they are served by the gateway fleet-auth
 * door rather than the Garden proxy, and their ADMIN_TOKEN path is proven end
 * to end in fleet-auth-routes.test.ts, lifecycle-ceremony.test.ts and
 * authority-lifecycle-operator-approval.integration.test.ts. The Discord OAuth
 * callback and lifecycle OAuth start are not Garden catalogue routes at all.
 */
const NON_OPERATOR_MUTATIONS: Readonly<Record<string, string>> = Object.freeze({});

function operatorMutations(): GardenRouteCapability[] {
  return GARDEN_ROUTE_CAPABILITIES.filter(capability => (
    capability.method !== 'GET'
    && capability.method !== 'HEAD'
    && (capability.method as string) !== 'WS'
    && capability.authorization.publicAccess === 'never'
    && !Object.hasOwn(NON_OPERATOR_MUTATIONS, capability.id)
  ));
}

function concretePath(pattern: string): string {
  return pattern.split('/').map(segment => {
    if (segment.startsWith(':')) return `fixture-${segment.slice(1).toLowerCase()}`;
    if (segment.startsWith('*')) return 'fixture/remainder';
    return segment;
  }).join('/');
}

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
  return { response, body: () => responseBody.toString('utf8') };
}

function captureProxy(): { headers: () => IncomingHttpHeaders; path: () => string | undefined } {
  let capturedHeaders: IncomingHttpHeaders = {};
  let capturedPath: string | undefined;
  httpRequest.mockImplementationOnce((options: RequestOptions, callback?: (response: unknown) => void) => {
    capturedHeaders = options.headers ?? {};
    capturedPath = options.path ?? undefined;
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
  return { headers: () => capturedHeaders, path: () => capturedPath };
}

function createAdminTokenOnlyGateway() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const audit = {
    record: vi.fn(async () => ({
      authorizationEventId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      authorityGeneration: 4,
      globalAuthEpoch: 6,
      occurredAt: new Date(NOW_SECONDS * 1_000),
    })),
  };
  const verifier = createRequestCapabilityVerifier({
    issuer: ISSUER,
    maxTtlSeconds: 30,
    keys: [{
      issuer: ISSUER,
      kid: 'admin-token-routes-key',
      publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
      notBefore: '2026-07-01T00:00:00.000Z',
      notAfter: '2026-07-03T00:00:00.000Z',
      status: 'active',
    }],
  });
  const broker = {
    resolveAuthorizationContext: vi.fn(async () => { throw new Error('no SSO sessions exist'); }),
  };
  const router = new GatewayFleetSsoRouter({
    canonicalOrigin: CANONICAL_ORIGIN,
    trustProxy: true,
    adminToken: ADMIN_TOKEN,
    adminTokenAudit: audit,
    ssoLoginEnabled: false,
    broker,
    signer: createGatewayRequestCapabilitySigner({
      issuer: ISSUER,
      kid: 'admin-token-routes-key',
      privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      ttlSeconds: 30,
      nowSeconds: () => NOW_SECONDS,
    }),
    verifier,
    replay: { consume: async input => ({ outcome: 'consumed', result: input.consumeResult }) },
    portalProjection: { resolve: vi.fn(), resolveAdminToken: vi.fn() },
    modelUsageProjection: { resolve: vi.fn() },
    upstreams: [{ companionId: COMPANION_ID, origin: new URL('http://127.0.0.1:19321') }],
    nowSeconds: () => NOW_SECONDS,
    denialLogger: { warn: vi.fn() },
  } as ConstructorParameters<typeof GatewayFleetSsoRouter>[0]);
  const chatAdmissions: string[] = [];
  router.registerGardenChatHandler(async (admission) => {
    chatAdmissions.push(admission.authorization.provenance.source);
    admission.response.writeHead(200);
    admission.response.end();
  });
  return { router, audit, verifier, broker, chatAdmissions };
}

describe('audited ADMIN_TOKEN operator reaches every Garden mutation without SSO', () => {
  beforeEach(() => {
    // Garden admission verifies against the wall clock.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW_SECONDS * 1_000);
  });

  afterEach(() => {
    vi.useRealTimers();
    httpRequest.mockReset();
  });

  it('enumerates a non-trivial operator mutation surface with only real exclusions', () => {
    const catalogued = new Set(GARDEN_ROUTE_CAPABILITIES.map(route => route.id));
    for (const excluded of Object.keys(NON_OPERATOR_MUTATIONS)) {
      expect(catalogued.has(excluded), excluded).toBe(true);
    }
    const routes = operatorMutations();
    expect(routes.length).toBeGreaterThan(20);
    expect(routes.some(route => route.authorization.requirements.assurance === 'escalated')).toBe(true);
  });

  it.each(operatorMutations().map(route => [route.id, route] as const))(
    '%s',
    async (_id, route) => {
      const { router, audit, verifier, broker, chatAdmissions } = createAdminTokenOnlyGateway();
      const upstream = captureProxy();
      const path = concretePath(route.pattern);
      const body = route.body.mode === 'forbidden' ? undefined : Buffer.from('{}');
      const probe = responseProbe();
      await router.handle(gatewayRequest({
        method: route.method,
        path: `/companions/${COMPANION_ID}/garden${path}`,
        headers: {
          authorization: `Bearer ${ADMIN_TOKEN}`,
          origin: CANONICAL_ORIGIN,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body } : {}),
      }), probe.response as never);

      expect(probe.response.statusCode, probe.body()).toBe(200);
      expect(broker.resolveAuthorizationContext).not.toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledOnce();
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
        action: route.authorization.action,
        provider: 'admin_token',
        principalId: 'admin-token-operator',
      }));

      if (route.id === 'POST /v1/chat/completions') {
        // Garden chat is admitted in the gateway, not proxied to the Garden.
        expect(chatAdmissions).toEqual(['gateway_admin_token']);
        return;
      }
      const admitted = await admitFleetGardenRequest({
        admission: {
          kind: 'fleet-principal',
          audience: 'operator',
          companionId: COMPANION_ID,
          verifier,
          replay: { consume: async input => ({ outcome: 'consumed', result: input.consumeResult }) },
        },
        rawTarget: upstream.path() ?? path,
        method: route.method,
        headers: {
          ...upstream.headers(),
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ?? Buffer.alloc(0),
      });
      expect(admitted.decision).toBe('allow');
      if (admitted.decision !== 'allow' || !('verified' in admitted)) return;
      const context = createFleetGardenRequestContext({
        target: admitted.target,
        verified: admitted.verified,
      });
      expect(context.resource.routeId).toBe(route.id);
      expect(isAuditedAdminTokenOperator(context)).toBe(true);
      expect(gardenRequestServiceBoundaryDenial(context)).toBeNull();
      expect(isSubjectBoundFleetRequest(context)).toBe(false);
      if (route.authorization.requirements.assurance === 'escalated') {
        expect(hasEscalatedOperatorAssurance(context)).toBe(true);
      }
      if (route.authorization.resource.area === 'contacts') {
        expect(resolveFleetGardenContactMutationActor(context)?.auditMetadata).toMatchObject({
          source: 'fleet_garden',
          provider: 'admin_token',
          principalId: 'admin-token-operator',
        });
      }
    },
  );

  it('signs the whole-fleet model-usage roster for the ADMIN_TOKEN operator', async () => {
    const { router, verifier } = createAdminTokenOnlyGateway();
    const upstream = captureProxy();
    const probe = responseProbe();
    await router.handle(gatewayRequest({
      method: 'GET',
      path: `/companions/${COMPANION_ID}/garden/api/admin/fleet-model-usage?range=week`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    }), probe.response as never);
    expect(probe.response.statusCode, probe.body()).toBe(200);
    const admitted = await admitFleetGardenRequest({
      admission: {
        kind: 'fleet-principal',
        audience: 'operator',
        companionId: COMPANION_ID,
        verifier,
        replay: { consume: async input => ({ outcome: 'consumed', result: input.consumeResult }) },
      },
      rawTarget: upstream.path() ?? '/api/admin/fleet-model-usage?range=week',
      method: 'GET',
      headers: upstream.headers(),
      body: Buffer.alloc(0),
    });
    expect(admitted.decision).toBe('allow');
    if (admitted.decision !== 'allow' || !('verified' in admitted)) return;
    expect(admitted.verified.authContext.fleetCompanionIds).toEqual([COMPANION_ID]);
    expect(admitted.verified.authContext.fleetModelUsageRequestTarget).toEqual(expect.any(String));
  });

  it('keeps unauthenticated and wrong-token mutations fail-closed', async () => {
    const route = operatorMutations()[0]!;
    for (const headers of [{}, { authorization: 'Bearer not-the-admin-token' }]) {
      const { router, audit } = createAdminTokenOnlyGateway();
      const probe = responseProbe();
      await router.handle(gatewayRequest({
        method: route.method,
        path: `/companions/${COMPANION_ID}/garden${concretePath(route.pattern)}`,
        headers: { origin: CANONICAL_ORIGIN, ...headers },
      }), probe.response as never);
      expect([401, 403]).toContain(probe.response.statusCode);
      expect(audit.record).not.toHaveBeenCalled();
      expect(httpRequest).not.toHaveBeenCalled();
    }
  });
});
