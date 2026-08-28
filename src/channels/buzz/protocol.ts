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
  channelAllowlist: ReadonlySet<string>;
  authorAllowlist: ReadonlySet<string>;
  machineAuthorPubkeys: ReadonlySet<string>;
  maxAutonomousReplyHops: number;
}

export interface BuzzCausalEnvelope {
  rootEventId: string;
  chainId: string;
  parentEventId: string;
  hop: number;
  recipientPubkeys: readonly string[];
}

export interface BuzzMembershipChange {
  channelId: string;
  active: boolean;
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
  if (event.kind !== BUZZ_STREAM_KIND || event.created_at < policy.subscribedSince) return false;
  if (event.pubkey === policy.companionPubkey || !policy.authorAllowlist.has(event.pubkey)) return false;
  if (Buffer.byteLength(event.content, 'utf8') > BUZZ_STREAM_TEXT_CHUNK_LIMIT) return false;
  const channels = buzzTagValues(event, 'h');
  if (channels.length !== 1 || !policy.channelAllowlist.has(channels[0]!)) return false;
  const mentionedPubkeys = buzzTagValues(event, 'p');
  if (
    !mentionedPubkeys.includes(policy.companionPubkey)
    || mentionedPubkeys.some(pubkey => !isNostrHexKey(pubkey))
  ) return false;
  if (!policy.machineAuthorPubkeys.has(event.pubkey)) {
    return !event.tags.some(tag => tag[0] === 'e' || tag[0]?.startsWith('agent-'));
  }
  return parseBuzzCausalEnvelope(event, policy.companionPubkey, policy.maxAutonomousReplyHops)
    !== null;
}

export function parseBuzzCausalEnvelope(
  event: NostrEvent,
  companionPubkey: string,
  maxAutonomousReplyHops: number,
): BuzzCausalEnvelope | null {
  const roots = buzzTagValues(event, 'agent-root');
  const chains = buzzTagValues(event, 'agent-chain');
  const hops = buzzTagValues(event, 'agent-hop');
  const recipients = buzzTagValues(event, 'agent-recipient');
  const eventReferences = event.tags.filter(tag => tag[0] === 'e');
  const replyParents = eventReferences
    .filter(tag => tag[3] === 'reply' && typeof tag[1] === 'string')
    .map(tag => tag[1]!);
  const mentionedPubkeys = buzzTagValues(event, 'p');
  const hasUnknownAgentTag = event.tags.some(tag => (
    tag[0]?.startsWith('agent-')
    && tag[0] !== 'agent-root'
    && tag[0] !== 'agent-chain'
    && tag[0] !== 'agent-hop'
    && tag[0] !== 'agent-recipient'
  ));
  if (
    roots.length !== 1
    || chains.length !== 1
    || hops.length !== 1
    || eventReferences.length !== 1
    || replyParents.length !== 1
    || recipients.length === 0
    || new Set(recipients).size !== recipients.length
    || new Set(mentionedPubkeys).size !== mentionedPubkeys.length
    || !sameStringSet(recipients, mentionedPubkeys)
    || hasUnknownAgentTag
  ) return null;
  const rootEventId = roots[0]!;
  const chainId = chains[0]!;
  const parentEventId = replyParents[0]!;
  const hop = Number(hops[0]);
  if (
    !isNostrHexKey(rootEventId)
    || chainId !== rootEventId
    || !isNostrHexKey(parentEventId)
    || !Number.isSafeInteger(hop)
    || hop < 1
    || hop > maxAutonomousReplyHops
    || !recipients.includes(companionPubkey)
    || recipients.some(recipient => !isNostrHexKey(recipient))
  ) return null;
  return { rootEventId, chainId, parentEventId, hop, recipientPubkeys: recipients };
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightValues = new Set(right);
  return left.every(value => rightValues.has(value));
}

export function createBuzzCausalReplyTags(input: {
  rootEventId: string;
  parentEventId: string;
  hop: number;
  recipientPubkeys: readonly string[];
}): string[][] {
  return [
    ['e', input.parentEventId, '', 'reply'],
    ...input.recipientPubkeys.map(pubkey => ['p', pubkey]),
    ['agent-root', input.rootEventId],
    ['agent-chain', input.rootEventId],
    ['agent-hop', String(input.hop)],
    ...input.recipientPubkeys.map(pubkey => ['agent-recipient', pubkey]),
  ];
}

export function parseBuzzMembershipSnapshot(
  event: NostrEvent,
  relayPubkey: string,
  companionPubkey: string,
): string | null {
  if (!acceptsRelayAuthorityEvent(event, relayPubkey, BUZZ_MEMBERSHIP_SNAPSHOT_KIND)) return null;
  const channelIds = buzzTagValues(event, 'd');
  if (
    channelIds.length !== 1
    || !isRfc4122Uuid(channelIds[0]!)
    || !buzzTagValues(event, 'p').includes(companionPubkey)
  ) return null;
  return channelIds[0]!;
}

export function parseBuzzMembershipChange(
  event: NostrEvent,
  relayPubkey: string,
  companionPubkey: string,
): BuzzMembershipChange | null {
  if (
    !acceptsRelayAuthorityEvent(event, relayPubkey, BUZZ_MEMBER_ADDED_KIND)
    && !acceptsRelayAuthorityEvent(event, relayPubkey, BUZZ_MEMBER_REMOVED_KIND)
  ) return null;
  const channelIds = buzzTagValues(event, 'h');
  const targets = buzzTagValues(event, 'p');
  if (
    channelIds.length !== 1
    || !isRfc4122Uuid(channelIds[0]!)
    || targets.length !== 1
    || targets[0] !== companionPubkey
  ) return null;
  return { channelId: channelIds[0]!, active: event.kind === BUZZ_MEMBER_ADDED_KIND };
}

function acceptsRelayAuthorityEvent(
  event: NostrEvent,
  relayPubkey: string,
  expectedKind: number,
): boolean {
  if (event.kind !== expectedKind || event.pubkey !== relayPubkey) return false;
  try {
    return verifyEvent(event);
  } catch {
    return false;
  }
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
