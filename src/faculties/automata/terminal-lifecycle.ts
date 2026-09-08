import { createHash } from 'node:crypto';

import type {
  AutomataArtifactRef,
  AutomataRunOutcome,
  ProductionAutomataClassId,
} from './registry-contract.js';

/**
 * Bus `source` value carried by an authoritative run-terminal event that reports
 * real worker output or an observed Bus write.
 */
export const AUTOMATA_TERMINAL_HANDOFF_SOURCE = 'automata-terminal-handoff';

/**
 * Bus `source` value carried by an authoritative run-terminal event for a run
 * that produced no Bus finding. The event is still deterministic and complete;
 * the distinct source makes "the worker learned nothing" queryable instead of
 * indistinguishable from silence.
 */
export const AUTOMATA_TERMINAL_NO_FINDING_SOURCE = 'automata-terminal-no-finding';

export const AUTOMATA_TERMINAL_HANDOFF_SOURCES: readonly string[] = [
  AUTOMATA_TERMINAL_HANDOFF_SOURCE,
  AUTOMATA_TERMINAL_NO_FINDING_SOURCE,
];

/** Authoritative durable lineage for one automata run of one worker class. */
export interface AutomataWorkerLineage {
  automatonClass: ProductionAutomataClassId;
  runId: string;
  taskId: string;
  workerId: string;
  parentRunId?: string;
  sourceRunId?: string;
  sessionIds: readonly string[];
}

export interface AutomataWorkerTerminalUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  turns: number;
}

/**
 * `useful` when the run left a Bus finding or a class-authored summary;
 * `no_finding` when it did not. Both record a complete terminal event.
 */
export type AutomataTerminalHandoffKind = 'useful' | 'no_finding';

/**
 * Trusted terminal metadata handed to the durable Automata Bus adapter.
 *
 * Deliberately absent: worker output, transcript entries, prompts, tool calls,
 * and reasoning. The Bus receives only lineage, outcome/accounting metadata,
 * and references to separately governed work products.
 */
export interface RecordAutomataTerminalHandoffInput {
  idempotencyKey: string;
  lineage: AutomataWorkerLineage;
  lifecycleState: 'completed' | 'failed' | 'cancelled';
  outcome: AutomataRunOutcome;
  stateReason: string;
  failureReason?: string;
  resultKind: 'final' | 'partial' | 'none';
  handoffKind: AutomataTerminalHandoffKind;
  /** Class-authored process summary. Never worker output or transcript text. */
  summary?: string;
  usage?: AutomataWorkerTerminalUsage;
  outputRefs: readonly AutomataArtifactRef[];
  parentHandoffRef?: string;
  occurredAtMs: number;
}

/**
 * Terminal facts read back OUT of an already-persisted handoff (8n40k). A run
 * that crashed between its Bus handoff and its registry terminalization replays
 * with freshly computed work; these are the durable facts the Bus already
 * recorded, so the registry converges on them instead of on the re-run.
 */
export interface PersistedAutomataTerminalOutcome {
  lifecycleState: 'completed' | 'failed' | 'cancelled';
  outcome: AutomataRunOutcome;
  stateReason: string;
  failureReason?: string;
}

export interface AutomataTerminalHandoffReceipt {
  /** Stable durable Bus handoff/event reference. */
  handoffRef: string;
  /** False on an exact idempotent replay of an already-recorded terminal. */
  inserted: boolean;
  findingRefs: readonly string[];
  evidenceRefs: readonly string[];
  artifactRefs: readonly AutomataArtifactRef[];
  /** When the durable terminal was actually recorded. Replays only. */
  occurredAtMs?: number;
  /** The durable terminal facts. Replays only. */
  persistedOutcome?: PersistedAutomataTerminalOutcome;
}

export interface AutomataWorkerRunInspection {
  runId: string;
  taskId: string;
  sessionIds: readonly string[];
  findingRefs: readonly string[];
  evidenceRefs: readonly string[];
  artifactRefs: readonly AutomataArtifactRef[];
  handoffRefs: readonly string[];
}

/** Narrow composition port implemented by the durable Bus/run adapter. */
export interface AutomataTerminalLifecyclePort {
  recordTerminalHandoff(
    input: RecordAutomataTerminalHandoffInput,
  ): Promise<AutomataTerminalHandoffReceipt>;
  inspectRun(input: AutomataWorkerLineage): Promise<AutomataWorkerRunInspection>;
}

export type AutomataTerminalLifecycleDelivery =
  | {
      status: 'recorded';
      idempotencyKey: string;
      handoffRef: string;
      replay: boolean;
      findingRefs: string[];
      evidenceRefs: string[];
      artifactRefs: AutomataArtifactRef[];
      /** Durable terminal facts and time, present only on a replay hit. */
      occurredAtMs?: number;
      persistedOutcome?: PersistedAutomataTerminalOutcome;
    }
  | {
      status: 'failed';
      idempotencyKey: string;
      error: string;
    }
  | {
      status: 'not_configured';
    };

/**
 * Stable across processes and retries for one class's one run attempt.
 *
 * Binding the key to class and worker generation as well as the run id keeps a
 * restarted or retried worker from either duplicating a terminal event or
 * colliding with another class that reused the same run identifier.
 */
export function buildAutomataTerminalHandoffKey(input: {
  automatonClass: ProductionAutomataClassId;
  runId: string;
  attempt: number;
}): string {
  const runId = input.runId.trim();
  if (!runId) throw new Error('Automata terminal handoff key requires a non-empty runId');
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) {
    throw new Error('Automata terminal handoff key attempt must be a positive safe integer');
  }
  return createHash('sha256')
    .update(`automata-terminal-v2\0${input.automatonClass}\0${runId}\0${input.attempt}`)
    .digest('hex');
}
