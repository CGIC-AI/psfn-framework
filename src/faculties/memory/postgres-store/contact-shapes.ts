import { executeQuery, queryRows } from '../../../persistence/postgres.js';
import type { RecentContactShapeArtifact } from '../memory-store-port.js';
import type { RecentContactShapeRow } from './rows.js';
import { decodeStringArray, serializeJsonValue } from './rows.js';
import type { PostgresMemoryStoreCollaboratorContext } from './collaborator-context.js';

/**
 * Recent contact-shape artifacts for PostgresMemoryStore, persisted in
 * `recent_contact_shapes` (schema version 1) and mirrored in memory.
 */
export class PostgresRecentContactShapeStore {
  private readonly shapes = new Map<string, RecentContactShapeArtifact>();

  constructor(
    private readonly ctx: Pick<
      PostgresMemoryStoreCollaboratorContext,
      'pool' | 'persist' | 'markRetrievalCorpusChanged'
    >,
  ) {}

  async hydrate(): Promise<void> {
    const recentContactShapes = await queryRows<RecentContactShapeRow>(this.ctx.pool, `
      SELECT schema_version, contact_id, summary_text, source_memory_ids,
             confidence_score, novelty_score, updated_at, fresh_until
      FROM recent_contact_shapes
      WHERE schema_version = 1
    `);
    for (const row of recentContactShapes) {
      this.shapes.set(row.contact_id, {
        schemaVersion: 1,
        contactId: row.contact_id,
        summary: row.summary_text,
        sourceMemoryIds: decodeStringArray(row.source_memory_ids),
        confidenceScore: row.confidence_score,
        noveltyScore: row.novelty_score,
        updatedAt: row.updated_at,
        freshUntil: row.fresh_until,
      });
    }
  }

  private async persistRecentContactShape(shape: RecentContactShapeArtifact): Promise<void> {
    await executeQuery(this.ctx.pool, `
      INSERT INTO recent_contact_shapes (
        schema_version, contact_id, summary_text, source_memory_ids,
        confidence_score, novelty_score, updated_at, fresh_until
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (contact_id) DO UPDATE SET
        schema_version = EXCLUDED.schema_version,
        summary_text = EXCLUDED.summary_text,
        source_memory_ids = EXCLUDED.source_memory_ids,
        confidence_score = EXCLUDED.confidence_score,
        novelty_score = EXCLUDED.novelty_score,
        updated_at = EXCLUDED.updated_at,
        fresh_until = EXCLUDED.fresh_until
    `, [
      shape.schemaVersion,
      shape.contactId,
      shape.summary,
      serializeJsonValue(shape.sourceMemoryIds),
      shape.confidenceScore,
      shape.noveltyScore,
      shape.updatedAt,
      shape.freshUntil,
    ]);
  }

  async upsertRecentContactShape(shape: RecentContactShapeArtifact): Promise<void> {
    await this.ctx.persist(() => this.persistRecentContactShape(shape));
    this.shapes.set(shape.contactId, shape);
    this.ctx.markRetrievalCorpusChanged();
  }

  async getRecentContactShape(contactId: string): Promise<RecentContactShapeArtifact | undefined> {
    return this.shapes.get(contactId);
  }

  async listRecentContactShapes(): Promise<RecentContactShapeArtifact[]> {
    return Array.from(this.shapes.values()).sort((left, right) => right.updatedAt - left.updatedAt);
  }
}
