import type { TrustLevel, ChannelVisibility, SensitivityLevel } from '../../system/trust/types.js';

export type RelationshipType = 'partner' | 'family' | 'friend' | 'acquaintance' | 'stranger' | 'ai_companion';
export type ContactChannel = string;
export type ChannelPrivacyLevel = ChannelVisibility;
export type SocialGraphEntityKind = 'person';
export type SocialGraphEntitySource = 'contact' | 'memory' | 'manual' | 'system';
export type SocialRelationshipKind =
  | 'partner'
  | 'family'
  | 'friend'
  | 'acquaintance'
  | 'colleague'
  | 'parent'
  | 'child'
  | 'sibling'
  | 'caregiver'
  | 'household'
  | 'manager'
  | 'direct_report'
  | 'other';

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

export const CONTACT_MUTATION_AUDIT_FIELDS = [
  'trust_level',
  'is_machine_intelligence',
  'notes',
  'display_name',
  'nickname',
  'relationship_type',
  'channel_privacy',
  'channel_link',
  'conversation_channel',
] as const;

export type ContactMutationAuditField = typeof CONTACT_MUTATION_AUDIT_FIELDS[number];

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
export const VALID_SOCIAL_GRAPH_ENTITY_KINDS: SocialGraphEntityKind[] = ['person'];
export const VALID_SOCIAL_GRAPH_SOURCES: SocialGraphEntitySource[] = ['contact', 'memory', 'manual', 'system'];
export const VALID_SOCIAL_RELATIONSHIP_KINDS: SocialRelationshipKind[] = [
  'partner',
  'family',
  'friend',
  'acquaintance',
  'colleague',
  'parent',
  'child',
  'sibling',
  'caregiver',
  'household',
  'manager',
  'direct_report',
  'other',
];

export interface SocialGraphEntity {
  id: string;
  entityKind: SocialGraphEntityKind;
  displayName: string;
  contactId?: string;
  sensitivity: SensitivityLevel;
  provenanceRefs: string[];
  confidence: number;
  source: SocialGraphEntitySource;
  createdAt: string;
  updatedAt: string;
}

export interface SocialGraphEntityUpsertInput {
  id?: string;
  entityKind?: SocialGraphEntityKind;
  displayName: string;
  contactId?: string;
  sensitivity?: SensitivityLevel;
  provenanceRefs?: string[];
  confidence?: number;
  source?: SocialGraphEntitySource;
}

export interface SocialGraphQueryOptions {
  viewerTrustLevel?: TrustLevel;
  viewerChannelVisibility?: ChannelPrivacyLevel;
  limit?: number;
}

export interface SocialGraphEntityQuery extends SocialGraphQueryOptions {
  contactId?: string;
}

export interface SocialRelationshipEdge {
  id: string;
  sourceEntityId: string;
  targetEntityId: string;
  relationshipType: SocialRelationshipKind;
  directional: boolean;
  sensitivity: SensitivityLevel;
  provenanceRefs: string[];
  evidenceMemoryIds: string[];
  confidence: number;
  createdAt: string;
  updatedAt: string;
}

export interface SocialRelationshipEdgeUpsertInput {
  sourceEntityId: string;
  targetEntityId: string;
  relationshipType: SocialRelationshipKind;
  directional?: boolean;
  sensitivity?: SensitivityLevel;
  provenanceRefs?: string[];
  evidenceMemoryIds?: string[];
  confidence?: number;
}

export interface SocialRelationshipEdgeQuery extends SocialGraphQueryOptions {
  contactId?: string;
  entityId?: string;
  relationshipType?: SocialRelationshipKind;
  minConfidence?: number;
}

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
  /** True when this contact is another machine intelligence (peer companion/agent) — orthogonal to relationshipType. */
  isMachineIntelligence?: boolean;
  firstSeen: string;  // ISO timestamp
  lastSeen: string;   // ISO timestamp
  notes?: string;
}
