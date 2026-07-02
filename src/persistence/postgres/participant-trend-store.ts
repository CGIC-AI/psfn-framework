import type { Pool } from 'pg';
import {
  createPostgresPool,
  ensurePostgresSchema,
  executeQuery,
  queryRows,
} from '../postgres.js';
import { POSTGRES_PARTICIPANT_TREND_MIGRATIONS } from './migrations.js';
import {
  normalizePersistedParticipantTrend,
  type ParticipantTrendStorePort,
  type PersistedParticipantTrend,
} from '../../core/emotion/participant-trend-persistence.js';

/**
 * Per-participant room emotion trend store (bead E6.3). One row per
 * (room, participant); upserted as a participant's own trend moves and loaded
 * lazily per room on first touch. Follows the runtime-store pattern used by
 * PostgresInternalStateStore so trends survive restart instead of dying with
 * an in-memory accumulator.
 */
export class PostgresParticipantTrendStore implements ParticipantTrendStorePort {
  private constructor(private readonly pool: Pool) {}

  static async connect(databaseUrl: string): Promise<PostgresParticipantTrendStore> {
    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-participant-trends',
      allowExitOnIdle: true,
    });
    await ensurePostgresSchema(pool, POSTGRES_PARTICIPANT_TREND_MIGRATIONS);
    return new PostgresParticipantTrendStore(pool);
  }

  async loadRoom(roomKey: string): Promise<PersistedParticipantTrend[]> {
    const key = roomKey.trim();
    if (!key) return [];
    const rows = await queryRows<{
      room_key: string;
      participant_key: string;
      vad: unknown;
      discrete: unknown;
      interaction_count: number;
      updated_at: string;
    }>(this.pool, `
      SELECT room_key, participant_key, vad, discrete, interaction_count, updated_at
      FROM participant_emotion_trends
      WHERE room_key = $1
      ORDER BY updated_at ASC
    `, [key]);

    return rows.map((row) => {
      try {
        return normalizePersistedParticipantTrend({
          roomKey: row.room_key,
          participantKey: row.participant_key,
          vad: row.vad as PersistedParticipantTrend['vad'],
          discrete: row.discrete as PersistedParticipantTrend['discrete'],
          interactionCount: row.interaction_count,
          updatedAt: row.updated_at,
        });
      } catch (error) {
        throw new Error(
          `Persisted participant trend for room "${key}" is corrupt and cannot be rehydrated: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    });
  }

  async saveTrend(record: PersistedParticipantTrend): Promise<void> {
    const normalized = normalizePersistedParticipantTrend(record);
    await executeQuery(this.pool, `
      INSERT INTO participant_emotion_trends
        (room_key, participant_key, vad, discrete, interaction_count, updated_at)
      VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6)
      ON CONFLICT (room_key, participant_key) DO UPDATE SET
        vad = excluded.vad,
        discrete = excluded.discrete,
        interaction_count = excluded.interaction_count,
        updated_at = excluded.updated_at
    `, [
      normalized.roomKey,
      normalized.participantKey,
      JSON.stringify(normalized.vad),
      JSON.stringify(normalized.discrete),
      normalized.interactionCount,
      normalized.updatedAt,
    ]);
  }

  async deleteTrends(roomKey: string, participantKeys: readonly string[]): Promise<void> {
    const key = roomKey.trim();
    if (!key || participantKeys.length === 0) return;
    const keys = participantKeys.map((value) => value.trim()).filter((value) => value.length > 0);
    if (keys.length === 0) return;
    await executeQuery(this.pool, `
      DELETE FROM participant_emotion_trends
      WHERE room_key = $1 AND participant_key = ANY($2::text[])
    `, [key, keys]);
  }
}
