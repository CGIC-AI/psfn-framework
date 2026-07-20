import type { Agent, AgentMessage, AgentTool } from '../../../../boundary/pi-agent/index.js';
import type { AssistantMessage } from '@mariozechner/pi-ai';
import type { EventBus, EventMap } from '../../../../shared/event-bus.js';
import type { CostTelemetryPort } from '../../../../shared/telemetry/cost-telemetry-port.js';
import type {
  DurableRunChargeProbe,
  DurableRunChargeRecorder,
} from '../../../../shared/telemetry/run-charge.js';
import type { ComposeContext } from '../../../identity/prompt-types.js';
import type { ImageVisionReviewer } from '../../../../primitives/images/types.js';
import type { VisionIntakeImageScreenerPort } from '../vision-attachments.js';
import type { SessionManager } from '../../../session/manager.js';
import type { MetacognitiveFlag } from '../../../self-model/metacognition.js';
import type { InternalState } from '../../../self-model/state.js';
import type { SkillsRuntime } from '../../../../faculties/skills/runtime.js';
import type { TurnToolSummary } from '../../../../faculties/skills/reflection-nudge.js';
import type { ChannelMeta } from '../../../../system/trust/policy.js';
import type { TrustLevel } from '../../../../system/trust/types.js';
import type { SatellitePresencePort } from '../../satellite-adapter-port.js';
import type { CompanionPresenceTurnPort } from '../../companion-presence-runtime.js';
import type {
  AgentResponse,
  Attachment,
  CorrelationMetadata,
  InferredPostTurnAction,
  MessagePromptOverride,
  MessagePromptOverrideMode,
  ObservabilityCallType,
  ParentTurnContinuationStop,
  ResponseStyle,
  SubstrateMessage,
  TurnID,
  TurnRecord,
  TurnUsage,
} from '../../../../shared/contracts/runtime.js';
import type { CoreSubstrateConfig } from '../../../../system/config/runtime-config-contracts.js';
import type { ContextBudgetTurnCharacteristics } from '../../../../shared/context-budget.js';
import type { ObserverEvalSidecarRuntime } from '../../../eval/observer-sidecar/types.js';
import type { ContextManifest } from '../../../session/context-manifest.js';
import type { TurnObservabilityRecord } from '../../../turns/observability.js';
import type { TurnPromptSnapshot, TurnSnapshot } from '../../../turns/snapshot.js';
import type { EventBridge } from '../../event-bridge.js';
import type { RuntimeMode } from '../../tool-wiring-validator.js';
import type {
  LLMProviderPort,
  MemoryExtractor,
  MemoryProvider,
  WikiRetrievalPort,
} from '../../contracts.js';
import type { FatigueBudgetPort } from '../../fatigue/fatigue-budget.js';
import type { HumanAttentionPressurePort } from '../../fatigue/human-attention-pressure.js';
import type { IcpFatigueRegulationReservationPort } from '../../fatigue/regulation-reservation.js';
import type { AdaptiveToolRuntimeState } from '../../adaptive-tools-telemetry.js';
import type { EmotionSelfModelRuntime } from '../emotion-self-model-runtime.js';
import type {
  ParticipantRelationshipEdgeInput,
  ResolvedAuthorContext,
  UserRuntimeProfile,
} from '../runtime-context.js';
import type { ToolTurnOutcome } from '../tool-runtime-contracts.js';
import type { ApprovalQueuePort } from '../../../../system/capabilities/approval-queue-port.js';
import type { NotificationPort } from '../../../../boundary/gateway/notification-port.js';
import type { ArtifactEgressDestination } from '../../../artifacts/sensitivity-egress.js';
import type { PromptCacheTurnRuntime } from './prompt-cache-runtime.js';
import type { CompletionNoticeBuffer } from '../../completion-notices.js';
import type { SessionActorKind } from '../../../session/turn-provenance.js';
import type { ConversationScopeSpeaker } from '../../../session/conversation-scope.js';
import type { IntakeFirewallMode } from '../../../../system/config/intake-policy-config.js';
import type { ForegroundWorkLease } from '../../background-work/supervisor.js';
import type { EnqueueBackgroundWorkInput } from '../../background-work/types.js';

export interface TurnSessionIdentity {
  readonly sourceChannelId: string;
  readonly logicalSessionId: string;
}

export interface TurnExecutionRuntime {
  eventBus: EventBus;
  costTelemetry: CostTelemetryPort;
  durableChargeRecorder?: DurableRunChargeRecorder | null;
  durableChargeProbe?: DurableRunChargeProbe | null;
  fatigueBudget?: FatigueBudgetPort | null;
  humanAttentionPressure?: HumanAttentionPressurePort | null;
  fatigueRegulationReservations?: IcpFatigueRegulationReservationPort | null;
  satellitePresence: SatellitePresencePort;
  /**
   * Cross-companion presence (sprint 10, W5a). Absent/null (single-companion,
   * flag-off) skips the per-turn presence write entirely.
   */
  companionPresence?: CompanionPresenceTurnPort | null;
  llmClient: LLMProviderPort;
  imageVisionReviewer: ImageVisionReviewer | null;
  /** htm9.8 vision intake screener; null when the firewall is not wired. */
  visionIntakeScreener: VisionIntakeImageScreenerPort | null;
  cogSecMode: IntakeFirewallMode;
  sessionManager: SessionManager;
  config: CoreSubstrateConfig;
  runtimeMode: RuntimeMode;
  agent: Agent;
  bridge: EventBridge;
  systemPrompt: string;
  /** Prompt-cache directive holder + prefix-stability tracker (E2.4). */
  promptCacheRuntime: PromptCacheTurnRuntime;
  /** Ephemeral background-completion notices rendered once into the next prompt. */
  completionNotices: CompletionNoticeBuffer;
  memoryProvider: MemoryProvider | null;
  artifactApprovalQueue?: ApprovalQueuePort | null;
  artifactApprovalNotifier?: NotificationPort | null;
  shareApprovedArtifacts?: (
    attachments: readonly Attachment[],
    destination: ArtifactEgressDestination,
  ) => Promise<void>;
  memoryExtractor: MemoryExtractor | null;
  /** E8.3: supplemental wiki RAG provider; null until the projection is wired. */
  wikiRetrieval: WikiRetrievalPort | null;
  /**
   * W5b: places soft-registry threaded from startup, used to resolve the
   * companion's current site for wiki shared-world scope. Optional/undefined
   * behaves as no situated site (personal-only retrieval).
   */
  placesRegistry?: import('../../../../shared/contracts/places-registry.js').PlacesRegistryConfig | undefined;
  /**
   * Fallback situated place for a placeless turn — dual-presence aware
   * (vinz.29): a deliberate virtual `move` (vinz.26), else on mindspace
   * (plain-chat) turns the twin of the durable last-known physical room, else
   * the active physical emanation. Takes the turn message because the mode is
   * classified per turn from its routing origin. Keeps the wiki shared-world
   * scope and the mindspace presence write in lockstep with the rendered
   * situated block. Absent ⇒ turn-message resolution only.
   */
  resolveSituatedFallbackPlaceId?: (message: SubstrateMessage) => string | undefined;
  /**
   * Virtual-activity presence follow (vinz.21): evaluated once per turn on
   * the pre-turn path AFTER author/trust resolution. When the trusted partner
   * is active in a place-bound virtual companion-room the companion is not
   * present at, this pulls her virtual presence there through the same port
   * path a deliberate move uses (arrival semantics + room-entry note).
   * Never throws (the follower fails closed internally). Absent ⇒ no
   * evaluation (minimal runtimes/tests).
   */
  followVirtualRoomActivity?: (
    message: SubstrateMessage,
    author: import('../../virtual-room-follow.js').VirtualFollowAuthorContext,
  ) => Promise<void>;
  skillsRuntime: SkillsRuntime | null;
  evaluateReflectionNudge: (toolSummary: TurnToolSummary) => string | null;
  emotionSelfModelRuntime: EmotionSelfModelRuntime;
  observerEvalSidecar?: ObserverEvalSidecarRuntime | null;
  beginForegroundBackgroundWork: (logicalSessionId: string) => ForegroundWorkLease | null;
  endForegroundBackgroundWork: (lease: ForegroundWorkLease | null) => Promise<void>;
  enqueuePostTurnBackgroundWork: (
    inputs: readonly EnqueueBackgroundWorkInput[],
  ) => Promise<void>;
  resolveTaskKind: (message: SubstrateMessage) => string | undefined;
  buildTurnBudgetCharacteristics: (
    message: SubstrateMessage,
    taskKind?: string,
  ) => ContextBudgetTurnCharacteristics;
  resolveTurnCallType: (
    message: SubstrateMessage,
    taskKind: string | undefined,
  ) => ObservabilityCallType;
  buildTurnCorrelation: (
    message: SubstrateMessage,
    callType: ObservabilityCallType,
    turnId: TurnID,
    requestId: string,
  ) => CorrelationMetadata;
  withCorrelationPurpose: (
    correlation: CorrelationMetadata,
    purpose: string,
  ) => CorrelationMetadata;
  resolveAuthorContext: (message: SubstrateMessage) => Promise<ResolvedAuthorContext>;
  /**
   * E3.3 envelope derivation input: how many of the recent-speaker window's
   * distinct speakers resolve to contacts. Fail closed: lookup failures count
   * as unresolved, never resolved.
   */
  countResolvableSpeakerContacts: (
    message: SubstrateMessage,
    speakers: readonly ConversationScopeSpeaker[],
  ) => Promise<number>;
  /**
   * E4.4 orchestrator fetch: pre-prompt lookup of live, high-confidence
   * relationship edges between currently listed participants. Group turns only;
   * fails closed to an empty set. The producer renders; this never renders.
   */
  resolveParticipantRelationships: (
    message: SubstrateMessage,
    conversationScope: import('../../../session/conversation-scope.js').ConversationScope,
    trustLevel: TrustLevel,
  ) => Promise<ParticipantRelationshipEdgeInput[]>;
  emitTurnStage: (
    message: SubstrateMessage,
    turnStartMs: number,
    turnId: TurnID,
    requestId: string,
    stage: 'trust' | 'memory' | 'fatigue' | 'context' | 'first-token' | 'prompt' | 'end',
    callType: ObservabilityCallType,
    payload: Record<string, unknown>,
  ) => EventMap['agent.turn.stage'];
  recordUserMessage: (
    message: SubstrateMessage,
    turnSessionIdentity: TurnSessionIdentity,
    turnId: TurnID,
    requestId: string,
    trustLevel: TrustLevel,
    continuityUserId?: string,
    contentOverride?: string,
    actorKind?: SessionActorKind,
  ) => number | null;
  recordSystemMessage: (
    message: SubstrateMessage,
    turnSessionIdentity: TurnSessionIdentity,
    turnId: TurnID,
    requestId: string,
    content: string,
    continuityUserId?: string,
  ) => number | null;
  resolveSessionChannelId: (channelId: string) => string;
  resolveChannelType: (message: SubstrateMessage) => string | undefined;
  ensureModel: (message?: SubstrateMessage) => void;
  captureTurnPromptSnapshot: (ctx: ComposeContext) => TurnPromptSnapshot;
  captureAuthoritativeSystemPrompt?: (systemPrompt: string) => void;
  buildScratchpadContextBlock: () => string;
  normalizeTurnPromptOverride: (message: SubstrateMessage) => MessagePromptOverride;
  resolveResponseStyle: (
    message: SubstrateMessage,
    channelType: string | undefined,
    channelMeta: ChannelMeta,
  ) => ResponseStyle;
  buildPromptTemplateVariables: (
    message: SubstrateMessage,
    resolvedUserName: string,
    trustLevel: TrustLevel,
    channelType: string | undefined,
    canonicalContactKey: string | undefined,
    subjectIdentityKey: string | undefined,
    now: Date,
  ) => Record<string, string>;
  buildDynamicPromptTemplateVariables: (
    message: SubstrateMessage,
    resolvedUserName: string,
    trustLevel: TrustLevel,
    relationshipType: ResolvedAuthorContext['relationshipType'] | undefined,
    channelType: string | undefined,
    canonicalContactKey: string | undefined,
    subjectIdentityKey: string | undefined,
    responseStyle: ResponseStyle,
    now: Date,
    taskKind: string | undefined,
    templateVariables: Record<string, string>,
    internalState: InternalState,
    metacognitiveFlags: readonly MetacognitiveFlag[],
    emotionAppraisalChain: readonly import('../../../emotion/appraisal.js').EmotionAppraisalEntry[],
    currentUserRuntimeProfile: UserRuntimeProfile | undefined,
    conversationScope: import('../../../session/conversation-scope.js').ConversationScope,
    participantRelationshipEdges: readonly ParticipantRelationshipEdgeInput[],
  ) => Record<string, string>;
  setCurrentSelfModelState: (
    state: InternalState,
    snapshotRef: string,
    metacognitiveFlags: readonly MetacognitiveFlag[],
  ) => void;
  buildRuntimeContext: (
    message: SubstrateMessage,
    resolvedUserName: string,
    trustLevel: TrustLevel,
    relationshipType: ResolvedAuthorContext['relationshipType'] | undefined,
    channelType: string | undefined,
    canonicalContactKey: string | undefined,
    subjectIdentityKey: string | undefined,
    responseStyle: ResponseStyle,
    now: Date,
    taskKind: string | undefined,
    templateVariables: Record<string, string>,
    internalState: InternalState,
    metacognitiveFlags: readonly MetacognitiveFlag[],
    emotionAppraisalChain: readonly import('../../../emotion/appraisal.js').EmotionAppraisalEntry[],
    conversationScope?: import('../../../session/conversation-scope.js').ConversationScope,
  ) => string;
  buildPromptPrefixCacheKey: (
    message: SubstrateMessage,
    channelType: string | undefined,
    canonicalContactKey: string | undefined,
    subjectIdentityKey: string | undefined,
  ) => string;
  buildStaticPromptSettingsHash: (
    templateVariables: Record<string, string>,
    staticPrefixTemplate?: string,
  ) => string;
  resolveStaticPromptPrefix: (params: {
    cacheKey: string;
    staticPrefixTemplate: string;
    staticHash: string;
    settingsHash: string;
    now: Date;
    variables: Record<string, string>;
  }) => Promise<string>;
  hashPromptText: (text: string) => string;
  getPersonaAdaptation: (
    trustLevel: TrustLevel,
    internalState: InternalState,
    metacognitiveFlags: readonly MetacognitiveFlag[],
    templateVariables?: Record<string, string>,
  ) => string | null;
  resolveContextWindow: () => number;
  resolveToolTurnOutcome: (
    message: SubstrateMessage,
    taskKind: string | undefined,
  ) => ToolTurnOutcome;
  getAdaptiveToolRuntimeState: () => AdaptiveToolRuntimeState;
  getActiveTurnTools: () => readonly AgentTool<any>[];
  applyActiveToolsToAgentForTurn: (
    message: SubstrateMessage,
    taskKind: string | undefined,
    callType: ObservabilityCallType,
    correlation: CorrelationMetadata,
    toolTurnOutcome: ToolTurnOutcome,
  ) => void;
  setActiveTurnContext: (
    correlation: CorrelationMetadata,
    taskKind: string | null,
    intent: string | null,
    turnSessionIdentity: TurnSessionIdentity,
  ) => void;
  clearActiveTurnContext: () => void;
  setActiveTurnCorrelation: (correlation: CorrelationMetadata | null) => void;
  extractResponseText: () => string;
  getLatestAssistantMessage: () => AssistantMessage | null;
  accumulateTurnUsage: (messages: AgentMessage[]) => TurnUsage;
  recordToolObservations: (
    message: SubstrateMessage,
    turnSessionIdentity: TurnSessionIdentity,
    turnId: TurnID,
    requestId: string,
    turnMessages: AgentMessage[],
    trustLevel: TrustLevel,
  ) => void;
  recordAssistantMessage: (
    message: SubstrateMessage,
    turnSessionIdentity: TurnSessionIdentity,
    turnId: TurnID,
    requestId: string,
    responseText: string,
    trustLevel: TrustLevel,
    continuityUserId?: string,
    emotionSnapshot?: import('../../../emotion/state.js').EmotionStateSnapshot | null,
    recoveryResponse?: AgentResponse,
    runtimeFallbackProvenance?: import('../../../../shared/contracts/runtime.js').RuntimeFallbackProvenance,
  ) => number | null;
  buildTurnToolSummary: (turnMessages: AgentMessage[]) => TurnToolSummary;
  inferPostTurnActions: (context: {
    message: SubstrateMessage;
    response: AgentResponse;
    turnMessages: AgentMessage[];
    turnId: TurnID;
    completedAt: number;
    contextManifest?: ContextManifest;
    canonicalContactKey?: string;
  }) => Promise<InferredPostTurnAction[]>;
  buildTurnRecord: (input: {
    message: SubstrateMessage;
    turnSessionIdentity: TurnSessionIdentity;
    turnId: TurnID;
    requestId: string;
    startedAt: number;
    completedAt: number;
    userSessionEntryId: number | null;
    assistantSessionEntryId: number | null;
    response?: AgentResponse;
    model?: string;
    assistantMessageContent?: string;
    turnMessages: AgentMessage[];
    status?: TurnRecord['status'];
    continuationStop?: ParentTurnContinuationStop;
    promptMode: MessagePromptOverrideMode;
    promptText: string;
    contextMessageCount: number;
    memoryContextChars: number;
    trustLevel: TrustLevel;
    speakerRole: 'user' | 'system';
    canonicalContactKey?: string;
    retrievalProvenanceRefs: string[];
    turnSnapshot?: TurnSnapshot;
    turnObservability?: TurnObservabilityRecord;
    internalStateSnapshotRef?: string;
    persistedUserMessageContent?: string;
  }) => TurnRecord;
  emitTelemetry: (event: string, payload: Record<string, unknown>) => void;
  consumeIntentionalNoReplyDecision: (turnId: TurnID) => AgentResponse['metadata']['noReply'] | null;
  runIntentionPostTurnHooks: (context: {
    message: SubstrateMessage;
    response: AgentResponse;
    turnMessages: AgentMessage[];
    turnId: TurnID;
    completedAt: number;
    canonicalContactKey?: string;
    icpCorrelation?: import('../../../../shared/contracts/icp-autonomy.js').IcpConversationCorrelation;
  }) => Promise<void>;
}
