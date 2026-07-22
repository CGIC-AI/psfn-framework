import { randomUUID } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import {
  createPostgresPool,
  ensurePostgresSchema,
  executeQuery,
  queryRows,
} from '../postgres.js';
import { POSTGRES_ANALYSIS_WORKBENCH_TRACE_MIGRATIONS } from './migrations.js';
import type { AnalysisWorkbenchTraceView } from '../../operator/garden/types.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { createComponentLogger } from '../../shared/logger.js';
import { toErrorMessage } from '../../shared/utils/errors.js';

const log = createComponentLogger('AnalysisWorkbenchTraceStore');

/**
 * Durable ring for the redacted analysis-workbench trace projection (bead
 * vb11). The Garden dashboard keeps an in-memory ring for hot reads and
 * hydrates it from this store on construction, so traces recorded before a
 * Garden/agent restart remain visible afterward. Companion-scoped; the store
 * itself keeps each companion bounded to a fixed retention window.
 */
export interface AnalysisWorkbenchTraceStorePort {
  /** Persist one redacted trace projection, then prune to the retention cap. */
  record(trace: AnalysisWorkbenchTraceView): Promise<void>;
  /** Newest-first traces for the scoped companion, capped by `limit`. */
  listRecent(limit: number): Promise<AnalysisWorkbenchTraceView[]>;
  close(): Promise<void>;
}

interface TraceRow extends QueryResultRow {
  trace_json: unknown;
}

function assertTraceView(value: unknown): AnalysisWorkbenchTraceView {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Persisted analysis-workbench trace is not an object');
  }
  const record = value as Record<string, unknown>;
  if (typeof record.timestamp !== 'number' || typeof record.task !== 'string'
    || typeof record.iterations !== 'number' || !Array.isArray(record.steps)) {
    throw new Error('Persisted analysis-workbench trace is missing required fields');
  }
  return value as AnalysisWorkbenchTraceView;
}

export class PostgresAnalysisWorkbenchTraceStore implements AnalysisWorkbenchTraceStorePort {
  private readonly ready: Promise<void>;

  constructor(
    private readonly pool: Pool,
    private readonly companionId: string,
    private readonly retentionCap: number,
    private readonly ownsPool: boolean,
  ) {
    if (!companionId.trim()) {
      throw new Error('analysis-workbench trace store requires a non-empty companionId');
    }
    if (!Number.isSafeInteger(retentionCap) || retentionCap < 1) {
      throw new Error('analysis-workbench trace store requires a positive retention cap');
    }
    this.ready = ensurePostgresSchema(pool, POSTGRES_ANALYSIS_WORKBENCH_TRACE_MIGRATIONS);
    // The migration promise is created here but nothing awaits it until the
    // first `record`/`listRecent` call, so a boot-time failure would otherwise
    // escape as a process-level unhandled rejection and destabilise the agent
    // (psfn-framework-stmof). Observing it reports the failure once; `ready`
    // still rejects for every caller below, so nothing is swallowed.
    this.ready.catch((error) => {
      log.error('Analysis-workbench trace schema migration failed', {
        error: toErrorMessage(error),
      });
    });
  }

  static connect(
    databaseUrl: string,
    companionId: string,
    retentionCap: number,
    options: { schema?: string; role?: string } = {},
  ): PostgresAnalysisWorkbenchTraceStore {
    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-analysis-workbench-traces',
      allowExitOnIdle: true,
      schema: options.schema,
      role: options.role,
    });
    return new PostgresAnalysisWorkbenchTraceStore(pool, companionId, retentionCap, true);
  }

  /** Test/embedding entry point: caller owns the pool lifecycle. */
  static async fromPool(
    pool: Pool,
    companionId: string,
    retentionCap: number,
  ): Promise<PostgresAnalysisWorkbenchTraceStore> {
    const store = new PostgresAnalysisWorkbenchTraceStore(pool, companionId, retentionCap, false);
    await store.ready;
    return store;
  }

  async record(trace: AnalysisWorkbenchTraceView): Promise<void> {
    await this.ready;
    if (!Number.isSafeInteger(trace.timestamp) || trace.timestamp < 0) {
      throw new Error('analysis-workbench trace timestamp must be a non-negative integer');
    }
    await executeQuery(this.pool, `
      INSERT INTO analysis_workbench_traces (id, companion_id, recorded_at_ms, trace_json)
      VALUES ($1, $2, $3, $4::jsonb)
    `, [randomUUID(), this.companionId, trace.timestamp, JSON.stringify(trace)]);
    await this.pruneToRetentionCap();
  }

  async listRecent(limit: number): Promise<AnalysisWorkbenchTraceView[]> {
    await this.ready;
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error('analysis-workbench trace listRecent requires a positive integer limit');
    }
    const rows = await queryRows<TraceRow>(this.pool, `
      SELECT trace_json
      FROM analysis_workbench_traces
      WHERE companion_id = $1
      ORDER BY recorded_at_ms DESC, id DESC
      LIMIT $2
    `, [this.companionId, limit]);
    return rows.map((row) => assertTraceView(row.trace_json));
  }

  private async pruneToRetentionCap(): Promise<void> {
    await executeQuery(this.pool, `
      DELETE FROM analysis_workbench_traces
      WHERE companion_id = $1
        AND id IN (
          SELECT id
          FROM analysis_workbench_traces
          WHERE companion_id = $1
          ORDER BY recorded_at_ms DESC, id DESC
          OFFSET $2
        )
    `, [this.companionId, this.retentionCap]);
  }

  async close(): Promise<void> {
    if (this.ownsPool) {
      await this.pool.end();
    }
  }
}

/**
 * Build a companion-scoped trace store from runtime config. Returns null when
 * persistence is not Postgres (the dashboard then stays memory-only); throws
 * when Postgres is configured without a companionId, since the store must be
 * companion-scoped.
 *
 * Traces are companion-local, so the pool pins the companion's tenant schema
 * and role exactly like every other per-companion store in
 * `createAgentPersistenceRuntime`. Without that pin the store inherits the
 * default `"$user", public` search_path, which resolves to nothing under a
 * named tenant credential (no `$user` schema, no USAGE on `public`) and fails
 * the unqualified migration DDL with `no schema has been selected to create
 * in` (psfn-framework-stmof). When `postgresSchema` is unset the behavior is
 * byte-identical to the legacy single-companion public tenant.
 */
export function createPostgresAnalysisWorkbenchTraceStoreFromConfig(
  config: Pick<
    SubstrateConfig,
    | 'persistenceBackend'
    | 'postgresDatabaseUrl'
    | 'companionId'
    | 'postgresSchema'
    | 'postgresRole'
    | 'multiCompanion'
  >,
  retentionCap: number,
): PostgresAnalysisWorkbenchTraceStore | null {
  if (config.persistenceBackend !== 'postgres') {
    return null;
  }
  const databaseUrl = config.postgresDatabaseUrl?.trim();
  if (!databaseUrl) return null;
  const companionId = config.companionId?.trim();
  if (!companionId) {
    throw new Error('PostgreSQL analysis-workbench trace persistence requires a configured companionId');
  }
  const schema = config.postgresSchema?.trim() || undefined;
  // A least-privilege tenant role is only accepted alongside an explicit
  // schema, and multi-companion topology owns it — same contract as
  // `createAgentPersistenceRuntime`, so a fleet member never silently falls
  // back to its login role's default privileges.
  const role = schema && config.multiCompanion === true
    ? config.postgresRole?.trim() || (() => {
        throw new Error(
          'Multi-companion analysis-workbench trace persistence requires config.postgresRole',
        );
      })()
    : undefined;
  return PostgresAnalysisWorkbenchTraceStore.connect(databaseUrl, companionId, retentionCap, {
    schema,
    role,
  });
}
