import type {
  CharacterCardHistoryEntry,
  CharacterCardSnapshot,
} from '../../../identity/card-versioning.js';
import type { PromptLayerMetadataUpdate } from '../../../identity/prompt-store.js';
import type {
  PromptRegistryEntry,
  PromptRegistryHistoryEntry,
} from '../../../identity/prompt-registry.js';
import type { PromptHistoryEntry, PromptLayer } from '../../../identity/prompt-types.js';
import type { CharacterCardV2 } from '../../../identity/types.js';
import type { EditableSettings } from '../../../system/settings.js';
import type { ContactProfileArtifact, MemoryLink } from '../../../memory/store.js';
import type { PurrMemory } from '../../../memory/types.js';
import type { SessionEntry } from '../../../session/types.js';
import type { SubstrateConfig, TurnRecord } from '../../../types.js';
import type {
  Contact,
  ContactIdentityLinkVerification,
  ContactMutationAuditEntry,
  ContactMutationAuditQuery,
  RelationshipType,
  SocialGraphEntitySource,
  SocialRelationshipKind,
} from '../../../contacts/types.js';
import type { ChannelVisibility, SensitivityLevel, TrustLevel } from '../../../trust/types.js';
import type {
  CapabilityTierConfig,
} from '../../../system/config/capability-tier-config.js';
import type { SettingsContractData } from '../../../system/config/settings-contract.js';
import type { BackupJsonConfig } from '../../../system/config/backup-config.js';
import type { ModelsRuntimeConfig } from '../../../system/config/models-config.js';
import type { ProvidersRuntimeConfig } from '../../../system/config/providers-config.js';
import type { SchedulerRuntimeConfig } from '../../../system/config/scheduler-config.js';
import type { SkillsRuntimeConfig } from '../../../system/config/skills-config.js';
import type { TrustPolicyConfig } from '../../../system/config/trust-policy-config.js';
import type { NorthStarItem, NorthStarScope } from '../../../north-star/store.js';
import type {
  ChannelInfo,
  CompactionAuditView,
  DashboardCostWindow,
  DashboardStats,
  EnvInfo,
} from '../types.js';
import type { ContactConversationChannelView } from './contact-session-linker.js';
import type { IdentityIntakeReviewState } from '../identity-intake-types.js';
import type {
  AdaptiveToolDecisionTelemetry,
  AdaptiveToolRuntimeState,
  AdaptiveToolSnapshotTelemetry,
} from '../../../agent/adaptive-tools-telemetry.js';
import type { RuntimeToolCatalogSnapshot } from '../../../agent/tool-catalog.js';
import type {
  RuntimeServiceHealth,
  RuntimeServiceHealthStatus,
} from '../../../tool-health/types.js';
import type {
  ObservedMemory,
  ObservedScoredMemory,
  TurnMemorySnapshotRecord,
  TurnRetrievalTelemetryRecord,
  TurnSessionContextSnapshotRecord,
  TurnSnapshotRecord,
  TurnStageTelemetryRecord,
} from '../../../turns/observability.js';
import type { SessionRoleEnvelopePreview } from '../../../internal-role-envelopes/projections.js';
import type {
  AdminMemoryManagedScopeKind,
  AdminMemoryScopeEvidenceItem,
} from './memory-scope-evidence.js';

export interface AdminDashboardData {
  stats: DashboardStats;
}

export interface AdminDashboardService {
  getDashboardData(options?: { costWindow?: DashboardCostWindow }): AdminDashboardData;
}

export type AdminAdaptiveToolTelemetryEvent =
  | {
    type: 'decision';
    timestamp: number;
    payload: AdaptiveToolDecisionTelemetry;
  }
  | {
    type: 'snapshot';
    timestamp: number;
    payload: AdaptiveToolSnapshotTelemetry;
  };

export interface AdminToolFailureEvent {
  toolName: string;
  channelId: string;
  message: string;
  timestamp: number;
}

export interface AdminToolAvailabilityView {
  status: 'active' | 'available' | 'unavailable' | 'not_applicable';
  detail: string;
  source?: string;
}

export interface AdminToolHealthView {
  name: string;
  description: string;
  scope: 'core' | 'extended' | 'conditional';
  health: {
    status: RuntimeServiceHealthStatus;
    detail: string;
  };
  contexts: {
    chat: AdminToolAvailabilityView;
    internalHeartbeat: AdminToolAvailabilityView;
  };
  lastFailure?: AdminToolFailureEvent;
}

export interface AdminAdaptiveToolsData {
  state: AdaptiveToolRuntimeState | null;
  catalog: RuntimeToolCatalogSnapshot | null;
  serviceHealth: RuntimeServiceHealth[];
  toolHealth: AdminToolHealthView[];
  recentFailures: AdminToolFailureEvent[];
  recentTelemetry: AdminAdaptiveToolTelemetryEvent[];
}

export interface AdminAdaptiveToolsService {
  getAdaptiveToolsData(): Promise<AdminAdaptiveToolsData>;
}

export interface AdminMemoryContactSummary {
  id: string;
  displayName: string;
}

export interface AdminMemoryListData {
  memories: PurrMemory[];
  contactsById: Map<string, AdminMemoryContactSummary>;
  pagination: {
    limit: number;
    offset: number;
    total: number;
    hasPrevious: boolean;
    hasNext: boolean;
  };
}

export interface AdminMemoryDetailData {
  memory: PurrMemory;
  linkedContact?: AdminMemoryContactSummary;
  scopeAssignments: AdminMemoryScopeAssignmentView[];
  scopeRepair?: AdminMemoryScopeRepairView;
}

export interface AdminMemorySearchResult {
  query: string;
  results: PurrMemory[];
  contactsById: Map<string, AdminMemoryContactSummary>;
}

export interface MemoryMutationResult {
  ok: boolean;
  message?: string;
}

export interface AdminMemoryLinkResult {
  ok: boolean;
  link?: MemoryLink;
  message?: string;
}

export interface AdminBulkMutationResult {
  ok: boolean;
  count: number;
  message?: string;
}

export interface AdminMemoryScopeAssignmentView {
  kind: AdminMemoryManagedScopeKind;
  id: string;
  label?: string;
  canonicalTag: string;
  evidence: AdminMemoryScopeEvidenceItem[];
}

export interface AdminMemoryScopeRepairView {
  needsRepair: boolean;
  suggestedScopeRef?: {
    kind: string;
    id: string;
    label?: string;
  };
  suggestedScopeTags: string[];
  notes: string[];
}

export interface AdminMemoryScopeSummary {
  kind: AdminMemoryManagedScopeKind;
  id: string;
  label?: string;
  canonicalTag: string;
  memoryCount: number;
  needsRepairCount: number;
}

export interface AdminMemoryScopedMemoryView {
  memory: PurrMemory;
  evidence: AdminMemoryScopeEvidenceItem[];
  repair: AdminMemoryScopeRepairView;
}

export interface AdminMemoryScopeListData {
  scopes: AdminMemoryScopeSummary[];
}

export interface AdminMemoryScopeDetailData {
  scope: AdminMemoryScopeSummary;
  memories: AdminMemoryScopedMemoryView[];
}

export interface AdminMemoryScopeMutationResult extends MemoryMutationResult {
  memory?: AdminMemoryDetailData['memory'];
  scopeAssignments?: AdminMemoryScopeAssignmentView[];
  scopeRepair?: AdminMemoryScopeRepairView;
}

export interface AdminMemoryService {
  listMemories(params?: URLSearchParams): AdminMemoryListData;
  getMemoryDetail(id: string): AdminMemoryDetailData | null;
  listManagedScopes(params?: URLSearchParams): AdminMemoryScopeListData;
  getManagedScopeDetail(kind: string, id: string): AdminMemoryScopeDetailData | null;
  searchMemories(query: string): Promise<AdminMemorySearchResult>;
  supersedeMemory(id: string): MemoryMutationResult;
  updateMemoryScope(
    id: string,
    fields: {
      scopeRef?: { kind?: string; id?: string; label?: string } | null;
      scopeTags?: string[];
      repair?: boolean;
    },
  ): AdminMemoryScopeMutationResult;
  linkMemories(id1: string, id2: string, linkType?: string): AdminMemoryLinkResult;
  unlinkMemories(id1: string, id2: string): MemoryMutationResult;
  getMemoryLinks(id: string): MemoryLink[];
  bulkDelete(ids: string[]): AdminBulkMutationResult;
  bulkUpdate(ids: string[], fields: { memoryType?: string; sensitivity?: string }): AdminBulkMutationResult;
}

export interface AdminSessionListData {
  channels: ChannelInfo[];
}

export interface AdminSessionMessagesData {
  sessionId: string;
  channelId: string;
  messages: SessionEntry[];
  roleEnvelopePreviews: AdminSessionRoleEnvelopePreview[];
  compactionAuditViews: CompactionAuditView[];
  turns: AdminSessionTurnData[];
}

export interface AdminSessionService {
  listSessions(): AdminSessionListData;
  getSessionMessages(sessionId: string): AdminSessionMessagesData;
}

export type AdminObservedMemory = ObservedMemory;

export type AdminObservedScoredMemory = ObservedScoredMemory;

export type AdminTurnStageTelemetry = TurnStageTelemetryRecord;

export type AdminTurnRetrievalTelemetry = TurnRetrievalTelemetryRecord;

export type AdminTurnSessionContextSnapshotData = TurnSessionContextSnapshotRecord;

export type AdminTurnMemorySnapshotData = TurnMemorySnapshotRecord;

export type AdminTurnSnapshotData = TurnSnapshotRecord;

export interface AdminSessionRoleEnvelopePreview {
  sessionEntryId: number;
  preview: SessionRoleEnvelopePreview;
}

export interface AdminContinuityProvenanceView {
  sessionEntryId: number;
  turnId: string;
  continuityUserId: string;
  sourceChannelId: string;
  sourceVisibility: ChannelVisibility;
  currentChannelId: string;
  currentVisibility: ChannelVisibility;
  carriedAcrossChannels: boolean;
}

export interface AdminSessionTurnData {
  record: TurnRecord;
  roleEnvelopeRefs: string[];
  continuityProvenance: AdminContinuityProvenanceView[];
  stages: AdminTurnStageTelemetry[];
  retrievals: AdminTurnRetrievalTelemetry[];
  snapshot: AdminTurnSnapshotData | null;
}

export interface AdminIdentityData {
  card: CharacterCardV2;
  config: SubstrateConfig;
  version: number;
  checksum?: string;
  history: CharacterCardHistoryEntry[];
  intakeReview: IdentityIntakeReviewState | null;
}

export interface ImportResult {
  ok: boolean;
  message: string;
}

export interface IntakeStageResult {
  ok: boolean;
  message: string;
  review?: IdentityIntakeReviewState | null;
}

export interface IntakeCommitResult {
  ok: boolean;
  message: string;
  review?: IdentityIntakeReviewState | null;
}

export interface RollbackResult {
  ok: boolean;
  message: string;
  snapshot?: CharacterCardSnapshot;
}

export interface DiffPreviewResult {
  ok: boolean;
  current: CharacterCardV2;
  target: CharacterCardV2;
}

export interface FieldUpdateResult {
  ok: boolean;
  message: string;
}

export interface OnboardingActionResult {
  ok: boolean;
  message: string;
  onboardingRequired: boolean;
  action?: 'keep_starter' | 'edit_identity';
  updatedFields?: string[];
}

export interface AdminIdentityService {
  getIdentityData(): AdminIdentityData;
  importIdentityCard(body: string): Promise<ImportResult>;
  stageIdentityIntake(body: string): IntakeStageResult;
  commitIdentityIntake(body: string): Promise<IntakeCommitResult>;
  rollbackIdentityCard(body: string): RollbackResult;
  previewIdentityCardDiff(body: string): DiffPreviewResult;
  updateIdentityField(body: string): FieldUpdateResult;
  applyOnboardingAction(body: string): Promise<OnboardingActionResult>;
}

export interface SettingsConfigEditors {
  models: ModelsRuntimeConfig;
  providers: ProvidersRuntimeConfig;
  skills: SkillsRuntimeConfig;
  scheduler: SchedulerRuntimeConfig;
  trustPolicy: TrustPolicyConfig;
  capabilities: CapabilityTierConfig;
  backup: BackupJsonConfig;
}

export interface AdminVoiceProviderOption {
  id: string;
  configured: boolean;
  requiredTokens: string[];
}

export interface AdminVoiceProviderData {
  stt: AdminVoiceProviderOption[];
  tts: AdminVoiceProviderOption[];
}

export interface AdminSettingsData {
  config: EditableSettings;
  env: EnvInfo;
  editors: SettingsConfigEditors;
  voiceProviders: AdminVoiceProviderData;
}

export interface SettingsValidationError {
  field: string;
  message: string;
  code?: string;
}

export interface ConfigUpdateResult {
  ok: boolean;
  message: string;
  validationErrors?: SettingsValidationError[];
}

export interface AdminSettingsService {
  getSettingsData(): Promise<AdminSettingsData>;
  getSettingsContractData(): SettingsContractData;
  updateSettings(body: string): ConfigUpdateResult;
  getSubConfigJson(key: string): string | null;
  saveSubConfigJson(key: string, json: string): ConfigUpdateResult;
}

export interface AdminContactListData {
  contacts: Contact[];
  profileMap: Map<string, ContactProfileArtifact>;
  relatedChannelMap: Map<string, ContactConversationChannelView[]>;
  socialGraphMap: Map<string, AdminContactSocialGraphView>;
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

export interface AdminContactsService {
  listContacts(params?: URLSearchParams): AdminContactListData;
  getContactDetail(contactId: string): AdminContactDetailData | null;
  updateContact(contactId: string, body: string): ContactUpdateResult;
  createContact(body: string): ContactUpdateResult;
  deleteContact(contactId: string): ContactUpdateResult;
  mergeContacts(targetId: string, body: string): ContactUpdateResult;
  unlinkChannelIdentity(contactId: string, body: string): ContactUpdateResult;
}

export interface AdminPromptListData {
  layers: PromptLayer[];
  staticPrompts: PromptRegistryEntry[];
}

export interface AdminConstitutionImmutableBlock {
  id: string;
  title: string;
  content: string;
  editable: false;
}

export interface AdminConstitutionCompanionLayer {
  id: string;
  title: string;
  content: string;
  provenanceRefs: string[];
  historyVersions: number[];
  entryIds: string[];
  editable: false;
}

export interface AdminConstitutionMutableLayer extends PromptLayer {
  editable: boolean;
  readOnlyReason?: string;
}

export interface AdminFoundationSection {
  id: string;
  title: string;
  content: string;
  enabled: boolean;
  defaultEnabled: boolean;
}

export interface AdminFoundationPreview {
  text: string;
  hash: string;
}

export interface AdminFoundationSnapshotData {
  layerId: string;
  layerName: string;
  sections: AdminFoundationSection[];
  preview: AdminFoundationPreview;
}

export interface AdminConstitutionPreview {
  text: string;
  hash: string;
  staticPrefix: string;
  dynamicSuffix: string;
}

export interface AdminConstitutionSnapshotData {
  immutableBlocks: AdminConstitutionImmutableBlock[];
  companionLayer: AdminConstitutionCompanionLayer | null;
  mutableLayers: AdminConstitutionMutableLayer[];
  preview: AdminConstitutionPreview;
}

export interface AdminNorthStarItem extends NorthStarItem {
  scope: NorthStarScope;
}

export interface AdminNorthStarPreview {
  text: string;
  hash: string;
}

export interface AdminNorthStarSnapshotData {
  items: AdminNorthStarItem[];
  limit: number;
  preview: AdminNorthStarPreview;
}

export interface AdminPromptDetailData {
  layer?: PromptLayer;
  layerHistory?: PromptHistoryEntry[];
  staticPrompt?: PromptRegistryEntry;
  staticPromptHistory?: PromptRegistryHistoryEntry[];
}

export interface PromptUpdateResult {
  ok: boolean;
  message: string;
  layer?: PromptLayer;
  staticPrompt?: PromptRegistryEntry;
}

export interface ConstitutionUpdateResult {
  ok: boolean;
  message: string;
  snapshot?: AdminConstitutionSnapshotData;
}

export interface FoundationUpdateResult {
  ok: boolean;
  message: string;
  snapshot?: AdminFoundationSnapshotData;
}

export interface NorthStarUpdateResult {
  ok: boolean;
  message: string;
  snapshot?: AdminNorthStarSnapshotData;
}

export interface AdminPromptsService {
  listPrompts(): AdminPromptListData;
  getFoundationSnapshot(): AdminFoundationSnapshotData | null;
  saveFoundationSections(body: string): FoundationUpdateResult;
  getConstitutionSnapshot(): AdminConstitutionSnapshotData | null;
  saveConstitutionMutableLayers(body: string): ConstitutionUpdateResult;
  getNorthStarSnapshot(): AdminNorthStarSnapshotData | null;
  saveNorthStarItems(body: string): NorthStarUpdateResult;
  getPromptDetail(layerId: string): AdminPromptDetailData | null;
  getStaticPromptDetail(key: string): AdminPromptDetailData | null;
  createPromptLayer(body: string): PromptUpdateResult;
  updatePromptLayer(body: string): PromptUpdateResult;
  updatePromptRegistry(body: string): PromptUpdateResult;
  togglePromptLayer(body: string): PromptUpdateResult;
  rollbackPromptLayer(body: string): PromptUpdateResult;
  rollbackPromptRegistry(body: string): PromptUpdateResult;
  previewPromptLayerDiff(body: string): { oldContent: string; newContent: string } | null;
  resolvePromptLayerMetadata(params: URLSearchParams): { metadata: PromptLayerMetadataUpdate } | { error: string };
}
