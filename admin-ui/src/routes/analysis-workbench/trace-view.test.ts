import { describe, expect, it } from 'vitest';
import { projectAnalysisTraceOutcome } from './trace-view.js';

describe('Analysis Workbench trace outcome projection', () => {
  it('shows completed work with progress, owner limits, and exact run cost', () => {
    expect(projectAnalysisTraceOutcome({
      outcome: 'completed',
      continuation: 'not_needed',
      budgetStop: null,
      iterations: 45,
      totalTokens: 125_000,
      durationMs: 420_000,
      sessionCostUsd: 1.2345,
      limitPolicy: {
        maxIterations: 60,
        maxTokens: 256_000,
        maxWallTimeMs: 600_000,
        maxSubQueries: 60,
        maxToolCalls: 50,
      },
    })).toEqual({
      status: 'completed',
      continuation: 'complete; no continuation needed',
      progress: '45/60 iterations · 125.0k/256.0k tokens · 7.0m/10.0m',
      cost: '$1.2345',
    });
  });

  it('shows a budget-limited run as incomplete and terminal without fabricating legacy data', () => {
    expect(projectAnalysisTraceOutcome({
      outcome: 'limit_reached',
      continuation: 'restart_required',
      budgetStop: 'token budget',
      iterations: 12,
      totalTokens: 256_000,
      durationMs: 300_000,
      sessionCostUsd: 2,
      limitPolicy: {
        maxIterations: 60,
        maxTokens: 256_000,
        maxWallTimeMs: 600_000,
        maxSubQueries: 60,
        maxToolCalls: 50,
      },
    })).toMatchObject({
      status: 'incomplete — token budget',
      continuation: 'terminal; start a new run to continue',
      cost: '$2.0000',
    });

    expect(projectAnalysisTraceOutcome({
      budgetStop: null,
      iterations: 1,
      totalTokens: 10,
      durationMs: 5,
    })).toEqual({
      status: 'outcome unavailable',
      continuation: 'continuation unavailable',
      progress: '1 iteration · 10 tokens · 5ms (limit policy unavailable)',
      cost: 'cost unavailable',
    });
  });
});
