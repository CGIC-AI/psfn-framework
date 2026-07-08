import type { Agent, AgentMessage } from '@mariozechner/pi-agent-core';
import type { AssistantMessage } from '@mariozechner/pi-ai';
import { classifyBroadcastDraft } from '../../../system/trust/broadcast-safety.js';
import type { EventBus, EventMap } from '../../../shared/event-bus.js';
import type { CostTelemetryPort } from '../../../shared/telemetry/cost-telemetry-port.js';
import type { ComposeContext } from '../../identity/prompt-types.js';
import type { ImageVisionReviewer } from '../../../primitives/images/types.js';
import { resolveCompanionIdFromConfig } from '../../identity/companion-runtime.js';
import { createComponentLogger } from '../../../shared/logger.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import type { SessionManager } from '../../session/manager.js';
import {
  cloneMetacognitiveFlags,
  type MetacognitiveFlag,
} from '../../self-model/metacognition.js';
import {
  buildInternalStateSnapshotRef,
  type InternalState,
} from '../../self-model/state.js';
import type { SkillsRuntime } from '../../../faculties/skills/runtime.js';
import type { TurnToolSummary } from '../../../faculties/skills/reflection-nudge.js';
import type { ChannelMeta } from '../../../system/trust/policy.js';
import type { TrustLevel } from '../../../system/trust/types.js';
import type { SatellitePresencePort } from '../satellite-adapter-port.js';
import type { CompanionPresenceTurnPort } from '../companion-presence-runtime.js';
import type { AgentResponse, CorrelationMetadata, FatigueEnforcementMetadata, InferredPostTurnAction, MessagePromptOverride, MessagePromptOverrideMode, ObservabilityCallType, ResponseStyle, SubstrateMessage, TurnID, TurnRecord, TurnUsage } from '../../../shared/contracts/runtime.js';
import type { CoreSubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import type { ContextBudgetTurnCharacteristics } from '../../../shared/context-budget.js';
import { isTemporalContextBudgetTurn } from '../../../shared/context-budget.js';
import type { ObserverEvalSidecarRuntime } from '../../eval/observer-sidecar/types.js';
import type { ContextManifest } from '../../session/context-manifest.js';
import { createTurnId } from '../../turns/id.js';
import type { TurnObservabilityRecord } from '../../turns/observability.js';
import type {
  TurnPromptSnapshot,
  TurnSnapshot,
} from '../../turns/snapshot.js';
import {
  parseDeferredToolHandoffActionId,
} from '../deferred-tool-handoff.js';
import type { EventBridge } from '../event-bridge.js';
import type { RuntimeMode } from '../tool-wiring-validator.js';
import type { LLMProviderPort, MemoryExtractor, MemoryProvider, WikiRetrievalPort } from '../contracts.js';
import type { FatigueBudgetPort } from '../fatigue/fatigue-budget.js';
import {
  attachRecordedFatigueEvent,
  evaluateFatigueForTurn,
  type FatigueRecentHumanParticipation,
  type FatigueTurnDecision,
} from '../fatigue/runtime-enforcement.js';
import type { AdaptiveToolRuntimeState } from '../adaptive-tools-telemetry.js';
import type { EmotionSelfModelRuntime } from './emotion-self-model-runtime.js';
import type { ParticipantRelationshipEdgeInput, ResolvedAuthorContext, UserRuntimeProfile } from './runtime-context.js';
import type { AutoloadTurnOutcome } from './adaptive-tools-runtime.js';
import type {
  BackgroundContinuationCompletionSignal,
  PendingBackgroundContinuationDelivery,
} from './background-continuation-runtime.js';
import {
  resolveRuntimeLaneClassForTurn,
} from '../worker-lanes.js';
import { runWithPaidDeliverableTracking } from '../../../shared/paid-deliverable-tracking.js';
import { summarizeChargedImageDeliverables } from '../../../primitives/images/generated-media.js';
import { invokeAgentForTurn, type AgentInvocationMutableState } from './turn-execution/agent-invocation.js';
import { createTurnExecutionObservability } from './turn-execution/observability.js';
import { assembleTurnPrompt } from './turn-execution/prompt-assembly.js';
import type { PromptCacheTurnRuntime } from './turn-execution/prompt-cache-runtime.js';
import type { CompletionNoticeBuffer } from '../completion-notices.js';
import { computePreTurnState, prepareTurnIdentityState } from './turn-execution/pre-turn-state.js';
import {
  collectTurnResponseAttachments,
  schedulePostTurnWork,
} from './turn-execution/post-turn-scheduling.js';
import { hasVisionTurnInputs } from './vision-attachments.js';
import type { SessionEntry } from '../../session/types.js';
import type { ConversationScopeSpeaker } from '../../session/conversation-scope.js';

const log = createComponentLogger('SubstrateAgent');

function cloneComputedInternalStateForResponse(internalState: InternalState): InternalState {
  return JSON.parse(JSON.stringify(internalState)) as InternalState;
}

export interface TurnExecutionRuntime {
  eventBus: EventBus;
  costTelemetry: CostTelemetryPort;
  fatigueBudget?: FatigueBudgetPort | null;
  satellitePresence: SatellitePresencePort;
  /**
   * Cross-companion presence (sprint 10, W5a). Absent/null (single-companion,
   * flag-off) skips the per-turn presence write entirely.
   */
  companionPresence?: CompanionPresenceTurnPort | null;
  llmClient: LLMProviderPort;
  imageVisionReviewer: ImageVisionReviewer | null;
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
  memoryExtractor: MemoryExtractor | null;
  /** E8.3: supplemental wiki RAG provider; null until the projection is wired. */
  wikiRetrieval: WikiRetrievalPort | null;
  skillsRuntime: SkillsRuntime | null;
  evaluateReflectionNudge: (toolSummary: TurnToolSummary) => string | null;
  emotionSelfModelRuntime: EmotionSelfModelRuntime;
  observerEvalSidecar?: ObserverEvalSidecarRuntime | null;
  pinDeferredContinuationSessionContext: (
    deferredContinuationId: string | null,
    channelId: string,
  ) => () => void;
  awaitPostTurnDrain: (input: {
    channelId: string;
    turnId: TurnID;
    requestId: string;
    correlation: CorrelationMetadata;
  }) => Promise<void>;
  registerPostTurnBackgroundWork: (input: {
    channelId: string;
    turnId: TurnID;
    requestId: string;
    work: ReadonlyArray<{ name: string; promise: Promise<unknown> }>;
    correlation: CorrelationMetadata;
  }) => void;
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
    conversationScope: import('../../session/conversation-scope.js').ConversationScope,
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
    turnId: TurnID,
    requestId: string,
    trustLevel: TrustLevel,
    continuityUserId?: string,
    contentOverride?: string,
  ) => number | null;
  recordSystemMessage: (
    message: SubstrateMessage,
    turnId: TurnID,
    requestId: string,
    content: string,
    continuityUserId?: string,
  ) => number | null;
  resolveSessionChannelId: (channelId: string) => string;
  resolveChannelType: (message: SubstrateMessage) => string | undefined;
  ensureModel: (message?: SubstrateMessage) => void;
  captureTurnPromptSnapshot: (ctx: ComposeContext) => TurnPromptSnapshot;
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
  preloadExtendedToolsForTurn: (
    message: SubstrateMessage,
    taskKind: string | undefined,
    correlation: CorrelationMetadata,
  ) => AutoloadTurnOutcome;
  getAdaptiveToolRuntimeState: () => AdaptiveToolRuntimeState;
  applyActiveToolsToAgentForTurn: (
    message: SubstrateMessage,
    taskKind: string | undefined,
    callType: ObservabilityCallType,
    correlation: CorrelationMetadata,
    autoloadOutcome: AutoloadTurnOutcome,
  ) => void;
  setActiveTurnContext: (
    correlation: CorrelationMetadata,
    taskKind: string | null,
    intent: string | null,
  ) => void;
  clearActiveTurnContext: () => void;
  setActiveTurnCorrelation: (correlation: CorrelationMetadata | null) => void;
  extractResponseText: () => string;
  getLatestAssistantMessage: () => AssistantMessage | null;
  accumulateTurnUsage: (messages: AgentMessage[]) => TurnUsage;
  recordToolObservations: (
    message: SubstrateMessage,
    turnId: TurnID,
    requestId: string,
    turnMessages: AgentMessage[],
    trustLevel: TrustLevel,
  ) => void;
  recordAssistantMessage: (
    message: SubstrateMessage,
    turnId: TurnID,
    requestId: string,
    responseText: string,
    trustLevel: TrustLevel,
    continuityUserId?: string,
    emotionSnapshot?: import('../../emotion/state.js').EmotionStateSnapshot | null,
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
  queueBackgroundContinuationCompletion: (
    deferredContinuationId: string,
    message: SubstrateMessage,
    response: AgentResponse,
    taskKind: string | null,
    intent: string | null,
  ) => BackgroundContinuationCompletionSignal;
  emitBackgroundContinuationEvent: (
    eventName: 'agent.background.continuation.completed' | 'agent.background.continuation.post_turn_delivery',
    payload: Record<string, unknown>,
  ) => Promise<void>;
  dequeueBackgroundContinuationDeliveries: (
    deliverySessionId: string,
    limit?: number,
  ) => PendingBackgroundContinuationDelivery[];
  emitTelemetry: (event: string, payload: Record<string, unknown>) => void;
  consumeIntentionalNoReplyDecision: (turnId: TurnID) => AgentResponse['metadata']['noReply'] | null;
  runIntentionPostTurnHooks: (context: {
    message: SubstrateMessage;
    response: AgentResponse;
    turnMessages: AgentMessage[];
    turnId: TurnID;
    completedAt: number;
    canonicalContactKey?: string;
  }) => Promise<void>;
}

function summarizeFatigue(metadata: FatigueEnforcementMetadata): Record<string, unknown> {
  return {
    decision: metadata.decision,
    modelDisposition: metadata.modelDisposition,
    alertInjected: metadata.alertInjected,
    shouldRecordSpend: metadata.shouldRecordSpend,
    policyState: metadata.policyState,
    policyBaseState: metadata.policyBaseState,
    spendDecision: metadata.spendDecision,
    spendReason: metadata.spendReason,
    overchargeEligible: metadata.overchargeEligible,
    overchargePermitted: metadata.overchargePermitted,
    overchargeReasons: metadata.overchargeReasons,
    overchargeBlockedReasons: metadata.overchargeBlockedReasons,
    scope: metadata.scope,
    budget: metadata.budget,
  };
}

function evaluateRuntimeFatigue(input: {
  runtime: TurnExecutionRuntime;
  message: SubstrateMessage;
  authorContext: ResolvedAuthorContext;
  channelType: string | undefined;
  channelMeta: ChannelMeta;
  taskKind: string | undefined;
  turnCorrelationBase: CorrelationMetadata;
  timestampMs: number;
}): FatigueTurnDecision | null {
  if (!input.runtime.fatigueBudget) {
    return null;
  }
  const fatiguePolicy = input.runtime.config.chargePolicy?.fatigue;
  if (!fatiguePolicy) {
    throw new Error('Fatigue enforcement requires chargePolicy.fatigue when fatigueBudget is wired');
  }
  return evaluateFatigueForTurn({
    fatigueBudget: input.runtime.fatigueBudget,
    fatiguePolicy,
    localCompanionId: resolveCompanionIdFromConfig(input.runtime.config),
    message: input.message,
    authorContext: input.authorContext,
    channelId: input.runtime.resolveSessionChannelId(input.message.channelId),
    channelType: input.channelType,
    channelMeta: input.channelMeta,
    taskKind: input.taskKind,
    recentHumanParticipation: resolveRecentHumanParticipationForFatigue({
      runtime: input.runtime,
      message: input.message,
      authorContext: input.authorContext,
      sessionChannelId: input.runtime.resolveSessionChannelId(input.message.channelId),
      nowMs: input.timestampMs,
      windowMs: fatiguePolicy.overcharge.recentHumanParticipationWindowMs,
    }),
    timestampMs: input.timestampMs,
    correlation: input.runtime.withCorrelationPurpose(input.turnCorrelationBase, 'agent.fatigue.evaluate'),
  });
}

function resolveRecentHumanParticipationForFatigue(input: {
  runtime: TurnExecutionRuntime;
  message: SubstrateMessage;
  authorContext: ResolvedAuthorContext;
  sessionChannelId: string;
  nowMs: number;
  windowMs: number;
}): FatigueRecentHumanParticipation {
  const participants = new Set<string>();
  let messageCount = 0;
  let latestHumanTimestampMs: number | undefined;
  const addHumanMessage = (entry: Pick<SessionEntry, 'authorId' | 'authorName' | 'timestamp'>): void => {
    if (!Number.isFinite(entry.timestamp) || entry.timestamp > input.nowMs) {
      return;
    }
    const ageMs = input.nowMs - entry.timestamp;
    if (ageMs < 0 || ageMs > input.windowMs) {
      return;
    }
    messageCount += 1;
    participants.add(entry.authorId?.trim() || entry.authorName?.trim() || 'unknown-human');
    latestHumanTimestampMs = latestHumanTimestampMs === undefined
      ? entry.timestamp
      : Math.max(latestHumanTimestampMs, entry.timestamp);
  };

  if (
    input.authorContext.speakingWithIsMachineIntelligence !== true
    && input.authorContext.speakerRole !== 'system'
  ) {
    addHumanMessage({
      authorId: input.message.authorId,
      authorName: input.message.authorName,
      timestamp: input.nowMs,
    });
  }

  for (const entry of input.runtime.sessionManager.getRecentMessages(input.sessionChannelId, 32)) {
    if (entry.role !== 'user') {
      continue;
    }
    if (entry.authorId && entry.authorId === input.message.authorId) {
      continue;
    }
    addHumanMessage(entry);
  }

  return {
    messageCount,
    participantCount: participants.size,
    ...(latestHumanTimestampMs !== undefined
      ? { latestMessageAgeMs: input.nowMs - latestHumanTimestampMs }
      : {}),
  };
}

function emitFatigueDecision(input: {
  runtime: TurnExecutionRuntime;
  message: SubstrateMessage;
  turnCorrelationBase: CorrelationMetadata;
  fatigueDecision: FatigueTurnDecision;
  observability: Pick<ReturnType<typeof createTurnExecutionObservability>, 'emitObservedTurnStage'>;
}): void {
  const telemetry = summarizeFatigue(input.fatigueDecision.metadata);
  input.observability.emitObservedTurnStage('fatigue', telemetry);
  input.runtime.emitTelemetry('agent.fatigue.decision', {
    channelId: input.message.channelId,
    ...telemetry,
    ...input.runtime.withCorrelationPurpose(input.turnCorrelationBase, 'agent.fatigue.decision'),
  });
  if (input.fatigueDecision.suppressModel) {
    log.info('Suppressed machine-intelligence turn at fatigue hard cap', {
      channelId: input.message.channelId,
      ...telemetry,
    });
  }
}

function buildSuppressedFatigueResponse(input: {
  message: SubstrateMessage;
  startTime: number;
  completedAt: number;
  model: string;
  fatigue: FatigueEnforcementMetadata;
}): AgentResponse {
  return {
    content: '',
    channelId: input.message.channelId,
    metadata: {
      model: input.model,
      inputTokens: 0,
      outputTokens: 0,
      durationMs: input.completedAt - input.startTime,
      fatigue: input.fatigue,
    },
  };
}

export async function handleMessageForTurn(
  runtime: TurnExecutionRuntime,
  message: SubstrateMessage,
): Promise<AgentResponse> {
  const requestId = message.id;
  const turnId = createTurnId();
  const deferredContinuationId = parseDeferredToolHandoffActionId(message.id);
  const taskKind = runtime.resolveTaskKind(message);
  const turnBudgetCharacteristics = runtime.buildTurnBudgetCharacteristics(message, taskKind);
  const temporalRetrievalMode: 'temporal' | undefined = isTemporalContextBudgetTurn(turnBudgetCharacteristics)
    ? 'temporal'
    : undefined;
  const temporalRetrievalCallerContext = temporalRetrievalMode
    ? { retrievalMode: temporalRetrievalMode }
    : undefined;
  const turnCallType = runtime.resolveTurnCallType(message, taskKind);
  const turnRuntimeClass = resolveRuntimeLaneClassForTurn({
    callType: turnCallType,
    channelId: message.channelId,
    ...(taskKind ? { taskKind } : {}),
    ...(deferredContinuationId ? { deferredContinuationId } : {}),
  });
  const turnCorrelationBase = runtime.buildTurnCorrelation(message, turnCallType, turnId, requestId);
  await runtime.awaitPostTurnDrain({
    channelId: message.channelId,
    turnId,
    requestId,
    correlation: turnCorrelationBase,
  });
  const startTime = Date.now();
  const restorePinnedSessionContext = runtime.pinDeferredContinuationSessionContext(
    deferredContinuationId,
    message.channelId,
  );
  const focusMemoryScopeQuery = runtime.sessionManager.getActiveFocusMemoryScopeQuery(message.channelId);
  const deferSessionEntryPersistence = hasVisionTurnInputs(message);
  const observability = createTurnExecutionObservability({
    runtime,
    message,
    startTime,
    turnId,
    requestId,
    turnCallType,
    turnCorrelationBase,
  });
  const identityState = await prepareTurnIdentityState({
    runtime,
    message,
    turnId,
    requestId,
    turnCorrelationBase,
    observability,
    deferSessionEntryPersistence,
  });
  const {
    authorContext,
    channelMeta,
    contextEnvelope,
    broadcastVisibilityScope,
    viewerRequestContext,
    baseVisionToolRequestContext,
    continuitySubjectKey,
    attributedSystemContent,
    userSessionEntryId: preparedUserSessionEntryId,
    emotionSessionId,
    trustLevel,
    speakerRole,
    canonicalContactKey,
    conversationScope,
  } = identityState;
  let promptMode: MessagePromptOverrideMode = 'default';
  let fullPrompt = '';
  let contextMessageCount = 0;
  let memoryContextChars = 0;
  let memoryContextBlock = '';
  let wikiContextBlock = '';
  let turnSnapshot: TurnSnapshot | undefined;
  let turnMessages: AgentMessage[] = [];
  let responseModel = runtime.agent.state.model.id;
  let userSessionEntryId = preparedUserSessionEntryId;
  let assistantSessionEntryId: number | null = null;
  let internalStateSnapshotRef: string | undefined;
  let persistedUserMessageContent: string | undefined;
  let fatigueDecision: FatigueTurnDecision | null = null;
  const invocationState: AgentInvocationMutableState = {
    turnMessages,
    turnStartMessageIndex: null,
  };
  const recordDeferredSessionEntry = (contentOverride?: string): number | null => {
    if (speakerRole === 'system') {
      return runtime.recordSystemMessage(
        message,
        turnId,
        requestId,
        contentOverride ?? attributedSystemContent,
        continuitySubjectKey,
      );
    }
    return runtime.recordUserMessage(
      message,
      turnId,
      requestId,
      trustLevel,
      continuitySubjectKey,
      contentOverride,
    );
  };

  try {
    const channelType = runtime.resolveChannelType(message);
    fatigueDecision = evaluateRuntimeFatigue({
      runtime,
      message,
      authorContext,
      channelType,
      channelMeta,
      taskKind,
      turnCorrelationBase,
      timestampMs: startTime,
    });
    if (fatigueDecision) {
      emitFatigueDecision({
        runtime,
        message,
        turnCorrelationBase,
        fatigueDecision,
        observability,
      });
    }
    if (fatigueDecision?.suppressModel) {
      const completedAt = Date.now();
      const suppressedResponse = buildSuppressedFatigueResponse({
        message,
        startTime,
        completedAt,
        model: responseModel,
        fatigue: fatigueDecision.metadata,
      });
      observability.emitObservedTurnStage('end', {
        durationMs: completedAt - startTime,
        ttftMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        fatigue: summarizeFatigue(fatigueDecision.metadata),
      });
      runtime.sessionManager.recordTurn(
        runtime.buildTurnRecord({
          message,
          turnId,
          requestId,
          startedAt: startTime,
          completedAt,
          userSessionEntryId,
          assistantSessionEntryId,
          response: suppressedResponse,
          turnMessages: [],
          promptMode,
          promptText: fullPrompt,
          contextMessageCount,
          memoryContextChars,
          trustLevel,
          speakerRole,
          canonicalContactKey,
          retrievalProvenanceRefs: [],
          turnObservability: {
            stages: observability.getObservedTurnStages(),
            retrievals: observability.getObservedTurnRetrievals(),
            ...(observability.getObservedTurnSnapshot() ? { snapshot: observability.getObservedTurnSnapshot() } : {}),
          },
        }),
      );
      await runtime.eventBus.emit('agent.turn.end', {
        message,
        response: suppressedResponse,
        ...runtime.withCorrelationPurpose(turnCorrelationBase, 'agent.turn.end'),
      });
      return suppressedResponse;
    }
    runtime.ensureModel(message);
    responseModel = runtime.agent.state.model.id;
    const preTurnState = await computePreTurnState({
      runtime,
      message,
      channelType,
      taskKind,
      turnId,
      requestId,
      channelMeta,
      authorContext,
      conversationScope,
      continuitySubjectKey,
      trustLevel,
      emotionSessionId,
      turnBudgetCharacteristics,
      focusMemoryScopeQuery,
      temporalRetrievalCallerContext,
      temporalRetrievalMode,
      viewerRequestContext,
      turnCorrelationBase,
      observability,
    });
    turnSnapshot = preTurnState.turnSnapshot;
    if (fatigueDecision) {
      turnSnapshot.fatigue = fatigueDecision.metadata;
    }
    memoryContextBlock = preTurnState.memoryContextBlock;
    wikiContextBlock = preTurnState.wikiContextBlock;
    memoryContextChars = preTurnState.memoryContextChars;
    const autoloadOutcome = runtime.preloadExtendedToolsForTurn(message, taskKind, turnCorrelationBase);
    runtime.applyActiveToolsToAgentForTurn(
      message,
      taskKind,
      turnCallType,
      turnCorrelationBase,
      autoloadOutcome,
    );
    const responseStyle = runtime.resolveResponseStyle(message, channelType, channelMeta);
    const promptAssembly = await assembleTurnPrompt({
      runtime,
      message,
      channelType,
      taskKind,
      channelMeta,
      authorContext,
      conversationScope,
      trustLevel,
      responseStyle,
      emotionSessionId,
      preTurnInternalState: preTurnState.preTurnInternalState,
      emotionAppraisalChain: preTurnState.emotionAppraisalChain,
      memoryContextBlock,
      wikiContextBlock,
      scratchpadBlock: preTurnState.scratchpadBlock,
      turnBudgetCharacteristics,
      continuitySubjectKey,
      temporalRetrievalMode,
      viewerRequestContext,
      turnCorrelationBase,
      turnCallType,
      turnSnapshot,
      memoryManifestSeed: preTurnState.memoryManifestSeed ?? observability.getMemoryManifestSeed(),
      ...(fatigueDecision ? { fatigue: fatigueDecision.metadata } : {}),
      getRetrievalProvenanceRefs: observability.getRetrievalProvenanceRefs,
      getObservedTurnRetrievals: observability.getObservedTurnRetrievals,
      observability,
    });
    promptMode = promptAssembly.promptMode;
    fullPrompt = promptAssembly.fullPrompt;
    contextMessageCount = promptAssembly.contextMessageCount;

    const promptStageStart = Date.now();
    // Establish the turn-scoped paid-deliverable registry around the agent
    // invocation so charged tools (e.g. paid image generation) can record an
    // undelivered artifact and the in-turn response_control tool can refuse a
    // no-reply that would silently drop it.
    const invocationResult = await runWithPaidDeliverableTracking(() => invokeAgentForTurn({
      runtime,
      message,
      context: promptAssembly.context,
      providerSystemPrompt: promptAssembly.providerSystemPrompt,
      piMessages: promptAssembly.piMessages,
      startTime,
      promptStageStart,
      turnId,
      requestId,
      taskKind,
      turnCallType,
      turnCorrelationBase,
      viewerRequestContext,
      baseVisionToolRequestContext,
      autoloadOutcome,
      turnSnapshot,
      templateVariables: promptAssembly.templateVariables,
      speakerRole,
      mutableState: invocationState,
      observability,
    }));
    turnMessages = invocationResult.turnMessages;
    responseModel = invocationResult.responseModel;
    persistedUserMessageContent = invocationResult.persistedUserMessageContent;
    if (deferSessionEntryPersistence && userSessionEntryId == null) {
      userSessionEntryId = recordDeferredSessionEntry(persistedUserMessageContent);
    }
    const {
      firstTokenAt,
      turnUsage,
      responseText,
      fallbackDiagnostics,
      runtimeContradictionDiagnostics,
      turnIntent,
    } = invocationResult;
    const noReplyDecision = runtime.consumeIntentionalNoReplyDecision(turnId);
    // Intentional silence is only honored when no user-facing reply was
    // authored. A no_reply issued during internal follow-up continuation
    // (whisper/system-note steps drained into this run) must not suppress the
    // reply already written for the user — that silently drops an authored
    // reply (psfn-framework-ay73). responseText is already bounded to the
    // user-facing portion of the run via the user-facing boundary index.
    const honorNoReply = noReplyDecision != null && responseText.trim().length === 0;
    if (noReplyDecision && !honorNoReply) {
      log.warn('Intentional no-reply demoted: user-facing reply already authored this turn; delivering the reply', {
        channelId: message.channelId,
        turnId,
        requestId,
        noReplyAuditId: noReplyDecision.auditId,
        noReplySource: noReplyDecision.source,
      });
      runtime.emitTelemetry('agent.no_reply.demoted', {
        channelId: message.channelId,
        turnId,
        auditId: noReplyDecision.auditId,
        source: noReplyDecision.source,
        ...runtime.withCorrelationPurpose(turnCorrelationBase, 'agent.no_reply.demoted'),
      });
    }
    let safeResponseText = honorNoReply ? '' : responseText;
    let broadcastSafetyMeta: AgentResponse['metadata']['broadcastSafety'] | undefined;

    if (contextEnvelope.broadcast) {
      const visibilityScope = broadcastVisibilityScope ?? 'public_only';
      const classification = classifyBroadcastDraft(responseText);
      const operatorApproval = visibilityScope === 'approved_private_context';
      const approvalRequired = classification.risky && !operatorApproval;
      const provenanceRefs = [...new Set(observability.getRetrievalProvenanceRefs())];

      broadcastSafetyMeta = {
        visibilityScope,
        operatorApproval,
        risky: classification.risky,
        signals: classification.signals,
        approvalRequired,
        provenanceRefs,
      };

      runtime.emitTelemetry('broadcast.pre_send.classified', {
        channelId: message.channelId,
        risky: classification.risky,
        signals: classification.signals,
        visibilityScope,
        ...runtime.withCorrelationPurpose(turnCorrelationBase, 'broadcast.pre_send.classified'),
      });

      if (approvalRequired) {
        runtime.emitTelemetry('broadcast.approval.required', {
          channelId: message.channelId,
          signals: classification.signals,
          visibilityScope,
          draftLength: responseText.length,
          ...runtime.withCorrelationPurpose(turnCorrelationBase, 'broadcast.approval.required'),
        });
        runtime.sessionManager.appendSystemNote(
          message.channelId,
          `Broadcast draft held for approval (${classification.signals.join(', ') || 'risk'} risk).`,
        );
        safeResponseText = '';
      }

      const provenancePayload = {
        channelId: message.channelId,
        visibilityScope,
        operatorApproval,
        risky: classification.risky,
        signals: classification.signals,
        provenanceRefs,
        contextMessageCount,
        memoryContextChars,
        ...runtime.withCorrelationPurpose(turnCorrelationBase, 'broadcast.provenance'),
      };
      runtime.emitTelemetry('broadcast.provenance', provenancePayload);
      log.info('Broadcast provenance', provenancePayload);
    }

    const retrievalProvenanceRefs = observability.getRetrievalProvenanceRefs();
    const internalState = await runtime.emotionSelfModelRuntime.computeInternalStateForTurn({
      message,
      responseText,
      trustLevel,
      canonicalContactKey,
      emotionSnapshot: preTurnState.emotionSnapshot,
      toolCallCount: turnUsage.toolCalls,
      sessionChannelId: emotionSessionId,
      conversationScope,
    });
    internalStateSnapshotRef = buildInternalStateSnapshotRef(internalState);
    const metacognitiveFlags = runtime.emotionSelfModelRuntime.computeMetacognitiveFlagsForTurn({
      internalState,
      responseText,
      toolCallCount: turnUsage.toolCalls,
      sessionChannelId: emotionSessionId,
      retrievalProvenanceRefs,
    });
    runtime.setCurrentSelfModelState(
      internalState,
      internalStateSnapshotRef,
      metacognitiveFlags,
    );

    runtime.recordToolObservations(
      message,
      turnId,
      requestId,
      turnMessages,
      trustLevel,
    );
    const responseAttachments = honorNoReply
      ? []
      : await collectTurnResponseAttachments({
          runtime,
          turnMessages,
          galleryContext: {
            channelId: message.channelId,
            channelType: message.channelType,
            turnId,
            requestId,
            sourceMessageId: message.id,
            ...(userSessionEntryId !== null ? { userSessionEntryId } : {}),
          },
        });

    // Fail loud, never silently: if a charged image deliverable was produced this
    // turn but is not riding out on the reply, surface it. The response_control
    // guard should prevent the no-reply case; this is the last-resort audit trail.
    const chargedImageDeliverables = summarizeChargedImageDeliverables(turnMessages);
    if (chargedImageDeliverables.length > 0) {
      if (honorNoReply) {
        log.warn('Paid image deliverable dropped by intentional no-reply', {
          channelId: message.channelId,
          turnId,
          requestId,
          noReplyAuditId: noReplyDecision.auditId,
          noReplySource: noReplyDecision.source,
          deliverables: chargedImageDeliverables,
        });
      } else if (responseAttachments.length === 0) {
        log.warn('Paid image deliverable was not attached to the outbound reply', {
          channelId: message.channelId,
          turnId,
          requestId,
          deliverables: chargedImageDeliverables,
        });
      }
    }

    if (!broadcastSafetyMeta?.approvalRequired && !honorNoReply) {
      assistantSessionEntryId = runtime.recordAssistantMessage(
        message,
        turnId,
        requestId,
        safeResponseText,
        trustLevel,
        continuitySubjectKey,
        preTurnState.emotionSnapshot,
      );
    }

    if (runtime.skillsRuntime) {
      const toolSummary = runtime.buildTurnToolSummary(turnMessages);
      const nudge = runtime.evaluateReflectionNudge(toolSummary);
      if (nudge) {
        runtime.sessionManager.appendSystemNote(message.channelId, nudge);
      }
    }

    const completedAt = Date.now();
    const responseDiagnostics: NonNullable<AgentResponse['metadata']['diagnostics']> = {};
    if (fallbackDiagnostics?.fallback) {
      responseDiagnostics.fallback = fallbackDiagnostics.fallback;
    }
    if (runtimeContradictionDiagnostics?.runtimeContradiction) {
      responseDiagnostics.runtimeContradiction = runtimeContradictionDiagnostics.runtimeContradiction;
    }
    let responseFatigueMetadata = fatigueDecision?.metadata;
    if (fatigueDecision?.shouldRecordSpend) {
      if (!runtime.fatigueBudget) {
        throw new Error('Fatigue spend recording requires fatigueBudget');
      }
      const fatigueEvent = runtime.fatigueBudget.recordFinalDecision(
        fatigueDecision.evaluation,
        {
          correlation: runtime.withCorrelationPurpose(turnCorrelationBase, 'agent.fatigue.record'),
          details: {
            enforcementDecision: fatigueDecision.metadata.decision,
            policyState: fatigueDecision.metadata.policyState,
            policyBaseState: fatigueDecision.metadata.policyBaseState,
            overchargePermitted: fatigueDecision.metadata.overchargePermitted,
            overchargeReasons: fatigueDecision.metadata.overchargeReasons,
            responseChars: responseText.length,
            model: responseModel,
          },
        },
      );
      responseFatigueMetadata = attachRecordedFatigueEvent(fatigueDecision.metadata, fatigueEvent);
      fatigueDecision = {
        ...fatigueDecision,
        metadata: responseFatigueMetadata,
      };
      turnSnapshot.fatigue = responseFatigueMetadata;
      runtime.emitTelemetry('agent.fatigue.recorded', {
        channelId: message.channelId,
        amount: fatigueEvent.amount,
        spentAfter: fatigueEvent.spentAfter,
        remainingAllowance: fatigueEvent.remainingAllowance,
        decision: responseFatigueMetadata.decision,
        ...runtime.withCorrelationPurpose(turnCorrelationBase, 'agent.fatigue.recorded'),
      });
    }
    const agentResponse: AgentResponse = {
      content: safeResponseText,
      channelId: message.channelId,
      ...(responseAttachments.length > 0 ? { attachments: responseAttachments } : {}),
      metadata: {
        model: responseModel,
        inputTokens: turnUsage.inputTokens,
        outputTokens: turnUsage.outputTokens,
        durationMs: completedAt - startTime,
        internalState: cloneComputedInternalStateForResponse(internalState),
        internalStateSnapshotRef,
        metacognitiveFlags: cloneMetacognitiveFlags(metacognitiveFlags),
        ...(retrievalProvenanceRefs.length > 0 ? { retrievalProvenanceRefs } : {}),
        ...(Object.keys(responseDiagnostics).length > 0 ? { diagnostics: responseDiagnostics } : {}),
        ...(broadcastSafetyMeta ? { broadcastSafety: broadcastSafetyMeta } : {}),
        ...(responseFatigueMetadata ? { fatigue: responseFatigueMetadata } : {}),
        ...(honorNoReply ? { noReply: noReplyDecision } : {}),
      },
    };
    await schedulePostTurnWork({
      runtime,
      message,
      response: agentResponse,
      turnMessages,
      turnId,
      requestId,
      startTime,
      completedAt,
      firstTokenAt,
      turnUsage,
      context: promptAssembly.context,
      deferredContinuationId,
      turnCallType,
      turnRuntimeClass,
      taskKind,
      turnIntent,
      turnCorrelationBase,
      userSessionEntryId,
      assistantSessionEntryId,
      promptMode,
      fullPrompt,
      contextMessageCount,
      memoryContextChars,
      memoryContextBlock,
      trustLevel,
      speakerRole,
      canonicalContactKey,
      continuitySubjectKey,
      turnSnapshot,
      internalStateSnapshotRef,
      internalState,
      templateVariables: promptAssembly.templateVariables,
      emotionSessionId,
      channelMeta,
      conversationScope,
      turnBudgetCharacteristics,
      observability,
      persistedUserMessageContent,
    });

    return agentResponse;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    const observedFailureTurnMessages = invocationState.turnMessages.length > 0
      ? invocationState.turnMessages
      : invocationState.turnStartMessageIndex == null
        ? []
        : runtime.agent.state.messages.slice(invocationState.turnStartMessageIndex);
    let assistantMessageContent: string | undefined;
    try {
      const extracted = runtime.extractResponseText().trim();
      if (extracted.length > 0) {
        assistantMessageContent = extracted;
      }
    } catch {
      assistantMessageContent = undefined;
    }
    const failedCompletedAt = Date.now();
    if (deferSessionEntryPersistence && userSessionEntryId == null) {
      try {
        userSessionEntryId = recordDeferredSessionEntry(persistedUserMessageContent);
      } catch (recordError) {
        log.warn('Deferred user session entry persistence failed during turn error handling', {
          channelId: message.channelId,
          turnId,
          requestId,
          error: toErrorMessage(recordError),
        });
      }
    }
    runtime.sessionManager.recordTurn(
      runtime.buildTurnRecord({
        message,
        turnId,
        requestId,
        startedAt: startTime,
        completedAt: failedCompletedAt,
        userSessionEntryId,
        assistantSessionEntryId,
        ...(assistantMessageContent ? { assistantMessageContent } : {}),
        turnMessages: observedFailureTurnMessages,
        status: 'failed',
        model: runtime.agent.state.model.id,
        promptMode,
        promptText: fullPrompt,
        contextMessageCount,
        memoryContextChars,
        trustLevel,
        speakerRole,
        canonicalContactKey,
        retrievalProvenanceRefs: observability.getRetrievalProvenanceRefs(),
        ...(persistedUserMessageContent ? { persistedUserMessageContent } : {}),
        ...(turnSnapshot ? { turnSnapshot } : {}),
        turnObservability: {
          stages: observability.getObservedTurnStages(),
          retrievals: observability.getObservedTurnRetrievals(),
          ...(observability.getObservedTurnSnapshot() ? { snapshot: observability.getObservedTurnSnapshot() } : {}),
        },
        ...(internalStateSnapshotRef ? { internalStateSnapshotRef } : {}),
      }),
    );
    await runtime.eventBus.emit('agent.error', {
      message,
      error: err,
      ...runtime.withCorrelationPurpose(turnCorrelationBase, 'agent.error'),
    });
    throw err;
  } finally {
    observability.unsubscribe();
    restorePinnedSessionContext();
  }
}
