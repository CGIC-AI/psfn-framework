import type {
  ConfirmationDecision as CanonicalConfirmationDecision,
  ConfirmationQueueEntry as CanonicalConfirmationQueueEntry,
  ConfirmationResolveResult as CanonicalConfirmationResolveResult,
} from '../../../../src/boundary/gateway/protocol.js';
import type {
  PurrMemory as CanonicalPurrMemory,
  MemoryScopeRef as CanonicalMemoryScopeRef,
} from '../../../../src/faculties/memory/types.js';
import type { ReflectionTemplate as CanonicalReflectionTemplate } from '../../../../src/core/scheduler/heartbeat-policy.js';
import type {
  RecurringCadence as CanonicalRecurringCadence,
  ScheduledTask as CanonicalScheduledTask,
  TaskState as CanonicalTaskState,
  TaskType as CanonicalTaskType,
} from '../../../../src/core/scheduler/types.js';
import type {
  PromptRegistryEntry as CanonicalPromptRegistryEntry,
  PromptRegistryHistoryEntry as CanonicalPromptRegistryHistoryEntry,
} from '../../../../src/core/identity/prompt-registry.js';
import type {
  PromptRuntimeBlockId,
  PromptRuntimeBlockPlacement,
  PromptRuntimeBlockSchemaClassification,
  PromptRuntimeBlockVisibility,
  PromptRuntimeEditableBlockId,
  PromptRuntimeMacroHint as CanonicalPromptRuntimeMacroHint,
} from '../../../../src/core/identity/prompt-runtime.js';
import type { PromptLayer, PromptHistoryEntry } from '../../../../src/core/identity/prompt-types.js';
import type { RuntimePromptLayerSchemaClassification } from '../../../../src/core/identity/runtime-prompt-layers.js';
import type { NorthStarItem as CanonicalNorthStarItem } from '../../../../src/faculties/north-star/store.js';
import type { SkillEntry as CanonicalSkillEntry, SkillSnapshot as CanonicalSkillSnapshot, SkillSkipRecord as CanonicalSkillSkipRecord } from '../../../../src/faculties/skills/types.js';
import type { ValuesJournalEntry as CanonicalValuesJournalEntry } from '../../../../src/faculties/values/store.js';
import type {
  AdminChatBootstrapResponse as CanonicalAdminChatBootstrapResponse,
  AdminModelRoomBootstrapResponse as CanonicalAdminModelRoomBootstrapResponse,
  AdminModelRoomParticipant as CanonicalAdminModelRoomParticipant,
} from '../../../../src/operator/garden/chat/types.js';
import type {
  AdminDashboardData as CanonicalAdminDashboardData,
  AdminPromptDetailData as CanonicalAdminPromptDetailData,
  AdminPromptListData as CanonicalAdminPromptListData,
  AdminSessionListData as CanonicalAdminSessionListData,
  AdminSessionMessagesData as CanonicalAdminSessionMessagesData,
  AdminSessionTurnData as CanonicalAdminSessionTurnData,
  AdminSettingsData as CanonicalAdminSettingsData,
  ConfigUpdateResult as CanonicalConfigUpdateResult,
  ConstitutionUpdateResult as CanonicalConstitutionUpdateResult,
  FoundationUpdateResult as CanonicalFoundationUpdateResult,
  NorthStarUpdateResult as CanonicalNorthStarUpdateResult,
  PromptUpdateResult as CanonicalPromptUpdateResult,
  RuntimePromptUpdateResult as CanonicalRuntimePromptUpdateResult,
  SettingsConfigEditors as CanonicalSettingsConfigEditors,
  SettingsValidationError as CanonicalSettingsValidationError,
} from '../../../../src/operator/garden/services/types.js';
import type {
  SettingsContractData as CanonicalSettingsContractData,
  SettingsContractField as CanonicalSettingsContractField,
  SettingsContractSubsystem as CanonicalSettingsContractSubsystem,
} from '../../../../src/system/config/settings-contract.js';

export type {
  CredentialReference,
  EnvCredentialReference,
} from '../../../../src/boundary/custody/credential-vault.js';
export type {
  DashboardCostWindow,
  DashboardCostWindowTotals,
  DashboardCostWindowUsage,
  DashboardSessionContextPressure,
  DashboardStats,
  ThinkTraceStepView,
  ThinkTraceView,
} from '../../../../src/operator/garden/types.js';
export type {
  CanonicalProviderRegistry,
  CanonicalProviderType,
  ProviderRegistryEntry,
} from '../../../../src/shared/contracts/runtime.js';

// Dashboard
export type AdminDashboardData = CanonicalAdminDashboardData;

// Memory -- backend-owned with UI compatibility overlays for legacy wire shapes.
export type PurrMemory = Omit<CanonicalPurrMemory, 'type' | 'scopeRef' | 'sensitivity'> & {
  type: CanonicalPurrMemory['type'] | string;
  scopeRef?: MemoryScopeRef;
  sensitivity?: CanonicalPurrMemory['sensitivity'] | string;
  content?: string;
  createdAt?: number;
  updatedAt?: number;
  emotionalWeight?: number;
  supersededAt?: number;
};

export type MemoryScopeRef = Omit<CanonicalMemoryScopeRef, 'kind'> & {
  kind: CanonicalMemoryScopeRef['kind'] | string;
};

export interface AdminMemoryContactSummary {
  id: string;
  displayName: string;
}

export interface AdminMemoryListData {
  memories: PurrMemory[];
  contactsById: Record<string, AdminMemoryContactSummary>;
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
  contactsById: Record<string, AdminMemoryContactSummary>;
}

export interface AdminMemoryLink {
  id1: string;
  id2: string;
  linkType: string;
  linkedAt: number;
}

export interface AdminMemoryLinkResult {
  ok: boolean;
  message?: string;
  link?: AdminMemoryLink;
}

export interface AdminBulkMutationResult {
  ok: boolean;
  count: number;
  message?: string;
}

export interface AdminMemoryScopeEvidenceItem {
  type: string;
  value: string;
  detail: string;
}

export interface AdminMemoryScopeAssignmentView {
  kind: 'project' | 'north_star';
  id: string;
  label?: string;
  canonicalTag: string;
  evidence: AdminMemoryScopeEvidenceItem[];
}

export interface AdminMemoryScopeRepairView {
  needsRepair: boolean;
  suggestedScopeRef?: MemoryScopeRef;
  suggestedScopeTags: string[];
  notes: string[];
}

export interface AdminMemoryScopeSummary {
  kind: 'project' | 'north_star';
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

export interface AdminMemoryScopeMutationResult {
  ok: boolean;
  message?: string;
  memory?: PurrMemory;
  scopeAssignments?: AdminMemoryScopeAssignmentView[];
  scopeRepair?: AdminMemoryScopeRepairView;
}

// Sessions
export type ChannelInfo = CanonicalAdminSessionListData['channels'][number];

export interface SessionEntry {
  role: string;
  content: string;
  authorName?: string;
  authorId?: string;
  timestamp?: string;
  toolCalls?: unknown[];
  originChannelId?: string;
  channelVisibility?: string;
}

export type CompactionAuditView = CanonicalAdminSessionMessagesData['compactionAuditViews'][number];

export type AdminSessionListData = CanonicalAdminSessionListData;

export type AdminTurnStageTelemetry = CanonicalAdminSessionTurnData['stages'][number];

export type AdminTurnRetrievalTelemetry = CanonicalAdminSessionTurnData['retrievals'][number];

export interface MemoryWithheldSummary {
  totalCount: number;
  reasonCounts: Record<string, number>;
}

export interface AdminObservedMemory {
  id: string;
  text: string;
  type: string;
  importance: number;
  confidence: number;
  emotionalValence: number;
  formationVAD?: Record<string, number>;
  salience: number;
  sourceRef: string;
  extractedAt: number;
  lastAccessed: number;
  accessCount: number;
  supersededBy?: string;
  tags: string[];
  provenanceRefs?: string[];
  retentionClass?: string;
  sensitivity: string;
  consentFlags?: Record<string, boolean>;
  contactId?: string;
  deletedAt?: number;
  deletedBy?: string;
  deleteReason?: string;
}

export interface AdminObservedScoredMemory extends AdminObservedMemory {
  similarity: number;
}

export interface AdminTurnPromptSnapshotData {
  staticPrefixTemplate: string;
  dynamicSuffixTemplate: string;
  staticHash: string;
  versionPointer: string;
}

export interface AdminTurnPromptContextMessage {
  role: string;
  content: string;
}

export type AdminPromptSectionCacheabilityClass =
  | 'static'
  | 'session_stable'
  | 'append_only'
  | 'volatile';

export type AdminPromptSectionCacheBreaker =
  | 'prompt_layer'
  | 'runtime'
  | 'channel'
  | 'task'
  | 'macro'
  | 'tool'
  | 'retrieval'
  | 'scratchpad'
  | 'session_history';

export interface AdminPromptSectionCacheability {
  section:
    | 'staticPrefixTemplate'
    | 'dynamicSuffixTemplate'
    | 'renderedStaticPrefix'
    | 'renderedDynamicSuffix'
    | 'runtimeContext'
    | 'memoryContextBlock'
    | 'scratchpadContext'
    | 'assembledPrompt'
    | 'finalSystemPrompt'
    | 'messages';
  cacheability: AdminPromptSectionCacheabilityClass;
  cacheBreakers: AdminPromptSectionCacheBreaker[];
  reason: string;
}

export interface AdminPromptSectionTelemetry {
  id: string;
  title: string;
  content: string;
  charCount: number;
  tokenCount: number;
}

export interface AdminTurnProviderWireMessage {
  role: string;
  source: string;
  content: string;
}

export interface AdminTurnProviderSystemRoleData {
  transport: string;
  supportsSystemRole: boolean;
  supportsDeveloperRole: boolean;
  usesOutOfBandSystemPrompt: boolean;
}

export interface AdminTurnProviderObservabilityData {
  routeKind: string;
  requestedProvider: string;
  requestedModel: string;
  backendProvider: string;
  backendModel: string;
  backendApi: string;
  backendBaseUrl?: string;
  systemRole: AdminTurnProviderSystemRoleData;
  providerWireMessages: AdminTurnProviderWireMessage[];
}

export interface AdminTurnPromptResponseSnapshotData {
  content: string;
  reasoning?: string;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  toolCallCount?: number;
}

export interface AdminTurnPromptContextSnapshotData {
  renderedStaticPrefix: string;
  renderedDynamicSuffix: string;
  runtimeContext: string;
  memoryContextBlock: string;
  scratchpadContext: string;
  assembledPrompt: string;
  finalSystemPrompt: string;
  messages: AdminTurnPromptContextMessage[];
  currentTurnInput?: string;
  providerObservability?: AdminTurnProviderObservabilityData;
  response?: AdminTurnPromptResponseSnapshotData;
  inputSections?: AdminPromptSectionTelemetry[];
  runtimeContextSections?: AdminPromptSectionTelemetry[];
  finalSystemSections?: AdminPromptSectionTelemetry[];
  sectionCacheability?: AdminPromptSectionCacheability[];
}

export interface AdminTurnToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface AdminAdaptiveToolSnapshotTool {
  toolName: string;
  source: string;
}

export interface AdminAdaptiveToolSnapshotSkip {
  toolName: string;
  source: string;
  reason: string;
  missingTokens?: string[];
}

export interface AdminAdaptiveToolSnapshotCounts {
  core: number;
  promoted: number;
  extendedLoaded: number;
  autoload: number;
  deferred: number;
  total: number;
}

export interface AdminAdaptiveToolSnapshotData {
  timestamp: number;
  tools: AdminAdaptiveToolSnapshotTool[];
  skipped: AdminAdaptiveToolSnapshotSkip[];
  counts: AdminAdaptiveToolSnapshotCounts;
  taskKind?: string | null;
  intent?: string | null;
  turnId?: string;
  requestId?: string;
  channelId?: string;
  callType?: string;
  purpose?: string;
}

export interface AdminTurnToolContextSnapshotData {
  activeTools: AdminTurnToolSchema[];
  adaptiveSnapshot?: AdminAdaptiveToolSnapshotData;
}

export interface AdminTurnSessionContextSnapshotData {
  channelId: string;
  recentEntries: SessionEntry[];
  compactionSummaryTexts: string[];
  focusKnowledgeTexts: string[];
  continuityEntries: SessionEntry[];
  compactionPromptText?: string;
  versionPointer: string;
}

export interface AdminTurnMemorySnapshotData {
  channelId: string;
  profile?: Record<string, unknown>;
  emotionalSnapshot?: Record<string, number>;
  contactEmotionalMemories: AdminObservedMemory[];
  semanticCandidates: AdminObservedScoredMemory[];
  lexicalCandidates: AdminObservedScoredMemory[];
  proactiveCandidates: AdminObservedMemory[];
  withheldSummary?: MemoryWithheldSummary;
  versionPointer: string;
}

export interface AdminTurnSnapshotData {
  turnId: string;
  requestId: string;
  channelId: string;
  capturedAt: number;
  trustLevel: string;
  canonicalContactKey?: string;
  prompt?: AdminTurnPromptSnapshotData;
  promptContext?: AdminTurnPromptContextSnapshotData;
  toolContext?: AdminTurnToolContextSnapshotData;
  sessionContext?: AdminTurnSessionContextSnapshotData;
  memory?: AdminTurnMemorySnapshotData;
}

export type AdminSessionTurnData = CanonicalAdminSessionTurnData;

export interface SessionRoleEnvelopePreview {
  schemaVersion: 1;
  envelopeId: string;
  internalRole: string;
  summary: string;
  sourceStage: string;
  promotionTarget: string;
  promotedRef?: string;
}

export interface AdminSessionRoleEnvelopePreview {
  sessionEntryId: number;
  preview: SessionRoleEnvelopePreview;
}

export interface AdminSessionMessageOntologyView {
  sessionEntryId: number;
  transportRole: SessionEntry['role'];
  promptRole: 'user' | 'assistant' | 'toolResult' | 'custom';
  semanticType: 'outwardSpeech' | 'toolResult' | 'systemNote' | 'mirror';
  messageClass: 'outwardSpeech' | 'systemNote' | 'internalWhisper' | 'compaction' | 'continuity' | 'mirror' | null;
  promptVisibility: 'prompt_visible' | 'operator_only';
  displayLabel: string;
}

export type AdminSessionMessagesData = CanonicalAdminSessionMessagesData;

// Contacts
export interface ContactChannelIdentity {
  channel: string;
  userId: string;
}

export interface ContactChannelLink extends ContactChannelIdentity {
  privacyLevel: ChannelPrivacyLevel;
  firstSeen?: string;
  lastSeen?: string;
}

export type ChannelPrivacyLevel = 'private' | 'semi_private' | 'public' | 'broadcast';

export interface Contact {
  id: string;
  displayName: string;
  nickname?: string;
  discordUserId?: string;
  trustLevel: string;
  relationshipType: string;
  channelIdentities?: ContactChannelIdentity[];
  channels?: ContactChannelLink[];
  conversationChannels?: Array<{
    channel: string;
    channelId: string;
    privacyLevel?: ChannelPrivacyLevel;
    firstSeen: string;
    lastSeen: string;
  }>;
  emotionalBaseline?: Record<string, number>;
  firstSeen: string;
  lastSeen: string;
  notes?: string;
}

export interface ContactProfileArtifact {
  memoryCount: number;
  displayName?: string;
  summary?: string;
  updatedAt?: number;
  sourceMemoryIds?: string[];
}

export interface ContactConversationChannelView {
  channel: string;
  channelId: string;
  userId?: string;
  privacyLevel?: ChannelPrivacyLevel;
  lastSeen?: string;
}

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

export interface AdminContactSocialGraphEntityView {
  id: string;
  displayName: string;
  contactId?: string;
  source: SocialGraphEntitySource;
  sensitivity: string;
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
  sensitivity: string;
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
  sensitivity: string;
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

export interface AdminContactListData {
  contacts: Contact[];
  profileMap: Record<string, ContactProfileArtifact>;
  relatedChannelMap: Record<string, ContactConversationChannelView[]>;
  socialGraphMap: Record<string, AdminContactSocialGraphView>;
  verifications: ContactIdentityLinkVerification[];
  mutationAudits: ContactMutationAuditEntry[];
  mutationAuditQuery: unknown;
}

export interface ContactUpdateResult {
  ok: boolean;
  message: string;
  contact?: Contact;
  relatedChannels?: ContactConversationChannelView[];
}

export type TrustLevel = 'primary' | 'trusted' | 'regular' | 'public';

export type RelationshipType = 'partner' | 'family' | 'friend' | 'acquaintance' | 'stranger' | 'ai_companion';

export const RELATIONSHIP_TYPES: RelationshipType[] = [
  'partner', 'family', 'friend', 'acquaintance', 'stranger', 'ai_companion',
];

export const CHANNEL_PRIVACY_LEVELS: ChannelPrivacyLevel[] = [
  'private', 'semi_private', 'public', 'broadcast',
];

export interface ContactIdentityLinkVerification {
  id: string;
  status: string;
  sourceChannel: string;
  sourceUserId: string;
  targetChannel: string;
  targetUserId: string;
  contactId: string;
  nonce?: string;
  expiresAt?: string;
}

export interface ContactMutationAuditEntry {
  id: string;
  contactId: string;
  field: string;
  actor: string;
  oldValue?: string;
  newValue?: string;
  timestamp: string;
}

// Settings
export type SettingsContractSubsystem = CanonicalSettingsContractSubsystem;

export type SettingsContractField = CanonicalSettingsContractField;

export type SettingsContractData = CanonicalSettingsContractData;

export type SettingsConfigEditors = CanonicalSettingsConfigEditors;

export type AdminSettingsData = CanonicalAdminSettingsData;

export type SettingsValidationError = CanonicalSettingsValidationError;

export type ConfigUpdateResult = CanonicalConfigUpdateResult;

// Identity
export interface CharacterCardV2 {
  spec: string;
  spec_version: string;
  data: {
    name: string;
    description: string;
    personality: string;
    scenario: string;
    first_mes: string;
    mes_example: string;
    system_prompt: string;
    post_history_instructions: string;
    tags: string[];
    creator: string;
    creator_notes: string;
    character_version: string;
    extensions: Record<string, unknown>;
    [key: string]: unknown;
  };
}

export interface CharacterCardHistoryEntry {
  version: number;
  timestamp: string;
  updatedBy: string;
  reason?: string;
  previousChecksum: string;
  newChecksum: string;
  previousCard?: CharacterCardV2;
  newCard?: CharacterCardV2;
  // Legacy compat -- old API responses used changedBy instead of updatedBy
  changedBy?: string;
  checksum?: string;
}

export interface AdminIdentityData {
  card: CharacterCardV2;
  config: Record<string, unknown>;
  version: number;
  checksum?: string;
  history: CharacterCardHistoryEntry[];
  intakeReview: unknown;
}

// Prompts
export interface PromptLayer {
  id: string;
  type: string;
  name: string;
  content: string;
  enabled: boolean;
  priority: number;
  identifier?: string;
  role?: string;
  promptOrder?: number;
  channelType?: string;
  taskKind?: string;
  version: number;
  updatedAt: string;
  updatedBy: string;
  checksum: string;
}

export interface PromptHistoryEntry {
  layerId: string;
  layerName: string;
  previousContent: string;
  previousChecksum: string;
  newContent: string;
  newChecksum: string;
  updatedBy: string;
  reason?: string;
  timestamp: string;
  version: number;
}

export type AdminPromptDetailData = CanonicalAdminPromptDetailData;

export type PromptRegistryHistoryEntry = CanonicalPromptRegistryHistoryEntry;

export interface PromptDiffResult {
  oldContent: string;
  newContent: string;
}

export type PromptRegistryEntry = CanonicalPromptRegistryEntry & {
  content?: string;
};

export interface PromptRuntimeBlock {
  id: PromptRuntimeBlockId;
  label: string;
  description: string;
  source: string;
  schemaClassification: PromptRuntimeBlockSchemaClassification;
  required: boolean;
  immutable: boolean;
  providerManaged: boolean;
  placement: PromptRuntimeBlockPlacement;
  visibility: PromptRuntimeBlockVisibility;
  reorderable: boolean;
  contentVisible: boolean;
  companionEditable: boolean;
  customContent?: string;
  lockedReason?: string;
  effectiveOrder: number;
}

export interface PromptRuntimeLayerCoverageEntry {
  identifier: string;
  name: string;
  classification: RuntimePromptLayerSchemaClassification;
  required: boolean;
  status: 'valid' | 'missing' | 'disabled' | 'empty';
  layerId?: string;
}

export type PromptRuntimeMacroHint = CanonicalPromptRuntimeMacroHint;

export type AdminPromptListData = CanonicalAdminPromptListData;

export interface ConstitutionImmutableBlock {
  id: string;
  title: string;
  content: string;
  editable: false;
}

export interface ConstitutionCompanionLayer {
  id: string;
  title: string;
  content: string;
  provenanceRefs: string[];
  historyVersions: number[];
  entryIds: string[];
  editable: false;
}

export interface ConstitutionMutableLayer extends PromptLayer {
  editable: boolean;
  readOnlyReason?: string;
}

export interface FoundationSection {
  id: string;
  title: string;
  content: string;
  enabled: boolean;
  defaultEnabled: boolean;
}

export interface FoundationSnapshotData {
  layerId: string;
  layerName: string;
  sections: FoundationSection[];
  preview: {
    text: string;
    hash: string;
  };
}

export interface ConstitutionSnapshotData {
  immutableBlocks: ConstitutionImmutableBlock[];
  companionLayer: ConstitutionCompanionLayer | null;
  mutableLayers: ConstitutionMutableLayer[];
  preview: {
    text: string;
    hash: string;
    staticPrefix: string;
    dynamicSuffix: string;
  };
}

export type ConstitutionUpdateResult = CanonicalConstitutionUpdateResult;

export type FoundationUpdateResult = CanonicalFoundationUpdateResult;

export type NorthStarScope = 'shared' | 'companion';

export type NorthStarItem = CanonicalNorthStarItem;

export interface NorthStarSnapshotData {
  items: NorthStarItem[];
  limit: number;
  preview: {
    text: string;
    hash: string;
  };
}

export type NorthStarUpdateResult = CanonicalNorthStarUpdateResult;

export type RuntimePromptUpdateResult = Omit<CanonicalRuntimePromptUpdateResult, 'updated'> & {
  updated?: Array<PromptRuntimeEditableBlockId | string>;
};

export type PromptUpdateResult = CanonicalPromptUpdateResult;

// Chat
export type AdminChatBootstrapResponse = CanonicalAdminChatBootstrapResponse;

export type AdminModelRoomParticipant = CanonicalAdminModelRoomParticipant;

export type AdminModelRoomBootstrapResponse = CanonicalAdminModelRoomBootstrapResponse;

// Models
export interface DiscoveredModel {
  id: string;
  description?: string;
  providerHints?: string[];
  contextLength?: number;
  maxCompletionTokens?: number;
  pricing?: Record<string, string | number | undefined>;
  supportsVision?: boolean;
  supportsReasoning?: boolean;
}

// Scheduler
export type TaskType = CanonicalTaskType;
export type TaskState = CanonicalTaskState;
export type SchedulerCadenceTimezone = Extract<CanonicalRecurringCadence, { timezone: 'local' | 'utc' }>['timezone'];
export type RelativeRecurringCadence = Extract<CanonicalRecurringCadence, { kind: 'relative' }>;
export type HourlyRecurringCadence = Extract<CanonicalRecurringCadence, { kind: 'hourly' }>;
export type DailyRecurringCadence = Extract<CanonicalRecurringCadence, { kind: 'daily' }>;
export type RecurringCadence = CanonicalRecurringCadence;

export type ScheduledTask = Omit<CanonicalScheduledTask, 'handler' | 'eligibility'>;

export interface ReflectionDeliberationConfig {
  maxRounds?: number;
  maxTotalTokens?: number;
  maxWallTimeMs?: number;
  voices?: Array<'background' | 'reasoning'>;
  inputUsdPerMillionTokens?: number;
  outputUsdPerMillionTokens?: number;
}

export type ReflectionTemplate = Omit<CanonicalReflectionTemplate, 'cadence' | 'deliberation'> & {
  cadence?: RecurringCadence;
  deliberation?: ReflectionDeliberationConfig;
};

export interface AdminSchedulerData {
  tasks: ScheduledTask[];
  reflections: ReflectionTemplate[];
}

export interface SchedulerMutationResult {
  ok: boolean;
  message: string;
}

// Skills
export type SkillRequirements = CanonicalSkillEntry['requires'];

export type SkillEntry = Pick<
  CanonicalSkillEntry,
  'id' | 'name' | 'description' | 'category' | 'relativePath' | 'source' | 'always' | 'requires' | 'content' | 'size'
>;

export type SkillSkipRecord = Pick<
  CanonicalSkillSkipRecord,
  'kind' | 'name' | 'relativePath' | 'source' | 'reason' | 'details'
>;

export type SkillDirectorySpec = Pick<CanonicalSkillSnapshot['directories'][number], 'relativePath' | 'source'>;

export type SkillSnapshot = Omit<CanonicalSkillSnapshot, 'directories' | 'includedSkills' | 'skipped'> & {
  directories: SkillDirectorySpec[];
  includedSkills: SkillEntry[];
  skipped: SkillSkipRecord[];
};

export interface ManagedSkill {
  name: string;
  description: string;
  category: string;
  version: number;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface AdminSkillsData {
  snapshot: SkillSnapshot;
  managed: ManagedSkill[];
  disabledSkills: string[];
}

// Confirmations
export type ConfirmationDecision = CanonicalConfirmationDecision;

export type ConfirmationQueueEntry = CanonicalConfirmationQueueEntry;

export interface AdminConfirmationsData {
  entries: ConfirmationQueueEntry[];
  available: boolean;
  message?: string;
}

export type ConfirmationResolveResult = CanonicalConfirmationResolveResult;

// Values Timeline
export type ValuesJournalEntry = CanonicalValuesJournalEntry;

export interface AdminValuesData {
  entries: ValuesJournalEntry[];
}

// Telemetry
export interface TelemetryCorrelation {
  turnId?: string;
  requestId?: string;
  channelId?: string;
  callType?: string;
  originType?: string;
  originStage?: string;
  toolName?: string;
  toolCallId?: string;
  purpose?: string;
}

export interface TelemetryEvent {
  type: string;
  timestamp: number;
  correlation?: TelemetryCorrelation;
  data: unknown;
}

// Audit Trail (derived from telemetry events on the client)
export type AuditActionType = 'tool_invocation' | 'identity_edit' | 'external_action' | 'memory_mutation';
export type AuditDecision = 'allowed' | 'denied';
export type AuditTimeRange = '15m' | '1h' | '24h' | '7d' | '30d' | 'all';

export interface AuditEntry {
  id: string;
  timestamp: number;
  actionType: AuditActionType;
  decision: AuditDecision;
  narrative: string;
  details?: string;
}

export interface AuditFilters {
  actionType: AuditActionType | 'all';
  decision: AuditDecision | 'all';
  timeRange: AuditTimeRange;
}
