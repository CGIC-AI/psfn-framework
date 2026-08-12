import { createHash } from 'node:crypto';

import type { AutomataArtifactRef } from '../automata/registry-contract.js';

export interface SubagentAutomataLineage {
  runId: string;
  taskId: string;
  workerId: string;
  parentRunId?: string;
  sourceRunId?: string;
  sessionIds: readonly string[];
}

interface SubagentTerminalUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  turns: number;
}

/**
 * Trusted terminal metadata handed to the durable Automata Bus adapter.
 *
 * Deliberately absent: worker output, transcript entries, prompts, tool calls,
 * and reasoning. The Bus receives only lineage, outcome/accounting metadata,
 * and references to separately governed work products.
 */
export interface RecordSubagentTerminalHandoffInput {
  idempotencyKey: string;
  lineage: SubagentAutomataLineage;
  lifecycleState: 'completed' | 'failed' | 'cancelled';
  outcome: 'completed' | 'blocked' | 'cancelled' | 'budget_limited';
  stateReason: string;
  failureReason?: string;
  resultKind: 'final' | 'partial' | 'none';
  usage: SubagentTerminalUsage;
  outputRefs: readonly AutomataArtifactRef[];
  parentHandoffRef?: string;
  occurredAtMs: number;
}

export interface SubagentAutomataTerminalReceipt {
  /** Stable durable Bus handoff/event reference. */
  handoffRef: string;
  /** False on an exact idempotent replay of an already-recorded terminal. */
  inserted: boolean;
  findingRefs: readonly string[];
  evidenceRefs: readonly string[];
  artifactRefs: readonly AutomataArtifactRef[];
}

export interface SubagentAutomataRunInspection {
  runId: string;
  taskId: string;
  sessionIds: readonly string[];
  findingRefs: readonly string[];
  evidenceRefs: readonly string[];
  artifactRefs: readonly AutomataArtifactRef[];
  handoffRefs: readonly string[];
}

/** Narrow composition port implemented by the durable Bus/run adapter. */
export interface SubagentAutomataLifecyclePort {
  recordTerminalHandoff(
    input: RecordSubagentTerminalHandoffInput,
  ): Promise<SubagentAutomataTerminalReceipt>;
  inspectRun(input: SubagentAutomataLineage): Promise<SubagentAutomataRunInspection>;
}

export type SubagentAutomataLifecycleDelivery =
  | {
      status: 'recorded';
      idempotencyKey: string;
      handoffRef: string;
      replay: boolean;
      findingRefs: string[];
      evidenceRefs: string[];
      artifactRefs: AutomataArtifactRef[];
    }
  | {
      status: 'failed';
      idempotencyKey: string;
      error: string;
    }
  | {
      status: 'not_configured';
    };

/** Stable across processes and retries for one run's one terminal outcome. */
export function buildSubagentTerminalHandoffKey(
  runId: string,
): string {
  return createHash('sha256')
    .update(`subagent-terminal-v1\0${runId.trim()}`)
    .digest('hex');
}
