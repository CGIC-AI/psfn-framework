import type {
  type LowTierTrustDriftSuggestion,
  type TrustDriftBehaviorSignals,
} from '../../system/trust/policy.js';
import type { TrustLevel, TrustMutationSource } from '../../system/trust/types.js';
import type { EmotionalSnapshot } from './store/emotional-baseline.js';
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
  ): Contact;
  getById(id: string): Contact | undefined;
  getByDiscordUserId(discordUserId: string): Contact | undefined;
  getByChannelIdentity(channel: ContactChannel, channelUserId: string): Contact | undefined;
  getByTrustLevel(trustLevel: TrustLevel): Contact[];
  getSocialGraphEntityById(entityId: string): SocialGraphEntity | undefined;
  getSocialGraphEntityByContactId(contactId: string): SocialGraphEntity | undefined;
  listSocialGraphEntities(query?: SocialGraphEntityQuery): SocialGraphEntity[];
  upsertSocialGraphEntity(input: SocialGraphEntityUpsertInput): SocialGraphEntity;
  upsertSocialRelationshipEdge(input: SocialRelationshipEdgeUpsertInput): SocialRelationshipEdge;
  listSocialRelationshipEdges(query?: SocialRelationshipEdgeQuery): SocialRelationshipEdge[];
  listRelatedContacts(contactId: string, query?: SocialRelationshipEdgeQuery): Contact[];
  suggestLowTierTrustDrift(
    id: string,
    signals: TrustDriftBehaviorSignals,
    actor?: string,
  ): ContactTrustDriftSuggestion | null;
  applyLowTierTrustDriftSuggestion(
    id: string,
    suggestion: ContactTrustDriftSuggestion,
    actor?: string,
  ): ContactTrustDriftApplyResult;
  setTrustLevel(
    id: string,
    trustLevel: TrustLevel,
    actor?: string,
    options?: ContactTrustMutationOptions,
  ): boolean;
  updateLastSeen(id: string): void;
  updateIdentityProfile(contactId: string, displayName: string, nickname?: string, actor?: string): boolean;
  recordChannelActivity(
    contactId: string,
    channel: ContactChannel,
    channelId: string,
    privacyLevel?: ChannelPrivacyLevel,
  ): void;
  mergeContacts(sourceContactId: string, targetContactId: string): boolean;
  updateNotes(id: string, notes: string, actor?: string): boolean;
  updateEmotionalBaseline(
    id: string,
    observation: {
      valence: number;
      confidence?: number;
      observedAtMs?: number;
    },
  ): Contact | undefined;
  getEmotionalSnapshot(id: string): EmotionalSnapshot | undefined;
  updateRelationshipType(id: string, relationshipType: RelationshipType, actor?: string): boolean;
  setChannelPrivacy(
    contactId: string,
    channel: ContactChannel,
    channelUserId: string,
    privacyLevel: ChannelPrivacyLevel,
    actor?: string,
  ): boolean;
  setConversationChannelPrivacy(
    contactId: string,
    channel: ContactChannel,
    channelId: string,
    privacyLevel: ChannelPrivacyLevel,
    actor?: string,
  ): boolean;
  getConversationChannelPrivacy(
    contactId: string,
    channel: ContactChannel,
    channelId: string,
  ): ChannelPrivacyLevel | undefined;
  deleteConversationChannel(contactId: string, channel: ContactChannel, channelId: string, actor?: string): boolean;
  createIdentityLinkChallenge(
    input: ContactIdentityLinkChallengeInput,
  ): ContactIdentityLinkChallengeResult;
  verifyIdentityLinkChallenge(
    input: ContactIdentityLinkVerificationInput,
  ): ContactIdentityLinkVerificationResult;
  linkChannelIdentity(
    contactId: string,
    channel: ContactChannel,
    channelUserId: string,
    options?: ContactIdentityLinkOptions,
    actor?: string,
  ): ContactIdentityLinkResult;
  listAll(): Contact[];
  listIdentityLinkVerifications(limit?: number): ContactIdentityLinkVerification[];
  listMutationAuditEntries(query?: ContactMutationAuditQuery): ContactMutationAuditEntry[];
  resolveChannelIdentity(
    channel: ContactChannel,
    channelUserId: string,
    displayName?: string,
  ): Contact;
  resolveUserId(discordUserId: string): Contact;
  getCanonicalContactKey(channel: ContactChannel, channelUserId: string): string | undefined;
  deleteContact(id: string): boolean;
  unlinkChannelIdentity(contactId: string, channel: string, channelUserId: string, actor?: string): boolean;
}
