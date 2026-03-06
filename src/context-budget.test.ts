import { describe, expect, it } from 'vitest';
import {
  classifyContextBudgetTurn,
  MEMORY_RETRIEVAL_MIN_TOKENS_FLOOR_DEFAULT,
  MEMORY_RETRIEVAL_BUDGET_PCT_DEFAULT,
  MEMORY_RETRIEVAL_BUDGET_PCT_RANGE,
  resolveAdaptiveContextBudgetProfile,
  resolveMemoryRetrievalBudget,
  resolveMemoryRetrievalBudgetPct,
  resolveSessionHistoryBudget,
  resolveSessionHistoryBudgetPct,
  SESSION_HISTORY_MIN_TOKENS_FLOOR_DEFAULT,
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

  it('enforces minimum token floors for small context windows', () => {
    const sessionBudget = resolveSessionHistoryBudget({
      defaultContextWindow: 8_000,
      modelRoster: {
        chat: {
          model: 'small/chat',
          provider: 'openrouter',
          maxTokens: 2048,
          contextWindow: 8_000,
        },
      },
      sessionHistoryBudgetPct: 6,
    });
    const retrievalBudget = resolveMemoryRetrievalBudget({
      defaultContextWindow: 8_000,
      modelRoster: {
        chat: {
          model: 'small/chat',
          provider: 'openrouter',
          maxTokens: 2048,
          contextWindow: 8_000,
        },
      },
      memoryRetrievalBudgetPct: 2,
    });

    expect(sessionBudget.tokenBudget).toBe(SESSION_HISTORY_MIN_TOKENS_FLOOR_DEFAULT);
    expect(retrievalBudget.tokenBudget).toBe(MEMORY_RETRIEVAL_MIN_TOKENS_FLOOR_DEFAULT);
  });

  it('supports per-model token floor overrides from chat roster', () => {
    const sessionBudget = resolveSessionHistoryBudget({
      defaultContextWindow: 8_000,
      modelRoster: {
        chat: {
          model: 'small/chat',
          provider: 'openrouter',
          maxTokens: 2048,
          contextWindow: 8_000,
          contextBudget: {
            sessionHistoryMinTokens: 2_500,
            memoryRetrievalMinTokens: 750,
          },
        },
      },
      sessionHistoryBudgetPct: 6,
    });
    const retrievalBudget = resolveMemoryRetrievalBudget({
      defaultContextWindow: 8_000,
      modelRoster: {
        chat: {
          model: 'small/chat',
          provider: 'openrouter',
          maxTokens: 2048,
          contextWindow: 8_000,
          contextBudget: {
            sessionHistoryMinTokens: 2_500,
            memoryRetrievalMinTokens: 750,
          },
        },
      },
      memoryRetrievalBudgetPct: 2,
    });

    expect(sessionBudget.tokenBudget).toBe(2_500);
    expect(retrievalBudget.tokenBudget).toBe(750);
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

  it('classifies turn characteristics into deterministic budget categories', () => {
    expect(classifyContextBudgetTurn({
      messageText: 'Can you remember what I said yesterday?',
    })).toBe('recall');
    expect(classifyContextBudgetTurn({
      taskKind: 'heartbeat',
    })).toBe('task');
    expect(classifyContextBudgetTurn({
      messageText: 'I feel anxious and need support today.',
    })).toBe('emotional');
    expect(classifyContextBudgetTurn({
      messageText: 'Write a short poem about rain.',
    })).toBe('creative');
    expect(classifyContextBudgetTurn({
      messageText: 'What is the difference between TCP and UDP?',
    })).toBe('factual');
    expect(classifyContextBudgetTurn({
      messageText: 'hello there',
    })).toBe('default');
  });

  it('fails closed to base percentages when adaptive budgets are disabled', () => {
    const profile = resolveAdaptiveContextBudgetProfile({
      sessionHistoryBudgetPct: 11,
      memoryRetrievalBudgetPct: 5,
      adaptiveContextBudgetsEnabled: false,
    }, {
      messageText: 'Can you remember what I told you?',
    });

    expect(profile.enabled).toBe(false);
    expect(profile.source).toBe('disabled');
    expect(profile.category).toBe('default');
    expect(profile.sessionHistoryBudgetPct).toBe(11);
    expect(profile.memoryRetrievalBudgetPct).toBe(5);
  });

  it('adapts session and memory percentages per turn when enabled', () => {
    const profile = resolveAdaptiveContextBudgetProfile({
      sessionHistoryBudgetPct: 6,
      memoryRetrievalBudgetPct: 2,
      adaptiveContextBudgetsEnabled: true,
    }, {
      messageText: 'Can you remember what I told you?',
    });

    expect(profile.enabled).toBe(true);
    expect(profile.source).toBe('adaptive');
    expect(profile.category).toBe('recall');
    expect(profile.sessionHistoryBudgetPct).toBe(4);
    expect(profile.memoryRetrievalBudgetPct).toBe(8);
  });

  it('uses adaptive percentages during budget resolution', () => {
    const sessionBudget = resolveSessionHistoryBudget({
      defaultContextWindow: 100_000,
      modelRoster: {
        chat: {
          model: 'test/chat',
          provider: 'openrouter',
          maxTokens: 4096,
          contextWindow: 100_000,
        },
      },
      sessionHistoryBudgetPct: 6,
      adaptiveContextBudgetsEnabled: true,
    }, {
      turn: {
        messageText: 'Can you remember what I told you?',
      },
    });
    const retrievalBudget = resolveMemoryRetrievalBudget({
      defaultContextWindow: 100_000,
      modelRoster: {
        chat: {
          model: 'test/chat',
          provider: 'openrouter',
          maxTokens: 4096,
          contextWindow: 100_000,
        },
      },
      memoryRetrievalBudgetPct: 2,
      adaptiveContextBudgetsEnabled: true,
    }, {
      turn: {
        messageText: 'Can you remember what I told you?',
      },
    });

    expect(sessionBudget.budgetPct).toBe(4);
    expect(sessionBudget.tokenBudget).toBe(4_000);
    expect(retrievalBudget.budgetPct).toBe(8);
    expect(retrievalBudget.tokenBudget).toBe(8_000);
  });
});
