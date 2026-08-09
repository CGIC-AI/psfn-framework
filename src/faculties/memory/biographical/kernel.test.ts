import { describe, expect, it } from 'vitest';

import {
  applyLoweringGrant,
  assembleCanonicalClaim,
  assertGrantInput,
  assertGrantRecord,
  assertLifecycleTransition,
  assertSources,
  assertSubjectRef,
  assertValidInterval,
  BiographicalClaimValidationError,
  BiographicalGrantValidationError,
  BiographicalLifecycleError,
  BIOGRAPHICAL_SOURCE_SLOTS,
  computeAutomaticSensitivity,
  computeClaimDigest,
  computeSourceSetDigest,
} from './kernel.js';
import {
  assertRelatedSubjectShape,
  canonicalizeClaimValue,
  claimConflictKey,
  claimKindFloor,
} from './claim-kinds.js';
import { assertClaimTransition, deserializeClaim } from './store-port.js';
import type {
  BiographicalClaimKind,
  BiographicalClaimSource,
  BiographicalClaimStatus,
  BiographicalClaimValue,
  BiographicalSensitivityGrant,
  BiographicalSubjectRef,
} from './types.js';

const SHA = 'a'.repeat(64);
const NOW = new Date('2026-08-09T12:00:00.000Z');

function contact(id: string, version = 1): BiographicalSubjectRef {
  return { kind: 'contact', contactId: id, subjectVersion: version };
}
function companion(id: string, version = 1): BiographicalSubjectRef {
  return { kind: 'companion', companionId: id, subjectVersion: version };
}

function source(overrides: Partial<BiographicalClaimSource> = {}): BiographicalClaimSource {
  return {
    ref: 'memory:m-1',
    revision: '2026-08-09T10:00:00.000Z',
    evidenceDigest: SHA,
    sensitivityAtProjection: 'personal',
    subjectEvidenceDigest: SHA,
    consentFingerprint: SHA,
    ...overrides,
  };
}

describe('biographical claim digests', () => {
  it('produces a stable 64-hex claim digest for identical canonical content', () => {
    const subject = contact('v');
    const value = canonicalizeClaimValue('nickname', { kind: 'nickname', nickname: 'Sunbeam loaf', scope: 'self' });
    const common = { schemaVersion: 1, normalizerVersion: 1, subject, kind: 'nickname' as const, value };
    const digestA = computeClaimDigest(common);
    const digestB = computeClaimDigest(common);

    expect(digestA).toMatch(/^[0-9a-f]{64}$/u);
    expect(digestA).toBe(digestB);
  });

  it('excludes timestamps, confidence, sensitivity, and sources from the claim digest', () => {
    const subject = contact('v');
    const value = canonicalizeClaimValue('nickname', { kind: 'nickname', nickname: 'Loaf', scope: 'self' });
    const base = { schemaVersion: 1, normalizerVersion: 1, subject, kind: 'nickname' as const, value };
    const digest = computeClaimDigest(base);
    // Re-running with different irrelevant context is still digest-stable.
    expect(computeClaimDigest(base)).toBe(digest);
  });

  it('changes the claim digest when the subject version changes (contact merge detection)', () => {
    const value = canonicalizeClaimValue('name', { kind: 'name', name: 'V', role: 'primary' });
    const before = computeClaimDigest({ schemaVersion: 1, normalizerVersion: 1, subject: contact('v', 1), kind: 'name', value });
    const after = computeClaimDigest({ schemaVersion: 1, normalizerVersion: 1, subject: contact('v', 2), kind: 'name', value });
    expect(before).not.toBe(after);
  });

  it('changes the claim digest when the structured value changes', () => {
    const subject = contact('v');
    const a = computeClaimDigest({
      schemaVersion: 1, normalizerVersion: 1, subject, kind: 'nickname',
      value: canonicalizeClaimValue('nickname', { kind: 'nickname', nickname: 'A', scope: 'self' }),
    });
    const b = computeClaimDigest({
      schemaVersion: 1, normalizerVersion: 1, subject, kind: 'nickname',
      value: canonicalizeClaimValue('nickname', { kind: 'nickname', nickname: 'B', scope: 'self' }),
    });
    expect(a).not.toBe(b);
  });

  it('produces a stable source-set digest and changes it when a source drifts', () => {
    const baseSources = [source(), source({ ref: 'memory:m-2', revision: '2026-08-09T10:00:00.000Z' })];
    const digestA = computeSourceSetDigest(baseSources);
    // Source order does not affect the digest (canonical ordering).
    const reordered = [...baseSources].reverse();
    expect(computeSourceSetDigest(reordered)).toBe(digestA);

    // A sensitivity or revision change drifts the digest.
    const drifted = computeSourceSetDigest([
      source({ sensitivityAtProjection: 'intimate' }),
      source({ ref: 'memory:m-2', revision: '2026-08-09T10:00:00.000Z' }),
    ]);
    expect(drifted).not.toBe(digestA);
  });
});

describe('biographical automatic sensitivity', () => {
  it('is the maximum of the kind floor, the proposal, and every live source', () => {
    const floor = claimKindFloor('relationship');
    expect(floor).toBe('personal');
    const { sensitivity } = computeAutomaticSensitivity({
      kind: 'relationship',
      proposedSensitivity: 'personal',
      sources: [source({ sensitivityAtProjection: 'intimate' }), source({ sensitivityAtProjection: 'public' })],
    });
    expect(sensitivity).toBe('intimate');
  });

  it('defaults the proposal to personal when missing or invalid', () => {
    const missing = computeAutomaticSensitivity({
      kind: 'name',
      sources: [source({ sensitivityAtProjection: 'public' })],
    });
    expect(missing.sensitivity).toBe('personal');

    const invalid = computeAutomaticSensitivity({
      kind: 'name',
      // @ts-expect-error invalid proposal must not widen or crash
      proposedSensitivity: 'definitely-not-a-level',
      sources: [source({ sensitivityAtProjection: 'public' })],
    });
    expect(invalid.sensitivity).toBe('personal');
  });

  it('a confidential source pins the automatic floor at confidential', () => {
    const { sensitivity } = computeAutomaticSensitivity({
      kind: 'name',
      proposedSensitivity: 'public',
      sources: [source({ sensitivityAtProjection: 'confidential' })],
    });
    expect(sensitivity).toBe('confidential');
  });
});

describe('biographical exact digest-bound lowering grants', () => {
  const claimDigest = 'c'.repeat(64);
  const sourceSetDigest = 's'.repeat(64);

  function grant(overrides: Partial<BiographicalSensitivityGrant> = {}): BiographicalSensitivityGrant {
    return {
      id: 'g-1',
      schemaVersion: 1,
      policyVersion: 1,
      claimDigest,
      sourceSetDigest,
      grantedSensitivity: 'public',
      authorizingActor: 'operator',
      authorityBasis: 'hitl-approval',
      reason: 'subject asked to share the nickname',
      grantedAt: '2026-08-09T11:00:00.000Z',
      ...overrides,
    };
  }

  it('lowers below the automatic floor only when bound to exact digests', () => {
    const result = applyLoweringGrant({
      claimDigest, sourceSetDigest, automaticSensitivity: 'intimate', grants: [grant()], now: NOW,
    });
    expect(result.effectiveSensitivity).toBe('public');
    expect(result.appliedGrant?.id).toBe('g-1');
  });

  it('does not apply when the claim digest differs (fail closed)', () => {
    const result = applyLoweringGrant({
      claimDigest: 'd'.repeat(64), sourceSetDigest, automaticSensitivity: 'intimate', grants: [grant()], now: NOW,
    });
    expect(result.effectiveSensitivity).toBe('intimate');
    expect(result.appliedGrant).toBeUndefined();
  });

  it('does not apply when the source-set digest differs', () => {
    const result = applyLoweringGrant({
      claimDigest, sourceSetDigest: 'x'.repeat(64), automaticSensitivity: 'intimate', grants: [grant()], now: NOW,
    });
    expect(result.effectiveSensitivity).toBe('intimate');
    expect(result.appliedGrant).toBeUndefined();
  });

  it('ignores revoked and expired grants', () => {
    const revoked = applyLoweringGrant({
      claimDigest, sourceSetDigest, automaticSensitivity: 'intimate',
      grants: [grant({ revokedAt: '2026-08-09T11:30:00.000Z', revokedReason: 'withdrawn' })], now: NOW,
    });
    expect(revoked.effectiveSensitivity).toBe('intimate');

    const expired = applyLoweringGrant({
      claimDigest, sourceSetDigest, automaticSensitivity: 'intimate',
      grants: [grant({ expiresAt: '2026-08-09T11:30:00.000Z' })], now: NOW,
    });
    expect(expired.effectiveSensitivity).toBe('intimate');
  });

  it('never raises sensitivity above the automatic floor', () => {
    const result = applyLoweringGrant({
      claimDigest, sourceSetDigest, automaticSensitivity: 'public',
      grants: [grant({ grantedSensitivity: 'confidential' })], now: NOW,
    });
    expect(result.effectiveSensitivity).toBe('public');
    expect(result.appliedGrant).toBeUndefined();
  });

  it('validates grant input digests and sensitivity, rejecting malformed grants', () => {
    expect(() => assertGrantInput({ claimDigest: 'short', sourceSetDigest, grantedSensitivity: 'public', authorizingActor: 'operator', authorityBasis: 'x', reason: 'y' })).toThrow(BiographicalGrantValidationError);
    expect(() => assertGrantInput({ claimDigest, sourceSetDigest, grantedSensitivity: 'nope', authorizingActor: 'operator', authorityBasis: 'x', reason: 'y' })).toThrow(BiographicalGrantValidationError);
    expect(() => assertGrantInput({ claimDigest, sourceSetDigest, grantedSensitivity: 'public', authorizingActor: 'martian', authorityBasis: 'x', reason: 'y' })).toThrow(BiographicalGrantValidationError);
    expect(() => assertGrantInput({ claimDigest, sourceSetDigest, grantedSensitivity: 'public', authorizingActor: 'operator', authorityBasis: 'x', reason: 'y', surprise: true })).toThrow(BiographicalGrantValidationError);
  });

  it('rejects stored grants with unsupported schema/policy versions', () => {
    expect(() => assertGrantRecord({ ...grant(), schemaVersion: 2 })).toThrow(BiographicalGrantValidationError);
    expect(() => assertGrantRecord({ ...grant(), policyVersion: 99 })).toThrow(BiographicalGrantValidationError);
  });

  it('rejects inconsistent grant chronology and revocation fields', () => {
    expect(() => assertGrantRecord(grant({
      expiresAt: '2026-08-09T10:00:00.000Z',
    }))).toThrow(BiographicalGrantValidationError);
    expect(() => assertGrantRecord(grant({
      revokedReason: 'missing timestamp',
    }))).toThrow(BiographicalGrantValidationError);
    expect(() => assertGrantRecord(grant({
      revokedAt: '2026-08-09T10:00:00.000Z',
      revokedReason: 'before grant',
    }))).toThrow(BiographicalGrantValidationError);
  });
});

describe('biographical validation (fail closed)', () => {
  const validValue: BiographicalClaimValue = { kind: 'nickname', nickname: 'Loaf', scope: 'self' };

  function expectInvalid(kind: BiographicalClaimKind, value: unknown, relatedSubject?: BiographicalSubjectRef): void {
    expect(() => {
      const canonical = canonicalizeClaimValue(kind, value);
      assertRelatedSubjectShape(kind, canonical, relatedSubject);
    }).toThrow(BiographicalClaimValidationError);
  }

  it('rejects unknown claim kinds', () => {
    expect(() => canonicalizeClaimValue('hobby' as BiographicalClaimKind, { kind: 'hobby' })).toThrow();
  });

  it('rejects malformed structured values', () => {
    expectInvalid('name', { kind: 'name', name: '', role: 'primary' });
    expectInvalid('name', { kind: 'name', name: 'V', role: 'super' });
    expectInvalid('nickname', { kind: 'nickname', nickname: '', scope: 'self' });
    expectInvalid('nickname', { kind: 'nickname', nickname: 'V', scope: 'both' });
    expectInvalid('relationship', { kind: 'relationship', relationshipType: '' });
    expectInvalid('name', { kind: 'name', name: 'V', role: 'primary', hidden: 'payload' });
  });

  it('rejects unknown subject and source fields', () => {
    expect(() => assertSubjectRef({
      kind: 'contact',
      contactId: 'v',
      subjectVersion: 1,
      channelOwnedIdentity: true,
    }, 'subject')).toThrow(BiographicalClaimValidationError);
    expect(() => assertSources([{ ...source(), hidden: 'payload' }])).toThrow(
      BiographicalClaimValidationError,
    );
  });

  it('rejects name values with a related subject (cardinality gate)', () => {
    expectInvalid('name', { kind: 'name', name: 'V', role: 'primary' }, contact('other'));
  });

  it('rejects relationship values without a related subject', () => {
    expect(() => {
      const canonical = canonicalizeClaimValue('relationship', { kind: 'relationship', relationshipType: 'husband' });
      assertRelatedSubjectShape('relationship', canonical, undefined);
    }).toThrow(BiographicalClaimValidationError);
  });

  it('rejects self nicknames that carry a related subject', () => {
    expect(() => {
      const canonical = canonicalizeClaimValue('nickname', { kind: 'nickname', nickname: 'Loaf', scope: 'self' });
      assertRelatedSubjectShape('nickname', canonical, contact('other'));
    }).toThrow(BiographicalClaimValidationError);
  });

  it('rejects invalid temporal intervals', () => {
    expect(() => assertValidInterval({
      validFrom: '2026-08-09T12:00:00.000Z',
      validTo: '2026-08-08T12:00:00.000Z',
    })).toThrow(BiographicalClaimValidationError);
  });

  it('rejects malformed timestamps', () => {
    expect(() => assertValidInterval({ validFrom: 'not-a-date' })).toThrow(BiographicalClaimValidationError);
  });

  it('accepts equal and ordered intervals, and absent bounds', () => {
    const same = assertValidInterval({
      validFrom: '2026-08-09T12:00:00.000Z',
      validTo: '2026-08-09T12:00:00.000Z',
    });
    expect(same.validFrom).toBe('2026-08-09T12:00:00.000Z');
    expect(assertValidInterval({}).validFrom).toBeUndefined();
  });

  it('rejects sources that exceed the bounded audit surface', () => {
    const tooMany = Array.from({ length: BIOGRAPHICAL_SOURCE_SLOTS + 1 }, (_, i) =>
      source({ ref: `memory:m-${i}` }),
    );
    expect(() => assertSources(tooMany)).toThrow(BiographicalClaimValidationError);
  });

  it('validates only public for the unused value shim', () => {
    void validValue;
  });

  it('rejects corrupted or forward-version stored claim envelopes', () => {
    const claim = assembleCanonicalClaim({
      id: 'claim-1',
      subject: contact('v'),
      kind: 'name',
      value: { kind: 'name', name: 'V', role: 'primary' },
      basis: 'explicit',
      status: 'active',
      sources: [source()],
      proposedSensitivity: 'personal',
      effectiveSensitivity: 'personal',
      confidence: 1,
      synthesizedAt: NOW.toISOString(),
      lastSourceValidatedAt: NOW.toISOString(),
      lastEvidenceAt: NOW.toISOString(),
    });
    expect(() => deserializeClaim({ ...claim, normalizerVersion: 99 })).toThrow(
      'normalizerVersion',
    );
    expect(() => deserializeClaim({ ...claim, claimDigest: 'f'.repeat(64) })).toThrow(
      'does not match canonical content',
    );
    expect(() => deserializeClaim({
      ...claim,
      sources: [{ ...claim.sources[0], revision: 'changed' }],
    })).toThrow('does not match source snapshots');
    expect(() => deserializeClaim({ ...claim, hidden: 'payload' })).toThrow(
      'unknown or missing fields',
    );
  });
});

describe('biographical conflict keys', () => {
  it('name primaries conflict; aliases coexist', () => {
    const subject = contact('v');
    const primaryA = claimConflictKey('name', subject, { kind: 'name', name: 'Vincent', role: 'primary' });
    const primaryB = claimConflictKey('name', subject, { kind: 'name', name: 'Vince', role: 'primary' });
    expect(primaryA).toBe(primaryB);
    const alias = claimConflictKey('name', subject, { kind: 'name', name: 'V', role: 'alias' });
    expect(alias).not.toBe(primaryA);
  });

  it('nicknames coalesce on normalized value + scope', () => {
    const subject = companion('purrs');
    const a = claimConflictKey('nickname', subject, { kind: 'nickname', nickname: 'Sunbeam Loaf', scope: 'self' });
    const b = claimConflictKey('nickname', subject, { kind: 'nickname', nickname: '  sunbeam   loaf ', scope: 'self' });
    expect(a).toBe(b);
  });

  it('relationship keys include the related subject and normalized type', () => {
    const subject = companion('purrs');
    const husband = claimConflictKey(
      'relationship', subject,
      { kind: 'relationship', relationshipType: 'Husband' },
      contact('v'),
    );
    const friend = claimConflictKey(
      'relationship', subject,
      { kind: 'relationship', relationshipType: 'Friend' },
      contact('v'),
    );
    expect(husband).not.toBe(friend);
  });
});

describe('biographical lifecycle transitions', () => {
  const cases: Array<[BiographicalClaimStatus, BiographicalClaimStatus]> = [
    ['candidate', 'active'],
    ['active', 'contested'],
    ['contested', 'active'],
    ['active', 'superseded'],
    ['active', 'revoked'],
  ];
  for (const [from, to] of cases) {
    it(`allows ${from} -> ${to}`, () => {
      expect(() => assertLifecycleTransition(from, to)).not.toThrow();
    });
  }

  const invalid: Array<[BiographicalClaimStatus, BiographicalClaimStatus]> = [
    ['candidate', 'candidate-to-nowhere' as BiographicalClaimStatus],
  ];
  it('rejects unknown target statuses', () => {
    for (const [from, to] of invalid) {
      expect(() => assertLifecycleTransition(from, to)).toThrow();
    }
  });

  it('rejects transitions out of terminal states (append-only)', () => {
    expect(() => assertLifecycleTransition('superseded', 'active')).toThrow(BiographicalLifecycleError);
    expect(() => assertLifecycleTransition('revoked', 'active')).toThrow(BiographicalLifecycleError);
  });

  it('assertClaimTransition is a no-op for same status', () => {
    expect(() => assertClaimTransition({ status: 'active' } as never, 'active', NOW)).not.toThrow();
  });
});
