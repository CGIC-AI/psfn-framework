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
import type { ContactProfileArtifact } from '../../../memory/store.js';
import type { PurrMemory } from '../../../memory/types.js';
import type { SessionEntry } from '../../../session/types.js';
import type { SubstrateConfig } from '../../../types.js';
import type {
  Contact,
  ContactIdentityLinkVerification,
  ContactMutationAuditEntry,
  ContactMutationAuditQuery,
} from '../../../contacts/types.js';
import type {
  CapabilityTierConfig,
} from '../../../config/capability-tier-config.js';
import type { ModelsRuntimeConfig } from '../../../config/models-config.js';
import type { SchedulerRuntimeConfig } from '../../../config/scheduler-config.js';
import type { SkillsRuntimeConfig } from '../../../config/skills-config.js';
import type { TrustPolicyConfig } from '../../../config/trust-policy-config.js';
import type {
  ChannelInfo,
  CompactionAuditView,
  DashboardStats,
  EnvInfo,
} from '../types.js';
import type { ContactConversationChannelView } from './contact-session-linker.js';
import type { IdentityIntakeReviewState } from '../templates/identity.js';

export interface AdminDashboardData {
  stats: DashboardStats;
}

export interface AdminDashboardService {
  getDashboardData(): AdminDashboardData;
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

export interface AdminMemoryService {
  listMemories(params?: URLSearchParams): AdminMemoryListData;
  getMemoryDetail(id: string): AdminMemoryDetailData | null;
  searchMemories(query: string): Promise<AdminMemorySearchResult>;
  supersedeMemory(id: string): MemoryMutationResult;
}

export interface AdminSessionListData {
  channels: ChannelInfo[];
}

export interface AdminSessionMessagesData {
  channelId: string;
  messages: SessionEntry[];
  compactionAuditViews: CompactionAuditView[];
}

export interface AdminSessionService {
  listSessions(): AdminSessionListData;
  getSessionMessages(channelId: string): AdminSessionMessagesData;
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

export interface AdminIdentityService {
  getIdentityData(): AdminIdentityData;
  importIdentityCard(body: string): Promise<ImportResult>;
  stageIdentityIntake(body: string): IntakeStageResult;
  commitIdentityIntake(body: string): Promise<IntakeCommitResult>;
  rollbackIdentityCard(body: string): RollbackResult;
  previewIdentityCardDiff(body: string): DiffPreviewResult;
  updateIdentityField(body: string): FieldUpdateResult;
}

export interface SettingsConfigEditors {
  models: ModelsRuntimeConfig;
  skills: SkillsRuntimeConfig;
  scheduler: SchedulerRuntimeConfig;
  trustPolicy: TrustPolicyConfig;
  capabilities: CapabilityTierConfig;
}

export interface AdminSettingsData {
  config: SubstrateConfig;
  env: EnvInfo;
  editors: SettingsConfigEditors;
}

export interface ConfigUpdateResult {
  ok: boolean;
  message: string;
}

export interface AdminSettingsService {
  getSettingsData(): Promise<AdminSettingsData>;
  updateSettings(body: string): ConfigUpdateResult;
  updateModelsConfig(body: string): ConfigUpdateResult;
  updateSkillsConfig(body: string): ConfigUpdateResult;
  updateSchedulerConfig(body: string): ConfigUpdateResult;
  updateTrustPolicyConfig(body: string): ConfigUpdateResult;
  updateCapabilitiesConfig(body: string): ConfigUpdateResult;
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
}

export interface AdminPromptListData {
  layers: PromptLayer[];
  staticPrompts: PromptRegistryEntry[];
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

export interface AdminPromptsService {
  listPrompts(): AdminPromptListData;
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
