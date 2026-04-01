import { SUBAGENT_WORKER_LANE } from '../agent/worker-lanes.js';
import type { SubagentTaskLifecycleState, SubagentTaskRecord } from './types.js';

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
  createdAt?: number;
}

export class SubagentTaskRegistry {
  private readonly activeTasks = new Map<string, SubagentTaskRecord>();
  private readonly completedTasks: SubagentTaskRecord[] = [];
  private readonly completedTaskLimit: number;

  constructor(options: { completedTaskLimit?: number } = {}) {
    this.completedTaskLimit = Math.max(1, Math.trunc(options.completedTaskLimit ?? DEFAULT_COMPLETED_TASK_LIMIT));
  }

  register(input: RegisterSubagentTaskInput): SubagentTaskRecord {
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
    };
    this.activeTasks.set(record.subagentId, record);
    return cloneTaskRecord(record);
  }

  markRunning(subagentId: string, reason: string, startedAt = Date.now()): SubagentTaskRecord {
    return this.transitionActiveTask(subagentId, 'running', reason, {
      startedAt,
      finishedAt: undefined,
      failureReason: undefined,
    });
  }

  markCompleted(subagentId: string, reason: string, finishedAt = Date.now()): SubagentTaskRecord {
    return this.finishTask(subagentId, 'completed', reason, finishedAt);
  }

  markFailed(
    subagentId: string,
    reason: string,
    failureReason: string,
    finishedAt = Date.now(),
  ): SubagentTaskRecord {
    return this.finishTask(subagentId, 'failed', reason, finishedAt, failureReason);
  }

  markCancelled(
    subagentId: string,
    reason: string,
    finishedAt = Date.now(),
    failureReason?: string,
  ): SubagentTaskRecord {
    return this.finishTask(subagentId, 'cancelled', reason, finishedAt, failureReason);
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
  ): SubagentTaskRecord {
    const current = this.activeTasks.get(subagentId);
    if (!current) {
      throw new Error(`Unknown subagent task "${subagentId}".`);
    }
    assertAllowedTransition(subagentId, current.lifecycleState, nextState);
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
  ): SubagentTaskRecord {
    const current = this.activeTasks.get(subagentId);
    if (!current) {
      throw new Error(`Unknown subagent task "${subagentId}".`);
    }
    assertAllowedTransition(subagentId, current.lifecycleState, nextState);
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
}

function assertAllowedTransition(
  subagentId: string,
  current: SubagentTaskLifecycleState,
  next: SubagentTaskLifecycleState,
): void {
  if (!ALLOWED_TRANSITIONS[current].includes(next)) {
    throw new Error(`Invalid subagent task transition for ${subagentId}: ${current} -> ${next}.`);
  }
}

function cloneTaskRecord(record: SubagentTaskRecord): SubagentTaskRecord {
  return {
    ...record,
    capabilities: [...record.capabilities],
    requiredCapabilities: [...record.requiredCapabilities],
  };
}
