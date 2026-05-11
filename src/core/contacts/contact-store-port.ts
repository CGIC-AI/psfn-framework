import type {
  LowTierTrustDriftSuggestion,
  TrustDriftBehaviorSignals,
} from '../../system/trust/policy.js';
import type { TrustLevel, TrustMutationSource } from '../../system/trust/types.js';
import type { EmotionalSnapshot, EmotionalTimeSeriesPoint } from './store/emotional-baseline.js';
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

export interface ContactStorePort {
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
  updateLastSeen(id: string): Awaitable<void>;
  updateIdentityProfile(contactId: string, displayName: string, nickname?: string, actor?: string): Awaitable<boolean>;
  recordChannelActivity(
    contactId: string,
    channel: ContactChannel,
    channelId: string,
    privacyLevel?: ChannelPrivacyLevel,
  ): Awaitable<void>;
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
}
