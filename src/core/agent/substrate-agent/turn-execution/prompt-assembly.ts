import {
  orderPromptRuntimeSystemPromptSections,
  renderFinalPromptSection,
  type PromptRuntimeSystemPromptBlockId,
} from '../../../identity/prompt-runtime.js';
import { TurnPromptVariableNamespace } from '../../../identity/prompt-variable-namespace.js';
import { resolveCachedPromptRuntimeLayoutStore } from '../../../identity/prompt-runtime-store-cache.js';
import { getDefaultRuntimePromptSections } from '../../../identity/runtime-prompt-layers.js';
import { buildSystemContextPromptBlock } from '../../../../primitives/llm/message-conversion.js';
import type { PiChatMessage } from '../../../../primitives/llm/message-conversion.js';
import {
  buildCurrentDatetimeProximityAnchor,
  computePromptPlanCachePrefixes,
  createPromptPlan,
  createPromptPlanBlock,
  DATETIME_ANCHOR_BLOCK_ID,
  renderPromptPlanAssembledPrompt,
  serializePromptPlanForProvider,
  stripCurrentDatetimePromptBlocks,
  type PromptPlan,
  type PromptPlanBlock,
} from './prompt-plan.js';
import { resolveGlobalPromptCachePolicy } from '../../../../primitives/llm/routing.js';
import { resolvePromptCacheMechanism } from '../../../../primitives/llm/prompt-cache.js';
import { runWithRequestContext } from '../../../../primitives/llm/request-context.js';
import { countTokens } from '../../../../primitives/llm/tokens.js';
import { resolveSystemRoleCapabilityMetadata } from '../../../../primitives/llm/models.js';
import type { ContextBudgetTurnCharacteristics } from '../../../../shared/context-budget.js';
import type {
  CorrelationMetadata,
  FatigueEnforcementMetadata,
  LLMPromptCacheObservability,
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
import { renderBackgroundCompletionsBlock } from '../../completion-notices.js';
import { renderCanaryPromptMarker } from '../../../cogsec/canary/canary-token.js';
import type { TurnExecutionObservability } from './observability.js';

const log = createComponentLogger('SubstrateAgent');
type TurnExecutionRuntime = import('../turn-execution-runtime.js').TurnExecutionRuntime;

interface DynamicSuffixRenderSection {
  identifier: string;
  required: boolean;
  content: string;
}

/**
 * Resolve the per-layer dynamic suffix sections for this turn (E2.5). The
 * turn snapshot's composed sections win; a snapshot that only carries the
 * joined template renders as ONE required unit (fail closed — never a silent
 * partial render); with no snapshot the seeded runtime layers apply.
 */
function resolveDynamicSuffixSections(
  promptSnapshot: TurnSnapshot['prompt'],
): DynamicSuffixRenderSection[] {
  if (promptSnapshot?.dynamicSuffixSections && promptSnapshot.dynamicSuffixSections.length > 0) {
    return promptSnapshot.dynamicSuffixSections;
  }
  const joinedTemplate = typeof promptSnapshot?.dynamicSuffixTemplate === 'string'
    ? promptSnapshot.dynamicSuffixTemplate.trim()
    : '';
  if (joinedTemplate) {
    return [{
      identifier: 'prompt-stack.dynamic_suffix',
      required: true,
      content: joinedTemplate,
    }];
  }
  return getDefaultRuntimePromptSections();
}

export interface TurnPromptAssemblyResult {
  promptMode: MessagePromptOverrideMode;
  fullPrompt: string;
  contextMessageCount: number;
  context: Awaited<ReturnType<TurnExecutionRuntime['sessionManager']['buildContext']>>;
  /** The turn's PromptPlan: the single assembly artifact (E2.2). */
  plan: PromptPlan;
  providerSystemPrompt: string;
  piMessages: PiChatMessage[];
  templateVariables: Record<string, string>;
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
  wikiContextBlock: string;
  scratchpadBlock: string;
  turnBudgetCharacteristics: ContextBudgetTurnCharacteristics;
  continuitySubjectKey: string | undefined;
  temporalRetrievalMode: 'temporal' | undefined;
  viewerRequestContext: Partial<CorrelationMetadata>;
  turnCorrelationBase: CorrelationMetadata;
  turnCallType: ObservabilityCallType;
  turnSnapshot: TurnSnapshot;
  /**
   * htm9.18 per-session canary token. Planted as an inert session-stable block
   * in privileged prompt material; if it later surfaces at the gateway egress
   * boundary the outbound action is held (prompt-leak tripwire). Absent ⇒ no
   * canary is planted this turn (e.g. custom-prompt override paths).
   */
  canaryToken?: string;
  currentSessionEntryId: number | null;
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
    wikiContextBlock,
    scratchpadBlock,
    turnBudgetCharacteristics,
    continuitySubjectKey,
    temporalRetrievalMode,
    viewerRequestContext,
    turnCorrelationBase,
    turnCallType,
    turnSnapshot,
    currentSessionEntryId,
    memoryManifestSeed,
    fatigue,
    canaryToken,
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
  // E4.4: the orchestrator fetches participant-relationship edges (async,
  // bounded, pre-prompt) so the sync variable build stays a pure render. The
  // producer applies the deterministic envelope/sensitivity/cap gates.
  const participantRelationshipEdges = await runtime.resolveParticipantRelationships(
    message,
    conversationScope,
    trustLevel,
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
      participantRelationshipEdges,
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
  // Per-section dynamic suffix render (E2.5 no-silent-leak invariant): a
  // required section with an unresolved macro fails the turn loudly; an
  // optional section drops with telemetry. No token ever leaks into bytes.
  const dynamicSuffixSections = resolveDynamicSuffixSections(turnSnapshot.prompt);
  const renderedDynamicSuffix = stripCurrentDatetimePromptBlocks(
    dynamicSuffixSections
      .map(section => renderFinalPromptSection(section.content, {
        now: runtimeNow,
        variables: promptRuntimeVariables,
        sectionLabel: section.identifier,
        required: section.required,
        onSectionDrop: (drop) => {
          log.warn('Optional prompt section dropped: unresolved macros', {
            channelId: message.channelId,
            turnId: turnSnapshot.turnId,
            sectionLabel: drop.sectionLabel,
            unresolvedTokens: drop.unresolvedTokens,
          });
          void runtime.eventBus.emit('agent.prompt.section_dropped', {
            channelId: message.channelId,
            turnId: turnSnapshot.turnId,
            sectionLabel: drop.sectionLabel,
            unresolvedTokens: drop.unresolvedTokens,
          }).catch((error: unknown) => {
            log.warn('Failed to emit prompt section drop telemetry', { error: String(error) });
          });
        },
      }))
      .map(text => text.trim())
      .filter(text => text.length > 0)
      .join('\n\n'),
  );
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
  const promptScopeKeys = resolveTurnPromptScopeKeys({
    ...(authorContext.canonicalContactKey ? { canonicalContactKey: authorContext.canonicalContactKey } : {}),
    channelId: message.channelId,
    isDirectMessage: channelMeta.isDirectMessage === true,
  });
  const resolveSectionScope = buildTurnPromptSectionScopeResolver(promptScopeKeys);
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

  // ── PromptPlan block emission (E2.2): every producer emits an ordered
  // block; the assembled prompt and the provider system prompt are pure
  // functions of the block list.
  const RUNTIME_SECTION_SCOPE_IDS: Record<string, string> = {
    'runtime.persona_adaptation': 'companion_persona_adaptation',
    'runtime.context': 'runtime_context',
    'runtime.scratchpad': 'scratchpad_context',
  };
  const planBlocks: PromptPlanBlock[] = [];
  if (promptPrefix.trim().length > 0) {
    const prefixScope = resolveSectionScope('rendered_static_prefix');
    planBlocks.push(createPromptPlanBlock({
      id: promptOverride.mode === 'default' ? 'static_prefix' : 'prompt_override',
      layer: 'prompt_stack',
      volatility: promptOverride.mode === 'default' ? 'static' : 'turn',
      producer: promptOverride.mode === 'default'
        ? (prefixScope?.producer ?? 'identity.prompt-composer')
        : 'turn-override.custom-prompt',
      ...(promptOverride.mode === 'default' && prefixScope?.scopeKey
        ? { scopeKey: prefixScope.scopeKey }
        : {}),
      renderedText: promptPrefix,
    }));
  }
  // htm9.18 canary: an inert, per-session marker planted in privileged prompt
  // material. It is 'session_stable' (stable across a session's turns, rotates
  // per session) and sits AFTER the frozen static prefix so it never churns the
  // cross-session static-prefix render/provider cache — the per-session
  // session-stable region is already session-bound.
  if (canaryToken) {
    planBlocks.push(createPromptPlanBlock({
      id: 'cogsec.canary',
      layer: 'prompt_stack',
      volatility: 'session_stable',
      producer: 'cogsec.canary',
      scopeKey: 'global',
      renderedText: renderCanaryPromptMarker(canaryToken),
    }));
  }
  if (renderedDynamicSuffix.trim().length > 0) {
    const suffixScope = resolveSectionScope('rendered_dynamic_suffix');
    planBlocks.push(createPromptPlanBlock({
      id: 'dynamic_suffix',
      layer: 'prompt_stack',
      volatility: 'turn',
      producer: suffixScope?.producer ?? 'identity.prompt-runtime',
      ...(suffixScope?.scopeKey ? { scopeKey: suffixScope.scopeKey } : {}),
      renderedText: renderedDynamicSuffix,
    }));
  }
  for (const section of orderedRuntimeSections) {
    if (section.content.trim().length === 0) continue;
    const sectionScope = resolveSectionScope(RUNTIME_SECTION_SCOPE_IDS[section.id] ?? section.id);
    planBlocks.push(createPromptPlanBlock({
      id: section.id,
      layer: 'runtime',
      volatility: 'turn',
      producer: sectionScope?.producer ?? 'substrate-agent.runtime-context',
      ...(sectionScope?.scopeKey ? { scopeKey: sectionScope.scopeKey } : {}),
      renderedText: section.content,
    }));
  }
  const fullPrompt = renderPromptPlanAssembledPrompt({ blocks: planBlocks });

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
      currentSessionEntryId ?? undefined,
    ),
  );
  if (currentSessionEntryId !== null && context.messages.some(contextMessage => (
    contextMessage.provenance?.sourceEntryIds?.includes(currentSessionEntryId) === true
  ))) {
    throw new Error(
      `Current session entry ${currentSessionEntryId} leaked into prior-history prompt assembly.`,
    );
  }
  // ── Session-derived blocks emitted into the plan (same ordered sections the
  // context builder appended to context.systemPrompt).
  const SESSION_BLOCK_SCOPE_IDS: Record<string, string> = {
    'memory.core': 'core_memory',
    'memory.retrieval': 'memory_context',
  };
  for (const sessionBlock of context.sessionPromptBlocks ?? []) {
    const sessionScope = resolveSectionScope(
      SESSION_BLOCK_SCOPE_IDS[sessionBlock.id] ?? sessionBlock.id,
    );
    planBlocks.push(createPromptPlanBlock({
      id: sessionBlock.id,
      layer: 'session',
      volatility: 'turn',
      producer: sessionScope?.producer ?? 'session.context-builder',
      ...(sessionScope?.scopeKey ? { scopeKey: sessionScope.scopeKey } : {}),
      renderedText: sessionBlock.content,
    }));
  }
  // E8.3: supplemental wiki RAG block, appended to the plan AFTER all memory
  // session blocks so it renders below memory context and never displaces it.
  // The block is already bounded to its own config-owned token cap by the wiki
  // retrieval service; here it is only positioned, never re-budgeted against
  // memory.
  if (wikiContextBlock.trim().length > 0) {
    planBlocks.push(createPromptPlanBlock({
      id: 'wiki.retrieval',
      layer: 'session',
      volatility: 'turn',
      producer: 'wiki.retrieval-service',
      renderedText: wikiContextBlock,
    }));
  }
  const systemContextPromptBlock = buildSystemContextPromptBlock(context.messages);
  if (systemContextPromptBlock) {
    const sessionContextScope = resolveSectionScope('session_context');
    planBlocks.push(createPromptPlanBlock({
      id: 'session_context',
      layer: 'provider',
      volatility: 'turn',
      producer: sessionContextScope?.producer ?? 'session.context-builder',
      ...(sessionContextScope?.scopeKey ? { scopeKey: sessionContextScope.scopeKey } : {}),
      renderedText: systemContextPromptBlock,
    }));
  }
  // Ephemeral background-completion notices: compact, render-once, and placed
  // in the system prompt (never among the recent chat messages). Draining here
  // is what enforces the once-only contract.
  const completionNoticesBlock = renderBackgroundCompletionsBlock(
    runtime.completionNotices.drain(runtime.resolveSessionChannelId(message.channelId)),
  );
  if (completionNoticesBlock) {
    planBlocks.push(createPromptPlanBlock({
      id: 'background_completions',
      layer: 'provider',
      volatility: 'turn',
      producer: 'agent.completion-notices',
      renderedText: completionNoticesBlock,
    }));
  }
  // The canonical clock ships as an ordered turn-volatile block, rendered from
  // the frozen variable namespace — not appended by string surgery.
  const currentDatetimeProximityAnchor = buildCurrentDatetimeProximityAnchor(promptRuntimeVariables);
  if (currentDatetimeProximityAnchor) {
    const anchorScope = resolveSectionScope('runtime_current_datetime');
    planBlocks.push(createPromptPlanBlock({
      id: DATETIME_ANCHOR_BLOCK_ID,
      layer: 'provider',
      volatility: 'turn',
      producer: anchorScope?.producer ?? 'runtime-context.current-datetime',
      scopeKey: 'global',
      renderedText: currentDatetimeProximityAnchor,
    }));
  }
  const plan = createPromptPlan({
    blocks: planBlocks,
    variables: promptRuntimeVariables,
    messages: context.messages.map(contextMessage => ({ ...contextMessage })),
    toolDefinitions: [],
    scope: conversationScope,
  });

  const providerModel = runtime.agent.state.model;
  const providerSystemRole = resolveSystemRoleCapabilityMetadata(providerModel);
  // Provider serialization is a pure function of the plan.
  const {
    systemPrompt: providerSystemPrompt,
    piMessages,
    providerWireMessages,
  } = serializePromptPlanForProvider(plan, providerSystemRole.transport);

  // ── Provider prompt-cache engagement + prefix-stability telemetry (E2.4) ──
  // The models.json promptCaching policy is the master switch (default off =
  // zero wire change). When on, the cachePlan boundaries are projected onto
  // the serialized system prompt and registered so the LLM client can place
  // provider cache breakpoints; the static region's byte-stability is checked
  // against the previous turn on the same scope regardless of the flag —
  // an unstable static prefix silently defeats every provider prefix cache
  // and is an alert, not a stat.
  const promptCachePolicy = resolveGlobalPromptCachePolicy(runtime.config);
  const cachePrefixes = computePromptPlanCachePrefixes(plan);
  runtime.promptCacheRuntime.clearTurnDirective();
  const promptCaching: LLMPromptCacheObservability = {
    configured: promptCachePolicy !== null,
    engaged: false,
  };
  if (!cachePrefixes.ok) {
    // Serializer contract violation: the static region did not serialize to a
    // byte-exact prefix of the system prompt. Surface it and never apply
    // misaligned breakpoints.
    const projectionFailurePayload = {
      channelId: message.channelId,
      turnId: turnSnapshot.turnId,
      requestId: turnSnapshot.requestId,
      scopeKey: conversationScope.key,
      reason: cachePrefixes.reason,
      staticBoundary: plan.cachePlan.staticBoundary,
      sessionStableBoundary: plan.cachePlan.sessionStableBoundary,
    };
    log.warn('Prompt plan cache prefixes violated the serializer byte-prefix contract', projectionFailurePayload);
    runtime.emitTelemetry('prompt.cache.prefix_projection_failed', projectionFailurePayload);
  }
  if (promptCachePolicy) {
    promptCaching.retention = promptCachePolicy.retention;
    promptCaching.scope = promptCachePolicy.scope;
    promptCaching.mechanism = resolvePromptCacheMechanism({
      provider: providerModel.provider,
      modelId: providerModel.id,
      api: providerModel.api,
    });
    if (promptCachePolicy.retention === 'none') {
      promptCaching.reason = 'disabled';
    } else {
      promptCaching.engaged = true;
      if (cachePrefixes.ok) {
        const directive = runtime.promptCacheRuntime.registerTurnDirective({
          systemPrompt: providerSystemPrompt,
          staticPrefixText: cachePrefixes.staticPrefixText,
          sessionStablePrefixText: cachePrefixes.sessionStablePrefixText,
        });
        promptCaching.boundaries = {
          staticPrefixChars: directive.boundaries.staticPrefixChars,
          sessionStablePrefixChars: directive.boundaries.sessionStablePrefixChars,
        };
      }
    }
  }
  if (promptOverride.mode === 'default') {
    const stability = runtime.promptCacheRuntime.checkPrefixStability({
      scopeKey: conversationScope.key,
      turnId: String(turnSnapshot.turnId),
      plan,
    });
    promptCaching.prefixStability = {
      checked: true,
      stable: stability.stable,
      firstObservation: stability.firstObservation,
      scopeKey: stability.scopeKey,
      ...(stability.changedBlocks
        ? { changedBlockIds: stability.changedBlocks.map(change => change.id) }
        : {}),
    };
    if (!stability.stable) {
      const instabilityPayload = {
        channelId: message.channelId,
        scopeKey: stability.scopeKey,
        turnId: turnSnapshot.turnId,
        requestId: turnSnapshot.requestId,
        previousTurnId: stability.previousTurnId ?? null,
        previousStaticHash: stability.previousStaticHash ?? null,
        currentStaticHash: stability.currentStaticHash,
        staticBoundary: plan.cachePlan.staticBoundary,
        changedBlocks: stability.changedBlocks ?? [],
        promptCachingConfigured: promptCachePolicy !== null,
      };
      log.warn('Prompt static-prefix instability: static region changed between turns on the same scope', instabilityPayload);
      runtime.emitTelemetry('prompt.cache.prefix_instability', instabilityPayload);
    }
  } else {
    promptCaching.prefixStability = { checked: false };
  }

  const contextMessageCount = context.messages.length;
  turnSnapshot.capturedAt = Date.now();
  turnSnapshot.plan = plan;
  turnSnapshot.promptContext = {
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
      promptCaching,
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
    plan,
    providerSystemPrompt,
    piMessages,
    templateVariables,
  };
}
