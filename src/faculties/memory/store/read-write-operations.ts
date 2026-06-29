import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { runInTransaction as runSqliteTransaction } from '../../../persistence/sqlite-utils.js';
import type { MemoryJournal } from '../journal.js';
import { MEMORY_EVOLUTION_RELATIONS, normalizeMemorySalienceUpdates } from '../memory-store-port.js';
import type {
  MemoryAbstractionLink,
  MemoryAbstractionLinkInput,
  MemoryBulkUpdatePatch,
  MemoryDeleteVersion,
  MemoryEvolutionLink,
  MemoryEvolutionLinkInput,
  MemoryEvolutionRelation,
  MemoryPatchEvent,
  MemorySalienceUpdate,
  MemorySoftDeleteOptions,
  MemoryStoreUpdatePatch,
  MemoryUndoSoftDeleteOptions,
  MemoryWriteCommit,
} from '../memory-store-port.js';
import {
  inferMemorySourceTypeFromSourceRef,
  normalizeFormationVAD,
  normalizeMemoryProvenance,
  normalizeMemoryScopeRef,
  normalizeMemoryScopeTags,
  normalizeMemorySourceType,
  type PurrMemory,
} from '../types.js';
import { embeddingToBuffer, validateEmbeddingDimensions } from './embeddings.js';
import {
  mapMemoryAbstractionLinkRow,
  mapMemoryDeleteVersionRow,
  mapMemoryEvolutionLinkRow,
  mapMemoryPatchEventRow,
  mapMemoryRow,
} from './mappers.js';
import type {
  MemoryAbstractionLinkRow,
  MemoryDeleteVersionRow,
  MemoryEvolutionLinkRow,
  MemoryPatchEventRow,
  MemoryRow,
} from './types.js';

export function insertMemory(
  db: Database.Database,
  embeddingDims: number,
  journal: MemoryJournal | null,
  memory: PurrMemory,
  embedding: Float32Array,
): void {
  validateEmbeddingDimensions(embedding, embeddingDims, 'insert');

  const insertMem = db.prepare(`
    INSERT INTO l2_memories (id, text, type, importance, confidence, emotional_valence, formation_vad,
      salience, source_ref, source_type, provenance_json, extracted_at, last_accessed, access_count, superseded_by, tags,
      scope_ref_kind, scope_ref_id, scope_ref_label, scope_tags, provenance_refs, retention_class, sensitivity,
      consent_flags, contact_id, deleted_at, deleted_by, delete_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertVec = db.prepare(`
    INSERT INTO l2_memory_embeddings (memory_id, embedding)
    VALUES (?, ?)
  `);

  const transaction = db.transaction(() => {
    insertMem.run(
      memory.id,
      memory.text,
      memory.type,
      memory.importance,
      memory.confidence,
      memory.emotionalValence,
      memory.formationVAD ? JSON.stringify(memory.formationVAD) : null,
      memory.salience,
      memory.sourceRef,
      normalizeMemorySourceType(memory.sourceType, inferMemorySourceTypeFromSourceRef(memory.sourceRef)),
      JSON.stringify(normalizeMemoryProvenance(memory.provenance) ?? {}),
      memory.extractedAt,
      memory.lastAccessed,
      memory.accessCount,
      memory.supersededBy ?? null,
      JSON.stringify(memory.tags),
      memory.scopeRef?.kind ?? null,
      memory.scopeRef?.id ?? null,
      memory.scopeRef?.label ?? null,
      JSON.stringify(normalizeMemoryScopeTags(memory.scopeTags)),
      JSON.stringify(memory.provenanceRefs ?? []),
      memory.retentionClass ?? null,
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- default for callers without sensitivity
      memory.sensitivity ?? 'personal',
      JSON.stringify(memory.consentFlags ?? {}),
      memory.contactId ?? null,
      memory.deletedAt ?? null,
      memory.deletedBy ?? null,
      memory.deleteReason ?? null,
    );
    insertVec.run(memory.id, embeddingToBuffer(embedding));
  });

  transaction();
  journal?.onInsert(memory);
}

export function persistMemoryWrite(
  db: Database.Database,
  embeddingDims: number,
  journal: MemoryJournal | null,
  input: MemoryWriteCommit,
): void {
  const supersededMemoryIds = [...new Set(input.supersededMemoryIds ?? [])];

  runSqliteTransaction(db, () => {
    for (const memoryId of supersededMemoryIds) {
      updateMemory(db, embeddingDims, memoryId, { supersededBy: input.memory.id });
    }
    insertMemory(db, embeddingDims, journal, input.memory, input.embedding);
  });
}

export function updateMemory(
  db: Database.Database,
  embeddingDims: number,
  id: string,
  updates: MemoryStoreUpdatePatch,
): void {
  const setClauses: string[] = [];
  const values: unknown[] = [];

  if (updates.text !== undefined) {
    setClauses.push('text = ?');
    values.push(updates.text);
  }
  if (updates.importance !== undefined) {
    setClauses.push('importance = ?');
    values.push(updates.importance);
  }
  if (updates.confidence !== undefined) {
    setClauses.push('confidence = ?');
    values.push(updates.confidence);
  }
  if (updates.emotionalValence !== undefined) {
    setClauses.push('emotional_valence = ?');
    values.push(updates.emotionalValence);
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'formationVAD')) {
    setClauses.push('formation_vad = ?');
    values.push(updates.formationVAD ? JSON.stringify(normalizeFormationVAD(updates.formationVAD)) : null);
  }
  if (updates.salience !== undefined) {
    setClauses.push('salience = ?');
    values.push(updates.salience);
  }
  if (updates.lastAccessed !== undefined) {
    setClauses.push('last_accessed = ?');
    values.push(updates.lastAccessed);
  }
  if (updates.accessCount !== undefined) {
    setClauses.push('access_count = ?');
    values.push(updates.accessCount);
  }
  if (updates.supersededBy !== undefined) {
    setClauses.push('superseded_by = ?');
    values.push(updates.supersededBy);
  }
  if (updates.sensitivity !== undefined) {
    setClauses.push('sensitivity = ?');
    values.push(updates.sensitivity);
  }
  if (updates.consentFlags !== undefined) {
    setClauses.push('consent_flags = ?');
    values.push(JSON.stringify(updates.consentFlags));
  }
  if (updates.tags !== undefined) {
    setClauses.push('tags = ?');
    values.push(JSON.stringify(updates.tags));
  }
  if (updates.scopeRef !== undefined) {
    const normalizedScopeRef = normalizeMemoryScopeRef(updates.scopeRef);
    setClauses.push('scope_ref_kind = ?');
    values.push(normalizedScopeRef?.kind ?? null);
    setClauses.push('scope_ref_id = ?');
    values.push(normalizedScopeRef?.id ?? null);
    setClauses.push('scope_ref_label = ?');
    values.push(normalizedScopeRef?.label ?? null);
  }
  if (updates.scopeTags !== undefined) {
    setClauses.push('scope_tags = ?');
    values.push(JSON.stringify(normalizeMemoryScopeTags(updates.scopeTags)));
  }
  if (updates.provenanceRefs !== undefined) {
    setClauses.push('provenance_refs = ?');
    values.push(JSON.stringify(updates.provenanceRefs));
  }
  if (updates.retentionClass !== undefined) {
    setClauses.push('retention_class = ?');
    values.push(updates.retentionClass);
  }
  if (updates.sourceType !== undefined) {
    setClauses.push('source_type = ?');
    values.push(normalizeMemorySourceType(updates.sourceType));
  }
  if (updates.provenance !== undefined) {
    setClauses.push('provenance_json = ?');
    values.push(JSON.stringify(normalizeMemoryProvenance(updates.provenance) ?? {}));
  }
  if (updates.contactId !== undefined) {
    setClauses.push('contact_id = ?');
    values.push(updates.contactId);
  }
  if (updates.deletedAt !== undefined) {
    setClauses.push('deleted_at = ?');
    values.push(updates.deletedAt);
  }
  if (updates.deletedBy !== undefined) {
    setClauses.push('deleted_by = ?');
    values.push(updates.deletedBy);
  }
  if (updates.deleteReason !== undefined) {
    setClauses.push('delete_reason = ?');
    values.push(updates.deleteReason);
  }

  if (setClauses.length === 0) return;
  if (updates.text !== undefined && !(updates.embedding instanceof Float32Array)) {
    throw new Error('updateMemory requires embedding when text is updated');
  }
  if (updates.embedding instanceof Float32Array) {
    validateEmbeddingDimensions(updates.embedding, embeddingDims, 'update');
  }

  const updateMem = db.prepare(
    `UPDATE l2_memories SET ${setClauses.join(', ')} WHERE id = ?`,
  );
  const updateVec = db.prepare(`
    UPDATE l2_memory_embeddings
    SET embedding = ?
    WHERE memory_id = ?
  `);

  const transaction = db.transaction(() => {
    updateMem.run(...values, id);
    if (updates.embedding instanceof Float32Array) {
      updateVec.run(embeddingToBuffer(updates.embedding), id);
    }
  });
  transaction();
}

export function runInTransaction<T>(db: Database.Database, handler: () => T): T {
  return runSqliteTransaction(db, handler);
}

export function recordPatchEvent(db: Database.Database, event: MemoryPatchEvent): void {
  db.prepare(`
    INSERT INTO l2_memory_patch_events (
      id, memory_id, source_ref, source_type, provenance_json, reason, patch_json, previous_json, next_json, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.id,
    event.memoryId,
    event.sourceRef,
    normalizeMemorySourceType(event.sourceType),
    JSON.stringify(normalizeMemoryProvenance(event.provenance) ?? {}),
    event.reason ?? null,
    JSON.stringify(event.patch),
    JSON.stringify(event.previousValues),
    JSON.stringify(event.nextValues),
    event.createdAt,
  );
}

export function getPatchEvents(db: Database.Database, memoryId: string): MemoryPatchEvent[] {
  const normalized = memoryId.trim();
  if (!normalized) return [];
  const rows = db.prepare(`
    SELECT *
    FROM l2_memory_patch_events
    WHERE memory_id = ?
    ORDER BY created_at DESC
  `).all(normalized) as MemoryPatchEventRow[];
  return rows.map(mapMemoryPatchEventRow);
}

export function softDeleteMemory(
  db: Database.Database,
  journal: MemoryJournal | null,
  id: string,
  options: MemorySoftDeleteOptions = {},
): MemoryDeleteVersion | null {
  const deleteId = options.deleteId ?? randomUUID();
  const deletedAt = options.deletedAt ?? Date.now();
  const deletedBy = options.deletedBy?.trim() || 'agent';
  const reason = options.reason?.trim();

  const selectStmt = db.prepare(`
    SELECT * FROM l2_memories
    WHERE id = ? AND deleted_at IS NULL
    LIMIT 1
  `);
  const insertVersion = db.prepare(`
    INSERT INTO l2_memory_delete_versions (
      delete_id,
      memory_id,
      snapshot_json,
      deleted_at,
      deleted_by,
      delete_reason
    )
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const updateStmt = db.prepare(`
    UPDATE l2_memories
    SET deleted_at = ?, deleted_by = ?, delete_reason = ?
    WHERE id = ? AND deleted_at IS NULL
  `);

  const transaction = db.transaction(() => {
    const row = selectStmt.get(id) as MemoryRow | undefined;
    if (!row) return null;

    const snapshot = mapMemoryRow(row);
    insertVersion.run(
      deleteId,
      id,
      JSON.stringify(snapshot),
      deletedAt,
      deletedBy,
      reason ?? null,
    );
    const result = updateStmt.run(
      deletedAt,
      deletedBy,
      reason ?? null,
      id,
    );
    if (result.changes === 0) return null;

    return {
      deleteId,
      memoryId: id,
      snapshot,
      deletedAt,
      deletedBy,
      deleteReason: reason,
    } satisfies MemoryDeleteVersion;
  });

  const deleteVersion = transaction();
  if (deleteVersion) {
    journal?.onSoftDelete(deleteVersion);
  }
  return deleteVersion;
}

export function undoSoftDelete(
  db: Database.Database,
  journal: MemoryJournal | null,
  deleteId: string,
  options: MemoryUndoSoftDeleteOptions = {},
): MemoryDeleteVersion | null {
  const restoredAt = options.restoredAt ?? Date.now();
  const restoredBy = options.restoredBy?.trim() || 'agent';

  const selectStmt = db.prepare(`
    SELECT * FROM l2_memory_delete_versions
    WHERE delete_id = ? AND restored_at IS NULL
    LIMIT 1
  `);
  const restoreMemoryStmt = db.prepare(`
    UPDATE l2_memories
    SET deleted_at = NULL, deleted_by = NULL, delete_reason = NULL
    WHERE id = ?
  `);
  const restoreVersionStmt = db.prepare(`
    UPDATE l2_memory_delete_versions
    SET restored_at = ?, restored_by = ?
    WHERE delete_id = ? AND restored_at IS NULL
  `);

  const transaction = db.transaction(() => {
    const versionRow = selectStmt.get(deleteId) as MemoryDeleteVersionRow | undefined;
    if (!versionRow) return null;

    restoreMemoryStmt.run(versionRow.memory_id);
    const versionResult = restoreVersionStmt.run(restoredAt, restoredBy, deleteId);
    if (versionResult.changes === 0) return null;

    return {
      ...mapMemoryDeleteVersionRow(versionRow),
      restoredAt,
      restoredBy,
    } satisfies MemoryDeleteVersion;
  });

  const restoreVersion = transaction();
  if (restoreVersion) {
    journal?.onRestore(restoreVersion);
  }
  return restoreVersion;
}

export function getDeleteVersion(
  db: Database.Database,
  deleteId: string,
): MemoryDeleteVersion | undefined {
  const row = db.prepare(`
    SELECT *
    FROM l2_memory_delete_versions
    WHERE delete_id = ?
    LIMIT 1
  `).get(deleteId) as MemoryDeleteVersionRow | undefined;
  if (!row) return undefined;
  return mapMemoryDeleteVersionRow(row);
}

export function recordAbstractionLink(
  db: Database.Database,
  input: MemoryAbstractionLinkInput,
): MemoryAbstractionLink {
  const sourceMemoryId = input.sourceMemoryId.trim();
  const abstractedMemoryId = input.abstractedMemoryId.trim();
  const externalRef = input.externalRef.trim();
  if (!sourceMemoryId || !abstractedMemoryId || !externalRef) {
    throw new Error('sourceMemoryId, abstractedMemoryId, and externalRef are required');
  }

  const id = input.linkId?.trim() || randomUUID();
  const createdAt = input.createdAt ?? Date.now();
  const createdBy = input.createdBy?.trim() || undefined;
  const reason = input.reason?.trim() || undefined;

  db.prepare(`
    INSERT INTO l2_memory_abstraction_links (
      id,
      source_memory_id,
      abstracted_memory_id,
      external_ref,
      created_at,
      created_by,
      reason
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    sourceMemoryId,
    abstractedMemoryId,
    externalRef,
    createdAt,
    createdBy ?? null,
    reason ?? null,
  );

  return {
    id,
    sourceMemoryId,
    abstractedMemoryId,
    externalRef,
    createdAt,
    createdBy,
    reason,
  };
}

export function getAbstractionLinksForSourceMemory(
  db: Database.Database,
  sourceMemoryId: string,
): MemoryAbstractionLink[] {
  const normalized = sourceMemoryId.trim();
  if (!normalized) return [];
  const rows = db.prepare(`
    SELECT *
    FROM l2_memory_abstraction_links
    WHERE source_memory_id = ?
    ORDER BY created_at DESC
  `).all(normalized) as MemoryAbstractionLinkRow[];
  return rows.map(mapMemoryAbstractionLinkRow);
}

export function getAbstractionLinksForAbstractedMemory(
  db: Database.Database,
  abstractedMemoryId: string,
): MemoryAbstractionLink[] {
  const normalized = abstractedMemoryId.trim();
  if (!normalized) return [];
  const rows = db.prepare(`
    SELECT *
    FROM l2_memory_abstraction_links
    WHERE abstracted_memory_id = ?
    ORDER BY created_at DESC
  `).all(normalized) as MemoryAbstractionLinkRow[];
  return rows.map(mapMemoryAbstractionLinkRow);
}

function normalizeEvolutionRelation(relation: MemoryEvolutionRelation): MemoryEvolutionRelation {
  if ((MEMORY_EVOLUTION_RELATIONS as readonly string[]).includes(relation)) {
    return relation;
  }
  throw new Error(`Invalid memory evolution relation: ${String(relation)}`);
}

function normalizeEvolutionConfidence(confidence: number | undefined): number {
  const normalized = confidence ?? 1;
  if (!Number.isFinite(normalized) || normalized < 0 || normalized > 1) {
    throw new Error('Memory evolution link confidence must be between 0 and 1');
  }
  return normalized;
}

function normalizeEvolutionLinkInput(input: MemoryEvolutionLinkInput): MemoryEvolutionLink {
  const sourceMemoryId = input.sourceMemoryId.trim();
  const targetMemoryId = input.targetMemoryId.trim();
  if (!sourceMemoryId || !targetMemoryId) {
    throw new Error('sourceMemoryId and targetMemoryId are required');
  }
  if (sourceMemoryId === targetMemoryId) {
    throw new Error('Memory evolution links require distinct source and target memories');
  }

  const sourceRef = input.sourceRef?.trim() || undefined;
  const provenanceRefs = [...new Set((input.provenanceRefs ?? [])
    .map(ref => ref.trim())
    .filter(ref => ref.length > 0))];
  const provenance = normalizeMemoryProvenance(input.provenance);

  return {
    id: input.linkId?.trim() || randomUUID(),
    sourceMemoryId,
    targetMemoryId,
    relation: normalizeEvolutionRelation(input.relation),
    confidence: normalizeEvolutionConfidence(input.confidence),
    reason: input.reason?.trim() || undefined,
    sourceRef,
    sourceType: normalizeMemorySourceType(input.sourceType, sourceRef
      ? inferMemorySourceTypeFromSourceRef(sourceRef)
      : 'unknown'),
    provenanceRefs,
    ...(provenance ? { provenance } : {}),
    createdAt: input.createdAt ?? Date.now(),
  };
}

export function recordEvolutionLink(
  db: Database.Database,
  input: MemoryEvolutionLinkInput,
): MemoryEvolutionLink {
  const link = normalizeEvolutionLinkInput(input);

  db.prepare(`
    INSERT INTO memory_evolution_links (
      id,
      source_memory_id,
      target_memory_id,
      relation,
      confidence,
      reason,
      source_ref,
      source_type,
      provenance_refs,
      provenance_json,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_memory_id, target_memory_id, relation) DO UPDATE SET
      id = excluded.id,
      confidence = excluded.confidence,
      reason = excluded.reason,
      source_ref = excluded.source_ref,
      source_type = excluded.source_type,
      provenance_refs = excluded.provenance_refs,
      provenance_json = excluded.provenance_json,
      created_at = excluded.created_at
  `).run(
    link.id,
    link.sourceMemoryId,
    link.targetMemoryId,
    link.relation,
    link.confidence,
    link.reason ?? null,
    link.sourceRef ?? null,
    link.sourceType,
    JSON.stringify(link.provenanceRefs),
    JSON.stringify(link.provenance ?? {}),
    link.createdAt,
  );

  return link;
}

export function getEvolutionLinksForSourceMemory(
  db: Database.Database,
  sourceMemoryId: string,
  relation?: MemoryEvolutionRelation,
): MemoryEvolutionLink[] {
  const normalized = sourceMemoryId.trim();
  if (!normalized) return [];
  const normalizedRelation = relation ? normalizeEvolutionRelation(relation) : undefined;
  const rows = normalizedRelation
    ? db.prepare(`
      SELECT *
      FROM memory_evolution_links
      WHERE source_memory_id = ? AND relation = ?
      ORDER BY created_at DESC, id DESC
    `).all(normalized, normalizedRelation) as MemoryEvolutionLinkRow[]
    : db.prepare(`
      SELECT *
      FROM memory_evolution_links
      WHERE source_memory_id = ?
      ORDER BY created_at DESC, id DESC
    `).all(normalized) as MemoryEvolutionLinkRow[];
  return rows.map(mapMemoryEvolutionLinkRow);
}

export function getEvolutionLinksForTargetMemory(
  db: Database.Database,
  targetMemoryId: string,
  relation?: MemoryEvolutionRelation,
): MemoryEvolutionLink[] {
  const normalized = targetMemoryId.trim();
  if (!normalized) return [];
  const normalizedRelation = relation ? normalizeEvolutionRelation(relation) : undefined;
  const rows = normalizedRelation
    ? db.prepare(`
      SELECT *
      FROM memory_evolution_links
      WHERE target_memory_id = ? AND relation = ?
      ORDER BY created_at DESC, id DESC
    `).all(normalized, normalizedRelation) as MemoryEvolutionLinkRow[]
    : db.prepare(`
      SELECT *
      FROM memory_evolution_links
      WHERE target_memory_id = ?
      ORDER BY created_at DESC, id DESC
    `).all(normalized) as MemoryEvolutionLinkRow[];
  return rows.map(mapMemoryEvolutionLinkRow);
}

export function bulkDelete(db: Database.Database, ids: string[]): number {
  if (!ids.length) return 0;
  const now = Date.now();
  const deletedBy = 'admin:bulk';

  const selectStmt = db.prepare(`
    SELECT * FROM l2_memories
    WHERE id = ? AND deleted_at IS NULL
    LIMIT 1
  `);
  const insertVersion = db.prepare(`
    INSERT INTO l2_memory_delete_versions (
      delete_id, memory_id, snapshot_json, deleted_at, deleted_by, delete_reason
    )
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const updateStmt = db.prepare(`
    UPDATE l2_memories
    SET deleted_at = ?, deleted_by = ?, delete_reason = ?
    WHERE id = ? AND deleted_at IS NULL
  `);

  let count = 0;
  const transaction = db.transaction(() => {
    for (const id of ids) {
      const normalizedId = id.trim();
      if (!normalizedId) continue;

      const row = selectStmt.get(normalizedId) as MemoryRow | undefined;
      if (!row) continue;

      const snapshot = mapMemoryRow(row);
      const deleteId = randomUUID();
      insertVersion.run(
        deleteId,
        normalizedId,
        JSON.stringify(snapshot),
        now,
        deletedBy,
        'bulk delete',
      );
      const result = updateStmt.run(now, deletedBy, 'bulk delete', normalizedId);
      if (result.changes > 0) count++;
    }
  });

  transaction();
  return count;
}

export function bulkUpdate(
  db: Database.Database,
  ids: string[],
  fields: MemoryBulkUpdatePatch,
): number {
  if (!ids.length) return 0;

  const setClauses: string[] = [];
  const setValues: unknown[] = [];

  if (fields.type !== undefined) {
    setClauses.push('type = ?');
    setValues.push(fields.type);
  }
  if (fields.sensitivity !== undefined) {
    setClauses.push('sensitivity = ?');
    setValues.push(fields.sensitivity);
  }
  if (fields.retentionClass !== undefined) {
    setClauses.push('retention_class = ?');
    setValues.push(fields.retentionClass);
  }

  if (setClauses.length === 0) return 0;

  const stmt = db.prepare(
    `UPDATE l2_memories SET ${setClauses.join(', ')} WHERE id = ? AND deleted_at IS NULL`,
  );

  let count = 0;
  const transaction = db.transaction(() => {
    for (const id of ids) {
      const normalizedId = id.trim();
      if (!normalizedId) continue;
      const result = stmt.run(...setValues, normalizedId);
      if (result.changes > 0) count++;
    }
  });

  transaction();
  return count;
}

export function bulkUpdateSalience(
  db: Database.Database,
  updates: MemorySalienceUpdate[],
): number {
  const normalizedUpdates = normalizeMemorySalienceUpdates(updates);
  if (normalizedUpdates.length === 0) return 0;

  const stmt = db.prepare(`
    UPDATE l2_memories
    SET salience = ?
    WHERE id = ? AND deleted_at IS NULL AND superseded_by IS NULL
  `);

  let count = 0;
  const transaction = db.transaction(() => {
    for (const update of normalizedUpdates) {
      const result = stmt.run(update.salience, update.id);
      if (result.changes > 0) count++;
    }
  });

  transaction();
  return count;
}
