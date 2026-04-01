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
} from '../routing/envelope.js';
import type { ShardExecutionPort } from './port.js';
import type {
  ShardConfig,
  ShardContextPack,
  ShardContextPackEntry,
  ShardLifecycleState,
  ShardResult,
  ShardRuntimeRecord,
  ShardRuntimeSnapshot,
  ShardRuntimeSnapshotOptions,
  ShardRuntimeState,
  ShardRuntimeTaskView,
  ShardSourceContext,
} from './types.js';
import { toErrorMessage } from '../utils/errors.js';

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
const BLOCKED_SHARD_TOOL_NAMES = new Set(['spawn_shard', 'load_tools', 'toolset']);
const DEFAULT_RUNTIME_SHARD_HISTORY_LIMIT = 25;
const APPRENTICE_SHARD_TOOL_EXTRAS = [
  'contact_list',
] as const;
export const DEFAULT_SHARD_TOOLSET = [
  'memory',
  'contact_lookup',
  'repo_status',
  'repo_diff',
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
}

export type ActiveShard = ShardRuntimeRecord;

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
    this.installAuditHooks();
  }

  async spawn(shardConfig: ShardConfig): Promise<ShardResult> {
    this.refreshShardHealth();
    const shardId = `shard-${randomUUID()}`;
    const channelId = `shard:${shardId}`;
    const gatewayRouting = this.deriveGatewayRouting(shardId, shardConfig.gatewayRouting);
    const contextPack = shardConfig.contextPack ?? await this.buildContextPack(
      shardId,
      channelId,
      shardConfig,
    );
    const preparedConfig = contextPack
      ? { ...shardConfig, contextPack, gatewayRouting }
      : { ...shardConfig, gatewayRouting };
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
    shardConfig: ShardConfig,
    baseMessage: SubstrateMessage,
  ): Promise<ShardResult> {
    this.refreshShardHealth();
    if (this.activeCount >= this.maxConcurrent) {
      throw new Error(
        `Shard limit reached (${this.maxConcurrent} concurrent). Wait for active shards to complete.`,
      );
    }

    const startTime = Date.now();
    const gatewayRouting = this.deriveGatewayRouting(shardId, shardConfig.gatewayRouting);
    const lineage = gatewayRouting.shard as ShardLineage;
    const maxTurns = shardConfig.maxTurns ?? DEFAULT_MAX_TURNS;
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

    this.activeCount++;
    const runtimeRecord: ShardRuntimeRecord = {
      shardId,
      name: shardConfig.name,
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
      capabilities,
      requiredCapabilities,
      lineage,
      gatewayRouting,
    };
    this.activeShards.set(shardId, runtimeRecord);
    this.shardRecords.set(shardId, runtimeRecord);
    this.noteShardHistory(shardId);
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
      companionId: gatewayRouting.companionId,
      shardCompanionId: lineage.shardCompanionId,
      parentShardId: lineage.parentShardId,
      capabilities,
      requiredCapabilities,
    });
    try {
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
      if (this.deps.memoryProvider && !shardConfig.contextPack) {
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
        content: lastContent,
        model: lastModel,
        inputTokens: totalInput,
        outputTokens: totalOutput,
        durationMs: completedAt - startTime,
        turns,
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
      };
      this.auditTrail?.append('shard.spawn.end', {
        shardId,
        status: 'completed',
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
    inherited: GatewayRoutingEnvelope | undefined,
  ): GatewayRoutingEnvelope {
    if (inherited?.shard?.shardId === shardId) {
      return cloneGatewayRoutingEnvelope(inherited) ?? deriveShardRoutingEnvelope({
        companionId: this.companionId,
        shardId,
      });
    }
    const companionId = inherited?.companionId.trim() || this.companionId;
    return deriveShardRoutingEnvelope({
      companionId,
      shardId,
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

  markArtifactDelivered(shardId: string): void {
    const shard = this.shardRecords.get(shardId);
    if (!shard || shard.artifactLifecycleState !== 'available') {
      return;
    }
    const deliveredAt = Date.now();
    shard.artifactLifecycleState = 'delivered';
    shard.artifactUpdatedAt = deliveredAt;
    shard.deliveredAt = deliveredAt;
    this.transitionRuntimeState(shardId, 'completed', 'artifact_delivered', deliveredAt);
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
  }

  private buildRuntimeTaskView(
    shard: ShardRuntimeRecord,
    transcriptLimit: number,
  ): ShardRuntimeTaskView {
    const transcript = this.deps.sessionStore.getRecent(shard.channelId, transcriptLimit);
    const transcriptMessageCount = this.deps.sessionStore.count(shard.channelId);
    const transcriptTruncated = transcriptMessageCount > transcriptLimit;
    const artifacts = shard.content && shard.artifactLifecycleState !== 'pending' && shard.artifactLifecycleState !== 'none'
      ? [{
        kind: 'final_output' as const,
        lifecycleState: shard.artifactLifecycleState,
        content: shard.content,
        timestamp: shard.artifactAvailableAt ?? shard.completedAt ?? shard.startedAt,
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

  private async buildContextPack(
    shardId: string,
    shardChannelId: string,
    shardConfig: ShardConfig,
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
      sessionEntries,
      ...(memoryBlock ? { memoryBlock } : {}),
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
    const sourceConversation = contextPack.sessionEntries
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
      '[Shard context pack]',
      'Use only this task-scoped source context while working the shard task.',
      `Source channel: ${contextPack.source.channelId}`,
      ...(contextPack.source.requestId ? [`Source requestId: ${contextPack.source.requestId}`] : []),
      ...(contextPack.source.turnId ? [`Source turnId: ${contextPack.source.turnId}`] : []),
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

  private wrapShardTool(tool: AgentTool<any>, shardId: string): AgentTool<any> {
    return {
      ...tool,
      execute: async (toolCallId, params, signal) => {
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
      const action = typeof (params as Record<string, unknown>).action === 'string'
        ? (params as Record<string, unknown>).action.trim()
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
      const action = typeof (params as Record<string, unknown>).action === 'string'
        ? (params as Record<string, unknown>).action.trim()
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
