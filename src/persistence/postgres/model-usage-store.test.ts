import type { Pool } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const postgresMocks = vi.hoisted(() => ({
  seriesOverflow: false,
  clientQueries: [] as Array<{ sql: string; values: unknown[] }>,
  createPostgresPool: vi.fn(() => ({}) as Pool),
  ensurePostgresSchemaWithAdvisoryLock: vi.fn(async () => undefined),
  assertModelUsageLedgerReadable: vi.fn(async () => undefined),
  queryOne: vi.fn(async (_pool: unknown, sql: string, values: unknown[] = []) => {
    if (!sql.includes('COUNT(*) AS calls,')) return undefined;
    return values[0] === 200
      ? { calls: 4, successful_calls: 4, total_tokens: 400, total_cost_usd: 0.4 }
      : { calls: 2, successful_calls: 2, total_tokens: 150, total_cost_usd: 0.15 };
  }),
  queryRows: vi.fn(async (_pool: unknown, sql: string) => {
    if (!sql.includes('AS series_key')) return [];
    if (postgresMocks.seriesOverflow) {
      return Array.from({ length: 5_001 }, (_, index) => ({
        series_key: `provider:model-${index}`,
        bucket_start_ms: 0,
      }));
    }
    return [{
          series_key: 'provider-a:model-a',
          bucket_start_ms: 0,
          calls: 2,
          successful_calls: 2,
          total_tokens: 150,
          total_cost_usd: 0.15,
    }];
  }),
}));

vi.mock('../postgres.js', () => ({
  createPostgresPool: postgresMocks.createPostgresPool,
  ensurePostgresSchemaWithAdvisoryLock: postgresMocks.ensurePostgresSchemaWithAdvisoryLock,
  queryOne: postgresMocks.queryOne,
  queryRows: postgresMocks.queryRows,
  withPostgresClient: vi.fn(async (_pool: unknown, operation: (client: unknown) => Promise<unknown>) => (
    operation({
      query: async (sql: string, values: unknown[] = []) => {
        postgresMocks.clientQueries.push({ sql, values });
        return sql.includes('INSERT INTO model_usage_events')
          ? { rows: [{ id: values[0] }] }
          : { rows: [] };
      },
    })
  )),
}));

vi.mock('./model-usage-access.js', () => ({
  assertModelUsageLedgerReadable: postgresMocks.assertModelUsageLedgerReadable,
}));

import {
  createPostgresModelUsageStoreFromConfig,
  PostgresModelUsageStore,
} from './model-usage-store.js';

describe('PostgresModelUsageStore previous-period totals', () => {
  beforeEach(() => {
    postgresMocks.createPostgresPool.mockClear();
    postgresMocks.ensurePostgresSchemaWithAdvisoryLock.mockClear();
    postgresMocks.assertModelUsageLedgerReadable.mockClear();
    postgresMocks.queryOne.mockClear();
    postgresMocks.queryRows.mockClear();
    postgresMocks.seriesOverflow = false;
    postgresMocks.clientQueries.length = 0;
  });

  it('resolves the first manifest companion as the ledger and opens follower reads read-only', async () => {
    const store = createPostgresModelUsageStoreFromConfig({
      persistenceBackend: 'postgres',
      postgresDatabaseUrl: 'postgres://follower:secret@localhost:5432/psfn',
      companionId: '22222222-2222-4222-8222-222222222222',
      multiCompanion: true,
      postgresSchema: 'companion_follower',
      postgresRole: 'follower_runtime',
      companionFleet: {
        companions: [
          { postgresSchema: 'arbitrary_primary_schema', postgresRole: 'primary_runtime' },
          { postgresSchema: 'companion_follower', postgresRole: 'follower_runtime' },
        ],
      },
    } as never, { companionId: '22222222-2222-4222-8222-222222222222' }, 'read_only');

    if (!store) throw new Error('Postgres config must create a model usage store');
    await store.waitUntilReady();
    expect(postgresMocks.createPostgresPool).toHaveBeenCalledWith(
      'postgres://follower:secret@localhost:5432/psfn',
      expect.objectContaining({
        schema: 'arbitrary_primary_schema',
        role: 'follower_runtime',
        readOnly: true,
      }),
    );
    expect(postgresMocks.assertModelUsageLedgerReadable).toHaveBeenCalledTimes(1);
    expect(postgresMocks.ensurePostgresSchemaWithAdvisoryLock).not.toHaveBeenCalled();
  });

  it('pins the gateway migration authority to the manifest primary owner', async () => {
    const store = createPostgresModelUsageStoreFromConfig({
      persistenceBackend: 'postgres',
      postgresDatabaseUrl: 'postgres://primary:secret@localhost:5432/psfn',
      companionId: '11111111-1111-4111-8111-111111111111',
      multiCompanion: true,
      postgresSchema: 'canonical_primary',
      postgresRole: 'primary_runtime',
      companionFleet: {
        companions: [
          { postgresSchema: 'canonical_primary', postgresRole: 'primary_runtime' },
          { postgresSchema: 'companion_follower', postgresRole: 'follower_runtime' },
        ],
      },
    } as never, { fleetAggregation: true }, 'migration_authority');

    if (!store) throw new Error('Postgres config must create a model usage store');
    await store.waitUntilReady();
    expect(postgresMocks.createPostgresPool).toHaveBeenCalledWith(
      'postgres://primary:secret@localhost:5432/psfn',
      expect.objectContaining({
        schema: 'canonical_primary',
        role: 'primary_runtime',
      }),
    );
    expect(postgresMocks.ensurePostgresSchemaWithAdvisoryLock).toHaveBeenCalledTimes(1);
    expect(postgresMocks.assertModelUsageLedgerReadable).not.toHaveBeenCalled();
  });

  it('rejects an unknown connection authority mode', () => {
    expect(() => new PostgresModelUsageStore(
      {} as Pool,
      { companionId: 'companion-a' },
      { access: 'write_if_possible' } as never,
    )).toThrow(/connection access/i);
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
    expect(data.attributionAnomalies).toEqual({
      unknownChargeLaneCalls: 0,
      unknownChargeLaneRatePercent: 0,
      unknownSessionCalls: 0,
      unknownSessionRatePercent: 0,
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
    expect(seriesQuery?.[1]).toContain('LIMIT 5001');
    expect(seriesQuery?.[2]).toEqual([200, 300, 'provider-a', 'companion-a']);
  });

  it('rejects dimension time-series results above the server-side safety bound', async () => {
    postgresMocks.seriesOverflow = true;
    const store = new PostgresModelUsageStore({} as Pool, { companionId: 'companion-a' });

    await expect(store.getUsageData({
      range: 'custom',
      sinceMs: 200,
      untilMs: 300,
      groupBy: ['sessionId'],
    })).rejects.toThrow('dimension time series exceeds the 5000-row safety limit');
  });

  it('preserves the enclosing session but records embedding as the model-operation origin', async () => {
    const store = new PostgresModelUsageStore({} as Pool, { companionId: 'companion-a' });

    await store.recordUsageEvent({
      logicalCallId: 'extraction-embedding',
      status: 'success',
      callKind: 'embedding',
      attribution: {
        companionId: 'companion-a',
        sessionId: 'session-a',
        channelId: 'channel-a',
        callType: 'memory',
        purpose: 'embedding',
        originStage: 'extraction',
      },
      provider: 'embedding-provider',
      model: 'embedding-model',
      inputTokens: 2,
      outputTokens: 0,
    });

    const insert = postgresMocks.clientQueries.find(({ sql }) => (
      sql.includes('INSERT INTO model_usage_events')
    ));
    expect(insert?.values[16]).toBe('embedding');
    expect(insert?.values[20]).toBe('session-a');
    expect(insert?.values[27]).toBe('background');
  });
});
