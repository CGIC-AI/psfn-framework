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
    currentProvider: provider('123456789012345678'),
    newProvider: provider('223456789012345678'),
    reasonDigest: DIGEST,
    decidedAt: new Date('2026-07-16T12:00:00.000Z'),
  };
}

describe('verified fleet-auth lifecycle decision contract', () => {
  it('accepts an exact current+new provider replacement proof', () => {
    expect(assertVerifiedFleetAuthLifecycleDecision(providerReplace()).action)
      .toBe('provider.replace');
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
});
