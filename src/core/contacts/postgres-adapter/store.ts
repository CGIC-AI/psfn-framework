import type { Pool, PoolClient } from 'pg';
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
  ContactRow,
  SocialGraphEntityRow,
  SocialRelationshipEdgeRow,
} from './rows.js';
import { normalizeTrimmed } from './mapping.js';
import { installPostgresContactCrudOperations } from './crud-operations.js';
import { installPostgresContactSharedOperations } from './shared-queries.js';
import { installPostgresContactSocialGraphOperations } from './social-graph-queries.js';
import { installPostgresContactTrustPolicyOperations } from './trust-policy-queries.js';
import { installPostgresContactLifecycleLedgerOperations } from './contact-lifecycle-ledger-operations.js';
import { installPostgresContactLifecycleRecoveryOperations } from './contact-lifecycle-recovery.js';
import type { ContactLifecycleGatewayPort } from '../contact-lifecycle-gateway-port.js';
import { installPostgresContactLifecycleCoordinatorOperations } from './contact-lifecycle-coordinator.js';
import { installPostgresContactLifecycleMutationCommitOperations } from './contact-lifecycle-mutation-commit.js';
import type { ContactLifecycleFaultStage } from './options.js';

export class PostgresContactStore implements ContactStorePort {
  readonly pool: Pool;
  readonly primaryUserId?: string;
  readonly exportDir: string | null;
  readonly contactLifecycleGateway: ContactLifecycleGatewayPort | null;
  readonly contactLifecycleFaultInjection: ((
    stage: ContactLifecycleFaultStage,
    request: import('../../../shared/contracts/contact-authority-lifecycle.js').ContactAuthorityLifecycleRequest,
  ) => Promise<void> | void) | null;

  declare prepareContactLifecycleIntent: ContactStorePort['prepareContactLifecycleIntent'];
  declare recordContactLifecycleGatewayResult: ContactStorePort['recordContactLifecycleGatewayResult'];
  declare claimContactLifecycleRecovery: ContactStorePort['claimContactLifecycleRecovery'];
  declare deferContactLifecycleRecovery: ContactStorePort['deferContactLifecycleRecovery'];
  declare assertContactLifecycleLedgerHealthy: ContactStorePort['assertContactLifecycleLedgerHealthy'];
  declare recoverContactLifecycleMutations: ContactStorePort['recoverContactLifecycleMutations'];
  declare getContactLifecycleDiagnostics: ContactStorePort['getContactLifecycleDiagnostics'];
  declare upsert: ContactStorePort['upsert'];
  declare getById: ContactStorePort['getById'];
  declare getByDiscordUserId: ContactStorePort['getByDiscordUserId'];
  declare getByChannelIdentity: ContactStorePort['getByChannelIdentity'];
  declare getByTrustLevel: ContactStorePort['getByTrustLevel'];
  declare getSocialGraphEntityById: ContactStorePort['getSocialGraphEntityById'];
  declare getSocialGraphEntityByContactId: ContactStorePort['getSocialGraphEntityByContactId'];
  declare listSocialGraphEntities: ContactStorePort['listSocialGraphEntities'];
  declare upsertSocialGraphEntity: ContactStorePort['upsertSocialGraphEntity'];
  declare upsertSocialRelationshipEdge: ContactStorePort['upsertSocialRelationshipEdge'];
  declare listSocialRelationshipEdges: ContactStorePort['listSocialRelationshipEdges'];
  declare listRelatedContacts: ContactStorePort['listRelatedContacts'];
  declare suggestLowTierTrustDrift: ContactStorePort['suggestLowTierTrustDrift'];
  declare applyLowTierTrustDriftSuggestion: ContactStorePort['applyLowTierTrustDriftSuggestion'];
  declare setTrustLevel: ContactStorePort['setTrustLevel'];
  declare setMachineIntelligence: ContactStorePort['setMachineIntelligence'];
  declare markMachineIntelligenceFromObservation: ContactStorePort['markMachineIntelligenceFromObservation'];
  declare updateLastSeen: ContactStorePort['updateLastSeen'];
  declare updateIdentityProfile: ContactStorePort['updateIdentityProfile'];
  declare recordChannelActivity: ContactStorePort['recordChannelActivity'];
  declare listKnownRooms: ContactStorePort['listKnownRooms'];
  declare countKnownRooms: ContactStorePort['countKnownRooms'];
  declare listRoomRoster: ContactStorePort['listRoomRoster'];
  declare countRoomRoster: ContactStorePort['countRoomRoster'];
  declare mergeContacts: ContactStorePort['mergeContacts'];
  declare updateNotes: ContactStorePort['updateNotes'];
  declare updateEmotionalBaseline: ContactStorePort['updateEmotionalBaseline'];
  declare getEmotionalSnapshot: ContactStorePort['getEmotionalSnapshot'];
  declare getEmotionalTimeSeries: ContactStorePort['getEmotionalTimeSeries'];
  declare updateRelationshipType: ContactStorePort['updateRelationshipType'];
  declare compareAndSetRelationshipType: ContactStorePort['compareAndSetRelationshipType'];
  declare setChannelPrivacy: ContactStorePort['setChannelPrivacy'];
  declare setConversationChannelPrivacy: ContactStorePort['setConversationChannelPrivacy'];
  declare getConversationChannelPrivacy: ContactStorePort['getConversationChannelPrivacy'];
  declare deleteConversationChannel: ContactStorePort['deleteConversationChannel'];
  declare createIdentityLinkChallenge: ContactStorePort['createIdentityLinkChallenge'];
  declare verifyIdentityLinkChallenge: ContactStorePort['verifyIdentityLinkChallenge'];
  declare linkChannelIdentity: ContactStorePort['linkChannelIdentity'];
  declare listAll: ContactStorePort['listAll'];
  declare listIdentityLinkVerifications: ContactStorePort['listIdentityLinkVerifications'];
  declare countVerifiedIdentityLinks: ContactStorePort['countVerifiedIdentityLinks'];
  declare getContactMaintenanceWatermark: ContactStorePort['getContactMaintenanceWatermark'];
  declare setContactMaintenanceWatermark: ContactStorePort['setContactMaintenanceWatermark'];
  declare listMutationAuditEntries: ContactStorePort['listMutationAuditEntries'];
  declare resolveChannelIdentity: ContactStorePort['resolveChannelIdentity'];
  declare resolveUserId: ContactStorePort['resolveUserId'];
  declare getCanonicalContactKey: ContactStorePort['getCanonicalContactKey'];
  declare deleteContact: ContactStorePort['deleteContact'];
  declare unlinkChannelIdentity: ContactStorePort['unlinkChannelIdentity'];
  declare reapproveRestoredDiscordIdentity: ContactStorePort['reapproveRestoredDiscordIdentity'];

  declare mergeContactsDirect: (sourceContactId: string, targetContactId: string, lifecycleIntentId?: string, recoveryLeaseOwner?: string) => Promise<boolean>;
  declare deleteContactDirect: (id: string, lifecycleIntentId?: string, recoveryLeaseOwner?: string) => Promise<boolean>;
  declare unlinkChannelIdentityDirect: (contactId: string, channel: string, channelUserId: string, actor?: string, lifecycleIntentId?: string, recoveryLeaseOwner?: string) => Promise<boolean>;
  declare commitVerifiedDiscordIdentity: (verificationId: string, lifecycleIntentId: string, recoveryLeaseOwner?: string) => Promise<number>;
  declare commitReapprovedDiscordIdentity: (lifecycleIntentId: string, recoveryLeaseOwner?: string) => Promise<number>;
  declare verifyDiscordIdentityLifecycle: (row: import('./rows.js').ContactIdentityVerificationRow, privacyLevel?: ChannelPrivacyLevel) => Promise<import('../types.js').ContactIdentityLinkVerificationResult>;
  declare suspendVerifiedDiscordIdentityConflict: (contactId: string, providerSubjectId: string, discriminator: string) => Promise<void>;
  declare resumeContactLifecycleIntent: (request: Extract<import('../../../shared/contracts/contact-authority-lifecycle.js').ContactAuthorityLifecycleRequest, { phase: 'prepare' }>) => Promise<import('../../../shared/contracts/contact-lifecycle-ledger.js').ContactLifecyclePrepareOutcome>;

  declare tableExists: (tableName: string) => Promise<boolean>;
  declare loadContactRow: (id: string) => Promise<ContactRow | undefined>;
  declare loadContactById: (id: string) => Promise<Contact | undefined>;
  declare loadContactEmotionalTimeSeries: (id: string, limit?: number) => Promise<EmotionalTimeSeriesPoint[]>;
  declare loadContactByChannelIdentity: (channel: ContactChannel, channelUserId: string) => Promise<Contact | undefined>;
  declare loadContactByRow: (row: ContactRow) => Promise<Contact>;
  declare touchContactLastSeen: (id: string) => Promise<void>;
  declare appendMutationAuditEntry: (contactId: string, field: ContactMutationAuditEntry['field'], oldValue: string | null, newValue: string | null, actor?: string, queryable?: Pool | PoolClient) => Promise<void>;
  declare upsertIdentityLinkRecord: (contactId: string, channel: string, channelUserId: string, firstSeen: string, lastSeen: string, privacyLevel?: ChannelPrivacyLevel) => Promise<ContactIdentityLinkResult>;
  declare upsertSocialGraphEntityForContact: (contact: Pick<Contact, 'id' | 'displayName' | 'firstSeen' | 'lastSeen'>) => Promise<SocialGraphEntity>;
  declare loadSocialGraphEntityByRow: (row: SocialGraphEntityRow | undefined) => Promise<SocialGraphEntity | undefined>;
  declare loadSocialGraphEntityById: (entityId: string) => Promise<SocialGraphEntity | undefined>;
  declare loadSocialGraphEntityByContactId: (contactId: string) => Promise<SocialGraphEntity | undefined>;
  declare loadSocialRelationshipEdgeRows: (query?: SocialRelationshipEdgeQuery) => Promise<Array<SocialRelationshipEdgeRow & { source_sensitivity: string; target_sensitivity: string }>>;
  declare loadRelatedContactIds: (contactId: string, query?: SocialRelationshipEdgeQuery) => Promise<string[]>;
  declare appendPrimaryTrustAudit: (contactId: string | undefined, previousTrustLevel: TrustLevel | null, source: 'upsert' | 'set_trust_level', outcome: 'allowed' | 'denied', actor?: string, details?: Record<string, unknown>, queryable?: Pool | PoolClient) => Promise<void>;
  declare isPrimaryTrustAssignmentAuthorized: (contact: Contact | undefined, identities: Array<{ channel: string; userId: string }>, discordUserId: string | undefined, options?: ContactTrustMutationOptions) => boolean;
  declare syncContactExports: () => Promise<void>;
  declare toVerification: (row: import('./rows.js').ContactIdentityVerificationRow) => ContactIdentityLinkVerification;
  declare markIdentityLinkVerification: (verificationId: string, status: ContactIdentityLinkVerification['status'], failureReason?: string, verifiedAt?: string) => Promise<ContactIdentityLinkVerification | undefined>;

  constructor(
    pool: Pool,
    primaryUserId?: string,
    exportDir?: string,
    contactLifecycleGateway?: ContactLifecycleGatewayPort,
    contactLifecycleFaultInjection?: PostgresContactStore['contactLifecycleFaultInjection'],
  ) {
    this.pool = pool;
    this.primaryUserId = normalizeTrimmed(primaryUserId);
    this.exportDir = normalizeTrimmed(exportDir) ?? null;
    this.contactLifecycleGateway = contactLifecycleGateway ?? null;
    this.contactLifecycleFaultInjection = contactLifecycleFaultInjection ?? null;
  }
}

installPostgresContactSharedOperations(PostgresContactStore);
installPostgresContactSocialGraphOperations(PostgresContactStore);
installPostgresContactTrustPolicyOperations(PostgresContactStore);
installPostgresContactCrudOperations(PostgresContactStore);
installPostgresContactLifecycleLedgerOperations(PostgresContactStore);
installPostgresContactLifecycleRecoveryOperations(PostgresContactStore);
installPostgresContactLifecycleMutationCommitOperations(PostgresContactStore);
installPostgresContactLifecycleCoordinatorOperations(PostgresContactStore);
