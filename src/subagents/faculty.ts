import { randomUUID } from 'node:crypto';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import type {
  CapabilityTier,
  GatewayRoutingEnvelope,
  ShardToolsetConfig,
  ShardLineage,
  SubstrateConfig,
  SubstrateMessage,
  WyomingRoutingMetadata,
} from '../types.js';
import type { EventBus } from '../event-bus.js';
import type { EmbeddingService, LLMProvider, MemoryProvider } from '../agent/contracts.js';
import { SubstrateAgent } from '../agent/substrate-agent.js';
import { SUBAGENT_WORKER_LANE } from '../agent/worker-lanes.js';
import type { RuntimeMode } from '../agent/tool-wiring-validator.js';
import { normalizeCapabilityTier } from '../capabilities/tiers.js';
import { DEFAULT_COMPANION_ID } from '../identity/companion-naming.js';
import { createGatewayRoutingEnvelope } from '../routing/envelope.js';
import type { SessionStore } from '../session/store.js';
import { SessionManager } from '../session/manager.js';
import { inferSessionChannelType } from '../session/session-id.js';
import { toErrorMessage } from '../utils/errors.js';
import type { SubagentExecutionPort } from './port.js';
import { SubagentTaskRegistry } from './task-registry.js';
import type {
  SubagentExecutionRequest,
  SubagentResult,
  SubagentTaskRecord,
  WyomingSubagentDelegationRequest,
} from './types.js';

const DEFAULT_MAX_CONCURRENT = 8;
const DEFAULT_MAX_TURNS = 1;
const DEFAULT_SUBAGENT_CAPABILITIES = ['general'] as const;
const SUBAGENT_TOOLSET_ALL = '*';
const APPRENTICE_SUBAGENT_TOOL_EXTRAS = [
  'contact_list',
  'memory_import_batch',
] as const;
export const DEFAULT_SUBAGENT_TOOLSET = [
  'memory_write',
  'contact_lookup',
  'repo_status',
  'repo_diff',
] as const;

const DEFAULT_SUBAGENT_TOOLSETS_BY_TIER: Readonly<Record<CapabilityTier, readonly string[]>> = {
  nursery: DEFAULT_SUBAGENT_TOOLSET,
  apprentice: [...DEFAULT_SUBAGENT_TOOLSET, ...APPRENTICE_SUBAGENT_TOOL_EXTRAS],
  autonomous: [SUBAGENT_TOOLSET_ALL],
  custom: [SUBAGENT_TOOLSET_ALL],
};

const BLOCKED_SUBAGENT_TOOL_NAMES = new Set(['spawn_shard', 'load_tools']);

export interface SubagentToolCatalog {
  core: readonly AgentTool<any>[];
  extended: readonly AgentTool<any>[];
}

export interface SubagentAuditTrail {
  append(event: string, details?: Record<string, unknown>): unknown;
}

export interface SubagentFacultyDeps {
  eventBus: EventBus;
  llmProvider: LLMProvider;
  sessionStore: SessionStore;
  embeddingService: EmbeddingService | null;
  memoryProvider: MemoryProvider | null;
  config: SubstrateConfig;
  parentSystemPrompt: string;
  maxConcurrent?: number;
  taskToolsets?: ShardToolsetConfig;
  toolCatalogProvider?: () => SubagentToolCatalog;
  auditTrail?: SubagentAuditTrail;
  runtimeMode?: RuntimeMode;
}

export interface WyomingSubagentDelegationResult {
  subagentId: string;
  content: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  lineage?: ShardLineage;
  gatewayRouting: GatewayRoutingEnvelope;
}

export class SubagentFaculty implements SubagentExecutionPort {
  readonly portFamily = 'subagent' as const;

  private readonly maxConcurrent: number;
  private readonly taskRegistry = new SubagentTaskRegistry();
  private readonly auditTrail: SubagentAuditTrail | null;

  constructor(private readonly deps: SubagentFacultyDeps) {
    this.maxConcurrent = Math.max(1, Math.trunc(deps.maxConcurrent ?? DEFAULT_MAX_CONCURRENT));
    this.auditTrail = deps.auditTrail ?? null;
  }

  async execute(request: SubagentExecutionRequest): Promise<SubagentResult> {
    if (this.taskRegistry.getActiveCount() >= this.maxConcurrent) {
      throw new Error(
        `Subagent limit reached (${this.maxConcurrent} concurrent). Wait for active subagent tasks to finish.`,
      );
    }

    const subagentId = `subagent-${randomUUID()}`;
    const startTime = Date.now();
    const maxTurns = Number.isFinite(request.maxTurns)
      ? Math.max(1, Math.trunc(request.maxTurns as number))
      : DEFAULT_MAX_TURNS;
    const capabilities = this.resolveAdvertisedCapabilities(request.capabilities);
    const requiredCapabilities = this.resolveRequiredCapabilities(request.requiredCapabilities);
    const missingCapabilities = requiredCapabilities.filter(capability => !capabilities.includes(capability));
    if (missingCapabilities.length > 0) {
      throw new Error(
        `Subagent routing denied: "${request.name}" is missing required capability tokens `
        + `(${missingCapabilities.join(', ')}).`,
      );
    }

    const executionChannelId = normalizeExecutionChannelId(request.executionChannelId)
      ?? `subagent:${subagentId}`;
    const baseMessage = this.buildBaseMessage(subagentId, executionChannelId, request);
    const task = this.taskRegistry.register({
      subagentId,
      name: request.name,
      task: request.task,
      channelId: executionChannelId,
      capabilities,
      requiredCapabilities,
      createdAt: startTime,
    });
    this.auditTrail?.append('subagent.lifecycle.transition', {
      subagentId,
      from: 'none',
      to: 'queued',
      reason: task.stateReason,
      workerLane: SUBAGENT_WORKER_LANE,
      channelId: executionChannelId,
    });
    this.auditTrail?.append('subagent.execute.start', {
      subagentId,
      name: request.name,
      channelId: executionChannelId,
      maxTurns,
      capabilities,
      requiredCapabilities,
      workerLane: SUBAGENT_WORKER_LANE,
    });

    try {
      const sessionManager = new SessionManager(
        this.deps.sessionStore,
        this.deps.config,
        this.deps.eventBus,
      );
      const agentLoop = new SubstrateAgent(
        this.deps.eventBus,
        this.deps.llmProvider,
        sessionManager,
        request.systemPrompt ?? this.deps.parentSystemPrompt,
        this.deps.config,
        {
          runtimeMode: this.deps.runtimeMode ?? 'single',
        },
      );

      if (this.deps.memoryProvider) {
        agentLoop.memoryProvider = this.deps.memoryProvider;
      }

      const injectedTools = this.resolveInjectedTools();
      for (const tool of injectedTools) {
        agentLoop.registerTool(tool);
      }
      this.auditTrail?.append('subagent.tools.injected', {
        subagentId,
        tier: this.resolveCapabilityTier(),
        tools: injectedTools.map(tool => tool.name),
      });

      this.transitionTask(subagentId, 'running', 'agent_initialized', startTime);

      let totalInput = 0;
      let totalOutput = 0;
      let lastModel = '';
      let lastContent = '';
      let turns = 0;

      for (let turn = 0; turn < maxTurns; turn++) {
        const turnMessage = turn === 0
          ? baseMessage
          : {
            ...baseMessage,
            id: `${subagentId}-turn-${turn}`,
            content: lastContent,
          };
        const response = await agentLoop.handleMessage(turnMessage);
        totalInput += response.metadata.inputTokens;
        totalOutput += response.metadata.outputTokens;
        lastModel = response.metadata.model;
        lastContent = response.content;
        turns += 1;

        if (turn === 0 && maxTurns === 1) break;
      }

      const previous = this.taskRegistry.getActiveTask(subagentId);
      const completed = this.taskRegistry.markCompleted(subagentId, 'completed', Date.now());
      this.auditTrail?.append('subagent.lifecycle.transition', {
        subagentId,
        from: previous?.lifecycleState ?? 'running',
        to: completed.lifecycleState,
        reason: completed.stateReason,
        workerLane: completed.workerLane,
        channelId: completed.channelId,
      });

      const result: SubagentResult = {
        subagentId,
        name: request.name,
        content: lastContent,
        model: lastModel,
        inputTokens: totalInput,
        outputTokens: totalOutput,
        durationMs: Date.now() - startTime,
        turns,
        workerLane: SUBAGENT_WORKER_LANE,
        lifecycleState: 'completed',
        stateReason: completed.stateReason,
        capabilities: [...capabilities],
        requiredCapabilities: [...requiredCapabilities],
      };
      this.auditTrail?.append('subagent.execute.end', {
        subagentId,
        status: 'completed',
        durationMs: result.durationMs,
        turns: result.turns,
        channelId: executionChannelId,
      });
      return result;
    } catch (error) {
      const failureReason = toErrorMessage(error);
      const previous = this.taskRegistry.getActiveTask(subagentId);
      const failed = this.taskRegistry.markFailed(
        subagentId,
        'execution_failed',
        failureReason,
        Date.now(),
      );
      this.auditTrail?.append('subagent.lifecycle.transition', {
        subagentId,
        from: previous?.lifecycleState ?? 'queued',
        to: failed.lifecycleState,
        reason: failed.stateReason,
        failureReason,
        workerLane: failed.workerLane,
        channelId: failed.channelId,
      });
      this.auditTrail?.append('subagent.execute.end', {
        subagentId,
        status: 'failed',
        durationMs: Date.now() - startTime,
        error: failureReason,
        channelId: executionChannelId,
      });
      throw new Error(`Subagent "${request.name}" failed (execution_failed): ${failureReason}`);
    }
  }

  async delegateWyomingSession(
    request: WyomingSubagentDelegationRequest,
  ): Promise<WyomingSubagentDelegationResult> {
    const content = request.message.content.trim();
    if (!content) {
      throw new Error('Wyoming subagent delegation requires non-empty message content.');
    }

    const routing = request.routing ?? request.message.routing?.wyoming;
    this.auditTrail?.append('wyoming.subagent.delegate.start', {
      channelId: request.message.channelId,
      messageId: request.message.id,
      connectionId: routing?.connectionId,
      sessionId: routing?.sessionId,
      turnId: routing?.turnId,
      siteId: routing?.siteId,
      satelliteId: routing?.satelliteId,
    });

    try {
      const result = await this.execute({
        name: request.subagentName?.trim() || this.resolveWyomingSubagentName(routing),
        task: request.message.content,
        message: request.message,
        executionChannelId: request.message.channelId,
        maxTurns: 1,
        capabilities: this.resolveWyomingRouteCapabilities(routing),
        requiredCapabilities: this.resolveWyomingRouteCapabilities(routing),
      });
      const gatewayRouting = createGatewayRoutingEnvelope({
        companionId: request.gatewayRouting?.companionId
          ?? request.message.routing?.gateway?.companionId
          ?? DEFAULT_COMPANION_ID,
        ...(request.gatewayRouting?.shard || request.message.routing?.gateway?.shard
          ? { shard: request.gatewayRouting?.shard ?? request.message.routing?.gateway?.shard }
          : {}),
        subagentAddress: {
          executionPort: 'subagent',
          workerId: result.subagentId,
          lane: SUBAGENT_WORKER_LANE,
        },
      });
      this.auditTrail?.append('wyoming.subagent.delegate.end', {
        subagentId: result.subagentId,
        status: 'completed',
        durationMs: result.durationMs,
        channelId: request.message.channelId,
        messageId: request.message.id,
        companionId: gatewayRouting.companionId,
        shardCompanionId: gatewayRouting.shard?.shardCompanionId,
        parentShardId: gatewayRouting.shard?.parentShardId,
        connectionId: routing?.connectionId,
        sessionId: routing?.sessionId,
        turnId: routing?.turnId,
      });
      return {
        subagentId: result.subagentId,
        content: result.content,
        model: result.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        durationMs: result.durationMs,
        lineage: gatewayRouting.shard,
        gatewayRouting,
      };
    } catch (error) {
      const message = toErrorMessage(error);
      this.auditTrail?.append('wyoming.subagent.delegate.end', {
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

  getActiveCount(): number {
    return this.taskRegistry.getActiveCount();
  }

  getActiveTasks(): SubagentTaskRecord[] {
    return this.taskRegistry.getActiveTasks();
  }

  getRecentTasks(limit?: number): SubagentTaskRecord[] {
    return this.taskRegistry.getRecentTasks(limit);
  }

  private buildBaseMessage(
    subagentId: string,
    executionChannelId: string,
    request: SubagentExecutionRequest,
  ): SubstrateMessage {
    if (request.message) {
      return {
        ...request.message,
        content: request.task,
      };
    }
    return {
      id: subagentId,
      channelId: executionChannelId,
      channelType: inferSessionChannelType(executionChannelId) ?? 'api',
      authorId: 'system',
      authorName: 'SubagentFaculty',
      content: request.task,
      timestamp: new Date(),
    };
  }

  private resolveInjectedTools(): AgentTool<any>[] {
    const catalog = this.deps.toolCatalogProvider?.();
    if (!catalog) return [];

    const availableByName = new Map<string, AgentTool<any>>();
    for (const tool of [...catalog.core, ...catalog.extended]) {
      if (BLOCKED_SUBAGENT_TOOL_NAMES.has(tool.name)) continue;
      if (!availableByName.has(tool.name)) {
        availableByName.set(tool.name, tool);
      }
    }

    const toolNames = this.resolveToolNamesForTier(this.resolveCapabilityTier());
    const includeAll = toolNames.includes(SUBAGENT_TOOLSET_ALL);
    if (includeAll) {
      return [...availableByName.values()];
    }
    return toolNames
      .map(name => availableByName.get(name))
      .filter((tool): tool is AgentTool<any> => tool !== undefined);
  }

  private resolveToolNamesForTier(tier: CapabilityTier): string[] {
    const configured = this.deps.taskToolsets;
    const nursery = normalizeToolNames(configured?.nursery, DEFAULT_SUBAGENT_TOOLSETS_BY_TIER.nursery);

    if (tier === 'nursery') return nursery;

    if (tier === 'apprentice') {
      const apprentice = normalizeToolNames(configured?.apprentice);
      if (apprentice.length > 0) return apprentice;
      return [...nursery, ...APPRENTICE_SUBAGENT_TOOL_EXTRAS.filter(name => !nursery.includes(name))];
    }

    const tierConfig = normalizeToolNames(configured?.[tier] ?? configured?.autonomous);
    if (tierConfig.length > 0) return tierConfig;
    return [...DEFAULT_SUBAGENT_TOOLSETS_BY_TIER[tier]];
  }

  private resolveCapabilityTier(): CapabilityTier {
    return normalizeCapabilityTier(this.deps.config.capabilityTier);
  }

  private resolveAdvertisedCapabilities(tokens: readonly string[] | undefined): string[] {
    return normalizeCapabilityTokens(tokens, DEFAULT_SUBAGENT_CAPABILITIES);
  }

  private resolveRequiredCapabilities(tokens: readonly string[] | undefined): string[] {
    return normalizeCapabilityTokens(tokens);
  }

  private resolveWyomingSubagentName(routing?: WyomingRoutingMetadata): string {
    const satelliteId = routing?.satelliteId?.trim();
    if (satelliteId) return `wyoming:${satelliteId}`;
    const siteId = routing?.siteId?.trim();
    if (siteId) return `wyoming:${siteId}`;
    return 'wyoming';
  }

  private resolveWyomingRouteCapabilities(routing?: WyomingRoutingMetadata): string[] {
    const capabilityTokens = ['wyoming'];
    const siteId = routing?.siteId?.trim();
    if (siteId) {
      capabilityTokens.push(`wyoming:${siteId}`);
    }
    const satelliteId = routing?.satelliteId?.trim();
    if (siteId && satelliteId) {
      capabilityTokens.push(`wyoming:${siteId}:${satelliteId}`);
    }
    return capabilityTokens;
  }

  private transitionTask(
    subagentId: string,
    nextState: 'running',
    reason: string,
    startedAt: number,
  ): void {
    const task = this.taskRegistry.markRunning(subagentId, reason, startedAt);
    this.auditTrail?.append('subagent.lifecycle.transition', {
      subagentId,
      from: 'queued',
      to: nextState,
      reason,
      workerLane: task.workerLane,
      channelId: task.channelId,
    });
  }
}

function normalizeExecutionChannelId(channelId: string | undefined): string | null {
  if (typeof channelId !== 'string') return null;
  const normalized = channelId.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeCapabilityTokens(
  tokens: readonly string[] | undefined,
  fallback: readonly string[] = [],
): string[] {
  const normalized = new Set<string>();
  for (const token of tokens ?? fallback) {
    const value = token.trim();
    if (value.length > 0) {
      normalized.add(value);
    }
  }
  return [...normalized];
}

function normalizeToolNames(
  names: readonly string[] | undefined,
  fallback: readonly string[] = [],
): string[] {
  return normalizeCapabilityTokens(names, fallback);
}
