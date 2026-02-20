import { describe, expect, it } from 'vitest';
import {
  MEMORY_RETRIEVAL_BUDGET_PCT_DEFAULT,
  MEMORY_RETRIEVAL_BUDGET_PCT_RANGE,
  resolveMemoryRetrievalBudget,
  resolveMemoryRetrievalBudgetPct,
  resolveSessionHistoryBudget,
  resolveSessionHistoryBudgetPct,
  SESSION_HISTORY_BUDGET_PCT_DEFAULT,
  SESSION_HISTORY_BUDGET_PCT_RANGE,
} from './context-budget.js';

describe('context-budget', () => {
  it('calculates session history budget from context window percentage', () => {
    const budget = resolveSessionHistoryBudget({
      defaultContextWindow: 200_000,
      modelRoster: {
        chat: {
          model: 'test/chat',
          provider: 'openrouter',
          maxTokens: 4096,
          contextWindow: 200_000,
        },
      },
      sessionHistoryBudgetPct: 10,
    });

    expect(budget.mode).toBe('budget');
    expect(budget.tokenBudget).toBe(20_000);
    expect(budget.estimatedCount).toBe(Math.floor(20_000 / 256));
  });

  it('uses hard overrides when session/message limits are provided', () => {
    const sessionBudget = resolveSessionHistoryBudget({
      defaultContextWindow: 128_000,
      modelRoster: {},
      sessionHistoryBudgetPct: 6,
      sessionMessageLimit: 42,
    });
    const retrievalBudget = resolveMemoryRetrievalBudget({
      defaultContextWindow: 128_000,
      modelRoster: {},
      memoryRetrievalBudgetPct: 2,
      memoryRetrievalLimit: 11,
    });

    expect(sessionBudget.mode).toBe('hard_limit');
    expect(sessionBudget.estimatedCount).toBe(42);
    expect(retrievalBudget.mode).toBe('hard_limit');
    expect(retrievalBudget.estimatedCount).toBe(11);
  });

  it('clamps or defaults budget percentages into supported ranges', () => {
    const sessionPct = resolveSessionHistoryBudgetPct({
      sessionHistoryBudgetPct: SESSION_HISTORY_BUDGET_PCT_RANGE.max + 50,
    });
    const retrievalPct = resolveMemoryRetrievalBudgetPct({
      memoryRetrievalBudgetPct: 0,
    });

    expect(sessionPct).toBe(SESSION_HISTORY_BUDGET_PCT_RANGE.max);
    expect(retrievalPct).toBe(MEMORY_RETRIEVAL_BUDGET_PCT_DEFAULT);
    expect(SESSION_HISTORY_BUDGET_PCT_DEFAULT).toBeGreaterThanOrEqual(SESSION_HISTORY_BUDGET_PCT_RANGE.min);
    expect(MEMORY_RETRIEVAL_BUDGET_PCT_DEFAULT).toBeGreaterThanOrEqual(MEMORY_RETRIEVAL_BUDGET_PCT_RANGE.min);
  });
});
