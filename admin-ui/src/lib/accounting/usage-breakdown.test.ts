import { describe, expect, it } from 'vitest';
import type { ModelUsageBreakdown } from '../../../../src/shared/telemetry/model-usage.js';
import { buildUsageBreakdownRows } from './usage-breakdown';

function breakdown(key: string, cost: number): ModelUsageBreakdown {
  return {
    key,
    calls: cost,
    inputTokens: cost * 10,
    outputTokens: cost * 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: cost * 15,
    totalCostUsd: cost,
  };
}

describe('buildUsageBreakdownRows', () => {
  it('keeps the eight highest-cost rows and rolls the remainder into Other', () => {
    const rows = buildUsageBreakdownRows(
      Array.from({ length: 10 }, (_, index) => breakdown(`purpose-${index + 1}`, index + 1)),
      { dimension: 'purpose' },
    );

    expect(rows.map(row => row.key)).toEqual([
      'purpose-10',
      'purpose-9',
      'purpose-8',
      'purpose-7',
      'purpose-6',
      'purpose-5',
      'purpose-4',
      'purpose-3',
      'Other',
    ]);
    expect(rows.at(-1)).toMatchObject({
      calls: 3,
      totalTokens: 45,
      effectiveCostUsd: 3,
      drillValue: null,
    });
  });

  it('sorts the visible top rows by the requested metric and direction', () => {
    const rows = buildUsageBreakdownRows([
      { ...breakdown('brief', 3), totalTokens: 20 },
      { ...breakdown('long', 2), totalTokens: 300 },
      { ...breakdown('medium', 1), totalTokens: 100 },
    ], {
      dimension: 'purpose',
      sortBy: 'totalTokens',
      sortDirection: 'asc',
    });

    expect(rows.map(row => row.key)).toEqual(['brief', 'medium', 'long']);
  });

  it('maps model drill values and disables drilling for the unknown tool row', () => {
    const [model] = buildUsageBreakdownRows(
      [breakdown('openrouter:anthropic/claude-sonnet', 2)],
      { dimension: 'model' },
    );
    const [tool] = buildUsageBreakdownRows(
      [breakdown('unknown', 1)],
      { dimension: 'toolName' },
    );

    expect(model).toMatchObject({
      label: 'openrouter:anthropic/claude-sonnet',
      drillValue: 'anthropic/claude-sonnet',
    });
    expect(tool).toMatchObject({ label: 'No tool', drillValue: null });
  });
});
