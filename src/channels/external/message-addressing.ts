import {
  parseMessageAddressingMetadata,
  type MessageAddresseeEvidence,
  type MessageAddressingMetadata,
  type MessageAddressingParticipant,
  type MessageAuthorSourceClass,
} from '../../shared/contracts/message-addressing.js';
import { EXTERNAL_CHANNEL_PLUGIN_ID } from './config.js';

/**
 * Transport-authoritative addressing for the generic external bridge channel
 * (psfn-framework-w1lc2).
 *
 * Without this envelope every external group line normalized to an UNVERIFIED
 * room, and the room-signal gate fails closed on an unverified room
 * (`room_unverified`), so no external group line could ever reach a
 * participation candidate, the appraiser, or room-reply egress. The bridge
 * protocol already carries what the envelope needs: the declared conversation
 * kind (the room topology) and the platform's `addressedToCompanion` flag (a
 * mention of, or reply to, the companion's account). Prose is never consulted.
 */

/** The companion account this adapter instance speaks as in its rooms. */
export interface ExternalObserverIdentity {
  /**
   * Stable observer id. It never starts with the adapter's sender namespace
   * (`external:<instanceId>:`), so no bridge sender id can impersonate it.
   */
  authorId: string;
  displayName: string;
}

export function externalObserverIdentity(input: {
  instanceId: string;
  displayName: string;
}): ExternalObserverIdentity {
  const displayName = input.displayName.trim();
  if (!displayName) {
    throw new Error(`External channel adapter "${input.instanceId}" requires a companion display name`);
  }
  return {
    authorId: `${EXTERNAL_CHANNEL_PLUGIN_ID}-companion:${input.instanceId}`,
    displayName,
  };
}

export interface ExternalMessageAddressingInput {
  author: MessageAddressingParticipant;
  observer: ExternalObserverIdentity;
  /** Namespaced room channel id. */
  channelId: string;
  isDirectMessage: boolean;
  addressedToCompanion: boolean;
  /** Namespaced reply target, when the bridge supplied one. */
  replyToMessageId?: string;
  sourceClass: MessageAuthorSourceClass;
}

export function buildExternalMessageAddressing(
  input: ExternalMessageAddressingInput,
): MessageAddressingMetadata {
  const observer: MessageAddressingParticipant = {
    authorId: input.observer.authorId,
    authorName: input.observer.displayName,
  };
  const channel = {
    scope: input.isDirectMessage ? 'direct' as const : 'group' as const,
    channelId: input.channelId,
  };
  const mentioned = !input.isDirectMessage && input.addressedToCompanion;
  const evidence: MessageAddresseeEvidence[] = [];
  if (mentioned) evidence.push('mention');
  if (input.isDirectMessage) evidence.push('direct_message');
  const replyTarget = input.replyToMessageId ? { messageId: input.replyToMessageId } : undefined;
  const resolvedAddressee = evidence.length > 0
    ? { kind: 'participants' as const, participants: [{ ...observer, evidence }] }
    : replyTarget
      ? { kind: 'unresolved_reply' as const, messageId: replyTarget.messageId }
      : { kind: 'room' as const, ...channel };
  return parseMessageAddressingMetadata({
    schemaVersion: 2,
    source: 'external',
    author: input.author,
    observer,
    mentionedTargets: mentioned ? [observer] : [],
    ...(replyTarget ? { replyTarget } : {}),
    channel,
    resolvedAddressee,
    authorClass: {
      sourceClass: input.sourceClass,
      // A bridge asserts no platform role or member count; both stay
      // `unknown`, which every participation gate treats as untrusted/large.
      roomRole: 'unknown',
      roomSize: 'unknown',
    },
  });
}
