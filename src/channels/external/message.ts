// Inbound normalization for external bridges: one protocol message becomes one
// screened SubstrateMessage. Every identifier is namespaced under the adapter
// instance so two bridges can never collide on, or impersonate, each other's
// conversations or senders.

import { screenChatMessageBody } from '../../core/cogsec/intake/chat-message-screening.js';
import type { IntakeScreeningService } from '../../core/cogsec/intake/screening.js';
import type { SubstrateMessage } from '../../shared/contracts/runtime.js';
import { classifyChannelEnvelope } from '../../system/trust/policy.js';
import { EXTERNAL_CHANNEL_PLUGIN_ID, type ExternalChannelLimits } from './config.js';
import type { ExternalChannelInboundMessage } from './protocol.js';

export function externalChannelIdPrefix(instanceId: string): string {
  return `${EXTERNAL_CHANNEL_PLUGIN_ID}:${instanceId}:`;
}

export class ExternalChannelMessageRejected extends Error {}

/** Enforce owner-file size bounds before any screening work is spent. */
export function assertExternalInboundWithinLimits(
  message: ExternalChannelInboundMessage,
  limits: Pick<ExternalChannelLimits, 'maxTextChars' | 'maxIdChars'>,
): void {
  if (message.text.length > limits.maxTextChars) {
    throw new ExternalChannelMessageRejected(`text exceeds ${limits.maxTextChars} characters`);
  }
  const ids: Array<[string, string | undefined]> = [
    ['id', message.id],
    ['conversationId', message.conversationId],
    ['senderId', message.senderId],
    ['senderName', message.senderName],
    ['replyToMessageId', message.replyToMessageId],
  ];
  for (const [field, value] of ids) {
    if (value === undefined) continue;
    if (value.length > limits.maxIdChars) {
      throw new ExternalChannelMessageRejected(`${field} exceeds ${limits.maxIdChars} characters`);
    }
    if (value.trim() !== value || value.length === 0) {
      throw new ExternalChannelMessageRejected(`${field} must not have surrounding whitespace`);
    }
  }
}

function parseSentAt(sentAt: string | undefined, receivedAt: Date): Date {
  if (sentAt === undefined) return receivedAt;
  const parsed = new Date(sentAt);
  if (Number.isNaN(parsed.getTime())) {
    throw new ExternalChannelMessageRejected('sentAt must be an ISO-8601 timestamp');
  }
  return parsed;
}

export interface ExternalInboundContext {
  instanceId: string;
  intakeScreening: IntakeScreeningService | null;
  receivedAt: Date;
}

export async function toExternalSubstrateMessage(
  message: ExternalChannelInboundMessage,
  context: ExternalInboundContext,
): Promise<SubstrateMessage> {
  const prefix = externalChannelIdPrefix(context.instanceId);
  const channelId = `${prefix}${message.conversationId}`;
  const messageId = `${prefix}${message.id}`;
  const isDirectMessage = message.conversationKind === 'direct';
  const timestamp = parseSentAt(message.sentAt, context.receivedAt);
  const channelPrivacy = classifyChannelEnvelope(channelId, { isDirectMessage }).privacy;
  // A bridge asserts no platform role or relationship, so its authors take the
  // same least-privileged DM-conditioned trust floor Telegram uses.
  const screened = await screenChatMessageBody({
    content: message.text,
    screening: context.intakeScreening,
    sourceClass: isDirectMessage ? 'regular_contact' : 'public_contact',
    surface: 'external',
    channelId,
    messageId,
    channelTopology: isDirectMessage ? 'direct' : 'group',
    channelPrivacy,
  });
  return {
    id: messageId,
    channelId,
    channelType: 'external',
    isDirectMessage,
    authorId: `${prefix}${message.senderId}`,
    authorName: message.senderName,
    content: screened.content,
    timestamp,
    ...(message.replyToMessageId ? { replyToMessageId: `${prefix}${message.replyToMessageId}` } : {}),
    routing: {
      source: 'external',
      // uf06o: like Discord and Telegram, only a direct message or a group line
      // the platform addressed to the companion is a responding turn. Ambient
      // group chatter is observation: the agent's shared observe path runs the
      // participation gate (passive-name candidate, appraiser, reservation,
      // egress lease), and not replying is a valid outcome.
      responseMode: isDirectMessage || message.addressedToCompanion === true ? 'respond' : 'observe',
      channelPrivacy,
      ...(screened.snapshot ? { intakeEnvelopes: [screened.snapshot] } : {}),
    },
  };
}
