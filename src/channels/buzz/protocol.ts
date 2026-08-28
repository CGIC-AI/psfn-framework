import {
  finalizeEvent,
  getPublicKey,
  nip19,
  verifyEvent,
  type Event as NostrEvent,
} from 'nostr-tools';
import { isRecord, isRfc4122Uuid } from '../../shared/utils/types.js';

export const BUZZ_STREAM_KIND = 9;
export const NIP_42_AUTH_KIND = 22_242;
export const BUZZ_MEMBERSHIP_SNAPSHOT_KIND = 39_002;
export const BUZZ_MEMBER_ADDED_KIND = 44_100;
export const BUZZ_MEMBER_REMOVED_KIND = 44_101;
export const BUZZ_STREAM_TEXT_CHUNK_LIMIT = 64 * 1_024;
const NOSTR_HEX_KEY_PATTERN = /^[0-9a-f]{64}$/;
const BUZZ_SCOPED_ID_PREFIX = 'buzz:';

export interface BuzzStreamAcceptancePolicy {
  companionPubkey: string;
  subscribedSince: number;
  nowSeconds: number;
  maxFutureEventSkewSeconds: number;
  channelAllowlist: ReadonlySet<string>;
  authorAllowlist: ReadonlySet<string>;
}

export interface BuzzThreadReference {
  rootEventId: string;
  parentEventId: string;
}

export interface BuzzMembershipChange {
  channelId: string;
  active: boolean;
  position: BuzzMembershipPosition;
}

export interface BuzzMembershipSnapshot {
  channelId: string;
  position: BuzzMembershipPosition;
}

export interface BuzzMembershipPosition {
  createdAt: number;
  eventId: string;
}

export interface BuzzRelayAuthorityPolicy {
  relayPubkey: string;
  companionPubkey: string;
  nowSeconds: number;
  maxFutureEventSkewSeconds: number;
}

export function isNostrHexKey(value: string): boolean {
  return NOSTR_HEX_KEY_PATTERN.test(value);
}

export function parseBuzzPrivateKey(value: string): Uint8Array {
  const normalized = value.trim();
  if (isNostrHexKey(normalized)) return Uint8Array.from(Buffer.from(normalized, 'hex'));
  try {
    const decoded = nip19.decode(normalized);
    if (decoded.type === 'nsec' && decoded.data instanceof Uint8Array) return decoded.data;
  } catch {
    // The stable, secret-free error below covers all decode failures.
  }
  throw new Error('Buzz private key must be a 32-byte lowercase hex key or a valid nsec key');
}

export function companionPubkeyForPrivateKey(privateKey: Uint8Array): string {
  return getPublicKey(privateKey);
}

export function parseBuzzRelayFrame(value: string): unknown[] | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function isNostrEvent(value: unknown): value is NostrEvent {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.pubkey === 'string'
    && typeof value.created_at === 'number'
    && typeof value.kind === 'number'
    && Array.isArray(value.tags)
    && typeof value.content === 'string'
    && typeof value.sig === 'string';
}

export function buzzTagValues(event: NostrEvent, name: string): string[] {
  return event.tags
    .filter(tag => tag[0] === name && typeof tag[1] === 'string')
    .map(tag => tag[1]!);
}

export function acceptsBuzzStreamEvent(
  event: NostrEvent,
  policy: BuzzStreamAcceptancePolicy,
): boolean {
  try {
    if (!verifyEvent(event)) return false;
  } catch {
    return false;
  }
  if (
    event.kind !== BUZZ_STREAM_KIND
    || event.created_at < policy.subscribedSince
    || event.created_at > policy.nowSeconds + policy.maxFutureEventSkewSeconds
  ) return false;
  if (event.pubkey === policy.companionPubkey || !policy.authorAllowlist.has(event.pubkey)) return false;
  if (Buffer.byteLength(event.content, 'utf8') > BUZZ_STREAM_TEXT_CHUNK_LIMIT) return false;
  const channels = buzzTagValues(event, 'h');
  if (channels.length !== 1 || !policy.channelAllowlist.has(channels[0]!)) return false;
  const mentionedPubkeys = buzzTagValues(event, 'p');
  if (mentionedPubkeys.some(pubkey => !isNostrHexKey(pubkey))) return false;
  const hasEventReferences = event.tags.some(tag => tag[0] === 'e');
  const hasAgentTags = event.tags.some(tag => tag[0]?.startsWith('agent-'));
  return !hasAgentTags
    && (!hasEventReferences || parseBuzzThreadReference(event) !== null);
}

/** Parse the strict NIP-10 root/reply pair used by Buzz room threads. */
export function parseBuzzThreadReference(event: NostrEvent): BuzzThreadReference | null {
  const references = event.tags.filter(tag => tag[0] === 'e');
  const roots = references.filter(tag => tag[3] === 'root');
  const replies = references.filter(tag => tag[3] === 'reply');
  if (
    references.length !== 2
    || roots.length !== 1
    || replies.length !== 1
    || references.some(tag => tag.length < 4 || (tag[3] !== 'root' && tag[3] !== 'reply'))
  ) return null;
  const rootEventId = roots[0]?.[1];
  const parentEventId = replies[0]?.[1];
  if (
    typeof rootEventId !== 'string'
    || typeof parentEventId !== 'string'
    || !isNostrHexKey(rootEventId)
    || !isNostrHexKey(parentEventId)
  ) return null;
  return { rootEventId, parentEventId };
}

export function parseBuzzMembershipSnapshot(
  event: NostrEvent,
  policy: BuzzRelayAuthorityPolicy,
): BuzzMembershipSnapshot | null {
  if (!acceptsRelayAuthorityEvent(event, policy, BUZZ_MEMBERSHIP_SNAPSHOT_KIND)) return null;
  const channelIds = buzzTagValues(event, 'd');
  if (
    channelIds.length !== 1
    || !isRfc4122Uuid(channelIds[0]!)
    || !buzzTagValues(event, 'p').includes(policy.companionPubkey)
  ) return null;
  return {
    channelId: channelIds[0]!,
    position: { createdAt: event.created_at, eventId: event.id },
  };
}

export function parseBuzzMembershipChange(
  event: NostrEvent,
  policy: BuzzRelayAuthorityPolicy,
): BuzzMembershipChange | null {
  if (
    !acceptsRelayAuthorityEvent(event, policy, BUZZ_MEMBER_ADDED_KIND)
    && !acceptsRelayAuthorityEvent(event, policy, BUZZ_MEMBER_REMOVED_KIND)
  ) return null;
  const channelIds = buzzTagValues(event, 'h');
  const targets = buzzTagValues(event, 'p');
  if (
    channelIds.length !== 1
    || !isRfc4122Uuid(channelIds[0]!)
    || targets.length !== 1
    || targets[0] !== policy.companionPubkey
  ) return null;
  return {
    channelId: channelIds[0]!,
    active: event.kind === BUZZ_MEMBER_ADDED_KIND,
    position: { createdAt: event.created_at, eventId: event.id },
  };
}

function acceptsRelayAuthorityEvent(
  event: NostrEvent,
  policy: BuzzRelayAuthorityPolicy,
  expectedKind: number,
): boolean {
  if (
    event.kind !== expectedKind
    || event.pubkey !== policy.relayPubkey
    || event.created_at > policy.nowSeconds + policy.maxFutureEventSkewSeconds
  ) return false;
  try {
    return verifyEvent(event);
  } catch {
    return false;
  }
}

export function compareBuzzMembershipPositions(
  left: BuzzMembershipPosition,
  right: BuzzMembershipPosition,
): number {
  if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
  return left.eventId.localeCompare(right.eventId);
}

export function createBuzzAuthEvent(
  relayUrl: string,
  challenge: string,
  privateKey: Uint8Array,
): NostrEvent {
  return finalizeEvent({
    kind: NIP_42_AUTH_KIND,
    created_at: Math.floor(Date.now() / 1_000),
    content: '',
    tags: [['relay', relayUrl], ['challenge', challenge]],
  }, privateKey);
}

export function createBuzzStreamEvent(input: {
  channelId: string;
  content: string;
  tags: string[][];
  privateKey: Uint8Array;
}): NostrEvent {
  return finalizeEvent({
    kind: BUZZ_STREAM_KIND,
    created_at: Math.floor(Date.now() / 1_000),
    content: input.content,
    tags: [['h', input.channelId], ...input.tags],
  }, input.privateKey);
}

export function buzzPrincipal(relayUrl: string, pubkey: string): string {
  return encodeBuzzScopedId(relayUrl, pubkey);
}

export function buzzChannelId(relayUrl: string, channelId: string): string {
  return encodeBuzzScopedId(relayUrl, channelId);
}

export function parseBuzzChannelId(value: string, expectedRelayUrl: string): string {
  const prefix = `${BUZZ_SCOPED_ID_PREFIX}${encodeURIComponent(expectedRelayUrl)}:`;
  if (!value.startsWith(prefix)) {
    throw new Error(`Buzz outbound channel ${value} does not belong to configured relay`);
  }
  const channelId = value.slice(prefix.length);
  if (!channelId) throw new Error('Buzz outbound channel is missing its native channel identifier');
  return channelId;
}

export function buzzDisplayName(pubkey: string): string {
  return nip19.npubEncode(pubkey);
}

function encodeBuzzScopedId(relayUrl: string, nativeId: string): string {
  return `${BUZZ_SCOPED_ID_PREFIX}${encodeURIComponent(relayUrl)}:${nativeId}`;
}
