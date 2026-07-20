import { generateKeyPairSync } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { createCompanionId, type CompanionId } from '../../shared/routing/companion-id.js';
import {
  compileGatewayGardenRequestTarget,
} from '../../boundary/fleet-auth/request-capability-target.js';
import {
  createGatewayRequestCapabilitySigner,
  createRequestCapabilityVerifier,
  type RequestCapabilityAuthorityVersions,
} from '../../boundary/fleet-auth/request-capability.js';
import type {
  RequestCapabilityReplayConsumption,
  RequestCapabilityReplayOutcome,
  RequestCapabilityReplayPort,
} from '../../boundary/fleet-auth/request-capability-replay.js';
import {
  buildGardenCapabilityHeaders,
  InMemoryRequestCapabilityReplayPort,
  type GardenCapabilityContext,
} from './garden-admission.js';
import { FleetGardenTargetRegistry } from './fleet-garden-target-registry.js';
import { FleetGardenControlPlane } from './fleet-garden-control-plane.js';

const COMPANION_A = createCompanionId('11111111-1111-4111-8111-111111111111');
const COMPANION_B = createCompanionId('22222222-2222-4222-8222-222222222222');
const COMPANION_UNREGISTERED = createCompanionId('33333333-3333-4333-8333-333333333333');
const REQUEST_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DECISION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const VERSIONS: RequestCapabilityAuthorityVersions = Object.freeze({
  authorityGeneration: 2,
  globalAuthEpoch: 3,
  sessionAuthnVersion: 5,
  sessionAuthzVersion: 7,
  bindingVersion: 11,
  grantVersion: 13,
  policyVersion: 17,
});

function authContext(companionId: CompanionId) {
  return Object.freeze({
    principalId: 'principal-a',
    provider: 'discord' as const,
    providerSubjectId: '12345678901234567',
    companionId,
    contactBindingId: 'binding-a',
    contactId: 'contact-a',
    operatorGrantId: 'grant-a',
    role: 'admin' as const,
    sessionRecordId: 'session-a',
    sessionAssurance: 'webauthn_uv' as const,
    authorizationEventId: 'event-a',
    resolvedAt: '2030-01-01T00:00:00.000Z',
  });
}

const keyPair = generateKeyPairSync('ed25519');
const privateKeyPem = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicKeyPem = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const verifier = createRequestCapabilityVerifier({
  issuer: 'fleet-auth',
  maxTtlSeconds: 30,
  keys: [{
    issuer: 'fleet-auth',
    kid: 'active',
    publicKeyPem,
    notBefore: '2020-01-01T00:00:00.000Z',
    notAfter: '2040-01-01T00:00:00.000Z',
    status: 'active',
  }],
});

function signer(jti: string, nowSeconds?: () => number) {
  return createGatewayRequestCapabilitySigner({
    issuer: 'fleet-auth',
    kid: 'active',
    privateKeyPem,
    ttlSeconds: 30,
    generateJti: () => jti,
    ...(nowSeconds ? { nowSeconds } : {}),
  });
}

function capabilityContext(): GardenCapabilityContext {
  return Object.freeze({ requestId: REQUEST_ID, decisionId: DECISION_ID, versions: VERSIONS });
}

function signedHeaders(input: {
  companionId: CompanionId;
  innerTarget: string;
  method?: string;
  body?: Buffer;
  jti?: string;
  nowSeconds?: () => number;
  extraHeaders?: IncomingHttpHeaders;
}): IncomingHttpHeaders {
  const target = compileGatewayGardenRequestTarget({
    rawTarget: input.innerTarget,
    method: input.method ?? 'GET',
    companionId: input.companionId,
    body: input.body ?? Buffer.alloc(0),
  });
  const token = signer(input.jti ?? 'jti-default', input.nowSeconds).signOperator({
    target,
    requestId: REQUEST_ID,
    decisionId: DECISION_ID,
    authContext: authContext(input.companionId),
    versions: VERSIONS,
  });
  return {
    ...buildGardenCapabilityHeaders({ token, context: capabilityContext() }),
    ...(input.extraHeaders ?? {}),
  };
}

function registry(): FleetGardenTargetRegistry {
  return new FleetGardenTargetRegistry([
    {
      companionId: COMPANION_A,
      endpoint: { mode: 'socket', socketPath: '/run/garden-admin-a.sock', timeoutMs: 15_000 },
    },
    {
      companionId: COMPANION_B,
      endpoint: { mode: 'socket', socketPath: '/run/garden-admin-b.sock', timeoutMs: 15_000 },
    },
  ]);
}

function plane(overrides?: {
  registry?: FleetGardenTargetRegistry;
  replay?: RequestCapabilityReplayPort;
}): { plane: FleetGardenControlPlane; registry: FleetGardenTargetRegistry } {
  const targets = overrides?.registry ?? registry();
  return {
    plane: new FleetGardenControlPlane({
      registry: targets,
      verifier,
      replay: overrides?.replay ?? new InMemoryRequestCapabilityReplayPort(),
    }),
    registry: targets,
  };
}

/** Replay port that parks every consumption until the test releases it. */
class DeferredReplayPort implements RequestCapabilityReplayPort {
  private readonly inner = new InMemoryRequestCapabilityReplayPort();
  readonly pending: Array<{
    input: RequestCapabilityReplayConsumption;
    release: () => void;
  }> = [];

  consume(input: RequestCapabilityReplayConsumption): Promise<RequestCapabilityReplayOutcome> {
    return new Promise((resolve, reject) => {
      this.pending.push({
        input,
        release: () => {
          this.inner.consume(input).then(resolve, reject);
        },
      });
    });
  }
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error('condition never became true');
}

describe('FleetGardenControlPlane', () => {
  it('admits an exact companion-bound capability and resolves the immutable target last', async () => {
    const { plane: controlPlane, registry: targets } = plane();
    const resolveSpy = vi.spyOn(targets, 'resolve');
    const admitted = await controlPlane.admit({
      rawTarget: `/companions/${COMPANION_A}/garden/api/admin/dashboard`,
      method: 'GET',
      headers: signedHeaders({ companionId: COMPANION_A, innerTarget: '/api/admin/dashboard' }),
      body: Buffer.alloc(0),
    });
    expect(admitted).toMatchObject({
      decision: 'allow',
      kind: 'fleet_principal',
      companionId: COMPANION_A,
      verified: { audience: `operator:${COMPANION_A}`, action: 'garden.read' },
      context: {
        kind: 'fleet_principal',
        resource: { companionId: COMPANION_A },
        actor: { sessionAssurance: 'webauthn_uv' },
      },
      upstream: {
        companionId: COMPANION_A,
        endpoint: { socketPath: '/run/garden-admin-a.sock' },
        expectedAgentAudience: `agent:${COMPANION_A}`,
      },
    });
    expect(Object.isFrozen(admitted)).toBe(true);
    expect(resolveSpy).toHaveBeenCalledTimes(1);
    expect(resolveSpy).toHaveBeenCalledWith(COMPANION_A);
  });

  it('denies unknown, malformed, and unauthenticated selections before target resolution', async () => {
    const { plane: controlPlane, registry: targets } = plane();
    const resolveSpy = vi.spyOn(targets, 'resolve');
    for (const request of [
      // Not a companion-scoped route at all.
      { rawTarget: '/api/admin/dashboard', expected: 404 },
      // Malformed selections are indistinguishable from unknown companions.
      { rawTarget: '/companions/not-a-uuid/garden/api/admin/dashboard', expected: 404 },
      { rawTarget: '/companions/AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA/garden', expected: 404 },
      { rawTarget: `/companions/${COMPANION_A}/garden/../escape`, expected: 404 },
      // Valid-shaped but unauthenticated selections deny uniformly whether or
      // not the companion exists — non-enumerating.
      { rawTarget: `/companions/${COMPANION_A}/garden/api/admin/dashboard`, expected: 401 },
      { rawTarget: `/companions/${COMPANION_UNREGISTERED}/garden/api/admin/dashboard`, expected: 401 },
    ]) {
      const denied = await controlPlane.admit({
        rawTarget: request.rawTarget,
        method: 'GET',
        headers: {},
        body: Buffer.alloc(0),
      });
      expect(denied).toMatchObject({ decision: 'deny', status: request.expected });
    }
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it('denies a capability signed for companion A when presented on companion B routes', async () => {
    const { plane: controlPlane, registry: targets } = plane();
    const resolveSpy = vi.spyOn(targets, 'resolve');
    const headers = signedHeaders({
      companionId: COMPANION_A,
      innerTarget: '/api/admin/dashboard',
      jti: 'crossed-jti',
    });
    const denied = await controlPlane.admit({
      rawTarget: `/companions/${COMPANION_B}/garden/api/admin/dashboard`,
      method: 'GET',
      headers,
      body: Buffer.alloc(0),
    });
    expect(denied).toMatchObject({ decision: 'deny', status: 403 });
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it('denies stale and replayed capabilities before target resolution', async () => {
    const { plane: controlPlane, registry: targets } = plane();
    const resolveSpy = vi.spyOn(targets, 'resolve');

    const stale = await controlPlane.admit({
      rawTarget: `/companions/${COMPANION_A}/garden/api/admin/dashboard`,
      method: 'GET',
      headers: signedHeaders({
        companionId: COMPANION_A,
        innerTarget: '/api/admin/dashboard',
        jti: 'stale-jti',
        nowSeconds: () => Math.floor(Date.now() / 1000) - 3_600,
      }),
      body: Buffer.alloc(0),
    });
    expect(stale).toMatchObject({ decision: 'deny', status: 403 });
    expect(resolveSpy).not.toHaveBeenCalled();

    const replayableHeaders = () => signedHeaders({
      companionId: COMPANION_A,
      innerTarget: '/api/admin/dashboard',
      jti: 'replayed-jti',
    });
    const request = {
      rawTarget: `/companions/${COMPANION_A}/garden/api/admin/dashboard`,
      method: 'GET',
      body: Buffer.alloc(0),
    };
    const first = await controlPlane.admit({ ...request, headers: replayableHeaders() });
    expect(first).toMatchObject({ decision: 'allow' });
    const replayed = await controlPlane.admit({ ...request, headers: replayableHeaders() });
    expect(replayed).toMatchObject({ decision: 'deny', status: 409 });
    expect(resolveSpy).toHaveBeenCalledTimes(1);
  });

  it('denies a verified capability whose companion is missing from the registry', async () => {
    const { plane: controlPlane } = plane();
    const denied = await controlPlane.admit({
      rawTarget: `/companions/${COMPANION_UNREGISTERED}/garden/api/admin/dashboard`,
      method: 'GET',
      headers: signedHeaders({
        companionId: COMPANION_UNREGISTERED,
        innerTarget: '/api/admin/dashboard',
        jti: 'unregistered-jti',
      }),
      body: Buffer.alloc(0),
    });
    expect(denied).toEqual({ decision: 'deny', status: 404, message: 'Not found' });
  });

  it('isolates simultaneous requests for companions A and B', async () => {
    const replay = new DeferredReplayPort();
    const { plane: controlPlane } = plane({ replay });
    const admitA = controlPlane.admit({
      rawTarget: `/companions/${COMPANION_A}/garden/api/admin/dashboard`,
      method: 'GET',
      headers: signedHeaders({
        companionId: COMPANION_A,
        innerTarget: '/api/admin/dashboard',
        jti: 'concurrent-a',
      }),
      body: Buffer.alloc(0),
    });
    const admitB = controlPlane.admit({
      rawTarget: `/companions/${COMPANION_B}/garden/api/admin/dashboard`,
      method: 'GET',
      headers: signedHeaders({
        companionId: COMPANION_B,
        innerTarget: '/api/admin/dashboard',
        jti: 'concurrent-b',
      }),
      body: Buffer.alloc(0),
    });
    await waitFor(() => replay.pending.length === 2);
    // Complete B's slow-in-flight admission first, then A's: neither may
    // inherit the other's target, context, or authority.
    replay.pending[1]!.release();
    replay.pending[0]!.release();
    const [resultA, resultB] = await Promise.all([admitA, admitB]);

    expect(resultA).toMatchObject({
      decision: 'allow',
      companionId: COMPANION_A,
      verified: { audience: `operator:${COMPANION_A}` },
      context: { resource: { companionId: COMPANION_A } },
      upstream: { companionId: COMPANION_A, endpoint: { socketPath: '/run/garden-admin-a.sock' } },
    });
    expect(resultB).toMatchObject({
      decision: 'allow',
      companionId: COMPANION_B,
      verified: { audience: `operator:${COMPANION_B}` },
      context: { resource: { companionId: COMPANION_B } },
      upstream: { companionId: COMPANION_B, endpoint: { socketPath: '/run/garden-admin-b.sock' } },
    });
  });

  it('keeps confirmation resolution companion-bound and rejects ADMIN_TOKEN authority', async () => {
    const { plane: controlPlane, registry: targets } = plane();
    const resolveSpy = vi.spyOn(targets, 'resolve');
    const body = Buffer.from(JSON.stringify({ id: 'confirmation-1', decision: 'approve' }));
    const confirmationHeaders = (jti: string) => signedHeaders({
      companionId: COMPANION_A,
      innerTarget: '/api/admin/confirmations/resolve',
      method: 'POST',
      body,
      jti,
      extraHeaders: { 'content-type': 'application/json' },
    });

    // A shared admin token is never fleet authority: bearer/cookie caller
    // authority denies even alongside a valid companion-bound capability.
    for (const extraHeaders of [
      { authorization: 'Bearer fleet-wide-admin-token' },
      { cookie: 'psfn_token=fleet-wide-admin-token' },
    ]) {
      const denied = await controlPlane.admit({
        rawTarget: `/companions/${COMPANION_A}/garden/api/admin/confirmations/resolve`,
        method: 'POST',
        headers: { ...confirmationHeaders('admin-token-jti'), ...extraHeaders },
        body,
      });
      expect(denied).toMatchObject({ decision: 'deny', status: 400 });
    }
    expect(resolveSpy).not.toHaveBeenCalled();

    // The same request admits only through the exact companion-bound
    // capability, and the admitted authority is scoped to that companion.
    const admitted = await controlPlane.admit({
      rawTarget: `/companions/${COMPANION_A}/garden/api/admin/confirmations/resolve`,
      method: 'POST',
      headers: confirmationHeaders('confirmation-jti'),
      body,
    });
    expect(admitted).toMatchObject({
      decision: 'allow',
      companionId: COMPANION_A,
      verified: { audience: `operator:${COMPANION_A}`, action: 'confirmations.manage' },
      context: { action: 'confirmations.manage', resource: { companionId: COMPANION_A } },
    });

    // The identical signed confirmation capability cannot resolve companion
    // B's confirmations.
    const crossed = await controlPlane.admit({
      rawTarget: `/companions/${COMPANION_B}/garden/api/admin/confirmations/resolve`,
      method: 'POST',
      headers: confirmationHeaders('crossed-confirmation-jti'),
      body,
    });
    expect(crossed).toMatchObject({ decision: 'deny', status: 403 });
  });

  it('admits declared public routes without authority and without target resolution', async () => {
    const { plane: controlPlane, registry: targets } = plane();
    const resolveSpy = vi.spyOn(targets, 'resolve');
    const admitted = await controlPlane.admit({
      rawTarget: `/companions/${COMPANION_A}/garden/health`,
      method: 'GET',
      headers: {},
      body: Buffer.alloc(0),
    });
    expect(admitted).toMatchObject({
      decision: 'allow',
      kind: 'public',
      companionId: COMPANION_A,
      upstream: null,
      context: { kind: 'public' },
    });
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it('reports readiness per registered target from the separated health state', () => {
    const targets = registry();
    const { plane: controlPlane } = plane({ registry: targets });
    expect(controlPlane.probe()).toMatchObject({ status: 'unready' });

    targets.reportHealth(COMPANION_A, { status: 'ready', probedAt: '2030-01-01T00:00:00.000Z' });
    expect(controlPlane.probe()).toMatchObject({ status: 'unready' });

    targets.reportHealth(COMPANION_B, { status: 'ready', probedAt: '2030-01-01T00:00:00.000Z' });
    const probe = controlPlane.probe();
    expect(probe.status).toBe('ready');
    expect(probe.targets.map(target => target.companionId)).toEqual([COMPANION_A, COMPANION_B]);
  });
});
