import type { Agent } from '@mariozechner/pi-agent-core';
import type { AssistantMessage } from '@mariozechner/pi-ai';
import type { EventBus } from '../../../shared/event-bus.js';
import type { CostTelemetryPort } from '../../../shared/telemetry/cost-telemetry-port.js';
import type { ComposeContext } from '../../identity/prompt-types.js';
import type { SessionManager } from '../../session/manager.js';
import type { MessagePromptOverride, ResponseStyle, SubstrateMessage } from '../../../shared/contracts/runtime.js';
import type { CoreSubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import type { RuntimeMode } from '../tool-wiring-validator.js';
import type { EventBridge } from '../event-bridge.js';
import type { LLMProviderPort, MemoryExtractor, MemoryProvider } from '../contracts.js';
import type { SatellitePresencePort } from '../satellite-adapter-port.js';
import type { SkillsRuntime } from '../../../faculties/skills/runtime.js';
import type { TurnToolSummary } from '../../../faculties/skills/reflection-nudge.js';
import type { TrustLevel } from '../../../system/trust/types.js';
import type { EmotionSelfModelRuntime } from './emotion-self-model-runtime.js';
import type { ResolvedAuthorContext } from './runtime-context.js';
import type { TurnExecutionRuntime } from './turn-execution-runtime.js';
import type { TurnSupportRuntime } from './turn-support-runtime.js';
import type { ToolRuntimeFacade } from './tool-runtime-facade.js';
import type { ChannelMeta } from '../../../system/trust/policy.js';
import type { InternalState } from '../../self-model/state.js';
import type { MetacognitiveFlag } from '../../self-model/metacognition.js';
import type { ContextBudgetTurnCharacteristics } from '../../../shared/context-budget.js';
import type { ImageVisionReviewer } from '../../../primitives/images/types.js';
import type { ObserverEvalSidecarRuntime } from '../../eval/observer-sidecar/types.js';
import type { FatigueBudgetPort } from '../fatigue/fatigue-budget.js';

interface TurnExecutionAdapterCallbacks {
  resolveTaskKind: (message: SubstrateMessage) => string | undefined;
  buildTurnBudgetCharacteristics: (
    message: SubstrateMessage,
    taskKind?: string,
  ) => ContextBudgetTurnCharacteristics;
  resolveAuthorContext: (message: SubstrateMessage) => Promise<ResolvedAuthorContext>;
  resolveChannelType: (message: SubstrateMessage) => string | undefined;
  ensureModel: (message?: SubstrateMessage) => void;
  captureTurnPromptSnapshot: (ctx: ComposeContext) => import('../../turns/snapshot.js').TurnPromptSnapshot;
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
  ) => string;
  buildPromptPrefixCacheKey: (
    message: SubstrateMessage,
    channelType: string | undefined,
    canonicalContactKey: string | undefined,
    subjectIdentityKey: string | undefined,
  ) => string;
  buildStaticPromptSettingsHash: (templateVariables: Record<string, string>) => string;
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
  fatigueBudget?: FatigueBudgetPort | null;
  satellitePresence: SatellitePresencePort;
  llmClient: LLMProviderPort;
  imageVisionReviewer: ImageVisionReviewer | null;
  sessionManager: SessionManager;
  config: CoreSubstrateConfig;
  runtimeMode: RuntimeMode;
  agent: Agent;
  bridge: EventBridge;
  systemPrompt: string;
  memoryProvider: MemoryProvider | null;
  memoryExtractor: MemoryExtractor | null;
  skillsRuntime: SkillsRuntime | null;
  evaluateReflectionNudge: (toolSummary: TurnToolSummary) => string | null;
  emotionSelfModelRuntime: EmotionSelfModelRuntime;
  observerEvalSidecar?: ObserverEvalSidecarRuntime | null;
  turnSupportRuntime: TurnSupportRuntime;
  toolRuntimeFacade: ToolRuntimeFacade;
  callbacks: TurnExecutionAdapterCallbacks;
}

export function createTurnExecutionRuntimeAdapter(
  options: TurnExecutionAdapterOptions,
): TurnExecutionRuntime {
  return {
    eventBus: options.eventBus,
    costTelemetry: options.costTelemetry,
    fatigueBudget: options.fatigueBudget ?? null,
    satellitePresence: options.satellitePresence,
    llmClient: options.llmClient,
    imageVisionReviewer: options.imageVisionReviewer,
    sessionManager: options.sessionManager,
    config: options.config,
    runtimeMode: options.runtimeMode,
    agent: options.agent,
    bridge: options.bridge,
    systemPrompt: options.systemPrompt,
    memoryProvider: options.memoryProvider,
    memoryExtractor: options.memoryExtractor,
    skillsRuntime: options.skillsRuntime,
    evaluateReflectionNudge: (toolSummary) => options.evaluateReflectionNudge(toolSummary),
    emotionSelfModelRuntime: options.emotionSelfModelRuntime,
    observerEvalSidecar: options.observerEvalSidecar ?? null,
    pinDeferredContinuationSessionContext: (deferredContinuationId, channelId) => options.turnSupportRuntime
      .pinDeferredContinuationSessionContext(deferredContinuationId, channelId),
    awaitPostTurnDrain: (input) => options.turnSupportRuntime.awaitPostTurnDrain(input).then(() => undefined),
    registerPostTurnBackgroundWork: (input) => options.turnSupportRuntime.registerPostTurnBackgroundWork(input),
    resolveTaskKind: (message) => options.callbacks.resolveTaskKind(message),
    buildTurnBudgetCharacteristics: (message, taskKind) => options.callbacks
      .buildTurnBudgetCharacteristics(message, taskKind),
    resolveTurnCallType: (message, taskKind) => options.turnSupportRuntime.resolveTurnCallType(message, taskKind),
    buildTurnCorrelation: (message, callType, turnId, requestId) => options.turnSupportRuntime
      .buildTurnCorrelation(message, callType, turnId, requestId),
    withCorrelationPurpose: (correlation, purpose) => options.turnSupportRuntime.withCorrelationPurpose(correlation, purpose),
    resolveAuthorContext: (message) => options.callbacks.resolveAuthorContext(message),
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
    recordUserMessage: (message, turnId, requestId, trustLevel, continuityUserId, contentOverride) => options.turnSupportRuntime
      .recordUserMessage(message, turnId, requestId, trustLevel, continuityUserId, contentOverride),
    recordSystemMessage: (message, turnId, requestId, content, continuityUserId) => options.turnSupportRuntime
      .recordSystemMessage(message, turnId, requestId, content, continuityUserId),
    resolveSessionChannelId: (channelId) => options.turnSupportRuntime.resolveSessionChannelId(channelId),
    resolveChannelType: (message) => options.callbacks.resolveChannelType(message),
    ensureModel: (message) => options.callbacks.ensureModel(message),
    captureTurnPromptSnapshot: (ctx) => options.callbacks.captureTurnPromptSnapshot(ctx),
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
    ) => options.callbacks.buildDynamicPromptTemplateVariables(
      message,
      resolvedUserName,
      trustLevel,
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
    ),
    setCurrentSelfModelState: (
      state,
      snapshotRef,
      metacognitiveFlags,
    ) => options.callbacks.setCurrentSelfModelState(state, snapshotRef, metacognitiveFlags),
    buildRuntimeContext: (
      message,
      resolvedUserName,
      trustLevel,
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
    ) => options.callbacks.buildRuntimeContext(
      message,
      resolvedUserName,
      trustLevel,
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
    ),
    buildPromptPrefixCacheKey: (message, channelType, canonicalContactKey, subjectIdentityKey) => options.callbacks
      .buildPromptPrefixCacheKey(message, channelType, canonicalContactKey, subjectIdentityKey),
    buildStaticPromptSettingsHash: (templateVariables) => options.callbacks
      .buildStaticPromptSettingsHash(templateVariables),
    resolveStaticPromptPrefix: (params) => options.callbacks.resolveStaticPromptPrefix(params),
    hashPromptText: (text) => options.callbacks.hashPromptText(text),
    getPersonaAdaptation: (trustLevel, internalState, metacognitiveFlags, templateVariables) => options.callbacks
      .getPersonaAdaptation(trustLevel, internalState, metacognitiveFlags, templateVariables),
    resolveContextWindow: () => options.callbacks.resolveContextWindow(),
    preloadExtendedToolsForTurn: (message, taskKind, correlation) => options.toolRuntimeFacade
      .preloadExtendedToolsForTurn(message, taskKind, correlation),
    getAdaptiveToolRuntimeState: () => options.toolRuntimeFacade.getAdaptiveToolRuntimeState(),
    applyActiveToolsToAgentForTurn: (
      message,
      taskKind,
      callType,
      correlation,
      autoloadOutcome,
    ) => options.toolRuntimeFacade.applyActiveToolsToAgentForTurn(
      message,
      taskKind,
      callType,
      correlation,
      autoloadOutcome,
    ),
    setActiveTurnContext: (correlation, taskKind, intent) => options.turnSupportRuntime
      .setActiveTurnContext(correlation, taskKind, intent),
    clearActiveTurnContext: () => options.turnSupportRuntime.clearActiveTurnContext(),
    setActiveTurnCorrelation: (correlation) => options.turnSupportRuntime.setActiveTurnCorrelation(correlation),
    extractResponseText: () => options.callbacks.extractResponseText(),
    getLatestAssistantMessage: () => options.callbacks.getLatestAssistantMessage(),
    accumulateTurnUsage: (messages) => options.turnSupportRuntime.accumulateTurnUsage(messages),
    recordToolObservations: (message, turnId, requestId, turnMessages, trustLevel) => options.turnSupportRuntime
      .recordToolObservations(message, turnId, requestId, turnMessages, trustLevel),
    recordAssistantMessage: (
      message,
      turnId,
      requestId,
      responseText,
      trustLevel,
      continuityUserId,
      emotionSnapshot,
    ) => options.turnSupportRuntime.recordAssistantMessage(
      message,
      turnId,
      requestId,
      responseText,
      trustLevel,
      continuityUserId,
      emotionSnapshot,
    ),
    buildTurnToolSummary: (turnMessages) => options.turnSupportRuntime.buildTurnToolSummary(turnMessages),
    inferPostTurnActions: (context) => options.turnSupportRuntime.inferPostTurnActions(context),
    buildTurnRecord: (input) => options.turnSupportRuntime.buildTurnRecord(input),
    queueBackgroundContinuationCompletion: (
      deferredContinuationId,
      message,
      response,
      taskKind,
      intent,
    ) => options.turnSupportRuntime.queueBackgroundContinuationCompletion(
      deferredContinuationId,
      message,
      response,
      taskKind,
      intent,
    ),
    emitBackgroundContinuationEvent: (
      eventName,
      payload,
    ) => options.turnSupportRuntime.emitBackgroundContinuationEvent(eventName, payload),
    dequeueBackgroundContinuationDeliveries: (deliverySessionId, limit) => options.turnSupportRuntime
      .dequeueBackgroundContinuationDeliveries(deliverySessionId, limit),
    emitTelemetry: (eventName, payload) => options.turnSupportRuntime.emitTelemetry(eventName, payload),
    consumeIntentionalNoReplyDecision: (turnId) => options.turnSupportRuntime.consumeIntentionalNoReplyDecision(turnId),
    runIntentionPostTurnHooks: (context) => options.turnSupportRuntime.runIntentionPostTurnHooks(context),
  };
}
