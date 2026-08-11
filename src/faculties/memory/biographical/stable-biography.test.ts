import { describe, expect, it } from 'vitest';

import { createDefaultBiographicalDepthPolicy } from '../../../system/config/biographical-depth-policy.js';
import {
  assertRelatedSubjectShape,
  canonicalizeClaimValue,
  claimConflictKey,
  claimValuesCanCoexist,
} from './claim-kinds.js';
import { admitBiographicalCandidate } from './conflict-policy.js';
import {
  biographicalRetentionLimit,
  boundBiographicalDepthWork,
  deriveBiographicalCollectionDepth,
  planBiographicalDepthTransition,
} from './depth-policy.js';
import { InMemoryBiographicalProfileStore } from './in-memory-store.js';
import { presentBiographicalClaim } from './projection-rendering.js';
import { parsePortableStableCandidate } from './stable-candidate.js';
import { prepareBiographicalClaim } from './store-port.js';
import type { BiographicalTransitionInput } from './store-port.js';
import type {
  BiographicalClaimSource,
  BiographicalSubjectRef,
  StablePreferenceClaimValue,
} from './types.js';

const NOW = new Date('2026-08-10T12:00:00.000Z');
const SHA = 'a'.repeat(64);
const CONTACT: BiographicalSubjectRef = {
  kind: 'contact',
  contactId: 'v',
  subjectVersion: 1,
};
const OTHER_CONTACT: BiographicalSubjectRef = {
  kind: 'contact',
  contactId: 'eve',
  subjectVersion: 1,
};
const COMPANION: BiographicalSubjectRef = {
  kind: 'companion',
  companionId: 'purrs',
  subjectVersion: 1,
};

function source(ref = 'memory:stable-v'): BiographicalClaimSource {
  return {
    ref,
    revision: '1',
    evidenceDigest: SHA,
    sensitivityAtProjection: 'personal',
    subjectEvidenceDigest: SHA,
    consentFingerprint: SHA,
  };
}

function preference(
  polarity: StablePreferenceClaimValue['polarity'],
  target = 'tea',
): StablePreferenceClaimValue {
  return {
    kind: 'stable-preference',
    schemaVersion: 1,
    domain: 'food',
    target,
    polarity,
  };
}

function preferenceCandidate(
  polarity: StablePreferenceClaimValue['polarity'],
  basis: 'explicit' | 'inferred' = 'inferred',
  target = 'tea',
) {
  return {
    subject: CONTACT,
    kind: 'stable-preference' as const,
    value: preference(polarity, target),
    basis,
    confidence: 0.9,
    sources: [source(`memory:${polarity}-${target}`)],
    now: NOW,
  };
}

describe('closed stable-biography kinds', () => {
  it('canonicalizes only versioned closed values and pins normalized conflict semantics', () => {
    expect(canonicalizeClaimValue('role', {
      kind: 'role',
      schemaVersion: 1,
      roleType: 'employment',
      title: '  Staff   Engineer  ',
      organization: ' ACME ',
    })).toEqual({
      kind: 'role',
      schemaVersion: 1,
      roleType: 'employment',
      title: 'Staff Engineer',
      organization: 'ACME',
    });
    expect(() => canonicalizeClaimValue('role', {
      kind: 'role', schemaVersion: 2, roleType: 'employment', title: 'Engineer',
    })).toThrow(/schema version 1/);
    expect(() => canonicalizeClaimValue('stable-preference', {
      ...preference('likes'), notes: 'portable prose is forbidden',
    })).toThrow();

    const likes = preference('likes');
    const dislikes = preference('dislikes');
    expect(claimConflictKey('stable-preference', CONTACT, likes))
      .toBe(claimConflictKey('stable-preference', CONTACT, dislikes));
    expect(claimValuesCanCoexist(
      'stable-preference', likes, preference('prefers'),
    )).toBe(true);
    expect(claimValuesCanCoexist('stable-preference', likes, dislikes)).toBe(false);
    const aliasA = canonicalizeClaimValue('name', { kind: 'name', name: 'Morgan', role: 'alias' });
    const aliasB = canonicalizeClaimValue('name', { kind: 'name', name: 'Vee', role: 'alias' });
    expect(claimConflictKey('name', CONTACT, aliasA))
      .not.toBe(claimConflictKey('name', CONTACT, aliasB));
  });

  it('enforces exact one-subject or companion-contact dyad cardinality and temporal roles', () => {
    const shared = canonicalizeClaimValue('shared-language', {
      kind: 'shared-language',
      schemaVersion: 1,
      languageType: 'phrase',
      phrase: 'sunbeam loaf',
      meaning: 'an affectionate greeting',
    });
    expect(() => assertRelatedSubjectShape(
      'shared-language', shared, OTHER_CONTACT, CONTACT,
    )).toThrow(/companion-contact dyad/);
    expect(() => assertRelatedSubjectShape(
      'shared-language', shared, COMPANION, CONTACT,
    )).not.toThrow();
    expect(() => prepareBiographicalClaim({
      subject: CONTACT,
      kind: 'role',
      value: {
        kind: 'role', schemaVersion: 1, roleType: 'employment', title: 'Engineer',
      },
      basis: 'explicit',
      confidence: 1,
      sources: [source()],
      now: NOW,
    })).toThrow(/requires validFrom/);
  });

  it('rejects model-selected status, notes, unknown kinds and unsupported human shapes', () => {
    const candidate = preferenceCandidate('likes');
    const base = {
      subject: candidate.subject,
      kind: candidate.kind,
      value: candidate.value,
      basis: candidate.basis,
      confidence: candidate.confidence,
      sources: candidate.sources,
    };
    expect(() => parsePortableStableCandidate({ ...base, status: 'active' }, { now: NOW }))
      .toThrow(/status and free-form notes are forbidden/);
    expect(() => parsePortableStableCandidate({ ...base, notes: 'Morgan likes tea' }, { now: NOW }))
      .toThrow(/free-form notes/);
    expect(() => parsePortableStableCandidate({ ...base, kind: 'ephemeral-status' }, { now: NOW }))
      .toThrow(/kind must be one of/);
    expect(() => parsePortableStableCandidate({
      ...base,
      kind: 'shared-language',
      relatedSubject: OTHER_CONTACT,
      value: {
        kind: 'shared-language', schemaVersion: 1, languageType: 'signal', phrase: 'ping', meaning: 'hello',
      },
    }, { now: NOW })).toThrow(/companion-contact dyad/);
  });
});

describe('deterministic conflict and correction policy', () => {
  it('coexists set values, contests opposing keys, and keeps both sides as history', async () => {
    const store = new InMemoryBiographicalProfileStore(() => NOW);
    const tea = await admitBiographicalCandidate({
      store,
      candidate: preferenceCandidate('likes'),
    });
    const coffee = await admitBiographicalCandidate({
      store,
      candidate: preferenceCandidate('likes', 'inferred', 'coffee'),
    });
    const opposition = await admitBiographicalCandidate({
      store,
      candidate: preferenceCandidate('dislikes'),
    });
    expect([tea.disposition, coffee.disposition, opposition.disposition])
      .toEqual(['coexisting', 'coexisting', 'contested']);
    expect((await store.getClaim(tea.claim.id))?.status).toBe('contested');
    expect((await store.getClaim(coffee.claim.id))?.status).toBe('active');
    expect(opposition.claim.status).toBe('contested');
  });

  it('keeps a re-extracted candidate contested while its conflict key is unresolved', async () => {
    const store = new InMemoryBiographicalProfileStore(() => NOW);
    await admitBiographicalCandidate({
      store,
      candidate: preferenceCandidate('likes'),
    });
    await admitBiographicalCandidate({
      store,
      candidate: preferenceCandidate('dislikes'),
    });

    const reextracted = await admitBiographicalCandidate({
      store,
      candidate: {
        ...preferenceCandidate('likes'),
        sources: [source('memory:likes-tea-new-source')],
      },
    });

    expect(reextracted.disposition).toBe('contested');
    expect(reextracted.claim.status).toBe('contested');
    expect(await store.listClaims({
      subject: CONTACT,
      kind: 'stable-preference',
      status: 'active',
    })).toEqual([]);
    expect(await store.listClaims({
      subject: CONTACT,
      kind: 'stable-preference',
      status: 'contested',
    })).toHaveLength(3);
  });

  it('lets an authorized explicit subject correction supersede inference append-only', async () => {
    const store = new InMemoryBiographicalProfileStore(() => NOW);
    const inferred = await admitBiographicalCandidate({
      store,
      candidate: preferenceCandidate('likes'),
    });
    const corrected = await admitBiographicalCandidate({
      store,
      candidate: preferenceCandidate('dislikes', 'explicit'),
      correctionAuthority: {
        actor: 'subject',
        subject: CONTACT,
        authorizationRef: 'contact-choice:v-2026-08-10',
      },
    });
    expect(corrected.disposition).toBe('corrected');
    expect(corrected.claim.status).toBe('active');
    expect(corrected.claim.supersedesClaimId).toBe(inferred.claim.id);
    expect((await store.getClaim(inferred.claim.id))?.status).toBe('superseded');
  });

  it('quarantines only a semantic-conflict candidate', async () => {
    const store = new InMemoryBiographicalProfileStore(() => NOW);
    const active = await admitBiographicalCandidate({
      store,
      candidate: preferenceCandidate('likes'),
    });
    const quarantined = await admitBiographicalCandidate({
      store,
      candidate: preferenceCandidate('dislikes'),
      semanticConflict: true,
    });
    expect(quarantined.disposition).toBe('quarantined');
    expect(quarantined.claim.status).toBe('quarantined');
    expect((await store.getClaim(active.claim.id))?.status).toBe('active');
  });

  it('rolls back interrupted conflict admission and retries without partial state', async () => {
    class InterruptingStore extends InMemoryBiographicalProfileStore {
      interrupt = false;

      override async transitionClaim(input: BiographicalTransitionInput) {
        const transitioned = await super.transitionClaim(input);
        if (this.interrupt) {
          this.interrupt = false;
          throw new Error('simulated interruption after status write');
        }
        return transitioned;
      }
    }

    const store = new InterruptingStore(() => NOW);
    const original = await admitBiographicalCandidate({
      store,
      candidate: preferenceCandidate('likes'),
    });
    store.interrupt = true;

    await expect(admitBiographicalCandidate({
      store,
      candidate: preferenceCandidate('dislikes'),
    })).rejects.toThrow('simulated interruption');
    expect((await store.getClaim(original.claim.id))?.status).toBe('active');
    expect(await store.listClaims({
      subject: CONTACT,
      kind: 'stable-preference',
      includeTerminal: true,
    })).toHaveLength(1);

    const retried = await admitBiographicalCandidate({
      store,
      candidate: preferenceCandidate('dislikes'),
    });
    expect(retried.disposition).toBe('contested');
    expect(await store.listClaims({
      subject: CONTACT,
      kind: 'stable-preference',
      status: 'contested',
    })).toHaveLength(2);
  });
});

describe('stable renderers and adaptive depth', () => {
  it('renders active current roles deterministically and never renders expired or superseded roles', async () => {
    const store = new InMemoryBiographicalProfileStore(() => NOW);
    const active = await store.writeClaim({
      subject: CONTACT,
      kind: 'role',
      value: {
        kind: 'role', schemaVersion: 1, roleType: 'employment', title: 'Engineer', organization: 'ACME',
      },
      basis: 'explicit',
      status: 'active',
      confidence: 1,
      sources: [source()],
      validFrom: '2026-01-01T00:00:00.000Z',
      validTo: '2026-09-01T00:00:00.000Z',
      now: NOW,
    });
    expect(presentBiographicalClaim(active, 'current-author', NOW)?.line)
      .toBe('- Current role — employment: Engineer at ACME');
    expect(presentBiographicalClaim(active, 'current-author', new Date('2026-09-01T00:00:00.000Z')))
      .toBeUndefined();
    const superseded = await store.transitionClaim({ claimId: active.id, to: 'superseded', now: NOW });
    expect(presentBiographicalClaim(superseded, 'current-author', NOW)).toBeUndefined();
  });

  it('derives depth only from verified governed evidence and bounds every work phase', () => {
    const policy = createDefaultBiographicalDepthPolicy();
    const evidence = {
      subject: CONTACT as Extract<BiographicalSubjectRef, { kind: 'contact' }>,
      canonicalContactVerified: true,
      trust: { verified: true as const, level: 'regular' as const, authorityRef: 'trust:v' },
      governedContexts: [
        { verified: true as const, contextId: 'dm-v', governanceAuthorityRef: 'channel:dm-v', kind: 'dm' as const, primaryContact: false },
        { verified: true as const, contextId: 'garden-v', governanceAuthorityRef: 'garden:contacts', kind: 'group' as const, primaryContact: false },
      ],
    };
    expect(deriveBiographicalCollectionDepth({ subject: CONTACT, contactEvidence: evidence, policy }))
      .toBe('developing');
    expect(deriveBiographicalCollectionDepth({
      subject: CONTACT,
      contactEvidence: {
        ...evidence,
        trust: { ...evidence.trust, level: 'trusted' as const },
        relationship: { verified: true, type: 'friend', authorityRef: 'contact:v' },
      },
      policy,
    })).toBe('full');
    expect(deriveBiographicalCollectionDepth({
      subject: CONTACT,
      contactEvidence: { ...evidence, canonicalContactVerified: false },
      policy,
    })).toBe('recognition');
    expect(deriveBiographicalCollectionDepth({ subject: COMPANION, policy })).toBe('full');

    const values = Array.from({ length: 100 }, (_, index) => index);
    expect(boundBiographicalDepthWork({ values, depth: 'recognition', phase: 'refresh', policy }))
      .toHaveLength(policy.recognition.candidateLimitPerRefresh);
    expect(boundBiographicalDepthWork({ values, depth: 'full', phase: 'turn', policy }))
      .toHaveLength(policy.full.turnClaimLimit);
    expect(biographicalRetentionLimit('full', policy)).toBeUndefined();
    expect(biographicalRetentionLimit('developing', policy)).toBe(policy.developing.retentionClaimLimit);
  });

  it('keeps sensitivity/disclosure unchanged on promotion and stops enrichment on demotion', () => {
    const policy = createDefaultBiographicalDepthPolicy();
    const promotion = planBiographicalDepthTransition({
      previousDepth: 'recognition', depth: 'developing', verifiedTrustLevel: 'trusted', policy,
    });
    expect(promotion).toEqual(expect.objectContaining({
      promoted: true,
      sensitivityEffect: 'unchanged',
      disclosureEffect: 'unchanged',
      backfillClaimLimit: policy.developing.backfillBatchLimit,
      deleteHistory: false,
    }));
    const demotion = planBiographicalDepthTransition({
      previousDepth: 'full', depth: 'recognition', verifiedTrustLevel: 'primary', policy,
    });
    expect(demotion).toEqual(expect.objectContaining({
      demoted: true,
      enrichmentAllowed: false,
      ordinaryTrustCeiling: 'regular',
      deleteHistory: false,
    }));
  });
});
