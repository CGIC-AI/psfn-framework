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
import type { AgentTool, AgentToolResult, AgentMessage, StreamFn } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';
import { createHash } from 'node:crypto';
import type { AssistantMessage, ToolResultMessage, UserMessage } from '@mariozechner/pi-ai';
import type { EventBus } from '../event-bus.js';
import type { SessionManager } from '../session/manager.js';
import type {
  AgentResponse,
  CapabilityTier,
  CorrelationMetadata,
  ContextMessage,
  InferredPostTurnAction,
  LLMContext,
  MessageModelOverride,
  MessagePromptOverride,
  ObservabilityCallType,
  PostTurnActionCandidate,
  SubstrateConfig,
  SubstrateMessage,
  TurnUsage,
} from '../types.js';
import { PROMOTED_EXTENDED_TOOL_SLOTS_MAX } from '../types.js';
import type { ContactStore } from '../contacts/store.js';
import type { Contact } from '../contacts/types.js';
import type { LLMProvider, MemoryProvider, MemoryExtractor, ScratchpadProvider } from './contracts.js';
import type { TrustLevel } from '../trust/types.js';
import { classifyChannel, type ChannelMeta } from '../trust/policy.js';
import type { ChannelPromptDock } from '../channels/types.js';
import type { PromptComposer } from '../identity/prompt-composer.js';
import type { ComposeContext, ComposeSplitResult } from '../identity/prompt-types.js';
import {
  createSubstrateStreamFn,
  resolveExplicitModel,
  resolveModel,
} from './stream-adapter.js';
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
import { resolveToolRequiredCapabilities } from '../capabilities/requirements.js';
import { CapabilityRuntime } from '../capabilities/runtime.js';
import { normalizeCapabilityTier, resolveTierCapabilityTokens } from '../capabilities/tiers.js';
import type { CapabilityToken } from '../capabilities/tokens.js';
import { tagToolWithReversibility } from '../capabilities/safeguards.js';
import { textResult, textResultWithError } from '../tools/results.js';
import { toErrorMessage } from '../utils/errors.js';
import {
  validateAndLogToolWiring,
  extractGatewayMethods,
  type GatewayToolMetadataCoverage,
  type RuntimeMode,
  type ValidateToolsOptions,
} from './tool-wiring-validator.js';
import {
  classifyBroadcastDraft,
  resolveBroadcastVisibilityScope,
} from '../broadcast/safety.js';
import { runDeliberation } from '../llm/deliberation.js';
import {
  createDefaultExtendedToolAutoloadPolicy,
  type ExtendedToolAutoloadPolicy,
} from './extended-tool-autoload-policy.js';

const log = createComponentLogger('SubstrateAgent');

export type {
  LLMProvider,
  EmbeddingService,
  MemoryProvider,
  MemoryExtractor,
  ScratchpadProvider,
} from './contracts.js';

interface ResolvedAuthorContext {
  trustLevel: TrustLevel;
  resolvedUserName: string;
  canonicalContactKey?: string;
  continuityFallbackKeys: string[];
}

interface ProactiveMemoryProvider extends MemoryProvider {
  retrieveProactiveRecall?: (
    channelId: string,
    trustLevel?: TrustLevel,
    channelMeta?: ChannelMeta,
    canonicalContactId?: string,
  ) => Promise<string>;
}

interface PromptSections {
  staticPrefix: string;
  dynamicSuffix: string;
  staticHash: string;
}

interface FrozenPromptPrefix {
  renderedPrefix: string;
  staticHash: string;
  settingsHash: string;
}

interface ResolvedMoaSettings {
  maxRounds: number;
  maxTokensPerRound?: number;
  timeoutMs: number;
  referenceModels: string[];
  aggregatorModel?: string;
}

interface PostTurnInferenceContext {
  message: SubstrateMessage;
  response: AgentResponse;
  turnMessages: AgentMessage[];
}

export type PostTurnActionInferer = (
  context: PostTurnInferenceContext,
) => PostTurnActionCandidate[] | Promise<PostTurnActionCandidate[]>;

export type PromotedToolMutationErrorCode =
  | 'invalid_name'
  | 'tool_not_extended'
  | 'duplicate'
  | 'max_slots'
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

type TurnStageName = 'trust' | 'memory' | 'context' | 'prompt' | 'first-token' | 'end';
const SCRATCHPAD_PROMPT_SCAN_LIMIT = 64;
const SCRATCHPAD_PROMPT_MAX_ENTRIES = 8;
const SCRATCHPAD_PROMPT_MAX_ENTRY_CHARS = 240;
const SCRATCHPAD_PROMPT_MAX_TOTAL_CHARS = 1_600;
const PROMPT_HASH_LENGTH = 16;

// ── SubstrateAgent ──

export class SubstrateAgent {
  private agent: Agent;
  private eventBus: EventBus;
  private llmClient: LLMProvider;
  private sessionManager: SessionManager;
  private systemPrompt: string;
  private characterName: string;
  private config: SubstrateConfig;
  private coreTools: AgentTool<any>[] = [];
  private extendedTools: AgentTool<any>[] = [];
  private loadedExtended = new Set<string>();
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

  // Pluggable memory — null until memory system is wired
  memoryProvider: MemoryProvider | null = null;
  memoryExtractor: MemoryExtractor | null = null;
  scratchpadProvider: ScratchpadProvider | null = null;

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
    options?: { streamFn?: StreamFn; characterName?: string },
  ) {
    this.eventBus = eventBus;
    this.llmClient = llmClient;
    this.sessionManager = sessionManager;
    this.systemPrompt = systemPrompt;
    this.characterName = options?.characterName?.trim() || this.deriveCharacterName(systemPrompt);
    this.config = config;

    this.agent = new Agent({
      streamFn: options?.streamFn ?? createSubstrateStreamFn(config),
      convertToLlm,
    });

    this.installRuntimeHooks();

    // Persistent event bridge: pi-agent-core events → EventBus
    this.bridge = createEventBridge(this.agent, eventBus);

    // Register the load_tools meta-tool as a core tool
    this.coreTools.push(tagToolWithReversibility(this.createLoadToolsTool()));

    // Eagerly try to resolve the model, but don't throw if it fails
    // (e.g. in tests with fake model names). Deferred to handleMessage if needed.
    try {
      this.refreshModelFromConfig('startup');
    } catch {
      // Model will be resolved lazily on first handleMessage
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

  private getChatModelSignature(): string {
    const chatSlot = this.config.modelRoster.chat;
    const model = chatSlot?.model ?? this.config.primaryModel;
    const provider = chatSlot?.provider ?? this.config.primaryProvider;
    const maxTokens = chatSlot?.maxTokens ?? this.config.primaryMaxTokens;
    const contextWindow = chatSlot?.contextWindow ?? this.config.defaultContextWindow;
    return `${provider}::${model}::${maxTokens}::${contextWindow}`;
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

  private getTurnModelSignature(message?: SubstrateMessage): string {
    const override = this.normalizeTurnModelOverride(message);
    if (!override) return this.getChatModelSignature();
    return `override::${override.provider}::${override.model}::${override.maxTokens ?? ''}::${override.contextWindow ?? ''}`;
  }

  private refreshModelFromConfig(
    reason: 'startup' | 'turn-start' | 'settings-update',
    message?: SubstrateMessage,
  ): void {
    const override = this.normalizeTurnModelOverride(message);
    const nextSignature = this.getTurnModelSignature(message);
    if (this.modelResolved && this.modelSignature === nextSignature && this.agent.state.model) {
      return;
    }

    try {
      const resolved = override
        ? resolveExplicitModel(override)
        : resolveModel(this.config);
      this.agent.setModel(resolved);
      this.modelResolved = true;
      this.modelSignature = nextSignature;
      log.info('Resolved runtime chat model', {
        reason,
        model: resolved.id,
        override: Boolean(override),
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      if (this.agent.state.model) {
        this.modelResolved = true;
        log.warn('Model refresh failed; keeping previous chat model', {
          reason,
          error: err.message,
          currentModel: this.agent.state.model.id,
        });
        return;
      }

      this.modelResolved = false;
      this.modelSignature = null;
      throw err;
    }
  }

  registerTool(tool: AgentTool<any>, category: ToolCategory = 'core'): void {
    const taggedTool = tagToolWithReversibility(tool);
    if (category === 'core') {
      this.coreTools.push(taggedTool);
    } else {
      this.extendedTools.push(taggedTool);
    }
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

  private getCapabilityEligiblePromotedToolNames(): Set<string> {
    const promoted = this.getPromotedExtendedToolNamesInternal();
    const access = this.resolveCapabilityAccess();
    const eligible = new Set<string>();
    for (const toolName of promoted) {
      const tool = this.getExtendedToolByName(toolName);
      if (!tool) continue;
      const eligibility = evaluateToolCapabilityEligibility(tool, {}, access);
      if (!eligibility.allowed) continue;
      eligible.add(toolName);
    }
    return eligible;
  }

  private resolveActiveTools(): AgentTool<any>[] {
    const activeByName = new Map<string, AgentTool<any>>();
    for (const tool of this.coreTools) {
      if (!activeByName.has(tool.name)) {
        activeByName.set(tool.name, tool);
      }
    }

    const promotedNames = this.getCapabilityEligiblePromotedToolNames();
    for (const tool of this.extendedTools) {
      if (!this.loadedExtended.has(tool.name) && !promotedNames.has(tool.name)) {
        continue;
      }
      if (!activeByName.has(tool.name)) {
        activeByName.set(tool.name, tool);
      }
    }

    return [...activeByName.values()];
  }

  private applyActiveToolsToAgent(): void {
    this.agent.setTools(this.withCapabilityGates(this.resolveActiveTools()));
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
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      name: 'load_tools',
      label: 'load_tools',
      description: 'Load extended tool schemas by name. Call with tool names from the tool directory in your runtime context.',
      parameters: Type.Object({
        tools: Type.Array(Type.String(), { description: 'Names of extended tools to load' }),
      }),
      execute: async (
        _toolCallId: string,
        params: { tools: string[] },
      ): Promise<AgentToolResult<any>> => {
        const catalog = new Map(self.extendedTools.map(tool => [tool.name, tool]));
        const matched: AgentTool<any>[] = [];
        const seen = new Set<string>();
        for (const name of params.tools) {
          if (seen.has(name)) continue;
          seen.add(name);
          const tool = catalog.get(name);
          if (tool) matched.push(tool);
        }
        for (const t of matched) self.loadedExtended.add(t.name);
        self.applyActiveToolsToAgent();
        if (matched.length) {
          return textResult(`Loaded ${matched.length} tools: ${matched.map(t => t.name).join(', ')}`);
        }
        return textResultWithError(
          `No matching tools found. Available: ${self.extendedTools.map(t => t.name).join(', ')}`,
          true,
        );
      },
    };
  }

  private getActiveExtendedTools(): AgentTool<any>[] {
    if (this.loadedExtended.size === 0) return [];

    const catalog = new Map(this.extendedTools.map(tool => [tool.name, tool]));
    const active: AgentTool<any>[] = [];
    const staleNames: string[] = [];
    for (const name of this.loadedExtended) {
      const tool = catalog.get(name);
      if (!tool) {
        staleNames.push(name);
        continue;
      }
      active.push(tool);
    }
    for (const staleName of staleNames) {
      this.loadedExtended.delete(staleName);
    }
    return active;
  }

  private preloadExtendedToolsForTurn(
    message: SubstrateMessage,
    taskKind: string | undefined,
    correlation: CorrelationMetadata,
  ): void {
    const policy = this.extendedToolAutoloadPolicy;
    if (!policy || this.extendedTools.length === 0) {
      return;
    }

    const boundedMax = Number.isFinite(policy.maxPreloadCount)
      ? Math.max(0, Math.floor(policy.maxPreloadCount))
      : 0;
    const intent = policy.classifyIntent(message, taskKind);
    const candidateNames = policy.getCandidatesForIntent(intent).slice(0, boundedMax);
    if (candidateNames.length === 0) {
      this.emitTelemetry('agent.tools.autoload', {
        channelId: message.channelId,
        intent,
        taskKind: taskKind ?? null,
        boundedMax,
        candidates: [],
        activated: [],
        alreadyActive: [],
        skippedDenied: [],
        unavailable: [],
        ...this.withCorrelationPurpose(correlation, 'agent.tools.autoload'),
      });
      return;
    }

    const access = this.resolveCapabilityAccess();
    const catalog = new Map(this.extendedTools.map(tool => [tool.name, tool]));
    const activated: string[] = [];
    const alreadyActive: string[] = [];
    const unavailable: string[] = [];
    const skippedDenied: Array<{ toolName: string; missingTokens: CapabilityToken[] }> = [];

    for (const toolName of candidateNames) {
      const tool = catalog.get(toolName);
      if (!tool) {
        unavailable.push(toolName);
        this.emitTelemetry('agent.tools.autoload.skipped', {
          channelId: message.channelId,
          intent,
          taskKind: taskKind ?? null,
          toolName,
          reason: 'not_registered',
          ...this.withCorrelationPurpose(correlation, 'agent.tools.autoload.skipped'),
        });
        continue;
      }

      const missingTokens = resolveToolRequiredCapabilities(tool, {})
        .filter(token => !access.has(token));
      if (missingTokens.length > 0) {
        skippedDenied.push({ toolName, missingTokens });
        this.emitTelemetry('agent.tools.autoload.skipped', {
          channelId: message.channelId,
          intent,
          taskKind: taskKind ?? null,
          toolName,
          reason: 'capability_denied',
          missingTokens,
          tier: access.getTier(),
          ...this.withCorrelationPurpose(correlation, 'agent.tools.autoload.skipped'),
        });
        continue;
      }

      if (this.loadedExtended.has(tool.name)) {
        alreadyActive.push(tool.name);
        continue;
      }

      this.loadedExtended.add(tool.name);
      activated.push(tool.name);
    }

    this.emitTelemetry('agent.tools.autoload', {
      channelId: message.channelId,
      intent,
      taskKind: taskKind ?? null,
      boundedMax,
      candidates: candidateNames,
      activated,
      alreadyActive,
      skippedDenied,
      unavailable,
      ...this.withCorrelationPurpose(correlation, 'agent.tools.autoload'),
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
    this.recordUserMessage(message, authorContext.trustLevel, authorContext.canonicalContactKey);
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
    this.recordUserMessage(message, authorContext.trustLevel, authorContext.canonicalContactKey);
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

  registerPostTurnActionInferer(inferer: PostTurnActionInferer): () => void {
    this.postTurnActionInferers.push(inferer);
    return () => {
      const index = this.postTurnActionInferers.indexOf(inferer);
      if (index !== -1) {
        this.postTurnActionInferers.splice(index, 1);
      }
    };
  }

  /** Abort the current prompt, cancelling streaming and tool execution */
  abort(): void {
    this.agent.abort();
  }

  async handleMessage(message: SubstrateMessage): Promise<AgentResponse> {
    const startTime = Date.now();
    const taskKind = this.resolveTaskKind(message);
    const turnCallType = this.resolveTurnCallType(message, taskKind);
    const turnCorrelationBase = this.buildTurnCorrelation(message, turnCallType);
    const channelMeta: ChannelMeta = {
      ...(message.isDirectMessage !== undefined ? { isDirectMessage: message.isDirectMessage } : {}),
      ...(message.routing?.broadcast?.approvalToken
        ? { broadcastApprovalToken: message.routing.broadcast.approvalToken }
        : {}),
    };
    const channelVisibility = classifyChannel(message.channelId, channelMeta);
    const broadcastVisibilityScope = resolveBroadcastVisibilityScope(message.channelId, channelMeta);
    let retrievalProvenanceRefs: string[] = [];
    const unsubscribeRetrieval = this.eventBus.on('memory.retrieval', (telemetry) => {
      if (telemetry.channelId !== message.channelId) return;
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
    this.emitTurnStage(message, startTime, 'trust', turnCallType, {
      durationMs: Date.now() - trustStageStart,
      trustLevel: authorContext.trustLevel,
      canonicalContactKey: authorContext.canonicalContactKey ?? null,
    });

    // Record user message in session (JSONL append = L0 archival)
    this.recordUserMessage(message, authorContext.trustLevel, authorContext.canonicalContactKey);

    try {
      const trustLevel = authorContext.trustLevel;

      // Retrieve relevant memories (empty string if no memory provider)
      const memoryStageStart = Date.now();
      const memoryProvider = this.memoryProvider as ProactiveMemoryProvider | null;
      const memoriesBlock = memoryProvider
        ? await memoryProvider.retrieve(
          message.content,
          message.channelId,
          trustLevel,
          channelMeta,
          authorContext.canonicalContactKey,
        )
        : '';
      let proactiveRecallBlock = '';
      if (memoryProvider && typeof memoryProvider.retrieveProactiveRecall === 'function') {
        try {
          proactiveRecallBlock = await memoryProvider.retrieveProactiveRecall(
            message.channelId,
            trustLevel,
            channelMeta,
            authorContext.canonicalContactKey,
          );
        } catch (error) {
          log.debug('Proactive recall skipped due to provider error', {
            channelId: message.channelId,
            error: toErrorMessage(error),
          });
        }
      }
      const memoryContextBlock = [memoriesBlock, proactiveRecallBlock]
        .map(section => section.trim())
        .filter(section => section.length > 0)
        .join('\n\n');
      const scratchpadBlock = this.buildScratchpadContextBlock();
      this.emitTurnStage(message, startTime, 'memory', turnCallType, {
        durationMs: Date.now() - memoryStageStart,
        hasMemoryProvider: memoryProvider != null,
        memoryChars: memoryContextBlock.length,
        proactiveRecallChars: proactiveRecallBlock.length,
        proactiveRecallIncluded: proactiveRecallBlock.length > 0,
        scratchpadChars: scratchpadBlock.length,
        scratchpadIncluded: scratchpadBlock.length > 0,
      });

      // Compose prompt context (default system prompt pipeline or per-turn override).
      const channelType = this.resolveChannelType(message);
      const runtimeNow = new Date();
      const promptOverride = this.normalizeTurnPromptOverride(message);
      const templateVariables = this.buildPromptTemplateVariables(
        message,
        authorContext.resolvedUserName,
        trustLevel,
        channelType,
        authorContext.canonicalContactKey,
        runtimeNow,
      );
      const runtimeContext = this.buildRuntimeContext(
        message,
        authorContext.resolvedUserName,
        trustLevel,
        channelType,
        authorContext.canonicalContactKey,
        runtimeNow,
      );
      let fullPrompt = '';

      if (promptOverride.mode === 'default') {
        const promptSections = this.composePromptSections({ channelType, taskKind });
        const staticCacheKey = this.buildPromptPrefixCacheKey(
          message,
          channelType,
          authorContext.canonicalContactKey,
        );
        const staticSettingsHash = this.buildStaticPromptSettingsHash(templateVariables);
        const staticPrefix = this.resolveStaticPromptPrefix({
          cacheKey: staticCacheKey,
          staticPrefixTemplate: promptSections.staticPrefix,
          staticHash: promptSections.staticHash,
          settingsHash: staticSettingsHash,
          now: runtimeNow,
          variables: templateVariables,
        });
        const personaHint = this.getPersonaAdaptation(trustLevel);
        const dynamicSuffixTemplate = [promptSections.dynamicSuffix, personaHint]
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
      const context = await this.sessionManager.buildContext(
        message.channelId,
        fullPrompt,
        memoryContextBlock,
        this.llmClient,
        authorContext.canonicalContactKey ?? message.authorId,
        channelMeta,
        authorContext.continuityFallbackKeys,
      );
      this.emitTurnStage(message, startTime, 'context', turnCallType, {
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

      const moaSettings = this.resolveMoaSettings();
      if (moaSettings) {
        const moaResult = await this.runMoaTurn(context, message, moaSettings);
        firstTokenAt = Date.now();
        this.emitTurnStage(message, startTime, 'first-token', turnCallType, {
          ttftMs: firstTokenAt - startTime,
          source: 'fallback',
        });
        this.emitTurnStage(message, startTime, 'prompt', turnCallType, {
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
        this.ensureModel(message);
        this.agent.setSystemPrompt(context.systemPrompt);
        this.preloadExtendedToolsForTurn(message, taskKind, turnCorrelationBase);
        this.applyActiveToolsToAgent();

        // Convert ContextMessage[] to AgentMessage[] for the Agent.
        // Exclude the last message (the user message we just recorded) —
        // agent.prompt() will re-add it, avoiding duplication.
        const agentMessages = this.contextToAgentMessages(context.messages);
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
          this.emitTurnStage(message, startTime, 'first-token', turnCallType, {
            ttftMs: streamFirstTokenAt - startTime,
            source: 'stream',
          });
        });

        // Activate event bridge for this channel (streams deltas + tool events to EventBus)
        this.bridge.setChannel(message.channelId, {
          turnId: message.id,
          requestId: message.id,
          callType: turnCallType,
        });
        try {
          // Run the agent — pi-agent-core handles tool loop internally
          await this.agent.prompt({
            role: 'user',
            content: message.content,
            timestamp: Date.now(),
          } satisfies UserMessage);
        } finally {
          unsubscribeFirstToken();
          this.bridge.clearChannel();
        }
        if (streamFirstTokenAt == null) {
          streamFirstTokenAt = Date.now();
          this.emitTurnStage(message, startTime, 'first-token', turnCallType, {
            ttftMs: streamFirstTokenAt - startTime,
            source: 'fallback',
          });
        }
        this.emitTurnStage(message, startTime, 'prompt', turnCallType, {
          durationMs: Date.now() - promptStageStart,
          ttftMs: streamFirstTokenAt - startTime,
        });

        turnMessages = this.agent.state.messages.slice(turnStartMessageIndex);
        turnUsage = this.accumulateTurnUsage(turnMessages);
        responseModel = this.agent.state.model?.id ?? 'unknown';
        firstTokenAt = streamFirstTokenAt;

        // Extract response from agent state (last assistant message)
        responseText = this.extractResponseText();
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

      // Record assistant message (JSONL append = L0 archival)
      if (!broadcastSafetyMeta?.approvalRequired) {
        this.recordAssistantMessage(
          message,
          safeResponseText,
          authorContext.trustLevel,
          authorContext.canonicalContactKey,
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

      const agentResponse: AgentResponse = {
        content: safeResponseText,
        channelId: message.channelId,
        metadata: {
          model: responseModel,
          inputTokens: turnUsage.inputTokens,
          outputTokens: turnUsage.outputTokens,
          durationMs: Date.now() - startTime,
          ...(broadcastSafetyMeta ? { broadcastSafety: broadcastSafetyMeta } : {}),
        },
      };
      const inferredPostTurnActions = await this.inferPostTurnActions({
        message,
        response: agentResponse,
        turnMessages,
      });

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
      await this.eventBus.emit('agent.turn.usage', {
        message,
        usage: turnUsage,
        ...this.withCorrelationPurpose(turnCorrelationBase, 'agent.turn.usage'),
      });
      this.emitTurnStage(message, startTime, 'end', turnCallType, {
        durationMs: Date.now() - startTime,
        ttftMs: firstTokenAt - startTime,
        inputTokens: turnUsage.inputTokens,
        outputTokens: turnUsage.outputTokens,
      });

      // Trigger memory extraction (fire-and-forget)
      this.memoryExtractor?.maybeExtract(
        message.channelId,
        authorContext.canonicalContactKey,
      ).catch(err => {
        log.error('Memory extraction error', { error: String(err) });
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
    }
  }

  // ── Private helpers ──

  private resolveMoaSettings(): ResolvedMoaSettings | null {
    if (this.config.moaEnabled !== true) return null;

    const maxRoundsRaw = this.config.moaMaxRounds ?? 4;
    const timeoutMsRaw = this.config.moaTimeoutMs ?? 45_000;
    const maxTokensPerRoundRaw = this.config.moaMaxTokensPerRound;

    if (!Number.isFinite(maxRoundsRaw) || maxRoundsRaw <= 0) {
      log.warn('MoA disabled for turn due invalid max rounds', {
        moaMaxRounds: this.config.moaMaxRounds,
      });
      return null;
    }
    if (!Number.isFinite(timeoutMsRaw) || timeoutMsRaw <= 0) {
      log.warn('MoA disabled for turn due invalid timeout', {
        moaTimeoutMs: this.config.moaTimeoutMs,
      });
      return null;
    }
    if (
      maxTokensPerRoundRaw !== undefined
      && (!Number.isFinite(maxTokensPerRoundRaw) || maxTokensPerRoundRaw <= 0)
    ) {
      log.warn('MoA disabled for turn due invalid token cap', {
        moaMaxTokensPerRound: this.config.moaMaxTokensPerRound,
      });
      return null;
    }

    const referenceModels: string[] = [];
    for (const value of this.config.moaReferenceModels ?? []) {
      const trimmed = value.trim();
      if (!trimmed || referenceModels.includes(trimmed)) continue;
      referenceModels.push(trimmed);
    }
    const aggregatorModel = this.config.moaAggregatorModel?.trim() || undefined;

    return {
      maxRounds: Math.max(1, Math.floor(maxRoundsRaw)),
      timeoutMs: Math.max(250, Math.floor(timeoutMsRaw)),
      ...(maxTokensPerRoundRaw !== undefined
        ? { maxTokensPerRound: Math.max(1, Math.floor(maxTokensPerRoundRaw)) }
        : {}),
      referenceModels,
      ...(aggregatorModel ? { aggregatorModel } : {}),
    };
  }

  private buildMoaPrompt(context: LLMContext): string {
    const transcript = context.messages
      .map(message => `${message.role === 'assistant' ? 'Assistant' : 'User'}:\n${message.content}`)
      .join('\n\n');
    return [
      'Produce the best final assistant reply for the latest user turn.',
      `System instructions:\n${context.systemPrompt}`,
      transcript.length > 0 ? `Conversation transcript:\n${transcript}` : '',
      'Return only the assistant response text to send back.',
    ]
      .map(section => section.trim())
      .filter(section => section.length > 0)
      .join('\n\n');
  }

  private async runMoaTurn(
    context: LLMContext,
    message: SubstrateMessage,
    settings: ResolvedMoaSettings,
  ): Promise<{
    output: string;
    model: string;
    turnUsage: TurnUsage;
    rounds: number;
    stopReason: string;
  }> {
    const caps = {
      maxRounds: settings.maxRounds,
      maxWallTimeMs: settings.timeoutMs,
      ...(settings.maxTokensPerRound !== undefined
        ? {
          maxTokensPerRound: settings.maxTokensPerRound,
          maxTotalTokens: settings.maxTokensPerRound * settings.maxRounds,
        }
        : {}),
    };
    const deliberation = await runDeliberation(
      this.llmClient,
      this.buildMoaPrompt(context),
      {
        correlation: {
          turnId: message.id,
          requestId: message.id,
          channelId: message.channelId,
          callType: this.resolveTurnCallType(message, this.resolveTaskKind(message)),
          purpose: 'agent.moa.turn',
        },
        ...(settings.referenceModels.length > 0 ? { referenceModels: settings.referenceModels } : {}),
        ...(settings.aggregatorModel ? { aggregatorModel: settings.aggregatorModel } : {}),
        caps,
      },
    );

    const llmCalls = deliberation.rounds.reduce(
      (sum, round) => sum + round.voices.length + (round.aggregatorModel ? 1 : 0),
      0,
    );
    const peakInputTokens = deliberation.rounds.reduce(
      (max, round) => Math.max(max, round.inputTokens),
      0,
    );
    const contextWindow = this.resolveContextWindow();
    const contextUtilization = contextWindow > 0
      ? Math.min(100, (peakInputTokens / contextWindow) * 100)
      : 0;
    const lastRound = deliberation.rounds[deliberation.rounds.length - 1];
    const model = lastRound?.aggregatorModel
      ?? lastRound?.voices[lastRound.voices.length - 1]?.model
      ?? this.config.modelRoster.chat?.model
      ?? this.config.primaryModel;

    const turnUsage: TurnUsage = {
      inputTokens: deliberation.totalInputTokens,
      outputTokens: deliberation.totalOutputTokens,
      cacheReadTokens: 0,
      llmCalls,
      toolCalls: 0,
      contextUtilization,
      ...(deliberation.estimatedCostUsd > 0 ? { estimatedCostUsd: deliberation.estimatedCostUsd } : {}),
    };

    const moaCallType = this.resolveTurnCallType(message, this.resolveTaskKind(message));
    this.emitTelemetry('agent.moa.turn', {
      turnId: message.id,
      requestId: message.id,
      channelId: message.channelId,
      callType: moaCallType,
      purpose: 'agent.moa.turn',
      rounds: deliberation.rounds.length,
      stopReason: deliberation.stopReason,
      llmCalls,
      referenceModels: settings.referenceModels,
      aggregatorModel: settings.aggregatorModel ?? null,
      model,
      totalInputTokens: deliberation.totalInputTokens,
      totalOutputTokens: deliberation.totalOutputTokens,
      maxRounds: settings.maxRounds,
      maxTokensPerRound: settings.maxTokensPerRound ?? null,
      timeoutMs: settings.timeoutMs,
    });

    return {
      output: deliberation.output,
      model,
      turnUsage,
      rounds: deliberation.rounds.length,
      stopReason: deliberation.stopReason,
    };
  }

  private emitTurnStage(
    message: SubstrateMessage,
    turnStartMs: number,
    stage: TurnStageName,
    callType: ObservabilityCallType,
    payload: Record<string, unknown>,
  ): void {
    const telemetry = {
      turnId: message.id,
      requestId: message.id,
      channelId: message.channelId,
      callType,
      purpose: `agent.turn.stage.${stage}`,
      stage,
      elapsedMs: Math.max(0, Date.now() - turnStartMs),
      ...payload,
    };
    log.debug('Turn stage telemetry', telemetry);
    this.emitTelemetry('agent.turn.stage', telemetry);
  }

  private resolveTurnCallType(
    message: SubstrateMessage,
    taskKind: string | undefined,
  ): ObservabilityCallType {
    if (taskKind === 'heartbeat' || taskKind === 'reflection') {
      return 'scheduled';
    }
    if (message.channelId.startsWith('internal:')) {
      return 'scheduled';
    }
    return 'chat';
  }

  private buildTurnCorrelation(
    message: SubstrateMessage,
    callType: ObservabilityCallType,
  ): CorrelationMetadata {
    return {
      turnId: message.id,
      requestId: message.id,
      channelId: message.channelId,
      callType,
      purpose: 'agent.turn',
    };
  }

  private withCorrelationPurpose(
    correlation: CorrelationMetadata,
    purpose: string,
  ): CorrelationMetadata {
    return {
      ...correlation,
      purpose,
    };
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

  private composePromptSections(ctx: ComposeContext): PromptSections {
    if (!this.promptComposer) {
      return {
        staticPrefix: this.systemPrompt,
        dynamicSuffix: '',
        staticHash: this.hashPromptText(this.systemPrompt),
      };
    }

    const splitComposer = this.promptComposer as PromptComposer & {
      composeSplit?: (composeContext?: ComposeContext) => ComposeSplitResult;
    };
    if (typeof splitComposer.composeSplit === 'function') {
      const split = splitComposer.composeSplit(ctx);
      return {
        staticPrefix: split.staticPrefix,
        dynamicSuffix: split.dynamicSuffix,
        staticHash: split.staticHash,
      };
    }

    const composed = this.promptComposer.compose(ctx);
    return {
      staticPrefix: composed.text,
      dynamicSuffix: '',
      staticHash: composed.hash,
    };
  }

  private buildPromptPrefixCacheKey(
    message: SubstrateMessage,
    channelType: string | undefined,
    canonicalContactKey: string | undefined,
  ): string {
    return [
      message.channelId,
      channelType ?? 'unknown',
      canonicalContactKey ?? message.authorId,
    ].join('::');
  }

  private buildStaticPromptSettingsHash(templateVariables: Record<string, string>): string {
    const stableEntries = Object.entries(templateVariables)
      .filter(([key]) => key !== 'now_iso')
      .sort(([left], [right]) => left.localeCompare(right));
    return this.hashPromptText(JSON.stringify(stableEntries));
  }

  private resolveStaticPromptPrefix(params: {
    cacheKey: string;
    staticPrefixTemplate: string;
    staticHash: string;
    settingsHash: string;
    now: Date;
    variables: Record<string, string>;
  }): string {
    const cached = this.frozenPromptPrefixCache.get(params.cacheKey);
    if (cached && cached.staticHash === params.staticHash && cached.settingsHash === params.settingsHash) {
      return cached.renderedPrefix;
    }

    const renderedPrefix = injectPromptRuntimeTokens(params.staticPrefixTemplate, {
      now: params.now,
      variables: params.variables,
    });
    this.frozenPromptPrefixCache.set(params.cacheKey, {
      renderedPrefix,
      staticHash: params.staticHash,
      settingsHash: params.settingsHash,
    });
    return renderedPrefix;
  }

  private invalidatePromptPrefixCache(reason: string): void {
    if (this.frozenPromptPrefixCache.size === 0) return;
    this.frozenPromptPrefixCache.clear();
    log.info('Invalidated static prompt-prefix cache', {
      reason,
    });
  }

  private hashPromptText(text: string): string {
    return createHash('sha256').update(text).digest('hex').slice(0, PROMPT_HASH_LENGTH);
  }

  private recordUserMessage(
    message: SubstrateMessage,
    trustLevel: TrustLevel,
    canonicalContactKey?: string,
  ): void {
    if (canonicalContactKey) {
      this.sessionManager.recordUserMessage(
        message.channelId,
        message.content,
        message.authorId,
        message.authorName,
        message.isDirectMessage,
        canonicalContactKey,
        { trustLevel },
      );
      return;
    }

    this.sessionManager.recordUserMessage(
      message.channelId,
      message.content,
      message.authorId,
      message.authorName,
      message.isDirectMessage,
      undefined,
      { trustLevel },
    );
  }

  private recordAssistantMessage(
    message: SubstrateMessage,
    responseText: string,
    trustLevel: TrustLevel,
    canonicalContactKey?: string,
  ): void {
    if (canonicalContactKey) {
      this.sessionManager.recordAssistantMessage(
        message.channelId,
        responseText,
        message.authorId,
        message.isDirectMessage,
        canonicalContactKey,
        { trustLevel },
      );
      return;
    }

    this.sessionManager.recordAssistantMessage(
      message.channelId,
      responseText,
      message.authorId,
      message.isDirectMessage,
      undefined,
      { trustLevel },
    );
  }

  /** Convert ContextMessage[] (from buildContext) to AgentMessage[] for pi-agent-core */
  private contextToAgentMessages(messages: ContextMessage[]): AgentMessage[] {
    return messages.map(m => {
      if (m.role === 'user') {
        return {
          role: 'user',
          content: m.content,
          timestamp: Date.now(),
        } satisfies UserMessage;
      }
      // assistant — pi-ai expects content as ContentPart[]
      return {
        role: 'assistant',
        content: [{ type: 'text', text: m.content }],
        api: '',
        provider: '',
        model: '',
        usage: {
          input: 0, output: 0,
          cacheRead: 0, cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop',
        timestamp: Date.now(),
      } satisfies AssistantMessage;
    });
  }

  /** Aggregate usage stats for a single turn across all tool loop iterations. */
  private accumulateTurnUsage(messages: AgentMessage[]): TurnUsage {
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let llmCalls = 0;
    let toolCalls = 0;
    let maxInputTokens = 0;
    let estimatedCostUsd = 0;

    for (const message of messages) {
      if (this.isAssistantAgentMessage(message)) {
        llmCalls += 1;
        inputTokens += message.usage.input;
        outputTokens += message.usage.output;
        cacheReadTokens += message.usage.cacheRead;
        maxInputTokens = Math.max(maxInputTokens, message.usage.input);
        estimatedCostUsd += message.usage.cost.total;
        continue;
      }

      if (this.isToolResultAgentMessage(message)) {
        toolCalls += 1;
      }
    }

    const contextWindow = this.resolveContextWindow();
    const contextUtilization = contextWindow > 0
      ? Math.min(100, (maxInputTokens / contextWindow) * 100)
      : 0;

    return {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      llmCalls,
      toolCalls,
      contextUtilization,
      ...(estimatedCostUsd > 0 ? { estimatedCostUsd } : {}),
    };
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

  private isAssistantAgentMessage(message: AgentMessage): message is AssistantMessage {
    return (message as { role?: string }).role === 'assistant';
  }

  private isToolResultAgentMessage(message: AgentMessage): message is ToolResultMessage {
    return (message as { role?: string }).role === 'toolResult';
  }

  private buildTurnToolSummary(turnMessages: AgentMessage[]): TurnToolSummary {
    let toolCalls = 0;
    let usedThinkTool = false;
    for (const msg of turnMessages) {
      if (this.isToolResultAgentMessage(msg)) {
        toolCalls += 1;
        if (msg.toolName === 'think') {
          usedThinkTool = true;
        }
      }
    }
    return { toolCalls, usedThinkTool };
  }

  private async inferPostTurnActions(
    context: PostTurnInferenceContext,
  ): Promise<InferredPostTurnAction[]> {
    if (this.postTurnActionInferers.length === 0) {
      return [];
    }

    const inferred: InferredPostTurnAction[] = [];
    const seenDedupeKeys = new Set<string>();

    for (const inferer of this.postTurnActionInferers) {
      let candidates: PostTurnActionCandidate[] = [];
      try {
        candidates = await inferer(context);
      } catch (error) {
        log.warn('Post-turn action inferer failed', {
          channelId: context.message.channelId,
          messageId: context.message.id,
          error: toErrorMessage(error),
        });
        continue;
      }

      for (const candidate of candidates) {
        const normalized = this.normalizePostTurnActionCandidate(
          candidate,
          context.message,
          inferred.length,
        );
        if (!normalized) continue;
        if (seenDedupeKeys.has(normalized.dedupeKey)) continue;
        seenDedupeKeys.add(normalized.dedupeKey);
        inferred.push(normalized);
      }
    }

    return inferred;
  }

  private normalizePostTurnActionCandidate(
    candidate: PostTurnActionCandidate | null | undefined,
    message: SubstrateMessage,
    ordinal: number,
  ): InferredPostTurnAction | null {
    if (!candidate || typeof candidate.kind !== 'string') {
      return null;
    }

    const kind = candidate.kind.trim();
    if (!kind) {
      return null;
    }

    const payload = this.normalizePostTurnPayload(candidate.payload);
    const explicitDedupeKey = typeof candidate.dedupeKey === 'string' ? candidate.dedupeKey.trim() : '';
    const dedupeKey = explicitDedupeKey || `${kind}:${message.channelId}:${this.hashPostTurnPayload(payload)}`;
    const inferredAt = Date.now();
    const id = createHash('sha256')
      .update(`${message.id}:${kind}:${dedupeKey}:${ordinal}`)
      .digest('hex')
      .slice(0, 24);

    const normalizedMaxRetries = (
      typeof candidate.maxRetries === 'number'
      && Number.isFinite(candidate.maxRetries)
      && candidate.maxRetries >= 0
    )
      ? Math.floor(candidate.maxRetries)
      : undefined;

    return {
      id,
      kind,
      payload,
      dedupeKey,
      channelId: message.channelId,
      sourceMessageId: message.id,
      inferredAt,
      ...(normalizedMaxRetries !== undefined ? { maxRetries: normalizedMaxRetries } : {}),
    };
  }

  private normalizePostTurnPayload(
    payload: PostTurnActionCandidate['payload'],
  ): Record<string, unknown> {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return {};
    }
    return payload;
  }

  private hashPostTurnPayload(payload: Record<string, unknown>): string {
    const serialized = this.stableStringify(payload);
    return createHash('sha256').update(serialized).digest('hex').slice(0, 16);
  }

  private stableStringify(value: unknown): string {
    if (value === null) return 'null';
    if (value instanceof Date) return JSON.stringify(value.toISOString());
    if (typeof value === 'bigint') return JSON.stringify(value.toString());
    if (typeof value !== 'object') {
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
      return `[${value.map(item => this.stableStringify(item)).join(',')}]`;
    }

    const objectValue = value as Record<string, unknown>;
    const entries = Object.entries(objectValue)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${this.stableStringify(entryValue)}`);
    return `{${entries.join(',')}}`;
  }

  /** Extract text from the last assistant message in Agent state */
  private extractResponseText(): string {
    const messages = this.agent.state.messages;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if ((msg as unknown as { role: string }).role === 'assistant') {
        const content = (msg as unknown as AssistantMessage).content;
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
              });
            } else {
              log.warn('Assistant message has no text content blocks', {
                blockTypes: content.map((b: any) => b.type),
              });
            }
          }
          return textParts;
        }
      }
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
    const visibility = classifyChannel(message.channelId, { isDirectMessage: message.isDirectMessage });
    const modelId = this.agent.state.model?.id ?? this.config.primaryModel;

    return {
      user: resolvedUserName,
      user_name: resolvedUserName,
      user_id: message.authorId,
      char: this.characterName,
      char_name: this.characterName,
      character: this.characterName,
      character_name: this.characterName,
      channel: message.channelId,
      channel_id: message.channelId,
      channel_type: channelType ?? 'unknown',
      channel_visibility: visibility,
      trust_level: trustLevel,
      canonical_contact_id: canonicalContactKey ?? message.authorId,
      model: modelId,
      model_id: modelId,
      now_iso: now.toISOString(),
    };
  }

  /** Build a runtime context block with current time, channel, user, model info */
  private buildRuntimeContext(
    message: SubstrateMessage,
    resolvedUserName: string,
    trustLevel: TrustLevel,
    channelType: string | undefined,
    canonicalContactKey?: string,
    now: Date = new Date(),
  ): string {
    const visibility = classifyChannel(message.channelId, { isDirectMessage: message.isDirectMessage });
    const modelId = this.agent.state.model?.id ?? this.config.primaryModel;
    const contextWindow = this.resolveContextWindow();
    const coreCount = this.coreTools.length;
    const extendedCount = this.extendedTools.length;
    const promotedCount = this.getCapabilityEligiblePromotedToolNames().size;
    const activeCount = coreCount + promotedCount;
    const capabilityAccess = this.resolveCapabilityAccess();
    const capabilityTier = capabilityAccess.getTier();
    const skillsContext = this.skillsRuntime?.getPromptXml() ?? '';

    const lines = [
      '[Runtime Context]',
      `Current time: ${now.toISOString()}`,
      `Channel: ${message.channelId} (type: ${channelType ?? 'unknown'}, visibility: ${visibility})`,
      `Speaking with: ${resolvedUserName} (userId: ${message.authorId}, canonicalId: ${canonicalContactKey ?? message.authorId}, trust: ${trustLevel})`,
      `Model: ${modelId}`,
      `Capability tier: ${capabilityTier}`,
      `Context window: ${contextWindow} tokens`,
      `Tools: ${activeCount} active`
      + (promotedCount > 0 ? ` (${coreCount} core + ${promotedCount} promoted)` : '')
      + (extendedCount > 0 ? `, ${extendedCount} available via load_tools` : ''),
    ];

    // Tool directory for extended tools
    if (extendedCount > 0) {
      const promotedNames = this.getCapabilityEligiblePromotedToolNames();
      lines.push('');
      lines.push('Available extended tools:');
      for (const t of this.extendedTools) {
        const suffix = promotedNames.has(t.name) ? ' (promoted, always active)' : ' (use load_tools to activate)';
        lines.push(`- ${t.name}: ${t.description.split('.')[0]}${suffix}`);
      }
    }

    if (skillsContext) {
      lines.push('');
      lines.push('[Skills Index]');
      lines.push('Use skill_view(name) to load full instructions only when needed.');
      lines.push(skillsContext);
    }

    return lines.join('\n');
  }

  private buildScratchpadContextBlock(): string {
    if (!this.scratchpadProvider) return '';

    try {
      const entries = this.scratchpadProvider.listScratchpadEntries(SCRATCHPAD_PROMPT_SCAN_LIMIT);
      if (entries.length === 0) return '';

      const lines = [
        '[Scratchpad]',
        'Working notes (short-term, may be stale; verify before acting):',
      ];

      let included = 0;
      let usedChars = 0;
      for (const entry of entries) {
        if (included >= SCRATCHPAD_PROMPT_MAX_ENTRIES) break;

        const normalized = entry.content.replace(/\s+/g, ' ').trim();
        if (!normalized) continue;

        const clipped = normalized.length > SCRATCHPAD_PROMPT_MAX_ENTRY_CHARS
          ? `${normalized.slice(0, SCRATCHPAD_PROMPT_MAX_ENTRY_CHARS - 3)}...`
          : normalized;

        const line = `- ${entry.id}: ${clipped}`;
        const projectedChars = usedChars + line.length;
        if (projectedChars > SCRATCHPAD_PROMPT_MAX_TOTAL_CHARS) break;

        lines.push(line);
        usedChars = projectedChars;
        included += 1;
      }

      if (included === 0) return '';
      const omitted = Math.max(0, entries.length - included);
      if (omitted > 0) {
        lines.push(`- (${omitted} additional notes omitted for context budget)`);
      }

      return lines.join('\n');
    } catch (error) {
      log.debug('Scratchpad context injection skipped due to provider error', {
        error: toErrorMessage(error),
      });
      return '';
    }
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

  private getPersonaAdaptation(trustLevel: TrustLevel): string | null {
    switch (trustLevel) {
      case 'primary':
        return '[Trust: You are speaking with your primary person. Be your full, authentic self — share freely, reference shared history, express genuine emotions and vulnerability. This is honne — your inner truth.]';
      case 'trusted':
        return '[Trust: This is a trusted contact. Be warm and personal but mindful of boundaries — share appropriate personal context, avoid intimate details or confidential memories.]';
      case 'regular':
        return '[Trust: This is a regular acquaintance. Be friendly and helpful. Do not reference personal history, intimate details, or information from private conversations.]';
      case 'public':
        return '[Trust: This is a public interaction. Be professional and guarded. Share no personal information, relationship context, or private memories.]';
      default:
        return null;
    }
  }

  private resolveIdentityChannel(message: SubstrateMessage): string {
    if (message.channelType === 'discord') return 'discord';
    if (message.channelType === 'api') return 'api';
    if (message.channelType && message.channelType !== 'terminal') return message.channelType;
    if (message.channelId.startsWith('discord-voice:')) return 'discord';
    if (message.channelId.startsWith('api:')) return 'api';
    if (message.channelId.startsWith('internal:')) return 'internal';
    return 'unknown';
  }

  private collectContinuityFallbackKeys(
    authorId: string,
    canonicalContactKey: string,
    contact?: Contact,
  ): string[] {
    const keys = new Set<string>();
    const addKey = (value?: string): void => {
      if (!value || value === canonicalContactKey) return;
      keys.add(value);
    };

    addKey(authorId);
    addKey(contact?.discordUserId);
    for (const identity of contact?.channelIdentities ?? []) {
      addKey(identity.userId);
    }

    return [...keys].sort((a, b) => a.localeCompare(b));
  }

  private resolvePromptUserName(message: SubstrateMessage, contact?: Contact): string {
    const nickname = contact?.nickname?.trim();
    if (nickname) return nickname;

    const displayName = contact?.displayName?.trim();
    if (displayName) return displayName;

    const authorName = message.authorName?.trim();
    if (authorName) return authorName;

    return 'User';
  }

  private resolveAuthorContext(message: SubstrateMessage): ResolvedAuthorContext {
    // Internal system channels are self-context (heartbeat/reflection/planning).
    // They should use full private trust for memory access.
    if (message.channelId.startsWith('internal:')) {
      return {
        trustLevel: 'primary',
        resolvedUserName: this.resolvePromptUserName(message),
        canonicalContactKey: message.authorId,
        continuityFallbackKeys: [],
      };
    }

    if (!message.authorId || !this.contactStore) {
      return {
        trustLevel: 'regular',
        resolvedUserName: this.resolvePromptUserName(message),
        continuityFallbackKeys: [],
      };
    }

    try {
      const channel = this.resolveIdentityChannel(message);
      const maybeChannelResolver = this.contactStore as ContactStore & {
        resolveChannelIdentity?: (channel: string, userId: string, displayName?: string) => Contact;
      };
      const contact = typeof maybeChannelResolver.resolveChannelIdentity === 'function'
        ? maybeChannelResolver.resolveChannelIdentity(channel, message.authorId, message.authorName)
        : this.contactStore.resolveUserId(message.authorId);
      const canonicalContactKey = contact?.id;

      const maybeActivityRecorder = this.contactStore as ContactStore & {
        recordChannelActivity?: (contactId: string, channel: string, channelId: string) => void;
      };
      if (
        canonicalContactKey
        && typeof maybeActivityRecorder.recordChannelActivity === 'function'
      ) {
        maybeActivityRecorder.recordChannelActivity(canonicalContactKey, channel, message.channelId);
      }

      return {
        trustLevel: contact?.trustLevel ?? 'regular',
        resolvedUserName: this.resolvePromptUserName(message, contact),
        canonicalContactKey,
        continuityFallbackKeys: canonicalContactKey
          ? this.collectContinuityFallbackKeys(message.authorId, canonicalContactKey, contact)
          : [],
      };
    } catch (error) {
      log.warn('Failed to resolve contact identity for trust/context routing', {
        authorId: message.authorId,
        channelId: message.channelId,
        error: toErrorMessage(error),
      });
      return {
        trustLevel: 'regular',
        resolvedUserName: this.resolvePromptUserName(message),
        continuityFallbackKeys: [],
      };
    }
  }
}
