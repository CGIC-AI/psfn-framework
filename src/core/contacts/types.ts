import type { TrustLevel, SensitivityLevel } from '../../system/trust/types.js';
import type { ChannelPrivacy } from '../../system/trust/context-envelope.js';

export type RelationshipType = 'partner' | 'family' | 'friend' | 'acquaintance' | 'stranger' | 'ai_companion';
export type ContactChannel = string;
// E3.2 demoted per-contact privacy to provenance evidence; E3.3 narrows the
// value domain to ChannelPrivacy (stored legacy values decode at read time).
export type ChannelPrivacyLevel = ChannelPrivacy;
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
  /**
   * @deprecated E3.2 (Context Envelope contract, docs/context-envelope.md):
   * per-contact privacy labels are provenance EVIDENCE only. They must never
   * feed channel classification or policy gating — channel privacy is owned
   * by channels.json contextEnvelope labels, operator trust-policy overrides,
   * and derived defaults. Rows are retained for history; removal of the
   * column is a later cleanup bead.
   */
  privacyLevel: ChannelPrivacyLevel;
  firstSeen?: string;
  lastSeen?: string;
}

export interface ContactConversationChannel {
  channel: ContactChannel;
  channelId: string;
  firstSeen: string;
  lastSeen: string;
  /**
   * @deprecated E3.2 (Context Envelope contract, docs/context-envelope.md):
   * provenance evidence only — never a classification or gating input.
   * Retained for history; column removal is a later cleanup bead.
   */
  privacyLevel?: ChannelPrivacyLevel;
}

export interface ContactIdentityLinkOptions {
  /**
   * @deprecated E3.2: recorded as provenance evidence on the contact row
   * only; never consulted by channel classification (docs/context-envelope.md).
   */
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
  /**
   * @deprecated E3.2: provenance evidence recorded on the resulting channel
   * link only; never a classification or gating input (docs/context-envelope.md).
   */
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
  'timezone',
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
  'invite_only',
  'public',
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
  viewerChannelPrivacy?: ChannelPrivacyLevel;
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
  timezone?: string;
  trustLevel: TrustLevel;
  relationshipType: RelationshipType;
  emotionalBaseline?: Record<string, number>;  // e.g. { warmth: 0.7, formality: 0.3 }
  /** True when this contact is another machine intelligence (peer companion/agent) — orthogonal to relationshipType. */
  isMachineIntelligence?: boolean;
  firstSeen: string;  // ISO timestamp
  lastSeen: string;   // ISO timestamp
  notes?: string;
}

// ── Room roster (E4.1) ──
// A "room" is a conversation channel keyed by channelId. Roster data is derived
// ENTIRELY from existing contact_channel_activity rows (who has been seen in a
// channel) joined to the owning contact row — no new modeling, no schema change.
// This is DATA for operator/admin surfaces and future audience-scope consumers
// (E3.3 audienceScope derivation, E4.4). It is NEVER loaded into prompt content.

/** Default page size for a room roster query (operator constraint: bounded, ~50). */
export const DEFAULT_ROOM_ROSTER_LIMIT = 50;
/** Hard upper bound on a single room roster page. */
export const MAX_ROOM_ROSTER_LIMIT = 200;
/** Default cap on the known-rooms listing. */
export const DEFAULT_KNOWN_ROOMS_LIMIT = 100;
/** Hard upper bound on a known-rooms page. */
export const MAX_KNOWN_ROOMS_LIMIT = 500;

/** Summary of one known room (distinct channel + channelId) with membership stats. */
export interface RoomSummary {
  channel: ContactChannel;
  channelId: string;
  /** Count of distinct known contacts with activity in this room. */
  memberCount: number;
  /** Earliest first_seen across members (ISO timestamp). */
  firstActivity: string;
  /** Latest last_seen across members (ISO timestamp). */
  lastActivity: string;
}

/** One known member of a room: channel-activity row joined to the owning contact. */
export interface RoomRosterMember {
  contactId: string;
  displayName: string;
  trustLevel: TrustLevel;
  relationshipType: RelationshipType;
  channel: ContactChannel;
  channelId: string;
  privacyLevel: ChannelPrivacyLevel | null;
  firstSeen: string;  // ISO timestamp of first activity in this room
  lastSeen: string;   // ISO timestamp of most recent activity in this room
}

/** Pagination / filter options for room queries. */
export interface RoomQueryOptions {
  /** Optional channel filter (channelId is the room key, but ids can be scoped per channel). */
  channel?: ContactChannel;
  limit?: number;
  offset?: number;
}
