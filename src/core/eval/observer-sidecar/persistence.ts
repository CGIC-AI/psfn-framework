import type { Pool } from 'pg';
import type { EmotionStateSnapshot } from '../../emotion/state.js';
import {
  createPostgresPool,
  ensurePostgresSchema,
  executeQuery,
  queryRows,
  queryOne,
} from '../../../persistence/postgres.js';
import { POSTGRES_OBSERVER_EVAL_SIDECAR_MIGRATIONS } from '../../../persistence/postgres/migrations.js';
import type { ObserverEmotionCrosswalkOutput } from './crosswalk.js';
import type { EmoSimAdapterRunResult } from './emosim-adapter.js';
import type { ObserverAppraisalProjectionResult } from './projection.js';
import type {
  ObserverEvalPrivacyDecision,
  ObserverEvalSanitizedInputPayload,
  ObserverEvalSanitizedLifecycleStatePayload,
} from './privacy.js';
import type { ObserverEvalSidecarConfig } from './types.js';

export const OBSERVER_EVAL_SIDECAR_PERSISTENCE_SCHEMA_VERSION = 1 as const;
export const OBSERVER_EVAL_SIDECAR_EVAL_OWNER = 'observer_sidecar_eval' as const;
export const OBSERVER_EVAL_SIDECAR_NON_AUTHORITATIVE_NOTICE =
  'Observer sidecar persistence is eval-owned telemetry only; it is not companion memory, production EmotionState, InternalState, prompt state, contacts, or concerns.' as const;
export const OBSERVER_EVAL_COMPARISON_METRICS_VERSION =
  'psfn.observer-sidecar.comparison-metrics.v1' as const;

const DEFAULT_QUERY_LIMIT = 100;
const MAX_QUERY_LIMIT = 1_000;

export const OBSERVER_EVAL_RETENTION_CLASSES = Object.freeze([
  'ephemeral',
  'short',
  'standard',
  'extended',
  'manual_review',
] as const);

export type ObserverEvalRetentionClass = typeof OBSERVER_EVAL_RETENTION_CLASSES[number];
export type ObserverEvalSidecarRunStatus = 'running' | 'completed' | 'degraded' | 'failed';
export type ObserverEvalSidecarObservationStatus = 'ok' | 'degraded' | 'error';

export interface ObserverEvalSidecarRetentionMetadata {
  retentionClass: ObserverEvalRetentionClass;
  policyId: string;
  capturedAtMs: number;
  retainUntilMs: number;
  reason: string;
  deleteAfterMs?: number;
  tags?: readonly string[];
  metadata?: Record<string, unknown>;
}

export interface ObserverEvalSidecarRunInput {
  runId: string;
  sidecarId: string;
  deployment: string;
  evalSessionId?: string;
  scenarioId?: string;
  testRunId?: string;
  status?: ObserverEvalSidecarRunStatus;
  startedAtMs: number;
  completedAtMs?: number;
  metadata?: Record<string, unknown>;
  retention: ObserverEvalSidecarRetentionMetadata;
}

export interface ObserverEvalSidecarRunRecord extends ObserverEvalSidecarRunInput {
  schemaVersion: typeof OBSERVER_EVAL_SIDECAR_PERSISTENCE_SCHEMA_VERSION;
  evalOwner: typeof OBSERVER_EVAL_SIDECAR_EVAL_OWNER;
  authoritative: false;
  status: ObserverEvalSidecarRunStatus;
  metadata: Record<string, unknown>;
  createdAtMs: number;
  updatedAtMs: number;
  nonAuthoritativeNotice: typeof OBSERVER_EVAL_SIDECAR_NON_AUTHORITATIVE_NOTICE;
}

export interface ObserverEvalPsfnEmotionReference {
  snapshot: EmotionStateSnapshot | null;
  snapshotRef?: string;
  appraisalEntryCount: number;
  snapshotSource: 'observeEmotionState' | 'observer-sanitized-input';
}

export interface ObserverEvalSidecarComparisonMetrics {
  schemaVersion: typeof OBSERVER_EVAL_SIDECAR_PERSISTENCE_SCHEMA_VERSION;
  metricsVersion: typeof OBSERVER_EVAL_COMPARISON_METRICS_VERSION;
  divergenceScore: number | null;
  vadDistance: number | null;
  familyMismatch: boolean | null;
  directionMismatch: boolean | null;
  unmappedSignal: number | null;
  details?: Record<string, unknown>;
}

export interface ObserverEvalSidecarErrorState {
  message: string;
  code?: string;
  recoverable: boolean;
  redacted: true;
  redactionReason: string;
  details?: Record<string, boolean | number | string | null>;
}

export interface ObserverEvalSidecarObservationInput {
  observationId: string;
  runId: string;
  sanitizedInput: ObserverEvalSanitizedInputPayload;
  observedAtMs?: number;
  status?: ObserverEvalSidecarObservationStatus;
  psfnEmotion?: ObserverEvalPsfnEmotionReference;
  projection?: ObserverAppraisalProjectionResult;
  emosim?: EmoSimAdapterRunResult;
  crosswalk?: ObserverEmotionCrosswalkOutput;
  comparisonMetrics?: ObserverEvalSidecarComparisonMetrics;
  error?: ObserverEvalSidecarErrorState;
  degradedState?: ObserverEvalSanitizedLifecycleStatePayload;
  metadata?: Record<string, unknown>;
  retention: ObserverEvalSidecarRetentionMetadata;
}

export interface ObserverEvalSidecarObservationRecord extends ObserverEvalSidecarObservationInput {
  schemaVersion: typeof OBSERVER_EVAL_SIDECAR_PERSISTENCE_SCHEMA_VERSION;
  evalOwner: typeof OBSERVER_EVAL_SIDECAR_EVAL_OWNER;
  authoritative: false;
  turnId: string;
  capturedAtMs: number;
  observedAtMs: number;
  status: ObserverEvalSidecarObservationStatus;
  privacy: ObserverEvalPrivacyDecision;
  psfnEmotion: ObserverEvalPsfnEmotionReference;
  comparisonMetrics: ObserverEvalSidecarComparisonMetrics;
  metadata: Record<string, unknown>;
  createdAtMs: number;
  nonAuthoritativeNotice: typeof OBSERVER_EVAL_SIDECAR_NON_AUTHORITATIVE_NOTICE;
}

export interface ObserverEvalSidecarRunQuery {
  evalSessionId?: string;
  scenarioId?: string;
  testRunId?: string;
  status?: ObserverEvalSidecarRunStatus;
  sinceMs?: number;
  untilMs?: number;
  limit?: number;
}

export interface ObserverEvalSidecarObservationQuery {
  runId?: string;
  evalSessionId?: string;
  scenarioId?: string;
  testRunId?: string;
  turnId?: string;
  privacyClass?: ObserverEvalPrivacyDecision['privacyClass'];
  status?: ObserverEvalSidecarObservationStatus;
  minDivergenceScore?: number;
  sinceMs?: number;
  untilMs?: number;
  limit?: number;
}

export interface ObserverEvalSidecarPruneResult {
  prunedAtMs: number;
  prunedObservationIds: readonly string[];
  prunedRunIds: readonly string[];
}

export interface ObserverEvalSidecarPersistencePort {
  upsertRun(input: ObserverEvalSidecarRunInput): Promise<ObserverEvalSidecarRunRecord>;
  getRun(runId: string): Promise<ObserverEvalSidecarRunRecord | null>;
  queryRuns(query?: ObserverEvalSidecarRunQuery): Promise<ObserverEvalSidecarRunRecord[]>;
  recordObservation(
    input: ObserverEvalSidecarObservationInput,
  ): Promise<ObserverEvalSidecarObservationRecord>;
  getObservation(observationId: string): Promise<ObserverEvalSidecarObservationRecord | null>;
  getLatestObservation(
    query?: Omit<ObserverEvalSidecarObservationQuery, 'limit'>,
  ): Promise<ObserverEvalSidecarObservationRecord | null>;
  queryObservations(
    query?: ObserverEvalSidecarObservationQuery,
  ): Promise<ObserverEvalSidecarObservationRecord[]>;
  pruneExpiredRetention(nowMs: number): Promise<ObserverEvalSidecarPruneResult>;
}

interface StoreOptions {
  nowMs?: () => number;
}

interface ObserverEvalRunRow {
  run_id: string;
  schema_version: number | string;
  eval_owner: string;
  authoritative: boolean;
  sidecar_id: string;
  deployment: NonNullable<ObserverEvalSidecarConfig['deployment']>;
  eval_session_id: string | null;
  scenario_id: string | null;
  test_run_id: string | null;
  status: ObserverEvalSidecarRunStatus;
  started_at_ms: number | string;
  completed_at_ms: number | string | null;
  metadata_json: unknown;
  retention_json: unknown;
  retain_until_ms: number | string;
  created_at_ms: number | string;
  updated_at_ms: number | string;
}

interface ObserverEvalObservationRow {
  observation_id: string;
  run_id: string;
  schema_version: number | string;
  eval_owner: string;
  authoritative: boolean;
  turn_id: string;
  captured_at_ms: number | string;
  observed_at_ms: number | string;
  status: ObserverEvalSidecarObservationStatus;
  privacy_class: ObserverEvalPrivacyDecision['privacyClass'];
  sensitivity: ObserverEvalPrivacyDecision['sensitivity'];
  channel_visibility: ObserverEvalPrivacyDecision['channelVisibility'];
  redaction_reason: ObserverEvalPrivacyDecision['redactionReason'];
  raw_content_redacted: boolean;
  sensitive_identifiers_redacted: boolean;
  derived_telemetry_permitted: boolean;
  psfn_emotion_snapshot_ref: string | null;
  psfn_emotion_snapshot_json: unknown;
  observer_input_json: unknown;
  projected_appraisal_json: unknown;
  emosim_output_json: unknown;
  crosswalk_json: unknown;
  comparison_metrics_json: unknown;
  divergence_score: number | string | null;
  error_json: unknown;
  degraded_state_json: unknown;
  metadata_json: unknown;
  retention_json: unknown;
  retain_until_ms: number | string;
  created_at_ms: number | string;
}

interface ReturnedObservationIdRow {
  observation_id: string;
}

interface ReturnedRunIdRow {
  run_id: string;
}

interface SqlWhere {
  clause: string;
  values: unknown[];
}

export class PostgresObserverEvalSidecarStore implements ObserverEvalSidecarPersistencePort {
  private readonly ready: Promise<void>;
  private readonly nowMs: () => number;

  constructor(private readonly pool: Pool, options: StoreOptions = {}) {
    this.ready = ensurePostgresSchema(pool, POSTGRES_OBSERVER_EVAL_SIDECAR_MIGRATIONS);
    this.nowMs = options.nowMs ?? Date.now;
  }

  static connect(
    databaseUrl: string,
    options: StoreOptions = {},
  ): PostgresObserverEvalSidecarStore {
    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-observer-eval-sidecar',
      allowExitOnIdle: true,
    });
    return new PostgresObserverEvalSidecarStore(pool, options);
  }

  async upsertRun(input: ObserverEvalSidecarRunInput): Promise<ObserverEvalSidecarRunRecord> {
    const run = normalizeRunRecord(input, this.nowMs());
    await this.ready;
    await executeQuery(this.pool, `
      INSERT INTO observer_eval_sidecar_runs (
        run_id, schema_version, eval_owner, authoritative, sidecar_id, deployment,
        eval_session_id, scenario_id, test_run_id, status, started_at_ms,
        completed_at_ms, metadata_json, retention_json, retain_until_ms,
        created_at_ms, updated_at_ms
      )
      VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11,
        $12, $13::jsonb, $14::jsonb, $15,
        $16, $17
      )
      ON CONFLICT (run_id) DO UPDATE SET
        sidecar_id = excluded.sidecar_id,
        deployment = excluded.deployment,
        eval_session_id = excluded.eval_session_id,
        scenario_id = excluded.scenario_id,
        test_run_id = excluded.test_run_id,
        status = excluded.status,
        completed_at_ms = excluded.completed_at_ms,
        metadata_json = excluded.metadata_json,
        retention_json = excluded.retention_json,
        retain_until_ms = excluded.retain_until_ms,
        updated_at_ms = excluded.updated_at_ms
    `, [
      run.runId,
      run.schemaVersion,
      run.evalOwner,
      run.authoritative,
      run.sidecarId,
      run.deployment,
      run.evalSessionId ?? null,
      run.scenarioId ?? null,
      run.testRunId ?? null,
      run.status,
      run.startedAtMs,
      run.completedAtMs ?? null,
      JSON.stringify(run.metadata),
      JSON.stringify(run.retention),
      run.retention.retainUntilMs,
      run.createdAtMs,
      run.updatedAtMs,
    ]);
    return run;
  }

  async getRun(runId: string): Promise<ObserverEvalSidecarRunRecord | null> {
    await this.ready;
    const row = await queryOne<ObserverEvalRunRow>(this.pool, `
      SELECT *
      FROM observer_eval_sidecar_runs
      WHERE run_id = $1
    `, [normalizeNonEmptyText(runId, 'runId')]);
    return row ? mapRunRow(row) : null;
  }

  async queryRuns(query: ObserverEvalSidecarRunQuery = {}): Promise<ObserverEvalSidecarRunRecord[]> {
    await this.ready;
    const normalizedQuery = normalizeRunQuery(query);
    const where = buildRunWhere(normalizedQuery);
    const rows = await queryRows<ObserverEvalRunRow>(this.pool, `
      SELECT *
      FROM observer_eval_sidecar_runs
      ${where.clause}
      ORDER BY started_at_ms DESC, run_id DESC
      LIMIT ${normalizedQuery.limit}
    `, where.values);
    return rows.map(mapRunRow);
  }

  async recordObservation(
    input: ObserverEvalSidecarObservationInput,
  ): Promise<ObserverEvalSidecarObservationRecord> {
    const observation = normalizeObservationRecord(input, this.nowMs());
    await this.ready;
    await executeQuery(this.pool, `
      INSERT INTO observer_eval_sidecar_observations (
        observation_id, run_id, schema_version, eval_owner, authoritative,
        turn_id, captured_at_ms, observed_at_ms, status, privacy_class,
        sensitivity, channel_visibility, redaction_reason, raw_content_redacted,
        sensitive_identifiers_redacted, derived_telemetry_permitted,
        psfn_emotion_snapshot_ref, psfn_emotion_snapshot_json, observer_input_json,
        projected_appraisal_json, emosim_output_json, crosswalk_json,
        comparison_metrics_json, divergence_score, error_json, degraded_state_json,
        metadata_json, retention_json, retain_until_ms, created_at_ms
      )
      VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10,
        $11, $12, $13, $14,
        $15, $16,
        $17, $18::jsonb, $19::jsonb,
        $20::jsonb, $21::jsonb, $22::jsonb,
        $23::jsonb, $24, $25::jsonb, $26::jsonb,
        $27::jsonb, $28::jsonb, $29, $30
      )
      ON CONFLICT (observation_id) DO UPDATE SET
        run_id = excluded.run_id,
        turn_id = excluded.turn_id,
        captured_at_ms = excluded.captured_at_ms,
        observed_at_ms = excluded.observed_at_ms,
        status = excluded.status,
        privacy_class = excluded.privacy_class,
        sensitivity = excluded.sensitivity,
        channel_visibility = excluded.channel_visibility,
        redaction_reason = excluded.redaction_reason,
        raw_content_redacted = excluded.raw_content_redacted,
        sensitive_identifiers_redacted = excluded.sensitive_identifiers_redacted,
        derived_telemetry_permitted = excluded.derived_telemetry_permitted,
        psfn_emotion_snapshot_ref = excluded.psfn_emotion_snapshot_ref,
        psfn_emotion_snapshot_json = excluded.psfn_emotion_snapshot_json,
        observer_input_json = excluded.observer_input_json,
        projected_appraisal_json = excluded.projected_appraisal_json,
        emosim_output_json = excluded.emosim_output_json,
        crosswalk_json = excluded.crosswalk_json,
        comparison_metrics_json = excluded.comparison_metrics_json,
        divergence_score = excluded.divergence_score,
        error_json = excluded.error_json,
        degraded_state_json = excluded.degraded_state_json,
        metadata_json = excluded.metadata_json,
        retention_json = excluded.retention_json,
        retain_until_ms = excluded.retain_until_ms
    `, [
      observation.observationId,
      observation.runId,
      observation.schemaVersion,
      observation.evalOwner,
      observation.authoritative,
      observation.turnId,
      observation.capturedAtMs,
      observation.observedAtMs,
      observation.status,
      observation.privacy.privacyClass,
      observation.privacy.sensitivity,
      observation.privacy.channelVisibility,
      observation.privacy.redactionReason,
      observation.privacy.rawContentRedacted,
      observation.privacy.sensitiveIdentifiersRedacted,
      observation.privacy.derivedTelemetryPermitted,
      observation.psfnEmotion.snapshotRef ?? null,
      JSON.stringify(observation.psfnEmotion.snapshot),
      JSON.stringify(observation.sanitizedInput),
      JSON.stringify(observation.projection ?? null),
      JSON.stringify(observation.emosim ?? null),
      JSON.stringify(observation.crosswalk ?? null),
      JSON.stringify(observation.comparisonMetrics),
      observation.comparisonMetrics.divergenceScore,
      JSON.stringify(observation.error ?? null),
      JSON.stringify(observation.degradedState ?? null),
      JSON.stringify(observation.metadata),
      JSON.stringify(observation.retention),
      observation.retention.retainUntilMs,
      observation.createdAtMs,
    ]);
    return observation;
  }

  async getObservation(observationId: string): Promise<ObserverEvalSidecarObservationRecord | null> {
    await this.ready;
    const row = await queryOne<ObserverEvalObservationRow>(this.pool, `
      SELECT *
      FROM observer_eval_sidecar_observations
      WHERE observation_id = $1
    `, [normalizeNonEmptyText(observationId, 'observationId')]);
    return row ? mapObservationRow(row) : null;
  }

  async getLatestObservation(
    query: Omit<ObserverEvalSidecarObservationQuery, 'limit'> = {},
  ): Promise<ObserverEvalSidecarObservationRecord | null> {
    const rows = await this.queryObservations({ ...query, limit: 1 });
    return rows[0] ?? null;
  }

  async queryObservations(
    query: ObserverEvalSidecarObservationQuery = {},
  ): Promise<ObserverEvalSidecarObservationRecord[]> {
    await this.ready;
    const normalizedQuery = normalizeObservationQuery(query);
    const where = buildObservationWhere(normalizedQuery);
    const rows = await queryRows<ObserverEvalObservationRow>(this.pool, `
      SELECT o.*
      FROM observer_eval_sidecar_observations o
      JOIN observer_eval_sidecar_runs r ON r.run_id = o.run_id
      ${where.clause}
      ORDER BY o.observed_at_ms DESC, o.observation_id DESC
      LIMIT ${normalizedQuery.limit}
    `, where.values);
    return rows.map(mapObservationRow);
  }

  async pruneExpiredRetention(nowMs: number): Promise<ObserverEvalSidecarPruneResult> {
    const prunedAtMs = normalizeEpochMs(nowMs, 'nowMs');
    await this.ready;
    const observationRows = await queryRows<ReturnedObservationIdRow>(this.pool, `
      DELETE FROM observer_eval_sidecar_observations
      WHERE retain_until_ms <= $1
      RETURNING observation_id
    `, [prunedAtMs]);
    const runRows = await queryRows<ReturnedRunIdRow>(this.pool, `
      DELETE FROM observer_eval_sidecar_runs r
      WHERE r.retain_until_ms <= $1
        AND NOT EXISTS (
          SELECT 1
          FROM observer_eval_sidecar_observations o
          WHERE o.run_id = r.run_id
        )
      RETURNING run_id
    `, [prunedAtMs]);
    return {
      prunedAtMs,
      prunedObservationIds: observationRows.map(row => row.observation_id),
      prunedRunIds: runRows.map(row => row.run_id),
    };
  }
}

export function createPostgresObserverEvalSidecarStore(
  databaseUrl: string,
  options: StoreOptions = {},
): PostgresObserverEvalSidecarStore {
  return PostgresObserverEvalSidecarStore.connect(databaseUrl, options);
}

export function createObserverEvalComparisonMetrics(
  crosswalk: ObserverEmotionCrosswalkOutput | undefined,
  details?: Record<string, unknown>,
): ObserverEvalSidecarComparisonMetrics {
  const comparison = crosswalk?.derived.comparison;
  return {
    schemaVersion: OBSERVER_EVAL_SIDECAR_PERSISTENCE_SCHEMA_VERSION,
    metricsVersion: OBSERVER_EVAL_COMPARISON_METRICS_VERSION,
    divergenceScore: comparison?.valenceArousal.delta.euclideanDistance ?? null,
    vadDistance: comparison?.valenceArousal.delta.euclideanDistance ?? null,
    familyMismatch: comparison?.labels.familyMismatch ?? null,
    directionMismatch: comparison?.intensity.directionMismatch ?? null,
    unmappedSignal: comparison?.unknowns.unmappedIntensity ?? null,
    ...(details ? { details: cloneRecord(details) } : {}),
  };
}

function normalizeRunRecord(
  input: ObserverEvalSidecarRunInput,
  nowMs: number,
): ObserverEvalSidecarRunRecord {
  const startedAtMs = normalizeEpochMs(input.startedAtMs, 'startedAtMs');
  const completedAtMs = input.completedAtMs === undefined
    ? undefined
    : normalizeEpochMs(input.completedAtMs, 'completedAtMs');
  if (completedAtMs !== undefined && completedAtMs < startedAtMs) {
    throw new RangeError('completedAtMs must be >= startedAtMs');
  }
  const retention = normalizeRetention(input.retention);
  if (retention.retainUntilMs < startedAtMs) {
    throw new RangeError('run retention retainUntilMs must be >= startedAtMs');
  }
  const createdAtMs = normalizeEpochMs(nowMs, 'nowMs');
  return {
    schemaVersion: OBSERVER_EVAL_SIDECAR_PERSISTENCE_SCHEMA_VERSION,
    evalOwner: OBSERVER_EVAL_SIDECAR_EVAL_OWNER,
    authoritative: false,
    runId: normalizeNonEmptyText(input.runId, 'runId'),
    sidecarId: normalizeNonEmptyText(input.sidecarId, 'sidecarId'),
    deployment: normalizeDeployment(input.deployment),
    ...(optionalText(input.evalSessionId) ? { evalSessionId: optionalText(input.evalSessionId) } : {}),
    ...(optionalText(input.scenarioId) ? { scenarioId: optionalText(input.scenarioId) } : {}),
    ...(optionalText(input.testRunId) ? { testRunId: optionalText(input.testRunId) } : {}),
    status: normalizeRunStatus(input.status ?? 'running'),
    startedAtMs,
    ...(completedAtMs !== undefined ? { completedAtMs } : {}),
    metadata: cloneRecord(input.metadata),
    retention,
    createdAtMs,
    updatedAtMs: createdAtMs,
    nonAuthoritativeNotice: OBSERVER_EVAL_SIDECAR_NON_AUTHORITATIVE_NOTICE,
  };
}

function normalizeObservationRecord(
  input: ObserverEvalSidecarObservationInput,
  nowMs: number,
): ObserverEvalSidecarObservationRecord {
  const sanitizedInput = structuredClone(input.sanitizedInput);
  const capturedAtMs = normalizeEpochMs(sanitizedInput.provenance.capturedAt, 'sanitizedInput.provenance.capturedAt');
  const observedAtMs = normalizeEpochMs(input.observedAtMs ?? capturedAtMs, 'observedAtMs');
  const retention = normalizeRetention(input.retention);
  if (retention.retainUntilMs < observedAtMs) {
    throw new RangeError('observation retention retainUntilMs must be >= observedAtMs');
  }
  const psfnEmotion = normalizePsfnEmotion(input.psfnEmotion, sanitizedInput);
  const comparisonMetrics = input.comparisonMetrics
    ? normalizeComparisonMetrics(input.comparisonMetrics)
    : createObserverEvalComparisonMetrics(input.crosswalk);
  const createdAtMs = normalizeEpochMs(nowMs, 'nowMs');
  return {
    schemaVersion: OBSERVER_EVAL_SIDECAR_PERSISTENCE_SCHEMA_VERSION,
    evalOwner: OBSERVER_EVAL_SIDECAR_EVAL_OWNER,
    authoritative: false,
    observationId: normalizeNonEmptyText(input.observationId, 'observationId'),
    runId: normalizeNonEmptyText(input.runId, 'runId'),
    sanitizedInput,
    turnId: normalizeNonEmptyText(sanitizedInput.turn.turnId, 'sanitizedInput.turn.turnId'),
    capturedAtMs,
    observedAtMs,
    status: normalizeObservationStatus(input.status ?? statusFromObservation(input)),
    privacy: structuredClone(sanitizedInput.privacy),
    psfnEmotion,
    ...(input.projection ? { projection: structuredClone(input.projection) } : {}),
    ...(input.emosim ? { emosim: structuredClone(input.emosim) } : {}),
    ...(input.crosswalk ? { crosswalk: structuredClone(input.crosswalk) } : {}),
    comparisonMetrics,
    ...(input.error ? { error: structuredClone(input.error) } : {}),
    ...(input.degradedState ? { degradedState: structuredClone(input.degradedState) } : {}),
    metadata: cloneRecord(input.metadata),
    retention,
    createdAtMs,
    nonAuthoritativeNotice: OBSERVER_EVAL_SIDECAR_NON_AUTHORITATIVE_NOTICE,
  };
}

function statusFromObservation(input: ObserverEvalSidecarObservationInput): ObserverEvalSidecarObservationStatus {
  if (input.error) return 'error';
  if (input.degradedState) return 'degraded';
  return 'ok';
}

function normalizePsfnEmotion(
  input: ObserverEvalPsfnEmotionReference | undefined,
  sanitizedInput: ObserverEvalSanitizedInputPayload,
): ObserverEvalPsfnEmotionReference {
  if (input) {
    return {
      snapshot: structuredClone(input.snapshot),
      ...(optionalText(input.snapshotRef) ? { snapshotRef: optionalText(input.snapshotRef) } : {}),
      appraisalEntryCount: nonNegativeInteger(input.appraisalEntryCount, 'psfnEmotion.appraisalEntryCount'),
      snapshotSource: input.snapshotSource,
    };
  }
  return {
    snapshot: structuredClone(sanitizedInput.emotion.snapshot),
    appraisalEntryCount: nonNegativeInteger(
      sanitizedInput.emotion.appraisalEntryCount,
      'sanitizedInput.emotion.appraisalEntryCount',
    ),
    snapshotSource: sanitizedInput.provenance.emotionSnapshotSource,
  };
}

function normalizeComparisonMetrics(
  input: ObserverEvalSidecarComparisonMetrics,
): ObserverEvalSidecarComparisonMetrics {
  const divergenceScore = normalizeNullableFinite(input.divergenceScore, 'comparisonMetrics.divergenceScore');
  if (divergenceScore !== null && divergenceScore < 0) {
    throw new RangeError('comparisonMetrics.divergenceScore must be >= 0 when present');
  }
  return {
    schemaVersion: expectSchemaVersion(input.schemaVersion, 'comparisonMetrics.schemaVersion'),
    metricsVersion: input.metricsVersion,
    divergenceScore,
    vadDistance: normalizeNullableFinite(input.vadDistance, 'comparisonMetrics.vadDistance'),
    familyMismatch: normalizeNullableBoolean(input.familyMismatch),
    directionMismatch: normalizeNullableBoolean(input.directionMismatch),
    unmappedSignal: normalizeNullableFinite(input.unmappedSignal, 'comparisonMetrics.unmappedSignal'),
    ...(input.details ? { details: cloneRecord(input.details) } : {}),
  };
}

function normalizeRetention(input: ObserverEvalSidecarRetentionMetadata): ObserverEvalSidecarRetentionMetadata {
  const retentionClass = normalizeRetentionClass(input.retentionClass);
  const capturedAtMs = normalizeEpochMs(input.capturedAtMs, 'retention.capturedAtMs');
  const retainUntilMs = normalizeEpochMs(input.retainUntilMs, 'retention.retainUntilMs');
  if (retainUntilMs < capturedAtMs) {
    throw new RangeError('retention.retainUntilMs must be >= retention.capturedAtMs');
  }
  return {
    retentionClass,
    policyId: normalizeNonEmptyText(input.policyId, 'retention.policyId'),
    capturedAtMs,
    retainUntilMs,
    reason: normalizeNonEmptyText(input.reason, 'retention.reason'),
    ...(input.deleteAfterMs !== undefined
      ? { deleteAfterMs: normalizeEpochMs(input.deleteAfterMs, 'retention.deleteAfterMs') }
      : {}),
    ...(input.tags ? { tags: input.tags.map(tag => normalizeNonEmptyText(tag, 'retention.tags')) } : {}),
    ...(input.metadata ? { metadata: cloneRecord(input.metadata) } : {}),
  };
}

function mapRunRow(row: ObserverEvalRunRow): ObserverEvalSidecarRunRecord {
  assertNonAuthoritativeRow(row.schema_version, row.eval_owner, row.authoritative, 'observer_eval_sidecar_runs');
  const retention = normalizeRetention(
    parseRequiredRecord(row.retention_json, 'observer_eval_sidecar_runs.retention_json') as unknown as ObserverEvalSidecarRetentionMetadata,
  );
  const completedAtMs = row.completed_at_ms === null
    ? undefined
    : normalizeEpochMs(row.completed_at_ms, 'completed_at_ms');
  return {
    schemaVersion: OBSERVER_EVAL_SIDECAR_PERSISTENCE_SCHEMA_VERSION,
    evalOwner: OBSERVER_EVAL_SIDECAR_EVAL_OWNER,
    authoritative: false,
    runId: row.run_id,
    sidecarId: row.sidecar_id,
    deployment: normalizeDeployment(row.deployment),
    ...(row.eval_session_id ? { evalSessionId: row.eval_session_id } : {}),
    ...(row.scenario_id ? { scenarioId: row.scenario_id } : {}),
    ...(row.test_run_id ? { testRunId: row.test_run_id } : {}),
    status: normalizeRunStatus(row.status),
    startedAtMs: normalizeEpochMs(row.started_at_ms, 'started_at_ms'),
    ...(completedAtMs !== undefined ? { completedAtMs } : {}),
    metadata: parseRequiredRecord(row.metadata_json, 'observer_eval_sidecar_runs.metadata_json'),
    retention,
    createdAtMs: normalizeEpochMs(row.created_at_ms, 'created_at_ms'),
    updatedAtMs: normalizeEpochMs(row.updated_at_ms, 'updated_at_ms'),
    nonAuthoritativeNotice: OBSERVER_EVAL_SIDECAR_NON_AUTHORITATIVE_NOTICE,
  };
}

function mapObservationRow(row: ObserverEvalObservationRow): ObserverEvalSidecarObservationRecord {
  assertNonAuthoritativeRow(row.schema_version, row.eval_owner, row.authoritative, 'observer_eval_sidecar_observations');
  const sanitizedInput = parseRequiredRecord(
    row.observer_input_json,
    'observer_eval_sidecar_observations.observer_input_json',
  ) as unknown as ObserverEvalSanitizedInputPayload;
  const retention = normalizeRetention(
    parseRequiredRecord(row.retention_json, 'observer_eval_sidecar_observations.retention_json') as unknown as ObserverEvalSidecarRetentionMetadata,
  );
  const snapshot = parseOptionalJson(row.psfn_emotion_snapshot_json) as EmotionStateSnapshot | null | undefined;
  const psfnEmotion: ObserverEvalPsfnEmotionReference = {
    snapshot: snapshot ?? null,
    ...(row.psfn_emotion_snapshot_ref ? { snapshotRef: row.psfn_emotion_snapshot_ref } : {}),
    appraisalEntryCount: nonNegativeInteger(sanitizedInput.emotion.appraisalEntryCount, 'observer_input_json.emotion.appraisalEntryCount'),
    snapshotSource: sanitizedInput.provenance.emotionSnapshotSource,
  };
  const privacy: ObserverEvalPrivacyDecision = {
    privacyClass: row.privacy_class,
    sensitivity: row.sensitivity,
    channelVisibility: row.channel_visibility,
    rawContentRedacted: row.raw_content_redacted,
    sensitiveIdentifiersRedacted: row.sensitive_identifiers_redacted,
    derivedTelemetryPermitted: row.derived_telemetry_permitted,
    redactionReason: row.redaction_reason,
  };
  const projection = parseOptionalJson(row.projected_appraisal_json) as ObserverAppraisalProjectionResult | undefined;
  const emosim = parseOptionalJson(row.emosim_output_json) as EmoSimAdapterRunResult | undefined;
  const crosswalk = parseOptionalJson(row.crosswalk_json) as ObserverEmotionCrosswalkOutput | undefined;
  const error = parseOptionalJson(row.error_json) as ObserverEvalSidecarErrorState | undefined;
  const degradedState = parseOptionalJson(row.degraded_state_json) as ObserverEvalSanitizedLifecycleStatePayload | undefined;
  return {
    schemaVersion: OBSERVER_EVAL_SIDECAR_PERSISTENCE_SCHEMA_VERSION,
    evalOwner: OBSERVER_EVAL_SIDECAR_EVAL_OWNER,
    authoritative: false,
    observationId: row.observation_id,
    runId: row.run_id,
    sanitizedInput,
    turnId: row.turn_id,
    capturedAtMs: normalizeEpochMs(row.captured_at_ms, 'captured_at_ms'),
    observedAtMs: normalizeEpochMs(row.observed_at_ms, 'observed_at_ms'),
    status: normalizeObservationStatus(row.status),
    privacy,
    psfnEmotion,
    ...(projection ? { projection } : {}),
    ...(emosim ? { emosim } : {}),
    ...(crosswalk ? { crosswalk } : {}),
    comparisonMetrics: normalizeComparisonMetrics(
      parseRequiredRecord(
        row.comparison_metrics_json,
        'observer_eval_sidecar_observations.comparison_metrics_json',
      ) as unknown as ObserverEvalSidecarComparisonMetrics,
    ),
    ...(error ? { error } : {}),
    ...(degradedState ? { degradedState } : {}),
    metadata: parseRequiredRecord(row.metadata_json, 'observer_eval_sidecar_observations.metadata_json'),
    retention,
    createdAtMs: normalizeEpochMs(row.created_at_ms, 'created_at_ms'),
    nonAuthoritativeNotice: OBSERVER_EVAL_SIDECAR_NON_AUTHORITATIVE_NOTICE,
  };
}

function normalizeRunQuery(query: ObserverEvalSidecarRunQuery): Required<Pick<ObserverEvalSidecarRunQuery, 'limit'>> & ObserverEvalSidecarRunQuery {
  return {
    ...query,
    limit: normalizeLimit(query.limit),
    ...(query.sinceMs !== undefined ? { sinceMs: normalizeEpochMs(query.sinceMs, 'query.sinceMs') } : {}),
    ...(query.untilMs !== undefined ? { untilMs: normalizeEpochMs(query.untilMs, 'query.untilMs') } : {}),
  };
}

function normalizeObservationQuery(
  query: ObserverEvalSidecarObservationQuery,
): Required<Pick<ObserverEvalSidecarObservationQuery, 'limit'>> & ObserverEvalSidecarObservationQuery {
  return {
    ...query,
    limit: normalizeLimit(query.limit),
    ...(query.sinceMs !== undefined ? { sinceMs: normalizeEpochMs(query.sinceMs, 'query.sinceMs') } : {}),
    ...(query.untilMs !== undefined ? { untilMs: normalizeEpochMs(query.untilMs, 'query.untilMs') } : {}),
    ...(query.minDivergenceScore !== undefined
      ? { minDivergenceScore: normalizeNonNegativeFinite(query.minDivergenceScore, 'query.minDivergenceScore') }
      : {}),
  };
}

function buildRunWhere(query: ObserverEvalSidecarRunQuery): SqlWhere {
  const clauses: string[] = [];
  const values: unknown[] = [];
  pushWhere(clauses, values, 'eval_session_id =', query.evalSessionId);
  pushWhere(clauses, values, 'scenario_id =', query.scenarioId);
  pushWhere(clauses, values, 'test_run_id =', query.testRunId);
  pushWhere(clauses, values, 'status =', query.status);
  pushWhere(clauses, values, 'started_at_ms >=', query.sinceMs);
  pushWhere(clauses, values, 'started_at_ms <=', query.untilMs);
  return {
    clause: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    values,
  };
}

function buildObservationWhere(query: ObserverEvalSidecarObservationQuery): SqlWhere {
  const clauses: string[] = [];
  const values: unknown[] = [];
  pushWhere(clauses, values, 'o.run_id =', query.runId);
  pushWhere(clauses, values, 'r.eval_session_id =', query.evalSessionId);
  pushWhere(clauses, values, 'r.scenario_id =', query.scenarioId);
  pushWhere(clauses, values, 'r.test_run_id =', query.testRunId);
  pushWhere(clauses, values, 'o.turn_id =', query.turnId);
  pushWhere(clauses, values, 'o.privacy_class =', query.privacyClass);
  pushWhere(clauses, values, 'o.status =', query.status);
  pushWhere(clauses, values, 'o.observed_at_ms >=', query.sinceMs);
  pushWhere(clauses, values, 'o.observed_at_ms <=', query.untilMs);
  if (query.minDivergenceScore !== undefined) {
    values.push(query.minDivergenceScore);
    clauses.push(`o.divergence_score IS NOT NULL AND o.divergence_score >= $${values.length}`);
  }
  return {
    clause: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    values,
  };
}

function pushWhere(
  clauses: string[],
  values: unknown[],
  columnAndOperator: string,
  value: unknown,
): void {
  if (value === undefined) return;
  values.push(value);
  clauses.push(`${columnAndOperator} $${values.length}`);
}

function assertNonAuthoritativeRow(
  schemaVersion: number | string,
  evalOwner: string,
  authoritative: boolean,
  table: string,
): void {
  expectSchemaVersion(schemaVersion, `${table}.schema_version`);
  if (evalOwner !== OBSERVER_EVAL_SIDECAR_EVAL_OWNER) {
    throw new Error(`${table} row is not owned by ${OBSERVER_EVAL_SIDECAR_EVAL_OWNER}`);
  }
  if (authoritative !== false) {
    throw new Error(`${table} row violated observer sidecar non-authoritative boundary`);
  }
}

function expectSchemaVersion(value: number | string, field: string): typeof OBSERVER_EVAL_SIDECAR_PERSISTENCE_SCHEMA_VERSION {
  const version = Number(value);
  if (version !== OBSERVER_EVAL_SIDECAR_PERSISTENCE_SCHEMA_VERSION) {
    throw new Error(`${field} must be ${OBSERVER_EVAL_SIDECAR_PERSISTENCE_SCHEMA_VERSION}`);
  }
  return OBSERVER_EVAL_SIDECAR_PERSISTENCE_SCHEMA_VERSION;
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_QUERY_LIMIT;
  if (!Number.isFinite(limit) || limit < 1) return DEFAULT_QUERY_LIMIT;
  return Math.min(MAX_QUERY_LIMIT, Math.floor(limit));
}

function normalizeDeployment(value: string): NonNullable<ObserverEvalSidecarConfig['deployment']> {
  if (value === 'live' || value === 'eval' || value === 'test') return value;
  throw new Error(`deployment is invalid: ${String(value)}`);
}

function normalizeRunStatus(value: string): ObserverEvalSidecarRunStatus {
  if (value === 'running' || value === 'completed' || value === 'degraded' || value === 'failed') {
    return value;
  }
  throw new Error(`run status is invalid: ${value}`);
}

function normalizeObservationStatus(value: string): ObserverEvalSidecarObservationStatus {
  if (value === 'ok' || value === 'degraded' || value === 'error') return value;
  throw new Error(`observation status is invalid: ${value}`);
}

function normalizeRetentionClass(value: string): ObserverEvalRetentionClass {
  if ((OBSERVER_EVAL_RETENTION_CLASSES as readonly string[]).includes(value)) {
    return value as ObserverEvalRetentionClass;
  }
  throw new Error(`retentionClass is invalid: ${value}`);
}

function normalizeNonEmptyText(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${field} must be a string`);
  }
  const text = value.trim();
  if (text.length === 0) {
    throw new Error(`${field} must not be empty`);
  }
  return text;
}

function optionalText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text.length > 0 ? text : undefined;
}

function normalizeEpochMs(value: unknown, field: string): number {
  const numeric = typeof value === 'number'
    ? value
    : (typeof value === 'string' && value.trim().length > 0 ? Number(value) : NaN);
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw new RangeError(`${field} must be a finite non-negative timestamp in milliseconds`);
  }
  return Math.floor(numeric);
}

function nonNegativeInteger(value: unknown, field: string): number {
  const numeric = normalizeEpochMs(value, field);
  return Math.floor(numeric);
}

function normalizeNonNegativeFinite(value: unknown, field: string): number {
  const numeric = typeof value === 'number'
    ? value
    : (typeof value === 'string' && value.trim().length > 0 ? Number(value) : NaN);
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw new RangeError(`${field} must be a finite number >= 0`);
  }
  return numeric;
}

function normalizeNullableFinite(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  const numeric = normalizeNonNegativeFinite(value, field);
  return numeric;
}

function normalizeNullableBoolean(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'boolean') {
    throw new Error('nullable boolean field must be boolean or null');
  }
  return value;
}

function cloneRecord(value: Record<string, unknown> | undefined): Record<string, unknown> {
  return structuredClone(value ?? {});
}

function parseRequiredRecord(value: unknown, field: string): Record<string, unknown> {
  const parsed = parseJson(value);
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  throw new Error(`${field} must be a JSON object`);
}

function parseOptionalJson(value: unknown): unknown | undefined {
  if (value === null || value === undefined) return undefined;
  return parseJson(value);
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return structuredClone(value);
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`Invalid persisted observer sidecar JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}
