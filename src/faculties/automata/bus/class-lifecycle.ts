import { toErrorMessage } from '../../../shared/utils/errors.js';
import type {
  AutomataArtifactRef,
  AutomataRunOutcome,
  ProductionAutomataClassId,
} from '../registry-contract.js';
import type { AutomataRunRegistry } from '../run-registry.js';
import type {
  AutomataTerminalLifecyclePort,
  AutomataWorkerLineage,
} from '../terminal-lifecycle.js';
import type { AutomataBusToolAction, AutomataBusWorkerAccess } from './worker-access-contracts.js';
import {
  openAutomataBusWorkerRun,
  type AutomataBusWorkerRun,
  type AutomataWorkerFailurePolicy,
  type AutomataWorkerLifecycleEvent,
  type AutomataWorkerRunBinding,
  type AutomataWorkerRunPort,
} from './worker-execution.js';

/**
 * Status reasons every governed class shares. They are lifecycle vocabulary,
 * not per-class tuning: the class identity already travels on the run record,
 * so a class-specific reason string would only make the durable history harder
 * to query without adding information.
 */
const RUN_STARTED_REASON = 'automata_run_started';
const RUN_COMPLETED_REASON = 'automata_run_completed';
const RUN_FAILED_REASON = 'automata_run_failed';
const RUN_CANCELLED_REASON = 'automata_run_cancelled';

/** Durable binding one governed class run claims in the authoritative registry. */
export interface AutomataClassRunSpec {
  automatonClass: ProductionAutomataClassId;
  runId: string;
  workerId: string;
  taskId: string;
  taskLabel: string;
  taskSummary: string;
  sessionIds?: readonly string[];
  parentRunId?: string;
  sourceRunId?: string;
  createdAtMs?: number;
}

function lineageFromSpec(
  spec: AutomataClassRunSpec,
  sessionIds: readonly string[],
): AutomataWorkerLineage {
  return {
    automatonClass: spec.automatonClass,
    runId: spec.runId,
    taskId: spec.taskId,
    workerId: spec.workerId,
    ...(spec.parentRunId ? { parentRunId: spec.parentRunId } : {}),
    ...(spec.sourceRunId ? { sourceRunId: spec.sourceRunId } : {}),
    sessionIds,
  };
}

/**
 * The class-agnostic durable run adapter.
 *
 * `begin` registers the run or proves that an existing run is the exact same
 * binding, so a restarted or redelivered worker re-enters its own run instead
 * of forking a new one. A run that is already terminal reports
 * `execute: false`, which is how the wrapper avoids duplicating a terminal
 * event after restart. `terminalize` tolerates an already-terminal run for the
 * same reason.
 *
 * Classes whose runs carry a class-specific adoption rule (memory extraction
 * adopts the background-work supervisor's run id) keep their own adapter; every
 * other governed class binds through this one.
 */
export function createAutomataClassRunPort(
  registry: AutomataRunRegistry,
  spec: AutomataClassRunSpec,
): AutomataWorkerRunPort {
  return {
    begin: async (): Promise<AutomataWorkerRunBinding> => {
      let run = await registry.ensureRun({
        runId: spec.runId,
        automatonClass: spec.automatonClass,
        workerId: spec.workerId,
        taskId: spec.taskId,
        taskLabel: spec.taskLabel,
        taskSummary: spec.taskSummary,
        sessionIds: spec.sessionIds ?? [],
        ...(spec.parentRunId ? { parentRunId: spec.parentRunId } : {}),
        ...(spec.sourceRunId ? { sourceRunId: spec.sourceRunId } : {}),
        ...(spec.createdAtMs === undefined ? {} : { createdAtMs: spec.createdAtMs }),
      });
      // A completed run is a replay: skip execution and terminalization so a
      // restart cannot duplicate a terminal event. A failed or cancelled run is
      // NOT a replay — silently reporting it as one would let a retried caller
      // report success without doing the work — so it fails closed. A class
      // whose trigger genuinely re-attempts binds the attempt into its own run
      // id and therefore opens a fresh run instead of reaching this.
      if (run.status === 'failed' || run.status === 'cancelled') {
        throw new Error(
          `Automata run "${spec.runId}" is already a terminal ${run.status} run `
          + `for class ${spec.automatonClass}.`,
        );
      }
      if (run.status === 'queued') {
        run = await registry.transition(run.runId, {
          status: 'running',
          reason: RUN_STARTED_REASON,
          ...(spec.createdAtMs === undefined ? {} : { atMs: spec.createdAtMs }),
        });
      }
      return {
        companionId: run.companionId,
        lineage: lineageFromSpec(spec, [...run.sessionIds]),
        attempt: run.workerGeneration,
        execute: run.status === 'running',
      };
    },
    terminalize: async request => {
      const run = registry.getRun(spec.runId);
      if (!run) throw new Error(`Automata run "${spec.runId}" disappeared before terminalization.`);
      if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') return;
      if (request.lifecycleState === 'completed') {
        await registry.transition(run.runId, {
          status: 'completed',
          reason: RUN_COMPLETED_REASON,
          outcome: request.outcome,
          atMs: request.atMs,
        });
        return;
      }
      await registry.transition(run.runId, {
        status: request.lifecycleState,
        reason: request.lifecycleState === 'cancelled' ? RUN_CANCELLED_REASON : RUN_FAILED_REASON,
        outcome: request.outcome,
        failureReason: request.failureReason ?? request.stateReason,
        atMs: request.atMs,
      });
    },
  };
}

/**
 * Composition-owned Bus runtime shared by every governed class. A deployment
 * without a durable Automata runtime supplies none of it, and governed classes
 * then execute their unchanged worker logic Bus-blind rather than failing.
 */
export interface AutomataClassLifecycleRuntime {
  registry: AutomataRunRegistry;
  workerAccess?: AutomataBusWorkerAccess | null;
  terminal?: AutomataTerminalLifecyclePort | null;
  telemetry?: (event: AutomataWorkerLifecycleEvent) => void;
  policy?: AutomataWorkerFailurePolicy;
}

/**
 * What one governed class's own worker logic reports back. `summary` is a
 * class-authored process line, never worker output or transcript text; its
 * presence is what makes an otherwise silent single-pass class leave a `useful`
 * terminal handoff instead of a typed no-finding one.
 */
export interface AutomataClassWorkResult<T> {
  value: T;
  summary?: string;
  outputRefs?: readonly AutomataArtifactRef[];
  resultKind?: 'final' | 'partial' | 'none';
  outcome?: AutomataRunOutcome;
  /**
   * Terminal lifecycle state for work that finished without doing its job — a
   * lane that never won its maintenance baton, for instance. Defaults to
   * `completed`; a thrown error settles `failed` instead.
   */
  lifecycleState?: 'completed' | 'cancelled';
}

export type AutomataClassWorkOutcome<T> =
  | { status: 'executed'; value: T }
  /** The durable run was already terminal; the worker logic did not re-run. */
  | { status: 'replayed' };

/**
 * Run one class's work inside the governed Bus lifecycle.
 *
 * Every governed class reaches the Bus through exactly this call, so all of
 * them share one begin/brief/tool/handoff/terminal ordering, one idempotent
 * terminal event, and one fail-closed briefing contract. The class keeps its
 * own worker logic; only run opening, tool formation, and settlement move here.
 */
export async function runGovernedAutomataClass<T>(input: {
  runtime?: AutomataClassLifecycleRuntime | null;
  spec: AutomataClassRunSpec;
  /** Owner-supplied bounded briefing query. Never model-supplied. */
  briefingQuery: string;
  allowedActions?: readonly AutomataBusToolAction[];
  work: (run: AutomataBusWorkerRun | null) => Promise<AutomataClassWorkResult<T>>;
}): Promise<AutomataClassWorkOutcome<T>> {
  const runtime = input.runtime;
  if (!runtime) {
    const result = await input.work(null);
    return { status: 'executed', value: result.value };
  }
  const session = await openAutomataBusWorkerRun({
    access: runtime.workerAccess ?? null,
    run: createAutomataClassRunPort(runtime.registry, input.spec),
    terminal: runtime.terminal ?? null,
    briefingQuery: input.briefingQuery,
    ...(input.allowedActions ? { allowedActions: input.allowedActions } : {}),
    ...(runtime.policy ? { policy: runtime.policy } : {}),
    ...(runtime.telemetry ? { telemetry: runtime.telemetry } : {}),
  });
  if (!session.binding.execute) {
    await session.settle({
      lifecycleState: 'completed',
      outcome: 'completed',
      stateReason: RUN_COMPLETED_REASON,
      resultKind: 'none',
    });
    return { status: 'replayed' };
  }
  let result: AutomataClassWorkResult<T>;
  try {
    result = await input.work(session);
  } catch (error) {
    const failureReason = toErrorMessage(error);
    try {
      await session.settle({
        lifecycleState: 'failed',
        outcome: 'blocked',
        stateReason: RUN_FAILED_REASON,
        failureReason,
        resultKind: 'none',
      });
    } catch (settleError) {
      // The work error is the one the caller has to see; a settlement that
      // also failed must not replace it (psfn-framework-8n40k). Report both,
      // with a composed message because loggers read `.message`, not `.errors`.
      throw new AggregateError(
        [error, settleError],
        `Automata class ${input.spec.automatonClass} work failed: ${failureReason}; `
        + `settlement also failed: ${toErrorMessage(settleError)}`,
      );
    }
    throw error;
  }
  const lifecycleState = result.lifecycleState ?? 'completed';
  await session.settle({
    lifecycleState,
    outcome: result.outcome ?? 'completed',
    stateReason: lifecycleState === 'cancelled' ? RUN_CANCELLED_REASON : RUN_COMPLETED_REASON,
    resultKind: result.resultKind ?? 'final',
    ...(result.summary === undefined ? {} : { summary: result.summary }),
    ...(result.outputRefs ? { outputRefs: result.outputRefs } : {}),
  });
  return { status: 'executed', value: result.value };
}
