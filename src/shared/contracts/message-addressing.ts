import { isRecord } from '../utils/types.js';

export const MESSAGE_ADDRESSING_SCHEMA_VERSION = 2 as const;

export interface MessageAddressingParticipant {
  authorId: string;
  authorName: string;
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
 * normalization. The schema deliberately carries the Discord payload fields
 * memory attribution needs; sanitized prose is never asked to reconstruct
 * author, channel, reply, mention, or addressee identity.
 */
export interface MessageAddressingMetadata {
  schemaVersion: typeof MESSAGE_ADDRESSING_SCHEMA_VERSION;
  source: 'discord';
  author: MessageAddressingParticipant;
  observer: MessageAddressingParticipant;
  mentionedTargets: readonly MessageAddressingParticipant[];
  replyTarget?: MessageAddressingReplyTarget;
  channel: MessageAddressingChannel;
  resolvedAddressee: MessageResolvedAddressee;
}

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

/** Validate and normalize the platform envelope. Unknown/legacy schemas reject. */
export function parseMessageAddressingMetadata(value: unknown): MessageAddressingMetadata {
  if (!isRecord(value) || value.schemaVersion !== MESSAGE_ADDRESSING_SCHEMA_VERSION) {
    throw new Error(`Message addressing must be a schemaVersion ${MESSAGE_ADDRESSING_SCHEMA_VERSION} object`);
  }
  if (value.source !== 'discord') {
    throw new Error('Message addressing source must be "discord"');
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
  return {
    schemaVersion: MESSAGE_ADDRESSING_SCHEMA_VERSION,
    source: 'discord',
    author,
    observer,
    mentionedTargets,
    ...(replyTarget ? { replyTarget } : {}),
    channel,
    resolvedAddressee,
  };
}
