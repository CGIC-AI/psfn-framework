import type { Pool } from 'pg';
import type {
  ContactStorePort,
  ContactTrustMutationOptions,
} from '../contact-store-port.js';
import type {
  ChannelPrivacyLevel,
  Contact,
  ContactChannel,
  ContactIdentityLinkResult,
  ContactIdentityLinkVerification,
  ContactMutationAuditEntry,
  SocialGraphEntity,
  SocialRelationshipEdgeQuery,
} from '../types.js';
import type { TrustLevel } from '../../../system/trust/types.js';
import type { EmotionalTimeSeriesPoint } from '../store/emotional-baseline.js';
import type {
  ContactIdentityVerificationRow,
  ContactRow,
  SocialGraphEntityRow,
  SocialRelationshipEdgeRow,
} from './rows.js';

export interface PostgresContactOperationContext extends ContactStorePort {
  readonly pool: Pool;
  readonly primaryUserId?: string;
  readonly exportDir: string | null;
  tableExists(tableName: string): Promise<boolean>;
  loadContactRow(id: string): Promise<ContactRow | undefined>;
  loadContactById(id: string): Promise<Contact | undefined>;
  loadContactEmotionalTimeSeries(id: string, limit?: number): Promise<EmotionalTimeSeriesPoint[]>;
  loadContactByChannelIdentity(channel: ContactChannel, channelUserId: string): Promise<Contact | undefined>;
  loadContactByRow(row: ContactRow): Promise<Contact>;
  touchContactLastSeen(id: string): Promise<void>;
  appendMutationAuditEntry(
    contactId: string,
    field: ContactMutationAuditEntry['field'],
    oldValue: string | null,
    newValue: string | null,
    actor?: string,
  ): Promise<void>;
  upsertIdentityLinkRecord(
    contactId: string,
    channel: string,
    channelUserId: string,
    firstSeen: string,
    lastSeen: string,
    privacyLevel?: ChannelPrivacyLevel,
  ): Promise<ContactIdentityLinkResult>;
  upsertSocialGraphEntityForContact(
    contact: Pick<Contact, 'id' | 'displayName' | 'firstSeen' | 'lastSeen'>,
  ): Promise<SocialGraphEntity>;
  loadSocialGraphEntityByRow(row: SocialGraphEntityRow | undefined): Promise<SocialGraphEntity | undefined>;
  loadSocialGraphEntityById(entityId: string): Promise<SocialGraphEntity | undefined>;
  loadSocialGraphEntityByContactId(contactId: string): Promise<SocialGraphEntity | undefined>;
  loadSocialRelationshipEdgeRows(
    query?: SocialRelationshipEdgeQuery,
  ): Promise<Array<SocialRelationshipEdgeRow & { source_sensitivity: string; target_sensitivity: string }>>;
  loadRelatedContactIds(contactId: string, query?: SocialRelationshipEdgeQuery): Promise<string[]>;
  appendPrimaryTrustAudit(
    contactId: string | undefined,
    previousTrustLevel: TrustLevel | null,
    source: 'upsert' | 'set_trust_level',
    outcome: 'allowed' | 'denied',
    actor?: string,
    details?: Record<string, unknown>,
  ): Promise<void>;
  isPrimaryTrustAssignmentAuthorized(
    contact: Contact | undefined,
    identities: Array<{ channel: string; userId: string }>,
    discordUserId: string | undefined,
    options?: ContactTrustMutationOptions,
  ): boolean;
  syncContactExports(): Promise<void>;
  toVerification(row: ContactIdentityVerificationRow): ContactIdentityLinkVerification;
  markIdentityLinkVerification(
    verificationId: string,
    status: ContactIdentityLinkVerification['status'],
    failureReason?: string,
    verifiedAt?: string,
  ): Promise<ContactIdentityLinkVerification | undefined>;
}

export type PostgresContactOperationMap =
  ThisType<PostgresContactOperationContext> & Record<string, (...args: any[]) => unknown>;

export interface PostgresContactStoreClass {
  prototype: PostgresContactOperationContext;
}
