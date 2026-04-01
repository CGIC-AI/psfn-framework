// ── ShardManager ──
// Spawns ephemeral SubstrateAgent instances for parallel task execution.
// Shards share parent's heavy resources (LLM, DB, memory) but get isolated channelIds.

import { randomUUID } from 'node:crypto';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import type {
  CapabilityTier,
  GatewayRoutingEnvelope,
  ShardToolsetConfig,
  ShardLineage,
  SubstrateConfig,
  SubstrateMessage,
} from '../types.js';
import type { EventBus } from '../event-bus.js';
import type { LLMProvider, EmbeddingService, MemoryProvider } from '../agent/contracts.js';
import { SubstrateAgent } from '../agent/substrate-agent.js';
import type { RuntimeMode } from '../agent/tool-wiring-validator.js';
import { normalizeCapabilityTier } from '../capabilities/tiers.js';
import { evaluateCompositionalPolicyForChannelId } from '../compositional/policy.js';
import type { SessionStore } from '../session/store.js';
import { SessionManager } from '../session/manager.js';
import type { SessionEntry } from '../session/types.js';
import {
  evaluateShardSessionMemorySyncPolicy,
  type ShardSessionMemorySyncDecision,
  type ShardSessionMemorySyncEnvelope,
} from '../gateway/policy.js';
import { appendShardSessionMemorySyncAudit } from '../persistence/jsonl.js';
import { DEFAULT_COMPANION_ID } from '../identity/companion-naming.js';
import {
  cloneGatewayRoutingEnvelope,
  deriveShardRoutingEnvelope,
  type ShardCreationMode,
} from '../routing/envelope.js';
import type { ShardExecutionPort } from './port.js';
import type {
  ShardBackend,
  ShardConfig,
  ShardLifecycleState,
  ShardMergeReview,
  ShardParentContextSnapshot,
  ShardPromptDiscipline,
  ShardResult,
  ShardRuntimeRecord,
  ShardRuntimeSnapshot,
  ShardRuntimeSnapshotOptions,
  ShardRuntimeState,
  ShardRuntimeTaskView,
  ShardSourceContext,
  ShardContextPackEntry,
  ShardTaggedOutput,
  ShardTaggedOutputKind,
  ShardTaggedOutputProvenance,
  ShardTaggedOutputSource,
  ShardWorkLogEntry,
  ShardWorkLogEvent,
} from './types.js';
import { toErrorMessage } from '../utils/errors.js';
import { textResult } from '../tools/results.js';
import {
  assertMediatedShardBackendTier,
  LocalShardBackendController,
  resolveRequestedShardBackend,
  type ShardBackendController,
} from './backend-controller.js';

const DEFAULT_MAX_CONCURRENT = 5;
const DEFAULT_MAX_TURNS = 1;
const DEFAULT_SHARD_HEARTBEAT_STALE_AFTER_MS = 60_000;
const DEFAULT_SHARD_HEARTBEAT_DISCONNECT_MULTIPLIER = 3;
const CONTEXT_PACK_SESSION_SCAN_LIMIT = 12;
const CONTEXT_PACK_SESSION_ENTRY_LIMIT = 6;
const CONTEXT_PACK_ENTRY_CONTENT_MAX_CHARS = 600;
const CONTEXT_PACK_MEMORY_MAX_CHARS = 4_000;
const SHARD_TAGGED_OUTPUT_PREVIEW_MAX_CHARS = 180;
const DEFAULT_SHARD_CAPABILITIES = ['general'] as const;
const SHARD_TOOLSET_ALL = '*';
const SHARD_SYNC_POLICY_VERSION = 1;
const SHARD_SYNC_MEMORY_TARGET = 'memory:index';
const INTERNAL_SHARD_SOURCE_PARAM = '__psfnShardSource';
const BLOCKED_SHARD_TOOL_NAMES = new Set(['spawn_shard', 'load_tools', 'toolset']);
const DEFAULT_RUNTIME_SHARD_HISTORY_LIMIT = 25;
const DEFAULT_SHARD_PROMPT_GUARDRAILS = [
  'Operate as a shard that returns an artifact, not as a bounded subagent assignment.',
  'Do not recurse into additional shards or delegate work through bounded subagent control.',
  'Stay inside the shard remit and available tools; do not widen scope on your own.',
] as const;
const APPRENTICE_SHARD_TOOL_EXTRAS = [
  'contact_list',
] as const;
export const DEFAULT_SHARD_TOOLSET = [
  'memory',
  'contact_lookup',
  'repo',
] as const;

const DEFAULT_SHARD_TOOLSETS_BY_TIER: Readonly<Record<CapabilityTier, readonly string[]>> = {
  nursery: DEFAULT_SHARD_TOOLSET,
  apprentice: [...DEFAULT_SHARD_TOOLSET, ...APPRENTICE_SHARD_TOOL_EXTRAS],
  autonomous: [SHARD_TOOLSET_ALL],
  custom: [SHARD_TOOLSET_ALL],
};

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
  llmProvider: LLMProvider;
  sessionStore: SessionStore;
  sessionManager?: SessionManager | null;
  embeddingService: EmbeddingService | null;
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
  companionId?: string;
  backendController?: ShardBackendController;
}

export type ActiveShard = ShardRuntimeRecord;

interface ResolvedShardConfig extends ShardConfig {
  creationMode: ShardCreationMode;
  parentContext?: ShardParentContextSnapshot;
  promptDiscipline: ShardPromptDiscipline;
  gatewayRouting: GatewayRoutingEnvelope;
}

interface StagedShardMemoryOutput {
  content: string;
  label: string;
  source: ShardTaggedOutputSource;
  provenanceTags: string[];
}

export class ShardManager implements ShardExecutionPort {
  readonly portFamily = 'shard' as const;
  private deps: ShardManagerDeps;
  private auditTrail: ShardAuditTrail | null;
  private companionId: string;
  private activeCount = 0;
  private maxConcurrent: number;
  private heartbeatStaleAfterMs: number;
  private heartbeatDisconnectAfterMs: number;
  private runtimeShardHistoryLimit = DEFAULT_RUNTIME_SHARD_HISTORY_LIMIT;
  private activeShards = new Map<string, ActiveShard>();
  private shardHistoryOrder: string[] = [];
  private shardRecords = new Map<string, ShardRuntimeRecord>();
  private activeShardChannels = new Map<string, Set<string>>();
  private backendController: ShardBackendController;

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
    this.companionId = deps.companionId?.trim() || DEFAULT_COMPANION_ID;
    this.backendController = deps.backendController ?? new LocalShardBackendController();
    this.installAuditHooks();
  }

  async spawn(shardConfig: ShardConfig): Promise<ShardResult> {
    this.refreshShardHealth();
    const shardId = `shard-${randomUUID()}`;
    const channelId = `shard:${shardId}`;
    const creationMode = this.resolveCreationMode(shardConfig);
    this.assertShardCreationContract(shardConfig, creationMode);
    const gatewayRouting = this.deriveGatewayRouting(shardId, creationMode, shardConfig.gatewayRouting);
    const parentContext = shardConfig.parentContext
      ?? (creationMode === 'forked'
        ? await this.buildParentContextSnapshot(shardId, channelId, shardConfig)
        : undefined);
    const preparedConfig: ResolvedShardConfig = {
      ...shardConfig,
      creationMode,
      ...(parentContext ? { parentContext } : {}),
      promptDiscipline: this.buildPromptDiscipline(shardConfig, creationMode, parentContext),
      gatewayRouting,
    };
    const baseMessage: SubstrateMessage = {
      id: shardId,
      channelId,
      channelType: 'api',
      authorId: 'system',
      authorName: 'ShardManager',
      content: shardConfig.task,
      routing: {
        source: 'api',
        gateway: cloneGatewayRoutingEnvelope(gatewayRouting),
      },
      timestamp: new Date(),
    };
    return this.executeShard(shardId, channelId, preparedConfig, baseMessage);
  }

  private async executeShard(
    shardId: string,
    channelId: string,
    shardConfig: ResolvedShardConfig,
    baseMessage: SubstrateMessage,
  ): Promise<ShardResult> {
    this.refreshShardHealth();
    if (this.activeCount >= this.maxConcurrent) {
      throw new Error(
        `Shard limit reached (${this.maxConcurrent} concurrent). Wait for active shards to complete.`,
      );
    }

    const startTime = Date.now();
    const gatewayRouting = shardConfig.gatewayRouting;
    const lineage = gatewayRouting.shard as ShardLineage;
    const maxTurns = shardConfig.maxTurns ?? DEFAULT_MAX_TURNS;
    const capabilities = this.resolveAdvertisedCapabilities(shardConfig.capabilities);
    const requiredCapabilities = this.resolveRequiredCapabilities(shardConfig.requiredCapabilities);
    const backend = resolveRequestedShardBackend(shardConfig);
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

    this.activeCount++;
    const runtimeRecord: ShardRuntimeRecord = {
      shardId,
      name: shardConfig.name,
      backend,
      task: shardConfig.task,
      channelId,
      createdAt: startTime,
      startedAt: startTime,
      lifecycleState: 'registering',
      runtimeState: 'preparing',
      runtimeStateReason: 'spawn_requested',
      stateReason: 'spawn_requested',
      health: 'healthy',
      lastTransitionAt: startTime,
      lastHeartbeatAt: startTime,
      heartbeatStaleAfterMs,
      heartbeatDisconnectAfterMs,
      artifactLifecycleState: 'pending',
      artifactUpdatedAt: startTime,
      inputTokens: 0,
      outputTokens: 0,
      turns: 0,
      creationMode: shardConfig.creationMode,
      capabilities,
      requiredCapabilities,
      lineage,
      gatewayRouting,
      taggedOutputs: [],
      workLog: [],
      mergeReview: this.createEmptyMergeReview(shardId, startTime),
    };
    this.activeShards.set(shardId, runtimeRecord);
    this.shardRecords.set(shardId, runtimeRecord);
    this.noteShardHistory(shardId);
    this.registerActiveShardChannel(channelId, shardId);
    this.appendWorkLog(
      shardId,
      'task_declared',
      `Shard remit declared for "${shardConfig.name}".`,
      [
        `creation_mode=${shardConfig.creationMode}`,
        `channel_id=${channelId}`,
        `task=${this.truncateContextText(shardConfig.task, CONTEXT_PACK_ENTRY_CONTENT_MAX_CHARS)}`,
      ],
      startTime,
    );
    if (shardConfig.parentContext) {
      this.appendWorkLog(
        shardId,
        'context_seeded',
        `Shard context seeded from ${shardConfig.parentContext.source.channelId}.`,
        [
          `source_channel=${shardConfig.parentContext.source.channelId}`,
          `transcript_entries=${shardConfig.parentContext.transcript.entries.length}`,
          `memory_seeded=${shardConfig.parentContext.memory ? 'true' : 'false'}`,
        ],
        startTime,
      );
    }
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
      backend,
      creationMode: shardConfig.creationMode,
      maxTurns,
      channelId,
      companionId: gatewayRouting.companionId,
      shardCompanionId: lineage.shardCompanionId,
      parentShardId: lineage.parentShardId,
      capabilities,
      requiredCapabilities,
    });
    try {
      await this.assertShardBackendReady(shardId, shardConfig.name, backend, shardConfig.sourceContext);

      // Each shard gets its own SessionManager wrapping the shared store
      const sessionManager = new SessionManager(
        this.deps.sessionStore,
        this.deps.config,
        this.deps.eventBus,
      );

      const systemPrompt = this.resolveSystemPrompt(shardConfig);

      const agentLoop = new SubstrateAgent(
        this.deps.eventBus,
        this.deps.llmProvider,
        sessionManager,
        systemPrompt,
        this.deps.config,
        {
          runtimeMode: this.deps.runtimeMode ?? 'single',
        },
      );

      // Shards can READ memory but don't extract or archive (ephemeral)
      if (this.deps.memoryProvider && !shardConfig.parentContext) {
        agentLoop.memoryProvider = this.deps.memoryProvider;
      }

      // Shards don't recurse or self-escalate: we inject a tier-limited subset only.
      const injectedTools = this.resolveInjectedTools(shardId);
      for (const tool of injectedTools) {
        agentLoop.registerTool(tool);
      }
      this.auditTrail?.append('shard.tools.injected', {
        shardId,
        tier: this.resolveCapabilityTier(),
        tools: injectedTools.map(tool => tool.name),
      });
      this.transitionRuntimeState(shardId, 'running', 'agent_initialized');
      this.transitionShardState(shardId, 'ready', 'agent_initialized');
      this.touchShardHeartbeat(shardId);
      // No memoryExtractor — shards don't run L1 extraction/archive jobs.

      // Execute (single-turn by default)
      let totalInput = 0;
      let totalOutput = 0;
      let lastModel = '';
      let lastContent = '';
      let turns = 0;

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

        totalInput += response.metadata.inputTokens;
        totalOutput += response.metadata.outputTokens;
        lastModel = response.metadata.model;
        lastContent = response.content;
        turns++;
        this.touchShardHeartbeat(shardId);

        // For single-turn (default), we break after one turn
        // For multi-turn, we continue only if the response suggests more work
        if (turn === 0 && maxTurns === 1) break;
      }

      const completedAt = Date.now();
      this.setShardArtifact(
        shardId,
        lastContent,
        lastModel,
        totalInput,
        totalOutput,
        turns,
        completedAt,
      );
      this.transitionRuntimeState(shardId, 'awaiting_delivery', 'artifact_ready');
      this.transitionShardState(shardId, 'offline', 'completed');
      this.markShardCompleted(shardId, completedAt);
      const finishedShard = this.shardRecords.get(shardId);
      const result: ShardResult = {
        shardId,
        name: shardConfig.name,
        backend,
        content: lastContent,
        model: lastModel,
        inputTokens: totalInput,
        outputTokens: totalOutput,
        durationMs: completedAt - startTime,
        turns,
        creationMode: shardConfig.creationMode,
        lifecycleState: finishedShard?.lifecycleState ?? 'offline',
        runtimeState: finishedShard?.runtimeState ?? 'awaiting_delivery',
        runtimeStateReason: finishedShard?.runtimeStateReason ?? 'artifact_ready',
        health: finishedShard?.health ?? 'healthy',
        stateReason: finishedShard?.stateReason ?? 'completed',
        artifactLifecycleState: finishedShard?.artifactLifecycleState ?? 'available',
        ...(finishedShard?.artifactAvailableAt
          ? { artifactAvailableAt: finishedShard.artifactAvailableAt }
          : {}),
        ...(finishedShard?.deliveredAt ? { deliveredAt: finishedShard.deliveredAt } : {}),
        ...(finishedShard?.failureReason ? { failureReason: finishedShard.failureReason } : {}),
        capabilities: [...capabilities],
        requiredCapabilities: [...requiredCapabilities],
        lineage,
        gatewayRouting,
        taggedOutputs: this.cloneTaggedOutputs(finishedShard?.taggedOutputs ?? []),
        workLog: this.cloneWorkLog(finishedShard?.workLog ?? []),
        mergeReview: this.cloneMergeReview(
          finishedShard?.mergeReview ?? this.createEmptyMergeReview(shardId, completedAt),
        ),
      };
      this.auditTrail?.append('shard.spawn.end', {
        shardId,
        status: 'completed',
        creationMode: shardConfig.creationMode,
        durationMs: result.durationMs,
        turns: result.turns,
        companionId: result.gatewayRouting.companionId,
        shardCompanionId: result.lineage.shardCompanionId,
        lifecycleState: result.lifecycleState,
        runtimeState: result.runtimeState,
        artifactLifecycleState: result.artifactLifecycleState,
        health: result.health,
      });
      return result;
    } catch (error) {
      const msg = toErrorMessage(error);
      this.transitionRuntimeState(shardId, 'failed', 'execution_failed');
      this.transitionShardState(shardId, 'degraded', 'execution_failed', msg);
      this.transitionShardState(shardId, 'offline', 'execution_failed', msg);
      this.markShardFailure(shardId, msg);
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

  private deriveGatewayRouting(
    shardId: string,
    creationMode: ShardCreationMode,
    inherited: GatewayRoutingEnvelope | undefined,
  ): GatewayRoutingEnvelope {
    if (inherited?.shard?.shardId === shardId) {
      return cloneGatewayRoutingEnvelope(inherited) ?? deriveShardRoutingEnvelope({
        companionId: this.companionId,
        shardId,
        creationMode,
      });
    }
    const companionId = inherited?.companionId.trim() || this.companionId;
    return deriveShardRoutingEnvelope({
      companionId,
      shardId,
      creationMode,
      parentShardId: inherited?.shard?.shardId,
      ...(inherited?.subagentAddress ? { subagentAddress: inherited.subagentAddress } : {}),
    });
  }

  getActiveCount(): number {
    this.refreshShardHealth();
    return this.activeCount;
  }

  getActiveShards(): ActiveShard[] {
    this.refreshShardHealth();
    return [...this.activeShards.values()].map(shard => this.cloneShardRecord(shard));
  }

  getRuntimeSnapshot(options: ShardRuntimeSnapshotOptions = {}): ShardRuntimeSnapshot {
    this.refreshShardHealth();
    const shardLimit = normalizePositiveInteger(options.shardLimit, 10);
    const transcriptLimit = normalizePositiveInteger(options.transcriptLimit, 8);
    const activeShards = [...this.activeShards.values()].map(shard => this.buildRuntimeTaskView(shard, transcriptLimit));
    const recentShards = this.shardHistoryOrder
      .map(shardId => this.shardRecords.get(shardId))
      .filter((shard): shard is ShardRuntimeRecord => shard !== undefined && !this.activeShards.has(shard.shardId))
      .slice(0, shardLimit)
      .map(shard => this.buildRuntimeTaskView(shard, transcriptLimit));

    return {
      generatedAt: Date.now(),
      activeCount: this.activeCount,
      activeShards,
      recentShards,
    };
  }

  getRuntimeShardView(
    shardId: string,
    options: ShardRuntimeSnapshotOptions = {},
  ): ShardRuntimeTaskView | null {
    this.refreshShardHealth();
    const transcriptLimit = normalizePositiveInteger(options.transcriptLimit, 8);
    const shard = this.shardRecords.get(shardId);
    if (!shard) {
      return null;
    }
    return this.buildRuntimeTaskView(shard, transcriptLimit);
  }

  recordArtifactReturn(shardId: string): void {
    const shard = this.shardRecords.get(shardId);
    if (!shard || shard.artifactLifecycleState === 'pending' || shard.artifactLifecycleState === 'none') {
      return;
    }
    const returnedAt = Date.now();
    shard.mergeReview.artifactReturnedAt = returnedAt;
    shard.mergeReview.lastUpdatedAt = returnedAt;
    this.appendWorkLog(
      shardId,
      'artifact_returned',
      'Artifact returned to parent runtime; merge review remains required before core-state promotion.',
      [
        `artifact_state=${shard.artifactLifecycleState}`,
        `review_status=${shard.mergeReview.status}`,
      ],
      returnedAt,
    );
    this.auditTrail?.append('shard.foldback.artifact.returned', {
      shardId,
      artifactLifecycleState: shard.artifactLifecycleState,
      reviewStatus: shard.mergeReview.status,
      returnedAt,
    });
  }

  markArtifactDelivered(shardId: string): void {
    const shard = this.shardRecords.get(shardId);
    if (!shard || shard.artifactLifecycleState !== 'available') {
      return;
    }
    const deliveredAt = Date.now();
    shard.artifactLifecycleState = 'delivered';
    shard.artifactUpdatedAt = deliveredAt;
    shard.deliveredAt = deliveredAt;
    this.approveTaggedOutputsByKind(shardId, 'l0_output', deliveredAt);
    this.transitionRuntimeState(shardId, 'completed', 'artifact_delivered', deliveredAt);
    this.refreshMergeReviewState(shardId, deliveredAt);
  }

  private resolveHeartbeatStaleAfterMs(value: number | undefined): number {
    return normalizeHeartbeatStaleAfterMs(value, this.heartbeatStaleAfterMs);
  }

  private resolveHeartbeatDisconnectAfterMs(value: number | undefined, staleAfterMs: number): number {
    return normalizeHeartbeatDisconnectAfterMs(value, staleAfterMs, this.heartbeatDisconnectAfterMs);
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
    if (shard.lifecycleState === 'degraded' && shard.stateReason === 'heartbeat_stale') {
      this.transitionShardState(shardId, 'ready', 'heartbeat_recovered');
    }
  }

  private refreshShardHealth(now = Date.now()): void {
    const activeShards = [...this.activeShards.values()];
    for (const shard of activeShards) {
      const inHeartbeatManagedState = shard.lifecycleState === 'registering'
        || shard.lifecycleState === 'ready'
        || (shard.lifecycleState === 'degraded' && shard.stateReason === 'heartbeat_stale');
      if (!inHeartbeatManagedState) {
        continue;
      }

      const staleForMs = now - shard.lastHeartbeatAt;
      if (staleForMs <= shard.heartbeatStaleAfterMs) {
        continue;
      }

      const staleReason = `No heartbeat observed for ${staleForMs}ms (limit ${shard.heartbeatStaleAfterMs}ms).`;
      this.transitionShardState(shard.shardId, 'degraded', 'heartbeat_stale', staleReason);
      if (staleForMs <= shard.heartbeatDisconnectAfterMs) {
        continue;
      }

      const timeoutReason =
        `Heartbeat stale for ${staleForMs}ms exceeded recovery window `
        + `(${shard.heartbeatDisconnectAfterMs}ms).`;
      this.transitionRuntimeState(shard.shardId, 'detached', 'heartbeat_timeout');
      this.transitionShardState(shard.shardId, 'offline', 'heartbeat_timeout', timeoutReason);
      this.releaseActiveShard(shard.shardId, shard.channelId);
      this.auditTrail?.append('shard.health.evict', {
        shardId: shard.shardId,
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
    if (shard.lifecycleState !== 'ready' || shard.health !== 'healthy') {
      const detail = shard.failureReason
        ? `${shard.stateReason}; ${shard.failureReason}`
        : shard.stateReason;
      throw new Error(
        `Shard routing denied: "${shard.name}" is ${shard.lifecycleState}/${shard.health} (${detail}).`,
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
    const shard = this.shardRecords.get(shardId);
    if (!shard) {
      return;
    }

    const now = Date.now();
    const currentState = shard.lifecycleState;
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
      shard.lifecycleState = nextState;
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

  private transitionRuntimeState(
    shardId: string,
    nextState: ShardRuntimeState,
    reason: string,
    timestamp = Date.now(),
  ): void {
    const shard = this.shardRecords.get(shardId);
    if (!shard) {
      return;
    }
    if (shard.runtimeState === nextState && shard.runtimeStateReason === reason) {
      return;
    }
    shard.runtimeState = nextState;
    shard.runtimeStateReason = reason;
    shard.lastTransitionAt = timestamp;
  }

  private setShardArtifact(
    shardId: string,
    content: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
    turns: number,
    completedAt: number,
  ): void {
    const shard = this.shardRecords.get(shardId);
    if (!shard) {
      return;
    }
    shard.content = content;
    shard.model = model;
    shard.inputTokens = inputTokens;
    shard.outputTokens = outputTokens;
    shard.turns = turns;
    shard.completedAt = completedAt;
    shard.artifactLifecycleState = 'available';
    shard.artifactUpdatedAt = completedAt;
    shard.artifactAvailableAt = completedAt;
    shard.taggedOutputs.push(
      this.createTaggedOutput(
        shard,
        'l0_output',
        'Final shard output',
        content,
        'shard_final_response',
        completedAt,
      ),
    );
    this.appendWorkLog(
      shardId,
      'artifact_ready',
      'Shard artifact staged for fold-back review.',
      [
        `artifact_state=${shard.artifactLifecycleState}`,
        `tagged_output_count=${shard.taggedOutputs.length}`,
      ],
      completedAt,
    );
    this.requireMergeReview(shardId, 'artifact_output_pending_merge_review', completedAt);
  }

  private markShardCompleted(shardId: string, completedAt: number): void {
    const shard = this.shardRecords.get(shardId);
    if (!shard) {
      return;
    }
    shard.completedAt = completedAt;
  }

  private markShardFailure(shardId: string, failureReason: string): void {
    const shard = this.shardRecords.get(shardId);
    if (!shard) {
      return;
    }
    shard.failureReason = failureReason;
    shard.completedAt = Date.now();
    shard.artifactLifecycleState = 'none';
    shard.artifactUpdatedAt = shard.completedAt;
    shard.mergeReview.lastUpdatedAt = shard.completedAt;
  }

  private buildRuntimeTaskView(
    shard: ShardRuntimeRecord,
    transcriptLimit: number,
  ): ShardRuntimeTaskView {
    const transcript = this.deps.sessionStore.getRecent(shard.channelId, transcriptLimit);
    const transcriptMessageCount = this.deps.sessionStore.count(shard.channelId);
    const transcriptTruncated = transcriptMessageCount > transcriptLimit;
    const latestL0Output = [...shard.taggedOutputs]
      .reverse()
      .find(output => output.kind === 'l0_output');
    const artifacts = shard.content && shard.artifactLifecycleState !== 'pending' && shard.artifactLifecycleState !== 'none'
      ? [{
        kind: 'final_output' as const,
        lifecycleState: shard.artifactLifecycleState,
        content: shard.content,
        timestamp: shard.artifactAvailableAt ?? shard.completedAt ?? shard.startedAt,
        reviewRequired: latestL0Output?.reviewRequired ?? true,
        reviewState: latestL0Output?.reviewState ?? 'pending',
        provenance: latestL0Output?.provenance ?? this.createTaggedOutputProvenance(
          shard,
          'shard_final_response',
        ),
        ...(shard.deliveredAt ? { deliveredAt: shard.deliveredAt } : {}),
      }]
      : [];
    const lastEntry = transcript.at(-1);
    const lastActivityAt = lastEntry?.timestamp
      ?? shard.deliveredAt
      ?? shard.artifactAvailableAt
      ?? shard.completedAt
      ?? shard.lastHeartbeatAt;
    const deliveryPending = shard.artifactLifecycleState === 'available';
    const resume = {
      channelId: shard.channelId,
      lifecycleState: shard.lifecycleState,
      runtimeState: shard.runtimeState,
      health: shard.health,
      mode: deliveryPending ? 'delivery' as const : 'none' as const,
      resumable: deliveryPending,
      artifactLifecycleState: shard.artifactLifecycleState,
      artifactAvailable: shard.artifactLifecycleState === 'available' || shard.artifactLifecycleState === 'delivered',
      deliveryPending,
      transcriptAvailable: transcriptMessageCount > 0,
      transcriptMessageCount,
      transcriptTruncated,
      ...(Number.isFinite(lastActivityAt) ? { lastActivityAt } : {}),
      ...(shard.artifactAvailableAt ? { artifactAvailableAt: shard.artifactAvailableAt } : {}),
      ...(shard.deliveredAt ? { deliveredAt: shard.deliveredAt } : {}),
      ...(lastEntry?.id ? { lastMessageId: lastEntry.id } : {}),
    };

    return {
      task: this.cloneShardRecord(shard),
      transcript,
      transcriptMessageCount,
      transcriptTruncated,
      artifacts,
      taggedOutputs: this.cloneTaggedOutputs(shard.taggedOutputs),
      workLog: this.cloneWorkLog(shard.workLog),
      review: this.cloneMergeReview(shard.mergeReview),
      resume,
    };
  }

  private cloneShardRecord(shard: ShardRuntimeRecord): ShardRuntimeRecord {
    return {
      ...shard,
      capabilities: [...shard.capabilities],
      requiredCapabilities: [...shard.requiredCapabilities],
      lineage: { ...shard.lineage },
      gatewayRouting: cloneGatewayRoutingEnvelope(shard.gatewayRouting) ?? shard.gatewayRouting,
      taggedOutputs: this.cloneTaggedOutputs(shard.taggedOutputs),
      workLog: this.cloneWorkLog(shard.workLog),
      mergeReview: this.cloneMergeReview(shard.mergeReview),
    };
  }

  private noteShardHistory(shardId: string): void {
    this.shardHistoryOrder = [shardId, ...this.shardHistoryOrder.filter(current => current !== shardId)];
    const obsoleteShardIds = this.shardHistoryOrder.slice(this.runtimeShardHistoryLimit);
    this.shardHistoryOrder = this.shardHistoryOrder.slice(0, this.runtimeShardHistoryLimit);
    for (const obsoleteShardId of obsoleteShardIds) {
      if (this.activeShards.has(obsoleteShardId)) {
        continue;
      }
      this.shardRecords.delete(obsoleteShardId);
    }
  }

  private installAuditHooks(): void {
    this.deps.eventBus.on('agent.tool.start', (event) => {
      const shardId = this.resolveShardId(event.channelId);
      if (!shardId) return;
      this.touchShardHeartbeat(shardId);
      this.appendWorkLog(
        shardId,
        'tool_invoked',
        `Shard invoked tool "${event.toolName}".`,
        [
          `tool_name=${event.toolName}`,
          `tool_call_id=${event.toolCallId}`,
        ],
      );
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

  private resolveInjectedTools(shardId: string): AgentTool<any>[] {
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

    return selected.map(tool => this.wrapShardTool(tool, shardId));
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

  private async assertShardBackendReady(
    shardId: string,
    shardName: string,
    backend: ShardBackend,
    sourceContext?: ShardConfig['sourceContext'],
  ): Promise<void> {
    if (backend === 'inline') {
      return;
    }

    const capabilityTier = this.resolveCapabilityTier();
    assertMediatedShardBackendTier(backend, capabilityTier);
    const decision = await this.backendController.requestBackend({
      shardId,
      shardName,
      backend,
      capabilityTier,
      ...(sourceContext ? { sourceContext } : {}),
    });
    this.auditTrail?.append('shard.backend.control', {
      shardId,
      shardName,
      backend,
      controller: decision.controller,
      status: decision.status,
      reason: decision.reason,
      capabilityTier,
    });
    if (decision.status !== 'approved') {
      throw new Error(`Shard backend "${backend}" is unavailable: ${decision.reason}`);
    }

    throw new Error(
      `Shard backend "${backend}" was approved by ${decision.controller} mediation `
      + 'but no shard faculty executor is wired for mediated backend execution.',
    );
  }

  private resolveCreationMode(shardConfig: ShardConfig): ShardCreationMode {
    return shardConfig.creationMode ?? 'fresh';
  }

  private assertShardCreationContract(
    shardConfig: ShardConfig,
    creationMode: ShardCreationMode,
  ): void {
    if (creationMode === 'forked') {
      if (shardConfig.parentContext || shardConfig.sourceContext) {
        return;
      }
      throw new Error(
        'Forked shard creation requires sourceContext or a typed parentContext snapshot.',
      );
    }

    if (shardConfig.parentContext || shardConfig.sourceContext) {
      throw new Error(
        'Fresh shard creation must not inherit parent context. Set creationMode to "forked" to inherit source context.',
      );
    }
  }

  private async buildParentContextSnapshot(
    shardId: string,
    shardChannelId: string,
    shardConfig: ShardConfig,
  ): Promise<ShardParentContextSnapshot> {
    const source = this.normalizeSourceContext(shardConfig.sourceContext);
    if (!source) {
      throw new Error(
        'Forked shard creation requires a non-empty sourceContext.channelId when parentContext is not supplied.',
      );
    }

    const policyDecision = evaluateCompositionalPolicyForChannelId({
      policy: this.deps.config.compositionalPolicy,
      capabilityTier: this.resolveCapabilityTier(),
      channelId: source.channelId,
      purpose: 'shard_context',
    });
    if (!policyDecision.allowed) {
      throw new Error(
        `Forked shard creation denied for source channel "${source.channelId}" (${policyDecision.reason}).`,
      );
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

    return {
      purpose: 'shard_context',
      inheritedFrom: 'source_channel',
      task: shardConfig.task,
      source,
      transcript: {
        kind: 'session_entries',
        entries: sessionEntries,
      },
      ...(memoryBlock
        ? {
          memory: {
            kind: 'memory_block',
            content: memoryBlock,
          },
        }
        : {}),
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
    return {
      channelId,
      ...(requestId ? { requestId } : {}),
      ...(turnId ? { turnId } : {}),
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

  private buildPromptDiscipline(
    shardConfig: ShardConfig,
    creationMode: ShardCreationMode,
    parentContext: ShardParentContextSnapshot | undefined,
  ): ShardPromptDiscipline {
    const stablePrefix = this.deps.parentSystemPrompt.trim();
    const remitSupplement = shardConfig.systemPrompt?.trim();

    return {
      stablePrefix,
      remit: [
        `Creation mode: ${creationMode}.`,
        `Shard name: ${shardConfig.name.trim()}.`,
        `Shard task: ${this.truncateContextText(shardConfig.task, CONTEXT_PACK_ENTRY_CONTENT_MAX_CHARS)}.`,
        ...(remitSupplement ? [`Remit notes: ${remitSupplement}`] : []),
        ...(parentContext ? [`Inherited source channel: ${parentContext.source.channelId}.`] : []),
      ].join('\n'),
      guardrails: [
        ...DEFAULT_SHARD_PROMPT_GUARDRAILS,
        ...(creationMode === 'forked'
          ? ['Treat inherited parent context as a read-only snapshot, not as a live conversation to continue.']
          : ['Do not assume any hidden parent context beyond the shard remit.']),
      ],
    };
  }

  private resolveSystemPrompt(shardConfig: ResolvedShardConfig): string {
    return [
      shardConfig.promptDiscipline.stablePrefix,
      this.renderPromptDiscipline(shardConfig.promptDiscipline),
      ...(shardConfig.parentContext ? [this.renderParentContextSnapshot(shardConfig.parentContext)] : []),
    ]
      .map(section => section.trim())
      .filter(section => section.length > 0)
      .join('\n\n');
  }

  private renderPromptDiscipline(promptDiscipline: ShardPromptDiscipline): string {
    return [
      '[Shard remit]',
      promptDiscipline.remit,
      '',
      '[Shard guardrails]',
      ...promptDiscipline.guardrails.map(guardrail => `- ${guardrail}`),
    ].join('\n');
  }

  private renderParentContextSnapshot(parentContext: ShardParentContextSnapshot): string {
    const sourceConversation = parentContext.transcript.entries
      .map(entry => {
        const speaker = entry.role === 'assistant'
          ? 'Assistant'
          : entry.role === 'system'
            ? 'System'
            : (entry.authorName?.trim() || 'User');
        return `${speaker}: ${entry.content}`;
      })
      .join('\n');

    return [
      '[Forked shard parent context]',
      'Use this inherited parent snapshot as read-only context while completing the shard remit.',
      `Inherited from: ${parentContext.inheritedFrom}`,
      `Source channel: ${parentContext.source.channelId}`,
      ...(parentContext.source.requestId ? [`Source requestId: ${parentContext.source.requestId}`] : []),
      ...(parentContext.source.turnId ? [`Source turnId: ${parentContext.source.turnId}`] : []),
      `Task scope: ${this.truncateContextText(parentContext.task, CONTEXT_PACK_ENTRY_CONTENT_MAX_CHARS)}`,
      ...(sourceConversation
        ? [
          '',
          '[Focused source conversation]',
          sourceConversation,
        ]
        : []),
      ...(parentContext.memory?.content
        ? [
          '',
          '[Task-scoped memory]',
          parentContext.memory.content,
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

  private buildShardValidationPath(shardId: string): string {
    return `/api/admin/shards/${encodeURIComponent(shardId)}`;
  }

  private createEmptyMergeReview(shardId: string, timestamp: number): ShardMergeReview {
    return {
      required: false,
      status: 'none',
      validationPath: this.buildShardValidationPath(shardId),
      lastUpdatedAt: timestamp,
      pendingTaggedOutputCount: 0,
      blockingReasons: [],
    };
  }

  private cloneTaggedOutputs(outputs: readonly ShardTaggedOutput[]): ShardTaggedOutput[] {
    return outputs.map(output => ({
      ...output,
      provenance: {
        ...output.provenance,
        tags: [...output.provenance.tags],
      },
    }));
  }

  private cloneWorkLog(workLog: readonly ShardWorkLogEntry[]): ShardWorkLogEntry[] {
    return workLog.map(entry => ({
      ...entry,
      details: [...entry.details],
    }));
  }

  private cloneMergeReview(review: ShardMergeReview): ShardMergeReview {
    return {
      ...review,
      blockingReasons: [...review.blockingReasons],
    };
  }

  private appendWorkLog(
    shardId: string,
    event: ShardWorkLogEvent,
    message: string,
    details: string[] = [],
    timestamp = Date.now(),
  ): void {
    const shard = this.shardRecords.get(shardId);
    if (!shard) {
      return;
    }
    shard.workLog.push({
      entryId: `worklog-${randomUUID()}`,
      event,
      timestamp,
      message,
      details: [...details],
    });
  }

  private createTaggedOutputProvenance(
    shard: Pick<ShardRuntimeRecord, 'channelId' | 'task' | 'lineage'>,
    source: ShardTaggedOutputSource,
    options: {
      sourceToolName?: string;
      toolCallId?: string;
      provenanceTags?: string[];
    } = {},
  ): ShardTaggedOutputProvenance {
    return {
      coreCompanionId: shard.lineage.coreCompanionId,
      shardCompanionId: shard.lineage.shardCompanionId,
      shardId: shard.lineage.shardId,
      channelId: shard.channelId,
      task: shard.task,
      source,
      ...(options.sourceToolName ? { sourceToolName: options.sourceToolName } : {}),
      ...(options.toolCallId ? { toolCallId: options.toolCallId } : {}),
      tags: [...new Set(options.provenanceTags?.filter(Boolean) ?? [])],
    };
  }

  private createTaggedOutput(
    shard: ShardRuntimeRecord,
    kind: ShardTaggedOutputKind,
    label: string,
    content: string,
    source: ShardTaggedOutputSource,
    createdAt: number,
    options: {
      sourceToolName?: string;
      toolCallId?: string;
      provenanceTags?: string[];
      reviewState?: ShardTaggedOutput['reviewState'];
    } = {},
  ): ShardTaggedOutput {
    const normalizedContent = content.trim();
    const reviewState = options.reviewState ?? 'pending';
    return {
      outputId: `output-${randomUUID()}`,
      kind,
      label,
      content: normalizedContent,
      preview: this.truncateContextText(normalizedContent, SHARD_TAGGED_OUTPUT_PREVIEW_MAX_CHARS),
      createdAt,
      reviewRequired: true,
      reviewState,
      blockedCorePromotion: reviewState !== 'approved',
      provenance: this.createTaggedOutputProvenance(shard, source, {
        ...options,
        provenanceTags: [
          'fold_back',
          `tagged_output_kind:${kind}`,
          `tagged_output_source:${source}`,
          ...(options.provenanceTags ?? []),
        ],
      }),
    };
  }

  private approveTaggedOutputsByKind(
    shardId: string,
    kind: ShardTaggedOutputKind,
    timestamp = Date.now(),
  ): void {
    const shard = this.shardRecords.get(shardId);
    if (!shard) {
      return;
    }
    let updated = false;
    for (const output of shard.taggedOutputs) {
      if (output.kind !== kind || output.reviewState === 'approved') {
        continue;
      }
      output.reviewState = 'approved';
      output.blockedCorePromotion = false;
      updated = true;
    }
    if (updated) {
      this.appendWorkLog(
        shardId,
        'merge_review_approved',
        `Approved shard tagged outputs of kind "${kind}".`,
        [`kind=${kind}`],
        timestamp,
      );
      this.auditTrail?.append('shard.foldback.review.approved', {
        shardId,
        kind,
        timestamp,
      });
    }
  }

  private computeMergeReviewBlockingReasons(shard: ShardRuntimeRecord): string[] {
    const pendingOutputs = shard.taggedOutputs.filter(output => output.reviewRequired && output.reviewState === 'pending');
    const reasons = new Set<string>();
    if (pendingOutputs.some(output => output.kind === 'l0_output')) {
      reasons.add('artifact_output_pending_merge_review');
    }
    if (pendingOutputs.some(output => output.kind === 'l2_memory')) {
      reasons.add('staged_shard_memory_pending_merge_review');
    }
    if (pendingOutputs.some(output => output.provenance.tags.includes('interpretive:emotional_or_relational'))) {
      reasons.add('emotional_or_relational_interpretation_requires_core_review');
    }
    return [...reasons];
  }

  private refreshMergeReviewState(shardId: string, timestamp = Date.now()): void {
    const shard = this.shardRecords.get(shardId);
    if (!shard) {
      return;
    }
    const previousStatus = shard.mergeReview.status;
    const blockingReasons = this.computeMergeReviewBlockingReasons(shard);
    const hasReviewableOutputs = shard.taggedOutputs.some(output => output.reviewRequired);
    const required = shard.mergeReview.required || hasReviewableOutputs;
    const pendingTaggedOutputCount = shard.taggedOutputs
      .filter(output => output.reviewRequired && output.reviewState === 'pending')
      .length;
    shard.mergeReview.required = required;
    shard.mergeReview.status = pendingTaggedOutputCount > 0
      ? 'pending'
      : required
        ? 'approved'
        : 'none';
    if (hasReviewableOutputs && !shard.mergeReview.requestedAt) {
      shard.mergeReview.requestedAt = timestamp;
    }
    if (required && shard.mergeReview.status === 'approved') {
      shard.mergeReview.approvedAt = timestamp;
    }
    if (shard.mergeReview.status !== 'approved') {
      delete shard.mergeReview.approvedAt;
    }
    shard.mergeReview.lastUpdatedAt = timestamp;
    shard.mergeReview.pendingTaggedOutputCount = pendingTaggedOutputCount;
    shard.mergeReview.blockingReasons = blockingReasons;

    if (required && previousStatus !== 'pending') {
      this.appendWorkLog(
        shardId,
        'merge_review_pending',
        'Shard fold-back outputs require explicit merge review.',
        [
          ...blockingReasons.map(reason => `reason=${reason}`),
          `validation_path=${shard.mergeReview.validationPath}`,
        ],
        timestamp,
      );
      this.auditTrail?.append('shard.foldback.review.pending', {
        shardId,
        blockingReasons,
        pendingTaggedOutputCount,
        validationPath: shard.mergeReview.validationPath,
        timestamp,
      });
    }
  }

  private requireMergeReview(shardId: string, _reason: string, timestamp = Date.now()): void {
    this.refreshMergeReviewState(shardId, timestamp);
  }

  private parseShardMemoryTags(rawTags: unknown): string[] {
    if (Array.isArray(rawTags)) {
      return rawTags
        .flatMap(tag => typeof tag === 'string' ? [tag.trim().toLowerCase()] : [])
        .filter(Boolean);
    }
    if (typeof rawTags !== 'string') {
      return [];
    }
    return rawTags
      .split(',')
      .map(tag => tag.trim().toLowerCase())
      .filter(Boolean);
  }

  private isEmotionalOrRelationalMemory(memoryType: string | undefined, tags: readonly string[]): boolean {
    if (memoryType?.trim().toLowerCase() === 'emotional') {
      return true;
    }
    return tags.some(tag => (
      tag.includes('relationship')
      || tag.includes('relational')
      || tag.includes('contact')
      || tag.includes('partner')
      || tag.includes('family')
      || tag.includes('friend')
    ));
  }

  private buildMemoryOutputProvenanceTags(
    memoryType: unknown,
    rawTags: unknown,
    sensitivity: unknown,
  ): string[] {
    const tags = this.parseShardMemoryTags(rawTags);
    const normalizedType = typeof memoryType === 'string' ? memoryType.trim().toLowerCase() : '';
    const normalizedSensitivity = typeof sensitivity === 'string' ? sensitivity.trim().toLowerCase() : '';
    return [
      ...(normalizedType ? [`memory_type:${normalizedType}`] : []),
      ...(normalizedSensitivity ? [`sensitivity:${normalizedSensitivity}`] : []),
      ...tags.map(tag => `memory_tag:${tag}`),
      ...(this.isEmotionalOrRelationalMemory(normalizedType || undefined, tags)
        ? ['interpretive:emotional_or_relational']
        : []),
    ];
  }

  private resolveStagedShardMemoryOutputs(
    toolName: string,
    params: unknown,
  ): StagedShardMemoryOutput[] {
    if (typeof params !== 'object' || params === null || Array.isArray(params)) {
      return [];
    }
    const input = params as Record<string, unknown>;

    const toWriteOutput = (record: Record<string, unknown>, labelPrefix: string): StagedShardMemoryOutput[] => {
      const text = typeof record.text === 'string' ? record.text.trim() : '';
      if (!text) {
        return [];
      }
      const memoryType = typeof record.type === 'string' ? record.type.trim().toLowerCase() : '';
      return [{
        content: text,
        label: `${labelPrefix}${memoryType ? ` (${memoryType})` : ''}`,
        source: 'memory_write',
        provenanceTags: this.buildMemoryOutputProvenanceTags(
          record.type,
          record.tags,
          record.sensitivity,
        ),
      }];
    };

    const toImportOutputs = (
      records: unknown,
      sourceLabel: string,
    ): StagedShardMemoryOutput[] => {
      if (!Array.isArray(records)) {
        return [];
      }
      return records.flatMap((record, index) => {
        if (typeof record !== 'object' || record === null || Array.isArray(record)) {
          return [];
        }
        const entry = record as Record<string, unknown>;
        const text = typeof entry.text === 'string' ? entry.text.trim() : '';
        if (!text) {
          return [];
        }
        const memoryType = typeof entry.type === 'string' ? entry.type.trim().toLowerCase() : '';
        return [{
          content: text,
          label: `Imported shard memory ${index + 1} from ${sourceLabel}${memoryType ? ` (${memoryType})` : ''}`,
          source: 'memory_import_batch' as const,
          provenanceTags: this.buildMemoryOutputProvenanceTags(
            entry.type,
            entry.tags,
            entry.sensitivity,
          ),
        }];
      });
    };

    if (toolName === 'memory') {
      const action = typeof input.action === 'string' ? input.action.trim().toLowerCase() : '';
      if (action === 'write') {
        return toWriteOutput(input, 'Staged shard memory');
      }
      if (action === 'import') {
        const source = typeof input.source === 'string' && input.source.trim()
          ? input.source.trim().toLowerCase()
          : 'import';
        return toImportOutputs(input.records, source);
      }
      return [];
    }

    if (toolName === 'memory_write') {
      return toWriteOutput(input, 'Staged shard memory');
    }
    if (toolName === 'memory_import_batch') {
      const source = typeof input.source === 'string' && input.source.trim()
        ? input.source.trim().toLowerCase()
        : 'import';
      return toImportOutputs(input.records, source);
    }
    return [];
  }

  private captureShardFoldBackOutput(
    toolName: string,
    params: unknown,
    shardId: string,
    toolCallId: string,
  ) {
    const stagedOutputs = this.resolveStagedShardMemoryOutputs(toolName, params);
    if (stagedOutputs.length === 0) {
      return null;
    }

    const shard = this.shardRecords.get(shardId);
    if (!shard) {
      throw new Error(`Shard "${shardId}" is offline.`);
    }
    const timestamp = Date.now();
    const captured = stagedOutputs.map(output => {
      const taggedOutput = this.createTaggedOutput(
        shard,
        'l2_memory',
        output.label,
        output.content,
        output.source,
        timestamp,
        {
          sourceToolName: toolName,
          toolCallId,
          provenanceTags: output.provenanceTags,
        },
      );
      shard.taggedOutputs.push(taggedOutput);
      this.appendWorkLog(
        shardId,
        'l2_memory_staged',
        `Shard staged "${output.label}" for merge review.`,
        [
          `tool_name=${toolName}`,
          `tool_call_id=${toolCallId}`,
          `output_id=${taggedOutput.outputId}`,
        ],
        timestamp,
      );
      this.auditTrail?.append('shard.foldback.output.staged', {
        shardId,
        outputId: taggedOutput.outputId,
        kind: taggedOutput.kind,
        source: taggedOutput.provenance.source,
        toolName,
        toolCallId,
        provenanceTags: taggedOutput.provenance.tags,
      });
      return taggedOutput;
    });
    this.requireMergeReview(shardId, 'staged_shard_memory_pending_merge_review', timestamp);

    return textResult(
      captured.length === 1
        ? `Queued shard memory output ${captured[0].outputId} for merge review at ${shard.mergeReview.validationPath}; core state remains unchanged until approval.`
        : `Queued ${captured.length} shard memory outputs for merge review at ${shard.mergeReview.validationPath}; core state remains unchanged until approval.`,
    );
  }

  private assertShardCoreMutationAllowed(
    toolName: string,
    params: unknown,
    shardId: string,
    toolCallId: string,
  ): void {
    const deny = (reason: string): never => {
      this.appendWorkLog(
        shardId,
        'tool_invoked',
        `Denied shard core mutation via "${toolName}".`,
        [
          `tool_name=${toolName}`,
          `tool_call_id=${toolCallId}`,
          `reason=${reason}`,
        ],
      );
      this.auditTrail?.append('shard.foldback.mutation.denied', {
        shardId,
        toolName,
        toolCallId,
        reason,
      });
      throw new Error(reason);
    };

    if (toolName === 'memory') {
      if (typeof params !== 'object' || params === null || Array.isArray(params)) {
        return;
      }
      const rawAction = (params as { action?: unknown }).action;
      const action = typeof rawAction === 'string'
        ? rawAction.trim().toLowerCase()
        : '';
      if (action === 'redact' || action === 'delete' || action === 'restore') {
        deny(`Shard memory action "${action}" requires explicit merge review outside shard runtime.`);
      }
      return;
    }

    if (
      toolName === 'memory_redact'
      || toolName === 'memory_delete'
      || toolName === 'undo_memory_delete'
    ) {
      deny(`Shard tool "${toolName}" requires explicit merge review outside shard runtime.`);
    }
  }

  private wrapShardTool(tool: AgentTool<any>, shardId: string): AgentTool<any> {
    return {
      ...tool,
      execute: async (toolCallId, params, signal) => {
        const stagedOutput = this.captureShardFoldBackOutput(tool.name, params, shardId, toolCallId);
        if (stagedOutput) {
          return stagedOutput;
        }
        this.assertShardCoreMutationAllowed(tool.name, params, shardId, toolCallId);
        this.enforceShardToolSyncPolicy(tool.name, params, shardId, toolCallId);
        const scopedParams = this.applyShardSourceParams(tool.name, params, shardId);
        // scopedParams has extra shard-source fields; tool.execute expects Static<TSchema>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return tool.execute(toolCallId, scopedParams as any, signal);
      },
    };
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
      const rawAction = (params as { action?: unknown }).action;
      const action = typeof rawAction === 'string'
        ? rawAction.trim()
        : '';
      switch (action) {
        case 'write':
          return 'memory_write';
        case 'import':
          return 'memory_import_batch';
        case 'redact':
          return 'memory_redact';
        default:
          return null;
      }
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
    if (
      toolName !== 'memory'
      && toolName !== 'memory_write'
      && toolName !== 'memory_import_batch'
      && toolName !== 'memory_redact'
    ) {
      return params;
    }
    if (typeof params !== 'object' || params === null || Array.isArray(params)) {
      return params;
    }

    if (toolName === 'memory') {
      const rawAction = (params as { action?: unknown }).action;
      const action = typeof rawAction === 'string'
        ? rawAction.trim()
        : '';
      if (action !== 'write' && action !== 'import' && action !== 'redact') {
        return params;
      }
    }

    return {
      ...(params as Record<string, unknown>),
      [INTERNAL_SHARD_SOURCE_PARAM]: `shard:${shardId}`,
    };
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

function normalizePositiveInteger(value: unknown, fallback: number): number {
  const normalized = typeof value === 'number' && Number.isFinite(value)
    ? Math.trunc(value)
    : fallback;
  return Math.max(1, normalized);
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
