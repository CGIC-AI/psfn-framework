import type { Pool } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const postgresMocks = vi.hoisted(() => ({
  ensurePostgresSchemaWithAdvisoryLock: vi.fn(async () => undefined),
  queryOne: vi.fn(async (_pool: unknown, sql: string, values: unknown[] = []) => {
    if (!sql.includes('COUNT(*) AS calls,')) return undefined;
    return values[0] === 200
      ? { calls: 4, successful_calls: 4, total_tokens: 400, total_cost_usd: 0.4 }
      : { calls: 2, successful_calls: 2, total_tokens: 150, total_cost_usd: 0.15 };
  }),
  queryRows: vi.fn(async (_pool: unknown, sql: string) => (
    sql.includes('AS series_key')
      ? [{
          series_key: 'provider-a:model-a',
          bucket_start_ms: 0,
          calls: 2,
          successful_calls: 2,
          total_tokens: 150,
          total_cost_usd: 0.15,
        }]
      : []
  )),
}));

vi.mock('../postgres.js', () => ({
  createPostgresPool: vi.fn(),
  ensurePostgresSchemaWithAdvisoryLock: postgresMocks.ensurePostgresSchemaWithAdvisoryLock,
  queryOne: postgresMocks.queryOne,
  queryRows: postgresMocks.queryRows,
  withPostgresClient: vi.fn(),
}));

import { PostgresModelUsageStore } from './model-usage-store.js';

describe('PostgresModelUsageStore previous-period totals', () => {
  beforeEach(() => {
    postgresMocks.ensurePostgresSchemaWithAdvisoryLock.mockClear();
    postgresMocks.queryOne.mockClear();
    postgresMocks.queryRows.mockClear();
  });

  it('queries only totals for the shifted window with every ledger filter preserved', async () => {
    const store = new PostgresModelUsageStore({} as Pool, { companionId: 'companion-a' });

    const data = await store.getUsageData({
      range: 'custom',
      sinceMs: 200,
      untilMs: 300,
      provider: 'provider-a',
      model: 'model-a',
      channelId: 'channel-a',
      purpose: 'analytics',
      status: 'success',
      costSource: 'provider',
      telemetryVisibility: 'operator_visible',
      limit: 5,
    });

    expect(data.totals).toMatchObject({ calls: 4, totalTokens: 400, totalCostUsd: 0.4 });
    expect(data.previousPeriod).toMatchObject({
      sinceMs: 100,
      untilMs: 200,
      totals: { calls: 2, totalTokens: 150, totalCostUsd: 0.15 },
    });

    const totalsQueries = postgresMocks.queryOne.mock.calls.filter(([, sql]) => (
      sql.includes('COUNT(*) AS calls,')
    ));
    expect(totalsQueries).toHaveLength(2);
    expect(totalsQueries[0]?.[2]).toEqual([
      200,
      300,
      'provider-a',
      'model-a',
      'operator_visible',
      'companion-a',
      'channel-a',
      'analytics',
      'success',
      'provider',
    ]);
    expect(totalsQueries[1]?.[2]).toEqual([
      100,
      200,
      'provider-a',
      'model-a',
      'operator_visible',
      'companion-a',
      'channel-a',
      'analytics',
      'success',
      'provider',
    ]);
  });

  it('returns sparse provider:model totals for each model time bucket', async () => {
    const store = new PostgresModelUsageStore({} as Pool, { companionId: 'companion-a' });

    const data = await store.getUsageData({
      range: 'custom',
      sinceMs: 200,
      untilMs: 300,
      timezone: 'UTC',
      bucket: 'hour',
      groupBy: ['model'],
      provider: 'provider-a',
    });

    expect(data.seriesByDimension?.model).toEqual([
      expect.objectContaining({
        key: 'provider-a:model-a',
        startMs: 0,
        endMs: 300,
        calls: 2,
        totalTokens: 150,
        totalCostUsd: 0.15,
      }),
    ]);
    const seriesQuery = postgresMocks.queryRows.mock.calls.find(([, sql]) => (
      sql.includes('AS series_key')
    ));
    expect(seriesQuery?.[1]).toContain("provider || ':' || model AS series_key");
    expect(seriesQuery?.[2]).toEqual([200, 300, 'provider-a', 'companion-a']);
  });
});
