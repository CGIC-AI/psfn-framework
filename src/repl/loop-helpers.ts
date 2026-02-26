import type { BudgetStatus, ThinkBudget, ThinkEvidence, ThinkResult, ThinkStep } from './types.js';

export interface StepBuilderInput {
  iteration: number;
  code: string;
  output: string;
  error: string | null;
  evidenceCollected: ThinkEvidence[];
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
  steps?: ThinkStep[];
  evidence?: ThinkEvidence[];
}

export function createBudgetStatus(): BudgetStatus {
  return {
    iterations: 0,
    totalTokens: 0,
    wallTimeMs: 0,
    subQueries: 0,
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
): void {
  status.wallTimeMs = Date.now() - startTime;
  status.subQueries = subQueries;
}

export function updateBudgetProgress(
  status: BudgetStatus,
  iteration: number,
  totalInputTokens: number,
  totalOutputTokens: number,
  startTime: number,
  subQueries: number,
): void {
  status.iterations = iteration;
  status.totalTokens = totalInputTokens + totalOutputTokens;
  updateBudgetRuntime(status, startTime, subQueries);
}

export function checkBudget(status: BudgetStatus, budget: ThinkBudget): void {
  if (status.iterations >= budget.maxIterations) {
    status.exceeded = 'max iterations';
  } else if (budget.maxTokens && status.totalTokens >= budget.maxTokens) {
    status.exceeded = 'token budget';
  } else if (budget.maxWallTimeMs && status.wallTimeMs >= budget.maxWallTimeMs) {
    status.exceeded = 'wall time';
  } else if (budget.maxSubQueries && status.subQueries >= budget.maxSubQueries) {
    status.exceeded = 'sub-query limit';
  }
}

export function buildStep(input: StepBuilderInput): ThinkStep {
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

export function flattenEvidence(steps: ThinkStep[]): ThinkEvidence[] {
  return steps.flatMap(step => step.evidenceCollected);
}

export function makeBudgetResult(input: BudgetResultInput): ThinkResult {
  return {
    answer: input.answer,
    iterations: input.iterations,
    totalInputTokens: input.totalInputTokens,
    totalOutputTokens: input.totalOutputTokens,
    durationMs: input.durationMs,
    truncated: input.truncated,
    budgetStatus: input.budgetStatus,
    steps: input.steps ?? [],
    evidence: input.evidence ?? [],
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
