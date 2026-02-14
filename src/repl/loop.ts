// ── RLM Iteration Loop ──
// Runs an ephemeral think cycle: LLM → code → output → repeat until FINAL.

import type { ContextMessage } from '../types.js';
import type { REPLDeps, ThinkResult, BudgetStatus, ThinkBudget } from './types.js';
import { REPLSandbox } from './sandbox.js';
import type { SandboxBudgetRef } from './sandbox.js';
import { buildRLMSystemPrompt } from './prompt.js';
import type { ThinkContextMetadata } from './prompt.js';
import { parseResponse } from './parse.js';

function checkBudget(status: BudgetStatus, budget: ThinkBudget): void {
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

function makeBudgetResult(
  answer: string,
  iterations: number,
  totalInputTokens: number,
  totalOutputTokens: number,
  durationMs: number,
  truncated: boolean,
  budgetStatus: BudgetStatus,
): ThinkResult {
  return { answer, iterations, totalInputTokens, totalOutputTokens, durationMs, truncated, budgetStatus };
}

export async function runRLMLoop(task: string, deps: REPLDeps): Promise<ThinkResult> {
  const startTime = Date.now();
  const { config, llmProvider } = deps;
  const budget = config.budget;

  // Budget tracking
  const budgetStatus: BudgetStatus = {
    iterations: 0,
    totalTokens: 0,
    wallTimeMs: 0,
    subQueries: 0,
    exceeded: null,
  };

  // Shared budget ref for sandbox llm_query tracking
  const budgetRef: SandboxBudgetRef = {
    subQueries: 0,
    maxSubQueries: budget.maxSubQueries ?? 20,
  };

  const sandbox = new REPLSandbox({
    llmProvider,
    embeddingService: deps.embeddingService,
    memoryStore: deps.memoryStore,
    sessionManager: deps.sessionManager,
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
    const response = await llmProvider.complete(
      { systemPrompt, messages },
      'extraction',
    );

    totalInputTokens += response.inputTokens;
    totalOutputTokens += response.outputTokens;

    // Update budget status
    budgetStatus.iterations = i + 1;
    budgetStatus.totalTokens = totalInputTokens + totalOutputTokens;
    budgetStatus.wallTimeMs = Date.now() - startTime;
    budgetStatus.subQueries = budgetRef.subQueries;

    const text = response.content;
    messages.push({ role: 'assistant', content: text });

    const action = parseResponse(text);

    switch (action.type) {
      case 'final':
        return makeBudgetResult(
          action.answer, i + 1, totalInputTokens, totalOutputTokens,
          Date.now() - startTime, false, budgetStatus,
        );

      case 'final_var': {
        const locals = sandbox.getLocals();
        const value = locals[action.varName];
        const answer = value !== undefined ? String(value) : `[Variable "${action.varName}" not found]`;
        return makeBudgetResult(
          answer, i + 1, totalInputTokens, totalOutputTokens,
          Date.now() - startTime, false, budgetStatus,
        );
      }

      case 'code': {
        const result = await sandbox.execute(action.code, config.executionTimeoutMs, config.outputTruncation);

        if (result.finalAnswer !== null) {
          return makeBudgetResult(
            result.finalAnswer, i + 1, totalInputTokens, totalOutputTokens,
            Date.now() - startTime, false, budgetStatus,
          );
        }

        // Format execution output for the LLM
        let feedback = '';
        if (result.output) feedback += result.output;
        if (result.error) feedback += (feedback ? '\n' : '') + `Error: ${result.error}`;
        if (!feedback) feedback = '[No output]';

        // Append variable change info if any
        if (result.variablesChanged.length > 0) {
          feedback += `\nVariables changed: ${result.variablesChanged.join(', ')}`;
        }

        messages.push({ role: 'user', content: feedback });
        break;
      }

      case 'none':
        messages.push({
          role: 'user',
          content: 'Please write a ```repl code block to execute, or call FINAL("your answer") when done.',
        });
        break;
    }

    // Check budget after each iteration
    budgetStatus.wallTimeMs = Date.now() - startTime;
    budgetStatus.subQueries = budgetRef.subQueries;
    checkBudget(budgetStatus, budget);
    if (budgetStatus.exceeded) break;
  }

  // Budget or max iterations exhausted
  const lastAssistant = messages.filter(m => m.role === 'assistant').pop();
  budgetStatus.wallTimeMs = Date.now() - startTime;
  if (!budgetStatus.exceeded) {
    budgetStatus.exceeded = 'max iterations';
  }
  return makeBudgetResult(
    lastAssistant?.content ?? '[No response generated]',
    budgetStatus.iterations,
    totalInputTokens, totalOutputTokens,
    Date.now() - startTime, true, budgetStatus,
  );
}
