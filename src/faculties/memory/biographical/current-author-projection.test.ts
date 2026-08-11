import { describe, expect, it } from 'vitest';

import {
  createGroupConversationScope,
  type ConversationScopeSpeaker,
} from '../../../core/session/conversation-scope.js';
import type { ContextEnvelope } from '../../../system/trust/context-envelope.js';
import { ingestCurrentAuthorIdentityEvidence } from './current-author-ingest.js';
import { InMemoryBiographicalProfileStore } from './in-memory-store.js';
import {
  projectBiographicalContext,
  type BiographicalSourceRevalidator,
  type SourceRevalidationOutcome,
} from './projection.js';
import type {
  BiographicalClaim,
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
const Morgan: BiographicalSubjectRef = { kind: 'contact', contactId: 'v', subjectVersion: 1 };
const EVE: BiographicalSubjectRef = { kind: 'contact', contactId: 'eve', subjectVersion: 1 };

function envelope(channelPrivacy: ContextEnvelope['channelPrivacy']): ContextEnvelope {
  return { channelPrivacy, audienceScope: 'few', audienceKnowledge: 'all_known', broadcast: false };
}

function group(
  channelPrivacy: ContextEnvelope['channelPrivacy'],
  recentSpeakers: readonly ConversationScopeSpeaker[] = [],
) {
  return createGroupConversationScope({
    channelId: `discord:group:${channelPrivacy}`,
    envelope: envelope(channelPrivacy),
    recentSpeakers,
  });
}

function source(ref: string): BiographicalClaimSource {
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
  private readonly current = new Map<string, BiographicalClaimSource>();

  seed(sources: readonly BiographicalClaimSource[]): void {
    for (const item of sources) this.current.set(item.ref, item);
  }

  async revalidate(sources: readonly BiographicalClaimSource[]): Promise<SourceRevalidationOutcome> {
    const currentSources: BiographicalClaimSource[] = [];
    for (const item of sources) {
      const current = this.current.get(item.ref);
      if (current === undefined) {
        return { status: 'invalid', reason: 'missing', sourceRef: item.ref };
      }
      currentSources.push(current);
    }
    return { status: 'valid', currentSources };
  }
}

async function seedIdentity(input: {
  store: InMemoryBiographicalProfileStore;
  revalidator: MemoryRevalidator;
  subject?: BiographicalSubjectRef;
  value:
    | { kind: 'name'; name: string; role: 'primary' | 'alias' }
    | { kind: 'relationship'; relationshipType: 'partner' | 'friend' }
    | { kind: 'relational_nickname'; nickname: string };
  ref: string;
}): Promise<BiographicalClaim> {
  const currentAuthorSubject = input.subject ?? Morgan;
  const sources = [source(input.ref)];
  input.revalidator.seed(sources);
  const dyadic = input.value.kind !== 'name';
  const result = await ingestCurrentAuthorIdentityEvidence({
    store: input.store,
    evidence: {
      currentAuthorSubject,
      companionSubject: COMPANION,
      value: input.value,
      sources,
      confidence: 1,
      basis: 'explicit',
      attribution: {
        status: 'complete',
        participantSubjects: dyadic ? [currentAuthorSubject, COMPANION] : [currentAuthorSubject],
      },
      now: NOW,
    },
  });
  return result.claim;
}

async function makePublic(store: InMemoryBiographicalProfileStore, claim: BiographicalClaim): Promise<void> {
  await store.recordGrant({
    claimDigest: claim.claimDigest,
    sourceSetDigest: claim.sourceSetDigest,
    grantedSensitivity: 'public',
    authorizingActor: 'subject',
    authorityBasis: 'exact structured identity publication choice',
    reason: 'safe recognition in public rooms',
    now: NOW,
  });
}

describe('projectBiographicalContext — verified current author', () => {
  it('recognizes Morgan as the partner and nickname source in a public group without raw memories', async () => {
    const store = new InMemoryBiographicalProfileStore(() => NOW);
    const revalidator = new MemoryRevalidator();
    const name = await seedIdentity({ store, revalidator, value: { kind: 'name', name: 'Morgan', role: 'primary' }, ref: 'contact:v' });
    const relationship = await seedIdentity({ store, revalidator, value: { kind: 'relationship', relationshipType: 'partner' }, ref: 'memory:relationship-v' });
    const nickname = await seedIdentity({ store, revalidator, value: { kind: 'relational_nickname', nickname: 'Sunbeam loaf' }, ref: 'memory:nickname-v' });
    await makePublic(store, name);
    await makePublic(store, relationship);
    await makePublic(store, nickname);

    const result = await projectBiographicalContext(
      { store, revalidator, rebuildQueueMaxPending: 8 },
      {
        companionSubject: COMPANION,
        currentAuthor: { status: 'verified', subject: Morgan, trustLevel: 'primary' },
        conversationScope: group('public', [{ authorId: 'discord-v', name: 'Morgan' }]),
        now: NOW,
      },
    );

    expect(result.admittedClaimIds).toEqual([name.id, relationship.id, nickname.id]);
    expect(result.promptSection).toContain('## Current author identity');
    expect(result.promptSection).toContain('- Primary name: Morgan');
    expect(result.promptSection).toContain('- Relationship to the companion: partner');
    expect(result.promptSection).toContain('## Current author relational attribution');
    expect(result.promptSection).toContain('- The current author calls the companion “Sunbeam loaf”.');
    expect(result.promptSection).not.toContain('memory:');
    expect(result.promptSection).not.toContain('discord:dm:v');
    expect(result.disclosureSources).toHaveLength(3);
    for (const claim of [name, relationship, nickname]) {
      expect(result.disclosureSources.some(item => item.ref === `biographical:${claim.id}`)).toBe(true);
    }
  });

  it('never ambiently loads a present or rostered but unrelated contact', async () => {
    const store = new InMemoryBiographicalProfileStore(() => NOW);
    const revalidator = new MemoryRevalidator();
    const vName = await seedIdentity({ store, revalidator, value: { kind: 'name', name: 'Morgan', role: 'primary' }, ref: 'contact:v' });
    const eveName = await seedIdentity({ store, revalidator, subject: EVE, value: { kind: 'name', name: 'Eve', role: 'primary' }, ref: 'contact:eve' });
    await makePublic(store, vName);
    await makePublic(store, eveName);

    const result = await projectBiographicalContext(
      { store, revalidator, rebuildQueueMaxPending: 8 },
      {
        companionSubject: COMPANION,
        currentAuthor: { status: 'verified', subject: Morgan, trustLevel: 'regular' },
        conversationScope: group('public', [
          { authorId: 'discord-v', name: 'Morgan' },
          { authorId: 'discord-eve', name: 'Eve' },
        ]),
        now: NOW,
      },
    );

    expect(result.admittedClaimIds).toEqual([vName.id]);
    expect(result.promptSection).toContain('Morgan');
    expect(result.promptSection).not.toContain('Eve');
    expect(result.disclosureSources.some(item => item.ref === `biographical:${eveName.id}`)).toBe(false);
  });

  it.each(['missing', 'ambiguous'] as const)('fails closed when canonical author resolution is %s', async status => {
    const store = new InMemoryBiographicalProfileStore(() => NOW);
    const revalidator = new MemoryRevalidator();
    const name = await seedIdentity({ store, revalidator, value: { kind: 'name', name: 'Morgan', role: 'primary' }, ref: 'contact:v' });
    await makePublic(store, name);

    const result = await projectBiographicalContext(
      { store, revalidator, rebuildQueueMaxPending: 8 },
      {
        companionSubject: COMPANION,
        currentAuthor: { status },
        conversationScope: group('public', [{ authorId: 'discord-v', name: 'Morgan' }]),
        now: NOW,
      },
    );

    expect(result.admittedClaimIds).toEqual([]);
    expect(result.promptSection).toBe('');
    expect(result.disclosureSources).toEqual([]);
  });

  it('applies both the destination envelope and verified-author trust ceiling per claim', async () => {
    const store = new InMemoryBiographicalProfileStore(() => NOW);
    const revalidator = new MemoryRevalidator();
    const relationship = await seedIdentity({ store, revalidator, value: { kind: 'relationship', relationshipType: 'partner' }, ref: 'memory:relationship-v' });

    const publicTrust = await projectBiographicalContext(
      { store, revalidator, rebuildQueueMaxPending: 8 },
      {
        companionSubject: COMPANION,
        currentAuthor: { status: 'verified', subject: Morgan, trustLevel: 'public' },
        conversationScope: group('invite_only'),
        now: NOW,
      },
    );
    const regularTrust = await projectBiographicalContext(
      { store, revalidator, rebuildQueueMaxPending: 8 },
      {
        companionSubject: COMPANION,
        currentAuthor: { status: 'verified', subject: Morgan, trustLevel: 'regular' },
        conversationScope: group('invite_only'),
        now: NOW,
      },
    );

    expect(publicTrust.admittedClaimIds).toEqual([]);
    expect(publicTrust.withheld).toContainEqual(expect.objectContaining({
      claimId: relationship.id,
      reason: 'destination-disallowed',
    }));
    expect(regularTrust.admittedClaimIds).toEqual([relationship.id]);
    expect(regularTrust.disclosureSources[0]?.sensitivity).toBe('personal');
  });

  it('keeps current-author claims and lineage 1:1 under a bounded prompt budget', async () => {
    const store = new InMemoryBiographicalProfileStore(() => NOW);
    const revalidator = new MemoryRevalidator();
    const name = await seedIdentity({ store, revalidator, value: { kind: 'name', name: 'Morgan', role: 'primary' }, ref: 'contact:v' });
    const relationship = await seedIdentity({ store, revalidator, value: { kind: 'relationship', relationshipType: 'partner' }, ref: 'memory:relationship-v' });
    await makePublic(store, name);
    await makePublic(store, relationship);

    const result = await projectBiographicalContext(
      { store, revalidator, rebuildQueueMaxPending: 8 },
      {
        companionSubject: COMPANION,
        currentAuthor: { status: 'verified', subject: Morgan, trustLevel: 'primary' },
        conversationScope: group('public'),
        tokenBudget: 25,
        estimateTokens: () => 10,
        now: NOW,
      },
    );

    expect(result.admittedClaimIds).toEqual([name.id]);
    expect(result.disclosureSources).toHaveLength(1);
    expect(result.disclosureSources[0]?.ref).toBe(`biographical:${name.id}`);
    expect(result.withheld).toContainEqual(expect.objectContaining({
      claimId: relationship.id,
      reason: 'token-budget-exhausted',
    }));
  });
});
