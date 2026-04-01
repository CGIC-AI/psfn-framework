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
import {
  SUBAGENT_WORKER_LANE,
  createWorkerExecutionPolicy,
} from '../agent/worker-lanes.js';
import type { RuntimeMode } from '../agent/tool-wiring-validator.js';
import { normalizeCapabilityTier } from '../capabilities/tiers.js';
import { DEFAULT_COMPANION_ID } from '../identity/companion-naming.js';
import { createGatewayRoutingEnvelope } from '../routing/envelope.js';
import type { SessionStore } from '../session/store.js';
import { SessionManager } from '../session/manager.js';
import { inferSessionChannelType } from '../session/session-id.js';
import { toErrorMessage } from '../utils/errors.js';
import type { SubagentControlPort } from './port.js';
import { SubagentTaskRegistry } from './task-registry.js';
import type {
  SubagentExecutionRequest,
  SubagentRuntimeArtifactView,
  SubagentRuntimeTaskDetail,
  SubagentRuntimeResumeView,
  SubagentRuntimeSnapshot,
  SubagentRuntimeSnapshotOptions,
  SubagentRuntimeTaskView,
  SubagentResult,
  SubagentTaskRecord,
  WyomingSubagentDelegationRequest,
} from './types.js';

const DEFAULT_MAX_CONCURRENT = 8;
const DEFAULT_MAX_TURNS = 1;
const DEFAULT_RECENT_RESULT_LIMIT = 25;
const DEFAULT_SUBAGENT_CAPABILITIES = ['general'] as const;
const SUBAGENT_TOOLSET_ALL = '*';
export const DEFAULT_SUBAGENT_TOOLSET = [
  'memory',
  'contact',
  'repo_status',
  'repo_diff',
] as const;

const DEFAULT_SUBAGENT_TOOLSETS_BY_TIER: Readonly<Record<CapabilityTier, readonly string[]>> = {
  nursery: DEFAULT_SUBAGENT_TOOLSET,
  apprentice: DEFAULT_SUBAGENT_TOOLSET,
  autonomous: [SUBAGENT_TOOLSET_ALL],
  custom: [SUBAGENT_TOOLSET_ALL],
};

const BLOCKED_SUBAGENT_TOOL_NAMES = new Set(['spawn_shard', 'load_tools', 'toolset']);
const SUBAGENT_CONTROL_AUTHOR_ID = 'system:subagent-control';
const SUBAGENT_CONTROL_AUTHOR_NAME = 'SubagentControl';

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

interface ActiveSubagentHandle {
  subagentId: string;
  request: SubagentExecutionRequest;
  baseMessage: SubstrateMessage;
  channelId: string;
  startTime: number;
  maxTurns: number;
  capabilities: string[];
  requiredCapabilities: string[];
  agentLoop: SubstrateAgent | null;
  pendingMessages: SubstrateMessage[];
  cancelReason?: string;
  completion: Promise<SubagentResult>;
  resolveCompletion: (result: SubagentResult) => void;
  settled: boolean;
}

export class SubagentFaculty implements SubagentControlPort {
  readonly portFamily = 'subagent' as const;

  private readonly maxConcurrent: number;
  private readonly taskRegistry = new SubagentTaskRegistry();
  private readonly auditTrail: SubagentAuditTrail | null;
  private readonly activeHandles = new Map<string, ActiveSubagentHandle>();
  private readonly recentResults = new Map<string, SubagentResult>();
  private readonly recentResultIds: string[] = [];

  constructor(private readonly deps: SubagentFacultyDeps) {
    this.maxConcurrent = Math.max(1, Math.trunc(deps.maxConcurrent ?? DEFAULT_MAX_CONCURRENT));
    this.auditTrail = deps.auditTrail ?? null;
  }

  async execute(request: SubagentExecutionRequest): Promise<SubagentResult> {
    const task = await this.spawn(request);
    const result = await this.wait(task.subagentId);
    if (result.lifecycleState === 'completed') {
      return result;
    }
    const failureReason = result.failureReason ?? result.stateReason;
    const terminalState = result.lifecycleState === 'cancelled' ? 'cancelled' : 'failed';
    throw new Error(`Subagent "${result.name}" ${terminalState} (${result.stateReason}): ${failureReason}`);
  }

  async spawn(request: SubagentExecutionRequest): Promise<SubagentTaskRecord> {
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
    const workerExecution = createWorkerExecutionPolicy(SUBAGENT_WORKER_LANE);
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
      workerProfileClass: workerExecution.profileClass,
      modelPurpose: workerExecution.modelPurpose,
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
      workerProfileClass: workerExecution.profileClass,
      modelPurpose: workerExecution.modelPurpose,
    });
    const completion = createDeferred<SubagentResult>();
    const handle: ActiveSubagentHandle = {
      subagentId,
      request,
      baseMessage,
      channelId: executionChannelId,
      startTime,
      maxTurns,
      capabilities,
      requiredCapabilities,
      agentLoop: null,
      pendingMessages: [],
      completion: completion.promise,
      resolveCompletion: completion.resolve,
      settled: false,
    };
    this.activeHandles.set(subagentId, handle);
    queueMicrotask(() => {
      void this.runHandle(handle);
    });
    return task;
  }

  async message(subagentId: string, message: string): Promise<SubagentRuntimeTaskView> {
    const handle = this.requireActiveHandle(subagentId);
    if (this.isCancellationRequested(handle)) {
      throw new Error(`Subagent "${subagentId}" is cancelling and cannot accept new messages.`);
    }
    const content = normalizeRequiredText(message, 'message');
    const followUp = this.buildControlMessage(handle.channelId, content);
    if (handle.agentLoop) {
      handle.agentLoop.followUp(followUp);
    } else {
      handle.pendingMessages.push(followUp);
    }
    this.auditTrail?.append('subagent.message.queued', {
      subagentId,
      channelId: handle.channelId,
      deliveryState: handle.agentLoop ? 'running' : 'queued',
    });
    const taskView = this.getRuntimeTaskView(subagentId, { transcriptLimit: 8 });
    if (!taskView) {
      throw new Error(`Unknown subagent task "${subagentId}".`);
    }
    return taskView;
  }

  async wait(subagentId: string): Promise<SubagentResult> {
    const activeHandle = this.activeHandles.get(subagentId);
    if (activeHandle) {
      return cloneSubagentResult(await activeHandle.completion);
    }

    const recentResult = this.recentResults.get(subagentId);
    if (recentResult) {
      return cloneSubagentResult(recentResult);
    }

    throw new Error(`Unknown subagent task "${subagentId}".`);
  }

  async cancel(subagentId: string, reason?: string): Promise<SubagentResult> {
    const handle = this.activeHandles.get(subagentId);
    if (!handle) {
      const recentResult = this.recentResults.get(subagentId);
      if (recentResult) {
        return cloneSubagentResult(recentResult);
      }
      throw new Error(`Unknown subagent task "${subagentId}".`);
    }

    if (!this.isCancellationRequested(handle)) {
      handle.cancelReason = normalizeOptionalText(reason) ?? 'cancel_requested';
      this.auditTrail?.append('subagent.cancel.requested', {
        subagentId,
        channelId: handle.channelId,
        reason: handle.cancelReason,
      });
      if (handle.agentLoop) {
        handle.agentLoop.abort();
      } else {
        this.finishHandle(handle, this.finalizeCancelled(handle, 0, 0, '', '', 0));
      }
    }

    return cloneSubagentResult(await handle.completion);
  }

  private async runHandle(handle: ActiveSubagentHandle): Promise<void> {
    if (handle.settled) return;

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
        handle.request.systemPrompt ?? this.deps.parentSystemPrompt,
        this.deps.config,
        {
          runtimeMode: this.deps.runtimeMode ?? 'single',
        },
      );
      handle.agentLoop = agentLoop;

      if (this.deps.memoryProvider) {
        agentLoop.memoryProvider = this.deps.memoryProvider;
      }

      const injectedTools = this.resolveInjectedTools();
      for (const tool of injectedTools) {
        agentLoop.registerTool(tool);
      }
      this.auditTrail?.append('subagent.tools.injected', {
        subagentId: handle.subagentId,
        tier: this.resolveCapabilityTier(),
        tools: injectedTools.map(tool => tool.name),
      });

      if (this.isCancellationRequested(handle)) {
        this.finishHandle(handle, this.finalizeCancelled(handle, 0, 0, '', '', 0));
        return;
      }

      this.transitionTask(handle.subagentId, 'running', 'agent_initialized', handle.startTime);
      this.flushPendingMessages(handle);

      let totalInput = 0;
      let totalOutput = 0;
      let lastModel = '';
      let lastContent = '';
      let turns = 0;

      for (let turn = 0; turn < handle.maxTurns; turn++) {
        const turnMessage = turn === 0
          ? handle.baseMessage
          : {
            ...handle.baseMessage,
            id: `${handle.subagentId}-turn-${turn}`,
            content: lastContent,
          };
        const response = await agentLoop.handleMessage(turnMessage);
        totalInput += response.metadata.inputTokens;
        totalOutput += response.metadata.outputTokens;
        lastModel = response.metadata.model;
        lastContent = response.content;
        turns += 1;

        if (this.isCancellationRequested(handle)) {
          this.finishHandle(handle, this.finalizeCancelled(
            handle,
            totalInput,
            totalOutput,
            lastModel,
            lastContent,
            turns,
          ));
          return;
        }

        if (turn === 0 && handle.maxTurns === 1) break;
      }

      this.finishHandle(handle, this.finalizeCompleted(
        handle,
        totalInput,
        totalOutput,
        lastModel,
        lastContent,
        turns,
      ));
    } catch (error) {
      if (this.isCancellationRequested(handle)) {
        this.finishHandle(handle, this.finalizeCancelled(handle, 0, 0, '', '', 0));
        return;
      }
      this.finishHandle(handle, this.finalizeFailed(handle, toErrorMessage(error)));
    }
  }

  getRuntimeTaskDetail(
    subagentId: string,
    options: SubagentRuntimeSnapshotOptions = {},
  ): SubagentRuntimeTaskDetail | null {
    const view = this.getRuntimeTaskView(subagentId, options);
    if (!view) return null;
    const result = this.recentResults.get(subagentId);
    return result
      ? { view, result: cloneSubagentResult(result) }
      : { view };
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

  getResult(subagentId: string): SubagentResult | null {
    const result = this.recentResults.get(subagentId);
    return result ? cloneSubagentResult(result) : null;
  }

  getRuntimeSnapshot(options: SubagentRuntimeSnapshotOptions = {}): SubagentRuntimeSnapshot {
    const taskLimit = normalizePositiveInteger(options.taskLimit, 10);
    const transcriptLimit = normalizePositiveInteger(options.transcriptLimit, 8);
    const activeTasks = this.taskRegistry.getActiveTasks().map(task => this.buildRuntimeTaskView(task, transcriptLimit));
    const recentTasks = this.taskRegistry.getRecentTasks(taskLimit).map(task => this.buildRuntimeTaskView(task, transcriptLimit));

    return {
      generatedAt: Date.now(),
      activeCount: this.taskRegistry.getActiveCount(),
      activeTasks,
      recentTasks,
    };
  }

  getRuntimeTaskView(subagentId: string, options: SubagentRuntimeSnapshotOptions = {}): SubagentRuntimeTaskView | null {
    const transcriptLimit = normalizePositiveInteger(options.transcriptLimit, 8);
    const active = this.taskRegistry.getActiveTask(subagentId);
    if (active) {
      return this.buildRuntimeTaskView(active, transcriptLimit);
    }

    const recent = this.taskRegistry.getRecentTasks(Number.MAX_SAFE_INTEGER).find(task => task.subagentId === subagentId);
    if (!recent) {
      return null;
    }

    return this.buildRuntimeTaskView(recent, transcriptLimit);
  }

  private requireActiveHandle(subagentId: string): ActiveSubagentHandle {
    const handle = this.activeHandles.get(subagentId);
    if (!handle) {
      throw new Error(`Unknown subagent task "${subagentId}".`);
    }
    return handle;
  }

  private isCancellationRequested(handle: ActiveSubagentHandle): boolean {
    return handle.cancelReason !== undefined;
  }

  private flushPendingMessages(handle: ActiveSubagentHandle): void {
    if (!handle.agentLoop || handle.pendingMessages.length === 0) return;
    const pendingMessages = handle.pendingMessages.splice(0, handle.pendingMessages.length);
    for (const message of pendingMessages) {
      handle.agentLoop.followUp(message);
    }
  }

  private finishHandle(handle: ActiveSubagentHandle, result: SubagentResult): void {
    if (handle.settled) return;
    handle.settled = true;
    this.activeHandles.delete(handle.subagentId);
    this.storeRecentResult(result);
    handle.resolveCompletion(cloneSubagentResult(result));
  }

  private storeRecentResult(result: SubagentResult): void {
    this.recentResults.set(result.subagentId, cloneSubagentResult(result));
    const existingIndex = this.recentResultIds.indexOf(result.subagentId);
    if (existingIndex >= 0) {
      this.recentResultIds.splice(existingIndex, 1);
    }
    this.recentResultIds.unshift(result.subagentId);
    while (this.recentResultIds.length > DEFAULT_RECENT_RESULT_LIMIT) {
      const evicted = this.recentResultIds.pop();
      if (evicted) {
        this.recentResults.delete(evicted);
      }
    }
  }

  private finalizeCompleted(
    handle: ActiveSubagentHandle,
    totalInput: number,
    totalOutput: number,
    lastModel: string,
    lastContent: string,
    turns: number,
  ): SubagentResult {
    const previous = this.taskRegistry.getActiveTask(handle.subagentId);
    const completed = this.taskRegistry.markCompleted(handle.subagentId, 'completed', Date.now());
    this.auditTrail?.append('subagent.lifecycle.transition', {
      subagentId: handle.subagentId,
      from: previous?.lifecycleState ?? 'running',
      to: completed.lifecycleState,
      reason: completed.stateReason,
      workerLane: completed.workerLane,
      channelId: completed.channelId,
    });
    const result: SubagentResult = {
      subagentId: handle.subagentId,
      name: handle.request.name,
      content: lastContent,
      model: lastModel,
      inputTokens: totalInput,
      outputTokens: totalOutput,
      durationMs: Date.now() - handle.startTime,
      turns,
      workerLane: SUBAGENT_WORKER_LANE,
      lifecycleState: 'completed',
      stateReason: completed.stateReason,
      capabilities: [...handle.capabilities],
      requiredCapabilities: [...handle.requiredCapabilities],
    };
    this.auditTrail?.append('subagent.execute.end', {
      subagentId: handle.subagentId,
      status: 'completed',
      durationMs: result.durationMs,
      turns: result.turns,
      channelId: handle.channelId,
    });
    return result;
  }

  private finalizeCancelled(
    handle: ActiveSubagentHandle,
    totalInput: number,
    totalOutput: number,
    lastModel: string,
    lastContent: string,
    turns: number,
  ): SubagentResult {
    const previous = this.taskRegistry.getActiveTask(handle.subagentId);
    const cancelled = this.taskRegistry.markCancelled(
      handle.subagentId,
      'cancel_requested',
      Date.now(),
      handle.cancelReason,
    );
    this.auditTrail?.append('subagent.lifecycle.transition', {
      subagentId: handle.subagentId,
      from: previous?.lifecycleState ?? 'queued',
      to: cancelled.lifecycleState,
      reason: cancelled.stateReason,
      ...(handle.cancelReason ? { failureReason: handle.cancelReason } : {}),
      workerLane: cancelled.workerLane,
      channelId: cancelled.channelId,
    });
    const result: SubagentResult = {
      subagentId: handle.subagentId,
      name: handle.request.name,
      content: lastContent,
      model: lastModel,
      inputTokens: totalInput,
      outputTokens: totalOutput,
      durationMs: Date.now() - handle.startTime,
      turns,
      workerLane: SUBAGENT_WORKER_LANE,
      lifecycleState: 'cancelled',
      stateReason: cancelled.stateReason,
      ...(handle.cancelReason ? { failureReason: handle.cancelReason } : {}),
      capabilities: [...handle.capabilities],
      requiredCapabilities: [...handle.requiredCapabilities],
    };
    this.auditTrail?.append('subagent.execute.end', {
      subagentId: handle.subagentId,
      status: 'cancelled',
      durationMs: result.durationMs,
      turns: result.turns,
      ...(handle.cancelReason ? { error: handle.cancelReason } : {}),
      channelId: handle.channelId,
    });
    return result;
  }

  private finalizeFailed(
    handle: ActiveSubagentHandle,
    failureReason: string,
  ): SubagentResult {
    const previous = this.taskRegistry.getActiveTask(handle.subagentId);
    const failed = this.taskRegistry.markFailed(
      handle.subagentId,
      'execution_failed',
      failureReason,
      Date.now(),
    );
    this.auditTrail?.append('subagent.lifecycle.transition', {
      subagentId: handle.subagentId,
      from: previous?.lifecycleState ?? 'queued',
      to: failed.lifecycleState,
      reason: failed.stateReason,
      failureReason,
      workerLane: failed.workerLane,
      channelId: failed.channelId,
    });
    const result: SubagentResult = {
      subagentId: handle.subagentId,
      name: handle.request.name,
      content: '',
      model: '',
      inputTokens: 0,
      outputTokens: 0,
      durationMs: Date.now() - handle.startTime,
      turns: 0,
      workerLane: SUBAGENT_WORKER_LANE,
      lifecycleState: 'failed',
      stateReason: failed.stateReason,
      failureReason,
      capabilities: [...handle.capabilities],
      requiredCapabilities: [...handle.requiredCapabilities],
    };
    this.auditTrail?.append('subagent.execute.end', {
      subagentId: handle.subagentId,
      status: 'failed',
      durationMs: result.durationMs,
      error: failureReason,
      channelId: handle.channelId,
    });
    return result;
  }

  private buildControlMessage(channelId: string, content: string): SubstrateMessage {
    return {
      id: `subagent-control-${randomUUID()}`,
      channelId,
      channelType: inferSessionChannelType(channelId) ?? 'api',
      authorId: SUBAGENT_CONTROL_AUTHOR_ID,
      authorName: SUBAGENT_CONTROL_AUTHOR_NAME,
      content,
      timestamp: new Date(),
      routing: {
        workerExecution: createWorkerExecutionPolicy(SUBAGENT_WORKER_LANE),
      },
    };
  }

  private buildBaseMessage(
    subagentId: string,
    executionChannelId: string,
    request: SubagentExecutionRequest,
  ): SubstrateMessage {
    const workerExecution = createWorkerExecutionPolicy(SUBAGENT_WORKER_LANE);
    if (request.message) {
      return {
        ...request.message,
        content: request.task,
        routing: {
          ...(request.message.routing ?? {}),
          workerExecution,
        },
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
      routing: {
        workerExecution,
      },
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

  private buildRuntimeTaskView(
    task: SubagentTaskRecord,
    transcriptLimit: number,
  ): SubagentRuntimeTaskView {
    const transcript = this.deps.sessionStore.getRecent(task.channelId, transcriptLimit);
    const transcriptMessageCount = this.deps.sessionStore.count(task.channelId);
    const transcriptTruncated = transcriptMessageCount > transcriptLimit;
    const latestAssistantEntry = [...transcript].reverse().find(entry => entry.role === 'assistant' && entry.content.trim().length > 0);
    const artifacts: SubagentRuntimeArtifactView[] = latestAssistantEntry
      ? [{
        kind: 'final_output',
        content: latestAssistantEntry.content,
        timestamp: latestAssistantEntry.timestamp,
        ...(typeof latestAssistantEntry.id === 'number' ? { sourceMessageId: latestAssistantEntry.id } : {}),
      }]
      : [];

    const lastEntry = transcript.at(-1);
    const lastActivityAt = lastEntry?.timestamp
      ?? task.finishedAt
      ?? task.startedAt
      ?? task.createdAt;
    const resume: SubagentRuntimeResumeView = {
      channelId: task.channelId,
      lifecycleState: task.lifecycleState,
      resumable: task.lifecycleState === 'queued' || task.lifecycleState === 'running',
      transcriptAvailable: transcriptMessageCount > 0,
      transcriptMessageCount,
      transcriptTruncated,
    };
    if (Number.isFinite(lastActivityAt)) {
      resume.lastActivityAt = lastActivityAt;
    }
    if (lastEntry) {
      resume.lastMessageId = lastEntry.id;
    }

    return {
      task,
      transcript,
      transcriptMessageCount,
      transcriptTruncated,
      artifacts,
      resume,
    };
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

function normalizePositiveInteger(value: unknown, fallback: number): number {
  const normalized = typeof value === 'number' && Number.isFinite(value)
    ? Math.trunc(value)
    : fallback;
  return Math.max(1, normalized);
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeRequiredText(value: string, field: string): string {
  const normalized = normalizeOptionalText(value);
  if (!normalized) {
    throw new Error(`${field} is required.`);
  }
  return normalized;
}

function cloneSubagentResult(result: SubagentResult): SubagentResult {
  return {
    ...result,
    capabilities: [...result.capabilities],
    requiredCapabilities: [...result.requiredCapabilities],
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
