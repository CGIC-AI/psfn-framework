import type { Message } from 'discord.js';
import type {
  MessageAddresseeEvidence,
  MessageAddressingMetadata,
  MessageAddressingParticipant,
  SubstrateMessage,
} from '../../shared/contracts/runtime.js';
import { parseMessageAddressingMetadata } from '../../shared/contracts/message-addressing.js';

interface MutableResolvedDiscordAddressee extends MessageAddressingParticipant {
  evidence: Set<MessageAddresseeEvidence>;
}

export interface DiscordMessageAddressingInput {
  message: Message;
  isDirectMessage: boolean;
  runtimeBotId?: string;
  observer?: { displayName?: string; username?: string };
  fallbackObserverName?: string;
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

  return parseMessageAddressingMetadata({
    schemaVersion: 2,
    source: 'discord',
    author,
    observer,
    mentionedTargets,
    ...(replyTarget ? { replyTarget } : {}),
    channel,
    resolvedAddressee,
  });
}
