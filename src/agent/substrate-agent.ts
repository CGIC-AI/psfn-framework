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
import type { AssistantMessage, ImageContent, ToolResultMessage, UserMessage } from '@mariozechner/pi-ai';
import type { EventBus } from '../event-bus.js';
import type { SessionManager } from '../session/manager.js';
import type {
  Attachment,
  AgentResponse,
  CapabilityTier,
  CorrelationMetadata,
  ContextMessage,
  InferredPostTurnAction,
  LLMContext,
  MessageModelOverride,
  MessagePromptOverride,
  ResponseStyle,
  ObservabilityCallType,
  PostTurnActionCandidate,
  SubstrateConfig,
  SubstrateMessage,
  TurnUsage,
  ModelPurpose,
} from '../types.js';
import { PROMOTED_EXTENDED_TOOL_SLOTS_MAX } from '../types.js';
import type { ContactStore } from '../contacts/store.js';
import type { Contact } from '../contacts/types.js';
import type { LLMProvider, MemoryProvider, MemoryExtractor, ScratchpadProvider } from './contracts.js';
import type { TrustLevel } from '../trust/types.js';
import {
  classifyChannel,
  getResponseStylePromptGuidance,
  resolveChannelResponseStyle,
  type ChannelMeta,
} from '../trust/policy.js';
import type { ChannelPromptDock } from '../channels/types.js';
import {
  enforceUntrustedCompactionGuard,
  type PromptComposer,
} from '../identity/prompt-composer.js';
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
import { textResultWithError } from '../tools/results.js';
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
import { runWithRequestContext } from '../llm/request-context.js';
import {
  normalizeDeferredToolHandoffIntent,
  normalizeToolNameList,
  type DeferredToolHandoffIntent,
} from './deferred-tool-handoff.js';
import {
  createDefaultExtendedToolAutoloadPolicy,
  type ExtendedToolAutoloadPolicy,
} from './extended-tool-autoload-policy.js';
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

interface VisionAttachmentFetchCapabilities {
  webFetchBinary?: (
    url: string,
    options?: {
      lane?: 'default' | 'local_crawler';
      maxBytes?: number;
    },
  ) => Promise<{
    dataBase64: string;
    mimeType: string;
    sizeBytes: number;
  }>;
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

export interface ExtendedToolActivationResult {
  requestedTools: string[];
  activatedTools: string[];
  alreadyActiveTools: string[];
  missingTools: string[];
}

export interface ExtendedToolActivationOptions {
  source?: Extract<AdaptiveToolActivationSource, 'extended_loaded' | 'autoload' | 'deferred'>;
  correlation?: CorrelationMetadata;
  taskKind?: string | null;
  intent?: string | null;
}

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
const VISION_ATTACHMENT_MAX_COUNT = 4;
const VISION_ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;
const VISION_ATTACHMENT_FETCH_TIMEOUT_MS = 12_000;
const DISCORD_VISION_ATTACHMENT_HOSTS = new Set([
  'cdn.discordapp.com',
  'media.discordapp.net',
]);
const DISCORD_VISION_ATTACHMENT_HOST_SUFFIXES = [
  '.discordapp.com',
  '.discordapp.net',
];
const VISION_ATTACHMENT_EXTENSION_TO_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
};
const VISION_ATTACHMENT_FORMAT_QUERY_KEYS = ['format', 'fm'];
const LOADED_TOOL_SOURCE_PRIORITY: Record<Extract<AdaptiveToolActivationSource, 'extended_loaded' | 'autoload' | 'deferred'>, number> = {
  autoload: 1,
  extended_loaded: 2,
  deferred: 3,
};

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

interface AutoloadTurnOutcome {
  intent: string | null;
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
  private activeTurnCorrelation: CorrelationMetadata | null = null;
  private lastAdaptiveToolSnapshot: AdaptiveToolSnapshotTelemetry | null = null;

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
    options?: {
      streamFn?: StreamFn;
      characterName?: string;
      characterPromptVariables?: Record<string, string>;
      characterPromptVariablesProvider?: () => Record<string, string>;
    },
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

  private getModelSignatureForPurpose(purpose: ModelPurpose): string {
    const slot = this.config.modelRoster[purpose]
      ?? (purpose !== 'chat' ? this.config.modelRoster.chat : undefined);
    const model = slot?.model ?? this.config.primaryModel;
    const provider = slot?.provider ?? this.config.primaryProvider;
    const maxTokens = slot?.maxTokens ?? this.config.primaryMaxTokens;
    const contextWindow = slot?.contextWindow ?? this.config.defaultContextWindow;
    return `${purpose}::${provider}::${model}::${maxTokens}::${contextWindow}`;
  }

  private hasVisionAttachments(message?: SubstrateMessage): boolean {
    if (!message?.attachments || message.attachments.length === 0) return false;
    return message.attachments.some((attachment) => this.resolveAttachmentImageContentType(attachment) !== null);
  }

  private resolveTurnModelPurpose(message?: SubstrateMessage): ModelPurpose {
    return this.hasVisionAttachments(message) ? 'vision' : 'chat';
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
    if (this.modelResolved && this.modelSignature === nextSignature && this.agent.state.model) {
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
      else if (entry.source === 'deferred') counts.deferred += 1;
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
      turnId: message.id,
      requestId: message.id,
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
    this.emitTelemetry('agent.tools.adaptive.snapshot', snapshot);

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

  activateExtendedTools(
    toolNames: readonly string[],
    options: ExtendedToolActivationOptions = {},
  ): ExtendedToolActivationResult {
    const requestedTools = normalizeToolNameList(toolNames);
    const byName = new Set(this.extendedTools.map(tool => tool.name));
    const activatedTools: string[] = [];
    const alreadyActiveTools: string[] = [];
    const missingTools: string[] = [];
    const source = options.source ?? 'extended_loaded';
    const telemetryCorrelation = options.correlation;
    const taskKind = options.taskKind ?? null;
    const intent = options.intent ?? null;

    for (const name of requestedTools) {
      if (!byName.has(name)) {
        missingTools.push(name);
        this.emitAdaptiveToolDecision({
          ...this.withAdaptiveCorrelation(telemetryCorrelation, 'agent.tools.adaptive.decision'),
          toolName: name,
          source,
          decision: 'skipped',
          reason: 'not_registered',
          taskKind,
          intent,
        });
        continue;
      }
      const status = this.trackLoadedExtendedTool(name, source);
      if (status === 'activated') {
        activatedTools.push(name);
      } else {
        alreadyActiveTools.push(name);
      }
      this.emitAdaptiveToolDecision({
        ...this.withAdaptiveCorrelation(telemetryCorrelation, 'agent.tools.adaptive.decision'),
        toolName: name,
        source,
        decision: status,
        reason: status === 'activated' ? 'explicit_activation' : 'already_loaded',
        taskKind,
        intent,
      });
    }

    if (activatedTools.length > 0) {
      this.applyActiveToolsToAgent();
    }

    return {
      requestedTools,
      activatedTools,
      alreadyActiveTools,
      missingTools,
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
        intendedAction: Type.Optional(
          Type.String({
            description:
              'Optional follow-up action to execute after this reply when tools were discovered late.',
          }),
        ),
        deferUntilTurnBoundary: Type.Optional(
          Type.Boolean({
            description:
              'Set true when this tool load was discovered late and the intended action should continue post-reply.',
          }),
        ),
        maxRetries: Type.Optional(
          Type.Number({
            description: 'Optional retry cap for deferred continuation (default: 2, max: 4).',
            minimum: 0,
            maximum: 4,
          }),
        ),
      }),
      execute: async (
        _toolCallId: string,
        params: {
          tools: string[];
          intendedAction?: string;
          deferUntilTurnBoundary?: boolean;
          maxRetries?: number;
        },
      ): Promise<AgentToolResult<{ isError?: boolean; deferredToolHandoff?: DeferredToolHandoffIntent }>> => {
        const activation = self.activateExtendedTools(params.tools, {
          source: 'extended_loaded',
          correlation: self.activeTurnCorrelation ?? undefined,
        });
        if (activation.activatedTools.length > 0 || activation.alreadyActiveTools.length > 0) {
          const details: { deferredToolHandoff?: DeferredToolHandoffIntent } = {};
          const contentLines: string[] = [];
          if (activation.activatedTools.length > 0) {
            contentLines.push(
              `Loaded ${activation.activatedTools.length} tools: ${activation.activatedTools.join(', ')}`,
            );
          }
          if (activation.alreadyActiveTools.length > 0) {
            contentLines.push(
              `Already active: ${activation.alreadyActiveTools.join(', ')}`,
            );
          }

          if (activation.missingTools.length > 0) {
            contentLines.push(`Missing tools: ${activation.missingTools.join(', ')}`);
          }

          const handoffTools = [...new Set([
            ...activation.activatedTools,
            ...activation.alreadyActiveTools,
          ])];
          const deferredToolHandoff = params.deferUntilTurnBoundary
            ? normalizeDeferredToolHandoffIntent({
              toolNames: handoffTools,
              intendedAction: params.intendedAction,
              maxRetries: params.maxRetries,
            })
            : null;
          if (deferredToolHandoff) {
            details.deferredToolHandoff = deferredToolHandoff;
            contentLines.push('Queued deferred continuation intent for post-turn execution.');
            for (const toolName of deferredToolHandoff.toolNames) {
              self.emitAdaptiveToolDecision({
                ...self.withAdaptiveCorrelation(undefined, 'agent.tools.adaptive.decision'),
                toolName,
                source: 'deferred',
                decision: 'queued',
                reason: 'defer_until_turn_boundary',
              });
            }
          } else if (params.deferUntilTurnBoundary) {
            contentLines.push('Deferred continuation skipped: provide a non-empty intendedAction.');
            for (const toolName of handoffTools) {
              self.emitAdaptiveToolDecision({
                ...self.withAdaptiveCorrelation(undefined, 'agent.tools.adaptive.decision'),
                toolName,
                source: 'deferred',
                decision: 'skipped',
                reason: 'missing_intended_action',
              });
            }
          }

          return {
            content: [{ type: 'text', text: contentLines.join('\n') }],
            details,
          };
        }
        return textResultWithError(
          `No matching tools found. Available: ${self.extendedTools.map(t => t.name).join(', ')}`,
          true,
        );
      },
    };
  }

  private preloadExtendedToolsForTurn(
    message: SubstrateMessage,
    taskKind: string | undefined,
    correlation: CorrelationMetadata,
  ): AutoloadTurnOutcome {
    const policy = this.extendedToolAutoloadPolicy;
    if (!policy || this.extendedTools.length === 0) {
      return {
        intent: null,
        skipped: [],
      };
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
      return {
        intent,
        skipped: [],
      };
    }

    const access = this.resolveCapabilityAccess();
    const catalog = new Map(this.extendedTools.map(tool => [tool.name, tool]));
    const activated: string[] = [];
    const alreadyActive: string[] = [];
    const unavailable: string[] = [];
    const skippedDenied: Array<{ toolName: string; missingTokens: CapabilityToken[] }> = [];
    const skipped: AdaptiveToolSnapshotSkip[] = [];

    for (const toolName of candidateNames) {
      const tool = catalog.get(toolName);
      if (!tool) {
        unavailable.push(toolName);
        skipped.push({
          toolName,
          source: 'autoload',
          reason: 'not_registered',
        });
        this.emitTelemetry('agent.tools.autoload.skipped', {
          channelId: message.channelId,
          intent,
          taskKind: taskKind ?? null,
          toolName,
          reason: 'not_registered',
          ...this.withCorrelationPurpose(correlation, 'agent.tools.autoload.skipped'),
        });
        this.emitAdaptiveToolDecision({
          ...this.withAdaptiveCorrelation(correlation, 'agent.tools.adaptive.decision'),
          toolName,
          source: 'autoload',
          decision: 'skipped',
          reason: 'not_registered',
          taskKind: taskKind ?? null,
          intent,
        });
        continue;
      }

      const missingTokens = resolveToolRequiredCapabilities(tool, {})
        .filter(token => !access.has(token));
      if (missingTokens.length > 0) {
        skippedDenied.push({ toolName, missingTokens });
        skipped.push({
          toolName,
          source: 'autoload',
          reason: 'capability_denied',
          missingTokens,
        });
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
        this.emitAdaptiveToolDecision({
          ...this.withAdaptiveCorrelation(correlation, 'agent.tools.adaptive.decision'),
          toolName,
          source: 'autoload',
          decision: 'skipped',
          reason: 'capability_denied',
          missingTokens,
          taskKind: taskKind ?? null,
          intent,
        });
        continue;
      }

      const activationState = this.trackLoadedExtendedTool(tool.name, 'autoload');
      if (activationState === 'already_active') {
        alreadyActive.push(tool.name);
      } else {
        activated.push(tool.name);
      }
      this.emitAdaptiveToolDecision({
        ...this.withAdaptiveCorrelation(correlation, 'agent.tools.adaptive.decision'),
        toolName: tool.name,
        source: 'autoload',
        decision: activationState,
        reason: activationState === 'activated' ? 'autoload_candidate' : 'autoload_candidate_already_active',
        taskKind: taskKind ?? null,
        intent,
      });
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

    return {
      intent,
      skipped,
    };
  }

  private async buildTurnUserContent(message: SubstrateMessage): Promise<UserMessage['content']> {
    const imageBlocks = await this.resolveVisionImageContentBlocks(message);
    if (imageBlocks.length === 0) return message.content;

    return [
      { type: 'text', text: message.content },
      ...imageBlocks,
    ];
  }

  private async resolveVisionImageContentBlocks(message: SubstrateMessage): Promise<ImageContent[]> {
    const attachments = message.attachments ?? [];
    if (attachments.length === 0) return [];

    const imageAttachments = attachments
      .map((attachment) => ({
        attachment,
        contentType: this.resolveAttachmentImageContentType(attachment),
      }))
      .filter((entry): entry is { attachment: Attachment; contentType: string } => entry.contentType !== null)
      .slice(0, VISION_ATTACHMENT_MAX_COUNT);
    if (imageAttachments.length === 0) return [];

    const resolved = await Promise.all(
      imageAttachments.map((entry) => this.resolveVisionAttachmentContent(
        message,
        entry.attachment,
        entry.contentType,
      )),
    );
    const blocks = resolved.filter((block): block is ImageContent => block !== null);
    if (blocks.length === 0) {
      log.warn('Vision image attachments present but none were resolved', {
        channelId: message.channelId,
        channelType: message.channelType,
        attachmentCount: imageAttachments.length,
        attachmentHosts: imageAttachments.map((entry) => {
          try {
            return new URL(entry.attachment.url).hostname;
          } catch {
            return 'invalid-url';
          }
        }),
      });
    }
    return blocks;
  }

  private async resolveVisionAttachmentContent(
    message: SubstrateMessage,
    attachment: Attachment,
    inferredContentType: string,
  ): Promise<ImageContent | null> {
    if (message.channelType !== 'discord') {
      return null;
    }

    let attachmentUrl: URL;
    try {
      attachmentUrl = new URL(attachment.url);
    } catch {
      return null;
    }
    if (attachmentUrl.protocol !== 'https:' || !this.isAllowedDiscordVisionAttachmentHost(attachmentUrl.hostname)) {
      return null;
    }

    const visionFetchCapabilities = this.llmClient as unknown as VisionAttachmentFetchCapabilities;
    if (typeof visionFetchCapabilities.webFetchBinary === 'function') {
      try {
        const fetched = await visionFetchCapabilities.webFetchBinary(attachmentUrl.toString(), {
          lane: 'default',
          maxBytes: VISION_ATTACHMENT_MAX_BYTES,
        });
        const responseMimeType = (fetched.mimeType ?? inferredContentType)
          .split(';')[0]
          .trim()
          .toLowerCase();
        if (!responseMimeType.startsWith('image/')) {
          return null;
        }
        if (fetched.sizeBytes <= 0 || fetched.sizeBytes > VISION_ATTACHMENT_MAX_BYTES) {
          return null;
        }
        return {
          type: 'image',
          data: fetched.dataBase64,
          mimeType: responseMimeType,
        };
      } catch (error) {
        log.warn('Gateway binary fetch for Discord image attachment failed', {
          channelId: message.channelId,
          url: attachmentUrl.toString(),
          error: toErrorMessage(error),
        });
        return null;
      }
    }

    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), VISION_ATTACHMENT_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(attachmentUrl.toString(), {
        signal: abortController.signal,
      });
      if (!response.ok) {
        log.debug('Skipping Discord image attachment due to fetch failure', {
          channelId: message.channelId,
          status: response.status,
          url: attachmentUrl.toString(),
        });
        return null;
      }

      const reportedLength = Number.parseInt(response.headers.get('content-length') ?? '', 10);
      if (Number.isFinite(reportedLength) && reportedLength > VISION_ATTACHMENT_MAX_BYTES) {
        log.debug('Skipping Discord image attachment over byte budget', {
          channelId: message.channelId,
          size: reportedLength,
          url: attachmentUrl.toString(),
        });
        return null;
      }

      const responseMimeType = (response.headers.get('content-type') ?? inferredContentType)
        .split(';')[0]
        .trim()
        .toLowerCase();
      if (!responseMimeType.startsWith('image/')) {
        return null;
      }

      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0 || bytes.length > VISION_ATTACHMENT_MAX_BYTES) {
        return null;
      }

      return {
        type: 'image',
        data: bytes.toString('base64'),
        mimeType: responseMimeType,
      };
    } catch (error) {
      log.debug('Skipping Discord image attachment due to retrieval error', {
        channelId: message.channelId,
        url: attachmentUrl.toString(),
        error: toErrorMessage(error),
      });
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private isAllowedDiscordVisionAttachmentHost(hostname: string): boolean {
    const normalized = hostname.trim().toLowerCase();
    if (!normalized) return false;
    if (DISCORD_VISION_ATTACHMENT_HOSTS.has(normalized)) return true;
    return DISCORD_VISION_ATTACHMENT_HOST_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
  }

  private resolveAttachmentImageContentType(attachment: Attachment): string | null {
    const normalizedContentType = attachment.contentType
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (normalizedContentType.startsWith('image/')) {
      return normalizedContentType;
    }

    const candidates = [attachment.name, attachment.url];
    for (const candidate of candidates) {
      const inferred = inferImageMimeTypeFromAttachmentCandidate(candidate);
      if (inferred) return inferred;
    }

    return null;
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
      const responseStyle = this.resolveResponseStyle(message, channelType, channelMeta);
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
        responseStyle,
        runtimeNow,
        taskKind,
        templateVariables,
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
        ),
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
        this.agent.setSystemPrompt(enforceUntrustedCompactionGuard(context.systemPrompt));
        const autoloadOutcome = this.preloadExtendedToolsForTurn(message, taskKind, turnCorrelationBase);
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
          originType: turnCallType,
          originStage: 'agent.turn.prompt',
          purpose: 'agent.turn.prompt',
        });
        this.activeTurnCorrelation = turnCorrelationBase;
        const turnUserContent = await this.buildTurnUserContent(message);
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
          this.bridge.clearChannel();
          this.activeTurnCorrelation = null;
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
        if (this.hasVisionAttachments(message) && responseText.trim().length === 0) {
          const assistantMessage = this.getLatestAssistantMessage();
          log.warn('Vision turn produced empty assistant text; attempting recovery reply', {
            channelId: message.channelId,
            model: this.agent.state.model?.id ?? null,
            stopReason: assistantMessage?.stopReason ?? null,
            errorMessage: assistantMessage?.errorMessage ?? null,
          });

          // Recovery always falls back to chat slot so the user gets a response
          // even when the configured vision deployment is unavailable.
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

          const recoveryNote = assistantMessage?.errorMessage
            ? `Runtime note: the previous vision reply produced no text (${assistantMessage.errorMessage}). Respond to the user's latest image turn now. If the image could not be processed, clearly say so and ask for resend.`
            : 'Runtime note: the previous vision reply produced no text. Respond to the user\'s latest image turn now. If the image could not be processed, clearly say so and ask for resend.';

          const runVisionRecoveryPrompt = async (
            content: string,
            requestSuffix: string,
            originStage: string,
          ): Promise<void> => {
            this.bridge.setChannel(message.channelId, {
              turnId: message.id,
              requestId: `${message.id}:${requestSuffix}`,
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
              this.bridge.clearChannel();
              this.activeTurnCorrelation = null;
            }
          };

          await runVisionRecoveryPrompt(
            recoveryNote,
            'vision-recovery',
            'agent.turn.vision_recovery',
          );

          turnMessages = this.agent.state.messages.slice(turnStartMessageIndex);
          turnUsage = this.accumulateTurnUsage(turnMessages);
          responseModel = this.agent.state.model?.id ?? responseModel;
          responseText = this.extractResponseText();

          if (responseText.trim().length === 0) {
            log.warn('Vision recovery reply was empty; attempting strict non-empty recovery reply', {
              channelId: message.channelId,
              model: this.agent.state.model?.id ?? null,
            });

            await runVisionRecoveryPrompt(
              'Runtime note: the previous recovery reply was empty. Reply now with exactly one short sentence. If the image could not be processed, clearly say so and ask for resend.',
              'vision-recovery-strict',
              'agent.turn.vision_recovery_strict',
            );

            turnMessages = this.agent.state.messages.slice(turnStartMessageIndex);
            turnUsage = this.accumulateTurnUsage(turnMessages);
            responseModel = this.agent.state.model?.id ?? responseModel;
            responseText = this.extractResponseText();
          }

          if (responseText.trim().length === 0) {
            log.warn('Vision turn remained empty after recovery attempts', {
              channelId: message.channelId,
              model: this.agent.state.model?.id ?? null,
            });
          }
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
          originType: this.resolveTurnCallType(message, this.resolveTaskKind(message)),
          originStage: 'agent.moa.turn',
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
      originType: callType,
      originStage: 'agent.turn',
    };
  }

  private withCorrelationPurpose(
    correlation: CorrelationMetadata,
    purpose: string,
  ): CorrelationMetadata {
    return {
      ...correlation,
      purpose,
      originStage: purpose,
    };
  }

  private withAdaptiveCorrelation(
    correlation: CorrelationMetadata | undefined,
    purpose: string,
  ): Partial<CorrelationMetadata> {
    if (correlation) {
      return this.withCorrelationPurpose(correlation, purpose);
    }
    if (this.activeTurnCorrelation) {
      return this.withCorrelationPurpose(this.activeTurnCorrelation, purpose);
    }
    return { purpose };
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

  private resolveRuntimeCharacterName(characterPromptVariables: Record<string, string>): string {
    const candidates = [
      characterPromptVariables.char,
      characterPromptVariables.char_name,
      characterPromptVariables.character,
      characterPromptVariables.character_name,
      characterPromptVariables['character.name'],
      characterPromptVariables.name,
    ];
    for (const candidate of candidates) {
      const trimmed = candidate?.trim();
      if (trimmed && trimmed.length > 0) {
        return trimmed;
      }
    }
    return this.characterName;
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
    const characterPromptVariables = this.resolveCharacterPromptVariables();
    const runtimeCharacterName = this.resolveRuntimeCharacterName(characterPromptVariables);
    this.characterName = runtimeCharacterName;

    return {
      ...characterPromptVariables,
      user: resolvedUserName,
      user_name: resolvedUserName,
      user_id: message.authorId,
      char: runtimeCharacterName,
      char_name: runtimeCharacterName,
      character: runtimeCharacterName,
      character_name: runtimeCharacterName,
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
    responseStyle: ResponseStyle = 'concise',
    now: Date = new Date(),
    taskKind?: string,
    templateVariables?: Record<string, string>,
  ): string {
    const visibility = classifyChannel(message.channelId, { isDirectMessage: message.isDirectMessage });
    const modelId = this.agent.state.model?.id ?? this.config.primaryModel;
    const contextWindow = this.resolveContextWindow();
    const extendedCount = this.extendedTools.length;
    const activeResolution = this.resolveActiveTools();
    const {
      core: coreCount,
      promoted: promotedCount,
      extendedLoaded: extendedLoadedCount,
      autoload: autoloadCount,
      deferred: deferredCount,
      total: activeCount,
    } = activeResolution.counts;
    const capabilityAccess = this.resolveCapabilityAccess();
    const capabilityTier = capabilityAccess.getTier();
    const skillsContext = this.skillsRuntime?.getPromptXml() ?? '';
    const responseStyleGuidance = getResponseStylePromptGuidance(responseStyle);
    const extendedBreakdown = [
      extendedLoadedCount > 0 ? `${extendedLoadedCount} loaded` : null,
      autoloadCount > 0 ? `${autoloadCount} autoload` : null,
      deferredCount > 0 ? `${deferredCount} deferred` : null,
    ].filter(Boolean).join(' + ');

    const lines = [
      '[Runtime Context]',
      `Current time: ${now.toISOString()}`,
      `Channel: ${message.channelId} (type: ${channelType ?? 'unknown'}, visibility: ${visibility})`,
      `Speaking with: ${resolvedUserName} (userId: ${message.authorId}, canonicalId: ${canonicalContactKey ?? message.authorId}, trust: ${trustLevel})`,
      `Model: ${modelId}`,
      `Response style preference: ${responseStyle}`,
      `Capability tier: ${capabilityTier}`,
      `Context window: ${contextWindow} tokens`,
      `Tools: ${activeCount} active`
      + ` (${coreCount} core`
      + (promotedCount > 0 ? ` + ${promotedCount} promoted` : '')
      + (extendedBreakdown ? ` + ${extendedBreakdown}` : '')
      + ')'
      + (extendedCount > 0 ? `, ${extendedCount} available via load_tools` : ''),
    ];

    const isScheduledTask = taskKind === 'heartbeat' || taskKind === 'reflection' || message.channelId.startsWith('internal:');
    if (isScheduledTask) {
      const promptVariables = templateVariables ?? this.resolveCharacterPromptVariables();
      const appearance = (
        promptVariables['character.visual_description']
        || promptVariables.extensions_visual_description
        || promptVariables.visual_description
        || ''
      ).trim();
      if (appearance.length > 0) {
        lines.push(`Appearance context: ${appearance}`);
      }
    }

    // Tool directory for extended tools
    if (extendedCount > 0) {
      const promotedNames = this.getCapabilityEligiblePromotedToolNames();
      lines.push('');
      lines.push('Available extended tools:');
      for (const t of this.extendedTools) {
        const loaded = this.loadedExtended.get(t.name);
        let suffix = ' (use load_tools to activate)';
        if (promotedNames.has(t.name)) {
          suffix = ' (promoted, always active)';
        } else if (loaded?.source === 'autoload') {
          suffix = ' (autoload active)';
        } else if (loaded?.source === 'deferred') {
          suffix = ' (deferred active)';
        } else if (loaded?.source === 'extended_loaded') {
          suffix = ' (loaded active)';
        }
        lines.push(`- ${t.name}: ${t.description.split('.')[0]}${suffix}`);
      }
    }

    lines.push('');
    lines.push('[Response Style Guidance]');
    lines.push(responseStyleGuidance);

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

function inferImageMimeTypeFromAttachmentCandidate(candidate: string | null | undefined): string | null {
  if (!candidate) return null;
  const trimmed = candidate.trim();
  if (!trimmed) return null;

  let pathCandidate = trimmed;
  try {
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      const parsed = new URL(trimmed);
      const fromQuery = inferImageMimeTypeFromQueryParams(parsed.searchParams);
      if (fromQuery) return fromQuery;
      pathCandidate = parsed.pathname;
    }
  } catch {
    pathCandidate = trimmed;
  }

  const lowerPath = pathCandidate.toLowerCase();
  for (const [extension, mimeType] of Object.entries(VISION_ATTACHMENT_EXTENSION_TO_MIME)) {
    if (lowerPath.endsWith(extension)) {
      return mimeType;
    }
  }
  return null;
}

function inferImageMimeTypeFromQueryParams(searchParams: URLSearchParams): string | null {
  for (const key of VISION_ATTACHMENT_FORMAT_QUERY_KEYS) {
    const raw = searchParams.get(key)?.trim().toLowerCase();
    if (!raw) continue;
    const normalized = raw.startsWith('.') ? raw : `.${raw}`;
    const mimeType = VISION_ATTACHMENT_EXTENSION_TO_MIME[normalized];
    if (mimeType) return mimeType;
  }
  return null;
}
