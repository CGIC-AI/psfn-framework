import { describe, expect, it, vi } from 'vitest';

import { createGroupConversationScope } from '../../../core/session/conversation-scope.js';
import { parseMessageAddressingMetadata } from '../../../shared/contracts/message-addressing.js';
import type { ContextEnvelope } from '../../../system/trust/context-envelope.js';
import { ingestCurrentAuthorIdentityEvidence } from './current-author-ingest.js';
import type {
  CanonicalAddressedContactResolution,
  CanonicalAddressedContactResolver,
} from './explicit-subject-selection.js';
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
const AUTHOR: BiographicalSubjectRef = {
  kind: 'contact',
  contactId: 'author',
  subjectVersion: 1,
};
const EVE: BiographicalSubjectRef = {
  kind: 'contact',
  contactId: 'eve',
  subjectVersion: 1,
};
const MALLORY: BiographicalSubjectRef = {
  kind: 'contact',
  contactId: 'mallory',
  subjectVersion: 1,
};

function envelope(channelPrivacy: ContextEnvelope['channelPrivacy']): ContextEnvelope {
  return {
    channelPrivacy,
    audienceScope: 'few',
    audienceKnowledge: 'all_known',
    broadcast: false,
  };
}

function group(
  channelPrivacy: ContextEnvelope['channelPrivacy'],
  recentSpeakers: readonly { authorId: string; name: string }[] = [],
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
    sourceChannelId: 'discord:dm:subject',
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

class AddressedContactResolver implements CanonicalAddressedContactResolver {
  readonly resolve = vi.fn(async (
    input: Parameters<CanonicalAddressedContactResolver['resolve']>[0],
  ): Promise<CanonicalAddressedContactResolution> => (
    this.resolutions.get(input.transportParticipantId) ?? { status: 'missing' }
  ));

  constructor(
    private readonly resolutions: ReadonlyMap<string, CanonicalAddressedContactResolution>,
  ) {}
}

async function seedName(input: {
  store: InMemoryBiographicalProfileStore;
  revalidator: MemoryRevalidator;
  subject: BiographicalSubjectRef;
  name: string;
  ref: string;
}): Promise<BiographicalClaim> {
  const sources = [source(input.ref)];
  input.revalidator.seed(sources);
  const result = await ingestCurrentAuthorIdentityEvidence({
    store: input.store,
    evidence: {
      currentAuthorSubject: input.subject,
      companionSubject: COMPANION,
      value: { kind: 'name', name: input.name, role: 'primary' },
      sources,
      confidence: 1,
      basis: 'explicit',
      attribution: { status: 'complete', participantSubjects: [input.subject] },
      now: NOW,
    },
  });
  return result.claim;
}

async function makePublic(
  store: InMemoryBiographicalProfileStore,
  claim: BiographicalClaim,
): Promise<void> {
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

function addressedParticipants(input: {
  channelId: string;
  participants: readonly {
    id: string;
    name: string;
    evidence: readonly ('mention' | 'reply')[];
  }[];
}) {
  const mentionedTargets = input.participants
    .filter(participant => participant.evidence.includes('mention'))
    .map(participant => ({ authorId: participant.id, authorName: participant.name }));
  const replied = input.participants.find(participant => participant.evidence.includes('reply'));
  return parseMessageAddressingMetadata({
    schemaVersion: 2,
    source: 'discord',
    author: { authorId: 'discord-author', authorName: 'Author' },
    observer: { authorId: 'discord-companion', authorName: 'Purrsephone' },
    mentionedTargets,
    ...(replied
      ? {
        replyTarget: {
          messageId: 'reply-message',
          author: { authorId: replied.id, authorName: replied.name },
        },
      }
      : {}),
    channel: { scope: 'group', channelId: input.channelId },
    resolvedAddressee: {
      kind: 'participants',
      participants: input.participants.map(participant => ({
        authorId: participant.id,
        authorName: participant.name,
        evidence: participant.evidence,
      })),
    },
  });
}

function unresolvedReply(channelId: string) {
  return parseMessageAddressingMetadata({
    schemaVersion: 2,
    source: 'discord',
    author: { authorId: 'discord-author', authorName: 'Author' },
    observer: { authorId: 'discord-companion', authorName: 'Purrsephone' },
    mentionedTargets: [],
    replyTarget: { messageId: 'missing-reply' },
    channel: { scope: 'group', channelId },
    resolvedAddressee: { kind: 'unresolved_reply', messageId: 'missing-reply' },
  });
}

function verified(
  subject: Extract<BiographicalSubjectRef, { kind: 'contact' }>,
  participation: 'authoritative' | 'unproven',
): CanonicalAddressedContactResolution {
  return participation === 'authoritative'
    ? {
      status: 'verified',
      subject,
      trustLevel: 'regular',
      currentParticipation: {
        status: 'authoritative',
        proofRef: `transport-presence:${subject.contactId}`,
      },
    }
    : { status: 'verified', subject, trustLevel: 'regular', currentParticipation: { status: 'unproven' } };
}

describe('projectBiographicalContext — explicit reply and mention subjects', () => {
  it('projects a verified mentioned subject public claim without fuzzy-matching its display name', async () => {
    const store = new InMemoryBiographicalProfileStore(() => NOW);
    const revalidator = new MemoryRevalidator();
    const eveName = await seedName({ store, revalidator, subject: EVE, name: 'Eve', ref: 'contact:eve' });
    await makePublic(store, eveName);
    const resolver = new AddressedContactResolver(new Map([
      ['discord-eve', verified(EVE, 'unproven')],
    ]));
    const scope = group('public');

    const result = await projectBiographicalContext(
      {
        store,
        revalidator,
        rebuildQueueMaxPending: 8,
        explicitAddressing: { resolver, maxSubjects: 2 },
      },
      {
        companionSubject: COMPANION,
        currentAuthor: { status: 'verified', subject: AUTHOR, trustLevel: 'regular' },
        conversationScope: scope,
        messageAddressing: addressedParticipants({
          channelId: scope.channelId,
          participants: [{ id: 'discord-eve', name: 'Not Eve', evidence: ['mention'] }],
        }),
        now: NOW,
      },
    );

    expect(resolver.resolve).toHaveBeenCalledWith({
      source: 'discord',
      transportParticipantId: 'discord-eve',
      channelId: scope.channelId,
      evidence: ['mention'],
    });
    expect(result.admittedClaimIds).toEqual([eveName.id]);
    expect(result.promptSection).toContain('## Explicitly relevant contact');
    expect(result.promptSection).toContain('Primary name: Eve');
    expect(result.promptSection).not.toContain('Not Eve');
    expect(result.disclosureSources).toHaveLength(1);
    expect(result.disclosureSources[0]?.ref).toBe(`biographical:${eveName.id}`);
  });

  it('requires authoritative current participation proof as well as an allowed destination for personal claims', async () => {
    const store = new InMemoryBiographicalProfileStore(() => NOW);
    const revalidator = new MemoryRevalidator();
    const eveName = await seedName({ store, revalidator, subject: EVE, name: 'Eve', ref: 'contact:eve' });
    const inviteScope = group('invite_only');
    const addressing = addressedParticipants({
      channelId: inviteScope.channelId,
      participants: [{ id: 'discord-eve', name: 'Eve', evidence: ['reply'] }],
    });

    const withoutProof = await projectBiographicalContext(
      {
        store,
        revalidator,
        rebuildQueueMaxPending: 8,
        explicitAddressing: {
          resolver: new AddressedContactResolver(new Map([
            ['discord-eve', verified(EVE, 'unproven')],
          ])),
          maxSubjects: 2,
        },
      },
      {
        companionSubject: COMPANION,
        conversationScope: inviteScope,
        messageAddressing: addressing,
        now: NOW,
      },
    );
    expect(withoutProof.admittedClaimIds).toEqual([]);
    expect(withoutProof.promptSection).toBe('');
    expect(withoutProof.withheld).toContainEqual(expect.objectContaining({
      claimId: eveName.id,
      reason: 'participation-unproven',
    }));

    const withProof = await projectBiographicalContext(
      {
        store,
        revalidator,
        rebuildQueueMaxPending: 8,
        explicitAddressing: {
          resolver: new AddressedContactResolver(new Map([
            ['discord-eve', verified(EVE, 'authoritative')],
          ])),
          maxSubjects: 2,
        },
      },
      {
        companionSubject: COMPANION,
        conversationScope: inviteScope,
        messageAddressing: addressing,
        now: NOW,
      },
    );
    expect(withProof.admittedClaimIds).toEqual([eveName.id]);
    expect(withProof.disclosureSources).toHaveLength(1);
    expect(withProof.disclosureSources[0]?.provenanceRefs)
      .toContain('biographical-participation:transport-presence:eve');

    const publicScope = group('public');
    const disallowedDestination = await projectBiographicalContext(
      {
        store,
        revalidator,
        rebuildQueueMaxPending: 8,
        explicitAddressing: {
          resolver: new AddressedContactResolver(new Map([
            ['discord-eve', verified(EVE, 'authoritative')],
          ])),
          maxSubjects: 2,
        },
      },
      {
        companionSubject: COMPANION,
        conversationScope: publicScope,
        messageAddressing: addressedParticipants({
          channelId: publicScope.channelId,
          participants: [{ id: 'discord-eve', name: 'Eve', evidence: ['reply'] }],
        }),
        now: NOW,
      },
    );
    expect(disallowedDestination.admittedClaimIds).toEqual([]);
    expect(disallowedDestination.withheld).toContainEqual(expect.objectContaining({
      claimId: eveName.id,
      reason: 'no-publication-choice',
    }));
  });

  it('does not use recent speakers or historical roster knowledge as subject relevance or participation proof', async () => {
    const store = new InMemoryBiographicalProfileStore(() => NOW);
    const revalidator = new MemoryRevalidator();
    const eveName = await seedName({ store, revalidator, subject: EVE, name: 'Eve', ref: 'contact:eve' });
    await makePublic(store, eveName);
    const resolver = new AddressedContactResolver(new Map([
      ['discord-eve', verified(EVE, 'authoritative')],
    ]));

    const result = await projectBiographicalContext(
      { store, revalidator, rebuildQueueMaxPending: 8, explicitAddressing: { resolver, maxSubjects: 2 } },
      {
        companionSubject: COMPANION,
        conversationScope: group('invite_only', [{ authorId: 'discord-eve', name: 'Eve' }]),
        now: NOW,
      },
    );

    expect(result.admittedClaimIds).toEqual([]);
    expect(result.promptSection).toBe('');
    expect(result.disclosureSources).toEqual([]);
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it('does not treat the companion observer mention used to address the bot as a contact subject', async () => {
    const store = new InMemoryBiographicalProfileStore(() => NOW);
    const revalidator = new MemoryRevalidator();
    const resolver = new AddressedContactResolver(new Map());
    const scope = group('public');

    const result = await projectBiographicalContext(
      { store, revalidator, rebuildQueueMaxPending: 8, explicitAddressing: { resolver, maxSubjects: 2 } },
      {
        companionSubject: COMPANION,
        conversationScope: scope,
        messageAddressing: addressedParticipants({
          channelId: scope.channelId,
          participants: [{
            id: 'discord-companion',
            name: 'Purrsephone',
            evidence: ['mention'],
          }],
        }),
        now: NOW,
      },
    );

    expect(result.promptSection).toBe('');
    expect(result.withheld).toEqual([]);
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', { status: 'missing' } as const, 'explicit-contact-missing'],
    ['ambiguous', { status: 'ambiguous' } as const, 'explicit-contact-ambiguous'],
  ])('fails closed when a mentioned contact binding is %s', async (_label, resolution, reason) => {
    const store = new InMemoryBiographicalProfileStore(() => NOW);
    const revalidator = new MemoryRevalidator();
    const scope = group('public');
    const resolver = new AddressedContactResolver(new Map([['discord-eve', resolution]]));

    const result = await projectBiographicalContext(
      { store, revalidator, rebuildQueueMaxPending: 8, explicitAddressing: { resolver, maxSubjects: 2 } },
      {
        companionSubject: COMPANION,
        conversationScope: scope,
        messageAddressing: addressedParticipants({
          channelId: scope.channelId,
          participants: [{ id: 'discord-eve', name: 'Eve', evidence: ['mention'] }],
        }),
        now: NOW,
      },
    );

    expect(result.promptSection).toBe('');
    expect(result.withheld).toContainEqual(expect.objectContaining({ reason }));
  });

  it('fails closed when an explicit transport target has no resolved participant entry', async () => {
    const store = new InMemoryBiographicalProfileStore(() => NOW);
    const revalidator = new MemoryRevalidator();
    const scope = group('public');
    const resolver = new AddressedContactResolver(new Map([
      ['discord-eve', verified(EVE, 'authoritative')],
    ]));
    const addressing = parseMessageAddressingMetadata({
      schemaVersion: 2,
      source: 'discord',
      author: { authorId: 'discord-author', authorName: 'Author' },
      observer: { authorId: 'discord-companion', authorName: 'Purrsephone' },
      mentionedTargets: [{ authorId: 'discord-eve', authorName: 'Eve' }],
      channel: { scope: 'group', channelId: scope.channelId },
      resolvedAddressee: { kind: 'room', channelId: scope.channelId },
    });

    const result = await projectBiographicalContext(
      { store, revalidator, rebuildQueueMaxPending: 8, explicitAddressing: { resolver, maxSubjects: 2 } },
      {
        companionSubject: COMPANION,
        conversationScope: scope,
        messageAddressing: addressing,
        now: NOW,
      },
    );

    expect(result.promptSection).toBe('');
    expect(result.withheld).toContainEqual(expect.objectContaining({
      addressedParticipantId: 'discord-eve',
      reason: 'explicit-contact-missing',
    }));
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it('reports explicit addressing when no canonical-contact resolver was injected', async () => {
    const store = new InMemoryBiographicalProfileStore(() => NOW);
    const revalidator = new MemoryRevalidator();
    const scope = group('public');

    const result = await projectBiographicalContext(
      { store, revalidator, rebuildQueueMaxPending: 8 },
      {
        companionSubject: COMPANION,
        conversationScope: scope,
        messageAddressing: addressedParticipants({
          channelId: scope.channelId,
          participants: [{ id: 'discord-eve', name: 'Eve', evidence: ['mention'] }],
        }),
        now: NOW,
      },
    );

    expect(result.promptSection).toBe('');
    expect(result.withheld).toContainEqual(expect.objectContaining({
      reason: 'explicit-resolver-unavailable',
    }));
  });

  it('fails closed with an inspectable reason for an authorless reply target', async () => {
    const store = new InMemoryBiographicalProfileStore(() => NOW);
    const revalidator = new MemoryRevalidator();
    const scope = group('public');
    const resolver = new AddressedContactResolver(new Map());

    const result = await projectBiographicalContext(
      { store, revalidator, rebuildQueueMaxPending: 8, explicitAddressing: { resolver, maxSubjects: 2 } },
      {
        companionSubject: COMPANION,
        conversationScope: scope,
        messageAddressing: unresolvedReply(scope.channelId),
        now: NOW,
      },
    );

    expect(result.promptSection).toBe('');
    expect(result.disclosureSources).toEqual([]);
    expect(result.withheld).toContainEqual(expect.objectContaining({
      reason: 'explicit-reply-unresolved',
    }));
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it('bounds explicit subjects and never ambiently loads an unmentioned roster contact', async () => {
    const store = new InMemoryBiographicalProfileStore(() => NOW);
    const revalidator = new MemoryRevalidator();
    const eveName = await seedName({ store, revalidator, subject: EVE, name: 'Eve', ref: 'contact:eve' });
    const malloryName = await seedName({ store, revalidator, subject: MALLORY, name: 'Mallory', ref: 'contact:mallory' });
    await makePublic(store, eveName);
    await makePublic(store, malloryName);
    const resolver = new AddressedContactResolver(new Map([
      ['discord-eve', verified(EVE, 'unproven')],
      ['discord-mallory', verified(MALLORY, 'unproven')],
    ]));
    const scope = group('public', [{ authorId: 'discord-rostered', name: 'Rostered Contact' }]);

    const result = await projectBiographicalContext(
      { store, revalidator, rebuildQueueMaxPending: 8, explicitAddressing: { resolver, maxSubjects: 1 } },
      {
        companionSubject: COMPANION,
        conversationScope: scope,
        messageAddressing: addressedParticipants({
          channelId: scope.channelId,
          participants: [
            { id: 'discord-eve', name: 'Eve', evidence: ['mention', 'reply'] },
            { id: 'discord-mallory', name: 'Mallory', evidence: ['mention'] },
          ],
        }),
        now: NOW,
      },
    );

    expect(result.admittedClaimIds).toEqual([eveName.id]);
    expect(result.promptSection).toContain('Eve');
    expect(result.promptSection).not.toContain('Mallory');
    expect(result.promptSection).not.toContain('Rostered Contact');
    expect(result.withheld).toContainEqual(expect.objectContaining({
      reason: 'explicit-subject-limit',
    }));
    expect(resolver.resolve).toHaveBeenCalledTimes(1);
    expect(result.admittedClaimIds).toHaveLength(result.disclosureSources.length);
  });
});
