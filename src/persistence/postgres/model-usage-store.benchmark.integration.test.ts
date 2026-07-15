import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';
import { createPostgresPool } from '../postgres.js';
import {
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import { PostgresModelUsageStore } from './model-usage-store.js';

const TEST_IMAGE = 'postgres:16.8-alpine';
const TEST_TIMEOUT_MS = 120_000;
const YEAR_SCALE_EVENT_COUNT = 3_650;
/** Raw-ledger target on the local one-core Docker harness; exceeding it requires rollup evidence. */
const YEAR_SCALE_QUERY_TARGET_MS = 2_000;

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: TEST_IMAGE });
}, TEST_TIMEOUT_MS);

afterAll(async () => {
  await harness?.stop();
}, TEST_TIMEOUT_MS);

describe('PostgresModelUsageStore year-scale benchmark', () => {
  it('meets the raw indexed-query target without rollups', async () => {
    if (!harness) throw new Error('Postgres test harness is unavailable');
    const { databaseUrl } = await harness.createDatabase();
    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'model-usage-year-benchmark',
      allowExitOnIdle: true,
      max: 4,
    });
    const store = new PostgresModelUsageStore(pool, { companionId: 'benchmark-companion' });
    const sinceMs = Date.parse('2025-01-01T00:00:00.000Z');
    const untilMs = Date.parse('2026-01-01T00:00:00.000Z');
    try {
      await store.recordUsageEvent({
        logicalCallId: 'benchmark-seed',
        recordedAtMs: sinceMs,
        startedAtMs: sinceMs,
        status: 'success',
        settlement: 'complete',
        callKind: 'chat',
        attribution: {
          companionId: 'benchmark-companion', channelId: 'benchmark-channel', channelType: 'api',
          callType: 'chat', purpose: 'year-benchmark',
        },
        provider: 'provider-0', model: 'model-0', inputTokens: 10, outputTokens: 5,
        cacheReadTokens: 3, cacheWriteTokens: 2, totalTokens: 20,
        estimatedCost: { total: 0.001 }, effectiveCost: { total: 0.001 }, costSource: 'estimate',
      });
      await pool.query(`
        WITH seed AS (
          SELECT to_jsonb(model_usage_events) AS data
          FROM model_usage_events
          WHERE id = 'benchmark-seed:0'
        ), generated AS (
          SELECT
            series,
            $1::bigint + FLOOR((series::numeric / $2::numeric) * ($3::bigint - $1::bigint - 1))::bigint AS at_ms,
            data
          FROM seed
          CROSS JOIN generate_series(1, $2::integer) AS series
        )
        INSERT INTO model_usage_events
        SELECT (jsonb_populate_record(
          NULL::model_usage_events,
          data || jsonb_build_object(
            'id', 'benchmark-' || series,
            'logical_call_id', 'benchmark-' || series,
            'recorded_at_ms', at_ms,
            'started_at_ms', at_ms,
            'day_key', to_char(to_timestamp(at_ms / 1000.0) AT TIME ZONE 'UTC', 'YYYY-MM-DD'),
            'month_key', to_char(to_timestamp(at_ms / 1000.0) AT TIME ZONE 'UTC', 'YYYY-MM'),
            'provider', 'provider-' || (series % 10),
            'model', 'model-' || (series % 10),
            'event_fingerprint', md5('benchmark-' || series)
          )
        )).*
        FROM generated
      `, [sinceMs, YEAR_SCALE_EVENT_COUNT - 1, untilMs]);
      await pool.query('ANALYZE model_usage_events');

      const plan = await pool.query<{ 'QUERY PLAN': string }>(`
        EXPLAIN (ANALYZE, FORMAT TEXT)
        SELECT COUNT(*), SUM(total_tokens), SUM(effective_cost_usd)
        FROM model_usage_events
        WHERE provider = 'provider-7'
          AND model = 'model-7'
          AND recorded_at_ms >= $1
          AND recorded_at_ms < $2
      `, [sinceMs, untilMs]);
      expect(plan.rows.map(row => row['QUERY PLAN']).join('\n')).toMatch(/Index|Bitmap/u);

      const startedAt = performance.now();
      const result = await store.getUsageData({
        range: 'custom', sinceMs, untilMs, timezone: 'UTC', bucket: 'day',
        groupBy: ['provider', 'status'], topN: 10, limit: 25,
      });
      const elapsedMs = performance.now() - startedAt;
      process.stdout.write(
        `model-usage year benchmark: ${YEAR_SCALE_EVENT_COUNT} events, ${elapsedMs.toFixed(2)}ms `
        + `(target <${YEAR_SCALE_QUERY_TARGET_MS}ms)\n`,
      );

      expect(result.totals.calls).toBe(YEAR_SCALE_EVENT_COUNT);
      expect(result.timeSeries).toHaveLength(365);
      expect(result.timeSeries.reduce((sum, bucket) => sum + bucket.calls, 0)).toBe(YEAR_SCALE_EVENT_COUNT);
      expect(elapsedMs).toBeLessThan(YEAR_SCALE_QUERY_TARGET_MS);
    } finally {
      await pool.end();
    }
  }, TEST_TIMEOUT_MS);
});
