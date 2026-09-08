import type {
  BackgroundWorkAutomataLifecyclePort,
} from '../../core/agent/background-work/supervisor.js';
import type {
  BackgroundWorkPayload,
  ClaimedBackgroundWorkJob,
  StoredBackgroundWorkJob,
} from '../../core/agent/background-work/types.js';
import type { AutomataRunRecord } from '../../faculties/automata/registry-contract.js';
import type {
  AutomataRunRegistry,
  RegisterAutomataRunInput,
} from '../../faculties/automata/run-registry.js';

type MemoryExtractionPayload = Extract<BackgroundWorkPayload, { kind: 'memory_extraction' }>;

const MEMORY_EXTRACTION_TASK_LABEL = 'Memory extraction';
const MEMORY_EXTRACTION_TASK_SUMMARY = 'Extract durable memory from a canonical source turn';

function memoryExtractionBinding(
  job: ClaimedBackgroundWorkJob,
  payload: MemoryExtractionPayload,
): RegisterAutomataRunInput {
  return {
    runId: payload.source.requestId,
    automatonClass: 'memory.extraction',
    workerId: `background-work:${job.jobId}`,
    taskId: payload.source.logicalSessionId,
    taskLabel: MEMORY_EXTRACTION_TASK_LABEL,
    taskSummary: MEMORY_EXTRACTION_TASK_SUMMARY,
    sessionIds: [...new Set([payload.source.logicalSessionId, payload.source.channelId])],
    createdAtMs: job.createdAtMs,
  };
}

async function ensureMemoryExtractionRun(
  registry: AutomataRunRegistry,
  job: ClaimedBackgroundWorkJob,
  payload: MemoryExtractionPayload,
): Promise<AutomataRunRecord> {
  return await registry.ensureRun(memoryExtractionBinding(job, payload));
}

async function startMemoryExtractionRun(
  registry: AutomataRunRegistry,
  job: ClaimedBackgroundWorkJob,
  payload: MemoryExtractionPayload,
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

/**
 * The governed extraction lifecycle terminalizes its own run, so the supervisor
 * only closes a run the worker never reached. An already-terminal run is
 * accepted as-is: re-recording it would duplicate a terminal outcome.
 */
async function terminalizeMemoryExtractionRun(
  registry: AutomataRunRegistry,
  job: ClaimedBackgroundWorkJob,
  payload: MemoryExtractionPayload,
  terminal:
    | { status: 'completed' }
    | { status: 'failed'; reasonCode: StoredBackgroundWorkJob['reasonCode'] },
): Promise<void> {
  const run = await ensureMemoryExtractionRun(registry, job, payload);
  if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') return;
  if (run.status === 'queued') {
    await registry.transition(run.runId, {
      status: 'running',
      reason: 'background_work_claimed',
    });
  }
  await registry.transition(run.runId, terminal.status === 'completed'
    ? {
        status: 'completed',
        reason: 'background_work_completed',
        outcome: 'completed',
      }
    : {
        status: 'failed',
        reason: 'background_work_failed',
        outcome: 'blocked',
        failureReason: terminal.reasonCode,
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
      await terminalizeMemoryExtractionRun(registry, job, payload, { status: 'completed' });
    },
    async onFailed({ job, payload, reasonCode }): Promise<void> {
      if (payload.kind !== 'memory_extraction') return;
      await terminalizeMemoryExtractionRun(registry, job, payload, { status: 'failed', reasonCode });
    },
  };
}
