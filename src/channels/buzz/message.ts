import type { Event as NostrEvent } from 'nostr-tools';
import { screenChatMessageEnvelope } from '../../core/cogsec/intake/chat-message-screening.js';
import type { IntakeScreeningService } from '../../core/cogsec/intake/screening.js';
import { parseMessageAddressingMetadata } from '../../shared/contracts/message-addressing.js';
import type { SubstrateMessage } from '../../shared/contracts/runtime.js';
import {
  buzzChannelId,
  buzzDisplayName,
  buzzPrincipal,
  buzzTagValues,
} from './protocol.js';

export interface BuzzMessageContext {
  relayUrl: string;
  companionId: string;
  companionPubkey: string;
  intakeScreening: IntakeScreeningService | null;
}

export async function toBuzzSubstrateMessage(
  event: NostrEvent,
  context: BuzzMessageContext,
): Promise<SubstrateMessage> {
  const nativeChannelId = buzzTagValues(event, 'h')[0]!;
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
  const addressing = parseMessageAddressingMetadata({
    schemaVersion: 2,
    source: 'buzz',
    author,
    observer,
    mentionedTargets,
    channel: { scope: 'group', channelId: nativeChannelId },
    resolvedAddressee: {
      kind: 'participants',
      participants: mentionedTargets.map(participant => ({ ...participant, evidence: ['mention'] })),
    },
  });
  const channelId = buzzChannelId(context.relayUrl, nativeChannelId);
  const screened = await screenChatMessageEnvelope({
    envelope: { content: event.content, addressing },
    screening: context.intakeScreening,
    sourceClass: 'regular_contact',
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
    isDirectMessage: false,
    routing: {
      source: 'buzz',
      responseMode: 'respond',
      addressing: screened.envelope.addressing,
      channelPrivacy: 'invite_only',
      ...(screened.snapshot ? { intakeEnvelopes: [screened.snapshot] } : {}),
    },
  };
}
