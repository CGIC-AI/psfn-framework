import { SUBAGENT_WORKER_LANE } from '../../core/agent/worker-lanes.js';
import type { AutomataRunOutcome, AutomataRunRecord } from '../automata/registry-contract.js';
import type { AutomataRunRegistry } from '../automata/run-registry.js';
import type { SubagentExecutionSourceContext, SubagentTaskLifecycleState, SubagentTaskRecord } from './types.js';

const DEFAULT_COMPLETED_TASK_LIMIT = 25;

const ALLOWED_TRANSITIONS: Readonly<Record<SubagentTaskLifecycleState, readonly SubagentTaskLifecycleState[]>> = {
  queued: ['running', 'cancelled', 'failed'],
  running: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

export interface RegisterSubagentTaskInput {
  subagentId: string;
  name: string;
  task: string;
  channelId: string;
  capabilities: readonly string[];
  requiredCapabilities: readonly string[];
  sourceContext?: SubagentExecutionSourceContext;
  createdAt?: number;
}

export class SubagentTaskRegistry {
  private readonly activeTasks = new Map<string, SubagentTaskRecord>();
  private readonly completedTasks: SubagentTaskRecord[] = [];
  private readonly completedTaskLimit: number;
  private readonly runRegistry: AutomataRunRegistry | null;

  constructor(options: { completedTaskLimit?: number; runRegistry?: AutomataRunRegistry } = {}) {
    this.completedTaskLimit = Math.max(1, Math.trunc(options.completedTaskLimit ?? DEFAULT_COMPLETED_TASK_LIMIT));
    this.runRegistry = options.runRegistry ?? null;
    if (this.runRegistry) {
      for (const run of this.runRegistry.listRetainedRunsForRuntime()) {
        if (run.automatonClass !== 'subagent.bounded') continue;
        const task = taskFromRun(run);
        if (task.lifecycleState === 'queued' || task.lifecycleState === 'running') {
          this.activeTasks.set(task.subagentId, task);
        } else {
          this.completedTasks.push(task);
        }
      }
      this.completedTasks.sort((left, right) => (right.finishedAt ?? right.createdAt) - (left.finishedAt ?? left.createdAt));
    }
  }

  register(input: RegisterSubagentTaskInput): SubagentTaskRecord | Promise<SubagentTaskRecord> {
    const createdAt = input.createdAt ?? Date.now();
    const record: SubagentTaskRecord = {
      subagentId: input.subagentId,
      name: input.name,
      task: input.task,
      workerLane: SUBAGENT_WORKER_LANE,
      channelId: input.channelId,
      lifecycleState: 'queued',
      stateReason: 'execution_requested',
      createdAt,
      capabilities: [...input.capabilities],
      requiredCapabilities: [...input.requiredCapabilities],
      ...(input.sourceContext ? { sourceContext: cloneSourceContext(input.sourceContext) } : {}),
    };
    if (this.runRegistry) {
      return this.persistRegistration(record);
    }
    this.activeTasks.set(record.subagentId, record);
    return cloneTaskRecord(record);
  }

  markRunning(subagentId: string, reason: string, startedAt = Date.now()): SubagentTaskRecord | Promise<SubagentTaskRecord> {
    return this.transitionActiveTask(subagentId, 'running', reason, {
      startedAt,
      finishedAt: undefined,
      failureReason: undefined,
    });
  }

  markCompleted(subagentId: string, reason: string, finishedAt = Date.now()): SubagentTaskRecord | Promise<SubagentTaskRecord> {
    return this.finishTask(subagentId, 'completed', reason, finishedAt, undefined, 'completed');
  }

  markFailed(
    subagentId: string,
    reason: string,
    failureReason: string,
    finishedAt = Date.now(),
    outcome: Extract<AutomataRunOutcome, 'blocked' | 'budget_limited'> = 'blocked',
  ): SubagentTaskRecord | Promise<SubagentTaskRecord> {
    return this.finishTask(subagentId, 'failed', reason, finishedAt, failureReason, outcome);
  }

  markCancelled(
    subagentId: string,
    reason: string,
    finishedAt = Date.now(),
    failureReason?: string,
  ): SubagentTaskRecord | Promise<SubagentTaskRecord> {
    return this.finishTask(subagentId, 'cancelled', reason, finishedAt, failureReason, 'cancelled');
  }

  getActiveCount(): number {
    return this.activeTasks.size;
  }

  getActiveTasks(): SubagentTaskRecord[] {
    return [...this.activeTasks.values()].map(cloneTaskRecord);
  }

  getActiveTask(subagentId: string): SubagentTaskRecord | null {
    const task = this.activeTasks.get(subagentId);
    return task ? cloneTaskRecord(task) : null;
  }

  getRecentTasks(limit = this.completedTaskLimit): SubagentTaskRecord[] {
    const bounded = Math.max(0, Math.trunc(limit));
    return this.completedTasks.slice(0, bounded).map(cloneTaskRecord);
  }

  private transitionActiveTask(
    subagentId: string,
    nextState: Extract<SubagentTaskLifecycleState, 'running'>,
    reason: string,
    overrides: {
      startedAt?: number;
      finishedAt?: number;
      failureReason?: string;
    } = {},
  ): SubagentTaskRecord | Promise<SubagentTaskRecord> {
    const current = this.activeTasks.get(subagentId);
    if (!current) {
      throw new Error(`Unknown automaton task "${subagentId}".`);
    }
    assertAllowedTransition(subagentId, current.lifecycleState, nextState);
    if (this.runRegistry) {
      return this.persistTransition(current, nextState, reason, overrides);
    }
    current.lifecycleState = nextState;
    current.stateReason = reason;
    if (overrides.startedAt !== undefined) current.startedAt = overrides.startedAt;
    if (overrides.finishedAt !== undefined) current.finishedAt = overrides.finishedAt;
    if (overrides.failureReason !== undefined) current.failureReason = overrides.failureReason;
    return cloneTaskRecord(current);
  }

  private finishTask(
    subagentId: string,
    nextState: Extract<SubagentTaskLifecycleState, 'completed' | 'failed' | 'cancelled'>,
    reason: string,
    finishedAt: number,
    failureReason?: string,
    outcome?: AutomataRunOutcome,
  ): SubagentTaskRecord | Promise<SubagentTaskRecord> {
    const current = this.activeTasks.get(subagentId);
    if (!current) {
      throw new Error(`Unknown automaton task "${subagentId}".`);
    }
    assertAllowedTransition(subagentId, current.lifecycleState, nextState);
    if (this.runRegistry) {
      return this.persistFinish(current, nextState, reason, finishedAt, failureReason, outcome);
    }
    current.lifecycleState = nextState;
    current.stateReason = reason;
    current.finishedAt = finishedAt;
    if (failureReason) current.failureReason = failureReason;
    this.activeTasks.delete(subagentId);
    this.completedTasks.unshift(cloneTaskRecord(current));
    if (this.completedTasks.length > this.completedTaskLimit) {
      this.completedTasks.length = this.completedTaskLimit;
    }
    return cloneTaskRecord(current);
  }

  private async persistRegistration(record: SubagentTaskRecord): Promise<SubagentTaskRecord> {
    await this.runRegistry!.register({
      runId: record.subagentId,
      automatonClass: 'subagent.bounded',
      workerId: record.subagentId,
      taskId: record.sourceContext?.originatingTaskId ?? record.subagentId,
      taskLabel: record.name,
      taskSummary: record.task,
      sessionIds: [...new Set([record.channelId, ...(record.sourceContext?.logicalSessionId
        ? [record.sourceContext.logicalSessionId]
        : [])])],
      createdAtMs: record.createdAt,
    });
    this.activeTasks.set(record.subagentId, record);
    return cloneTaskRecord(record);
  }

  private async persistTransition(
    current: SubagentTaskRecord,
    nextState: Extract<SubagentTaskLifecycleState, 'running'>,
    reason: string,
    overrides: { startedAt?: number; finishedAt?: number; failureReason?: string },
  ): Promise<SubagentTaskRecord> {
    await this.runRegistry!.transition(current.subagentId, {
      status: nextState,
      reason,
      atMs: overrides.startedAt,
    });
    current.lifecycleState = nextState;
    current.stateReason = reason;
    if (overrides.startedAt !== undefined) current.startedAt = overrides.startedAt;
    if (overrides.finishedAt !== undefined) current.finishedAt = overrides.finishedAt;
    if (overrides.failureReason !== undefined) current.failureReason = overrides.failureReason;
    return cloneTaskRecord(current);
  }

  private async persistFinish(
    current: SubagentTaskRecord,
    nextState: Extract<SubagentTaskLifecycleState, 'completed' | 'failed' | 'cancelled'>,
    reason: string,
    finishedAt: number,
    failureReason?: string,
    outcome?: AutomataRunOutcome,
  ): Promise<SubagentTaskRecord> {
    await this.runRegistry!.transition(current.subagentId, {
      status: nextState,
      reason,
      atMs: finishedAt,
      ...(outcome ? { outcome } : {}),
      ...(failureReason ? { failureReason } : {}),
    });
    current.lifecycleState = nextState;
    current.stateReason = reason;
    current.finishedAt = finishedAt;
    if (failureReason) current.failureReason = failureReason;
    this.activeTasks.delete(current.subagentId);
    this.completedTasks.unshift(cloneTaskRecord(current));
    if (this.completedTasks.length > this.completedTaskLimit) this.completedTasks.length = this.completedTaskLimit;
    return cloneTaskRecord(current);
  }
}

function taskFromRun(run: AutomataRunRecord): SubagentTaskRecord {
  const channelId = run.sessionIds[0];
  if (!channelId) throw new Error(`Durable subagent run "${run.runId}" has no session`);
  return {
    subagentId: run.workerId,
    name: run.taskLabel,
    task: run.taskSummary,
    workerLane: SUBAGENT_WORKER_LANE,
    channelId,
    lifecycleState: run.status,
    stateReason: run.statusReason,
    createdAt: run.createdAtMs,
    ...(run.startedAtMs === undefined ? {} : { startedAt: run.startedAtMs }),
    ...(run.finishedAtMs === undefined ? {} : { finishedAt: run.finishedAtMs }),
    ...(run.failureReason ? { failureReason: run.failureReason } : {}),
    capabilities: [],
    requiredCapabilities: [],
  };
}

function assertAllowedTransition(
  subagentId: string,
  current: SubagentTaskLifecycleState,
  next: SubagentTaskLifecycleState,
): void {
  if (!ALLOWED_TRANSITIONS[current].includes(next)) {
    throw new Error(`Invalid automaton task transition for ${subagentId}: ${current} -> ${next}.`);
  }
}

function cloneTaskRecord(record: SubagentTaskRecord): SubagentTaskRecord {
  return {
    ...record,
    capabilities: [...record.capabilities],
    requiredCapabilities: [...record.requiredCapabilities],
    ...(record.sourceContext ? { sourceContext: cloneSourceContext(record.sourceContext) } : {}),
  };
}

function cloneSourceContext(sourceContext: SubagentExecutionSourceContext): SubagentExecutionSourceContext {
  return {
    channelId: sourceContext.channelId,
    ...(sourceContext.logicalSessionId ? { logicalSessionId: sourceContext.logicalSessionId } : {}),
    ...(sourceContext.requestId ? { requestId: sourceContext.requestId } : {}),
    ...(sourceContext.turnId ? { turnId: sourceContext.turnId } : {}),
    ...(sourceContext.originatingTaskId ? { originatingTaskId: sourceContext.originatingTaskId } : {}),
    ...(sourceContext.originatingBeadId ? { originatingBeadId: sourceContext.originatingBeadId } : {}),
  };
}
