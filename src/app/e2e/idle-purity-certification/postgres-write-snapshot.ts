import { escapeIdentifier, type Pool, type QueryResultRow } from 'pg';

import type { PostgresWriteSnapshot } from './certification.js';

interface PostgresWriteCounterRow extends QueryResultRow {
  readonly deleted: string;
  readonly inserted: string;
  readonly relation_name: string;
  readonly schema_name: string;
  readonly updated: string;
}

interface PostgresRelationFingerprintRow extends QueryResultRow {
  readonly row_count: string;
  readonly row_fingerprint: string;
}

interface PostgresSequenceStateRow extends QueryResultRow {
  readonly last_value: string | null;
  readonly relation_name: string;
  readonly schema_name: string;
}

/**
 * Capture tuple-write counters and a direct MVCC fingerprint for every
 * non-system relation in one repeatable-read snapshot. The fingerprint catches
 * durable changes whose counters have not been published yet; the counters
 * independently retain evidence of net-zero insert/delete activity. These reads
 * do not write application state, so the observer cannot make its own
 * certification fail.
 */
export async function capturePostgresWriteSnapshot(
  pool: Pool,
): Promise<PostgresWriteSnapshot> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result = await client.query<PostgresWriteCounterRow>(`
      SELECT
        schemaname::text AS schema_name,
        relname::text AS relation_name,
        n_tup_ins::text AS inserted,
        n_tup_upd::text AS updated,
        n_tup_del::text AS deleted
      FROM pg_stat_user_tables
      ORDER BY schemaname, relname
    `);
    const snapshot: Record<string, PostgresWriteSnapshot[string]> = {};
    for (const row of result.rows) {
      const qualifiedRelation = `${escapeIdentifier(row.schema_name)}.`
        + escapeIdentifier(row.relation_name);
      const fingerprint = await client.query<PostgresRelationFingerprintRow>(`
        SELECT
          COUNT(*)::text AS row_count,
          COALESCE(
            md5(string_agg(hashed.row_digest, '' ORDER BY hashed.row_digest)),
            md5('')
          ) AS row_fingerprint
        FROM (
          SELECT md5(
            to_jsonb(row_value)::text || ':'
            || row_value.xmin::text || ':'
            || row_value.ctid::text
          ) AS row_digest
          FROM ${qualifiedRelation} AS row_value
        ) AS hashed
      `);
      const physicalState = fingerprint.rows.at(0);
      if (!physicalState) {
        throw new Error(`PostgreSQL relation fingerprint is missing for ${row.schema_name}.${row.relation_name}`);
      }
      snapshot[`${row.schema_name}.${row.relation_name}`] = {
        deleted: row.deleted,
        inserted: row.inserted,
        rowCount: physicalState.row_count,
        rowFingerprint: physicalState.row_fingerprint,
        updated: row.updated,
      };
    }
    const sequences = await client.query<PostgresSequenceStateRow>(`
      SELECT
        schemaname::text AS schema_name,
        sequencename::text AS relation_name,
        last_value::text
      FROM pg_sequences
      WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
      ORDER BY schemaname, sequencename
    `);
    for (const sequence of sequences.rows) {
      const key = `${sequence.schema_name}.${sequence.relation_name}`;
      if (snapshot[key]) {
        throw new Error(`PostgreSQL relation snapshot key is ambiguous: ${key}`);
      }
      snapshot[key] = {
        deleted: '0',
        inserted: '0',
        rowCount: '1',
        rowFingerprint: `sequence:${sequence.last_value ?? 'unused'}`,
        updated: '0',
      };
    }
    await client.query('COMMIT');
    return snapshot;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
