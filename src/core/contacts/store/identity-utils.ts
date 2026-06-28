import { v7 as uuidv7 } from 'uuid';
import type {
  ChannelPrivacyLevel,
  Contact,
  ContactChannel,
  ContactChannelIdentity,
  ContactChannelLink,
  ContactIdentityLinkOptions,
  ContactIdentityLinkVerification,
  ContactIdentityLinkVerificationState,
  RelationshipType,
} from '../types.js';
import { CHANNEL_PRIVACY_LEVELS } from '../types.js';
import type { TrustLevel } from '../../../system/trust/types.js';
import type { ContactIdentityVerificationRow } from './domain-types.js';

export const LEGACY_DISCORD_CHANNEL = 'discord';
export const DEFAULT_LINK_VERIFICATION_TTL_MS = 5 * 60_000;

export function normalizeIdentity(channel: ContactChannel, userId: string): ContactChannelIdentity {
  const normalizedChannel = channel.trim().toLowerCase() || 'unknown';
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) {
    throw new Error('Contact identity userId cannot be empty');
  }
  return {
    channel: normalizedChannel,
    userId: normalizedUserId,
  };
}

export function defaultPrivacyForChannel(channel: ContactChannel): ChannelPrivacyLevel {
  const normalized = channel.trim().toLowerCase();
  if (normalized === 'api' || normalized === 'internal' || normalized === 'subagent' || normalized === 'shard') {
    return 'private';
  }
  if (normalized === 'twitter' || normalized === 'rss' || normalized === 'broadcast') {
    return 'broadcast';
  }
  return 'semi_private';
}

export function normalizePrivacyLevel(
  privacyLevel: ChannelPrivacyLevel | undefined,
  channel: ContactChannel,
): ChannelPrivacyLevel {
  if (!privacyLevel) return defaultPrivacyForChannel(channel);
  return CHANNEL_PRIVACY_LEVELS.includes(privacyLevel)
    ? privacyLevel
    : defaultPrivacyForChannel(channel);
}

export function isValidChannelPrivacyLevel(level: string): level is ChannelPrivacyLevel {
  return CHANNEL_PRIVACY_LEVELS.includes(level as ChannelPrivacyLevel);
}

export function normalizeChannelLinkInput(
  identity: ContactChannelIdentity,
  options?: ContactIdentityLinkOptions,
): ContactChannelLink {
  const privacyLevel = normalizePrivacyLevel(options?.privacyLevel, identity.channel);
  return {
    channel: identity.channel,
    userId: identity.userId,
    privacyLevel,
    firstSeen: '',
    lastSeen: '',
  };
}

export function identityKey(identity: ContactChannelIdentity): string {
  return `${identity.channel}:${identity.userId}`;
}

export function normalizeVerificationTtlMs(ttlMs: number | undefined): number {
  if (!Number.isFinite(ttlMs) || !ttlMs || ttlMs <= 0) {
    return DEFAULT_LINK_VERIFICATION_TTL_MS;
  }
  return Math.min(Math.floor(ttlMs), 60 * 60_000);
}

export function createVerificationToken(): string {
  return uuidv7().replace(/-/g, '');
}

export function normalizeVerificationState(value: string): ContactIdentityLinkVerificationState {
  switch (value) {
    case 'verified':
    case 'failed':
    case 'expired':
    case 'pending':
      return value;
    default:
      return 'pending';
  }
}

export function toIdentityLinkVerification(
  row: ContactIdentityVerificationRow,
): ContactIdentityLinkVerification {
  return {
    id: row.id,
    contactId: row.contact_id,
    sourceChannel: row.source_channel,
    sourceUserId: row.source_user_id,
    targetChannel: row.target_channel,
    targetUserId: row.target_user_id,
    nonce: row.nonce,
    expiresAt: row.expires_at,
    signature: row.signature,
    status: normalizeVerificationState(row.status),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    verifiedAt: row.verified_at ?? undefined,
    failureReason: row.failure_reason ?? undefined,
  };
}

export function getLegacyDiscordUserId(
  existingDiscordUserId: string | undefined,
  partialDiscordUserId: string | undefined,
  identities: ContactChannelIdentity[],
): string | undefined {
  if (existingDiscordUserId) return existingDiscordUserId;
  if (partialDiscordUserId) return partialDiscordUserId;

  const discordIdentity = identities.find(identity => identity.channel === LEGACY_DISCORD_CHANNEL);
  return discordIdentity?.userId;
}

export function isPrimaryUser(discordUserId: string, primaryUserId?: string): boolean {
  return !!primaryUserId && discordUserId === primaryUserId;
}

export function isPrimaryIdentity(identity: ContactChannelIdentity, primaryUserId?: string): boolean {
  return identity.channel === LEGACY_DISCORD_CHANNEL && isPrimaryUser(identity.userId, primaryUserId);
}

export function isPrimaryContact(
  contact: Contact,
  identities: ContactChannelIdentity[],
  primaryUserId?: string,
): boolean {
  if (contact.trustLevel === 'primary') return true;
  if (contact.discordUserId && isPrimaryUser(contact.discordUserId, primaryUserId)) return true;
  return identities.some(identity => isPrimaryIdentity(identity, primaryUserId));
}

export function normalizeNicknameValue(nickname: string | undefined): string | null | undefined {
  if (nickname === undefined) return undefined;
  const trimmed = nickname.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function looksLikeOpaqueIdentifier(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (/^\d{8,}$/.test(trimmed)) return true;
  if (trimmed.includes(':')) return true;
  if (/^(api|discord|unknown|session|user|id)[-_:.]?[a-z0-9-_.]*$/i.test(trimmed)) return true;
  return false;
}

export function pickPreferredDisplayName(
  targetDisplayName: string,
  sourceDisplayName: string,
  targetDiscordUserId: string | null,
  sourceDiscordUserId: string | null,
): string {
  const normalizedTarget = targetDisplayName.trim();
  const normalizedSource = sourceDisplayName.trim();
  if (!normalizedTarget) return normalizedSource;
  if (!normalizedSource) return normalizedTarget;

  if (
    targetDiscordUserId
    && normalizedTarget === targetDiscordUserId
    && normalizedSource !== (sourceDiscordUserId ?? '')
  ) {
    return normalizedSource;
  }

  if (looksLikeOpaqueIdentifier(normalizedTarget) && !looksLikeOpaqueIdentifier(normalizedSource)) {
    return normalizedSource;
  }

  return normalizedTarget;
}

export function normalizeTrustLevel(value: string): TrustLevel {
  switch (value) {
    case 'primary':
    case 'trusted':
    case 'regular':
    case 'public':
      return value;
    default:
      return 'regular';
  }
}

function trustRank(level: TrustLevel): number {
  switch (level) {
    case 'primary':
      return 3;
    case 'trusted':
      return 2;
    case 'regular':
      return 1;
    case 'public':
    default:
      return 0;
  }
}

export function pickMostTrustedLevel(first: string, second: string): TrustLevel {
  const firstTrust = normalizeTrustLevel(first);
  const secondTrust = normalizeTrustLevel(second);
  return trustRank(firstTrust) >= trustRank(secondTrust) ? firstTrust : secondTrust;
}

export function compareIsoTimestamps(left: string, right: string): number {
  if (!left && !right) return 0;
  if (!left) return -1;
  if (!right) return 1;

  const leftEpoch = Date.parse(left);
  const rightEpoch = Date.parse(right);
  if (!Number.isNaN(leftEpoch) && !Number.isNaN(rightEpoch)) {
    if (leftEpoch === rightEpoch) return 0;
    return leftEpoch > rightEpoch ? 1 : -1;
  }

  return left.localeCompare(right);
}

export function earliestTimestamp(left: string, right: string): string {
  if (!left) return right;
  if (!right) return left;
  return compareIsoTimestamps(left, right) <= 0 ? left : right;
}

export function latestTimestamp(left: string, right: string): string {
  if (!left) return right;
  if (!right) return left;
  return compareIsoTimestamps(left, right) >= 0 ? left : right;
}

export function relationshipForTrust(
  trustLevel: TrustLevel,
  fallback: RelationshipType,
): RelationshipType {
  return trustLevel === 'primary' ? 'partner' : fallback;
}
