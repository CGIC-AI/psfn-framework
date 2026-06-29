// ── ShardManager ──
// Manages bounded subagent launches plus shard routing/state for parallel task execution.
// Bounded launches share parent's heavy resources (LLM, DB, memory) but get isolated channelIds.

import { randomUUID } from 'node:crypto';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { CapabilityTier, ShardToolsetConfig, SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { sanitizeCoreSubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { SubstrateMessage } from '../../shared/contracts/runtime.js';
import { resolvePresenceSubjectId } from '../../core/agent/presence-metadata.js';
import type { EventBus } from '../../shared/event-bus.js';
import type { LLMProviderPort, EmbeddingProviderPort, MemoryProvider } from '../../core/agent/contracts.js';
import { SubstrateAgent } from '../../core/agent/substrate-agent.js';
import {
  createActiveEmanationSatellitePresencePort,
  type SatellitePresencePort,
  type SatelliteRoutingMetadata,
} from '../../core/agent/satellite-adapter-port.js';
import type { RuntimeMode } from '../../core/agent/tool-wiring-validator.js';
import { normalizeCapabilityTier } from '../../system/capabilities/tiers.js';
import { evaluateCompositionalPolicyForChannelId } from '../../system/capabilities/compositional-policy.js';
import type { SessionStore } from '../../persistence/sessions/store.js';
import { SessionManager } from '../../core/session/manager.js';
import type { SessionEntry } from '../../core/session/types.js';
import {
  evaluateShardSessionMemorySyncPolicy,
  type ShardSessionMemorySyncDecision,
  type ShardSessionMemorySyncEnvelope,
} from '../../boundary/gateway/policy.js';
import { appendShardSessionMemorySyncAudit } from '../../persistence/jsonl.js';
import type { ShardExecutionPort } from './port.js';
import { chargeSurface, getRunChargeContext, runWithChargeContext } from '../../shared/telemetry/run-charge.js';
import type {
  ShardConfig,
  ShardContextPack,
  ShardContextPackEntry,
  ShardHealthState,
  ShardLifecycleState,
  ShardResult,
  ShardRuntimeRecord,
  ShardSourceContext,
} from './types.js';
import { buildShardLineageEnvelope, deriveShardCompanionId } from './result-lineage.js';
import { getRequestContext } from '../../primitives/llm/request-context.js';
import { AGENT_LOOP_MAX_ASSISTANT_STEPS_PER_RUN } from '../../core/agent/turn-limits.js';
import {
  createArtifactReturnPort,
  type ArtifactReturnBatch,
  type ArtifactReturnPort,
} from './artifact-return-port.js';
import {
  createEmptyShardMergeReview,
  resolveStagedShardMemoryOutputs,
  computeShardMergeReviewBlockingReasons,
} from './output-review.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import { textResultWithError } from '../../core/tools/results.js';
import type {
  ShardFoldReviewController,
  ShardFoldReviewRecord,
  ShardFoldReviewResolveParams,
} from './fold-review.js';
import {
  type BoundedSubagentLaunchSummary,
  type SubagentExecutionPort,
} from '../../core/agent/substrate-agent/bounded-subagent-contract.js';
import {
  resolveCompanionIdFromConfig,
  resolveCompanionNameFromConfig,
} from '../../core/identity/companion-runtime.js';

const DEFAULT_MAX_CONCURRENT = 5;
const DEFAULT_MAX_TURNS = 1;
const DEFAULT_SHARD_HEARTBEAT_STALE_AFTER_MS = 60_000;
const DEFAULT_SHARD_HEARTBEAT_DISCONNECT_MULTIPLIER = 3;
const CONTEXT_PACK_SESSION_SCAN_LIMIT = 12;
const CONTEXT_PACK_SESSION_ENTRY_LIMIT = 6;
const CONTEXT_PACK_ENTRY_CONTENT_MAX_CHARS = 600;
const CONTEXT_PACK_MEMORY_MAX_CHARS = 4_000;
const DEFAULT_SHARD_CAPABILITIES = ['general'] as const;
const SHARD_TOOLSET_ALL = '*';
const SHARD_SYNC_POLICY_VERSION = 1;
const SHARD_SYNC_MEMORY_TARGET = 'memory:index';
const INTERNAL_SHARD_SOURCE_PARAM = '__psfnShardSource';
const BLOCKED_SHARD_TOOL_NAMES = new Set([
  'subagent',
  'spawn_subagent',
  'load_tools',
  'memory_write',
  'memory_import_batch',
  'memory_patch',
  'memory_redact',
  'memory_delete',
  'undo_memory_delete',
  'scratchpad_read',
  'scratchpad_write',
  'contact_list',
  'contact_lookup',
  'contact_note',
  'contact_set_trust',
  'contact_link_identity',
  'contact_set_channel_privacy',
  'contact_set_machine_intelligence',
]);
const APPRENTICE_SHARD_TOOL_EXTRAS = [
] as const;
export const DEFAULT_SHARD_TOOLSET = [
  'memory',
  'contact',
  'repo_status',
  'repo_diff',
] as const;

const DEFAULT_SHARD_TOOLSETS_BY_TIER: Readonly<Record<CapabilityTier, readonly string[]>> = {
  nursery: DEFAULT_SHARD_TOOLSET,
  apprentice: [...DEFAULT_SHARD_TOOLSET, ...APPRENTICE_SHARD_TOOL_EXTRAS],
  autonomous: [SHARD_TOOLSET_ALL],
  custom: [SHARD_TOOLSET_ALL],
};

function normalizeShardMaxTurns(value: unknown): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_TURNS;
  return Math.max(1, Math.min(AGENT_LOOP_MAX_ASSISTANT_STEPS_PER_RUN, Math.trunc(value as number)));
}

const SHARD_STATE_TRANSITIONS: Readonly<Record<ShardLifecycleState, readonly ShardLifecycleState[]>> = {
  registering: ['ready', 'degraded', 'offline'],
  ready: ['degraded', 'offline'],
  degraded: ['ready', 'offline'],
  offline: [],
};

export interface ShardToolCatalog {
  core: readonly AgentTool<any>[];
  extended: readonly AgentTool<any>[];
}

export interface ShardAuditTrail {
  append(event: string, details?: Record<string, unknown>): unknown;
}

export interface ShardManagerDeps {
  eventBus: EventBus;
  llmProvider: LLMProviderPort;
  sessionStore: SessionStore;
  sessionManager?: SessionManager | null;
  embeddingService: EmbeddingProviderPort | null;
  memoryProvider: MemoryProvider | null;
  config: SubstrateConfig;
  parentSystemPrompt: string;
  maxConcurrent?: number;
  heartbeatStaleAfterMs?: number;
  heartbeatDisconnectAfterMs?: number;
  shardToolsets?: ShardToolsetConfig;
  toolCatalogProvider?: () => ShardToolCatalog;
  auditTrail?: ShardAuditTrail;
  runtimeMode?: RuntimeMode;
  shardSessionMemorySyncAuditPath?: string;
  artifactReturnPort?: ArtifactReturnPort;
  satellitePresencePort?: SatellitePresencePort;
  foldReviewController?: ShardFoldReviewController | null;
}

export interface SatelliteDelegationRequest {
  message: SubstrateMessage;
  routing?: SatelliteRoutingMetadata;
  shardName?: string;
}

export interface ActiveShard {
  id: string;
  name: string;
  task: string;
  startedAt: number;
  channelId: string;
  state: ShardLifecycleState;
  stateReason: string;
  health: ShardHealthState;
  lastTransitionAt: number;
  lastHeartbeatAt: number;
  heartbeatStaleAfterMs: number;
  heartbeatDisconnectAfterMs: number;
  capabilities: string[];
  requiredCapabilities: string[];
  failureReason?: string;
}

export class ShardManager implements ShardExecutionPort, SubagentExecutionPort {
  private deps: ShardManagerDeps;
  private auditTrail: ShardAuditTrail | null;
  private artifactReturnPort: ArtifactReturnPort;
  private satellitePresencePort: SatellitePresencePort;
  private activeCount = 0;
  private maxConcurrent: number;
  private heartbeatStaleAfterMs: number;
  private heartbeatDisconnectAfterMs: number;
  private activeShards = new Map<string, ActiveShard>();
  private activeShardChannels = new Map<string, Set<string>>();
  private foldReviewController: ShardFoldReviewController | null;

  constructor(deps: ShardManagerDeps) {
    this.deps = deps;
    this.maxConcurrent = deps.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this.heartbeatStaleAfterMs = normalizeHeartbeatStaleAfterMs(
      deps.heartbeatStaleAfterMs,
      DEFAULT_SHARD_HEARTBEAT_STALE_AFTER_MS,
    );
    this.heartbeatDisconnectAfterMs = normalizeHeartbeatDisconnectAfterMs(
      deps.heartbeatDisconnectAfterMs,
      this.heartbeatStaleAfterMs,
      this.heartbeatStaleAfterMs * DEFAULT_SHARD_HEARTBEAT_DISCONNECT_MULTIPLIER,
    );
    this.auditTrail = deps.auditTrail ?? null;
    this.artifactReturnPort = deps.artifactReturnPort ?? createArtifactReturnPort();
    this.satellitePresencePort = deps.satellitePresencePort ?? createActiveEmanationSatellitePresencePort();
    this.foldReviewController = deps.foldReviewController ?? null;
    this.installAuditHooks();
  }

  async spawn(shardConfig: ShardConfig): Promise<ShardResult> {
    const activeChargeContext = getRunChargeContext();
    const chargePolicy = this.deps.config.chargePolicy ?? activeChargeContext?.chargePolicy;
    if (!activeChargeContext && chargePolicy) {
      return runWithChargeContext({
        chargePolicy,
        eventBus: this.deps.eventBus,
        lane: 'interactive',
        correlation: getRequestContext(),
      }, async () => this.spawn(shardConfig));
    }

    this.refreshShardHealth();
    const shardId = `shard-${randomUUID()}`;
    const channelId = `shard:${shardId}`;
    const coreCompanionId = resolveCompanionIdFromConfig(this.deps.config);
    const coreCompanionName = resolveCompanionNameFromConfig(this.deps.config);
    const shardCompanionId = deriveShardCompanionId(coreCompanionId, shardId);
    const shardRuntimeConfig: SubstrateConfig = {
      ...this.deps.config,
      companionId: shardCompanionId,
    };
    const contextPack = shardConfig.contextPack
      ? this.withCompanionNameForContextPack(shardConfig.contextPack, coreCompanionName)
      : await this.buildContextPack(
        shardId,
        channelId,
        shardConfig,
        coreCompanionName,
      );
    const preparedConfig = contextPack
      ? { ...shardConfig, contextPack }
      : shardConfig;
    const baseMessage: SubstrateMessage = {
      id: shardId,
      channelId,
      channelType: 'api',
      authorId: coreCompanionId,
      authorName: coreCompanionName,
      content: shardConfig.task,
      timestamp: new Date(),
    };
    const lineage = buildShardLineageEnvelope({
      kind: 'spawn',
      coreCompanionId,
      shardId,
      shardChannelId: channelId,
      sourceMessage: baseMessage,
      ...(shardConfig.sourceContext ? { sourceContext: shardConfig.sourceContext } : {}),
    });
    if (chargePolicy) {
      return runWithChargeContext({
        chargePolicy,
        eventBus: this.deps.eventBus,
        lane: 'shard',
        runId: shardId,
        correlation: getRequestContext(),
      }, async () => this.executeShard(shardId, channelId, preparedConfig, baseMessage, lineage, shardRuntimeConfig));
    }
    return this.executeShard(shardId, channelId, preparedConfig, baseMessage, lineage, shardRuntimeConfig);
  }

  async executeSubagent(shardConfig: ShardConfig): Promise<BoundedSubagentLaunchSummary> {
    const activeChargeContext = getRunChargeContext();
    const chargePolicy = this.deps.config.chargePolicy ?? activeChargeContext?.chargePolicy;
    if (!activeChargeContext && chargePolicy) {
      return runWithChargeContext({
        chargePolicy,
        eventBus: this.deps.eventBus,
        lane: 'interactive',
        correlation: getRequestContext(),
      }, async () => this.executeSubagent(shardConfig));
    }

    chargeSurface('subagentLaunch', {
      details: {
        name: shardConfig.name,
        ...(shardConfig.maxTurns !== undefined ? { maxTurns: shardConfig.maxTurns } : {}),
      },
    });

    const result = await this.spawn(shardConfig);
    return {
      subagentId: result.shardId,
      name: result.name,
      content: result.content,
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      durationMs: result.durationMs,
      turns: result.turns,
      lifecycleState: result.lifecycleState,
      health: result.health,
      stateReason: result.stateReason,
      ...(result.failureReason ? { failureReason: result.failureReason } : {}),
      capabilities: [...result.capabilities],
      requiredCapabilities: [...result.requiredCapabilities],
      ...(result.artifactReturn ? { artifactReturn: result.artifactReturn } : {}),
    };
  }

  async delegateSatelliteSession(request: SatelliteDelegationRequest): Promise<ShardResult> {
    const activeChargeContext = getRunChargeContext();
    const chargePolicy = this.deps.config.chargePolicy ?? activeChargeContext?.chargePolicy;
    if (!activeChargeContext && chargePolicy) {
      return runWithChargeContext({
        chargePolicy,
        eventBus: this.deps.eventBus,
        lane: 'interactive',
        correlation: getRequestContext(),
      }, async () => this.delegateSatelliteSession(request));
    }

    this.refreshShardHealth();
    const content = request.message.content.trim();
    if (!content) {
      throw new Error('Satellite shard delegation requires non-empty message content.');
    }

    const routing = request.routing ?? request.message.routing?.wyoming;
    const shardId = `wyoming-shard-${randomUUID()}`;
    const coreCompanionId = resolveCompanionIdFromConfig(this.deps.config);
    const shardCompanionId = deriveShardCompanionId(coreCompanionId, shardId);
    const shardRuntimeConfig: SubstrateConfig = {
      ...this.deps.config,
      companionId: shardCompanionId,
    };
    const presenceSubjectId = resolvePresenceSubjectId(routing?.presence) ?? routing?.satelliteId?.trim();
    const routeCapabilities = this.resolveWyomingRouteCapabilities(routing, presenceSubjectId);
    const shardName = request.shardName?.trim()
      || this.resolveWyomingShardName(routing, presenceSubjectId);
    const embodimentContext = this.satellitePresencePort.resolveCanonicalEmbodiment(routing?.presence);
    const shardConfig: ShardConfig = {
      name: shardName,
      task: request.message.content,
      maxTurns: 1,
      capabilities: routeCapabilities,
      requiredCapabilities: routeCapabilities,
      sourceContext: {
        channelId: request.message.channelId,
        requestId: request.message.id,
        ...(routing?.turnId ? { turnId: routing.turnId } : {}),
        ...(embodimentContext ? { embodimentContext } : {}),
      },
    };
    this.auditTrail?.append('satellite.shard.delegate.start', {
      shardId,
      channelId: request.message.channelId,
      messageId: request.message.id,
      connectionId: routing?.connectionId,
      sessionId: routing?.sessionId,
      turnId: routing?.turnId,
      siteId: routing?.siteId,
      satelliteId: routing?.satelliteId,
      presence: routing?.presence,
    });
    const lineage = buildShardLineageEnvelope({
      kind: 'wyoming',
      coreCompanionId,
      shardId,
      shardChannelId: request.message.channelId,
      sourceMessage: request.message,
      ...(routing ? { satelliteRouting: routing } : {}),
    });

    try {
      const result = chargePolicy
        ? await runWithChargeContext({
          chargePolicy,
          eventBus: this.deps.eventBus,
          lane: 'shard',
          runId: shardId,
          correlation: getRequestContext(),
        }, async () => this.executeShard(
          shardId,
          request.message.channelId,
          shardConfig,
          request.message,
          lineage,
          shardRuntimeConfig,
        ))
        : await this.executeShard(
          shardId,
          request.message.channelId,
          shardConfig,
          request.message,
          lineage,
          shardRuntimeConfig,
        );
      this.auditTrail?.append('satellite.shard.delegate.end', {
        shardId,
        status: 'completed',
        durationMs: result.durationMs,
        channelId: request.message.channelId,
        messageId: request.message.id,
        connectionId: routing?.connectionId,
        sessionId: routing?.sessionId,
        turnId: routing?.turnId,
      });
      return result;
    } catch (error) {
      const message = toErrorMessage(error);
      this.auditTrail?.append('satellite.shard.delegate.end', {
        shardId,
        status: 'failed',
        error: message,
        channelId: request.message.channelId,
        messageId: request.message.id,
        connectionId: routing?.connectionId,
        sessionId: routing?.sessionId,
        turnId: routing?.turnId,
      });
      throw error;
    }
  }

  private async executeShard(
    shardId: string,
    channelId: string,
    shardConfig: ShardConfig,
    baseMessage: SubstrateMessage,
    lineage: ShardResult['lineage'],
    runtimeConfig: SubstrateConfig,
  ): Promise<ShardResult> {
    this.refreshShardHealth();
    if (this.activeCount >= this.maxConcurrent) {
      throw new Error(
        `Shard limit reached (${this.maxConcurrent} concurrent). Wait for active shards to complete.`,
      );
    }

    const startTime = Date.now();
    const maxTurns = normalizeShardMaxTurns(shardConfig.maxTurns);
    const capabilities = this.resolveAdvertisedCapabilities(shardConfig.capabilities);
    const requiredCapabilities = this.resolveRequiredCapabilities(shardConfig.requiredCapabilities);
    const missingCapabilities = requiredCapabilities.filter(capability => !capabilities.includes(capability));
    if (missingCapabilities.length > 0) {
      throw new Error(
        `Shard routing denied: "${shardConfig.name}" is missing required capability tokens `
        + `(${missingCapabilities.join(', ')}).`,
      );
    }
    const heartbeatStaleAfterMs = this.resolveHeartbeatStaleAfterMs(shardConfig.heartbeatStaleAfterMs);
    const heartbeatDisconnectAfterMs = this.resolveHeartbeatDisconnectAfterMs(
      shardConfig.heartbeatDisconnectAfterMs,
      heartbeatStaleAfterMs,
    );

    chargeSurface('shardLaunch', {
      details: {
        shardId,
        name: shardConfig.name,
        maxTurns,
        channelId,
      },
    });

    this.activeCount++;
    this.activeShards.set(shardId, {
      id: shardId,
      name: shardConfig.name,
      task: shardConfig.task,
      startedAt: startTime,
      channelId,
      state: 'registering',
      stateReason: 'spawn_requested',
      health: 'healthy',
      lastTransitionAt: startTime,
      lastHeartbeatAt: startTime,
      heartbeatStaleAfterMs,
      heartbeatDisconnectAfterMs,
      capabilities,
      requiredCapabilities,
    });
    this.registerActiveShardChannel(channelId, shardId);
    this.auditTrail?.append('shard.lifecycle.transition', {
      shardId,
      from: 'none',
      to: 'registering',
      reason: 'spawn_requested',
      health: 'healthy',
      channelId,
    });
    this.auditTrail?.append('shard.spawn.start', {
      shardId,
      name: shardConfig.name,
      maxTurns,
      channelId,
      capabilities,
      requiredCapabilities,
    });
    try {
      const shardMemoryReviewContext: Pick<ShardRuntimeRecord, 'channelId' | 'task' | 'lineage'> = {
        channelId,
        task: shardConfig.task,
        lineage,
      };
      // Each shard gets its own SessionManager wrapping the shared store
      const sessionManager = new SessionManager(
        this.deps.sessionStore,
        runtimeConfig,
        this.deps.eventBus,
      );

      const systemPrompt = this.resolveSystemPrompt(shardConfig);

      const agentLoop = new SubstrateAgent(
        this.deps.eventBus,
        this.deps.llmProvider,
        sessionManager,
        systemPrompt,
        sanitizeCoreSubstrateConfig(runtimeConfig),
        {
          runtimeMode: this.deps.runtimeMode,
        },
      );

      // Shards can READ memory but don't extract or archive (ephemeral)
      if (this.deps.memoryProvider && !shardConfig.contextPack) {
        agentLoop.memoryProvider = this.deps.memoryProvider;
      }

      // Shards don't recurse or self-escalate: we inject a tier-limited subset only.
      const injectedTools = this.resolveInjectedTools(shardId, shardMemoryReviewContext);
      for (const tool of injectedTools) {
        agentLoop.registerTool(tool);
      }
      this.auditTrail?.append('shard.tools.injected', {
        shardId,
        tier: this.resolveCapabilityTier(),
        tools: injectedTools.map(tool => tool.name),
      });
      this.transitionShardState(shardId, 'ready', 'agent_initialized');
      this.touchShardHeartbeat(shardId);
      // No memoryExtractor — shards don't run L1 extraction/archive jobs.

      // Execute with a bounded turn loop.
      let totalInput = 0;
      let totalOutput = 0;
      let lastModel = '';
      let lastContent = '';
      let turns = 0;
      let artifactReturn: ArtifactReturnBatch | null = null;

      for (let turn = 0; turn < maxTurns; turn++) {
        this.refreshShardHealth();
        this.assertShardRoutable(shardId, requiredCapabilities);
        this.touchShardHeartbeat(shardId);
        const turnMessage = turn === 0 ? baseMessage : {
          ...baseMessage,
          id: `${shardId}-turn-${turn}`,
          content: lastContent,
        };

        const response = await agentLoop.handleMessage(turnMessage);
        const shardArtifactReturn = this.artifactReturnPort.collectArtifactReturn({
          lineage,
          turnIndex: turn + 1,
          turnMessageId: turnMessage.id,
          attachments: response.attachments,
        });
        if (shardArtifactReturn) {
          const shardArtifacts = shardArtifactReturn.artifacts;
          artifactReturn = artifactReturn
            ? {
              mergePolicy: artifactReturn.mergePolicy,
              artifacts: [...artifactReturn.artifacts, ...shardArtifacts],
            }
            : {
              mergePolicy: shardArtifactReturn.mergePolicy,
              artifacts: [...shardArtifacts],
            };
          this.auditTrail?.append('shard.artifact.return', {
            shardId,
            turnIndex: turn + 1,
            artifactIds: shardArtifacts.map(artifact => artifact.artifactId),
            mergePolicy: shardArtifactReturn.mergePolicy,
          });
          if (this.foldReviewController) {
            await this.foldReviewController.recordArtifactReturn({
              shardId,
              channelId,
              task: shardConfig.task,
              lineage,
              timestamp: Date.now(),
              artifactReturn: shardArtifactReturn,
            });
          }
        }

        totalInput += response.metadata.inputTokens;
        totalOutput += response.metadata.outputTokens;
        lastModel = response.metadata.model;
        lastContent = response.content;
        turns++;
        this.touchShardHeartbeat(shardId);

        // For a one-turn shard, we break after the first turn.
        // Multi-turn shards continue only if the response suggests more work.
        if (turn === 0 && maxTurns === 1) break;
      }

      this.transitionShardState(shardId, 'offline', 'completed');
      const finishedShard = this.activeShards.get(shardId);
      const result: ShardResult = {
        shardId,
        name: shardConfig.name,
        content: lastContent,
        model: lastModel,
        inputTokens: totalInput,
        outputTokens: totalOutput,
        durationMs: Date.now() - startTime,
        turns,
        lifecycleState: finishedShard?.state ?? 'offline',
        health: finishedShard?.health ?? 'healthy',
        stateReason: finishedShard?.stateReason ?? 'completed',
        ...(finishedShard?.failureReason ? { failureReason: finishedShard.failureReason } : {}),
        capabilities: [...capabilities],
        requiredCapabilities: [...requiredCapabilities],
        lineage,
        ...(artifactReturn ? { artifactReturn } : {}),
      };
      this.auditTrail?.append('shard.spawn.end', {
        shardId,
        status: 'completed',
        durationMs: result.durationMs,
        turns: result.turns,
        lifecycleState: result.lifecycleState,
        health: result.health,
      });
      return result;
    } catch (error) {
      const msg = toErrorMessage(error);
      this.transitionShardState(shardId, 'degraded', 'execution_failed', msg);
      this.transitionShardState(shardId, 'offline', 'execution_failed', msg);
      this.auditTrail?.append('shard.spawn.end', {
        shardId,
        status: 'failed',
        durationMs: Date.now() - startTime,
        error: msg,
      });
      throw new Error(`Shard "${shardConfig.name}" failed (execution_failed): ${msg}`);
    } finally {
      this.releaseActiveShard(shardId, channelId);
    }
  }

  getActiveCount(): number {
    this.refreshShardHealth();
    return this.activeCount;
  }

  getActiveShards(): ActiveShard[] {
    this.refreshShardHealth();
    return [...this.activeShards.values()].map(shard => ({
      ...shard,
      capabilities: [...shard.capabilities],
      requiredCapabilities: [...shard.requiredCapabilities],
    }));
  }

  async listFoldReviews(): Promise<ShardFoldReviewRecord[]> {
    return await this.requireFoldReviewController().listFoldReviews();
  }

  async getFoldReview(shardId: string): Promise<ShardFoldReviewRecord | null> {
    return await this.requireFoldReviewController().getFoldReview(shardId);
  }

  async resolveFoldReview(params: ShardFoldReviewResolveParams): Promise<ShardFoldReviewRecord | null> {
    return await this.requireFoldReviewController().resolveFoldReview(params);
  }

  private resolveHeartbeatStaleAfterMs(value: number | undefined): number {
    return normalizeHeartbeatStaleAfterMs(value, this.heartbeatStaleAfterMs);
  }

  private resolveHeartbeatDisconnectAfterMs(value: number | undefined, staleAfterMs: number): number {
    return normalizeHeartbeatDisconnectAfterMs(value, staleAfterMs, this.heartbeatDisconnectAfterMs);
  }

  private requireFoldReviewController(): ShardFoldReviewController {
    if (!this.foldReviewController) {
      throw new Error('Shard fold review controller unavailable.');
    }
    return this.foldReviewController;
  }

  private resolveAdvertisedCapabilities(tokens: readonly string[] | undefined): string[] {
    return normalizeCapabilityTokens(tokens, DEFAULT_SHARD_CAPABILITIES);
  }

  private resolveRequiredCapabilities(tokens: readonly string[] | undefined): string[] {
    return normalizeCapabilityTokens(tokens);
  }

  private touchShardHeartbeat(shardId: string): void {
    const shard = this.activeShards.get(shardId);
    if (!shard) return;
    shard.lastHeartbeatAt = Date.now();
    if (shard.state === 'degraded' && shard.stateReason === 'heartbeat_stale') {
      this.transitionShardState(shardId, 'ready', 'heartbeat_recovered');
    }
  }

  private refreshShardHealth(now = Date.now()): void {
    const activeShards = [...this.activeShards.values()];
    for (const shard of activeShards) {
      const inHeartbeatManagedState = shard.state === 'registering'
        || shard.state === 'ready'
        || (shard.state === 'degraded' && shard.stateReason === 'heartbeat_stale');
      if (!inHeartbeatManagedState) {
        continue;
      }

      const staleForMs = now - shard.lastHeartbeatAt;
      if (staleForMs <= shard.heartbeatStaleAfterMs) {
        continue;
      }

      const staleReason = `No heartbeat observed for ${staleForMs}ms (limit ${shard.heartbeatStaleAfterMs}ms).`;
      this.transitionShardState(shard.id, 'degraded', 'heartbeat_stale', staleReason);
      if (staleForMs <= shard.heartbeatDisconnectAfterMs) {
        continue;
      }

      const timeoutReason =
        `Heartbeat stale for ${staleForMs}ms exceeded recovery window `
        + `(${shard.heartbeatDisconnectAfterMs}ms).`;
      this.transitionShardState(shard.id, 'offline', 'heartbeat_timeout', timeoutReason);
      this.releaseActiveShard(shard.id, shard.channelId);
      this.auditTrail?.append('shard.health.evict', {
        shardId: shard.id,
        state: 'offline',
        reason: 'heartbeat_timeout',
        staleForMs,
        heartbeatStaleAfterMs: shard.heartbeatStaleAfterMs,
        heartbeatDisconnectAfterMs: shard.heartbeatDisconnectAfterMs,
      });
    }
  }

  private assertShardRoutable(shardId: string, requiredCapabilities: readonly string[]): void {
    const shard = this.activeShards.get(shardId);
    if (!shard) {
      throw new Error(`Shard routing denied: "${shardId}" is offline.`);
    }
    if (shard.state !== 'ready' || shard.health !== 'healthy') {
      const detail = shard.failureReason
        ? `${shard.stateReason}; ${shard.failureReason}`
        : shard.stateReason;
      throw new Error(
        `Shard routing denied: "${shard.name}" is ${shard.state}/${shard.health} (${detail}).`,
      );
    }

    const missing = requiredCapabilities.filter(capability => !shard.capabilities.includes(capability));
    if (missing.length > 0) {
      throw new Error(
        `Shard routing denied: "${shard.name}" is missing required capability tokens `
        + `(${missing.join(', ')}).`,
      );
    }
  }

  private releaseActiveShard(shardId: string, channelId: string): void {
    const deleted = this.activeShards.delete(shardId);
    this.unregisterActiveShardChannel(channelId, shardId);
    if (!deleted) {
      return;
    }
    this.activeCount = Math.max(0, this.activeCount - 1);
  }

  private transitionShardState(
    shardId: string,
    nextState: ShardLifecycleState,
    reason: string,
    failureReason?: string,
  ): void {
    const shard = this.activeShards.get(shardId);
    if (!shard) {
      return;
    }

    const now = Date.now();
    const currentState = shard.state;
    const currentFailureReason = shard.failureReason;
    if (
      currentState === nextState
      && shard.stateReason === reason
      && currentFailureReason === failureReason
    ) {
      return;
    }
    if (currentState !== nextState) {
      const allowedTransitions = SHARD_STATE_TRANSITIONS[currentState];
      if (!allowedTransitions.includes(nextState)) {
        throw new Error(
          `Invalid shard lifecycle transition for ${shardId}: ${currentState} -> ${nextState}.`,
        );
      }
      shard.state = nextState;
      shard.lastTransitionAt = now;
    }
    shard.stateReason = reason;

    if (nextState === 'ready') {
      shard.health = 'healthy';
      delete shard.failureReason;
    } else if (nextState === 'degraded') {
      shard.health = reason === 'heartbeat_stale' ? 'stale' : 'failed';
      if (failureReason) {
        shard.failureReason = failureReason;
      }
    } else if (nextState === 'offline' && failureReason) {
      shard.failureReason = failureReason;
    }

    this.auditTrail?.append('shard.lifecycle.transition', {
      shardId,
      from: currentState,
      to: nextState,
      reason,
      health: shard.health,
      ...(failureReason ? { failureReason } : {}),
    });
  }

  private installAuditHooks(): void {
    this.deps.eventBus.on('agent.tool.start', (event) => {
      const shardId = this.resolveShardId(event.channelId);
      if (!shardId) return;
      this.touchShardHeartbeat(shardId);
      this.auditTrail?.append('shard.tool.start', {
        shardId,
        channelId: event.channelId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
      });
    });

    this.deps.eventBus.on('agent.tool.end', (event) => {
      const shardId = this.resolveShardId(event.channelId);
      if (!shardId) return;
      this.touchShardHeartbeat(shardId);
      this.auditTrail?.append('shard.tool.end', {
        shardId,
        channelId: event.channelId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        isError: event.isError,
      });
    });
  }

  private resolveInjectedTools(
    shardId: string,
    memoryReviewContext: Pick<ShardRuntimeRecord, 'channelId' | 'task' | 'lineage'>,
  ): AgentTool<any>[] {
    const catalog = this.deps.toolCatalogProvider?.();
    if (!catalog) return [];

    const availableByName = new Map<string, AgentTool<any>>();
    const available = [...catalog.core, ...catalog.extended];
    for (const tool of available) {
      if (BLOCKED_SHARD_TOOL_NAMES.has(tool.name)) continue;
      if (!availableByName.has(tool.name)) {
        availableByName.set(tool.name, tool);
      }
    }

    const toolNames = this.resolveToolNamesForTier(this.resolveCapabilityTier());
    const includeAll = toolNames.includes(SHARD_TOOLSET_ALL);
    const selected = includeAll
      ? [...availableByName.values()]
      : toolNames
        .map(name => availableByName.get(name))
        .filter((tool): tool is AgentTool<any> => tool !== undefined);

    return selected.map(tool => this.wrapShardTool(tool, shardId, memoryReviewContext));
  }

  private resolveToolNamesForTier(tier: CapabilityTier): string[] {
    const configured = this.deps.shardToolsets ?? this.deps.config.shardToolsets;
    const nursery = normalizeToolNames(
      configured?.nursery,
      DEFAULT_SHARD_TOOLSETS_BY_TIER.nursery,
    );

    if (tier === 'nursery') return nursery;

    if (tier === 'apprentice') {
      const apprentice = normalizeToolNames(configured?.apprentice);
      if (apprentice.length > 0) return apprentice;
      return [...nursery, ...APPRENTICE_SHARD_TOOL_EXTRAS.filter(name => !nursery.includes(name))];
    }

    const tierConfig = normalizeToolNames(configured?.[tier] ?? configured?.autonomous);
    if (tierConfig.length > 0) return tierConfig;
    return [...DEFAULT_SHARD_TOOLSETS_BY_TIER[tier]];
  }

  private resolveCapabilityTier(): CapabilityTier {
    return normalizeCapabilityTier(this.deps.config.capabilityTier);
  }

  private async buildContextPack(
    shardId: string,
    shardChannelId: string,
    shardConfig: ShardConfig,
    companionName: string,
  ): Promise<ShardContextPack | null> {
    const source = this.normalizeSourceContext(shardConfig.sourceContext);
    if (!source) {
      return null;
    }

    const policyDecision = evaluateCompositionalPolicyForChannelId({
      policy: this.deps.config.compositionalPolicy,
      capabilityTier: this.resolveCapabilityTier(),
      channelId: source.channelId,
      purpose: 'shard_context',
    });
    if (!policyDecision.allowed) {
      return null;
    }

    const sessionSyncEnvelope: ShardSessionMemorySyncEnvelope = {
      version: SHARD_SYNC_POLICY_VERSION,
      syncClass: 'transcript_fact',
      direction: 'prime_to_shard',
      authority: 'prime',
      operation: 'context_pack_session',
      shardId,
      sourceId: source.channelId,
      targetId: shardChannelId,
      idempotencyKey: this.buildSyncIdempotencyKey([
        'context_pack_session',
        shardId,
        source.channelId,
        source.requestId,
        source.turnId,
      ]),
      requestedAt: Date.now(),
    };
    const sessionSyncDecision = this.evaluateSyncPolicy(sessionSyncEnvelope);
    const sessionEntries = sessionSyncDecision.allowed
      ? this.buildContextPackEntries(source)
      : [];

    const memorySyncEnvelope: ShardSessionMemorySyncEnvelope = {
      version: SHARD_SYNC_POLICY_VERSION,
      syncClass: 'derived_memory',
      direction: 'prime_to_shard',
      authority: 'prime',
      operation: 'context_pack_memory',
      shardId,
      sourceId: source.channelId,
      targetId: shardChannelId,
      idempotencyKey: this.buildSyncIdempotencyKey([
        'context_pack_memory',
        shardId,
        source.channelId,
        source.requestId,
        source.turnId,
        shardConfig.task,
      ]),
      requestedAt: Date.now(),
    };
    const memorySyncDecision = this.evaluateSyncPolicy(memorySyncEnvelope);
    const memoryBlock = memorySyncDecision.allowed
      ? await this.buildContextPackMemoryBlock(
        shardConfig.task,
        source.channelId,
        this.resolveContextPackMemoryScopeQuery(source.channelId),
      )
      : '';
    if (sessionEntries.length === 0 && memoryBlock.length === 0) {
      return null;
    }

    return {
      purpose: 'shard_context',
      task: shardConfig.task,
      source,
      companionName,
      sessionEntries,
      ...(memoryBlock ? { memoryBlock } : {}),
    };
  }

  private withCompanionNameForContextPack(
    contextPack: ShardContextPack,
    companionName: string,
  ): ShardContextPack {
    const existingCompanionName = contextPack.companionName?.trim();
    return {
      ...contextPack,
      companionName: existingCompanionName || companionName,
    };
  }

  private evaluateSyncPolicy(
    envelope: ShardSessionMemorySyncEnvelope,
  ): ShardSessionMemorySyncDecision {
    const decision = evaluateShardSessionMemorySyncPolicy(envelope);
    this.recordSyncPolicyDecision(envelope, decision);
    return decision;
  }

  private recordSyncPolicyDecision(
    envelope: ShardSessionMemorySyncEnvelope,
    decision: ShardSessionMemorySyncDecision,
  ): void {
    const policyEvent = {
      shardId: envelope.shardId,
      syncClass: envelope.syncClass,
      direction: envelope.direction,
      authority: envelope.authority,
      operation: envelope.operation,
      sourceId: envelope.sourceId,
      targetId: envelope.targetId,
      idempotencyKey: envelope.idempotencyKey,
      decision: decision.allowed ? 'ALLOW' : 'DENY',
      reason: decision.reason,
      requestedAt: envelope.requestedAt,
    } as const;
    this.auditTrail?.append('shard.sync.policy', policyEvent);

    const path = this.deps.shardSessionMemorySyncAuditPath?.trim();
    if (!path) {
      return;
    }

    appendShardSessionMemorySyncAudit(path, {
      timestamp: Date.now(),
      shardId: envelope.shardId,
      syncClass: envelope.syncClass,
      direction: envelope.direction,
      authority: envelope.authority,
      operation: envelope.operation,
      sourceId: envelope.sourceId,
      targetId: envelope.targetId,
      idempotencyKey: envelope.idempotencyKey,
      decision: decision.allowed ? 'ALLOW' : 'DENY',
      reason: decision.reason,
    });
  }

  private buildSyncIdempotencyKey(parts: Array<string | undefined>): string {
    const normalized = parts
      .map(part => part?.trim())
      .filter((part): part is string => Boolean(part))
      .join('|');
    if (normalized.length === 0) {
      return `sync:${Date.now()}`;
    }
    if (normalized.length > 200) {
      return normalized.slice(0, 200);
    }
    return normalized;
  }

  private normalizeSourceContext(
    sourceContext: ShardSourceContext | undefined,
  ): ShardSourceContext | null {
    const channelId = sourceContext?.channelId.trim();
    if (!channelId || !sourceContext) {
      return null;
    }

    const requestId = sourceContext.requestId?.trim();
    const turnId = sourceContext.turnId?.trim();
    const embodimentContext = sourceContext.embodimentContext;
    return {
      channelId,
      ...(requestId ? { requestId } : {}),
      ...(turnId ? { turnId } : {}),
      ...(embodimentContext ? { embodimentContext } : {}),
    };
  }

  private buildContextPackEntries(source: ShardSourceContext): ShardContextPackEntry[] {
    const recentEntries = this.deps.sessionStore.getRecent(
      source.channelId,
      CONTEXT_PACK_SESSION_SCAN_LIMIT,
    );
    const focusedEntries = this.selectContextPackEntries(recentEntries, source);
    return focusedEntries.map(entry => ({
      role: entry.role,
      content: this.truncateContextText(entry.content, CONTEXT_PACK_ENTRY_CONTENT_MAX_CHARS),
      ...(entry.authorName ? { authorName: entry.authorName } : {}),
      timestamp: entry.timestamp,
    }));
  }

  private selectContextPackEntries(
    recentEntries: readonly SessionEntry[],
    source: ShardSourceContext,
  ): SessionEntry[] {
    if (recentEntries.length <= CONTEXT_PACK_SESSION_ENTRY_LIMIT) {
      return [...recentEntries];
    }

    const anchorIndex = this.findContextPackAnchorIndex(recentEntries, source);
    if (anchorIndex < 0) {
      return recentEntries.slice(-CONTEXT_PACK_SESSION_ENTRY_LIMIT);
    }

    const endExclusive = anchorIndex + 1;
    const start = Math.max(0, endExclusive - CONTEXT_PACK_SESSION_ENTRY_LIMIT);
    return recentEntries.slice(start, endExclusive);
  }

  private findContextPackAnchorIndex(
    recentEntries: readonly SessionEntry[],
    source: ShardSourceContext,
  ): number {
    for (let index = recentEntries.length - 1; index >= 0; index -= 1) {
      const entry = recentEntries.at(index);
      if (!entry) continue;
      if (this.sessionEntryMatchesSource(entry, source)) {
        return index;
      }
    }
    return -1;
  }

  private sessionEntryMatchesSource(entry: SessionEntry, source: ShardSourceContext): boolean {
    const metadata = entry.metadata;
    if (!metadata) {
      return false;
    }

    return this.metadataIncludesField(metadata, 'requestId', source.requestId)
      || this.metadataIncludesField(metadata, 'turnId', source.turnId);
  }

  private metadataIncludesField(
    metadata: string,
    field: 'requestId' | 'turnId',
    value: string | undefined,
  ): boolean {
    if (!value) {
      return false;
    }
    return metadata.includes(`\"${field}\":${JSON.stringify(value)}`);
  }

  private async buildContextPackMemoryBlock(
    task: string,
    sourceChannelId: string,
    scopeQuery: import('../memory/types.js').MemoryScopeQuery | undefined,
  ): Promise<string> {
    const query = task.trim();
    if (!query || !this.deps.memoryProvider) {
      return '';
    }

    const memoryBlock = await this.deps.memoryProvider.retrieve(
      query,
      sourceChannelId,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      scopeQuery,
    );
    return this.truncateContextText(memoryBlock, CONTEXT_PACK_MEMORY_MAX_CHARS);
  }

  private resolveContextPackMemoryScopeQuery(
    sourceChannelId: string,
  ): import('../memory/types.js').MemoryScopeQuery | undefined {
    return this.deps.sessionManager?.getActiveFocusMemoryScopeQuery(sourceChannelId) ?? undefined;
  }

  private resolveSystemPrompt(shardConfig: ShardConfig): string {
    const basePrompt = shardConfig.systemPrompt ?? this.deps.parentSystemPrompt;
    if (!shardConfig.contextPack) {
      return basePrompt;
    }

    return [basePrompt, this.renderContextPack(shardConfig.contextPack)]
      .map(section => section.trim())
      .filter(section => section.length > 0)
      .join('\n\n');
  }

  private renderContextPack(contextPack: ShardContextPack): string {
    const companionName = contextPack.companionName?.trim() || 'Assistant';
    const sourceConversation = contextPack.sessionEntries
      .map(entry => {
        const speaker = entry.role === 'assistant'
          ? entry.authorName?.trim() || companionName
          : entry.role === 'system'
            ? 'System'
            : (entry.authorName?.trim() || 'User');
        return `${speaker}: ${entry.content}`;
      })
      .join('\n');

    return [
      '[Shard context pack]',
      'Use only this task-scoped source context while working the shard task.',
      `Source channel: ${contextPack.source.channelId}`,
      ...(contextPack.source.requestId ? [`Source requestId: ${contextPack.source.requestId}`] : []),
      ...(contextPack.source.turnId ? [`Source turnId: ${contextPack.source.turnId}`] : []),
      ...(contextPack.source.embodimentContext
        ? [`Source embodiment: ${contextPack.source.embodimentContext.embodimentId}`]
        : []),
      `Task scope: ${this.truncateContextText(contextPack.task, CONTEXT_PACK_ENTRY_CONTENT_MAX_CHARS)}`,
      ...(sourceConversation
        ? [
          '',
          '[Focused source conversation]',
          sourceConversation,
        ]
        : []),
      ...(contextPack.memoryBlock
        ? [
          '',
          '[Task-scoped memory]',
          contextPack.memoryBlock,
        ]
        : []),
    ].join('\n');
  }

  private truncateContextText(value: string, maxChars: number): string {
    const normalized = value.trim();
    if (normalized.length <= maxChars) {
      return normalized;
    }
    return `${normalized.slice(0, maxChars - 3)}...`;
  }

  private wrapShardTool(
    tool: AgentTool<any>,
    shardId: string,
    memoryReviewContext: Pick<ShardRuntimeRecord, 'channelId' | 'task' | 'lineage'>,
  ): AgentTool<any> {
    return {
      ...tool,
      execute: async (toolCallId, params, signal) => {
        if (this.isShardMemoryImportTool(tool.name, params)) {
          return this.quarantineShardMemoryImport(tool.name, toolCallId, params, memoryReviewContext);
        }
        this.enforceShardToolSyncPolicy(tool.name, params, shardId, toolCallId);
        const scopedParams = this.applyShardSourceParams(tool.name, params, shardId);
        // scopedParams has extra shard-source fields; tool.execute expects Static<TSchema>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return tool.execute(toolCallId, scopedParams as any, signal);
      },
    };
  }

  private isShardMemoryImportTool(toolName: string, params: unknown): boolean {
    if (toolName === 'memory_import_batch') {
      return true;
    }
    if (toolName !== 'memory' || typeof params !== 'object' || params === null || Array.isArray(params)) {
      return false;
    }
    const paramRecord = params as Record<string, unknown>;
    const action = typeof paramRecord.action === 'string'
      ? paramRecord.action.trim().toLowerCase()
      : '';
    return action === 'import';
  }

  private async quarantineShardMemoryImport(
    toolName: string,
    toolCallId: string,
    params: unknown,
    memoryReviewContext: Pick<ShardRuntimeRecord, 'channelId' | 'task' | 'lineage'>,
  ): Promise<AgentToolResult<any>> {
    if (typeof params !== 'object' || params === null || Array.isArray(params)) {
      return textResultWithError('Error: records must be a non-empty array', true);
    }

    const input = params as Record<string, unknown>;
    const rawRecords = input.records;
    if (!Array.isArray(rawRecords) || rawRecords.length === 0) {
      return textResultWithError('Error: records must be a non-empty array', true);
    }

    const directPromotionDecision = this.evaluateShardMemoryImportPromotionPolicy(
      memoryReviewContext.lineage.shardId,
      toolCallId,
    );
    const stagedOutputs = resolveStagedShardMemoryOutputs(
      memoryReviewContext,
      toolName,
      toolCallId,
      params,
      {
        blockedCorePromotionReason: directPromotionDecision.reason,
      },
    );
    if (stagedOutputs.length === 0) {
      return textResultWithError('Error: memory import batch must contain valid records', true);
    }

    const reviewTimestamp = Date.now();
    const mergeReview = createEmptyShardMergeReview(memoryReviewContext.lineage.shardId, reviewTimestamp);
    const blockingReasons = computeShardMergeReviewBlockingReasons({
      ...memoryReviewContext,
      taggedOutputs: stagedOutputs,
      mergeReview,
    });
    this.auditTrail?.append('shard.memory.import.quarantined', {
      shardId: memoryReviewContext.lineage.shardId,
      toolName,
      toolCallId,
      pendingTaggedOutputCount: stagedOutputs.length,
      blockedCorePromotionReason: directPromotionDecision.reason,
      blockingReasons,
    });
    if (this.foldReviewController) {
      await this.foldReviewController.recordPendingMemoryCandidates({
        shardId: memoryReviewContext.lineage.shardId,
        channelId: memoryReviewContext.channelId,
        task: memoryReviewContext.task,
        lineage: memoryReviewContext.lineage,
        timestamp: reviewTimestamp,
        outputs: stagedOutputs,
      });
    }

    const summary = `Memory import quarantined: ${stagedOutputs.length} record(s) staged as pending fold review.`;
    return {
      content: [{ type: 'text', text: summary }],
      details: {
        mutationWorkflow: 'fold_review_only',
        reviewState: 'pending',
        blockedCorePromotion: true,
        blockedCorePromotionReason: directPromotionDecision.reason,
        directPromotionDecision,
        pendingTaggedOutputCount: stagedOutputs.length,
        blockingReasons,
        foldReview: {
          required: true,
          status: 'pending',
          validationPath: mergeReview.validationPath,
          lastUpdatedAt: reviewTimestamp,
          pendingTaggedOutputCount: stagedOutputs.length,
          blockingReasons,
          outputs: stagedOutputs,
        },
      },
    };
  }

  private evaluateShardMemoryImportPromotionPolicy(
    shardId: string,
    toolCallId: string,
  ): ShardSessionMemorySyncDecision {
    const decision = this.evaluateSyncPolicy({
      version: SHARD_SYNC_POLICY_VERSION,
      syncClass: 'derived_memory',
      direction: 'shard_to_prime',
      authority: 'shard',
      operation: 'memory_import_batch',
      shardId,
      sourceId: `shard:${shardId}`,
      targetId: SHARD_SYNC_MEMORY_TARGET,
      idempotencyKey: this.buildSyncIdempotencyKey([
        'shard_tool_sync',
        shardId,
        toolCallId,
        'memory_import_batch',
      ]),
      requestedAt: Date.now(),
    });
    if (decision.allowed) {
      throw new Error(
        `Shard session/memory sync unexpectedly allowed for memory_import_batch (${decision.reason}).`,
      );
    }
    return decision;
  }

  private enforceShardToolSyncPolicy(
    toolName: string,
    params: unknown,
    shardId: string,
    toolCallId: string,
  ): void {
    const operation = this.resolveShardToolSyncOperation(toolName, params);
    if (!operation) {
      return;
    }

    const envelope: ShardSessionMemorySyncEnvelope = {
      version: SHARD_SYNC_POLICY_VERSION,
      syncClass: 'derived_memory',
      direction: 'shard_to_prime',
      authority: 'shard',
      operation,
      shardId,
      sourceId: `shard:${shardId}`,
      targetId: SHARD_SYNC_MEMORY_TARGET,
      idempotencyKey: this.buildSyncIdempotencyKey([
        'shard_tool_sync',
        shardId,
        toolCallId,
        operation,
      ]),
      requestedAt: Date.now(),
    };
    const decision = this.evaluateSyncPolicy(envelope);
    if (!decision.allowed) {
      throw new Error(
        `Shard session/memory sync denied for ${toolName} (${decision.reason}).`,
      );
    }
  }

  private resolveShardToolSyncOperation(
    toolName: string,
    params: unknown,
  ): ShardSessionMemorySyncEnvelope['operation'] | null {
    if (toolName === 'memory') {
      if (typeof params !== 'object' || params === null || Array.isArray(params)) {
        return null;
      }
      const paramRecord = params as Record<string, unknown>;
      const action = typeof paramRecord.action === 'string'
        ? paramRecord.action.trim().toLowerCase()
        : '';
      if (action === 'write') return 'memory_write';
      if (action === 'import') return 'memory_import_batch';
      if (
        action === 'patch'
        || action === 'redact'
        || action === 'delete'
        || action === 'restore'
      ) {
        return 'memory_redact';
      }
      return null;
    }
    if (
      toolName !== 'memory_write'
      && toolName !== 'memory_import_batch'
      && toolName !== 'memory_redact'
    ) {
      return null;
    }
    return toolName;
  }

  private applyShardSourceParams(
    toolName: string,
    params: unknown,
    shardId: string,
  ): unknown {
    if (toolName === 'memory') {
      if (typeof params !== 'object' || params === null || Array.isArray(params)) {
        return params;
      }
      const paramRecord = params as Record<string, unknown>;
      const action = typeof paramRecord.action === 'string'
        ? paramRecord.action.trim().toLowerCase()
        : '';
      if (action !== 'write') {
        return params;
      }
      return {
        ...(params as Record<string, unknown>),
        [INTERNAL_SHARD_SOURCE_PARAM]: `shard:${shardId}`,
      };
    }
    if (
      toolName !== 'memory_write'
      && toolName !== 'memory_import_batch'
      && toolName !== 'memory_redact'
    ) {
      return params;
    }
    if (typeof params !== 'object' || params === null || Array.isArray(params)) {
      return params;
    }

    return {
      ...(params as Record<string, unknown>),
      [INTERNAL_SHARD_SOURCE_PARAM]: `shard:${shardId}`,
    };
  }

  private resolveWyomingShardName(
    routing: SatelliteRoutingMetadata | undefined,
    presenceSubjectId: string | undefined,
  ): string {
    const siteId = routing?.siteId?.trim() || 'unknown-site';
    const subjectId = presenceSubjectId || routing?.satelliteId?.trim() || 'unknown-satellite';
    return `wyoming:${siteId}:${subjectId}`;
  }

  private resolveWyomingRouteCapabilities(
    routing: SatelliteRoutingMetadata | undefined,
    presenceSubjectId: string | undefined,
  ): string[] {
    const siteId = routing?.siteId?.trim() || 'unknown-site';
    const subjectId = presenceSubjectId || routing?.satelliteId?.trim() || 'unknown-satellite';
    return normalizeCapabilityTokens([
      'wyoming',
      `wyoming:${siteId}`,
      `wyoming:${siteId}:${subjectId}`,
    ]);
  }

  private registerActiveShardChannel(channelId: string, shardId: string): void {
    const active = this.activeShardChannels.get(channelId) ?? new Set<string>();
    active.add(shardId);
    this.activeShardChannels.set(channelId, active);
  }

  private unregisterActiveShardChannel(channelId: string, shardId: string): void {
    const active = this.activeShardChannels.get(channelId);
    if (!active) return;
    active.delete(shardId);
    if (active.size === 0) {
      this.activeShardChannels.delete(channelId);
    }
  }

  private resolveShardId(channelId: string): string | null {
    if (channelId.startsWith('shard:')) {
      const shardId = channelId.slice('shard:'.length).trim();
      return shardId.length > 0 ? shardId : null;
    }

    const activeShards = this.activeShardChannels.get(channelId);
    if (!activeShards || activeShards.size === 0) {
      return null;
    }
    return activeShards.values().next().value ?? null;
  }
}

function normalizeToolNames(
  configured: readonly string[] | undefined,
  fallback: readonly string[] = [],
): string[] {
  const source = configured && configured.length > 0 ? configured : fallback;
  return [...new Set(
    source
      .map(item => item.trim())
      .filter(Boolean),
  )];
}

function normalizeCapabilityTokens(
  configured: readonly string[] | undefined,
  fallback: readonly string[] = [],
): string[] {
  const source = configured && configured.length > 0 ? configured : fallback;
  return [...new Set(
    source
      .map(item => item.trim())
      .filter(Boolean),
  )];
}

function normalizeHeartbeatStaleAfterMs(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined) {
    return fallback;
  }
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : fallback;
}

function normalizeHeartbeatDisconnectAfterMs(
  value: number | undefined,
  staleAfterMs: number,
  fallback: number,
): number {
  const normalized = normalizeHeartbeatStaleAfterMs(value, fallback);
  if (normalized <= staleAfterMs) {
    return staleAfterMs + 1;
  }
  return normalized;
}
