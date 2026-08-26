import type {
  IntakeEnvelopeSnapshot,
  IntakeSourceClass,
} from '../../../shared/contracts/intake-envelope.js';
import type { ChannelPrivacy } from '../../../system/trust/context-envelope.js';
import type { ContactStorePort } from '../../contacts/contact-store-port.js';
import type { ConversationScope } from '../../session/conversation-scope.js';
import type { IntakeChatBodyChannelClass } from '../../../system/config/intake-policy-config.js';
import type { CogSecStructuralSurface } from '../../../shared/contracts/cogsec-mode.js';
import { createComponentLogger } from '../../../shared/logger.js';
import {
  parseMessageAddressingMetadata,
  type MessageAddressingMetadata,
} from '../../../shared/contracts/message-addressing.js';
import type { IntakeScreeningService } from './screening.js';

const log = createComponentLogger('ChatMessageIntakeScreening');

export type ChatMessageSurface = 'api' | 'discord' | 'telegram' | 'multica';

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
  /** Authenticated adapter topology; never inferred from message text. */
  channelTopology?: 'direct' | 'group';
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

function resolveChatCogSecSurface(
  input: ScreenChatMessageBodyInput,
  chatBodyContext: Parameters<IntakeScreeningService['screen']>[1]['chatBodyContext'],
): CogSecStructuralSurface {
  const topology = input.conversationScope?.kind ?? input.channelTopology;
  if (!topology) {
    throw new Error('CogSec chat screening requires authenticated channel topology');
  }
  if (topology === 'group') return { channelClass: 'group_chat' };
  if (input.channelPrivacy === 'public') return { channelClass: 'public_channel' };
  const ownerEligiblePrimary = chatBodyContext?.contactTrust.trustLevel === 'primary'
    && chatBodyContext.contactTrust.archived === false
    && chatBodyContext.contactTrust.contactId === input.canonicalContactId
    && chatBodyContext.conversationScope.kind === 'dm';
  if (input.sourceClass === 'operator'
    || (input.sourceClass === 'primary_user' && ownerEligiblePrimary)) {
    return { channelClass: 'operator_direct' };
  }
  return { channelClass: 'private_direct' };
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

  const cogSecSurface = resolveChatCogSecSurface(input, chatBodyContext);

  const screened = await input.screening.screen(input.content, {
    sourceClass: input.sourceClass,
    origin: { ref: `${input.surface}:${input.channelId}:${input.messageId}` },
    scope: 'context',
    subject: { kind: 'body' },
    sourceChannelId: input.channelId,
    sourceMessageId: input.messageId,
    surface: cogSecSurface,
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
    ...(input.channelTopology ? { channelTopology: input.channelTopology } : {}),
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
