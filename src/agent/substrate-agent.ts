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
  ContextMessage,
  SubstrateConfig,
  SubstrateMessage,
  TurnUsage,
} from '../types.js';
import type { ContactStore } from '../contacts/store.js';
import type { Contact } from '../contacts/types.js';
import type { LLMProvider, MemoryProvider, MemoryExtractor, ScratchpadProvider } from './contracts.js';
import type { TrustLevel } from '../trust/types.js';
import { classifyChannel, type ChannelMeta } from '../trust/policy.js';
import type { ChannelPromptDock } from '../channels/types.js';
import type { PromptComposer } from '../identity/prompt-composer.js';
import type { ComposeContext, ComposeSplitResult } from '../identity/prompt-types.js';
import { createSubstrateStreamFn, resolveModel } from './stream-adapter.js';
import { convertToLlm } from './messages.js';
import { createEventBridge, type EventBridge } from './event-bridge.js';
import { createComponentLogger } from '../logger.js';
import { injectPromptRuntimeTokens } from '../identity/prompt-runtime.js';
import type { SkillsRuntime } from '../skills/runtime.js';
import type { ToolCategory } from './tool-registrar.js';
import { gateToolWithCapabilities, type CapabilityAccess } from '../capabilities/gate.js';
import { CapabilityRuntime } from '../capabilities/runtime.js';
import { normalizeCapabilityTier, resolveTierCapabilityTokens } from '../capabilities/tiers.js';
import type { CapabilityToken } from '../capabilities/tokens.js';
import { tagToolWithReversibility } from '../capabilities/safeguards.js';
import { textResult, textResultWithError } from '../tools/results.js';
import { toErrorMessage } from '../utils/errors.js';
import {
  classifyBroadcastDraft,
  resolveBroadcastVisibilityScope,
} from '../broadcast/safety.js';

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
  private frozenPromptPrefixCache = new Map<string, FrozenPromptPrefix>();

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
  private ensureModel(): void {
    this.refreshModelFromConfig('turn-start');
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

  private refreshModelFromConfig(reason: 'startup' | 'turn-start' | 'settings-update'): void {
    const nextSignature = this.getChatModelSignature();
    if (this.modelResolved && this.modelSignature === nextSignature && this.agent.state.model) {
      return;
    }

    try {
      const resolved = resolveModel(this.config);
      this.agent.setModel(resolved);
      this.modelResolved = true;
      this.modelSignature = nextSignature;
      log.info('Resolved runtime chat model', {
        reason,
        model: resolved.id,
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

  getToolCatalog(): { core: readonly AgentTool<any>[]; extended: readonly AgentTool<any>[] } {
    return {
      core: [...this.coreTools],
      extended: [...this.extendedTools],
    };
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
        const matched = self.extendedTools.filter(t => params.tools.includes(t.name));
        for (const t of matched) self.loadedExtended.add(t.name);
        const active = [
          ...self.coreTools,
          ...self.extendedTools.filter(t => self.loadedExtended.has(t.name)),
        ];
        self.agent.setTools(self.withCapabilityGates(active));
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

  /** Abort the current prompt, cancelling streaming and tool execution */
  abort(): void {
    this.agent.abort();
  }

  async handleMessage(message: SubstrateMessage): Promise<AgentResponse> {
    const startTime = Date.now();
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

    await this.eventBus.emit('agent.turn.start', { message });

    const trustStageStart = Date.now();
    const authorContext = this.resolveAuthorContext(message);
    this.emitTurnStage(message, startTime, 'trust', {
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
      this.emitTurnStage(message, startTime, 'memory', {
        durationMs: Date.now() - memoryStageStart,
        hasMemoryProvider: memoryProvider != null,
        memoryChars: memoryContextBlock.length,
        proactiveRecallChars: proactiveRecallBlock.length,
        proactiveRecallIncluded: proactiveRecallBlock.length > 0,
        scratchpadChars: scratchpadBlock.length,
        scratchpadIncluded: scratchpadBlock.length > 0,
      });

      // Compose system prompt as static prefix + dynamic suffix.
      const channelType = this.resolveChannelType(message);
      const taskKind = this.resolveTaskKind(message);
      const promptSections = this.composePromptSections({ channelType, taskKind });

      const runtimeNow = new Date();
      const templateVariables = this.buildPromptTemplateVariables(
        message,
        trustLevel,
        channelType,
        authorContext.canonicalContactKey,
        runtimeNow,
      );
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

      // Runtime context — date/time, channel, user, model info
      const runtimeContext = this.buildRuntimeContext(
        message,
        trustLevel,
        channelType,
        authorContext.canonicalContactKey,
        runtimeNow,
      );
      const fullPrompt = [staticPrefix, dynamicSuffix, runtimeContext, scratchpadBlock]
        .map(section => section.trim())
        .filter(section => section.length > 0)
        .join('\n\n');

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
      this.emitTurnStage(message, startTime, 'context', {
        durationMs: Date.now() - contextStageStart,
        contextMessages: context.messages.length,
        systemPromptChars: context.systemPrompt.length,
      });

      // Configure pi-agent-core Agent for this turn
      this.ensureModel();
      this.agent.setSystemPrompt(context.systemPrompt);
      this.loadedExtended.clear();
      this.agent.setTools(this.withCapabilityGates(this.coreTools));

      // Convert ContextMessage[] to AgentMessage[] for the Agent.
      // Exclude the last message (the user message we just recorded) —
      // agent.prompt() will re-add it, avoiding duplication.
      const agentMessages = this.contextToAgentMessages(context.messages);
      const historyMessages = agentMessages.length > 0 ? agentMessages.slice(0, -1) : [];
      this.agent.replaceMessages(historyMessages);
      const turnStartMessageIndex = this.agent.state.messages.length;

      const promptStageStart = Date.now();
      let firstTokenAt: number | null = null;
      const streamTelemetryBus = this.eventBus as unknown as {
        on: (event: string, handler: (data: { channelId: string; text: string }) => void) => () => void;
      };
      const unsubscribeFirstToken = streamTelemetryBus.on('agent.stream.delta', ({ channelId }) => {
        if (channelId !== message.channelId || firstTokenAt != null) return;
        firstTokenAt = Date.now();
        this.emitTurnStage(message, startTime, 'first-token', {
          ttftMs: firstTokenAt - startTime,
          source: 'stream',
        });
      });

      // Activate event bridge for this channel (streams deltas + tool events to EventBus)
      this.bridge.setChannel(message.channelId);
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
      if (firstTokenAt == null) {
        firstTokenAt = Date.now();
        this.emitTurnStage(message, startTime, 'first-token', {
          ttftMs: firstTokenAt - startTime,
          source: 'fallback',
        });
      }
      this.emitTurnStage(message, startTime, 'prompt', {
        durationMs: Date.now() - promptStageStart,
        ttftMs: firstTokenAt - startTime,
      });

      const turnMessages = this.agent.state.messages.slice(turnStartMessageIndex);
      const turnUsage = this.accumulateTurnUsage(turnMessages);

      // Extract response from agent state (last assistant message)
      const responseText = this.extractResponseText();
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
        });

        if (approvalRequired) {
          this.emitTelemetry('broadcast.approval.required', {
            channelId: message.channelId,
            signals: classification.signals,
            visibilityScope,
            draftLength: responseText.length,
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

      const agentResponse: AgentResponse = {
        content: safeResponseText,
        channelId: message.channelId,
        metadata: {
          model: this.agent.state.model?.id ?? 'unknown',
          inputTokens: turnUsage.inputTokens,
          outputTokens: turnUsage.outputTokens,
          durationMs: Date.now() - startTime,
          ...(broadcastSafetyMeta ? { broadcastSafety: broadcastSafetyMeta } : {}),
        },
      };

      await this.eventBus.emit('agent.turn.end', { message, response: agentResponse });
      await this.eventBus.emit('agent.turn.usage', { message, usage: turnUsage });
      this.emitTurnStage(message, startTime, 'end', {
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
      await this.eventBus.emit('agent.error', { message, error: err });
      throw err;
    } finally {
      unsubscribeRetrieval();
    }
  }

  // ── Private helpers ──

  private emitTurnStage(
    message: SubstrateMessage,
    turnStartMs: number,
    stage: TurnStageName,
    payload: Record<string, unknown>,
  ): void {
    const telemetry = {
      turnId: message.id,
      channelId: message.channelId,
      stage,
      elapsedMs: Math.max(0, Date.now() - turnStartMs),
      ...payload,
    };
    log.debug('Turn stage telemetry', telemetry);
    this.emitTelemetry('agent.turn.stage', telemetry);
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
    return this.config.modelRoster.chat?.contextWindow ?? this.config.defaultContextWindow;
  }

  private isAssistantAgentMessage(message: AgentMessage): message is AssistantMessage {
    return (message as { role?: string }).role === 'assistant';
  }

  private isToolResultAgentMessage(message: AgentMessage): message is ToolResultMessage {
    return (message as { role?: string }).role === 'toolResult';
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
    trustLevel: TrustLevel,
    channelType: string | undefined,
    canonicalContactKey: string | undefined,
    now: Date,
  ): Record<string, string> {
    const visibility = classifyChannel(message.channelId, { isDirectMessage: message.isDirectMessage });
    const modelId = this.agent.state.model?.id ?? this.config.primaryModel;

    return {
      user: message.authorName,
      user_name: message.authorName,
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
    const capabilityAccess = this.resolveCapabilityAccess();
    const capabilityTier = capabilityAccess.getTier();
    const skillsContext = this.skillsRuntime?.getPromptXml() ?? '';

    const lines = [
      '[Runtime Context]',
      `Current time: ${now.toISOString()}`,
      `Channel: ${message.channelId} (type: ${channelType ?? 'unknown'}, visibility: ${visibility})`,
      `Speaking with: ${message.authorName} (userId: ${message.authorId}, canonicalId: ${canonicalContactKey ?? message.authorId}, trust: ${trustLevel})`,
      `Model: ${modelId}`,
      `Capability tier: ${capabilityTier}`,
      `Context window: ${contextWindow} tokens`,
      `Tools: ${coreCount} active` + (extendedCount > 0 ? `, ${extendedCount} available via load_tools` : ''),
    ];

    // Tool directory for extended tools
    if (extendedCount > 0) {
      lines.push('');
      lines.push('Available extended tools (use load_tools to activate):');
      for (const t of this.extendedTools) {
        lines.push(`- ${t.name}: ${t.description.split('.')[0]}`);
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

  private resolveAuthorContext(message: SubstrateMessage): ResolvedAuthorContext {
    // Internal system channels are self-context (heartbeat/reflection/planning).
    // They should use full private trust for memory access.
    if (message.channelId.startsWith('internal:')) {
      return {
        trustLevel: 'primary',
        canonicalContactKey: message.authorId,
        continuityFallbackKeys: [],
      };
    }

    if (!message.authorId || !this.contactStore) {
      return {
        trustLevel: 'regular',
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
        continuityFallbackKeys: [],
      };
    }
  }
}
