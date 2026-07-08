import type { SubstrateMessage } from '../../../shared/contracts/runtime.js';
import { createComponentLogger } from '../../../shared/logger.js';
import { getRuntimeTrustPolicy } from '../../../system/trust/runtime-policy.js';
import type { TrustLevel } from '../../../system/trust/types.js';
import type { ContactStorePort } from '../../contacts/contact-store-port.js';
import type {
  ConversationScope,
  ConversationScopeSpeaker,
} from '../../session/conversation-scope.js';
import {
  resolveIdentityChannel,
  type ParticipantRelationshipEdgeInput,
} from './runtime-context.js';

const log = createComponentLogger('SubstrateAgent');
const PARTICIPANT_EDGE_DEDUPE_SEPARATOR = '\0';

/**
 * E3.3 envelope derivation input: count the recent-speaker window entries
 * that resolve to contacts through the same channel-identity path the turn
 * uses for its author. Fail closed: no contact store, an empty window, or a
 * failed lookup contributes zero resolved speakers (the envelope derivation
 * then classifies audienceKnowledge as anonymous/partially_known, never
 * all_known).
 */
export async function countResolvableSpeakerContactsForTurn(input: {
  message: SubstrateMessage;
  speakers: readonly ConversationScopeSpeaker[];
  contactStore: ContactStorePort | null;
}): Promise<number> {
  const { message, speakers, contactStore } = input;
  if (!contactStore || speakers.length === 0) return 0;
  const identityChannel = resolveIdentityChannel(message);
  let resolved = 0;
  for (const speaker of speakers) {
    try {
      const contact = await contactStore.getByChannelIdentity(identityChannel, speaker.authorId);
      if (contact) resolved += 1;
    } catch (error) {
      log.warn('Speaker contact resolvability lookup failed; counting speaker as unresolved (fail closed)', {
        channelId: message.channelId,
        identityChannel,
        speakerAuthorId: speaker.authorId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return resolved;
}

/**
 * E4.4 orchestrator fetch: gather live, high-confidence social-relationship
 * edges BETWEEN currently listed participants (the <=5 recentSpeakers set) so
 * the conversation-state producer can render a compact participant_relationships
 * block. The producer never fetches: this async pre-prompt step runs the
 * bounded query and hands candidates through.
 *
 * Only group turns are eligible (a DM has one participant). Fail closed: no
 * contact store, no resolved participants, or a lookup error yields an empty
 * set (the block is then absent entirely). The confidence threshold is
 * config-owned (trust-policy.json -> participantRelationshipConfidenceThreshold,
 * default 0.7) and applied as the query's minConfidence; the room
 * sensitivity rule (public/personal only) is enforced deterministically in
 * the producer gate. One bounded list call, not a per-pair fan-out.
 */
export async function resolveParticipantRelationshipsForTurn(input: {
  message: SubstrateMessage;
  conversationScope: ConversationScope;
  trustLevel: TrustLevel;
  contactStore: ContactStorePort | null;
}): Promise<ParticipantRelationshipEdgeInput[]> {
  const {
    message,
    conversationScope,
    trustLevel,
    contactStore,
  } = input;
  if (conversationScope.kind !== 'group') return [];
  if (!contactStore) return [];
  const speakers = conversationScope.recentSpeakers;
  if (speakers.length < 2) return [];

  const identityChannel = resolveIdentityChannel(message);
  const threshold = getRuntimeTrustPolicy().participantRelationshipConfidenceThreshold;

  // Resolve each currently listed participant to its social-graph entity id
  // (authorId to contact to entity). Display uses the present speaker name.
  const nameByEntityId = new Map<string, string>();
  try {
    for (const speaker of speakers) {
      const contact = await contactStore.getByChannelIdentity(identityChannel, speaker.authorId);
      if (!contact) continue;
      const entity = await contactStore.getSocialGraphEntityByContactId(contact.id);
      if (!entity) continue;
      if (!nameByEntityId.has(entity.id)) {
        nameByEntityId.set(entity.id, speaker.name);
      }
    }
  } catch (error) {
    log.warn('Participant relationship entity resolution failed; rendering no relationships (fail closed)', {
      channelId: message.channelId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
  if (nameByEntityId.size < 2) return [];

  let edges;
  try {
    edges = await contactStore.listSocialRelationshipEdges({
      viewerTrustLevel: trustLevel,
      viewerChannelPrivacy: conversationScope.envelope.channelPrivacy,
      minConfidence: threshold,
    });
  } catch (error) {
    log.warn('Participant relationship edge listing failed; rendering no relationships (fail closed)', {
      channelId: message.channelId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }

  const candidates: ParticipantRelationshipEdgeInput[] = [];
  const seen = new Set<string>();
  for (const edge of edges) {
    const aName = nameByEntityId.get(edge.sourceEntityId);
    const bName = nameByEntityId.get(edge.targetEntityId);
    // Both endpoints must be currently listed participants.
    if (!aName || !bName || edge.sourceEntityId === edge.targetEntityId) continue;
    if (edge.confidence < threshold) continue;
    const dedupeKey = [
      edge.sourceEntityId,
      edge.targetEntityId,
      edge.relationshipType,
    ].join(PARTICIPANT_EDGE_DEDUPE_SEPARATOR);
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    candidates.push({
      aName,
      bName,
      relationshipType: edge.relationshipType,
      sensitivity: edge.sensitivity,
      confidence: edge.confidence,
      updatedAt: edge.updatedAt,
    });
  }
  return candidates;
}
