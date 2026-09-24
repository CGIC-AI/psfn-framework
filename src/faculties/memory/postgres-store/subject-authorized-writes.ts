import type {
  MemoryStorePort,
  MemorySubjectAuthorizedMutation,
  MemorySubjectAuthorizedWrite,
} from '../memory-store-port.js';
import {
  MemorySubjectAuthorizationDeniedError,
  parseMemorySubjectQueryAuthorization,
  type MemorySubjectQueryAuthorization,
} from '../../../shared/contracts/memory-subject.js';
import type { MemoryRow } from './rows.js';
import { decodeEmbedding, tryFromMemoryRow, validateEmbeddingDimensions } from './rows.js';
import { buildMemorySubjectAuthorizationPredicate } from './subject-policy.js';
import { MEMORY_SUBJECT_SELECT_COLUMNS } from './subject-queries.js';
import type { PostgresMemoryStoreCollaboratorContext } from './collaborator-context.js';

/**
 * Subject-authorized mutations and writes for PostgresMemoryStore. The target
 * rows are locked `FOR UPDATE` under the SQL subject-authorization predicate
 * inside one memory-store transaction; any unauthorized or missing row denies
 * the whole operation (fail closed) and rolls it back.
 */
export class PostgresMemorySubjectAuthorizedWrites {
  constructor(
    private readonly ctx: Pick<
      PostgresMemoryStoreCollaboratorContext,
      | 'embeddingDims'
      | 'queryWrite'
      | 'hasActiveTransaction'
      | 'runInTransaction'
      | 'setResidentMemory'
    >,
    private readonly writes: Pick<MemoryStorePort, 'updateMemory' | 'insertMemory'>,
  ) {}

  private async lockAuthorizedActiveMemoryRows(
    authorization: MemorySubjectQueryAuthorization,
    memoryIds: readonly string[],
  ): Promise<MemoryRow[]> {
    if (memoryIds.length === 0) return [];
    const predicate = buildMemorySubjectAuthorizationPredicate(authorization, {
      memoryAlias: 'memory',
      firstParameter: 2,
    });
    const authorizedRows = await this.ctx.queryWrite<MemoryRow>(`
      SELECT ${MEMORY_SUBJECT_SELECT_COLUMNS}
      FROM l2_memories memory
      WHERE memory.id = ANY($1::text[])
        AND memory.superseded_by IS NULL
        AND memory.deleted_at IS NULL
        AND ${predicate.sql}
      ORDER BY memory.id
      FOR UPDATE
    `, [memoryIds, ...predicate.values]);
    if (authorizedRows.length !== memoryIds.length) {
      throw new MemorySubjectAuthorizationDeniedError();
    }
    return authorizedRows;
  }

  /**
   * Refreshes the in-memory `memories` snapshot from freshly locked rows so a
   * concurrent committed write cannot be overwritten by stale data. a27w.1:
   * embeddings are no longer cached, so the locked vector is only validated
   * fail-closed (bounded to the locked set) and never retained.
   */
  private hydrateLockedMemoryRows(rows: readonly MemoryRow[], operation: string): void {
    for (const row of rows) {
      const memory = tryFromMemoryRow(row);
      if (!memory) continue;
      this.ctx.setResidentMemory(row.id, memory);
      const embedding = decodeEmbedding(row.embedding);
      if (embedding) {
        validateEmbeddingDimensions(embedding, this.ctx.embeddingDims, operation);
      }
    }
  }

  async mutateAuthorizedMemorySubjects(input: MemorySubjectAuthorizedMutation): Promise<number> {
    const authorization = parseMemorySubjectQueryAuthorization(input.authorization);
    if (authorization.action !== 'bulk_mutation' && authorization.action !== 'update') {
      throw new Error('Memory subject authorization action does not permit mutation');
    }
    const memoryIds = [...new Set(input.memoryIds.flatMap(id => {
      const normalized = id.trim();
      return normalized ? [normalized] : [];
    }))].sort();
    if (memoryIds.length === 0) return 0;
    const mutate = async (): Promise<number> => {
      const authorizedRows = await this.lockAuthorizedActiveMemoryRows(authorization, memoryIds);
      // The SQL lock is authoritative. Refresh the local snapshot before
      // applying the patch so a sibling maintenance/contact process cannot
      // have its committed fields overwritten by stale hydrated state.
      this.hydrateLockedMemoryRows(authorizedRows, 'authorized mutation');
      for (const memoryId of memoryIds) {
        await this.writes.updateMemory(memoryId, input.updates);
      }
      return memoryIds.length;
    };
    return this.ctx.hasActiveTransaction()
      ? await mutate()
      : await this.ctx.runInTransaction(mutate);
  }

  async persistAuthorizedMemoryWrite(input: MemorySubjectAuthorizedWrite): Promise<void> {
    const authorization = parseMemorySubjectQueryAuthorization(input.authorization);
    if (authorization.action !== 'bulk_mutation' && authorization.action !== 'update') {
      throw new Error('Memory subject authorization action does not permit write');
    }
    const supersededMemoryIds = [...new Set(input.supersededMemoryIds?.flatMap(id => {
      const normalized = id.trim();
      return normalized ? [normalized] : [];
    }) ?? [])].sort();
    const commit = async (): Promise<void> => {
      const authorizedRows = await this.lockAuthorizedActiveMemoryRows(
        authorization,
        supersededMemoryIds,
      );
      this.hydrateLockedMemoryRows(authorizedRows, 'authorized write');
      for (const memoryId of supersededMemoryIds) {
        await this.writes.updateMemory(memoryId, { supersededBy: input.memory.id });
      }
      await this.writes.insertMemory(input.memory, input.embedding);
      // The writer must be able to read back the row it persists. The SQL
      // predicate runs against the new row's persisted subject projection in
      // this transaction; a denial throws and rolls back the whole write,
      // including the superseded-row updates above.
      await this.lockAuthorizedActiveMemoryRows(authorization, [input.memory.id]);
    };
    if (this.ctx.hasActiveTransaction()) {
      await commit();
      return;
    }
    await this.ctx.runInTransaction(commit);
  }
}
