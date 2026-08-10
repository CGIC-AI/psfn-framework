import type { ConfirmationQueueEntry } from '../../../../src/system/capabilities/confirmation-queue.js';
import type { PublicationProvenanceView } from '../../../../src/core/cogsec/disclosure/publication-provenance.js';
import type {
  PurrMemory as CanonicalPurrMemory,
  MemoryScopeRef as CanonicalMemoryScopeRef,
} from '../../../../src/faculties/memory/types.js';
import type {
  TurnPromptContextSnapshot as CanonicalTurnPromptContextSnapshot,
  TurnToolContextSnapshot,
} from '../../../../src/core/turns/snapshot.js';
import type {
  ObservedMemory as CanonicalObservedMemory,
  ObservedScoredMemory as CanonicalObservedScoredMemory,
} from '../../../../src/core/turns/observability.js';
import type {
  AdaptiveToolCatalogSource,
  AdaptiveToolSnapshotTelemetry,
} from '../../../../src/core/agent/adaptive-tools-telemetry.js';
import type { PromptPlan } from '../../../../src/core/agent/substrate-agent/turn-execution/prompt-plan.js';
import type { CapabilityToken } from '../../../../src/system/capabilities/tokens.js';
import type { SessionEntry as CanonicalSessionEntry } from '../../../../src/core/session/types.js';
import type {
  RecurringCadence as CanonicalRecurringCadence,
  ScheduledTask as CanonicalScheduledTask,
} from '../../../../src/core/scheduler/types.js';
import type { PromptRegistryEntry as CanonicalPromptRegistryEntry } from '../../../../src/core/identity/prompt-registry.js';
import type { CharacterCardV2 as CanonicalCharacterCardV2 } from '../../../../src/core/identity/types.js';
import type { CharacterCardHistoryEntry as CanonicalCharacterCardHistoryEntry } from '../../../../src/core/identity/card-versioning.js';
import type { SessionRoleEnvelopePreview as CanonicalSessionRoleEnvelopePreview } from '../../../../src/core/internal-role-envelopes/projections.js';
import type {
  PromptRuntimeBlockId,
  PromptRuntimeBlockPlacement,
  PromptRuntimeBlockSchemaClassification,
  PromptRuntimeBlockVisibility,
} from '../../../../src/core/identity/prompt-runtime.js';
import type { PromptLayer } from '../../../../src/core/identity/prompt-types.js';
import type { RuntimePromptLayerSchemaClassification } from '../../../../src/core/identity/runtime-prompt-layers.js';
import type { NorthStarItem } from '../../../../src/faculties/north-star/store.js';
import type { SkillEntry, SkillSnapshot } from '../../../../src/faculties/skills/types.js';
import type { ValuesJournalEntry } from '../../../../src/faculties/values/store.js';
import type { ReflectionJournalEntry } from '../../../../src/persistence/journals/reflection-journal.js';
import type { ReflectionMetacognitionJournalEntry } from '../../../../src/persistence/journals/reflection-metacognition-journal.js';
import type { ReflectionDailyJournalEntry } from '../../../../src/persistence/journals/reflection-substrate.js';
import type { ReflectionTemplate } from '../../../../src/core/scheduler/reflection-policy.js';
import {
  VALID_RELATIONSHIP_TYPES as CANONICAL_RELATIONSHIP_TYPES,
  type ChannelPrivacyLevel as CanonicalChannelPrivacyLevel,
  type Contact as CanonicalContact,
  type ContactChannelIdentity as CanonicalContactChannelIdentity,
  type ContactChannelLink as CanonicalContactChannelLink,
  type ContactIdentityLinkVerification as CanonicalContactIdentityLinkVerification,
  type ContactMutationAuditEntry as CanonicalContactMutationAuditEntry,
  type RelationshipType as CanonicalRelationshipType,
  type SocialGraphEntitySource as CanonicalSocialGraphEntitySource,
  type SocialRelationshipKind as CanonicalSocialRelationshipKind,
} from '../../../../src/core/contacts/types.js';
import type { RecentContactShapeArtifact as CanonicalRecentContactShapeArtifact } from '../../../../src/faculties/memory/memory-store-port.js';
import type { MemoryWithheldSummary as CanonicalMemoryWithheldSummary } from '../../../../src/faculties/memory/withheld-summary.js';
import type { ContactConversationChannelView as CanonicalContactConversationChannelView } from '../../../../src/operator/garden/services/contact-session-linker.js';
import type { SchedulerMutationResult as CanonicalSchedulerMutationResult } from '../../../../src/operator/garden/services/scheduler-service.js';
import type {
  SubsystemHealthSnapshot as CanonicalSubsystemHealthSnapshot,
  SubsystemLaneEvent as CanonicalSubsystemLaneEvent,
  SubsystemLaneHealth as CanonicalSubsystemLaneHealth,
  SubsystemLaneOutcome as CanonicalSubsystemLaneOutcome,
  SubsystemLaneSource as CanonicalSubsystemLaneSource,
  SubsystemLaneStatus as CanonicalSubsystemLaneStatus,
} from '../../../../src/operator/garden/services/subsystem-health-service.js';
import type { AdminSessionRoleEnvelopePreview as CanonicalAdminSessionRoleEnvelopePreview } from '../../../../src/operator/garden/services/types/continuity.js';
import type { ContactUpdateResult as CanonicalContactUpdateResult } from '../../../../src/operator/garden/services/types/contacts.js';
import type {
  AdminTurnMemorySnapshotData as CanonicalAdminTurnMemorySnapshotData,
  AdminTurnSessionContextSnapshotData as CanonicalAdminTurnSessionContextSnapshotData,
  AdminTurnSnapshotData as CanonicalAdminTurnSnapshotData,
} from '../../../../src/operator/garden/services/types/prompt-loom.js';
import type { AdminSessionMessageOntologyView as CanonicalAdminSessionMessageOntologyView } from '../../../../src/operator/garden/services/types/sessions.js';
import type {
  ChannelInfo as CanonicalChannelInfo,
  CompactionAuditView as CanonicalCompactionAuditView,
} from '../../../../src/operator/garden/types.js';
import type { DiscoveredModel as CanonicalDiscoveredModel } from '../../../../src/primitives/llm/discovery.js';
import { CHANNEL_PRIVACY_VALUES } from '../../../../src/system/trust/context-envelope.js';
import {
  TRUST_LEVELS as CANONICAL_TRUST_LEVELS,
  type TrustLevel as CanonicalTrustLevel,
} from '../../../../src/system/trust/types.js';
import type {
  RuntimePromptUpdateResult as CanonicalRuntimePromptUpdateResult,
} from '../../../../src/operator/garden/services/types.js';
export type {
  AdminBiographicalClaimDetail,
  AdminBiographicalClaimList,
  AdminBiographicalClaimView,
} from '../../../../src/operator/garden/services/biographical-review-service.js';
import type {
  AuthenticityProvenance,
  ContextMessage,
  LLMProviderWireMessage,
  LLMSystemPromptTransport,
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
  DashboardModelUsageSparklinePoint,
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
  ProvenanceDestinationView,
  ProvenanceFieldStatus,
  ProvenanceSourceKind,
  ProvenanceSourceKindCount,
  ProvenanceSourceView,
  PublicationProvenanceView,
} from '../../../../src/core/cogsec/disclosure/publication-provenance.js';
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
  AdminIntakeQuarantineFirewallStatus,
  AdminIntakeQuarantineFlywheelTarget,
  AdminIntakeQuarantineItemDetail,
  AdminIntakeQuarantineItemView,
  AdminIntakeQuarantineSourceListAction,
  AdminIntakeSourceListMutationInput,
} from '../../../../src/operator/garden/services/types.js';
export type {
  FleetCogSecOverview,
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
  EffectiveModelSelectionProjection,
  EffectiveModelSelectionView,
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
} from '../../../../src/core/scheduler/reflection-policy.js';
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
  /** Owner-only aggregate; omitted for non-owner principals. */
  withheldBySubjectAuthorizationCount?: number;
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
export type ChannelInfo = CanonicalChannelInfo;

export type SessionEntry = CanonicalSessionEntry;

export type CompactionAuditView = CanonicalCompactionAuditView;

export type MemoryWithheldSummary = CanonicalMemoryWithheldSummary;

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
export type AdminTurnPromptContextSnapshotData = Omit<
  CanonicalTurnPromptContextSnapshot,
  'providerObservability'
> & {
  providerObservability?: AdminTurnProviderObservabilityData;
  renderedStaticPrefix?: string;
  renderedDynamicSuffix?: string;
  runtimeContext?: string;
  memoryContextBlock?: string;
  scratchpadContext?: string;
  assembledPrompt?: string;
  finalSystemPrompt?: string;
  messages?: AdminTurnPromptContextMessage[];
  currentTurnInput?: string;
  response?: AdminTurnPromptResponseSnapshotData;
  inputSections?: AdminPromptSectionTelemetry[];
  runtimeContextSections?: AdminPromptSectionTelemetry[];
  memoryContextSections?: AdminPromptSectionTelemetry[];
  finalSystemSections?: AdminPromptSectionTelemetry[];
  sectionCacheability?: AdminPromptSectionCacheability[];
};

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

export type AdminAdaptiveToolSnapshotData = AdaptiveToolSnapshotTelemetry;

export type AdminTurnToolContextSnapshotData = TurnToolContextSnapshot;

export type AdminTurnSessionContextSnapshotData = CanonicalAdminTurnSessionContextSnapshotData;

export type AdminTurnMemorySnapshotData = CanonicalAdminTurnMemorySnapshotData;

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

export type AdminTurnSnapshotData = Omit<CanonicalAdminTurnSnapshotData, 'promptContext'> & {
  /** Historical persisted records may carry pre-plan prompt string fields. */
  promptContext?: AdminTurnPromptContextSnapshotData;
};

export type SessionRoleEnvelopePreview = CanonicalSessionRoleEnvelopePreview;

export type AdminSessionRoleEnvelopePreview = CanonicalAdminSessionRoleEnvelopePreview;

export type AdminSessionMessageOntologyView = CanonicalAdminSessionMessageOntologyView;

// Contacts
export type ContactChannelIdentity = CanonicalContactChannelIdentity;

export type ContactChannelLink = CanonicalContactChannelLink;

export type ChannelPrivacyLevel = CanonicalChannelPrivacyLevel;

export type Contact = CanonicalContact;

export type RecentContactShapeArtifact = CanonicalRecentContactShapeArtifact;

export type ContactConversationChannelView = CanonicalContactConversationChannelView;

export type SocialGraphEntitySource = CanonicalSocialGraphEntitySource;
export type SocialRelationshipKind = CanonicalSocialRelationshipKind;

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
  recentContactShapeSummary?: string;
  recentContactShapeUpdatedAt?: number;
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
  recentContactShapeMap: Record<string, RecentContactShapeArtifact>;
  relatedChannelMap: Record<string, ContactConversationChannelView[]>;
  socialGraphMap: Record<string, AdminContactSocialGraphView>;
  relationshipScoreMap?: Record<string, AdminContactRelationshipScoreView>;
  verifications: ContactIdentityLinkVerification[];
  mutationAudits: ContactMutationAuditEntry[];
  mutationAuditQuery: unknown;
}

export type ContactUpdateResult = CanonicalContactUpdateResult;

export type TrustLevel = CanonicalTrustLevel;

export type RelationshipType = CanonicalRelationshipType;

export const TRUST_LEVELS = CANONICAL_TRUST_LEVELS;

export const RELATIONSHIP_TYPES = CANONICAL_RELATIONSHIP_TYPES;

export const CHANNEL_PRIVACY_LEVELS = CHANNEL_PRIVACY_VALUES;

export type ContactIdentityLinkVerification = CanonicalContactIdentityLinkVerification;

export type ContactMutationAuditEntry = CanonicalContactMutationAuditEntry;

// Identity
export type CharacterCardV2 = CanonicalCharacterCardV2;

export type CharacterCardHistoryEntry = CanonicalCharacterCardHistoryEntry;

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

export type PromptRegistryEntry = CanonicalPromptRegistryEntry;

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

export type RuntimePromptUpdateResult = CanonicalRuntimePromptUpdateResult;

// Models
export type DiscoveredModel = CanonicalDiscoveredModel;

// Scheduler
export type SchedulerCadenceTimezone = Extract<CanonicalRecurringCadence, { timezone: 'local' | 'utc' }>['timezone'];

export type ScheduledTask = Omit<CanonicalScheduledTask, 'handler' | 'eligibility'>;

export interface AdminSchedulerData {
  tasks: ScheduledTask[];
  reflections: ReflectionTemplate[];
}

export type SchedulerMutationResult = CanonicalSchedulerMutationResult;

// Subsystem health (background lanes)
export type SubsystemLaneOutcome = CanonicalSubsystemLaneOutcome;

export type SubsystemLaneStatus = CanonicalSubsystemLaneStatus;

export type SubsystemLaneSource = CanonicalSubsystemLaneSource;

export type SubsystemLaneEvent = CanonicalSubsystemLaneEvent;

export type SubsystemLaneHealth = CanonicalSubsystemLaneHealth;

export type SubsystemHealthSnapshot = CanonicalSubsystemHealthSnapshot;

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

/**
 * A pending confirmation, additively carrying a content-free disclosure-
 * provenance view when the entry is a publication/share candidate (jp36.7.2).
 */
export type ConfirmationQueueEntryView = ConfirmationQueueEntry & {
  disclosureProvenance?: PublicationProvenanceView;
};

export interface AdminConfirmationsData {
  entries: ConfirmationQueueEntryView[];
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
