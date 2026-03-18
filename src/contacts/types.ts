import type { TrustLevel, ChannelVisibility } from '../trust/types.js';

export type RelationshipType = 'partner' | 'family' | 'friend' | 'acquaintance' | 'stranger' | 'ai_companion';
export type ContactChannel = string;
export type ChannelPrivacyLevel = ChannelVisibility;

export interface ContactChannelIdentity {
  channel: ContactChannel;
  userId: string;
}

export interface ContactChannelLink extends ContactChannelIdentity {
  privacyLevel: ChannelPrivacyLevel;
  firstSeen?: string;
  lastSeen?: string;
}

export interface ContactConversationChannel {
  channel: ContactChannel;
  channelId: string;
  firstSeen: string;
  lastSeen: string;
  privacyLevel?: ChannelPrivacyLevel;
}

export interface ContactIdentityLinkOptions {
  privacyLevel?: ChannelPrivacyLevel;
}

export type ContactIdentityLinkResult =
  | 'linked'
  | 'already_linked'
  | 'contact_not_found'
  | 'identity_conflict';

export type ContactIdentityLinkVerificationState =
  | 'pending'
  | 'verified'
  | 'failed'
  | 'expired';

export interface ContactIdentityLinkVerification {
  id: string;
  contactId: string;
  sourceChannel: ContactChannel;
  sourceUserId: string;
  targetChannel: ContactChannel;
  targetUserId: string;
  nonce: string;
  expiresAt: string;
  signature: string;
  status: ContactIdentityLinkVerificationState;
  createdAt: string;
  updatedAt: string;
  verifiedAt?: string;
  failureReason?: string;
}

export interface ContactIdentityLinkChallengeInput {
  contactId: string;
  sourceChannel: ContactChannel;
  sourceUserId: string;
  targetChannel: ContactChannel;
  targetUserId: string;
  ttlMs?: number;
}

export type ContactIdentityLinkChallengeResult =
  | {
    status: 'challenge_created' | 'pending_exists';
    verification: ContactIdentityLinkVerification;
  }
  | { status: 'already_linked' }
  | { status: 'contact_not_found' }
  | { status: 'source_identity_not_linked' }
  | { status: 'identity_conflict' };

export interface ContactIdentityLinkVerificationInput {
  contactId: string;
  sourceChannel: ContactChannel;
  sourceUserId: string;
  targetChannel: ContactChannel;
  targetUserId: string;
  nonce: string;
  expiresAt: string;
  signature: string;
  privacyLevel?: ChannelPrivacyLevel;
}

export type ContactIdentityLinkVerificationResult =
  | { status: 'linked' | 'already_linked'; verification: ContactIdentityLinkVerification }
  | { status: 'verification_not_found' }
  | { status: 'verification_replayed'; verification: ContactIdentityLinkVerification }
  | { status: 'verification_expired'; verification: ContactIdentityLinkVerification }
  | { status: 'invalid_signature'; verification: ContactIdentityLinkVerification }
  | { status: 'claim_mismatch'; verification: ContactIdentityLinkVerification }
  | { status: 'source_identity_not_linked'; verification: ContactIdentityLinkVerification }
  | { status: 'identity_conflict'; verification: ContactIdentityLinkVerification }
  | { status: 'contact_not_found' };

export type ContactMutationAuditField = 'trust_level' | 'notes';

export interface ContactMutationAuditEntry {
  id: number;
  contactId: string;
  actor: string;
  field: ContactMutationAuditField;
  oldValue: string | null;
  newValue: string | null;
  timestamp: string;
}

export interface ContactMutationAuditQuery {
  contactId?: string;
  actor?: string;
  field?: ContactMutationAuditField;
  limit?: number;
}

export const CHANNEL_PRIVACY_LEVELS: ChannelPrivacyLevel[] = [
  'private',
  'semi_private',
  'public',
  'broadcast',
];

export const VALID_RELATIONSHIP_TYPES: RelationshipType[] = [
  'partner', 'family', 'friend', 'acquaintance', 'stranger', 'ai_companion',
];

export interface Contact {
  id: string;
  discordUserId?: string;
  nickname?: string;
  channelIdentities?: ContactChannelIdentity[];
  channels?: ContactChannelLink[];
  conversationChannels?: ContactConversationChannel[];
  displayName: string;
  trustLevel: TrustLevel;
  relationshipType: RelationshipType;
  emotionalBaseline?: Record<string, number>;  // e.g. { warmth: 0.7, formality: 0.3 }
  firstSeen: string;  // ISO timestamp
  lastSeen: string;   // ISO timestamp
  notes?: string;
}
