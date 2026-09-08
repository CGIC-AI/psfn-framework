import {
  parseMessageAddressingMetadata,
  type MessageAddresseeEvidence,
  type MessageAddressingMetadata,
  type MessageAddressingParticipant,
  type MessageAuthorSourceClass,
} from '../../shared/contracts/message-addressing.js';

/**
 * Transport-authoritative Telegram addressing (jp36.5.6).
 *
 * Telegram previously handed the agent a bare `SubstrateMessage` with no
 * addressing envelope at all, so mentions, replies, and author standing had to
 * be re-derived from prose downstream — the Discord-shaped assumption this bead
 * removes. This builds the SAME validated envelope Discord and Buzz already
 * produce, from Bot API entities only: `mention` entities are matched against
 * the authenticated bot username, `text_mention` entities against its numeric
 * id, and replies against `reply_to_message.from.id`. Prose is never consulted.
 */

/** The Bot API user fields addressing needs. */
export interface TelegramAddressingUser {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}

/** The Bot API entity fields addressing needs (`offset`/`length` slice `text`). */
export interface TelegramAddressingEntity {
  type: string;
  offset: number;
  length: number;
  user?: TelegramAddressingUser;
}

/** The authenticated bot account this process speaks as. */
export interface TelegramObserverIdentity {
  id: number;
  displayName: string;
  username?: string;
}

export interface TelegramMessageAddressingInput {
  messageText: string;
  entities: readonly TelegramAddressingEntity[];
  author: TelegramAddressingUser;
  authorName: string;
  observer: TelegramObserverIdentity;
  /** Base room channel id (thread id is carried separately, as on Discord). */
  channelId: string;
  threadId?: string;
  isDirectMessage: boolean;
  replyTo?: { messageId: number; from?: TelegramAddressingUser };
  /** The same intake trust class the adapter already computes for screening. */
  sourceClass: MessageAuthorSourceClass;
}

export interface TelegramMessageAddressingResult {
  addressing: MessageAddressingMetadata;
  /** The message directly addresses this companion (mention or reply). */
  addressesObserver: boolean;
}

/**
 * Build and validate the Telegram addressing envelope. Returns the envelope plus
 * the deterministic "was I addressed" answer the adapter needs to choose between
 * a responding turn and an ambient observation.
 */
export function buildTelegramMessageAddressing(
  input: TelegramMessageAddressingInput,
): TelegramMessageAddressingResult {
  const observerName = input.observer.displayName.trim();
  if (!observerName) {
    throw new Error('Telegram addressing requires an authenticated companion display name');
  }
  const author: MessageAddressingParticipant = {
    authorId: String(input.author.id),
    authorName: input.authorName,
  };
  const observer: MessageAddressingParticipant = {
    authorId: String(input.observer.id),
    authorName: observerName,
  };
  const mentionedTargets = resolveMentionedTargets(input, observer);
  const replyTarget = input.replyTo
    ? {
      messageId: String(input.replyTo.messageId),
      ...(input.replyTo.from && String(input.replyTo.from.id) === observer.authorId
        ? { author: observer }
        : {}),
    }
    : undefined;

  const channel = {
    scope: input.isDirectMessage ? 'direct' as const : 'group' as const,
    channelId: input.channelId,
    ...(input.threadId && !input.isDirectMessage ? { threadId: input.threadId } : {}),
  };

  const evidence: MessageAddresseeEvidence[] = [];
  if (mentionedTargets.some(target => target.authorId === observer.authorId)) {
    evidence.push('mention');
  }
  if (replyTarget?.author) evidence.push('reply');
  if (input.isDirectMessage) evidence.push('direct_message');

  const resolvedAddressee = evidence.length > 0
    ? {
      kind: 'participants' as const,
      participants: [{ ...observer, evidence }],
    }
    : replyTarget
      ? { kind: 'unresolved_reply' as const, messageId: replyTarget.messageId }
      : { kind: 'room' as const, ...channel };

  const addressing = parseMessageAddressingMetadata({
    schemaVersion: 2,
    source: 'telegram',
    author,
    observer,
    mentionedTargets,
    ...(replyTarget ? { replyTarget } : {}),
    channel,
    resolvedAddressee,
    authorClass: {
      sourceClass: input.sourceClass,
      // The Bot API message payload carries no chat-member status and no member
      // count, and room participation must never spend an API call per ambient
      // line. Both stay `unknown`, which every gate treats as untrusted/large.
      roomRole: 'unknown',
      roomSize: 'unknown',
    },
  });
  return {
    addressing,
    addressesObserver: evidence.some(item => item === 'mention' || item === 'reply'),
  };
}

/**
 * Resolve mentioned participants from Bot API entities alone. Only the
 * companion's own account is resolved by identity; other `text_mention`
 * entities carry a real user object and are kept, while bare `@handle` mentions
 * of third parties cannot be resolved to an id and are deliberately dropped
 * rather than guessed.
 */
function resolveMentionedTargets(
  input: TelegramMessageAddressingInput,
  observer: MessageAddressingParticipant,
): MessageAddressingParticipant[] {
  const observerHandle = input.observer.username?.trim().toLowerCase();
  const byId = new Map<string, MessageAddressingParticipant>();
  for (const entity of input.entities) {
    if (entity.type === 'text_mention' && entity.user) {
      const participant = String(entity.user.id) === observer.authorId
        ? observer
        : {
          authorId: String(entity.user.id),
          authorName: telegramDisplayName(entity.user),
        };
      byId.set(participant.authorId, participant);
      continue;
    }
    if (entity.type !== 'mention' || !observerHandle) continue;
    const handle = input.messageText
      .slice(entity.offset, entity.offset + entity.length)
      .trim()
      .replace(/^@/, '')
      .toLowerCase();
    if (handle === observerHandle) byId.set(observer.authorId, observer);
  }
  return [...byId.values()];
}

function telegramDisplayName(user: TelegramAddressingUser): string {
  if (user.username) return user.username;
  const combined = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  return combined.length > 0 ? combined : `telegram-${String(user.id)}`;
}
