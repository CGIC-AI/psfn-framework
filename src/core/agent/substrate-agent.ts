// ── SubstrateAgent ──
// Wraps pi-agent-core's Agent class, replacing the manual streamWithToolLoop
// from the legacy in-house loop implementation. pi-agent-core handles tool
// calling/execution/looping
// internally — we just configure it and subscribe to events for streaming.
//
// Provider interfaces (LLMProviderPort, EmbeddingProviderPort, MemoryProvider,
// MemoryExtractor) are re-exported here for callers that import contracts
// from the SubstrateAgent module.

import { Agent } from '@mariozechner/pi-agent-core';
import type { AgentTool, StreamFn } from '@mariozechner/pi-agent-core';
import type { UserMessage } from '@mariozechner/pi-ai';
import type { EventBus } from '../../shared/event-bus.js';
import { createEventBusCostTelemetryPort } from '../../shared/telemetry/cost-telemetry-port.js';
import { getRunChargeContext, runWithChargeContext } from '../../shared/telemetry/run-charge.js';
import type { SessionManager } from '../session/manager.js';
import { formatAttributedSystemContent } from '../session/entry-attribution.js';
import {
  INTENTION_FOLLOW_UP_AUTHOR_ID,
  INTENTION_FOLLOW_UP_AUTHOR_NAME,
} from '../intention/appraisal.js';
import type { AgentResponse, CorrelationMetadata, ModelBudgetBlockedEvent, MessagePromptOverride, ResponseStyle, SubstrateMessage } from '../../shared/contracts/runtime.js';
import type { CapabilityTier, CoreSubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { ContactStorePort } from '../contacts/contact-store-port.js';
import type { ImageVisionReviewer } from '../../primitives/images/types.js';
import type { LLMProviderPort, MemoryProvider, MemoryExtractor, ScratchpadProvider } from './contracts.js';
import type { TrustLevel } from '../../system/trust/types.js';
import {
  resolveChannelResponseStyle,
  type ChannelMeta,
} from '../../system/trust/policy.js';
import type { ChannelPromptRegistryPort } from '../../channels/backplane/registry-port.js';
import {
  type PromptComposer,
} from '../identity/prompt-composer.js';
import {
  resolveCachedPromptRuntimeLayoutStore,
} from '../identity/prompt-runtime-store-cache.js';
import type { ComposeContext } from '../identity/prompt-types.js';
import { resolveCompanionIdFromConfig } from '../identity/companion-runtime.js';
import {
  createSubstrateStreamFn,
  type SubstrateStreamTransport,
  type SubstrateStreamRuntimeOptions,
} from './stream-adapter.js';
import { createActiveEmanationSatellitePresencePort } from './satellite-adapter-port.js';
import { installAgentToolSchedulerPatch } from './agent-loop-patch.js';
import { convertToLlm, type InternalWhisperMessage } from './messages.js';
import { MESSAGE_CLASSES } from './message-classes.js';
import { createEventBridge, type EventBridge } from './event-bridge.js';
import { createComponentLogger } from '../../shared/logger.js';
import type { SkillsRuntime } from '../../faculties/skills/runtime.js';
import { ReflectionNudgeTracker } from '../../faculties/skills/reflection-nudge.js';
import type { ToolCategory } from './tool-registrar.js';
import {
  gateToolWithCapabilities,
  type CapabilityAccess,
} from '../../system/capabilities/gate.js';
import { CapabilityRuntime } from '../../system/capabilities/runtime.js';
import { normalizeCapabilityTier, resolveTierCapabilityTokens } from '../../system/capabilities/tiers.js';
import type { CapabilityToken } from '../../system/capabilities/tokens.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import {
  type GatewayToolMetadataCoverage,
  type RuntimeMode,
} from './tool-wiring-validator.js';
import {
  type ExtendedToolAutoloadPolicy,
} from './extended-tool-autoload-policy.js';
import type {
  AdaptiveToolRuntimeState,
} from './adaptive-tools-telemetry.js';
import type { RuntimeToolCatalogSnapshot } from './tool-catalog.js';
import { createTurnId } from '../turns/id.js';
import type { TurnPromptSnapshot } from '../turns/snapshot.js';
import { EmotionState } from '../emotion/state.js';
import type { EmotionObserver } from '../emotion/observer.js';
import { EmotionAppraisal, type EmotionAppraisalEntry } from '../emotion/appraisal.js';
import type { ActiveConcernContextProvider } from '../intention/concern-store-port.js';
import type { PendingFollowUpContextProvider } from '../intention/pending-follow-ups.js';
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
  type InternalStateContinuityGap,
  type InternalStateStorePort,
  type PersistedInternalStateRecord,
} from '../self-model/internal-state-persistence.js';
import {
  buildPromptPrefixCacheKey as buildPromptPrefixCacheKeyForTurn,
  buildStaticPromptSettingsHash as buildStaticPromptSettingsHashForTurn,
  captureTurnPromptSnapshot as captureTurnPromptSnapshotForTurn,
  hashPromptText as hashPromptTextForTurn,
  resolveStaticPromptPrefix as resolveStaticPromptPrefixForTurn,
  type FrozenPromptPrefix,
} from './substrate-agent/prompt-lifecycle.js';
import {
  type IntentionPostTurnHook,
  type PostTurnActionInferer,
} from './substrate-agent/post-turn-actions.js';
import {
  buildActiveConcernsContextBlock as buildActiveConcernsContextBlockForTurn,
  buildBehavioralNotesContextBlock as buildBehavioralNotesContextBlockForTurn,
  buildDynamicPromptTemplateVariables as buildDynamicPromptTemplateVariablesForTurn,
  buildPromptTemplateVariables as buildPromptTemplateVariablesForTurn,
  buildRuntimeContext as buildRuntimeContextForTurn,
  buildScratchpadContextBlock as buildScratchpadContextBlockForTurn,
  getPersonaAdaptation as getPersonaAdaptationForTurn,
  resolveContinuitySubjectKey,
  resolveAuthorContext as resolveAuthorContextForTurn,
  type ResolvedAuthorContext,
} from './substrate-agent/runtime-context.js';
import {
  type ExtendedToolActivationOptions,
  type ExtendedToolActivationResult,
} from './substrate-agent/adaptive-tools-runtime.js';
import { EmotionSelfModelRuntime } from './substrate-agent/emotion-self-model-runtime.js';
import {
  type BackgroundContinuationTaskRecord,
} from './substrate-agent/background-continuation-runtime.js';
import {
  handleMessageForTurn,
} from './substrate-agent/turn-execution-runtime.js';
import { createTurnExecutionRuntimeAdapter } from './substrate-agent/turn-execution-adapter.js';
import {
  refreshModelFromConfig as refreshModelFromConfigForRuntime,
} from './substrate-agent/model-runtime.js';
import {
  buildTurnBudgetCharacteristics as buildTurnBudgetCharacteristicsForRuntime,
  resolveChannelType as resolveChannelTypeForRuntime,
  resolveTaskKind as resolveTaskKindForRuntime,
} from './substrate-agent/channel-routing-runtime.js';
import {
  deriveCharacterName as deriveCharacterNameForRuntime,
  extractResponseText as extractResponseTextForRuntime,
  getLatestAssistantMessage as getLatestAssistantMessageForRuntime,
  resolveContextWindow as resolveContextWindowForRuntime,
} from './substrate-agent/agent-state-runtime.js';
import {
  ToolRuntimeFacade,
  type PromotedToolMutationResult,
} from './substrate-agent/tool-runtime-facade.js';
import { TurnSupportRuntime } from './substrate-agent/turn-support-runtime.js';
import type { ObserverEvalSidecarRuntime } from '../eval/observer-sidecar/types.js';

const log = createComponentLogger('SubstrateAgent');

function resolveRuntimePromptGuidanceVariables(config: SubstrateConfig): Record<string, string> {
  const store = resolveCachedPromptRuntimeLayoutStore(config);
  return {
    runtime_persona_adaptation_extra: store.getEditableBlockContent('runtime.persona_adaptation'),
    runtime_context_extra: store.getEditableBlockContent('runtime.context'),
  };
}

function resolveConfiguredCharacterName(config: CoreSubstrateConfig): string | undefined {
  const candidate = typeof config.characterName === 'string'
    ? config.characterName.trim()
    : '';
  return candidate || undefined;
}

export type {
  LLMProviderPort,
  EmbeddingProviderPort,
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
} from './substrate-agent/tool-runtime-facade.js';

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
  streamRuntimeOptions?: Omit<SubstrateStreamRuntimeOptions, 'onBudgetBlocked'>;
  characterName?: string;
  characterPromptVariables?: Record<string, string>;
  characterPromptVariablesProvider?: () => Record<string, string>;
  runtimeMode?: RuntimeMode;
  emotionRuntime?: EmotionRuntimeWiring;
  selfModelRuntime?: SelfModelRuntimeWiring;
  observerEvalSidecar?: ObserverEvalSidecarRuntime;
  streamTransport?: SubstrateStreamTransport;
}
const DEFAULT_TOOL_SCHEDULER_MAX_PARALLEL = 5;

// ── SubstrateAgent ──

export class SubstrateAgent {
  private agent: Agent;
  private eventBus: EventBus;
  private llmClient: LLMProviderPort;
  private sessionManager: SessionManager;
  private systemPrompt: string;
  private characterName: string;
  private resolveCharacterPromptVariables: () => Record<string, string>;
  private config: CoreSubstrateConfig;
  private modelResolved = false;
  private modelSignature: string | null = null;
  private bridge: EventBridge;
  private channelRegistry: ChannelPromptRegistryPort = new Map();
  private capabilityRuntime: CapabilityRuntime | null = null;
  private gatedToolCache = new WeakMap<AgentTool<any>, AgentTool<any>>();
  private frozenPromptPrefixCache = new Map<string, FrozenPromptPrefix>();
  private reflectionNudge = new ReflectionNudgeTracker();
  private readonly turnSupportRuntime: TurnSupportRuntime;
  private readonly toolRuntimeFacade: ToolRuntimeFacade;
  private readonly satellitePresencePort = createActiveEmanationSatellitePresencePort();
  private selfModelRuntimeRequired = false;
  private readonly emotionSelfModelRuntime: EmotionSelfModelRuntime;
  private currentInternalState: InternalState | null = null;
  private currentInternalStateSnapshotRef: string | null = null;
  private currentMetacognitiveFlags: MetacognitiveFlag[] = [];
  private internalStateStore: InternalStateStorePort | null = null;
  private internalStateContinuityGap: InternalStateContinuityGap | null = null;
  private internalStateContinuityGapRenderCount = 0;
  private runtimeMode: RuntimeMode;

  private get activeTurnCorrelation(): CorrelationMetadata | null {
    return this.turnSupportRuntime.getActiveTurnCorrelation();
  }

  private set activeTurnCorrelation(correlation: CorrelationMetadata | null) {
    this.turnSupportRuntime.setActiveTurnCorrelation(correlation);
  }

  private get activeTurnTaskKind(): string | null {
    return this.turnSupportRuntime.getActiveTurnTaskKind();
  }

  private set activeTurnTaskKind(taskKind: string | null) {
    this.turnSupportRuntime.setActiveTurnTaskKind(taskKind);
  }

  private get activeTurnIntent(): string | null {
    return this.turnSupportRuntime.getActiveTurnIntent();
  }

  private set activeTurnIntent(intent: string | null) {
    this.turnSupportRuntime.setActiveTurnIntent(intent);
  }

  // Pluggable memory — null until memory system is wired
  memoryProvider: MemoryProvider | null = null;
  memoryExtractor: MemoryExtractor | null = null;
  scratchpadProvider: ScratchpadProvider | null = null;
  activeConcernProvider: ActiveConcernContextProvider | null = null;
  pendingFollowUpProvider: PendingFollowUpContextProvider | null = null;
  behavioralPatternProvider: BehavioralPatternContextProvider | null = null;

  // Trust resolution — null until contacts are wired
  contactStore: ContactStorePort | null = null;

  // Prompt composition — null falls back to static systemPrompt
  promptComposer: PromptComposer | null = null;

  // SKILL.md runtime — null until skills system is wired
  skillsRuntime: SkillsRuntime | null = null;
  imageVisionReviewer: ImageVisionReviewer | null = null;
  observerEvalSidecar: ObserverEvalSidecarRuntime | null = null;

  constructor(
    eventBus: EventBus,
    llmClient: LLMProviderPort,
    sessionManager: SessionManager,
    systemPrompt: string,
    config: CoreSubstrateConfig,
    options?: SubstrateAgentOptions,
  ) {
    this.eventBus = eventBus;
    this.llmClient = llmClient;
    this.sessionManager = sessionManager;
    this.systemPrompt = systemPrompt;
    this.characterName = options?.characterName?.trim()
      || resolveConfiguredCharacterName(config)
      || deriveCharacterNameForRuntime(systemPrompt);
    const fallbackPromptVariables = { ...(options?.characterPromptVariables ?? {}) };
    this.resolveCharacterPromptVariables = options?.characterPromptVariablesProvider
      ?? (() => fallbackPromptVariables);
    this.config = config;
    this.runtimeMode = options?.runtimeMode ?? 'gateway';
    this.selfModelRuntimeRequired = options?.selfModelRuntime?.requireWiring ?? false;
    this.observerEvalSidecar = options?.observerEvalSidecar ?? null;
    this.emotionSelfModelRuntime = new EmotionSelfModelRuntime({
      sessionManager: this.sessionManager,
      llmProvider: this.llmClient,
      emotionRuntime: options?.emotionRuntime,
      getActiveConcernProvider: () => this.activeConcernProvider,
      getPendingFollowUpProvider: () => this.pendingFollowUpProvider,
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
    const defaultStreamTransport = options?.streamTransport ?? {
      stream: this.llmClient.stream.bind(this.llmClient),
    };

    this.agent = new Agent({
      streamFn: options?.streamFn ?? createSubstrateStreamFn(config, {
        ...(options?.streamRuntimeOptions ?? {}),
        transport: defaultStreamTransport,
        onBudgetBlocked: emitBudgetBlocked,
      }),
      convertToLlm,
    });
    this.turnSupportRuntime = new TurnSupportRuntime({
      eventBus: this.eventBus,
      sessionManager: this.sessionManager,
      hashPromptText: (text) => this.hashPromptText(text),
      resolveContextWindow: () => resolveContextWindowForRuntime(
        this.config,
        this.agent.state.model as { contextWindow?: unknown } | undefined,
      ),
    });
    this.toolRuntimeFacade = new ToolRuntimeFacade({
      config: this.config,
      agent: this.agent,
      resolveCapabilityAccess: () => this.resolveCapabilityAccess(),
      withCapabilityGates: (tools) => this.withCapabilityGates(tools),
      withCorrelationPurpose: (correlation, purpose) => this.turnSupportRuntime.withCorrelationPurpose(correlation, purpose),
      withAdaptiveCorrelation: (correlation, purpose) => this.turnSupportRuntime.withAdaptiveCorrelation(correlation, purpose),
      emitAdaptiveToolDecision: (payload) => this.turnSupportRuntime.emitAdaptiveToolDecision(payload),
      emitTelemetry: (event, payload) => this.turnSupportRuntime.emitTelemetry(event, payload),
      resolveSessionChannelId: (channelId) => this.turnSupportRuntime.resolveSessionChannelId(channelId),
      getActiveTurnCorrelation: () => this.turnSupportRuntime.getActiveTurnCorrelation(),
      getActiveTurnTaskKind: () => this.turnSupportRuntime.getActiveTurnTaskKind(),
      getActiveTurnIntent: () => this.turnSupportRuntime.getActiveTurnIntent(),
    });
    installAgentToolSchedulerPatch(this.agent, {
      maxParallelToolCalls: DEFAULT_TOOL_SCHEDULER_MAX_PARALLEL,
      onTelemetry: (eventName, payload) => {
        this.turnSupportRuntime.emitTelemetry(eventName, {
          ...this.turnSupportRuntime.withAdaptiveCorrelation(
            this.turnSupportRuntime.getActiveTurnCorrelation() ?? undefined,
            eventName,
          ),
          timestamp: Date.now(),
          taskKind: this.turnSupportRuntime.getActiveTurnTaskKind(),
          intent: this.turnSupportRuntime.getActiveTurnIntent(),
          ...payload,
        });
      },
    });

    this.installRuntimeHooks();

    // Persistent event bridge: pi-agent-core events → EventBus
    this.bridge = createEventBridge(this.agent, eventBus);

    // Register the core discovery and non-default tool control tools.
    this.registerTool(this.toolRuntimeFacade.createToolSearchTool(), 'core');
    this.registerTool(this.toolRuntimeFacade.createToolsetTool(), 'core');

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
    this.toolRuntimeFacade.registerTool(tool, category);
  }

  private getCapabilityEligiblePromotedToolNames(): Set<string> {
    return this.toolRuntimeFacade.getCapabilityEligiblePromotedToolNames();
  }

  private classifyExtendedToolForTurn(toolName: string) {
    return this.toolRuntimeFacade.classifyExtendedToolForTurn(toolName);
  }

  getPromotedExtendedToolsLimit(): number {
    return this.toolRuntimeFacade.getPromotedExtendedToolsLimit();
  }

  getPromotedExtendedTools(): readonly string[] {
    return this.toolRuntimeFacade.getPromotedExtendedTools();
  }

  addPromotedExtendedTool(toolName: string): PromotedToolMutationResult {
    return this.toolRuntimeFacade.addPromotedExtendedTool(toolName);
  }

  removePromotedExtendedTool(toolName: string): PromotedToolMutationResult {
    return this.toolRuntimeFacade.removePromotedExtendedTool(toolName);
  }

  swapPromotedExtendedTools(fromSlot: number, toSlot: number): PromotedToolMutationResult {
    return this.toolRuntimeFacade.swapPromotedExtendedTools(fromSlot, toSlot);
  }

  getToolCatalog(): { core: readonly AgentTool<any>[]; extended: readonly AgentTool<any>[] } {
    return this.toolRuntimeFacade.getToolCatalog();
  }

  getAdaptiveToolRuntimeState(): AdaptiveToolRuntimeState {
    return this.toolRuntimeFacade.getAdaptiveToolRuntimeState();
  }

  getToolCatalogSnapshot(): RuntimeToolCatalogSnapshot {
    return this.toolRuntimeFacade.getToolCatalogSnapshot();
  }

  getBackgroundContinuationTasks(): readonly BackgroundContinuationTaskRecord[] {
    return this.turnSupportRuntime.getBackgroundContinuationTasks();
  }

  activateExtendedTools(
    toolNames: readonly string[],
    options: ExtendedToolActivationOptions = {},
  ): ExtendedToolActivationResult {
    return this.toolRuntimeFacade.activateExtendedTools(toolNames, options);
  }

  validateToolWiring(
    mode: RuntimeMode,
    gatewayClient?: object,
    requiredGatewayMetadataCoverage?: GatewayToolMetadataCoverage,
  ): void {
    this.toolRuntimeFacade.validateToolWiring(mode, gatewayClient, requiredGatewayMetadataCoverage);
  }

  setChannelRegistry(registry: ChannelPromptRegistryPort): void {
    this.channelRegistry = registry;
    this.invalidatePromptPrefixCache('channel-registry-updated');
  }

  setCapabilityRuntime(runtime: CapabilityRuntime | null): void {
    this.capabilityRuntime = runtime;
    this.gatedToolCache = new WeakMap<AgentTool<any>, AgentTool<any>>();
    this.refreshCapabilityRuntime();
  }

  setExtendedToolAutoloadPolicy(policy: ExtendedToolAutoloadPolicy | null): void {
    this.toolRuntimeFacade.setExtendedToolAutoloadPolicy(policy);
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
  async steer(message: SubstrateMessage): Promise<void> {
    if (!this.agent.state.isStreaming) return;
    const authorContext = await this.resolveAuthorContext(message);
    this.turnSupportRuntime.recordUserMessage(
      message,
      createTurnId(),
      message.id,
      authorContext.trustLevel,
      authorContext.subjectIdentityKey ?? authorContext.canonicalContactKey,
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
   *
   * Intention appraisal follow-ups are injected as internal Whisper notes to self
   * and are never persisted into the external session journal.
   */
  async followUp(message: SubstrateMessage): Promise<void> {
    if (message.authorId === INTENTION_FOLLOW_UP_AUTHOR_ID) {
      this.agent.followUp({
        role: 'custom',
        type: 'internalWhisper',
        messageClass: MESSAGE_CLASSES.internalWhisper,
        content: message.content,
        speakerName: message.authorName.trim() || INTENTION_FOLLOW_UP_AUTHOR_NAME,
        timestamp: Date.now(),
      } satisfies InternalWhisperMessage);
      log.debug('Queued follow-up', {
        channelId: message.channelId,
        internalKind: 'whisper',
      });
      return;
    }

    const isSystemOriginated = message.authorId.startsWith('system:');
    const turnId = createTurnId();
    const systemContent = isSystemOriginated
      ? formatAttributedSystemContent(message.content, message.authorName)
      : message.content;
    if (isSystemOriginated) {
      this.turnSupportRuntime.recordSystemMessage(
        message,
        turnId,
        message.id,
        systemContent,
      );
    } else {
      const authorContext = await this.resolveAuthorContext(message);
      this.turnSupportRuntime.recordUserMessage(
        message,
        turnId,
        message.id,
        authorContext.trustLevel,
        authorContext.subjectIdentityKey ?? authorContext.canonicalContactKey,
      );
    }
    this.agent.followUp(isSystemOriginated
      ? {
        role: 'custom',
        type: 'systemNote',
        messageClass: MESSAGE_CLASSES.systemNote,
        content: systemContent,
        timestamp: Date.now(),
      }
      : {
        role: 'user',
        content: systemContent,
        timestamp: Date.now(),
      } satisfies UserMessage);
    log.debug('Queued follow-up', {
      channelId: message.channelId,
      systemOriginated: isSystemOriginated,
    });
  }

  /**
   * Record a message as observed context without invoking the model or adding an
   * assistant response. Used for ambient channel traffic that should be visible
   * in later turns but must not itself trigger a reply.
   */
  async observeMessage(message: SubstrateMessage): Promise<void> {
    await this.sessionManager.awaitPendingAutoCompaction(message.channelId);

    const turnId = createTurnId();
    const requestId = message.id;
    const observationMetadata = JSON.stringify({
      type: 'observed_message',
      source: message.routing?.source ?? message.channelType,
      responseMode: message.routing?.responseMode ?? 'observe',
    });
    const recordOptions = {
      turnId,
      requestId,
      sourceMessageId: message.id,
      metadata: observationMetadata,
      channelMeta: {
        isDirectMessage: message.isDirectMessage ?? false,
      },
    };

    if (message.authorId.startsWith('system:')) {
      this.sessionManager.recordSystemMessage(
        message.channelId,
        formatAttributedSystemContent(message.content, message.authorName),
        message.authorId,
        message.authorName,
        message.isDirectMessage,
        undefined,
        recordOptions,
      );
      return;
    }

    const authorContext = await this.resolveAuthorContext(message);
    const continuitySubjectKey = resolveContinuitySubjectKey({
      canonicalContactKey: authorContext.canonicalContactKey,
      subjectIdentityKey: authorContext.subjectIdentityKey,
      authorId: message.authorId,
    });
    this.sessionManager.recordUserMessage(
      message.channelId,
      message.content,
      message.authorId,
      message.authorName,
      message.isDirectMessage,
      continuitySubjectKey,
      {
        ...recordOptions,
        trustLevel: authorContext.trustLevel,
      },
    );
    log.debug('Observed message without model turn', {
      channelId: message.channelId,
      messageId: message.id,
      authorId: message.authorId,
    });
  }

  /** Wait for the agent to finish all pending work (prompt + steering + follow-ups) */
  waitForIdle(): Promise<void> {
    return this.agent.waitForIdle();
  }

  setActiveConcernProvider(provider: ActiveConcernContextProvider | null): void {
    this.activeConcernProvider = provider;
  }

  setPendingFollowUpProvider(provider: PendingFollowUpContextProvider | null): void {
    this.pendingFollowUpProvider = provider;
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

  setInternalStateStore(store: InternalStateStorePort | null): void {
    this.internalStateStore = store;
  }

  /** Restores a validated persisted snapshot as the current running state (startup rehydration). */
  restorePersistedInternalState(record: PersistedInternalStateRecord): void {
    this.currentInternalState = cloneInternalState(record.state);
    this.currentInternalStateSnapshotRef = record.snapshotRef;
    this.currentMetacognitiveFlags = cloneMetacognitiveFlags(record.metacognitiveFlags);
    this.internalStateContinuityGap = null;
    this.internalStateContinuityGapRenderCount = 0;
  }

  /** Records that persisted state was too stale to restore; surfaced to her on the next turn. */
  noteInternalStateContinuityGap(gap: InternalStateContinuityGap): void {
    this.internalStateContinuityGap = gap;
    this.internalStateContinuityGapRenderCount = 0;
  }

  getInternalStateContinuityGap(): InternalStateContinuityGap | null {
    return this.internalStateContinuityGap;
  }

  private persistCurrentInternalState(): void {
    if (!this.internalStateStore || !this.currentInternalState || !this.currentInternalStateSnapshotRef) {
      return;
    }
    const record: PersistedInternalStateRecord = {
      state: cloneInternalState(this.currentInternalState),
      snapshotRef: this.currentInternalStateSnapshotRef,
      metacognitiveFlags: cloneMetacognitiveFlags(this.currentMetacognitiveFlags),
      savedAt: new Date().toISOString(),
    };
    this.internalStateStore.save(record).catch((error: unknown) => {
      log.error('Failed to persist current internal state', {
        error: toErrorMessage(error),
        snapshotRef: record.snapshotRef,
      });
    });
  }

  registerPostTurnActionInferer(inferer: PostTurnActionInferer): () => void {
    return this.turnSupportRuntime.registerPostTurnActionInferer(inferer);
  }

  registerIntentionPostTurnHook(hook: IntentionPostTurnHook): () => void {
    return this.turnSupportRuntime.registerIntentionPostTurnHook(hook);
  }

  /** Abort the current prompt, cancelling streaming and tool execution */
  abort(): void {
    this.agent.abort();
  }

  async handleMessage(message: SubstrateMessage): Promise<AgentResponse> {
    const run = async (): Promise<AgentResponse> => handleMessageForTurn(createTurnExecutionRuntimeAdapter({
      eventBus: this.eventBus,
      costTelemetry: createEventBusCostTelemetryPort(this.eventBus),
      satellitePresence: this.satellitePresencePort,
      llmClient: this.llmClient,
      imageVisionReviewer: this.imageVisionReviewer,
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
      observerEvalSidecar: this.observerEvalSidecar,
      turnSupportRuntime: this.turnSupportRuntime,
      toolRuntimeFacade: this.toolRuntimeFacade,
      callbacks: {
        resolveTaskKind: (turnMessage) => resolveTaskKindForRuntime(turnMessage, this.channelRegistry),
        buildTurnBudgetCharacteristics: (turnMessage, taskKind) => buildTurnBudgetCharacteristicsForRuntime(
          turnMessage,
          taskKind,
        ),
        resolveAuthorContext: (turnMessage) => this.resolveAuthorContext(turnMessage),
        resolveChannelType: (turnMessage) => resolveChannelTypeForRuntime(turnMessage, this.channelRegistry),
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
          subjectIdentityKey,
          now,
        ) => this.buildPromptTemplateVariables(
          turnMessage,
          resolvedUserName,
          trustLevel,
          channelType,
          canonicalContactKey,
          subjectIdentityKey,
          now,
        ),
        buildDynamicPromptTemplateVariables: (
          turnMessage,
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
        ) => this.buildDynamicPromptTemplateVariables(
          turnMessage,
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
        setCurrentSelfModelState: (state, snapshotRef, metacognitiveFlags) => {
          this.currentInternalState = state;
          this.currentInternalStateSnapshotRef = snapshotRef;
          this.currentMetacognitiveFlags = cloneMetacognitiveFlags(metacognitiveFlags);
          // A continuity gap stays visible for the first turn after restart
          // (state is recomputed before the prompt renders), then clears.
          if (this.internalStateContinuityGap && this.internalStateContinuityGapRenderCount > 0) {
            this.internalStateContinuityGap = null;
          }
          this.persistCurrentInternalState();
        },
        buildRuntimeContext: (
          turnMessage,
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
        ) => this.buildRuntimeContext(
          turnMessage,
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
        buildPromptPrefixCacheKey: (
          turnMessage,
          channelType,
          canonicalContactKey,
          subjectIdentityKey,
        ) => this.buildPromptPrefixCacheKey(
          turnMessage,
          channelType,
          canonicalContactKey,
          subjectIdentityKey,
        ),
        buildStaticPromptSettingsHash: (templateVariables) => this.buildStaticPromptSettingsHash(templateVariables),
        resolveStaticPromptPrefix: (params) => this.resolveStaticPromptPrefix(params),
        hashPromptText: (text) => this.hashPromptText(text),
        getPersonaAdaptation: (
          trustLevel,
          internalState,
          metacognitiveFlags,
          templateVariables,
        ) => this.getPersonaAdaptation(
          trustLevel,
          internalState,
          metacognitiveFlags,
          templateVariables,
        ),
        resolveContextWindow: () => resolveContextWindowForRuntime(
          this.config,
          this.agent.state.model as { contextWindow?: unknown } | undefined,
        ),
        extractResponseText: () => extractResponseTextForRuntime({
          assistantMessage: getLatestAssistantMessageForRuntime(this.agent.state.messages),
          logger: log,
        }),
        getLatestAssistantMessage: () => getLatestAssistantMessageForRuntime(this.agent.state.messages),
      },
    }), message);

    if (!this.config.chargePolicy || getRunChargeContext()) {
      return run();
    }

    return runWithChargeContext({
      chargePolicy: this.config.chargePolicy,
      eventBus: this.eventBus,
      lane: 'interactive',
      runId: message.id,
      correlation: {
        requestId: message.id,
        channelId: message.channelId,
      },
    }, run);
  }

  // ── Private helpers ──

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
    subjectIdentityKey?: string,
  ): string {
    return buildPromptPrefixCacheKeyForTurn(
      message,
      channelType,
      canonicalContactKey,
      subjectIdentityKey,
    );
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

  private buildPromptTemplateVariables(
    message: SubstrateMessage,
    resolvedUserName: string,
    trustLevel: TrustLevel,
    channelType: string | undefined,
    canonicalContactKey: string | undefined,
    subjectIdentityKey: string | undefined,
    now: Date,
  ): Record<string, string> {
    const characterPromptVariables = this.resolveCharacterPromptVariables();
    const runtimePromptGuidanceVariables = resolveRuntimePromptGuidanceVariables(this.config);
    const { templateVariables, runtimeCharacterName } = buildPromptTemplateVariablesForTurn({
      message,
      resolvedUserName,
      trustLevel,
      channelType,
      canonicalContactKey,
      subjectIdentityKey,
      now,
      characterPromptVariables,
      modelId: this.agent.state.model.id,
      fallbackCharacterName: this.characterName,
    });
    this.characterName = runtimeCharacterName;
    return {
      ...templateVariables,
      ...runtimePromptGuidanceVariables,
    };
  }

  private buildDynamicPromptTemplateVariables(
    message: SubstrateMessage,
    resolvedUserName: string,
    trustLevel: TrustLevel,
    channelType: string | undefined,
    canonicalContactKey: string | undefined,
    subjectIdentityKey: string | undefined,
    responseStyle: ResponseStyle = 'concise',
    now: Date = new Date(),
    taskKind: string | undefined,
    templateVariables: Record<string, string>,
    internalState: InternalState,
    metacognitiveFlags: readonly MetacognitiveFlag[],
    emotionAppraisalChain: readonly EmotionAppraisalEntry[],
  ): Record<string, string> {
    const recentMessages = this.sessionManager.getRecentMessages(message.channelId, 6);
    const latestPriorMessage = [...recentMessages]
      .reverse()
      .find((entry, index) => {
        if (entry.role === 'system' || entry.role === 'tool') return false;
        if (
          index === 0
          && entry.role === 'user'
          && entry.authorId === message.authorId
          && entry.content === message.content
        ) {
          return false;
        }
        return true;
      });
    const activeToolCounts = this.toolRuntimeFacade.resolveActiveToolCounts();
    const loadedExtended = new Map<string, AdaptiveLoadedExtendedToolState>(
      this.toolRuntimeFacade.getLoadedExtendedTools(),
    );
    const extendedTools = [...this.toolRuntimeFacade.getExtendedTools()];

    return buildDynamicPromptTemplateVariablesForTurn({
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
      modelId: this.agent.state.model.id,
      capabilityTier: this.resolveCapabilityAccess().getTier(),
      activeToolCounts,
      extendedTools,
      loadedExtended,
      classifyExtendedToolForTurn: (toolName) => this.classifyExtendedToolForTurn(toolName),
      promotedExtendedToolNames: this.getCapabilityEligiblePromotedToolNames(),
      skillsContext: this.skillsRuntime?.getPromptXml() ?? '',
      activeConcernsBlock: this.buildActiveConcernsContextBlock(canonicalContactKey),
      behavioralNotesBlock: this.buildBehavioralNotesContextBlock(canonicalContactKey),
      lastMessageReceivedAtMs: latestPriorMessage?.timestamp ?? null,
      config: this.config as Record<string, unknown>,
    });
  }

  /** Build a runtime context block with current time, channel, user, model info */
  private buildRuntimeContext(
    message: SubstrateMessage,
    resolvedUserName: string,
    trustLevel: TrustLevel,
    channelType: string | undefined,
    canonicalContactKey?: string,
    subjectIdentityKey?: string,
    responseStyle: ResponseStyle = 'concise',
    now: Date = new Date(),
    taskKind?: string,
    templateVariables?: Record<string, string>,
    internalState?: InternalState,
    metacognitiveFlags: readonly MetacognitiveFlag[] = [],
    emotionAppraisalChain: readonly EmotionAppraisalEntry[] = [],
  ): string {
    const activeToolCounts = this.toolRuntimeFacade.resolveActiveToolCounts();
    if (this.internalStateContinuityGap) {
      this.internalStateContinuityGapRenderCount += 1;
    }
    return buildRuntimeContextForTurn({
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
      modelId: this.agent.state.model.id,
      contextWindow: resolveContextWindowForRuntime(
        this.config,
        this.agent.state.model as { contextWindow?: unknown } | undefined,
      ),
      capabilityTier: this.resolveCapabilityAccess().getTier(),
      activeToolCounts,
      extendedTools: [...this.toolRuntimeFacade.getExtendedTools()],
      loadedExtended: new Map(this.toolRuntimeFacade.getLoadedExtendedTools()),
      classifyExtendedToolForTurn: (toolName) => this.classifyExtendedToolForTurn(toolName),
      promotedExtendedToolNames: this.getCapabilityEligiblePromotedToolNames(),
      skillsContext: this.skillsRuntime?.getPromptXml() ?? '',
      activeConcernsBlock: this.buildActiveConcernsContextBlock(canonicalContactKey),
      behavioralNotesBlock: this.buildBehavioralNotesContextBlock(canonicalContactKey),
      formatTopEmotions: (discrete) => this.emotionSelfModelRuntime.formatTopEmotions(discrete),
      config: this.config as unknown as Record<string, unknown>,
      internalStateContinuityGap: this.internalStateContinuityGap,
    });
  }

  private buildActiveConcernsContextBlock(canonicalContactKey?: string): string {
    return buildActiveConcernsContextBlockForTurn({
      activeConcernProvider: this.activeConcernProvider,
      canonicalContactKey,
      logger: log,
    });
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

  private async resolveAuthorContext(message: SubstrateMessage): Promise<ResolvedAuthorContext> {
    return resolveAuthorContextForTurn({
      message,
      contactStore: this.contactStore,
      logger: log,
      companionIdentityKey: resolveCompanionIdFromConfig(this.config),
      companionDisplayName: this.characterName,
    });
  }
}
