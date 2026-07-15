import type { PoolClient } from 'pg';
import { classifyMemorySubject } from '../subject-classification.js';
import type { PurrMemory } from '../types.js';
import { serializeJsonValue } from './rows.js';

export async function persistMemorySubjectProjection(
  client: PoolClient,
  memory: PurrMemory,
  memoryRevision: number,
  embedding?: Float32Array,
  now?: number,
): Promise<ReturnType<typeof classifyMemorySubject>> {
  const provisional = classifyMemorySubject(memory, { memoryRevision, embedding, now });
  const contactTable = provisional.subjectContactIds.length > 0
    ? await client.query<{ table_name: string | null }>(
      "SELECT to_regclass('contacts')::text AS table_name",
    )
    : undefined;
  let validSubjectContactIds: ReadonlySet<string> | undefined;
  if (contactTable?.rows[0]?.table_name) {
    const rows = await client.query<{ id: string }>(
      'SELECT id FROM contacts WHERE id = ANY($1::text[])',
      [provisional.subjectContactIds],
    );
    validSubjectContactIds = new Set(rows.rows.map(row => row.id));
  }
  const classification = validSubjectContactIds === undefined
    ? provisional
    : classifyMemorySubject(memory, { memoryRevision, embedding, now, validSubjectContactIds });
  await client.query(`
    INSERT INTO l2_memory_subject_classifications (
      memory_id, subject_class, status, classifier_version, memory_revision,
      evidence_digest, evidence_json, room_id, unbound_person_label_hash,
      reason_class, classified_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT (memory_id) DO UPDATE SET
      subject_class = EXCLUDED.subject_class,
      status = EXCLUDED.status,
      classifier_version = EXCLUDED.classifier_version,
      memory_revision = EXCLUDED.memory_revision,
      evidence_digest = EXCLUDED.evidence_digest,
      evidence_json = EXCLUDED.evidence_json,
      room_id = EXCLUDED.room_id,
      unbound_person_label_hash = EXCLUDED.unbound_person_label_hash,
      reason_class = EXCLUDED.reason_class,
      classified_at = EXCLUDED.classified_at,
      updated_at = EXCLUDED.updated_at
  `, [
    classification.memoryId,
    classification.subjectClass,
    classification.status,
    classification.classifierVersion,
    classification.memoryRevision,
    classification.evidenceDigest,
    serializeJsonValue(classification.evidence),
    classification.roomId ?? null,
    classification.unboundPersonLabelHash ?? null,
    classification.reasonClass,
    classification.classifiedAt,
    classification.updatedAt,
  ]);
  await client.query(
    'DELETE FROM l2_memory_subject_contacts WHERE memory_id = $1',
    [classification.memoryId],
  );
  for (const contactId of classification.subjectContactIds) {
    await client.query(`
      INSERT INTO l2_memory_subject_contacts (memory_id, contact_id)
      VALUES ($1, $2)
    `, [classification.memoryId, contactId]);
  }
  const updated = await client.query<{ id: string }>(`
    UPDATE l2_memories
    SET subject_evidence_digest = $2
    WHERE id = $1 AND authorization_revision = $3
    RETURNING id
  `, [classification.memoryId, classification.evidenceDigest, classification.memoryRevision]);
  if (updated.rowCount !== 1) {
    throw new Error(`Memory ${memory.id} changed while its subject projection was being classified`);
  }
  return classification;
}
