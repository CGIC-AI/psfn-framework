import type { Pool, QueryResultRow } from 'pg';
import {
  createPostgresPool,
  ensurePostgresSchema,
  executeQuery,
  queryRows,
} from '../postgres.js';
import { POSTGRES_HEALTH_EVENT_MIGRATIONS, SHARED_SCHEMA_NAME } from './migrations.js';
import { assertSharedSchemaReady } from './shared-schema.js';
import { assertPostgresRelationColumns } from './relation-contract.js';
import { requireSafeInteger as safeInteger } from './row-guards.js';
import { validateHealthEvent, type HealthEvent } from '../../shared/contracts/health-event.js';
import {
  MAX_HEALTH_EVENT_LIST_LIMIT,
  type HealthEventQuery,
  type HealthEventStorePort,
} from '../../shared/observability/health-event-stream.js';

/**
 * Postgres adapter for the bounded runtime health-event stream (bead
 * psfn-framework-7qeo1.24.1).
 *
 * The ring bound is the table: every write prunes everything past
 * `maxRows` in newest-first order, exactly like the analysis-workbench trace
 * ring, so the stream survives a restart without ever growing unbounded. The
 * cap is operator-owned (`settings.json` `healthEventStreamMaxRows`) and is
 * required at construction — there is no built-in fallback, so a runtime can
 * never persist health events without a declared bound.
 *
 * Each process (gateway, agent) opens its own store against its own pool
 * scope and persists the observations it makes. In a single-companion
 * deployment those resolve to one table, so that already is the joined view.
 * In a fleet they do not, and the gateway's own observations would be
 * unreadable by every Garden — so there the gateway writes its system-owned
 * rows into the shared schema instead ({@link
 * PostgresHealthEventStore.connectShared}, bead psfn-framework-e5r0s), and each
 * companion's incident timeline reads that stream beside its own.
 */

const DEFAULT_HEALTH_EVENT_LIST_LIMIT = 200;

interface HealthEventRow extends QueryResultRow {
  event_id: string;
  schema_version: number;
  correlation_id: string;
  causation_id: string | null;
  owner_kind: string;
  owner_companion_id: string | null;
  severity: string;
  code: string;
  process: string;
  component: string;
  observer_id: string;
  subject_hash: string | null;
  occurrence_count: string | number;
  first_observed_at_ms: string | number;
  last_observed_at_ms: string | number;
  recorded_at_ms: string | number;
  evidence_json: unknown;
}

function normalizeBoundedLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_HEALTH_EVENT_LIST_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_HEALTH_EVENT_LIST_LIMIT) {
    throw new Error(
      `health event list limit must be an integer in [1, ${String(MAX_HEALTH_EVENT_LIST_LIMIT)}]`,
    );
  }
  return limit;
}

/**
 * Rebuild the envelope from columns and re-validate it. A row written by a
 * newer schema version, hand-edited, or corrupted fails closed here rather
 * than reaching a detector as a half-typed object.
 */
function mapHealthEventRow(row: HealthEventRow): HealthEvent {
  return validateHealthEvent({
    schemaVersion: row.schema_version,
    eventId: row.event_id,
    correlationId: row.correlation_id,
    ...(row.causation_id === null ? {} : { causationId: row.causation_id }),
    owner: row.owner_companion_id === null
      ? { kind: row.owner_kind }
      : { kind: row.owner_kind, companionId: row.owner_companion_id },
    severity: row.severity,
    code: row.code,
    provenance: {
      process: row.process,
      component: row.component,
      observerId: row.observer_id,
      ...(row.subject_hash === null ? {} : { subjectHash: row.subject_hash }),
    },
    occurrenceCount: safeInteger(row.occurrence_count, 'occurrence_count'),
    firstObservedAtMs: safeInteger(row.first_observed_at_ms, 'first_observed_at_ms'),
    lastObservedAtMs: safeInteger(row.last_observed_at_ms, 'last_observed_at_ms'),
    recordedAtMs: safeInteger(row.recorded_at_ms, 'recorded_at_ms'),
    evidence: row.evidence_json,
  });
}

function requirePositiveRowCap(maxRows: number): number {
  if (!Number.isSafeInteger(maxRows) || maxRows < 1) {
    throw new Error('health event stream requires a positive settings-owned row cap');
  }
  return maxRows;
}

export class PostgresHealthEventStore implements HealthEventStorePort {
  private constructor(
    private readonly pool: Pool,
    private readonly maxRows: number,
    private readonly ownsPool: boolean,
  ) {}

  static async connect(
    databaseUrl: string,
    maxRows: number,
    options: { schema?: string; role?: string } = {},
  ): Promise<PostgresHealthEventStore> {
    requirePositiveRowCap(maxRows);
    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-runtime-health-stream',
      allowExitOnIdle: true,
      schema: options.schema,
      role: options.role,
    });
    try {
      await ensurePostgresSchema(pool, POSTGRES_HEALTH_EVENT_MIGRATIONS);
      return new PostgresHealthEventStore(pool, maxRows, true);
    } catch (error) {
      await pool.end().catch(() => undefined);
      throw error;
    }
  }

  /**
   * Open the FLEET-WIDE stream in the shared schema (bead psfn-framework-e5r0s).
   *
   * Deliberately runs no DDL. The shared schema's migration authority owns its
   * chain — an ordinary runtime credential holds USAGE and DML there but not
   * CREATE — so this proves the chain has been applied and fails closed if it
   * has not, exactly like every other shared store.
   *
   * `role` is the caller's own runtime role: the gateway writes its
   * system-owned observations here, and each companion agent opens the same
   * table read-only under its own tenant credential.
   */
  static async connectShared(
    databaseUrl: string,
    maxRows: number,
    options: { role?: string } = {},
  ): Promise<PostgresHealthEventStore> {
    requirePositiveRowCap(maxRows);
    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-fleet-health-stream',
      allowExitOnIdle: true,
      schema: SHARED_SCHEMA_NAME,
      ...(options.role ? { role: options.role } : {}),
      max: 2,
    });
    try {
      await assertSharedSchemaReady(pool);
      await assertPostgresRelationColumns(pool, {
        schema: SHARED_SCHEMA_NAME,
        relation: 'runtime_health_events',
        columns: [
          'event_id', 'schema_version', 'correlation_id', 'owner_kind', 'severity',
          'code', 'process', 'component', 'observer_id', 'recorded_at_ms', 'evidence_json',
        ],
        privileges: ['SELECT'],
      });
      return new PostgresHealthEventStore(pool, maxRows, true);
    } catch (error) {
      await pool.end().catch(() => undefined);
      throw error;
    }
  }

  /** Test/embedding entry point: caller owns the pool lifecycle. */
  static async fromPool(pool: Pool, maxRows: number): Promise<PostgresHealthEventStore> {
    requirePositiveRowCap(maxRows);
    await ensurePostgresSchema(pool, POSTGRES_HEALTH_EVENT_MIGRATIONS);
    return new PostgresHealthEventStore(pool, maxRows, false);
  }

  /**
   * Append one envelope, then prune to the operator-owned cap. Idempotent on
   * `eventId`: a redelivered bus event never duplicates a row, so occurrence
   * counts stay honest.
   */
  async record(event: HealthEvent): Promise<void> {
    // Re-validate at the write boundary too: the store is the last place that
    // can refuse an envelope that never went through `createHealthEvent`.
    const validated = validateHealthEvent(event);
    await executeQuery(this.pool, `
      INSERT INTO runtime_health_events (
        event_id, schema_version, correlation_id, causation_id,
        owner_kind, owner_companion_id, severity, code,
        process, component, observer_id, subject_hash,
        occurrence_count, first_observed_at_ms, last_observed_at_ms,
        recorded_at_ms, evidence_json
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb
      )
      ON CONFLICT (event_id) DO NOTHING
    `, [
      validated.eventId,
      validated.schemaVersion,
      validated.correlationId,
      validated.causationId ?? null,
      validated.owner.kind,
      validated.owner.kind === 'companion' ? validated.owner.companionId : null,
      validated.severity,
      validated.code,
      validated.provenance.process,
      validated.provenance.component,
      validated.provenance.observerId,
      validated.provenance.subjectHash ?? null,
      validated.occurrenceCount,
      validated.firstObservedAtMs,
      validated.lastObservedAtMs,
      validated.recordedAtMs,
      JSON.stringify(validated.evidence),
    ]);
    await this.pruneToRowCap();
  }

  /**
   * Newest-first read seam for detectors and the Garden incident timeline.
   * `sinceMs` bounds the window by record time; `correlationId` narrows to one
   * incident.
   */
  async listRecent(query: HealthEventQuery = {}): Promise<HealthEvent[]> {
    const limit = normalizeBoundedLimit(query.limit);
    const sinceMs = query.sinceMs ?? null;
    if (sinceMs !== null && (!Number.isSafeInteger(sinceMs) || sinceMs < 0)) {
      throw new Error('health event listRecent sinceMs must be a non-negative integer');
    }
    const correlationId = query.correlationId?.trim() ?? null;
    if (query.correlationId !== undefined && !correlationId) {
      throw new Error('health event listRecent correlationId must be non-empty when provided');
    }
    const rows = await queryRows<HealthEventRow>(this.pool, `
      SELECT *
      FROM runtime_health_events
      WHERE ($1::bigint IS NULL OR recorded_at_ms >= $1::bigint)
        AND ($2::uuid IS NULL OR correlation_id = $2::uuid)
      ORDER BY recorded_at_ms DESC, event_id DESC
      LIMIT $3
    `, [sinceMs, correlationId, limit]);
    return rows.map(mapHealthEventRow);
  }

  async close(): Promise<void> {
    if (this.ownsPool) {
      await this.pool.end();
    }
  }

  /**
   * The ring bound. Deletes everything past the cap in the same newest-first
   * order the read uses, so the surviving window is exactly what an operator
   * would see.
   */
  private async pruneToRowCap(): Promise<void> {
    await executeQuery(this.pool, `
      DELETE FROM runtime_health_events
      WHERE event_id IN (
        SELECT event_id
        FROM runtime_health_events
        ORDER BY recorded_at_ms DESC, event_id DESC
        OFFSET $1
      )
    `, [this.maxRows]);
  }
}

/**
 * Open the gateway process's health stream from runtime config.
 *
 * `loadConfig` requires a Postgres URL in gateway mode, so this has no
 * nullable or memory-only path: a missing URL or a missing owner-file row cap
 * is a startup failure, not a silent downgrade to an unobservable runtime.
 *
 * Deliberately unpinned to any companion tenant schema, matching every other
 * unconditional gateway store (`gateway_audit`, companion presence): the
 * gateway credential owns its own default search_path and does not hold a
 * companion tenant role. Per-companion health events are written by the agent
 * process, whose factory pins the tenant scope like its sibling stores.
 */
export function createGatewayHealthEventStore(config: {
  postgresDatabaseUrl?: string;
  healthEventStreamMaxRows?: number;
}): Promise<PostgresHealthEventStore> {
  const databaseUrl = config.postgresDatabaseUrl?.trim();
  if (!databaseUrl) {
    throw new Error('Runtime health stream requires config.postgresDatabaseUrl');
  }
  const maxRows = config.healthEventStreamMaxRows;
  if (maxRows === undefined) {
    throw new Error('Runtime health stream requires settings.json healthEventStreamMaxRows');
  }
  return PostgresHealthEventStore.connect(databaseUrl, maxRows);
}

/**
 * Open the gateway's FLEET-WIDE health stream in the shared schema
 * (bead psfn-framework-e5r0s).
 *
 * Same owner-file bound and same config validation as its single-companion
 * sibling above; the only difference is where the rows land, which is the whole
 * point — in a fleet the gateway's observations are the only ones no companion
 * can otherwise see.
 */
export function createFleetSystemHealthEventStore(config: {
  postgresDatabaseUrl?: string;
  healthEventStreamMaxRows?: number;
}): Promise<PostgresHealthEventStore> {
  const databaseUrl = config.postgresDatabaseUrl?.trim();
  if (!databaseUrl) {
    throw new Error('Fleet system health stream requires config.postgresDatabaseUrl');
  }
  const maxRows = config.healthEventStreamMaxRows;
  if (maxRows === undefined) {
    throw new Error('Fleet system health stream requires settings.json healthEventStreamMaxRows');
  }
  return PostgresHealthEventStore.connectShared(databaseUrl, maxRows);
}
