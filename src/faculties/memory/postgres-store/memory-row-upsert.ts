import type { PurrMemory } from '../types.js';
import { serializeJsonValue, toMemoryRow, validateEmbeddingDimensions } from './rows.js';
import type { PostgresMemoryStoreCollaboratorContext } from './collaborator-context.js';

/**
 * Upsert one full `l2_memories` row (metadata plus pgvector embedding) and
 * return the row's database-assigned authorization revision. Runs on the
 * active memory-store transaction client when one is open. Fails closed on an
 * embedding of the wrong dimension or a missing/invalid revision.
 */
export async function upsertL2MemoryRow(
  ctx: Pick<PostgresMemoryStoreCollaboratorContext, 'embeddingDims' | 'queryWrite'>,
  memory: PurrMemory,
  embedding?: Float32Array,
): Promise<number> {
  if (embedding) {
    validateEmbeddingDimensions(embedding, ctx.embeddingDims, 'write');
  }
  const row = toMemoryRow(memory, embedding);
  const revisions = await ctx.queryWrite<{ authorization_revision: string }>(`
    INSERT INTO l2_memories (
      id, text, type, importance, confidence, emotional_valence, formation_vad, salience,
      salience_decay_anchor_at,
      source_ref, source_type, provenance_json, extracted_at, last_accessed, access_count,
      superseded_by, tags,
      scope_ref_kind, scope_ref_id, scope_ref_label, scope_tags, provenance_refs,
      retention_class, sensitivity, consent_flags, contact_id, deleted_at, deleted_by,
      delete_reason, emotional_texture, embedding
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31::vector
    )
    ON CONFLICT (id) DO UPDATE SET
      text = EXCLUDED.text,
      type = EXCLUDED.type,
      importance = EXCLUDED.importance,
      confidence = EXCLUDED.confidence,
      emotional_valence = EXCLUDED.emotional_valence,
      formation_vad = EXCLUDED.formation_vad,
      salience = EXCLUDED.salience,
      salience_decay_anchor_at = EXCLUDED.salience_decay_anchor_at,
      source_ref = EXCLUDED.source_ref,
      source_type = EXCLUDED.source_type,
      provenance_json = EXCLUDED.provenance_json,
      extracted_at = EXCLUDED.extracted_at,
      last_accessed = EXCLUDED.last_accessed,
      access_count = EXCLUDED.access_count,
      superseded_by = EXCLUDED.superseded_by,
      tags = EXCLUDED.tags,
      scope_ref_kind = EXCLUDED.scope_ref_kind,
      scope_ref_id = EXCLUDED.scope_ref_id,
      scope_ref_label = EXCLUDED.scope_ref_label,
      scope_tags = EXCLUDED.scope_tags,
      provenance_refs = EXCLUDED.provenance_refs,
      retention_class = EXCLUDED.retention_class,
      sensitivity = EXCLUDED.sensitivity,
      consent_flags = EXCLUDED.consent_flags,
      contact_id = EXCLUDED.contact_id,
      deleted_at = EXCLUDED.deleted_at,
      deleted_by = EXCLUDED.deleted_by,
      delete_reason = EXCLUDED.delete_reason,
      emotional_texture = EXCLUDED.emotional_texture,
      embedding = EXCLUDED.embedding
    RETURNING authorization_revision
  `, [
    row.id,
    row.text,
    row.type,
    row.importance,
    row.confidence,
    row.emotional_valence,
    serializeJsonValue(row.formation_vad),
    row.salience,
    row.salience_decay_anchor_at,
    row.source_ref,
    row.source_type,
    serializeJsonValue(row.provenance_json),
    row.extracted_at,
    row.last_accessed,
    row.access_count,
    row.superseded_by,
    serializeJsonValue(row.tags),
    row.scope_ref_kind,
    row.scope_ref_id,
    row.scope_ref_label,
    serializeJsonValue(row.scope_tags),
    serializeJsonValue(row.provenance_refs),
    row.retention_class,
    row.sensitivity,
    serializeJsonValue(row.consent_flags),
    row.contact_id,
    row.deleted_at,
    row.deleted_by,
    row.delete_reason,
    serializeJsonValue(row.emotional_texture),
    row.embedding,
  ]);
  const revision = Number(revisions[0]?.authorization_revision);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error(`Memory ${memory.id} did not return a valid authorization revision`);
  }
  return revision;
}
