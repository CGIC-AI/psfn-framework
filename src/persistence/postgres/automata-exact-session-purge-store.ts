import type { QueryResultRow } from 'pg';
import {
  parseExactSessionPurgeSagaRecord,
  type ExactSessionPurgeSagaRecord,
  type ExactSessionPurgeSagaStorePort,
} from '../../faculties/automata/production-exact-session-purge.js';

export const AUTOMATA_EXACT_SESSION_PURGE_POSTGRES_RELATIONS = [
  'automata_exact_session_purge_sagas',
] as const;

export const AUTOMATA_EXACT_SESSION_PURGE_POSTGRES_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS automata_exact_session_purge_sagas (
    companion_id TEXT NOT NULL CHECK (length(btrim(companion_id)) > 0),
    session_id TEXT NOT NULL CHECK (length(btrim(session_id)) > 0),
    run_id TEXT NOT NULL CHECK (length(btrim(run_id)) > 0),
    target_revision TEXT NOT NULL CHECK (length(btrim(target_revision)) > 0),
    saga_revision BIGINT NOT NULL CHECK (saga_revision > 0),
    saga_status TEXT NOT NULL CHECK (saga_status IN ('in_progress', 'completed')),
    saga_json JSONB NOT NULL CHECK (jsonb_typeof(saga_json) = 'object'),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (companion_id, session_id),
    FOREIGN KEY (companion_id, session_id)
      REFERENCES automata_session_classifications (companion_id, session_id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CHECK (saga_json ->> 'companionId' = companion_id),
    CHECK (saga_json ->> 'sessionId' = session_id),
    CHECK (saga_json ->> 'runId' = run_id),
    CHECK (saga_json ->> 'targetRevision' = target_revision),
    CHECK ((saga_json ->> 'revision')::bigint = saga_revision),
    CHECK (saga_json ->> 'status' = saga_status),
    CHECK (saga_json #>> '{target,classification,ownership}' = 'automata'),
    CHECK (saga_json -> 'surfaces' ?& ARRAY[
      'journals', 'journal_rolls', 'channel_index', 'transcript_projection',
      'turn_records', 'redis_tail_pointers'
    ]),
    CHECK (jsonb_object_length(saga_json -> 'surfaces') = 6)
  )`,
  `CREATE INDEX IF NOT EXISTS automata_exact_session_purge_in_progress_idx
    ON automata_exact_session_purge_sagas (companion_id, updated_at, session_id)
    WHERE saga_status = 'in_progress'`,
] as const;

export const AUTOMATA_EXACT_SESSION_PURGE_POSTGRES_ROLLBACK_STATEMENTS = [
  'DROP TABLE IF EXISTS automata_exact_session_purge_sagas',
] as const;

interface SagaRow extends QueryResultRow {
  saga_json: unknown;
  saga_revision: number | string;
}

export interface ExactSessionPurgeSagaSqlPool {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

function rowRevision(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error('Exact-session purge Postgres saga revision is invalid');
  }
  return parsed;
}

/** Companion-scoped durable CAS store for restartable forward recovery. */
export class PostgresExactSessionPurgeSagaStore implements ExactSessionPurgeSagaStorePort {
  constructor(
    private readonly pool: ExactSessionPurgeSagaSqlPool,
    private readonly companionId: string,
  ) {
    if (!companionId.trim()) throw new Error('Exact-session purge saga companionId is required');
  }

  async load(companionId: string, sessionId: string): Promise<ExactSessionPurgeSagaRecord | null> {
    this.assertCompanion(companionId);
    const result = await this.pool.query<SagaRow>(`
      SELECT saga_json, saga_revision
      FROM automata_exact_session_purge_sagas
      WHERE companion_id = $1 AND session_id = $2
    `, [this.companionId, sessionId]);
    const row = result.rows[0];
    if (!row) return null;
    const saga = parseExactSessionPurgeSagaRecord(row.saga_json);
    if (saga.revision !== rowRevision(row.saga_revision)) {
      throw new Error('Exact-session purge Postgres saga revision columns disagree');
    }
    this.assertCompanion(saga.companionId);
    return saga;
  }

  async create(record: ExactSessionPurgeSagaRecord): Promise<void> {
    this.assertCompanion(record.companionId);
    const saga = parseExactSessionPurgeSagaRecord(record);
    const result = await this.pool.query(`
      INSERT INTO automata_exact_session_purge_sagas (
        companion_id, session_id, run_id, target_revision,
        saga_revision, saga_status, saga_json
      ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
      ON CONFLICT (companion_id, session_id) DO NOTHING
    `, [
      saga.companionId,
      saga.sessionId,
      saga.runId,
      saga.targetRevision,
      saga.revision,
      saga.status,
      JSON.stringify(saga),
    ]);
    if (result.rowCount !== 1) throw new Error('Exact-session purge saga already exists');
  }

  async update(record: ExactSessionPurgeSagaRecord, previousRevision: number): Promise<void> {
    this.assertCompanion(record.companionId);
    const saga = parseExactSessionPurgeSagaRecord(record);
    const result = await this.pool.query(`
      UPDATE automata_exact_session_purge_sagas SET
        run_id = $3,
        target_revision = $4,
        saga_revision = $5,
        saga_status = $6,
        saga_json = $7::jsonb,
        updated_at = CURRENT_TIMESTAMP
      WHERE companion_id = $1 AND session_id = $2 AND saga_revision = $8
    `, [
      saga.companionId,
      saga.sessionId,
      saga.runId,
      saga.targetRevision,
      saga.revision,
      saga.status,
      JSON.stringify(saga),
      previousRevision,
    ]);
    if (result.rowCount !== 1) {
      throw new Error('Exact-session purge saga changed concurrently');
    }
  }

  private assertCompanion(companionId: string): void {
    if (companionId !== this.companionId) {
      throw new Error('Exact-session purge saga store companion scope mismatch');
    }
  }
}
