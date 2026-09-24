import { executeQuery, queryRows } from '../../../persistence/postgres.js';
import type { RecentContactShapeArtifact } from '../memory-store-port.js';
import type { RecentContactShapeRow } from './rows.js';
import { decodeStringArray, parsePgNumber, serializeJsonValue } from './rows.js';
import type { PostgresMemoryStoreCollaboratorContext } from './collaborator-context.js';

const CONTACT_SHAPE_COLUMNS = `
  schema_version, contact_id, summary_text, source_memory_ids,
  confidence_score, novelty_score, updated_at, fresh_until
`;

function fromRecentContactShapeRow(row: RecentContactShapeRow): RecentContactShapeArtifact {
  return {
    schemaVersion: 1,
    contactId: row.contact_id,
    summary: row.summary_text,
    sourceMemoryIds: decodeStringArray(row.source_memory_ids),
    confidenceScore: row.confidence_score,
    noveltyScore: row.novelty_score,
    updatedAt: parsePgNumber(row.updated_at, 'recent_contact_shapes.updated_at'),
    freshUntil: parsePgNumber(row.fresh_until, 'recent_contact_shapes.fresh_until'),
  };
}

/**
 * Recent contact-shape artifacts for PostgresMemoryStore, persisted in
 * `recent_contact_shapes` (schema version 1) and read at query time keyed by
 * contact (t4mia); nothing is hydrated into process memory.
 */
export class PostgresRecentContactShapeStore {
  constructor(
    private readonly ctx: Pick<
      PostgresMemoryStoreCollaboratorContext,
      'pool' | 'persist' | 'markRetrievalCorpusChanged'
    >,
  ) {}

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
    this.ctx.markRetrievalCorpusChanged();
  }

  async getRecentContactShape(contactId: string): Promise<RecentContactShapeArtifact | undefined> {
    const rows = await queryRows<RecentContactShapeRow>(this.ctx.pool, `
      SELECT ${CONTACT_SHAPE_COLUMNS}
      FROM recent_contact_shapes
      WHERE schema_version = 1 AND contact_id = $1
    `, [contactId]);
    const row = rows.at(0);
    return row ? fromRecentContactShapeRow(row) : undefined;
  }

  async listRecentContactShapes(): Promise<RecentContactShapeArtifact[]> {
    const rows = await queryRows<RecentContactShapeRow>(this.ctx.pool, `
      SELECT ${CONTACT_SHAPE_COLUMNS}
      FROM recent_contact_shapes
      WHERE schema_version = 1
      ORDER BY updated_at DESC, contact_id ASC
    `);
    return rows.map(fromRecentContactShapeRow);
  }
}
