import type { ConfirmationQueueEntry } from '../../../../src/system/capabilities/confirmation-queue.js';
import type {
  PurrMemory as CanonicalPurrMemory,
  MemoryScopeRef as CanonicalMemoryScopeRef,
} from '../../../../src/faculties/memory/types.js';
import type { TurnToolContextSnapshot } from '../../../../src/core/turns/snapshot.js';
import type {
  ObservedMemory as CanonicalObservedMemory,
  ObservedScoredMemory as CanonicalObservedScoredMemory,
  TurnMemorySnapshotRecord,
  TurnSessionContextSnapshotRecord,
  TurnSnapshotRecord,
} from '../../../../src/core/turns/observability.js';
import type { AdaptiveToolCatalogSource } from '../../../../src/core/agent/adaptive-tools-telemetry.js';
import type { PromptPlan } from '../../../../src/core/agent/substrate-agent/turn-execution/prompt-plan.js';
import type { CapabilityToken } from '../../../../src/system/capabilities/tokens.js';
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
import type { ReflectionJournalEntry } from '../../../../src/persistence/journals/reflection-journal.js';
import type { ReflectionMetacognitionJournalEntry } from '../../../../src/persistence/journals/reflection-metacognition-journal.js';
import type { ReflectionDailyJournalEntry } from '../../../../src/persistence/journals/reflection-substrate.js';
import type { ReflectionTemplate } from '../../../../src/core/scheduler/heartbeat-policy.js';
import type {
  AdminSessionListData as CanonicalAdminSessionListData,
  AdminSessionMessagesData as CanonicalAdminSessionMessagesData,
  RuntimePromptUpdateResult as CanonicalRuntimePromptUpdateResult,
} from '../../../../src/operator/garden/services/types.js';
import type {
  AuthenticityProvenance,
  ContextMessage,
  LLMProviderWireMessage,
  LLMSystemPromptTransport,
  ObservabilityCallType,
} from '../../../../src/shared/contracts/runtime.js';

export type {
  CredentialReference,
  EnvCredentialReference,
} from '../../../../src/boundary/custody/credential-vault.js';
export type {
  DashboardCostWindow,
  DashboardCostWindowUsage,
  DashboardModelUsageFreshness,
  DashboardModelUsageProjection,
  DashboardModelUsageState,
  DashboardSessionContextPressure,
  DashboardStats,
  DashboardTransientSessionTelemetry,
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
  AdminIntakeQuarantineDecisionRequest,
  AdminIntakeQuarantineFlywheelTarget,
  AdminIntakeQuarantineItemDetail,
  AdminIntakeQuarantineItemView,
  AdminIntakeQuarantineSourceListAction,
  AdminIntakeSourceListMutationInput,
} from '../../../../src/operator/garden/services/types.js';
export type {
  AdminDriftReviewListData,
  DriftReviewCard,
  DriftReviewCardResolution,
  SecondArrowReviewCard,
} from '../../../../src/operator/garden/services/types.js';
export type { DriftSignalResult } from '../../../../src/core/cogsec/drift/drift-signals.js';
export type {
  SecondArrowClusterMember,
  SecondArrowSignalResult,
} from '../../../../src/core/cogsec/drift/second-arrow-signals.js';
export type {
  IntakePolicyConfig,
  IntakeSourceListEntry,
  IntakeSourceListName,
  IntakeSourceListsConfig,
} from '../../../../src/system/config/intake-policy-config.js';
export type {
  AdminDashboardData,
  AdminCogSecEventListData,
  AdminCogSecRemediationApplyData,
  AdminCogSecRemediationInput,
  AdminCogSecRemediationPreviewData,
  AdminPromptDetailData,
  AdminPromptListData,
  AdminSessionListData,
  AdminSessionDetailData,
  AdminSessionMessagesData,
  AdminSessionRouteListData,
  AdminSessionRouteResetData,
  AdminSessionRouteResetInput,
  AdminSessionRouteView,
  AdminSessionSearchData,
  AdminSessionSearchHitView,
  AdminSessionTurnData,
  AdminSessionTurnDetailData,
  AdminPromptLoomData,
  AdminPromptLoomConcernOutputData,
  AdminPromptLoomContactOutputData,
  AdminPromptLoomSubsystemOutputEntry,
  AdminPromptLoomSubsystemOutputsData,
  AdminTurnRetrievalTelemetry,
  AdminTurnStageTelemetry,
  AdminSettingsData,
  EffectiveFleetAuthOwnerProjection,
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
  SkillRootScan,
  SkillSkipRecord,
  SkillSnapshot,
} from '../../../../src/faculties/skills/types.js';
export type { NorthStarItem, NorthStarScope } from '../../../../src/faculties/north-star/store.js';
export type { ValuesJournalEntry } from '../../../../src/faculties/values/store.js';
export type { ReflectionJournalEntry } from '../../../../src/persistence/journals/reflection-journal.js';
export type { ReflectionMetacognitionJournalEntry } from '../../../../src/persistence/journals/reflection-metacognition-journal.js';
export type { ReflectionDailyJournalEntry } from '../../../../src/persistence/journals/reflection-substrate.js';

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
  bodyRedacted?: boolean;
  bodyRedaction?: AdminMemoryBodyRedaction;
};

// Explicit redaction descriptor for a hidden high-intimacy memory body.
export interface AdminMemoryBodyRedaction {
  sensitivity: string;
  originalLength: number;
  reason: 'high_intimacy_sensitivity';
  revealHint: string;
}

// Session-elevation state for reading high-intimacy memory bodies.
export interface AdminMemoryElevationStatus {
  elevated: boolean;
  expiresAt?: number;
  ttlMs: number;
}

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
  elevation?: AdminMemoryElevationStatus;
}

export interface AdminMemoryDetailData {
  memory: AdminUiPurrMemory;
  linkedContact?: AdminMemoryContactSummary;
  scopeAssignments: AdminMemoryScopeAssignmentView[];
  scopeRepair?: AdminMemoryScopeRepairView;
  elevation?: AdminMemoryElevationStatus;
}

export interface AdminMemorySearchResult {
  query: string;
  results: AdminUiPurrMemory[];
  contactsById: Record<string, AdminMemoryContactSummary>;
  privacySummary: AdminMemoryPrivacySummary;
  elevation?: AdminMemoryElevationStatus;
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
  elevation?: AdminMemoryElevationStatus;
}

export interface AdminMemoryScopeMutationResult {
  ok: boolean;
  message?: string;
  memory?: AdminUiPurrMemory;
  scopeAssignments?: AdminMemoryScopeAssignmentView[];
  scopeRepair?: AdminMemoryScopeRepairView;
}

// Sessions
export type ChannelInfo = CanonicalAdminSessionListData['channels'][number] & {
  linkedContactId?: string;
  linkedContactName?: string;
};

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
  relevanceBands?: Record<string, number>;
}

export type AdminObservedMemory = CanonicalObservedMemory;

export type AdminObservedScoredMemory = CanonicalObservedScoredMemory;

export interface AdminTurnPromptSnapshotData {
  staticPrefixTemplate: string;
  dynamicSuffixTemplate: string;
  dynamicSuffixSections?: Array<{
    identifier: string;
    required: boolean;
    content: string;
  }>;
  staticHash: string;
  versionPointer: string;
  sectionCacheability?: AdminPromptSectionCacheability[];
}

export type AdminAuthenticityProvenance = AuthenticityProvenance;

export interface AdminTurnPromptContextMessage {
  role: ContextMessage['role'];
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

export type AdminPromptSectionScopeClass = 'dm' | 'room' | 'global';

export type AdminPromptSectionVolatilityClass = 'static' | 'session_stable' | 'append_only' | 'volatile';

export interface AdminPromptSectionScopeProvenance {
  producer?: string;
  scopeKey?: string;
  scopeClass?: AdminPromptSectionScopeClass;
  volatility?: AdminPromptSectionVolatilityClass;
  sourceHint?: string;
}

export interface AdminPromptSectionTelemetry {
  id: string;
  title: string;
  content: string;
  charCount: number;
  tokenCount: number;
  provenance?: AdminAuthenticityProvenance;
  scopeProvenance?: AdminPromptSectionScopeProvenance;
}

export interface AdminTurnProviderWireMessage {
  role: LLMProviderWireMessage['role'];
  source: LLMProviderWireMessage['source'];
  content: string;
}

export interface AdminTurnProviderSystemRoleData {
  transport: LLMSystemPromptTransport;
  supportsSystemRole: boolean;
  supportsDeveloperRole: boolean;
  usesOutOfBandSystemPrompt: boolean;
}

/**
 * Provider prompt-cache telemetry mirror, rendered absent-tolerant in the
 * Loom Cache tab. E2.4 populates hit/miss fields; render whatever exists.
 */
export interface AdminTurnPromptCachingObservabilityData {
  configured: boolean;
  engaged: boolean;
  strategy?: string;
  retention?: string;
  scope?: string;
  sessionId?: string;
  reason?: string;
  mechanism?: string;
  appliedBreakpoints?: number;
  boundaries?: {
    staticPrefixChars: number;
    sessionStablePrefixChars: number;
  };
  usage?: {
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
  prefixStability?: {
    checked: boolean;
    stable?: boolean;
    firstObservation?: boolean;
    scopeKey?: string;
    changedBlockIds?: string[];
  };
}

/**
 * True provider wire body captured as-sent (bead hgw3-80f6). The Loom renders
 * `body` as the byte-identical raw-wire view; `body` is absent when a persisted
 * record's sidecar body could not be resolved.
 */
export interface AdminTurnCapturedWirePayloadData {
  api: string;
  model: string;
  capturedAtMs: number;
  byteLength: number;
  toolCount: number;
  body?: unknown;
  bodyRef?: string;
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
  promptCaching?: AdminTurnPromptCachingObservabilityData;
  /** Absent on slim records when the PromptPlan can reproduce it byte-for-byte. */
  providerWireMessages?: AdminTurnProviderWireMessage[];
  capturedWirePayload?: AdminTurnCapturedWirePayloadData;
}

export interface AdminTurnPromptResponseSnapshotData {
  content: string;
  reasoning?: string;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  toolCallCount?: number;
}

/**
 * Prompt observability that is not derivable from the PromptPlan (E2.2).
 * Rendered prompt strings and the shipped message history live on
 * AdminTurnSnapshotData.plan for current records; the optional string fields
 * here exist only on historical persisted records that predate the plan.
 */
export interface AdminTurnPromptContextSnapshotData {
  renderedStaticPrefix?: string;
  renderedDynamicSuffix?: string;
  runtimeContext?: string;
  memoryContextBlock?: string;
  scratchpadContext?: string;
  assembledPrompt?: string;
  finalSystemPrompt?: string;
  messages?: AdminTurnPromptContextMessage[];
  currentTurnInput?: string;
  providerObservability?: AdminTurnProviderObservabilityData;
  response?: AdminTurnPromptResponseSnapshotData;
  inputSections?: AdminPromptSectionTelemetry[];
  runtimeContextSections?: AdminPromptSectionTelemetry[];
  memoryContextSections?: AdminPromptSectionTelemetry[];
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
  source: AdaptiveToolCatalogSource;
}

export interface AdminAdaptiveToolSnapshotSkip {
  toolName: string;
  source: 'extended';
  reason: string;
  missingTokens?: CapabilityToken[];
}

export interface AdminAdaptiveToolSnapshotCounts {
  core: number;
  extended: number;
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
  callType?: ObservabilityCallType;
  purpose?: string;
}

export type AdminTurnToolContextSnapshotData = TurnToolContextSnapshot;

export type AdminTurnSessionContextSnapshotData = TurnSessionContextSnapshotRecord;

export type AdminTurnMemorySnapshotData = TurnMemorySnapshotRecord;

export interface AdminPromptPlanBlock {
  id: string;
  layer: 'prompt_stack' | 'runtime' | 'session' | 'provider';
  volatility: 'static' | 'session_stable' | 'turn';
  producer: string;
  scopeKey?: string;
  renderedText: string;
  tokensEst: number;
}

export interface AdminPromptPlanData {
  schemaVersion: 1;
  blocks: AdminPromptPlanBlock[];
  variables: Record<string, string>;
  messages: AdminTurnPromptContextMessage[];
  toolDefinitions: AdminTurnToolSchema[];
  cachePlan: { staticBoundary: number; sessionStableBoundary: number };
  scope: PromptPlan['scope'];
}

export type AdminTurnSnapshotData = Omit<TurnSnapshotRecord, 'promptContext'> & {
  /** Historical persisted records may carry pre-plan prompt string fields. */
  promptContext?: AdminTurnPromptContextSnapshotData;
};

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

export type ChannelPrivacyLevel = 'private' | 'invite_only' | 'public' | 'broadcast';

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
  'private', 'invite_only', 'public', 'broadcast',
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

// Subsystem health (background lanes)
export type SubsystemLaneOutcome = 'ran' | 'skipped' | 'degraded' | 'failed';

export type SubsystemLaneStatus =
  | 'ok'
  | 'skipped'
  | 'degraded'
  | 'failed'
  | 'stale'
  | 'paused'
  | 'never';

export type SubsystemLaneSource = 'event_bus' | 'scheduler';

export interface SubsystemLaneEvent {
  at: number;
  outcome: SubsystemLaneOutcome;
  reason?: string;
  error?: string;
  counts?: Record<string, number>;
}

export interface SubsystemLaneHealth {
  id: string;
  label: string;
  description: string;
  source: SubsystemLaneSource;
  sinceProcessStart: boolean;
  status: SubsystemLaneStatus;
  lastEventAt: number | null;
  lastOutcome: SubsystemLaneOutcome | null;
  lastReason: string | null;
  lastError: string | null;
  counts: Record<string, number>;
  observedEventCount: number;
  recent: SubsystemLaneEvent[];
  intervalMs?: number;
  lastRunAt?: number | null;
  nextRunDueAt?: number | null;
  deniedReason?: string | null;
}

export interface SubsystemHealthSnapshot {
  processStartedAt: number;
  generatedAt: number;
  lanes: SubsystemLaneHealth[];
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

export interface AdminReflectionMetacognitionData {
  entries: ReflectionMetacognitionJournalEntry[];
}

export interface AdminReflectionDailyData {
  entries: ReflectionDailyJournalEntry[];
}

export interface AdminReflectionJournalData {
  entries: ReflectionJournalEntry[];
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
  | 'memory_access'
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
  actionType: AuditActionType;
  decision: AuditDecision;
  narrative: string;
  details?: string;
  actor?: 'operator' | 'companion';
}

export interface AuditHistoryDetailData {
  entry: AuditEntry;
  raw: Record<string, unknown> | null;
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
