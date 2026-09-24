import type { QueryResultRow } from 'pg';
import { queryRows } from '../../../persistence/postgres.js';
import { assertMemoryListPosition } from '../list-position.js';
import type {
  ActiveMemoryListOptions,
  MemoryListOptions,
  MemoryStoreStats,
} from '../memory-store-port.js';
import {
  READABLE_PERSISTED_MEMORY_TYPES,
  normalizeMemoryScopeQuery,
  resolvePersistedMemoryType,
  type MemoryScopeQuery,
  type PurrMemory,
} from '../types.js';
import type { CountRow, MemoryRow } from './rows.js';
import { parsePgNumber, tryFromMemoryRow } from './rows.js';
import { clampLimit, lexicalScore } from './utils.js';
import { MEMORY_SUBJECT_METADATA_SELECT_COLUMNS } from './subject-queries.js';
import type { PostgresMemoryStoreCollaboratorContext } from './collaborator-context.js';

interface TypeStatsRow extends QueryResultRow {
  type: string;
  count: number | string;
  salience_sum: number | string | null;
}

const ACTIVE = 'memory.superseded_by IS NULL AND memory.deleted_at IS NULL';

/**
 * Tokenization shared with {@link lexicalScore}: lower-cased `[a-z0-9]+` runs.
 * Duplicate tokens are kept, exactly as lexicalScore counts them.
 */
function lexicalTokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map(token => token.trim())
    .filter(token => token.length > 0);
}

function sqlRowLimit(limit: number, operation: string): number {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new Error(`${operation} requires a non-negative integer limit, got ${String(limit)}`);
  }
  return limit;
}

function decodeRows(rows: readonly MemoryRow[]): PurrMemory[] {
  return rows.flatMap((row) => {
    const memory = tryFromMemoryRow(row);
    return memory ? [memory] : [];
  });
}

/**
 * Query-time L2 metadata reads for PostgresMemoryStore (psfn-framework-ufgwv).
 * Replaces the former boot-time hydration of every `l2_memories` row into a
 * resident Map: detail, batch, count, list, channel/contact slices, stats,
 * and raw lexical search are answered by SQL on demand, projecting metadata
 * only (never `embedding::text`).
 *
 * Every read binds {@link READABLE_PERSISTED_MEMORY_TYPES} so LIMIT and COUNT
 * windows cover exactly the rows `tryFromMemoryRow` decodes, as the Map did.
 * Inside a memory-store transaction reads run on the transaction client, so
 * a handler observes its own staged writes; outside, they run on the pool and
 * observe committed state only (a rolled-back write is never visible).
 *
 * These are system-internal reads: product recall reaches L2 through the
 * subject-authorized selectors in subject-queries.ts, which are unchanged.
 */
export class PostgresL2ReadModel {
  constructor(
    private readonly ctx: Pick<
      PostgresMemoryStoreCollaboratorContext,
      'pool' | 'hasActiveTransaction' | 'queryWrite'
    >,
  ) {}

  private async read<T extends QueryResultRow>(text: string, values: readonly unknown[]): Promise<T[]> {
    if (this.ctx.hasActiveTransaction()) {
      return await this.ctx.queryWrite<T>(text, values);
    }
    return await queryRows<T>(this.ctx.pool, text, values);
  }

  private async selectMemories(
    where: string,
    values: readonly unknown[],
    tail: string,
  ): Promise<PurrMemory[]> {
    const typeParameter = `$${values.length + 1}`;
    const rows = await this.read<MemoryRow>(`
      SELECT ${MEMORY_SUBJECT_METADATA_SELECT_COLUMNS}
      FROM l2_memories memory
      WHERE memory.type = ANY(${typeParameter}::text[])
        AND ${where}
      ${tail}
    `, [...values, READABLE_PERSISTED_MEMORY_TYPES]);
    return decodeRows(rows);
  }

  async getById(id: string): Promise<PurrMemory | undefined> {
    const [memory] = await this.selectMemories('memory.id = $1', [id], '');
    return memory;
  }

  /** Deduplicated, first-seen input order, misses dropped. */
  async getByIds(ids: readonly string[]): Promise<PurrMemory[]> {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) return [];
    const memories = await this.selectMemories('memory.id = ANY($1::text[])', [uniqueIds], '');
    const byId = new Map(memories.map(memory => [memory.id, memory]));
    return uniqueIds.flatMap((id) => {
      const memory = byId.get(id);
      return memory ? [memory] : [];
    });
  }

  async countActiveMemories(): Promise<number> {
    const rows = await this.read<CountRow>(`
      SELECT COUNT(*) AS count
      FROM l2_memories memory
      WHERE memory.type = ANY($1::text[])
        AND ${ACTIVE}
    `, [READABLE_PERSISTED_MEMORY_TYPES]);
    return rows[0] ? parsePgNumber(rows[0].count, 'count') : 0;
  }

  /** Active rows first, then archived; newest first within each group. */
  async listMemories(options: MemoryListOptions = {}): Promise<PurrMemory[]> {
    const offset = clampLimit(options.offset, 0, 0, 100_000);
    const order = `
      ORDER BY CASE WHEN memory.superseded_by IS NOT NULL OR memory.deleted_at IS NOT NULL THEN 1 ELSE 0 END ASC,
        memory.extracted_at DESC, memory.id DESC`;
    if (options.limit === undefined) {
      return await this.selectMemories('TRUE', [offset], `${order} OFFSET $1`);
    }
    const limit = clampLimit(options.limit, 50, 1, 500);
    return await this.selectMemories('TRUE', [offset, limit], `${order} OFFSET $1 LIMIT $2`);
  }

  async listActiveMemories(options: ActiveMemoryListOptions = {}): Promise<PurrMemory[]> {
    const before = options.before === undefined ? undefined : assertMemoryListPosition(options.before);
    const limit = clampLimit(options.limit, 50, 1, 500);
    const offset = clampLimit(options.offset, 0, 0, 100_000);
    const values: unknown[] = [offset, limit];
    let where = ACTIVE;
    if (before !== undefined) {
      values.push(before.extractedAt, before.memoryId);
      where += ' AND (memory.extracted_at, memory.id) < ($3, $4)';
    }
    return await this.selectMemories(
      where,
      values,
      'ORDER BY memory.extracted_at DESC, memory.id DESC OFFSET $1 LIMIT $2',
    );
  }

  async getAllActiveMemories(limit: number): Promise<PurrMemory[]> {
    return await this.selectMemories(
      ACTIVE,
      [sqlRowLimit(limit, 'getAllActiveMemories')],
      'ORDER BY memory.extracted_at DESC, memory.id ASC LIMIT $1',
    );
  }

  async getMemoriesByChannel(channelId: string, limit: number): Promise<PurrMemory[]> {
    return await this.selectMemories(
      `${ACTIVE} AND starts_with(memory.source_ref, $1 || ':')`,
      [channelId, sqlRowLimit(limit, 'getMemoriesByChannel')],
      'ORDER BY memory.extracted_at DESC, memory.id DESC LIMIT $2',
    );
  }

  async getMemoriesByContact(contactId: string, limit: number): Promise<PurrMemory[]> {
    return await this.selectMemories(
      `${ACTIVE} AND memory.contact_id = $1`,
      [contactId, sqlRowLimit(limit, 'getMemoriesByContact')],
      'ORDER BY memory.salience DESC, memory.extracted_at DESC, memory.id DESC LIMIT $2',
    );
  }

  async getStats(): Promise<MemoryStoreStats> {
    const rows = await this.read<TypeStatsRow>(`
      SELECT memory.type AS type, COUNT(*) AS count, SUM(memory.salience) AS salience_sum
      FROM l2_memories memory
      WHERE memory.type = ANY($1::text[])
        AND ${ACTIVE}
      GROUP BY memory.type
    `, [READABLE_PERSISTED_MEMORY_TYPES]);
    const byType: Record<string, number> = {};
    let total = 0;
    let salience = 0;
    for (const row of rows) {
      const resolution = resolvePersistedMemoryType(row.type);
      if (resolution.disposition === 'quarantine') continue;
      const count = parsePgNumber(row.count, 'count');
      byType[resolution.type] = (byType[resolution.type] ?? 0) + count;
      total += count;
      salience += row.salience_sum === null ? 0 : parsePgNumber(row.salience_sum, 'salience_sum');
    }
    return {
      total,
      byType,
      avgSalience: total > 0 ? salience / total : 0,
    };
  }

  /**
   * Raw (system-internal) lexical search. SQL applies the exact lexicalScore
   * matching rule — the fraction of query tokens contained in
   * `lower(text || ' ' || tags || ' ' || source_ref)` — and the exact scope
   * semantics of the former in-memory filter; the returned similarity is
   * recomputed with lexicalScore itself.
   */
  async searchByText(
    query: string,
    limit: number,
    scopeQuery?: MemoryScopeQuery,
  ): Promise<Array<PurrMemory & { similarity: number }>> {
    const tokens = lexicalTokens(query);
    if (tokens.length === 0) return [];
    const rowLimit = sqlRowLimit(limit, 'searchByText');
    const values: unknown[] = [tokens, rowLimit];
    const conditions = [ACTIVE];
    const normalizedScopeQuery = normalizeMemoryScopeQuery(scopeQuery);
    if (normalizedScopeQuery) {
      const refs = normalizedScopeQuery.refs ?? [];
      const tags = normalizedScopeQuery.tags ?? [];
      const refConditions = refs.map((ref) => {
        values.push(ref.kind, ref.id);
        return `(memory.scope_ref_kind = $${values.length - 1} AND memory.scope_ref_id = $${values.length})`;
      });
      let tagCondition = 'TRUE';
      if (tags.length > 0) {
        values.push(tags);
        tagCondition = `(jsonb_typeof(memory.scope_tags) = 'array' AND memory.scope_tags ?| $${values.length}::text[])`;
      }
      const scopeCondition = refConditions.length > 0 ? `(${refConditions.join(' OR ')})` : 'TRUE';
      conditions.push(normalizedScopeQuery.mode === 'only'
        ? `(${scopeCondition} AND ${tagCondition})`
        : `(${scopeCondition} OR ${tagCondition})`);
    }
    values.push(READABLE_PERSISTED_MEMORY_TYPES);
    const rows = await this.read<MemoryRow>(`
      SELECT ${MEMORY_SUBJECT_METADATA_SELECT_COLUMNS}
      FROM l2_memories memory
      CROSS JOIN LATERAL (
        SELECT COUNT(*) AS hits
        FROM unnest($1::text[]) AS token(value)
        WHERE strpos(lower(
          memory.text || ' ' || COALESCE((
            SELECT string_agg(tag.value, ' ' ORDER BY tag.ordinality)
            FROM jsonb_array_elements_text(
              CASE WHEN jsonb_typeof(memory.tags) = 'array' THEN memory.tags ELSE '[]'::jsonb END
            ) WITH ORDINALITY AS tag(value, ordinality)
          ), '') || ' ' || memory.source_ref
        ), token.value) > 0
      ) lexical
      WHERE memory.type = ANY($${values.length}::text[])
        AND ${conditions.join(' AND ')}
        AND lexical.hits > 0
      ORDER BY lexical.hits DESC, memory.salience DESC, memory.extracted_at DESC, memory.id DESC
      LIMIT $2
    `, values);
    const memories = decodeRows(rows);
    return memories
      .map(memory => ({ ...memory, similarity: lexicalScore(memory, query) }))
      .filter(memory => memory.similarity > 0)
      .sort((left, right) => right.similarity - left.similarity || right.salience - left.salience || right.extractedAt - left.extractedAt)
      .slice(0, limit);
  }
}
