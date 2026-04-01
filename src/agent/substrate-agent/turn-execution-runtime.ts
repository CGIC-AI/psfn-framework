import type { Agent, AgentMessage } from '@mariozechner/pi-agent-core';
import type { AssistantMessage, UserMessage } from '@mariozechner/pi-ai';
import { resolveBroadcastVisibilityScope, classifyBroadcastDraft } from '../../broadcast/safety.js';
import type { EventBus, EventMap } from '../../event-bus.js';
import { enforceUntrustedCompactionGuard } from '../../identity/prompt-composer.js';
import type { ComposeContext } from '../../identity/prompt-types.js';
import { injectPromptRuntimeTokens } from '../../identity/prompt-runtime.js';
import { collectGeneratedImageAttachments } from '../../images/generated-media.js';
import type { ImageVisionReviewer } from '../../images/types.js';
import { runWithVisionToolRequestContext } from '../../images/request-context.js';
import { runWithRequestContext } from '../../llm/request-context.js';
import { contextMessagesToPiMessages } from '../../llm/message-conversion.js';
import { createComponentLogger } from '../../logger.js';
import { resolveConfiguredCompanionDataDir } from '../../persistence/layout.js';
import type { SessionManager } from '../../session/manager.js';
import type { ContextManifestMemorySeed } from '../../session/context-manifest.js';
import {
  cloneMetacognitiveFlags,
  type MetacognitiveFlag,
} from '../../self-model/metacognition.js';
import {
  buildInternalStateSnapshotRef,
  cloneInternalState,
  type InternalState,
} from '../../self-model/state.js';
import type { SkillsRuntime } from '../../skills/runtime.js';
import type { TurnToolSummary } from '../../skills/reflection-nudge.js';
import { classifyChannel, type ChannelMeta } from '../../trust/policy.js';
import { normalizeChannelVisibility, type TrustLevel } from '../../trust/types.js';
import type {
  AgentResponse,
  CorrelationMetadata,
  InferredPostTurnAction,
  MessagePromptOverride,
  MessagePromptOverrideMode,
  ObservabilityCallType,
  ResponseStyle,
  SubstrateConfig,
  SubstrateMessage,
  TurnID,
  TurnRecord,
  TurnUsage,
} from '../../types.js';
import { toErrorMessage } from '../../utils/errors.js';
import type { ContextBudgetTurnCharacteristics } from '../../context-budget.js';
import type { ContextManifest } from '../../session/context-manifest.js';
import { createTurnId } from '../../turns/id.js';
import type {
  TurnObservabilityRecord,
  TurnRetrievalTelemetryRecord,
  TurnStageTelemetryRecord,
} from '../../turns/observability.js';
import {
  sanitizeTurnRetrievalTelemetry,
  sanitizeTurnSnapshot,
  sanitizeTurnStageTelemetry,
} from '../../turns/observability.js';
import type { TurnPromptSnapshot, TurnSnapshot } from '../../turns/snapshot.js';
import {
  parseDeferredToolHandoffActionId,
} from '../deferred-tool-handoff.js';
import type { EventBridge } from '../event-bridge.js';
import type { RuntimeMode } from '../tool-wiring-validator.js';
import { resolveModel } from '../stream-adapter.js';
import type { LLMProvider, MemoryExtractor, MemoryProvider } from '../contracts.js';
import type { MemoryScopeQuery } from '../../memory/types.js';
import type { AdaptiveToolRuntimeState } from '../adaptive-tools-telemetry.js';
import {
  collectVisionTurnImageUrls,
  hasVisionTurnInputs,
  buildTurnUserContent,
} from './vision-attachments.js';
import {
  resolveMoaSettings,
  runMoaTurn,
} from './moa-turn.js';
import type { EmotionSelfModelRuntime } from './emotion-self-model-runtime.js';
import type { ResolvedAuthorContext } from './runtime-context.js';
import type { AutoloadTurnOutcome } from './adaptive-tools-runtime.js';
import type {
  BackgroundContinuationCompletionSignal,
  PendingBackgroundContinuationDelivery,
} from './background-continuation-runtime.js';
import {
  cloneObservedAdaptiveToolSnapshot,
  readActiveTurnToolSchemas,
} from './turn-tool-context.js';
import { buildPromptContextSectionCacheability } from './prompt-lifecycle.js';

const log = createComponentLogger('SubstrateAgent');

interface ProactiveMemoryProvider extends MemoryProvider {
  retrieveProactiveRecall?: (
    channelId: string,
    trustLevel?: TrustLevel,
    channelMeta?: ChannelMeta,
    canonicalContactId?: string,
    turnSnapshot?: import('../../turns/snapshot.js').TurnMemorySnapshot,
    turnBudgetCharacteristics?: ContextBudgetTurnCharacteristics,
    scopeQuery?: MemoryScopeQuery,
  ) => Promise<string>;
}

export interface TurnExecutionRuntime {
  eventBus: EventBus;
  llmClient: LLMProvider;
  imageVisionReviewer: ImageVisionReviewer | null;
  sessionManager: SessionManager;
  config: SubstrateConfig;
  runtimeMode: RuntimeMode;
  agent: Agent;
  bridge: EventBridge;
  systemPrompt: string;
  memoryProvider: MemoryProvider | null;
  memoryExtractor: MemoryExtractor | null;
  skillsRuntime: SkillsRuntime | null;
  evaluateReflectionNudge: (toolSummary: TurnToolSummary) => string | null;
  emotionSelfModelRuntime: EmotionSelfModelRuntime;
  pinDeferredContinuationSessionContext: (
    deferredContinuationId: string | null,
    channelId: string,
  ) => () => void;
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
  resolveAuthorContext: (message: SubstrateMessage) => ResolvedAuthorContext;
  emitTurnStage: (
    message: SubstrateMessage,
    turnStartMs: number,
    turnId: TurnID,
    requestId: string,
    stage: 'trust' | 'memory' | 'context' | 'first-token' | 'prompt' | 'end',
    callType: ObservabilityCallType,
    payload: Record<string, unknown>,
  ) => EventMap['agent.turn.stage'];
  recordUserMessage: (
    message: SubstrateMessage,
    turnId: TurnID,
    requestId: string,
    trustLevel: TrustLevel,
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
  }) => string;
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
    response: AgentResponse;
    turnMessages: AgentMessage[];
    promptMode: MessagePromptOverrideMode;
    promptText: string;
    contextMessageCount: number;
    memoryContextChars: number;
    trustLevel: TrustLevel;
    canonicalContactKey?: string;
    retrievalProvenanceRefs: string[];
    turnSnapshot?: TurnSnapshot;
    turnObservability?: TurnObservabilityRecord;
    internalStateSnapshotRef?: string;
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
  ) => PendingBackgroundContinuationDelivery[];
  emitTelemetry: (event: string, payload: Record<string, unknown>) => void;
  runIntentionPostTurnHooks: (context: {
    message: SubstrateMessage;
    response: AgentResponse;
    turnMessages: AgentMessage[];
    turnId: TurnID;
    completedAt: number;
    canonicalContactKey?: string;
  }) => Promise<void>;
}

export async function handleMessageForTurn(
  runtime: TurnExecutionRuntime,
  message: SubstrateMessage,
): Promise<AgentResponse> {
  const startTime = Date.now();
  const requestId = message.id;
  const turnId = createTurnId();
  const deferredContinuationId = parseDeferredToolHandoffActionId(message.id);
  const restorePinnedSessionContext = runtime.pinDeferredContinuationSessionContext(
    deferredContinuationId,
    message.channelId,
  );
  const taskKind = runtime.resolveTaskKind(message);
  const turnBudgetCharacteristics = runtime.buildTurnBudgetCharacteristics(message, taskKind);
  const turnCallType = runtime.resolveTurnCallType(message, taskKind);
  const turnCorrelationBase = runtime.buildTurnCorrelation(message, turnCallType, turnId, requestId);
  const focusMemoryScopeQuery = runtime.sessionManager.getActiveFocusMemoryScopeQuery(message.channelId);
  let retrievalProvenanceRefs: string[] = [];
  let memoryManifestSeed: ContextManifestMemorySeed | undefined;
  const observedTurnStages: TurnStageTelemetryRecord[] = [];
  const observedTurnRetrievals: TurnRetrievalTelemetryRecord[] = [];
  let observedTurnSnapshot: TurnObservabilityRecord['snapshot'] | undefined;
  const emitObservedTurnStage = (
    stage: 'trust' | 'memory' | 'context' | 'first-token' | 'prompt' | 'end',
    payload: Record<string, unknown>,
  ): void => {
    const telemetry = runtime.emitTurnStage(
      message,
      startTime,
      turnId,
      requestId,
      stage,
      turnCallType,
      payload,
    );
    observedTurnStages.push(sanitizeTurnStageTelemetry(telemetry));
  };
  const emitTurnSnapshot = async (snapshot: TurnSnapshot): Promise<void> => {
    observedTurnSnapshot = sanitizeTurnSnapshot(snapshot);
    await runtime.eventBus.emit('agent.turn.snapshot', {
      snapshot,
      ...runtime.withCorrelationPurpose(turnCorrelationBase, 'agent.turn.snapshot'),
    });
  };
  const unsubscribeRetrieval = runtime.eventBus.on('memory.retrieval', (telemetry) => {
    if (telemetry.channelId !== message.channelId) return;
    if (telemetry.requestId && telemetry.requestId !== requestId) return;
    if (telemetry.turnId && telemetry.turnId !== turnId) return;

    const observedRetrieval = sanitizeTurnRetrievalTelemetry(telemetry);
    if (observedRetrieval) {
      observedTurnRetrievals.push(observedRetrieval);
    }

    memoryManifestSeed = {
      ...(telemetry.reason ? { reason: telemetry.reason } : {}),
      ...(telemetry.retrievalSource ? { retrievalSource: telemetry.retrievalSource } : {}),
      ...(telemetry.candidateCount !== undefined ? { candidateCount: telemetry.candidateCount } : {}),
      ...(telemetry.policyAllowedCount !== undefined ? { policyAllowedCount: telemetry.policyAllowedCount } : {}),
      ...(telemetry.rankedCount !== undefined ? { rankedCount: telemetry.rankedCount } : {}),
      ...(telemetry.returnedCount !== undefined ? { returnedCount: telemetry.returnedCount } : {}),
      ...(telemetry.retrievalLimit !== undefined ? { retrievalLimit: telemetry.retrievalLimit } : {}),
      ...(telemetry.retrievalBudgetPct !== undefined ? { retrievalBudgetPct: telemetry.retrievalBudgetPct } : {}),
      ...(telemetry.retrievalTokenBudget !== undefined ? { retrievalTokenBudget: telemetry.retrievalTokenBudget } : {}),
      ...(telemetry.retrievalLimitMode ? { retrievalLimitMode: telemetry.retrievalLimitMode } : {}),
      ...(telemetry.contactScopeRejectedCount !== undefined
        ? { contactScopeRejectedCount: telemetry.contactScopeRejectedCount }
        : {}),
      ...(telemetry.sensitivityRejectedCount !== undefined
        ? { sensitivityRejectedCount: telemetry.sensitivityRejectedCount }
        : {}),
      ...(telemetry.policyRejectedCount !== undefined ? { policyRejectedCount: telemetry.policyRejectedCount } : {}),
      ...(telemetry.policyRejectedReasonTags
        ? { policyRejectedReasonTags: { ...telemetry.policyRejectedReasonTags } }
        : {}),
      ...(telemetry.withheldCount !== undefined ? { withheldCount: telemetry.withheldCount } : {}),
      ...(telemetry.withheldReasonCounts
        ? { withheldReasonCounts: { ...telemetry.withheldReasonCounts } }
        : {}),
      ...(telemetry.scoreRejectedCount !== undefined ? { scoreRejectedCount: telemetry.scoreRejectedCount } : {}),
      ...(telemetry.budgetCappedCount !== undefined ? { budgetCappedCount: telemetry.budgetCappedCount } : {}),
      ...(telemetry.selectedTypes ? { selectedTypes: { ...telemetry.selectedTypes } } : {}),
      ...(telemetry.compositionalMode ? { compositionalMode: telemetry.compositionalMode } : {}),
    };
    const refs = telemetry.provenanceRefs ?? [];
    if (refs.length === 0) return;
    retrievalProvenanceRefs = [...new Set(refs.map(ref => ref.trim()).filter(Boolean))];
  });

  const trustStageStart = Date.now();
  const authorContext = runtime.resolveAuthorContext(message);
  const resolvedChannelPrivacy = normalizeChannelVisibility(message.routing?.channelPrivacy)
    ?? authorContext.channelPrivacyLevel;
  if (resolvedChannelPrivacy) {
    message.routing = {
      ...(message.routing ?? {}),
      channelPrivacy: resolvedChannelPrivacy,
    };
  }
  const channelMeta: ChannelMeta = {
    ...(message.isDirectMessage !== undefined ? { isDirectMessage: message.isDirectMessage } : {}),
    ...(message.routing?.broadcast?.approvalToken
      ? { broadcastApprovalToken: message.routing.broadcast.approvalToken }
      : {}),
    ...(resolvedChannelPrivacy ? { privacyLevel: resolvedChannelPrivacy } : {}),
  };
  const channelVisibility = classifyChannel(message.channelId, channelMeta);
  const broadcastVisibilityScope = resolveBroadcastVisibilityScope(message.channelId, channelMeta);
  const viewerRequestContext = {
    viewerTrustLevel: authorContext.trustLevel,
    viewerChannelVisibility: channelVisibility,
    ...(message.isDirectMessage !== undefined ? { viewerIsDirectMessage: message.isDirectMessage } : {}),
  };
  const baseVisionToolRequestContext = {
    userMessageText: message.content,
    imageAttachmentUrls: collectVisionTurnImageUrls(message),
  };
  await runtime.eventBus.emit('agent.turn.start', {
    message,
    ...runtime.withCorrelationPurpose(turnCorrelationBase, 'agent.turn.start'),
  });
  const subjectIdentityKey = authorContext.subjectIdentityKey
    ?? authorContext.canonicalContactKey
    ?? message.authorId;
  const continuityUserId = authorContext.subjectIdentityKey ?? authorContext.canonicalContactKey;
  emitObservedTurnStage('trust', {
    durationMs: Date.now() - trustStageStart,
    trustLevel: authorContext.trustLevel,
    canonicalContactKey: authorContext.canonicalContactKey ?? null,
  });

  runtime.emotionSelfModelRuntime.assertSelfModelRuntimeConfigured();
  await runtime.sessionManager.awaitPendingAutoCompaction(message.channelId);

  const userSessionEntryId = runtime.recordUserMessage(
    message,
    turnId,
    requestId,
    authorContext.trustLevel,
    continuityUserId,
  );
  const emotionSessionId = runtime.resolveSessionChannelId(message.channelId);

  try {
    const trustLevel = authorContext.trustLevel;
    const channelType = runtime.resolveChannelType(message);
    const memoryProvider = runtime.memoryProvider as ProactiveMemoryProvider | null;
    const bypassMemoryForVisionTurn = hasVisionTurnInputs(message);
    runtime.ensureModel(message);
    const promptSnapshot = runtime.captureTurnPromptSnapshot({ channelType, taskKind });
    const sessionContextSnapshot = typeof (runtime.sessionManager as SessionManager & {
      captureTurnContextSnapshot?: SessionManager['captureTurnContextSnapshot'];
    }).captureTurnContextSnapshot === 'function'
      ? runtime.sessionManager.captureTurnContextSnapshot(
        message.channelId,
        subjectIdentityKey,
        channelMeta,
        authorContext.continuityFallbackKeys,
        turnBudgetCharacteristics,
      )
      : undefined;
    const [emotionSnapshot, memorySnapshot] = await Promise.all([
      runtime.emotionSelfModelRuntime.observeEmotionState(
        message.content,
        emotionSessionId,
      ),
      memoryProvider && typeof memoryProvider.captureTurnMemorySnapshot === 'function'
        ? memoryProvider.captureTurnMemorySnapshot(
          message.content,
          message.channelId,
          trustLevel,
          channelMeta,
          authorContext.canonicalContactKey,
          turnBudgetCharacteristics,
          focusMemoryScopeQuery ?? undefined,
        )
        : Promise.resolve(undefined),
    ]);
    const emotionAppraisalChain = runtime.emotionSelfModelRuntime.getEmotionAppraisalChain(emotionSessionId);
    const turnSnapshot: TurnSnapshot = {
      turnId,
      requestId,
      channelId: message.channelId,
      capturedAt: Date.now(),
      trustLevel,
      ...(authorContext.canonicalContactKey ? { canonicalContactKey: authorContext.canonicalContactKey } : {}),
      prompt: promptSnapshot,
      ...(sessionContextSnapshot ? { sessionContext: sessionContextSnapshot } : {}),
      ...(memorySnapshot ? { memory: memorySnapshot } : {}),
    };
    await emitTurnSnapshot(turnSnapshot);

    const memoryStageStart = Date.now();
    const { memoriesBlock, proactiveRecallBlock } = await runWithRequestContext(
      {
        ...runtime.withCorrelationPurpose(turnCorrelationBase, 'agent.turn.memory'),
        ...viewerRequestContext,
      },
      async () => {
        const memoriesBlockPromise = memoryProvider
          && !bypassMemoryForVisionTurn
          ? memoryProvider.retrieve(
            message.content,
            message.channelId,
            trustLevel,
            channelMeta,
            authorContext.canonicalContactKey,
            memorySnapshot,
            turnBudgetCharacteristics,
            undefined,
            focusMemoryScopeQuery ?? undefined,
          )
          : Promise.resolve('');
        const proactiveRecallBlockPromise = memoryProvider
          && !bypassMemoryForVisionTurn
          && typeof memoryProvider.retrieveProactiveRecall === 'function'
          ? memoryProvider.retrieveProactiveRecall(
            message.channelId,
            trustLevel,
            channelMeta,
            authorContext.canonicalContactKey,
            memorySnapshot,
            turnBudgetCharacteristics,
            focusMemoryScopeQuery ?? undefined,
          )
          : Promise.resolve('');
        const [memoriesBlock, proactiveRecallBlock] = await Promise.all([
          memoriesBlockPromise,
          proactiveRecallBlockPromise,
        ]);
        return { memoriesBlock, proactiveRecallBlock };
      },
    );
    const memoryContextBlock = [memoriesBlock, proactiveRecallBlock]
      .map(section => section.trim())
      .filter(section => section.length > 0)
      .join('\n\n');
    const scratchpadBlock = runtime.buildScratchpadContextBlock();
    emitObservedTurnStage('memory', {
      durationMs: Date.now() - memoryStageStart,
      hasMemoryProvider: memoryProvider != null,
      memoryChars: memoryContextBlock.length,
      proactiveRecallChars: proactiveRecallBlock.length,
      proactiveRecallIncluded: proactiveRecallBlock.length > 0,
      memoryBypassedForVisionTurn: bypassMemoryForVisionTurn,
      scratchpadChars: scratchpadBlock.length,
      scratchpadIncluded: scratchpadBlock.length > 0,
    });

    const runtimeNow = new Date();
    const promptOverride = runtime.normalizeTurnPromptOverride(message);
    const responseStyle = runtime.resolveResponseStyle(message, channelType, channelMeta);
    const templateVariables = runtime.buildPromptTemplateVariables(
      message,
      authorContext.resolvedUserName,
      trustLevel,
      channelType,
      authorContext.canonicalContactKey,
      authorContext.subjectIdentityKey,
      runtimeNow,
    );
    const preTurnInternalState = runtime.emotionSelfModelRuntime.computeInternalStateForTurn({
      message,
      responseText: '',
      trustLevel,
      canonicalContactKey: authorContext.canonicalContactKey,
      emotionSnapshot,
      toolCallCount: 0,
      sessionChannelId: emotionSessionId,
    });
    const preTurnInternalStateSnapshotRef = buildInternalStateSnapshotRef(preTurnInternalState);
    const preTurnMetacognitiveFlags = runtime.emotionSelfModelRuntime.computeMetacognitiveFlagsForTurn({
      internalState: preTurnInternalState,
      responseText: '',
      toolCallCount: 0,
      sessionChannelId: emotionSessionId,
      retrievalProvenanceRefs,
    });
    runtime.setCurrentSelfModelState(
      preTurnInternalState,
      preTurnInternalStateSnapshotRef,
      preTurnMetacognitiveFlags,
    );
    const runtimeContext = runtime.buildRuntimeContext(
      message,
      authorContext.resolvedUserName,
      trustLevel,
      channelType,
      authorContext.canonicalContactKey,
      authorContext.subjectIdentityKey,
      responseStyle,
      runtimeNow,
      taskKind,
      templateVariables,
      preTurnInternalState,
      preTurnMetacognitiveFlags,
      emotionAppraisalChain,
    );
    let fullPrompt = '';
    let renderedStaticPrefix = '';
    let renderedDynamicSuffix = '';
    let promptAssembly:
      | {
        stablePrefix: string;
        lateBlocks: string[];
      }
      | undefined;

    if (promptOverride.mode === 'default') {
      const staticCacheKey = runtime.buildPromptPrefixCacheKey(
        message,
        channelType,
        authorContext.canonicalContactKey,
        authorContext.subjectIdentityKey,
      );
      const staticSettingsHash = runtime.buildStaticPromptSettingsHash(templateVariables);
      renderedStaticPrefix = runtime.resolveStaticPromptPrefix({
        cacheKey: staticCacheKey,
        staticPrefixTemplate: turnSnapshot.prompt?.staticPrefixTemplate ?? runtime.systemPrompt,
        staticHash: turnSnapshot.prompt?.staticHash ?? runtime.hashPromptText(runtime.systemPrompt),
        settingsHash: staticSettingsHash,
        now: runtimeNow,
        variables: templateVariables,
      });
      const personaHint = runtime.getPersonaAdaptation(
        trustLevel,
        preTurnInternalState,
        preTurnMetacognitiveFlags,
        templateVariables,
      );
      const dynamicSuffixTemplate = [turnSnapshot.prompt?.dynamicSuffixTemplate ?? '', personaHint]
        .map(section => section?.trim() ?? '')
        .filter(section => section.length > 0)
        .join('\n\n');
      renderedDynamicSuffix = injectPromptRuntimeTokens(dynamicSuffixTemplate, {
        now: runtimeNow,
        variables: templateVariables,
      });
      fullPrompt = [renderedStaticPrefix, renderedDynamicSuffix, runtimeContext, scratchpadBlock]
        .map(section => section.trim())
        .filter(section => section.length > 0)
        .join('\n\n');
      promptAssembly = {
        stablePrefix: renderedStaticPrefix,
        lateBlocks: [renderedDynamicSuffix, runtimeContext, scratchpadBlock],
      };
    } else {
      const customPrompt = promptOverride.mode === 'custom'
        ? (promptOverride.systemPrompt ?? '')
        : '';
      fullPrompt = [customPrompt, runtimeContext, scratchpadBlock]
        .map(section => section.trim())
        .filter(section => section.length > 0)
        .join('\n\n');
      promptAssembly = {
        stablePrefix: customPrompt.trim(),
        lateBlocks: [runtimeContext, scratchpadBlock],
      };
    }

    const contextStageStart = Date.now();
    const context = await runWithRequestContext(
      {
        ...runtime.withCorrelationPurpose(turnCorrelationBase, 'agent.turn.context'),
        ...viewerRequestContext,
      },
      async () => runtime.sessionManager.buildContext(
        message.channelId,
        fullPrompt,
        memoryContextBlock,
        undefined,
        subjectIdentityKey,
        channelMeta,
        authorContext.continuityFallbackKeys,
        turnSnapshot.sessionContext,
        memoryManifestSeed,
        turnBudgetCharacteristics,
        promptAssembly,
      ),
    );
    turnSnapshot.capturedAt = Date.now();
    turnSnapshot.promptContext = {
      renderedStaticPrefix,
      renderedDynamicSuffix,
      runtimeContext,
      memoryContextBlock,
      scratchpadContext: scratchpadBlock,
      assembledPrompt: fullPrompt,
      finalSystemPrompt: context.systemPrompt,
      messages: context.messages.map(contextMessage => ({ ...contextMessage })),
      sectionCacheability: buildPromptContextSectionCacheability({
        promptSnapshot: turnSnapshot.prompt,
        renderedStaticPrefix,
        renderedDynamicSuffix,
        runtimeContext,
        memoryContextBlock,
        scratchpadContext: scratchpadBlock,
        assembledPrompt: fullPrompt,
        finalSystemPrompt: context.systemPrompt,
        messageCount: context.messages.length,
      }),
    };
    await emitTurnSnapshot(turnSnapshot);
    emitObservedTurnStage('context', {
      durationMs: Date.now() - contextStageStart,
      contextMessages: context.messages.length,
      systemPromptChars: context.systemPrompt.length,
      promptMode: promptOverride.mode,
    });

    const promptStageStart = Date.now();
    let firstTokenAt: number;
    let turnMessages: AgentMessage[] = [];
    let turnUsage: TurnUsage;
    let responseModel: string;
    let responseText: string;
    let fallbackDiagnostics: AgentResponse['metadata']['diagnostics'] | undefined;
    let turnIntent: string | null = null;

    const moaSettings = resolveMoaSettings(runtime.config, log);
    if (moaSettings) {
      const moaResult = await runMoaTurn({
        llmClient: runtime.llmClient,
        context,
        message,
        settings: moaSettings,
        turnId,
        requestId,
        callType: turnCallType,
        contextWindow: runtime.resolveContextWindow(),
        emitTelemetry: (eventName, payload) => runtime.emitTelemetry(eventName, payload),
      });
      firstTokenAt = Date.now();
      emitObservedTurnStage('first-token', {
        ttftMs: firstTokenAt - startTime,
        source: 'fallback',
      });
      emitObservedTurnStage('prompt', {
        durationMs: Date.now() - promptStageStart,
        ttftMs: firstTokenAt - startTime,
        mode: 'moa',
        rounds: moaResult.rounds,
        stopReason: moaResult.stopReason,
      });
      turnUsage = moaResult.turnUsage;
      responseModel = moaResult.model;
      responseText = moaResult.output;
    } else {
      runtime.agent.setSystemPrompt(enforceUntrustedCompactionGuard(context.systemPrompt));
      const autoloadOutcome = runtime.preloadExtendedToolsForTurn(message, taskKind, turnCorrelationBase);
      turnIntent = autoloadOutcome.intent;
      runtime.applyActiveToolsToAgentForTurn(
        message,
        taskKind,
        turnCallType,
        turnCorrelationBase,
        autoloadOutcome,
      );
      const adaptiveToolSnapshot = cloneObservedAdaptiveToolSnapshot(
        runtime.getAdaptiveToolRuntimeState().lastSnapshot,
      );
      const activeTools = readActiveTurnToolSchemas(runtime.agent);
      if (activeTools.length > 0 || adaptiveToolSnapshot) {
        turnSnapshot.toolContext = {
          activeTools,
          ...(adaptiveToolSnapshot
            ? { adaptiveSnapshot: adaptiveToolSnapshot }
            : {}),
        };
        turnSnapshot.capturedAt = Date.now();
        await emitTurnSnapshot(turnSnapshot);
      }

      const agentMessages: AgentMessage[] = contextMessagesToPiMessages(context.messages);
      const historyMessages = agentMessages.length > 0 ? agentMessages.slice(0, -1) : [];
      runtime.agent.replaceMessages(historyMessages);
      const turnStartMessageIndex = runtime.agent.state.messages.length;

      let streamFirstTokenAt: number | null = null;
      const streamTelemetryBus = runtime.eventBus as unknown as {
        on: (event: string, handler: (data: { channelId: string; text: string }) => void) => () => void;
      };
      const unsubscribeFirstToken = streamTelemetryBus.on('agent.stream.delta', ({ channelId }) => {
        if (channelId !== message.channelId || streamFirstTokenAt != null) return;
        streamFirstTokenAt = Date.now();
        emitObservedTurnStage('first-token', {
          ttftMs: streamFirstTokenAt - startTime,
          source: 'stream',
        });
      });

      const bridgeToken = runtime.bridge.setChannel(message.channelId, {
        turnId,
        requestId,
        callType: turnCallType,
        originType: turnCallType,
        originStage: 'agent.turn.prompt',
        purpose: 'agent.turn.prompt',
      });
      runtime.setActiveTurnContext(turnCorrelationBase, taskKind ?? null, autoloadOutcome.intent);
      const turnUserContentBuildResult = await buildTurnUserContent({
        message,
        llmClient: runtime.llmClient,
        runtimeMode: runtime.runtimeMode,
        logger: log,
        visionReviewer: runtime.imageVisionReviewer,
      });
      const visionToolRequestContext = {
        ...baseVisionToolRequestContext,
        ...(turnUserContentBuildResult.currentTurnVisionReview
          ? { currentTurnVisionReview: turnUserContentBuildResult.currentTurnVisionReview }
          : {}),
      };
      try {
        await runWithRequestContext(
          {
            ...runtime.withCorrelationPurpose(turnCorrelationBase, 'agent.turn.prompt'),
            ...viewerRequestContext,
          },
          async () => runWithVisionToolRequestContext(
            visionToolRequestContext,
            async () => runtime.agent.prompt({
              role: 'user',
              content: turnUserContentBuildResult.content,
              timestamp: Date.now(),
            } satisfies UserMessage),
          ),
        );
      } finally {
        unsubscribeFirstToken();
        runtime.bridge.clearChannel(bridgeToken);
        runtime.clearActiveTurnContext();
      }
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- closure mutation invisible to narrowing
      if (streamFirstTokenAt == null) {
        streamFirstTokenAt = Date.now();
        emitObservedTurnStage('first-token', {
          ttftMs: streamFirstTokenAt - startTime,
          source: 'fallback',
        });
      }
      emitObservedTurnStage('prompt', {
        durationMs: Date.now() - promptStageStart,
        ttftMs: streamFirstTokenAt - startTime,
      });

      turnMessages = runtime.agent.state.messages.slice(turnStartMessageIndex);
      turnUsage = runtime.accumulateTurnUsage(turnMessages);
      responseModel = runtime.agent.state.model.id;
      firstTokenAt = streamFirstTokenAt;

      responseText = runtime.extractResponseText();
      if (hasVisionTurnInputs(message) && responseText.trim().length === 0) {
        const assistantMessage = runtime.getLatestAssistantMessage();
        log.warn('Vision turn produced empty assistant text; attempting non-fabricating recovery replay', {
          channelId: message.channelId,
          model: runtime.agent.state.model.id,
          stopReason: assistantMessage?.stopReason ?? null,
          errorMessage: assistantMessage?.errorMessage ?? null,
        });

        try {
          const recoveryModel = resolveModel(runtime.config, 'chat');
          runtime.agent.setModel(recoveryModel);
          responseModel = recoveryModel.id;
        } catch (error) {
          log.warn('Vision recovery model resolution failed; keeping current model', {
            channelId: message.channelId,
            error: toErrorMessage(error),
          });
        }

        const replayTransportContent = message.content.trim();
        let recoveryAttempts = 0;
        const runVisionRecoveryPrompt = async (
          content: UserMessage['content'],
          requestSuffix: string,
          originStage: string,
        ): Promise<void> => {
          const bridgeToken = runtime.bridge.setChannel(message.channelId, {
            turnId,
            requestId: `${requestId}:${requestSuffix}`,
            callType: turnCallType,
            originType: turnCallType,
            originStage,
            purpose: originStage,
          });
          runtime.setActiveTurnCorrelation(turnCorrelationBase);
          try {
            await runWithRequestContext(
              {
                ...runtime.withCorrelationPurpose(turnCorrelationBase, originStage),
                ...viewerRequestContext,
              },
              async () => runWithVisionToolRequestContext(
                visionToolRequestContext,
                async () => runtime.agent.prompt({
                  role: 'user',
                  content,
                  timestamp: Date.now(),
                } satisfies UserMessage),
              ),
            );
          } finally {
            runtime.bridge.clearChannel(bridgeToken);
            runtime.setActiveTurnCorrelation(null);
          }
        };

        if (replayTransportContent.length > 0) {
          await runVisionRecoveryPrompt(
            replayTransportContent,
            'vision-recovery',
            'agent.turn.vision_recovery',
          );
          recoveryAttempts += 1;

          turnMessages = runtime.agent.state.messages.slice(turnStartMessageIndex);
          turnUsage = runtime.accumulateTurnUsage(turnMessages);
          responseModel = runtime.agent.state.model.id;
          responseText = runtime.extractResponseText();

          if (responseText.trim().length === 0) {
            log.warn('Vision recovery replay remained empty; retrying once with same transport content', {
              channelId: message.channelId,
              model: runtime.agent.state.model.id,
            });
            await runVisionRecoveryPrompt(
              replayTransportContent,
              'vision-recovery-retry',
              'agent.turn.vision_recovery_retry',
            );
            recoveryAttempts += 1;

            turnMessages = runtime.agent.state.messages.slice(turnStartMessageIndex);
            turnUsage = runtime.accumulateTurnUsage(turnMessages);
            responseModel = runtime.agent.state.model.id;
            responseText = runtime.extractResponseText();
          }
        } else {
          log.warn('Vision recovery replay skipped because transport-normalized content was empty', {
            channelId: message.channelId,
          });
        }

        const finalContentEmpty = responseText.trim().length === 0;
        fallbackDiagnostics = {
          fallback: {
            code: 'vision_empty_response',
            strategy: 'replay_transport_content',
            attempts: recoveryAttempts,
            finalContentEmpty,
            ...(assistantMessage?.stopReason ? { previousStopReason: assistantMessage.stopReason } : {}),
            ...(assistantMessage?.errorMessage ? { previousErrorMessage: assistantMessage.errorMessage } : {}),
          },
        };
        runtime.emitTelemetry('agent.turn.fallback', {
          channelId: message.channelId,
          channelType: message.channelType,
          ...fallbackDiagnostics.fallback,
          ...runtime.withCorrelationPurpose(turnCorrelationBase, 'agent.turn.fallback'),
        });

        if (finalContentEmpty) {
          log.warn('Vision turn remained empty after non-fabricating recovery replay', {
            channelId: message.channelId,
            model: runtime.agent.state.model.id,
          });
        }
      }
    }
    let safeResponseText = responseText;
    let broadcastSafetyMeta: AgentResponse['metadata']['broadcastSafety'] | undefined;
    let assistantSessionEntryId: number | null = null;

    if (channelVisibility === 'broadcast') {
      const visibilityScope = broadcastVisibilityScope ?? 'public_only';
      const classification = classifyBroadcastDraft(responseText);
      const operatorApproval = visibilityScope === 'approved_private_context';
      const approvalRequired = classification.risky && !operatorApproval;
      const provenanceRefs = [...new Set(retrievalProvenanceRefs)];

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
        contextMessageCount: context.messages.length,
        memoryContextChars: memoryContextBlock.length,
        ...runtime.withCorrelationPurpose(turnCorrelationBase, 'broadcast.provenance'),
      };
      runtime.emitTelemetry('broadcast.provenance', provenancePayload);
      log.info('Broadcast provenance', provenancePayload);
    }

    const internalState = runtime.emotionSelfModelRuntime.computeInternalStateForTurn({
      message,
      responseText,
      trustLevel: authorContext.trustLevel,
      canonicalContactKey: authorContext.canonicalContactKey,
      emotionSnapshot,
      toolCallCount: turnUsage.toolCalls,
      sessionChannelId: emotionSessionId,
    });
    const internalStateSnapshotRef = buildInternalStateSnapshotRef(internalState);
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
      authorContext.trustLevel,
    );
    const responseAttachments = await collectGeneratedImageAttachments({
      turnMessages,
      companionDataDir: resolveConfiguredCompanionDataDir(runtime.config),
    });

    if (!broadcastSafetyMeta?.approvalRequired) {
      assistantSessionEntryId = runtime.recordAssistantMessage(
        message,
        turnId,
        requestId,
        safeResponseText,
        authorContext.trustLevel,
        continuityUserId,
        emotionSnapshot,
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
    const agentResponse: AgentResponse = {
      content: safeResponseText,
      channelId: message.channelId,
      ...(responseAttachments.length > 0 ? { attachments: responseAttachments } : {}),
      metadata: {
        model: responseModel,
        inputTokens: turnUsage.inputTokens,
        outputTokens: turnUsage.outputTokens,
        durationMs: completedAt - startTime,
        internalState: cloneInternalState(internalState),
        internalStateSnapshotRef,
        metacognitiveFlags: cloneMetacognitiveFlags(metacognitiveFlags),
        ...(fallbackDiagnostics ? { diagnostics: fallbackDiagnostics } : {}),
        ...(broadcastSafetyMeta ? { broadcastSafety: broadcastSafetyMeta } : {}),
      },
    };
    const inferredPostTurnActions = await runtime.inferPostTurnActions({
      message,
      response: agentResponse,
      turnMessages,
      turnId,
      completedAt,
      contextManifest: context.manifest,
      ...(authorContext.canonicalContactKey ? { canonicalContactKey: authorContext.canonicalContactKey } : {}),
    });
    const completionSignal = deferredContinuationId && turnCallType === 'background'
      ? runtime.queueBackgroundContinuationCompletion(
        deferredContinuationId,
        message,
        agentResponse,
        taskKind ?? null,
        turnIntent,
      )
      : null;
    const postTurnDeliveries = !completionSignal && turnCallType === 'chat'
      ? runtime.dequeueBackgroundContinuationDeliveries(
        runtime.resolveSessionChannelId(message.channelId),
      )
      : [];
    emitObservedTurnStage('end', {
      durationMs: completedAt - startTime,
      ttftMs: firstTokenAt - startTime,
      inputTokens: turnUsage.inputTokens,
      outputTokens: turnUsage.outputTokens,
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
        response: agentResponse,
        turnMessages,
        promptMode: promptOverride.mode,
        promptText: fullPrompt,
        contextMessageCount: context.messages.length,
        memoryContextChars: memoryContextBlock.length,
        trustLevel: authorContext.trustLevel,
        canonicalContactKey: authorContext.canonicalContactKey,
        retrievalProvenanceRefs,
        turnSnapshot,
        turnObservability: {
          stages: observedTurnStages,
          retrievals: observedTurnRetrievals,
          ...(observedTurnSnapshot ? { snapshot: observedTurnSnapshot } : {}),
        },
        internalStateSnapshotRef,
      }),
    );

    await runtime.eventBus.emit('agent.turn.end', {
      message,
      response: agentResponse,
      ...runtime.withCorrelationPurpose(turnCorrelationBase, 'agent.turn.end'),
    });
    if (completionSignal) {
      await runtime.emitBackgroundContinuationEvent(
        'agent.background.continuation.completed',
        {
          channelId: message.channelId,
          continuationId: completionSignal.continuationId,
          sourceMessageId: completionSignal.sourceMessageId,
          deliverySessionId: completionSignal.deliverySessionId,
          queuedForPostTurnDelivery: completionSignal.queuedForPostTurnDelivery,
          hasDeliverableContent: completionSignal.hasDeliverableContent,
          notifyUser: completionSignal.notifyUser,
          notificationReason: completionSignal.notificationReason,
          origin: completionSignal.origin,
          urgency: completionSignal.urgency,
          channelContext: completionSignal.channelContext,
          completionAgeMs: completionSignal.completionAgeMs,
          stale: completionSignal.stale,
          taskKind: completionSignal.taskKind,
          intent: completionSignal.intent,
          completedAt: completionSignal.completedAt,
          queueDepth: completionSignal.queueDepth,
          ...runtime.withCorrelationPurpose(turnCorrelationBase, 'agent.background.continuation.completed'),
        },
      );
    } else if (postTurnDeliveries.length > 0) {
      await runtime.emitBackgroundContinuationEvent(
        'agent.background.continuation.post_turn_delivery',
        {
          channelId: message.channelId,
          deliverySessionId: runtime.resolveSessionChannelId(message.channelId),
          deliveries: postTurnDeliveries,
          ...runtime.withCorrelationPurpose(turnCorrelationBase, 'agent.background.continuation.post_turn_delivery'),
        },
      );
    }
    if (inferredPostTurnActions.length > 0) {
      await runtime.eventBus.emit('agent.post_turn.actions.inferred', {
        message,
        response: agentResponse,
        actions: inferredPostTurnActions,
        ...runtime.withCorrelationPurpose(turnCorrelationBase, 'agent.post_turn.actions.inferred'),
      });
    }
    await runtime.eventBus.emit('agent.turn.usage', {
      message,
      usage: turnUsage,
      ...runtime.withCorrelationPurpose(turnCorrelationBase, 'agent.turn.usage'),
    });

    runtime.memoryExtractor?.maybeExtract(
      message.channelId,
      authorContext.canonicalContactKey,
      turnId,
    ).catch(err => {
      log.error('Memory extraction error', { error: String(err) });
    });

    void runtime.runIntentionPostTurnHooks({
      message,
      response: agentResponse,
      turnMessages,
      turnId,
      completedAt,
      ...(authorContext.canonicalContactKey
        ? { canonicalContactKey: authorContext.canonicalContactKey }
        : {}),
    }).catch((error) => {
      log.error('Intention post-turn hook dispatch error', {
        channelId: message.channelId,
        error: toErrorMessage(error),
      });
    });

    void runtime.emotionSelfModelRuntime.triggerEmotionAppraisal({
      sessionChannelId: emotionSessionId,
      turnId,
      internalState,
      templateVariables,
    }).catch((error) => {
      log.error('Emotion appraisal error', {
        channelId: message.channelId,
        error: toErrorMessage(error),
      });
    });

    void runtime.sessionManager.scheduleAutoCompactionBetweenTurns({
      channelId: message.channelId,
      systemPrompt: fullPrompt,
      memoriesBlock: memoryContextBlock,
      llmProvider: runtime.llmClient,
      channelMeta,
      userId: subjectIdentityKey,
      compactionPromptText: turnSnapshot.sessionContext?.compactionPromptText,
      turnBudgetCharacteristics,
    }).catch((error) => {
      log.error('Auto-compaction dispatch error', {
        channelId: message.channelId,
        error: toErrorMessage(error),
      });
    });

    return agentResponse;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    await runtime.eventBus.emit('agent.error', {
      message,
      error: err,
      ...runtime.withCorrelationPurpose(turnCorrelationBase, 'agent.error'),
    });
    throw err;
  } finally {
    unsubscribeRetrieval();
    restorePinnedSessionContext();
  }
}
