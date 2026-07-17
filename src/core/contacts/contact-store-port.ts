import type {
  LowTierTrustDriftSuggestion,
  TrustDriftBehaviorSignals,
} from '../../system/trust/policy.js';
import type { TrustLevel, TrustMutationSource } from '../../system/trust/types.js';
import type { EmotionalSnapshot, EmotionalTimeSeriesPoint } from './store/emotional-baseline.js';
import type {
  ContactLifecycleGatewayResultInput,
  ContactLifecyclePrepareOutcome,
  ContactLifecycleRecoveryClaimInput,
  ContactLifecycleRecoveryDeferralInput,
  ContactLifecycleRecoveryLease,
} from '../../shared/contracts/contact-lifecycle-ledger.js';
import type {
  ChannelPrivacyLevel,
  Contact,
  ContactChannel,
  ContactIdentityLinkChallengeInput,
  ContactIdentityLinkChallengeResult,
  ContactIdentityLinkOptions,
  ContactIdentityLinkResult,
  ContactIdentityLinkVerification,
  ContactIdentityLinkVerificationInput,
  ContactIdentityLinkVerificationResult,
  ContactMutationAuditEntry,
  ContactMutationAuditQuery,
  RelationshipType,
  RoomQueryOptions,
  RoomRosterMember,
  RoomSummary,
  SocialGraphEntity,
  SocialGraphEntityQuery,
  SocialGraphEntityUpsertInput,
  SocialRelationshipEdge,
  SocialRelationshipEdgeQuery,
  SocialRelationshipEdgeUpsertInput,
} from './types.js';

export interface ContactTrustMutationOptions {
  allowPrimaryTrustAssignment?: boolean;
  mutationSource?: TrustMutationSource;
}

export interface ContactUpsertMutationOptions extends ContactTrustMutationOptions {
  actor?: string;
}

type Awaitable<T> = T | Promise<T>;

export interface ContactTrustDriftSuggestion extends LowTierTrustDriftSuggestion {
  contactId: string;
  createdAt: string;
}

export interface ContactTrustDriftApplyResult {
  applied: boolean;
  reason: string;
}

export type ContactLifecycleDiagnosticState = 'prepared' | 'over_fenced' | 'manual_hold';

/**
 * Bounded operator projection of durable contact-authority work. Deliberately
 * omits intent, contact, companion, and provider-subject identifiers.
 */
export interface ContactLifecycleDiagnosticEntry {
  action: 'contact.merge' | 'contact.delete' | 'contact.discord_unlink'
    | 'contact.identity_conflict' | 'contact.verify' | 'contact.reapprove';
  state: ContactLifecycleDiagnosticState;
  phase: 'gateway_prepare_pending' | 'contact_commit_pending'
    | 'gateway_finalize_pending' | 'manual_hold' | 'quarantined';
  reason: string;
  retryCount: number;
  updatedAt: string;
}

export interface ContactLifecycleDiagnostics {
  schemaVersion: 1;
  total: number;
  truncated: boolean;
  counts: Record<ContactLifecycleDiagnosticState, number>;
  entries: ContactLifecycleDiagnosticEntry[];
}

/**
 * Outcome of an atomic observation-driven machine-intelligence marking (E7.3).
 * `override_preserved` means the latest `is_machine_intelligence` audit entry
 * was a deliberate (non-`system:`) correction, so the observation did not write.
 */
export type MachineIntelligenceObservationMarkResult =
  | 'marked'
  | 'already_marked'
  | 'override_preserved'
  | 'not_found';

export interface ContactStorePort {
  /** Exact current companion-owned Discord/contact authority for fleet activation. */
  readVerifiedDiscordContactAuthority(
    contactId: string,
    providerSubjectId: string,
  ): Awaitable<import('../../shared/contracts/contact-authority-snapshot.js').VerifiedDiscordContactAuthoritySnapshot | undefined>;
  /** Prepare or exactly resume one companion-local contact authority saga. */
  prepareContactLifecycleIntent(input: unknown): Awaitable<ContactLifecyclePrepareOutcome>;
  /** Append one exact gateway result and advance the durable companion phase. */
  recordContactLifecycleGatewayResult(
    input: ContactLifecycleGatewayResultInput,
  ): Awaitable<ContactLifecyclePrepareOutcome>;
  /** Claim bounded startup/retry work with database-owned leases. */
  claimContactLifecycleRecovery(
    input: ContactLifecycleRecoveryClaimInput,
  ): Awaitable<ContactLifecycleRecoveryLease[]>;
  /** Release a failed recovery lease with durable exponential backoff. */
  deferContactLifecycleRecovery(
    input: ContactLifecycleRecoveryDeferralInput,
  ): Awaitable<ContactLifecyclePrepareOutcome>;
  /** Startup integrity check; corrupt authority state fails store creation. */
  assertContactLifecycleLedgerHealthy(): Awaitable<void>;
  /** Resume a bounded batch of durable contact-authority mutations at startup. */
  recoverContactLifecycleMutations(): Awaitable<ContactLifecyclePrepareOutcome[]>;
  /** Identity-free, bounded projection of pending/over-fenced/manual-hold work. */
  getContactLifecycleDiagnostics(limit?: number): Awaitable<ContactLifecycleDiagnostics>;
  upsert(
    partial: Partial<Contact> & { displayName: string },
    options?: ContactUpsertMutationOptions,
  ): Awaitable<Contact>;
  getById(id: string): Awaitable<Contact | undefined>;
  getByDiscordUserId(discordUserId: string): Awaitable<Contact | undefined>;
  getByChannelIdentity(channel: ContactChannel, channelUserId: string): Awaitable<Contact | undefined>;
  getByTrustLevel(trustLevel: TrustLevel): Awaitable<Contact[]>;
  getSocialGraphEntityById(entityId: string): Awaitable<SocialGraphEntity | undefined>;
  getSocialGraphEntityByContactId(contactId: string): Awaitable<SocialGraphEntity | undefined>;
  listSocialGraphEntities(query?: SocialGraphEntityQuery): Awaitable<SocialGraphEntity[]>;
  upsertSocialGraphEntity(input: SocialGraphEntityUpsertInput): Awaitable<SocialGraphEntity>;
  upsertSocialRelationshipEdge(input: SocialRelationshipEdgeUpsertInput): Awaitable<SocialRelationshipEdge>;
  listSocialRelationshipEdges(query?: SocialRelationshipEdgeQuery): Awaitable<SocialRelationshipEdge[]>;
  listRelatedContacts(contactId: string, query?: SocialRelationshipEdgeQuery): Awaitable<Contact[]>;
  /** Count of identity-link challenges this contact has completed with status 'verified'. */
  countVerifiedIdentityLinks(contactId: string): Awaitable<number>;
  /**
   * Durable per-processor maintenance watermark (ISO timestamp of the last
   * completed run). Used by scheduler-owned contact maintenance lanes (e.g.
   * the nightly trust-drift review) to run at most once per calendar day
   * across restarts. Unknown processor → undefined.
   */
  getContactMaintenanceWatermark(processor: string): Awaitable<string | undefined>;
  setContactMaintenanceWatermark(processor: string, lastRunAt: string): Awaitable<void>;
  suggestLowTierTrustDrift(
    id: string,
    signals: TrustDriftBehaviorSignals,
    actor?: string,
  ): Awaitable<ContactTrustDriftSuggestion | null>;
  applyLowTierTrustDriftSuggestion(
    id: string,
    suggestion: ContactTrustDriftSuggestion,
    actor?: string,
  ): Awaitable<ContactTrustDriftApplyResult>;
  setTrustLevel(
    id: string,
    trustLevel: TrustLevel,
    actor?: string,
    options?: ContactTrustMutationOptions,
  ): Awaitable<boolean>;
  setMachineIntelligence(id: string, isMachineIntelligence: boolean, actor?: string): Awaitable<boolean>;
  /**
   * Atomically checks the latest `is_machine_intelligence` audit actor and sets
   * the marker in the same critical section — a concurrent deliberate correction
   * can never be clobbered by an observation (no check-then-write TOCTOU).
   */
  markMachineIntelligenceFromObservation(
    id: string,
    actor: string,
  ): Awaitable<MachineIntelligenceObservationMarkResult>;
  updateLastSeen(id: string): Awaitable<void>;
  updateIdentityProfile(contactId: string, displayName: string, nickname?: string, actor?: string): Awaitable<boolean>;
  recordChannelActivity(
    contactId: string,
    channel: ContactChannel,
    channelId: string,
    privacyLevel?: ChannelPrivacyLevel,
  ): Awaitable<void>;
  // ── Room roster (E4.1) ──
  // Bounded, read-only queries over contact_channel_activity for the operator
  // room surface. These are the seam that E3.3 (audienceScope derivation) and
  // E4.4 will later consume for roster size — do NOT wire those consumers here,
  // and never route this data into prompt content.
  /** Distinct known rooms (channel + channelId) with member counts and activity bounds. */
  listKnownRooms(options?: Pick<RoomQueryOptions, 'limit' | 'offset'>): Awaitable<RoomSummary[]>;
  /** Total count of distinct known rooms (for room-list pagination). */
  countKnownRooms(): Awaitable<number>;
  /** Known members of a room ordered by last-seen desc; bounded + paginated. */
  listRoomRoster(channelId: string, options?: RoomQueryOptions): Awaitable<RoomRosterMember[]>;
  /** Total known-member count for a room (for roster pagination). */
  countRoomRoster(channelId: string, options?: Pick<RoomQueryOptions, 'channel'>): Awaitable<number>;
  mergeContacts(sourceContactId: string, targetContactId: string): Awaitable<boolean>;
  updateNotes(id: string, notes: string, actor?: string): Awaitable<boolean>;
  updateEmotionalBaseline(
    id: string,
    observation: {
      valence: number;
      confidence?: number;
      observedAtMs?: number;
    },
  ): Awaitable<Contact | undefined>;
  getEmotionalSnapshot(id: string): Awaitable<EmotionalSnapshot | undefined>;
  getEmotionalTimeSeries(id: string, limit?: number): Awaitable<EmotionalTimeSeriesPoint[]>;
  updateRelationshipType(id: string, relationshipType: RelationshipType, actor?: string): Awaitable<boolean>;
  /** Atomically changes a relationship only while its persisted value matches `expectedRelationshipType`. */
  compareAndSetRelationshipType(
    id: string,
    expectedRelationshipType: RelationshipType,
    relationshipType: RelationshipType,
    actor?: string,
  ): Awaitable<boolean>;
  setChannelPrivacy(
    contactId: string,
    channel: ContactChannel,
    channelUserId: string,
    privacyLevel: ChannelPrivacyLevel,
    actor?: string,
  ): Awaitable<boolean>;
  setConversationChannelPrivacy(
    contactId: string,
    channel: ContactChannel,
    channelId: string,
    privacyLevel: ChannelPrivacyLevel,
    actor?: string,
  ): Awaitable<boolean>;
  getConversationChannelPrivacy(
    contactId: string,
    channel: ContactChannel,
    channelId: string,
  ): Awaitable<ChannelPrivacyLevel | undefined>;
  deleteConversationChannel(contactId: string, channel: ContactChannel, channelId: string, actor?: string): Awaitable<boolean>;
  createIdentityLinkChallenge(
    input: ContactIdentityLinkChallengeInput,
  ): Awaitable<ContactIdentityLinkChallengeResult>;
  verifyIdentityLinkChallenge(
    input: ContactIdentityLinkVerificationInput,
  ): Awaitable<ContactIdentityLinkVerificationResult>;
  linkChannelIdentity(
    contactId: string,
    channel: ContactChannel,
    channelUserId: string,
    options?: ContactIdentityLinkOptions,
    actor?: string,
  ): Awaitable<ContactIdentityLinkResult>;
  listAll(): Awaitable<Contact[]>;
  listIdentityLinkVerifications(limit?: number): Awaitable<ContactIdentityLinkVerification[]>;
  listMutationAuditEntries(query?: ContactMutationAuditQuery): Awaitable<ContactMutationAuditEntry[]>;
  resolveChannelIdentity(
    channel: ContactChannel,
    channelUserId: string,
    displayName?: string,
  ): Awaitable<Contact>;
  resolveUserId(discordUserId: string): Awaitable<Contact>;
  getCanonicalContactKey(channel: ContactChannel, channelUserId: string): Awaitable<string | undefined>;
  deleteContact(id: string): Awaitable<boolean>;
  unlinkChannelIdentity(contactId: string, channel: string, channelUserId: string, actor?: string): Awaitable<boolean>;
  /** Reapprove one exact restored Discord ownership through the authenticated saga. */
  reapproveRestoredDiscordIdentity(contactId: string, channelUserId: string): Awaitable<boolean>;
}
