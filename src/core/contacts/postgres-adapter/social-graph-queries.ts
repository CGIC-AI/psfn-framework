import { randomUUID } from 'node:crypto';
import type { Contact, SocialGraphEntity, SocialGraphEntityQuery, SocialGraphEntityUpsertInput, SocialRelationshipEdge, SocialRelationshipEdgeQuery, SocialRelationshipEdgeUpsertInput } from '../types.js';
import { getAllowedSensitivities } from '../../../system/trust/policy.js';
import {
  chooseMoreRestrictiveSensitivity,
  edgeVisible,
  normalizeLimit,
  normalizeSensitivity,
  normalizeTrimmed,
  normalizeViewerTrustLevel,
  normalizeViewerVisibility,
  socialGraphEdgeRowToEdge,
  socialGraphEntityRowToEntity,
} from './mapping.js';
import type { SocialGraphEntityRow, SocialRelationshipEdgeRow } from './rows.js';
import { queryOne, queryRows } from './connection.js';
import type { PostgresContactOperationMap } from './operation-map.js';
import type { PostgresContactStore } from './store.js';

const postgresContactSocialGraphOperations: PostgresContactOperationMap = {
  async upsertSocialGraphEntityForContact(contact: Pick<Contact, 'id' | 'displayName' | 'firstSeen' | 'lastSeen'>): Promise<SocialGraphEntity> {
    return await this.upsertSocialGraphEntity({
      id: `contact:${contact.id}`,
      displayName: contact.displayName,
      contactId: contact.id,
      source: 'contact',
      confidence: 1,
    });
  },

  async loadSocialGraphEntityByRow(row: SocialGraphEntityRow | undefined): Promise<SocialGraphEntity | undefined> {
    return row ? socialGraphEntityRowToEntity(row) : undefined;
  },

  async loadSocialGraphEntityById(entityId: string): Promise<SocialGraphEntity | undefined> {
    const row = await queryOne<SocialGraphEntityRow>(
      this.pool,
      `
        SELECT id, entity_kind, display_name, contact_id, sensitivity, provenance_refs,
               confidence, source, created_at, updated_at
        FROM social_graph_entities
        WHERE id = $1
        LIMIT 1
      `,
      [entityId],
    );
    return await this.loadSocialGraphEntityByRow(row);
  },

  async loadSocialGraphEntityByContactId(contactId: string): Promise<SocialGraphEntity | undefined> {
    const row = await queryOne<SocialGraphEntityRow>(
      this.pool,
      `
        SELECT id, entity_kind, display_name, contact_id, sensitivity, provenance_refs,
               confidence, source, created_at, updated_at
        FROM social_graph_entities
        WHERE contact_id = $1
        LIMIT 1
      `,
      [contactId],
    );
    return await this.loadSocialGraphEntityByRow(row);
  },

  async loadSocialRelationshipEdgeRows(
    query: SocialRelationshipEdgeQuery = {},
  ): Promise<Array<SocialRelationshipEdgeRow & { source_sensitivity: string; target_sensitivity: string }>> {
    const limit = normalizeLimit(query.limit, 200, 1, 200);
    let entityId = normalizeTrimmed(query.entityId);
    if (!entityId && query.contactId) {
      entityId = (await this.loadSocialGraphEntityByContactId(query.contactId))?.id;
    }
    if (query.contactId && !entityId) return [];

    const params: unknown[] = [];
    const clauses: string[] = [];
    if (entityId) {
      clauses.push('(e.source_entity_id = $1 OR e.target_entity_id = $1)');
      params.push(entityId);
    }
    if (query.relationshipType) {
      clauses.push(`e.relationship_type = $${params.length + 1}`);
      params.push(query.relationshipType);
    }
    if (Number.isFinite(query.minConfidence)) {
      clauses.push(`e.confidence >= $${params.length + 1}`);
      params.push(query.minConfidence);
    }

    const sql = `
      SELECT
        e.id,
        e.source_entity_id,
        e.target_entity_id,
        e.relationship_type,
        e.directional,
        e.sensitivity,
        e.provenance_refs,
        e.evidence_memory_ids,
        e.confidence,
        e.created_at,
        e.updated_at,
        source.sensitivity AS source_sensitivity,
        target.sensitivity AS target_sensitivity
      FROM social_relationship_edges e
      INNER JOIN social_graph_entities source ON source.id = e.source_entity_id
      INNER JOIN social_graph_entities target ON target.id = e.target_entity_id
      ${clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY e.updated_at DESC, e.created_at DESC
      LIMIT $${params.length + 1}
    `;
    return await queryRows<SocialRelationshipEdgeRow & { source_sensitivity: string; target_sensitivity: string }>(
      this.pool,
      sql,
      [...params, limit],
    );
  },

  async loadRelatedContactIds(contactId: string, query: SocialRelationshipEdgeQuery = {}): Promise<string[]> {
    const entity = await this.loadSocialGraphEntityByContactId(contactId);
    if (!entity) return [];
    const rows = await this.loadSocialRelationshipEdgeRows({
      ...query,
      entityId: entity.id,
    });
    const related = new Set<string>();
    for (const row of rows) {
      const edge = socialGraphEdgeRowToEdge(row);
      const otherEntityId = edge.sourceEntityId === entity.id ? edge.targetEntityId : edge.sourceEntityId;
      const otherEntity = await this.loadSocialGraphEntityById(otherEntityId);
      if (otherEntity?.contactId) {
        related.add(otherEntity.contactId);
      }
    }
    return [...related];
  },

  async getSocialGraphEntityById(entityId: string): Promise<SocialGraphEntity | undefined> {
    return await this.loadSocialGraphEntityById(entityId);
  },

  async getSocialGraphEntityByContactId(contactId: string): Promise<SocialGraphEntity | undefined> {
    return await this.loadSocialGraphEntityByContactId(contactId);
  },

  async listSocialGraphEntities(query: SocialGraphEntityQuery = {}): Promise<SocialGraphEntity[]> {
    const limit = normalizeLimit(query.limit, 100, 1, 100);
    const allowed = new Set(getAllowedSensitivities(
      normalizeViewerTrustLevel(query.viewerTrustLevel),
      normalizeViewerVisibility(query.viewerChannelVisibility),
    ));
    const rows = query.contactId
      ? await queryRows<SocialGraphEntityRow>(
        this.pool,
        `
          SELECT id, entity_kind, display_name, contact_id, sensitivity, provenance_refs,
                 confidence, source, created_at, updated_at
          FROM social_graph_entities
          WHERE contact_id = $1
          ORDER BY updated_at DESC
          LIMIT $2
        `,
        [query.contactId, limit],
      )
      : await queryRows<SocialGraphEntityRow>(
        this.pool,
        `
          SELECT id, entity_kind, display_name, contact_id, sensitivity, provenance_refs,
                 confidence, source, created_at, updated_at
          FROM social_graph_entities
          ORDER BY updated_at DESC
          LIMIT $1
        `,
        [limit],
      );
    return rows
      .map(socialGraphEntityRowToEntity)
      .filter(entity => allowed.has(entity.sensitivity));
  },

  async upsertSocialGraphEntity(input: SocialGraphEntityUpsertInput): Promise<SocialGraphEntity> {
    const displayName = input.displayName.trim();
    if (!displayName) {
      throw new Error('social graph entity displayName must be non-empty');
    }
    const normalizedContactId = normalizeTrimmed(input.contactId);
    const existing = normalizedContactId
      ? await this.loadSocialGraphEntityByContactId(normalizedContactId)
      : (input.id ? await this.loadSocialGraphEntityById(input.id) : undefined);
    const now = new Date().toISOString();
    const id = normalizedContactId
      ? `contact:${normalizedContactId}`
      : (normalizeTrimmed(input.id) ?? `entity:${randomUUID()}`);
    const sensitivity = input.sensitivity ?? 'personal';
    const entityKind = input.entityKind ?? 'person';
    const source = input.source ?? (normalizedContactId ? 'contact' : 'manual');
    const provenanceRefs = input.provenanceRefs ?? [];
    const confidence = input.confidence ?? (normalizedContactId ? 1 : 0.7);

    if (existing) {
      const nextSensitivity = chooseMoreRestrictiveSensitivity(
        existing.sensitivity,
        sensitivity,
      );
      const nextProvenanceRefs = [...new Set([...existing.provenanceRefs, ...provenanceRefs])];
      const nextConfidence = Math.max(existing.confidence, confidence);
      await this.pool.query(
        `
          UPDATE social_graph_entities
          SET entity_kind = $1,
              display_name = $2,
              contact_id = $3,
              sensitivity = $4,
              provenance_refs = $5,
              confidence = $6,
              source = $7,
              updated_at = $8
          WHERE id = $9
        `,
        [entityKind, displayName, normalizedContactId ?? null, nextSensitivity, nextProvenanceRefs, nextConfidence, source, now, existing.id],
      );
      const updated = await this.loadSocialGraphEntityById(existing.id);
      if (!updated) throw new Error(`Failed to reload social graph entity ${existing.id}`);
      return updated;
    }

    await this.pool.query(
      `
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
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `,
      [id, entityKind, displayName, normalizedContactId ?? null, sensitivity, provenanceRefs, confidence, source, now, now],
    );
    const created = await this.loadSocialGraphEntityById(id);
    if (!created) throw new Error(`Failed to load social graph entity ${id}`);
    return created;
  },

  async upsertSocialRelationshipEdge(input: SocialRelationshipEdgeUpsertInput): Promise<SocialRelationshipEdge> {
    const sourceEntityId = input.sourceEntityId.trim();
    const targetEntityId = input.targetEntityId.trim();
    if (!sourceEntityId || !targetEntityId) {
      throw new Error('social relationship edge requires sourceEntityId and targetEntityId');
    }
    if (sourceEntityId === targetEntityId) {
      throw new Error('social relationship edge cannot target the same entity');
    }

    const directional = input.directional ?? true;
    const relationshipType = input.relationshipType;
    const sensitivity = input.sensitivity ?? 'personal';
    const provenanceRefs = input.provenanceRefs ?? [];
    const evidenceMemoryIds = input.evidenceMemoryIds ?? [];
    const confidence = input.confidence ?? 0.7;
    const sourceExists = await this.loadSocialGraphEntityById(sourceEntityId);
    const targetExists = await this.loadSocialGraphEntityById(targetEntityId);
    if (!sourceExists || !targetExists) {
      throw new Error('social relationship edge requires existing source and target entities');
    }

    const existing = await queryOne<SocialRelationshipEdgeRow>(
      this.pool,
      `
        SELECT id, source_entity_id, target_entity_id, relationship_type, directional,
               sensitivity, provenance_refs, evidence_memory_ids, confidence, created_at, updated_at
        FROM social_relationship_edges
        WHERE source_entity_id = $1
          AND target_entity_id = $2
          AND relationship_type = $3
          AND directional = $4
        LIMIT 1
      `,
      [sourceEntityId, targetEntityId, relationshipType, directional],
    );
    const now = new Date().toISOString();

    if (existing) {
      const existingEdge = socialGraphEdgeRowToEdge(existing);
      const nextSensitivity = existingEdge.sensitivity >= sensitivity ? existingEdge.sensitivity : sensitivity;
      const nextProvenanceRefs = [...new Set([...existingEdge.provenanceRefs, ...provenanceRefs])];
      const nextEvidenceMemoryIds = [...new Set([...existingEdge.evidenceMemoryIds, ...evidenceMemoryIds])];
      const nextConfidence = Math.max(existingEdge.confidence, confidence);
      await this.pool.query(
        `
          UPDATE social_relationship_edges
          SET sensitivity = $1,
              provenance_refs = $2,
              evidence_memory_ids = $3,
              confidence = $4,
              updated_at = $5
          WHERE id = $6
        `,
        [nextSensitivity, nextProvenanceRefs, nextEvidenceMemoryIds, nextConfidence, now, existingEdge.id],
      );
      const updated = await queryOne<SocialRelationshipEdgeRow>(
        this.pool,
        `
          SELECT id, source_entity_id, target_entity_id, relationship_type, directional,
                 sensitivity, provenance_refs, evidence_memory_ids, confidence, created_at, updated_at
          FROM social_relationship_edges
          WHERE id = $1
          LIMIT 1
        `,
        [existingEdge.id],
      );
      if (!updated) throw new Error(`Failed to reload social relationship edge ${existingEdge.id}`);
      return socialGraphEdgeRowToEdge(updated);
    }

    const id = `edge:${randomUUID()}`;
    await this.pool.query(
      `
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
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      `,
      [id, sourceEntityId, targetEntityId, relationshipType, directional, sensitivity, provenanceRefs, evidenceMemoryIds, confidence, now, now],
    );
    const created = await queryOne<SocialRelationshipEdgeRow>(
      this.pool,
      `
        SELECT id, source_entity_id, target_entity_id, relationship_type, directional,
               sensitivity, provenance_refs, evidence_memory_ids, confidence, created_at, updated_at
        FROM social_relationship_edges
        WHERE id = $1
        LIMIT 1
      `,
      [id],
    );
    if (!created) throw new Error(`Failed to load social relationship edge ${id}`);
    return socialGraphEdgeRowToEdge(created);
  },

  async listSocialRelationshipEdges(query: SocialRelationshipEdgeQuery = {}): Promise<SocialRelationshipEdge[]> {
    const rows = await this.loadSocialRelationshipEdgeRows(query);
    return rows
      .filter(row => edgeVisible(
        normalizeSensitivity(row.sensitivity),
        normalizeSensitivity(row.source_sensitivity),
        normalizeSensitivity(row.target_sensitivity),
        query,
      ))
      .map(socialGraphEdgeRowToEdge);
  },

  async listRelatedContacts(contactId: string, query: SocialRelationshipEdgeQuery = {}): Promise<Contact[]> {
    const relatedIds = await this.loadRelatedContactIds(contactId, query);
    const contacts: Contact[] = [];
    for (const relatedId of relatedIds) {
      const contact = await this.getById(relatedId);
      if (contact) contacts.push(contact);
    }
    return contacts;
  },
};

export function installPostgresContactSocialGraphOperations(store: typeof PostgresContactStore): void {
  Object.assign(store.prototype, postgresContactSocialGraphOperations);
}

