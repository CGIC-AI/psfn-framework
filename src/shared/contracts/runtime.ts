import type { ContextManifest } from '../../core/session/context-manifest.js';
import type { CompanionPresenceMetadata, EmbodimentPresenceMetadata } from '../../core/agent/presence-metadata.js';
import type { CredentialReference } from '../../boundary/custody/credential-vault.js';
import type { TrustLevel } from '../../system/trust/types.js';
import type { ChannelPrivacy } from '../../system/trust/context-envelope.js';
import type { TurnID } from '../../core/turns/types.js';
import type { ModelContextBudgetConfig } from '../context-budget-contracts.js';
import type {
  ChargePolicyRuntimeLane,
  ChargePolicySurface,
  FatiguePolicyChannelSetting,
  FatiguePolicyIntent,
  FatiguePolicyRelationshipClass,
  FatiguePolicyState,
} from './charge-policy.js';
import type { SatelliteRoutingMetadata } from './satellite-registry.js';
import type { GatewayRoutingEnvelope } from '../routing/envelope.js';

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
  provenanceRefs?: string[];
  /** Normalized input arguments the model issued for this tool call. */
  arguments?: Record<string, unknown>;
  /** Text result returned by the tool (present once the result is observed). */
  resultText?: string;
  /** Structured result details returned by the tool, when provided. */
  details?: unknown;
  /** Assistant reasoning that accompanied the tool call, when captured. */
  rationale?: string;
  /** Provider thought signature attached to the tool call, when captured. */
  thoughtSignature?: string;
}

export interface TurnRecordVersionPointers {
  model: string;
  promptMode?: MessagePromptOverrideMode;
  promptHash?: string;
  promptStack?: string;
  memoryState?: string;
  sessionState?: string;
}

/**
 * Durable satellite/place origin recorded on a turn for long-lived history.
 * Sourced from the message's satellite routing metadata (`placeId` is the
 * static foreign key into `places.json` established by the satellite→place
 * binding). Fail-closed: the field is absent unless the turn actually carried a
 * bound `placeId`; nothing is fabricated for non-satellite turns.
 */
export interface TurnRecordLocation {
  /** Static place binding carried onto the turn (`SatelliteConfig.placeId`). */
  placeId?: string;
  /** Originating satellite, recorded alongside the place for durable provenance. */
  satelliteId?: string;
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
  /** Durable satellite/place origin; absent on non-satellite (or unbound) turns. */
  location?: TurnRecordLocation;
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

export interface GatewayRoutingMetadata extends GatewayRoutingEnvelope {}

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
  viewerChannelPrivacy?: ChannelPrivacy;
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

/**
 * E1.7: self-contained ConversationScope decision for scheduler-dispatched
 * reflection/heartbeat turns. Deliberately structural (no core/session import)
 * so the shared contract layer stays clean. A `group` hint makes the reflection
 * reflect on the ROOM: no single canonical contact is bound and continuity keys
 * become room-based. A `dm` hint (or absence) leaves reflection binding
 * byte-identical to the pre-E1.7 behavior.
 */
export type ReflectionScopeHint =
  | { kind: 'dm'; contactId: string; displayName?: string }
  | { kind: 'group'; roomId: string; roomName?: string };

export interface MessageRoutingMetadata {
  source?: 'wyoming' | 'discord' | 'api' | 'psfn-amica' | 'satellite' | 'unknown';
  /**
   * Transport-level response disposition. `observe` messages are recorded as
   * context but must not trigger model response generation or channel egress.
   */
  responseMode?: 'respond' | 'observe';
  /**
   * Provenance-honest marker that the message author is another machine
   * intelligence (peer companion/agent), sourced from CHANNEL bot/app metadata
   * (e.g. Discord `author.bot`). Consumed by author-context resolution to
   * auto-tag the contact as machine-intelligence so conversation-fatigue
   * relationship classes apply without manual tagging. Observation only ever
   * ADDS the marker; a deliberate operator/tool correction on the contact
   * (non-`system:` audit actor) is never clobbered by re-observation.
   */
  authorIsMachineIntelligence?: boolean;
  gateway?: GatewayRoutingMetadata;
  wyoming?: WyomingRoutingMetadata;
  satellite?: SatelliteRoutingMetadata;
  broadcast?: BroadcastRoutingMetadata;
  channelPrivacy?: ChannelPrivacy;
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
  /**
   * E1.7: explicit ConversationScope decision for scheduler-dispatched
   * reflection/heartbeat turns. When present with `kind: 'group'`, the turn
   * pipeline reflects on the ROOM (`roomId`), binds no single canonical contact,
   * and derives room-based continuity fallback keys. Absent (or `kind: 'dm'`)
   * leaves the existing DM/internal reflection binding byte-identical.
   */
  reflectionScope?: ReflectionScopeHint;
  workerExecution?: {
    lane: string;
    profileClass: string;
    modelPurpose: ModelPurpose;
    failClosed: boolean;
  };
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
  /** Stable per-event identity; rolling-window dedupe collapses only exact replays of the same event. */
  eventId: string;
  timestampMs: number;
  lane: ChargePolicyRuntimeLane;
  surface: ChargePolicySurface;
  amount: number;
  /** Lane quota from charge-policy.json; enforced per run and over the shared rolling 24h window. */
  quota: number;
  /** Rolling 24h lane spend after this event, shared across root runs and nested children. */
  spentAfter: number;
  /** Rolling 24h lane quota remaining after this event. */
  remainingAfter: number;
  lineage: RunChargeLineage;
  details?: Record<string, unknown>;
}

export type FatigueBudgetDecision = 'charged' | 'free' | 'overcharge';

export type FatigueBudgetReason =
  | 'machine_intelligence_response'
  | 'overcharge_recent_human_participation'
  | 'overcharge_work_intent_wrapup'
  | 'peer_not_machine_intelligence'
  | 'triggering_author_not_machine_intelligence';

export type FatigueBudgetSoftState = 'clear' | 'soft_limit_reached';

export type FatigueBudgetHardState = 'available' | 'exhausted';

export type FatigueTriggeringAuthorRole =
  | 'human'
  | 'machine_intelligence'
  | 'system'
  | 'unknown';

export interface FatigueBudgetActorSnapshot {
  role: FatigueTriggeringAuthorRole;
  contactId?: string;
  channelAuthorId?: string;
  displayName?: string;
  isMachineIntelligence?: boolean;
}

export interface FatigueBudgetPeerSnapshot {
  contactId: string;
  displayName?: string;
  channelAuthorId?: string;
  isMachineIntelligence?: boolean;
}

export interface FatigueBudgetEvent extends Partial<CorrelationMetadata> {
  timestampMs: number;
  dayKey: string;
  localCompanionId: string;
  peerContactId: string;
  channelId: string;
  triggeringAuthor: FatigueBudgetActorSnapshot;
  peer: FatigueBudgetPeerSnapshot;
  amount: number;
  decision: FatigueBudgetDecision;
  reason: FatigueBudgetReason;
  spentAfter: number;
  remainingAllowance: number;
  allowance: number;
  softLimit: number;
  normalSpentAfter?: number;
  overchargeSpentAfter?: number;
  overchargeAllowance?: number;
  remainingOvercharge?: number;
  softState: FatigueBudgetSoftState;
  hardState: FatigueBudgetHardState;
  lineage?: RunChargeLineage;
  details?: Record<string, unknown>;
}

export type FatigueEnforcementDecision =
  | 'allowed_free'
  | 'allowed_charged'
  | 'wrap_up_charged'
  | 'overcharge_charged'
  | 'suppressed_hard_exhausted';

export interface FatigueEnforcementBudgetMetadata {
  spentBefore: number;
  remainingBefore: number;
  allowance: number;
  softLimit: number;
  hardLimit: number;
  amount: number;
  spentAfterProjected: number;
  remainingAfterProjected: number;
  normalSpentBefore: number;
  normalSpentAfterProjected: number;
  overchargeSpentBefore: number;
  overchargeSpentAfterProjected: number;
  overchargeAllowance: number;
  overchargeRemainingBefore: number;
  overchargeRemainingAfterProjected: number;
}

export interface FatigueRecordedEventMetadata {
  timestampMs: number;
  amount: number;
  decision: FatigueBudgetDecision;
  reason: FatigueBudgetReason;
  spentAfter: number;
  remainingAllowance: number;
  normalSpentAfter?: number;
  overchargeSpentAfter?: number;
  overchargeAllowance?: number;
  remainingOvercharge?: number;
  softState: FatigueBudgetSoftState;
  hardState: FatigueBudgetHardState;
}

export interface FatigueEnforcementMetadata {
  schemaVersion: 1;
  decision: FatigueEnforcementDecision;
  modelDisposition: 'allowed' | 'suppressed';
  alertInjected: boolean;
  shouldRecordSpend: boolean;
  spendDecision: FatigueBudgetDecision;
  spendReason: FatigueBudgetReason;
  policyState: FatiguePolicyState;
  policyBaseState: Exclude<FatiguePolicyState, 'overcharge_eligible'>;
  intent: FatiguePolicyIntent;
  relationshipClass: FatiguePolicyRelationshipClass;
  channelSetting: FatiguePolicyChannelSetting;
  overchargeEligible: boolean;
  overchargePermitted: boolean;
  overchargeBlockedReasons: string[];
  overchargeReasons: string[];
  scope: FatigueBudgetScopeSnapshot;
  peer: FatigueBudgetPeerSnapshot;
  triggeringAuthor: FatigueBudgetActorSnapshot;
  budget: FatigueEnforcementBudgetMetadata;
  recordedEvent?: FatigueRecordedEventMetadata;
}

export interface FatigueBudgetScopeSnapshot {
  localCompanionId: string;
  peerContactId: string;
  channelId: string;
  dayKey: string;
}

export interface ResponseMetadata {
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  noReply?: IntentionalNoReplyMetadata;
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
  fatigue?: FatigueEnforcementMetadata;
}

export interface IntentionalNoReplyMetadata {
  schemaVersion: 1;
  disposition: 'intentional_no_reply';
  source: 'response_control_tool';
  auditId: string;
  decidedAt: number;
  turnId: TurnID;
  requestId?: string;
  channelId?: string;
  toolCallId?: string;
  reason?: string;
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

export type AuthenticityProvenanceKind =
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

export type AuthenticitySourceAuthor =
  | 'partner'
  | 'companion'
  | 'system'
  | 'tool'
  | 'memory'
  | 'mixed'
  | 'unknown';

export type AuthenticityTransformer =
  | 'none'
  | 'runtime'
  | 'compaction'
  | 'retrieval'
  | 'extraction'
  | 'projection'
  | 'redaction'
  | 'tool'
  | 'system';

export type AuthenticityWording = 'direct' | 'derived' | 'transformed' | 'redacted';
export type AuthenticityDetailLossRisk = 'none' | 'possible' | 'likely';
export type AuthenticityEmotionalTexture = 'preserved' | 'may_be_flattened' | 'unknown';

export interface AuthenticityProvenance {
  schemaVersion: 1;
  kind: AuthenticityProvenanceKind;
  sourceAuthor: AuthenticitySourceAuthor;
  transformedBy: AuthenticityTransformer;
  wording: AuthenticityWording;
  directSpeech: boolean;
  detailLoss: AuthenticityDetailLossRisk;
  emotionalTexture: AuthenticityEmotionalTexture;
  safeAsPartnerSpeech: boolean;
  sourceSpanCount?: number;
  sourceEntryIds?: number[];
  notes?: string[];
}

export interface ContextMessage {
  role: Role;
  content: string;
  provenance?: AuthenticityProvenance;
}

/** Scope class for a prompt block: DM contact, room/channel, or global. */
export type PromptSectionScopeClass = 'dm' | 'room' | 'global';

export type PromptSectionVolatilityClass = 'static' | 'session_stable' | 'append_only' | 'volatile';

/**
 * Per-block producer + scope labels (Loom block inspection, bead u9jo.3).
 * Distinct from `AuthenticityProvenance` (which describes source authorship /
 * authenticity of the rendered text); this describes WHICH producer emitted the
 * block and WHAT scope it was keyed to. Interim shape carried on the current
 * snapshot; a later epic replaces the plumbing but keeps this UI contract.
 */
export interface PromptSectionScopeProvenance {
  /** Producer module/function that emitted the block. */
  producer?: string;
  /** Resolved scope key: `dm:<contactId>` / `room:<channelId>` / `global`. */
  scopeKey?: string;
  /** Scope class the block was keyed to. */
  scopeClass?: PromptSectionScopeClass;
  /** Volatility / cacheability class, when determinable. */
  volatility?: PromptSectionVolatilityClass;
  /** Source data hint (e.g. core-memory scope key, memory IDs). */
  sourceHint?: string;
}

export interface PromptSectionTelemetry {
  id: string;
  title: string;
  content: string;
  charCount: number;
  tokenCount: number;
  /** Source authorship / authenticity of the rendered text. */
  provenance?: AuthenticityProvenance;
  /** Producer module + scope labels for Loom block inspection (bead u9jo.3). */
  scopeProvenance?: PromptSectionScopeProvenance;
}

export interface LLMContext {
  systemPrompt: string;
  /**
   * Ordered nonempty session-derived blocks appended to the base system
   * prompt by the session context builder (memories, compaction summaries,
   * orientation, continuity, ...). Consumed by the PromptPlan builder so the
   * plan carries the same blocks the systemPrompt string was joined from.
   */
  sessionPromptBlocks?: Array<{ id: string; content: string }>;
  messages: ContextMessage[];
  tools?: ToolSchema[];
  modelHint?: LLMModelHint;
  correlation?: CorrelationMetadata;
  manifest?: ContextManifest;
  systemPromptSections?: PromptSectionTelemetry[];
  /**
   * PromptPlan cachePlan boundaries for `systemPrompt` (E2.4). Only attached
   * when the models.json promptCaching policy is enabled; consumers verify the
   * prefix hashes before applying provider cache breakpoints.
   */
  promptCacheBoundaries?: LLMSystemPromptCacheBoundaries;
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

/**
 * Provider cache engagement mechanism resolved per request (E2.4):
 * - anthropic_cache_control: cache_control breakpoints at PromptPlan cachePlan
 *   boundaries on the anthropic-messages API.
 * - openrouter_cache_control_passthrough: cache_control breakpoints embedded in
 *   the OpenAI-completions system message parts; OpenRouter forwards them to
 *   Anthropic backends.
 * - openai_prompt_cache_key: prompt_cache_key / prompt_cache_retention params
 *   on the OpenAI responses API.
 * - implicit_prefix: no request-level knob exists for the provider; the
 *   engagement is the byte-stable static prefix itself (OpenRouter open
 *   models, local runners).
 */
export type PromptCacheMechanism =
  | 'anthropic_cache_control'
  | 'openrouter_cache_control_passthrough'
  | 'openai_prompt_cache_key'
  | 'implicit_prefix';

export interface LLMPromptCacheObservability {
  configured: boolean;
  engaged: boolean;
  strategy?: PromptCacheStrategy;
  retention?: PromptCacheRetention;
  scope?: PromptCacheScope;
  sessionId?: string;
  reason?: 'disabled' | 'missing_channel_id';
  /** Mechanism actually applied to the provider request (E2.4). */
  mechanism?: PromptCacheMechanism;
  /** cache_control breakpoints applied to the serialized system prompt. */
  appliedBreakpoints?: number;
  /** PromptPlan cachePlan boundaries projected onto the serialized system prompt. */
  boundaries?: {
    staticPrefixChars: number;
    sessionStablePrefixChars: number;
  };
  /** Provider-reported cache usage for the turn, when the provider returns it. */
  usage?: {
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
  /** Per-turn static-prefix stability check against the previous turn on the same scope. */
  prefixStability?: {
    checked: boolean;
    stable?: boolean;
    firstObservation?: boolean;
    scopeKey?: string;
    changedBlockIds?: string[];
  };
}

/**
 * PromptPlan cachePlan boundaries projected onto the serialized provider
 * system prompt (char offsets + content hashes). Carried as plain data on
 * LLMContext so the provider client — local or across the gateway RPC — can
 * verify the prefix bytes before applying provider cache breakpoints.
 * Fail-closed: a hash mismatch means the boundaries are stale and no
 * breakpoints are applied.
 */
export interface LLMSystemPromptCacheBoundaries {
  staticPrefixChars: number;
  staticPrefixHash: string;
  sessionStablePrefixChars: number;
  sessionStablePrefixHash: string;
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

/**
 * Registry-wide provider prompt-caching policy (models.json owner, E2.4).
 *
 * `enabled` is the master switch and seeds OFF: the operator flips it to true
 * after verifying cache engagement on a test channel. When disabled, no
 * provider request carries any cache parameter (zero wire change). When
 * enabled, per-provider serializers engage the mechanism the pi-ai layer
 * actually supports (Anthropic cache_control breakpoints at PromptPlan
 * boundaries, OpenRouter anthropic cache_control passthrough, OpenAI
 * responses prompt_cache_key; byte-stable-prefix-only providers get telemetry
 * without wire changes).
 *
 * `retention` ('none' | 'short' | 'long', default 'short') and `scope`
 * ('channel' | 'request', default 'channel') tune cache lifetime and the
 * session key used by providers with session-based caching.
 */
export interface ModelRegistryPromptCachingPolicy {
  enabled: boolean;
  retention?: PromptCacheRetention;
  scope?: PromptCacheScope;
}

export interface CanonicalModelRegistry {
  schemaVersion: 1;
  models: ModelRegistryEntry[];
  budgetPolicy?: ModelRegistryBudgetPolicy;
  promptCaching?: ModelRegistryPromptCachingPolicy;
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

export type ModelPurpose = 'chat' | 'background' | 'memory' | 'context' | 'reasoning' | 'longContext' | 'vision' | 'moa';
export type CompletionPurpose = 'chat' | 'background' | 'memory' | 'context' | 'extraction' | 'summary' | 'reasoning' | 'import_processing' | 'vision';
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
  'emosim_server',
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
  /**
   * Base URL of the long-lived emo_sim server (HTTP JSON API), e.g.
   * http://psfn-emosim:17342. Required when kind=emosim_server and the
   * sidecar is enabled. The emo_sim API is unauthenticated by design; it
   * must only be reachable over loopback or a cluster-internal service.
   */
  serverUrl?: string;
  /** Stable emo_sim session label. Found-or-created once; never recreated. */
  sessionLabel?: string;
  /** Stable emo_sim human-agent name representing the companion. */
  agentName?: string;
  timeoutMs?: number;
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

/**
 * Shadow trigger levers over the observer sidecar's simulated emotion state.
 * TRACKING ONLY: lever events are write-only telemetry for the Garden admin
 * surface. Nothing in the live companion loop may read or act on them.
 */
export interface ObserverEvalSidecarLeverSettings {
  enabled: boolean;
  /** Minimum ms between refires of the same lever without a full condition reset. */
  cooldownMs: number;
  wouldMessage: {
    enabled: boolean;
    socialNeedThreshold: number;
    attachmentIntensityThreshold: number;
    sustainMs: number;
  };
  wouldCheckIn: {
    enabled: boolean;
    valenceThreshold: number;
    sustainMs: number;
  };
  wouldRest: {
    enabled: boolean;
    sleepPressureThreshold: number;
    arousalThreshold: number;
    sustainMs: number;
  };
  ruminationWatch: {
    enabled: boolean;
    intensityThreshold: number;
    sustainMs: number;
  };
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
  levers?: ObserverEvalSidecarLeverSettings;
}

export interface RuntimeConfigHooks {
  refreshModels?: () => void;
  refreshCapabilities?: () => void;
  invalidatePromptPrefixCache?: (reason?: string) => void;
  persistPromotedExtendedTools?: (toolNames: readonly string[]) => void;
}

export interface Lifecycle {
  init(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}
