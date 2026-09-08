import type { ChannelType, SubstrateMessage } from '../../shared/contracts/runtime.js';
import {
  type MessageAddressingMetadata,
  type MessageAddressingSource,
  type MessageAuthorRoomRole,
  type MessageAuthorSourceClass,
  type MessageRoomSizeBand,
} from '../../shared/contracts/message-addressing.js';
import type { RoomParticipationObservation } from './room-participation-lease.js';

/**
 * The channel-neutral room observation (jp36.5.6, bible §8.1).
 *
 * One shape, produced from any connector's normalized `SubstrateMessage` after
 * that connector has already translated its own platform identifiers, mentions,
 * replies, roles, and trust metadata into `routing.addressing`. Everything
 * downstream — the deterministic participation gates, the shared feature
 * extractor, the bounded lease — reads this instead of reaching back into
 * Discord-shaped fields, so participation policy never forks per connector.
 *
 * This is the seam jp36.5.5 left open: {@link toRoomParticipationObservation}
 * projects it onto the content-free `RoomParticipationObservation` the lease
 * gate already consumes, so the lease no longer depends on Discord's
 * `author.bot` marker reaching it by chance.
 *
 * Fail-closed by construction. Anything the connector did not assert is
 * normalized to its least-privileged value (`public_contact`, `unknown` room
 * role, `unknown` room size, no direct address), never guessed from prose.
 */

const ROOM_OBSERVATION_SCHEMA_VERSION = 1 as const;

/** Why a normalized message is not an observable room event. */
type RoomObservationRejection =
  /** A direct/private conversation is never a room. */
  | 'direct_message'
  /** The connector supplied no usable message/author identity. */
  | 'invalid_identity'
  /** The connector supplied no usable event time. */
  | 'invalid_timestamp';

/** Content-free author standing, normalized across connectors. */
interface RoomObservationAuthor {
  authorId: string;
  displayName: string;
  /** Bot/app author, from channel metadata — the bot-loop fence input. */
  isMachine: boolean;
  /** The observing companion's own account authored this message. */
  isObserver: boolean;
  /** Canonical intake trust class; unasserted connectors fall to the floor. */
  sourceClass: MessageAuthorSourceClass;
  /** Platform-asserted standing in this room; `unknown` is untrusted. */
  roomRole: MessageAuthorRoomRole;
}

export interface RoomObservation {
  schemaVersion: typeof ROOM_OBSERVATION_SCHEMA_VERSION;
  /** Which connector translated this event; `unknown` never gains privilege. */
  connector: MessageAddressingSource | 'unknown';
  channelType: ChannelType;
  /** The runtime room key — the same channel id leases and sessions are keyed by. */
  roomId: string;
  /** Platform thread inside the room, when the connector models one. */
  threadId?: string;
  /** Coarse room-size band; `unknown` is treated as the large/untrusted case. */
  roomSize: MessageRoomSizeBand;
  /** True only when the connector asserted a verified group room. */
  roomVerified: boolean;
  messageId: string;
  timestampMs: number;
  author: RoomObservationAuthor;
  /**
   * Connector-authoritative: this message mentions the observing companion.
   * Resolved from `addressing.resolvedAddressee`, never from message prose, so
   * a platform mention and a Nostr `p` tag read identically.
   */
  addressedByMention: boolean;
  /** Connector-authoritative: this message replies to the observing companion. */
  addressedByReply: boolean;
  replyToMessageId?: string;
  /**
   * The room text. Consumed ONLY by the once-per-physical-message feature
   * extraction; it is never persisted on the lease, never attached to a
   * nomination, and never reaches content-free diagnostics.
   */
  content: string;
}

export type RoomObservationResult =
  | { status: 'observed'; observation: RoomObservation }
  | { status: 'rejected'; reason: RoomObservationRejection };

/**
 * Translate one connector-normalized message into the channel-neutral room
 * observation. Pure, allocation-bounded, and free of any model or durable call:
 * an ambient message that never becomes a candidate costs exactly this.
 */
export function normalizeRoomObservation(message: SubstrateMessage): RoomObservationResult {
  const addressing = message.routing?.addressing;
  if (message.isDirectMessage === true || addressing?.channel.scope === 'direct') {
    return { status: 'rejected', reason: 'direct_message' };
  }
  const messageId = message.id.trim();
  const roomId = message.channelId.trim();
  const authorId = message.authorId.trim();
  if (!messageId || !roomId || !authorId) {
    return { status: 'rejected', reason: 'invalid_identity' };
  }
  const timestampMs = message.timestamp instanceof Date
    ? message.timestamp.getTime()
    : Number.NaN;
  if (!Number.isFinite(timestampMs)) {
    return { status: 'rejected', reason: 'invalid_timestamp' };
  }

  const observerId = addressing?.observer.authorId;
  const addressed = resolveObserverAddressing(addressing, observerId);
  const authorClass = addressing?.authorClass;
  const threadId = addressing?.channel.threadId;
  const replyToMessageId = message.replyToMessageId ?? addressing?.replyTarget?.messageId;

  return {
    status: 'observed',
    observation: {
      schemaVersion: ROOM_OBSERVATION_SCHEMA_VERSION,
      connector: addressing?.source ?? 'unknown',
      channelType: message.channelType,
      roomId,
      ...(threadId ? { threadId } : {}),
      roomSize: authorClass?.roomSize ?? 'unknown',
      // Only a connector that produced validated addressing has asserted the
      // group scope; everything else stays unverified and gets no privilege.
      roomVerified: addressing?.channel.scope === 'group',
      messageId,
      timestampMs,
      author: {
        authorId,
        displayName: message.authorName,
        isMachine: message.routing?.authorIsMachineIntelligence === true,
        isObserver: observerId !== undefined && observerId === authorId,
        sourceClass: authorClass?.sourceClass ?? 'public_contact',
        roomRole: authorClass?.roomRole ?? 'unknown',
      },
      addressedByMention: addressed.mention,
      addressedByReply: addressed.reply,
      ...(replyToMessageId ? { replyToMessageId } : {}),
      content: message.content,
    },
  };
}

/**
 * Project the channel-neutral observation onto the content-free shape the
 * bounded room-participation lease gate consumes (jp36.5.5). Length only — the
 * room text stops here.
 */
export function toRoomParticipationObservation(
  observation: RoomObservation,
): RoomParticipationObservation {
  return {
    messageId: observation.messageId,
    timestampMs: observation.timestampMs,
    authorIsMachine: observation.author.isMachine,
    contentLength: observation.content.trim().length,
  };
}

/**
 * Resolve whether the observing companion was directly addressed, using only
 * the connector's own validated addressee resolution. Absent addressing means
 * "not addressed" — the textual alias cue is a separate, weaker signal.
 */
function resolveObserverAddressing(
  addressing: MessageAddressingMetadata | undefined,
  observerId: string | undefined,
): { mention: boolean; reply: boolean } {
  if (!addressing || !observerId) {
    return { mention: false, reply: false };
  }
  const resolved = addressing.resolvedAddressee;
  if (resolved.kind !== 'participants') {
    return { mention: false, reply: false };
  }
  const observer = resolved.participants.find(
    participant => participant.authorId === observerId,
  );
  if (!observer) {
    return { mention: false, reply: false };
  }
  return {
    mention: observer.evidence.includes('mention'),
    reply: observer.evidence.includes('reply'),
  };
}
