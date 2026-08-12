import type {
  BackgroundWorkAutomataLifecyclePort,
} from '../../core/agent/background-work/supervisor.js';
import type {
  BackgroundWorkPayload,
  ClaimedBackgroundWorkJob,
  StoredBackgroundWorkJob,
} from '../../core/agent/background-work/types.js';
import type {
  AutomataRunRecord,
  ProductionAutomataClassId,
} from '../../faculties/automata/registry-contract.js';
import type { AutomataRunRegistry } from '../../faculties/automata/run-registry.js';

interface MemoryExtractionRunBinding {
  runId: string;
  automatonClass: ProductionAutomataClassId;
  workerId: string;
  taskId: string;
  taskLabel: string;
  taskSummary: string;
  sessionIds: readonly string[];
  createdAtMs: number;
}

function uniqueSessionIds(payload: Extract<BackgroundWorkPayload, { kind: 'memory_extraction' }>): string[] {
  return [...new Set([payload.source.logicalSessionId, payload.source.channelId])];
}

function memoryExtractionBinding(
  job: ClaimedBackgroundWorkJob,
  payload: Extract<BackgroundWorkPayload, { kind: 'memory_extraction' }>,
): MemoryExtractionRunBinding {
  return {
    runId: payload.source.requestId,
    automatonClass: 'memory.extraction',
    workerId: `background-work:${job.jobId}`,
    taskId: payload.source.logicalSessionId,
    taskLabel: 'Memory extraction',
    taskSummary: 'Extract durable memory from a canonical source turn',
    sessionIds: uniqueSessionIds(payload),
    createdAtMs: job.createdAtMs,
  };
}

function assertExactBinding(record: AutomataRunRecord, expected: MemoryExtractionRunBinding): void {
  const sameSessions = record.sessionIds.length === expected.sessionIds.length
    && record.sessionIds.every((sessionId, index) => sessionId === expected.sessionIds[index]);
  if (
    record.runId !== expected.runId
    || record.automatonClass !== expected.automatonClass
    || record.workerId !== expected.workerId
    || record.taskId !== expected.taskId
    || record.taskLabel !== expected.taskLabel
    || record.taskSummary !== expected.taskSummary
    || record.createdAtMs !== expected.createdAtMs
    || !sameSessions
  ) {
    throw new Error(`Automata memory extraction run "${expected.runId}" conflicts with its background-work binding.`);
  }
}

async function ensureMemoryExtractionRun(
  registry: AutomataRunRegistry,
  job: ClaimedBackgroundWorkJob,
  payload: Extract<BackgroundWorkPayload, { kind: 'memory_extraction' }>,
): Promise<AutomataRunRecord> {
  const binding = memoryExtractionBinding(job, payload);
  const existing = registry.getRun(binding.runId);
  if (existing) {
    assertExactBinding(existing, binding);
    return existing;
  }
  return registry.register(binding);
}

async function startMemoryExtractionRun(
  registry: AutomataRunRegistry,
  job: ClaimedBackgroundWorkJob,
  payload: Extract<BackgroundWorkPayload, { kind: 'memory_extraction' }>,
): Promise<void> {
  const run = await ensureMemoryExtractionRun(registry, job, payload);
  if (run.status === 'queued') {
    await registry.transition(run.runId, {
      status: 'running',
      reason: 'background_work_claimed',
    });
    return;
  }
  if (run.status !== 'running' && run.status !== 'completed') {
    throw new Error(`Automata memory extraction run "${run.runId}" cannot resume from ${run.status}.`);
  }
}

async function completeMemoryExtractionRun(
  registry: AutomataRunRegistry,
  job: ClaimedBackgroundWorkJob,
  payload: Extract<BackgroundWorkPayload, { kind: 'memory_extraction' }>,
): Promise<void> {
  const run = await ensureMemoryExtractionRun(registry, job, payload);
  if (run.status === 'completed') return;
  if (run.status === 'queued') {
    await registry.transition(run.runId, {
      status: 'running',
      reason: 'background_work_claimed',
    });
  } else if (run.status !== 'running') {
    throw new Error(`Automata memory extraction run "${run.runId}" cannot complete from ${run.status}.`);
  }
  await registry.transition(run.runId, {
    status: 'completed',
    reason: 'background_work_completed',
    outcome: 'completed',
  });
}

async function failMemoryExtractionRun(
  registry: AutomataRunRegistry,
  job: ClaimedBackgroundWorkJob,
  payload: Extract<BackgroundWorkPayload, { kind: 'memory_extraction' }>,
  reasonCode: StoredBackgroundWorkJob['reasonCode'],
): Promise<void> {
  const run = await ensureMemoryExtractionRun(registry, job, payload);
  if (run.status === 'completed') return;
  if (run.status === 'failed') {
    if (run.statusReason !== 'background_work_failed' || run.failureReason !== reasonCode) {
      throw new Error(`Automata memory extraction run "${run.runId}" has a conflicting terminal failure.`);
    }
    return;
  }
  if (run.status !== 'queued' && run.status !== 'running') {
    throw new Error(`Automata memory extraction run "${run.runId}" cannot fail from ${run.status}.`);
  }
  await registry.transition(run.runId, {
    status: 'failed',
    reason: 'background_work_failed',
    outcome: 'blocked',
    failureReason: reasonCode,
  });
}

export function createBackgroundWorkAutomataLifecycle(
  registry: AutomataRunRegistry,
): BackgroundWorkAutomataLifecyclePort {
  return {
    async onClaimed({ job, payload }): Promise<void> {
      if (payload.kind !== 'memory_extraction') return;
      await startMemoryExtractionRun(registry, job, payload);
    },
    async onCompleted({ job, payload }): Promise<void> {
      if (payload.kind !== 'memory_extraction') return;
      await completeMemoryExtractionRun(registry, job, payload);
    },
    async onFailed({ job, payload, reasonCode }): Promise<void> {
      if (payload.kind !== 'memory_extraction') return;
      await failMemoryExtractionRun(registry, job, payload, reasonCode);
    },
  };
}
