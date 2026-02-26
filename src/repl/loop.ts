// ── RLM Iteration Loop ──
// Runs an ephemeral think cycle: LLM → code → output → repeat until FINAL.

import type { ContextMessage, LLMResponse } from '../types.js';
import type {
  BudgetStatus,
  REPLDeps,
  ThinkBudget,
  ThinkResult,
  ThinkStep,
} from './types.js';
import { REPLSandbox } from './sandbox.js';
import type { SandboxBudgetRef } from './sandbox.js';
import { buildRLMSystemPrompt } from './prompt.js';
import type { ThinkContextMetadata } from './prompt.js';
import { parseResponse } from './parse.js';
import {
  buildStep,
  checkBudget,
  createBudgetStatus,
  flattenEvidence,
  formatExecutionFeedback,
  makeBudgetResult,
  updateBudgetProgress,
  updateBudgetRuntime,
} from './loop-helpers.js';

const LLM_TIMEOUT_BUFFER_MS = 25;
const LLM_TIMEOUT_REASON = 'llm timeout';
const LLM_TIMEOUT_ANSWER = '[Think loop timed out waiting for LLM response]';

class LLMIterationTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`LLM iteration timed out after ${timeoutMs}ms`);
    this.name = 'LLMIterationTimeoutError';
  }
}

function getRemainingWallTimeMs(startTime: number, budget: ThinkBudget): number | null {
  if (!budget.maxWallTimeMs) return null;
  return budget.maxWallTimeMs - (Date.now() - startTime);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) {
    throw new LLMIterationTimeoutError(timeoutMs);
  }

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new LLMIterationTimeoutError(timeoutMs)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

interface BuildResultOptions {
  answer: string;
  iterations: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  startTime: number;
  truncated: boolean;
  budgetStatus: BudgetStatus;
  steps: ThinkStep[];
}

function buildThinkResult(options: BuildResultOptions): ThinkResult {
  const allEvidence = flattenEvidence(options.steps);
  return makeBudgetResult(
    {
      answer: options.answer,
      iterations: options.iterations,
      totalInputTokens: options.totalInputTokens,
      totalOutputTokens: options.totalOutputTokens,
      durationMs: Date.now() - options.startTime,
      truncated: options.truncated,
      budgetStatus: options.budgetStatus,
      steps: options.steps,
      evidence: allEvidence,
    },
  );
}

function pushPassiveStep(
  steps: ThinkStep[],
  iteration: number,
  response: LLMResponse,
  cumulativeTokens: number,
  iterationStart: number,
  output = '',
): void {
  steps.push(buildStep({
    iteration,
    code: '',
    output,
    error: null,
    evidenceCollected: [],
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
    cumulativeTokens,
    durationMs: Date.now() - iterationStart,
    variablesChanged: [],
  }));
}

export async function runRLMLoop(task: string, deps: REPLDeps): Promise<ThinkResult> {
  const startTime = Date.now();
  const { config, llmProvider } = deps;
  const budget = config.budget;

  // Budget tracking
  const budgetStatus = createBudgetStatus();

  // Shared budget ref for sandbox llm_query tracking
  const budgetRef: SandboxBudgetRef = {
    subQueries: 0,
    maxSubQueries: budget.maxSubQueries ?? 20,
  };

  const steps: ThinkStep[] = [];

  const sandbox = new REPLSandbox({
    llmProvider,
    embeddingService: deps.embeddingService,
    memoryStore: deps.memoryStore,
    sessionManager: deps.sessionManager,
    scheduler: deps.scheduler,
    eventBus: deps.eventBus,
    getCapabilityTier: deps.getCapabilityTier,
    moduleInstallConfirmationQueue: deps.moduleInstallConfirmationQueue,
    onModuleRegistryMutation: deps.onModuleRegistryMutation,
  }, budgetRef);

  // Gather context metadata for system prompt
  const stats = deps.memoryStore?.getStats();
  const metadata: ThinkContextMetadata = {
    memoryCount: stats?.total ?? 0,
    memoryBreakdown: stats
      ? Object.entries(stats.byType)
        .filter(([, n]) => (n as number) > 0)
        .map(([type, n]) => `${n} ${type}`)
        .join(', ')
      : 'none',
    channelCount: 0,
    currentChannelMessages: 0,
  };

  const systemPrompt = buildRLMSystemPrompt(metadata);

  const messages: ContextMessage[] = [
    { role: 'user', content: task },
  ];

  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (let i = 0; i < budget.maxIterations; i++) {
    const iterationStart = Date.now();
    const remainingBeforeLLM = getRemainingWallTimeMs(startTime, budget);
    if (remainingBeforeLLM !== null && remainingBeforeLLM <= 0) {
      updateBudgetRuntime(budgetStatus, startTime, budgetRef.subQueries);
      budgetStatus.exceeded = 'wall time';
      break;
    }

    let response: LLMResponse;
    try {
      const timeoutMs = remainingBeforeLLM === null
        ? null
        : Math.floor(remainingBeforeLLM - LLM_TIMEOUT_BUFFER_MS);
      if (timeoutMs !== null && timeoutMs <= 0) {
        updateBudgetRuntime(budgetStatus, startTime, budgetRef.subQueries);
        budgetStatus.exceeded = 'wall time';
        break;
      }

      const completion = llmProvider.complete(
        { systemPrompt, messages },
        'reasoning',
      );
      response = timeoutMs === null
        ? await completion
        : await withTimeout(completion, timeoutMs);
    } catch (error) {
      updateBudgetRuntime(budgetStatus, startTime, budgetRef.subQueries);
      if (error instanceof LLMIterationTimeoutError) {
        budgetStatus.exceeded = LLM_TIMEOUT_REASON;
        break;
      }
      throw error;
    }

    totalInputTokens += response.inputTokens;
    totalOutputTokens += response.outputTokens;

    // Update budget status
    updateBudgetProgress(
      budgetStatus,
      i + 1,
      totalInputTokens,
      totalOutputTokens,
      startTime,
      budgetRef.subQueries,
    );

    const text = response.content;
    messages.push({ role: 'assistant', content: text });

    const action = parseResponse(text);

    switch (action.type) {
      case 'final': {
        pushPassiveStep(
          steps,
          i + 1,
          response,
          budgetStatus.totalTokens,
          iterationStart,
          action.answer,
        );
        return buildThinkResult({
          answer: action.answer,
          iterations: i + 1,
          totalInputTokens,
          totalOutputTokens,
          startTime,
          truncated: false,
          budgetStatus,
          steps,
        });
      }

      case 'final_var': {
        const locals = sandbox.getLocals();
        const value = locals[action.varName];
        const answer = value !== undefined ? String(value) : `[Variable "${action.varName}" not found]`;
        pushPassiveStep(
          steps,
          i + 1,
          response,
          budgetStatus.totalTokens,
          iterationStart,
          answer,
        );
        return buildThinkResult({
          answer,
          iterations: i + 1,
          totalInputTokens,
          totalOutputTokens,
          startTime,
          truncated: false,
          budgetStatus,
          steps,
        });
      }

      case 'code': {
        const result = await sandbox.execute(action.code, config.executionTimeoutMs, config.outputTruncation);
        const stepEvidence = sandbox.collectEvidence();
        const stepTokens = response.inputTokens + response.outputTokens;

        const step = buildStep({
          iteration: i + 1,
          code: action.code,
          output: result.output,
          error: result.error,
          evidenceCollected: stepEvidence,
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
          cumulativeTokens: budgetStatus.totalTokens,
          durationMs: Date.now() - iterationStart,
          variablesChanged: result.variablesChanged,
        });
        steps.push(step);

        if (result.finalAnswer !== null) {
          return buildThinkResult({
            answer: result.finalAnswer,
            iterations: i + 1,
            totalInputTokens,
            totalOutputTokens,
            startTime,
            truncated: false,
            budgetStatus,
            steps,
          });
        }

        const feedback = formatExecutionFeedback(
          result.output,
          result.error,
          i + 1,
          stepTokens,
          result.variablesChanged,
        );

        messages.push({ role: 'user', content: feedback });
        break;
      }

      case 'none':
        {
        pushPassiveStep(steps, i + 1, response, budgetStatus.totalTokens, iterationStart);
        messages.push({
          role: 'user',
          content: 'Please write a ```repl code block to execute, or call FINAL("your answer") when done.',
        });
        break;
        }
    }

    // Check budget after each iteration
    updateBudgetRuntime(budgetStatus, startTime, budgetRef.subQueries);
    checkBudget(budgetStatus, budget);
    if (budgetStatus.exceeded) break;
  }

  // Budget or max iterations exhausted
  const lastAssistant = messages.filter(m => m.role === 'assistant').pop();
  updateBudgetRuntime(budgetStatus, startTime, budgetRef.subQueries);
  if (!budgetStatus.exceeded) {
    budgetStatus.exceeded = 'max iterations';
  }
  const timeoutFallback = budgetStatus.exceeded === LLM_TIMEOUT_REASON
    ? LLM_TIMEOUT_ANSWER
    : '[No response generated]';
  return buildThinkResult({
    answer: lastAssistant?.content ?? timeoutFallback,
    iterations: budgetStatus.iterations,
    totalInputTokens,
    totalOutputTokens,
    startTime,
    truncated: true,
    budgetStatus,
    steps,
  });
}
