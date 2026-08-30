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
  role: 'admin' as const, sessionRecordId: 'session-a', sessionAssurance: 'escalated' as const,
  fleetAccessMode: 'multi_admin' as const,
  authorizationEventId: 'event-a', resolvedAt: '2030-01-01T00:00:00.000Z',
});
const testingHarnessAuthContext = Object.freeze({
  principalId: 'testing-harness', provider: 'testing_harness' as const,
  providerSubjectId: 'testing-harness', companionId,
  contactBindingId: `testing-harness-binding-${companionId}`,
  contactId: `testing-harness-contact-${companionId}`,
  operatorGrantId: 'testing-harness-admin', role: 'admin' as const,
  sessionRecordId: `testing-harness-session-${companionId}`,
  sessionAssurance: 'escalated' as const,
  fleetAccessMode: 'multi_admin' as const,
  authorizationEventId: 'event-harness', resolvedAt: '2030-01-01T00:00:00.000Z',
});
const adminTokenAuthContext = Object.freeze({
  principalId: 'admin-token-operator', provider: 'admin_token' as const,
  providerSubjectId: 'admin-token', companionId,
  contactBindingId: `admin-token-binding-${companionId}`,
  contactId: `admin-token-contact-${companionId}`,
  operatorGrantId: `admin-token-grant-${companionId}`, role: 'owner' as const,
  sessionRecordId: `admin-token-session-${companionId}`,
  sessionAssurance: 'break_glass' as const,
  fleetAccessMode: 'sole_admin' as const,
  authorizationEventId: 'event-admin-token', resolvedAt: '2030-01-01T00:00:00.000Z',
});

function fixture(
  authorityDecision: 'allow' | 'deny' = 'allow',
  provider: 'discord' | 'admin_token' | 'testing_harness' = 'discord',
) {
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
    rawTarget: provider === 'testing_harness'
      ? '/api/admin/settings'
      : '/api/admin/images/generated?q=cat',
    method: 'GET',
    companionId,
    body: Buffer.alloc(0),
  });
  const childTarget = compileGatewayGardenRequestTarget({
    rawTarget: provider === 'testing_harness'
      ? '/api/admin/settings'
      : '/api/admin/images/generated/image-a',
    method: provider === 'testing_harness' ? 'GET' : 'PATCH',
    companionId,
    body: provider === 'testing_harness'
      ? Buffer.alloc(0)
      : Buffer.from('{"favorite":true}'),
    ...(provider === 'testing_harness'
      ? {}
      : { headers: { 'content-type': 'application/json' } }),
  });
  const parentBinding = {
    target: parentTarget,
    requestId: randomUUID(),
    decisionId: randomUUID(),
    authContext: provider === 'testing_harness'
      ? testingHarnessAuthContext
      : provider === 'admin_token'
        ? adminTokenAuthContext
        : authContext,
    versions,
  };
  const parentToken = provider === 'testing_harness'
    ? signer.signTestingHarness(parentBinding)
    : signer.signOperator(parentBinding);
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
    ...(provider === 'testing_harness'
      ? {
          testingHarness: {
            enabled: true as const,
            principalId: 'testing-harness',
            operatorGrantId: 'testing-harness-admin',
            role: 'admin' as const,
            allowedActions: ['settings.read'] as const,
          },
        }
      : {}),
  });
  const input = {
    operator: provider === 'testing_harness'
      ? {
          kind: 'testing_harness_provider' as const,
          provider: 'testing_harness' as const,
          audience: 'testing-harness',
          companionId,
        }
      : {
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
    signer,
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

  it('accepts a configured testing-harness parent and signs an action-bounded child', async () => {
    const built = fixture('allow', 'testing_harness');

    const result = await built.broker.exchange(built.input);

    expect(built.replay.consume).toHaveBeenCalledOnce();
    expect(built.authority.reauthorize).not.toHaveBeenCalled();
    const verified = built.verifier.verifyAgent({
      token: result.token,
      target: built.childTarget,
      requestId: result.requestId,
      decisionId: result.decisionId,
      versions,
      parent: result.parent,
      nowSeconds: NOW,
    });
    expect(verified).toMatchObject({
      audience: `agent:${companionId}`,
      action: 'settings.read',
      parent: expect.objectContaining({ audience: 'testing-harness' }),
      authContext: {
        provider: 'testing_harness',
        principalId: 'testing-harness',
      },
    });
  });

  it('carries a gateway-authenticated ADMIN_TOKEN parent into an agent child without SSO reauthorization', async () => {
    const built = fixture('deny', 'admin_token');

    const result = await built.broker.exchange(built.input);

    expect(built.replay.consume).toHaveBeenCalledOnce();
    expect(built.authority.reauthorize).not.toHaveBeenCalled();
    const verified = built.verifier.verifyAgent({
      token: result.token,
      target: built.childTarget,
      requestId: result.requestId,
      decisionId: result.decisionId,
      versions,
      parent: result.parent,
      nowSeconds: NOW,
    });
    expect(verified).toMatchObject({
      audience: `agent:${companionId}`,
      authContext: {
        provider: 'admin_token',
        principalId: 'admin-token-operator',
      },
    });
    expect(JSON.stringify(result)).not.toContain(built.parentToken);
  });

  it('denies a testing-harness parent when verifier-side enablement is absent', async () => {
    const built = fixture('allow', 'testing_harness');
    const broker = new GatewayFleetAuthChildAssertionBroker({
      signer: built.signer,
      verifier: built.verifier,
      replay: built.replay,
      authority: built.authority,
    });

    await expect(broker.exchange(built.input)).rejects
      .toBeInstanceOf(GatewayChildAssertionDeniedError);
    expect(built.replay.consume).not.toHaveBeenCalled();
    expect(built.authority.reauthorize).not.toHaveBeenCalled();
  });

  it('denies a testing-harness parent when provider identity is omitted or mismatched', async () => {
    const built = fixture('allow', 'testing_harness');

    await expect(built.broker.exchange({
      ...built.input,
      operator: {
        kind: 'operator_process',
        operatorId: `operator:${companionId}`,
        companionId,
      },
    })).rejects.toBeInstanceOf(GatewayChildAssertionDeniedError);
    await expect(built.broker.exchange({
      ...built.input,
      operator: {
        kind: 'testing_harness_provider',
        provider: 'testing_harness',
        audience: 'other-principal',
        companionId,
      },
    })).rejects.toBeInstanceOf(GatewayChildAssertionDeniedError);
    expect(built.replay.consume).not.toHaveBeenCalled();
    expect(built.authority.reauthorize).not.toHaveBeenCalled();
  });

  it('denies a testing-harness child whose action is wider than the configured allowlist', async () => {
    const built = fixture('allow', 'testing_harness');
    const widenedTarget = compileGatewayGardenRequestTarget({
      rawTarget: '/api/admin/settings',
      method: 'PATCH',
      companionId,
      body: Buffer.from('{"activeTimezone":"UTC"}'),
      headers: { 'content-type': 'application/json' },
    });

    await expect(built.broker.exchange({
      ...built.input,
      child: { ...built.input.child, target: widenedTarget },
    })).rejects.toBeInstanceOf(GatewayChildAssertionDeniedError);
    expect(built.replay.consume).not.toHaveBeenCalled();
    expect(built.authority.reauthorize).not.toHaveBeenCalled();
  });

  it('denies a replayed testing-harness parent before signing another child', async () => {
    const built = fixture('allow', 'testing_harness');
    vi.mocked(built.replay.consume).mockImplementation(async input => ({
      outcome: 'replayed',
      result: input.consumeResult,
    }));

    await expect(built.broker.exchange(built.input)).rejects
      .toBeInstanceOf(GatewayChildAssertionDeniedError);
    expect(built.authority.reauthorize).not.toHaveBeenCalled();
  });

  it('preserves the operator parent idempotent-replay exchange behavior', async () => {
    const built = fixture();
    vi.mocked(built.replay.consume).mockImplementation(async input => ({
      outcome: 'replayed',
      result: input.consumeResult,
    }));

    await expect(built.broker.exchange(built.input)).resolves.toMatchObject({
      target: built.childTarget,
      decisionId: built.childDecisionId,
    });
    expect(built.authority.reauthorize).toHaveBeenCalledOnce();
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
