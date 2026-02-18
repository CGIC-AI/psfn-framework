// ── ShardManager ──
// Spawns ephemeral AgentLoop instances for parallel task execution.
// Shards share parent's heavy resources (LLM, DB, memory) but get isolated channelIds.

import { randomUUID } from 'node:crypto';
import type { SubstrateConfig, SubstrateMessage } from '../types.js';
import type { EventBus } from '../event-bus.js';
import type { LLMProvider, EmbeddingService, MemoryProvider } from '../agent-loop.js';
import { AgentLoop } from '../agent-loop.js';
import type { SessionStore } from '../session/store.js';
import { SessionManager } from '../session/manager.js';
import type { ShardConfig, ShardResult } from './types.js';

const DEFAULT_MAX_CONCURRENT = 5;
const DEFAULT_MAX_TURNS = 1;

export interface ShardManagerDeps {
  eventBus: EventBus;
  llmProvider: LLMProvider;
  sessionStore: SessionStore;
  embeddingService: EmbeddingService | null;
  memoryProvider: MemoryProvider | null;
  config: SubstrateConfig;
  parentSystemPrompt: string;
  maxConcurrent?: number;
}

export interface ActiveShard {
  id: string;
  name: string;
  task: string;
  startedAt: number;
}

export class ShardManager {
  private deps: ShardManagerDeps;
  private activeCount = 0;
  private maxConcurrent: number;
  private activeShards = new Map<string, ActiveShard>();

  constructor(deps: ShardManagerDeps) {
    this.deps = deps;
    this.maxConcurrent = deps.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
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
      // No memoryExtractor — shards don't create memories
      // No spawn_shard tool — shards can't spawn sub-shards (depth=1 max)

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

      return {
        shardId,
        name: shardConfig.name,
        content: lastContent,
        model: lastModel,
        inputTokens: totalInput,
        outputTokens: totalOutput,
        durationMs: Date.now() - startTime,
        turns,
      };
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
}
