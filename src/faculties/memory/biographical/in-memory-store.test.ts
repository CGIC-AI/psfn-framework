import { describe, expect, it } from 'vitest';

import { InMemoryBiographicalProfileStore } from './in-memory-store.js';
import { BiographicalLifecycleError } from './kernel.js';
import type {
  BiographicalClaimSource,
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

function store(now: () => Date = () => NOW) {
  return new InMemoryBiographicalProfileStore(now);
}

describe('InMemoryBiographicalProfileStore — writeClaim', () => {
  it('persists a self nickname with the computed digest and automatic sensitivity', async () => {
    const s = store();
    const claim = await s.writeClaim({
      subject: companion('purrs'),
      kind: 'nickname',
      value: { kind: 'nickname', nickname: 'Sunbeam loaf', scope: 'self' },
      basis: 'explicit',
      confidence: 0.9,
      sources: [source()],
      now: NOW,
    });
    expect(claim.status).toBe('candidate');
    expect(claim.effectiveSensitivity).toBe('personal');
    expect(claim.claimDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(await s.getClaim(claim.id)).toEqual(claim);
  });

  it('stores an audit-only collection-depth decision without changing sensitivity', async () => {
    const s = store();
    const full = await s.writeClaim({
      subject: companion('purrs'),
      kind: 'name',
      value: { kind: 'name', name: 'Companion', role: 'primary' },
      basis: 'explicit',
      confidence: 1,
      sources: [source()],
      depthDecision: 'full',
      now: NOW,
    });
    expect(full.depthDecision).toBe('full');
    expect(full.effectiveSensitivity).toBe('personal');

    const recognition = await s.writeClaim({
      subject: contact('stranger'),
      kind: 'name',
      value: { kind: 'name', name: 'Stranger', role: 'primary' },
      basis: 'observed',
      confidence: 0.5,
      sources: [source({ ref: 'memory:m-2' })],
      depthDecision: 'recognition',
      now: NOW,
    });
    expect(recognition.depthDecision).toBeUndefined();
  });

  it('rejects unknown kinds and malformed values fail-closed', async () => {
    const s = store();
    await expect(
      s.writeClaim({
        subject: companion('purrs'),
        // @ts-expect-error unknown kind
        kind: 'hobby',
        value: { kind: 'hobby' },
        basis: 'explicit',
        confidence: 0.5,
        sources: [source()],
        now: NOW,
      }),
    ).rejects.toThrow();
  });

  it('rejects an invalid proposed sensitivity before persistence', async () => {
    const s = store();
    await expect(
      s.writeClaim({
        subject: companion('purrs'),
        kind: 'name',
        value: { kind: 'name', name: 'Companion', role: 'primary' },
        basis: 'explicit',
        // @ts-expect-error runtime callers must fail closed too
        proposedSensitivity: 'friends-only',
        confidence: 1,
        sources: [source()],
        now: NOW,
      }),
    ).rejects.toThrow('proposedSensitivity');
  });

  it('uses admission time for evidence recency instead of parsing opaque revisions', async () => {
    const s = store();
    const claim = await s.writeClaim({
      subject: contact('v'),
      kind: 'name',
      value: { kind: 'name', name: 'Morgan', role: 'primary' },
      basis: 'explicit',
      confidence: 1,
      sources: [source({ revision: '1' })],
      now: NOW,
    });
    expect(claim.lastEvidenceAt).toBe(NOW.toISOString());
  });

  it('rejects duplicate claim ids instead of rewriting append-only history', async () => {
    const s = store();
    const input = {
      id: 'claim-fixed',
      subject: contact('v'),
      kind: 'name' as const,
      value: { kind: 'name' as const, name: 'Morgan', role: 'primary' as const },
      basis: 'explicit' as const,
      confidence: 1,
      sources: [source()],
      now: NOW,
    };
    await s.writeClaim(input);
    await expect(s.writeClaim({
      ...input,
      value: { kind: 'name', name: 'Someone else', role: 'primary' },
    })).rejects.toThrow('already exists');
  });

  it('matches an exact canonical subject version and validates list limits', async () => {
    const s = store();
    await s.writeClaim({
      subject: contact('v', 1),
      kind: 'name',
      value: { kind: 'name', name: 'Morgan', role: 'primary' },
      basis: 'explicit',
      confidence: 1,
      sources: [source()],
      now: NOW,
    });
    expect(await s.listClaims({ subject: contact('v', 2) })).toEqual([]);
    await expect(s.listClaims({ limit: 0 })).rejects.toThrow('positive integer');
    await expect(s.listClaims({ offset: -1 })).rejects.toThrow('non-negative integer');
  });

  it('orders same-time claims by id like the Postgres adapter', async () => {
    const s = store();
    for (const id of ['claim-b', 'claim-a']) {
      await s.writeClaim({
        id,
        subject: contact(id),
        kind: 'name',
        value: { kind: 'name', name: id, role: 'primary' },
        basis: 'explicit',
        confidence: 1,
        sources: [source({ ref: `memory:${id}` })],
        now: NOW,
      });
    }
    expect((await s.listClaims()).map(claim => claim.id)).toEqual(['claim-a', 'claim-b']);
    expect((await s.listClaims({ offset: 1, limit: 1 })).map(claim => claim.id))
      .toEqual(['claim-b']);
  });
});

describe('InMemoryBiographicalProfileStore — supersession (append-only)', () => {
  it('marks the prior claim superseded and keeps both rows in history', async () => {
    const s = store();
    const original = await s.writeClaim({
      subject: contact('v'),
      kind: 'relationship',
      relatedSubject: companion('purrs'),
      value: { kind: 'relationship', relationshipType: 'employed at Acme' },
      basis: 'observed',
      confidence: 0.8,
      sources: [source()],
      validFrom: '2026-01-01T00:00:00.000Z',
      status: 'active',
      now: new Date('2026-06-01T00:00:00.000Z'),
    });
    const result = await s.supersedeClaim({
      supersededClaimId: original.id,
      subject: contact('v'),
      relatedSubject: companion('purrs'),
      kind: 'relationship',
      value: { kind: 'relationship', relationshipType: 'employed at Globex' },
      basis: 'explicit',
      confidence: 0.9,
      sources: [source({ ref: 'memory:m-2', revision: '2026-08-01T00:00:00.000Z' })],
      validFrom: '2026-08-01T00:00:00.000Z',
      now: NOW,
    });
    expect(result.superseded.status).toBe('superseded');
    expect(result.superseding.status).toBe('candidate');
    expect(result.superseding.supersedesClaimId).toBe(original.id);

    // Both rows persist; the superseded one is excluded from the default list.
    const live = await s.listClaims({ subject: contact('v') });
    expect(live.map(c => c.id)).toEqual([result.superseding.id]);
    const history = await s.listClaims({ subject: contact('v'), includeTerminal: true });
    expect(history.map(c => c.id).sort()).toEqual([original.id, result.superseding.id].sort());
  });

  it('refuses to supersede an already-terminal claim', async () => {
    const s = store();
    const original = await s.writeClaim({
      subject: contact('v'),
      kind: 'name',
      value: { kind: 'name', name: 'Morgan', role: 'primary' },
      basis: 'explicit',
      confidence: 1,
      sources: [source()],
      status: 'active',
      now: NOW,
    });
    await s.transitionClaim({ claimId: original.id, to: 'revoked', now: NOW });
    await expect(
      s.supersedeClaim({
        supersededClaimId: original.id,
        subject: contact('v'),
        kind: 'name',
        value: { kind: 'name', name: 'V2', role: 'primary' },
        basis: 'explicit',
        confidence: 1,
        sources: [source({ ref: 'memory:m-2' })],
        now: NOW,
      }),
    ).rejects.toThrow(BiographicalLifecycleError);
  });

  it('refuses to supersede a different canonical subject', async () => {
    const s = store();
    const original = await s.writeClaim({
      subject: contact('v'),
      kind: 'name',
      value: { kind: 'name', name: 'Morgan', role: 'primary' },
      basis: 'explicit',
      confidence: 1,
      sources: [source()],
      status: 'active',
      now: NOW,
    });
    await expect(s.supersedeClaim({
      supersededClaimId: original.id,
      subject: contact('someone-else'),
      kind: 'name',
      value: { kind: 'name', name: 'Someone', role: 'primary' },
      basis: 'explicit',
      confidence: 1,
      sources: [source({ ref: 'memory:m-2' })],
      now: NOW,
    })).rejects.toThrow('same canonical subject');
    expect((await s.getClaim(original.id))?.status).toBe('active');
  });
});

describe('InMemoryBiographicalProfileStore — lifecycle transitions', () => {
  it('transitions candidate -> active -> contested -> active', async () => {
    const s = store();
    const claim = await s.writeClaim({
      subject: contact('v'),
      kind: 'nickname',
      value: { kind: 'nickname', nickname: 'Loaf', scope: 'self' },
      basis: 'observed',
      confidence: 0.7,
      sources: [source()],
      now: NOW,
    });
    expect((await s.transitionClaim({ claimId: claim.id, to: 'active', now: NOW })).status).toBe('active');
    expect((await s.transitionClaim({ claimId: claim.id, to: 'contested', now: NOW })).status).toBe('contested');
    expect((await s.transitionClaim({ claimId: claim.id, to: 'active', now: NOW })).status).toBe('active');
  });

  it('rejects invalid transitions', async () => {
    const s = store();
    const claim = await s.writeClaim({
      subject: contact('v'),
      kind: 'nickname',
      value: { kind: 'nickname', nickname: 'Loaf', scope: 'self' },
      basis: 'observed',
      confidence: 0.7,
      sources: [source()],
      status: 'active',
      now: NOW,
    });
    // active -> candidate is not a valid transition.
    await expect(
      s.transitionClaim({ claimId: claim.id, to: 'candidate', now: NOW }),
    ).rejects.toThrow(BiographicalLifecycleError);
  });
});

describe('InMemoryBiographicalProfileStore — exact digest-bound grants', () => {
  it('lowers a claim below its source floor only via an exact grant', async () => {
    const s = store();
    const claim = await s.writeClaim({
      subject: companion('purrs'),
      kind: 'nickname',
      value: { kind: 'nickname', nickname: 'Loaf', scope: 'self' },
      basis: 'explicit',
      proposedSensitivity: 'personal',
      confidence: 0.9,
      sources: [source({ sensitivityAtProjection: 'intimate' })],
      now: NOW,
    });
    expect(claim.effectiveSensitivity).toBe('intimate');

    const grant = await s.recordGrant({
      claimDigest: claim.claimDigest,
      sourceSetDigest: claim.sourceSetDigest,
      grantedSensitivity: 'public',
      authorizingActor: 'operator',
      authorityBasis: 'hitl-approval',
      reason: 'subject authorized sharing',
      now: NOW,
    });
    expect(grant.claimDigest).toBe(claim.claimDigest);

    const lowered = await s.getClaim(claim.id);
    expect(lowered?.effectiveSensitivity).toBe('public');
    expect(lowered?.appliedGrantId).toBe(grant.id);
    expect(await s.listGrantsForClaim(claim.id)).toHaveLength(1);
  });

  it('a grant bound to the wrong digest does not lower the claim (fail closed)', async () => {
    const s = store();
    const claim = await s.writeClaim({
      subject: companion('purrs'),
      kind: 'nickname',
      value: { kind: 'nickname', nickname: 'Loaf', scope: 'self' },
      basis: 'explicit',
      confidence: 0.9,
      sources: [source({ sensitivityAtProjection: 'intimate' })],
      now: NOW,
    });
    await s.recordGrant({
      claimDigest: 'd'.repeat(64),
      sourceSetDigest: claim.sourceSetDigest,
      grantedSensitivity: 'public',
      authorizingActor: 'operator',
      authorityBasis: 'hitl-approval',
      reason: 'wrong claim digest',
      now: NOW,
    });
    const unchanged = await s.getClaim(claim.id);
    expect(unchanged?.effectiveSensitivity).toBe('intimate');
    expect(unchanged?.appliedGrantId).toBeUndefined();
    // No grants match the claim's digests.
    expect(await s.listGrantsForClaim(claim.id)).toHaveLength(0);
  });

  it('revoking a grant reverts the effective sensitivity to the automatic floor', async () => {
    const s = store();
    const claim = await s.writeClaim({
      subject: companion('purrs'),
      kind: 'nickname',
      value: { kind: 'nickname', nickname: 'Loaf', scope: 'self' },
      basis: 'explicit',
      confidence: 0.9,
      sources: [source({ sensitivityAtProjection: 'intimate' })],
      now: NOW,
    });
    const grant = await s.recordGrant({
      claimDigest: claim.claimDigest,
      sourceSetDigest: claim.sourceSetDigest,
      grantedSensitivity: 'public',
      authorizingActor: 'operator',
      authorityBasis: 'hitl-approval',
      reason: 'temporary',
      now: NOW,
    });
    expect((await s.getClaim(claim.id))?.effectiveSensitivity).toBe('public');

    const revoked = await s.revokeGrant(grant.id, { reason: 'withdrawn', now: NOW });
    expect(revoked.revokedAt).toBeDefined();
    const reverted = await s.getClaim(claim.id);
    expect(reverted?.effectiveSensitivity).toBe('intimate');
    expect(reverted?.appliedGrantId).toBeUndefined();
  });

  it('collection depth never affects grant lowering (depth != disclosure)', async () => {
    const s = store();
    const claim = await s.writeClaim({
      subject: contact('stranger'),
      kind: 'nickname',
      value: { kind: 'nickname', nickname: 'Loaf', scope: 'self' },
      basis: 'observed',
      confidence: 0.4,
      sources: [source({ sensitivityAtProjection: 'personal' })],
      depthDecision: 'recognition',
      now: NOW,
    });
    // recognition depth keeps the personal floor; only an exact grant lowers.
    expect(claim.effectiveSensitivity).toBe('personal');
    const grant = await s.recordGrant({
      claimDigest: claim.claimDigest,
      sourceSetDigest: claim.sourceSetDigest,
      grantedSensitivity: 'public',
      authorizingActor: 'operator',
      authorityBasis: 'hitl-approval',
      reason: 'ok',
      now: NOW,
    });
    expect(grant.grantedSensitivity).toBe('public');
    expect((await s.getClaim(claim.id))?.effectiveSensitivity).toBe('public');
  });

  it('evaluates grant expiry against the supplied decision time', async () => {
    let readAt = NOW;
    const s = store(() => readAt);
    const claim = await s.writeClaim({
      subject: companion('purrs'),
      kind: 'nickname',
      value: { kind: 'nickname', nickname: 'Loaf', scope: 'self' },
      basis: 'explicit',
      confidence: 0.9,
      sources: [source({ sensitivityAtProjection: 'intimate' })],
      now: NOW,
    });
    await s.recordGrant({
      claimDigest: claim.claimDigest,
      sourceSetDigest: claim.sourceSetDigest,
      grantedSensitivity: 'public',
      authorizingActor: 'operator',
      authorityBasis: 'hitl-approval',
      reason: 'bounded approval',
      expiresAt: '2026-08-09T12:30:00.000Z',
      now: NOW,
    });
    expect((await s.getClaim(claim.id))?.effectiveSensitivity).toBe('public');

    readAt = new Date('2026-08-09T13:00:00.000Z');
    const expired = await s.getClaim(claim.id);
    expect(expired?.effectiveSensitivity).toBe('intimate');
    expect(expired?.appliedGrantId).toBeUndefined();
  });
});

describe('InMemoryBiographicalProfileStore — temporal validity', () => {
  it('persists validFrom and validTo intervals', async () => {
    const s = store();
    const claim = await s.writeClaim({
      subject: contact('v'),
      kind: 'relationship',
      relatedSubject: companion('purrs'),
      value: { kind: 'relationship', relationshipType: 'employed at Acme' },
      basis: 'observed',
      confidence: 0.8,
      sources: [source()],
      validFrom: '2026-01-01T00:00:00.000Z',
      validTo: '2026-07-01T00:00:00.000Z',
      now: NOW,
    });
    expect(claim.validFrom).toBe('2026-01-01T00:00:00.000Z');
    expect(claim.validTo).toBe('2026-07-01T00:00:00.000Z');
  });

  it('rejects inverted intervals', async () => {
    const s = store();
    await expect(
      s.writeClaim({
        subject: contact('v'),
        kind: 'relationship',
        relatedSubject: companion('purrs'),
        value: { kind: 'relationship', relationshipType: 'x' },
        basis: 'observed',
        confidence: 0.8,
        sources: [source()],
        validFrom: '2026-07-01T00:00:00.000Z',
        validTo: '2026-01-01T00:00:00.000Z',
        now: NOW,
      }),
    ).rejects.toThrow();
  });
});
