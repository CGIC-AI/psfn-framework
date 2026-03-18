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

  it('derives message and memory estimates directly from the token budget', () => {
    const sessionBudget = resolveSessionHistoryBudget({
      defaultContextWindow: 1_000_000,
      modelRoster: {},
      sessionHistoryBudgetPct: 50,
    });
    const retrievalBudget = resolveMemoryRetrievalBudget({
      defaultContextWindow: 1_000_000,
      modelRoster: {},
      memoryRetrievalBudgetPct: 50,
    });

    expect(sessionBudget.mode).toBe('budget');
    expect(sessionBudget.estimatedCount).toBe(Math.floor(500_000 / 256));
    expect(retrievalBudget.mode).toBe('budget');
    expect(retrievalBudget.estimatedCount).toBe(Math.floor(500_000 / 170));
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

  it('prefers canonical model catalog metadata over stale chat roster metadata', () => {
    const sessionBudget = resolveSessionHistoryBudget({
      defaultContextWindow: 128_000,
      modelRoster: {
        chat: {
          model: 'stale/chat',
          provider: 'openrouter',
          maxTokens: 4096,
          contextWindow: 32_000,
        },
      },
      modelCatalog: {
        primary: {
          model: 'catalog/chat',
          provider: 'openrouter',
          defaults: {
            maxTokens: 4096,
            contextWindow: 200_000,
            contextBudget: {
              sessionHistoryMinTokens: 9_000,
            },
          },
        },
      },
      modelRoleAssignments: {
        chat: 'primary',
      },
      sessionHistoryBudgetPct: 4,
    });

    expect(sessionBudget.contextWindow).toBe(200_000);
    expect(sessionBudget.tokenBudget).toBe(9_000);
  });

  it('recomputes budgets from the canonical per-turn purpose slot', () => {
    const sessionBudget = resolveSessionHistoryBudget({
      defaultContextWindow: 128_000,
      modelRoster: {
        chat: {
          model: 'chat-model',
          provider: 'openrouter',
          maxTokens: 4096,
          contextWindow: 128_000,
          contextBudget: {
            sessionHistoryMinTokens: 4_000,
          },
        },
      },
      modelCatalog: {
        primary: {
          model: 'chat-model',
          provider: 'openrouter',
          defaults: {
            maxTokens: 4096,
            contextWindow: 128_000,
            contextBudget: {
              sessionHistoryMinTokens: 4_000,
            },
          },
        },
        vision: {
          model: 'vision-model',
          provider: 'openrouter',
          defaults: {
            maxTokens: 4096,
            contextWindow: 16_000,
            contextBudget: {
              sessionHistoryMinTokens: 2_000,
            },
          },
        },
      },
      modelRoleAssignments: {
        chat: 'primary',
        vision: 'vision',
      },
      sessionHistoryBudgetPct: 6,
    }, {
      turn: {
        modelSelection: {
          purpose: 'vision',
        },
      },
    });

    expect(sessionBudget.contextWindow).toBe(16_000);
    expect(sessionBudget.tokenBudget).toBe(2_000);
  });

  it('matches explicit per-turn provider/model overrides against canonical metadata', () => {
    const retrievalBudget = resolveMemoryRetrievalBudget({
      defaultContextWindow: 128_000,
      modelRoster: {
        chat: {
          model: 'chat-model',
          provider: 'openrouter',
          maxTokens: 4096,
          contextWindow: 128_000,
        },
      },
      modelCatalog: {
        primary: {
          model: 'chat-model',
          provider: 'openrouter',
          defaults: {
            maxTokens: 4096,
            contextWindow: 128_000,
          },
        },
        compact: {
          model: 'compact-model',
          provider: 'openrouter',
          defaults: {
            maxTokens: 4096,
            contextWindow: 24_000,
            contextBudget: {
              memoryRetrievalMinTokens: 600,
            },
          },
        },
      },
      modelRoleAssignments: {
        chat: 'primary',
      },
      memoryRetrievalBudgetPct: 2,
    }, {
      turn: {
        modelSelection: {
          provider: 'openrouter',
          model: 'compact-model',
        },
      },
    });

    expect(retrievalBudget.contextWindow).toBe(24_000);
    expect(retrievalBudget.tokenBudget).toBe(600);
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
      taskKind: 'planning',
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

  it('classifies heartbeat and reflection turns using normal companion-context heuristics', () => {
    expect(classifyContextBudgetTurn({
      channelId: 'internal:heartbeat',
      channelType: 'internal',
      taskKind: 'heartbeat',
      messageText: 'I feel anxious and need support today.',
    })).toBe('emotional');
    expect(classifyContextBudgetTurn({
      channelId: 'internal:reflection:values-reflection',
      channelType: 'internal',
      taskKind: 'reflection',
      messageText: 'Can you remember what mattered most last week?',
    })).toBe('recall');
    expect(classifyContextBudgetTurn({
      channelId: 'internal:reflection:whisper',
      channelType: 'internal',
      taskKind: 'reflection',
      messageText: 'just checking in',
    })).toBe('default');
    expect(classifyContextBudgetTurn({
      channelId: 'internal:planning:daily',
      channelType: 'internal',
      taskKind: 'planning',
      messageText: 'just checking in',
    })).toBe('task');
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
