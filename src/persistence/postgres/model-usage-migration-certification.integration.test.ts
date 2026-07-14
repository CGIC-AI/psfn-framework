import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import { createPostgresPool } from '../postgres.js';
import {
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import {
  certifyModelUsageMigrations,
  inspectModelUsageMigrationEvidence,
} from './model-usage-migration-certification.js';

const TEST_IMAGE = 'postgres:16.8-alpine';
const INTEGRATION_TIMEOUT_MS = 120_000;

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: TEST_IMAGE });
}, INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
  await harness?.stop();
}, INTEGRATION_TIMEOUT_MS);

async function createLegacyModelUsageTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE model_usage_events (
      id TEXT PRIMARY KEY,
      logical_call_id TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0,
      recorded_at_ms BIGINT NOT NULL,
      started_at_ms BIGINT NOT NULL,
      completed_at_ms BIGINT,
      duration_ms BIGINT,
      ttft_ms BIGINT,
      day_key TEXT NOT NULL,
      month_key TEXT NOT NULL,
      status TEXT NOT NULL,
      call_kind TEXT NOT NULL,
      call_type TEXT NOT NULL,
      purpose TEXT NOT NULL,
      origin_type TEXT,
      origin_stage TEXT,
      service TEXT,
      process TEXT,
      turn_id TEXT,
      request_id TEXT,
      channel_id TEXT,
      tool_name TEXT,
      tool_call_id TEXT,
      charge_lane TEXT,
      charge_surface TEXT,
      charge_run_id TEXT,
      charge_root_run_id TEXT,
      charge_parent_run_id TEXT,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      slot_key TEXT,
      requested_provider TEXT,
      requested_model TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      provider_cost_usd DOUBLE PRECISION,
      estimated_cost_usd DOUBLE PRECISION,
      cost_source TEXT NOT NULL DEFAULT 'none',
      currency TEXT,
      stop_reason TEXT,
      error_code TEXT,
      error_message TEXT,
      metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      event_fingerprint TEXT NOT NULL,
      UNIQUE (logical_call_id, attempt)
    )
  `);
}

async function insertLegacyEvidenceCorpus(pool: Pool): Promise<void> {
  await pool.query(`
    INSERT INTO model_usage_events (
      id, logical_call_id, attempt, recorded_at_ms, started_at_ms,
      completed_at_ms, day_key, month_key, status, call_kind, call_type,
      purpose, origin_type, origin_stage, service, process, turn_id, request_id,
      channel_id, tool_name, tool_call_id, charge_lane, charge_surface,
      charge_run_id, charge_root_run_id, charge_parent_run_id, provider, model,
      slot_key, requested_provider, requested_model, input_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens, total_tokens, provider_cost_usd,
      estimated_cost_usd, cost_source, currency, metadata_json, event_fingerprint
    ) VALUES
      (
        'legacy-provider', 'legacy-provider-call', 0, 1752300000000, 1752299999900,
        1752300000000, '2025-07-12', '2025-07', 'success', 'chat', 'chat',
        'chat', 'chat', 'response', 'agent', 'agent', 'turn-provider', 'request-provider',
        'channel-known', NULL, NULL, 'interactive', 'externalModelConsult',
        'run-provider', 'root-provider', NULL, 'openrouter', 'provider-model',
        'chat', 'openrouter', 'provider-model', 10, 5, 3, 2, 20, 0.25,
        0.125, 'provider', 'USD', '{}'::jsonb, 'legacy:legacy-provider'
      ),
      (
        'legacy-estimate', 'legacy-estimate-call', 0, 1752300100000, 1752300099900,
        1752300100000, '2025-07-12', '2025-07', 'success', 'completion', 'summary',
        'summary', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        NULL, NULL, NULL, 'ollama', 'local-model', NULL, NULL, NULL, 8, 4, 0, 0, 12,
        NULL, 0.01, 'estimate', 'USD', '{}'::jsonb, 'legacy:legacy-estimate'
      ),
      (
        'legacy-unknown', 'legacy-unknown-call', 0, 1752300200000, 1752300199900,
        NULL, '2025-07-12', '2025-07', 'failure', 'embedding', 'memory',
        'memory', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        NULL, NULL, NULL, 'api', 'unknown-price-model', NULL, NULL, NULL, 0, 0, 0, 0, 0,
        NULL, 0, 'none', NULL, '{}'::jsonb, 'legacy:legacy-unknown'
      ),
      (
        'legacy-repaired-total', 'legacy-repaired-total-call', 0, 1752300300000, 1752300299900,
        1752300300000, '2025-07-12', '2025-07', 'success', 'chat', 'tool',
        'tool', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'repl', NULL, NULL, NULL,
        NULL, NULL, NULL, 'litellm', 'tool-model', NULL, NULL, NULL, 4, 3, 2, 1, 99,
        NULL, 0, 'none', 'EUR', '{}'::jsonb, 'legacy:legacy-repaired-total'
      ),
      (
        'legacy-provider-null-cost', 'legacy-provider-null-cost-call', 0,
        1752300400000, 1752300399900, 1752300400000,
        '2025-07-12', '2025-07', 'success', 'chat', 'chat', 'chat',
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        NULL, NULL, NULL, 'openrouter', 'provider-null-cost-model', NULL, NULL, NULL,
        6, 2, 0, 0, 8, NULL, NULL, 'provider', 'USD', '{}'::jsonb,
        'legacy:legacy-provider-null-cost'
      ),
      (
        'legacy-estimate-null-cost', 'legacy-estimate-null-cost-call', 0,
        1752300500000, 1752300499900, 1752300500000,
        '2025-07-12', '2025-07', 'success', 'completion', 'summary', 'summary',
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        NULL, NULL, NULL, 'ollama', 'estimate-null-cost-model', NULL, NULL, NULL,
        7, 3, 0, 0, 10, NULL, NULL, 'estimate', 'USD', '{}'::jsonb,
        'legacy:legacy-estimate-null-cost'
      )
  `);
}

describe('model usage migration certification', () => {
  it('dry-runs, rolls back, applies with backup evidence, and reports known/inferred/unknown history idempotently', async () => {
    if (!harness) throw new Error('Postgres test harness is unavailable');
    const { databaseUrl } = await harness.createDatabase();
    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'model-usage-migration-certification',
      allowExitOnIdle: true,
      max: 1,
    });

    try {
      await createLegacyModelUsageTable(pool);
      await insertLegacyEvidenceCorpus(pool);

      const dryRun = await certifyModelUsageMigrations(pool, { mode: 'dry-run' });
      expect(dryRun).toMatchObject({
        mode: 'dry-run',
        backupReference: null,
        transaction: 'rolled_back',
        rollbackVerified: true,
        evidence: {
          historicalRows: 6,
          cost: { known: 1, inferred: 1, unknown: 4 },
          tokenTotals: { known: 4, inferred: 1, unknown: 1 },
          quarantinedNonUsdRows: 1,
        },
      });
      expect(dryRun.evidence.attribution.channelId).toEqual({
        known: 1,
        inferred: 0,
        unknown: 5,
      });

      const rolledBackColumns = await pool.query<{ column_name: string }>(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'model_usage_events'
          AND column_name = 'accounting_schema_version'
      `);
      expect(rolledBackColumns.rows).toEqual([]);
      expect(await pool.query('SELECT COUNT(*)::integer AS count FROM model_usage_events'))
        .toMatchObject({ rows: [{ count: 6 }] });

      await expect(certifyModelUsageMigrations(pool, { mode: 'apply' }))
        .rejects.toThrow('backup reference');

      const applied = await certifyModelUsageMigrations(pool, {
        mode: 'apply',
        backupReference: 'local-test-backup:model-usage-before-cam6',
      });
      expect(applied).toMatchObject({
        mode: 'apply',
        backupReference: 'local-test-backup:model-usage-before-cam6',
        transaction: 'committed',
        rollbackVerified: false,
        evidence: dryRun.evidence,
      });

      const beforeRerun = await inspectModelUsageMigrationEvidence(pool);
      const rerun = await certifyModelUsageMigrations(pool, {
        mode: 'apply',
        backupReference: 'local-test-backup:model-usage-before-cam6',
      });
      expect(rerun.evidence).toEqual(beforeRerun);
      expect(await inspectModelUsageMigrationEvidence(pool)).toEqual(beforeRerun);
    } finally {
      await pool.end();
    }
  }, INTEGRATION_TIMEOUT_MS);
});
