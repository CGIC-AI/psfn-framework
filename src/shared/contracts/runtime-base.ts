import type { RuntimeLaneClass } from './runtime-lanes.js';
import type { ContextManifest } from './context-manifest-contracts.js';
import type { CompanionPresenceMetadata, EmbodimentPresenceMetadata } from './presence-contracts.js';
import type { CredentialReference } from './credential-contracts.js';
import type { TrustLevel, ChannelPrivacy } from './trust-contracts.js';
import type { TurnID } from './turn-contracts.js';
import type { ChannelType } from './channel-types.js';
import type { InternalState, MetacognitiveFlag } from './self-model-contracts.js';
import type { ModelContextBudgetConfig } from '../context-budget-contracts.js';
import type { ToolCallOutcome } from './tool-call-outcome.js';
import type {
  ChargePolicyRuntimeLane,
  ChargePolicySurface,
  FatigueContinuationEvidence,
  FatiguePolicyChannelSetting,
  FatiguePolicyIntent,
  FatiguePolicyRelationshipClass,
  FatiguePolicyState,
  FatigueRegulationState,
} from './charge-policy.js';
import type { SatelliteRoutingMetadata } from './satellite-registry.js';
import type { GatewayRoutingEnvelope } from '../routing/envelope.js';
import type { IntakeEnvelopeSnapshot } from './intake-envelope.js';
import type { HubDeviceAttachmentSnapshot } from './hub-device-ingress.js';
import type {
  IcpConversationCorrelation,
  IcpInitiationSource,
} from './icp-autonomy.js';
import type { PlacePrivacy } from './places-registry.js';
import type {
  CompanionTouchRegion,
  CompanionTouchStimulusKind,
} from './companion-relay.js';
import type { ObservabilityCallType } from './observability-call-types.js';
export type { ObservabilityCallType } from './observability-call-types.js';

// ── Channel-agnostic message types ──

export { CHANNEL_TYPES } from './channel-types.js';
export type { ChannelType } from './channel-types.js';
export type { TurnID } from './turn-contracts.js';
export type { ModelContextBudgetConfig } from '../context-budget-contracts.js';

export type RuntimeFallbackStrategy =
  | 'runtime_nonfabricating_notice'
  // Legacy: no longer written (the datetime-contradiction guard now preserves
  // the companion's response and surfaces a system note instead). Retained as a
  // readable value so historical turn records persisted with it still normalize.
  | 'runtime_datetime_contradiction_refusal';

export interface RuntimeFallbackProvenance {
  schemaVersion: 1;
  authoredBy: 'runtime';
  model: 'runtime-fallback';
  strategy: RuntimeFallbackStrategy;
}

export interface TurnRecordMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  sessionEntryId?: number;
  sourceMessageId?: string;
  authorId?: string;
  authorName?: string;
  /** Gateway-authoritative parent message for direct reply lineage. */
  replyToMessageId?: string;
  runtimeFallbackProvenance?: RuntimeFallbackProvenance;
}

export interface TurnRecordToolCall {
  toolName: string;
  toolCallId?: string;
  /** Stable bounded result category; absent only on legacy or still-pending calls. */
  outcome?: ToolCallOutcome;
  /** Compatibility projection derived from outcome for legacy consumers. */
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
 * Durable room/satellite place origin recorded on a turn for long-lived
 * history. Fail-closed: the field is absent unless authoritative routing
 * carried a non-empty placeId.
 */
export interface TurnRecordLocation {
  /** Static place binding carried onto the turn (`SatelliteConfig.placeId`). */
  placeId?: string;
  /** Originating satellite, recorded alongside the place for durable provenance. */
  satelliteId?: string;
}

/**
 * Write-time privacy decision for later introspection auditing. The audit
 * runner never infers eligibility from legacy transcript text: only an
 * explicitly public, non-DM turn may expose verbatim content. Every other
 * shape is retained as emotional-signal-only and cannot be replayed.
 */
export interface TurnRecordAuditPrivacy {
  schemaVersion: 1;
  contentMode: 'verbatim_public' | 'emotional_signal_only';
  channelPrivacy?: ChannelPrivacy;
  contentSensitivity: 'non_intimate' | 'intimate' | 'ambiguous';
  /** Present only when the companion classified this exact current turn. */
  contentSensitivityActor?: {
    kind: 'companion';
    turnId: TurnID;
    requestId: string;
  };
  reason:
    | 'explicit_public_non_dm'
    | 'direct_message'
    | 'non_public_channel'
    | 'intimate_content'
    | 'missing_or_ambiguous_content_sensitivity'
    | 'missing_or_ambiguous_privacy';
}

export type ParentTurnContinuationStopReason =
  | 'wall_clock_limit'
  | 'prompt_entry_limit';

/** Content-free snapshot of the emergency fuse that stopped one parent turn. */
export interface ParentTurnContinuationStopSnapshot {
  schemaVersion: 1;
  reason: ParentTurnContinuationStopReason;
  promptEntries: number;
  maxPromptEntries: number;
  elapsedMs: number;
  maxWallTimeMs: number;
}

/** Durable terminal disposition added after outward partial-text detection. */
export interface ParentTurnContinuationStop extends ParentTurnContinuationStopSnapshot {
  outcome: 'failed' | 'partial';
}

export type TurnRecordBackgroundWorkKind =
  | 'memory_extraction'
  | 'intention_post_turn_hooks'
  | 'emotion_appraisal'
  | 'auto_compaction';

/**
 * Privacy-safe durable handoff descriptor for one post-turn job. Payloads are
 * validated by the background-work owner before enqueue; keeping the manifest
 * on the canonical TurnRecord makes a record-first handoff replayable after a
 * process crash without copying the raw turn into Postgres.
 */
export interface TurnRecordBackgroundWorkJob {
  jobId: string;
  idempotencyKey: string;
  logicalSessionId: string;
  kind: TurnRecordBackgroundWorkKind;
  payload: unknown;
  payloadFingerprint: string;
  sourceTurnId: string;
  sourceRequestId: string;
  sourceChannelId: string;
  createdAtMs: number;
  maxAttempts: number;
}

export interface TurnRecordBackgroundWorkHandoff {
  schemaVersion: 1;
  jobs: TurnRecordBackgroundWorkJob[];
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
  /**
   * Per-companion model selection (23pp): a models.json registry entry id
   * (catalog slot key) chosen by the companion's settings overlay. Resolved
   * fail-closed against the serving-side model registry — an unknown or
   * disabled slot key rejects the call rather than silently substituting a
   * model. Explicit `model`/`provider` hint fields take precedence over the
   * slot selection when both are present.
   */
  slotKey?: string;
}

export interface LLMCallAccountingContext {
  /** Stable identity shared by every physical attempt of one caller operation. */
  logicalCallId: string;
  /** One-based physical attempt number within the logical call. */
  attempt: number;
  /** The upstream caller owns retry/fallback sequencing for this operation. */
  retryOwner?: 'caller';
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

export type TelemetryVisibility = 'operator_visible' | 'companion_private';
export const COMPANION_PRIVATE_BACKGROUND_PURPOSE = 'companion_private.background';

export interface LLMRequestMetadata {
  companionId?: string;
  sessionId?: string;
  turnId?: string;
  requestId?: string;
  channelId?: string;
  channelType?: ChannelType;
  toolName?: string;
  toolCallId?: string;
  originType?: ObservabilityCallType;
  originStage?: string;
  /**
   * Controls whether per-call telemetry may appear on operator surfaces.
   * Companion-private work still contributes to aggregate cost accounting.
   */
  telemetryVisibility?: TelemetryVisibility;
  service?: string;
  process?: string;
  chargeLane?: ChargePolicyRuntimeLane;
  chargeSurface?: ChargePolicySurface;
  /** Exact immutable charge event that bought this provider work, when one is active. */
  chargeEventId?: string;
  chargeRunId?: string;
  chargeRootRunId?: string;
  chargeParentRunId?: string;
  shardId?: string;
  subagentId?: string;
  conversationId?: string;
  rootInitiationId?: string;
  workloadType?: string;
  workloadId?: string;
}

/**
 * Requester provenance — WHO is driving this turn, orthogonal to `viewerTrustLevel`
 * (which is a scoping label). Self-directed and system-injected turns carry a
 * high `viewerTrustLevel` ('primary') so memory/prompt scoping resolves to the
 * companion's own subject, but they have NO live human in the loop. Human-in-the-loop
 * effector gates MUST read this signal rather than trust level alone. For
 * `world.control`, unattended turns require an explicit autonomous intent and
 * audit reason and remain limited to safe registered lighting. Fail closed:
 * absence is treated as unknown provenance.
 *   - 'human'        live human speaker (speakerRole === 'user')
 *   - 'self_directed' scheduler-driven reflection (internal: channel)
 *   - 'system'       system-injected turn (system: author, e.g. deferred handoff)
 */
export const REQUESTER_PROVENANCE_VALUES = ['human', 'self_directed', 'system'] as const;
export type RequesterProvenance = typeof REQUESTER_PROVENANCE_VALUES[number];
export const REQUEST_AUDIENCE_VALUES = ['self', 'primary_contact', 'external'] as const;
export type RequestAudience = typeof REQUEST_AUDIENCE_VALUES[number];

export interface CorrelationMetadata extends LLMRequestMetadata {
  callType: ObservabilityCallType;
  purpose: string;
  viewerTrustLevel?: TrustLevel;
  /**
   * Origin of the requester driving this turn, independent of `viewerTrustLevel`.
   * Human-in-the-loop effector gates require `'human'`; self-directed/system turns
   * are refused even at `viewerTrustLevel: 'primary'`. See {@link RequesterProvenance}.
   */
  requesterProvenance?: RequesterProvenance;
  /**
   * Audience of the work product, resolved by the runtime rather than the
   * model. Absence is deliberately ambiguous and must never grant self access.
   */
  requestAudience?: RequestAudience;
  viewerChannelPrivacy?: ChannelPrivacy;
  viewerIsDirectMessage?: boolean;
  /** Canonical contact resolved at ingress for subject-authorized memory access. Never model supplied. */
  viewerMemorySubjectContactId?: string;
  /**
   * Channel-native id of the turn's originating human author (Discord user
   * snowflake / Telegram user id). Runtime-resolved from the inbound message,
   * never model supplied. Consumed where a channel-side interaction must be
   * bound back to its author — e.g. clarify delivery restricting who may answer.
   */
  viewerAuthorId?: string;
  embodimentContext?: EmbodimentPresenceMetadata;
  /** Preserved across the turn, its nested model/tool calls, and post-turn work. */
  icpCorrelation?: IcpConversationCorrelation;
}

/** Versioned allow-list shared by correlation writers and strict persisted-snapshot readers. */
export const CORRELATION_METADATA_SCHEMA_VERSION = 1;
export const CORRELATION_METADATA_KEYS = [
  'companionId',
  'sessionId',
  'turnId',
  'requestId',
  'channelId',
  'channelType',
  'toolName',
  'toolCallId',
  'originType',
  'originStage',
  'telemetryVisibility',
  'service',
  'process',
  'chargeLane',
  'chargeSurface',
  'chargeEventId',
  'chargeRunId',
  'chargeRootRunId',
  'chargeParentRunId',
  'shardId',
  'subagentId',
  'conversationId',
  'rootInitiationId',
  'workloadType',
  'workloadId',
  'callType',
  'purpose',
  'viewerTrustLevel',
  'requesterProvenance',
  'requestAudience',
  'viewerChannelPrivacy',
  'viewerIsDirectMessage',
  'viewerMemorySubjectContactId',
  'viewerAuthorId',
  'embodimentContext',
  'icpCorrelation',
] as const satisfies readonly (keyof CorrelationMetadata)[];

/**
 * E1.7: self-contained ConversationScope decision for scheduler-dispatched
 * reflection turns. Deliberately structural (no core/session import)
 * so the shared contract layer stays clean. A `group` hint makes the reflection
 * reflect on the ROOM: no single canonical contact is bound and continuity keys
 * become room-based. A `dm` hint (or absence) leaves reflection binding
 * byte-identical to the pre-E1.7 behavior.
 */
export type ReflectionScopeHint =
  | { kind: 'dm'; contactId: string; displayName?: string }
  | { kind: 'group'; roomId: string; roomName?: string };

/** Trusted, process-local ICP continuation intent. Never inferred from peer prose. */
export const ICP_CONTINUATION_TASK_KINDS = [
  'work',
  'research',
  'problem_solving',
] as const;
export type IcpContinuationTaskKind = typeof ICP_CONTINUATION_TASK_KINDS[number];

export function isIcpContinuationTaskKind(
  value: unknown,
): value is IcpContinuationTaskKind {
  return typeof value === 'string'
    && ICP_CONTINUATION_TASK_KINDS.includes(value as IcpContinuationTaskKind);
}

/**
 * Private, scheduler-authored origin for a local autonomy candidate turn.
 * This never crosses the gateway candidate projection and is never inferred
 * from candidate motivation or model prose.
 */
export interface IcpAutonomyCandidateOrigin {
  candidateId: string;
  rootInitiationId: string;
  source: IcpInitiationSource;
  provenanceRef: string;
  continuationTaskKind?: IcpContinuationTaskKind;
}

export type ReflectionTurnStage = 'tool_grounding' | 'final_output';
export type ReflectionTurnMode = 'agent' | 'deliberation';

/** Scheduler-authored provenance for assistant rows in an internal reflection session. */
export interface ReflectionTurnProvenance {
  schemaVersion: 1;
  stage: ReflectionTurnStage;
  templateId: string;
  mode: ReflectionTurnMode;
  journalEntryId?: string;
}

/** Transport-authoritative participant named by an explicit message mention. */
export interface MessageMentionTarget {
  authorId: string;
  authorName: string;
}

/**
 * Structured addressing captured by the channel adapter before content
 * normalization. Downstream cognition must prefer this evidence over prose
 * guesses about who a shared-room message addressed.
 */
export interface MessageAddressingMetadata {
  schemaVersion: 1;
  mentionedTargets: readonly MessageMentionTarget[];
}

export interface MessageRoutingMetadata {
  source?: 'wyoming' | 'discord' | 'telegram' | 'api' | 'terminal' | 'psfn-amica' | 'satellite' | 'companion' | 'companion-ui' | 'unknown';
  /**
   * Transport-level response disposition. `observe` messages are recorded as
   * context but must not trigger model response generation or channel egress.
   */
  responseMode?: 'respond' | 'observe';
  /** Channel-authoritative mentions, including mentions of other companions. */
  addressing?: MessageAddressingMetadata;
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
  /** Separate server-authored human/device provenance for Companion UI turns. */
  hubDeviceAttachment?: HubDeviceAttachmentSnapshot;
  /** Gateway-authoritative location-room classification for companion turns. */
  room?: {
    placeId: string;
    privacy: PlacePrivacy;
  };
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
  /** Server-authored physical interaction metadata; caller prose is never accepted. */
  stimulus?: {
    schemaVersion: 1;
    kind: CompanionTouchStimulusKind;
    region: CompanionTouchRegion;
    count: number;
    durationMs: number;
    deviceId: string;
  };
  /**
   * E1.7: explicit ConversationScope decision for scheduler-dispatched
   * reflection turns. When present with `kind: 'group'`, the turn
   * pipeline reflects on the ROOM (`roomId`), binds no single canonical contact,
   * and derives room-based continuity fallback keys. Absent (or `kind: 'dm'`)
   * leaves the existing DM/internal reflection binding byte-identical.
   */
  reflectionScope?: ReflectionScopeHint;
  /**
   * Scheduler-authored reflection stage. The assistant turn boundary stores it
   * in durable session/continuity metadata, while canonical journal output adds
   * its journal entry id before experiential extraction. No prose inference.
   */
  reflectionTurn?: ReflectionTurnProvenance;
  /**
   * Fully-bound ICP lineage for an ordinary companion-channel turn. The
   * gateway and target-turn entrypoint validate this before it reaches the
   * prompt/runtime. It is metadata, never a parallel dispatch path.
   */
  icpCorrelation?: IcpConversationCorrelation;
  /**
   * Inner shard lineage for an ordinary shard→parent companion turn. The
   * parent CompanionId remains the routing identity; the shard id is
   * provenance only and must never be treated as a relay peer.
   */
  shardParentIcp?: import('./shard-parent-icp.js').ShardParentIcpRoutingMetadata;
  /** Durable lineage carried by generated follow-up turns outside a live ICP channel turn. */
  originIcpRootInitiationId?: string;
  /**
   * Internal target-turn trigger: participates in prompt assembly but is not
   * persisted as partner/system transcript speech. Only valid with a strict
   * `icpCorrelation` on a companion channel.
   */
  privateTurnTrigger?: true;
  /**
   * Scheduler-owned structured intent for a private ICP target turn. This is
   * valid only with `privateTurnTrigger` and a bound ICP correlation.
   */
  icpContinuationTaskKind?: IcpContinuationTaskKind;
  /** Exact private candidate lineage for a non-recursive local autonomy turn. */
  icpAutonomyCandidate?: IcpAutonomyCandidateOrigin;
  workerExecution?: {
    lane: string;
    profileClass: string;
    modelPurpose: ModelPurpose;
    failClosed: boolean;
  };
  /**
   * htm9.1: cognition intake firewall envelope references. Point-in-time
   * snapshots of the IntakeEnvelope(s) covering this message's body and/or
   * attachments (see src/shared/contracts/intake-envelope.ts). Optional and
   * additive: adapters/gateway stamp it as the firewall epic lands (htm9.2+);
   * absence means the message predates or bypasses intake screening. The
   * envelope journal stays authoritative — this is a cheap read for sink
   * gates and prompt assembly.
   */
  intakeEnvelopes?: readonly IntakeEnvelopeSnapshot[];
  /**
   * mmo9.6.1: transport-agnostic turn-cancellation identity. Minted once at
   * voice transport ingress and threaded transport->gateway->agent so a late
   * barge-in can abort the specific in-flight model turn it names. Survives
   * serializeMessage (it is a plain string on routing). The agent registers it
   * as the active turn's id and `SubstrateAgent.cancelTurn(id)` aborts IFF the
   * active turn's id matches — a stale/mismatched id must never abort a newer
   * turn. Reused by preemptive voice control frames (mmo9.6.2/mmo9.8).
   */
  cancellationId?: string;
  /**
   * mmo9.8.3: caller-supplied UUIDv7 turn-correlation identity. A transport that
   * must correlate the agent's stamped `agent.stream.delta` turnId BEFORE the
   * turn executes (the live voice reply-stream bridge) mints a real UUIDv7 and
   * threads it here so `executeTurn` stamps THAT id on every delta instead of an
   * independently-generated one. Honored only when the turn is not bound to an
   * authoritative ICP correlation (which always wins); validated as UUIDv7 and
   * fails closed on a malformed value. Absent → the agent mints its own id as
   * before. NOT a cancellation identity — see `cancellationId` for barge-in.
   */
  turnId?: string;
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
  /** Gateway-authoritative parent message id when this message is a reply. */
  replyToMessageId?: string;
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
  | 'overcharge_explicit_peer_invitation'
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

export interface FatigueSocialRegulationMetadata {
  state: FatigueRegulationState;
  chargeLane: Extract<ChargePolicyRuntimeLane, 'interactive' | 'companion_social'>;
  relationshipPressure: number;
  rootNormalSpent: number;
  rootOverchargeSpent: number;
  contributingEventCount: number;
  marginalChargeUnits: number;
  closeoutReserveRemainingBefore: number;
  closeoutReserveRemainingAfterProjected: number;
  continuationEvidence: FatigueContinuationEvidence[];
  rootInitiationId?: string;
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
  socialRegulation: FatigueSocialRegulationMetadata;
  recordedEvent?: FatigueRecordedEventMetadata;
}

/**
 * Durable write-ahead description of the one fatigue spend owned by a turn.
 * ICP recovery can replay this operation without re-evaluating policy or
 * charging the same stable turn twice.
 */
export interface FatiguePendingSpendMetadata {
  schemaVersion: 1;
  timestampMs: number;
  decision: FatigueBudgetDecision;
  reason: FatigueBudgetReason;
  amount: number;
  scope: FatigueBudgetScopeSnapshot;
  peer: FatigueBudgetPeerSnapshot;
  triggeringAuthor: FatigueBudgetActorSnapshot;
  limits: {
    softLimit: number;
    hardLimit: number;
    overchargeLimit: number;
  };
  correlation: Partial<CorrelationMetadata>;
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
  turnId?: TurnID;
  requestId?: string;
  icpCorrelation?: IcpConversationCorrelation;
  runtimeFallbackProvenance?: RuntimeFallbackProvenance;
  noReply?: IntentionalNoReplyMetadata;
  /**
   * Transport receipt for an inbound notification handled on an asynchronous
   * channel surface. This response is never companion-authored channel output;
   * any later reply travels through the gateway's outbound send RPC.
   */
  notificationAck?: NotificationAckMetadata;
  internalState?: InternalState;
  internalStateSnapshotRef?: string;
  metacognitiveFlags?: MetacognitiveFlag[];
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
  fatiguePendingSpend?: FatiguePendingSpendMetadata;
}

export interface NotificationAckMetadata {
  schemaVersion: 1;
  disposition: 'notification_ack';
  outcome: 'forwarded_to_agent' | 'blocked_by_policy';
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
  accounting?: LLMCallAccountingContext;
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
  costEvidenceConflict?: { fields: string[] };
  raw?: Record<string, unknown>;
}

export type LLMStreamOutputKind = 'text' | 'thinking' | 'tool';

/**
 * Content-free observation captured when the provider stream yields its first
 * substantive output. A terminal completion without a streamed text,
 * thinking, or tool event does not satisfy this contract.
 */
export interface LLMStreamFirstOutputObservation {
  kind: LLMStreamOutputKind;
  monotonicAtMs: number;
  timestampMs: number;
}

export interface StreamCallbacks {
  onText?: (text: string) => void;
  onToolCall?: (name: string, input: Record<string, unknown>) => void;
  onFirstOutput?: (observation: LLMStreamFirstOutputObservation) => void;
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
  reason?: 'disabled' | 'missing_channel_id' | 'missing_companion_id';
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

/**
 * The actual provider request body captured as-sent via the pi-ai `onPayload`
 * hook (bead hgw3-80f6). This is the ground truth for the Loom "raw wire" view:
 * unlike the pre-call `providerWireMessages` reconstructions, it includes the
 * tool schemas (each serialized once), `cache_control` breakpoints, and any
 * provider-specific transforms exactly as they went over the network.
 *
 * Diet: `body` is large (full system prompt + messages + tool schemas). Live
 * captures on the event bus always carry it. The persisted turn record
 * content-addresses the body into the shared sidecar store and replaces the
 * inline `body` with `bodyRef`; the small summary fields stay inline so every
 * persisted record still attests what shipped (byte length, tool count) without
 * the bloat. Read paths resolve `bodyRef` back into `body`.
 */
export interface LLMCapturedProviderWirePayload {
  /** Provider API family the body targets (`model.api`), e.g. 'anthropic-messages'. */
  api: string;
  /** Backend model id the body was sent to. */
  model: string;
  /** Wall-clock capture time (ms). */
  capturedAtMs: number;
  /** utf-8 byte length of the JSON-serialized body exactly as sent. */
  byteLength: number;
  /** Count of tool definitions in the body — each tool serialized exactly once. */
  toolCount: number;
  /**
   * The provider request body exactly as handed to the transport, deep-cloned.
   * Present on live captures; absent on diet-slimmed persisted records, where it
   * is recoverable through `bodyRef`.
   */
  body?: unknown;
  /**
   * Content-addressed reference to the sidecar-stored body on diet-slimmed
   * persisted records. Mutually exclusive with an inline `body`; read paths
   * resolve it back before the record leaves the persistence layer.
   */
  bodyRef?: string;
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
  /**
   * Flattened provider wire capture. Live captures always carry it; SLIM
   * persisted turn snapshots omit it when the view is byte-derivable from the
   * canonical PromptPlan (bead hgw3.3). Consumers must preserve absence —
   * never coerce a missing capture to [] (the Garden read path treats absence
   * as "derive from the plan" and an empty array as "captured empty").
   */
  providerWireMessages?: LLMProviderWireMessage[];
  /**
   * The true provider wire body captured as-sent via pi-ai `onPayload`
   * (bead hgw3-80f6). Authoritative "raw wire" source for the Loom, replacing
   * the pre-call reconstructions. Absent on legacy records that predate capture.
   */
  capturedWirePayload?: LLMCapturedProviderWirePayload;
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

/**
 * Per-companion model selection (23pp): maps a canonical model purpose to the
 * models.json registry entry id (catalog slot key) the companion should lead
 * that lane with. The catalog and provider credentials stay gateway-global;
 * only the SELECTION is companion-scoped (settings.overlay.json). Absent keys
 * fall back to the registry's primary-purpose routing unchanged. The `moa`
 * purpose is not selectable here (rejected by the settings normalizer): MoA
 * model choices are owned by moaReferenceModels/moaAggregatorModel.
 */
export type ModelPurposeSelection = Partial<Record<CanonicalModelPurpose, string>>;

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
  cacheReadPer1MUsd?: number;
  cacheWritePer1MUsd?: number;
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
  /**
   * Concurrent in-flight model-call capacity the model-call gate admits for this
   * provider's shared/local endpoint. Defaults to 1 (fail-closed single slot).
   * This is admission mechanism only (Law 12.4): it bounds concurrency and
   * enables higher-priority preemption; it is not a budget or fairness system.
   */
  capacity?: number;
  /**
   * Slots (of `capacity`) reserved for foreground/interactive lanes so a
   * background model call never occupies the last slot a foreground acquire
   * would need. Defaults to 0. Clamped below `capacity` so background work is
   * never fully starved.
   */
  reservedForegroundSlots?: number;
  metadata?: Record<string, unknown>;
}

export interface CanonicalProviderRegistry {
  schemaVersion: 1;
  providers: ProviderRegistryEntry[];
}

export interface ModelRegistryEntry {
  id: string;
  enabled?: boolean;
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
 * `enabled` is the master switch and defaults ON: the shipped
 * models.seed.json sets it for fresh installs, and the registry normalizer
 * defaults an ABSENT key to enabled so registries written before caching
 * shipped are not stranded off. The operator can flip it to false to fully
 * disable provider caching — an explicit false is never overridden. When
 * disabled, no provider request carries any cache parameter (zero wire
 * change). When enabled, per-provider serializers engage the mechanism the pi-ai layer
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

export interface ModelBudgetWindowSnapshot {
  dayKey: string;
  monthKey: string;
  dailySpentUsd: number;
  dailyLimitUsd: number;
  monthlySpentUsd: number;
  monthlyLimitUsd: number;
  dailyUnknownCostAttempts: number;
  monthlyUnknownCostAttempts: number;
}

export type ModelBudgetBlockReason =
  | 'daily_budget_exceeded'
  | 'monthly_budget_exceeded'
  | 'missing_cost_metadata'
  | 'accounting_unavailable'
  | 'unknown_historical_cost';

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
/**
 * Canonical set of completion purposes. `CompletionPurpose` is derived from this
 * tuple so the runtime union and the runtime-validatable list can never drift
 * (used by the gateway RPC boundary to fail closed on a malformed wire purpose).
 */
export const COMPLETION_PURPOSES = [
  'chat',
  'background',
  'memory',
  'context',
  'extraction',
  'summary',
  'reasoning',
  'import_processing',
  'vision',
] as const;
export type CompletionPurpose = typeof COMPLETION_PURPOSES[number];

/** Runtime type guard for a wire-supplied completion purpose. Fails closed. */
export function isCompletionPurpose(value: unknown): value is CompletionPurpose {
  return typeof value === 'string'
    && (COMPLETION_PURPOSES as readonly string[]).includes(value);
}

/**
 * Retry disposition an autonomous work item declares to the LLM client.
 * - 'inherit' keeps the client's configured retry policy (current behavior).
 * - 'none' opts the work item out of client-side retries (maps to disableRetry).
 * Consumed by the client's retry wiring; carried on {@link LLMWorkSpec}.
 */
export type LLMWorkRetryPolicy = 'inherit' | 'none';

/**
 * Cancellation semantics a work item declares. The concrete AbortSignal is NOT
 * carried on the spec (specs must stay serializable across the gateway RPC
 * boundary); the caller still threads the live signal through the call options.
 * - 'caller_signal' the caller owns an AbortSignal that cancels this work.
 * - 'deadline'      the work is bounded by {@link LLMWorkSpec.deadlineMs}.
 * - 'none'          no explicit cancellation channel.
 */
export type LLMWorkCancellation = 'caller_signal' | 'deadline' | 'none';

/**
 * mmo9.7.1 — the typed superset of the ad-hoc correlation+lane every autonomous
 * LLM call previously passed piecemeal. A single declarative contract for a unit
 * of model work: its purpose, the runtime lane it belongs to, output/deadline/
 * cost ceilings, cancellation + retry disposition, whether it is durable, and
 * the correlation lineage.
 *
 * Law 12.4 (single admission/lane/budget system): `lane` is a DECLARED value the
 * client reconciles BYTE-IDENTICALLY against the existing
 * `resolveRuntimeLaneClassForModelCall`. It is NOT a second lane resolver: the
 * model-call gate keeps resolving the runtime class from correlation exactly as
 * before, and the client fails closed if a declared `lane` disagrees. Admission
 * stays the mmo9.5 ModelCallGate; budget stays the charge-unit economy. The
 * ceiling fields are consumed by mmo9.7.2 boundary accounting; `durable` /
 * `preemptionProtected` by mmo9.7.3/.7.4 welfare + anti-starvation.
 */
export interface LLMWorkSpec {
  /** Semantic completion purpose; also the value passed to the client entry. */
  purpose: CompletionPurpose;
  /**
   * Runtime lane this work belongs to. MUST equal
   * `resolveRuntimeLaneClassForModelCall(...)` for this call's correlation — a
   * declared assertion the client verifies, never a parallel resolver.
   */
  lane: RuntimeLaneClass;
  /**
   * Whether the work is durable (survives process restart via the background
   * work supervisor) or ephemeral. Consumed by mmo9.7.3.
   */
  durable: boolean;
  /** Hard cap on generated output tokens for this work item, when declared. */
  maxOutputTokens?: number;
  /** Advisory wall-clock budget in ms. Cancellation is owned by the signal. */
  deadlineMs?: number;
  /** Token ceiling declaration consulted by mmo9.7.2 accounting (not a ledger). */
  tokenCeiling?: number;
  /** Dollar ceiling declaration consulted by mmo9.7.2 accounting (not a ledger). */
  costCeilingUsd?: number;
  /** Cancellation semantics; the live AbortSignal rides the call options. */
  cancellation?: LLMWorkCancellation;
  /** Retry disposition; defaults to the client's configured policy. */
  retryPolicy?: LLMWorkRetryPolicy;
  /**
   * mmo9.7.4 welfare/anti-starvation flag. Nothing sets it true yet; carried
   * here so mmo9.7.4 consumes it without introducing a second flag.
   */
  preemptionProtected?: boolean;
  /**
   * fxt1: welfare grant proof. When `preemptionProtected` is asserted for an
   * autonomous call, this carries the background-work `jobId` whose store row
   * granted the escalation. The gateway RPC boundary re-verifies this id against
   * the background-work store (`welfare_claimed = true AND state = 'running'`,
   * companion-scoped) before honoring `preemptionProtected`; any failure strips
   * the flag (fail closed → preemptable). It is a gateway-only verification
   * token, never forwarded past the boundary. Only the sanctioned welfare path
   * (post-turn background runtime, keyed off `job.welfareClaimed`) sets it.
   */
  welfareGrantJobId?: string;
  /** Correlation lineage (companion/session/channel/charge/ICP) for this work. */
  correlation?: Partial<CorrelationMetadata>;
}
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
    /**
     * would_rest reads only mood arousal. drives.sleepPressure is deliberately
     * excluded per the oth4 operator ruling (physiological drives must not
     * drive behavior); the former sleepPressureThreshold key was removed and is
     * rejected fail-closed by the settings normalizer.
     */
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
  persistPromotedExtendedTools?: (toolNames: readonly string[]) => void | Promise<void>;
}

export interface Lifecycle {
  init(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}
