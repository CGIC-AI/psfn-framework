import type { DatabaseAdapter } from '../../persistence/db-adapter.js';
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
import type {
  ContactRow,
  SocialGraphEntityRow,
  SocialRelationshipEdgeRow,
} from './domain-types.js';
import type { ChannelVisibility, SensitivityLevel, TrustLevel } from '../../trust/types.js';
import { SENSITIVITY_LEVELS, sensitivityOrd } from '../../trust/types.js';
import { getAllowedSensitivities } from '../../trust/policy.js';

function clampUnit(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value ?? fallback));
}

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

function normalizeViewerVisibility(value: ChannelVisibility | undefined): ChannelVisibility {
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
    normalizeViewerVisibility(query.viewerChannelVisibility),
  );
  return allowed.includes(edgeSensitivity)
    && allowed.includes(sourceSensitivity)
    && allowed.includes(targetSensitivity);
}

export async function backfillContactGraphEntities(adapter: DatabaseAdapter): Promise<void> {
  await adapter.exec(`
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

export async function getSocialGraphEntityById(
  adapter: DatabaseAdapter,
  entityId: string,
): Promise<SocialGraphEntity | undefined> {
  const row = await adapter.queryOne<SocialGraphEntityRow>(`
    SELECT *
    FROM social_graph_entities
    WHERE id = ?
    LIMIT 1
  `, [entityId]);
  return row ? mapSocialGraphEntityRow(row) : undefined;
}

export async function getSocialGraphEntityByContactId(
  adapter: DatabaseAdapter,
  contactId: string,
): Promise<SocialGraphEntity | undefined> {
  const row = await adapter.queryOne<SocialGraphEntityRow>(`
    SELECT *
    FROM social_graph_entities
    WHERE contact_id = ?
    LIMIT 1
  `, [contactId]);
  return row ? mapSocialGraphEntityRow(row) : undefined;
}

export async function upsertSocialGraphEntity(
  adapter: DatabaseAdapter,
  input: SocialGraphEntityUpsertInput,
): Promise<SocialGraphEntity> {
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
    ? await getSocialGraphEntityByContactId(adapter, normalizedContactId)
    : (input.id ? await getSocialGraphEntityById(adapter, input.id) : undefined);

  if (existing) {
    const nextSensitivity = chooseMoreRestrictiveSensitivity(existing.sensitivity, sensitivity);
    const nextProvenanceRefs = normalizeStringArray([...existing.provenanceRefs, ...provenanceRefs]);
    const nextConfidence = Math.max(existing.confidence, confidence);
    await adapter.run(`
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
    `, [
      entityKind,
      displayName,
      normalizedContactId ?? null,
      nextSensitivity,
      JSON.stringify(nextProvenanceRefs),
      nextConfidence,
      source,
      now,
      existing.id,
    ]);
    return await getSocialGraphEntityById(adapter, existing.id)!;
  }

  const id = input.id?.trim() || fallbackId;
  await adapter.run(`
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
  `, [
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
  ]);
  return await getSocialGraphEntityById(adapter, id)!;
}

export async function ensureContactSocialGraphEntity(
  adapter: DatabaseAdapter,
  contact: Pick<ContactRow, 'id' | 'display_name' | 'first_seen' | 'last_seen'>,
): Promise<SocialGraphEntity> {
  return upsertSocialGraphEntity(adapter, {
    id: `contact:${contact.id}`,
    displayName: contact.display_name,
    contactId: contact.id,
    source: 'contact',
    confidence: 1,
  });
}

export async function listSocialGraphEntities(
  adapter: DatabaseAdapter,
  query: SocialGraphEntityQuery = {},
): Promise<SocialGraphEntity[]> {
  const limit = Number.isFinite(query.limit) ? Math.max(1, Math.min(Math.floor(query.limit!), 100)) : 100;
  const allowed = new Set(getAllowedSensitivities(
    normalizeViewerTrustLevel(query.viewerTrustLevel),
    normalizeViewerVisibility(query.viewerChannelVisibility),
  ));

  const rows = query.contactId
    ? await adapter.query<SocialGraphEntityRow>(`
      SELECT *
      FROM social_graph_entities
      WHERE contact_id = ?
      ORDER BY updated_at DESC
      LIMIT ?
    `, [query.contactId, limit])
    : await adapter.query<SocialGraphEntityRow>(`
      SELECT *
      FROM social_graph_entities
      ORDER BY updated_at DESC
      LIMIT ?
    `, [limit]);

  return rows
    .map(mapSocialGraphEntityRow)
    .filter(entity => allowed.has(entity.sensitivity));
}

export async function upsertSocialRelationshipEdge(
  adapter: DatabaseAdapter,
  input: SocialRelationshipEdgeUpsertInput,
): Promise<SocialRelationshipEdge> {
  const sourceEntityId = input.sourceEntityId.trim();
  const targetEntityId = input.targetEntityId.trim();
  if (!sourceEntityId || !targetEntityId) {
    throw new Error('social relationship edge requires sourceEntityId and targetEntityId');
  }
  if (sourceEntityId === targetEntityId) {
    throw new Error('social relationship edge cannot target the same entity');
  }

  const directional = input.directional ?? true;
  const normalizedEndpoints = normalizeUndirectedEndpoints(sourceEntityId, targetEntityId, directional);
  const relationshipType = normalizeRelationshipKind(input.relationshipType);
  const sensitivity = normalizeSensitivity(input.sensitivity);
  const provenanceRefs = normalizeStringArray(input.provenanceRefs);
  const evidenceMemoryIds = normalizeStringArray(input.evidenceMemoryIds);
  const confidence = clampUnit(input.confidence, 0.7);

  const sourceExists = await getSocialGraphEntityById(adapter, normalizedEndpoints.sourceEntityId);
  const targetExists = await getSocialGraphEntityById(adapter, normalizedEndpoints.targetEntityId);
  if (!sourceExists || !targetExists) {
    throw new Error('social relationship edge requires existing source and target entities');
  }

  const now = new Date().toISOString();
  const existingRow = await adapter.queryOne<SocialRelationshipEdgeRow>(`
    SELECT *
    FROM social_relationship_edges
    WHERE source_entity_id = ?
      AND target_entity_id = ?
      AND relationship_type = ?
      AND directional = ?
    LIMIT 1
  `, [
    normalizedEndpoints.sourceEntityId,
    normalizedEndpoints.targetEntityId,
    relationshipType,
    directional ? 1 : 0,
  ]);

  if (existingRow) {
    const existing = mapSocialRelationshipEdgeRow(existingRow);
    await adapter.run(`
      UPDATE social_relationship_edges
      SET sensitivity = ?,
          provenance_refs = ?,
          evidence_memory_ids = ?,
          confidence = ?,
          updated_at = ?
      WHERE id = ?
    `, [
      chooseMoreRestrictiveSensitivity(existing.sensitivity, sensitivity),
      JSON.stringify(normalizeStringArray([...existing.provenanceRefs, ...provenanceRefs])),
      JSON.stringify(normalizeStringArray([...existing.evidenceMemoryIds, ...evidenceMemoryIds])),
      Math.max(existing.confidence, confidence),
      now,
      existing.id,
    ]);
    const edges = await listSocialRelationshipEdges(adapter, {
      entityId: normalizedEndpoints.sourceEntityId,
      relationshipType,
      viewerTrustLevel: 'primary',
      viewerChannelVisibility: 'private',
    });
    return edges.find(edge => edge.id === existing.id)!;
  }

  const id = `edge:${randomUUID()}`;
  await adapter.run(`
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
  `, [
    id,
    normalizedEndpoints.sourceEntityId,
    normalizedEndpoints.targetEntityId,
    relationshipType,
    directional ? 1 : 0,
    sensitivity,
    JSON.stringify(provenanceRefs),
    JSON.stringify(evidenceMemoryIds),
    confidence,
    now,
    now,
  ]);

  const edges = await listSocialRelationshipEdges(adapter, {
    entityId: normalizedEndpoints.sourceEntityId,
    relationshipType,
    viewerTrustLevel: 'primary',
    viewerChannelVisibility: 'private',
  });
  return edges.find(edge => edge.id === id)!;
}

export async function listSocialRelationshipEdges(
  adapter: DatabaseAdapter,
  query: SocialRelationshipEdgeQuery = {},
): Promise<SocialRelationshipEdge[]> {
  const limit = Number.isFinite(query.limit) ? Math.max(1, Math.min(Math.floor(query.limit!), 200)) : 200;
  let entityId = query.entityId?.trim() || undefined;
  if (!entityId && query.contactId) {
    const entity = await getSocialGraphEntityByContactId(adapter, query.contactId);
    entityId = entity?.id;
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

  const rows = await adapter.query<Array<SocialRelationshipEdgeRow & {
    source_sensitivity: string;
    target_sensitivity: string;
  }>>(`
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
  `, [...params, limit]);

  return rows
    .filter(row => edgeVisible(
      normalizeSensitivity(row.sensitivity),
      normalizeSensitivity(row.source_sensitivity),
      normalizeSensitivity(row.target_sensitivity),
      query,
    ))
    .map(row => mapSocialRelationshipEdgeRow(row));
}

export async function listRelatedContactIds(
  adapter: DatabaseAdapter,
  contactId: string,
  query: SocialRelationshipEdgeQuery = {},
): Promise<string[]> {
  const entity = await getSocialGraphEntityByContactId(adapter, contactId);
  if (!entity) return [];

  const edges = await listSocialRelationshipEdges(adapter, {
    ...query,
    entityId: entity.id,
  });
  const relatedContactIds = new Set<string>();
  for (const edge of edges) {
    const otherEntityId = edge.sourceEntityId === entity.id ? edge.targetEntityId : edge.sourceEntityId;
    const otherEntity = await getSocialGraphEntityById(adapter, otherEntityId);
    if (otherEntity?.contactId) {
      relatedContactIds.add(otherEntity.contactId);
    }
  }
  return [...relatedContactIds];
}

export async function mergeSocialGraphForContacts(
  adapter: DatabaseAdapter,
  sourceContactId: string,
  targetContactId: string,
): Promise<void> {
  const sourceEntity = await getSocialGraphEntityByContactId(adapter, sourceContactId);
  const targetEntity = await getSocialGraphEntityByContactId(adapter, targetContactId);
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

  await adapter.run(`
    UPDATE social_graph_entities
    SET sensitivity = ?,
        provenance_refs = ?,
        confidence = ?,
        updated_at = ?
    WHERE id = ?
  `, [
    mergedSensitivity,
    JSON.stringify(mergedProvenanceRefs),
    mergedConfidence,
    now,
    targetEntity.id,
  ]);

  const sourceEdges = await adapter.query<SocialRelationshipEdgeRow>(`
    SELECT *
    FROM social_relationship_edges
    WHERE source_entity_id = ? OR target_entity_id = ?
    ORDER BY created_at ASC, id ASC
  `, [sourceEntity.id, sourceEntity.id]);

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
      await adapter.run('DELETE FROM social_relationship_edges WHERE id = ?', [existing.id]);
      continue;
    }

    const duplicateRow = await adapter.queryOne<SocialRelationshipEdgeRow>(`
      SELECT *
      FROM social_relationship_edges
      WHERE source_entity_id = ?
        AND target_entity_id = ?
        AND relationship_type = ?
        AND directional = ?
        AND id != ?
      LIMIT 1
    `, [
      normalizedEndpoints.sourceEntityId,
      normalizedEndpoints.targetEntityId,
      existing.relationshipType,
      existing.directional ? 1 : 0,
      existing.id,
    ]);

    if (duplicateRow) {
      const duplicate = mapSocialRelationshipEdgeRow(duplicateRow);
      await adapter.run(`
        UPDATE social_relationship_edges
        SET sensitivity = ?,
            provenance_refs = ?,
            evidence_memory_ids = ?,
            confidence = ?,
            updated_at = ?
        WHERE id = ?
      `, [
        chooseMoreRestrictiveSensitivity(duplicate.sensitivity, existing.sensitivity),
        JSON.stringify(normalizeStringArray([...duplicate.provenanceRefs, ...existing.provenanceRefs])),
        JSON.stringify(normalizeStringArray([...duplicate.evidenceMemoryIds, ...existing.evidenceMemoryIds])),
        Math.max(duplicate.confidence, existing.confidence),
        existing.updatedAt > duplicate.updatedAt ? existing.updatedAt : duplicate.updatedAt,
        duplicate.id,
      ]);
      await adapter.run('DELETE FROM social_relationship_edges WHERE id = ?', [existing.id]);
      continue;
    }

    await adapter.run(`
      UPDATE social_relationship_edges
      SET source_entity_id = ?,
          target_entity_id = ?,
          updated_at = ?
      WHERE id = ?
    `, [
      normalizedEndpoints.sourceEntityId,
      normalizedEndpoints.targetEntityId,
      now,
      existing.id,
    ]);
  }

  const duplicates = await adapter.query<{
    source_entity_id: string;
    target_entity_id: string;
    relationship_type: string;
    directional: number;
  }>(`
    SELECT
      source_entity_id,
      target_entity_id,
      relationship_type,
      directional
    FROM social_relationship_edges
    GROUP BY source_entity_id, target_entity_id, relationship_type, directional
    HAVING COUNT(*) > 1
  `);

  for (const duplicate of duplicates) {
    const rows = await adapter.query<SocialRelationshipEdgeRow>(`
      SELECT *
      FROM social_relationship_edges
      WHERE source_entity_id = ?
        AND target_entity_id = ?
        AND relationship_type = ?
        AND directional = ?
      ORDER BY created_at ASC, id ASC
    `, [
      duplicate.source_entity_id,
      duplicate.target_entity_id,
      duplicate.relationship_type,
      duplicate.directional,
    ]);

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

    await adapter.run(`
      UPDATE social_relationship_edges
      SET sensitivity = ?,
          provenance_refs = ?,
          evidence_memory_ids = ?,
          confidence = ?,
          updated_at = ?
      WHERE id = ?
    `, [
      mergedEdge.sensitivity,
      JSON.stringify(mergedEdge.provenanceRefs),
      JSON.stringify(mergedEdge.evidenceMemoryIds),
      mergedEdge.confidence,
      mergedEdge.updatedAt,
      primary.id,
    ]);

    for (const row of rest) {
      await adapter.run('DELETE FROM social_relationship_edges WHERE id = ?', [row.id]);
    }
  }

  await adapter.run('DELETE FROM social_graph_entities WHERE id = ?', [sourceEntity.id]);
}