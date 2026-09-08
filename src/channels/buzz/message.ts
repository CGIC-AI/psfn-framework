import type { Event as NostrEvent } from 'nostr-tools';
import { screenChatMessageEnvelope } from '../../core/cogsec/intake/chat-message-screening.js';
import type { IntakeScreeningService } from '../../core/cogsec/intake/screening.js';
import {
  parseMessageAddressingMetadata,
  type MessageAuthorSourceClass,
} from '../../shared/contracts/message-addressing.js';
import type { SubstrateMessage } from '../../shared/contracts/runtime.js';
import {
  buzzChannelId,
  buzzDisplayName,
  buzzPrincipal,
  buzzTagValues,
  parseBuzzThreadReference,
} from './protocol.js';

export interface BuzzMessageContext {
  relayUrl: string;
  companionId: string;
  companionPubkey: string;
  authorIsMachine: boolean;
  intakeScreening: IntakeScreeningService | null;
}

/**
 * The one cross-connector author trust floor (psfn-framework-vprcm). Discord
 * (`resolveMessageSourceClass`) and Telegram (`resolveInboundSourceClass`)
 * answer this same DM-conditioned question, so Buzz answers it the same way
 * instead of asserting a second, more permissive policy for one connector.
 *
 * A Nostr relay asserts no room membership, role, or prior relationship for an
 * `h`-tagged post, so an unknown room author lands on the least-privileged chat
 * class. The DM branch exists so the policy keeps one shape if Nostr private
 * messaging is ever admitted, not because Buzz can reach it today.
 */
export function resolveBuzzAuthorSourceClass(
  isDirectMessage: boolean,
): MessageAuthorSourceClass {
  return isDirectMessage ? 'regular_contact' : 'public_contact';
}

export async function toBuzzSubstrateMessage(
  event: NostrEvent,
  context: BuzzMessageContext,
): Promise<SubstrateMessage> {
  const nativeChannelId = buzzTagValues(event, 'h')[0]!;
  const channelId = buzzChannelId(context.relayUrl, nativeChannelId);
  const author = {
    authorId: buzzPrincipal(context.relayUrl, event.pubkey),
    authorName: buzzDisplayName(event.pubkey),
  };
  const observer = {
    authorId: buzzPrincipal(context.relayUrl, context.companionPubkey),
    authorName: context.companionId,
  };
  const mentionedTargets = [...new Set(buzzTagValues(event, 'p'))].map(pubkey => ({
    authorId: buzzPrincipal(context.relayUrl, pubkey),
    authorName: pubkey === context.companionPubkey
      ? context.companionId
      : buzzDisplayName(pubkey),
  }));
  const companionMentioned = buzzTagValues(event, 'p').includes(context.companionPubkey);
  const thread = parseBuzzThreadReference(event);
  // Buzz has no private-message surface: every admitted event is a room post.
  const isDirectMessage = false;
  const sourceClass = resolveBuzzAuthorSourceClass(isDirectMessage);
  const channel = {
    scope: 'group' as const,
    channelId,
    ...(thread ? { threadId: thread.rootEventId } : {}),
  };
  const addressing = parseMessageAddressingMetadata({
    schemaVersion: 2,
    source: 'buzz',
    author,
    observer,
    mentionedTargets,
    ...(thread ? { replyTarget: { messageId: thread.parentEventId } } : {}),
    channel,
    // jp36.5.6: the same intake trust class this connector passes to body
    // screening below. Nostr asserts neither a room role nor a member count, so
    // both stay `unknown` — the untrusted/large case for participation policy.
    authorClass: {
      sourceClass,
      roomRole: 'unknown',
      roomSize: 'unknown',
    },
    resolvedAddressee: mentionedTargets.length > 0
      ? {
          kind: 'participants',
          participants: mentionedTargets.map(participant => ({ ...participant, evidence: ['mention'] })),
        }
      : thread
        ? { kind: 'unresolved_reply', messageId: thread.parentEventId }
        : { kind: 'room', channelId },
  });
  const screened = await screenChatMessageEnvelope({
    envelope: { content: event.content, addressing },
    screening: context.intakeScreening,
    sourceClass,
    surface: 'buzz',
    channelId,
    messageId: event.id,
    channelPrivacy: 'invite_only',
    channelTopology: 'group',
  });
  return {
    id: event.id,
    channelId,
    channelType: 'buzz',
    authorId: author.authorId,
    authorName: author.authorName,
    content: screened.envelope.content,
    timestamp: new Date(event.created_at * 1_000),
    isDirectMessage,
    ...(thread ? { replyToMessageId: thread.parentEventId } : {}),
    routing: {
      source: 'buzz',
      responseMode: companionMentioned ? 'respond' : 'observe',
      ...(context.authorIsMachine ? { authorIsMachineIntelligence: true } : {}),
      addressing: screened.envelope.addressing,
      channelPrivacy: 'invite_only',
      ...(screened.snapshot ? { intakeEnvelopes: [screened.snapshot] } : {}),
    },
  };
}
