import type { Message } from 'discord.js';
import type {
  MessageAddresseeEvidence,
  MessageAddressingMetadata,
  MessageAddressingParticipant,
  SubstrateMessage,
} from '../../shared/contracts/runtime.js';
import {
  parseMessageAddressingMetadata,
  toMessageAuthorSourceClass,
  type MessageAddressingAuthorClass,
  type MessageAuthorRoomRole,
} from '../../shared/contracts/message-addressing.js';
import type { IntakeSourceClass } from '../../shared/contracts/intake-envelope.js';

interface MutableResolvedDiscordAddressee extends MessageAddressingParticipant {
  evidence: Set<MessageAddresseeEvidence>;
}

export interface DiscordMessageAddressingInput {
  message: Message;
  isDirectMessage: boolean;
  runtimeBotId?: string;
  observer?: { displayName?: string; username?: string };
  fallbackObserverName?: string;
  /**
   * The intake trust class the adapter already resolved for body screening
   * (jp36.5.6). Absent input keeps the envelope's `authorClass` absent, which
   * every participation gate reads as untrusted.
   */
  sourceClass?: IntakeSourceClass;
}

/**
 * Guild standing asserted by Discord itself. Ownership beats moderation; a
 * member with no elevated permission is an ordinary member; anything the
 * gateway could not resolve (an uncached member, a DM) stays `unknown` and is
 * treated as untrusted downstream.
 */
function resolveDiscordRoomRole(message: Message): MessageAuthorRoomRole {
  const member = message.member;
  if (!member) return 'unknown';
  if (message.guild?.ownerId === message.author.id) return 'owner';
  // `ManageMessages` is the coarse "can moderate this room" bit; the exact
  // permission set is Discord's own, not a tuning value.
  return member.permissions.has('ManageMessages') ? 'moderator' : 'member';
}

function resolveDiscordAuthorClass(
  input: DiscordMessageAddressingInput,
): MessageAddressingAuthorClass | undefined {
  if (input.sourceClass === undefined) return undefined;
  return {
    sourceClass: toMessageAuthorSourceClass(input.sourceClass),
    roomRole: input.isDirectMessage ? 'unknown' : resolveDiscordRoomRole(input.message),
    // Discord exposes a guild member count, but banding it needs an owner-owned
    // threshold the adapter does not carry. Until that lands the band stays
    // `unknown`, which every gate treats as the large/untrusted case.
    roomSize: 'unknown',
  };
}

function hasEquivalentDiscordAddressing(
  left: SubstrateMessage,
  right: SubstrateMessage,
): boolean {
  return JSON.stringify(left.routing?.addressing ?? null)
    === JSON.stringify(right.routing?.addressing ?? null);
}

/** Coalesce only contiguous turns whose author and transport addressing agree. */
export function coalesceDiscordTurnsByAddressing<
  Turn extends { substrateMsg: SubstrateMessage },
>(turns: Turn[], merge: (group: Turn[]) => Turn): Turn[] {
  const groups: Turn[][] = [];
  for (const turn of turns) {
    const current = groups.at(-1);
    const first = current?.[0];
    if (
      first
      && first.substrateMsg.authorId === turn.substrateMsg.authorId
      && hasEquivalentDiscordAddressing(first.substrateMsg, turn.substrateMsg)
    ) {
      current.push(turn);
    } else {
      groups.push([turn]);
    }
  }
  return groups.map(merge);
}

/** Build and validate transport-authoritative Discord addressing before body screening. */
export function buildDiscordMessageAddressing(
  input: DiscordMessageAddressingInput,
): MessageAddressingMetadata {
  const {
    message,
    isDirectMessage,
    runtimeBotId,
    observer: authenticatedObserver,
    fallbackObserverName,
  } = input;
  const author = {
    authorId: message.author.id,
    authorName: message.author.displayName,
  };
  if (!runtimeBotId?.trim()) {
    throw new Error('Discord message has no authenticated companion author id; refusing addressing fallback');
  }
  const observerName = authenticatedObserver?.displayName?.trim()
    || authenticatedObserver?.username?.trim()
    || fallbackObserverName?.trim();
  if (!observerName) {
    throw new Error('Discord message has no authenticated companion display name; refusing addressing fallback');
  }
  const observer = { authorId: runtimeBotId.trim(), authorName: observerName };
  const mentionedTargets = [...message.mentions.users.values()].map(user => ({
    authorId: user.id,
    authorName: user.displayName,
  }));
  const repliedUser = message.mentions.repliedUser;
  const replyTarget = message.reference?.messageId
    ? {
      messageId: message.reference.messageId,
      ...(repliedUser
        ? {
          author: {
            authorId: repliedUser.id,
            authorName: repliedUser.displayName,
          },
        }
        : {}),
    }
    : undefined;
  const channel = message.channel.isThread()
    ? (() => {
      if (!message.channel.parentId) {
        throw new Error(`Discord thread ${message.channelId} has no parent channel; refusing addressing fallback`);
      }
      return {
        scope: 'group' as const,
        channelId: message.channel.parentId,
        threadId: message.channelId,
      };
    })()
    : {
      scope: isDirectMessage ? 'direct' as const : 'group' as const,
      channelId: message.channelId,
    };

  const addressees = new Map<string, MutableResolvedDiscordAddressee>();
  const addAddressee = (
    participant: MessageAddressingParticipant,
    evidence: MessageAddresseeEvidence,
  ): void => {
    const existing = addressees.get(participant.authorId);
    if (existing) {
      if (existing.authorName !== participant.authorName) {
        throw new Error(
          `Discord addressing identity ${participant.authorId} has conflicting display names`,
        );
      }
      existing.evidence.add(evidence);
      return;
    }
    addressees.set(participant.authorId, {
      ...participant,
      evidence: new Set([evidence]),
    });
  };
  for (const target of mentionedTargets) addAddressee(target, 'mention');
  if (replyTarget?.author) addAddressee(replyTarget.author, 'reply');
  if (isDirectMessage) addAddressee(observer, 'direct_message');

  const resolvedParticipants = [...addressees.values()].map(participant => ({
    authorId: participant.authorId,
    authorName: participant.authorName,
    evidence: (['mention', 'reply', 'direct_message'] as const)
      .filter(item => participant.evidence.has(item)),
  }));
  const resolvedAddressee = resolvedParticipants.length > 0
    ? { kind: 'participants' as const, participants: resolvedParticipants }
    : replyTarget
      ? { kind: 'unresolved_reply' as const, messageId: replyTarget.messageId }
      : { kind: 'room' as const, ...channel };

  const authorClass = resolveDiscordAuthorClass(input);
  return parseMessageAddressingMetadata({
    schemaVersion: 2,
    source: 'discord',
    author,
    observer,
    mentionedTargets,
    ...(replyTarget ? { replyTarget } : {}),
    channel,
    resolvedAddressee,
    ...(authorClass ? { authorClass } : {}),
  });
}
