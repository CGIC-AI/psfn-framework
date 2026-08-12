import type {
  IntakeEnvelopeSnapshot,
  IntakeSourceClass,
} from '../../../shared/contracts/intake-envelope.js';
import type { ChannelPrivacy } from '../../../system/trust/context-envelope.js';
import type { ContactStorePort } from '../../contacts/contact-store-port.js';
import type { ConversationScope } from '../../session/conversation-scope.js';
import type { IntakeChatBodyChannelClass } from '../../../system/config/intake-policy-config.js';
import { createComponentLogger } from '../../../shared/logger.js';
import {
  parseMessageAddressingMetadata,
  type MessageAddressingMetadata,
} from '../../../shared/contracts/message-addressing.js';
import type { IntakeScreeningService } from './screening.js';

const log = createComponentLogger('ChatMessageIntakeScreening');

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
  channelClass?: IntakeChatBodyChannelClass;
  conversationScope?: ConversationScope;
  /** Canonical Contact authority; absent deliberately keeps ordinary enforcement. */
  contactStore?: Pick<ContactStorePort, 'getById'> | null;
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

  const canonicalContactId = input.canonicalContactId?.trim();
  let chatBodyContext: Parameters<IntakeScreeningService['screen']>[1]['chatBodyContext'];
  if (
    canonicalContactId
    && input.channelClass
    && input.conversationScope
    && input.contactStore
  ) {
    try {
      const contact = await input.contactStore.getById(canonicalContactId);
      if (contact) {
        chatBodyContext = {
          channelClass: input.channelClass,
          conversationScope: input.conversationScope,
          contactTrust: {
            contactId: contact.id,
            trustLevel: contact.trustLevel,
            resolvedAtMs: Date.now(),
            archived: contact.archivedAt !== undefined,
          },
        };
      }
    } catch (error) {
      // The ordinary screening path is the fail-closed fallback. Keep the
      // lookup failure visible without including chat content in the log.
      log.warn('Canonical Contact trust lookup failed; retaining ordinary chat screening', {
        channelId: input.channelId,
        messageId: input.messageId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const screened = await input.screening.screen(input.content, {
    sourceClass: input.sourceClass,
    origin: { ref: `${input.surface}:${input.channelId}:${input.messageId}` },
    scope: 'context',
    subject: { kind: 'body' },
    sourceChannelId: input.channelId,
    ...(canonicalContactId
      ? { canonicalContactId }
      : {}),
    ...(input.channelPrivacy ? { channelPrivacy: input.channelPrivacy } : {}),
    ...(chatBodyContext ? { chatBodyContext } : {}),
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
    ...(input.channelClass ? { channelClass: input.channelClass } : {}),
    ...(input.conversationScope ? { conversationScope: input.conversationScope } : {}),
    ...(input.contactStore ? { contactStore: input.contactStore } : {}),
  });
  return {
    envelope: {
      content: screened.content,
      addressing,
    },
    snapshot: screened.snapshot,
  };
}
