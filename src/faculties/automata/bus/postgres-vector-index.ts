import { randomUUID } from 'node:crypto';

import { requireUuid } from '../../../shared/utils/uuid.js';
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
import type { AutomataBusReindexLease } from './reindex-service.js';

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
  reindex_state?: unknown;
  reindex_lease_live?: unknown;
  mutation_fence?: unknown;
}

interface AutomataBusReindexLeaseRow {
  companion_id: unknown;
  reindex_lease_token: unknown;
  reindex_snapshot_sequence: unknown;
  reindex_snapshot_mutation_fence: unknown;
}

interface AutomataBusSnapshotRow {
  snapshot_sequence: unknown;
}

interface AutomataBusMutationFenceRow {
  mutation_fence: unknown;
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
  reindexLeaseDurationMs: number;
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

async function advanceVectorMutationFence(
  queryable: AutomataBusSqlQueryable,
  companionId: string,
  identity: AutomataBusEmbeddingIdentity,
  initialIndexState: AutomataBusIndexState,
): Promise<number> {
  await ensureVectorIdentityState(queryable, companionId, identity, initialIndexState);
  const advanced = await queryable.query<AutomataBusMutationFenceRow>(`
    UPDATE automata_bus_vector_state
    SET mutation_fence = mutation_fence + 1, updated_at = clock_timestamp()
    WHERE companion_id = $1
      AND provider = $2
      AND model = $3
      AND dimensions = $4
    RETURNING mutation_fence
  `, [companionId, identity.provider, identity.model, identity.dimensions]);
  if (advanced.rows.length !== 1) {
    throw new Error('Automata Bus vector mutation did not acquire the exact companion fence');
  }
  return parseNonNegativeInteger(
    advanced.rows[0]?.mutation_fence,
    'vector mutation_fence',
  );
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
  private readonly reindexLeaseDurationMs: number;

  constructor(
    private readonly pool: AutomataBusSqlPool,
    options: PostgresAutomataBusVectorIndexOptions,
  ) {
    this.companionId = requireAutomataBusNonEmptyString(options.companionId, 'companionId');
    this.maxCandidateLimit = requireAutomataBusPositiveInteger(
      options.maxCandidateLimit,
      'maxCandidateLimit',
    );
    this.reindexLeaseDurationMs = requireAutomataBusPositiveInteger(
      options.reindexLeaseDurationMs,
      'reindexLeaseDurationMs',
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
    return await withWriteTransaction(this.pool, async (client) => {
      const mutationFence = await advanceVectorMutationFence(
        client,
        this.companionId,
        identity,
        'building',
      );
      const written = await client.query<{ event_id: unknown }>(`
        INSERT INTO automata_bus_finding_vectors (
          companion_id, event_id, provider, model, dimensions, embedding, mutation_fence, indexed_at
        ) VALUES ($1, $2, $3, $4, $5, $6::vector, $7, clock_timestamp())
        ON CONFLICT (companion_id, event_id) DO UPDATE SET
          provider = EXCLUDED.provider,
          model = EXCLUDED.model,
          dimensions = EXCLUDED.dimensions,
          embedding = EXCLUDED.embedding,
          mutation_fence = EXCLUDED.mutation_fence,
          indexed_at = clock_timestamp()
        RETURNING event_id
      `, [
        this.companionId,
        eventId,
        identity.provider,
        identity.model,
        identity.dimensions,
        embedding,
        mutationFence,
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
      let mutationFence: number;
      if (input.stage === 'model-identity') {
        const required = await client.query<AutomataBusMutationFenceRow>(`
          UPDATE automata_bus_vector_state
          SET
            index_state = 'degraded',
            reindex_state = CASE
              WHEN reindex_state = 'running' THEN 'running'
              ELSE 'required'
            END,
            mutation_fence = mutation_fence + 1,
            updated_at = clock_timestamp()
          WHERE companion_id = $1
          RETURNING mutation_fence
        `, [this.companionId]);
        if (required.rows.length !== 1) {
          throw new Error('Automata Bus model-identity lag requires existing vector state');
        }
        mutationFence = parseNonNegativeInteger(
          required.rows[0]?.mutation_fence,
          'vector mutation_fence',
        );
      } else {
        mutationFence = await advanceVectorMutationFence(
          client,
          this.companionId,
          identity,
          'unavailable',
        );
      }
      const written = await client.query<{ event_id: unknown }>(`
        INSERT INTO automata_bus_vector_lag (
          companion_id, event_id, stage, provider, model, dimensions,
          first_failed_at, last_failed_at, attempts, mutation_fence
        ) VALUES ($1, $2, $3, $4, $5, $6, clock_timestamp(), clock_timestamp(), 1, $7)
        ON CONFLICT (companion_id, event_id) DO UPDATE SET
          stage = EXCLUDED.stage,
          provider = EXCLUDED.provider,
          model = EXCLUDED.model,
          dimensions = EXCLUDED.dimensions,
          last_failed_at = clock_timestamp(),
          attempts = automata_bus_vector_lag.attempts + 1,
          mutation_fence = EXCLUDED.mutation_fence
        RETURNING event_id
      `, [
        this.companionId,
        eventId,
        input.stage,
        identity.provider,
        identity.model,
        identity.dimensions,
        mutationFence,
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
    await withWriteTransaction(this.pool, async (client) => {
      const mutationFence = await advanceVectorMutationFence(
        client,
        this.companionId,
        identity,
        'building',
      );
      await client.query(`
        DELETE FROM automata_bus_vector_lag
        WHERE companion_id = $1
          AND event_id = $2
          AND provider = $3
          AND model = $4
          AND dimensions = $5
          AND mutation_fence <= $6
      `, [
        this.companionId,
        eventId,
        identity.provider,
        identity.model,
        identity.dimensions,
        mutationFence,
      ]);
      await client.query(`
        UPDATE automata_bus_vector_state state
        SET index_state = 'ready', updated_at = CURRENT_TIMESTAMP
        WHERE state.companion_id = $1
          AND state.provider = $2
          AND state.model = $3
          AND state.dimensions = $4
          AND state.reindex_state = 'current'
          AND NOT EXISTS (
            SELECT 1
            FROM automata_bus_vector_lag lag
            WHERE lag.companion_id = state.companion_id
          )
      `, [
        this.companionId,
        identity.provider,
        identity.model,
        identity.dimensions,
      ]);
    });
  }

  async beginReindex(input: {
    companionId: string;
    modelIdentity: AutomataBusEmbeddingIdentity;
  }): Promise<AutomataBusReindexLease> {
    if (input.companionId !== this.companionId) {
      throw new Error('Automata Bus reindex companion scope mismatch');
    }
    const identity = normalizeAutomataBusEmbeddingIdentity(input.modelIdentity);
    return await withWriteTransaction(this.pool, async (client) => {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`automata-bus-reindex:${this.companionId}`],
      );
      const incumbent = await client.query<AutomataBusVectorIdentityRow>(`
        SELECT
          provider,
          model,
          dimensions,
          reindex_state,
          mutation_fence,
          reindex_lease_until > clock_timestamp() AS reindex_lease_live
        FROM automata_bus_vector_state
        WHERE companion_id = $1
        FOR UPDATE
      `, [this.companionId]);
      const row = incumbent.rows[0];
      if (row?.reindex_state === 'running' && row.reindex_lease_live === true) {
        throw new Error('Automata Bus reindex is already running');
      }
      const snapshot = await client.query<AutomataBusSnapshotRow>(`
        SELECT COALESCE(MAX(sequence), 0)::bigint AS snapshot_sequence
        FROM automata_bus_current_findings
        WHERE companion_id = $1
      `, [this.companionId]);
      const snapshotSequence = parseNonNegativeInteger(
        snapshot.rows[0]?.snapshot_sequence,
        'reindex snapshot_sequence',
      );
      const mutationFence = row === undefined
        ? 0
        : parseNonNegativeInteger(row.mutation_fence, 'reindex mutation_fence');
      const leaseToken = randomUUID();
      const written = await client.query<AutomataBusReindexLeaseRow>(`
        INSERT INTO automata_bus_vector_state (
          companion_id, provider, model, dimensions, index_state, reindex_state,
          mutation_fence, reindex_lease_token, reindex_lease_until,
          reindex_snapshot_sequence, reindex_snapshot_mutation_fence, updated_at
        ) VALUES (
          $1, $2, $3, $4, 'building', 'running', $5, $6::uuid,
          clock_timestamp() + ($7 * INTERVAL '1 millisecond'), $8, $9, clock_timestamp()
        )
        ON CONFLICT (companion_id) DO UPDATE SET
          provider = EXCLUDED.provider,
          model = EXCLUDED.model,
          dimensions = EXCLUDED.dimensions,
          index_state = 'building',
          reindex_state = 'running',
          reindex_lease_token = EXCLUDED.reindex_lease_token,
          reindex_lease_until = EXCLUDED.reindex_lease_until,
          reindex_snapshot_sequence = EXCLUDED.reindex_snapshot_sequence,
          reindex_snapshot_mutation_fence = EXCLUDED.reindex_snapshot_mutation_fence,
          updated_at = clock_timestamp()
        RETURNING
          companion_id,
          reindex_lease_token,
          reindex_snapshot_sequence,
          reindex_snapshot_mutation_fence
      `, [
        this.companionId,
        identity.provider,
        identity.model,
        identity.dimensions,
        mutationFence,
        leaseToken,
        this.reindexLeaseDurationMs,
        snapshotSequence,
        mutationFence,
      ]);
      const acquired = written.rows[0];
      if (!acquired || acquired.companion_id !== this.companionId) {
        throw new Error('Automata Bus reindex did not acquire exact companion state');
      }
      return {
        companionId: this.companionId,
        leaseToken: requireUuid(
          acquired.reindex_lease_token,
          'reindex lease_token',
        ),
        snapshotSequence: parseNonNegativeInteger(
          acquired.reindex_snapshot_sequence,
          'reindex snapshot_sequence',
        ),
        mutationFence: parseNonNegativeInteger(
          acquired.reindex_snapshot_mutation_fence,
          'reindex snapshot_mutation_fence',
        ),
      };
    });
  }

  async completeReindex(input: {
    companionId: string;
    modelIdentity: AutomataBusEmbeddingIdentity;
    leaseToken: string;
    snapshotSequence: number;
    mutationFence: number;
    eventIds: readonly string[];
  }): Promise<void> {
    if (input.companionId !== this.companionId) {
      throw new Error('Automata Bus reindex companion scope mismatch');
    }
    const identity = normalizeAutomataBusEmbeddingIdentity(input.modelIdentity);
    const leaseToken = requireUuid(input.leaseToken, 'leaseToken');
    const snapshotSequence = parseNonNegativeInteger(input.snapshotSequence, 'snapshotSequence');
    const mutationFence = parseNonNegativeInteger(input.mutationFence, 'mutationFence');
    const eventIds = input.eventIds.map((eventId, index) => (
      requireAutomataBusNonEmptyString(eventId, `eventIds[${index}]`)
    ));
    if (new Set(eventIds).size !== eventIds.length) {
      throw new Error('Automata Bus reindex eventIds must not contain duplicates');
    }
    await withWriteTransaction(this.pool, async (client) => {
      const lease = await client.query<{ companion_id: unknown }>(`
        SELECT companion_id
        FROM automata_bus_vector_state
        WHERE companion_id = $1
          AND provider = $2
          AND model = $3
          AND dimensions = $4
          AND reindex_state = 'running'
          AND reindex_lease_token = $5::uuid
          AND reindex_snapshot_sequence = $6
          AND reindex_snapshot_mutation_fence = $7
        FOR UPDATE
      `, [
        this.companionId,
        identity.provider,
        identity.model,
        identity.dimensions,
        leaseToken,
        snapshotSequence,
        mutationFence,
      ]);
      if (lease.rows.length !== 1) {
        throw new Error('Automata Bus reindex completion lost exact companion lease');
      }
      await client.query(`
        DELETE FROM automata_bus_finding_vectors vector
        USING automata_bus_current_findings finding
        WHERE vector.companion_id = $1
          AND finding.companion_id = vector.companion_id
          AND finding.event_id = vector.event_id
          AND finding.sequence <= $6
          AND vector.mutation_fence <= $7
          AND (
            vector.provider <> $2
            OR vector.model <> $3
            OR vector.dimensions <> $4
            OR NOT (vector.event_id = ANY($5::text[]))
          )
      `, [
        this.companionId,
        identity.provider,
        identity.model,
        identity.dimensions,
        eventIds,
        snapshotSequence,
        mutationFence,
      ]);
      await client.query(`
        DELETE FROM automata_bus_vector_lag
        WHERE companion_id = $1
          AND mutation_fence <= $2
      `, [this.companionId, mutationFence]);
      const written = await client.query<{ companion_id: unknown }>(`
        UPDATE automata_bus_vector_state
        SET
          index_state = CASE
            WHEN EXISTS (
              SELECT 1
              FROM automata_bus_vector_lag lag
              WHERE lag.companion_id = automata_bus_vector_state.companion_id
            ) THEN 'degraded'
            ELSE 'ready'
          END,
          reindex_state = CASE
            WHEN EXISTS (
              SELECT 1
              FROM automata_bus_vector_lag lag
              WHERE lag.companion_id = automata_bus_vector_state.companion_id
                AND lag.stage = 'model-identity'
            ) THEN 'required'
            ELSE 'current'
          END,
          reindex_lease_token = NULL,
          reindex_lease_until = NULL,
          reindex_snapshot_sequence = NULL,
          reindex_snapshot_mutation_fence = NULL,
          updated_at = clock_timestamp()
        WHERE companion_id = $1
          AND provider = $2
          AND model = $3
          AND dimensions = $4
          AND reindex_state = 'running'
          AND reindex_lease_token = $5::uuid
          AND reindex_snapshot_sequence = $6
          AND reindex_snapshot_mutation_fence = $7
        RETURNING companion_id
      `, [
        this.companionId,
        identity.provider,
        identity.model,
        identity.dimensions,
        leaseToken,
        snapshotSequence,
        mutationFence,
      ]);
      if (written.rows.length !== 1) {
        throw new Error('Automata Bus reindex completion lost exact companion state');
      }
    });
  }

  async failReindex(input: {
    companionId: string;
    modelIdentity: AutomataBusEmbeddingIdentity;
    leaseToken: string;
    snapshotSequence: number;
    mutationFence: number;
  }): Promise<void> {
    if (input.companionId !== this.companionId) {
      throw new Error('Automata Bus reindex companion scope mismatch');
    }
    const identity = normalizeAutomataBusEmbeddingIdentity(input.modelIdentity);
    const leaseToken = requireUuid(input.leaseToken, 'leaseToken');
    const snapshotSequence = parseNonNegativeInteger(input.snapshotSequence, 'snapshotSequence');
    const mutationFence = parseNonNegativeInteger(input.mutationFence, 'mutationFence');
    const written = await this.pool.query<{ companion_id: unknown }>(`
      UPDATE automata_bus_vector_state
      SET
        index_state = 'degraded',
        reindex_state = 'required',
        reindex_lease_token = NULL,
        reindex_lease_until = NULL,
        reindex_snapshot_sequence = NULL,
        reindex_snapshot_mutation_fence = NULL,
        updated_at = clock_timestamp()
      WHERE companion_id = $1
        AND provider = $2
        AND model = $3
        AND dimensions = $4
        AND reindex_state = 'running'
        AND reindex_lease_token = $5::uuid
        AND reindex_snapshot_sequence = $6
        AND reindex_snapshot_mutation_fence = $7
      RETURNING companion_id
    `, [
      this.companionId,
      identity.provider,
      identity.model,
      identity.dimensions,
      leaseToken,
      snapshotSequence,
      mutationFence,
    ]);
    if (written.rows.length !== 1) {
      throw new Error('Automata Bus reindex failure lost exact companion lease');
    }
  }

  async setState(input: SetAutomataBusVectorStateInput): Promise<void> {
    const identity = normalizeAutomataBusEmbeddingIdentity(input.modelIdentity);
    const indexState = parseIndexState(input.indexState);
    const reindexState = parseReindexState(input.reindexState);
    if (reindexState === 'running') {
      throw new Error('Automata Bus running reindex state requires lease acquisition');
    }
    await withWriteTransaction(this.pool, async (client) => {
      const incumbent = await client.query<AutomataBusVectorIdentityRow>(`
        SELECT provider, model, dimensions, reindex_state
        FROM automata_bus_vector_state
        WHERE companion_id = $1
        FOR UPDATE
      `, [this.companionId]);
      if (incumbent.rows[0]?.reindex_state === 'running') {
        throw new Error('Automata Bus vector state cannot overwrite an active reindex lease');
      }
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
          reindex_lease_token = NULL,
          reindex_lease_until = NULL,
          reindex_snapshot_sequence = NULL,
          reindex_snapshot_mutation_fence = NULL,
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
