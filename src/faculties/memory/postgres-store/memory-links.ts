import { randomUUID } from 'node:crypto';
import { executeQuery, queryRows } from '../../../persistence/postgres.js';
import type {
  MemoryAbstractionLink,
  MemoryAbstractionLinkInput,
  MemoryEvolutionLink,
  MemoryEvolutionLinkInput,
  MemoryEvolutionRelation,
  MemoryLink,
} from '../memory-store-port.js';
import type {
  MemoryAbstractionLinkRow,
  MemoryEvolutionLinkRow,
  MemoryLinkRow,
} from './rows.js';
import { serializeJsonValue } from './rows.js';
import {
  fromEvolutionLinkRow,
  normalizeEvolutionLinkInput,
  normalizeEvolutionRelation,
} from './evolution.js';
import { memoryEvolutionKey, memoryKey } from './utils.js';
import type { PostgresMemoryStoreCollaboratorContext } from './collaborator-context.js';

/**
 * Memory-to-memory relationships for PostgresMemoryStore: abstraction links
 * (`l2_memory_abstraction_links`), evolution decisions
 * (`memory_evolution_links`), and undirected related links (`memory_links`).
 * Each is persisted pool-direct on the facade persist chain and mirrored in
 * memory; none participates in memory-store transactions.
 */
export class PostgresMemoryLinkStore {
  private readonly abstractionLinks = new Map<string, MemoryAbstractionLink>();
  private readonly memoryEvolutionLinks = new Map<string, MemoryEvolutionLink>();
  private readonly memoryLinks = new Map<string, MemoryLink>();

  constructor(
    private readonly ctx: Pick<
      PostgresMemoryStoreCollaboratorContext,
      'pool' | 'persist' | 'markRetrievalCorpusChanged'
    >,
  ) {}

  async hydrate(): Promise<void> {
    const linkRows = await queryRows<MemoryAbstractionLinkRow>(this.ctx.pool, `
      SELECT id, source_memory_id, abstracted_memory_id, external_ref, created_at, created_by, reason
      FROM l2_memory_abstraction_links
    `);
    for (const row of linkRows) {
      const link = {
        id: row.id,
        sourceMemoryId: row.source_memory_id,
        abstractedMemoryId: row.abstracted_memory_id,
        externalRef: row.external_ref,
        createdAt: row.created_at,
        ...(row.created_by ? { createdBy: row.created_by } : {}),
        ...(row.reason ? { reason: row.reason } : {}),
      };
      this.abstractionLinks.set(link.id, link);
    }

    const evolutionLinkRows = await queryRows<MemoryEvolutionLinkRow>(this.ctx.pool, `
      SELECT
        id, source_memory_id, target_memory_id, relation, confidence, reason,
        source_ref, source_type, provenance_refs, provenance_json, created_at
      FROM memory_evolution_links
    `);
    for (const row of evolutionLinkRows) {
      const link = fromEvolutionLinkRow(row);
      this.memoryEvolutionLinks.set(memoryEvolutionKey(
        link.sourceMemoryId,
        link.targetMemoryId,
        link.relation,
      ), link);
    }

    const memoryLinkRows = await queryRows<MemoryLinkRow>(this.ctx.pool, `
      SELECT id1, id2, link_type, created_at FROM memory_links
    `);
    for (const row of memoryLinkRows) {
      this.memoryLinks.set(memoryKey(row.id1, row.id2), {
        id1: row.id1,
        id2: row.id2,
        linkType: row.link_type,
        createdAt: row.created_at,
      });
    }
  }

  /** Read-only view of the recorded evolution decisions, for diagnostics. */
  evolutionLinks(): ReadonlyMap<string, MemoryEvolutionLink> {
    return this.memoryEvolutionLinks;
  }

  async recordAbstractionLink(input: MemoryAbstractionLinkInput): Promise<MemoryAbstractionLink> {
    const id = input.linkId?.trim() || randomUUID();
    const link: MemoryAbstractionLink = {
      id,
      sourceMemoryId: input.sourceMemoryId.trim(),
      abstractedMemoryId: input.abstractedMemoryId.trim(),
      externalRef: input.externalRef.trim(),
      createdAt: input.createdAt ?? Date.now(),
      ...(input.createdBy ? { createdBy: input.createdBy.trim() } : {}),
      ...(input.reason ? { reason: input.reason.trim() } : {}),
    };
    await this.ctx.persist(async () => {
      await executeQuery(this.ctx.pool, `
        INSERT INTO l2_memory_abstraction_links (
          id, source_memory_id, abstracted_memory_id, external_ref, created_at, created_by, reason
        ) VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (id) DO UPDATE SET
          source_memory_id = EXCLUDED.source_memory_id,
          abstracted_memory_id = EXCLUDED.abstracted_memory_id,
          external_ref = EXCLUDED.external_ref,
          created_at = EXCLUDED.created_at,
          created_by = EXCLUDED.created_by,
          reason = EXCLUDED.reason
      `, [link.id, link.sourceMemoryId, link.abstractedMemoryId, link.externalRef, link.createdAt, link.createdBy ?? null, link.reason ?? null]);
    });
    this.abstractionLinks.set(link.id, link);
    return link;
  }

  async getAbstractionLinksForSourceMemory(sourceMemoryId: string): Promise<MemoryAbstractionLink[]> {
    return Array.from(this.abstractionLinks.values()).filter(link => link.sourceMemoryId === sourceMemoryId);
  }

  async getAbstractionLinksForAbstractedMemory(abstractedMemoryId: string): Promise<MemoryAbstractionLink[]> {
    return Array.from(this.abstractionLinks.values()).filter(link => link.abstractedMemoryId === abstractedMemoryId);
  }

  async recordEvolutionLink(input: MemoryEvolutionLinkInput): Promise<MemoryEvolutionLink> {
    const link = normalizeEvolutionLinkInput(input);
    await this.ctx.persist(async () => {
      await executeQuery(this.ctx.pool, `
        INSERT INTO memory_evolution_links (
          id, source_memory_id, target_memory_id, relation, confidence, reason,
          source_ref, source_type, provenance_refs, provenance_json, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (source_memory_id, target_memory_id, relation) DO UPDATE SET
          id = EXCLUDED.id,
          confidence = EXCLUDED.confidence,
          reason = EXCLUDED.reason,
          source_ref = EXCLUDED.source_ref,
          source_type = EXCLUDED.source_type,
          provenance_refs = EXCLUDED.provenance_refs,
          provenance_json = EXCLUDED.provenance_json,
          created_at = EXCLUDED.created_at
      `, [
        link.id,
        link.sourceMemoryId,
        link.targetMemoryId,
        link.relation,
        link.confidence,
        link.reason ?? null,
        link.sourceRef ?? null,
        link.sourceType,
        serializeJsonValue(link.provenanceRefs),
        serializeJsonValue(link.provenance ?? {}),
        link.createdAt,
      ]);
    });
    this.memoryEvolutionLinks.set(memoryEvolutionKey(
      link.sourceMemoryId,
      link.targetMemoryId,
      link.relation,
    ), link);
    this.ctx.markRetrievalCorpusChanged();
    return link;
  }

  async getEvolutionLinksForSourceMemory(
    sourceMemoryId: string,
    relation?: MemoryEvolutionRelation,
  ): Promise<MemoryEvolutionLink[]> {
    const normalized = sourceMemoryId.trim();
    if (!normalized) return [];
    const normalizedRelation = relation ? normalizeEvolutionRelation(relation) : undefined;
    return Array.from(this.memoryEvolutionLinks.values())
      .filter(link => link.sourceMemoryId === normalized)
      .filter(link => normalizedRelation === undefined || link.relation === normalizedRelation)
      .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id));
  }

  async getEvolutionLinksForTargetMemory(
    targetMemoryId: string,
    relation?: MemoryEvolutionRelation,
  ): Promise<MemoryEvolutionLink[]> {
    const normalized = targetMemoryId.trim();
    if (!normalized) return [];
    const normalizedRelation = relation ? normalizeEvolutionRelation(relation) : undefined;
    return Array.from(this.memoryEvolutionLinks.values())
      .filter(link => link.targetMemoryId === normalized)
      .filter(link => normalizedRelation === undefined || link.relation === normalizedRelation)
      .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id));
  }

  async linkMemories(id1: string, id2: string, linkType: string = 'related'): Promise<MemoryLink | null> {
    const normalizedId1 = id1.trim();
    const normalizedId2 = id2.trim();
    if (!normalizedId1 || !normalizedId2 || normalizedId1 === normalizedId2) return null;
    const [first, second] = normalizedId1 < normalizedId2 ? [normalizedId1, normalizedId2] : [normalizedId2, normalizedId1];
    const key = memoryKey(first, second);
    if (this.memoryLinks.has(key)) return null;
    const link: MemoryLink = { id1: first, id2: second, linkType: linkType.trim() || 'related', createdAt: Date.now() };
    await this.ctx.persist(async () => {
      await executeQuery(this.ctx.pool, `
        INSERT INTO memory_links (id1, id2, link_type, created_at)
        VALUES ($1,$2,$3,$4)
        ON CONFLICT (id1, id2) DO UPDATE SET
          link_type = EXCLUDED.link_type,
          created_at = EXCLUDED.created_at
      `, [link.id1, link.id2, link.linkType, link.createdAt]);
    });
    this.memoryLinks.set(key, link);
    this.ctx.markRetrievalCorpusChanged();
    return link;
  }

  async unlinkMemories(id1: string, id2: string): Promise<boolean> {
    const normalizedId1 = id1.trim();
    const normalizedId2 = id2.trim();
    if (!normalizedId1 || !normalizedId2) return false;
    const [first, second] = normalizedId1 < normalizedId2 ? [normalizedId1, normalizedId2] : [normalizedId2, normalizedId1];
    const key = memoryKey(first, second);
    if (!this.memoryLinks.has(key)) return false;
    await this.ctx.persist(async () => {
      await executeQuery(this.ctx.pool, 'DELETE FROM memory_links WHERE id1 = $1 AND id2 = $2', [first, second]);
    });
    this.memoryLinks.delete(key);
    this.ctx.markRetrievalCorpusChanged();
    return true;
  }

  async getLinkedMemories(id: string): Promise<MemoryLink[]> {
    const normalizedId = id.trim();
    if (!normalizedId) return [];
    return Array.from(this.memoryLinks.values())
      .filter(link => link.id1 === normalizedId || link.id2 === normalizedId)
      .sort((left, right) => right.createdAt - left.createdAt);
  }
}
