import { describe, expect, it } from 'vitest';
import { buildContextBudgetPreview } from '../../admin-ui/src/lib/settings/context-budget-preview';

describe('buildContextBudgetPreview', () => {
  it('uses the effective chat slot context window instead of the fallback window', () => {
    const preview = buildContextBudgetPreview({
      defaultContextWindow: 128_000,
      modelRoster: {
        chat: {
          model: 'stale-chat',
          provider: 'openrouter',
          contextWindow: 32_000,
        },
      },
      modelCatalog: {
        primary: {
          model: 'chat-model',
          provider: 'openrouter',
          defaults: {
            contextWindow: 200_000,
            contextBudget: {
              sessionHistoryMinTokens: 9_000,
              memoryRetrievalMinTokens: 2_500,
            },
          },
        },
      },
      modelRoleAssignments: {
        chat: 'primary',
      },
      sessionHistoryBudgetPct: 4,
      memoryRetrievalBudgetPct: 2,
      adaptiveContextBudgetsEnabled: true,
    }, {
      systemPromptTokens: 2_500,
      maxResponseTokens: 4_096,
    });

    expect(preview.contextWindow).toBe(200_000);
    expect(preview.resolvedChatModel).toBe('chat-model');
    expect(preview.resolvedChatProvider).toBe('openrouter');
    expect(preview.sessionHistoryMinTokens).toBe(9_000);
    expect(preview.memoryRetrievalMinTokens).toBe(2_500);
    expect(preview.sessTokenBudget).toBe(9_000);
    expect(preview.memTokenBudget).toBe(4_000);
  });

  it('shows heartbeat and reflection preview rows using the default companion budget, not the task profile', () => {
    const preview = buildContextBudgetPreview({
      defaultContextWindow: 100_000,
      modelRoster: {
        chat: {
          model: 'chat-model',
          provider: 'openrouter',
          contextWindow: 100_000,
        },
      },
      sessionHistoryBudgetPct: 6,
      memoryRetrievalBudgetPct: 2,
      adaptiveContextBudgetsEnabled: true,
    }, {
      systemPromptTokens: 2_500,
      maxResponseTokens: 4_096,
    });

    const heartbeatVariant = preview.variants.find((variant) => variant.key === 'heartbeat_reflection');
    const taskVariant = preview.variants.find((variant) => variant.key === 'task');

    expect(heartbeatVariant).toMatchObject({
      source: 'default',
    });
    expect(heartbeatVariant?.sessionBudget.budgetPct).toBe(6);
    expect(heartbeatVariant?.memoryBudget.budgetPct).toBe(2);
    expect(taskVariant?.sessionBudget.budgetPct).toBe(12);
    expect(taskVariant?.memoryBudget.budgetPct).toBe(2);
  });
});
