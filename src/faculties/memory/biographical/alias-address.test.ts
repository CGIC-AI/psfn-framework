import { describe, expect, it } from 'vitest';

import type { ContactStorePort } from '../../../core/contacts/contact-store-port.js';
import { createBiographicalAliasResolver } from './alias-address.js';
import { InMemoryBiographicalProfileStore } from './in-memory-store.js';
import type { BiographicalSourceRevalidator, SourceRevalidationOutcome } from './projection.js';
import type { BiographicalClaimSource, BiographicalSubjectRef } from './types.js';

const SHA = 'a'.repeat(64);
const NOW = new Date('2026-08-10T12:00:00.000Z');
const COMPANION: Extract<BiographicalSubjectRef, { kind: 'companion' }> = {
  kind: 'companion',
  companionId: 'purrs',
  subjectVersion: 1,
};
const PARTNER: BiographicalSubjectRef = { kind: 'contact', contactId: 'v', subjectVersion: 1 };

function source(ref = 'memory:m-1'): BiographicalClaimSource {
  return {
    ref,
    revision: '2026-08-10T10:00:00.000Z',
    evidenceDigest: SHA,
    sensitivityAtProjection: 'personal',
    subjectEvidenceDigest: SHA,
    consentFingerprint: SHA,
    sourceChannelId: 'discord:dm:v',
  };
}

class MemoryRevalidator implements BiographicalSourceRevalidator {
  private readonly live = new Set<string>();

  seed(sources: readonly BiographicalClaimSource[]): void {
    for (const item of sources) this.live.add(item.ref);
  }

  drop(ref: string): void {
    this.live.delete(ref);
  }

  async revalidate(
    sources: readonly BiographicalClaimSource[],
  ): Promise<SourceRevalidationOutcome> {
    for (const item of sources) {
      if (!this.live.has(item.ref)) {
        return { status: 'invalid', reason: 'missing', sourceRef: item.ref };
      }
    }
    return { status: 'valid', currentSources: [...sources] };
  }
}

function contactStore(bindings: Record<string, { id: string; archivedAt?: Date }>): ContactStorePort {
  return {
    getByChannelIdentity: async (_source: string, participantId: string) =>
      bindings[participantId] as never,
  } as unknown as ContactStorePort;
}

async function seedNickname(input: {
  store: InMemoryBiographicalProfileStore;
  revalidator: MemoryRevalidator;
  nickname: string;
  ref: string;
  scope: 'self' | 'relational';
  portabilityScope: 'origin_only' | 'universal' | 'subject_present';
  relatedSubject?: BiographicalSubjectRef;
}) {
  const sources = [source(input.ref)];
  input.revalidator.seed(sources);
  return await input.store.writeClaim({
    subject: COMPANION,
    ...(input.relatedSubject !== undefined ? { relatedSubject: input.relatedSubject } : {}),
    kind: 'nickname',
    value: { kind: 'nickname', nickname: input.nickname, scope: input.scope },
    basis: 'explicit',
    status: 'active',
    portabilityScope: input.portabilityScope,
    confidence: 1,
    sources,
    now: NOW,
  });
}

describe('createBiographicalAliasResolver', () => {
  it('gives a bound speaker its own reviewed alias plus published baseline names', async () => {
    const store = new InMemoryBiographicalProfileStore(() => NOW);
    const revalidator = new MemoryRevalidator();
    await seedNickname({
      store,
      revalidator,
      nickname: 'Sunbeam loaf',
      ref: 'memory:relational',
      scope: 'relational',
      relatedSubject: PARTNER,
      portabilityScope: 'subject_present',
    });
    await seedNickname({
      store,
      revalidator,
      nickname: 'Purrs',
      ref: 'memory:self',
      scope: 'self',
      portabilityScope: 'universal',
    });
    // Reviewed, but nobody made it portable: it is not an address cue either.
    await seedNickname({
      store,
      revalidator,
      nickname: 'Only in the dark',
      ref: 'memory:origin',
      scope: 'self',
      portabilityScope: 'origin_only',
    });

    const resolver = createBiographicalAliasResolver({
      store,
      contactStore: contactStore({ 'discord-v': { id: 'v' } }),
      revalidator,
      companionSubject: COMPANION,
      minAliasLength: 3,
      now: () => NOW,
    });

    expect((await resolver.resolve({
      source: 'discord',
      transportParticipantId: 'discord-v',
    })).sort()).toEqual(['Purrs', 'Sunbeam loaf']);
  });

  it('gives an unrelated or unverified speaker only the published baseline names', async () => {
    const store = new InMemoryBiographicalProfileStore(() => NOW);
    const revalidator = new MemoryRevalidator();
    await seedNickname({
      store,
      revalidator,
      nickname: 'Sunbeam loaf',
      ref: 'memory:relational',
      scope: 'relational',
      relatedSubject: PARTNER,
      portabilityScope: 'subject_present',
    });
    const resolver = createBiographicalAliasResolver({
      store,
      contactStore: contactStore({
        'discord-eve': { id: 'eve' },
        'discord-archived': { id: 'v', archivedAt: NOW },
      }),
      revalidator,
      companionSubject: COMPANION,
      minAliasLength: 3,
      now: () => NOW,
    });

    // A verified but unrelated contact, an archived contact, and a speaker the
    // contact store does not know all resolve to nothing — the same answer, so
    // none of them can learn that a relationship-scoped nickname exists.
    for (const transportParticipantId of ['discord-eve', 'discord-archived', 'discord-nobody']) {
      expect(await resolver.resolve({ source: 'discord', transportParticipantId }))
        .toEqual([]);
    }
  });

  it('withdraws an alias whose sources no longer revalidate, and one below the floor', async () => {
    const store = new InMemoryBiographicalProfileStore(() => NOW);
    const revalidator = new MemoryRevalidator();
    await seedNickname({
      store,
      revalidator,
      nickname: 'Sunbeam loaf',
      ref: 'memory:relational',
      scope: 'relational',
      relatedSubject: PARTNER,
      portabilityScope: 'subject_present',
    });
    await seedNickname({
      store,
      revalidator,
      nickname: 'V',
      ref: 'memory:short',
      scope: 'relational',
      relatedSubject: PARTNER,
      portabilityScope: 'subject_present',
    });
    const bindings = { 'discord-v': { id: 'v' } };
    const resolver = createBiographicalAliasResolver({
      store,
      contactStore: contactStore(bindings),
      revalidator,
      companionSubject: COMPANION,
      minAliasLength: 3,
      now: () => NOW,
    });

    // A one-character alias is never a safe summons.
    expect(await resolver.resolve({ source: 'discord', transportParticipantId: 'discord-v' }))
      .toEqual(['Sunbeam loaf']);

    // A tombstoned, quarantined or vanished source withdraws the alias on the
    // very next message: the same read-time gate the projection applies.
    revalidator.drop('memory:relational');
    expect(await resolver.resolve({ source: 'discord', transportParticipantId: 'discord-v' }))
      .toEqual([]);
  });
});
