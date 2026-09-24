import { randomUUID } from 'node:crypto';
import { executeQuery, queryRows } from '../../../persistence/postgres.js';
import { MEMORY_EVOLUTION_RELATIONS } from '../memory-store-port.js';
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
import { parsePgNumber, serializeJsonValue } from './rows.js';
import {
  fromEvolutionLinkRow,
  normalizeEvolutionLinkInput,
  normalizeEvolutionRelation,
} from './evolution.js';
import type { PostgresMemoryStoreCollaboratorContext } from './collaborator-context.js';

/** Diagnostic totals over the recorded evolution decisions. */
export interface MemoryEvolutionDecisionSummary {
  readonly total: number;
  readonly byRelation: Readonly<Record<MemoryEvolutionRelation, number>>;
  readonly latestCreatedAt?: number;
}

const ABSTRACTION_LINK_COLUMNS = `
  id, source_memory_id, abstracted_memory_id, external_ref, created_at, created_by, reason
`;
const EVOLUTION_LINK_COLUMNS = `
  id, source_memory_id, target_memory_id, relation, confidence, reason,
  source_ref, source_type, provenance_refs, provenance_json, created_at
`;

function fromAbstractionLinkRow(row: MemoryAbstractionLinkRow): MemoryAbstractionLink {
  return {
    id: row.id,
    sourceMemoryId: row.source_memory_id,
    abstractedMemoryId: row.abstracted_memory_id,
    externalRef: row.external_ref,
    createdAt: parsePgNumber(row.created_at, 'l2_memory_abstraction_links.created_at'),
    ...(row.created_by ? { createdBy: row.created_by } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
  };
}

function fromMemoryLinkRow(row: MemoryLinkRow): MemoryLink {
  return {
    id1: row.id1,
    id2: row.id2,
    linkType: row.link_type,
    createdAt: parsePgNumber(row.created_at, 'memory_links.created_at'),
  };
}

function orderedPair(id1: string, id2: string): [string, string] | null {
  const first = id1.trim();
  const second = id2.trim();
  if (!first || !second) return null;
  return first < second ? [first, second] : [second, first];
}

/**
 * Memory-to-memory relationships for PostgresMemoryStore: abstraction links
 * (`l2_memory_abstraction_links`), evolution decisions
 * (`memory_evolution_links`), and undirected related links (`memory_links`).
 * Each is persisted pool-direct on the facade persist chain and read at query
 * time keyed by endpoint (t4mia); none is hydrated into process memory and
 * none participates in memory-store transactions.
 */
export class PostgresMemoryLinkStore {
  constructor(
    private readonly ctx: Pick<
      PostgresMemoryStoreCollaboratorContext,
      'pool' | 'persist' | 'markRetrievalCorpusChanged'
    >,
  ) {}

  /** Counts per relation plus the newest decision time, for diagnostics. */
  async summarizeEvolutionDecisions(): Promise<MemoryEvolutionDecisionSummary> {
    const rows = await queryRows<{ relation: string; count: unknown; latest: unknown }>(this.ctx.pool, `
      SELECT relation, COUNT(*) AS count, MAX(created_at) AS latest
      FROM memory_evolution_links
      GROUP BY relation
    `);
    const byRelation: Record<MemoryEvolutionRelation, number> = {
      supersedes: 0,
      updates: 0,
      negates: 0,
      conflicts_with: 0,
    };
    let total = 0;
    let latestCreatedAt: number | undefined;
    for (const row of rows) {
      // Same decoding as fromEvolutionLinkRow: an unrecognized stored relation
      // counts as 'updates'.
      const relation = (MEMORY_EVOLUTION_RELATIONS as readonly string[]).includes(row.relation)
        ? row.relation as MemoryEvolutionRelation
        : 'updates';
      const count = parsePgNumber(row.count, 'memory_evolution_links.count');
      byRelation[relation] += count;
      total += count;
      latestCreatedAt = Math.max(
        latestCreatedAt ?? 0,
        parsePgNumber(row.latest, 'memory_evolution_links.created_at'),
      );
    }
    return {
      total,
      byRelation,
      ...(latestCreatedAt !== undefined ? { latestCreatedAt } : {}),
    };
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
    return link;
  }

  async getAbstractionLinksForSourceMemory(sourceMemoryId: string): Promise<MemoryAbstractionLink[]> {
    const rows = await queryRows<MemoryAbstractionLinkRow>(this.ctx.pool, `
      SELECT ${ABSTRACTION_LINK_COLUMNS}
      FROM l2_memory_abstraction_links
      WHERE source_memory_id = $1
      ORDER BY created_at ASC, id ASC
    `, [sourceMemoryId]);
    return rows.map(fromAbstractionLinkRow);
  }

  async getAbstractionLinksForAbstractedMemory(abstractedMemoryId: string): Promise<MemoryAbstractionLink[]> {
    const rows = await queryRows<MemoryAbstractionLinkRow>(this.ctx.pool, `
      SELECT ${ABSTRACTION_LINK_COLUMNS}
      FROM l2_memory_abstraction_links
      WHERE abstracted_memory_id = $1
      ORDER BY created_at ASC, id ASC
    `, [abstractedMemoryId]);
    return rows.map(fromAbstractionLinkRow);
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
    this.ctx.markRetrievalCorpusChanged();
    return link;
  }

  async getEvolutionLinksForSourceMemory(
    sourceMemoryId: string,
    relation?: MemoryEvolutionRelation,
  ): Promise<MemoryEvolutionLink[]> {
    return await this.evolutionLinksByEndpoint('source_memory_id', sourceMemoryId, relation);
  }

  async getEvolutionLinksForTargetMemory(
    targetMemoryId: string,
    relation?: MemoryEvolutionRelation,
  ): Promise<MemoryEvolutionLink[]> {
    return await this.evolutionLinksByEndpoint('target_memory_id', targetMemoryId, relation);
  }

  private async evolutionLinksByEndpoint(
    endpoint: 'source_memory_id' | 'target_memory_id',
    memoryId: string,
    relation?: MemoryEvolutionRelation,
  ): Promise<MemoryEvolutionLink[]> {
    const normalized = memoryId.trim();
    if (!normalized) return [];
    const normalizedRelation = relation ? normalizeEvolutionRelation(relation) : null;
    const rows = await queryRows<MemoryEvolutionLinkRow>(this.ctx.pool, `
      SELECT ${EVOLUTION_LINK_COLUMNS}
      FROM memory_evolution_links
      WHERE ${endpoint} = $1
        AND ($2::text IS NULL OR relation = $2)
      ORDER BY created_at DESC, id DESC
    `, [normalized, normalizedRelation]);
    return rows.map(row => fromEvolutionLinkRow({
      ...row,
      created_at: parsePgNumber(row.created_at, 'memory_evolution_links.created_at'),
    }));
  }

  async linkMemories(id1: string, id2: string, linkType: string = 'related'): Promise<MemoryLink | null> {
    const pair = orderedPair(id1, id2);
    if (!pair || pair[0] === pair[1]) return null;
    const [first, second] = pair;
    const link: MemoryLink = { id1: first, id2: second, linkType: linkType.trim() || 'related', createdAt: Date.now() };
    // An existing link is left untouched and reported as not created.
    const inserted = await this.ctx.persist(async () => await queryRows<{ id1: string }>(this.ctx.pool, `
      INSERT INTO memory_links (id1, id2, link_type, created_at)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (id1, id2) DO NOTHING
      RETURNING id1
    `, [link.id1, link.id2, link.linkType, link.createdAt]));
    if (inserted.length === 0) return null;
    this.ctx.markRetrievalCorpusChanged();
    return link;
  }

  async unlinkMemories(id1: string, id2: string): Promise<boolean> {
    const pair = orderedPair(id1, id2);
    if (!pair) return false;
    const [first, second] = pair;
    const deleted = await this.ctx.persist(async () => await queryRows<{ id1: string }>(
      this.ctx.pool,
      'DELETE FROM memory_links WHERE id1 = $1 AND id2 = $2 RETURNING id1',
      [first, second],
    ));
    if (deleted.length === 0) return false;
    this.ctx.markRetrievalCorpusChanged();
    return true;
  }

  async getLinkedMemories(id: string): Promise<MemoryLink[]> {
    const normalizedId = id.trim();
    if (!normalizedId) return [];
    const rows = await queryRows<MemoryLinkRow>(this.ctx.pool, `
      SELECT id1, id2, link_type, created_at
      FROM memory_links
      WHERE id1 = $1 OR id2 = $1
      ORDER BY created_at DESC, id1 ASC, id2 ASC
    `, [normalizedId]);
    return rows.map(fromMemoryLinkRow);
  }
}
