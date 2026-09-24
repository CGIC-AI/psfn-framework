import { executeQuery } from '../../../persistence/postgres.js';
import type {
  MemoryBulkUpdatePatch,
  MemorySalienceUpdate,
} from '../memory-store-port.js';
import { normalizeMemorySalienceUpdates } from '../memory-store-port.js';
import { applyRetentionClassTags, type PurrMemory } from '../types.js';
import type { PostgresMemoryStoreCollaboratorContext } from './collaborator-context.js';
import type { PostgresL2ReadModel } from './l2-read-model.js';

/**
 * Operator bulk field updates and batched salience maintenance for
 * PostgresMemoryStore. Each batch is a single `UPDATE ... FROM (VALUES ...)`
 * on the facade persist chain; the current rows are read through the L2 read
 * model, and change counters advance only when Postgres reports an update.
 */
export class PostgresMemoryBulkUpdates {
  constructor(
    private readonly ctx: Pick<
      PostgresMemoryStoreCollaboratorContext,
      | 'pool'
      | 'persist'
      | 'markSalienceMaintenanceChanged'
      | 'markRetrievalCorpusChanged'
    >,
    private readonly reads: Pick<PostgresL2ReadModel, 'getByIds'>,
  ) {}

  async bulkUpdate(ids: string[], fields: MemoryBulkUpdatePatch): Promise<number> {
    if (
      fields.type === undefined
      && fields.sensitivity === undefined
      && fields.retentionClass === undefined
    ) {
      return 0;
    }

    const normalizedIds = ids.map(id => id.trim()).filter(id => id.length > 0);
    const existingById = new Map(
      (await this.reads.getByIds(normalizedIds)).map(memory => [memory.id, memory]),
    );
    const updatesById = new Map<string, PurrMemory>();
    for (const normalizedId of normalizedIds) {
      const existing = existingById.get(normalizedId);
      if (!existing || existing.deletedAt) continue;
      const next = { ...existing };
      if (fields.type !== undefined) next.type = fields.type;
      if (fields.sensitivity !== undefined) next.sensitivity = fields.sensitivity;
      if (fields.retentionClass !== undefined) {
        next.retentionClass = fields.retentionClass;
        next.tags = applyRetentionClassTags(existing, fields.retentionClass);
      }
      updatesById.set(normalizedId, next);
    }
    const updates = [...updatesById.values()];
    if (updates.length === 0) return 0;

    const values: unknown[] = [];
    const valueColumns = ['id'];
    const setClauses: string[] = [];
    if (fields.type !== undefined) {
      valueColumns.push('type');
      setClauses.push('type = updates.type');
    }
    if (fields.sensitivity !== undefined) {
      valueColumns.push('sensitivity');
      setClauses.push('sensitivity = updates.sensitivity');
    }
    if (fields.retentionClass !== undefined) {
      valueColumns.push('retention_class', 'tags');
      setClauses.push('retention_class = updates.retention_class', 'tags = updates.tags');
    }

    const rows = updates.map((update) => {
      const row: string[] = [];
      values.push(update.id);
      row.push(`$${values.length}::text`);
      if (fields.type !== undefined) {
        values.push(update.type);
        row.push(`$${values.length}::text`);
      }
      if (fields.sensitivity !== undefined) {
        values.push(update.sensitivity);
        row.push(`$${values.length}::text`);
      }
      if (fields.retentionClass !== undefined) {
        values.push(update.retentionClass ?? null);
        row.push(`$${values.length}::text`);
        values.push(JSON.stringify(update.tags));
        row.push(`$${values.length}::jsonb`);
      }
      return `(${row.join(', ')})`;
    });

    const result = await this.ctx.persist(() => executeQuery<{ id: unknown }>(this.ctx.pool, `
      UPDATE l2_memories AS memory
      SET ${setClauses.join(', ')}
      FROM (VALUES ${rows.join(', ')}) AS updates(${valueColumns.join(', ')})
      WHERE memory.id = updates.id
        AND memory.deleted_at IS NULL
      RETURNING memory.id
    `, values));

    const updatedIds = new Set(result.rows.flatMap(row => (
      typeof row.id === 'string' ? [row.id] : []
    )));
    if (updatedIds.size > 0) {
      this.ctx.markSalienceMaintenanceChanged();
      this.ctx.markRetrievalCorpusChanged();
    }
    return result.rowCount ?? updatedIds.size;
  }

  async bulkUpdateSalience(updates: MemorySalienceUpdate[]): Promise<number> {
    const normalizedUpdates = normalizeMemorySalienceUpdates(updates);
    if (normalizedUpdates.length === 0) return 0;

    const values: unknown[] = [];
    const rows = normalizedUpdates.map((update, index) => {
      const idParam = index * 3 + 1;
      const salienceParam = idParam + 1;
      const anchorParam = salienceParam + 1;
      values.push(update.id, update.salience, update.salienceDecayAnchorAt);
      return `($${idParam}::text, $${salienceParam}::numeric, $${anchorParam}::bigint)`;
    });

    const result = await this.ctx.persist(() => executeQuery<{ id: unknown }>(this.ctx.pool, `
      UPDATE l2_memories AS memory
      SET salience = updates.salience,
          salience_decay_anchor_at = updates.salience_decay_anchor_at
      FROM (VALUES ${rows.join(', ')}) AS updates(id, salience, salience_decay_anchor_at)
      WHERE memory.id = updates.id
        AND memory.deleted_at IS NULL
        AND memory.superseded_by IS NULL
      RETURNING memory.id
    `, values));

    const updatedIds = new Set(result.rows.flatMap(row => (
      typeof row.id === 'string' ? [row.id] : []
    )));
    if (updatedIds.size > 0) {
      this.ctx.markSalienceMaintenanceChanged();
      this.ctx.markRetrievalCorpusChanged();
    }

    return result.rowCount ?? 0;
  }
}
