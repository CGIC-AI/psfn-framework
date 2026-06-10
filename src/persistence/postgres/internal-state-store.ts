import type { Pool } from 'pg';
import {
  createPostgresPool,
  ensurePostgresSchema,
  executeQuery,
  queryOne,
} from '../postgres.js';
import { POSTGRES_INTERNAL_STATE_MIGRATIONS } from './migrations.js';
import {
  normalizePersistedInternalStateRecord,
  type InternalStateStorePort,
  type PersistedInternalStateRecord,
} from '../../core/self-model/internal-state-persistence.js';

const CURRENT_SNAPSHOT_ID = 'current';

/**
 * Single-row store for the companion's running internal state. The row is
 * upserted on every turn so a restart can rehydrate from where she left off;
 * history is not kept here (reflections already record snapshot refs).
 */
export class PostgresInternalStateStore implements InternalStateStorePort {
  private constructor(private readonly pool: Pool) {}

  static async connect(databaseUrl: string): Promise<PostgresInternalStateStore> {
    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-internal-state',
      allowExitOnIdle: true,
    });
    await ensurePostgresSchema(pool, POSTGRES_INTERNAL_STATE_MIGRATIONS);
    return new PostgresInternalStateStore(pool);
  }

  async save(record: PersistedInternalStateRecord): Promise<void> {
    const normalized = normalizePersistedInternalStateRecord(record);
    await executeQuery(this.pool, `
      INSERT INTO internal_state_snapshots (id, state, snapshot_ref, metacognitive_flags, saved_at)
      VALUES ($1, $2::jsonb, $3, $4::jsonb, $5)
      ON CONFLICT (id) DO UPDATE SET
        state = excluded.state,
        snapshot_ref = excluded.snapshot_ref,
        metacognitive_flags = excluded.metacognitive_flags,
        saved_at = excluded.saved_at
    `, [
      CURRENT_SNAPSHOT_ID,
      JSON.stringify(normalized.state),
      normalized.snapshotRef,
      JSON.stringify(normalized.metacognitiveFlags),
      normalized.savedAt,
    ]);
  }

  async loadLatest(): Promise<PersistedInternalStateRecord | null> {
    const row = await queryOne<{
      state: unknown;
      snapshot_ref: string;
      metacognitive_flags: unknown;
      saved_at: string;
    }>(this.pool, `
      SELECT state, snapshot_ref, metacognitive_flags, saved_at
      FROM internal_state_snapshots
      WHERE id = $1
    `, [CURRENT_SNAPSHOT_ID]);

    if (!row) return null;

    try {
      return normalizePersistedInternalStateRecord({
        state: row.state as PersistedInternalStateRecord['state'],
        snapshotRef: row.snapshot_ref,
        metacognitiveFlags: row.metacognitive_flags as PersistedInternalStateRecord['metacognitiveFlags'],
        savedAt: row.saved_at,
      });
    } catch (error) {
      throw new Error(
        `Persisted internal state in Postgres is corrupt and cannot be rehydrated: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
