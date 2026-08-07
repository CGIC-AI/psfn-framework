import type { Agent } from '../../../boundary/pi-agent/index.js';
import type { AssistantMessage } from '@mariozechner/pi-ai';
import type { EventBus } from '../../../shared/event-bus.js';
import type { CostTelemetryPort } from '../../../shared/telemetry/cost-telemetry-port.js';
import type {
  DurableRunChargeProbe,
  DurableRunChargeRecorder,
} from '../../../shared/telemetry/run-charge.js';
import type { ComposeContext } from '../../identity/prompt-types.js';
import type { SessionManager } from '../../session/manager.js';
import type { MessagePromptOverride, ResponseStyle, SubstrateMessage } from '../../../shared/contracts/runtime.js';
import type { CoreSubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import type { ToolWiringValidationMode } from '../tool-wiring-validator.js';
import type { EventBridge } from '../event-bridge.js';
import type { LLMProviderPort, MemoryExtractor, MemoryProvider, WikiRetrievalPort } from '../contracts.js';
import type { SatellitePresencePort } from '../satellite-adapter-port.js';
import type { CompanionPresenceTurnPort } from '../companion-presence-runtime.js';
import type { SkillsRuntime } from '../../../faculties/skills/runtime.js';
import type { TurnToolSummary } from '../../../faculties/skills/reflection-nudge.js';
import type { TrustLevel } from '../../../system/trust/types.js';
import type { EmotionSelfModelRuntime } from './emotion-self-model-runtime.js';
import type { ParticipantRelationshipEdgeInput, ResolvedAuthorContext, UserRuntimeProfile } from './runtime-context.js';
import type { TurnAdmissionRuntime } from './turn-execution/contracts.js';
import type { PromptCacheTurnRuntime } from './turn-execution/prompt-cache-runtime.js';
import { CompletionNoticeBuffer } from '../completion-notices.js';
import type { TurnSupportRuntime } from './turn-support-runtime.js';
import type { ToolRuntimeFacade } from './tool-runtime-facade.js';
import type { ChannelMeta } from '../../../system/trust/policy.js';
import type { InternalState } from '../../self-model/state.js';
import type { MetacognitiveFlag } from '../../self-model/metacognition.js';
import type { ContextBudgetTurnCharacteristics } from '../../../shared/context-budget.js';
import type { ConversationScopeSpeaker } from '../../session/conversation-scope.js';
import type { CapturedSessionReads } from '../../session/manager/captured-session-owner.js';
import type { ImageVisionReviewer } from '../../../primitives/images/types.js';
import type { VisionIntakeImageScreenerPort } from './vision-attachments.js';
import type { ObserverEvalSidecarRuntime } from '../../eval/observer-sidecar/types.js';
import type { FatigueBudgetPort } from '../fatigue/fatigue-budget.js';
import type { HumanAttentionPressurePort } from '../fatigue/human-attention-pressure.js';
import type { IcpFatigueRegulationReservationPort } from '../fatigue/regulation-reservation.js';
import type { IntakeFirewallMode } from '../../../system/config/intake-policy-config.js';
import type { ApprovalQueuePort } from '../../../system/capabilities/approval-queue-port.js';
import type { NotificationPort } from '../../../boundary/gateway/notification-port.js';
import type { Attachment } from '../../../shared/contracts/runtime.js';
import type { ArtifactEgressDestination } from '../../artifacts/sensitivity-egress.js';
import type { DisclosureLineage } from '../../cogsec/disclosure/contracts.js';

interface TurnExecutionAdapterCallbacks {
  resolveTaskKind: (message: SubstrateMessage) => string | undefined;
  buildTurnBudgetCharacteristics: (
    message: SubstrateMessage,
    taskKind?: string,
  ) => ContextBudgetTurnCharacteristics;
  resolveAuthorContext: (message: SubstrateMessage) => Promise<ResolvedAuthorContext>;
  countResolvableSpeakerContacts: (
    message: SubstrateMessage,
    speakers: readonly ConversationScopeSpeaker[],
  ) => Promise<number>;
  resolveParticipantRelationships: (
    message: SubstrateMessage,
    conversationScope: import('../../session/conversation-scope.js').ConversationScope,
    trustLevel: TrustLevel,
  ) => Promise<ParticipantRelationshipEdgeInput[]>;
  resolveChannelType: (message: SubstrateMessage) => string | undefined;
  ensureModel: (message?: SubstrateMessage) => void;
  captureTurnPromptSnapshot: (ctx: ComposeContext) => import('../../turns/snapshot.js').TurnPromptSnapshot;
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
    emotionAppraisalChain: readonly import('../../emotion/appraisal.js').EmotionAppraisalEntry[],
    currentUserRuntimeProfile: UserRuntimeProfile | undefined,
    conversationScope: import('../../session/conversation-scope.js').ConversationScope,
    participantRelationshipEdges: readonly ParticipantRelationshipEdgeInput[],
    capturedSessionReads: CapturedSessionReads,
  ) => Promise<Record<string, string>>;
  setCurrentSelfModelState: (
    state: InternalState,
    snapshotRef: string,
    metacognitiveFlags: readonly MetacognitiveFlag[],
  ) => void;
  setCurrentTurnDisclosureLineage: (lineage: DisclosureLineage) => void;
  getCurrentTurnDisclosureLineage: () => DisclosureLineage | undefined;
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
    emotionAppraisalChain: readonly import('../../emotion/appraisal.js').EmotionAppraisalEntry[],
    conversationScope?: import('../../session/conversation-scope.js').ConversationScope,
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
  extractResponseText: () => string;
  getLatestAssistantMessage: () => AssistantMessage | null;
}

export interface TurnExecutionAdapterOptions {
  eventBus: EventBus;
  costTelemetry: CostTelemetryPort;
  durableChargeRecorder?: DurableRunChargeRecorder | null;
  durableChargeProbe?: DurableRunChargeProbe | null;
  fatigueBudget?: FatigueBudgetPort | null;
  humanAttentionPressure?: HumanAttentionPressurePort | null;
  fatigueRegulationReservations?: IcpFatigueRegulationReservationPort | null;
  satellitePresence: SatellitePresencePort;
  /** Cross-companion presence (W5a); absent/null skips presence writes. */
  companionPresence?: CompanionPresenceTurnPort | null;
  llmClient: LLMProviderPort;
  imageVisionReviewer: ImageVisionReviewer | null;
  /** htm9.8 vision intake screener; null when the firewall is not wired. */
  visionIntakeScreener: VisionIntakeImageScreenerPort | null;
  cogSecMode: IntakeFirewallMode;
  sessionManager: SessionManager;
  config: CoreSubstrateConfig;
  runtimeMode: ToolWiringValidationMode;
  agent: Agent;
  bridge: EventBridge;
  systemPrompt: string;
  memoryProvider: MemoryProvider | null;
  artifactApprovalQueue?: ApprovalQueuePort | null;
  artifactApprovalNotifier?: NotificationPort | null;
  shareApprovedArtifacts?: (
    attachments: readonly Attachment[],
    destination: ArtifactEgressDestination,
  ) => Promise<void>;
  memoryExtractor: MemoryExtractor | null;
  wikiRetrieval: WikiRetrievalPort | null;
  placesRegistry?: import('../../../shared/contracts/places-registry.js').PlacesRegistryConfig | undefined;
  /** Fallback situated place for placeless turns (dual-presence seam, vinz.29). */
  resolveSituatedFallbackPlaceId?: (message: SubstrateMessage) => string | undefined;
  /** Virtual-activity presence follow (vinz.21); absent skips the evaluation. */
  followVirtualRoomActivity?: (
    message: SubstrateMessage,
    author: import('../virtual-room-follow.js').VirtualFollowAuthorContext,
  ) => Promise<void>;
  skillsRuntime: SkillsRuntime | null;
  evaluateReflectionNudge: (toolSummary: TurnToolSummary) => string | null;
  emotionSelfModelRuntime: EmotionSelfModelRuntime;
  observerEvalSidecar?: ObserverEvalSidecarRuntime | null;
  turnSupportRuntime: TurnSupportRuntime;
  toolRuntimeFacade: ToolRuntimeFacade;
  promptCacheRuntime: PromptCacheTurnRuntime;
  completionNotices?: CompletionNoticeBuffer;
  callbacks: TurnExecutionAdapterCallbacks;
}

export function createTurnExecutionRuntimeAdapter(
  options: TurnExecutionAdapterOptions,
): TurnAdmissionRuntime {
  return {
    eventBus: options.eventBus,
    costTelemetry: options.costTelemetry,
    durableChargeRecorder: options.durableChargeRecorder ?? null,
    durableChargeProbe: options.durableChargeProbe ?? null,
    fatigueBudget: options.fatigueBudget ?? null,
    humanAttentionPressure: options.humanAttentionPressure ?? null,
    fatigueRegulationReservations: options.fatigueRegulationReservations ?? null,
    satellitePresence: options.satellitePresence,
    companionPresence: options.companionPresence ?? null,
    llmClient: options.llmClient,
    imageVisionReviewer: options.imageVisionReviewer,
    visionIntakeScreener: options.visionIntakeScreener,
    cogSecMode: options.cogSecMode,
    sessionManager: options.sessionManager,
    config: options.config,
    runtimeMode: options.runtimeMode,
    agent: options.agent,
    bridge: options.bridge,
    systemPrompt: options.systemPrompt,
    promptCacheRuntime: options.promptCacheRuntime,
    completionNotices: options.completionNotices ?? new CompletionNoticeBuffer(),
    memoryProvider: options.memoryProvider,
    artifactApprovalQueue: options.artifactApprovalQueue ?? null,
    artifactApprovalNotifier: options.artifactApprovalNotifier ?? null,
    ...(options.shareApprovedArtifacts
      ? { shareApprovedArtifacts: options.shareApprovedArtifacts }
      : {}),
    memoryExtractor: options.memoryExtractor,
    wikiRetrieval: options.wikiRetrieval,
    placesRegistry: options.placesRegistry,
    ...(options.resolveSituatedFallbackPlaceId
      ? { resolveSituatedFallbackPlaceId: options.resolveSituatedFallbackPlaceId }
      : {}),
    ...(options.followVirtualRoomActivity
      ? { followVirtualRoomActivity: options.followVirtualRoomActivity }
      : {}),
    skillsRuntime: options.skillsRuntime,
    evaluateReflectionNudge: (toolSummary) => options.evaluateReflectionNudge(toolSummary),
    emotionSelfModelRuntime: options.emotionSelfModelRuntime,
    observerEvalSidecar: options.observerEvalSidecar ?? null,
    backgroundWorkMaxAttempts: options.turnSupportRuntime.backgroundWorkMaxAttempts,
    beginForegroundBackgroundWork: (logicalSessionId) => options.turnSupportRuntime
      .beginForegroundBackgroundWork(logicalSessionId),
    endForegroundBackgroundWork: (lease) => options.turnSupportRuntime
      .endForegroundBackgroundWork(lease),
    enqueuePostTurnBackgroundWork: (inputs) => options.turnSupportRuntime
      .enqueuePostTurnBackgroundWork(inputs),
    resolveTaskKind: (message) => options.callbacks.resolveTaskKind(message),
    buildTurnBudgetCharacteristics: (message, taskKind) => options.callbacks
      .buildTurnBudgetCharacteristics(message, taskKind),
    resolveTurnCallType: (message, taskKind) => options.turnSupportRuntime.resolveTurnCallType(message, taskKind),
    buildTurnCorrelation: (message, callType, turnId, requestId, logicalSessionId) => (
      options.turnSupportRuntime.buildTurnCorrelation(
        message,
        callType,
        turnId,
        requestId,
        logicalSessionId,
      )
    ),
    withCorrelationPurpose: (correlation, purpose) => options.turnSupportRuntime.withCorrelationPurpose(correlation, purpose),
    resolveAuthorContext: (message) => options.callbacks.resolveAuthorContext(message),
    countResolvableSpeakerContacts: (message, speakers) => options.callbacks
      .countResolvableSpeakerContacts(message, speakers),
    resolveParticipantRelationships: (message, conversationScope, trustLevel) => options.callbacks
      .resolveParticipantRelationships(message, conversationScope, trustLevel),
    emitTurnStage: (
      message,
      turnStartMs,
      turnId,
      requestId,
      stage,
      callType,
      payload,
    ) => options.turnSupportRuntime.emitTurnStage(
      message,
      turnStartMs,
      turnId,
      requestId,
      stage,
      callType,
      payload,
    ),
    recordUserMessage: (
      message,
      turnSessionIdentity,
      turnId,
      requestId,
      trustLevel,
      continuityUserId,
      contentOverride,
      actorKind,
    ) => options.turnSupportRuntime.recordUserMessage(
      message,
      turnSessionIdentity,
      turnId,
      requestId,
      trustLevel,
      continuityUserId,
      contentOverride,
      actorKind,
    ),
    recordSystemMessage: (message, turnSessionIdentity, turnId, requestId, content, continuityUserId) => (
      options.turnSupportRuntime.recordSystemMessage(
        message,
        turnSessionIdentity,
        turnId,
        requestId,
        content,
        continuityUserId,
      )
    ),
    resolveChannelType: (message) => options.callbacks.resolveChannelType(message),
    ensureModel: (message) => options.callbacks.ensureModel(message),
    captureTurnPromptSnapshot: (ctx) => options.callbacks.captureTurnPromptSnapshot(ctx),
    ...(options.callbacks.captureAuthoritativeSystemPrompt
      ? {
        captureAuthoritativeSystemPrompt: (systemPrompt: string) => options.callbacks
          .captureAuthoritativeSystemPrompt?.(systemPrompt),
      }
      : {}),
    buildScratchpadContextBlock: () => options.callbacks.buildScratchpadContextBlock(),
    normalizeTurnPromptOverride: (message) => options.callbacks.normalizeTurnPromptOverride(message),
    resolveResponseStyle: (message, channelType, channelMeta) => options.callbacks
      .resolveResponseStyle(message, channelType, channelMeta),
    buildPromptTemplateVariables: (
      message,
      resolvedUserName,
      trustLevel,
      channelType,
      canonicalContactKey,
      subjectIdentityKey,
      now,
    ) => options.callbacks.buildPromptTemplateVariables(
      message,
      resolvedUserName,
      trustLevel,
      channelType,
      canonicalContactKey,
      subjectIdentityKey,
      now,
    ),
    buildDynamicPromptTemplateVariables: (
      message,
      resolvedUserName,
      trustLevel,
      relationshipType,
      channelType,
      canonicalContactKey,
      subjectIdentityKey,
      responseStyle,
      now,
      taskKind,
      templateVariables,
      internalState,
      metacognitiveFlags,
      emotionAppraisalChain,
      currentUserRuntimeProfile,
      conversationScope,
      participantRelationshipEdges,
      capturedSessionReads,
    ) => options.callbacks.buildDynamicPromptTemplateVariables(
      message,
      resolvedUserName,
      trustLevel,
      relationshipType,
      channelType,
      canonicalContactKey,
      subjectIdentityKey,
      responseStyle,
      now,
      taskKind,
      templateVariables,
      internalState,
      metacognitiveFlags,
      emotionAppraisalChain,
      currentUserRuntimeProfile,
      conversationScope,
      participantRelationshipEdges,
      capturedSessionReads,
    ),
    setCurrentSelfModelState: (
      state,
      snapshotRef,
      metacognitiveFlags,
    ) => options.callbacks.setCurrentSelfModelState(state, snapshotRef, metacognitiveFlags),
    setCurrentTurnDisclosureLineage: (lineage) =>
      options.callbacks.setCurrentTurnDisclosureLineage(lineage),
    getCurrentTurnDisclosureLineage: () =>
      options.callbacks.getCurrentTurnDisclosureLineage(),
    buildRuntimeContext: (
      message,
      resolvedUserName,
      trustLevel,
      relationshipType,
      channelType,
      canonicalContactKey,
      subjectIdentityKey,
      responseStyle,
      now,
      taskKind,
      templateVariables,
      internalState,
      metacognitiveFlags,
      emotionAppraisalChain,
      conversationScope,
    ) => options.callbacks.buildRuntimeContext(
      message,
      resolvedUserName,
      trustLevel,
      relationshipType,
      channelType,
      canonicalContactKey,
      subjectIdentityKey,
      responseStyle,
      now,
      taskKind,
      templateVariables,
      internalState,
      metacognitiveFlags,
      emotionAppraisalChain,
      conversationScope,
    ),
    buildPromptPrefixCacheKey: (message, channelType, canonicalContactKey, subjectIdentityKey) => options.callbacks
      .buildPromptPrefixCacheKey(message, channelType, canonicalContactKey, subjectIdentityKey),
    buildStaticPromptSettingsHash: (templateVariables, staticPrefixTemplate) => options.callbacks
      .buildStaticPromptSettingsHash(templateVariables, staticPrefixTemplate),
    resolveStaticPromptPrefix: (params) => options.callbacks.resolveStaticPromptPrefix(params),
    hashPromptText: (text) => options.callbacks.hashPromptText(text),
    getPersonaAdaptation: (trustLevel, internalState, metacognitiveFlags, templateVariables) => options.callbacks
      .getPersonaAdaptation(trustLevel, internalState, metacognitiveFlags, templateVariables),
    resolveContextWindow: () => options.callbacks.resolveContextWindow(),
    resolveToolTurnOutcome: (message, taskKind) => options.toolRuntimeFacade
      .resolveToolTurnOutcome(message, taskKind),
    getAdaptiveToolRuntimeState: () => options.toolRuntimeFacade.getAdaptiveToolRuntimeState(),
    getActiveTurnTools: () => options.toolRuntimeFacade.getActiveTurnTools(),
    applyActiveToolsToAgentForTurn: (
      message,
      taskKind,
      callType,
      correlation,
      toolTurnOutcome,
    ) => options.toolRuntimeFacade.applyActiveToolsToAgentForTurn(
      message,
      taskKind,
      callType,
      correlation,
      toolTurnOutcome,
    ),
    setActiveTurnContext: (correlation, taskKind, intent, turnSessionIdentity) => (
      options.turnSupportRuntime.setActiveTurnContext(
        correlation,
        taskKind,
        intent,
        turnSessionIdentity,
      )
    ),
    clearActiveTurnContext: () => options.turnSupportRuntime.clearActiveTurnContext(),
    setActiveTurnCorrelation: (correlation) => options.turnSupportRuntime.setActiveTurnCorrelation(correlation),
    extractResponseText: () => options.callbacks.extractResponseText(),
    getLatestAssistantMessage: () => options.callbacks.getLatestAssistantMessage(),
    accumulateTurnUsage: (messages) => options.turnSupportRuntime.accumulateTurnUsage(messages),
    recordToolObservations: (
      message,
      turnSessionIdentity,
      turnId,
      requestId,
      turnMessages,
      trustLevel,
    ) => options.turnSupportRuntime.recordToolObservations(
      message,
      turnSessionIdentity,
      turnId,
      requestId,
      turnMessages,
      trustLevel,
    ),
    // (returns DisclosureToolResultSource[] — arrow body already returns it)
    recordAssistantMessage: (
      message,
      turnSessionIdentity,
      turnId,
      requestId,
      responseText,
      trustLevel,
      continuityUserId,
      emotionSnapshot,
      recoveryResponse,
      runtimeFallbackProvenance,
    ) => options.turnSupportRuntime.recordAssistantMessage(
      message,
      turnSessionIdentity,
      turnId,
      requestId,
      responseText,
      trustLevel,
      continuityUserId,
      emotionSnapshot,
      recoveryResponse,
      runtimeFallbackProvenance,
    ),
    buildTurnToolSummary: (turnMessages) => options.turnSupportRuntime.buildTurnToolSummary(turnMessages),
    inferPostTurnActions: (context) => options.turnSupportRuntime.inferPostTurnActions(context),
    buildTurnRecord: (input, sessionReads) => (
      options.turnSupportRuntime.buildTurnRecord(input, sessionReads)
    ),
    emitTelemetry: (eventName, payload) => options.turnSupportRuntime.emitTelemetry(eventName, payload),
    consumeIntentionalNoReplyDecision: (turnId) => options.turnSupportRuntime.consumeIntentionalNoReplyDecision(turnId),
    runIntentionPostTurnHooks: (context) => options.turnSupportRuntime.runIntentionPostTurnHooks(context),
  };
}
