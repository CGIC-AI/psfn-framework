import { randomUUID } from 'node:crypto';
import type { AgentTool } from '../../boundary/pi-agent/index.js';
import type {
  CapabilityTier,
  SubstrateConfig,
} from '../../system/config/runtime-config-contracts.js';
import { sanitizeCoreSubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { EventBus } from '../../shared/event-bus.js';
import type {
  LLMProviderPort as LLMProvider,
  MemoryProvider,
} from '../../core/agent/contracts.js';
import type { EmbeddingProviderPort as EmbeddingService } from '../../shared/contracts/embedding-provider.js';
import { SubstrateAgent } from '../../core/agent/substrate-agent.js';
import {
  SUBAGENT_WORKER_LANE,
  createWorkerExecutionPolicy,
} from '../../core/agent/worker-lanes.js';
import type { RuntimeMode } from '../../core/agent/tool-wiring-validator.js';
import { normalizeCapabilityTier } from '../../system/capabilities/tiers.js';
import { resolveCoreCompanionIdFromConfig } from '../../core/identity/companion-runtime.js';
import {
  createGatewayRoutingEnvelope,
  type GatewayRoutingEnvelope,
  type ShardLineage,
} from '../../shared/routing/envelope.js';
import type { ChannelType, SubstrateMessage, WyomingRoutingMetadata } from '../../shared/contracts/runtime.js';
import type { SessionStore } from '../../persistence/sessions/store.js';
import { SessionManager } from '../../core/session/manager.js';
import { inferSessionChannelType } from '../../core/session/session-id.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import { createComponentLogger } from '../../shared/logger.js';
import { AGENT_LOOP_MAX_ASSISTANT_STEPS_PER_RUN } from '../../core/agent/turn-limits.js';
import {
  buildCompletionHandoffDedupeKey,
  emitCompletionHandoff,
  safeEmitCompletionHandoffError,
  summarizeCompletionText,
  type CompletionHandoffInput,
} from '../../core/agent/completion-handoff.js';
import type { CompletionNoticeBuffer } from '../../core/agent/completion-notices.js';
import { assertWorkSpecLaneParity } from '../../primitives/llm/work-spec.js';
import type { SubagentControlPort } from './port.js';
import { SubagentTaskRegistry } from './task-registry.js';
import { buildSubagentWorkSpec, createSubagentWorkSpecProvider } from './work-spec.js';
import type {
  SubagentExecutionRequest,
  SubagentExecutionSourceContext,
  SubagentPartialResult,
  SubagentRemainingBudget,
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

const log = createComponentLogger('SubagentFaculty');

/** mmo9.7.7: which declared work-spec budget ceiling curtailed a bounded run. */
interface SubagentBudgetExhaustion {
  reason: 'deadline' | 'output_tokens';
}

const DEFAULT_MAX_CONCURRENT = 8;
const DEFAULT_MAX_TURNS = 1;
const DEFAULT_RECENT_RESULT_LIMIT = 25;
const DEFAULT_SUBAGENT_CAPABILITIES = ['general'] as const;

const BLOCKED_SUBAGENT_TOOL_NAMES = new Set([
  'subagent',
  'spawn_subagent',
  'spawn_shard',
  'shard',
  'load_tools',
  'toolset',
  'contact_list',
  'contact_lookup',
  'contact_note',
  'contact_set_trust',
  'contact_link_identity',
  'contact_set_channel_privacy',
  'contact_set_machine_intelligence',
]);
const SUBAGENT_TASK_AUTHOR_ID = 'system:subagent-task';
const SUBAGENT_TASK_AUTHOR_NAME = 'SubagentTask';
const SUBAGENT_CONTROL_AUTHOR_ID = 'system:subagent-control';
const SUBAGENT_CONTROL_AUTHOR_NAME = 'SubagentControl';

function resolveMessageChannelType(channelId: string): ChannelType {
  const inferred = inferSessionChannelType(channelId);
  return inferred && inferred !== 'subagent' ? inferred : 'api';
}

function normalizeSubagentMaxTurns(value: unknown): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_TURNS;
  return Math.max(1, Math.min(AGENT_LOOP_MAX_ASSISTANT_STEPS_PER_RUN, Math.trunc(value as number)));
}

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
  /** Buffer for compact companion-facing completion notices (never session-persisted). */
  completionNotices?: CompletionNoticeBuffer | null;
  embeddingService: EmbeddingService | null;
  memoryProvider: MemoryProvider | null;
  config: SubstrateConfig;
  parentSystemPrompt: string;
  maxConcurrent?: number;
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
  /**
   * Follow-up/steer turns dispatched onto this subagent's SubstrateAgent
   * (via `message`) run as fresh ordinary turns that are not part of the
   * bounded `runHandle` loop. They still write to the subagent session, so
   * the faculty must await them before reporting the subagent terminal —
   * otherwise a "completed" subagent can keep writing to a session whose
   * backing store the caller has already disposed (psfn-framework-k510).
   */
  outstandingTurns: Promise<void>[];
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
    // Owner-file setting (zet.7): explicit deps override wins (tests/embedding),
    // then the operator's settings.json value, then the compiled default.
    this.maxConcurrent = Math.max(
      1,
      Math.trunc(deps.maxConcurrent ?? deps.config.subagentMaxConcurrent ?? DEFAULT_MAX_CONCURRENT),
    );
    this.auditTrail = deps.auditTrail ?? null;
  }

  /** Resolved concurrency cap on active subagent tasks (owner-file backed, zet.7). */
  get maxConcurrentTasks(): number {
    return this.maxConcurrent;
  }

  async execute(request: SubagentExecutionRequest): Promise<SubagentResult> {
    const task = await this.spawn(request);
    const result = await this.wait(task.subagentId);
    if (result.outcome === 'completed') {
      return result;
    }
    const failureReason = result.failureReason ?? result.stateReason;
    throw new Error(`Subagent "${result.name}" ${result.outcome} (${result.stateReason}): ${failureReason}`);
  }

  async spawn(request: SubagentExecutionRequest): Promise<SubagentTaskRecord> {
    // Fail closed on a work spec whose declared lane does not reconcile with the
    // single runtime lane resolver (Law 12.4) before any worker is registered.
    assertWorkSpecLaneParity(request.workSpec);
    const subagentId = `subagent-${randomUUID()}`;
    const startTime = Date.now();
    if (this.taskRegistry.getActiveCount() >= this.maxConcurrent) {
      await this.emitBlockedSpawnHandoff(
        request,
        subagentId,
        'concurrency_limit',
        `Subagent limit reached (${this.maxConcurrent} concurrent). Wait for active subagent tasks to finish.`,
      );
      throw new Error(
        `Subagent limit reached (${this.maxConcurrent} concurrent). Wait for active subagent tasks to finish.`,
      );
    }

    const maxTurns = normalizeSubagentMaxTurns(request.maxTurns);
    const capabilities = this.resolveAdvertisedCapabilities(request.capabilities);
    const requiredCapabilities = this.resolveRequiredCapabilities(request.requiredCapabilities);
    const missingCapabilities = requiredCapabilities.filter(capability => !capabilities.includes(capability));
    if (missingCapabilities.length > 0) {
      await this.emitBlockedSpawnHandoff(
        request,
        subagentId,
        'missing_capabilities',
        `Subagent routing denied: "${request.name}" is missing required capability tokens `
        + `(${missingCapabilities.join(', ')}).`,
      );
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
      ...(request.sourceContext ? { sourceContext: request.sourceContext } : {}),
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
      outstandingTurns: [],
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
      this.trackOutstandingTurn(handle, handle.agentLoop.followUp(followUp), followUp.id);
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
        await this.finishHandle(handle, this.finalizeCancelled(handle, 0, 0, '', '', 0));
      }
    }

    return cloneSubagentResult(await handle.completion);
  }

  private async runHandle(handle: ActiveSubagentHandle): Promise<void> {
    if (handle.settled) return;

    // mmo9.7.7: hoisted above the try so a mid-turn cancel that aborts the
    // in-flight handleMessage (surfacing as a throw) preserves the accumulated
    // partial in the catch path — otherwise the cancelled result would discard
    // every completed turn's tokens/checkpoint (mmo9.7.7 P1).
    let totalInput = 0;
    let totalOutput = 0;
    let lastModel = '';
    let lastContent = '';
    let turns = 0;

    try {
      const sessionManager = new SessionManager(
        this.deps.sessionStore,
        this.deps.config,
        this.deps.eventBus,
      );
      // mmo9.7.7: thread the request's typed work spec onto the bounded worker's
      // model calls through the mmo9.7.1 client seam (no new admission logic).
      const workSpecProvider = createSubagentWorkSpecProvider(
        this.deps.llmProvider,
        handle.request.workSpec,
      );
      const agentLoop = new SubstrateAgent(
        this.deps.eventBus,
        workSpecProvider,
        sessionManager,
        handle.request.systemPrompt ?? this.deps.parentSystemPrompt,
        sanitizeCoreSubstrateConfig(this.deps.config),
        {
          runtimeMode: this.deps.runtimeMode === 'gateway' ? 'gateway' : undefined,
          // Subagents are ephemeral and intentionally own no durable post-turn lane.
          backgroundWorkDisabled: true,
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
        await this.finishHandle(handle, this.finalizeCancelled(handle, 0, 0, '', '', 0));
        return;
      }

      this.transitionTask(handle.subagentId, 'running', 'agent_initialized', handle.startTime);
      await this.emitLifecycleProgressHandoff(handle, 'started', 0);
      this.flushPendingMessages(handle);

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
        await this.emitLifecycleProgressHandoff(handle, 'progress', turns);

        if (this.isCancellationRequested(handle)) {
          await this.finishHandle(handle, this.finalizeCancelled(
            handle,
            totalInput,
            totalOutput,
            lastModel,
            lastContent,
            turns,
          ));
          return;
        }

        // mmo9.7.7: honestly report budget_limited when a declared work-spec
        // budget (deadline / output-token ceiling) is crossed with bounded-loop
        // turns still unused. A single-turn run (its bounded deliverable) or the
        // final turn is never budget_limited — there is nothing left to curtail.
        if (turn < handle.maxTurns - 1) {
          const budget = this.evaluateBudgetExhaustion(handle, totalOutput, turns);
          if (budget) {
            await this.finishHandle(handle, this.finalizeBudgetLimited(
              handle,
              totalInput,
              totalOutput,
              lastModel,
              lastContent,
              turns,
              budget,
            ));
            return;
          }
        }

        if (turn === 0 && handle.maxTurns === 1) break;
      }

      await this.finishHandle(handle, this.finalizeCompleted(
        handle,
        totalInput,
        totalOutput,
        lastModel,
        lastContent,
        turns,
      ));
    } catch (error) {
      if (this.isCancellationRequested(handle)) {
        // Preserve the accumulated partial: a cancel that aborted an in-flight
        // turn still discarded no completed work.
        await this.finishHandle(handle, this.finalizeCancelled(
          handle,
          totalInput,
          totalOutput,
          lastModel,
          lastContent,
          turns,
        ));
        return;
      }
      await this.finishHandle(handle, this.finalizeFailed(handle, toErrorMessage(error)));
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
        workSpec: buildSubagentWorkSpec({
          correlation: {
            channelId: request.message.channelId,
            ...(request.message.id ? { requestId: request.message.id } : {}),
            ...(routing?.turnId ? { turnId: routing.turnId } : {}),
          },
        }),
        message: request.message,
        executionChannelId: request.message.channelId,
        maxTurns: 1,
        capabilities: this.resolveWyomingRouteCapabilities(routing),
        requiredCapabilities: this.resolveWyomingRouteCapabilities(routing),
      });
      const gatewayRouting = createGatewayRoutingEnvelope({
        companionId: request.gatewayRouting?.companionId
          ?? request.message.routing?.gateway?.companionId
          ?? resolveCoreCompanionIdFromConfig(this.deps.config),
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
      this.trackOutstandingTurn(handle, handle.agentLoop.followUp(message), message.id);
    }
  }

  /**
   * Records a fresh-ordinary turn dispatched onto the subagent's SubstrateAgent
   * so `finishHandle` can await it before the subagent is reported terminal.
   * Failures are recorded (never swallowed) but must not surface as an unhandled
   * rejection, so the tracked promise is settled here and the raw error is
   * routed to the audit trail.
   */
  private trackOutstandingTurn(
    handle: ActiveSubagentHandle,
    turn: Promise<unknown>,
    followUpMessageId: string,
  ): void {
    const settled = turn.then(
      () => undefined,
      (error: unknown) => {
        this.auditTrail?.append('subagent.followup_turn.failed', {
          subagentId: handle.subagentId,
          channelId: handle.channelId,
          followUpMessageId,
          error: toErrorMessage(error),
        });
      },
    );
    handle.outstandingTurns.push(settled);
  }

  private async drainOutstandingTurns(handle: ActiveSubagentHandle): Promise<void> {
    // Follow-up turns can themselves dispatch further follow-ups, so drain
    // until the set is stable rather than snapshotting once.
    while (handle.outstandingTurns.length > 0) {
      const inFlight = handle.outstandingTurns.splice(0, handle.outstandingTurns.length);
      await Promise.all(inFlight);
    }
  }

  private async finishHandle(handle: ActiveSubagentHandle, result: SubagentResult): Promise<void> {
    if (handle.settled) return;
    // Remove from the active set first so no further follow-up turns can be
    // enqueued via `message` once we begin draining.
    this.activeHandles.delete(handle.subagentId);
    // Drain any follow-up/steer turns still writing to the subagent session
    // before reporting terminality. Without this, `wait`/`execute`/`cancel`
    // resolve while a detached turn is mid-write, and a caller that disposes
    // the session store races an in-flight journal write (psfn-framework-k510).
    await this.drainOutstandingTurns(handle);
    this.storeRecentResult(result);
    try {
      await this.emitCompletionHandoff(handle, result);
    } catch (handoffError) {
      log.error('Terminal subagent lifecycle handoff failed without changing the task result', {
        subagentId: handle.subagentId,
        lifecycleState: result.lifecycleState,
        error: safeEmitCompletionHandoffError(handoffError),
      });
    }
    handle.settled = true;
    handle.resolveCompletion(cloneSubagentResult(result));
  }

  private async emitBlockedSpawnHandoff(
    request: SubagentExecutionRequest,
    subagentId: string,
    reason: string,
    error: string,
  ): Promise<void> {
    const sourceContext = this.resolveSourceContext(request);
    await this.emitHandoff({
      source: 'subagent',
      taskId: subagentId,
      taskLabel: request.name,
      subagentId,
      status: 'blocked',
      resultSummary: `Subagent "${request.name}" did not start.`,
      outputRefs: [],
      validationPerformed: ['subagent_spawn_policy', reason],
      blocker: { reason, error },
      partialResult: false,
      recommendedNextAction: 'Revise the worker request, wait for active workers to clear, or choose a narrower task before notifying any partner.',
      origin: {
        ...(sourceContext ? this.originFromSourceContext(sourceContext) : {}),
        ...(sourceContext ? { sourceChannelId: sourceContext.channelId } : {}),
      },
      dedupeKey: buildCompletionHandoffDedupeKey([
        'subagent',
        subagentId,
        'blocked',
        reason,
        sourceContext?.requestId,
        sourceContext?.turnId,
      ]),
    }, sourceContext?.channelId);
  }

  private async emitCompletionHandoff(
    handle: ActiveSubagentHandle,
    result: SubagentResult,
  ): Promise<void> {
    const sourceContext = this.resolveSourceContext(handle.request);

    // mmo9.7.7: key the handoff off the honest terminal outcome + checkpoint. A
    // A cancelled or budget_limited run can still carry a partial deliverable,
    // but cancellation remains the honest lifecycle status instead of being
    // collapsed into the generic partial state.
    const checkpointContent = result.partial?.latestCheckpoint.content.trim() ?? '';
    const hasUsableCheckpoint = checkpointContent.length > 0;
    const isPartial = (result.outcome === 'cancelled' || result.outcome === 'budget_limited')
      && hasUsableCheckpoint;
    const status = result.outcome === 'completed'
      ? 'completed'
      : result.outcome === 'blocked'
        ? 'blocked'
        : result.outcome === 'cancelled'
          ? 'cancelled'
          : (isPartial ? 'partial' : 'failed');
    await this.emitHandoff({
      source: 'subagent',
      taskId: handle.subagentId,
      taskLabel: result.name,
      subagentId: handle.subagentId,
      status,
      resultSummary: result.outcome === 'completed' || isPartial
        ? summarizeCompletionText(result.content)
        : `Subagent "${result.name}" ended without a usable final output.`,
      outputRefs: [
        { kind: 'session', ref: handle.channelId, label: 'subagent transcript' },
        { kind: 'subagent_result', ref: result.subagentId, label: result.lifecycleState },
      ],
      validationPerformed: [
        'subagent_lifecycle_terminal',
        `state_reason:${result.stateReason}`,
        ...(result.turns > 0 ? [`turns:${result.turns}`] : []),
      ],
      ...(result.failureReason
        ? {
            blocker: {
              reason: result.stateReason,
              error: result.failureReason,
            },
          }
        : {}),
      partialResult: isPartial || status === 'partial',
      recommendedNextAction: result.lifecycleState === 'completed'
        ? 'Review the internal handoff and decide whether to continue, ask a follow-up, or write a companion-authored partner response.'
        : 'Decide whether to retry, narrow the worker task, or surface a companion-authored status after policy review.',
      origin: {
        ...(sourceContext ? this.originFromSourceContext(sourceContext) : {}),
        ...(sourceContext ? { sourceChannelId: sourceContext.channelId } : {}),
      },
      dedupeKey: buildCompletionHandoffDedupeKey([
        'subagent',
        handle.subagentId,
        result.lifecycleState,
        result.stateReason,
        sourceContext?.requestId,
        sourceContext?.turnId,
      ]),
    }, sourceContext?.channelId);
  }

  private async emitLifecycleProgressHandoff(
    handle: ActiveSubagentHandle,
    status: 'started' | 'progress',
    completedTurns: number,
  ): Promise<void> {
    const sourceContext = this.resolveSourceContext(handle.request);
    await this.emitHandoff({
      source: 'subagent',
      taskId: handle.subagentId,
      taskLabel: handle.request.name,
      subagentId: handle.subagentId,
      status,
      resultSummary: status === 'started'
        ? `Subagent "${handle.request.name}" started.`
        : `Subagent "${handle.request.name}" completed ${completedTurns} of ${handle.maxTurns} bounded turns.`,
      outputRefs: [],
      validationPerformed: [
        'subagent_lifecycle_nonterminal',
        ...(status === 'progress' ? [`completed_turns:${completedTurns}`] : []),
      ],
      partialResult: status === 'progress',
      recommendedNextAction: 'Keep the task visible without interrupting the foreground conversation.',
      origin: {
        ...(sourceContext ? this.originFromSourceContext(sourceContext) : {}),
        ...(sourceContext ? { sourceChannelId: sourceContext.channelId } : {}),
      },
      dedupeKey: buildCompletionHandoffDedupeKey([
        'subagent',
        handle.subagentId,
        status,
        String(completedTurns),
        sourceContext?.requestId,
        sourceContext?.turnId,
      ]),
    }, sourceContext?.channelId, false);
  }

  private async emitHandoff(
    handoff: CompletionHandoffInput,
    targetChannelId?: string,
    bufferNotice = true,
  ): Promise<void> {
    try {
      await emitCompletionHandoff({
        eventBus: this.deps.eventBus,
        handoff,
        ...(targetChannelId ? { targetChannelId } : {}),
        ...(bufferNotice && this.deps.completionNotices
          ? { notices: this.deps.completionNotices }
          : {}),
      });
    } catch (error) {
      this.auditTrail?.append('subagent.completion_handoff.failed', {
        subagentId: handoff.subagentId,
        targetChannelId,
        error: safeEmitCompletionHandoffError(error),
      });
      throw error;
    }
  }

  private resolveSourceContext(request: SubagentExecutionRequest): SubagentExecutionSourceContext | null {
    if (request.sourceContext?.channelId.trim()) {
      return request.sourceContext;
    }
    if (request.message?.channelId.trim()) {
      return {
        channelId: request.message.channelId,
        requestId: request.message.id,
        ...(request.message.routing?.wyoming?.turnId ? { turnId: request.message.routing.wyoming.turnId } : {}),
      };
    }
    return null;
  }

  private originFromSourceContext(sourceContext: SubagentExecutionSourceContext): CompletionHandoffInput['origin'] {
    return {
      ...(sourceContext.originatingTaskId ? { originatingTaskId: sourceContext.originatingTaskId } : {}),
      ...(sourceContext.originatingBeadId ? { originatingBeadId: sourceContext.originatingBeadId } : {}),
      ...(sourceContext.requestId ? { requestId: sourceContext.requestId, sourceMessageId: sourceContext.requestId } : {}),
      ...(sourceContext.turnId ? { turnId: sourceContext.turnId } : {}),
    };
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
      outcome: 'completed',
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
      outcome: 'cancelled',
      stateReason: cancelled.stateReason,
      ...(handle.cancelReason ? { failureReason: handle.cancelReason } : {}),
      partial: this.buildPartialResult(handle, totalOutput, lastModel, lastContent, turns),
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
      outcome: 'blocked',
      stateReason: failed.stateReason,
      failureReason,
      partial: this.buildPartialResult(handle, 0, '', '', 0),
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

  private finalizeBudgetLimited(
    handle: ActiveSubagentHandle,
    totalInput: number,
    totalOutput: number,
    lastModel: string,
    lastContent: string,
    turns: number,
    budget: SubagentBudgetExhaustion,
  ): SubagentResult {
    const failureReason = budget.reason === 'deadline'
      ? 'work spec deadline budget exhausted before completion'
      : 'work spec output-token budget exhausted before completion';
    const previous = this.taskRegistry.getActiveTask(handle.subagentId);
    // The registry lifecycle machine has no budget terminal; record the coarse
    // non-completed terminal (failed) while the result reports the honest
    // `budget_limited` outcome so it never masquerades as completed.
    const stopped = this.taskRegistry.markFailed(
      handle.subagentId,
      'budget_exhausted',
      failureReason,
      Date.now(),
    );
    this.auditTrail?.append('subagent.lifecycle.transition', {
      subagentId: handle.subagentId,
      from: previous?.lifecycleState ?? 'running',
      to: stopped.lifecycleState,
      reason: stopped.stateReason,
      outcome: 'budget_limited',
      budgetReason: budget.reason,
      failureReason,
      workerLane: stopped.workerLane,
      channelId: stopped.channelId,
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
      lifecycleState: 'failed',
      outcome: 'budget_limited',
      stateReason: stopped.stateReason,
      failureReason,
      partial: this.buildPartialResult(handle, totalOutput, lastModel, lastContent, turns),
      capabilities: [...handle.capabilities],
      requiredCapabilities: [...handle.requiredCapabilities],
    };
    this.auditTrail?.append('subagent.execute.end', {
      subagentId: handle.subagentId,
      status: 'budget_limited',
      durationMs: result.durationMs,
      turns: result.turns,
      budgetReason: budget.reason,
      channelId: handle.channelId,
    });
    return result;
  }

  /**
   * mmo9.7.7: has this run crossed a declared work-spec budget ceiling? Only
   * consults ceilings the spec actually declared; returns null when no budget is
   * exhausted (the run may still complete or be cancelled). No admission logic —
   * this reads the spec's advisory ceilings, it does not gate model calls.
   */
  private evaluateBudgetExhaustion(
    handle: ActiveSubagentHandle,
    totalOutput: number,
    _turns: number,
  ): SubagentBudgetExhaustion | null {
    const { workSpec } = handle.request;
    if (workSpec.deadlineMs !== undefined && Date.now() - handle.startTime >= workSpec.deadlineMs) {
      return { reason: 'deadline' };
    }
    if (workSpec.maxOutputTokens !== undefined && totalOutput >= workSpec.maxOutputTokens) {
      return { reason: 'output_tokens' };
    }
    return null;
  }

  private buildPartialResult(
    handle: ActiveSubagentHandle,
    totalOutput: number,
    lastModel: string,
    lastContent: string,
    turns: number,
  ): SubagentPartialResult {
    return {
      remainingBudget: this.buildRemainingBudget(handle, totalOutput, turns),
      latestCheckpoint: {
        content: lastContent,
        turnsCompleted: turns,
        model: lastModel,
        capturedAt: Date.now(),
      },
    };
  }

  private buildRemainingBudget(
    handle: ActiveSubagentHandle,
    totalOutput: number,
    turns: number,
  ): SubagentRemainingBudget {
    const { workSpec } = handle.request;
    const remaining: SubagentRemainingBudget = {
      remainingTurns: Math.max(0, handle.maxTurns - turns),
    };
    if (workSpec.maxOutputTokens !== undefined) {
      remaining.remainingOutputTokens = Math.max(0, workSpec.maxOutputTokens - totalOutput);
    }
    if (workSpec.deadlineMs !== undefined) {
      remaining.remainingDeadlineMs = workSpec.deadlineMs - (Date.now() - handle.startTime);
    }
    return remaining;
  }

  private buildControlMessage(channelId: string, content: string): SubstrateMessage {
    return {
      id: `subagent-control-${randomUUID()}`,
      channelId,
      channelType: resolveMessageChannelType(channelId),
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
      channelType: resolveMessageChannelType(executionChannelId),
      authorId: SUBAGENT_TASK_AUTHOR_ID,
      authorName: SUBAGENT_TASK_AUTHOR_NAME,
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

    return [...availableByName.values()];
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
    ...(result.partial
      ? {
          partial: {
            remainingBudget: { ...result.partial.remainingBudget },
            latestCheckpoint: { ...result.partial.latestCheckpoint },
          },
        }
      : {}),
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
