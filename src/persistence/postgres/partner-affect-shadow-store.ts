import { randomUUID } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import {
  createPostgresPool,
  ensurePostgresSchema,
  executeQuery,
  queryOne,
  queryRows,
} from '../postgres.js';
import { POSTGRES_PARTNER_AFFECT_SHADOW_MIGRATIONS } from './migrations.js';
import type {
  PartnerAffectObservationListOptions,
  PartnerAffectObservationRecordResult,
  PartnerAffectShadowStorePort,
  PartnerAffectSuppressionListOptions,
} from '../../core/emotion/partner-affect/shadow-store-port.js';
import {
  PARTNER_AFFECT_SCHEMA_VERSION,
  PARTNER_AFFECT_SUPPRESSION_REASONS,
  isPartnerAffectDirection,
  isPartnerAffectSignalFamily,
  type PartnerAffectAssertionBasis,
  type PartnerAffectObservation,
  type PartnerAffectSuppressedObservation,
  type PartnerAffectSuppressionReason,
} from '../../shared/contracts/partner-affect.js';
import { normalizeEmotionTelemetryProvenance } from '../../core/emotion/telemetry-validation.js';

const MAX_PARTNER_AFFECT_SHADOW_LIST_LIMIT = 1_000;
const DEFAULT_PARTNER_AFFECT_SHADOW_LIST_LIMIT = 200;

interface ObservationRow extends QueryResultRow {
  observation_key: string;
  schema_version: number;
  observation_id: string;
  source_id: string;
  partner_contact_id: string;
  signal_family: string;
  metric_name: string;
  value: number;
  unit: string;
  window_start_ms: string | number;
  window_end_ms: string | number;
  observed_at_ms: string | number;
  coverage: number;
  confidence: number;
  missingness: number;
  direction: string;
  sensitivity: string;
  consent_ref: string;
  assertion: string;
  provenance_json: unknown;
  processing_revision: string;
  received_at_ms: string | number;
}

interface SuppressionRow extends QueryResultRow {
  observation_key: string | null;
  source_id: string | null;
  signal_family: string | null;
  partner_contact_id: string | null;
  reasons_json: unknown;
  detail: string;
  received_at_ms: string | number;
}

function safeInteger(value: string | number, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Persisted partner-affect shadow row has non-integer ${field}: ${String(value)}`);
  }
  return parsed;
}

function normalizeBoundedLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PARTNER_AFFECT_SHADOW_LIST_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PARTNER_AFFECT_SHADOW_LIST_LIMIT) {
    throw new Error(
      `partner-affect shadow list limit must be an integer in [1, ${String(MAX_PARTNER_AFFECT_SHADOW_LIST_LIMIT)}]`,
    );
  }
  return limit;
}

function mapObservationRow(row: ObservationRow): PartnerAffectObservation {
  if (row.schema_version !== PARTNER_AFFECT_SCHEMA_VERSION) {
    throw new Error(
      `Persisted partner-affect observation ${row.observation_key} has unsupported schema version ${String(row.schema_version)}`,
    );
  }
  if (!isPartnerAffectSignalFamily(row.signal_family)) {
    throw new Error(
      `Persisted partner-affect observation ${row.observation_key} has unknown signal family "${row.signal_family}"`,
    );
  }
  if (!isPartnerAffectDirection(row.direction)) {
    throw new Error(
      `Persisted partner-affect observation ${row.observation_key} has unknown direction "${row.direction}"`,
    );
  }
  if (
    row.assertion !== 'partner_asserted'
    && row.assertion !== 'model_inferred'
    && row.assertion !== 'sensor_summary'
    && row.assertion !== 'unverified'
  ) {
    throw new Error(
      `Persisted partner-affect observation ${row.observation_key} has unknown assertion basis "${row.assertion}"`,
    );
  }
  return {
    schemaVersion: PARTNER_AFFECT_SCHEMA_VERSION,
    observationKey: row.observation_key,
    observationId: row.observation_id,
    sourceId: row.source_id,
    partnerContactId: row.partner_contact_id,
    signalFamily: row.signal_family,
    metricName: row.metric_name,
    value: row.value,
    unit: row.unit,
    windowStartMs: safeInteger(row.window_start_ms, 'window_start_ms'),
    windowEndMs: safeInteger(row.window_end_ms, 'window_end_ms'),
    observedAtMs: safeInteger(row.observed_at_ms, 'observed_at_ms'),
    coverage: row.coverage,
    confidence: row.confidence,
    missingness: row.missingness,
    direction: row.direction,
    sensitivity: row.sensitivity,
    consentRef: row.consent_ref,
    assertion: row.assertion as PartnerAffectAssertionBasis,
    provenance: normalizeEmotionTelemetryProvenance(
      row.provenance_json,
      `partnerAffectObservation(${row.observation_key}).provenance`,
    ),
    processingRevision: row.processing_revision,
    receivedAtMs: safeInteger(row.received_at_ms, 'received_at_ms'),
  };
}

function mapSuppressionRow(row: SuppressionRow): PartnerAffectSuppressedObservation {
  if (!Array.isArray(row.reasons_json) || row.reasons_json.length === 0) {
    throw new Error('Persisted partner-affect suppression record has malformed reasons');
  }
  const reasons = row.reasons_json.map((reason) => {
    if (!PARTNER_AFFECT_SUPPRESSION_REASONS.includes(reason as PartnerAffectSuppressionReason)) {
      throw new Error(`Persisted partner-affect suppression record has unknown reason "${String(reason)}"`);
    }
    return reason as PartnerAffectSuppressionReason;
  });
  let signalFamily = null;
  if (row.signal_family !== null) {
    if (!isPartnerAffectSignalFamily(row.signal_family)) {
      throw new Error(
        `Persisted partner-affect suppression record has unknown signal family "${row.signal_family}"`,
      );
    }
    signalFamily = row.signal_family;
  }
  return {
    schemaVersion: PARTNER_AFFECT_SCHEMA_VERSION,
    observationKey: row.observation_key,
    sourceId: row.source_id,
    signalFamily,
    partnerContactId: row.partner_contact_id,
    reasons,
    detail: row.detail,
    receivedAtMs: safeInteger(row.received_at_ms, 'received_at_ms'),
  };
}

/**
 * Postgres adapter for the Partner Affect shadow observation store
 * (docs/partner-affect.md slice 1). Idempotent on (source_id, observation_id);
 * shadow-only read surface (Garden inspection + tests).
 */
export class PostgresPartnerAffectShadowStore implements PartnerAffectShadowStorePort {
  private constructor(
    private readonly pool: Pool,
    private readonly ownsPool: boolean,
  ) {}

  static async connect(
    databaseUrl: string,
    options: { schema?: string; role?: string } = {},
  ): Promise<PostgresPartnerAffectShadowStore> {
    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-partner-affect-shadow',
      allowExitOnIdle: true,
      schema: options.schema,
      role: options.role,
    });
    try {
      await ensurePostgresSchema(pool, POSTGRES_PARTNER_AFFECT_SHADOW_MIGRATIONS);
      return new PostgresPartnerAffectShadowStore(pool, true);
    } catch (error) {
      await pool.end().catch(() => undefined);
      throw error;
    }
  }

  /** Test/embedding entry point: caller owns the pool lifecycle. */
  static async fromPool(pool: Pool): Promise<PostgresPartnerAffectShadowStore> {
    await ensurePostgresSchema(pool, POSTGRES_PARTNER_AFFECT_SHADOW_MIGRATIONS);
    return new PostgresPartnerAffectShadowStore(pool, false);
  }

  async recordAccepted(
    observation: PartnerAffectObservation,
  ): Promise<PartnerAffectObservationRecordResult> {
    const row = await queryOne<{ observation_key: string }>(this.pool, `
      INSERT INTO partner_affect_shadow_observations (
        observation_key, schema_version, observation_id, source_id,
        partner_contact_id, signal_family, metric_name, value, unit,
        window_start_ms, window_end_ms, observed_at_ms,
        coverage, confidence, missingness, direction,
        sensitivity, consent_ref, assertion, provenance_json,
        processing_revision, received_at_ms
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
        $13, $14, $15, $16, $17, $18, $19, $20::jsonb, $21, $22
      )
      ON CONFLICT (source_id, observation_id) DO NOTHING
      RETURNING observation_key
    `, [
      observation.observationKey,
      observation.schemaVersion,
      observation.observationId,
      observation.sourceId,
      observation.partnerContactId,
      observation.signalFamily,
      observation.metricName,
      observation.value,
      observation.unit,
      observation.windowStartMs,
      observation.windowEndMs,
      observation.observedAtMs,
      observation.coverage,
      observation.confidence,
      observation.missingness,
      observation.direction,
      observation.sensitivity,
      observation.consentRef,
      observation.assertion,
      JSON.stringify(observation.provenance),
      observation.processingRevision,
      observation.receivedAtMs,
    ]);
    return { inserted: row !== undefined };
  }

  async recordSuppressed(suppressed: PartnerAffectSuppressedObservation): Promise<void> {
    if (suppressed.reasons.length === 0) {
      throw new Error('partner-affect suppression record requires at least one reason');
    }
    await executeQuery(this.pool, `
      INSERT INTO partner_affect_shadow_suppressions (
        id, schema_version, observation_key, source_id, signal_family,
        partner_contact_id, reasons_json, detail, received_at_ms
      ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
    `, [
      randomUUID(),
      suppressed.schemaVersion,
      suppressed.observationKey,
      suppressed.sourceId,
      suppressed.signalFamily,
      suppressed.partnerContactId,
      JSON.stringify(suppressed.reasons),
      suppressed.detail.slice(0, 2_048),
      suppressed.receivedAtMs,
    ]);
  }

  async listAccepted(
    options: PartnerAffectObservationListOptions,
  ): Promise<PartnerAffectObservation[]> {
    const partnerContactId = options.partnerContactId.trim();
    if (!partnerContactId) {
      throw new Error('listAccepted requires a non-empty partnerContactId');
    }
    const limit = normalizeBoundedLimit(options.limit);
    const sinceMs = options.sinceMs === undefined ? null : options.sinceMs;
    if (sinceMs !== null && (!Number.isSafeInteger(sinceMs) || sinceMs < 0)) {
      throw new Error('listAccepted sinceMs must be a non-negative integer when provided');
    }
    const rows = await queryRows<ObservationRow>(this.pool, `
      SELECT *
      FROM partner_affect_shadow_observations
      WHERE partner_contact_id = $1
        AND ($2::bigint IS NULL OR observed_at_ms >= $2::bigint)
      ORDER BY observed_at_ms DESC, observation_key DESC
      LIMIT $3
    `, [partnerContactId, sinceMs, limit]);
    return rows.map(mapObservationRow);
  }

  async listSuppressed(
    options: PartnerAffectSuppressionListOptions = {},
  ): Promise<PartnerAffectSuppressedObservation[]> {
    const limit = normalizeBoundedLimit(options.limit);
    const partnerContactId = options.partnerContactId?.trim() ?? null;
    if (options.partnerContactId !== undefined && !partnerContactId) {
      throw new Error('listSuppressed partnerContactId must be non-empty when provided');
    }
    // Scope to the bound partner exactly like listAccepted: a non-null filter
    // excludes rows from a prior binding, a different partner, and unbound
    // (null-partner) suppressions. Absent filter returns the full audit.
    const rows = await queryRows<SuppressionRow>(this.pool, `
      SELECT observation_key, source_id, signal_family, partner_contact_id,
             reasons_json, detail, received_at_ms
      FROM partner_affect_shadow_suppressions
      WHERE ($1::text IS NULL OR partner_contact_id = $1)
      ORDER BY received_at_ms DESC, id DESC
      LIMIT $2
    `, [partnerContactId, limit]);
    return rows.map(mapSuppressionRow);
  }

  async pruneToRetentionCap(maxRetained: number): Promise<number> {
    if (!Number.isSafeInteger(maxRetained) || maxRetained < 1) {
      throw new Error('pruneToRetentionCap requires a positive integer cap');
    }
    const observationResult = await executeQuery(this.pool, `
      DELETE FROM partner_affect_shadow_observations
      WHERE observation_key IN (
        SELECT observation_key
        FROM partner_affect_shadow_observations
        ORDER BY observed_at_ms DESC, observation_key DESC
        OFFSET $1
      )
    `, [maxRetained]);
    const suppressionResult = await executeQuery(this.pool, `
      DELETE FROM partner_affect_shadow_suppressions
      WHERE id IN (
        SELECT id
        FROM partner_affect_shadow_suppressions
        ORDER BY received_at_ms DESC, id DESC
        OFFSET $1
      )
    `, [maxRetained]);
    return (observationResult.rowCount ?? 0) + (suppressionResult.rowCount ?? 0);
  }

  async close(): Promise<void> {
    if (this.ownsPool) {
      await this.pool.end();
    }
  }
}
