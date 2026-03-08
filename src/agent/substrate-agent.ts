// ── SubstrateAgent ──
// Wraps pi-agent-core's Agent class, replacing the manual streamWithToolLoop
// from the legacy in-house loop implementation. pi-agent-core handles tool
// calling/execution/looping
// internally — we just configure it and subscribe to events for streaming.
//
// Provider interfaces (LLMProvider, EmbeddingService, MemoryProvider,
// MemoryExtractor) are re-exported here for callers that import contracts
// from the SubstrateAgent module.

import { Agent } from '@mariozechner/pi-agent-core';
import type { AgentTool, AgentMessage, StreamFn } from '@mariozechner/pi-agent-core';
import type { AssistantMessage, UserMessage } from '@mariozechner/pi-ai';
import type { EventBus } from '../event-bus.js';
import type { SessionManager } from '../session/manager.js';
import type {
  AgentResponse,
  CapabilityTier,
  CorrelationMetadata,
  InferredPostTurnAction,
  ModelBudgetBlockedEvent,
  MessagePromptOverride,
  MessagePromptOverrideMode,
  ResponseStyle,
  ObservabilityCallType,
  SubstrateConfig,
  SubstrateMessage,
  TurnID,
  TurnRecord,
  TurnUsage,
} from '../types.js';
import type { ContactStore } from '../contacts/store.js';
import type { LLMProvider, MemoryProvider, MemoryExtractor, ScratchpadProvider } from './contracts.js';
import type { TrustLevel } from '../trust/types.js';
import {
  resolveChannelResponseStyle,
  type ChannelMeta,
} from '../trust/policy.js';
import type { ChannelPromptDock } from '../channels/types.js';
import {
  type PromptComposer,
} from '../identity/prompt-composer.js';
import type { ComposeContext } from '../identity/prompt-types.js';
import {
  createSubstrateStreamFn,
} from './stream-adapter.js';
import {
  inferRuntimeModeFromProvider,
} from './substrate-agent-helpers.js';
import { installAgentToolSchedulerPatch } from './agent-loop-patch.js';
import { convertToLlm } from './messages.js';
import { createEventBridge, type EventBridge } from './event-bridge.js';
import { createComponentLogger } from '../logger.js';
import type { SkillsRuntime } from '../skills/runtime.js';
import { ReflectionNudgeTracker, type TurnToolSummary } from '../skills/reflection-nudge.js';
import type { ToolCategory } from './tool-registrar.js';
import {
  gateToolWithCapabilities,
  type CapabilityAccess,
} from '../capabilities/gate.js';
import { CapabilityRuntime } from '../capabilities/runtime.js';
import { normalizeCapabilityTier, resolveTierCapabilityTokens } from '../capabilities/tiers.js';
import type { CapabilityToken } from '../capabilities/tokens.js';
import { tagToolWithReversibility } from '../capabilities/safeguards.js';
import { toErrorMessage } from '../utils/errors.js';
import {
  validateAndLogToolWiring,
  extractGatewayMethods,
  type GatewayToolMetadataCoverage,
  type RuntimeMode,
  type ValidateToolsOptions,
} from './tool-wiring-validator.js';
import {
  isDeferredToolHandoffMessageId,
} from './deferred-tool-handoff.js';
import {
  createDefaultExtendedToolAutoloadPolicy,
  type ExtendedToolAutoloadPolicy,
} from './extended-tool-autoload-policy.js';
import { BackgroundCompletionDeliveryQueue } from './background-completion-delivery-queue.js';
import type {
  AdaptiveLoadedExtendedToolState,
  AdaptiveToolActivationSource,
  AdaptiveToolDecisionTelemetry,
  AdaptiveToolRuntimeState,
  AdaptiveToolSnapshotSkip,
  AdaptiveToolSnapshotTelemetry,
} from './adaptive-tools-telemetry.js';
import { createTurnId } from '../turns/id.js';
import type { TurnPromptSnapshot, TurnSnapshot } from '../turns/snapshot.js';
import type { ContextBudgetTurnCharacteristics } from '../context-budget.js';
import { EmotionState, type EmotionStateSnapshot } from '../emotion/state.js';
import type { EmotionObserver } from '../emotion/observer.js';
import { EmotionAppraisal, type EmotionAppraisalEntry } from '../emotion/appraisal.js';
import type { ActiveConcernContextProvider } from '../intention/concerns.js';
import type { BehavioralPatternContextProvider } from '../intention/patterns.js';
import {
  cloneMetacognitiveFlags,
  type MetacognitiveFlag,
} from '../self-model/metacognition.js';
import {
  cloneInternalState,
  type InternalState,
} from '../self-model/state.js';
import {
  buildPromptPrefixCacheKey as buildPromptPrefixCacheKeyForTurn,
  buildStaticPromptSettingsHash as buildStaticPromptSettingsHashForTurn,
  captureTurnPromptSnapshot as captureTurnPromptSnapshotForTurn,
  hashPromptText as hashPromptTextForTurn,
  resolveStaticPromptPrefix as resolveStaticPromptPrefixForTurn,
  type FrozenPromptPrefix,
} from './substrate-agent/prompt-lifecycle.js';
import {
  inferPostTurnActions as inferPostTurnActionsForTurn,
  runIntentionPostTurnHooks as runIntentionPostTurnHooksForTurn,
  type IntentionPostTurnHook,
  type IntentionPostTurnHookContext,
  type PostTurnActionInferer,
  type PostTurnInferenceContext,
} from './substrate-agent/post-turn-actions.js';
import {
  accumulateTurnUsage as accumulateTurnUsageForTurn,
  buildTurnRecord as buildTurnRecordForTurn,
  buildTurnToolSummary as buildTurnToolSummaryForTurn,
  recordAssistantMessage as recordAssistantMessageForTurn,
  recordToolObservations as recordToolObservationsForTurn,
  recordUserMessage as recordUserMessageForTurn,
} from './substrate-agent/turn-records.js';
import {
  buildActiveConcernsContextBlock as buildActiveConcernsContextBlockForTurn,
  buildBehavioralNotesContextBlock as buildBehavioralNotesContextBlockForTurn,
  buildMetacognitiveNotesContextBlock as buildMetacognitiveNotesContextBlockForTurn,
  buildPromptTemplateVariables as buildPromptTemplateVariablesForTurn,
  buildRuntimeContext as buildRuntimeContextForTurn,
  buildScratchpadContextBlock as buildScratchpadContextBlockForTurn,
  getPersonaAdaptation as getPersonaAdaptationForTurn,
  resolveAuthorContext as resolveAuthorContextForTurn,
  type ResolvedAuthorContext,
} from './substrate-agent/runtime-context.js';
import {
  activateExtendedToolsForTurn,
  createLoadToolsTool,
  preloadExtendedToolsForTurn,
  type AutoloadTurnOutcome,
  type ExtendedToolActivationOptions,
  type ExtendedToolActivationResult,
} from './substrate-agent/adaptive-tools-runtime.js';
import { EmotionSelfModelRuntime } from './substrate-agent/emotion-self-model-runtime.js';
import {
  pinDeferredContinuationSessionContext as pinDeferredContinuationSessionContextForTurn,
  queueBackgroundContinuationCompletion as queueBackgroundContinuationCompletionForTurn,
  resolveSessionChannelId as resolveSessionChannelIdForTurn,
  dequeueBackgroundContinuationDeliveries as dequeueBackgroundContinuationDeliveriesForTurn,
  emitBackgroundContinuationEvent as emitBackgroundContinuationEventForTurn,
  type BackgroundContinuationTaskRecord,
  type BackgroundContinuationCompletionSignal,
  type PendingBackgroundContinuationDelivery,
} from './substrate-agent/background-continuation-runtime.js';
import {
  buildTurnCorrelation as buildTurnCorrelationForTurn,
  buildTurnStageTelemetry as buildTurnStageTelemetryForTurn,
  resolveTurnCallType as resolveTurnCallTypeForTurn,
  withAdaptiveCorrelation as withAdaptiveCorrelationForTurn,
  withCorrelationPurpose as withCorrelationPurposeForTurn,
  type TurnStageName,
} from './substrate-agent/turn-observability.js';
import {
  handleMessageForTurn,
} from './substrate-agent/turn-execution-runtime.js';
import {
  getTurnModelSignature as getTurnModelSignatureForRuntime,
  normalizeTurnModelOverride as normalizeTurnModelOverrideForRuntime,
  refreshModelFromConfig as refreshModelFromConfigForRuntime,
  resolveTurnModelPurpose as resolveTurnModelPurposeForRuntime,
} from './substrate-agent/model-runtime.js';
import {
  addPromotedExtendedTool as addPromotedExtendedToolForRuntime,
  applyActiveToolsToAgent as applyActiveToolsToAgentForRuntime,
  buildAdaptiveToolRuntimeState as buildAdaptiveToolRuntimeStateForRuntime,
  buildAdaptiveToolSnapshot as buildAdaptiveToolSnapshotForRuntime,
  classifyExtendedToolForTurn as classifyExtendedToolForTurnForRuntime,
  emitAdaptiveToolSnapshotDecisions as emitAdaptiveToolSnapshotDecisionsForRuntime,
  getExtendedToolByName as getExtendedToolByNameForRuntime,
  getPromotedExtendedToolNames as getPromotedExtendedToolNamesForRuntime,
  getPromotedExtendedToolsLimit as getPromotedExtendedToolsLimitForRuntime,
  mergeAdaptiveSkips as mergeAdaptiveSkipsForRuntime,
  persistPromotedExtendedToolNames as persistPromotedExtendedToolNamesForRuntime,
  removePromotedExtendedTool as removePromotedExtendedToolForRuntime,
  resolveActiveTools as resolveActiveToolsForRuntime,
  resolvePromotedToolActivation as resolvePromotedToolActivationForRuntime,
  setPromotedExtendedToolNames as setPromotedExtendedToolNamesForRuntime,
  swapPromotedExtendedTools as swapPromotedExtendedToolsForRuntime,
  trackLoadedExtendedTool as trackLoadedExtendedToolForRuntime,
  withToolConcurrencyMetadata as withToolConcurrencyMetadataForRuntime,
  type ActiveToolResolution,
  type PromotedToolMutationResult,
  type PromotedToolResolution,
} from './substrate-agent/tool-orchestration-runtime.js';

const log = createComponentLogger('SubstrateAgent');

export type {
  LLMProvider,
  EmbeddingService,
  MemoryProvider,
  MemoryExtractor,
  ScratchpadProvider,
} from './contracts.js';
export type {
  PostTurnActionInferer,
  IntentionPostTurnHookContext,
  IntentionPostTurnHook,
} from './substrate-agent/post-turn-actions.js';
export type {
  ExtendedToolActivationOptions,
  ExtendedToolActivationResult,
} from './substrate-agent/adaptive-tools-runtime.js';
export type {
  PromotedToolMutationErrorCode,
  PromotedToolMutationResult,
} from './substrate-agent/tool-orchestration-runtime.js';

export interface EmotionRuntimeWiring {
  state?: EmotionState;
  observer?: EmotionObserver;
  appraisal?: EmotionAppraisal;
  requireWiring?: boolean;
}

export interface SelfModelRuntimeWiring {
  requireWiring?: boolean;
}

export interface SubstrateAgentOptions {
  streamFn?: StreamFn;
  characterName?: string;
  characterPromptVariables?: Record<string, string>;
  characterPromptVariablesProvider?: () => Record<string, string>;
  runtimeMode?: RuntimeMode;
  emotionRuntime?: EmotionRuntimeWiring;
  selfModelRuntime?: SelfModelRuntimeWiring;
}
const DEFAULT_TOOL_SCHEDULER_MAX_PARALLEL = 5;

// ── SubstrateAgent ──

export class SubstrateAgent {
  private agent: Agent;
  private eventBus: EventBus;
  private llmClient: LLMProvider;
  private sessionManager: SessionManager;
  private systemPrompt: string;
  private characterName: string;
  private resolveCharacterPromptVariables: () => Record<string, string>;
  private config: SubstrateConfig;
  private coreTools: AgentTool<any>[] = [];
  private extendedTools: AgentTool<any>[] = [];
  private loadedExtended = new Map<string, AdaptiveLoadedExtendedToolState>();
  private modelResolved = false;
  private modelSignature: string | null = null;
  private bridge: EventBridge;
  private channelRegistry = new Map<string, ChannelPromptDock>();
  private capabilityRuntime: CapabilityRuntime | null = null;
  private gatedToolCache = new WeakMap<AgentTool<any>, AgentTool<any>>();
  private extendedToolAutoloadPolicy: ExtendedToolAutoloadPolicy | null = createDefaultExtendedToolAutoloadPolicy();
  private frozenPromptPrefixCache = new Map<string, FrozenPromptPrefix>();
  private reflectionNudge = new ReflectionNudgeTracker();
  private postTurnActionInferers: PostTurnActionInferer[] = [];
  private intentionPostTurnHooks: IntentionPostTurnHook[] = [];
  private activeTurnCorrelation: CorrelationMetadata | null = null;
  private activeTurnTaskKind: string | null = null;
  private activeTurnIntent: string | null = null;
  private lastAdaptiveToolSnapshot: AdaptiveToolSnapshotTelemetry | null = null;
  private pendingBackgroundContinuationDeliveries = new BackgroundCompletionDeliveryQueue<
    PendingBackgroundContinuationDelivery
  >();
  private backgroundContinuationTasks = new Map<string, BackgroundContinuationTaskRecord>();
  private selfModelRuntimeRequired = false;
  private readonly emotionSelfModelRuntime: EmotionSelfModelRuntime;
  private currentInternalState: InternalState | null = null;
  private currentInternalStateSnapshotRef: string | null = null;
  private currentMetacognitiveFlags: MetacognitiveFlag[] = [];
  private runtimeMode: RuntimeMode;

  // Pluggable memory — null until memory system is wired
  memoryProvider: MemoryProvider | null = null;
  memoryExtractor: MemoryExtractor | null = null;
  scratchpadProvider: ScratchpadProvider | null = null;
  activeConcernProvider: ActiveConcernContextProvider | null = null;
  behavioralPatternProvider: BehavioralPatternContextProvider | null = null;

  // Trust resolution — null until contacts are wired
  contactStore: ContactStore | null = null;

  // Prompt composition — null falls back to static systemPrompt
  promptComposer: PromptComposer | null = null;

  // SKILL.md runtime — null until skills system is wired
  skillsRuntime: SkillsRuntime | null = null;

  constructor(
    eventBus: EventBus,
    llmClient: LLMProvider,
    sessionManager: SessionManager,
    systemPrompt: string,
    config: SubstrateConfig,
    options?: SubstrateAgentOptions,
  ) {
    this.eventBus = eventBus;
    this.llmClient = llmClient;
    this.sessionManager = sessionManager;
    this.systemPrompt = systemPrompt;
    this.characterName = options?.characterName?.trim() || this.deriveCharacterName(systemPrompt);
    const fallbackPromptVariables = { ...(options?.characterPromptVariables ?? {}) };
    this.resolveCharacterPromptVariables = options?.characterPromptVariablesProvider
      ?? (() => fallbackPromptVariables);
    this.config = config;
    this.runtimeMode = options?.runtimeMode ?? inferRuntimeModeFromProvider(llmClient);
    this.selfModelRuntimeRequired = options?.selfModelRuntime?.requireWiring ?? false;
    this.emotionSelfModelRuntime = new EmotionSelfModelRuntime({
      sessionManager: this.sessionManager,
      llmProvider: this.llmClient,
      emotionRuntime: options?.emotionRuntime,
      getActiveConcernProvider: () => this.activeConcernProvider,
      getContactStore: () => this.contactStore,
      getSelfModelRuntimeRequired: () => this.selfModelRuntimeRequired,
      logger: log,
    });
    this.emotionSelfModelRuntime.assertEmotionRuntimeConfigured();

    const emitBudgetBlocked = (event: ModelBudgetBlockedEvent) => {
      this.eventBus.emit('model.budget.blocked', event).catch((error) => {
        log.error('Failed to emit stream budget blocked telemetry', {
          error: toErrorMessage(error),
          provider: event.provider,
          model: event.model,
          reason: event.reason,
        });
      });
    };

    this.agent = new Agent({
      streamFn: options?.streamFn ?? createSubstrateStreamFn(config, {
        onBudgetBlocked: emitBudgetBlocked,
      }),
      convertToLlm,
    });
    installAgentToolSchedulerPatch(this.agent, {
      maxParallelToolCalls: DEFAULT_TOOL_SCHEDULER_MAX_PARALLEL,
      onTelemetry: (eventName, payload) => {
        this.emitTelemetry(eventName, {
          ...this.withAdaptiveCorrelation(this.activeTurnCorrelation ?? undefined, eventName),
          timestamp: Date.now(),
          taskKind: this.activeTurnTaskKind,
          intent: this.activeTurnIntent,
          ...payload,
        });
      },
    });

    this.installRuntimeHooks();

    // Persistent event bridge: pi-agent-core events → EventBus
    this.bridge = createEventBridge(this.agent, eventBus);

    // Register the load_tools meta-tool as a core tool
    this.registerTool(this.createLoadToolsTool(), 'core');

    // Eagerly try to resolve the model, but don't throw if it fails
    // (e.g. in tests with fake model names). Deferred to handleMessage if needed.
    try {
      this.refreshModelFromConfig('startup');
    } catch (err) {
      // Model will be resolved lazily on first handleMessage
      log.debug('Deferred model resolution at startup', { error: String(err) });
    }
  }

  /** Ensure the model is resolved before calling agent.prompt() */
  private ensureModel(message?: SubstrateMessage): void {
    this.refreshModelFromConfig('turn-start', message);
  }

  /**
   * Re-resolve the chat model from current config.
   * Safe for runtime updates: if a new model cannot be resolved, keep the last working model.
   */
  refreshRuntimeModels(): void {
    this.refreshModelFromConfig('settings-update');
  }

  private installRuntimeHooks(): void {
    const existingHooks = this.config.runtimeHooks ?? {};
    const priorRefreshModels = existingHooks.refreshModels;
    const priorRefreshCapabilities = existingHooks.refreshCapabilities;
    const priorInvalidatePromptPrefixCache = existingHooks.invalidatePromptPrefixCache;
    this.config.runtimeHooks = {
      ...existingHooks,
      refreshModels: () => {
        priorRefreshModels?.();
        this.refreshRuntimeModels();
        this.invalidatePromptPrefixCache('runtime.refreshModels');
      },
      refreshCapabilities: () => {
        priorRefreshCapabilities?.();
        this.refreshCapabilityRuntime();
      },
      invalidatePromptPrefixCache: () => {
        priorInvalidatePromptPrefixCache?.();
        this.invalidatePromptPrefixCache('runtime.invalidatePromptPrefixCache');
      },
    };
  }

  private refreshCapabilityRuntime(): void {
    if (this.capabilityRuntime) {
      const refreshed = this.capabilityRuntime.refreshFromDisk();
      this.config.capabilityTier = refreshed.tier;
      return;
    }

    this.config.capabilityTier = this.resolveCapabilityTier();
  }

  private resolveCapabilityTier(): CapabilityTier {
    return normalizeCapabilityTier(this.config.capabilityTier);
  }

  private resolveCapabilityAccess(): CapabilityAccess {
    if (this.capabilityRuntime) return this.capabilityRuntime;

    const tier = this.resolveCapabilityTier();
    const grantedTokens = new Set(resolveTierCapabilityTokens(tier));
    return {
      getTier: () => tier,
      getGrantedTokens: () => grantedTokens,
      has: (token: CapabilityToken) => grantedTokens.has(token),
    };
  }

  private withCapabilityGates(tools: AgentTool<any>[]): AgentTool<any>[] {
    return tools.map((tool) => {
      const cached = this.gatedToolCache.get(tool);
      if (cached) return cached;
      const wrapped = gateToolWithCapabilities(tool, () => this.resolveCapabilityAccess());
      this.gatedToolCache.set(tool, wrapped);
      return wrapped;
    });
  }

  private resolveTurnModelPurpose(message?: SubstrateMessage) {
    return resolveTurnModelPurposeForRuntime(message);
  }

  private normalizeTurnModelOverride(message?: SubstrateMessage) {
    return normalizeTurnModelOverrideForRuntime(message);
  }

  private normalizeTurnPromptOverride(message: SubstrateMessage): MessagePromptOverride {
    const raw = message.routing?.promptOverride;
    if (!raw) {
      return { mode: 'default' };
    }

    if (raw.mode === 'none') return { mode: 'none' };
    if (raw.mode === 'custom') {
      const prompt = raw.systemPrompt?.trim();
      if (prompt) return { mode: 'custom', systemPrompt: prompt };
      return { mode: 'none' };
    }
    return { mode: 'default' };
  }

  private normalizeTurnResponseStyleOverride(message: SubstrateMessage): ResponseStyle | null {
    const raw = message.routing?.responseStyle;
    return raw === 'concise' || raw === 'expressive'
      ? raw
      : null;
  }

  private resolveResponseStyle(
    message: SubstrateMessage,
    channelType: string | undefined,
    channelMeta: ChannelMeta,
  ): ResponseStyle {
    const turnOverride = this.normalizeTurnResponseStyleOverride(message);
    if (turnOverride) return turnOverride;

    return resolveChannelResponseStyle(message.channelId, {
      channelType,
      meta: channelMeta,
      overrides: this.config.responseStyleOverrides,
    });
  }

  private getTurnModelSignature(message?: SubstrateMessage): string {
    return getTurnModelSignatureForRuntime(this.config, message);
  }

  private refreshModelFromConfig(
    reason: 'startup' | 'turn-start' | 'settings-update',
    message?: SubstrateMessage,
  ): void {
    const nextState = refreshModelFromConfigForRuntime({
      reason,
      config: this.config,
      state: {
        modelResolved: this.modelResolved,
        modelSignature: this.modelSignature,
      },
      message,
      setAgentModel: model => this.agent.setModel(model),
      getCurrentModelId: () => this.agent.state.model.id,
      logger: log,
    });
    this.modelResolved = nextState.modelResolved;
    this.modelSignature = nextState.modelSignature;
  }

  registerTool(tool: AgentTool<any>, category: ToolCategory = 'core'): void {
    const taggedTool = this.withToolConcurrencyMetadata(tagToolWithReversibility(tool), category);
    if (category === 'core') {
      this.coreTools.push(taggedTool);
    } else {
      this.extendedTools.push(taggedTool);
    }
  }

  private withToolConcurrencyMetadata(tool: AgentTool<any>, category: ToolCategory): AgentTool<any> {
    return withToolConcurrencyMetadataForRuntime(tool, category);
  }

  private getPromotedExtendedToolNamesInternal(): string[] {
    return getPromotedExtendedToolNamesForRuntime(this.config);
  }

  private setPromotedExtendedToolNamesInternal(next: readonly string[]): string[] {
    return setPromotedExtendedToolNamesForRuntime(this.config, next);
  }

  private persistPromotedExtendedToolNames(next: readonly string[]): string | null {
    return persistPromotedExtendedToolNamesForRuntime(this.config, next);
  }

  private getExtendedToolByName(name: string): AgentTool<any> | null {
    return getExtendedToolByNameForRuntime(this.extendedTools, name);
  }

  private classifyExtendedToolForTurn(toolName: string) {
    return classifyExtendedToolForTurnForRuntime(
      toolName,
      this.extendedToolAutoloadPolicy?.classifyToolForTurn ?? null,
    );
  }

  private resolvePromotedToolActivation(): PromotedToolResolution {
    return resolvePromotedToolActivationForRuntime({
      promotedTools: this.getPromotedExtendedToolNamesInternal(),
      extendedTools: this.extendedTools,
      resolveCapabilityAccess: () => this.resolveCapabilityAccess(),
      classifyExtendedToolForTurn: (toolName) => this.classifyExtendedToolForTurn(toolName),
    });
  }

  private getCapabilityEligiblePromotedToolNames(): Set<string> {
    return this.resolvePromotedToolActivation().activeNames;
  }

  private trackLoadedExtendedTool(
    toolName: string,
    source: Extract<AdaptiveToolActivationSource, 'extended_loaded' | 'autoload' | 'deferred'>,
  ): 'activated' | 'already_active' {
    return trackLoadedExtendedToolForRuntime(this.loadedExtended, toolName, source);
  }

  private mergeAdaptiveSkips(...groups: AdaptiveToolSnapshotSkip[][]): AdaptiveToolSnapshotSkip[] {
    return mergeAdaptiveSkipsForRuntime(...groups);
  }

  private resolveActiveTools(
    additionalSkipped: AdaptiveToolSnapshotSkip[] = [],
  ): ActiveToolResolution {
    return resolveActiveToolsForRuntime({
      coreTools: this.coreTools,
      extendedTools: this.extendedTools,
      loadedExtended: this.loadedExtended,
      promotedResolution: this.resolvePromotedToolActivation(),
      classifyExtendedToolForTurn: (toolName) => this.classifyExtendedToolForTurn(toolName),
      additionalSkipped,
    });
  }

  private applyActiveToolsToAgent(): void {
    const resolution = this.resolveActiveTools();
    applyActiveToolsToAgentForRuntime({
      resolution,
      withCapabilityGates: tools => this.withCapabilityGates(tools),
      setAgentTools: tools => this.agent.setTools(tools),
    });
  }

  private applyActiveToolsToAgentForTurn(
    message: SubstrateMessage,
    taskKind: string | undefined,
    callType: ObservabilityCallType,
    correlation: CorrelationMetadata,
    autoloadOutcome: AutoloadTurnOutcome,
  ): void {
    const resolution = this.resolveActiveTools(autoloadOutcome.skipped);
    applyActiveToolsToAgentForRuntime({
      resolution,
      withCapabilityGates: tools => this.withCapabilityGates(tools),
      setAgentTools: tools => this.agent.setTools(tools),
    });

    const snapshot = buildAdaptiveToolSnapshotForRuntime({
      message,
      taskKind,
      callType,
      correlation,
      autoloadOutcome,
      resolution,
      withAdaptiveCorrelation: (contextCorrelation, purpose) => this.withAdaptiveCorrelation(contextCorrelation, purpose),
    });
    this.lastAdaptiveToolSnapshot = snapshot;
    this.emitTelemetry('agent.tools.adaptive.snapshot', snapshot as unknown as Record<string, unknown>);

    emitAdaptiveToolSnapshotDecisionsForRuntime({
      snapshot,
      correlation,
      withAdaptiveCorrelation: (contextCorrelation, purpose) => this.withAdaptiveCorrelation(contextCorrelation, purpose),
      emitAdaptiveToolDecision: payload => this.emitAdaptiveToolDecision(payload),
    });
  }

  getPromotedExtendedToolsLimit(): number {
    return getPromotedExtendedToolsLimitForRuntime();
  }

  getPromotedExtendedTools(): readonly string[] {
    return [...this.getPromotedExtendedToolNamesInternal()];
  }

  addPromotedExtendedTool(toolName: string): PromotedToolMutationResult {
    return addPromotedExtendedToolForRuntime(toolName, {
      getPromotedExtendedToolNames: () => this.getPromotedExtendedToolNamesInternal(),
      setPromotedExtendedToolNames: (next) => this.setPromotedExtendedToolNamesInternal(next),
      persistPromotedExtendedToolNames: (next) => this.persistPromotedExtendedToolNames(next),
      getExtendedToolByName: (name) => this.getExtendedToolByName(name),
      classifyExtendedToolForTurn: (name) => this.classifyExtendedToolForTurn(name),
      resolveCapabilityAccess: () => this.resolveCapabilityAccess(),
      applyActiveToolsToAgent: () => this.applyActiveToolsToAgent(),
    });
  }

  removePromotedExtendedTool(toolName: string): PromotedToolMutationResult {
    return removePromotedExtendedToolForRuntime(toolName, {
      getPromotedExtendedToolNames: () => this.getPromotedExtendedToolNamesInternal(),
      setPromotedExtendedToolNames: (next) => this.setPromotedExtendedToolNamesInternal(next),
      persistPromotedExtendedToolNames: (next) => this.persistPromotedExtendedToolNames(next),
      getExtendedToolByName: (name) => this.getExtendedToolByName(name),
      classifyExtendedToolForTurn: (name) => this.classifyExtendedToolForTurn(name),
      resolveCapabilityAccess: () => this.resolveCapabilityAccess(),
      applyActiveToolsToAgent: () => this.applyActiveToolsToAgent(),
    });
  }

  swapPromotedExtendedTools(fromSlot: number, toSlot: number): PromotedToolMutationResult {
    return swapPromotedExtendedToolsForRuntime(fromSlot, toSlot, {
      getPromotedExtendedToolNames: () => this.getPromotedExtendedToolNamesInternal(),
      setPromotedExtendedToolNames: (next) => this.setPromotedExtendedToolNamesInternal(next),
      persistPromotedExtendedToolNames: (next) => this.persistPromotedExtendedToolNames(next),
      getExtendedToolByName: (name) => this.getExtendedToolByName(name),
      classifyExtendedToolForTurn: (name) => this.classifyExtendedToolForTurn(name),
      resolveCapabilityAccess: () => this.resolveCapabilityAccess(),
      applyActiveToolsToAgent: () => this.applyActiveToolsToAgent(),
    });
  }

  getToolCatalog(): { core: readonly AgentTool<any>[]; extended: readonly AgentTool<any>[] } {
    return {
      core: [...this.coreTools],
      extended: [...this.extendedTools],
    };
  }

  getAdaptiveToolRuntimeState(): AdaptiveToolRuntimeState {
    const promotedResolution = this.resolvePromotedToolActivation();
    const activeResolution = this.resolveActiveTools();

    return buildAdaptiveToolRuntimeStateForRuntime({
      coreTools: this.coreTools,
      extendedTools: this.extendedTools,
      loadedExtended: this.loadedExtended,
      promotedToolsConfigured: this.getPromotedExtendedToolNamesInternal(),
      promotedResolution,
      activeResolution,
      lastSnapshot: this.lastAdaptiveToolSnapshot,
    });
  }

  getBackgroundContinuationTasks(): readonly BackgroundContinuationTaskRecord[] {
    return [...this.backgroundContinuationTasks.values()]
      .sort((left, right) => left.completedAt - right.completedAt)
      .map(entry => ({ ...entry }));
  }

  activateExtendedTools(
    toolNames: readonly string[],
    options: ExtendedToolActivationOptions = {},
  ): ExtendedToolActivationResult {
    return activateExtendedToolsForTurn({
      toolNames,
      options,
      extendedTools: this.extendedTools,
      trackLoadedExtendedTool: (toolName, source) => this.trackLoadedExtendedTool(toolName, source),
      emitAdaptiveToolDecision: (payload) => this.emitAdaptiveToolDecision(payload),
      withAdaptiveCorrelation: (correlation, purpose) => this.withAdaptiveCorrelation(correlation, purpose),
      applyActiveToolsToAgent: () => this.applyActiveToolsToAgent(),
    });
  }

  /**
   * Validate that all registered tools have their runtime dependencies satisfied.
   * Tools with missing dependencies are logged as warnings and removed from the
   * tool registry so they cannot crash at invocation time.
   *
   * @param mode - 'single' for single-process mode, 'gateway' for agent/gateway split
   * @param gatewayClient - The gateway client object (gateway mode only), used to
   *   extract available RPC methods via prototype inspection
   * @param requiredGatewayMetadataCoverage - optional expected metadata coverage map
   *   for known gateway-dependent tools
   */
  validateToolWiring(
    mode: RuntimeMode,
    gatewayClient?: object,
    requiredGatewayMetadataCoverage?: GatewayToolMetadataCoverage,
  ): void {
    const allTools = [...this.coreTools, ...this.extendedTools];
    const options: ValidateToolsOptions = {
      mode,
      tools: allTools,
      requiredGatewayMetadataCoverage,
      requireConcurrencyMetadata: true,
    };

    if (mode === 'gateway' && gatewayClient) {
      options.gatewayClientMethods = extractGatewayMethods(gatewayClient);
    }

    const disabledNames = validateAndLogToolWiring(options);
    if (disabledNames.length === 0) return;

    const disabledSet = new Set(disabledNames);
    this.coreTools = this.coreTools.filter(t => !disabledSet.has(t.name));
    this.extendedTools = this.extendedTools.filter(t => !disabledSet.has(t.name));
    for (const disabledName of disabledSet) {
      this.loadedExtended.delete(disabledName);
    }
    const filteredPromoted = this
      .getPromotedExtendedToolNamesInternal()
      .filter(name => !disabledSet.has(name));
    this.setPromotedExtendedToolNamesInternal(filteredPromoted);
  }

  setChannelRegistry(registry: ReadonlyMap<string, ChannelPromptDock>): void {
    this.channelRegistry = new Map(registry);
    this.invalidatePromptPrefixCache('channel-registry-updated');
  }

  setCapabilityRuntime(runtime: CapabilityRuntime | null): void {
    this.capabilityRuntime = runtime;
    this.gatedToolCache = new WeakMap<AgentTool<any>, AgentTool<any>>();
    this.refreshCapabilityRuntime();
  }

  setExtendedToolAutoloadPolicy(policy: ExtendedToolAutoloadPolicy | null): void {
    this.extendedToolAutoloadPolicy = policy;
  }

  private createLoadToolsTool(): AgentTool<any> {
    return createLoadToolsTool({
      getExtendedTools: () => this.extendedTools,
      getExtendedToolAutoloadPolicy: () => this.extendedToolAutoloadPolicy,
      getActiveTurnCorrelation: () => this.activeTurnCorrelation,
      getActiveTurnTaskKind: () => this.activeTurnTaskKind,
      getActiveTurnIntent: () => this.activeTurnIntent,
      activateExtendedTools: (toolNames, options) => this.activateExtendedTools(toolNames, options),
      resolveSessionChannelId: (channelId) => this.resolveSessionChannelId(channelId),
      withAdaptiveCorrelation: (correlation, purpose) => this.withAdaptiveCorrelation(correlation, purpose),
      emitAdaptiveToolDecision: (payload) => this.emitAdaptiveToolDecision(payload),
      emitTelemetry: (event, payload) => this.emitTelemetry(event, payload),
    });
  }

  private preloadExtendedToolsForTurn(
    message: SubstrateMessage,
    taskKind: string | undefined,
    correlation: CorrelationMetadata,
  ): AutoloadTurnOutcome {
    return preloadExtendedToolsForTurn({
      message,
      taskKind,
      correlation,
      policy: this.extendedToolAutoloadPolicy,
      extendedTools: this.extendedTools,
      classifyExtendedToolForTurn: (toolName) => this.classifyExtendedToolForTurn(toolName),
      resolveCapabilityAccess: () => this.resolveCapabilityAccess(),
      trackLoadedExtendedTool: (toolName, source) => this.trackLoadedExtendedTool(toolName, source),
      emitTelemetry: (event, payload) => this.emitTelemetry(event, payload),
      emitAdaptiveToolDecision: (payload) => this.emitAdaptiveToolDecision(payload),
      withCorrelationPurpose: (contextCorrelation, purpose) => this.withCorrelationPurpose(contextCorrelation, purpose),
      withAdaptiveCorrelation: (contextCorrelation, purpose) => this.withAdaptiveCorrelation(contextCorrelation, purpose),
    });
  }

  // ── Steering + follow-up + lifecycle ──

  /** Whether the agent is currently processing a prompt */
  get isStreaming(): boolean {
    return this.agent.state.isStreaming;
  }

  /**
   * Inject a steering message mid-run. Delivered after current tool execution,
   * remaining tool calls are skipped, and the message is added to context
   * before the next LLM call. No-op if agent isn't streaming.
   */
  steer(message: SubstrateMessage): void {
    if (!this.agent.state.isStreaming) return;
    const authorContext = this.resolveAuthorContext(message);
    this.recordUserMessage(
      message,
      createTurnId(),
      message.id,
      authorContext.trustLevel,
      authorContext.canonicalContactKey,
    );
    this.agent.steer({
      role: 'user',
      content: message.content,
      timestamp: Date.now(),
    } satisfies UserMessage);
    log.debug('Steered message', { channelId: message.channelId, content: message.content.slice(0, 80) });
  }

  /**
   * Queue a follow-up message processed after the agent finishes current work.
   * Non-interrupting — waits for idle before delivery.
   */
  followUp(message: SubstrateMessage): void {
    const authorContext = this.resolveAuthorContext(message);
    this.recordUserMessage(
      message,
      createTurnId(),
      message.id,
      authorContext.trustLevel,
      authorContext.canonicalContactKey,
    );
    this.agent.followUp({
      role: 'user',
      content: message.content,
      timestamp: Date.now(),
    } satisfies UserMessage);
    log.debug('Queued follow-up', { channelId: message.channelId });
  }

  /** Wait for the agent to finish all pending work (prompt + steering + follow-ups) */
  waitForIdle(): Promise<void> {
    return this.agent.waitForIdle();
  }

  setActiveConcernProvider(provider: ActiveConcernContextProvider | null): void {
    this.activeConcernProvider = provider;
  }

  setBehavioralPatternProvider(provider: BehavioralPatternContextProvider | null): void {
    this.behavioralPatternProvider = provider;
  }

  setSelfModelRuntimeRequired(required: boolean): void {
    this.selfModelRuntimeRequired = required;
  }

  getCurrentInternalState(): InternalState | null {
    if (!this.currentInternalState) return null;
    return cloneInternalState(this.currentInternalState);
  }

  getCurrentInternalStateSnapshotRef(): string | null {
    return this.currentInternalStateSnapshotRef;
  }

  getCurrentMetacognitiveFlags(): MetacognitiveFlag[] {
    return cloneMetacognitiveFlags(this.currentMetacognitiveFlags);
  }

  registerPostTurnActionInferer(inferer: PostTurnActionInferer): () => void {
    this.postTurnActionInferers.push(inferer);
    return () => {
      const index = this.postTurnActionInferers.indexOf(inferer);
      if (index !== -1) {
        this.postTurnActionInferers.splice(index, 1);
      }
    };
  }

  registerIntentionPostTurnHook(hook: IntentionPostTurnHook): () => void {
    this.intentionPostTurnHooks.push(hook);
    return () => {
      const index = this.intentionPostTurnHooks.indexOf(hook);
      if (index !== -1) {
        this.intentionPostTurnHooks.splice(index, 1);
      }
    };
  }

  /** Abort the current prompt, cancelling streaming and tool execution */
  abort(): void {
    this.agent.abort();
  }

  async handleMessage(message: SubstrateMessage): Promise<AgentResponse> {
    return handleMessageForTurn({
      eventBus: this.eventBus,
      llmClient: this.llmClient,
      sessionManager: this.sessionManager,
      config: this.config,
      runtimeMode: this.runtimeMode,
      agent: this.agent,
      bridge: this.bridge,
      systemPrompt: this.systemPrompt,
      memoryProvider: this.memoryProvider,
      memoryExtractor: this.memoryExtractor,
      skillsRuntime: this.skillsRuntime,
      evaluateReflectionNudge: (toolSummary) => this.reflectionNudge.evaluate(toolSummary),
      emotionSelfModelRuntime: this.emotionSelfModelRuntime,
      pinDeferredContinuationSessionContext: (deferredContinuationId, channelId) => this.pinDeferredContinuationSessionContext(
        deferredContinuationId,
        channelId,
      ),
      resolveTaskKind: (turnMessage) => this.resolveTaskKind(turnMessage),
      buildTurnBudgetCharacteristics: (turnMessage, taskKind) => this.buildTurnBudgetCharacteristics(turnMessage, taskKind),
      resolveTurnCallType: (turnMessage, taskKind) => this.resolveTurnCallType(turnMessage, taskKind),
      buildTurnCorrelation: (turnMessage, callType, turnId, requestId) => this.buildTurnCorrelation(
        turnMessage,
        callType,
        turnId,
        requestId,
      ),
      withCorrelationPurpose: (correlation, purpose) => this.withCorrelationPurpose(correlation, purpose),
      resolveAuthorContext: (turnMessage) => this.resolveAuthorContext(turnMessage),
      emitTurnStage: (
        turnMessage,
        turnStartMs,
        turnId,
        requestId,
        stage,
        callType,
        payload,
      ) => this.emitTurnStage(turnMessage, turnStartMs, turnId, requestId, stage, callType, payload),
      recordUserMessage: (turnMessage, turnId, requestId, trustLevel, canonicalContactKey) => this.recordUserMessage(
        turnMessage,
        turnId,
        requestId,
        trustLevel,
        canonicalContactKey,
      ),
      resolveSessionChannelId: (channelId) => this.resolveSessionChannelId(channelId),
      resolveChannelType: (turnMessage) => this.resolveChannelType(turnMessage),
      ensureModel: (turnMessage) => this.ensureModel(turnMessage),
      captureTurnPromptSnapshot: (ctx) => this.captureTurnPromptSnapshot(ctx),
      buildScratchpadContextBlock: () => this.buildScratchpadContextBlock(),
      normalizeTurnPromptOverride: (turnMessage) => this.normalizeTurnPromptOverride(turnMessage),
      resolveResponseStyle: (turnMessage, channelType, channelMeta) => this.resolveResponseStyle(
        turnMessage,
        channelType,
        channelMeta,
      ),
      buildPromptTemplateVariables: (
        turnMessage,
        resolvedUserName,
        trustLevel,
        channelType,
        canonicalContactKey,
        now,
      ) => this.buildPromptTemplateVariables(
        turnMessage,
        resolvedUserName,
        trustLevel,
        channelType,
        canonicalContactKey,
        now,
      ),
      setCurrentSelfModelState: (state, snapshotRef, metacognitiveFlags) => {
        this.currentInternalState = state;
        this.currentInternalStateSnapshotRef = snapshotRef;
        this.currentMetacognitiveFlags = cloneMetacognitiveFlags(metacognitiveFlags);
      },
      buildRuntimeContext: (
        turnMessage,
        resolvedUserName,
        trustLevel,
        channelType,
        canonicalContactKey,
        responseStyle,
        now,
        taskKind,
        templateVariables,
        internalState,
        metacognitiveFlags,
        emotionAppraisalChain,
      ) => this.buildRuntimeContext(
        turnMessage,
        resolvedUserName,
        trustLevel,
        channelType,
        canonicalContactKey,
        responseStyle,
        now,
        taskKind,
        templateVariables,
        internalState,
        metacognitiveFlags,
        emotionAppraisalChain,
      ),
      buildPromptPrefixCacheKey: (turnMessage, channelType, canonicalContactKey) => this.buildPromptPrefixCacheKey(
        turnMessage,
        channelType,
        canonicalContactKey,
      ),
      buildStaticPromptSettingsHash: (templateVariables) => this.buildStaticPromptSettingsHash(templateVariables),
      resolveStaticPromptPrefix: (params) => this.resolveStaticPromptPrefix(params),
      hashPromptText: (text) => this.hashPromptText(text),
      getPersonaAdaptation: (trustLevel, internalState, metacognitiveFlags, templateVariables) => this.getPersonaAdaptation(
        trustLevel,
        internalState,
        metacognitiveFlags,
        templateVariables,
      ),
      resolveContextWindow: () => this.resolveContextWindow(),
      preloadExtendedToolsForTurn: (turnMessage, taskKind, correlation) => this.preloadExtendedToolsForTurn(
        turnMessage,
        taskKind,
        correlation,
      ),
      applyActiveToolsToAgentForTurn: (
        turnMessage,
        taskKind,
        callType,
        correlation,
        autoloadOutcome,
      ) => this.applyActiveToolsToAgentForTurn(turnMessage, taskKind, callType, correlation, autoloadOutcome),
      setActiveTurnContext: (correlation, taskKind, intent) => {
        this.activeTurnCorrelation = correlation;
        this.activeTurnTaskKind = taskKind;
        this.activeTurnIntent = intent;
      },
      clearActiveTurnContext: () => {
        this.activeTurnCorrelation = null;
        this.activeTurnTaskKind = null;
        this.activeTurnIntent = null;
      },
      setActiveTurnCorrelation: (correlation) => {
        this.activeTurnCorrelation = correlation;
      },
      extractResponseText: () => this.extractResponseText(),
      getLatestAssistantMessage: () => this.getLatestAssistantMessage(),
      accumulateTurnUsage: (messages) => this.accumulateTurnUsage(messages),
      recordToolObservations: (turnMessage, turnId, requestId, turnMessages, trustLevel) => this.recordToolObservations(
        turnMessage,
        turnId,
        requestId,
        turnMessages,
        trustLevel,
      ),
      recordAssistantMessage: (
        turnMessage,
        turnId,
        requestId,
        responseText,
        trustLevel,
        canonicalContactKey,
        emotionSnapshot,
      ) => this.recordAssistantMessage(
        turnMessage,
        turnId,
        requestId,
        responseText,
        trustLevel,
        canonicalContactKey,
        emotionSnapshot,
      ),
      buildTurnToolSummary: (turnMessages) => this.buildTurnToolSummary(turnMessages),
      inferPostTurnActions: (context) => this.inferPostTurnActions(context),
      buildTurnRecord: (input) => this.buildTurnRecord(input),
      queueBackgroundContinuationCompletion: (
        deferredContinuationId,
        turnMessage,
        response,
        taskKind,
        intent,
      ) => this.queueBackgroundContinuationCompletion(deferredContinuationId, turnMessage, response, taskKind, intent),
      emitBackgroundContinuationEvent: (eventName, payload) => this.emitBackgroundContinuationEvent(eventName, payload),
      dequeueBackgroundContinuationDeliveries: (deliverySessionId) => this.dequeueBackgroundContinuationDeliveries(
        deliverySessionId,
      ),
      emitTelemetry: (eventName, payload) => this.emitTelemetry(eventName, payload),
      runIntentionPostTurnHooks: (context) => this.runIntentionPostTurnHooks(context),
    }, message);
  }

  // ── Private helpers ──

  private pinDeferredContinuationSessionContext(
    deferredContinuationId: string | null,
    channelId: string,
  ): () => void {
    return pinDeferredContinuationSessionContextForTurn(
      deferredContinuationId,
      channelId,
      this.sessionManager,
    );
  }

  private resolveSessionChannelId(channelId: string): string {
    return resolveSessionChannelIdForTurn(this.sessionManager, channelId);
  }

  private queueBackgroundContinuationCompletion(
    deferredContinuationId: string,
    message: SubstrateMessage,
    response: AgentResponse,
    taskKind: string | null,
    intent: string | null,
  ): BackgroundContinuationCompletionSignal {
    return queueBackgroundContinuationCompletionForTurn({
      deferredContinuationId,
      message,
      response,
      taskKind,
      intent,
      resolveSessionChannelId: (channelId) => this.resolveSessionChannelId(channelId),
      backgroundContinuationTasks: this.backgroundContinuationTasks,
      pendingBackgroundContinuationDeliveries: this.pendingBackgroundContinuationDeliveries,
    });
  }

  private dequeueBackgroundContinuationDeliveries(
    deliverySessionId: string,
  ): PendingBackgroundContinuationDelivery[] {
    return dequeueBackgroundContinuationDeliveriesForTurn(
      this.pendingBackgroundContinuationDeliveries,
      deliverySessionId,
    );
  }

  private async emitBackgroundContinuationEvent(
    eventName: 'agent.background.continuation.completed' | 'agent.background.continuation.post_turn_delivery',
    payload: Record<string, unknown>,
  ): Promise<void> {
    await emitBackgroundContinuationEventForTurn(this.eventBus, eventName, payload);
  }

  private emitTurnStage(
    message: SubstrateMessage,
    turnStartMs: number,
    turnId: TurnID,
    requestId: string,
    stage: TurnStageName,
    callType: ObservabilityCallType,
    payload: Record<string, unknown>,
  ): void {
    const telemetry = buildTurnStageTelemetryForTurn({
      message,
      turnStartMs,
      turnId,
      requestId,
      stage,
      callType,
      payload,
    });
    log.debug('Turn stage telemetry', telemetry);
    this.emitTelemetry('agent.turn.stage', telemetry);
  }

  private resolveTurnCallType(
    message: SubstrateMessage,
    taskKind: string | undefined,
  ): ObservabilityCallType {
    return resolveTurnCallTypeForTurn(message, taskKind);
  }

  private buildTurnCorrelation(
    message: SubstrateMessage,
    callType: ObservabilityCallType,
    turnId: TurnID,
    requestId: string,
  ): CorrelationMetadata {
    return buildTurnCorrelationForTurn(message, callType, turnId, requestId);
  }

  private withCorrelationPurpose(
    correlation: CorrelationMetadata,
    purpose: string,
  ): CorrelationMetadata {
    return withCorrelationPurposeForTurn(correlation, purpose);
  }

  private withAdaptiveCorrelation(
    correlation: CorrelationMetadata | undefined,
    purpose: string,
  ): Partial<CorrelationMetadata> {
    return withAdaptiveCorrelationForTurn(correlation, this.activeTurnCorrelation, purpose);
  }

  private emitAdaptiveToolDecision(
    payload: Omit<AdaptiveToolDecisionTelemetry, 'timestamp'>,
  ): void {
    this.emitTelemetry('agent.tools.adaptive.decision', {
      ...payload,
      timestamp: Date.now(),
    });
  }

  private emitTelemetry(event: string, payload: Record<string, unknown>): void {
    const telemetryBus = this.eventBus as unknown as {
      emit: (event: string, payload: Record<string, unknown>) => Promise<void>;
    };
    telemetryBus.emit(event, payload).catch(error => {
      log.debug('Telemetry emit failed', {
        event,
        error: toErrorMessage(error),
      });
    });
  }

  private captureTurnPromptSnapshot(ctx: ComposeContext): TurnPromptSnapshot {
    return captureTurnPromptSnapshotForTurn({
      promptComposer: this.promptComposer,
      composeContext: ctx,
      systemPrompt: this.systemPrompt,
    });
  }

  private buildPromptPrefixCacheKey(
    message: SubstrateMessage,
    channelType: string | undefined,
    canonicalContactKey: string | undefined,
  ): string {
    return buildPromptPrefixCacheKeyForTurn(message, channelType, canonicalContactKey);
  }

  private buildStaticPromptSettingsHash(templateVariables: Record<string, string>): string {
    return buildStaticPromptSettingsHashForTurn(templateVariables);
  }

  private resolveStaticPromptPrefix(params: {
    cacheKey: string;
    staticPrefixTemplate: string;
    staticHash: string;
    settingsHash: string;
    now: Date;
    variables: Record<string, string>;
  }): string {
    return resolveStaticPromptPrefixForTurn({
      cache: this.frozenPromptPrefixCache,
      cacheKey: params.cacheKey,
      staticPrefixTemplate: params.staticPrefixTemplate,
      staticHash: params.staticHash,
      settingsHash: params.settingsHash,
      now: params.now,
      variables: params.variables,
    });
  }

  private invalidatePromptPrefixCache(reason: string): void {
    if (this.frozenPromptPrefixCache.size === 0) return;
    this.frozenPromptPrefixCache.clear();
    log.info('Invalidated static prompt-prefix cache', {
      reason,
    });
  }

  private hashPromptText(text: string): string {
    return hashPromptTextForTurn(text);
  }

  private recordUserMessage(
    message: SubstrateMessage,
    turnId: TurnID,
    requestId: string,
    trustLevel: TrustLevel,
    canonicalContactKey?: string,
  ): number | null {
    return recordUserMessageForTurn({
      sessionManager: this.sessionManager,
      message,
      turnId,
      requestId,
      trustLevel,
      canonicalContactKey,
    });
  }

  private recordAssistantMessage(
    message: SubstrateMessage,
    turnId: TurnID,
    requestId: string,
    responseText: string,
    trustLevel: TrustLevel,
    canonicalContactKey?: string,
    emotionSnapshot?: EmotionStateSnapshot | null,
  ): number | null {
    return recordAssistantMessageForTurn({
      sessionManager: this.sessionManager,
      message,
      turnId,
      requestId,
      responseText,
      trustLevel,
      canonicalContactKey,
      emotionSnapshot,
    });
  }

  private recordToolObservations(
    message: SubstrateMessage,
    turnId: TurnID,
    requestId: string,
    turnMessages: AgentMessage[],
    trustLevel: TrustLevel,
  ): void {
    recordToolObservationsForTurn({
      sessionManager: this.sessionManager,
      message,
      turnId,
      requestId,
      turnMessages,
      trustLevel,
    });
  }

  private buildTurnRecord(input: {
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
    internalStateSnapshotRef?: string;
  }): TurnRecord {
    return buildTurnRecordForTurn({
      ...input,
      hashPromptText: (text) => this.hashPromptText(text),
    });
  }

  /** Aggregate usage stats for a single turn across all tool loop iterations. */
  private accumulateTurnUsage(messages: AgentMessage[]): TurnUsage {
    return accumulateTurnUsageForTurn(messages, this.resolveContextWindow());
  }

  private resolveContextWindow(): number {
    // Config-level contextWindow takes precedence (user-configured via settings).
    // Only fall back to model-object contextWindow for per-turn overrides,
    // since LiteLLM models always bake in a 128k default.
    const configWindow = this.config.modelRoster.chat?.contextWindow ?? this.config.defaultContextWindow;
    if (configWindow > 0) return configWindow;
    const runtimeWindow = (this.agent.state.model as { contextWindow?: unknown } | undefined)?.contextWindow;
    if (typeof runtimeWindow === 'number' && Number.isFinite(runtimeWindow) && runtimeWindow > 0) {
      return runtimeWindow;
    }
    return 128_000; // sensible fallback
  }

  private buildTurnToolSummary(turnMessages: AgentMessage[]): TurnToolSummary {
    return buildTurnToolSummaryForTurn(turnMessages);
  }

  private async inferPostTurnActions(
    context: PostTurnInferenceContext,
  ): Promise<InferredPostTurnAction[]> {
    return inferPostTurnActionsForTurn({
      inferers: this.postTurnActionInferers,
      context,
      logger: log,
    });
  }

  private async runIntentionPostTurnHooks(
    context: IntentionPostTurnHookContext,
  ): Promise<void> {
    await runIntentionPostTurnHooksForTurn({
      hooks: this.intentionPostTurnHooks,
      context,
      logger: log,
    });
  }

  private getLatestAssistantMessage(): AssistantMessage | null {
    const messages = this.agent.state.messages;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if ((msg as unknown as { role: string }).role === 'assistant') {
        return msg as unknown as AssistantMessage;
      }
    }
    return null;
  }

  /** Extract text from the last assistant message in Agent state */
  private extractResponseText(): string {
    const assistantMessage = this.getLatestAssistantMessage();
    if (!assistantMessage) {
      log.warn('No assistant message found in agent state after prompt');
      return '';
    }

    const content = assistantMessage.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const textParts = content
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.text)
        .join('');
      if (!textParts) {
        const thinkingParts = content.filter((b: any) => b.type === 'thinking');
        if (thinkingParts.length) {
          log.warn('Assistant produced thinking but no text content', {
            thinkingBlocks: thinkingParts.length,
            blockTypes: content.map((b: any) => b.type),
            stopReason: assistantMessage.stopReason,
            errorMessage: assistantMessage.errorMessage ?? null,
          });
        } else {
          log.warn('Assistant message has no text content blocks', {
            blockTypes: content.map((b: any) => b.type),
            stopReason: assistantMessage.stopReason,
            errorMessage: assistantMessage.errorMessage ?? null,
          });
        }
      }
      return textParts;
    }

    log.warn('No assistant message found in agent state after prompt');
    return '';
  }
  private deriveCharacterName(systemPrompt: string): string {
    const firstLine = systemPrompt.split('\n')[0]?.trim() ?? '';
    const match = firstLine.match(/^You are\s+(.+?)\.?$/i);
    const candidate = match?.[1]?.trim();
    return candidate && candidate.length > 0 ? candidate : 'Assistant';
  }

  private buildPromptTemplateVariables(
    message: SubstrateMessage,
    resolvedUserName: string,
    trustLevel: TrustLevel,
    channelType: string | undefined,
    canonicalContactKey: string | undefined,
    now: Date,
  ): Record<string, string> {
    const characterPromptVariables = this.resolveCharacterPromptVariables();
    const { templateVariables, runtimeCharacterName } = buildPromptTemplateVariablesForTurn({
      message,
      resolvedUserName,
      trustLevel,
      channelType,
      canonicalContactKey,
      now,
      characterPromptVariables,
      modelId: this.agent.state.model.id,
      fallbackCharacterName: this.characterName,
    });
    this.characterName = runtimeCharacterName;
    return templateVariables;
  }

  /** Build a runtime context block with current time, channel, user, model info */
  private buildRuntimeContext(
    message: SubstrateMessage,
    resolvedUserName: string,
    trustLevel: TrustLevel,
    channelType: string | undefined,
    canonicalContactKey?: string,
    responseStyle: ResponseStyle = 'concise',
    now: Date = new Date(),
    taskKind?: string,
    templateVariables?: Record<string, string>,
    internalState?: InternalState,
    metacognitiveFlags: readonly MetacognitiveFlag[] = [],
    emotionAppraisalChain: readonly EmotionAppraisalEntry[] = [],
  ): string {
    const activeResolution = this.resolveActiveTools();
    return buildRuntimeContextForTurn({
      message,
      resolvedUserName,
      trustLevel,
      channelType,
      canonicalContactKey,
      responseStyle,
      now,
      taskKind,
      templateVariables,
      internalState,
      metacognitiveFlags,
      emotionAppraisalChain,
      modelId: this.agent.state.model.id,
      contextWindow: this.resolveContextWindow(),
      capabilityTier: this.resolveCapabilityAccess().getTier(),
      activeToolCounts: activeResolution.counts,
      extendedTools: this.extendedTools,
      loadedExtended: this.loadedExtended,
      classifyExtendedToolForTurn: (toolName) => this.classifyExtendedToolForTurn(toolName),
      promotedExtendedToolNames: this.getCapabilityEligiblePromotedToolNames(),
      skillsContext: this.skillsRuntime?.getPromptXml() ?? '',
      activeConcernsBlock: this.buildActiveConcernsContextBlock(canonicalContactKey),
      behavioralNotesBlock: this.buildBehavioralNotesContextBlock(canonicalContactKey),
      formatTopEmotions: (discrete) => this.emotionSelfModelRuntime.formatTopEmotions(discrete),
    });
  }

  private buildActiveConcernsContextBlock(canonicalContactKey?: string): string {
    return buildActiveConcernsContextBlockForTurn({
      activeConcernProvider: this.activeConcernProvider,
      canonicalContactKey,
      logger: log,
    });
  }

  private buildMetacognitiveNotesContextBlock(): string {
    return buildMetacognitiveNotesContextBlockForTurn(this.currentMetacognitiveFlags);
  }

  private buildBehavioralNotesContextBlock(canonicalContactKey?: string): string {
    return buildBehavioralNotesContextBlockForTurn({
      behavioralPatternProvider: this.behavioralPatternProvider,
      canonicalContactKey,
      logger: log,
    });
  }

  private buildScratchpadContextBlock(): string {
    return buildScratchpadContextBlockForTurn({
      scratchpadProvider: this.scratchpadProvider,
      logger: log,
    });
  }

  /** Map message channel info to a channelType string for prompt composition */
  private resolveChannelPromptDock(message: SubstrateMessage): ChannelPromptDock | undefined {
    const fromChannelType = this.channelRegistry.get(message.channelType);
    if (fromChannelType) return fromChannelType;

    const separatorIndex = message.channelId.indexOf(':');
    if (separatorIndex > 0) {
      const prefix = message.channelId.slice(0, separatorIndex);
      const fromPrefix = this.channelRegistry.get(prefix);
      if (fromPrefix) return fromPrefix;
    }

    if (message.channelId.startsWith('discord-voice:')) {
      return this.channelRegistry.get('discord');
    }
    return undefined;
  }

  /** Map message channel info to a channelType string for prompt composition */
  private resolveChannelType(message: SubstrateMessage): string | undefined {
    const channelDock = this.resolveChannelPromptDock(message);
    const adapterType = channelDock?.prompt?.resolveChannelType(message);
    if (adapterType) return adapterType;
    if (channelDock?.capabilities.promptChannelType) {
      return channelDock.capabilities.promptChannelType;
    }

    if (message.channelId.startsWith('discord-voice:')) return 'discord_voice';
    if (message.channelId.startsWith('api:')) return 'api';
    if (message.channelId.startsWith('internal:')) return 'internal';
    if (message.channelType === 'discord') return 'discord_text';
    return undefined;
  }

  /** Map internal channel/task context to prompt taskKind overlays */
  private resolveTaskKind(message: SubstrateMessage): string | undefined {
    if (isDeferredToolHandoffMessageId(message.id)) {
      return 'deferred_tool_handoff';
    }
    const channelDock = this.resolveChannelPromptDock(message);
    const adapterTaskKind = channelDock?.prompt?.resolveTaskKind?.(message);
    if (adapterTaskKind) return adapterTaskKind;

    if (!message.channelId.startsWith('internal:')) return undefined;

    const suffix = message.channelId.slice('internal:'.length).toLowerCase();
    if (!suffix) return undefined;

    if (suffix.includes('heartbeat')) return 'heartbeat';
    if (suffix.includes('reflection')) return 'reflection';
    if (suffix.includes('planning')) return 'planning';
    if (suffix.includes('maintenance')) return 'maintenance';
    return undefined;
  }

  private buildTurnBudgetCharacteristics(
    message: SubstrateMessage,
    taskKind?: string,
  ): ContextBudgetTurnCharacteristics {
    return {
      channelId: message.channelId,
      channelType: message.channelType,
      isDirectMessage: message.isDirectMessage,
      messageText: message.content,
      ...(taskKind ? { taskKind } : {}),
    };
  }

  private getPersonaAdaptation(
    trustLevel: TrustLevel,
    internalState: InternalState,
    metacognitiveFlags: readonly MetacognitiveFlag[],
    templateVariables?: Record<string, string>,
  ): string | null {
    return getPersonaAdaptationForTurn({
      trustLevel,
      internalState,
      metacognitiveFlags,
      templateVariables,
      config: this.config as unknown as Record<string, unknown>,
    });
  }

  private resolveAuthorContext(message: SubstrateMessage): ResolvedAuthorContext {
    return resolveAuthorContextForTurn({
      message,
      contactStore: this.contactStore,
      logger: log,
    });
  }
}
