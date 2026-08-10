import { describe, expect, it } from 'vitest';

import { prepareBiographicalReviewAudit } from './review-audit.js';

const DIGEST = 'a'.repeat(64);

function validInput() {
  return {
    claimId: 'claim-1',
    claimDigest: DIGEST,
    sourceSetDigest: DIGEST,
    action: 'approve' as const,
    decision: 'allowed' as const,
    reason: 'approved' as const,
    actorAuthorityRef: 'garden-fleet:event-1',
    now: new Date('2026-08-10T12:00:00.000Z'),
  };
}

describe('prepareBiographicalReviewAudit', () => {
  it('validates public store inputs before persistence', () => {
    expect(prepareBiographicalReviewAudit(validInput())).toMatchObject({
      claimId: 'claim-1', action: 'approve', reason: 'approved',
    });
    expect(() => prepareBiographicalReviewAudit({
      ...validInput(), claimDigest: 'not-a-digest',
    })).toThrow(/SHA-256 digest/u);
    expect(() => prepareBiographicalReviewAudit({
      ...validInput(), actorAuthorityRef: 'unscoped authority',
    })).toThrow(/authorityRef is malformed/iu);
    expect(() => prepareBiographicalReviewAudit({
      ...validInput(), action: 'publish' as never,
    })).toThrow(/action is not supported/u);
    expect(() => prepareBiographicalReviewAudit({
      ...validInput(), now: new Date(Number.NaN),
    })).toThrow(/valid Date/u);
  });
});
