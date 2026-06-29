import type { ConfirmationQueueEntry } from '../../../../src/system/capabilities/confirmation-queue.js';
import type {
  PurrMemory as CanonicalPurrMemory,
  MemoryScopeRef as CanonicalMemoryScopeRef,
} from '../../../../src/faculties/memory/types.js';
import type {
  RecurringCadence as CanonicalRecurringCadence,
  ScheduledTask as CanonicalScheduledTask,
} from '../../../../src/core/scheduler/types.js';
import type { PromptRegistryEntry as CanonicalPromptRegistryEntry } from '../../../../src/core/identity/prompt-registry.js';
import type {
  PromptRuntimeBlockId,
  PromptRuntimeBlockPlacement,
  PromptRuntimeBlockSchemaClassification,
  PromptRuntimeBlockVisibility,
  PromptRuntimeEditableBlockId,
} from '../../../../src/core/identity/prompt-runtime.js';
import type { PromptLayer } from '../../../../src/core/identity/prompt-types.js';
import type { RuntimePromptLayerSchemaClassification } from '../../../../src/core/identity/runtime-prompt-layers.js';
import type { NorthStarItem } from '../../../../src/faculties/north-star/store.js';
import type { SkillEntry, SkillSnapshot } from '../../../../src/faculties/skills/types.js';
import type { ValuesJournalEntry } from '../../../../src/faculties/values/store.js';
import type { ReflectionTemplate } from '../../../../src/core/scheduler/heartbeat-policy.js';
import type {
  AdminSessionListData as CanonicalAdminSessionListData,
  AdminSessionMessagesData as CanonicalAdminSessionMessagesData,
  RuntimePromptUpdateResult as CanonicalRuntimePromptUpdateResult,
} from '../../../../src/operator/garden/services/types.js';

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
  AnalysisWorkbenchTraceStepView,
  AnalysisWorkbenchTraceView,
} from '../../../../src/operator/garden/types.js';
export type {
  CanonicalProviderRegistry,
  CanonicalProviderType,
  ProviderRegistryEntry,
} from '../../../../src/shared/contracts/runtime.js';
export type { ProvidersRuntimeConfig } from '../../../../src/system/config/providers-config.js';
export type {
  ConfirmationDecision,
  ConfirmationQueueEntry,
  ConfirmationResolveResult,
} from '../../../../src/system/capabilities/confirmation-queue.js';
export type {
  SettingsContractData,
  SettingsContractField,
  SettingsContractSubsystem,
} from '../../../../src/system/config/settings-contract.js';
export type {
  Episode,
  EpisodeAffect,
  EpisodeArc,
  EpisodeArcKind,
  EpisodeArtifactRef,
  EpisodeProvenanceRef,
  EpisodeSalience,
  EpisodeSpanRef,
} from '../../../../src/shared/contracts/episodic-memory.js';
export type {
  AdminEpisodicEpisodeDetailData,
  AdminEpisodicEpisodeListData,
  AdminEpisodicEpisodeProvenanceData,
  AdminEpisodicRelatedArcView,
  AdminEpisodicThreadDetailData,
  AdminEpisodicThreadListData,
  AdminEpisodicThreadSummary,
} from '../../../../src/operator/garden/services/types.js';
export type {
  AdminDashboardData,
  AdminPromptDetailData,
  AdminPromptListData,
  AdminSessionListData,
  AdminSessionMessagesData,
  AdminSessionTurnData,
  AdminTurnRetrievalTelemetry,
  AdminTurnStageTelemetry,
  AdminSettingsData,
  ConfigUpdateResult,
  ConstitutionUpdateResult,
  FoundationUpdateResult,
  NorthStarUpdateResult,
  PromptUpdateResult,
  SettingsConfigEditors,
  SettingsValidationError,
} from '../../../../src/operator/garden/services/types.js';
export type {
  AdminChatBootstrapResponse,
  AdminModelRoomBootstrapResponse,
  AdminModelRoomParticipant,
} from '../../../../src/operator/garden/chat/types.js';
export type { PromptRegistryHistoryEntry } from '../../../../src/core/identity/prompt-registry.js';
export type { PromptRuntimeMacroHint } from '../../../../src/core/identity/prompt-runtime.js';
export type { PromptHistoryEntry, PromptLayer } from '../../../../src/core/identity/prompt-types.js';
export type {
  DailyRecurringCadence,
  HourlyRecurringCadence,
  RecurringCadence,
  RelativeRecurringCadence,
  TaskState,
  TaskType,
} from '../../../../src/core/scheduler/types.js';
export type {
  ReflectionDeliberationConfig,
  ReflectionTemplate,
} from '../../../../src/core/scheduler/heartbeat-policy.js';
export type {
  SkillDirectorySpec,
  SkillEntry,
  SkillSkipRecord,
  SkillSnapshot,
} from '../../../../src/faculties/skills/types.js';
export type { NorthStarItem, NorthStarScope } from '../../../../src/faculties/north-star/store.js';
export type { ValuesJournalEntry } from '../../../../src/faculties/values/store.js';

// Memory -- backend-owned with UI compatibility overlays for legacy wire shapes.
export type AdminUiPurrMemory = Omit<CanonicalPurrMemory, 'type' | 'scopeRef' | 'sensitivity'> & {
  type: CanonicalPurrMemory['type'] | string;
  scopeRef?: AdminUiMemoryScopeRef;
  sensitivity?: CanonicalPurrMemory['sensitivity'] | string;
  content?: string;
  createdAt?: number;
  updatedAt?: number;
  emotionalWeight?: number;
  supersededAt?: number;
};

export type AdminUiMemoryScopeRef = Omit<CanonicalMemoryScopeRef, 'kind'> & {
  kind: CanonicalMemoryScopeRef['kind'] | string;
};

export interface AdminMemoryContactSummary {
  id: string;
  displayName: string;
}

export interface AdminMemoryPrivacySummary {
  activeMemoryCount: number;
  matchingMemoryCount: number;
  pageMemoryCount: number;
  highSensitivityCount: number;
  consentGatedCount: number;
  contactLinkedCount: number;
  scopedCount: number;
  preferenceCount: number;
  durablePreferenceCount: number;
  sensitivityCounts: Record<string, number>;
}

export interface AdminMemoryListData {
  memories: AdminUiPurrMemory[];
  contactsById: Record<string, AdminMemoryContactSummary>;
  privacySummary: AdminMemoryPrivacySummary;
  pagination: {
    limit: number;
    offset: number;
    total: number;
    hasPrevious: boolean;
    hasNext: boolean;
  };
}

export interface AdminMemoryDetailData {
  memory: AdminUiPurrMemory;
  linkedContact?: AdminMemoryContactSummary;
  scopeAssignments: AdminMemoryScopeAssignmentView[];
  scopeRepair?: AdminMemoryScopeRepairView;
}

export interface AdminMemorySearchResult {
  query: string;
  results: AdminUiPurrMemory[];
  contactsById: Record<string, AdminMemoryContactSummary>;
  privacySummary: AdminMemoryPrivacySummary;
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
  suggestedScopeRef?: AdminUiMemoryScopeRef;
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
  memory: AdminUiPurrMemory;
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
  memory?: AdminUiPurrMemory;
  scopeAssignments?: AdminMemoryScopeAssignmentView[];
  scopeRepair?: AdminMemoryScopeRepairView;
}

// Sessions
export type ChannelInfo = CanonicalAdminSessionListData['channels'][number];

export interface SessionEntry {
  id: number;
  channelId?: string;
  role: string;
  content: string;
  authorName?: string;
  authorId?: string;
  timestamp?: string | number;
  toolCalls?: unknown[];
  originChannelId?: string;
  channelVisibility?: string;
  metadata?: string;
}

export type CompactionAuditView = CanonicalAdminSessionMessagesData['compactionAuditViews'][number];

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
  formationVAD?: unknown;
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
  consentFlags?: unknown;
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

export type AdminAuthenticityProvenanceKind =
  | 'user_direct'
  | 'companion_direct'
  | 'compaction_summary'
  | 'system_note'
  | 'system_injection'
  | 'memory_retrieval'
  | 'extraction_artifact'
  | 'projection'
  | 'search_result'
  | 'tool_result'
  | 'redacted_transformed';

export interface AdminAuthenticityProvenance {
  schemaVersion: 1;
  kind: AdminAuthenticityProvenanceKind;
  sourceAuthor: string;
  transformedBy: string;
  wording: string;
  directSpeech: boolean;
  detailLoss: string;
  emotionalTexture: string;
  safeAsPartnerSpeech: boolean;
  sourceSpanCount?: number;
  sourceEntryIds?: number[];
  notes?: string[];
}

export interface AdminTurnPromptContextMessage {
  role: string;
  content: string;
  provenance?: AdminAuthenticityProvenance;
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
  provenance?: AdminAuthenticityProvenance;
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
  profile?: unknown;
  emotionalSnapshot?: unknown;
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
  messageClass: 'outwardSpeech' | 'systemNote' | 'internalWhisper' | 'musing' | 'compaction' | 'continuity' | 'mirror' | null;
  promptVisibility: 'prompt_visible' | 'operator_only';
  displayLabel: string;
}

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

export interface AdminContactRelationshipScoreView {
  score: number;
  resolvedTier: string;
  previousTierThreshold?: number;
  nextTier?: string;
  nextTierThreshold?: number;
  progressToNextTier?: number;
  updatedAt?: string;
}

export interface AdminContactListData {
  contacts: Contact[];
  profileMap: Record<string, ContactProfileArtifact>;
  relatedChannelMap: Record<string, ContactConversationChannelView[]>;
  socialGraphMap: Record<string, AdminContactSocialGraphView>;
  relationshipScoreMap?: Record<string, AdminContactRelationshipScoreView>;
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

export interface NorthStarSnapshotData {
  items: NorthStarItem[];
  limit: number;
  preview: {
    text: string;
    hash: string;
  };
}

export type RuntimePromptUpdateResult = Omit<CanonicalRuntimePromptUpdateResult, 'updated'> & {
  updated?: Array<PromptRuntimeEditableBlockId | string>;
};

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
  zdrAvailable?: boolean;
  zdrEndpointCount?: number;
  zdrProviderTags?: string[];
  zdrProviderNames?: string[];
}

// Scheduler
export type SchedulerCadenceTimezone = Extract<CanonicalRecurringCadence, { timezone: 'local' | 'utc' }>['timezone'];

export type ScheduledTask = Omit<CanonicalScheduledTask, 'handler' | 'eligibility'>;

export interface AdminSchedulerData {
  tasks: ScheduledTask[];
  reflections: ReflectionTemplate[];
}

export interface SchedulerMutationResult {
  ok: boolean;
  message: string;
}

// Skills
export type SkillRequirements = SkillEntry['requires'];

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

export interface AdminConfirmationsData {
  entries: ConfirmationQueueEntry[];
  available: boolean;
  message?: string;
}

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

// Audit Trail (persisted Garden/runtime history)
export type AuditActionType =
  | 'tool_invocation'
  | 'tool_activation'
  | 'identity_edit'
  | 'external_action'
  | 'memory_mutation'
  | 'settings_change'
  | 'confirmation'
  | 'charge_decision'
  | 'gateway_policy';
export type AuditDecision = 'allowed' | 'denied' | 'needs_approval';
export type AuditTimeRange = '15m' | '1h' | '24h' | '7d' | '30d' | 'all';
export type AuditHistorySource = 'garden' | 'gateway' | 'charge';

export interface AuditEntry {
  id: string;
  timestamp: number;
  source: AuditHistorySource;
  sourceRecordId?: string;
  actionType: AuditActionType;
  decision: AuditDecision;
  narrative: string;
  details?: string;
  actor?: 'operator' | 'companion';
  raw?: Record<string, unknown>;
}

export interface AuditFilters {
  actionType: AuditActionType | 'all';
  decision: AuditDecision | 'all';
  timeRange: AuditTimeRange;
  source?: AuditHistorySource | 'all';
  query?: string;
  limit?: number;
  offset?: number;
}

export interface AuditHistoryData {
  entries: AuditEntry[];
  filters: Required<Pick<AuditFilters, 'actionType' | 'decision' | 'timeRange'>> & {
    source: AuditHistorySource | 'all';
    query?: string;
    limit: number;
    offset: number;
  };
  pagination: {
    limit: number;
    offset: number;
    total: number;
    hasPrevious: boolean;
    hasNext: boolean;
  };
  sources: Record<AuditHistorySource, {
    available: boolean;
    count: number;
    message?: string;
  }>;
}
