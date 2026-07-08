import type { ContactProfileArtifact } from '../../../../faculties/memory/memory-store-port.js';
import type {
  Contact,
  ContactIdentityLinkVerification,
  ContactMutationAuditEntry,
  ContactMutationAuditQuery,
  RelationshipType,
  SocialGraphEntitySource,
  SocialRelationshipKind,
} from '../../../../core/contacts/types.js';
import type {
  SensitivityLevel,
  TrustLevel,
} from '../../../../system/trust/types.js';
import type { ContactConversationChannelView } from '../contact-session-linker.js';

export interface AdminContactListData {
  contacts: Contact[];
  profileMap: Map<string, ContactProfileArtifact>;
  relatedChannelMap: Map<string, ContactConversationChannelView[]>;
  socialGraphMap: Map<string, AdminContactSocialGraphView>;
  relationshipScoreMap?: Map<string, AdminContactRelationshipScoreView>;
  verifications: ContactIdentityLinkVerification[];
  mutationAudits: ContactMutationAuditEntry[];
  mutationAuditQuery: ContactMutationAuditQuery;
}

export interface AdminContactDetailData {
  contact: Contact;
  profile?: ContactProfileArtifact;
  relatedChannels: ContactConversationChannelView[];
}

export interface ContactUpdateResult {
  ok: boolean;
  message: string;
  contact?: Contact;
  relatedChannels?: ContactConversationChannelView[];
}

export interface AdminContactSocialGraphEntityView {
  id: string;
  displayName: string;
  contactId?: string;
  source: SocialGraphEntitySource;
  sensitivity: SensitivityLevel;
  confidence: number;
  provenanceRefs: string[];
  createdAt: string;
  updatedAt: string;
}

export interface AdminContactSocialGraphNeighborView {
  entityId: string;
  contactId?: string;
  displayName: string;
  source: SocialGraphEntitySource;
  sensitivity: SensitivityLevel;
  confidence: number;
  provenanceRefs: string[];
  mentionOnly: boolean;
  trustLevel?: TrustLevel;
  relationshipType?: RelationshipType;
  profileSummary?: string;
  profileUpdatedAt?: number;
}

export interface AdminContactSocialGraphConnectionView {
  edgeId: string;
  relationshipType: SocialRelationshipKind;
  directional: boolean;
  direction: 'incoming' | 'outgoing' | 'undirected';
  sensitivity: SensitivityLevel;
  confidence: number;
  provenanceRefs: string[];
  evidenceMemoryIds: string[];
  createdAt: string;
  updatedAt: string;
  neighbor: AdminContactSocialGraphNeighborView;
}

export interface AdminContactSocialGraphView {
  entity?: AdminContactSocialGraphEntityView;
  edgeCount: number;
  neighborCount: number;
  evidenceCount: number;
  provenanceCount: number;
  mentionOnlyNeighborCount: number;
  connections: AdminContactSocialGraphConnectionView[];
}

export interface AdminContactRelationshipScoreView {
  score: number;
  resolvedTier: string;
  previousTierThreshold?: number;
  nextTier?: string;
  nextTierThreshold?: number;
  progressToNextTier?: number;
  updatedAt?: string;
}

export interface AdminContactRelationshipScoreReader {
  listContactRelationshipScores(contactIds: readonly string[]): Promise<Map<string, AdminContactRelationshipScoreView>>;
}

export interface AdminContactsService {
  listContacts(params?: URLSearchParams): Promise<AdminContactListData>;
  getContactDetail(contactId: string): Promise<AdminContactDetailData | null>;
  updateContact(contactId: string, body: string): Promise<ContactUpdateResult>;
  createContact(body: string): Promise<ContactUpdateResult>;
  deleteContact(contactId: string): Promise<ContactUpdateResult>;
  mergeContacts(targetId: string, body: string): Promise<ContactUpdateResult>;
  unlinkChannelIdentity(contactId: string, body: string): Promise<ContactUpdateResult>;
  deleteConversationChannel(contactId: string, body: string): Promise<ContactUpdateResult>;
}
