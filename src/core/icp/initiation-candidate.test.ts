import { describe, expect, it } from 'vitest';

import {
  assertIcpInitiationCandidateStatusTransition,
  parseIcpInitiationCandidate,
  toIcpInitiationCandidateSharedMetadata,
} from './initiation-candidate.js';

const COMPANION_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const COMPANION_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('private ICP initiation candidate contract', () => {
  const rawCandidate = {
    candidateId: '11111111-1111-4111-8111-111111111111',
    rootInitiationId: '33333333-3333-4333-8333-333333333333',
    localCompanionId: COMPANION_A,
    peerContactId: 'contact-artemis',
    peerCompanionId: COMPANION_B,
    preferredChannel: 'dm',
    source: 'weighted_thought',
    provenanceRef: 'weighted-thought:wt-42',
    reasonSummary: 'I want to follow up on our shared research question.',
    createdAtMs: 10_000,
    expiresAtMs: 70_000,
    status: 'pending',
    revision: 1,
  } as const;

  it('strictly parses private motivation and rejects stale or unknown data', () => {
    const candidate = parseIcpInitiationCandidate(rawCandidate, {
      nowMs: 11_000,
      requireCurrent: true,
    });
    expect(candidate.reasonSummary).toContain('shared research');
    expect(() => parseIcpInitiationCandidate({ ...rawCandidate, chainOfThought: 'secret' }))
      .toThrow('unknown keys');
    expect(() => parseIcpInitiationCandidate({
      ...rawCandidate,
      peerCompanionId: COMPANION_A,
    })).toThrow('must target a different companion');
    expect(() => parseIcpInitiationCandidate(rawCandidate, {
      nowMs: 70_000,
      requireCurrent: true,
    })).toThrow('expired');
  });

  it('projects only content-free metadata for shared arbitration', () => {
    const shared = toIcpInitiationCandidateSharedMetadata(
      parseIcpInitiationCandidate(rawCandidate),
    );
    expect(shared).not.toHaveProperty('reasonSummary');
    expect(shared).not.toHaveProperty('peerContactId');
    expect(JSON.stringify(shared)).not.toContain('shared research');
    expect(shared.candidateId).toBe(rawCandidate.candidateId);
  });

  it('enforces candidate lifecycle transitions', () => {
    expect(() => assertIcpInitiationCandidateStatusTransition('pending', 'permitted'))
      .not.toThrow();
    expect(() => assertIcpInitiationCandidateStatusTransition('deferred', 'pending'))
      .not.toThrow();
    expect(() => assertIcpInitiationCandidateStatusTransition('consumed', 'pending'))
      .toThrow('Invalid ICP candidate status transition');
  });
});
