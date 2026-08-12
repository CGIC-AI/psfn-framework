import {
  appendAutomataBusCurrentFindingPredicates,
  automataBusAudienceFilterAllowsScope,
  createAutomataBusPostgresParameters,
  encodeAutomataBusEmbedding,
  normalizeAutomataBusEmbeddingIdentity,
  normalizeAutomataBusPostgresQuery,
  parseAutomataBusSearchEventId,
  parseAutomataBusSearchScore,
  requireAutomataBusNonEmptyString,
  requireAutomataBusPositiveInteger,
} from './postgres-query-sql.js';
import type {
  AutomataBusSqlClient,
  AutomataBusSqlPool,
  AutomataBusSqlQueryable,
} from './postgres-store.js';
import type {
  AutomataBusEmbeddingIdentity,
  AutomataBusIndexHealthPort,
  AutomataBusIndexLagInput,
  AutomataBusIndexState,
  AutomataBusIndexSuccessInput,
  AutomataBusReindexState,
  AutomataBusVectorIndexPort,
  AutomataBusVectorIndexState,
  AutomataBusVectorSearchInput,
  AutomataBusVectorUpsertInput,
} from './query-ports.js';

interface AutomataBusVectorStateRow {
  provider: unknown;
  model: unknown;
  dimensions: unknown;
  index_state: unknown;
  reindex_state: unknown;
  pending_count: unknown;
  oldest_pending_at: unknown;
  last_failure_at: unknown;
}

interface AutomataBusVectorIdentityRow {
  provider: unknown;
  model: unknown;
  dimensions: unknown;
}

interface AutomataBusVectorSearchRow {
  event_id: unknown;
  score: unknown;
}

interface BuiltVectorSearch {
  text: string;
  values: unknown[];
}

interface PostgresAutomataBusVectorIndexOptions {
  companionId: string;
  maxCandidateLimit: number;
}

interface SetAutomataBusVectorStateInput {
  modelIdentity: AutomataBusEmbeddingIdentity;
  indexState: AutomataBusIndexState;
  reindexState: AutomataBusReindexState;
}

const INDEX_STATES: readonly AutomataBusIndexState[] = [
  'building',
  'degraded',
  'ready',
  'unavailable',
];
const REINDEX_STATES: readonly AutomataBusReindexState[] = ['current', 'required', 'running'];
const LAG_STAGES: readonly AutomataBusIndexLagInput['stage'][] = [
  'embedding',
  'index-state',
  'model-identity',
  'vector',
];

function parseNonNegativeInteger(value: unknown, field: string): number {
  const parsed = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return parsed;
}

function parseOptionalInstant(value: unknown, field: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  const normalized = value instanceof Date
    ? value.toISOString()
    : requireAutomataBusNonEmptyString(value, field);
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp)) throw new Error(`${field} must be a timestamp`);
  return new Date(timestamp).toISOString();
}

function parseIndexState(value: unknown): AutomataBusIndexState {
  if (typeof value !== 'string' || !INDEX_STATES.includes(value as AutomataBusIndexState)) {
    throw new Error('Invalid Automata Bus vector index_state');
  }
  return value as AutomataBusIndexState;
}

function parseReindexState(value: unknown): AutomataBusReindexState {
  if (typeof value !== 'string' || !REINDEX_STATES.includes(value as AutomataBusReindexState)) {
    throw new Error('Invalid Automata Bus vector reindex_state');
  }
  return value as AutomataBusReindexState;
}

function parseIdentityRow(row: AutomataBusVectorIdentityRow): AutomataBusEmbeddingIdentity {
  return normalizeAutomataBusEmbeddingIdentity({
    provider: requireAutomataBusNonEmptyString(row.provider, 'vector state provider'),
    model: requireAutomataBusNonEmptyString(row.model, 'vector state model'),
    dimensions: typeof row.dimensions === 'string' ? Number(row.dimensions) : row.dimensions as number,
  });
}

function sameIdentity(
  left: AutomataBusEmbeddingIdentity,
  right: AutomataBusEmbeddingIdentity,
): boolean {
  return left.provider === right.provider
    && left.model === right.model
    && left.dimensions === right.dimensions;
}

async function withReadOnlyExactTransaction<T>(
  pool: AutomataBusSqlPool,
  operation: (client: AutomataBusSqlClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    await client.query('SET LOCAL enable_indexscan = off');
    await client.query('SET LOCAL enable_bitmapscan = off');
    const value = await operation(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'Automata Bus exact search failed and rollback also failed',
      );
    }
    throw error;
  } finally {
    client.release();
  }
}

async function withWriteTransaction<T>(
  pool: AutomataBusSqlPool,
  operation: (client: AutomataBusSqlClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const value = await operation(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'Automata Bus vector write failed and rollback also failed',
      );
    }
    throw error;
  } finally {
    client.release();
  }
}

async function ensureVectorIdentityState(
  queryable: AutomataBusSqlQueryable,
  companionId: string,
  identity: AutomataBusEmbeddingIdentity,
  initialIndexState: AutomataBusIndexState,
): Promise<void> {
  const state = await queryable.query<{ companion_id: unknown }>(`
    INSERT INTO automata_bus_vector_state (
      companion_id, provider, model, dimensions, index_state, reindex_state, updated_at
    ) VALUES ($1, $2, $3, $4, $5, 'current', CURRENT_TIMESTAMP)
    ON CONFLICT (companion_id) DO UPDATE SET
      updated_at = CURRENT_TIMESTAMP
    WHERE automata_bus_vector_state.provider = EXCLUDED.provider
      AND automata_bus_vector_state.model = EXCLUDED.model
      AND automata_bus_vector_state.dimensions = EXCLUDED.dimensions
    RETURNING companion_id
  `, [
    companionId,
    identity.provider,
    identity.model,
    identity.dimensions,
    initialIndexState,
  ]);
  if (state.rows.length !== 1) {
    throw new Error('Automata Bus vector model identity differs from active index state');
  }
}

function parseSearchRows(rows: readonly AutomataBusVectorSearchRow[]): Array<{
  eventId: string;
  score: number;
}> {
  return rows.map(row => ({
    eventId: parseAutomataBusSearchEventId(row.event_id),
    score: parseAutomataBusSearchScore(row.score),
  }));
}

export class PostgresAutomataBusVectorIndexAdapter implements
  AutomataBusVectorIndexPort,
  AutomataBusIndexHealthPort {
  private readonly companionId: string;
  private readonly maxCandidateLimit: number;

  constructor(
    private readonly pool: AutomataBusSqlPool,
    options: PostgresAutomataBusVectorIndexOptions,
  ) {
    this.companionId = requireAutomataBusNonEmptyString(options.companionId, 'companionId');
    this.maxCandidateLimit = requireAutomataBusPositiveInteger(
      options.maxCandidateLimit,
      'maxCandidateLimit',
    );
  }

  async readState(): Promise<AutomataBusVectorIndexState> {
    const result = await this.pool.query<AutomataBusVectorStateRow>(`
      SELECT
        state.provider,
        state.model,
        state.dimensions,
        state.index_state,
        state.reindex_state,
        COUNT(lag.event_id)::bigint AS pending_count,
        MIN(lag.first_failed_at) AS oldest_pending_at,
        MAX(lag.last_failed_at) AS last_failure_at
      FROM automata_bus_vector_state state
      LEFT JOIN automata_bus_vector_lag lag
        ON lag.companion_id = state.companion_id
      WHERE state.companion_id = $1
      GROUP BY
        state.provider,
        state.model,
        state.dimensions,
        state.index_state,
        state.reindex_state
    `, [this.companionId]);
    const row = result.rows[0];
    if (!row) {
      return {
        indexState: 'unavailable',
        reindexState: 'required',
        modelIdentity: null,
        indexingLag: { pendingCount: 0 },
      };
    }
    const oldestPendingAt = parseOptionalInstant(row.oldest_pending_at, 'oldest_pending_at');
    const lastFailureAt = parseOptionalInstant(row.last_failure_at, 'last_failure_at');
    return {
      indexState: parseIndexState(row.index_state),
      reindexState: parseReindexState(row.reindex_state),
      modelIdentity: parseIdentityRow(row),
      indexingLag: {
        pendingCount: parseNonNegativeInteger(row.pending_count, 'pending_count'),
        ...(oldestPendingAt !== undefined ? { oldestPendingAt } : {}),
        ...(lastFailureAt !== undefined ? { lastFailureAt } : {}),
      },
    };
  }

  private buildSearch(input: AutomataBusVectorSearchInput): BuiltVectorSearch | null {
    const identity = normalizeAutomataBusEmbeddingIdentity(input.modelIdentity);
    const query = normalizeAutomataBusPostgresQuery(
      input.visibility,
      input.filters,
      input.limit,
      this.maxCandidateLimit,
    );
    if (query.visibility.companionId !== this.companionId) {
      throw new Error('Automata Bus vector adapter companion scope mismatch');
    }
    if (!automataBusAudienceFilterAllowsScope(query.visibility, query.filters)) return null;
    const embedding = encodeAutomataBusEmbedding(input.embedding, identity);
    const parameters = createAutomataBusPostgresParameters();
    const predicates = appendAutomataBusCurrentFindingPredicates(parameters, query, 'c');
    predicates.push(`v.provider = ${parameters.add(identity.provider)}`);
    predicates.push(`v.model = ${parameters.add(identity.model)}`);
    predicates.push(`v.dimensions = ${parameters.add(identity.dimensions)}`);
    const embeddingParameter = parameters.add(embedding);
    const limit = parameters.add(query.limit);
    const distance = `v.embedding::vector(${identity.dimensions}) <=> `
      + `${embeddingParameter}::vector(${identity.dimensions})`;
    return {
      text: `
        SELECT
          v.event_id,
          GREATEST(0.0, LEAST(1.0, 1 - (${distance}))) AS score
        FROM automata_bus_finding_vectors v
        JOIN automata_bus_current_findings c
          ON c.companion_id = v.companion_id
          AND c.event_id = v.event_id
        WHERE ${predicates.join('\n          AND ')}
        ORDER BY ${distance} ASC, v.event_id ASC
        LIMIT ${limit}
      `,
      values: parameters.values,
    };
  }

  async searchApproximate(input: AutomataBusVectorSearchInput): Promise<readonly {
    eventId: string;
    score: number;
  }[]> {
    const search = this.buildSearch(input);
    if (!search) return [];
    const rows = await this.pool.query<AutomataBusVectorSearchRow>(search.text, search.values);
    return parseSearchRows(rows.rows);
  }

  async searchExact(input: AutomataBusVectorSearchInput): Promise<readonly {
    eventId: string;
    score: number;
  }[]> {
    const search = this.buildSearch(input);
    if (!search) return [];
    return withReadOnlyExactTransaction(this.pool, async (client) => {
      const rows = await client.query<AutomataBusVectorSearchRow>(search.text, search.values);
      return parseSearchRows(rows.rows);
    });
  }

  async upsert(input: AutomataBusVectorUpsertInput): Promise<void> {
    if (input.companionId !== this.companionId) {
      throw new Error('Automata Bus vector upsert companion scope mismatch');
    }
    const eventId = requireAutomataBusNonEmptyString(input.eventId, 'eventId');
    const identity = normalizeAutomataBusEmbeddingIdentity(input.modelIdentity);
    const embedding = encodeAutomataBusEmbedding(input.embedding, identity);
    await withWriteTransaction(this.pool, async (client) => {
      await ensureVectorIdentityState(client, this.companionId, identity, 'building');
      const written = await client.query<{ event_id: unknown }>(`
        INSERT INTO automata_bus_finding_vectors (
          companion_id, event_id, provider, model, dimensions, embedding, indexed_at
        ) VALUES ($1, $2, $3, $4, $5, $6::vector, CURRENT_TIMESTAMP)
        ON CONFLICT (companion_id, event_id) DO UPDATE SET
          provider = EXCLUDED.provider,
          model = EXCLUDED.model,
          dimensions = EXCLUDED.dimensions,
          embedding = EXCLUDED.embedding,
          indexed_at = CURRENT_TIMESTAMP
        RETURNING event_id
      `, [
        this.companionId,
        eventId,
        identity.provider,
        identity.model,
        identity.dimensions,
        embedding,
      ]);
      if (written.rows.length !== 1) {
        throw new Error('Automata Bus vector upsert did not write exactly one row');
      }
    });
  }

  async markLagging(input: AutomataBusIndexLagInput): Promise<void> {
    if (input.companionId !== this.companionId) {
      throw new Error('Automata Bus vector lag companion scope mismatch');
    }
    if (!LAG_STAGES.includes(input.stage)) throw new Error('Automata Bus vector lag stage is unknown');
    const eventId = requireAutomataBusNonEmptyString(input.eventId, 'eventId');
    const identity = normalizeAutomataBusEmbeddingIdentity(input.modelIdentity);
    await withWriteTransaction(this.pool, async (client) => {
      if (input.stage === 'model-identity') {
        const required = await client.query<{ companion_id: unknown }>(`
          UPDATE automata_bus_vector_state
          SET reindex_state = 'required', updated_at = CURRENT_TIMESTAMP
          WHERE companion_id = $1
          RETURNING companion_id
        `, [this.companionId]);
        if (required.rows.length !== 1) {
          throw new Error('Automata Bus model-identity lag requires existing vector state');
        }
      } else {
        await ensureVectorIdentityState(client, this.companionId, identity, 'unavailable');
      }
      const written = await client.query<{ event_id: unknown }>(`
        INSERT INTO automata_bus_vector_lag (
          companion_id, event_id, stage, provider, model, dimensions,
          first_failed_at, last_failed_at, attempts
        ) VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1)
        ON CONFLICT (companion_id, event_id) DO UPDATE SET
          stage = EXCLUDED.stage,
          provider = EXCLUDED.provider,
          model = EXCLUDED.model,
          dimensions = EXCLUDED.dimensions,
          last_failed_at = CURRENT_TIMESTAMP,
          attempts = automata_bus_vector_lag.attempts + 1
        RETURNING event_id
      `, [
        this.companionId,
        eventId,
        input.stage,
        identity.provider,
        identity.model,
        identity.dimensions,
      ]);
      if (written.rows.length !== 1) {
        throw new Error('Automata Bus vector lag write did not affect exactly one row');
      }
    });
  }

  async markIndexed(input: AutomataBusIndexSuccessInput): Promise<void> {
    if (input.companionId !== this.companionId) {
      throw new Error('Automata Bus indexed-health companion scope mismatch');
    }
    const eventId = requireAutomataBusNonEmptyString(input.eventId, 'eventId');
    const identity = normalizeAutomataBusEmbeddingIdentity(input.modelIdentity);
    await this.pool.query(`
      DELETE FROM automata_bus_vector_lag
      WHERE companion_id = $1
        AND event_id = $2
        AND provider = $3
        AND model = $4
        AND dimensions = $5
    `, [
      this.companionId,
      eventId,
      identity.provider,
      identity.model,
      identity.dimensions,
    ]);
  }

  async setState(input: SetAutomataBusVectorStateInput): Promise<void> {
    const identity = normalizeAutomataBusEmbeddingIdentity(input.modelIdentity);
    const indexState = parseIndexState(input.indexState);
    const reindexState = parseReindexState(input.reindexState);
    await withWriteTransaction(this.pool, async (client) => {
      const incumbent = await client.query<AutomataBusVectorIdentityRow>(`
        SELECT provider, model, dimensions
        FROM automata_bus_vector_state
        WHERE companion_id = $1
        FOR UPDATE
      `, [this.companionId]);
      const existing = incumbent.rows[0] ? parseIdentityRow(incumbent.rows[0]) : undefined;
      if (existing && !sameIdentity(existing, identity) && reindexState === 'current') {
        throw new Error('Automata Bus model identity change requires explicit reindex state');
      }
      const written = await client.query<{ companion_id: unknown }>(`
        INSERT INTO automata_bus_vector_state (
          companion_id, provider, model, dimensions, index_state, reindex_state, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
        ON CONFLICT (companion_id) DO UPDATE SET
          provider = EXCLUDED.provider,
          model = EXCLUDED.model,
          dimensions = EXCLUDED.dimensions,
          index_state = EXCLUDED.index_state,
          reindex_state = EXCLUDED.reindex_state,
          updated_at = CURRENT_TIMESTAMP
        RETURNING companion_id
      `, [
        this.companionId,
        identity.provider,
        identity.model,
        identity.dimensions,
        indexState,
        reindexState,
      ]);
      if (written.rows.length !== 1) {
        throw new Error('Automata Bus vector state update did not affect exactly one row');
      }
    });
  }
}
