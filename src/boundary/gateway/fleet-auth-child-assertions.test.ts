import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createCompanionId } from '../../shared/routing/companion-id.js';
import { compileGatewayGardenRequestTarget } from '../fleet-auth/request-capability-target.js';
import {
  createGatewayRequestCapabilitySigner,
  createRequestCapabilityVerifier,
  type RequestCapabilityAuthorityVersions,
} from '../fleet-auth/request-capability.js';
import type { RequestCapabilityReplayPort } from '../fleet-auth/request-capability-replay.js';
import {
  GatewayChildAssertionDeniedError,
  GatewayFleetAuthChildAssertionBroker,
  type GatewayChildAssertionAuthorityPort,
} from './fleet-auth-child-assertions.js';

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
  role: 'admin' as const, sessionRecordId: 'session-a', sessionAssurance: 'webauthn_uv' as const,
  authorizationEventId: 'event-a', resolvedAt: '2030-01-01T00:00:00.000Z',
});

function fixture(authorityDecision: 'allow' | 'deny' = 'allow') {
  const pair = generateKeyPairSync('ed25519');
  const ids = ['operator-jti', 'agent-jti'];
  const signer = createGatewayRequestCapabilitySigner({
    issuer: 'fleet-auth',
    kid: 'active-key',
    privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    ttlSeconds: 30,
    nowSeconds: () => NOW,
    generateJti: () => ids.shift() ?? randomUUID(),
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
  const parentTarget = compileGatewayGardenRequestTarget({
    rawTarget: '/api/admin/images/generated?q=cat',
    method: 'GET',
    companionId,
    body: Buffer.alloc(0),
  });
  const childTarget = compileGatewayGardenRequestTarget({
    rawTarget: '/api/admin/images/generated/image-a',
    method: 'PATCH',
    companionId,
    body: Buffer.from('{"favorite":true}'),
    headers: { 'content-type': 'application/json' },
  });
  const parentBinding = {
    target: parentTarget,
    requestId: randomUUID(),
    decisionId: randomUUID(),
    authContext,
    versions,
  };
  const parentToken = signer.signOperator(parentBinding);
  const replay: RequestCapabilityReplayPort = {
    consume: vi.fn(async input => ({ outcome: 'consumed', result: input.consumeResult })),
  };
  const childDecisionId = randomUUID();
  const authority: GatewayChildAssertionAuthorityPort = {
    reauthorize: vi.fn(async () => authorityDecision === 'allow'
      ? { decision: 'allow', decisionId: childDecisionId, versions }
      : { decision: 'deny' }),
  };
  const broker = new GatewayFleetAuthChildAssertionBroker({
    signer,
    verifier,
    replay,
    authority,
  });
  const input = {
    operator: {
      kind: 'operator_process' as const,
      operatorId: `operator:${companionId}` as const,
      companionId,
    },
    parent: { token: parentToken, ...parentBinding, nowSeconds: NOW },
    child: { target: childTarget, requestId: randomUUID() },
  };
  return {
    authority,
    broker,
    childDecisionId,
    childTarget,
    input,
    parentBinding,
    parentToken,
    replay,
    verifier,
  };
}

describe('GatewayFleetAuthChildAssertionBroker', () => {
  it('consumes and freshly reauthorizes the exact parent before signing a linked agent child', async () => {
    const built = fixture();
    const result = await built.broker.exchange(built.input);

    expect(built.replay.consume).toHaveBeenCalledOnce();
    expect(built.authority.reauthorize).toHaveBeenCalledWith(expect.objectContaining({
      parentTarget: built.input.parent.target,
      childTarget: built.childTarget,
      parent: expect.objectContaining({ audience: `operator:${companionId}` }),
    }));
    const verified = built.verifier.verifyAgent({
      token: result.token,
      target: built.childTarget,
      requestId: result.requestId,
      decisionId: built.childDecisionId,
      versions,
      parent: result.parent,
      nowSeconds: NOW,
    });
    expect(verified).toMatchObject({
      audience: `agent:${companionId}`,
      parent: result.parent,
    });
    expect(() => built.verifier.verifyOperator({
      token: result.token,
      target: built.childTarget,
      requestId: result.requestId,
      decisionId: built.childDecisionId,
      versions,
      nowSeconds: NOW,
    })).toThrow();
    expect(JSON.stringify(result)).not.toContain(built.parentToken);
  });

  it('denies stale authority and never signs a child', async () => {
    const built = fixture('deny');
    await expect(built.broker.exchange(built.input)).rejects
      .toBeInstanceOf(GatewayChildAssertionDeniedError);
  });

  it('denies a child when any authority version changes during reauthorization', async () => {
    const built = fixture();
    vi.mocked(built.authority.reauthorize).mockResolvedValue({
      decision: 'allow',
      decisionId: randomUUID(),
      versions: Object.freeze({
        ...versions,
        sessionAuthzVersion: versions.sessionAuthzVersion + 1,
      }),
    });

    await expect(built.broker.exchange(built.input)).rejects
      .toBeInstanceOf(GatewayChildAssertionDeniedError);
  });

  it('denies a caller-selected operator identity before consuming the parent', async () => {
    const built = fixture();
    await expect(built.broker.exchange({
      ...built.input,
      operator: { ...built.input.operator, operatorId: 'operator:other' },
    })).rejects.toBeInstanceOf(GatewayChildAssertionDeniedError);
    expect(built.replay.consume).not.toHaveBeenCalled();
  });
});
