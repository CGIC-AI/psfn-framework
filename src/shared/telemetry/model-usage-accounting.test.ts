import { describe, expect, it } from 'vitest';
import { reconcileModelUsageAccounting } from './model-usage-accounting.js';

describe('reconcileModelUsageAccounting', () => {
  it('keeps a provider-only total unallocated while preserving an independent estimate', () => {
    const accounting = reconcileModelUsageAccounting({
      usage: {
        inputTokens: 176,
        outputTokens: 2,
        cacheReadTokens: 7,
        cacheWriteTokens: 11,
        totalTokens: 196,
      },
      providerCost: {
        total: 0.95,
        currency: 'USD',
      },
      estimatedRates: {
        inputPer1MUsd: 2,
        outputPer1MUsd: 8,
        cacheReadPer1MUsd: 0.2,
        cacheWritePer1MUsd: 2.5,
        currency: 'USD',
      },
    });

    expect(accounting.usage).toEqual({
      inputTokens: 176,
      outputTokens: 2,
      cacheReadTokens: 7,
      cacheWriteTokens: 11,
      totalTokens: 196,
    });
    expect(accounting.providerCost).toEqual({
      total: 0.95,
      currency: 'USD',
    });
    expect(accounting.providerCost.input).toBeUndefined();
    expect(accounting.providerCost.cacheRead).toBeUndefined();
    expect(accounting.estimatedCost).toEqual({
      input: 0.000352,
      output: 0.000016,
      cacheRead: 0.0000014,
      cacheWrite: 0.0000275,
      total: 0.0003969,
      currency: 'USD',
    });
    expect(accounting.effectiveCost).toEqual({
      total: 0.95,
      currency: 'USD',
    });
    expect(accounting.costSource).toBe('provider');
  });

  it('does not fabricate an estimated allocation when a nonzero cache bucket has no rate', () => {
    const accounting = reconcileModelUsageAccounting({
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 3,
        cacheWriteTokens: 0,
      },
      estimatedRates: {
        inputPer1MUsd: 1,
        outputPer1MUsd: 2,
        currency: 'USD',
      },
    });

    expect(accounting.usage.totalTokens).toBe(18);
    expect(accounting.estimatedCost).toEqual({
      input: 0.00001,
      output: 0.00001,
      cacheWrite: 0,
      currency: 'USD',
    });
    expect(accounting.estimatedCost.total).toBeUndefined();
    expect(accounting.effectiveCost.total).toBeUndefined();
    expect(accounting.costSource).toBe('none');
  });

  it('derives a provider total only when every nonzero token bucket has a component', () => {
    const accounting = reconcileModelUsageAccounting({
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      providerCost: {
        input: 0.00001,
        output: 0.00002,
        currency: 'USD',
      },
    });

    expect(accounting.providerCost).toEqual({
      input: 0.00001,
      output: 0.00002,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0.00003,
      currency: 'USD',
    });
    expect(accounting.effectiveCost.total).toBe(0.00003);
    expect(accounting.costSource).toBe('provider');
  });

  it('rejects a provider total-token value that double-counts separated cache buckets', () => {
    expect(() => reconcileModelUsageAccounting({
      usage: {
        inputTokens: 90,
        outputTokens: 10,
        cacheReadTokens: 20,
        cacheWriteTokens: 5,
        totalTokens: 145,
      },
    })).toThrow('totalTokens must equal input + output + cacheRead + cacheWrite (125)');
  });
});
