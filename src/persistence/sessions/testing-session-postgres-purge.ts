import type { Pool, PoolClient } from 'pg';
import { withPostgresClient } from '../postgres.js';

export interface SessionDatabasePurgeInput {
  sessionId: string;
  channelId: string;
}

export interface SessionDatabasePurgeReport {
  removedProjectionRows: number;
  removedMemoryRows: number;
  removedRecentContactShapeRows: number;
  removedMemoryLinkRows: number;
  removedMaintenanceReviewRows: number;
}

export interface SessionDatabasePurgePort {
  purgeSession(input: SessionDatabasePurgeInput): Promise<SessionDatabasePurgeReport>;
}

interface DurableMemoryTableAvailability {
  memories: string | null;
  recentContactShapes: string | null;
}

async function resolveDurableMemoryTables(
  client: PoolClient,
): Promise<DurableMemoryTableAvailability> {
  const result = await client.query<DurableMemoryTableAvailability>(`
    SELECT
      to_regclass('l2_memories')::text AS memories,
      to_regclass('recent_contact_shapes')::text AS "recentContactShapes"
  `);
  return result.rows[0] ?? { memories: null, recentContactShapes: null };
}

/**
 * Atomically remove the transcript projection and every durable memory row
 * carrying the exact logical session id. Recent Contact Shapes are derived
 * artifacts, so a shape referencing any removed memory is removed as a
 * whole instead of retaining a summary synthesized from testing content.
 */
export async function purgeTestingSessionPostgresData(
  pool: Pool,
  input: SessionDatabasePurgeInput,
): Promise<SessionDatabasePurgeReport> {
  return await withPostgresClient(pool, async (client) => {
    const tables = await resolveDurableMemoryTables(client);
    if (Boolean(tables.memories) !== Boolean(tables.recentContactShapes)) {
      throw new Error(
        'Session purge found an incomplete durable-memory schema; '
        + 'l2_memories and recent_contact_shapes must either both exist or both be absent',
      );
    }

    let removedMemoryRows = 0;
    let removedRecentContactShapeRows = 0;
    let removedMemoryLinkRows = 0;
    let removedMaintenanceReviewRows = 0;
    if (tables.memories && tables.recentContactShapes) {
      const memoryIdsResult = await client.query<{ id: string }>(`
        SELECT id
        FROM l2_memories
        WHERE provenance_json->>'sessionId' = $1
        ORDER BY id
      `, [input.sessionId]);
      const memoryIds = memoryIdsResult.rows.map(row => row.id);
      if (memoryIds.length > 0) {
        const shapes = await client.query(`
          DELETE FROM recent_contact_shapes AS shape
          WHERE EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(shape.source_memory_ids) AS source_memory_id
            WHERE source_memory_id = ANY($1::text[])
          )
        `, [memoryIds]);
        removedRecentContactShapeRows = shapes.rowCount ?? 0;

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
    const activity = await client.query(`
      DELETE FROM session_conversational_activity
      WHERE logical_session_id = $1
    `, [input.channelId]);
    const workset = await client.query(`
      DELETE FROM session_conversational_workset
      WHERE logical_session_id = $1
    `, [input.channelId]);
    const drift = await client.query(`
      DELETE FROM session_projection_drift
      WHERE channel_id = $1
    `, [input.channelId]);

    return {
      removedProjectionRows: (projection.rowCount ?? 0)
        + (activity.rowCount ?? 0)
        + (workset.rowCount ?? 0)
        + (drift.rowCount ?? 0),
      removedMemoryRows,
      removedRecentContactShapeRows,
      removedMemoryLinkRows,
      removedMaintenanceReviewRows,
    };
  });
}
