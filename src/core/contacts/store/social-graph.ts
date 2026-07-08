import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type {
  SocialGraphEntity,
  SocialGraphEntityQuery,
  SocialGraphEntitySource,
  SocialGraphEntityUpsertInput,
  SocialRelationshipEdge,
  SocialRelationshipEdgeQuery,
  SocialRelationshipEdgeUpsertInput,
  SocialRelationshipKind,
  SocialGraphEntityKind,
} from '../types.js';
import {
  VALID_SOCIAL_GRAPH_ENTITY_KINDS,
  VALID_SOCIAL_GRAPH_SOURCES,
  VALID_SOCIAL_RELATIONSHIP_KINDS,
} from '../types.js';
import {
  classifySocialRelationship,
  effectiveEdgeDirectional,
  inverseRelationshipKind,
} from '../social-relationship-classification.js';
import type {
  ContactRow,
  SocialGraphEntityRow,
  SocialRelationshipEdgeRow,
} from './domain-types.js';
import type { SensitivityLevel, TrustLevel } from '../../../system/trust/types.js';
import type { ChannelPrivacy } from '../../../system/trust/context-envelope.js';
import { SENSITIVITY_LEVELS, sensitivityOrd } from '../../../system/trust/types.js';
import { getAllowedSensitivities } from '../../../system/trust/policy.js';
import { clampUnit } from '../../../shared/utils/numeric.js';

function normalizeSensitivity(value: unknown, fallback: SensitivityLevel = 'personal'): SensitivityLevel {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase() as SensitivityLevel;
  return SENSITIVITY_LEVELS.includes(normalized) ? normalized : fallback;
}

function normalizeStringArray(values: readonly string[] | undefined): string[] {
  const out = new Set<string>();
  for (const raw of values ?? []) {
    const normalized = raw.trim();
    if (normalized) out.add(normalized);
  }
  return [...out];
}

function normalizeEntityKind(value: unknown): SocialGraphEntityKind {
  if (typeof value !== 'string') return 'person';
  const normalized = value.trim().toLowerCase() as SocialGraphEntityKind;
  return VALID_SOCIAL_GRAPH_ENTITY_KINDS.includes(normalized) ? normalized : 'person';
}

function normalizeEntitySource(value: unknown, fallback: SocialGraphEntitySource = 'manual'): SocialGraphEntitySource {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase() as SocialGraphEntitySource;
  return VALID_SOCIAL_GRAPH_SOURCES.includes(normalized) ? normalized : fallback;
}

function normalizeRelationshipKind(value: unknown): SocialRelationshipKind {
  if (typeof value !== 'string') return 'other';
  const normalized = value.trim().toLowerCase() as SocialRelationshipKind;
  return VALID_SOCIAL_RELATIONSHIP_KINDS.includes(normalized) ? normalized : 'other';
}

function normalizeViewerTrustLevel(value: TrustLevel | undefined): TrustLevel {
  return value ?? 'public';
}

function normalizeViewerVisibility(value: ChannelPrivacy | undefined): ChannelPrivacy {
  return value ?? 'public';
}

function chooseMoreRestrictiveSensitivity(
  left: SensitivityLevel,
  right: SensitivityLevel,
): SensitivityLevel {
  return sensitivityOrd(left) >= sensitivityOrd(right) ? left : right;
}

function mapSocialGraphEntityRow(row: SocialGraphEntityRow): SocialGraphEntity {
  let provenanceRefs: string[] = [];
  try {
    const parsed = JSON.parse(row.provenance_refs);
    provenanceRefs = Array.isArray(parsed)
      ? normalizeStringArray(parsed.filter((value): value is string => typeof value === 'string'))
      : [];
  } catch {
    provenanceRefs = [];
  }

  return {
    id: row.id,
    entityKind: normalizeEntityKind(row.entity_kind),
    displayName: row.display_name,
    contactId: row.contact_id ?? undefined,
    sensitivity: normalizeSensitivity(row.sensitivity),
    provenanceRefs,
    confidence: clampUnit(row.confidence, 1),
    source: normalizeEntitySource(row.source, 'manual'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSocialRelationshipEdgeRow(row: SocialRelationshipEdgeRow): SocialRelationshipEdge {
  let provenanceRefs: string[] = [];
  let evidenceMemoryIds: string[] = [];
  try {
    const parsed = JSON.parse(row.provenance_refs);
    provenanceRefs = Array.isArray(parsed)
      ? normalizeStringArray(parsed.filter((value): value is string => typeof value === 'string'))
      : [];
  } catch {
    provenanceRefs = [];
  }
  try {
    const parsed = JSON.parse(row.evidence_memory_ids);
    evidenceMemoryIds = Array.isArray(parsed)
      ? normalizeStringArray(parsed.filter((value): value is string => typeof value === 'string'))
      : [];
  } catch {
    evidenceMemoryIds = [];
  }

  return {
    id: row.id,
    sourceEntityId: row.source_entity_id,
    targetEntityId: row.target_entity_id,
    relationshipType: normalizeRelationshipKind(row.relationship_type),
    directional: row.directional === 1,
    sensitivity: normalizeSensitivity(row.sensitivity),
    provenanceRefs,
    evidenceMemoryIds,
    confidence: clampUnit(row.confidence, 0.7),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeUndirectedEndpoints(
  sourceEntityId: string,
  targetEntityId: string,
  directional: boolean,
): { sourceEntityId: string; targetEntityId: string } {
  if (directional || sourceEntityId <= targetEntityId) {
    return { sourceEntityId, targetEntityId };
  }
  return {
    sourceEntityId: targetEntityId,
    targetEntityId: sourceEntityId,
  };
}

function edgeVisible(
  edgeSensitivity: SensitivityLevel,
  sourceSensitivity: SensitivityLevel,
  targetSensitivity: SensitivityLevel,
  query: SocialRelationshipEdgeQuery,
): boolean {
  const allowed = getAllowedSensitivities(
    normalizeViewerTrustLevel(query.viewerTrustLevel),
    { channelPrivacy: normalizeViewerVisibility(query.viewerChannelPrivacy), broadcast: false },
  );
  return allowed.includes(edgeSensitivity)
    && allowed.includes(sourceSensitivity)
    && allowed.includes(targetSensitivity);
}

export function backfillContactGraphEntities(db: Database.Database): void {
  db.exec(`
    INSERT INTO social_graph_entities (
      id,
      entity_kind,
      display_name,
      contact_id,
      sensitivity,
      provenance_refs,
      confidence,
      source,
      created_at,
      updated_at
    )
    SELECT
      'contact:' || c.id,
      'person',
      c.display_name,
      c.id,
      'personal',
      '[]',
      1,
      'contact',
      c.first_seen,
      c.last_seen
    FROM contacts c
    WHERE NOT EXISTS (
      SELECT 1
      FROM social_graph_entities e
      WHERE e.contact_id = c.id
    )
  `);
}

export function getSocialGraphEntityById(
  db: Database.Database,
  entityId: string,
): SocialGraphEntity | undefined {
  const row = db.prepare(`
    SELECT *
    FROM social_graph_entities
    WHERE id = ?
    LIMIT 1
  `).get(entityId) as SocialGraphEntityRow | undefined;
  return row ? mapSocialGraphEntityRow(row) : undefined;
}

export function getSocialGraphEntityByContactId(
  db: Database.Database,
  contactId: string,
): SocialGraphEntity | undefined {
  const row = db.prepare(`
    SELECT *
    FROM social_graph_entities
    WHERE contact_id = ?
    LIMIT 1
  `).get(contactId) as SocialGraphEntityRow | undefined;
  return row ? mapSocialGraphEntityRow(row) : undefined;
}

export function upsertSocialGraphEntity(
  db: Database.Database,
  input: SocialGraphEntityUpsertInput,
): SocialGraphEntity {
  const displayName = input.displayName.trim();
  if (!displayName) {
    throw new Error('social graph entity displayName must be non-empty');
  }

  const normalizedContactId = input.contactId?.trim() || undefined;
  const now = new Date().toISOString();
  const fallbackId = normalizedContactId ? `contact:${normalizedContactId}` : `entity:${randomUUID()}`;
  const sensitivity = normalizeSensitivity(input.sensitivity);
  const entityKind = normalizeEntityKind(input.entityKind);
  const source = normalizeEntitySource(input.source, normalizedContactId ? 'contact' : 'manual');
  const provenanceRefs = normalizeStringArray(input.provenanceRefs);
  const confidence = clampUnit(input.confidence, normalizedContactId ? 1 : 0.7);

  const existing = normalizedContactId
    ? getSocialGraphEntityByContactId(db, normalizedContactId)
    : (input.id ? getSocialGraphEntityById(db, input.id) : undefined);

  if (existing) {
    const nextSensitivity = chooseMoreRestrictiveSensitivity(existing.sensitivity, sensitivity);
    const nextProvenanceRefs = normalizeStringArray([...existing.provenanceRefs, ...provenanceRefs]);
    const nextConfidence = Math.max(existing.confidence, confidence);
    db.prepare(`
      UPDATE social_graph_entities
      SET entity_kind = ?,
          display_name = ?,
          contact_id = ?,
          sensitivity = ?,
          provenance_refs = ?,
          confidence = ?,
          source = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      entityKind,
      displayName,
      normalizedContactId ?? null,
      nextSensitivity,
      JSON.stringify(nextProvenanceRefs),
      nextConfidence,
      source,
      now,
      existing.id,
    );
    return getSocialGraphEntityById(db, existing.id)!;
  }

  const id = input.id?.trim() || fallbackId;
  db.prepare(`
    INSERT INTO social_graph_entities (
      id,
      entity_kind,
      display_name,
      contact_id,
      sensitivity,
      provenance_refs,
      confidence,
      source,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    entityKind,
    displayName,
    normalizedContactId ?? null,
    sensitivity,
    JSON.stringify(provenanceRefs),
    confidence,
    source,
    now,
    now,
  );
  return getSocialGraphEntityById(db, id)!;
}

export function ensureContactSocialGraphEntity(
  db: Database.Database,
  contact: Pick<ContactRow, 'id' | 'display_name' | 'first_seen' | 'last_seen'>,
): SocialGraphEntity {
  return upsertSocialGraphEntity(db, {
    id: `contact:${contact.id}`,
    displayName: contact.display_name,
    contactId: contact.id,
    source: 'contact',
    confidence: 1,
  });
}

export function listSocialGraphEntities(
  db: Database.Database,
  query: SocialGraphEntityQuery = {},
): SocialGraphEntity[] {
  const limit = Number.isFinite(query.limit) ? Math.max(1, Math.min(Math.floor(query.limit!), 100)) : 100;
  const allowed = new Set(getAllowedSensitivities(
    normalizeViewerTrustLevel(query.viewerTrustLevel),
    { channelPrivacy: normalizeViewerVisibility(query.viewerChannelPrivacy), broadcast: false },
  ));

  const rows = query.contactId
    ? db.prepare(`
      SELECT *
      FROM social_graph_entities
      WHERE contact_id = ?
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(query.contactId, limit) as SocialGraphEntityRow[]
    : db.prepare(`
      SELECT *
      FROM social_graph_entities
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(limit) as SocialGraphEntityRow[];

  return rows
    .map(mapSocialGraphEntityRow)
    .filter(entity => allowed.has(entity.sensitivity));
}

interface EdgeWriteFields {
  sensitivity: SensitivityLevel;
  provenanceRefs: string[];
  evidenceMemoryIds: string[];
  confidence: number;
}

function edgeToWriteFields(edge: SocialRelationshipEdge): EdgeWriteFields {
  return {
    sensitivity: edge.sensitivity,
    provenanceRefs: edge.provenanceRefs,
    evidenceMemoryIds: edge.evidenceMemoryIds,
    confidence: edge.confidence,
  };
}

export function getSocialRelationshipEdgeById(
  db: Database.Database,
  edgeId: string,
): SocialRelationshipEdge | undefined {
  const row = db.prepare(`
    SELECT *
    FROM social_relationship_edges
    WHERE id = ?
    LIMIT 1
  `).get(edgeId) as SocialRelationshipEdgeRow | undefined;
  return row ? mapSocialRelationshipEdgeRow(row) : undefined;
}

/**
 * Find-or-create a single edge row for an exact (source, target, type,
 * directional) key, merging write-fields into any existing row (max confidence,
 * union provenance/evidence, more-restrictive sensitivity). Endpoints are used
 * verbatim — callers are responsible for canonical ordering.
 */
function upsertSingleEdgeRow(
  db: Database.Database,
  sourceEntityId: string,
  targetEntityId: string,
  relationshipType: SocialRelationshipKind,
  directional: boolean,
  fields: EdgeWriteFields,
  now: string,
): SocialRelationshipEdge {
  const existingRow = db.prepare(`
    SELECT *
    FROM social_relationship_edges
    WHERE source_entity_id = ?
      AND target_entity_id = ?
      AND relationship_type = ?
      AND directional = ?
    LIMIT 1
  `).get(
    sourceEntityId,
    targetEntityId,
    relationshipType,
    directional ? 1 : 0,
  ) as SocialRelationshipEdgeRow | undefined;

  if (existingRow) {
    const existing = mapSocialRelationshipEdgeRow(existingRow);
    db.prepare(`
      UPDATE social_relationship_edges
      SET sensitivity = ?,
          provenance_refs = ?,
          evidence_memory_ids = ?,
          confidence = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      chooseMoreRestrictiveSensitivity(existing.sensitivity, fields.sensitivity),
      JSON.stringify(normalizeStringArray([...existing.provenanceRefs, ...fields.provenanceRefs])),
      JSON.stringify(normalizeStringArray([...existing.evidenceMemoryIds, ...fields.evidenceMemoryIds])),
      Math.max(existing.confidence, fields.confidence),
      now,
      existing.id,
    );
    return getSocialRelationshipEdgeById(db, existing.id)!;
  }

  const id = `edge:${randomUUID()}`;
  db.prepare(`
    INSERT INTO social_relationship_edges (
      id,
      source_entity_id,
      target_entity_id,
      relationship_type,
      directional,
      sensitivity,
      provenance_refs,
      evidence_memory_ids,
      confidence,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    sourceEntityId,
    targetEntityId,
    relationshipType,
    directional ? 1 : 0,
    fields.sensitivity,
    JSON.stringify(normalizeStringArray(fields.provenanceRefs)),
    JSON.stringify(normalizeStringArray(fields.evidenceMemoryIds)),
    fields.confidence,
    now,
    now,
  );
  return getSocialRelationshipEdgeById(db, id)!;
}

/**
 * Write an inverse-pair edge (e.g. parent A->B) and keep its linked mirror
 * (child B->A) consistent. Both rows converge to the SAME shared write-fields
 * (union of the input and both existing rows) via three idempotent single-row
 * upserts. The primary (A->B, kind) edge is returned.
 */
function upsertInversePairEdges(
  db: Database.Database,
  sourceEntityId: string,
  targetEntityId: string,
  relationshipType: SocialRelationshipKind,
  inverseType: SocialRelationshipKind,
  fields: EdgeWriteFields,
  now: string,
): SocialRelationshipEdge {
  // 1. Primary: union(existing primary, input).
  const primaryOnce = upsertSingleEdgeRow(
    db, sourceEntityId, targetEntityId, relationshipType, true, fields, now,
  );
  // 2. Mirror: union(existing mirror, primary) => full union of all three.
  const mirror = upsertSingleEdgeRow(
    db, targetEntityId, sourceEntityId, inverseType, true, edgeToWriteFields(primaryOnce), now,
  );
  // 3. Primary again with the mirror's full union => both rows now identical
  //    in the shared fields (max/union/most-restrictive are order-independent).
  return upsertSingleEdgeRow(
    db, sourceEntityId, targetEntityId, relationshipType, true, edgeToWriteFields(mirror), now,
  );
}

export function upsertSocialRelationshipEdge(
  db: Database.Database,
  input: SocialRelationshipEdgeUpsertInput,
): SocialRelationshipEdge {
  const sourceEntityId = input.sourceEntityId.trim();
  const targetEntityId = input.targetEntityId.trim();
  if (!sourceEntityId || !targetEntityId) {
    throw new Error('social relationship edge requires sourceEntityId and targetEntityId');
  }
  if (sourceEntityId === targetEntityId) {
    throw new Error('social relationship edge cannot target the same entity');
  }

  const relationshipType = normalizeRelationshipKind(input.relationshipType);
  const classification = classifySocialRelationship(relationshipType);
  // Classification governs the stored `directional` flag (fail-closed
  // normalization): symmetric -> undirected, inverse_pair -> directional,
  // genuinely_directional -> respect the caller.
  const directional = effectiveEdgeDirectional(relationshipType, input.directional);
  const normalizedEndpoints = normalizeUndirectedEndpoints(sourceEntityId, targetEntityId, directional);

  const sourceExists = getSocialGraphEntityById(db, normalizedEndpoints.sourceEntityId);
  const targetExists = getSocialGraphEntityById(db, normalizedEndpoints.targetEntityId);
  if (!sourceExists || !targetExists) {
    throw new Error('social relationship edge requires existing source and target entities');
  }

  const fields: EdgeWriteFields = {
    sensitivity: normalizeSensitivity(input.sensitivity),
    provenanceRefs: normalizeStringArray(input.provenanceRefs),
    evidenceMemoryIds: normalizeStringArray(input.evidenceMemoryIds),
    confidence: clampUnit(input.confidence, 0.7),
  };
  const now = new Date().toISOString();

  if (classification.directionality === 'inverse_pair') {
    const inverseType = inverseRelationshipKind(relationshipType)!;
    return upsertInversePairEdges(
      db,
      normalizedEndpoints.sourceEntityId,
      normalizedEndpoints.targetEntityId,
      relationshipType,
      inverseType,
      fields,
      now,
    );
  }

  return upsertSingleEdgeRow(
    db,
    normalizedEndpoints.sourceEntityId,
    normalizedEndpoints.targetEntityId,
    relationshipType,
    directional,
    fields,
    now,
  );
}

export function listSocialRelationshipEdges(
  db: Database.Database,
  query: SocialRelationshipEdgeQuery = {},
): SocialRelationshipEdge[] {
  const limit = Number.isFinite(query.limit) ? Math.max(1, Math.min(Math.floor(query.limit!), 200)) : 200;
  let entityId = query.entityId?.trim() || undefined;
  if (!entityId && query.contactId) {
    entityId = getSocialGraphEntityByContactId(db, query.contactId)?.id;
  }
  if (query.contactId && !entityId) return [];

  const params: unknown[] = [];
  const where: string[] = [];
  if (entityId) {
    where.push('(e.source_entity_id = ? OR e.target_entity_id = ?)');
    params.push(entityId, entityId);
  }
  if (query.relationshipType) {
    where.push('e.relationship_type = ?');
    params.push(normalizeRelationshipKind(query.relationshipType));
  }
  if (Number.isFinite(query.minConfidence)) {
    where.push('e.confidence >= ?');
    params.push(query.minConfidence);
  }

  const rows = db.prepare(`
    SELECT
      e.*,
      source.sensitivity AS source_sensitivity,
      target.sensitivity AS target_sensitivity
    FROM social_relationship_edges e
    INNER JOIN social_graph_entities source ON source.id = e.source_entity_id
    INNER JOIN social_graph_entities target ON target.id = e.target_entity_id
    ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY e.updated_at DESC, e.created_at DESC
    LIMIT ?
  `).all(...params, limit) as Array<SocialRelationshipEdgeRow & {
    source_sensitivity: string;
    target_sensitivity: string;
  }>;

  return rows
    .filter(row => edgeVisible(
      normalizeSensitivity(row.sensitivity),
      normalizeSensitivity(row.source_sensitivity),
      normalizeSensitivity(row.target_sensitivity),
      query,
    ))
    .map(row => mapSocialRelationshipEdgeRow(row));
}

export function listRelatedContactIds(
  db: Database.Database,
  contactId: string,
  query: SocialRelationshipEdgeQuery = {},
): string[] {
  const entity = getSocialGraphEntityByContactId(db, contactId);
  if (!entity) return [];

  const edges = listSocialRelationshipEdges(db, {
    ...query,
    entityId: entity.id,
  });
  const relatedContactIds = new Set<string>();
  for (const edge of edges) {
    const otherEntityId = edge.sourceEntityId === entity.id ? edge.targetEntityId : edge.sourceEntityId;
    const otherEntity = getSocialGraphEntityById(db, otherEntityId);
    if (otherEntity?.contactId) {
      relatedContactIds.add(otherEntity.contactId);
    }
  }
  return [...relatedContactIds];
}

export function mergeSocialGraphForContacts(
  db: Database.Database,
  sourceContactId: string,
  targetContactId: string,
): void {
  const sourceEntity = getSocialGraphEntityByContactId(db, sourceContactId);
  const targetEntity = getSocialGraphEntityByContactId(db, targetContactId);
  if (!sourceEntity || !targetEntity || sourceEntity.id === targetEntity.id) {
    return;
  }

  const now = new Date().toISOString();
  const mergedSensitivity = chooseMoreRestrictiveSensitivity(targetEntity.sensitivity, sourceEntity.sensitivity);
  const mergedProvenanceRefs = normalizeStringArray([
    ...targetEntity.provenanceRefs,
    ...sourceEntity.provenanceRefs,
  ]);
  const mergedConfidence = Math.max(targetEntity.confidence, sourceEntity.confidence);

  db.prepare(`
    UPDATE social_graph_entities
    SET sensitivity = ?,
        provenance_refs = ?,
        confidence = ?,
        updated_at = ?
    WHERE id = ?
  `).run(
    mergedSensitivity,
    JSON.stringify(mergedProvenanceRefs),
    mergedConfidence,
    now,
    targetEntity.id,
  );

  const sourceEdges = db.prepare(`
    SELECT *
    FROM social_relationship_edges
    WHERE source_entity_id = ? OR target_entity_id = ?
    ORDER BY created_at ASC, id ASC
  `).all(sourceEntity.id, sourceEntity.id) as SocialRelationshipEdgeRow[];

  for (const row of sourceEdges) {
    const existing = mapSocialRelationshipEdgeRow(row);
    const rewrittenSource = existing.sourceEntityId === sourceEntity.id ? targetEntity.id : existing.sourceEntityId;
    const rewrittenTarget = existing.targetEntityId === sourceEntity.id ? targetEntity.id : existing.targetEntityId;
    const normalizedEndpoints = normalizeUndirectedEndpoints(
      rewrittenSource,
      rewrittenTarget,
      existing.directional,
    );

    if (normalizedEndpoints.sourceEntityId === normalizedEndpoints.targetEntityId) {
      db.prepare('DELETE FROM social_relationship_edges WHERE id = ?').run(existing.id);
      continue;
    }

    const duplicateRow = db.prepare(`
      SELECT *
      FROM social_relationship_edges
      WHERE source_entity_id = ?
        AND target_entity_id = ?
        AND relationship_type = ?
        AND directional = ?
        AND id != ?
      LIMIT 1
    `).get(
      normalizedEndpoints.sourceEntityId,
      normalizedEndpoints.targetEntityId,
      existing.relationshipType,
      existing.directional ? 1 : 0,
      existing.id,
    ) as SocialRelationshipEdgeRow | undefined;

    if (duplicateRow) {
      const duplicate = mapSocialRelationshipEdgeRow(duplicateRow);
      db.prepare(`
        UPDATE social_relationship_edges
        SET sensitivity = ?,
            provenance_refs = ?,
            evidence_memory_ids = ?,
            confidence = ?,
            updated_at = ?
        WHERE id = ?
      `).run(
        chooseMoreRestrictiveSensitivity(duplicate.sensitivity, existing.sensitivity),
        JSON.stringify(normalizeStringArray([...duplicate.provenanceRefs, ...existing.provenanceRefs])),
        JSON.stringify(normalizeStringArray([...duplicate.evidenceMemoryIds, ...existing.evidenceMemoryIds])),
        Math.max(duplicate.confidence, existing.confidence),
        existing.updatedAt > duplicate.updatedAt ? existing.updatedAt : duplicate.updatedAt,
        duplicate.id,
      );
      db.prepare('DELETE FROM social_relationship_edges WHERE id = ?').run(existing.id);
      continue;
    }

    db.prepare(`
      UPDATE social_relationship_edges
      SET source_entity_id = ?,
          target_entity_id = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      normalizedEndpoints.sourceEntityId,
      normalizedEndpoints.targetEntityId,
      now,
      existing.id,
    );
  }

  const duplicates = db.prepare(`
    SELECT
      source_entity_id,
      target_entity_id,
      relationship_type,
      directional
    FROM social_relationship_edges
    GROUP BY source_entity_id, target_entity_id, relationship_type, directional
    HAVING COUNT(*) > 1
  `).all() as Array<{
    source_entity_id: string;
    target_entity_id: string;
    relationship_type: string;
    directional: number;
  }>;

  for (const duplicate of duplicates) {
    const rows = db.prepare(`
      SELECT *
      FROM social_relationship_edges
      WHERE source_entity_id = ?
        AND target_entity_id = ?
        AND relationship_type = ?
        AND directional = ?
      ORDER BY created_at ASC, id ASC
    `).all(
      duplicate.source_entity_id,
      duplicate.target_entity_id,
      duplicate.relationship_type,
      duplicate.directional,
    ) as SocialRelationshipEdgeRow[];

    if (rows.length < 2) continue;
    const [primaryRow, ...rest] = rows;
    const primary = mapSocialRelationshipEdgeRow(primaryRow);
    let mergedEdge = { ...primary };
    for (const row of rest) {
      const edge = mapSocialRelationshipEdgeRow(row);
      mergedEdge = {
        ...mergedEdge,
        sensitivity: chooseMoreRestrictiveSensitivity(mergedEdge.sensitivity, edge.sensitivity),
        provenanceRefs: normalizeStringArray([...mergedEdge.provenanceRefs, ...edge.provenanceRefs]),
        evidenceMemoryIds: normalizeStringArray([...mergedEdge.evidenceMemoryIds, ...edge.evidenceMemoryIds]),
        confidence: Math.max(mergedEdge.confidence, edge.confidence),
        updatedAt: edge.updatedAt > mergedEdge.updatedAt ? edge.updatedAt : mergedEdge.updatedAt,
      };
    }

    db.prepare(`
      UPDATE social_relationship_edges
      SET sensitivity = ?,
          provenance_refs = ?,
          evidence_memory_ids = ?,
          confidence = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      mergedEdge.sensitivity,
      JSON.stringify(mergedEdge.provenanceRefs),
      JSON.stringify(mergedEdge.evidenceMemoryIds),
      mergedEdge.confidence,
      mergedEdge.updatedAt,
      primary.id,
    );

    for (const row of rest) {
      db.prepare('DELETE FROM social_relationship_edges WHERE id = ?').run(row.id);
    }
  }

  // E4.3: the endpoint rewrites above can leave mirror pairs half-bound (a
  // parent survives while its child mirror was dropped as a self-loop, or two
  // mirrors collapsed onto one entity). Reconcile restores every invariant —
  // symmetric normalization, canonical ordering, dedupe, and mirror re-binding —
  // before the now-empty source entity is removed.
  reconcileSocialGraphConsistency(db, { apply: true });

  db.prepare('DELETE FROM social_graph_entities WHERE id = ?').run(sourceEntity.id);
}

// ── E4.3: bidirectional consistency + edge-hygiene reconciliation ──
// Classification-driven consistency pass over the whole edge set. Powers both
// the runtime merge repair (apply=true) and the report-first
// `npm run audit:social-graph` maintenance command (dry-run default). Every
// UNAMBIGUOUS violation is auto-fixed under apply; AMBIGUOUS violations (lost
// direction, conflicting mirror types) are reported for operator review and
// never mutated.

export type SocialGraphConsistencyFindingKind =
  | 'symmetric_marked_directional'
  | 'inverse_marked_undirected'
  | 'non_canonical_undirected'
  | 'duplicate_pair'
  | 'missing_mirror'
  | 'conflicting_mirror';

export interface SocialGraphConsistencyFinding {
  kind: SocialGraphConsistencyFindingKind;
  edgeId: string;
  sourceEntityId: string;
  targetEntityId: string;
  relationshipType: SocialRelationshipKind;
  directional: boolean;
  detail: string;
  /** Ambiguous findings are never auto-fixed; they are queued for operator review. */
  ambiguous: boolean;
  /** True when this finding was repaired in this run (apply mode only). */
  fixed: boolean;
}

export interface SocialGraphConsistencyReport {
  scannedEdges: number;
  findings: SocialGraphConsistencyFinding[];
  fixedCount: number;
  ambiguousCount: number;
  applied: boolean;
}

function edgeFindingMeta(edge: SocialRelationshipEdge): Pick<
  SocialGraphConsistencyFinding,
  'edgeId' | 'sourceEntityId' | 'targetEntityId' | 'relationshipType' | 'directional'
> {
  return {
    edgeId: edge.id,
    sourceEntityId: edge.sourceEntityId,
    targetEntityId: edge.targetEntityId,
    relationshipType: edge.relationshipType,
    directional: edge.directional,
  };
}

function allEdgeRows(db: Database.Database): SocialRelationshipEdgeRow[] {
  return db.prepare(`
    SELECT *
    FROM social_relationship_edges
    ORDER BY created_at ASC, id ASC
  `).all() as SocialRelationshipEdgeRow[];
}

function writeEdgeFields(
  db: Database.Database,
  edgeId: string,
  fields: EdgeWriteFields,
  updatedAt: string,
): void {
  db.prepare(`
    UPDATE social_relationship_edges
    SET sensitivity = ?,
        provenance_refs = ?,
        evidence_memory_ids = ?,
        confidence = ?,
        updated_at = ?
    WHERE id = ?
  `).run(
    fields.sensitivity,
    JSON.stringify(normalizeStringArray(fields.provenanceRefs)),
    JSON.stringify(normalizeStringArray(fields.evidenceMemoryIds)),
    fields.confidence,
    updatedAt,
    edgeId,
  );
}

function mergeWriteFields(a: EdgeWriteFields, b: EdgeWriteFields): EdgeWriteFields {
  return {
    sensitivity: chooseMoreRestrictiveSensitivity(a.sensitivity, b.sensitivity),
    provenanceRefs: normalizeStringArray([...a.provenanceRefs, ...b.provenanceRefs]),
    evidenceMemoryIds: normalizeStringArray([...a.evidenceMemoryIds, ...b.evidenceMemoryIds]),
    confidence: Math.max(a.confidence, b.confidence),
  };
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const set = new Set(left);
  return right.every(value => set.has(value));
}

function writeFieldsEqual(a: EdgeWriteFields, b: EdgeWriteFields): boolean {
  return a.sensitivity === b.sensitivity
    && a.confidence === b.confidence
    && sameStringSet(a.provenanceRefs, b.provenanceRefs)
    && sameStringSet(a.evidenceMemoryIds, b.evidenceMemoryIds);
}

export function reconcileSocialGraphConsistency(
  db: Database.Database,
  options: { apply?: boolean } = {},
): SocialGraphConsistencyReport {
  const apply = options.apply === true;
  const findings: SocialGraphConsistencyFinding[] = [];
  const now = new Date().toISOString();
  const scannedEdges = allEdgeRows(db).length;

  // Stage 1 — symmetric type stored directional -> normalize to undirected canonical.
  for (const row of allEdgeRows(db)) {
    const edge = mapSocialRelationshipEdgeRow(row);
    if (classifySocialRelationship(edge.relationshipType).directionality !== 'symmetric') continue;
    if (!edge.directional) continue;
    const finding: SocialGraphConsistencyFinding = {
      kind: 'symmetric_marked_directional',
      ...edgeFindingMeta(edge),
      detail: `Symmetric '${edge.relationshipType}' stored as directional; normalized to a single undirected canonical edge.`,
      ambiguous: false,
      fixed: false,
    };
    if (apply) {
      const endpoints = normalizeUndirectedEndpoints(edge.sourceEntityId, edge.targetEntityId, false);
      // Merge into (or create) the canonical undirected row, then drop the directional row.
      upsertSingleEdgeRow(
        db,
        endpoints.sourceEntityId,
        endpoints.targetEntityId,
        edge.relationshipType,
        false,
        edgeToWriteFields(edge),
        now,
      );
      db.prepare('DELETE FROM social_relationship_edges WHERE id = ?').run(edge.id);
      finding.fixed = true;
    }
    findings.push(finding);
  }

  // Stage 2 — inverse-pair type stored undirected -> direction lost (AMBIGUOUS).
  for (const row of allEdgeRows(db)) {
    const edge = mapSocialRelationshipEdgeRow(row);
    if (classifySocialRelationship(edge.relationshipType).directionality !== 'inverse_pair') continue;
    if (edge.directional) continue;
    findings.push({
      kind: 'inverse_marked_undirected',
      ...edgeFindingMeta(edge),
      detail: `Inverse-pair '${edge.relationshipType}' stored undirected; original direction is unrecoverable — queued for operator review.`,
      ambiguous: true,
      fixed: false,
    });
  }

  // Stage 3 — undirected endpoints not in canonical order -> swap/merge.
  for (const row of allEdgeRows(db)) {
    const edge = mapSocialRelationshipEdgeRow(row);
    if (edge.directional) continue;
    if (edge.sourceEntityId <= edge.targetEntityId) continue;
    const finding: SocialGraphConsistencyFinding = {
      kind: 'non_canonical_undirected',
      ...edgeFindingMeta(edge),
      detail: 'Undirected edge endpoints not in canonical order; re-ordered.',
      ambiguous: false,
      fixed: false,
    };
    if (apply) {
      // target < source here, so (target, source) is canonical.
      upsertSingleEdgeRow(
        db,
        edge.targetEntityId,
        edge.sourceEntityId,
        edge.relationshipType,
        false,
        edgeToWriteFields(edge),
        now,
      );
      db.prepare('DELETE FROM social_relationship_edges WHERE id = ?').run(edge.id);
      finding.fixed = true;
    }
    findings.push(finding);
  }

  // Stage 4 — duplicate rows for the same (source, target, type, directional) -> collapse.
  const duplicateGroups = db.prepare(`
    SELECT source_entity_id, target_entity_id, relationship_type, directional
    FROM social_relationship_edges
    GROUP BY source_entity_id, target_entity_id, relationship_type, directional
    HAVING COUNT(*) > 1
  `).all() as Array<{
    source_entity_id: string;
    target_entity_id: string;
    relationship_type: string;
    directional: number;
  }>;
  for (const group of duplicateGroups) {
    const rows = db.prepare(`
      SELECT *
      FROM social_relationship_edges
      WHERE source_entity_id = ?
        AND target_entity_id = ?
        AND relationship_type = ?
        AND directional = ?
      ORDER BY created_at ASC, id ASC
    `).all(
      group.source_entity_id,
      group.target_entity_id,
      group.relationship_type,
      group.directional,
    ) as SocialRelationshipEdgeRow[];
    if (rows.length < 2) continue;
    const edges = rows.map(mapSocialRelationshipEdgeRow);
    const [primary, ...rest] = edges;
    const finding: SocialGraphConsistencyFinding = {
      kind: 'duplicate_pair',
      ...edgeFindingMeta(primary),
      detail: `${edges.length} duplicate rows for this pair/type/direction; collapsed to one.`,
      ambiguous: false,
      fixed: false,
    };
    if (apply) {
      let merged = edgeToWriteFields(primary);
      for (const edge of rest) merged = mergeWriteFields(merged, edgeToWriteFields(edge));
      writeEdgeFields(db, primary.id, merged, now);
      for (const edge of rest) {
        db.prepare('DELETE FROM social_relationship_edges WHERE id = ?').run(edge.id);
      }
      finding.fixed = true;
    }
    findings.push(finding);
  }

  // Stage 5 — inverse-pair mirror integrity: every directional inverse-pair edge
  // must have its reciprocal mirror with shared fields.
  for (const row of allEdgeRows(db)) {
    const edge = mapSocialRelationshipEdgeRow(row);
    const classification = classifySocialRelationship(edge.relationshipType);
    if (classification.directionality !== 'inverse_pair' || !edge.directional) continue;
    const inverseType = classification.inverse!;
    const mirrorRows = db.prepare(`
      SELECT *
      FROM social_relationship_edges
      WHERE source_entity_id = ?
        AND target_entity_id = ?
        AND directional = 1
    `).all(edge.targetEntityId, edge.sourceEntityId) as SocialRelationshipEdgeRow[];
    const exactMirror = mirrorRows
      .map(mapSocialRelationshipEdgeRow)
      .find(candidate => candidate.relationshipType === inverseType);

    if (exactMirror) {
      // Mirror present; ensure shared fields (idempotent — only writes on drift).
      const merged = mergeWriteFields(edgeToWriteFields(edge), edgeToWriteFields(exactMirror));
      if (apply && (!writeFieldsEqual(merged, edgeToWriteFields(edge)) || !writeFieldsEqual(merged, edgeToWriteFields(exactMirror)))) {
        writeEdgeFields(db, edge.id, merged, now);
        writeEdgeFields(db, exactMirror.id, merged, now);
      }
      continue;
    }

    const conflictingMirror = mirrorRows
      .map(mapSocialRelationshipEdgeRow)
      .find(candidate => classifySocialRelationship(candidate.relationshipType).directionality === 'inverse_pair');
    if (conflictingMirror) {
      findings.push({
        kind: 'conflicting_mirror',
        ...edgeFindingMeta(edge),
        detail: `Expected mirror '${inverseType}' on reversed endpoints but found conflicting '${conflictingMirror.relationshipType}' — queued for operator review.`,
        ambiguous: true,
        fixed: false,
      });
      continue;
    }

    const finding: SocialGraphConsistencyFinding = {
      kind: 'missing_mirror',
      ...edgeFindingMeta(edge),
      detail: `Missing reciprocal '${inverseType}' mirror for '${edge.relationshipType}'; created with shared confidence/evidence/sensitivity.`,
      ambiguous: false,
      fixed: false,
    };
    if (apply) {
      upsertSingleEdgeRow(
        db,
        edge.targetEntityId,
        edge.sourceEntityId,
        inverseType,
        true,
        edgeToWriteFields(edge),
        now,
      );
      finding.fixed = true;
    }
    findings.push(finding);
  }

  return {
    scannedEdges,
    findings,
    fixedCount: findings.filter(finding => finding.fixed).length,
    ambiguousCount: findings.filter(finding => finding.ambiguous).length,
    applied: apply,
  };
}
