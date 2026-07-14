import type { Pool, PoolClient, QueryResultRow } from 'pg';

import {
  POSTGRES_MODEL_USAGE_MIGRATION_ADVISORY_LOCK,
  POSTGRES_MODEL_USAGE_MIGRATIONS,
} from './migrations.js';

const MODEL_USAGE_ATTRIBUTION_COLUMNS = {
  companionId: 'companion_id',
  sessionId: 'session_id',
  channelId: 'channel_id',
  channelType: 'channel_type',
  originType: 'origin_type',
  originStage: 'origin_stage',
  service: 'service',
  process: 'process',
  turnId: 'turn_id',
  requestId: 'request_id',
  toolName: 'tool_name',
  toolCallId: 'tool_call_id',
  chargeLane: 'charge_lane',
  chargeSurface: 'charge_surface',
  chargeEventId: 'charge_event_id',
  chargeRunId: 'charge_run_id',
  chargeRootRunId: 'charge_root_run_id',
  chargeParentRunId: 'charge_parent_run_id',
  shardId: 'shard_id',
  subagentId: 'subagent_id',
  conversationId: 'conversation_id',
  rootInitiationId: 'root_initiation_id',
  workloadType: 'workload_type',
  workloadId: 'workload_id',
  slotKey: 'slot_key',
  requestedProvider: 'requested_provider',
  requestedModel: 'requested_model',
} as const;

export type ModelUsageHistoricalAttributionField = keyof typeof MODEL_USAGE_ATTRIBUTION_COLUMNS;

export interface ModelUsageEvidenceCounts {
  known: number;
  inferred: number;
  unknown: number;
}

export interface ModelUsageMigrationEvidenceReport {
  historicalRows: number;
  cost: ModelUsageEvidenceCounts;
  tokenTotals: ModelUsageEvidenceCounts;
  attribution: Record<ModelUsageHistoricalAttributionField, ModelUsageEvidenceCounts>;
  quarantinedNonUsdRows: number;
}

export interface ModelUsageMigrationCertificationReport {
  mode: 'dry-run' | 'apply';
  backupReference: string | null;
  transaction: 'rolled_back' | 'committed';
  rollbackVerified: boolean;
  schemaChanged: boolean;
  evidence: ModelUsageMigrationEvidenceReport;
}

interface QueryExecutor {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

interface MigrationStateSnapshot {
  tableExists: boolean;
  schemaSignature: string | null;
  rowCount: number;
  rowSignature: string | null;
}

interface EvidenceRow {
  historical_rows: string | number;
  provider_cost_rows: string | number;
  estimated_cost_rows: string | number;
  unknown_cost_rows: string | number;
  known_token_rows: string | number;
  inferred_token_rows: string | number;
  unknown_token_rows: string | number;
  quarantined_non_usd_rows: string | number;
}

function count(value: string | number | undefined): number {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid model-usage certification count: ${String(value)}`);
  }
  return parsed;
}

function emptyEvidenceCounts(): ModelUsageEvidenceCounts {
  return { known: 0, inferred: 0, unknown: 0 };
}

function emptyEvidenceReport(): ModelUsageMigrationEvidenceReport {
  return {
    historicalRows: 0,
    cost: emptyEvidenceCounts(),
    tokenTotals: emptyEvidenceCounts(),
    attribution: Object.fromEntries(
      Object.keys(MODEL_USAGE_ATTRIBUTION_COLUMNS).map(field => [field, emptyEvidenceCounts()]),
    ) as Record<ModelUsageHistoricalAttributionField, ModelUsageEvidenceCounts>,
    quarantinedNonUsdRows: 0,
  };
}

async function modelUsageTableExists(executor: QueryExecutor): Promise<boolean> {
  const result = await executor.query<{ exists: boolean }>(`
    SELECT to_regclass(current_schema() || '.model_usage_events') IS NOT NULL AS exists
  `);
  return result.rows[0]?.exists === true;
}

async function snapshotMigrationState(executor: QueryExecutor): Promise<MigrationStateSnapshot> {
  if (!await modelUsageTableExists(executor)) {
    return {
      tableExists: false,
      schemaSignature: null,
      rowCount: 0,
      rowSignature: null,
    };
  }

  const schema = await executor.query<{ signature: string | null }>(`
    SELECT md5(COALESCE(string_agg(
      column_name || ':' || data_type || ':' || is_nullable || ':' || COALESCE(column_default, ''),
      ',' ORDER BY ordinal_position
    ), '')) AS signature
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'model_usage_events'
  `);
  const rows = await executor.query<{
    row_count: string | number;
    signature: string | null;
  }>(`
    SELECT COUNT(*) AS row_count,
           md5(COALESCE(string_agg(md5(to_jsonb(event_row)::text), '' ORDER BY id), '')) AS signature
    FROM model_usage_events AS event_row
  `);
  return {
    tableExists: true,
    schemaSignature: schema.rows[0]?.signature ?? null,
    rowCount: count(rows.rows[0]?.row_count),
    rowSignature: rows.rows[0]?.signature ?? null,
  };
}

function snapshotsEqual(left: MigrationStateSnapshot, right: MigrationStateSnapshot): boolean {
  return left.tableExists === right.tableExists
    && left.schemaSignature === right.schemaSignature
    && left.rowCount === right.rowCount
    && left.rowSignature === right.rowSignature;
}

async function inspectEvidence(executor: QueryExecutor): Promise<ModelUsageMigrationEvidenceReport> {
  if (!await modelUsageTableExists(executor)) return emptyEvidenceReport();

  const evidence = await executor.query<EvidenceRow>(`
    SELECT
      COUNT(*) AS historical_rows,
      COUNT(*) FILTER (WHERE cost_source = 'provider') AS provider_cost_rows,
      COUNT(*) FILTER (WHERE cost_source = 'estimate') AS estimated_cost_rows,
      COUNT(*) FILTER (WHERE cost_source = 'none') AS unknown_cost_rows,
      COUNT(*) FILTER (
        WHERE NOT COALESCE(metadata_json -> '_accountingMigration' ? 'legacyTotalTokens', FALSE)
          AND (input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) > 0
      ) AS known_token_rows,
      COUNT(*) FILTER (
        WHERE COALESCE(metadata_json -> '_accountingMigration' ? 'legacyTotalTokens', FALSE)
      ) AS inferred_token_rows,
      COUNT(*) FILTER (
        WHERE NOT COALESCE(metadata_json -> '_accountingMigration' ? 'legacyTotalTokens', FALSE)
          AND (input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) = 0
      ) AS unknown_token_rows,
      COUNT(*) FILTER (
        WHERE metadata_json -> '_accountingMigration' ->> 'nonUsdCostQuarantined' = 'true'
      ) AS quarantined_non_usd_rows
    FROM model_usage_events
    WHERE event_fingerprint LIKE 'legacy:%'
  `);
  const row = evidence.rows[0];
  if (!row) return emptyEvidenceReport();

  const historicalRows = count(row.historical_rows);
  const attributionEntries: Array<readonly [string, ModelUsageEvidenceCounts]> = [];
  for (const [field, column] of Object.entries(MODEL_USAGE_ATTRIBUTION_COLUMNS)) {
    const result = await executor.query<{
      known: string | number;
      unknown: string | number;
    }>(`
      SELECT
        COUNT(*) FILTER (
          WHERE ${column} IS NOT NULL
            AND BTRIM(${column}) <> ''
            AND ${column} <> 'unknown'
        ) AS known,
        COUNT(*) FILTER (
          WHERE ${column} IS NULL
            OR BTRIM(${column}) = ''
            OR ${column} = 'unknown'
        ) AS unknown
      FROM model_usage_events
      WHERE event_fingerprint LIKE 'legacy:%'
    `);
    attributionEntries.push([field, {
      known: count(result.rows[0]?.known),
      inferred: 0,
      unknown: count(result.rows[0]?.unknown),
    }]);
  }

  return {
    historicalRows,
    cost: {
      known: count(row.provider_cost_rows),
      inferred: count(row.estimated_cost_rows),
      unknown: count(row.unknown_cost_rows),
    },
    tokenTotals: {
      known: count(row.known_token_rows),
      inferred: count(row.inferred_token_rows),
      unknown: count(row.unknown_token_rows),
    },
    attribution: Object.fromEntries(attributionEntries) as Record<
      ModelUsageHistoricalAttributionField,
      ModelUsageEvidenceCounts
    >,
    quarantinedNonUsdRows: count(row.quarantined_non_usd_rows),
  };
}

export async function inspectModelUsageMigrationEvidence(
  pool: Pool,
): Promise<ModelUsageMigrationEvidenceReport> {
  return await inspectEvidence(pool as QueryExecutor);
}

function normalizeBackupReference(value: string | undefined): string | null {
  if (value === undefined) return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > 512 || /[\u0000-\u001F\u007F-\u009F]/u.test(normalized)) {
    throw new Error('Model-usage migration backup reference must be a non-empty printable string of at most 512 characters');
  }
  return normalized;
}

async function runCanonicalMigrations(client: PoolClient): Promise<void> {
  const [namespaceKey, migrationKey] = POSTGRES_MODEL_USAGE_MIGRATION_ADVISORY_LOCK;
  await client.query('SELECT pg_advisory_xact_lock($1::integer, $2::integer)', [
    namespaceKey,
    migrationKey,
  ]);
  for (const statement of POSTGRES_MODEL_USAGE_MIGRATIONS) {
    await client.query(statement);
  }
}

export async function certifyModelUsageMigrations(
  pool: Pool,
  options: {
    mode: 'dry-run' | 'apply';
    backupReference?: string;
  },
): Promise<ModelUsageMigrationCertificationReport> {
  const backupReference = normalizeBackupReference(options.backupReference);
  if (options.mode === 'apply' && backupReference === null) {
    throw new Error('Applying model-usage migrations requires a verified backup reference');
  }

  const client = await pool.connect();
  let transactionOpen = false;
  let before: MigrationStateSnapshot;
  let migrated: MigrationStateSnapshot;
  let evidence: ModelUsageMigrationEvidenceReport;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    before = await snapshotMigrationState(client as QueryExecutor);
    await runCanonicalMigrations(client);
    evidence = await inspectEvidence(client as QueryExecutor);
    migrated = await snapshotMigrationState(client as QueryExecutor);

    if (options.mode === 'dry-run') {
      await client.query('ROLLBACK');
    } else {
      await client.query('COMMIT');
    }
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  if (options.mode === 'dry-run') {
    const rolledBack = await snapshotMigrationState(pool as QueryExecutor);
    if (!snapshotsEqual(before, rolledBack)) {
      throw new Error('Model-usage migration dry-run rollback did not restore the original schema and rows');
    }
    return {
      mode: options.mode,
      backupReference,
      transaction: 'rolled_back',
      rollbackVerified: true,
      schemaChanged: !snapshotsEqual(before, migrated),
      evidence,
    };
  }

  return {
    mode: options.mode,
    backupReference,
    transaction: 'committed',
    rollbackVerified: false,
    schemaChanged: !snapshotsEqual(before, migrated),
    evidence,
  };
}
