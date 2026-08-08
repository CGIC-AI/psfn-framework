import type { PoolClient } from 'pg';

/**
 * Contact identity changes invalidate every projection that names the old
 * contact. The memory evidence itself is deliberately not rewritten: a later
 * bounded backfill must classify the repaired provenance instead of guessing.
 */
export async function invalidateMemorySubjectsForContact(
  client: PoolClient,
  contactId: string,
): Promise<void> {
  const tables = await client.query<{ classifications: string | null; contacts: string | null }>(`
    SELECT
      to_regclass('l2_memory_subject_classifications')::text AS classifications,
      to_regclass('l2_memory_subject_contacts')::text AS contacts
  `);
  const firstRow = tables.rows[0];
  if (firstRow === undefined || !firstRow.classifications || !firstRow.contacts) return;
  await client.query(`
    WITH affected AS (
      SELECT memory_id
      FROM l2_memory_subject_contacts
      WHERE contact_id = $1
    )
    UPDATE l2_memories memory
    SET authorization_revision = memory.authorization_revision + 1,
        subject_evidence_digest = NULL
    FROM affected
    WHERE memory.id = affected.memory_id
  `, [contactId]);
  await client.query(`
    UPDATE l2_memory_subject_classifications classification
    SET status = 'invalidated',
        updated_at = (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT
    WHERE EXISTS (
      SELECT 1
      FROM l2_memory_subject_contacts subject_contact
      WHERE subject_contact.memory_id = classification.memory_id
        AND subject_contact.contact_id = $1
    )
  `, [contactId]);
  const checkpoints = await client.query<{ table_name: string | null }>(
    "SELECT to_regclass('l2_memory_subject_backfill_checkpoints')::text AS table_name",
  );
  if (checkpoints.rows[0]?.table_name) {
    await client.query(`
      UPDATE l2_memory_subject_backfill_checkpoints
      SET cursor_memory_id = NULL, completed = FALSE, processed_count = 0,
          updated_at = (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT
    `);
  }
}
