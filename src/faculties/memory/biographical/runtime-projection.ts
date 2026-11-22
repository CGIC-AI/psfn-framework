import type { MemoryProvider } from '../../../core/agent/contracts.js';
import type { ContactStorePort } from '../../../core/contacts/contact-store-port.js';
import type { Contact } from '../../../core/contacts/types.js';
import type { ConversationScope } from '../../../core/session/conversation-scope.js';
import type { BiographicalDepthPolicy } from '../../../system/config/biographical-depth-policy.js';
import type { BiographicalProfileStorePort } from './store-port.js';
import type { BiographicalSubjectRef } from './types.js';
import type { BiographicalSourceRevalidator } from './projection.js';
import { projectBiographicalContext } from './projection.js';
import type {
  CanonicalAddressedContactResolver,
  VerifiedExplicitSubject,
} from './explicit-subject-selection.js';

type CurrentParticipationProof = VerifiedExplicitSubject['currentParticipation'];

function inferChannelSource(channelId: string): string | undefined {
  const normalized = channelId.trim();
  const separator = normalized.indexOf(':');
  if (separator <= 0) return undefined;
  return normalized.slice(0, separator);
}

async function resolveCurrentParticipation(input: {
  readonly contactStore: ContactStorePort;
  readonly conversationScope: ConversationScope;
  readonly source: string;
  readonly channelId: string;
  readonly transportParticipantId: string;
  readonly evidence: readonly ('reply' | 'mention')[];
  readonly contact: Contact;
}): Promise<CurrentParticipationProof> {
  if (
    input.conversationScope.kind === 'dm'
    && input.conversationScope.contact.contactId === input.contact.id
  ) {
    return {
      status: 'authoritative',
      proofRef: `dm-participant:${input.source}:${input.channelId}:${input.contact.id}`,
    };
  }
  if (input.evidence.includes('reply')) {
    return {
      status: 'authoritative',
      proofRef: `reply-target:${input.source}:${input.channelId}:${input.contact.id}`,
    };
  }
  const spokeRecently = input.conversationScope.recentSpeakers.some(
    speaker => speaker.authorId === input.transportParticipantId
      || speaker.authorId === input.contact.id,
  );
  if (spokeRecently) {
    return {
      status: 'authoritative',
      proofRef: `recent-speaker:${input.source}:${input.channelId}:${input.contact.id}`,
    };
  }
  const knownInChannel = input.contact.conversationChannels?.some(
    channel => channel.channelId === input.channelId,
  ) === true;
  if (knownInChannel) {
    return {
      status: 'authoritative',
      proofRef: `channel-activity:${input.source}:${input.channelId}:${input.contact.id}`,
    };
  }
  if (typeof input.contactStore.listRoomRoster === 'function') {
    const roster = await input.contactStore.listRoomRoster(input.channelId);
    if (roster.some(member => member.contactId === input.contact.id)) {
      return {
        status: 'authoritative',
        proofRef: `room-roster:${input.source}:${input.channelId}:${input.contact.id}`,
      };
    }
  }
  return { status: 'unproven' };
}

function canonicalAddressedContactResolver(
  contactStore: ContactStorePort,
  conversationScope: ConversationScope,
): CanonicalAddressedContactResolver {
  return {
    resolve: async input => {
      const contact = await contactStore.getByChannelIdentity(
        input.source,
        input.transportParticipantId,
      );
      if (!contact || contact.archivedAt) return { status: 'missing' };
      const currentParticipation = await resolveCurrentParticipation({
        contactStore,
        conversationScope,
        source: input.source,
        channelId: input.channelId,
        transportParticipantId: input.transportParticipantId,
        evidence: input.evidence,
        contact,
      });
      return {
        status: 'verified',
        subject: { kind: 'contact', contactId: contact.id, subjectVersion: 1 },
        trustLevel: contact.trustLevel,
        currentParticipation,
      };
    },
  };
}

async function resolvePresentRoomSpeakerContactIds(input: {
  readonly contactStore: ContactStorePort;
  readonly conversationScope: ConversationScope;
  readonly source?: string;
}): Promise<string[]> {
  if (input.conversationScope.kind !== 'group') return [];
  const source = input.source ?? inferChannelSource(input.conversationScope.channelId);
  const contactIds = new Set<string>();
  for (const speaker of input.conversationScope.recentSpeakers) {
    const participantId = speaker.authorId.trim();
    if (!participantId) continue;
    let contact: Contact | undefined;
    if (source && typeof input.contactStore.getByChannelIdentity === 'function') {
      contact = await input.contactStore.getByChannelIdentity(source, participantId);
    }
    if (!contact && typeof input.contactStore.getById === 'function') {
      contact = await input.contactStore.getById(participantId);
    }
    if (contact && !contact.archivedAt) {
      contactIds.add(contact.id);
    }
  }
  return [...contactIds];
}

export function createRuntimeBiographicalProjection(input: {
  store: BiographicalProfileStorePort;
  revalidator: BiographicalSourceRevalidator;
  contactStore: ContactStorePort;
  companionId: string;
  policy: BiographicalDepthPolicy;
}): Pick<MemoryProvider, 'projectBiographicalContext'> {
  const companionSubject: BiographicalSubjectRef = {
    kind: 'companion',
    companionId: input.companionId,
    subjectVersion: 1,
  };
  return {
    projectBiographicalContext: async request => {
      const resolver = canonicalAddressedContactResolver(
        input.contactStore,
        request.conversationScope,
      );
      const presentContactIds = await resolvePresentRoomSpeakerContactIds({
        contactStore: input.contactStore,
        conversationScope: request.conversationScope,
        ...(request.messageAddressing?.source
          ? { source: request.messageAddressing.source }
          : {}),
      });
      const projected = await projectBiographicalContext({
        store: input.store,
        revalidator: input.revalidator,
        rebuildQueueMaxPending: input.policy.full.operationClaimLimit,
        explicitAddressing: {
          resolver,
          maxSubjects: input.policy.full.turnClaimLimit,
        },
      }, {
        companionSubject,
        conversationScope: request.conversationScope,
        ...(request.currentAuthor ? { currentAuthor: request.currentAuthor } : {}),
        ...(request.messageAddressing
          ? { messageAddressing: request.messageAddressing }
          : {}),
        ...(presentContactIds.length > 0 ? { presentContactIds } : {}),
      });
      return {
        promptSection: projected.promptSection,
        disclosureSources: projected.disclosureSources,
        admittedClaimIds: projected.admittedClaimIds,
        withheldCount: projected.withheld.length,
      };
    },
  };
}
