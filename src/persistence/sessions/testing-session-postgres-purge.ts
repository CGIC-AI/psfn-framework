import type { Pool, PoolClient } from 'pg';
import { withPostgresClient } from '../postgres.js';

export interface SessionDatabasePurgeInput {
  sessionId: string;
  channelId: string;
}

export interface SessionDatabasePurgeReport {
  removedProjectionRows: number;
  removedMemoryRows: number;
  removedContactProfileRows: number;
  removedMemoryLinkRows: number;
  removedMaintenanceReviewRows: number;
}

export interface SessionDatabasePurgePort {
  purgeSession(input: SessionDatabasePurgeInput): Promise<SessionDatabasePurgeReport>;
}

interface DurableMemoryTableAvailability {
  memories: string | null;
  profiles: string | null;
}

async function resolveDurableMemoryTables(
  client: PoolClient,
): Promise<DurableMemoryTableAvailability> {
  const result = await client.query<DurableMemoryTableAvailability>(`
    SELECT
      to_regclass('l2_memories')::text AS memories,
      to_regclass('contact_profiles')::text AS profiles
  `);
  return result.rows[0] ?? { memories: null, profiles: null };
}

/**
 * Atomically remove the transcript projection and every durable memory row
 * carrying the exact logical session id. Contact profiles are derived
 * artifacts, so a profile referencing any removed memory is removed as a
 * whole instead of retaining a summary synthesized from testing content.
 */
export async function purgeTestingSessionPostgresData(
  pool: Pool,
  input: SessionDatabasePurgeInput,
): Promise<SessionDatabasePurgeReport> {
  return await withPostgresClient(pool, async (client) => {
    const tables = await resolveDurableMemoryTables(client);
    if (Boolean(tables.memories) !== Boolean(tables.profiles)) {
      throw new Error(
        'Session purge found an incomplete durable-memory schema; '
        + 'l2_memories and contact_profiles must either both exist or both be absent',
      );
    }

    let removedMemoryRows = 0;
    let removedContactProfileRows = 0;
    let removedMemoryLinkRows = 0;
    let removedMaintenanceReviewRows = 0;
    if (tables.memories && tables.profiles) {
      const memoryIdsResult = await client.query<{ id: string }>(`
        SELECT id
        FROM l2_memories
        WHERE provenance_json->>'sessionId' = $1
        ORDER BY id
      `, [input.sessionId]);
      const memoryIds = memoryIdsResult.rows.map(row => row.id);
      if (memoryIds.length > 0) {
        const profiles = await client.query(`
          DELETE FROM contact_profiles AS profile
          WHERE EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(profile.source_memory_ids) AS source_memory_id
            WHERE source_memory_id = ANY($1::text[])
          )
        `, [memoryIds]);
        removedContactProfileRows = profiles.rowCount ?? 0;

        const memoryLinks = await client.query(`
          DELETE FROM memory_links
          WHERE id1 = ANY($1::text[]) OR id2 = ANY($1::text[])
        `, [memoryIds]);
        removedMemoryLinkRows = memoryLinks.rowCount ?? 0;

        const maintenanceReviews = await client.query(`
          DELETE FROM l2_memory_maintenance_reviews
          WHERE subject_memory_id = ANY($1::text[])
            OR candidate_memory_ids ?| $1::text[]
        `, [memoryIds]);
        removedMaintenanceReviewRows = maintenanceReviews.rowCount ?? 0;

        const memories = await client.query(`
          DELETE FROM l2_memories
          WHERE id = ANY($1::text[])
        `, [memoryIds]);
        removedMemoryRows = memories.rowCount ?? 0;
      }
    }

    const projection = await client.query(`
      DELETE FROM session_messages_projection
      WHERE channel_id = $1
    `, [input.channelId]);
    const drift = await client.query(`
      DELETE FROM session_projection_drift
      WHERE channel_id = $1
    `, [input.channelId]);

    return {
      removedProjectionRows: (projection.rowCount ?? 0) + (drift.rowCount ?? 0),
      removedMemoryRows,
      removedContactProfileRows,
      removedMemoryLinkRows,
      removedMaintenanceReviewRows,
    };
  });
}
