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
import type { EditableSettings } from '../../../settings.js';
import type { MemoryLink } from '../../../memory/store.js';
import type { PurrMemory } from '../../../memory/types.js';
import type { SessionEntry } from '../../../session/types.js';
import type { SubstrateConfig, TurnRecord } from '../../../types.js';
import type {
  Contact,
  ContactIdentityLinkVerification,
  ContactMutationAuditEntry,
  ContactMutationAuditQuery,
} from '../../../contacts/types.js';
import type {
  CapabilityTierConfig,
} from '../../../config/capability-tier-config.js';
import type { SettingsContractData } from '../../../config/settings-contract.js';
import type { BackupJsonConfig } from '../../../config/backup-config.js';
import type { ModelsRuntimeConfig } from '../../../config/models-config.js';
import type { SchedulerRuntimeConfig } from '../../../config/scheduler-config.js';
import type { SkillsRuntimeConfig } from '../../../config/skills-config.js';
import type { TrustPolicyConfig } from '../../../config/trust-policy-config.js';
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

export interface AdminMemoryService {
  listMemories(params?: URLSearchParams): AdminMemoryListData;
  getMemoryDetail(id: string): AdminMemoryDetailData | null;
  searchMemories(query: string): Promise<AdminMemorySearchResult>;
  supersedeMemory(id: string): MemoryMutationResult;
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

export interface AdminSessionTurnData {
  record: TurnRecord;
  roleEnvelopeRefs: string[];
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

export interface AdminPromptsService {
  listPrompts(): AdminPromptListData;
  getConstitutionSnapshot(): AdminConstitutionSnapshotData | null;
  saveConstitutionMutableLayers(body: string): ConstitutionUpdateResult;
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
