import type {
  IntakeEnvelopeSnapshot,
  IntakeSourceClass,
} from '../../../shared/contracts/intake-envelope.js';
import type { ChannelPrivacy } from '../../../system/trust/context-envelope.js';
import {
  parseMessageAddressingMetadata,
  type MessageAddressingMetadata,
} from '../../../shared/contracts/message-addressing.js';
import type { IntakeScreeningService } from './screening.js';

export type ChatMessageSurface = 'api' | 'discord' | 'telegram';

export interface ScreenChatMessageBodyInput {
  content: string;
  screening: IntakeScreeningService | null | undefined;
  sourceClass: IntakeSourceClass;
  surface: ChatMessageSurface;
  channelId: string;
  messageId: string;
  canonicalContactId?: string;
  channelPrivacy?: ChannelPrivacy;
}

export interface ScreenedChatMessageBody {
  content: string;
  snapshot: IntakeEnvelopeSnapshot | null;
}

export interface PlatformChatMessageEnvelope {
  content: string;
  addressing: MessageAddressingMetadata;
}

export interface ScreenChatMessageEnvelopeInput
  extends Omit<ScreenChatMessageBodyInput, 'content'> {
  envelope: PlatformChatMessageEnvelope;
}

export interface ScreenedChatMessageEnvelope {
  envelope: PlatformChatMessageEnvelope;
  snapshot: IntakeEnvelopeSnapshot | null;
}

/**
 * Screens a prompt-bearing chat body at the channel boundary and returns the
 * effective content plus the snapshot that must travel with that exact body.
 */
export async function screenChatMessageBody(
  input: ScreenChatMessageBodyInput,
): Promise<ScreenedChatMessageBody> {
  if (!input.screening || input.content.trim().length === 0) {
    return { content: input.content, snapshot: null };
  }

  const screened = await input.screening.screen(input.content, {
    sourceClass: input.sourceClass,
    origin: { ref: `${input.surface}:${input.channelId}:${input.messageId}` },
    scope: 'context',
    subject: { kind: 'body' },
    sourceChannelId: input.channelId,
    ...(input.canonicalContactId
      ? { canonicalContactId: input.canonicalContactId }
      : {}),
    ...(input.channelPrivacy ? { channelPrivacy: input.channelPrivacy } : {}),
    timing: {
      traceId: input.messageId,
      requestId: input.messageId,
      channelId: input.channelId,
      channelType: input.surface,
    },
  });

  return {
    content: screened.effectiveText,
    snapshot: screened.snapshot,
  };
}

/**
 * Screen a chat body without collapsing its transport-authoritative payload to
 * a string. The platform envelope is validated before screening and returned
 * beside the exact effective body, so sanitization cannot erase attribution.
 */
export async function screenChatMessageEnvelope(
  input: ScreenChatMessageEnvelopeInput,
): Promise<ScreenedChatMessageEnvelope> {
  const addressing = parseMessageAddressingMetadata(input.envelope.addressing);
  const screened = await screenChatMessageBody({
    content: input.envelope.content,
    screening: input.screening,
    sourceClass: input.sourceClass,
    surface: input.surface,
    channelId: input.channelId,
    messageId: input.messageId,
    ...(input.canonicalContactId ? { canonicalContactId: input.canonicalContactId } : {}),
    ...(input.channelPrivacy ? { channelPrivacy: input.channelPrivacy } : {}),
  });
  return {
    envelope: {
      content: screened.content,
      addressing,
    },
    snapshot: screened.snapshot,
  };
}
