import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createCompanionId } from '../../shared/routing/companion-id.js';
import { compileGatewayGardenRequestTarget } from './request-capability-target.js';
import {
  createGatewayRequestCapabilitySigner,
  createRequestCapabilityVerifier,
  type RequestCapabilityAuthorityVersions,
} from './request-capability.js';
import { compileRequestCapabilityReplayConsumption } from './request-capability-replay.js';

const NOW = 1_893_456_000;
const companionId = createCompanionId('11111111-1111-4111-8111-111111111111');
const versions: RequestCapabilityAuthorityVersions = Object.freeze({
  authorityGeneration: 2,
  globalAuthEpoch: 3,
  sessionAuthnVersion: 5,
  sessionAuthzVersion: 7,
  bindingVersion: 11,
  grantVersion: 13,
  policyVersion: 17,
});
const authContext = Object.freeze({
  principalId: 'principal-a', provider: 'discord' as const, providerSubjectId: '12345678901234567',
  companionId, contactBindingId: 'binding-a', contactId: 'contact-a', operatorGrantId: 'grant-a',
  role: 'admin' as const, sessionRecordId: 'session-a', sessionAssurance: 'oauth' as const,
  fleetAccessMode: 'multi_admin' as const,
  authorizationEventId: 'event-a', resolvedAt: '2030-01-01T00:00:00.000Z',
});

function fixture() {
  const pair = generateKeyPairSync('ed25519');
  const target = compileGatewayGardenRequestTarget({
    rawTarget: '/api/admin/images/generated?q=cat',
    method: 'GET',
    companionId,
    body: Buffer.alloc(0),
  });
  const signer = createGatewayRequestCapabilitySigner({
    issuer: 'fleet-auth',
    kid: 'active-key',
    privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    ttlSeconds: 30,
    nowSeconds: () => NOW,
    generateJti: () => 'replay-jti',
  });
  const verifier = createRequestCapabilityVerifier({
    issuer: 'fleet-auth',
    maxTtlSeconds: 30,
    keys: [{
      issuer: 'fleet-auth',
      kid: 'active-key',
      publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      notBefore: '2029-01-01T00:00:00.000Z',
      notAfter: '2031-01-01T00:00:00.000Z',
      status: 'active',
    }],
  });
  const binding = {
    target,
    requestId: randomUUID(),
    decisionId: randomUUID(),
    authContext,
    versions,
  };
  const token = signer.signOperator(binding);
  const verified = verifier.verifyOperator({ token, ...binding, nowSeconds: NOW });
  return { target, token, verified };
}

describe('request capability replay compiler', () => {
  it('binds the signed token and shared verified target fields without recompiling the digest', () => {
    const { target, token, verified } = fixture();
    const compiled = compileRequestCapabilityReplayConsumption({ token, verified, target });

    expect(compiled).toMatchObject({
      issuer: 'fleet-auth',
      jti: 'replay-jti',
      targetDigest: target.targetDigest,
      bodyDigest: target.bodyDigest,
      resourceDigest: target.resourceDigest,
      expiresAt: new Date((NOW + 30) * 1_000),
      consumeResult: {
        decision: 'allow',
        requestId: verified.requestId,
        decisionId: verified.decisionId,
        audience: `operator:${companionId}`,
      },
    });
    for (const digest of [
      compiled.capabilityDigest,
      compiled.audienceDigest,
      compiled.companionDigest,
      compiled.actionDigest,
      compiled.parentDigest,
      compiled.decisionDigest,
      compiled.authorityVersionsDigest,
    ]) expect(digest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('fails closed when a caller mixes verified authority with another target', () => {
    const { token, verified } = fixture();
    const changed = compileGatewayGardenRequestTarget({
      rawTarget: '/api/admin/settings',
      method: 'GET',
      companionId,
      body: Buffer.alloc(0),
    });
    expect(() => compileRequestCapabilityReplayConsumption({ token, verified, target: changed }))
      .toThrow(/does not match/u);
  });
});
