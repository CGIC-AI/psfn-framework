import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { compileGatewayGardenRequestTarget } from '../../boundary/fleet-auth/request-capability-target.js';
import {
  createGatewayRequestCapabilitySigner,
  createRequestCapabilityVerifier,
  type RequestCapabilityAuthorityVersions,
} from '../../boundary/fleet-auth/request-capability.js';
import { createCompanionId } from '../../shared/routing/companion-id.js';
import { createGardenFleetChildAssertionClient } from './fleet-child-assertion-client.js';

const COMPANION_ID = createCompanionId('11111111-1111-4111-8111-111111111111');
const VERSIONS: RequestCapabilityAuthorityVersions = Object.freeze({
  authorityGeneration: 2,
  globalAuthEpoch: 3,
  sessionAuthnVersion: 5,
  sessionAuthzVersion: 7,
  bindingVersion: 11,
  grantVersion: 13,
  policyVersion: 17,
});
const keyPair = generateKeyPairSync('ed25519');
const privateKeyPem = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicKeyPem = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const target = compileGatewayGardenRequestTarget({
  rawTarget: '/api/admin/dashboard',
  method: 'GET',
  companionId: COMPANION_ID,
  body: Buffer.alloc(0),
});
const requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const decisionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const token = createGatewayRequestCapabilitySigner({
  issuer: 'fleet-auth',
  kid: 'active',
  privateKeyPem,
  ttlSeconds: 30,
  generateJti: () => 'parent-jti',
}).signOperator({
  target,
  requestId,
  decisionId,
  versions: VERSIONS,
  authContext: {
    principalId: 'principal-1',
    provider: 'discord',
    providerSubjectId: '12345678901234567',
    companionId: COMPANION_ID,
    contactBindingId: 'binding-1',
    contactId: 'contact-1',
    operatorGrantId: 'grant-1',
    role: 'admin',
    sessionRecordId: 'session-1',
    sessionAssurance: 'webauthn_uv',
    authorizationEventId: 'event-1',
    resolvedAt: '2030-01-01T00:00:00.000Z',
  },
});
const parentVerified = createRequestCapabilityVerifier({
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
}).verifyOperator({ token, target, requestId, decisionId, versions: VERSIONS });
const harnessToken = createGatewayRequestCapabilitySigner({
  issuer: 'fleet-auth',
  kid: 'active',
  privateKeyPem,
  ttlSeconds: 30,
  generateJti: () => 'harness-parent-jti',
}).signTestingHarness({
  target,
  requestId,
  decisionId,
  versions: VERSIONS,
  authContext: {
    principalId: 'testing-harness',
    provider: 'testing_harness',
    providerSubjectId: 'testing-harness',
    companionId: COMPANION_ID,
    contactBindingId: `testing-harness-binding-${COMPANION_ID}`,
    contactId: `testing-harness-contact-${COMPANION_ID}`,
    operatorGrantId: 'testing-harness-admin',
    role: 'admin',
    sessionRecordId: `testing-harness-session-${COMPANION_ID}`,
    sessionAssurance: 'webauthn_uv',
    authorizationEventId: 'harness-event',
    resolvedAt: '2030-01-01T00:00:00.000Z',
  },
});
const harnessParentVerified = createRequestCapabilityVerifier({
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
}).verifyTestingHarness({ token: harnessToken, target, requestId, decisionId, versions: VERSIONS });

function exchangeResponse(
  bodyValue: BodyInit | null | undefined,
  override: Record<string, unknown> = {},
  verified = parentVerified,
): Response {
  const body = JSON.parse(String(bodyValue)) as {
    child: { requestId: string };
  };
  return new Response(JSON.stringify({
    schemaVersion: 1,
    token: 'agent-child-token',
    audience: `agent:${COMPANION_ID}`,
    requestId: body.child.requestId,
    decisionId,
    targetDigest: target.targetDigest,
    versions: VERSIONS,
    parent: {
      audience: verified.audience,
      requestId: verified.requestId,
      decisionId: verified.decisionId,
      jti: verified.jti,
      targetDigest: verified.targetDigest,
    },
    ...override,
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function exchange(fetchImpl: typeof fetch) {
  return createGardenFleetChildAssertionClient('http://127.0.0.1:10000/v1', fetchImpl).exchange({
    parentToken: token,
    parentContext: { requestId, decisionId, versions: VERSIONS },
    parentVerified,
    target,
    expectedAgentAudience: `agent:${COMPANION_ID}`,
  });
}

function exchangeHarness(fetchImpl: typeof fetch) {
  return createGardenFleetChildAssertionClient('http://127.0.0.1:10000/v1', fetchImpl).exchange({
    parentToken: harnessToken,
    parentContext: { requestId, decisionId, versions: VERSIONS },
    parentVerified: harnessParentVerified,
    target,
    expectedAgentAudience: `agent:${COMPANION_ID}`,
    providerIdentity: {
      provider: 'testing_harness',
      audience: 'testing-harness',
    },
  });
}

describe('createGardenFleetChildAssertionClient', () => {
  it('appends the route to a /v1 base without duplicating the version segment', async () => {
    // GATEWAY_OPERATOR_API_BASE_URL ends in /v1 in both the Helm chart and the
    // local launcher; the gateway serves /v1/internal/fleet-auth/child-assertions.
    let requestedUrl: string | undefined;
    await exchange(async (input, init) => {
      requestedUrl = String(input);
      return exchangeResponse(init?.body);
    });
    expect(requestedUrl).toBe('http://127.0.0.1:10000/v1/internal/fleet-auth/child-assertions');
  });

  it('accepts only a child response bound to the selected companion, target, and parent', async () => {
    const child = await exchange(async (_input, init) => (
      exchangeResponse(init?.body)
    ));
    expect(child).toMatchObject({
      token: 'agent-child-token',
      context: {
        requestId: expect.any(String),
        parent: {
          audience: `operator:${COMPANION_ID}`,
          jti: 'parent-jti',
          targetDigest: target.targetDigest,
        },
      },
    });

    for (const override of [
      { audience: 'agent:22222222-2222-4222-8222-222222222222' },
      { targetDigest: 'f'.repeat(64) },
      {
        parent: {
          audience: parentVerified.audience,
          requestId: parentVerified.requestId,
          decisionId: parentVerified.decisionId,
          jti: 'different-parent',
          targetDigest: parentVerified.targetDigest,
        },
      },
    ]) {
      await expect(exchange(async (_input, init) => (
        exchangeResponse(init?.body, override)
      ))).rejects.toThrow('Fleet child assertion response was invalid');
    }
  });

  it('adds a provider-scoped identity only for testing-harness parent exchanges', async () => {
    let operatorBody: Record<string, unknown> | undefined;
    let harnessBody: Record<string, unknown> | undefined;
    await exchange(async (_input, init) => {
      operatorBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return exchangeResponse(init?.body);
    });
    await exchangeHarness(async (_input, init) => {
      harnessBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return exchangeResponse(init?.body, {}, harnessParentVerified);
    });

    expect(operatorBody).not.toHaveProperty('providerIdentity');
    expect(harnessBody).toMatchObject({
      providerIdentity: {
        provider: 'testing_harness',
        audience: 'testing-harness',
      },
    });
  });
});
