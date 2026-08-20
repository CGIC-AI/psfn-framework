import {
  createEmptyAnalysisWorkbenchDiagnostics,
  type BudgetStatus,
  type AnalysisWorkbenchBudget,
  type AnalysisWorkbenchDiagnostics,
  type AnalysisWorkbenchEvidence,
  type AnalysisWorkbenchLimitPolicy,
  type AnalysisWorkbenchResult,
  type AnalysisWorkbenchStep,
} from './types.js';
import { combineAbortSignal } from '../../../shared/utils/abort-signal.js';
import { abortError } from '../../../shared/utils/errors.js';

export interface StepBuilderInput {
  iteration: number;
  code: string;
  output: string;
  error: string | null;
  evidenceCollected: AnalysisWorkbenchEvidence[];
  inputTokens: number;
  outputTokens: number;
  cumulativeTokens: number;
  durationMs: number;
  variablesChanged: string[];
}

export interface BudgetResultInput {
  answer: string;
  iterations: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  durationMs: number;
  truncated: boolean;
  budgetStatus: BudgetStatus;
  limitPolicy: AnalysisWorkbenchLimitPolicy;
  steps?: AnalysisWorkbenchStep[];
  evidence?: AnalysisWorkbenchEvidence[];
  diagnostics?: AnalysisWorkbenchDiagnostics;
}

export interface AnalysisWorkerRequestMetadata {
  workloadType?: string;
  subagentId?: string;
  shardId?: string;
}

export function isBoundedAnalysisWorkerRequest(
  metadata: AnalysisWorkerRequestMetadata,
): boolean {
  return metadata.workloadType === 'subagent'
    || metadata.workloadType === 'shard'
    || Boolean(metadata.subagentId)
    || Boolean(metadata.shardId);
}

/**
 * Settle the local caller promptly when a parent or deadline aborts, while
 * forwarding the composed signal to the operation. A split transport may only
 * stop its local RPC wait unless that transport implements remote cancellation.
 */
export async function runAbortableAnalysisOperation<T>(options: {
  timeoutMs: number | null;
  parentSignals: Array<AbortSignal | undefined>;
  createTimeoutReason: (timeoutMs: number) => unknown;
  run: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  if (options.timeoutMs !== null && options.timeoutMs <= 0) {
    throw options.createTimeoutReason(options.timeoutMs);
  }

  const deadlineController = new AbortController();
  const signal = options.parentSignals.reduce<AbortSignal>(
    (combined, parentSignal) =>
      combineAbortSignal(parentSignal, combined) ?? combined,
    deadlineController.signal,
  );
  if (signal.aborted) {
    throw signal.reason ?? abortError(undefined, 'Analysis Workbench completion aborted');
  }

  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const rejectOnAbort = (): void => {
    rejectAbort(
      signal.reason
      ?? abortError(undefined, 'Analysis Workbench completion aborted'),
    );
  };
  signal.addEventListener('abort', rejectOnAbort, { once: true });

  const timeoutMs = options.timeoutMs;
  let timer: NodeJS.Timeout | undefined;
  if (timeoutMs !== null) {
    timer = setTimeout(() => {
      if (!deadlineController.signal.aborted) {
        deadlineController.abort(options.createTimeoutReason(timeoutMs));
      }
    }, timeoutMs);
    timer.unref();
  }

  const operation = Promise.resolve().then(() => options.run(signal));
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener('abort', rejectOnAbort);
  }
}

export function createBudgetStatus(): BudgetStatus {
  return {
    iterations: 0,
    totalTokens: 0,
    wallTimeMs: 0,
    subQueries: 0,
    toolCalls: 0,
    sessionCostUsd: 0,
    dayCostUsd: 0,
    warnings: [],
    exceeded: null,
  };
}

export function updateBudgetRuntime(
  status: BudgetStatus,
  startTime: number,
  subQueries: number,
  toolCalls = 0,
): void {
  status.wallTimeMs = Date.now() - startTime;
  status.subQueries = subQueries;
  status.toolCalls = toolCalls;
}

export function updateBudgetProgress(
  status: BudgetStatus,
  iteration: number,
  totalInputTokens: number,
  totalOutputTokens: number,
  startTime: number,
  subQueries: number,
  toolCalls = 0,
): void {
  status.iterations = iteration;
  status.totalTokens = totalInputTokens + totalOutputTokens;
  updateBudgetRuntime(status, startTime, subQueries, toolCalls);
}

export function checkBudget(status: BudgetStatus, budget: AnalysisWorkbenchBudget): void {
  if (status.iterations >= budget.maxIterations) {
    status.exceeded = 'max iterations';
  } else if (budget.maxTokens && status.totalTokens >= budget.maxTokens) {
    status.exceeded = 'token budget';
  } else if (budget.maxWallTimeMs && status.wallTimeMs >= budget.maxWallTimeMs) {
    status.exceeded = 'wall time';
  } else if (budget.maxSubQueries && status.subQueries >= budget.maxSubQueries) {
    status.exceeded = 'sub-query limit';
  } else if (budget.maxToolCalls && status.toolCalls >= budget.maxToolCalls) {
    status.exceeded = 'tool-call limit';
  }
}

export function buildStep(input: StepBuilderInput): AnalysisWorkbenchStep {
  const stepTokens = input.inputTokens + input.outputTokens;
  return {
    iteration: input.iteration,
    timestamp: Date.now(),
    code: input.code,
    output: input.output,
    error: input.error,
    evidenceCollected: input.evidenceCollected,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    tokensUsed: stepTokens,
    cumulativeTokens: input.cumulativeTokens,
    durationMs: input.durationMs,
    variablesChanged: input.variablesChanged,
  };
}

export function flattenEvidence(steps: AnalysisWorkbenchStep[]): AnalysisWorkbenchEvidence[] {
  return steps.flatMap(step => step.evidenceCollected);
}

export function makeBudgetResult(input: BudgetResultInput): AnalysisWorkbenchResult {
  return {
    answer: input.answer,
    outcome: input.truncated ? 'limit_reached' : 'completed',
    continuation: input.truncated ? 'restart_required' : 'not_needed',
    limitPolicy: input.limitPolicy,
    iterations: input.iterations,
    totalInputTokens: input.totalInputTokens,
    totalOutputTokens: input.totalOutputTokens,
    durationMs: input.durationMs,
    truncated: input.truncated,
    budgetStatus: input.budgetStatus,
    steps: input.steps ?? [],
    evidence: input.evidence ?? [],
    diagnostics: input.diagnostics ?? createEmptyAnalysisWorkbenchDiagnostics(),
  };
}

export function formatExecutionFeedback(
  output: string,
  error: string | null,
  iteration: number,
  stepTokens: number,
  variablesChanged: string[],
): string {
  let feedback = '';
  if (output) {
    feedback += output;
  }
  if (error) {
    feedback += (feedback ? '\n' : '') + `Error: ${error}`;
  }
  if (!feedback) {
    feedback = '[No output]';
  }

  if (variablesChanged.length > 0) {
    feedback += `\n[Iteration ${iteration} | ${stepTokens} tokens | vars changed: ${variablesChanged.join(', ')}]`;
  }

  return feedback;
}
