// ── ShardManager ──
// Spawns ephemeral AgentLoop instances for parallel task execution.
// Shards share parent's heavy resources (LLM, DB, memory) but get isolated channelIds.

import { randomUUID } from 'node:crypto';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import type {
  CapabilityTier,
  ShardToolsetConfig,
  SubstrateConfig,
  SubstrateMessage,
} from '../types.js';
import type { EventBus } from '../event-bus.js';
import type { LLMProvider, EmbeddingService, MemoryProvider } from '../agent-loop.js';
import { AgentLoop } from '../agent-loop.js';
import { normalizeCapabilityTier } from '../capabilities/tiers.js';
import type { SessionStore } from '../session/store.js';
import { SessionManager } from '../session/manager.js';
import type { ShardConfig, ShardResult } from './types.js';

const DEFAULT_MAX_CONCURRENT = 5;
const DEFAULT_MAX_TURNS = 1;
const SHARD_TOOLSET_ALL = '*';
const INTERNAL_SHARD_SOURCE_PARAM = '__psfnShardSource';
const BLOCKED_SHARD_TOOL_NAMES = new Set(['spawn_shard', 'load_tools']);
const APPRENTICE_SHARD_TOOL_EXTRAS = [
  'contact_list',
  'memory_import_batch',
] as const;
export const DEFAULT_SHARD_TOOLSET = [
  'memory_write',
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
  embeddingService: EmbeddingService | null;
  memoryProvider: MemoryProvider | null;
  config: SubstrateConfig;
  parentSystemPrompt: string;
  maxConcurrent?: number;
  shardToolsets?: ShardToolsetConfig;
  toolCatalogProvider?: () => ShardToolCatalog;
  auditTrail?: ShardAuditTrail;
}

export interface ActiveShard {
  id: string;
  name: string;
  task: string;
  startedAt: number;
}

export class ShardManager {
  private deps: ShardManagerDeps;
  private auditTrail: ShardAuditTrail | null;
  private activeCount = 0;
  private maxConcurrent: number;
  private activeShards = new Map<string, ActiveShard>();

  constructor(deps: ShardManagerDeps) {
    this.deps = deps;
    this.maxConcurrent = deps.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this.auditTrail = deps.auditTrail ?? null;
    this.installAuditHooks();
  }

  async spawn(shardConfig: ShardConfig): Promise<ShardResult> {
    if (this.activeCount >= this.maxConcurrent) {
      throw new Error(
        `Shard limit reached (${this.maxConcurrent} concurrent). Wait for active shards to complete.`,
      );
    }

    const startTime = Date.now();
    const shardId = `shard-${randomUUID()}`;
    const channelId = `shard:${shardId}`;
    const maxTurns = shardConfig.maxTurns ?? DEFAULT_MAX_TURNS;

    this.activeCount++;
    this.activeShards.set(shardId, {
      id: shardId,
      name: shardConfig.name,
      task: shardConfig.task,
      startedAt: startTime,
    });
    this.auditTrail?.append('shard.spawn.start', {
      shardId,
      name: shardConfig.name,
      maxTurns,
    });
    try {
      // Each shard gets its own SessionManager wrapping the shared store
      const sessionManager = new SessionManager(
        this.deps.sessionStore,
        this.deps.config,
        this.deps.eventBus,
      );

      const systemPrompt = shardConfig.systemPrompt ?? this.deps.parentSystemPrompt;

      const agentLoop = new AgentLoop(
        this.deps.eventBus,
        this.deps.llmProvider,
        sessionManager,
        systemPrompt,
        this.deps.config,
      );

      // Shards can READ memory but don't extract or archive (ephemeral)
      if (this.deps.memoryProvider) {
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
      // No memoryExtractor — shards don't run L1 extraction/archive jobs.

      // Build initial message
      const message: SubstrateMessage = {
        id: shardId,
        channelId,
        channelType: 'api',
        authorId: 'system',
        authorName: 'ShardManager',
        content: shardConfig.task,
        timestamp: new Date(),
      };

      // Execute (single-turn by default)
      let totalInput = 0;
      let totalOutput = 0;
      let lastModel = '';
      let lastContent = '';
      let turns = 0;

      for (let turn = 0; turn < maxTurns; turn++) {
        const turnMessage = turn === 0 ? message : {
          ...message,
          id: `${shardId}-turn-${turn}`,
          content: lastContent,
        };

        const response = await agentLoop.handleMessage(turnMessage);

        totalInput += response.metadata.inputTokens;
        totalOutput += response.metadata.outputTokens;
        lastModel = response.metadata.model;
        lastContent = response.content;
        turns++;

        // For single-turn (default), we break after one turn
        // For multi-turn, we continue only if the response suggests more work
        if (turn === 0 && maxTurns === 1) break;
      }

      const result: ShardResult = {
        shardId,
        name: shardConfig.name,
        content: lastContent,
        model: lastModel,
        inputTokens: totalInput,
        outputTokens: totalOutput,
        durationMs: Date.now() - startTime,
        turns,
      };
      this.auditTrail?.append('shard.spawn.end', {
        shardId,
        status: 'completed',
        durationMs: result.durationMs,
        turns: result.turns,
      });
      return result;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.auditTrail?.append('shard.spawn.end', {
        shardId,
        status: 'failed',
        durationMs: Date.now() - startTime,
        error: msg,
      });
      throw error;
    } finally {
      this.activeCount--;
      this.activeShards.delete(shardId);
    }
  }

  getActiveCount(): number {
    return this.activeCount;
  }

  getActiveShards(): ActiveShard[] {
    return [...this.activeShards.values()];
  }

  private installAuditHooks(): void {
    this.deps.eventBus.on('agent.tool.start', (event) => {
      const shardId = this.resolveShardId(event.channelId);
      if (!shardId) return;
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

    if (tier === 'autonomous' || tier === 'custom') {
      const tierConfig = normalizeToolNames(configured?.[tier] ?? configured?.autonomous);
      if (tierConfig.length > 0) return tierConfig;
      return [...DEFAULT_SHARD_TOOLSETS_BY_TIER[tier]];
    }

    return [...DEFAULT_SHARD_TOOLSETS_BY_TIER.nursery];
  }

  private resolveCapabilityTier(): CapabilityTier {
    return normalizeCapabilityTier(this.deps.config.capabilityTier);
  }

  private wrapShardTool(tool: AgentTool<any>, shardId: string): AgentTool<any> {
    return {
      ...tool,
      execute: async (toolCallId, params, signal) => {
        const scopedParams = this.applyShardSourceParams(tool.name, params, shardId);
        return tool.execute(toolCallId, scopedParams as any, signal);
      },
    };
  }

  private applyShardSourceParams(
    toolName: string,
    params: unknown,
    shardId: string,
  ): unknown {
    if (
      toolName !== 'memory_write'
      && toolName !== 'memory_import_batch'
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

  private resolveShardId(channelId: string): string | null {
    if (!channelId.startsWith('shard:')) return null;
    const shardId = channelId.slice('shard:'.length).trim();
    return shardId.length > 0 ? shardId : null;
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
