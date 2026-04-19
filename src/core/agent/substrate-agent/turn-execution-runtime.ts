import type { Agent, AgentMessage } from '@mariozechner/pi-agent-core';
import type { AssistantMessage, UserMessage } from '@mariozechner/pi-ai';
import { resolveBroadcastVisibilityScope, classifyBroadcastDraft } from '../../../system/trust/broadcast-safety.js';
import type { EventBus, EventMap } from '../../../shared/event-bus.js';
import type { CostTelemetryPort } from '../../../shared/telemetry/cost-telemetry-port.js';
import { enforceUntrustedCompactionGuard } from '../../identity/prompt-composer.js';
import type { ComposeContext } from '../../identity/prompt-types.js';
import {
  injectPromptRuntimeTokens,
  orderPromptRuntimeSystemPromptSections,
  PromptRuntimeLayoutStore,
  resolvePromptRuntimeLayoutPath,
  type PromptRuntimeSystemPromptBlockId,
} from '../../identity/prompt-runtime.js';
import { getCachedPromptRuntimeLayoutStore } from '../../identity/prompt-runtime-store-cache.js';
import { composeDefaultRuntimePromptTemplate } from '../../identity/runtime-prompt-layers.js';
import { collectGeneratedImageAttachments } from '../../../primitives/images/generated-media.js';
import type { ImageVisionReviewer } from '../../../primitives/images/types.js';
import { runWithVisionToolRequestContext } from '../../../primitives/images/request-context.js';
import { runWithRequestContext } from '../../../primitives/llm/request-context.js';
import {
  buildSystemContextPromptBlock,
  contextMessagesToPiMessages,
  mergeSystemContextIntoSystemPrompt,
} from '../../../primitives/llm/message-conversion.js';
import { countTokens } from '../../../primitives/llm/tokens.js';
import { createComponentLogger } from '../../../shared/logger.js';
import { resolveConfiguredCompanionDataDir } from '../../../persistence/layout.js';
import { resolveSystemRoleCapabilityMetadata } from '../../../primitives/llm/models.js';
import type { SessionManager } from '../../session/manager.js';
import { formatAttributedSystemContent } from '../../session/entry-attribution.js';
import type { ContextManifestMemorySeed } from '../../session/context-manifest.js';
import { resolveMaxHistorySpanMs } from '../../session/manager-primitives.js';
import {
  cloneMetacognitiveFlags,
  type MetacognitiveFlag,
} from '../../self-model/metacognition.js';
import {
  buildInternalStateSnapshotRef,
  cloneInternalState,
  type InternalState,
} from '../../self-model/state.js';
import type { SkillsRuntime } from '../../../faculties/skills/runtime.js';
import type { TurnToolSummary } from '../../../faculties/skills/reflection-nudge.js';
import { MESSAGE_CLASSES } from '../message-classes.js';
import type { SystemNoteMessage } from '../messages.js';
import { classifyChannel, type ChannelMeta } from '../../../system/trust/policy.js';
import { normalizeChannelVisibility, type TrustLevel } from '../../../system/trust/types.js';
import type { SatellitePresencePort } from '../satellite-adapter-port.js';
import {
  resolveActiveEmanationState,
} from '../active-emanation-state.js';
import type { AgentResponse, CorrelationMetadata, InferredPostTurnAction, MessagePromptOverride, MessagePromptOverrideMode, ObservabilityCallType, ResponseStyle, SubstrateMessage, TurnID, TurnRecord, TurnUsage } from '../../../shared/contracts/runtime.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import type { ContextBudgetTurnCharacteristics } from '../../../shared/context-budget.js';
import { isTemporalContextBudgetTurn } from '../../../shared/context-budget.js';
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
import { detectTurnObservabilityWarnings } from '../../turns/observability-warnings.js';
import type {
  TurnPromptResponseSnapshot,
  TurnPromptSnapshot,
  TurnSnapshot,
} from '../../turns/snapshot.js';
import {
  parseDeferredToolHandoffActionId,
} from '../deferred-tool-handoff.js';
import type { EventBridge } from '../event-bridge.js';
import type { RuntimeMode } from '../tool-wiring-validator.js';
import { resolveModel } from '../stream-adapter.js';
import type { LLMProviderPort, MemoryExtractor, MemoryProvider } from '../contracts.js';
import type { MemoryScopeQuery } from '../../../faculties/memory/types.js';
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
import {
  resolveAppearanceContextFromTemplateVariables,
  resolveContinuitySubjectKey,
  type ResolvedAuthorContext,
} from './runtime-context.js';
import type { AutoloadTurnOutcome } from './adaptive-tools-runtime.js';
import type {
  BackgroundContinuationCompletionSignal,
  PendingBackgroundContinuationDelivery,
} from './background-continuation-runtime.js';
import {
  cloneObservedAdaptiveToolSnapshot,
  readActiveTurnToolSchemas,
} from './turn-tool-context.js';
import {
  buildPromptSectionTelemetryList,
  extractWrappedPromptSections,
} from '../../identity/prompt-sections.js';
import {
  buildRuntimeDatetimeAnchorRetryPrompt,
  buildRuntimeDatetimeContradictionRefusal,
  detectRuntimeDatetimeContradiction,
} from './runtime-datetime-contradiction-guard.js';
import { sanitizePersistedReasoningText } from './turn-records.js';

const log = createComponentLogger('SubstrateAgent');
const DEFAULT_RUNTIME_PROMPT_TEMPLATE = composeDefaultRuntimePromptTemplate();
const VISION_TURN_TIMEOUT_MS = 10_000;
function getPromptRuntimeLayoutStore(config: SubstrateConfig): PromptRuntimeLayoutStore {
  const companionDataDir = resolveConfiguredCompanionDataDir(config);
  const filePath = resolvePromptRuntimeLayoutPath(companionDataDir);
  return getCachedPromptRuntimeLayoutStore(filePath, () => new PromptRuntimeLayoutStore(filePath));
}

function buildTurnObservabilityWarningPayload(input: {
  callType: ObservabilityCallType;
  nowMs: number;
  maxHistorySpanMs: number;
  temporalRetrievalMode: boolean;
  snapshot?: TurnSnapshot;
  retrievals: readonly TurnRetrievalTelemetryRecord[];
}): {
  observabilityWarnings?: ReturnType<typeof detectTurnObservabilityWarnings>['warnings'];
  observabilityCounters?: ReturnType<typeof detectTurnObservabilityWarnings>['counters'];
} {
  const warningSummary = detectTurnObservabilityWarnings(input);
  if (warningSummary.warnings.length === 0) {
    return {};
  }
  return {
    observabilityWarnings: warningSummary.warnings,
    observabilityCounters: warningSummary.counters,
  };
}

function buildPromptMessage(
  message: SubstrateMessage,
  speakerRole: 'user' | 'system',
  content: UserMessage['content'],
): UserMessage | SystemNoteMessage {
  if (speakerRole !== 'system' || typeof content !== 'string') {
    return {
      role: 'user',
      content,
      timestamp: Date.now(),
    } satisfies UserMessage;
  }

  return {
    role: 'custom',
    type: 'systemNote',
    messageClass: MESSAGE_CLASSES.systemNote,
    content: formatAttributedSystemContent(content, message.authorName),
    timestamp: Date.now(),
  } satisfies SystemNoteMessage;
}

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
  costTelemetry: CostTelemetryPort;
  satellitePresence: SatellitePresencePort;
  llmClient: LLMProviderPort;
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
  resolveAuthorContext: (message: SubstrateMessage) => Promise<ResolvedAuthorContext>;
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

async function runWithVisionTurnTimeout<T>({
  channelId,
  deadlineAt,
  stage,
  onTimeout,
  run,
}: {
  channelId: string;
  deadlineAt: number | null;
  stage: string;
  onTimeout?: (() => void) | undefined;
  run: () => Promise<T>;
}): Promise<T> {
  if (deadlineAt == null) {
    return run();
  }

  const remainingMs = deadlineAt - Date.now();
  const timeoutError = new Error(`Vision turn timed out after ${VISION_TURN_TIMEOUT_MS}ms`);
  if (remainingMs <= 0) {
    log.warn('Vision turn exceeded its deadline before stage start', {
      channelId,
      stage,
      timeoutMs: VISION_TURN_TIMEOUT_MS,
    });
    if (onTimeout) {
      try {
        onTimeout();
      } catch (error) {
        log.warn('Vision turn timeout cleanup failed', {
          channelId,
          stage,
          error: toErrorMessage(error),
        });
      }
    }
    throw timeoutError;
  }

  let timeoutHandle!: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      log.warn('Vision turn timed out; aborting stage', {
        channelId,
        stage,
        timeoutMs: VISION_TURN_TIMEOUT_MS,
      });
      if (onTimeout) {
        try {
          onTimeout();
        } catch (error) {
          log.warn('Vision turn timeout cleanup failed', {
            channelId,
            stage,
            error: toErrorMessage(error),
          });
        }
      }
      reject(timeoutError);
    }, remainingMs);
  });
  try {
    return await Promise.race([run(), timeoutPromise]);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function readAssistantReasoning(message: AssistantMessage | null): string | undefined {
  if (!message || !Array.isArray(message.content)) return undefined;
  const reasoning = message.content
    .filter((block: unknown): block is { type: string; thinking?: string } => (
      typeof block === 'object'
      && block !== null
      && (block as { type?: unknown }).type === 'thinking'
      && typeof (block as { thinking?: unknown }).thinking === 'string'
    ))
    .map(block => block.thinking?.trim() ?? '')
    .filter(block => block.length > 0)
    .join('\n\n');
  return sanitizePersistedReasoningText(reasoning);
}

function countAssistantToolCalls(message: AssistantMessage | null): number | undefined {
  if (!message || !Array.isArray(message.content)) return undefined;
  const count = message.content.filter((block: unknown) => (
    typeof block === 'object'
    && block !== null
    && (block as { type?: unknown }).type === 'toolCall'
  )).length;
  return count > 0 ? count : undefined;
}

function buildPromptResponseSnapshot(input: {
  assistantMessage: AssistantMessage | null;
  content: string;
  model: string | null;
  stopReason?: string;
}): TurnPromptResponseSnapshot {
  const reasoning = readAssistantReasoning(input.assistantMessage);
  const toolCallCount = countAssistantToolCalls(input.assistantMessage);
  return {
    content: input.content,
    ...(input.model ? { model: input.model } : {}),
    ...(input.assistantMessage?.stopReason
      ? { stopReason: input.assistantMessage.stopReason }
      : input.stopReason
        ? { stopReason: input.stopReason }
        : {}),
    ...(input.assistantMessage?.errorMessage ? { errorMessage: input.assistantMessage.errorMessage } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(toolCallCount !== undefined ? { toolCallCount } : {}),
  };
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
  const temporalRetrievalMode: 'temporal' | undefined = isTemporalContextBudgetTurn(turnBudgetCharacteristics)
    ? 'temporal'
    : undefined;
  const temporalRetrievalCallerContext = temporalRetrievalMode
    ? { retrievalMode: temporalRetrievalMode }
    : undefined;
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
  const routingPresenceResolution = resolveActiveEmanationState(
    message.routing?.presence ?? message.routing?.wyoming?.presence,
  );
  const canonicalPresence = routingPresenceResolution.presence;
  const canonicalSatellitePresence = runtime.satellitePresence.resolveCanonicalSatellite(canonicalPresence);
  const canonicalEmbodimentContext = runtime.satellitePresence.resolveCanonicalEmbodiment(canonicalPresence);
  if (canonicalPresence) {
    const nextRouting = {
      ...(message.routing ?? {}),
      ...(canonicalPresence.channelPrivacy ? { channelPrivacy: canonicalPresence.channelPrivacy } : {}),
      presence: canonicalPresence,
    };
    if (message.routing?.wyoming || canonicalSatellitePresence) {
      nextRouting.wyoming = {
        ...(message.routing?.wyoming ?? {}),
        ...(canonicalSatellitePresence?.siteId ? { siteId: canonicalSatellitePresence.siteId } : {}),
        ...(canonicalSatellitePresence ? { satelliteId: canonicalSatellitePresence.satelliteId } : {}),
        presence: canonicalPresence,
      };
    }
    message.routing = nextRouting;
  }
  const authorContext = await runtime.resolveAuthorContext(message);
  const resolvedChannelPrivacy = normalizeChannelVisibility(message.routing?.channelPrivacy)
    ?? authorContext.channelPrivacyLevel;
  if (resolvedChannelPrivacy && message.routing?.channelPrivacy !== resolvedChannelPrivacy) {
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
  const embodimentContext = canonicalEmbodimentContext;
  const viewerRequestContext = {
    viewerTrustLevel: authorContext.trustLevel,
    viewerChannelVisibility: channelVisibility,
    ...(message.isDirectMessage !== undefined ? { viewerIsDirectMessage: message.isDirectMessage } : {}),
    ...(embodimentContext ? { embodimentContext } : {}),
  };
  const baseVisionToolRequestContext = {
    userMessageText: message.content,
    imageAttachmentUrls: collectVisionTurnImageUrls(message),
  };
  void runtime.eventBus.emit('agent.turn.start', {
    message,
    ...runtime.withCorrelationPurpose(turnCorrelationBase, 'agent.turn.start'),
  });
  const continuitySubjectKey = authorContext.continuitySubjectKey
    ?? resolveContinuitySubjectKey({
      canonicalContactKey: authorContext.canonicalContactKey,
      subjectIdentityKey: authorContext.subjectIdentityKey,
      authorId: message.authorId,
    });
  const attributedSystemContent = authorContext.speakerRole === 'system'
    ? formatAttributedSystemContent(message.content, message.authorName)
    : message.content;
  emitObservedTurnStage('trust', {
    durationMs: Date.now() - trustStageStart,
    trustLevel: authorContext.trustLevel,
    canonicalContactKey: authorContext.canonicalContactKey ?? null,
  });

  runtime.emotionSelfModelRuntime.assertSelfModelRuntimeConfigured();
  await runtime.sessionManager.awaitPendingAutoCompaction(message.channelId);

  const userSessionEntryId = authorContext.speakerRole === 'system'
    ? runtime.recordSystemMessage(
      message,
      turnId,
      requestId,
      attributedSystemContent,
      continuitySubjectKey,
    )
    : runtime.recordUserMessage(
      message,
      turnId,
      requestId,
      authorContext.trustLevel,
      continuitySubjectKey,
    );
  const emotionSessionId = runtime.resolveSessionChannelId(message.channelId);
  const trustLevel = authorContext.trustLevel;
  const speakerRole = authorContext.speakerRole;
  const canonicalContactKey = authorContext.canonicalContactKey;
  let promptMode: MessagePromptOverrideMode = 'default';
  let fullPrompt = '';
  let contextMessageCount = 0;
  let memoryContextChars = 0;
  let turnSnapshot: TurnSnapshot | undefined;
  let turnMessages: AgentMessage[] = [];
  let responseModel = runtime.agent.state.model.id;
  let assistantSessionEntryId: number | null = null;
  let internalStateSnapshotRef: string | undefined;
  let turnStartMessageIndex: number | null = null;

  try {
    const channelType = runtime.resolveChannelType(message);
    const memoryProvider = runtime.memoryProvider as ProactiveMemoryProvider | null;
    const bypassMemoryForVisionTurn = hasVisionTurnInputs(message);
    runtime.ensureModel(message);
    responseModel = runtime.agent.state.model.id;
    const promptSnapshot = runtime.captureTurnPromptSnapshot({ channelType, taskKind });
    const sessionContextSnapshot = typeof (runtime.sessionManager as SessionManager & {
      captureTurnContextSnapshot?: SessionManager['captureTurnContextSnapshot'];
    }).captureTurnContextSnapshot === 'function'
      ? runtime.sessionManager.captureTurnContextSnapshot(
        message.channelId,
        continuitySubjectKey,
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
          temporalRetrievalCallerContext,
          temporalRetrievalMode,
        )
        : Promise.resolve(undefined),
    ]);
    const emotionAppraisalChain = runtime.emotionSelfModelRuntime.getEmotionAppraisalChain(emotionSessionId);
    turnSnapshot = {
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
    void emitTurnSnapshot(turnSnapshot);

    const memoryStageStart = Date.now();
    const internalStatePromise = runtime.emotionSelfModelRuntime.computeInternalStateForTurn({
      message,
      responseText: '',
      trustLevel,
      canonicalContactKey: authorContext.canonicalContactKey,
      emotionSnapshot,
      toolCallCount: 0,
      sessionChannelId: emotionSessionId,
    });
    const memoryPromise = runWithRequestContext(
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
            temporalRetrievalCallerContext,
            temporalRetrievalMode,
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
    const [{ memoriesBlock, proactiveRecallBlock }, preTurnInternalState] = await Promise.all([
      memoryPromise,
      internalStatePromise,
    ]);
    const memoryContextBlock = [memoriesBlock, proactiveRecallBlock]
      .map(section => section.trim())
      .filter(section => section.length > 0)
      .join('\n\n');
    memoryContextChars = memoryContextBlock.length;
    const scratchpadBlock = runtime.buildScratchpadContextBlock();
    emitObservedTurnStage('memory', {
      durationMs: Date.now() - memoryStageStart,
      hasMemoryProvider: memoryProvider != null,
      memoryChars: memoryContextChars,
      proactiveRecallChars: proactiveRecallBlock.length,
      proactiveRecallIncluded: proactiveRecallBlock.length > 0,
      memoryBypassedForVisionTurn: bypassMemoryForVisionTurn,
      scratchpadChars: scratchpadBlock.length,
      scratchpadIncluded: scratchpadBlock.length > 0,
    });

    const runtimeNow = new Date();
    const promptOverride = runtime.normalizeTurnPromptOverride(message);
    promptMode = promptOverride.mode;
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
    const dynamicPromptVariables = runtime.buildDynamicPromptTemplateVariables(
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
    const promptRuntimeVariables = {
      ...templateVariables,
      ...dynamicPromptVariables,
    };
    let runtimeContext = '';
    runtimeContext = runtime.buildRuntimeContext(
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
    let renderedStaticPrefix = '';
    let renderedDynamicSuffix = '';
    const dynamicSuffixTemplate = turnSnapshot.prompt?.dynamicSuffixTemplate
      || DEFAULT_RUNTIME_PROMPT_TEMPLATE;
    renderedDynamicSuffix = injectPromptRuntimeTokens(dynamicSuffixTemplate, {
      now: runtimeNow,
      variables: promptRuntimeVariables,
    });

    if (promptOverride.mode === 'default') {
      const promptRuntimeLayout = getPromptRuntimeLayoutStore(runtime.config);
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
      const orderedRuntimeSections = orderPromptRuntimeSystemPromptSections([
        {
          id: 'runtime.persona_adaptation' as PromptRuntimeSystemPromptBlockId,
          content: personaHint ?? '',
        },
        {
          id: 'runtime.context' as PromptRuntimeSystemPromptBlockId,
          content: runtimeContext,
        },
        {
          id: 'runtime.scratchpad' as PromptRuntimeSystemPromptBlockId,
          content: scratchpadBlock,
        },
      ], promptRuntimeLayout);
      fullPrompt = [renderedStaticPrefix, renderedDynamicSuffix, ...orderedRuntimeSections.map(section => section.content)]
        .map(section => section.trim())
        .filter(section => section.length > 0)
        .join('\n\n');
    } else {
      const customPrompt = promptOverride.mode === 'custom'
        ? (promptOverride.systemPrompt ?? '')
        : '';
      const promptRuntimeLayout = getPromptRuntimeLayoutStore(runtime.config);
      const orderedRuntimeSections = orderPromptRuntimeSystemPromptSections([
        {
          id: 'runtime.persona_adaptation' as PromptRuntimeSystemPromptBlockId,
          content: runtime.getPersonaAdaptation(
            trustLevel,
            preTurnInternalState,
            preTurnMetacognitiveFlags,
            templateVariables,
          ) ?? '',
        },
        {
          id: 'runtime.context' as PromptRuntimeSystemPromptBlockId,
          content: runtimeContext,
        },
        {
          id: 'runtime.scratchpad' as PromptRuntimeSystemPromptBlockId,
          content: scratchpadBlock,
        },
      ], promptRuntimeLayout);
      fullPrompt = [customPrompt, renderedDynamicSuffix, ...orderedRuntimeSections.map(section => section.content)]
        .map(section => section.trim())
        .filter(section => section.length > 0)
        .join('\n\n');
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
        continuitySubjectKey,
        channelMeta,
        authorContext.continuityFallbackKeys,
        turnSnapshot.sessionContext,
        memoryManifestSeed,
        turnBudgetCharacteristics,
      ),
    );
    const providerSystemPrompt = mergeSystemContextIntoSystemPrompt(
      context.systemPrompt,
      context.messages,
    );
    const systemContextPromptBlock = buildSystemContextPromptBlock(context.messages);
    contextMessageCount = context.messages.length;
    turnSnapshot.capturedAt = Date.now();
    const providerModel = runtime.agent.state.model;
    const providerSystemRole = resolveSystemRoleCapabilityMetadata(providerModel);
    const providerWireMessages = [];
    if (providerSystemPrompt) {
      providerWireMessages.push({
        role: providerSystemRole.transport === 'openai_developer'
          ? 'developer'
          : providerSystemRole.transport === 'google_system_instruction'
            ? 'system_instruction'
            : 'system',
        source: 'system_prompt',
        content: providerSystemPrompt,
      });
    }
    const piMessages = contextMessagesToPiMessages(context.messages);
    for (const providerMessage of piMessages) {
      providerWireMessages.push({
        role: providerMessage.role === 'assistant' ? 'assistant' : 'user',
        source: 'message',
        content: typeof providerMessage.content === 'string'
          ? providerMessage.content
          : JSON.stringify(providerMessage.content),
      });
    }
    turnSnapshot.promptContext = {
      renderedStaticPrefix,
      renderedDynamicSuffix,
      runtimeContext,
      memoryContextBlock,
      scratchpadContext: scratchpadBlock,
      assembledPrompt: fullPrompt,
      finalSystemPrompt: providerSystemPrompt,
      messages: context.messages.map(contextMessage => ({ ...contextMessage })),
      inputSections: buildPromptSectionTelemetryList([
        {
          id: 'rendered_static_prefix',
          title: 'Rendered Static Prefix',
          content: renderedStaticPrefix,
        },
        {
          id: 'rendered_dynamic_suffix',
          title: 'Rendered Dynamic Suffix',
          content: renderedDynamicSuffix,
        },
        {
          id: 'runtime_context',
          title: 'Runtime Context',
          content: runtimeContext,
        },
        {
          id: 'memory_context',
          title: 'Memory Context',
          content: memoryContextBlock,
        },
        {
          id: 'scratchpad_context',
          title: 'Scratchpad Context',
          content: scratchpadBlock,
        },
      ]),
      runtimeContextSections: extractWrappedPromptSections(runtimeContext),
      finalSystemSections: context.systemPromptSections
        ? [
          ...context.systemPromptSections,
          ...(systemContextPromptBlock
            ? [{
              id: 'session_context',
              title: 'Session Context',
              content: systemContextPromptBlock,
              charCount: systemContextPromptBlock.length,
              tokenCount: countTokens(systemContextPromptBlock),
            }]
            : []),
        ]
        : buildPromptSectionTelemetryList([
          {
            id: 'final_system_prompt',
            title: 'Final System Prompt',
            content: providerSystemPrompt,
          },
        ]),
      providerObservability: {
        routeKind: providerModel.provider === 'litellm' ? 'configured_litellm_proxy' : 'registered_model',
        requestedProvider: providerModel.provider,
        requestedModel: providerModel.id,
        backendProvider: providerModel.provider,
        backendModel: providerModel.id,
        backendApi: providerModel.api,
        ...(providerModel.baseUrl ? { backendBaseUrl: providerModel.baseUrl } : {}),
        systemRole: providerSystemRole,
        providerWireMessages,
      },
    };
    const turnObservabilityWarningPayload = buildTurnObservabilityWarningPayload({
      callType: turnCallType,
      nowMs: Date.now(),
      maxHistorySpanMs: resolveMaxHistorySpanMs(runtime.config),
      temporalRetrievalMode: temporalRetrievalMode === 'temporal',
      snapshot: turnSnapshot,
      retrievals: observedTurnRetrievals,
    });
    if (turnObservabilityWarningPayload.observabilityWarnings) {
      log.warn('Turn observability warnings detected', {
        channelId: message.channelId,
        turnId,
        requestId,
        warningCodes: turnObservabilityWarningPayload.observabilityWarnings.map(warning => warning.code),
        counters: turnObservabilityWarningPayload.observabilityCounters,
      });
    }
    void emitTurnSnapshot(turnSnapshot);
    emitObservedTurnStage('context', {
      durationMs: Date.now() - contextStageStart,
      contextMessages: contextMessageCount,
      systemPromptChars: providerSystemPrompt.length,
      systemPromptTokens: countTokens(providerSystemPrompt),
      assembledPromptChars: fullPrompt.length,
      assembledPromptTokens: countTokens(fullPrompt),
      promptMode,
      ...turnObservabilityWarningPayload,
      ...(turnSnapshot.sessionContext?.orientation
        ? {
          orientationFired: turnSnapshot.sessionContext.orientation.fired,
          orientationReason: turnSnapshot.sessionContext.orientation.reason,
          orientationIdleGapMs: turnSnapshot.sessionContext.orientation.idleGapMs,
          orientationThresholdMs: turnSnapshot.sessionContext.orientation.idleThresholdMs,
          orientationNoteChars: turnSnapshot.sessionContext.orientation.noteText?.length ?? 0,
        }
        : {}),
    });

    const promptStageStart = Date.now();
    let firstTokenAt: number;
    let turnUsage: TurnUsage;
    let responseText: string;
    let fallbackDiagnostics: AgentResponse['metadata']['diagnostics'] | undefined;
    let runtimeContradictionDiagnostics: NonNullable<AgentResponse['metadata']['diagnostics']> | undefined;
    let turnIntent: string | null = null;
    const isVisionTurn = hasVisionTurnInputs(message);
    const visionTurnDeadlineAt = isVisionTurn ? promptStageStart + VISION_TURN_TIMEOUT_MS : null;

    const moaSettings = resolveMoaSettings(runtime.config, log);
    if (moaSettings) {
      const moaResult = await runWithVisionTurnTimeout({
        channelId: message.channelId,
        deadlineAt: visionTurnDeadlineAt,
        stage: 'moa_turn',
        run: () => runMoaTurn({
          llmClient: runtime.llmClient,
          context,
          message,
          settings: moaSettings,
          turnId,
          requestId,
          callType: turnCallType,
          contextWindow: runtime.resolveContextWindow(),
          emitTelemetry: (eventName, payload) => runtime.emitTelemetry(eventName, payload),
        }),
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
      if (turnSnapshot.promptContext) {
        turnSnapshot.promptContext.response = {
          content: moaResult.output,
          model: moaResult.model,
          stopReason: moaResult.stopReason,
        };
        turnSnapshot.capturedAt = Date.now();
        void emitTurnSnapshot(turnSnapshot);
      }
    } else {
      runtime.agent.setSystemPrompt(enforceUntrustedCompactionGuard(providerSystemPrompt));
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
        void emitTurnSnapshot(turnSnapshot);
      }

      const agentMessages: AgentMessage[] = piMessages;
      const historyMessages = agentMessages.length > 0 ? agentMessages.slice(0, -1) : [];
      runtime.agent.replaceMessages(historyMessages);
      turnStartMessageIndex = runtime.agent.state.messages.length;

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
      const turnUserContentBuildResult = await runWithVisionTurnTimeout({
        channelId: message.channelId,
        deadlineAt: visionTurnDeadlineAt,
        stage: 'build_turn_user_content',
        run: () => buildTurnUserContent({
          message,
          llmClient: runtime.llmClient,
          runtimeMode: runtime.runtimeMode,
          logger: log,
          visionReviewer: runtime.imageVisionReviewer,
        }),
      });
      const selfieAppearanceContext = activeTools.some((tool) => tool.name === 'selfie_create')
        ? resolveAppearanceContextFromTemplateVariables(templateVariables)
        : undefined;
      const visionToolRequestContext = {
        ...baseVisionToolRequestContext,
        ...(selfieAppearanceContext !== undefined
          ? { appearanceContext: selfieAppearanceContext }
          : {}),
        ...(turnUserContentBuildResult.currentTurnVisionReview
          ? { currentTurnVisionReview: turnUserContentBuildResult.currentTurnVisionReview }
          : {}),
      };
      if (turnSnapshot.promptContext) {
        turnSnapshot.promptContext.currentTurnInput = turnUserContentBuildResult.content;
        turnSnapshot.capturedAt = Date.now();
        void emitTurnSnapshot(turnSnapshot);
      }
      try {
        await runWithVisionTurnTimeout({
          channelId: message.channelId,
          deadlineAt: visionTurnDeadlineAt,
          stage: 'agent_prompt',
          onTimeout: () => runtime.agent.abort(),
          run: () => runWithRequestContext(
            {
              ...runtime.withCorrelationPurpose(turnCorrelationBase, 'agent.turn.prompt'),
              ...viewerRequestContext,
            },
            async () => runWithVisionToolRequestContext(
              visionToolRequestContext,
              async () => runtime.agent.prompt(
                buildPromptMessage(message, speakerRole, turnUserContentBuildResult.content),
              ),
            ),
          ),
        });
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

      turnMessages = runtime.agent.state.messages.slice(turnStartMessageIndex);
      turnUsage = runtime.accumulateTurnUsage(turnMessages);
      responseModel = runtime.agent.state.model.id;
      firstTokenAt = streamFirstTokenAt;

      responseText = runtime.extractResponseText();
      const runtimeContradictionDetection = detectRuntimeDatetimeContradiction(
        turnSnapshot.promptContext,
        responseText,
      );
      if (runtimeContradictionDetection.anchorDetected && runtimeContradictionDetection.contradictionDetected) {
        runtimeContradictionDiagnostics = {
          runtimeContradiction: {
            code: 'runtime_datetime_anchor_contradiction',
            anchorDetected: true,
            matchedSignals: [...runtimeContradictionDetection.matchedSignals],
            attempts: 1,
            retryAttempted: true,
            retrySucceeded: false,
            refusalApplied: false,
          },
        };
        log.warn('Runtime datetime contradiction detected; retrying with strengthened anchor', {
          channelId: message.channelId,
          matchedSignals: runtimeContradictionDetection.matchedSignals,
        });

        const preRetryTurnUsage = turnUsage;
        const strengthenedSystemPrompt = buildRuntimeDatetimeAnchorRetryPrompt(providerSystemPrompt);
        runtime.agent.replaceMessages(historyMessages);
        runtime.agent.setSystemPrompt(enforceUntrustedCompactionGuard(strengthenedSystemPrompt));

        const contradictionRetryBridgeToken = runtime.bridge.setChannel(message.channelId, {
          turnId,
          requestId: `${requestId}:runtime-contradiction-retry`,
          callType: turnCallType,
          originType: turnCallType,
          originStage: 'agent.turn.runtime_contradiction_retry',
          purpose: 'agent.turn.runtime_contradiction_retry',
        });
        runtime.setActiveTurnContext(turnCorrelationBase, taskKind ?? null, autoloadOutcome.intent);
        try {
          await runWithVisionTurnTimeout({
            channelId: message.channelId,
            deadlineAt: visionTurnDeadlineAt,
            stage: 'agent_turn_runtime_contradiction_retry',
            onTimeout: () => runtime.agent.abort(),
            run: () => runWithRequestContext(
              {
                ...runtime.withCorrelationPurpose(turnCorrelationBase, 'agent.turn.runtime_contradiction_retry'),
                ...viewerRequestContext,
              },
              async () => runWithVisionToolRequestContext(
                visionToolRequestContext,
                async () => runtime.agent.prompt(
                  buildPromptMessage(message, speakerRole, turnUserContentBuildResult.content),
                ),
              ),
            ),
          });
        } finally {
          runtime.bridge.clearChannel(contradictionRetryBridgeToken);
          runtime.clearActiveTurnContext();
        }

        turnMessages = runtime.agent.state.messages.slice(turnStartMessageIndex);
        const retryTurnUsage = runtime.accumulateTurnUsage(turnMessages);
        turnUsage = {
          inputTokens: preRetryTurnUsage.inputTokens + retryTurnUsage.inputTokens,
          outputTokens: preRetryTurnUsage.outputTokens + retryTurnUsage.outputTokens,
          cacheReadTokens: preRetryTurnUsage.cacheReadTokens + retryTurnUsage.cacheReadTokens,
          llmCalls: preRetryTurnUsage.llmCalls + retryTurnUsage.llmCalls,
          toolCalls: preRetryTurnUsage.toolCalls + retryTurnUsage.toolCalls,
          contextUtilization: Math.max(preRetryTurnUsage.contextUtilization, retryTurnUsage.contextUtilization),
          ...(preRetryTurnUsage.estimatedCostUsd !== undefined || retryTurnUsage.estimatedCostUsd !== undefined
            ? { estimatedCostUsd: (preRetryTurnUsage.estimatedCostUsd ?? 0) + (retryTurnUsage.estimatedCostUsd ?? 0) }
            : {}),
        };
        responseModel = runtime.agent.state.model.id;
        responseText = runtime.extractResponseText();

        const retryContradictionDetection = detectRuntimeDatetimeContradiction(
          turnSnapshot.promptContext,
          responseText,
        );
        if (retryContradictionDetection.contradictionDetected) {
          const baseRuntimeContradiction = runtimeContradictionDiagnostics.runtimeContradiction;
          runtimeContradictionDiagnostics = {
            runtimeContradiction: {
              ...baseRuntimeContradiction,
              attempts: 2,
              retrySucceeded: false,
              refusalApplied: true,
            },
          };
          responseText = buildRuntimeDatetimeContradictionRefusal();
        } else {
          const baseRuntimeContradiction = runtimeContradictionDiagnostics.runtimeContradiction;
          runtimeContradictionDiagnostics = {
            runtimeContradiction: {
              ...baseRuntimeContradiction,
              attempts: 2,
              retrySucceeded: true,
              refusalApplied: false,
            },
          };
        }
      }
      if (isVisionTurn && responseText.trim().length === 0) {
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
            await runWithVisionTurnTimeout({
              channelId: message.channelId,
              deadlineAt: visionTurnDeadlineAt,
              stage: originStage,
              onTimeout: () => runtime.agent.abort(),
              run: () => runWithRequestContext(
                {
                  ...runtime.withCorrelationPurpose(turnCorrelationBase, originStage),
                  ...viewerRequestContext,
                },
                async () => runWithVisionToolRequestContext(
                  visionToolRequestContext,
                  async () => runtime.agent.prompt(buildPromptMessage(message, speakerRole, content)),
                ),
              ),
            });
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
      emitObservedTurnStage('prompt', {
        durationMs: Date.now() - promptStageStart,
        ttftMs: streamFirstTokenAt - startTime,
        ...(runtimeContradictionDiagnostics
          ? {
            runtimeContradictionRetry: true,
            runtimeContradictionAttempts: runtimeContradictionDiagnostics.runtimeContradiction.attempts,
          }
          : {}),
      });
      if (turnSnapshot.promptContext) {
        turnSnapshot.promptContext.response = buildPromptResponseSnapshot({
          assistantMessage: runtime.getLatestAssistantMessage(),
          content: responseText,
          model: responseModel,
        });
        turnSnapshot.capturedAt = Date.now();
        await emitTurnSnapshot(turnSnapshot);
      }
    }
    let safeResponseText = responseText;
    let broadcastSafetyMeta: AgentResponse['metadata']['broadcastSafety'] | undefined;

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
        contextMessageCount,
        memoryContextChars,
        ...runtime.withCorrelationPurpose(turnCorrelationBase, 'broadcast.provenance'),
      };
      runtime.emitTelemetry('broadcast.provenance', provenancePayload);
      log.info('Broadcast provenance', provenancePayload);
    }

    const internalState = await runtime.emotionSelfModelRuntime.computeInternalStateForTurn({
      message,
      responseText,
      trustLevel,
      canonicalContactKey,
      emotionSnapshot,
      toolCallCount: turnUsage.toolCalls,
      sessionChannelId: emotionSessionId,
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
        trustLevel,
        continuitySubjectKey,
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
    const responseDiagnostics: NonNullable<AgentResponse['metadata']['diagnostics']> = {};
    if (fallbackDiagnostics?.fallback) {
      responseDiagnostics.fallback = fallbackDiagnostics.fallback;
    }
    if (runtimeContradictionDiagnostics?.runtimeContradiction) {
      responseDiagnostics.runtimeContradiction = runtimeContradictionDiagnostics.runtimeContradiction;
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
        internalState: cloneInternalState(internalState),
        internalStateSnapshotRef,
        metacognitiveFlags: cloneMetacognitiveFlags(metacognitiveFlags),
        ...(Object.keys(responseDiagnostics).length > 0 ? { diagnostics: responseDiagnostics } : {}),
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
      ...(canonicalContactKey ? { canonicalContactKey } : {}),
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
        promptMode,
        promptText: fullPrompt,
        contextMessageCount,
        memoryContextChars,
        trustLevel,
        speakerRole,
        canonicalContactKey,
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
    await runtime.costTelemetry.recordTurnUsage({
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
      userId: continuitySubjectKey,
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
    const observedFailureTurnMessages = turnMessages.length > 0
      ? turnMessages
      : turnStartMessageIndex == null
        ? []
        : runtime.agent.state.messages.slice(turnStartMessageIndex);
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
        retrievalProvenanceRefs,
        ...(turnSnapshot ? { turnSnapshot } : {}),
        turnObservability: {
          stages: observedTurnStages,
          retrievals: observedTurnRetrievals,
          ...(observedTurnSnapshot ? { snapshot: observedTurnSnapshot } : {}),
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
    unsubscribeRetrieval();
    restorePinnedSessionContext();
  }
}
