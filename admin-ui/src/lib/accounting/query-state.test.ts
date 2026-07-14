import { describe, expect, it } from 'vitest';
import {
  accountingSearchParamsForTab,
  accountingStateFromSearchParams,
  accountingStateToSearchParams,
  buildChargeCostQuery,
  buildModelUsageQuery,
  createDefaultAccountingState,
} from './query-state';

describe('accounting query state', () => {
  it('round-trips canonical ranges, grouping, sorting, and declared-dimension filters', () => {
    const state = {
      ...createDefaultAccountingState('America/New_York', new Date('2026-07-14T12:00:00Z')),
      range: 'quarter' as const,
      bucket: 'week' as const,
      groupBy: ['model', 'chargeLane'] as const,
      sortBy: 'effectiveCostUsd' as const,
      sortDirection: 'asc' as const,
      filters: { model: 'gpt-5', chargeLane: 'interactive' },
    };

    const params = accountingStateToSearchParams(state);
    const parsed = accountingStateFromSearchParams(params, 'UTC', new Date('2025-01-01T00:00:00Z'));

    expect(parsed).toEqual(state);
    expect(params.get('filter.model')).toBe('gpt-5');
    expect(params.get('filter.chargeLane')).toBe('interactive');
  });

  it('preserves accounting query state across Token Usage and Charge Policy tab switches', () => {
    const state = {
      ...createDefaultAccountingState('America/New_York', new Date('2026-07-14T12:00:00Z')),
      range: 'quarter' as const,
      bucket: 'week' as const,
      groupBy: ['model', 'channelId'] as const,
      sortBy: 'totalTokens' as const,
      sortDirection: 'asc' as const,
      eventOrder: 'recent' as const,
      filters: { model: 'gpt-5', channelId: 'discord:operator' },
    };

    const tokenUsageParams = accountingStateToSearchParams(state);
    const chargePolicyParams = accountingSearchParamsForTab(tokenUsageParams, 'charges');
    const returnedTokenUsageParams = accountingSearchParamsForTab(
      chargePolicyParams,
      'token-usage',
    );

    expect(chargePolicyParams.get('tab')).toBeNull();
    expect(returnedTokenUsageParams.get('tab')).toBe('token-usage');
    expect(accountingStateFromSearchParams(
      returnedTokenUsageParams,
      'UTC',
      new Date('2025-01-01T00:00:00Z'),
    )).toEqual(state);
  });

  it('fails closed to known values and ignores undeclared filter dimensions', () => {
    const parsed = accountingStateFromSearchParams(new URLSearchParams({
      range: 'forever',
      bucket: 'minute',
      groupBy: 'notAField,model',
      sortBy: 'money',
      sortDirection: 'sideways',
      'filter.notAField': 'leak',
      'filter.model': 'claude',
    }), 'UTC', new Date('2026-07-14T12:00:00Z'));

    expect(parsed.range).toBe('month');
    expect(parsed.bucket).toBe('auto');
    expect(parsed.groupBy).toEqual(['model']);
    expect(parsed.sortBy).toBe('effectiveCostUsd');
    expect(parsed.sortDirection).toBe('desc');
    expect(parsed.filters).toEqual({ model: 'claude' });
  });

  it('resolves custom inclusive dates at midnight in the selected IANA timezone', () => {
    const state = {
      ...createDefaultAccountingState('America/New_York', new Date('2026-07-14T12:00:00Z')),
      range: 'custom' as const,
      customSinceDate: '2026-03-08',
      customUntilDate: '2026-03-08',
    };

    const query = buildModelUsageQuery(state);

    expect(query.sinceMs).toBe(Date.parse('2026-03-08T05:00:00.000Z'));
    expect(query.untilMs).toBe(Date.parse('2026-03-09T04:00:00.000Z'));
    expect(query.timezone).toBe('America/New_York');
  });

  it('maps only charge-cost-compatible filters into the canonical reconciliation query', () => {
    const state = {
      ...createDefaultAccountingState('UTC', new Date('2026-07-14T12:00:00Z')),
      filters: {
        companionId: 'companion-a',
        channelId: 'discord:1',
        chargeLane: 'interactive',
        chargeSurface: 'externalModelConsult',
        chargeRunId: 'run-1',
        chargeRootRunId: 'root-1',
        model: 'gpt-5',
      },
    };

    expect(buildChargeCostQuery(state, { sinceMs: 10, untilMs: 20 })).toEqual({
      sinceMs: 10,
      untilMs: 20,
      companionId: 'companion-a',
      channelId: 'discord:1',
      lane: 'interactive',
      surface: 'externalModelConsult',
      runId: 'run-1',
      rootRunId: 'root-1',
    });
  });
});
