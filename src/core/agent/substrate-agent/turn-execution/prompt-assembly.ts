import {
  injectPromptRuntimeTokens,
  orderPromptRuntimeSystemPromptSections,
  type PromptRuntimeSystemPromptBlockId,
} from '../../../identity/prompt-runtime.js';
import { TurnPromptVariableNamespace } from '../../../identity/prompt-variable-namespace.js';
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
  FatigueEnforcementMetadata,
  LLMProviderWireMessage,
  MessagePromptOverrideMode,
  ObservabilityCallType,
  SubstrateMessage,
} from '../../../../shared/contracts/runtime.js';
import { buildAuthenticityProvenance } from '../../../../shared/authenticity-provenance.js';
import { createComponentLogger } from '../../../../shared/logger.js';
import { resolveMaxHistorySpanMs } from '../../../session/manager-primitives.js';
import { buildInternalStateSnapshotRef, type InternalState } from '../../../self-model/state.js';
import {
  buildPromptSectionTelemetryList,
  extractWrappedPromptSections,
} from '../../../identity/prompt-sections.js';
import {
  buildTurnPromptSectionScopeResolver,
  resolveTurnPromptScopeKeys,
} from '../../../identity/prompt-section-provenance.js';
import type { ContextManifestMemorySeed } from '../../../session/context-manifest.js';
import type { EmotionAppraisalEntry } from '../../../emotion/appraisal.js';
import type { TurnRetrievalTelemetryRecord } from '../../../turns/observability.js';
import { detectTurnObservabilityWarnings } from '../../../turns/observability-warnings.js';
import type { TurnSnapshot } from '../../../turns/snapshot.js';
import { buildFatiguePromptAlert } from '../../fatigue/runtime-enforcement.js';
import type { ResolvedAuthorContext, UserRuntimeProfile } from '../runtime-context.js';
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
    ['iso', readPromptVariable(variables, 'runtime_current_datetime_iso')],
    ['timezone', readPromptVariable(variables, 'active_timezone')],
    ['weekday', readPromptVariable(variables, 'runtime_current_weekday')],
    ['date', readPromptVariable(variables, 'runtime_current_date_human')],
    ['time', readPromptVariable(variables, 'runtime_current_time_human')],
    ['today', readPromptVariable(variables, 'runtime_current_today')],
    ['yesterday', readPromptVariable(variables, 'runtime_current_yesterday')],
    ['tomorrow', readPromptVariable(variables, 'runtime_current_tomorrow')],
    ['part_of_day', readPromptVariable(variables, 'runtime_current_part_of_day')],
  ] as const;
  const renderedFields = fields
    .filter(([, value]) => value.length > 0)
    .map(([tag, value]) => `<${tag}>${value}</${tag}>`);
  if (renderedFields.length === 0) {
    return '';
  }
  return [
    '<runtime.current_datetime authority="canonical" overrides="memory,conversation_history,continuity_anchor,wake_orientation,cross_channel_continuity">',
    ...renderedFields,
    '</runtime.current_datetime>',
  ].join('\n');
}

function stripCurrentDatetimePromptBlocks(text: string): string {
  return text
    .replace(/<runtime\.current_datetime(?:\s+[^>]*)?>\s*[\s\S]*?<\/runtime\.current_datetime>/g, '')
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

function buildCurrentUserRuntimeProfile(input: {
  authorContext: ResolvedAuthorContext;
  message: SubstrateMessage;
}): UserRuntimeProfile | undefined {
  const timezone = input.authorContext.timezone?.trim();
  if (!timezone) return undefined;

  const userId = input.message.authorId.trim()
    || input.authorContext.subjectIdentityKey?.trim()
    || input.authorContext.canonicalContactKey?.trim();
  if (!userId) return undefined;

  return {
    user_id: userId,
    display_name: input.message.authorName.trim()
      || input.authorContext.resolvedUserName.trim()
      || userId,
    timezone,
  };
}

export async function assembleTurnPrompt(input: {
  runtime: TurnExecutionRuntime;
  message: SubstrateMessage;
  channelType: string | undefined;
  taskKind: string | undefined;
  channelMeta: import('../../../../system/trust/policy.js').ChannelMeta;
  authorContext: ResolvedAuthorContext;
  conversationScope: import('../../../session/conversation-scope.js').ConversationScope;
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
  fatigue?: FatigueEnforcementMetadata;
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
    conversationScope,
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
    fatigue,
    getRetrievalProvenanceRefs,
    getObservedTurnRetrievals,
    observability,
  } = input;

  const runtimeNow = new Date();
  const promptOverride = runtime.normalizeTurnPromptOverride(message);
  const promptMode = promptOverride.mode;
  // Single construction path for the turn's prompt variables. Every variable is
  // registered against the macro manifest, duplicate writes throw, and the
  // namespace freezes before any template rendering happens.
  //
  // SEAM (E2 epic): the turn's ConversationScope (resolved once at
  // session-manager ingress) now feeds the scope-derived variables; the 'turn'
  // phase inputs will later come from a Context Envelope. Keep this two-phase
  // assemble/freeze shape — that is where the envelope slots in.
  const variableNamespace = new TurnPromptVariableNamespace();
  variableNamespace.assignRecord(
    'session',
    runtime.buildPromptTemplateVariables(
      message,
      authorContext.resolvedUserName,
      trustLevel,
      channelType,
      authorContext.canonicalContactKey,
      authorContext.subjectIdentityKey,
      runtimeNow,
    ),
    'substrate-agent:buildPromptTemplateVariables',
  );
  // E1.3: the machine-intelligence flag is part of the one-on-one speaking_with
  // binding, so it is gated to DM scope alongside runtime_speaking_with_name /
  // _trust_level. On group turns it is blank (absent), matching the other
  // speaking_with tokens so {{#if}} sections prune cleanly. DM turns keep the
  // byte-identical 'true'/'false' value.
  variableNamespace.assign(
    'session',
    'runtime_speaking_with_is_machine_intelligence',
    conversationScope.kind === 'dm'
      ? (authorContext.speakingWithIsMachineIntelligence === true ? 'true' : 'false')
      : '',
    'turn-execution:assembleTurnPrompt',
  );
  const templateVariables = variableNamespace.snapshotPhase('session') as Record<string, string>;
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
  variableNamespace.assignRecord(
    'turn',
    runtime.buildDynamicPromptTemplateVariables(
      message,
      authorContext.resolvedUserName,
      trustLevel,
      authorContext.relationshipType,
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
      buildCurrentUserRuntimeProfile({ authorContext, message }),
      conversationScope,
    ),
    'substrate-agent:buildDynamicPromptTemplateVariables',
  );
  // The namespace freezes before rendering: any later write throws.
  const { variables: promptRuntimeVariables } = variableNamespace.freeze();
  const runtimeContext = runtime.buildRuntimeContext(
    message,
    authorContext.resolvedUserName,
    trustLevel,
    authorContext.relationshipType,
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
    conversationScope,
  );
  const runtimeContextWithFatigue = [
    runtimeContext,
    buildFatiguePromptAlert(fatigue),
  ].map(section => section.trim()).filter(Boolean).join('\n\n');
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
      content: runtimeContextWithFatigue,
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
    const staticPrefixTemplate = turnSnapshot.prompt?.staticPrefixTemplate ?? runtime.systemPrompt;
    const staticSettingsHash = runtime.buildStaticPromptSettingsHash(
      templateVariables,
      staticPrefixTemplate,
    );
    renderedStaticPrefix = await runtime.resolveStaticPromptPrefix({
      cacheKey: staticCacheKey,
      staticPrefixTemplate,
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
  const staticTemporalRuleSections = extractWrappedPromptSections(renderedStaticPrefix)
    .filter(section => section.id === 'temporal_rules');
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
      conversationScope,
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
  const providerWireMessages: LLMProviderWireMessage[] = [];
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
  const promptScopeKeys = resolveTurnPromptScopeKeys({
    ...(authorContext.canonicalContactKey ? { canonicalContactKey: authorContext.canonicalContactKey } : {}),
    channelId: message.channelId,
    isDirectMessage: channelMeta.isDirectMessage === true,
  });
  const resolveSectionScope = buildTurnPromptSectionScopeResolver(promptScopeKeys);
  turnSnapshot.promptContext = {
    renderedStaticPrefix,
    renderedDynamicSuffix,
    runtimeContext: runtimeContextWithFatigue,
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
        ...(resolveSectionScope('rendered_static_prefix')
          ? { scopeProvenance: resolveSectionScope('rendered_static_prefix')! }
          : {}),
      },
      ...staticTemporalRuleSections.map(section => ({
        id: section.id,
        title: section.title,
        content: section.content,
        ...(resolveSectionScope(section.id) ? { scopeProvenance: resolveSectionScope(section.id)! } : {}),
      })),
      {
        id: 'rendered_dynamic_suffix',
        title: 'Rendered Dynamic Suffix',
        content: renderedDynamicSuffix,
        ...(resolveSectionScope('rendered_dynamic_suffix')
          ? { scopeProvenance: resolveSectionScope('rendered_dynamic_suffix')! }
          : {}),
      },
      {
        id: 'runtime_context',
        title: 'Runtime Context',
        content: runtimeContextWithFatigue,
        ...(resolveSectionScope('runtime_context')
          ? { scopeProvenance: resolveSectionScope('runtime_context')! }
          : {}),
      },
      {
        id: 'memory_context',
        title: 'Memory Context',
        content: memoryContextBlock,
        ...(resolveSectionScope('memory_context')
          ? { scopeProvenance: resolveSectionScope('memory_context')! }
          : {}),
        provenance: buildAuthenticityProvenance({
          kind: 'memory_retrieval',
          sourceAuthor: 'memory',
          transformedBy: 'retrieval',
          wording: 'derived',
          directSpeech: false,
          detailLoss: 'possible',
          emotionalTexture: 'may_be_flattened',
          safeAsPartnerSpeech: false,
          sourceSpanCount: memoryManifestSeed?.returnedCount,
          notes: ['Retrieved memory is derived context, not partner-authored direct speech.'],
        }),
      },
      {
        id: 'scratchpad_context',
        title: 'Scratchpad Context',
        content: scratchpadBlock,
        ...(resolveSectionScope('scratchpad_context')
          ? { scopeProvenance: resolveSectionScope('scratchpad_context')! }
          : {}),
      },
    ]),
    runtimeContextSections: extractWrappedPromptSections(runtimeContextWithFatigue, resolveSectionScope),
    memoryContextSections: extractWrappedPromptSections(memoryContextBlock, resolveSectionScope),
    finalSystemSections: context.systemPromptSections
      ? [
        ...context.systemPromptSections.map(section => {
          const scopeProvenance = resolveSectionScope(section.id);
          return scopeProvenance && !section.scopeProvenance ? { ...section, scopeProvenance } : section;
        }),
        ...staticTemporalRuleSections,
        ...(systemContextPromptBlock
          ? [{
            id: 'session_context',
            title: 'Session Context',
            content: systemContextPromptBlock,
            charCount: systemContextPromptBlock.length,
            tokenCount: countTokens(systemContextPromptBlock),
            ...(resolveSectionScope('session_context')
              ? { scopeProvenance: resolveSectionScope('session_context')! }
              : {}),
            provenance: buildAuthenticityProvenance({
              kind: 'system_injection',
              sourceAuthor: 'system',
              transformedBy: 'runtime',
              wording: 'transformed',
              directSpeech: false,
              detailLoss: 'possible',
              emotionalTexture: 'unknown',
              safeAsPartnerSpeech: false,
              sourceSpanCount: context.messages.filter(contextMessage => contextMessage.role === 'system').length || undefined,
              notes: ['Provider system context is injected runtime context, not partner-authored direct speech.'],
            }),
          }]
          : []),
        ...(currentDatetimeProximityAnchor
          ? [{
            id: 'runtime.current_datetime',
            title: 'Current Date & Time',
            content: currentDatetimeProximityAnchor,
            charCount: currentDatetimeProximityAnchor.length,
            tokenCount: countTokens(currentDatetimeProximityAnchor),
            provenance: buildAuthenticityProvenance({
              kind: 'system_injection',
              sourceAuthor: 'system',
              transformedBy: 'runtime',
              wording: 'direct',
              directSpeech: false,
              detailLoss: 'none',
              emotionalTexture: 'unknown',
              safeAsPartnerSpeech: false,
              notes: ['Canonical runtime clock injection; not partner-authored direct speech.'],
            }),
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
      promptCaching: {
        configured: false,
        engaged: false,
      },
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
