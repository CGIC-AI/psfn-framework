import {
  injectPromptRuntimeTokens,
  orderPromptRuntimeSystemPromptSections,
  type PromptRuntimeSystemPromptBlockId,
} from '../../../identity/prompt-runtime.js';
import { resolveCachedPromptRuntimeLayoutStore } from '../../../identity/prompt-runtime-store-cache.js';
import { composeDefaultRuntimePromptTemplate } from '../../../identity/runtime-prompt-layers.js';
import {
  buildSystemContextPromptBlock,
  contextMessagesToPiMessages,
  mergeSystemContextIntoSystemPrompt,
} from '../../../../primitives/llm/message-conversion.js';
import { runWithRequestContext } from '../../../../primitives/llm/request-context.js';
import { countTokens } from '../../../../primitives/llm/tokens.js';
import { resolveSystemRoleCapabilityMetadata } from '../../../../primitives/llm/models.js';
import type { ContextBudgetTurnCharacteristics } from '../../../../shared/context-budget.js';
import type {
  CorrelationMetadata,
  MessagePromptOverrideMode,
  ObservabilityCallType,
  SubstrateMessage,
} from '../../../../shared/contracts/runtime.js';
import { createComponentLogger } from '../../../../shared/logger.js';
import { resolveMaxHistorySpanMs } from '../../../session/manager-primitives.js';
import { buildInternalStateSnapshotRef, type InternalState } from '../../../self-model/state.js';
import {
  buildPromptSectionTelemetryList,
  extractWrappedPromptSections,
} from '../../../identity/prompt-sections.js';
import type { ContextManifestMemorySeed } from '../../../session/context-manifest.js';
import type { EmotionAppraisalEntry } from '../../../emotion/appraisal.js';
import type { TurnRetrievalTelemetryRecord } from '../../../turns/observability.js';
import { detectTurnObservabilityWarnings } from '../../../turns/observability-warnings.js';
import type { TurnSnapshot } from '../../../turns/snapshot.js';
import type { ResolvedAuthorContext } from '../runtime-context.js';
import type { TurnExecutionObservability } from './observability.js';

const log = createComponentLogger('SubstrateAgent');
type TurnExecutionRuntime = import('../turn-execution-runtime.js').TurnExecutionRuntime;
const DEFAULT_RUNTIME_PROMPT_TEMPLATE = composeDefaultRuntimePromptTemplate();

export interface TurnPromptAssemblyResult {
  promptMode: MessagePromptOverrideMode;
  fullPrompt: string;
  contextMessageCount: number;
  context: Awaited<ReturnType<TurnExecutionRuntime['sessionManager']['buildContext']>>;
  providerSystemPrompt: string;
  piMessages: ReturnType<typeof contextMessagesToPiMessages>;
  templateVariables: Record<string, string>;
}

function readPromptVariable(variables: Record<string, unknown>, key: string): string {
  const value = variables[key];
  return typeof value === 'string' ? value.trim() : '';
}

function buildCurrentDatetimeProximityAnchor(variables: Record<string, unknown>): string {
  const fields = [
    ['weekday', readPromptVariable(variables, 'runtime_current_weekday')],
    ['date', readPromptVariable(variables, 'runtime_current_date_human')],
    ['time', readPromptVariable(variables, 'runtime_current_time_human')],
    ['timezone', readPromptVariable(variables, 'active_timezone')],
    ['iso', readPromptVariable(variables, 'runtime_current_datetime_iso')],
  ] as const;
  const renderedFields = fields
    .filter(([, value]) => value.length > 0)
    .map(([tag, value]) => `<${tag}>${value}</${tag}>`);
  if (renderedFields.length === 0) {
    return '';
  }
  return [
    '<current_datetime>',
    ...renderedFields,
    '</current_datetime>',
  ].join('\n');
}

function stripCurrentDatetimePromptBlocks(text: string): string {
  return text
    .replace(/<current_datetime>\s*[\s\S]*?<\/current_datetime>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function appendCurrentDatetimeProximityAnchor(
  systemPrompt: string,
  variables: Record<string, unknown>,
): { systemPrompt: string; anchor: string } {
  const anchor = buildCurrentDatetimeProximityAnchor(variables);
  if (!anchor) {
    return { systemPrompt, anchor };
  }
  const trimmedSystemPrompt = systemPrompt.trim();
  return {
    systemPrompt: trimmedSystemPrompt
      ? `${trimmedSystemPrompt}\n\n${anchor}`
      : anchor,
    anchor,
  };
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

export async function assembleTurnPrompt(input: {
  runtime: TurnExecutionRuntime;
  message: SubstrateMessage;
  channelType: string | undefined;
  taskKind: string | undefined;
  channelMeta: import('../../../../system/trust/policy.js').ChannelMeta;
  authorContext: ResolvedAuthorContext;
  trustLevel: import('../../../../system/trust/types.js').TrustLevel;
  responseStyle: import('../../../../shared/contracts/runtime.js').ResponseStyle;
  emotionSessionId: string;
  preTurnInternalState: InternalState;
  emotionAppraisalChain: readonly EmotionAppraisalEntry[];
  memoryContextBlock: string;
  scratchpadBlock: string;
  turnBudgetCharacteristics: ContextBudgetTurnCharacteristics;
  continuitySubjectKey: string | undefined;
  temporalRetrievalMode: 'temporal' | undefined;
  viewerRequestContext: Partial<CorrelationMetadata>;
  turnCorrelationBase: CorrelationMetadata;
  turnCallType: ObservabilityCallType;
  turnSnapshot: TurnSnapshot;
  memoryManifestSeed: ContextManifestMemorySeed | undefined;
  getRetrievalProvenanceRefs: () => string[];
  getObservedTurnRetrievals: () => TurnRetrievalTelemetryRecord[];
  observability: Pick<TurnExecutionObservability, 'emitObservedTurnStage' | 'emitTurnSnapshotInBackground'>;
}): Promise<TurnPromptAssemblyResult> {
  const {
    runtime,
    message,
    channelType,
    taskKind,
    channelMeta,
    authorContext,
    trustLevel,
    responseStyle,
    emotionSessionId,
    preTurnInternalState,
    emotionAppraisalChain,
    memoryContextBlock,
    scratchpadBlock,
    turnBudgetCharacteristics,
    continuitySubjectKey,
    temporalRetrievalMode,
    viewerRequestContext,
    turnCorrelationBase,
    turnCallType,
    turnSnapshot,
    memoryManifestSeed,
    getRetrievalProvenanceRefs,
    getObservedTurnRetrievals,
    observability,
  } = input;

  const runtimeNow = new Date();
  const promptOverride = runtime.normalizeTurnPromptOverride(message);
  const promptMode = promptOverride.mode;
  const templateVariables = runtime.buildPromptTemplateVariables(
    message,
    authorContext.resolvedUserName,
    trustLevel,
    channelType,
    authorContext.canonicalContactKey,
    authorContext.subjectIdentityKey,
    runtimeNow,
  );
  templateVariables.runtime_speaking_with_is_machine_intelligence = authorContext.speakingWithIsMachineIntelligence === true
    ? 'true'
    : 'false';
  const preTurnInternalStateSnapshotRef = buildInternalStateSnapshotRef(preTurnInternalState);
  const preTurnMetacognitiveFlags = runtime.emotionSelfModelRuntime.computeMetacognitiveFlagsForTurn({
    internalState: preTurnInternalState,
    responseText: '',
    toolCallCount: 0,
    sessionChannelId: emotionSessionId,
    retrievalProvenanceRefs: getRetrievalProvenanceRefs(),
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
  const dynamicSuffixTemplate = turnSnapshot.prompt?.dynamicSuffixTemplate
    || DEFAULT_RUNTIME_PROMPT_TEMPLATE;
  const renderedDynamicSuffix = stripCurrentDatetimePromptBlocks(injectPromptRuntimeTokens(dynamicSuffixTemplate, {
    now: runtimeNow,
    variables: promptRuntimeVariables,
  }));
  const promptRuntimeLayout = resolveCachedPromptRuntimeLayoutStore(runtime.config);
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
  let renderedStaticPrefix = '';
  let promptPrefix = '';

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
    promptPrefix = renderedStaticPrefix;
  } else {
    promptPrefix = promptOverride.mode === 'custom'
      ? (promptOverride.systemPrompt ?? '')
      : '';
  }
  const fullPrompt = [promptPrefix, renderedDynamicSuffix, ...orderedRuntimeSections.map(section => section.content)]
    .map(section => section.trim())
    .filter(section => section.length > 0)
    .join('\n\n');

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
  const { systemPrompt: providerSystemPrompt, anchor: currentDatetimeProximityAnchor } = appendCurrentDatetimeProximityAnchor(
    stripCurrentDatetimePromptBlocks(mergeSystemContextIntoSystemPrompt(
      context.systemPrompt,
      context.messages,
    )),
    promptRuntimeVariables,
  );
  const systemContextPromptBlock = buildSystemContextPromptBlock(context.messages);
  const contextMessageCount = context.messages.length;
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
        ...(currentDatetimeProximityAnchor
          ? [{
            id: 'runtime.current_datetime',
            title: 'Current Date & Time',
            content: currentDatetimeProximityAnchor,
            charCount: currentDatetimeProximityAnchor.length,
            tokenCount: countTokens(currentDatetimeProximityAnchor),
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
    retrievals: getObservedTurnRetrievals(),
  });
  if (turnObservabilityWarningPayload.observabilityWarnings) {
    log.warn('Turn observability warnings detected', {
      channelId: message.channelId,
      turnId: turnSnapshot.turnId,
      requestId: turnSnapshot.requestId,
      warningCodes: turnObservabilityWarningPayload.observabilityWarnings.map(warning => warning.code),
      counters: turnObservabilityWarningPayload.observabilityCounters,
    });
  }
  observability.emitTurnSnapshotInBackground(turnSnapshot);
  observability.emitObservedTurnStage('context', {
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

  return {
    promptMode,
    fullPrompt,
    contextMessageCount,
    context,
    providerSystemPrompt,
    piMessages,
    templateVariables,
  };
}
