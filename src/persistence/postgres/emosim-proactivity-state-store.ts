import type { Pool, QueryResultRow } from 'pg';

import type {
  EmoSimProactivityState,
  EmoSimProactivityStateStorePort,
} from '../../core/emotion/emosim-proactivity-port.js';
import { isRecord } from '../../shared/utils/types.js';
import {
  createPostgresPool,
  ensurePostgresSchema,
  ensurePostgresSchemaExists,
  queryOne,
} from '../postgres.js';
import { POSTGRES_INTENTION_MIGRATIONS } from './migrations.js';

interface ProactivityStateRow extends QueryResultRow {
  first_crossing_ms: string | number | null;
  last_fired_at_ms: string | number | null;
}

interface LegacyStateRow extends QueryResultRow {
  state_json: unknown;
}

export class PostgresEmoSimProactivityStateStore
implements EmoSimProactivityStateStorePort {
  private constructor(
    private readonly pool: Pool,
    private readonly legacySidecarId: string | undefined,
  ) {}

  static async connect(
    databaseUrl: string,
    options: { schema?: string; role?: string; legacySidecarId?: string },
  ): Promise<PostgresEmoSimProactivityStateStore> {
    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'emosim-proactivity-state',
      allowExitOnIdle: true,
      schema: options.schema,
      role: options.role,
    });
    try {
      if (options.schema) await ensurePostgresSchemaExists(pool, options.schema);
      await ensurePostgresSchema(pool, POSTGRES_INTENTION_MIGRATIONS);
      return new PostgresEmoSimProactivityStateStore(
        pool,
        options.legacySidecarId?.trim() || undefined,
      );
    } catch (error) {
      await pool.end().catch(() => undefined);
      throw error;
    }
  }

  async load(): Promise<EmoSimProactivityState> {
    const row = await queryOne<ProactivityStateRow>(this.pool, `
      SELECT first_crossing_ms, last_fired_at_ms
      FROM emosim_proactivity_state
      WHERE source_kind = 'would_message'
    `);
    if (row) return mapState(row);
    return await this.loadLegacyState();
  }

  async save(state: EmoSimProactivityState): Promise<void> {
    const normalized = normalizeState(state);
    await this.pool.query(`
      INSERT INTO emosim_proactivity_state (
        source_kind, schema_version, first_crossing_ms, last_fired_at_ms, updated_at_ms
      ) VALUES ('would_message', 1, $1, $2, $3)
      ON CONFLICT (source_kind) DO UPDATE SET
        first_crossing_ms = excluded.first_crossing_ms,
        last_fired_at_ms = excluded.last_fired_at_ms,
        updated_at_ms = excluded.updated_at_ms
    `, [normalized.firstCrossingMs, normalized.lastFiredAtMs, Date.now()]);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async loadLegacyState(): Promise<EmoSimProactivityState> {
    if (!this.legacySidecarId) return emptyState();
    let row: LegacyStateRow | undefined;
    try {
      row = await queryOne<LegacyStateRow>(this.pool, `
        SELECT state_json
        FROM observer_eval_sidecar_lever_state
        WHERE sidecar_id = $1 AND lever = 'would_message'
      `, [this.legacySidecarId]);
    } catch (error) {
      if (isRecord(error) && error.code === '42P01') return emptyState();
      throw error;
    }
    if (!row) return emptyState();
    const state = typeof row.state_json === 'string'
      ? JSON.parse(row.state_json) as unknown
      : row.state_json;
    return parseLegacyEmoSimProactivityState(state);
  }
}

function mapState(row: ProactivityStateRow): EmoSimProactivityState {
  return normalizeState({
    firstCrossingMs: toNullableNumber(row.first_crossing_ms),
    lastFiredAtMs: toNullableNumber(row.last_fired_at_ms),
  });
}

function normalizeState(state: EmoSimProactivityState): EmoSimProactivityState {
  return {
    firstCrossingMs: requireNullableTimestamp(state.firstCrossingMs, 'firstCrossingMs'),
    lastFiredAtMs: requireNullableTimestamp(state.lastFiredAtMs, 'lastFiredAtMs'),
  };
}

function toNullableNumber(value: string | number | null): number | null {
  return value === null ? null : Number(value);
}

function requireNullableTimestamp(value: number | null, field: string): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Persisted EmoSim proactivity ${field} is invalid`);
  }
  return value;
}

function emptyState(): EmoSimProactivityState {
  return { firstCrossingMs: null, lastFiredAtMs: null };
}

export function parseLegacyEmoSimProactivityState(value: unknown): EmoSimProactivityState {
  if (!isRecord(value)) {
    throw new Error('Legacy EmoSim proactivity crossing state is malformed');
  }
  return normalizeState({
    firstCrossingMs: value.firstCrossingMs as number | null,
    lastFiredAtMs: value.lastFiredAtMs as number | null,
  });
}
