import { describe, expect, it } from 'vitest';
import { fromPartial } from '@total-typescript/shoehorn';

import type { ContactStorePort } from '../../../core/contacts/contact-store-port.js';
import type { Contact } from '../../../core/contacts/types.js';
import { createGroupConversationScope } from '../../../core/session/conversation-scope.js';
import {
  MESSAGE_ADDRESSING_SCHEMA_VERSION,
  type MessageAddressingMetadata,
} from '../../../shared/contracts/message-addressing.js';
import { createDefaultBiographicalDepthPolicy } from '../../../system/config/biographical-depth-policy.js';
import { InMemoryBiographicalProfileStore } from './in-memory-store.js';
import type { BiographicalSourceRevalidator } from './projection.js';
import { createRuntimeBiographicalProjection } from './runtime-projection.js';
import type { BiographicalClaimSource, BiographicalSubjectRef } from './types.js';

const NOW = new Date('2026-09-10T12:00:00.000Z');
const COMPANION: Extract<BiographicalSubjectRef, { kind: 'companion' }> = {
  kind: 'companion',
  companionId: 'companion-test',
  subjectVersion: 1,
};
const ALICE: Extract<BiographicalSubjectRef, { kind: 'contact' }> = {
  kind: 'contact',
  contactId: 'contact-alice',
  subjectVersion: 1,
};
const BOB: Extract<BiographicalSubjectRef, { kind: 'contact' }> = {
  kind: 'contact',
  contactId: 'contact-bob',
  subjectVersion: 1,
};
const ABSENT: Extract<BiographicalSubjectRef, { kind: 'contact' }> = {
  kind: 'contact',
  contactId: 'contact-absent',
  subjectVersion: 1,
};

function claimSource(ref: string, channelId: string): BiographicalClaimSource {
  return {
    ref,
    revision: '1',
    evidenceDigest: 'a'.repeat(64),
    sensitivityAtProjection: 'personal',
    subjectEvidenceDigest: 'c'.repeat(64),
    consentFingerprint: 'd'.repeat(64),
    sourceChannelId: channelId,
    sourceType: 'semantic',
    lifecycleStateAtProjection: 'active',
  };
}

function makeRevalidator(sources: readonly BiographicalClaimSource[]): BiographicalSourceRevalidator {
  const byRef = new Map(sources.map(item => [item.ref, item]));
  return {
    revalidate: async refs => {
      const currentSources = refs.map(item => byRef.get(item.ref));
      if (currentSources.some(item => item === undefined)) {
        return {
          status: 'invalid',
          reason: 'source-deleted',
          sourceRef: refs[0]?.ref ?? 'memory:unknown',
        };
      }
      return {
        status: 'valid',
        currentSources: currentSources as BiographicalClaimSource[],
      };
    },
  };
}

function makeContact(
  id: string,
  displayName: string,
  channelIds: readonly string[] = [],
): Contact {
  return {
    id,
    displayName,
    trustLevel: 'trusted',
    relationshipType: 'friend',
    firstSeen: '2025-01-01T00:00:00.000Z',
    lastSeen: '2026-09-10T11:00:00.000Z',
    conversationChannels: channelIds.map(channelId => ({
      channelId,
      channelType: 'discord_text',
      channelPrivacy: 'invite_only',
      lastSeen: '2026-09-10T11:00:00.000Z',
      messageCount: 3,
    })),
  };
}

function makeAddressing(
  channelId: string,
  mentioned: readonly { authorId: string; authorName: string }[],
  replyTarget?: { messageId: string; author: { authorId: string; authorName: string } },
): MessageAddressingMetadata {
  const byId = new Map<string, {
    authorId: string;
    authorName: string;
    evidence: Set<'mention' | 'reply'>;
  }>();
  for (const target of mentioned) {
    byId.set(target.authorId, {
      authorId: target.authorId,
      authorName: target.authorName,
      evidence: new Set(['mention']),
    });
  }
  if (replyTarget) {
    const existing = byId.get(replyTarget.author.authorId);
    if (existing) {
      existing.evidence.add('reply');
    } else {
      byId.set(replyTarget.author.authorId, {
        authorId: replyTarget.author.authorId,
        authorName: replyTarget.author.authorName,
        evidence: new Set(['reply']),
      });
    }
  }
  const participants = [...byId.values()].map(entry => ({
    authorId: entry.authorId,
    authorName: entry.authorName,
    evidence: [...entry.evidence],
  }));
  return {
    schemaVersion: MESSAGE_ADDRESSING_SCHEMA_VERSION,
    source: 'discord',
    channel: {
      scope: 'group',
      channelId,
    },
    observer: { authorId: 'bot-companion', authorName: 'Companion' },
    author: { authorId: 'discord-alice', authorName: 'Alice' },
    mentionedTargets: mentioned.map(target => ({
      authorId: target.authorId,
      authorName: target.authorName,
    })),
    ...(replyTarget ? {
      replyTarget: {
        messageId: replyTarget.messageId,
        author: {
          authorId: replyTarget.author.authorId,
          authorName: replyTarget.author.authorName,
        },
      },
    } : {}),
    resolvedAddressee: participants.length > 0
      ? { kind: 'participants', participants }
      : { kind: 'room', channelId },
  };
}

describe('createRuntimeBiographicalProjection live participation', () => {
  it('proves currentParticipation for present/replied speakers and passes present speakers for group claims', async () => {
    const roomId = 'discord:group:lounge';
    const store = new InMemoryBiographicalProfileStore(() => NOW);
    const bobPrefSource = claimSource('memory:bob-pref', 'discord:dm:bob');
    const absentPrefSource = claimSource('memory:absent-pref', 'discord:dm:absent');
    const groupPhraseSource = claimSource('memory:group-phrase', roomId);

    const bobClaim = await store.writeClaim({
      subject: BOB,
      kind: 'stable-preference',
      value: {
        kind: 'stable-preference',
        schemaVersion: 1,
        domain: 'food',
        target: 'matcha lattes',
        polarity: 'prefers',
      },
      basis: 'explicit',
      status: 'active',
      portabilityScope: 'subject_present',
      confidence: 0.95,
      sources: [bobPrefSource],
      now: NOW,
    });
    const absentClaim = await store.writeClaim({
      subject: ABSENT,
      kind: 'stable-preference',
      value: {
        kind: 'stable-preference',
        schemaVersion: 1,
        domain: 'food',
        target: 'espresso',
        polarity: 'likes',
      },
      basis: 'explicit',
      status: 'active',
      portabilityScope: 'subject_present',
      confidence: 0.95,
      sources: [absentPrefSource],
      now: NOW,
    });
    const groupClaim = await store.writeClaim({
      subject: COMPANION,
      participants: [ALICE, BOB],
      kind: 'shared-language',
      value: {
        kind: 'shared-language',
        schemaVersion: 1,
        languageType: 'phrase',
        phrase: 'lantern check',
        meaning: 'evening wind-down together',
      },
      basis: 'explicit',
      status: 'active',
      portabilityScope: 'subject_present',
      confidence: 0.95,
      sources: [groupPhraseSource],
      now: NOW,
    });

    const aliceContact = makeContact(ALICE.contactId, 'Alice', [roomId]);
    const bobContact = makeContact(BOB.contactId, 'Bob', [roomId]);
    const absentContact = makeContact(ABSENT.contactId, 'Devon', []);

    const byDiscordId = new Map<string, Contact>([
      ['discord-alice', aliceContact],
      ['discord-bob', bobContact],
      ['discord-absent', absentContact],
    ]);
    const byId = new Map<string, Contact>([
      [aliceContact.id, aliceContact],
      [bobContact.id, bobContact],
      [absentContact.id, absentContact],
    ]);
    const contactStore = fromPartial<ContactStorePort>({
      getByChannelIdentity: async (_source, externalId) => byDiscordId.get(externalId),
      getById: async id => byId.get(id),
      listRoomRoster: async () => [],
    });

    const projection = createRuntimeBiographicalProjection({
      store,
      revalidator: makeRevalidator([bobPrefSource, absentPrefSource, groupPhraseSource]),
      contactStore,
      companionId: COMPANION.companionId,
      policy: createDefaultBiographicalDepthPolicy(),
    });

    // Mention both Bob (recent speaker in room) and Devon (never participated in room).
    const result = await projection.projectBiographicalContext({
      conversationScope: createGroupConversationScope({
        channelId: roomId,
        recentSpeakers: [
          { authorId: 'discord-alice', name: 'Alice' },
          { authorId: 'discord-bob', name: 'Bob' },
        ],
      }),
      currentAuthor: {
        status: 'verified',
        subject: ALICE,
        trustLevel: 'trusted',
      },
      messageAddressing: makeAddressing(roomId, [
        { authorId: 'discord-bob', authorName: 'Bob' },
        { authorId: 'discord-absent', authorName: 'Devon' },
      ]),
    });

    expect(result.admittedClaimIds).toContain(bobClaim.id);
    expect(result.admittedClaimIds).toContain(groupClaim.id);
    expect(result.promptSection).toContain('matcha lattes');
    expect(result.promptSection).toContain('lantern check');

    // Devon has no live participation proof in this room -> non-public personal claim stays withheld.
    expect(result.admittedClaimIds).not.toContain(absentClaim.id);
    expect(result.promptSection).not.toContain('espresso');
  });

  it('proves currentParticipation for a transport reply target even without recentSpeakers', async () => {
    const roomId = 'discord:group:workshop';
    const store = new InMemoryBiographicalProfileStore(() => NOW);
    const bobPrefSource = claimSource('memory:bob-reply', 'discord:dm:bob');
    const bobClaim = await store.writeClaim({
      subject: BOB,
      kind: 'stable-preference',
      value: {
        kind: 'stable-preference',
        schemaVersion: 1,
        domain: 'communication',
        target: 'bulleted summaries',
        polarity: 'prefers',
      },
      basis: 'explicit',
      status: 'active',
      portabilityScope: 'subject_present',
      confidence: 0.9,
      sources: [bobPrefSource],
      now: NOW,
    });
    const bobContact = makeContact(BOB.contactId, 'Bob', []);
    const contactStore = fromPartial<ContactStorePort>({
      getByChannelIdentity: async (_source, externalId) => (
        externalId === 'discord-bob' ? bobContact : undefined
      ),
      listRoomRoster: async () => [],
    });

    const projection = createRuntimeBiographicalProjection({
      store,
      revalidator: makeRevalidator([bobPrefSource]),
      contactStore,
      companionId: COMPANION.companionId,
      policy: createDefaultBiographicalDepthPolicy(),
    });

    const result = await projection.projectBiographicalContext({
      conversationScope: createGroupConversationScope({ channelId: roomId }),
      currentAuthor: {
        status: 'verified',
        subject: ALICE,
        trustLevel: 'trusted',
      },
      messageAddressing: makeAddressing(
        roomId,
        [],
        { messageId: 'msg-123', author: { authorId: 'discord-bob', authorName: 'Bob' } },
      ),
    });

    expect(result.admittedClaimIds).toEqual([bobClaim.id]);
    expect(result.promptSection).toContain('bulleted summaries');
  });
});
