import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  assertVerifiedFleetAuthLifecycleDecision,
  digestVerifiedProviderProof,
  type VerifiedFleetAuthLifecycleDecision,
} from './authority-lifecycle-types.js';

const DIGEST = 'a'.repeat(64);

function principal(principalId = randomUUID()) {
  return {
    principalId,
    authnVersion: 1,
    authzVersion: 1,
    bindingVersion: 1,
    grantVersion: 1,
    policyVersion: 1,
  };
}

function provider(subjectId: string) {
  const proof = {
    provider: 'discord' as const,
    subjectId,
    callbackTransactionId: randomUUID(),
  };
  return { ...proof, proofDigest: digestVerifiedProviderProof(proof) };
}

function providerReplace(): VerifiedFleetAuthLifecycleDecision {
  const target = principal();
  const companionId = randomUUID();
  const contactId = 'contact-provider-replacement';
  const newProvider = provider('223456789012345678');
  return {
    verification: 'gateway_verified',
    action: 'provider.replace',
    decisionId: randomUUID(),
    ceremonyId: randomUUID(),
    actor: target,
    actorSession: {
      sessionId: randomUUID(),
      authnVersion: 1,
      authzVersion: 1,
      bindingVersion: 1,
      grantVersion: 1,
      policyVersion: 1,
      globalAuthEpoch: 1,
      provider: 'discord',
      providerSubjectId: '123456789012345678',
    },
    target,
    authorityGeneration: 1,
    globalAuthEpoch: 1,
    companionId,
    contactId,
    currentProvider: provider('123456789012345678'),
    newProvider,
    contactAuthority: {
      schemaVersion: 1,
      contactId,
      channel: 'discord',
      providerSubjectId: newProvider.subjectId,
      identityVersion: 2,
      verificationId: randomUUID(),
      verificationDigest: 'b'.repeat(64),
      contactAuthorityVersion: 3,
      ownershipState: 'verified',
      restoreState: 'live',
    },
    reasonDigest: DIGEST,
    decidedAt: new Date('2026-07-16T12:00:00.000Z'),
  };
}

describe('verified fleet-auth lifecycle decision contract', () => {
  it('accepts an exact current+new provider replacement proof', () => {
    expect(assertVerifiedFleetAuthLifecycleDecision(providerReplace()).action)
      .toBe('provider.replace');
  });

  it('rejects the retired provider-recovery action and an incomplete replacement proof', () => {
    expect(() => assertVerifiedFleetAuthLifecycleDecision({
      ...providerReplace(),
      action: 'provider.recover',
    })).toThrow(/action is unknown/u);
    expect(() => assertVerifiedFleetAuthLifecycleDecision({
      ...providerReplace(),
      currentProvider: undefined,
    })).toThrow();
  });

  it.each([
    ['unknown action', { ...providerReplace(), action: 'provider.swap' }],
    ['unknown field', { ...providerReplace(), providerSubjectId: '323456789012345678' }],
    ['substituted current subject', {
      ...providerReplace(),
      currentProvider: { ...provider('123456789012345678'), subjectId: '323456789012345678' },
    }],
    ['reused callback', (() => {
      const decision = providerReplace();
      return {
        ...decision,
        newProvider: {
          ...decision.newProvider,
          callbackTransactionId: decision.currentProvider.callbackTransactionId,
        },
      };
    })()],
    ['non-canonical time', { ...providerReplace(), decidedAt: new Date(Number.NaN) }],
  ])('rejects %s', (_label, candidate) => {
    expect(() => assertVerifiedFleetAuthLifecycleDecision(candidate)).toThrow();
  });

  describe('ADMIN_TOKEN operator approval branch (psfn-framework-ja7n0)', () => {
    function operatorReplace(): Record<string, unknown> {
      const { actor: _actor, actorSession: _session, ...rest } = providerReplace() as unknown as
        Record<string, unknown>;
      return {
        ...rest,
        operator: { kind: 'admin_token_operator', authorizationEventId: randomUUID() },
      };
    }

    it('accepts an exact operator approval with no principal actor', () => {
      const decision = assertVerifiedFleetAuthLifecycleDecision(operatorReplace());
      expect(decision.operator?.kind).toBe('admin_token_operator');
      expect(decision.actor).toBeUndefined();
    });

    it.each([
      ['operator plus principal actor', { ...operatorReplace(), actor: principal() }],
      ['unknown operator kind', {
        ...operatorReplace(),
        operator: { kind: 'testing_harness', authorizationEventId: randomUUID() },
      }],
      ['extra operator field', {
        ...operatorReplace(),
        operator: { kind: 'admin_token_operator', authorizationEventId: randomUUID(), role: 'owner' },
      }],
      ['approval id reused as decision id', (() => {
        const decision = operatorReplace();
        const id = randomUUID();
        return { ...decision, decisionId: id, operator: { kind: 'admin_token_operator', authorizationEventId: id } };
      })()],
      ['action outside the ceremony allowlist', {
        verification: 'gateway_verified',
        action: 'companion.remove',
        decisionId: randomUUID(),
        ceremonyId: randomUUID(),
        operator: { kind: 'admin_token_operator', authorizationEventId: randomUUID() },
        target: principal(),
        authorityGeneration: 1,
        globalAuthEpoch: 1,
        companionId: randomUUID(),
        reasonDigest: DIGEST,
        decidedAt: new Date('2026-07-16T12:00:00.000Z'),
      }],
    ])('rejects %s', (_label, candidate) => {
      expect(() => assertVerifiedFleetAuthLifecycleDecision(candidate)).toThrow();
    });
  });
});
