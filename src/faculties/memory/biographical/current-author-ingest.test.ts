import { describe, expect, it, vi } from 'vitest';

import { InMemoryBiographicalProfileStore } from './in-memory-store.js';
import {
  currentAuthorIdentityCandidateFingerprint,
  ingestCurrentAuthorIdentityEvidence,
  type CurrentAuthorIdentityEvidence,
} from './current-author-ingest.js';
import { BiographicalClaimValidationError } from './kernel.js';
import type {
  BiographicalClaimSource,
  BiographicalSubjectRef,
} from './types.js';

const SHA = 'a'.repeat(64);
const NOW = new Date('2026-08-10T12:00:00.000Z');
const COMPANION: BiographicalSubjectRef = {
  kind: 'companion',
  companionId: 'purrs',
  subjectVersion: 1,
};
const V: BiographicalSubjectRef = { kind: 'contact', contactId: 'v', subjectVersion: 1 };
const EVE: BiographicalSubjectRef = { kind: 'contact', contactId: 'eve', subjectVersion: 1 };

function source(ref: string, patch: Partial<BiographicalClaimSource> = {}): BiographicalClaimSource {
  return {
    ref,
    revision: '2026-08-10T10:00:00.000Z',
    evidenceDigest: SHA,
    sensitivityAtProjection: 'personal',
    subjectEvidenceDigest: SHA,
    consentFingerprint: SHA,
    sourceChannelId: 'dm:with-v',
    ...patch,
  };
}

function evidence(
  value: CurrentAuthorIdentityEvidence['value'],
  participants: readonly BiographicalSubjectRef[],
  patch: Partial<CurrentAuthorIdentityEvidence> = {},
): CurrentAuthorIdentityEvidence {
  return {
    currentAuthorSubject: V,
    companionSubject: COMPANION,
    value,
    sources: [source('contact:v')],
    confidence: 1,
    basis: 'explicit',
    attribution: { status: 'complete', participantSubjects: participants },
    now: NOW,
    ...patch,
  };
}

describe('ingestCurrentAuthorIdentityEvidence', () => {
  it('writes registered name, relationship, and dyadic nickname claims with exact subject shapes', async () => {
    const store = new InMemoryBiographicalProfileStore(() => NOW);

    const name = await ingestCurrentAuthorIdentityEvidence({
      store,
      evidence: evidence({ kind: 'name', name: 'V', role: 'primary' }, [V]),
    });
    const relationship = await ingestCurrentAuthorIdentityEvidence({
      store,
      evidence: evidence({ kind: 'relationship', relationshipType: 'partner' }, [V, COMPANION]),
    });
    const nickname = await ingestCurrentAuthorIdentityEvidence({
      store,
      evidence: evidence({ kind: 'relational_nickname', nickname: 'Sunbeam loaf' }, [V, COMPANION]),
    });

    expect(name.claim).toMatchObject({
      subject: V,
      kind: 'name',
      value: { kind: 'name', name: 'V', role: 'primary' },
      status: 'active',
    });
    expect(relationship.claim).toMatchObject({
      subject: V,
      relatedSubject: COMPANION,
      kind: 'relationship',
      value: { kind: 'relationship', relationshipType: 'partner' },
      status: 'active',
    });
    expect(nickname.claim).toMatchObject({
      subject: COMPANION,
      relatedSubject: V,
      kind: 'nickname',
      value: { kind: 'nickname', nickname: 'Sunbeam loaf', scope: 'relational' },
      status: 'active',
    });
  });

  it('closes the change gate without synthesis or a write for identical evidence', async () => {
    const store = new InMemoryBiographicalProfileStore(() => NOW);
    const input = evidence({ kind: 'relationship', relationshipType: 'partner' }, [V, COMPANION]);
    const first = await ingestCurrentAuthorIdentityEvidence({ store, evidence: input });
    const synthesize = vi.fn(async () => input.value);

    const second = await ingestCurrentAuthorIdentityEvidence({ store, evidence: input, synthesize });

    expect(second).toMatchObject({ status: 'unchanged', claim: { id: first.claim.id } });
    expect(synthesize).not.toHaveBeenCalled();
    await expect(store.listClaims({ status: 'active' })).resolves.toHaveLength(1);
  });

  it('supersedes only the same structured claim when its exact source set drifts', async () => {
    const store = new InMemoryBiographicalProfileStore(() => NOW);
    const firstEvidence = evidence({ kind: 'name', name: 'V', role: 'primary' }, [V]);
    const first = await ingestCurrentAuthorIdentityEvidence({ store, evidence: firstEvidence });
    const drifted = evidence(
      { kind: 'name', name: 'V', role: 'primary' },
      [V],
      { sources: [source('contact:v', { revision: '2026-08-10T11:00:00.000Z' })] },
    );

    expect(currentAuthorIdentityCandidateFingerprint(firstEvidence).claimDigest)
      .toBe(currentAuthorIdentityCandidateFingerprint(drifted).claimDigest);
    expect(currentAuthorIdentityCandidateFingerprint(firstEvidence).sourceSetDigest)
      .not.toBe(currentAuthorIdentityCandidateFingerprint(drifted).sourceSetDigest);

    const second = await ingestCurrentAuthorIdentityEvidence({ store, evidence: drifted });
    expect(second).toMatchObject({ status: 'superseded', superseded: { id: first.claim.id } });
    await expect(store.getClaim(first.claim.id)).resolves.toMatchObject({ status: 'superseded' });
  });

  it('rejects incomplete attribution and any additional human before writing', async () => {
    const store = new InMemoryBiographicalProfileStore(() => NOW);
    const incomplete = evidence(
      { kind: 'relationship', relationshipType: 'partner' },
      [V, COMPANION],
      { attribution: { status: 'incomplete', participantSubjects: [V, COMPANION] } },
    );
    const gossipShaped = evidence(
      { kind: 'relational_nickname', nickname: 'A third-party story' },
      [V, COMPANION, EVE],
    );

    await expect(ingestCurrentAuthorIdentityEvidence({ store, evidence: incomplete }))
      .rejects.toThrow(/complete canonical attribution/u);
    await expect(ingestCurrentAuthorIdentityEvidence({ store, evidence: gossipShaped }))
      .rejects.toThrow(/unsupported third-party subject/u);
    await expect(store.listClaims({ includeTerminal: true })).resolves.toEqual([]);
  });

  it('rejects unknown/gossip-shaped candidates and unregistered relationship labels', async () => {
    const store = new InMemoryBiographicalProfileStore(() => NOW);
    const unknown = evidence(
      { kind: 'gossip', statement: 'someone said something' } as never,
      [V, COMPANION],
    );
    const unregisteredRelationship = evidence(
      { kind: 'relationship', relationshipType: 'someone-was-fat' } as never,
      [V, COMPANION],
    );
    const proseSmuggling = evidence(
      {
        kind: 'relationship',
        relationshipType: 'partner',
        statement: 'someone said something about another person',
      } as never,
      [V, COMPANION],
    );

    await expect(ingestCurrentAuthorIdentityEvidence({ store, evidence: unknown }))
      .rejects.toBeInstanceOf(BiographicalClaimValidationError);
    await expect(ingestCurrentAuthorIdentityEvidence({ store, evidence: unregisteredRelationship }))
      .rejects.toThrow(/registered contact relationship/u);
    await expect(ingestCurrentAuthorIdentityEvidence({ store, evidence: proseSmuggling }))
      .rejects.toThrow(/only kind and relationshipType/u);
  });
});
