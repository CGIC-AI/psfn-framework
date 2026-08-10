import { describe, expect, it } from 'vitest';

import { InMemoryBiographicalProfileStore } from './in-memory-store.js';
import {
  COMPANION_PUBLICATION_AUTHORITY_BASIS,
  recordCompanionPublicationChoice,
  revokeCompanionPublicationChoice,
} from './publication.js';
import { ingestSelfNicknameEvidence } from './ingest.js';
import type {
  BiographicalClaimSource,
  BiographicalSubjectRef,
} from './types.js';

const SHA = 'a'.repeat(64);
const NOW = new Date('2026-08-10T12:00:00.000Z');

function companion(id = 'purrs'): BiographicalSubjectRef {
  return { kind: 'companion', companionId: id, subjectVersion: 1 };
}

function source(ref: string): BiographicalClaimSource {
  return {
    ref,
    revision: '2026-08-10T10:00:00.000Z',
    evidenceDigest: SHA,
    sensitivityAtProjection: 'personal',
    subjectEvidenceDigest: SHA,
    consentFingerprint: SHA,
    sourceChannelId: 'dm:with-v',
  };
}

function store() {
  return new InMemoryBiographicalProfileStore(() => NOW);
}

async function seed(store: InMemoryBiographicalProfileStore, nickname: string) {
  return ingestSelfNicknameEvidence({
    store,
    evidence: {
      companionSubject: companion(),
      nickname,
      sources: [source('memory:m-1')],
      confidence: 0.9,
      now: NOW,
    },
  });
}

describe('recordCompanionPublicationChoice — exact digest-bound lowering', () => {
  it('lowers exactly the chosen claim to public and stamps the companion basis', async () => {
    const s = store();
    const { claim: a } = await seed(s, 'Sunbeam loaf');
    const { claim: b } = await seed(s, 'Sunny');

    expect(a.effectiveSensitivity).toBe('personal');
    expect(b.effectiveSensitivity).toBe('personal');

    const grant = await recordCompanionPublicationChoice({
      store: s,
      choice: { claimId: a.id, reason: 'I want to be called this in public', now: NOW },
    });

    expect(grant.authorizingActor).toBe('companion');
    expect(grant.authorityBasis).toBe(COMPANION_PUBLICATION_AUTHORITY_BASIS);
    expect(grant.grantedSensitivity).toBe('public');
    expect(grant.claimDigest).toBe(a.claimDigest);
    expect(grant.sourceSetDigest).toBe(a.sourceSetDigest);

    const refreshedA = await s.getClaim(a.id);
    const refreshedB = await s.getClaim(b.id);
    expect(refreshedA?.effectiveSensitivity).toBe('public');
    expect(refreshedA?.appliedGrantId).toBe(grant.id);
    // Approval of one never authorizes another.
    expect(refreshedB?.effectiveSensitivity).toBe('personal');
    expect(refreshedB?.appliedGrantId).toBeUndefined();
  });

  it('records a distinct grant per nickname (independent approval)', async () => {
    const s = store();
    const { claim: a } = await seed(s, 'Sunbeam loaf');
    const { claim: b } = await seed(s, 'Sunny');

    const grantA = await recordCompanionPublicationChoice({
      store: s,
      choice: { claimId: a.id, reason: 'publish A', now: NOW },
    });
    const grantB = await recordCompanionPublicationChoice({
      store: s,
      choice: { claimId: b.id, reason: 'publish B', now: NOW },
    });

    expect(grantA.id).not.toBe(grantB.id);
    expect(grantA.claimDigest).not.toBe(grantB.claimDigest);
    expect((await s.getClaim(a.id))?.effectiveSensitivity).toBe('public');
    expect((await s.getClaim(b.id))?.effectiveSensitivity).toBe('public');
  });

  it('fails closed on an unknown claim id', async () => {
    const s = store();
    await expect(
      recordCompanionPublicationChoice({
        store: s,
        choice: { claimId: 'nope', reason: 'x', now: NOW },
      }),
    ).rejects.toThrow(/unknown biographical claim/u);
  });

  it('fails closed on a non-active claim', async () => {
    const s = store();
    const { claim: a } = await seed(s, 'Sunbeam loaf');
    await s.transitionClaim({ claimId: a.id, to: 'contested', now: NOW });
    await expect(
      recordCompanionPublicationChoice({
        store: s,
        choice: { claimId: a.id, reason: 'x', now: NOW },
      }),
    ).rejects.toThrow(/not active/u);
  });
});

describe('revokeCompanionPublicationChoice — immediate restriction', () => {
  it('reverts the claim to its automatic sensitivity immediately', async () => {
    const s = store();
    const { claim: a } = await seed(s, 'Sunbeam loaf');
    const grant = await recordCompanionPublicationChoice({
      store: s,
      choice: { claimId: a.id, reason: 'publish', now: NOW },
    });
    expect((await s.getClaim(a.id))?.effectiveSensitivity).toBe('public');

    const revoked = await revokeCompanionPublicationChoice({
      store: s,
      grantId: grant.id,
      revoke: { reason: 'I changed my mind', now: NOW },
    });
    expect(revoked.revokedAt).toBeDefined();

    const refreshed = await s.getClaim(a.id);
    expect(refreshed?.effectiveSensitivity).toBe('personal');
    expect(refreshed?.appliedGrantId).toBeUndefined();
  });

  it('revoking one nickname does not affect another', async () => {
    const s = store();
    const { claim: a } = await seed(s, 'Sunbeam loaf');
    const { claim: b } = await seed(s, 'Sunny');
    const grantA = await recordCompanionPublicationChoice({
      store: s,
      choice: { claimId: a.id, reason: 'publish A', now: NOW },
    });
    await recordCompanionPublicationChoice({
      store: s,
      choice: { claimId: b.id, reason: 'publish B', now: NOW },
    });

    await revokeCompanionPublicationChoice({
      store: s,
      grantId: grantA.id,
      revoke: { reason: 'revoke A only', now: NOW },
    });

    expect((await s.getClaim(a.id))?.effectiveSensitivity).toBe('personal');
    expect((await s.getClaim(b.id))?.effectiveSensitivity).toBe('public');
  });
});
