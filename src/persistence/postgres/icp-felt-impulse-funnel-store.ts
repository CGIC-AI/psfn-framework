import type { Pool, QueryResultRow } from 'pg';

import {
  parseIcpFeltImpulseFunnelRecord,
  requireFeltImpulseCorrelationId,
  type IcpFeltImpulseFunnelProjection,
  type IcpFeltImpulseFunnelRecentOutcome,
  type IcpFeltImpulseFunnelRecord,
  type IcpFeltImpulseFunnelStorePort,
  type IcpFeltImpulseLifecycleOutcome,
} from '../../core/icp/felt-impulse-funnel.js';
import {
  createPostgresPool,
  ensurePostgresSchema,
  ensurePostgresSchemaExists,
  queryOne,
  queryRows,
} from '../postgres.js';
import { POSTGRES_INTENTION_MIGRATIONS } from './migrations.js';
import { requireSafeInteger } from './row-guards.js';

interface FunnelRow extends QueryResultRow {
  correlation_id: string;
  first_crossing_ms: string | number;
  fired_at_ms: string | number;
  recorded_at_ms: string | number;
  outcome: string;
  next_eligible_at_ms: string | number | null;
  candidate_id: string | null;
  candidate_outcome: string | null;
}

interface FunnelProjectionRow extends FunnelRow {
  lifecycle_outcome: string | null;
}

interface FunnelCountRow extends QueryResultRow {
  outcome: string;
  candidate_outcome: string | null;
  lifecycle_outcome: string | null;
  outcome_count: string | number;
}

const FUNNEL_COLUMNS = `
  correlation_id, first_crossing_ms, fired_at_ms, recorded_at_ms, outcome,
  next_eligible_at_ms, candidate_id, candidate_outcome
`;

const FUNNEL_PROJECTION_COLUMNS = `
  funnel.correlation_id, funnel.first_crossing_ms, funnel.fired_at_ms,
  funnel.recorded_at_ms, funnel.outcome,
  funnel.next_eligible_at_ms, funnel.candidate_id, funnel.candidate_outcome
`;

const LIFECYCLE_OUTCOMES = new Set<IcpFeltImpulseLifecycleOutcome>([
  'pending',
  'permitted',
  'deferred',
  'declined',
  'rejected',
  'delivered',
  'suppressed',
  'expired',
  'cancelled',
]);

function mapRecord(row: FunnelRow): IcpFeltImpulseFunnelRecord {
  const base = {
    correlationId: row.correlation_id,
    firstCrossingMs: requireSafeInteger(
      row.first_crossing_ms,
      'feltImpulse.firstCrossingMs',
    ),
    firedAtMs: requireSafeInteger(row.fired_at_ms, 'feltImpulse.firedAtMs'),
    recordedAtMs: requireSafeInteger(row.recorded_at_ms, 'feltImpulse.recordedAtMs'),
  };
  switch (row.outcome) {
    case 'no_eligible_peer':
    case 'not_authorized':
      return parseIcpFeltImpulseFunnelRecord({ ...base, outcome: row.outcome });
    case 'throttled':
      if (row.next_eligible_at_ms === null) {
        throw new Error('Felt-impulse throttled row is missing nextEligibleAtMs');
      }
      return parseIcpFeltImpulseFunnelRecord({
        ...base,
        outcome: row.outcome,
        nextEligibleAtMs: requireSafeInteger(
          row.next_eligible_at_ms,
          'feltImpulse.nextEligibleAtMs',
        ),
      });
    case 'candidate_linked':
      if (row.candidate_id === null
        || (row.candidate_outcome !== 'submitted' && row.candidate_outcome !== 'deduped')) {
        throw new Error('Felt-impulse candidate-linked row is incomplete');
      }
      return parseIcpFeltImpulseFunnelRecord({
        ...base,
        outcome: row.outcome,
        candidateId: row.candidate_id,
        candidateOutcome: row.candidate_outcome,
      });
    default:
      throw new Error(`Unknown felt-impulse funnel outcome ${row.outcome}`);
  }
}

function lifecycleOutcome(value: string | null): IcpFeltImpulseLifecycleOutcome {
  if (!LIFECYCLE_OUTCOMES.has(value as IcpFeltImpulseLifecycleOutcome)) {
    throw new Error(`Unknown felt-impulse candidate lifecycle outcome ${String(value)}`);
  }
  return value as IcpFeltImpulseLifecycleOutcome;
}

function lifecycleSql(): string {
  return `CASE
    WHEN funnel.outcome <> 'candidate_linked' THEN NULL
    WHEN candidate.status = 'consumed' THEN candidate.delivery_disposition
    ELSE candidate.status
  END`;
}

export class PostgresIcpFeltImpulseFunnelStore implements IcpFeltImpulseFunnelStorePort {
  private constructor(private readonly pool: Pool) {}

  static async connect(
    databaseUrl: string,
    options: { schema?: string; role?: string },
  ): Promise<PostgresIcpFeltImpulseFunnelStore> {
    if (options.schema !== undefined && options.schema.trim().length === 0) {
      throw new Error('ICP felt-impulse funnel store schema must be non-empty when supplied');
    }
    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-icp-felt-impulse-funnel',
      allowExitOnIdle: true,
      schema: options.schema,
      role: options.role,
    });
    try {
      if (options.schema) await ensurePostgresSchemaExists(pool, options.schema);
      await ensurePostgresSchema(pool, POSTGRES_INTENTION_MIGRATIONS);
      return new PostgresIcpFeltImpulseFunnelStore(pool);
    } catch (error) {
      await pool.end().catch(() => undefined);
      throw error;
    }
  }

  async getOutcome(correlationId: string): Promise<IcpFeltImpulseFunnelRecord | null> {
    const row = await queryOne<FunnelRow>(this.pool, `
      SELECT ${FUNNEL_COLUMNS}
      FROM icp_felt_impulse_funnel_outcomes
      WHERE correlation_id = $1
    `, [requireFeltImpulseCorrelationId(correlationId)]);
    return row ? mapRecord(row) : null;
  }

  async recordOutcome(input: IcpFeltImpulseFunnelRecord): Promise<IcpFeltImpulseFunnelRecord> {
    const record = parseIcpFeltImpulseFunnelRecord(input);
    const row = await queryOne<FunnelRow>(this.pool, `
      INSERT INTO icp_felt_impulse_funnel_outcomes (
        correlation_id, first_crossing_ms, fired_at_ms, recorded_at_ms, outcome,
        next_eligible_at_ms, candidate_id, candidate_outcome
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (correlation_id) DO UPDATE
      SET correlation_id = EXCLUDED.correlation_id
      RETURNING ${FUNNEL_COLUMNS}
    `, [
      record.correlationId,
      record.firstCrossingMs,
      record.firedAtMs,
      record.recordedAtMs,
      record.outcome,
      record.outcome === 'throttled' ? record.nextEligibleAtMs : null,
      record.outcome === 'candidate_linked' ? record.candidateId : null,
      record.outcome === 'candidate_linked' ? record.candidateOutcome : null,
    ]);
    if (!row) throw new Error('Failed to record felt-impulse funnel outcome');
    return mapRecord(row);
  }

  async readProjection(limit: number): Promise<IcpFeltImpulseFunnelProjection> {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error('Felt-impulse funnel projection limit must be a positive safe integer');
    }
    const lifecycle = lifecycleSql();
    const [recentRows, countRows] = await Promise.all([
      queryRows<FunnelProjectionRow>(this.pool, `
        SELECT ${FUNNEL_PROJECTION_COLUMNS}, ${lifecycle} AS lifecycle_outcome
        FROM icp_felt_impulse_funnel_outcomes AS funnel
        LEFT JOIN icp_initiation_candidates AS candidate
          ON candidate.candidate_id = funnel.candidate_id
        ORDER BY funnel.fired_at_ms DESC, funnel.correlation_id
        LIMIT $1
      `, [limit]),
      queryRows<FunnelCountRow>(this.pool, `
        SELECT funnel.outcome, funnel.candidate_outcome,
          ${lifecycle} AS lifecycle_outcome, COUNT(*) AS outcome_count
        FROM icp_felt_impulse_funnel_outcomes AS funnel
        LEFT JOIN icp_initiation_candidates AS candidate
          ON candidate.candidate_id = funnel.candidate_id
        GROUP BY funnel.outcome, funnel.candidate_outcome, lifecycle_outcome
      `),
    ]);

    const projection: IcpFeltImpulseFunnelProjection = {
      totalQualified: 0,
      preCandidate: { noEligiblePeer: 0, notAuthorized: 0, throttled: 0 },
      candidateLinks: { total: 0, submitted: 0, deduped: 0 },
      candidateLifecycle: {
        pending: 0,
        permitted: 0,
        deferred: 0,
        declined: 0,
        rejected: 0,
        delivered: 0,
        suppressed: 0,
        expired: 0,
        cancelled: 0,
      },
      recent: recentRows.map(row => {
        const record = mapRecord(row);
        if (record.outcome !== 'candidate_linked') return record;
        return {
          ...record,
          lifecycleOutcome: lifecycleOutcome(row.lifecycle_outcome),
        } satisfies IcpFeltImpulseFunnelRecentOutcome;
      }),
    };
    for (const row of countRows) {
      const count = requireSafeInteger(row.outcome_count, 'feltImpulse.outcomeCount');
      projection.totalQualified += count;
      switch (row.outcome) {
        case 'no_eligible_peer':
          projection.preCandidate.noEligiblePeer += count;
          break;
        case 'not_authorized':
          projection.preCandidate.notAuthorized += count;
          break;
        case 'throttled':
          projection.preCandidate.throttled += count;
          break;
        case 'candidate_linked': {
          projection.candidateLinks.total += count;
          if (row.candidate_outcome === 'submitted') projection.candidateLinks.submitted += count;
          else if (row.candidate_outcome === 'deduped') projection.candidateLinks.deduped += count;
          else throw new Error(`Unknown felt-impulse candidate outcome ${String(row.candidate_outcome)}`);
          projection.candidateLifecycle[lifecycleOutcome(row.lifecycle_outcome)] += count;
          break;
        }
        default:
          throw new Error(`Unknown felt-impulse funnel outcome ${row.outcome}`);
      }
    }
    return projection;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
