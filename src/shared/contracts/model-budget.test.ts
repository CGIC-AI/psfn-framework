import { describe, expect, it } from 'vitest';
import { parseModelBudgetBlockedEvent } from './model-budget.js';

function validBudget(): Record<string, unknown> {
  return {
    dayKey: '2025-07-14',
    monthKey: '2025-07',
    dailySpentUsd: 1,
    dailyLimitUsd: 1,
    monthlySpentUsd: 2,
    monthlyLimitUsd: 10,
    dailyUnknownCostAttempts: 0,
    monthlyUnknownCostAttempts: 0,
  };
}

function validEvent(): Record<string, unknown> {
  return {
    timestampMs: 1_752_500_000_000,
    reason: 'daily_budget_exceeded',
    purpose: 'chat',
    provider: 'openrouter',
    model: 'test-model',
    service: 'chat',
    process: 'agent.turn.prompt',
    estimatedRequestCostUsd: 0.1,
    budget: validBudget(),
  };
}

describe('parseModelBudgetBlockedEvent', () => {
  it('returns a strictly validated budget-block event', () => {
    expect(parseModelBudgetBlockedEvent(validEvent())).toEqual(validEvent());
  });

  it.each([
    ['empty budget', { ...validEvent(), budget: {} }],
    ['bogus reason', { ...validEvent(), reason: 'invented_budget_reason' }],
    ['non-finite event amount', { ...validEvent(), estimatedRequestCostUsd: Number.POSITIVE_INFINITY }],
    ['non-finite budget amount', {
      ...validEvent(),
      budget: { ...validBudget(), dailySpentUsd: Number.NaN },
    }],
    ['unknown event field', { ...validEvent(), shadowBudget: true }],
    ['unknown budget field', {
      ...validEvent(),
      budget: { ...validBudget(), shadowSpendUsd: 3 },
    }],
  ])('rejects %s', (_label, value) => {
    expect(() => parseModelBudgetBlockedEvent(value)).toThrow();
  });
});
