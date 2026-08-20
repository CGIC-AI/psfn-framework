import type { AutomataRunRecord } from '../../automata/registry-contract.js';
import type { AutomataRunRegistry } from '../../automata/run-registry.js';
import type { ExtractionTriggerReason } from './types.js';

const MEMORY_EXTRACTION_WORKER_ID = 'memory-extraction';
const MEMORY_EXTRACTION_TASK_LABEL = 'Memory extraction';
const MEMORY_EXTRACTION_COMPLETED_REASON = 'memory_extraction_completed';
const MEMORY_EXTRACTION_FAILED_REASON = 'memory_extraction_failed';

export interface BeginMemoryExtractionAutomataRunInput {
  runId: string;
  taskId: string;
  sessionId: string;
  triggerReason: ExtractionTriggerReason;
  createdAtMs?: number;
}

export interface BeginMemoryExtractionAutomataRunResult {
  runId: string;
  execute: boolean;
}

function assertExactMemoryExtractionRun(
  run: AutomataRunRecord,
  input: BeginMemoryExtractionAutomataRunInput,
): void {
  if (
    run.automatonClass !== 'memory.extraction'
    || run.workerId !== MEMORY_EXTRACTION_WORKER_ID
    || run.taskId !== input.taskId
    || run.sessionIds.length !== 1
    || run.sessionIds[0] !== input.sessionId
  ) {
    throw new Error('Memory extraction Automata run lineage does not match the authoritative request');
  }
}

export async function beginMemoryExtractionAutomataRun(
  registry: AutomataRunRegistry,
  input: BeginMemoryExtractionAutomataRunInput,
): Promise<BeginMemoryExtractionAutomataRunResult> {
  let run = registry.getRun(input.runId);
  if (!run) {
    run = await registry.register({
      runId: input.runId,
      automatonClass: 'memory.extraction',
      workerId: MEMORY_EXTRACTION_WORKER_ID,
      taskId: input.taskId,
      taskLabel: MEMORY_EXTRACTION_TASK_LABEL,
      taskSummary: `Memory extraction triggered by ${input.triggerReason}`,
      sessionIds: [input.sessionId],
      ...(input.createdAtMs === undefined ? {} : { createdAtMs: input.createdAtMs }),
    });
  }
  assertExactMemoryExtractionRun(run, input);

  if (run.status === 'completed') {
    return { runId: run.runId, execute: false };
  }
  if (run.status === 'failed' || run.status === 'cancelled') {
    throw new Error(`Memory extraction Automata run is a terminal ${run.status} run`);
  }
  if (run.status === 'queued') {
    run = await registry.transition(run.runId, {
      status: 'running',
      reason: 'memory_extraction_started',
      ...(input.createdAtMs === undefined ? {} : { atMs: input.createdAtMs }),
    });
  }
  return { runId: run.runId, execute: true };
}

export async function completeMemoryExtractionAutomataRun(
  registry: AutomataRunRegistry,
  runId: string,
  atMs = Date.now(),
): Promise<void> {
  const run = registry.getRun(runId);
  if (!run) throw new Error('Memory extraction Automata run disappeared before completion');
  if (run.status === 'completed') return;
  if (run.status !== 'running') {
    throw new Error(`Memory extraction Automata run cannot complete from ${run.status}`);
  }
  await registry.transition(run.runId, {
    status: 'completed',
    reason: MEMORY_EXTRACTION_COMPLETED_REASON,
    outcome: 'completed',
    atMs,
  });
}

export async function failMemoryExtractionAutomataRun(
  registry: AutomataRunRegistry,
  runId: string,
  failureReason = 'orchestration_failure',
  atMs = Date.now(),
): Promise<void> {
  const run = registry.getRun(runId);
  if (!run) throw new Error('Memory extraction Automata run disappeared before failure recording');
  if (run.status === 'failed'
    && run.statusReason === MEMORY_EXTRACTION_FAILED_REASON
    && run.failureReason === failureReason) {
    return;
  }
  if (run.status !== 'queued' && run.status !== 'running') {
    throw new Error(`Memory extraction Automata run cannot fail from ${run.status}`);
  }
  await registry.transition(run.runId, {
    status: 'failed',
    reason: MEMORY_EXTRACTION_FAILED_REASON,
    outcome: 'blocked',
    failureReason,
    atMs,
  });
}
