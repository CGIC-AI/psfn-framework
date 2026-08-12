import {
  buildEffectiveAutomataClassManifest,
  cloneAutomataRun,
  requireAutomataClass,
  requireAutomataRunStatus,
  type AutomataArtifactRef,
  type AutomataOwnerPolicy,
  type AutomataRunOutcome,
  type AutomataRunRecord,
  type AutomataRunStatus,
  type EffectiveAutomataClassDescriptor,
  type ProductionAutomataClassId,
} from './registry-contract.js';
import { createAutomataTextValidator } from './validation.js';

const ALLOWED_TRANSITIONS: Readonly<Record<AutomataRunStatus, readonly AutomataRunStatus[]>> = {
  queued: ['running', 'failed', 'cancelled'],
  running: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

export interface AutomataRunStorePort {
  loadRetained(companionId: string, nowMs: number): Promise<AutomataRunRecord[]>;
  loadExact(companionId: string, runId: string): Promise<AutomataRunRecord | null>;
  insert(record: AutomataRunRecord): Promise<void>;
  update(record: AutomataRunRecord, previousStatus: AutomataRunStatus): Promise<void>;
  close?(): Promise<void>;
}

export interface RegisterAutomataRunInput {
  runId: string;
  automatonClass: string;
  workerId: string;
  workerGeneration?: number;
  taskId: string;
  taskLabel: string;
  taskSummary: string;
  parentRunId?: string;
  sourceRunId?: string;
  sessionIds?: readonly string[];
  artifacts?: readonly AutomataArtifactRef[];
  createdAtMs?: number;
}

export interface TransitionAutomataRunInput {
  status: string;
  reason: string;
  atMs?: number;
  outcome?: AutomataRunOutcome;
  failureReason?: string;
}

const requiredText = createAutomataTextValidator('Automata run');

function uniqueTexts(values: readonly string[], field: string): string[] {
  const normalized = values.map((value, index) => requiredText(value, `${field}[${index}]`));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`Automata run ${field} must not contain duplicates`);
  }
  return normalized;
}

export class InMemoryAutomataRunStore implements AutomataRunStorePort {
  private readonly records = new Map<string, AutomataRunRecord>();

  async loadRetained(companionId: string, nowMs: number): Promise<AutomataRunRecord[]> {
    return [...this.records.values()]
      .filter(record => (
        record.companionId === companionId
        && (!isTerminalStatus(record.status) || record.retentionDeadlineMs > nowMs)
      ))
      .map(cloneAutomataRun);
  }

  async loadExact(companionId: string, runId: string): Promise<AutomataRunRecord | null> {
    const record = this.records.get(runId);
    return record?.companionId === companionId ? cloneAutomataRun(record) : null;
  }

  async insert(record: AutomataRunRecord): Promise<void> {
    if (this.records.has(record.runId)) throw new Error(`Automata run "${record.runId}" already exists.`);
    this.records.set(record.runId, cloneAutomataRun(record));
  }

  async update(record: AutomataRunRecord, previousStatus: AutomataRunStatus): Promise<void> {
    const current = this.records.get(record.runId);
    if (!current || current.status !== previousStatus) {
      throw new Error(`Automata run "${record.runId}" changed concurrently.`);
    }
    this.records.set(record.runId, cloneAutomataRun(record));
  }
}

export class AutomataRunRegistry {
  private readonly runs = new Map<string, AutomataRunRecord>();
  private readonly classes: EffectiveAutomataClassDescriptor[];

  private constructor(
    private readonly companionId: string,
    private readonly policy: AutomataOwnerPolicy,
    private readonly store: AutomataRunStorePort,
  ) {
    this.classes = buildEffectiveAutomataClassManifest(policy);
  }

  static async hydrate(input: {
    companionId: string;
    policy: AutomataOwnerPolicy;
    store: AutomataRunStorePort;
    nowMs?: number;
  }): Promise<AutomataRunRegistry> {
    const companionId = requiredText(input.companionId, 'companionId');
    const registry = new AutomataRunRegistry(companionId, input.policy, input.store);
    const loaded = await input.store.loadRetained(companionId, input.nowMs ?? Date.now());
    for (const record of loaded) {
      if (record.companionId !== companionId) {
        throw new Error(`Automata store returned cross-companion run "${record.runId}".`);
      }
      requireAutomataClass(record.automatonClass);
      requireAutomataRunStatus(record.status);
      if (registry.runs.has(record.runId)) throw new Error(`Automata store returned duplicate run "${record.runId}".`);
      registry.runs.set(record.runId, cloneAutomataRun(record));
    }
    return registry;
  }

  listClasses(): EffectiveAutomataClassDescriptor[] {
    return this.classes.map(entry => ({ ...entry }));
  }

  async register(input: RegisterAutomataRunInput): Promise<AutomataRunRecord> {
    const runId = requiredText(input.runId, 'runId');
    if (this.runs.has(runId)) throw new Error(`Automata run "${runId}" already exists.`);
    const automatonClass = requireAutomataClass(input.automatonClass);
    const descriptor = this.classes.find(entry => entry.id === automatonClass);
    if (!descriptor) throw new Error(`Unknown automata class "${input.automatonClass}".`);
    const createdAtMs = input.createdAtMs ?? Date.now();
    if (!Number.isSafeInteger(createdAtMs) || createdAtMs < 0) throw new Error('Automata run createdAtMs is invalid');
    const workerGeneration = input.workerGeneration ?? 1;
    if (!Number.isSafeInteger(workerGeneration) || workerGeneration < 1) {
      throw new Error('Automata run workerGeneration must be a positive safe integer');
    }
    const record: AutomataRunRecord = {
      companionId: this.companionId,
      runId,
      automatonClass,
      workerId: requiredText(input.workerId, 'workerId'),
      workerGeneration,
      taskId: requiredText(input.taskId, 'taskId'),
      taskLabel: requiredText(input.taskLabel, 'taskLabel'),
      taskSummary: requiredText(input.taskSummary, 'taskSummary'),
      ...(input.parentRunId ? { parentRunId: requiredText(input.parentRunId, 'parentRunId') } : {}),
      ...(input.sourceRunId ? { sourceRunId: requiredText(input.sourceRunId, 'sourceRunId') } : {}),
      sessionIds: uniqueTexts(input.sessionIds ?? [], 'sessionIds'),
      artifacts: normalizeArtifacts(input.artifacts ?? []),
      status: 'queued',
      statusReason: 'execution_requested',
      promotionState: 'not_requested',
      foldState: 'not_required',
      createdAtMs,
      retentionDeadlineMs: createdAtMs + descriptor.retentionMs,
    };
    await this.store.insert(record);
    this.runs.set(runId, cloneAutomataRun(record));
    return cloneAutomataRun(record);
  }

  async transition(runId: string, input: TransitionAutomataRunInput): Promise<AutomataRunRecord> {
    const normalizedRunId = requiredText(runId, 'runId');
    const current = this.runs.get(normalizedRunId);
    if (!current) throw new Error(`Unknown automata run "${normalizedRunId}".`);
    const next = requireAutomataRunStatus(input.status);
    if (current.status === next && isTerminalStatus(next)) {
      const reason = requiredText(input.reason, 'statusReason');
      const failureReason = input.failureReason === undefined
        ? undefined
        : requiredText(input.failureReason, 'failureReason');
      if (
        current.statusReason === reason
        && current.outcome === input.outcome
        && current.failureReason === failureReason
      ) {
        return cloneAutomataRun(current);
      }
    }
    if (!ALLOWED_TRANSITIONS[current.status].includes(next)) {
      throw new Error(`Invalid automata run transition for ${normalizedRunId}: ${current.status} -> ${next}.`);
    }
    const atMs = input.atMs ?? Date.now();
    const updated: AutomataRunRecord = {
      ...cloneAutomataRun(current),
      status: next,
      statusReason: requiredText(input.reason, 'statusReason'),
      ...(next === 'running' ? { startedAtMs: atMs } : { finishedAtMs: atMs }),
      ...(input.outcome ? { outcome: input.outcome } : {}),
      ...(input.failureReason ? { failureReason: requiredText(input.failureReason, 'failureReason') } : {}),
    };
    await this.store.update(updated, current.status);
    this.runs.set(normalizedRunId, updated);
    return cloneAutomataRun(updated);
  }

  async linkArtifacts(
    runId: string,
    artifacts: readonly AutomataArtifactRef[],
  ): Promise<AutomataRunRecord> {
    const normalizedRunId = requiredText(runId, 'runId');
    const current = this.runs.get(normalizedRunId);
    if (!current) throw new Error(`Unknown automata run "${normalizedRunId}".`);
    const merged = mergeArtifacts(current.artifacts, normalizeArtifacts(artifacts));
    if (sameArtifacts(current.artifacts, merged)) return cloneAutomataRun(current);
    const updated = { ...cloneAutomataRun(current), artifacts: merged };
    await this.store.update(updated, current.status);
    this.runs.set(normalizedRunId, updated);
    return cloneAutomataRun(updated);
  }

  getRun(runId: string): AutomataRunRecord | null {
    const record = this.runs.get(runId);
    return record ? cloneAutomataRun(record) : null;
  }

  findByTask(taskId: string): AutomataRunRecord[] {
    const normalized = requiredText(taskId, 'taskId');
    return this.sortedRuns().filter(record => record.taskId === normalized);
  }

  findByTaskDescription(query: string, limit = this.policy.recentRunLimit): AutomataRunRecord[] {
    const normalized = requiredText(query, 'task query').toLowerCase();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.policy.operatorMutationLimit) {
      throw new Error(`Automata task discovery limit must be between 1 and ${this.policy.operatorMutationLimit}`);
    }
    return this.sortedRuns()
      .filter(record => [record.runId, record.workerId, record.taskId, record.taskLabel, record.taskSummary]
        .some(value => value.toLowerCase().includes(normalized)))
      .slice(0, limit);
  }

  listRuns(options: {
    status?: string;
    classId?: string;
    taskId?: string;
    limit?: number;
  } = {}): AutomataRunRecord[] {
    const status = options.status === undefined ? undefined : requireAutomataRunStatus(options.status);
    const classId: ProductionAutomataClassId | undefined = options.classId === undefined
      ? undefined
      : requireAutomataClass(options.classId);
    const taskId = options.taskId === undefined ? undefined : requiredText(options.taskId, 'taskId');
    const limit = options.limit ?? this.policy.recentRunLimit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.policy.operatorMutationLimit) {
      throw new Error(`Automata run list limit must be between 1 and ${this.policy.operatorMutationLimit}`);
    }
    return this.sortedRuns()
      .filter(record => status === undefined || record.status === status)
      .filter(record => classId === undefined || record.automatonClass === classId)
      .filter(record => taskId === undefined || record.taskId === taskId)
      .slice(0, limit);
  }

  /** Trusted runtime hydration view; operator bounds are applied by listRuns. */
  listRetainedRunsForRuntime(): AutomataRunRecord[] {
    return this.sortedRuns();
  }

  async close(): Promise<void> {
    await this.store.close?.();
  }

  private sortedRuns(): AutomataRunRecord[] {
    return [...this.runs.values()]
      .sort((left, right) => right.createdAtMs - left.createdAtMs || left.runId.localeCompare(right.runId))
      .map(cloneAutomataRun);
  }
}

function isTerminalStatus(status: AutomataRunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function normalizeArtifacts(artifacts: readonly AutomataArtifactRef[]): AutomataArtifactRef[] {
  const normalized = artifacts.map(artifact => {
    if (!['pending', 'durable', 'discarded'].includes(artifact.custody)) {
      throw new Error(`Automata run artifact custody "${String(artifact.custody)}" is invalid`);
    }
    return {
      kind: requiredText(artifact.kind, 'artifacts.kind'),
      ref: requiredText(artifact.ref, 'artifacts.ref'),
      custody: artifact.custody,
    };
  });
  if (new Set(normalized.map(artifact => `${artifact.kind}\0${artifact.ref}`)).size !== normalized.length) {
    throw new Error('Automata run artifacts must not contain duplicate kind/ref pairs');
  }
  return normalized;
}

function mergeArtifacts(
  existing: readonly AutomataArtifactRef[],
  added: readonly AutomataArtifactRef[],
): AutomataArtifactRef[] {
  const byReference = new Map(existing.map(artifact => [
    `${artifact.kind}\0${artifact.ref}`,
    { ...artifact },
  ]));
  for (const artifact of added) {
    byReference.set(`${artifact.kind}\0${artifact.ref}`, { ...artifact });
  }
  return [...byReference.values()];
}

function sameArtifacts(
  left: readonly AutomataArtifactRef[],
  right: readonly AutomataArtifactRef[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
