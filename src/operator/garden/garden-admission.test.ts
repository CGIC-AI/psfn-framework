import { generateKeyPairSync } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createCompanionId } from '../../shared/routing/companion-id.js';
import {
  compileGatewayGardenRequestTarget,
} from '../../boundary/fleet-auth/request-capability-target.js';
import {
  createGatewayRequestCapabilitySigner,
  createRequestCapabilityVerifier,
  type RequestCapabilityAuthorityVersions,
} from '../../boundary/fleet-auth/request-capability.js';
import {
  admitFleetGardenRequest,
  buildGardenCapabilityHeaders,
  InMemoryRequestCapabilityReplayPort,
  resolveGardenAdmissionMode,
  type FleetPrincipalGardenAdmission,
  type GardenCapabilityContext,
} from './garden-admission.js';
import {
  clearDiagnosticLogRingBufferForTests,
  getRecentDiagnosticLogRecords,
} from '../../shared/logger.js';

const COMPANION_ID = createCompanionId('11111111-1111-4111-8111-111111111111');
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
const AUTH_CONTEXT = Object.freeze({
  principalId: 'principal-a', provider: 'discord' as const, providerSubjectId: '12345678901234567',
  companionId: COMPANION_ID, contactBindingId: 'binding-a', contactId: 'contact-a',
  operatorGrantId: 'grant-a', role: 'admin' as const, sessionRecordId: 'session-a',
  sessionAssurance: 'oauth' as const, fleetAccessMode: 'multi_admin' as const,
  authorizationEventId: 'event-a',
  resolvedAt: '2030-01-01T00:00:00.000Z',
});
const TESTING_HARNESS_AUTH_CONTEXT = Object.freeze({
  ...AUTH_CONTEXT,
  principalId: 'testing-harness',
  provider: 'testing_harness' as const,
  providerSubjectId: 'testing-harness',
  contactBindingId: 'testing-harness-binding',
  contactId: 'testing-harness-contact',
  operatorGrantId: 'testing-harness-garden-grant',
  sessionRecordId: 'testing-harness-session',
});
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

function signer(jti: string) {
  return createGatewayRequestCapabilitySigner({
    issuer: 'fleet-auth',
    kid: 'active',
    privateKeyPem,
    ttlSeconds: 30,
    generateJti: () => jti,
  });
}

function target(rawTarget = '/api/admin/dashboard', method = 'GET', body = Buffer.alloc(0)) {
  return compileGatewayGardenRequestTarget({
    rawTarget,
    method,
    companionId: COMPANION_ID,
    body,
  });
}

function context(parent?: GardenCapabilityContext['parent']): GardenCapabilityContext {
  return Object.freeze({
    requestId: REQUEST_ID,
    decisionId: DECISION_ID,
    versions: VERSIONS,
    ...(parent ? { parent } : {}),
  });
}

function admission(
  audience: 'operator' | 'agent',
  testingHarnessEnabled = false,
): FleetPrincipalGardenAdmission {
  return {
    kind: 'fleet-principal',
    audience,
    companionId: COMPANION_ID,
    verifier,
    replay: new InMemoryRequestCapabilityReplayPort(),
    ...(testingHarnessEnabled ? { testingHarness: { enabled: true } } : {}),
  };
}

describe('discriminated Garden admission', () => {
  it('keeps standalone-token startup selection separate from fleet-principal selection', () => {
    const standaloneCredential = ['must', 'be', 'ignored'].join('-');
    expect(resolveGardenAdmissionMode({
      audience: 'operator',
      token: 'standalone',
    })).toEqual({ kind: 'standalone-token', token: 'standalone' });

    const selected = resolveGardenAdmissionMode({
      audience: 'operator',
      token: standaloneCredential,
      companionId: COMPANION_ID,
      fleetAuthVerifier: {
        kind: 'verifier',
        enabled: true,
        canonicalOrigin: 'https://fleet.example.test',
        requestCapabilities: {
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
        },
        hubDeviceAssertions: {
          issuer: 'hub',
          audience: 'fleet',
          maxTtlSeconds: 60,
          clockSkewSeconds: 2,
          keys: [],
        },
      },
    });
    expect(selected.kind).toBe('fleet-principal');
    expect('token' in selected).toBe(false);
  });

  it('admits an exact operator capability, strips all caller authority, and consumes replay once', async () => {
    const compiled = target();
    const token = signer('operator-once').signOperator({
      target: compiled,
      requestId: REQUEST_ID,
      decisionId: DECISION_ID,
      authContext: AUTH_CONTEXT,
      versions: VERSIONS,
    });
    const headers: IncomingHttpHeaders = {
      ...buildGardenCapabilityHeaders({ token, context: context() }),
      accept: 'application/json',
    };
    const mode = admission('operator');
    const first = await admitFleetGardenRequest({
      admission: mode,
      rawTarget: compiled.canonicalRequestTarget,
      method: compiled.method,
      headers,
      body: compiled.body,
    });
    expect(first).toMatchObject({
      decision: 'allow',
      verified: { audience: `operator:${COMPANION_ID}`, action: 'garden.read' },
    });
    expect(headers).not.toHaveProperty('x-psfn-request-capability');

    const retry = await admitFleetGardenRequest({
      admission: mode,
      rawTarget: compiled.canonicalRequestTarget,
      method: compiled.method,
      headers: { ...buildGardenCapabilityHeaders({ token, context: context() }) },
      body: compiled.body,
    });
    expect(retry).toEqual({
      decision: 'deny',
      status: 409,
      message: 'Fleet Garden capability already consumed',
    });
  });

  it('accepts testing_harness capabilities only behind the independent Garden verifier flag', async () => {
    const compiled = target('/api/admin/settings/backup', 'POST', Buffer.from('configJson=%7B%7D'));
    const token = signer('testing-harness-once').signTestingHarness({
      target: compiled,
      requestId: REQUEST_ID,
      decisionId: DECISION_ID,
      authContext: TESTING_HARNESS_AUTH_CONTEXT,
      versions: VERSIONS,
    });
    const authorityHeaders = () => ({
      ...buildGardenCapabilityHeaders({ token, context: context() }),
      'content-type': 'application/x-www-form-urlencoded',
    });

    await expect(admitFleetGardenRequest({
      admission: admission('operator'),
      rawTarget: compiled.canonicalRequestTarget,
      method: compiled.method,
      headers: authorityHeaders(),
      body: compiled.body,
    })).resolves.toMatchObject({ decision: 'deny', status: 403 });

    const enabledAdmission = admission('operator', true);
    await expect(admitFleetGardenRequest({
      admission: enabledAdmission,
      rawTarget: compiled.canonicalRequestTarget,
      method: compiled.method,
      headers: authorityHeaders(),
      body: compiled.body,
    })).resolves.toMatchObject({
      decision: 'allow',
      verified: {
        authContext: {
          principalId: 'testing-harness',
          provider: 'testing_harness',
          sessionAssurance: 'oauth',
          fleetAccessMode: 'multi_admin',
        },
      },
    });

    await expect(admitFleetGardenRequest({
      admission: enabledAdmission,
      rawTarget: compiled.canonicalRequestTarget,
      method: compiled.method,
      headers: authorityHeaders(),
      body: compiled.body,
    })).resolves.toEqual({
      decision: 'deny',
      status: 409,
      message: 'Fleet Garden capability already consumed',
    });
  });

  it('rejects legacy/query/header bypasses and makes feature-off login absent', async () => {
    const mode = admission('operator');
    for (const request of [
      { rawTarget: '/api/admin/dashboard', headers: { authorization: 'Bearer legacy' } },
      { rawTarget: '/api/admin/dashboard', headers: { cookie: 'psfn_token=legacy' } },
      { rawTarget: '/api/admin/dashboard?token=legacy', headers: {} },
      { rawTarget: '/api/admin/dashboard', headers: { 'x-psfn-role': 'owner' } },
      { rawTarget: '/api/admin/dashboard', headers: { 'x-root-id': 'forged-root' } },
      {
        rawTarget: '/api/admin/dashboard',
        headers: { 'x-companion-shared-workspace-credential': 'reusable' },
      },
    ]) {
      const result = await admitFleetGardenRequest({
        admission: mode,
        rawTarget: request.rawTarget,
        method: 'GET',
        headers: request.headers,
        body: Buffer.alloc(0),
      });
      expect(result.decision).toBe('deny');
    }

    const login = await admitFleetGardenRequest({
      admission: mode,
      rawTarget: '/login',
      method: 'POST',
      headers: {
        authorization: 'Bearer legacy',
        cookie: 'psfn_token=legacy; psfn_garden_session=browser',
      },
      body: Buffer.from('token=legacy'),
    });
    expect(login).toEqual({
      decision: 'deny',
      status: 400,
      message: 'Browser authority headers are forbidden',
    });
  });

  it('admits only a linked agent child and rejects an operator parent at the agent hop', async () => {
    const compiled = target();
    const parentToken = signer('parent-jti').signOperator({
      target: compiled,
      requestId: REQUEST_ID,
      decisionId: DECISION_ID,
      authContext: AUTH_CONTEXT,
      versions: VERSIONS,
    });
    const parentVerified = verifier.verifyOperator({
      token: parentToken,
      target: compiled,
      requestId: REQUEST_ID,
      decisionId: DECISION_ID,
      authContext: AUTH_CONTEXT,
      versions: VERSIONS,
    });
    const parent = Object.freeze({
      audience: parentVerified.audience as `operator:${string}`,
      requestId: parentVerified.requestId,
      decisionId: parentVerified.decisionId,
      jti: parentVerified.jti,
      targetDigest: parentVerified.targetDigest,
    });
    const childToken = signer('child-jti').signAgent({
      target: compiled,
      requestId: REQUEST_ID,
      decisionId: DECISION_ID,
      authContext: AUTH_CONTEXT,
      versions: VERSIONS,
      parent,
    });

    const allowed = await admitFleetGardenRequest({
      admission: admission('agent'),
      rawTarget: compiled.canonicalRequestTarget,
      method: compiled.method,
      headers: { ...buildGardenCapabilityHeaders({ token: childToken, context: context(parent) }) },
      body: compiled.body,
    });
    expect(allowed).toMatchObject({
      decision: 'allow',
      verified: { audience: `agent:${COMPANION_ID}`, parent },
    });

    const denied = await admitFleetGardenRequest({
      admission: admission('agent'),
      rawTarget: compiled.canonicalRequestTarget,
      method: compiled.method,
      headers: { ...buildGardenCapabilityHeaders({ token: parentToken, context: context() }) },
      body: compiled.body,
    });
    expect(denied).toMatchObject({ decision: 'deny', status: 403 });
  });

  it('rejects a signed capability when method, path, companion resource, or body changes', async () => {
    const body = Buffer.from('{"favorite":true}');
    const compiled = target('/api/admin/images/generated/image-a', 'PATCH', body);
    const token = signer('bound-jti').signOperator({
      target: compiled,
      requestId: REQUEST_ID,
      decisionId: DECISION_ID,
      authContext: AUTH_CONTEXT,
      versions: VERSIONS,
    });
    const authorityHeaders = () => ({
      ...buildGardenCapabilityHeaders({ token, context: context() }),
      'content-type': 'application/json',
    });
    for (const mutation of [
      { rawTarget: '/api/admin/images/generated/image-b', method: 'PATCH', body },
      { rawTarget: compiled.canonicalRequestTarget, method: 'DELETE', body: Buffer.alloc(0) },
      { rawTarget: compiled.canonicalRequestTarget, method: 'PATCH', body: Buffer.from('{"favorite":false}') },
    ]) {
      const result = await admitFleetGardenRequest({
        admission: admission('operator'),
        headers: authorityHeaders(),
        ...mutation,
      });
      expect(result).toMatchObject({ decision: 'deny' });
    }
  });

  it('logs a body-forbidden denial with route, reason code, action, and safe principal fallback', async () => {
    clearDiagnosticLogRingBufferForTests();

    const result = await admitFleetGardenRequest({
      admission: admission('operator'),
      rawTarget: '/api/admin/dashboard',
      method: 'GET',
      headers: {},
      body: Buffer.from('{}'),
    });

    expect(result).toMatchObject({ decision: 'deny', status: 400 });
    expect(getRecentDiagnosticLogRecords()).toContainEqual(expect.objectContaining({
      message: 'Fleet Garden request denied',
      component: 'GardenAdmission',
      context: expect.objectContaining({
        reasonCode: 'request_body_forbidden',
        routeId: 'GET /api/admin/dashboard',
        action: 'garden.read',
        principalId: 'unknown',
        status: 400,
      }),
    }));
  });
});
