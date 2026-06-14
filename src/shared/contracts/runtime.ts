import type { ContextManifest } from '../../core/session/context-manifest.js';
import type { CompanionPresenceMetadata, EmbodimentPresenceMetadata } from '../../core/agent/presence-metadata.js';
import type { CredentialReference } from '../../boundary/custody/credential-vault.js';
import type { ChannelVisibility, TrustLevel } from '../../system/trust/types.js';
import type { TurnID } from '../../core/turns/types.js';
import type { ModelContextBudgetConfig } from '../context-budget-contracts.js';
import type {
  ChargePolicyRuntimeLane,
  ChargePolicySurface,
} from './charge-policy.js';
import type { SatelliteRoutingMetadata } from './satellite-registry.js';

// ── Channel-agnostic message types ──

export const CHANNEL_TYPES = ['discord', 'terminal', 'api', 'telegram', 'psfn-amica'] as const;
export type ChannelType = typeof CHANNEL_TYPES[number];
export type { TurnID } from '../../core/turns/types.js';
export type { ModelContextBudgetConfig } from '../context-budget-contracts.js';

export interface TurnRecordMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  sessionEntryId?: number;
  sourceMessageId?: string;
  authorId?: string;
  authorName?: string;
}

export interface TurnRecordToolCall {
  toolName: string;
  toolCallId?: string;
  isError?: boolean;
}

export interface TurnRecordVersionPointers {
  model: string;
  promptMode?: MessagePromptOverrideMode;
  promptHash?: string;
  promptStack?: string;
  memoryState?: string;
  sessionState?: string;
}

export interface TurnRecord {
  schemaVersion: 1;
  turnId: TurnID;
  requestId: string;
  channelId: string;
  channelType: ChannelType;
  startedAt: number;
  completedAt: number;
  status: 'completed' | 'failed';
  userMessage: TurnRecordMessage;
  assistantMessage?: TurnRecordMessage;
  toolCalls: TurnRecordToolCall[];
  contextManifestRef?: string;
  internalStateSnapshotRef?: string;
  extractedMemoryIds: string[];
  concernDeltaRefs: string[];
  contactDeltaRefs: string[];
  roleEnvelopeRefs?: string[];
  observability?: import('../../core/turns/observability.js').TurnObservabilityRecord;
  versionPointers: TurnRecordVersionPointers;
  provenanceRefs: string[];
}

export interface WyomingShardDelegationHint {
  eligible: boolean;
  reason: string;
}

export interface GatewayRoutingMetadata {
  schemaVersion: 1;
  companionId: string;
}

export interface WyomingRoutingMetadata {
  connectionId?: string;
  sessionId?: string;
  turnId?: string;
  siteId?: string;
  satelliteId?: string;
  presence?: CompanionPresenceMetadata;
  shardDelegation?: WyomingShardDelegationHint;
}

export interface BroadcastRoutingMetadata {
  approvalToken?: string;
  visibilityScope?: 'public_only' | 'approved_private_context';
}

export type ModelThinkingEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface ModelControlKnobs {
  maxTokens?: number;
  contextWindow?: number;
  thinkingEnabled?: boolean;
  thinkingEffort?: ModelThinkingEffort;
  temperature?: number;
  topP?: number;
  topK?: number;
  frequencyPenalty?: number;
  repetitionPenalty?: number;
}

export interface LLMModelHint extends ModelControlKnobs {
  model?: string;
  provider?: string;
  pin?: boolean;
}

export interface MessageModelOverride extends ModelControlKnobs {
  provider: string;
  model: string;
  slotKey?: string;
  purpose?: ModelPurpose;
}

export type MessagePromptOverrideMode = 'default' | 'none' | 'custom';

export interface MessagePromptOverride {
  mode: MessagePromptOverrideMode;
  systemPrompt?: string;
}

export type ResponseStyle = 'concise' | 'expressive';

export type TextEmotionDType =
  | 'auto'
  | 'fp32'
  | 'fp16'
  | 'q8'
  | 'int8'
  | 'uint8'
  | 'q4'
  | 'bnb4'
  | 'q4f16';

export interface ResponseStyleOverrides {
  exact?: Record<string, ResponseStyle>;
  prefix?: Record<string, ResponseStyle>;
  channelType?: Record<string, ResponseStyle>;
  defaultStyle?: ResponseStyle;
}

export type ObservabilityCallType =
  | 'chat'
  | 'tool'
  | 'memory'
  | 'summary'
  | 'background'
  | 'scheduled';

export interface LLMRequestMetadata {
  turnId?: string;
  requestId?: string;
  channelId?: string;
  toolName?: string;
  toolCallId?: string;
  originType?: ObservabilityCallType;
  originStage?: string;
}

export interface CorrelationMetadata extends LLMRequestMetadata {
  callType: ObservabilityCallType;
  purpose: string;
  viewerTrustLevel?: TrustLevel;
  viewerChannelVisibility?: ChannelVisibility;
  viewerIsDirectMessage?: boolean;
  embodimentContext?: EmbodimentPresenceMetadata;
}

export interface GeneratedMessageProvenanceMetadata {
  kind: 'deferred_tool_handoff';
  sourceMessageId: string;
  sourceChannelId: string;
  sourceAuthorId: string;
  sourceAuthorName: string;
}

export interface MessageRoutingMetadata {
  source?: 'wyoming' | 'discord' | 'api' | 'psfn-amica' | 'satellite' | 'unknown';
  /**
   * Transport-level response disposition. `observe` messages are recorded as
   * context but must not trigger model response generation or channel egress.
   */
  responseMode?: 'respond' | 'observe';
  gateway?: GatewayRoutingMetadata;
  wyoming?: WyomingRoutingMetadata;
  satellite?: SatelliteRoutingMetadata;
  broadcast?: BroadcastRoutingMetadata;
  channelPrivacy?: ChannelVisibility;
  modelOverride?: MessageModelOverride;
  promptOverride?: MessagePromptOverride;
  responseStyle?: ResponseStyle;
  presence?: CompanionPresenceMetadata;
  /** Trusted canonical contact ID hint. When set by an authenticated channel adapter,
   *  the agent will attempt to resolve this contact directly before falling back to
   *  channel identity resolution. Allows Garden admin chat to route to the correct
   *  contact (with nickname etc.) regardless of API auth principal identity. */
  canonicalContactId?: string;
  /** Internal provenance for generated messages so runtime handoffs do not masquerade as user-authored turns. */
  generated?: GeneratedMessageProvenanceMetadata;
}

export interface SubstrateMessage {
  id: string;
  channelId: string;
  channelType: ChannelType;
  authorId: string;
  authorName: string;
  content: string;
  attachments?: Attachment[];
  timestamp: Date;
  /** True for direct/private messages (e.g. Discord DMs). Adapters set this explicitly. */
  isDirectMessage?: boolean;
  /** Optional transport/runtime routing hints (e.g. Wyoming session policy decisions). */
  routing?: MessageRoutingMetadata;
}

export interface Attachment {
  url: string;
  contentType: string;
  name: string;
  localPath?: string;
  dataBase64?: string;
  parsedTextPath?: string;
}

export interface AgentResponse {
  content: string;
  channelId: string;
  attachments?: Attachment[];
  metadata: ResponseMetadata;
}

export interface PostTurnActionCandidate {
  kind: string;
  payload?: Record<string, unknown>;
  dedupeKey?: string;
  maxRetries?: number;
  runAt?: number;
}

export interface InferredPostTurnAction {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  dedupeKey: string;
  channelId: string;
  sourceMessageId: string;
  inferredAt: number;
  maxRetries?: number;
  runAt?: number;
}

export interface RunChargeLineage {
  runId: string;
  rootRunId: string;
  parentRunId?: string;
}

export interface RunChargeEvent extends Partial<CorrelationMetadata> {
  timestampMs: number;
  lane: ChargePolicyRuntimeLane;
  surface: ChargePolicySurface;
  amount: number;
  quota: number;
  spentAfter: number;
  remainingAfter: number;
  lineage: RunChargeLineage;
  details?: Record<string, unknown>;
}

export interface ResponseMetadata {
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  internalState?: import('../../core/self-model/state.js').InternalState;
  internalStateSnapshotRef?: string;
  metacognitiveFlags?: import('../../core/self-model/metacognition.js').MetacognitiveFlag[];
  retrievalProvenanceRefs?: string[];
  diagnostics?: {
    fallback?: {
      code: 'vision_empty_response' | 'vision_content_unavailable' | 'vision_prompt_unavailable';
      strategy: 'replay_transport_content' | 'text_only_unavailable_notice' | 'runtime_nonfabricating_notice';
      attempts: number;
      finalContentEmpty: boolean;
      previousStopReason?: string;
      previousErrorMessage?: string;
      runtimeFallbackApplied?: boolean;
    };
    runtimeContradiction?: {
      code: 'runtime_datetime_anchor_contradiction';
      anchorDetected: boolean;
      matchedSignals: string[];
      attempts: number;
      retryAttempted: boolean;
      retrySucceeded: boolean;
      refusalApplied: boolean;
    };
  };
  broadcastSafety?: {
    visibilityScope: 'public_only' | 'approved_private_context';
    operatorApproval: boolean;
    risky: boolean;
    signals: Array<'sensitive' | 'private' | 'off_brand'>;
    approvalRequired: boolean;
    provenanceRefs: string[];
  };
}

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  llmCalls: number;
  toolCalls: number;
  contextUtilization: number;
  estimatedCostUsd?: number;
}

// ── Tool system ──

/** Serializable tool schema — no execute function, safe for wire protocol */
export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// ── LLM types ──

export type Role = 'user' | 'assistant' | 'system';

export interface ContextMessage {
  role: Role;
  content: string;
}

export interface PromptSectionTelemetry {
  id: string;
  title: string;
  content: string;
  charCount: number;
  tokenCount: number;
}

export interface LLMContext {
  systemPrompt: string;
  messages: ContextMessage[];
  tools?: ToolSchema[];
  modelHint?: LLMModelHint;
  correlation?: CorrelationMetadata;
  manifest?: ContextManifest;
  systemPromptSections?: PromptSectionTelemetry[];
}

export interface LLMUsageCostDetails {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
  currency?: string;
}

export interface LLMUsageDetails {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost?: LLMUsageCostDetails;
  raw?: Record<string, unknown>;
}

export interface StreamCallbacks {
  onText?: (text: string) => void;
  onToolCall?: (name: string, input: Record<string, unknown>) => void;
  onDone?: (response: LLMResponse) => void;
  onError?: (error: Error) => void;
}

export interface LLMResponse {
  content: string;
  reasoning?: string;
  providerObservability?: LLMProviderObservability;
  toolCalls: ToolCall[];
  model: string;
  inputTokens: number;
  outputTokens: number;
  usageDetails?: LLMUsageDetails;
  stopReason: string;
}

export type LLMSystemPromptTransport =
  | 'openai_system'
  | 'openai_developer'
  | 'anthropic_system'
  | 'google_system_instruction'
  | 'system_prompt';

export interface LLMProviderWireMessage {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool' | 'system_instruction';
  source: 'system_prompt' | 'message';
  content: string;
}

export interface LLMSystemRoleCapabilityMetadata {
  transport: LLMSystemPromptTransport;
  supportsSystemRole: boolean;
  supportsDeveloperRole: boolean;
  usesOutOfBandSystemPrompt: boolean;
}

export type PromptCacheStrategy = 'openai_responses';
export type PromptCacheRetention = 'none' | 'short' | 'long';
export type PromptCacheScope = 'channel' | 'request';

export interface LLMPromptCacheObservability {
  configured: boolean;
  engaged: boolean;
  strategy?: PromptCacheStrategy;
  retention?: PromptCacheRetention;
  scope?: PromptCacheScope;
  sessionId?: string;
  reason?: 'disabled' | 'missing_channel_id';
}

export interface LLMProviderObservability {
  routeKind: 'registered_model' | 'configured_litellm_proxy' | 'request_base_url';
  requestedProvider: string;
  requestedModel: string;
  backendProvider: string;
  backendModel: string;
  backendApi: string;
  backendBaseUrl?: string;
  systemRole: LLMSystemRoleCapabilityMetadata;
  promptCaching: LLMPromptCacheObservability;
  providerWireMessages: LLMProviderWireMessage[];
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

// ── Model roster ──

export interface ModelRouteConfig {
  providerOrder?: string[];
}

export interface ModelSlot {
  model: string;
  provider: string;
  maxTokens: number;
  contextWindow?: number;
  contextBudget?: ModelContextBudgetConfig;
  routing?: ModelRouteConfig;
}

export interface ModelSlotDefaults {
  maxTokens?: number;
  contextWindow?: number;
  contextBudget?: ModelContextBudgetConfig;
  description?: string;
}

export interface ModelSlotOverrides {
  maxTokens?: number;
  contextWindow?: number;
  contextBudget?: ModelContextBudgetConfig;
}

export interface ModelCatalogEntry {
  model: string;
  provider: string;
  defaults?: ModelSlotDefaults;
  overrides?: ModelSlotOverrides;
  routing?: ModelRouteConfig;
}

export type ModelRoleAssignments = Record<string, string>;

export const CANONICAL_MODEL_PURPOSES = [
  'chat',
  'background',
  'memory',
  'extraction',
  'summary',
  'reasoning',
  'import_processing',
  'longContext',
  'vision',
  'moa',
] as const;

export type CanonicalModelPurpose = typeof CANONICAL_MODEL_PURPOSES[number];

export interface ModelRegistryPurposeTag {
  purpose: CanonicalModelPurpose;
  primary: boolean;
}

export interface ModelRegistrySourceMetadata {
  type: string;
  label?: string;
  baseUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface ModelRegistryIdentityMetadata {
  provider: string;
  model: string;
  source: ModelRegistrySourceMetadata;
  family?: string;
}

export interface ModelRegistryCapabilityMetadata {
  maxOutputTokens?: number;
  contextWindow?: number;
  supportsVision?: boolean;
  supportsReasoning?: boolean;
  supportsPromptCaching?: boolean;
  promptCacheStrategy?: PromptCacheStrategy;
  [key: string]: unknown;
}

export interface ModelRegistryTuningMetadata extends ModelControlKnobs {
  maxOutputTokens?: number;
  promptCacheRetention?: PromptCacheRetention;
  promptCacheScope?: PromptCacheScope;
  [key: string]: unknown;
}

export interface ModelRegistryCostMetadata {
  inputPer1MUsd?: number;
  outputPer1MUsd?: number;
  currency?: string;
  [key: string]: unknown;
}

export interface ModelRegistryBudgetPolicy {
  enabled: boolean;
  dailyUsdLimit: number;
  monthlyUsdLimit: number;
  currency?: 'USD';
}

export const CANONICAL_PROVIDER_TYPES = [
  'litellm_proxy',
  'openrouter',
  'openai',
  'anthropic',
  'google',
  'mistral',
  'generic_openai',
] as const;

export type CanonicalProviderType = typeof CANONICAL_PROVIDER_TYPES[number];

export interface ProviderRegistryEntry {
  id: string;
  type: CanonicalProviderType;
  enabled: boolean;
  label?: string;
  apiBaseUrl?: string;
  modelsApiUrl?: string;
  apiKeyRef?: CredentialReference;
  metadata?: Record<string, unknown>;
}

export interface CanonicalProviderRegistry {
  schemaVersion: 1;
  providers: ProviderRegistryEntry[];
}

export interface ModelRegistryEntry {
  id: string;
  rank: number;
  identity: ModelRegistryIdentityMetadata;
  purposes: ModelRegistryPurposeTag[];
  capabilities?: ModelRegistryCapabilityMetadata;
  tuning?: ModelRegistryTuningMetadata;
  cost?: ModelRegistryCostMetadata;
  metadata?: Record<string, unknown>;
}

export interface CanonicalModelRegistry {
  schemaVersion: 1;
  models: ModelRegistryEntry[];
  budgetPolicy?: ModelRegistryBudgetPolicy;
}

export interface ModelUsageLedgerRecord {
  id: string;
  timestampMs: number;
  dayKey: string;
  monthKey: string;
  provider: string;
  model: string;
  slotKey?: string;
  purpose: string;
  service: string;
  process: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export interface ModelBudgetWindowSnapshot {
  dayKey: string;
  monthKey: string;
  dailySpentUsd: number;
  dailyLimitUsd: number;
  monthlySpentUsd: number;
  monthlyLimitUsd: number;
}

export type ModelBudgetBlockReason =
  | 'daily_budget_exceeded'
  | 'monthly_budget_exceeded'
  | 'missing_cost_metadata';

export interface ModelBudgetBlockedEvent extends Partial<CorrelationMetadata> {
  timestampMs: number;
  reason: ModelBudgetBlockReason;
  purpose: string;
  provider: string;
  model: string;
  slotKey?: string;
  service: string;
  process: string;
  estimatedRequestCostUsd: number;
  budget: ModelBudgetWindowSnapshot;
}

export type ModelPurpose = 'chat' | 'background' | 'memory' | 'context' | 'reasoning' | 'longContext' | 'vision';
export type CompletionPurpose = 'background' | 'memory' | 'context' | 'extraction' | 'summary' | 'reasoning' | 'import_processing' | 'vision';
export type ImportProcessingRouteMode = 'background' | 'openrouter_zdr' | 'local_endpoint';
export const COMPOSITIONAL_PURPOSES = [
  'extraction',
  'retrieval',
  'appraisal',
  'analysis_workbench',
  'shard_context',
] as const;
export type CompositionalPurpose = typeof COMPOSITIONAL_PURPOSES[number];

export const IMPORT_PROCESSING_ROUTE_MODES: readonly ImportProcessingRouteMode[] = [
  'background',
  'openrouter_zdr',
  'local_endpoint',
];

export const OBSERVER_EVAL_SIDECAR_DEPLOYMENT_TARGETS = [
  'live',
  'eval',
  'test_persona',
] as const;
export type ObserverEvalSidecarDeploymentTarget =
  typeof OBSERVER_EVAL_SIDECAR_DEPLOYMENT_TARGETS[number];

export const OBSERVER_EVAL_SIDECAR_MODES = [
  'observe_only',
] as const;
export type ObserverEvalSidecarMode =
  typeof OBSERVER_EVAL_SIDECAR_MODES[number];

export const OBSERVER_EVAL_SIDECAR_ADAPTER_KINDS = [
  'disabled',
  'emosim',
] as const;
export type ObserverEvalSidecarAdapterKind =
  typeof OBSERVER_EVAL_SIDECAR_ADAPTER_KINDS[number];

export type ObserverEvalSidecarOverflowPolicy = 'drop_newest';

export interface ObserverEvalSidecarQueueSettings {
  maxQueuedTurns: number;
  overflowPolicy: ObserverEvalSidecarOverflowPolicy;
  observerTimeoutMs: number;
  maxRetries: number;
  retryDelayMs: number;
  shutdownDrainTimeoutMs: number;
}

export interface ObserverEvalSidecarAdapterSettings {
  kind: ObserverEvalSidecarAdapterKind;
  emosimRoot?: string;
  pythonExecutable?: string;
  timeoutMs?: number;
  deterministicSeed?: string;
  includeWorldState: boolean;
}

export interface ObserverEvalSidecarPersistenceSettings {
  enabled: boolean;
  rootDir?: string;
  retentionDays: number;
  maxStoredObservations: number;
}

export interface ObserverEvalSidecarGardenExposureSettings {
  exposeHealth: boolean;
  exposeTelemetry: boolean;
}

export interface ObserverEvalSidecarSettings {
  enabled: boolean;
  sidecarId: string;
  deploymentTarget: ObserverEvalSidecarDeploymentTarget;
  mode: ObserverEvalSidecarMode;
  queue: ObserverEvalSidecarQueueSettings;
  adapter: ObserverEvalSidecarAdapterSettings;
  persistence: ObserverEvalSidecarPersistenceSettings;
  garden: ObserverEvalSidecarGardenExposureSettings;
}

export interface RuntimeConfigHooks {
  refreshModels?: () => void;
  refreshCapabilities?: () => void;
  invalidatePromptPrefixCache?: () => void;
  persistPromotedExtendedTools?: (toolNames: readonly string[]) => void;
}

export interface Lifecycle {
  init(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}
