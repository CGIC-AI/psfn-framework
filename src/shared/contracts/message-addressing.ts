import { isRecord } from '../utils/types.js';
import type { IntakeSourceClass } from './intake-envelope.js';

export const MESSAGE_ADDRESSING_SCHEMA_VERSION = 2 as const;

export interface MessageAddressingParticipant {
  authorId: string;
  authorName: string;
}

/**
 * The chat-author subset of the canonical intake trust vocabulary. Connectors
 * already compute exactly this for body screening (Discord
 * `resolveMessageSourceClass`, Telegram's inline `sourceClass`), so room
 * participation reuses it instead of inventing a second trust ladder.
 */
export const MESSAGE_AUTHOR_SOURCE_CLASSES = [
  'operator',
  'companion_self',
  'primary_user',
  'trusted_contact',
  'regular_contact',
  'public_contact',
] as const satisfies readonly IntakeSourceClass[];

export type MessageAuthorSourceClass = typeof MESSAGE_AUTHOR_SOURCE_CLASSES[number];

/**
 * Narrow a connector's intake source class onto the chat-author subset. Any
 * class outside it (a document, a tool output) is not a room author at all, so
 * it collapses to the least-privileged chat class rather than being trusted.
 */
export function toMessageAuthorSourceClass(value: IntakeSourceClass): MessageAuthorSourceClass {
  return (MESSAGE_AUTHOR_SOURCE_CLASSES as readonly string[]).includes(value)
    ? value as MessageAuthorSourceClass
    : 'public_contact';
}

/**
 * Connector-translated standing of the author inside this room. `unknown` is
 * the fail-closed value every connector that cannot assert standing must use.
 */
export const MESSAGE_AUTHOR_ROOM_ROLES = [
  'owner',
  'moderator',
  'member',
  'guest',
  'unknown',
] as const;

export type MessageAuthorRoomRole = typeof MESSAGE_AUTHOR_ROOM_ROLES[number];

/** Coarse room-size band. `unknown` is treated as the large/untrusted case. */
export const MESSAGE_ROOM_SIZE_BANDS = ['small', 'large', 'unknown'] as const;

export type MessageRoomSizeBand = typeof MESSAGE_ROOM_SIZE_BANDS[number];

/**
 * Content-free author standing captured at the connector boundary (jp36.5.6).
 * It carries no message text and no biography: only the trust class the intake
 * firewall already resolved, the room role the platform asserts, and a coarse
 * room-size band. Participation policy reads these instead of forking per
 * connector.
 */
export interface MessageAddressingAuthorClass {
  sourceClass: MessageAuthorSourceClass;
  roomRole: MessageAuthorRoomRole;
  roomSize: MessageRoomSizeBand;
}

interface MessageAddressingReplyTarget {
  messageId: string;
  author?: MessageAddressingParticipant;
}

interface MessageAddressingChannel {
  scope: 'direct' | 'group';
  channelId: string;
  threadId?: string;
}

export type MessageAddresseeEvidence = 'mention' | 'reply' | 'direct_message';

interface MessageResolvedParticipant extends MessageAddressingParticipant {
  evidence: readonly MessageAddresseeEvidence[];
}

type MessageResolvedAddressee =
  | {
    kind: 'participants';
    participants: readonly MessageResolvedParticipant[];
  }
  | {
    kind: 'room';
    channelId: string;
    threadId?: string;
  }
  | {
    kind: 'unresolved_reply';
    messageId: string;
  };

/**
 * Transport-authoritative addressing captured before CogSec body
 * normalization. The schema deliberately carries the channel payload fields
 * memory attribution needs; sanitized prose is never asked to reconstruct
 * author, channel, reply, mention, or addressee identity.
 */
export interface MessageAddressingMetadata {
  schemaVersion: typeof MESSAGE_ADDRESSING_SCHEMA_VERSION;
  source: MessageAddressingSource;
  author: MessageAddressingParticipant;
  observer: MessageAddressingParticipant;
  mentionedTargets: readonly MessageAddressingParticipant[];
  replyTarget?: MessageAddressingReplyTarget;
  channel: MessageAddressingChannel;
  resolvedAddressee: MessageResolvedAddressee;
  /**
   * Optional connector-translated author standing (jp36.5.6). Absent on
   * envelopes written before it existed and on connectors that cannot assert
   * it; every consumer must treat absence as the untrusted case.
   */
  authorClass?: MessageAddressingAuthorClass;
}

/** Connectors that can assert transport-authoritative addressing. */
export const MESSAGE_ADDRESSING_SOURCES = ['discord', 'buzz', 'telegram'] as const;

export type MessageAddressingSource = typeof MESSAGE_ADDRESSING_SOURCES[number];

function parseRequiredText(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Message addressing field "${fieldName}" must be a non-empty string`);
  }
  return value.trim();
}

function parseParticipant(value: unknown, fieldName: string): MessageAddressingParticipant {
  if (!isRecord(value)) {
    throw new Error(`Message addressing field "${fieldName}" must be an object`);
  }
  return {
    authorId: parseRequiredText(value.authorId, `${fieldName}.authorId`),
    authorName: parseRequiredText(value.authorName, `${fieldName}.authorName`),
  };
}

function parseParticipants(
  value: unknown,
  fieldName: string,
): MessageAddressingParticipant[] {
  if (!Array.isArray(value)) {
    throw new Error(`Message addressing field "${fieldName}" must be an array`);
  }
  const seen = new Set<string>();
  return value.map((participant, index) => {
    const parsed = parseParticipant(participant, `${fieldName}[${index}]`);
    if (seen.has(parsed.authorId)) {
      throw new Error(`Message addressing field "${fieldName}" duplicates "${parsed.authorId}"`);
    }
    seen.add(parsed.authorId);
    return parsed;
  });
}

function parseChannel(value: unknown): MessageAddressingChannel {
  if (!isRecord(value)) {
    throw new Error('Message addressing field "channel" must be an object');
  }
  if (value.scope !== 'direct' && value.scope !== 'group') {
    throw new Error('Message addressing field "channel.scope" must be "direct" or "group"');
  }
  const channelId = parseRequiredText(value.channelId, 'channel.channelId');
  const threadId = value.threadId === undefined
    ? undefined
    : parseRequiredText(value.threadId, 'channel.threadId');
  if (value.scope === 'direct' && threadId) {
    throw new Error('Message addressing direct channel cannot declare a thread');
  }
  return { scope: value.scope, channelId, ...(threadId ? { threadId } : {}) };
}

function parseReplyTarget(value: unknown): MessageAddressingReplyTarget | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error('Message addressing field "replyTarget" must be an object');
  }
  return {
    messageId: parseRequiredText(value.messageId, 'replyTarget.messageId'),
    ...(value.author === undefined
      ? {}
      : { author: parseParticipant(value.author, 'replyTarget.author') }),
  };
}

function parseEvidence(value: unknown, fieldName: string): MessageAddresseeEvidence[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Message addressing field "${fieldName}" must be a non-empty array`);
  }
  const allowed: readonly MessageAddresseeEvidence[] = ['mention', 'reply', 'direct_message'];
  const evidence = value.map((item, index) => {
    if (typeof item !== 'string' || !allowed.includes(item as MessageAddresseeEvidence)) {
      throw new Error(`Message addressing field "${fieldName}[${index}]" is unsupported`);
    }
    return item as MessageAddresseeEvidence;
  });
  if (new Set(evidence).size !== evidence.length) {
    throw new Error(`Message addressing field "${fieldName}" contains duplicate evidence`);
  }
  return evidence;
}

function parseResolvedAddressee(
  value: unknown,
  channel: MessageAddressingChannel,
  observer: MessageAddressingParticipant,
  mentionedTargets: readonly MessageAddressingParticipant[],
  replyTarget: MessageAddressingReplyTarget | undefined,
): MessageResolvedAddressee {
  if (!isRecord(value)) {
    throw new Error('Message addressing field "resolvedAddressee" must be an object');
  }
  if (value.kind === 'participants') {
    if (!Array.isArray(value.participants) || value.participants.length === 0) {
      throw new Error('Message addressing resolved participant list must be non-empty');
    }
    const seen = new Set<string>();
    const participants = value.participants.map((item, index) => {
      const participant = parseParticipant(item, `resolvedAddressee.participants[${index}]`);
      if (!isRecord(item)) {
        throw new Error(`Message addressing resolved participant ${index} must be an object`);
      }
      const evidence = parseEvidence(
        item.evidence,
        `resolvedAddressee.participants[${index}].evidence`,
      );
      if (seen.has(participant.authorId)) {
        throw new Error(`Message addressing resolved participant duplicates "${participant.authorId}"`);
      }
      seen.add(participant.authorId);
      if (
        evidence.includes('mention')
        && !mentionedTargets.some(target => (
          target.authorId === participant.authorId
          && target.authorName === participant.authorName
        ))
      ) {
        throw new Error('Message addressing mention evidence must match mentionedTargets');
      }
      if (
        evidence.includes('reply')
        && (
          replyTarget?.author?.authorId !== participant.authorId
          || replyTarget.author.authorName !== participant.authorName
        )
      ) {
        throw new Error('Message addressing reply evidence must match replyTarget.author');
      }
      if (evidence.includes('direct_message')) {
        if (
          channel.scope !== 'direct'
          || participant.authorId !== observer.authorId
          || participant.authorName !== observer.authorName
        ) {
          throw new Error('Message addressing direct-message evidence must match observer');
        }
      }
      return { ...participant, evidence };
    });
    if (
      channel.scope === 'direct'
      && !participants.some(participant => participant.evidence.includes('direct_message'))
    ) {
      throw new Error('Message addressing direct channel must resolve the authenticated observer');
    }
    return { kind: 'participants', participants };
  }
  if (value.kind === 'room') {
    if (channel.scope !== 'group') {
      throw new Error('Message addressing direct channel cannot resolve a room addressee');
    }
    const channelId = parseRequiredText(value.channelId, 'resolvedAddressee.channelId');
    const threadId = value.threadId === undefined
      ? undefined
      : parseRequiredText(value.threadId, 'resolvedAddressee.threadId');
    if (channelId !== channel.channelId || threadId !== channel.threadId) {
      throw new Error('Message addressing room addressee must match channel identity');
    }
    return { kind: 'room', channelId, ...(threadId ? { threadId } : {}) };
  }
  if (value.kind === 'unresolved_reply') {
    if (channel.scope !== 'group') {
      throw new Error('Message addressing direct channel cannot resolve an unresolved reply');
    }
    const messageId = parseRequiredText(value.messageId, 'resolvedAddressee.messageId');
    if (!replyTarget || replyTarget.messageId !== messageId || replyTarget.author) {
      throw new Error('Message addressing unresolved reply must match an authorless replyTarget');
    }
    return { kind: 'unresolved_reply', messageId };
  }
  throw new Error('Message addressing resolvedAddressee.kind is unsupported');
}

function parseEnumMember<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fieldName: string,
): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new Error(`Message addressing field "${fieldName}" must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

function parseAuthorClass(value: unknown): MessageAddressingAuthorClass | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error('Message addressing field "authorClass" must be an object');
  }
  return {
    sourceClass: parseEnumMember(
      value.sourceClass,
      MESSAGE_AUTHOR_SOURCE_CLASSES,
      'authorClass.sourceClass',
    ),
    roomRole: parseEnumMember(value.roomRole, MESSAGE_AUTHOR_ROOM_ROLES, 'authorClass.roomRole'),
    roomSize: parseEnumMember(value.roomSize, MESSAGE_ROOM_SIZE_BANDS, 'authorClass.roomSize'),
  };
}

/** Validate and normalize the platform envelope. Unknown/legacy schemas reject. */
export function parseMessageAddressingMetadata(value: unknown): MessageAddressingMetadata {
  if (!isRecord(value) || value.schemaVersion !== MESSAGE_ADDRESSING_SCHEMA_VERSION) {
    throw new Error(`Message addressing must be a schemaVersion ${MESSAGE_ADDRESSING_SCHEMA_VERSION} object`);
  }
  if (
    typeof value.source !== 'string'
    || !(MESSAGE_ADDRESSING_SOURCES as readonly string[]).includes(value.source)
  ) {
    throw new Error(
      `Message addressing source must be one of ${MESSAGE_ADDRESSING_SOURCES.join(', ')}`,
    );
  }
  const author = parseParticipant(value.author, 'author');
  const observer = parseParticipant(value.observer, 'observer');
  const mentionedTargets = parseParticipants(value.mentionedTargets, 'mentionedTargets');
  const replyTarget = parseReplyTarget(value.replyTarget);
  const channel = parseChannel(value.channel);
  const resolvedAddressee = parseResolvedAddressee(
    value.resolvedAddressee,
    channel,
    observer,
    mentionedTargets,
    replyTarget,
  );
  const authorClass = parseAuthorClass(value.authorClass);
  return {
    schemaVersion: MESSAGE_ADDRESSING_SCHEMA_VERSION,
    source: value.source as MessageAddressingSource,
    author,
    observer,
    mentionedTargets,
    ...(replyTarget ? { replyTarget } : {}),
    channel,
    resolvedAddressee,
    ...(authorClass ? { authorClass } : {}),
  };
}
