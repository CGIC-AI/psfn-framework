import type { SubstrateMessage } from '../../../shared/contracts/runtime.js';
import { createComponentLogger } from '../../../shared/logger.js';
import type { ContactStorePort } from '../../contacts/contact-store-port.js';
import {
  CONVERSATION_SCOPE_RECENT_SPEAKER_LIMIT,
  type ConversationScope,
  type ConversationScopeSpeaker,
} from '../../session/conversation-scope.js';
import type { PrivateRelationshipActivitySummary } from '../../session/manager/captured-session-owner.js';
import type { UserRuntimeProfile } from './runtime-context-sections/conversation-state.js';
import { resolveIdentityChannel } from './runtime-context.js';

const log = createComponentLogger('ParticipantActivity');

export interface PrivateRelationshipActivityReader {
  getPrivateRelationshipActivity(
    canonicalContactId: string,
  ): PrivateRelationshipActivitySummary | null;
}

/**
 * Resolve content-free relationship recency for the bounded room roster.
 * Channel identifiers and transcript content never leave the activity reader.
 */
export async function resolveParticipantActivityProfilesForTurn(input: {
  message: SubstrateMessage;
  conversationScope: ConversationScope;
  contactStore: ContactStorePort | null;
  activityReader: PrivateRelationshipActivityReader;
}): Promise<UserRuntimeProfile[]> {
  if (input.conversationScope.kind !== 'group' || !input.contactStore) return [];

  const identityChannel = resolveIdentityChannel(input.message);
  const profiles: UserRuntimeProfile[] = [];
  const currentSpeaker: ConversationScopeSpeaker = {
    authorId: input.message.authorId,
    name: input.message.authorName,
  };
  const seenSpeakerIds = new Set<string>();
  const boundedSpeakers = [currentSpeaker, ...input.conversationScope.recentSpeakers]
    .filter((speaker) => {
      if (seenSpeakerIds.has(speaker.authorId)) return false;
      seenSpeakerIds.add(speaker.authorId);
      return true;
    })
    .slice(0, CONVERSATION_SCOPE_RECENT_SPEAKER_LIMIT);

  for (const speaker of boundedSpeakers) {
    try {
      const contact = await input.contactStore.getByChannelIdentity(
        identityChannel,
        speaker.authorId,
      );
      if (!contact || contact.isMachineIntelligence === true) continue;

      const activity = input.activityReader.getPrivateRelationshipActivity(contact.id);
      if (!activity) continue;
      profiles.push({
        user_id: speaker.authorId,
        display_name: speaker.name,
        ...(contact.timezone ? { timezone: contact.timezone } : {}),
        lastDirectInteractionAtMs: activity.lastDirectInteractionAtMs,
      });
    } catch (error) {
      log.warn('Participant relationship activity lookup failed; omitting recency (fail closed)', {
        channelId: input.message.channelId,
        speakerAuthorId: speaker.authorId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return profiles;
}
