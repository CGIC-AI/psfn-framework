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
  MessageModelOverride,
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
  ModelPurpose,
} from '../types.js';
import { PROMOTED_EXTENDED_TOOL_SLOTS_MAX } from '../types.js';
import type { ContactStore } from '../contacts/store.js';
import type { LLMProvider, MemoryProvider, MemoryExtractor, ScratchpadProvider } from './contracts.js';
import type { TrustLevel } from '../trust/types.js';
import {
  classifyChannel,
  resolveChannelResponseStyle,
  type ChannelMeta,
} from '../trust/policy.js';
import type { ChannelPromptDock } from '../channels/types.js';
import {
  enforceUntrustedCompactionGuard,
  type PromptComposer,
} from '../identity/prompt-composer.js';
import type { ComposeContext } from '../identity/prompt-types.js';
import {
  createSubstrateStreamFn,
  resolveExplicitModel,
  resolveModel,
  resolveModelSelection,
} from './stream-adapter.js';
import {
  inferRuntimeModeFromProvider,
} from './substrate-agent-helpers.js';
import { installAgentToolSchedulerPatch } from './agent-loop-patch.js';
import { convertToLlm } from './messages.js';
import { createEventBridge, type EventBridge } from './event-bridge.js';
import { createComponentLogger } from '../logger.js';
import { injectPromptRuntimeTokens } from '../identity/prompt-runtime.js';
import type { SkillsRuntime } from '../skills/runtime.js';
import { ReflectionNudgeTracker, type TurnToolSummary } from '../skills/reflection-nudge.js';
import type { ToolCategory } from './tool-registrar.js';
import {
  evaluateToolCapabilityEligibility,
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
  type ToolConcurrencyMeta,
  type RuntimeMode,
  type ToolConcurrencyClass,
  type ToolExecutionEligibility,
  type ToolInterruptibility,
  type ValidateToolsOptions,
  type WirableTool,
} from './tool-wiring-validator.js';
import {
  classifyBroadcastDraft,
  resolveBroadcastVisibilityScope,
} from '../broadcast/safety.js';
import { runWithRequestContext } from '../llm/request-context.js';
import {
  parseDeferredToolHandoffActionId,
  isDeferredToolHandoffMessageId,
} from './deferred-tool-handoff.js';
import {
  classifyExtendedToolForTurn as classifyDefaultExtendedToolForTurn,
  createDefaultExtendedToolAutoloadPolicy,
  type ExtendedToolAutoloadPolicy,
  type ExtendedToolTurnClass,
} from './extended-tool-autoload-policy.js';
import { BackgroundCompletionDeliveryQueue } from './background-completion-delivery-queue.js';
import type {
  AdaptiveLoadedExtendedToolState,
  AdaptiveToolActivationSource,
  AdaptiveToolDecisionTelemetry,
  AdaptiveToolRuntimeState,
  AdaptiveToolSnapshotSkip,
  AdaptiveToolSnapshotTelemetry,
  AdaptiveToolSnapshotTool,
} from './adaptive-tools-telemetry.js';
import { contextMessagesToPiMessages } from '../llm/message-conversion.js';
import { createTurnId } from '../turns/id.js';
import type { TurnPromptSnapshot, TurnSnapshot } from '../turns/snapshot.js';
import type { ContextManifestMemorySeed } from '../session/context-manifest.js';
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
  buildInternalStateSnapshotRef,
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
  buildTurnUserContent,
  hasVisionAttachments,
} from './substrate-agent/vision-attachments.js';
import {
  resolveMoaSettings,
  runMoaTurn,
} from './substrate-agent/moa-turn.js';
import { EmotionSelfModelRuntime } from './substrate-agent/emotion-self-model-runtime.js';
import {
  activateExtendedToolsForTurn,
  createLoadToolsTool,
  preloadExtendedToolsForTurn,
  type AutoloadTurnOutcome,
  type ExtendedToolActivationOptions,
  type ExtendedToolActivationResult,
} from './substrate-agent/adaptive-tools-runtime.js';
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

interface ProactiveMemoryProvider extends MemoryProvider {
  retrieveProactiveRecall?: (
    channelId: string,
    trustLevel?: TrustLevel,
    channelMeta?: ChannelMeta,
    canonicalContactId?: string,
    turnSnapshot?: import('../turns/snapshot.js').TurnMemorySnapshot,
    turnBudgetCharacteristics?: ContextBudgetTurnCharacteristics,
  ) => Promise<string>;
}

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

export type PromotedToolMutationErrorCode =
  | 'invalid_name'
  | 'tool_not_extended'
  | 'duplicate'
  | 'max_slots'
  | 'background_only'
  | 'capability_denied'
  | 'not_found'
  | 'invalid_slot'
  | 'persist_failed';

export interface PromotedToolMutationResult {
  ok: boolean;
  changed: boolean;
  promotedTools: string[];
  message: string;
  errorCode?: PromotedToolMutationErrorCode;
  requiredTokens?: CapabilityToken[];
  missingTokens?: CapabilityToken[];
}

const LOADED_TOOL_SOURCE_PRIORITY: Record<Extract<AdaptiveToolActivationSource, 'extended_loaded' | 'autoload' | 'deferred'>, number> = {
  autoload: 1,
  extended_loaded: 2,
  deferred: 3,
};
const DEFAULT_PARALLEL_READ_MAX = 3;
const DEFAULT_SPAWN_SHARD_PARALLEL_MAX = 5;
const DEFAULT_TOOL_SCHEDULER_MAX_PARALLEL = 5;
const PARALLEL_READ_ONLY_TOOL_NAMES = new Set([
  'repo_status',
  'repo_diff',
  'issue_ready',
  'issue_show',
  'settings_get',
  'heartbeat_get_policy',
  'contact_lookup',
  'contact_list',
  'session_list',
  'skill_list',
  'skill_view',
  'prompt_layer_list',
  'prompt_layer_get',
  'identity_diff',
]);

interface ActiveToolResolution {
  tools: AgentTool<any>[];
  snapshotTools: AdaptiveToolSnapshotTool[];
  promotedSkipped: AdaptiveToolSnapshotSkip[];
  counts: AdaptiveToolSnapshotTelemetry['counts'];
}

interface PromotedToolResolution {
  activeNames: Set<string>;
  skipped: AdaptiveToolSnapshotSkip[];
}

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

  private getModelSignatureForPurpose(purpose: ModelPurpose): string {
    try {
      const selection = resolveModelSelection(this.config, purpose);
      const contextWindow = selection.contextWindow ?? this.config.defaultContextWindow;
      return `${purpose}::${selection.provider}::${selection.model}::${selection.maxTokens}::${contextWindow}`;
    } catch (error) {
      return `${purpose}::unresolved::${toErrorMessage(error)}`;
    }
  }

  private resolveTurnModelPurpose(message?: SubstrateMessage): ModelPurpose {
    return hasVisionAttachments(message) ? 'vision' : 'chat';
  }

  private normalizeTurnModelOverride(message?: SubstrateMessage): MessageModelOverride | null {
    const raw = message?.routing?.modelOverride;
    if (!raw) return null;
    const provider = raw.provider.trim().toLowerCase();
    const model = raw.model.trim();
    if (!provider || !model) return null;

    return {
      provider,
      model,
      ...(raw.maxTokens !== undefined ? { maxTokens: raw.maxTokens } : {}),
      ...(raw.contextWindow !== undefined ? { contextWindow: raw.contextWindow } : {}),
      ...(raw.slotKey ? { slotKey: raw.slotKey } : {}),
      ...(raw.purpose ? { purpose: raw.purpose } : {}),
    };
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
    const override = this.normalizeTurnModelOverride(message);
    if (!override) {
      const purpose = this.resolveTurnModelPurpose(message);
      return this.getModelSignatureForPurpose(purpose);
    }
    return `override::${override.provider}::${override.model}::${override.maxTokens ?? ''}::${override.contextWindow ?? ''}`;
  }

  private refreshModelFromConfig(
    reason: 'startup' | 'turn-start' | 'settings-update',
    message?: SubstrateMessage,
  ): void {
    const override = this.normalizeTurnModelOverride(message);
    const purpose = override ? null : this.resolveTurnModelPurpose(message);
    const nextSignature = this.getTurnModelSignature(message);
    if (this.modelResolved && this.modelSignature === nextSignature) {
      return;
    }

    try {
      const resolved = override
        ? resolveExplicitModel(override)
        : resolveModel(this.config, purpose ?? 'chat');
      this.agent.setModel(resolved);
      this.modelResolved = true;
      this.modelSignature = nextSignature;
      if (purpose === 'vision' && !resolved.input.includes('image')) {
        log.warn('Vision purpose resolved to model without image input capability', {
          reason,
          model: resolved.id,
          provider: resolved.provider,
          channelId: message?.channelId,
        });
      }
      log.info('Resolved runtime model', {
        reason,
        model: resolved.id,
        override: Boolean(override),
        ...(purpose ? { purpose } : {}),
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.modelResolved = true;
      log.warn('Model refresh failed; keeping previous chat model', {
        reason,
        error: err.message,
        currentModel: this.agent.state.model.id,
      });
      return;
    }
  }

  registerTool(tool: AgentTool<any>, category: ToolCategory = 'core'): void {
    const taggedTool = this.withToolConcurrencyMetadata(tagToolWithReversibility(tool), category);
    if (category === 'core') {
      this.coreTools.push(taggedTool);
    } else {
      this.extendedTools.push(taggedTool);
    }
  }

  private inferToolConcurrencyClass(toolName: string): ToolConcurrencyClass {
    if (toolName === 'spawn_shard') return 'spawn_shard';
    if (PARALLEL_READ_ONLY_TOOL_NAMES.has(toolName)) return 'read_only';
    return 'exclusive';
  }

  private inferToolInterruptibility(concurrencyClass: ToolConcurrencyClass): ToolInterruptibility {
    if (concurrencyClass === 'spawn_shard') return 'non_interruptible';
    return 'cooperative';
  }

  private inferToolEligibility(toolName: string, category: ToolCategory): ToolExecutionEligibility {
    if (category === 'extended' && classifyDefaultExtendedToolForTurn(toolName) === 'background') {
      return {
        foreground: false,
        background: true,
      };
    }
    return {
      foreground: true,
      background: true,
    };
  }

  private withToolConcurrencyMetadata(tool: AgentTool<any>, category: ToolCategory): AgentTool<any> {
    const wirable = tool as WirableTool;
    const existingMeta = wirable.wiringMeta;
    const existingConcurrency = existingMeta?.concurrency as Partial<ToolConcurrencyMeta> | undefined;
    const inferredClass = this.inferToolConcurrencyClass(tool.name);
    const inferredEligibility = this.inferToolEligibility(tool.name, category);
    const resolvedClass = existingConcurrency?.class ?? inferredClass;
    const concurrency: ToolConcurrencyMeta = {
      class: resolvedClass,
      exclusivityKeyPolicy: existingConcurrency?.exclusivityKeyPolicy
        ?? (resolvedClass === 'exclusive' ? 'category_tool_name' : 'none'),
      ...(existingConcurrency?.exclusivityKey ? { exclusivityKey: existingConcurrency.exclusivityKey } : {}),
      ...(existingConcurrency?.maxParallel !== undefined ? { maxParallel: existingConcurrency.maxParallel } : {}),
      interruptibility: existingConcurrency?.interruptibility
        ?? this.inferToolInterruptibility(resolvedClass),
      eligibility: existingConcurrency?.eligibility
        ? {
          foreground: typeof existingConcurrency.eligibility.foreground === 'boolean'
            ? existingConcurrency.eligibility.foreground
            : inferredEligibility.foreground,
          background: typeof existingConcurrency.eligibility.background === 'boolean'
            ? existingConcurrency.eligibility.background
            : inferredEligibility.background,
        }
        : inferredEligibility,
    };

    if (concurrency.class === 'exclusive') {
      if (!concurrency.exclusivityKey || concurrency.exclusivityKey.trim().length === 0) {
        concurrency.exclusivityKey = `${category}:${tool.name}`;
        concurrency.exclusivityKeyPolicy = 'category_tool_name';
      } else if (
        concurrency.exclusivityKeyPolicy === 'none'
      ) {
        concurrency.exclusivityKeyPolicy = 'static_key';
      }
    } else {
      concurrency.exclusivityKeyPolicy = 'none';
      delete concurrency.exclusivityKey;
      if (concurrency.maxParallel === undefined) {
        concurrency.maxParallel = concurrency.class === 'spawn_shard'
          ? DEFAULT_SPAWN_SHARD_PARALLEL_MAX
          : DEFAULT_PARALLEL_READ_MAX;
      }
    }

    wirable.wiringMeta = {
      ...(existingMeta ?? {}),
      concurrency,
    };
    return wirable;
  }

  private normalizePromotedExtendedToolNames(raw: readonly string[] | undefined): string[] {
    if (!Array.isArray(raw)) return [];
    const normalized: string[] = [];
    const seen = new Set<string>();
    for (const entry of raw) {
      if (typeof entry !== 'string') continue;
      const name = entry.trim();
      if (!name || seen.has(name)) continue;
      normalized.push(name);
      seen.add(name);
      if (normalized.length >= PROMOTED_EXTENDED_TOOL_SLOTS_MAX) break;
    }
    return normalized;
  }

  private toolNameListsEqual(a: readonly string[], b: readonly string[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  private getPromotedExtendedToolNamesInternal(): string[] {
    const current = this.normalizePromotedExtendedToolNames(this.config.promotedExtendedTools);
    const configured = this.config.promotedExtendedTools ?? [];
    if (!this.toolNameListsEqual(current, configured)) {
      this.config.promotedExtendedTools = current;
    }
    return current;
  }

  private setPromotedExtendedToolNamesInternal(next: readonly string[]): string[] {
    const normalized = this.normalizePromotedExtendedToolNames(next);
    this.config.promotedExtendedTools = normalized;
    return normalized;
  }

  private persistPromotedExtendedToolNames(next: readonly string[]): string | null {
    const persist = this.config.runtimeHooks?.persistPromotedExtendedTools;
    if (!persist) return null;
    try {
      persist([...next]);
      return null;
    } catch (error) {
      return toErrorMessage(error);
    }
  }

  private getExtendedToolByName(name: string): AgentTool<any> | null {
    return this.extendedTools.find(tool => tool.name === name) ?? null;
  }

  private classifyExtendedToolForTurn(toolName: string): ExtendedToolTurnClass {
    const classifier = this.extendedToolAutoloadPolicy?.classifyToolForTurn;
    if (!classifier) {
      return classifyDefaultExtendedToolForTurn(toolName);
    }
    return classifier(toolName);
  }

  private resolvePromotedToolActivation(): PromotedToolResolution {
    const promoted = this.getPromotedExtendedToolNamesInternal();
    const access = this.resolveCapabilityAccess();
    const activeNames = new Set<string>();
    const skipped: AdaptiveToolSnapshotSkip[] = [];
    for (const toolName of promoted) {
      const tool = this.getExtendedToolByName(toolName);
      if (!tool) {
        skipped.push({
          toolName,
          source: 'promoted',
          reason: 'not_registered',
        });
        continue;
      }
      if (this.classifyExtendedToolForTurn(tool.name) !== 'overlay') {
        skipped.push({
          toolName: tool.name,
          source: 'promoted',
          reason: 'background_only',
        });
        continue;
      }
      const eligibility = evaluateToolCapabilityEligibility(tool, {}, access);
      if (!eligibility.allowed) {
        skipped.push({
          toolName: tool.name,
          source: 'promoted',
          reason: 'capability_denied',
          ...(eligibility.missingTokens.length > 0 ? { missingTokens: eligibility.missingTokens } : {}),
        });
        continue;
      }
      activeNames.add(tool.name);
    }
    return {
      activeNames,
      skipped,
    };
  }

  private getCapabilityEligiblePromotedToolNames(): Set<string> {
    return this.resolvePromotedToolActivation().activeNames;
  }

  private trackLoadedExtendedTool(
    toolName: string,
    source: Extract<AdaptiveToolActivationSource, 'extended_loaded' | 'autoload' | 'deferred'>,
  ): 'activated' | 'already_active' {
    const now = Date.now();
    const existing = this.loadedExtended.get(toolName);
    if (!existing) {
      this.loadedExtended.set(toolName, {
        toolName,
        source,
        activatedAt: now,
        lastActivatedAt: now,
      });
      return 'activated';
    }

    const shouldPromoteSource = LOADED_TOOL_SOURCE_PRIORITY[source] > LOADED_TOOL_SOURCE_PRIORITY[existing.source];
    this.loadedExtended.set(toolName, {
      ...existing,
      source: shouldPromoteSource ? source : existing.source,
      lastActivatedAt: now,
    });
    return 'already_active';
  }

  private mergeAdaptiveSkips(...groups: AdaptiveToolSnapshotSkip[][]): AdaptiveToolSnapshotSkip[] {
    const deduped = new Map<string, AdaptiveToolSnapshotSkip>();
    for (const group of groups) {
      for (const entry of group) {
        const missingTokensKey = (entry.missingTokens ?? []).join(',');
        const key = `${entry.source}:${entry.toolName}:${entry.reason}:${missingTokensKey}`;
        if (deduped.has(key)) continue;
        deduped.set(key, {
          ...entry,
          ...(entry.missingTokens ? { missingTokens: [...entry.missingTokens] } : {}),
        });
      }
    }
    return [...deduped.values()];
  }

  private resolveActiveTools(
    additionalSkipped: AdaptiveToolSnapshotSkip[] = [],
  ): ActiveToolResolution {
    const activeByName = new Map<string, { tool: AgentTool<any>; source: AdaptiveToolActivationSource }>();
    for (const tool of this.coreTools) {
      if (!activeByName.has(tool.name)) {
        activeByName.set(tool.name, {
          tool,
          source: 'core',
        });
      }
    }

    const promotedResolution = this.resolvePromotedToolActivation();
    for (const tool of this.extendedTools) {
      if (this.classifyExtendedToolForTurn(tool.name) !== 'overlay') {
        continue;
      }
      const loaded = this.loadedExtended.get(tool.name);
      const source: AdaptiveToolActivationSource | null = promotedResolution.activeNames.has(tool.name)
        ? 'promoted'
        : (loaded?.source ?? null);
      if (!source) {
        continue;
      }
      if (!activeByName.has(tool.name)) {
        activeByName.set(tool.name, {
          tool,
          source,
        });
      }
    }

    const snapshotTools: AdaptiveToolSnapshotTool[] = [...activeByName.values()]
      .map((entry) => ({
        toolName: entry.tool.name,
        source: entry.source,
      }));

    const counts: AdaptiveToolSnapshotTelemetry['counts'] = {
      core: 0,
      promoted: 0,
      extendedLoaded: 0,
      autoload: 0,
      deferred: 0,
      total: snapshotTools.length,
    };
    for (const entry of snapshotTools) {
      if (entry.source === 'core') counts.core += 1;
      else if (entry.source === 'promoted') counts.promoted += 1;
      else if (entry.source === 'extended_loaded') counts.extendedLoaded += 1;
      else if (entry.source === 'autoload') counts.autoload += 1;
      else counts.deferred += 1;
    }

    return {
      tools: [...activeByName.values()].map(entry => entry.tool),
      snapshotTools,
      promotedSkipped: this.mergeAdaptiveSkips(promotedResolution.skipped, additionalSkipped),
      counts,
    };
  }

  private applyActiveToolsToAgent(): void {
    const resolution = this.resolveActiveTools();
    this.agent.setTools(this.withCapabilityGates(resolution.tools));
  }

  private applyActiveToolsToAgentForTurn(
    message: SubstrateMessage,
    taskKind: string | undefined,
    callType: ObservabilityCallType,
    correlation: CorrelationMetadata,
    autoloadOutcome: AutoloadTurnOutcome,
  ): void {
    const resolution = this.resolveActiveTools(autoloadOutcome.skipped);
    this.agent.setTools(this.withCapabilityGates(resolution.tools));

    const snapshot: AdaptiveToolSnapshotTelemetry = {
      ...this.withAdaptiveCorrelation(correlation, 'agent.tools.adaptive.snapshot'),
      turnId: correlation.turnId,
      requestId: correlation.requestId,
      channelId: message.channelId,
      callType,
      timestamp: Date.now(),
      tools: resolution.snapshotTools.map(tool => ({ ...tool })),
      skipped: resolution.promotedSkipped.map(skip => ({
        ...skip,
        ...(skip.missingTokens ? { missingTokens: [...skip.missingTokens] } : {}),
      })),
      counts: { ...resolution.counts },
      taskKind: taskKind ?? null,
      intent: autoloadOutcome.intent,
    };
    this.lastAdaptiveToolSnapshot = snapshot;
    this.emitTelemetry('agent.tools.adaptive.snapshot', snapshot as unknown as Record<string, unknown>);

    for (const tool of snapshot.tools) {
      this.emitAdaptiveToolDecision({
        ...this.withAdaptiveCorrelation(correlation, 'agent.tools.adaptive.decision'),
        toolName: tool.toolName,
        source: tool.source,
        decision: 'active',
        reason: 'turn_active_set',
        taskKind: snapshot.taskKind ?? null,
        intent: snapshot.intent ?? null,
      });
    }

    for (const skip of snapshot.skipped) {
      if (skip.source !== 'promoted') continue;
      this.emitAdaptiveToolDecision({
        ...this.withAdaptiveCorrelation(correlation, 'agent.tools.adaptive.decision'),
        toolName: skip.toolName,
        source: skip.source,
        decision: 'skipped',
        reason: skip.reason,
        ...(skip.missingTokens ? { missingTokens: [...skip.missingTokens] } : {}),
        taskKind: snapshot.taskKind ?? null,
        intent: snapshot.intent ?? null,
      });
    }
  }

  getPromotedExtendedToolsLimit(): number {
    return PROMOTED_EXTENDED_TOOL_SLOTS_MAX;
  }

  getPromotedExtendedTools(): readonly string[] {
    return [...this.getPromotedExtendedToolNamesInternal()];
  }

  addPromotedExtendedTool(toolName: string): PromotedToolMutationResult {
    const normalizedName = toolName.trim();
    if (!normalizedName) {
      return {
        ok: false,
        changed: false,
        promotedTools: this.getPromotedExtendedToolNamesInternal(),
        message: 'Tool name cannot be empty.',
        errorCode: 'invalid_name',
      };
    }

    const current = this.getPromotedExtendedToolNamesInternal();
    if (current.includes(normalizedName)) {
      return {
        ok: true,
        changed: false,
        promotedTools: current,
        message: `Tool "${normalizedName}" is already promoted.`,
        errorCode: 'duplicate',
      };
    }

    if (current.length >= PROMOTED_EXTENDED_TOOL_SLOTS_MAX) {
      return {
        ok: false,
        changed: false,
        promotedTools: current,
        message: `Promoted tool slots are full (max ${PROMOTED_EXTENDED_TOOL_SLOTS_MAX}).`,
        errorCode: 'max_slots',
      };
    }

    const tool = this.getExtendedToolByName(normalizedName);
    if (!tool) {
      return {
        ok: false,
        changed: false,
        promotedTools: current,
        message: `Tool "${normalizedName}" is not available in the extended catalog.`,
        errorCode: 'tool_not_extended',
      };
    }
    if (this.classifyExtendedToolForTurn(tool.name) !== 'overlay') {
      return {
        ok: false,
        changed: false,
        promotedTools: current,
        message: `Tool "${normalizedName}" is background-only and cannot be promoted.`,
        errorCode: 'background_only',
      };
    }

    const access = this.resolveCapabilityAccess();
    const eligibility = evaluateToolCapabilityEligibility(tool, {}, access);
    if (!eligibility.allowed) {
      return {
        ok: false,
        changed: false,
        promotedTools: current,
        message: `Tool "${normalizedName}" is not allowed for capability tier "${access.getTier()}".`,
        errorCode: 'capability_denied',
        requiredTokens: eligibility.requiredTokens,
        missingTokens: eligibility.missingTokens,
      };
    }

    const next = [...current, normalizedName];
    const persistError = this.persistPromotedExtendedToolNames(next);
    if (persistError) {
      return {
        ok: false,
        changed: false,
        promotedTools: current,
        message: `Failed to persist promoted tools: ${persistError}`,
        errorCode: 'persist_failed',
      };
    }

    const promotedTools = this.setPromotedExtendedToolNamesInternal(next);
    this.applyActiveToolsToAgent();
    return {
      ok: true,
      changed: true,
      promotedTools,
      message: `Promoted tool "${normalizedName}".`,
    };
  }

  removePromotedExtendedTool(toolName: string): PromotedToolMutationResult {
    const normalizedName = toolName.trim();
    if (!normalizedName) {
      return {
        ok: false,
        changed: false,
        promotedTools: this.getPromotedExtendedToolNamesInternal(),
        message: 'Tool name cannot be empty.',
        errorCode: 'invalid_name',
      };
    }

    const current = this.getPromotedExtendedToolNamesInternal();
    if (!current.includes(normalizedName)) {
      return {
        ok: false,
        changed: false,
        promotedTools: current,
        message: `Tool "${normalizedName}" is not currently promoted.`,
        errorCode: 'not_found',
      };
    }

    const next = current.filter(name => name !== normalizedName);
    const persistError = this.persistPromotedExtendedToolNames(next);
    if (persistError) {
      return {
        ok: false,
        changed: false,
        promotedTools: current,
        message: `Failed to persist promoted tools: ${persistError}`,
        errorCode: 'persist_failed',
      };
    }

    const promotedTools = this.setPromotedExtendedToolNamesInternal(next);
    this.applyActiveToolsToAgent();
    return {
      ok: true,
      changed: true,
      promotedTools,
      message: `Removed promoted tool "${normalizedName}".`,
    };
  }

  swapPromotedExtendedTools(fromSlot: number, toSlot: number): PromotedToolMutationResult {
    const current = this.getPromotedExtendedToolNamesInternal();
    if (
      !Number.isInteger(fromSlot)
      || !Number.isInteger(toSlot)
      || fromSlot < 1
      || toSlot < 1
      || fromSlot > current.length
      || toSlot > current.length
    ) {
      return {
        ok: false,
        changed: false,
        promotedTools: current,
        message: `Slots must be integers between 1 and ${current.length}.`,
        errorCode: 'invalid_slot',
      };
    }

    if (fromSlot === toSlot) {
      return {
        ok: true,
        changed: false,
        promotedTools: current,
        message: 'Swap slots are identical; no change made.',
      };
    }

    const fromIndex = fromSlot - 1;
    const toIndex = toSlot - 1;
    const next = [...current];
    const fromTool = next[fromIndex];
    const toTool = next[toIndex];
    if (!fromTool || !toTool) {
      return {
        ok: false,
        changed: false,
        promotedTools: current,
        message: `Slots must be integers between 1 and ${current.length}.`,
        errorCode: 'invalid_slot',
      };
    }
    next[fromIndex] = toTool;
    next[toIndex] = fromTool;

    const persistError = this.persistPromotedExtendedToolNames(next);
    if (persistError) {
      return {
        ok: false,
        changed: false,
        promotedTools: current,
        message: `Failed to persist promoted tools: ${persistError}`,
        errorCode: 'persist_failed',
      };
    }

    const promotedTools = this.setPromotedExtendedToolNamesInternal(next);
    this.applyActiveToolsToAgent();
    return {
      ok: true,
      changed: true,
      promotedTools,
      message: `Swapped promoted tool slots ${fromSlot} and ${toSlot}.`,
    };
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

    return {
      generatedAt: Date.now(),
      coreTools: this.coreTools.map(tool => tool.name),
      extendedTools: this.extendedTools.map(tool => tool.name),
      promotedToolsConfigured: this.getPromotedExtendedToolNamesInternal(),
      promotedToolsActive: [...promotedResolution.activeNames],
      promotedToolsSkipped: promotedResolution.skipped.map(entry => ({
        ...entry,
        ...(entry.missingTokens ? { missingTokens: [...entry.missingTokens] } : {}),
      })),
      loadedExtendedTools: [...this.loadedExtended.values()].map(entry => ({
        ...entry,
      })),
      activeTools: activeResolution.snapshotTools.map(entry => ({
        ...entry,
      })),
      lastSnapshot: this.lastAdaptiveToolSnapshot
        ? {
          ...this.lastAdaptiveToolSnapshot,
          tools: this.lastAdaptiveToolSnapshot.tools.map(tool => ({ ...tool })),
          skipped: this.lastAdaptiveToolSnapshot.skipped.map(skip => ({
            ...skip,
            ...(skip.missingTokens ? { missingTokens: [...skip.missingTokens] } : {}),
          })),
          counts: { ...this.lastAdaptiveToolSnapshot.counts },
        }
        : null,
    };
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
    const startTime = Date.now();
    const requestId = message.id;
    const turnId = createTurnId();
    const deferredContinuationId = parseDeferredToolHandoffActionId(message.id);
    const restorePinnedSessionContext = this.pinDeferredContinuationSessionContext(
      deferredContinuationId,
      message.channelId,
    );
    const taskKind = this.resolveTaskKind(message);
    const turnBudgetCharacteristics = this.buildTurnBudgetCharacteristics(message, taskKind);
    const turnCallType = this.resolveTurnCallType(message, taskKind);
    const turnCorrelationBase = this.buildTurnCorrelation(message, turnCallType, turnId, requestId);
    const channelMeta: ChannelMeta = {
      isDirectMessage: message.isDirectMessage,
      ...(message.routing?.broadcast?.approvalToken
        ? { broadcastApprovalToken: message.routing.broadcast.approvalToken }
        : {}),
    };
    const channelVisibility = classifyChannel(message.channelId, channelMeta);
    const broadcastVisibilityScope = resolveBroadcastVisibilityScope(message.channelId, channelMeta);
    let retrievalProvenanceRefs: string[] = [];
    let memoryManifestSeed: ContextManifestMemorySeed | undefined;
    const unsubscribeRetrieval = this.eventBus.on('memory.retrieval', (telemetry) => {
      if (telemetry.channelId !== message.channelId) return;
      if (telemetry.requestId && telemetry.requestId !== requestId) return;
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
        ...(telemetry.sensitivityRejectedCount !== undefined
          ? { sensitivityRejectedCount: telemetry.sensitivityRejectedCount }
          : {}),
        ...(telemetry.policyRejectedCount !== undefined ? { policyRejectedCount: telemetry.policyRejectedCount } : {}),
        ...(telemetry.policyRejectedReasonTags
          ? { policyRejectedReasonTags: { ...telemetry.policyRejectedReasonTags } }
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

    await this.eventBus.emit('agent.turn.start', {
      message,
      ...this.withCorrelationPurpose(turnCorrelationBase, 'agent.turn.start'),
    });

    const trustStageStart = Date.now();
    const authorContext = this.resolveAuthorContext(message);
    this.emitTurnStage(message, startTime, turnId, requestId, 'trust', turnCallType, {
      durationMs: Date.now() - trustStageStart,
      trustLevel: authorContext.trustLevel,
      canonicalContactKey: authorContext.canonicalContactKey ?? null,
    });

    this.emotionSelfModelRuntime.assertSelfModelRuntimeConfigured();

    // Record user message in session (JSONL append = L0 archival)
    const userSessionEntryId = this.recordUserMessage(
      message,
      turnId,
      requestId,
      authorContext.trustLevel,
      authorContext.canonicalContactKey,
    );
    const emotionSessionId = this.resolveSessionChannelId(message.channelId);

    try {
      const emotionSnapshot = await this.emotionSelfModelRuntime.observeEmotionState(
        message.content,
        emotionSessionId,
      );
      const emotionAppraisalChain = this.emotionSelfModelRuntime.getEmotionAppraisalChain(emotionSessionId);
      const trustLevel = authorContext.trustLevel;
      const channelType = this.resolveChannelType(message);
      const memoryProvider = this.memoryProvider as ProactiveMemoryProvider | null;
      this.ensureModel(message);
      const promptSnapshot = this.captureTurnPromptSnapshot({ channelType, taskKind });
      const sessionContextSnapshot = typeof (this.sessionManager as SessionManager & {
        captureTurnContextSnapshot?: SessionManager['captureTurnContextSnapshot'];
      }).captureTurnContextSnapshot === 'function'
        ? this.sessionManager.captureTurnContextSnapshot(
          message.channelId,
          authorContext.canonicalContactKey ?? message.authorId,
          channelMeta,
          authorContext.continuityFallbackKeys,
          turnBudgetCharacteristics,
        )
        : undefined;
      const memorySnapshot = memoryProvider && typeof memoryProvider.captureTurnMemorySnapshot === 'function'
        ? await memoryProvider.captureTurnMemorySnapshot(
          message.content,
          message.channelId,
          trustLevel,
          channelMeta,
          authorContext.canonicalContactKey,
          turnBudgetCharacteristics,
        )
        : undefined;
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

      // Retrieve relevant memories (empty string if no memory provider)
      const memoryStageStart = Date.now();
      const { memoriesBlock, proactiveRecallBlock } = await runWithRequestContext(
        this.withCorrelationPurpose(turnCorrelationBase, 'agent.turn.memory'),
        async () => {
          const memoriesBlock = memoryProvider
            ? memorySnapshot
              ? await memoryProvider.retrieve(
                message.content,
                message.channelId,
                trustLevel,
                channelMeta,
                authorContext.canonicalContactKey,
                memorySnapshot,
                turnBudgetCharacteristics,
              )
              : await memoryProvider.retrieve(
                message.content,
                message.channelId,
                trustLevel,
                channelMeta,
                authorContext.canonicalContactKey,
                undefined,
                turnBudgetCharacteristics,
              )
            : '';
          let proactiveRecallBlock = '';
          if (memoryProvider && typeof memoryProvider.retrieveProactiveRecall === 'function') {
            try {
              proactiveRecallBlock = memorySnapshot
                ? await memoryProvider.retrieveProactiveRecall(
                  message.channelId,
                  trustLevel,
                  channelMeta,
                  authorContext.canonicalContactKey,
                  memorySnapshot,
                  turnBudgetCharacteristics,
                )
                : await memoryProvider.retrieveProactiveRecall(
                  message.channelId,
                  trustLevel,
                  channelMeta,
                  authorContext.canonicalContactKey,
                  undefined,
                  turnBudgetCharacteristics,
                );
            } catch (error) {
              log.debug('Proactive recall skipped due to provider error', {
                channelId: message.channelId,
                error: toErrorMessage(error),
              });
            }
          }
          return { memoriesBlock, proactiveRecallBlock };
        },
      );
      const memoryContextBlock = [memoriesBlock, proactiveRecallBlock]
        .map(section => section.trim())
        .filter(section => section.length > 0)
        .join('\n\n');
      const scratchpadBlock = this.buildScratchpadContextBlock();
      this.emitTurnStage(message, startTime, turnId, requestId, 'memory', turnCallType, {
        durationMs: Date.now() - memoryStageStart,
        hasMemoryProvider: memoryProvider != null,
        memoryChars: memoryContextBlock.length,
        proactiveRecallChars: proactiveRecallBlock.length,
        proactiveRecallIncluded: proactiveRecallBlock.length > 0,
        scratchpadChars: scratchpadBlock.length,
        scratchpadIncluded: scratchpadBlock.length > 0,
      });

      // Compose prompt context (default system prompt pipeline or per-turn override).
      const runtimeNow = new Date();
      const promptOverride = this.normalizeTurnPromptOverride(message);
      const responseStyle = this.resolveResponseStyle(message, channelType, channelMeta);
      const templateVariables = this.buildPromptTemplateVariables(
        message,
        authorContext.resolvedUserName,
        trustLevel,
        channelType,
        authorContext.canonicalContactKey,
        runtimeNow,
      );
      const preTurnInternalState = this.emotionSelfModelRuntime.computeInternalStateForTurn({
        message,
        responseText: '',
        trustLevel,
        canonicalContactKey: authorContext.canonicalContactKey,
        emotionSnapshot,
        toolCallCount: 0,
        sessionChannelId: emotionSessionId,
      });
      const preTurnInternalStateSnapshotRef = buildInternalStateSnapshotRef(preTurnInternalState);
      const preTurnMetacognitiveFlags = this.emotionSelfModelRuntime.computeMetacognitiveFlagsForTurn({
        internalState: preTurnInternalState,
        responseText: '',
        toolCallCount: 0,
        sessionChannelId: emotionSessionId,
        retrievalProvenanceRefs,
      });
      this.currentInternalState = preTurnInternalState;
      this.currentInternalStateSnapshotRef = preTurnInternalStateSnapshotRef;
      this.currentMetacognitiveFlags = preTurnMetacognitiveFlags;
      const runtimeContext = this.buildRuntimeContext(
        message,
        authorContext.resolvedUserName,
        trustLevel,
        channelType,
        authorContext.canonicalContactKey,
        responseStyle,
        runtimeNow,
        taskKind,
        templateVariables,
        preTurnInternalState,
        preTurnMetacognitiveFlags,
        emotionAppraisalChain,
      );
      let fullPrompt = '';

      if (promptOverride.mode === 'default') {
        const staticCacheKey = this.buildPromptPrefixCacheKey(
          message,
          channelType,
          authorContext.canonicalContactKey,
        );
        const staticSettingsHash = this.buildStaticPromptSettingsHash(templateVariables);
        const staticPrefix = this.resolveStaticPromptPrefix({
          cacheKey: staticCacheKey,
          staticPrefixTemplate: turnSnapshot.prompt?.staticPrefixTemplate ?? this.systemPrompt,
          staticHash: turnSnapshot.prompt?.staticHash ?? this.hashPromptText(this.systemPrompt),
          settingsHash: staticSettingsHash,
          now: runtimeNow,
          variables: templateVariables,
        });
        const personaHint = this.getPersonaAdaptation(
          trustLevel,
          preTurnInternalState,
          preTurnMetacognitiveFlags,
          templateVariables,
        );
        const dynamicSuffixTemplate = [turnSnapshot.prompt?.dynamicSuffixTemplate ?? '', personaHint]
          .map(section => section?.trim() ?? '')
          .filter(section => section.length > 0)
          .join('\n\n');
        const dynamicSuffix = injectPromptRuntimeTokens(dynamicSuffixTemplate, {
          now: runtimeNow,
          variables: templateVariables,
        });
        fullPrompt = [staticPrefix, dynamicSuffix, runtimeContext, scratchpadBlock]
          .map(section => section.trim())
          .filter(section => section.length > 0)
          .join('\n\n');
      } else {
        const customPrompt = promptOverride.mode === 'custom'
          ? (promptOverride.systemPrompt ?? '')
          : '';
        fullPrompt = [customPrompt, runtimeContext, scratchpadBlock]
          .map(section => section.trim())
          .filter(section => section.length > 0)
          .join('\n\n');
      }

      // Build context (with auto-compaction + cross-channel continuity)
      const contextStageStart = Date.now();
      const context = await runWithRequestContext(
        this.withCorrelationPurpose(turnCorrelationBase, 'agent.turn.context'),
        async () => this.sessionManager.buildContext(
          message.channelId,
          fullPrompt,
          memoryContextBlock,
          this.llmClient,
          authorContext.canonicalContactKey ?? message.authorId,
          channelMeta,
          authorContext.continuityFallbackKeys,
          turnSnapshot.sessionContext,
          memoryManifestSeed,
          turnBudgetCharacteristics,
        ),
      );
      this.emitTurnStage(message, startTime, turnId, requestId, 'context', turnCallType, {
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

      const moaSettings = resolveMoaSettings(this.config, log);
      if (moaSettings) {
        const moaResult = await runMoaTurn({
          llmClient: this.llmClient,
          context,
          message,
          settings: moaSettings,
          turnId,
          requestId,
          callType: turnCallType,
          contextWindow: this.resolveContextWindow(),
          emitTelemetry: (eventName, payload) => this.emitTelemetry(eventName, payload),
        });
        firstTokenAt = Date.now();
        this.emitTurnStage(message, startTime, turnId, requestId, 'first-token', turnCallType, {
          ttftMs: firstTokenAt - startTime,
          source: 'fallback',
        });
        this.emitTurnStage(message, startTime, turnId, requestId, 'prompt', turnCallType, {
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
        // Configure pi-agent-core Agent for this turn
        this.agent.setSystemPrompt(enforceUntrustedCompactionGuard(context.systemPrompt));
        const autoloadOutcome = this.preloadExtendedToolsForTurn(message, taskKind, turnCorrelationBase);
        turnIntent = autoloadOutcome.intent;
        this.applyActiveToolsToAgentForTurn(
          message,
          taskKind,
          turnCallType,
          turnCorrelationBase,
          autoloadOutcome,
        );

        // Convert ContextMessage[] to AgentMessage[] for the Agent.
        // Exclude the last message (the user message we just recorded) —
        // agent.prompt() will re-add it, avoiding duplication.
        const agentMessages: AgentMessage[] = contextMessagesToPiMessages(context.messages);
        const historyMessages = agentMessages.length > 0 ? agentMessages.slice(0, -1) : [];
        this.agent.replaceMessages(historyMessages);
        const turnStartMessageIndex = this.agent.state.messages.length;

        let streamFirstTokenAt: number | null = null;
        const streamTelemetryBus = this.eventBus as unknown as {
          on: (event: string, handler: (data: { channelId: string; text: string }) => void) => () => void;
        };
        const unsubscribeFirstToken = streamTelemetryBus.on('agent.stream.delta', ({ channelId }) => {
          if (channelId !== message.channelId || streamFirstTokenAt != null) return;
          streamFirstTokenAt = Date.now();
          this.emitTurnStage(message, startTime, turnId, requestId, 'first-token', turnCallType, {
            ttftMs: streamFirstTokenAt - startTime,
            source: 'stream',
          });
        });

        // Activate event bridge for this channel (streams deltas + tool events to EventBus)
        const bridgeToken = this.bridge.setChannel(message.channelId, {
          turnId,
          requestId,
          callType: turnCallType,
          originType: turnCallType,
          originStage: 'agent.turn.prompt',
          purpose: 'agent.turn.prompt',
        });
        this.activeTurnCorrelation = turnCorrelationBase;
        this.activeTurnTaskKind = taskKind ?? null;
        this.activeTurnIntent = autoloadOutcome.intent;
        const turnUserContent = await buildTurnUserContent({
          message,
          llmClient: this.llmClient,
          runtimeMode: this.runtimeMode,
          logger: log,
        });
        try {
          // Run the agent — pi-agent-core handles tool loop internally
          await runWithRequestContext(
            this.withCorrelationPurpose(turnCorrelationBase, 'agent.turn.prompt'),
            async () => this.agent.prompt({
              role: 'user',
              content: turnUserContent,
              timestamp: Date.now(),
            } satisfies UserMessage),
          );
        } finally {
          unsubscribeFirstToken();
          this.bridge.clearChannel(bridgeToken);
          this.activeTurnCorrelation = null;
          this.activeTurnTaskKind = null;
          this.activeTurnIntent = null;
        }
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- closure mutation invisible to narrowing
        if (streamFirstTokenAt == null) {
          streamFirstTokenAt = Date.now();
          this.emitTurnStage(message, startTime, turnId, requestId, 'first-token', turnCallType, {
            ttftMs: streamFirstTokenAt - startTime,
            source: 'fallback',
          });
        }
        this.emitTurnStage(message, startTime, turnId, requestId, 'prompt', turnCallType, {
          durationMs: Date.now() - promptStageStart,
          ttftMs: streamFirstTokenAt - startTime,
        });

        turnMessages = this.agent.state.messages.slice(turnStartMessageIndex);
        turnUsage = this.accumulateTurnUsage(turnMessages);
        responseModel = this.agent.state.model.id;
        firstTokenAt = streamFirstTokenAt;

        // Extract response from agent state (last assistant message)
        responseText = this.extractResponseText();
        if (hasVisionAttachments(message) && responseText.trim().length === 0) {
          const assistantMessage = this.getLatestAssistantMessage();
          log.warn('Vision turn produced empty assistant text; attempting non-fabricating recovery replay', {
            channelId: message.channelId,
            model: this.agent.state.model.id,
            stopReason: assistantMessage?.stopReason ?? null,
            errorMessage: assistantMessage?.errorMessage ?? null,
          });

          // Recovery falls back to the chat slot, but replays transport-normalized
          // user content instead of injecting synthetic assistant/user wording.
          try {
            const recoveryModel = resolveModel(this.config, 'chat');
            this.agent.setModel(recoveryModel);
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
            const bridgeToken = this.bridge.setChannel(message.channelId, {
              turnId,
              requestId: `${requestId}:${requestSuffix}`,
              callType: turnCallType,
              originType: turnCallType,
              originStage,
              purpose: originStage,
            });
            this.activeTurnCorrelation = turnCorrelationBase;
            try {
              await runWithRequestContext(
                this.withCorrelationPurpose(turnCorrelationBase, originStage),
                async () => this.agent.prompt({
                  role: 'user',
                  content,
                  timestamp: Date.now(),
                } satisfies UserMessage),
              );
            } finally {
              this.bridge.clearChannel(bridgeToken);
              this.activeTurnCorrelation = null;
            }
          };

          if (replayTransportContent.length > 0) {
            await runVisionRecoveryPrompt(
              replayTransportContent,
              'vision-recovery',
              'agent.turn.vision_recovery',
            );
            recoveryAttempts += 1;

            turnMessages = this.agent.state.messages.slice(turnStartMessageIndex);
            turnUsage = this.accumulateTurnUsage(turnMessages);
            responseModel = this.agent.state.model.id;
            responseText = this.extractResponseText();

            if (responseText.trim().length === 0) {
              log.warn('Vision recovery replay remained empty; retrying once with same transport content', {
                channelId: message.channelId,
                model: this.agent.state.model.id,
              });
              await runVisionRecoveryPrompt(
                replayTransportContent,
                'vision-recovery-retry',
                'agent.turn.vision_recovery_retry',
              );
              recoveryAttempts += 1;

              turnMessages = this.agent.state.messages.slice(turnStartMessageIndex);
              turnUsage = this.accumulateTurnUsage(turnMessages);
              responseModel = this.agent.state.model.id;
              responseText = this.extractResponseText();
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
          this.emitTelemetry('agent.turn.fallback', {
            channelId: message.channelId,
            channelType: message.channelType,
            ...fallbackDiagnostics.fallback,
            ...this.withCorrelationPurpose(turnCorrelationBase, 'agent.turn.fallback'),
          });

          if (finalContentEmpty) {
            log.warn('Vision turn remained empty after non-fabricating recovery replay', {
              channelId: message.channelId,
              model: this.agent.state.model.id,
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

        this.emitTelemetry('broadcast.pre_send.classified', {
          channelId: message.channelId,
          risky: classification.risky,
          signals: classification.signals,
          visibilityScope,
          ...this.withCorrelationPurpose(turnCorrelationBase, 'broadcast.pre_send.classified'),
        });

        if (approvalRequired) {
          this.emitTelemetry('broadcast.approval.required', {
            channelId: message.channelId,
            signals: classification.signals,
            visibilityScope,
            draftLength: responseText.length,
            ...this.withCorrelationPurpose(turnCorrelationBase, 'broadcast.approval.required'),
          });
          this.sessionManager.appendSystemNote(
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
          ...this.withCorrelationPurpose(turnCorrelationBase, 'broadcast.provenance'),
        };
        this.emitTelemetry('broadcast.provenance', provenancePayload);
        log.info('Broadcast provenance', provenancePayload);
      }

      const internalState = this.emotionSelfModelRuntime.computeInternalStateForTurn({
        message,
        responseText,
        trustLevel: authorContext.trustLevel,
        canonicalContactKey: authorContext.canonicalContactKey,
        emotionSnapshot,
        toolCallCount: turnUsage.toolCalls,
        sessionChannelId: emotionSessionId,
      });
      this.currentInternalState = internalState;
      const internalStateSnapshotRef = buildInternalStateSnapshotRef(internalState);
      this.currentInternalStateSnapshotRef = internalStateSnapshotRef;
      const metacognitiveFlags = this.emotionSelfModelRuntime.computeMetacognitiveFlagsForTurn({
        internalState,
        responseText,
        toolCallCount: turnUsage.toolCalls,
        sessionChannelId: emotionSessionId,
        retrievalProvenanceRefs,
      });
      this.currentMetacognitiveFlags = metacognitiveFlags;

      this.recordToolObservations(
        message,
        turnId,
        requestId,
        turnMessages,
        authorContext.trustLevel,
      );

      // Record assistant message (JSONL append = L0 archival)
      if (!broadcastSafetyMeta?.approvalRequired) {
        assistantSessionEntryId = this.recordAssistantMessage(
          message,
          turnId,
          requestId,
          safeResponseText,
          authorContext.trustLevel,
          authorContext.canonicalContactKey,
          emotionSnapshot,
        );
      }

      // Self-reflection nudge: after complex multi-tool turns, suggest saving as a skill
      if (this.skillsRuntime) {
        const toolSummary = this.buildTurnToolSummary(turnMessages);
        const nudge = this.reflectionNudge.evaluate(toolSummary);
        if (nudge) {
          this.sessionManager.appendSystemNote(message.channelId, nudge);
        }
      }

      const completedAt = Date.now();
      const agentResponse: AgentResponse = {
        content: safeResponseText,
        channelId: message.channelId,
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
      const inferredPostTurnActions = await this.inferPostTurnActions({
        message,
        response: agentResponse,
        turnMessages,
        turnId,
        completedAt,
        contextManifest: context.manifest,
        ...(authorContext.canonicalContactKey ? { canonicalContactKey: authorContext.canonicalContactKey } : {}),
      });
      this.sessionManager.recordTurn(
        this.buildTurnRecord({
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
          internalStateSnapshotRef,
        }),
      );

      await this.eventBus.emit('agent.turn.end', {
        message,
        response: agentResponse,
        ...this.withCorrelationPurpose(turnCorrelationBase, 'agent.turn.end'),
      });
      if (inferredPostTurnActions.length > 0) {
        await this.eventBus.emit('agent.post_turn.actions.inferred', {
          message,
          response: agentResponse,
          actions: inferredPostTurnActions,
          ...this.withCorrelationPurpose(turnCorrelationBase, 'agent.post_turn.actions.inferred'),
        });
      }
      if (deferredContinuationId && turnCallType === 'background') {
        const completionSignal = this.queueBackgroundContinuationCompletion(
          deferredContinuationId,
          message,
          agentResponse,
          taskKind ?? null,
          turnIntent,
        );
        await this.emitBackgroundContinuationEvent(
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
            ...this.withCorrelationPurpose(turnCorrelationBase, 'agent.background.continuation.completed'),
          },
        );
      } else if (turnCallType === 'chat') {
        const postTurnDeliveries = this.dequeueBackgroundContinuationDeliveries(
          this.resolveSessionChannelId(message.channelId),
        );
        if (postTurnDeliveries.length > 0) {
          await this.emitBackgroundContinuationEvent(
            'agent.background.continuation.post_turn_delivery',
            {
              channelId: message.channelId,
              deliverySessionId: this.resolveSessionChannelId(message.channelId),
              deliveries: postTurnDeliveries,
              ...this.withCorrelationPurpose(turnCorrelationBase, 'agent.background.continuation.post_turn_delivery'),
            },
          );
        }
      }
      await this.eventBus.emit('agent.turn.usage', {
        message,
        usage: turnUsage,
        ...this.withCorrelationPurpose(turnCorrelationBase, 'agent.turn.usage'),
      });
      this.emitTurnStage(message, startTime, turnId, requestId, 'end', turnCallType, {
        durationMs: completedAt - startTime,
        ttftMs: firstTokenAt - startTime,
        inputTokens: turnUsage.inputTokens,
        outputTokens: turnUsage.outputTokens,
      });

      // Trigger memory extraction (fire-and-forget)
      this.memoryExtractor?.maybeExtract(
        message.channelId,
        authorContext.canonicalContactKey,
        turnId,
      ).catch(err => {
        log.error('Memory extraction error', { error: String(err) });
      });

      void this.runIntentionPostTurnHooks({
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

      void this.emotionSelfModelRuntime.triggerEmotionAppraisal({
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

      return agentResponse;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      await this.eventBus.emit('agent.error', {
        message,
        error: err,
        ...this.withCorrelationPurpose(turnCorrelationBase, 'agent.error'),
      });
      throw err;
    } finally {
      unsubscribeRetrieval();
      restorePinnedSessionContext();
    }
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
