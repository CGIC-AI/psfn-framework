import type { Pool, QueryResultRow } from 'pg';

import type {
  BackgroundWorkEnqueueResult,
  BackgroundWorkStorePort,
} from '../../core/agent/background-work/store-port.js';
import {
  BACKGROUND_WORK_REASON_CODES,
  BACKGROUND_WORK_STATES,
  createBackgroundWorkIdentity,
  fingerprintBackgroundWorkPayload,
  parseBackgroundWorkPayload,
  type BackgroundWorkReasonCode,
  type BackgroundWorkState,
  type ClaimedBackgroundWorkJob,
  type EnqueueBackgroundWorkInput,
  type StoredBackgroundWorkJob,
} from '../../core/agent/background-work/types.js';
import {
  createPostgresPool,
  queryOne,
  queryRows,
  runPostgresMigrations,
  withPostgresClient,
} from '../postgres.js';
import { POSTGRES_BACKGROUND_WORK_MIGRATIONS } from './migrations.js';

interface BackgroundWorkRow extends QueryResultRow {
  job_id: string;
  idempotency_key: string;
  logical_session_id: string;
  kind: string;
  payload_schema_version: number | string;
  payload: unknown;
  payload_fingerprint: string;
  source_turn_id: string;
  source_request_id: string;
  source_channel_id: string;
  state: string;
  reason_code: string;
  attempt_count: number | string;
  max_attempts: number | string;
  created_at_ms: number | string;
  available_at_ms: number | string;
  updated_at_ms: number | string;
  lease_owner: string | null;
  lease_expires_at_ms: number | string | null;
  completed_at_ms: number | string | null;
  revision: number | string;
}

const JOB_COLUMN_NAMES = [
  'job_id',
  'idempotency_key',
  'logical_session_id',
  'kind',
  'payload_schema_version',
  'payload',
  'payload_fingerprint',
  'source_turn_id',
  'source_request_id',
  'source_channel_id',
  'state',
  'reason_code',
  'attempt_count',
  'max_attempts',
  'created_at_ms',
  'available_at_ms',
  'updated_at_ms',
  'lease_owner',
  'lease_expires_at_ms',
  'completed_at_ms',
  'revision',
] as const;
const JOB_COLUMNS = JOB_COLUMN_NAMES.join(', ');

function qualifiedJobColumns(alias: string): string {
  return JOB_COLUMN_NAMES.map(column => `${alias}.${column}`).join(', ');
}
const VALID_STATES = new Set<string>(BACKGROUND_WORK_STATES);
const VALID_REASON_CODES = new Set<string>(BACKGROUND_WORK_REASON_CODES);
const MAX_TEXT_LENGTH = 2_048;
const MAX_FINGERPRINT_LENGTH = 128;
const MAX_PURGE_LIMIT = 10_000;

function requireText(value: unknown, field: string, maxLength = MAX_TEXT_LENGTH): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Background work ${field} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new Error(`Background work ${field} must be ${maxLength} characters or fewer`);
  }
  return normalized;
}

function safeInteger(value: unknown, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Background work ${field} must be a non-negative safe integer`);
  }
  return parsed;
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = safeInteger(value, field);
  if (parsed < 1) throw new Error(`Background work ${field} must be positive`);
  return parsed;
}

function parseState(value: string): BackgroundWorkState {
  if (!VALID_STATES.has(value)) throw new Error(`Unknown background work state: ${value}`);
  return value as BackgroundWorkState;
}

function parseReasonCode(value: string): BackgroundWorkReasonCode {
  if (!VALID_REASON_CODES.has(value)) {
    throw new Error(`Unknown background work reason code: ${value}`);
  }
  return value as BackgroundWorkReasonCode;
}

function mapRow(row: BackgroundWorkRow): StoredBackgroundWorkJob {
  const state = parseState(row.state);
  const leaseOwner = row.lease_owner === null
    ? undefined
    : requireText(row.lease_owner, 'leaseOwner');
  const leaseExpiresAtMs = row.lease_expires_at_ms === null
    ? undefined
    : safeInteger(row.lease_expires_at_ms, 'leaseExpiresAtMs');
  const completedAtMs = row.completed_at_ms === null
    ? undefined
    : safeInteger(row.completed_at_ms, 'completedAtMs');
  if (state === 'running' && (!leaseOwner || leaseExpiresAtMs === undefined)) {
    throw new Error(`Running background job ${row.job_id} is missing its lease`);
  }
  if (state !== 'running' && (leaseOwner || leaseExpiresAtMs !== undefined)) {
    throw new Error(`Non-running background job ${row.job_id} carries a lease`);
  }
  return {
    jobId: requireText(row.job_id, 'jobId'),
    idempotencyKey: requireText(row.idempotency_key, 'idempotencyKey'),
    logicalSessionId: requireText(row.logical_session_id, 'logicalSessionId'),
    kind: requireText(row.kind, 'kind'),
    payloadSchemaVersion: positiveInteger(row.payload_schema_version, 'payloadSchemaVersion'),
    payload: row.payload,
    payloadFingerprint: requireText(
      row.payload_fingerprint,
      'payloadFingerprint',
      MAX_FINGERPRINT_LENGTH,
    ),
    sourceTurnId: requireText(row.source_turn_id, 'sourceTurnId'),
    sourceRequestId: requireText(row.source_request_id, 'sourceRequestId'),
    sourceChannelId: requireText(row.source_channel_id, 'sourceChannelId'),
    state,
    reasonCode: parseReasonCode(row.reason_code),
    attemptCount: safeInteger(row.attempt_count, 'attemptCount'),
    maxAttempts: positiveInteger(row.max_attempts, 'maxAttempts'),
    createdAtMs: safeInteger(row.created_at_ms, 'createdAtMs'),
    availableAtMs: safeInteger(row.available_at_ms, 'availableAtMs'),
    updatedAtMs: safeInteger(row.updated_at_ms, 'updatedAtMs'),
    ...(leaseOwner ? { leaseOwner } : {}),
    ...(leaseExpiresAtMs !== undefined ? { leaseExpiresAtMs } : {}),
    ...(completedAtMs !== undefined ? { completedAtMs } : {}),
    revision: positiveInteger(row.revision, 'revision'),
  };
}

function mapClaimedRow(row: BackgroundWorkRow): ClaimedBackgroundWorkJob {
  const mapped = mapRow(row);
  if (mapped.state !== 'running' || !mapped.leaseOwner || mapped.leaseExpiresAtMs === undefined) {
    throw new Error(`Claimed background job ${mapped.jobId} is not running`);
  }
  return {
    ...mapped,
    state: 'running',
    leaseOwner: mapped.leaseOwner,
    leaseExpiresAtMs: mapped.leaseExpiresAtMs,
  };
}

function validateEnqueueInput(input: EnqueueBackgroundWorkInput): EnqueueBackgroundWorkInput {
  const createdAtMs = safeInteger(input.createdAtMs, 'createdAtMs');
  const payload = parseBackgroundWorkPayload(input.kind, input.payload);
  const expectedIdentity = createBackgroundWorkIdentity({
    logicalSessionId: input.logicalSessionId,
    turnId: input.sourceTurnId,
    kind: input.kind,
  });
  if (input.jobId !== expectedIdentity.jobId || input.idempotencyKey !== expectedIdentity.idempotencyKey) {
    throw new Error('Background work identity does not match its session/turn/kind binding');
  }
  if (payload.source.logicalSessionId !== input.logicalSessionId
    || payload.source.turnId !== input.sourceTurnId
    || payload.source.requestId !== input.sourceRequestId
    || payload.source.channelId !== input.sourceChannelId
    || payload.source.createdAtMs !== createdAtMs) {
    throw new Error('Background work metadata does not match its payload source binding');
  }
  const expectedPayloadFingerprint = fingerprintBackgroundWorkPayload(payload);
  if (input.payloadFingerprint !== expectedPayloadFingerprint) {
    throw new Error('Background work payload fingerprint mismatch');
  }
  return {
    ...input,
    jobId: requireText(input.jobId, 'jobId'),
    idempotencyKey: requireText(input.idempotencyKey, 'idempotencyKey'),
    logicalSessionId: requireText(input.logicalSessionId, 'logicalSessionId'),
    payload,
    payloadFingerprint: requireText(expectedPayloadFingerprint, 'payloadFingerprint', MAX_FINGERPRINT_LENGTH),
    sourceTurnId: requireText(input.sourceTurnId, 'sourceTurnId'),
    sourceRequestId: requireText(input.sourceRequestId, 'sourceRequestId'),
    sourceChannelId: requireText(input.sourceChannelId, 'sourceChannelId'),
    createdAtMs,
    maxAttempts: positiveInteger(input.maxAttempts, 'maxAttempts'),
  };
}

function assertIdempotentReplay(
  incumbent: StoredBackgroundWorkJob,
  input: EnqueueBackgroundWorkInput,
): void {
  if (incumbent.jobId !== input.jobId
    || incumbent.logicalSessionId !== input.logicalSessionId
    || incumbent.kind !== input.kind
    || incumbent.payloadSchemaVersion !== input.payload.schemaVersion
    || incumbent.payloadFingerprint !== input.payloadFingerprint
    || incumbent.sourceTurnId !== input.sourceTurnId
    || incumbent.sourceRequestId !== input.sourceRequestId
    || incumbent.sourceChannelId !== input.sourceChannelId
    || incumbent.createdAtMs !== input.createdAtMs
    || incumbent.maxAttempts !== input.maxAttempts) {
    throw new Error(`Background work idempotency key reuse mismatch: ${input.idempotencyKey}`);
  }
}

function requireTransitionRow(
  row: BackgroundWorkRow | undefined,
  jobId: string,
): StoredBackgroundWorkJob {
  if (!row) throw new Error(`Background work transition conflict for ${jobId}`);
  return mapRow(row);
}

export class PostgresBackgroundWorkStore implements BackgroundWorkStorePort {
  private closePromise: Promise<void> | null = null;

  private constructor(private readonly pool: Pool) {}

  static async connect(
    databaseUrl: string,
    options: { schema?: string } = {},
  ): Promise<PostgresBackgroundWorkStore> {
    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-background-work',
      allowExitOnIdle: true,
      max: 8,
      schema: options.schema,
    });
    try {
      await runPostgresMigrations(pool, POSTGRES_BACKGROUND_WORK_MIGRATIONS, options);
      return new PostgresBackgroundWorkStore(pool);
    } catch (error) {
      await pool.end().catch(() => undefined);
      throw error;
    }
  }

  async enqueue(inputValue: EnqueueBackgroundWorkInput): Promise<BackgroundWorkEnqueueResult> {
    const input = validateEnqueueInput(inputValue);
    return withPostgresClient(this.pool, async (client) => {
      // Serialize enqueue/supersession decisions per logical session so two
      // replicas cannot both leave competing auto-compaction jobs runnable.
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`background-work:${input.logicalSessionId}`],
      );
      const insertedResult = await client.query<BackgroundWorkRow>(`
        INSERT INTO agent_background_work_jobs (
          job_id, idempotency_key, logical_session_id, kind, payload_schema_version,
          payload, payload_fingerprint, source_turn_id, source_request_id, source_channel_id,
          state, reason_code, attempt_count, max_attempts, created_at_ms, available_at_ms,
          updated_at_ms, lease_owner, lease_expires_at_ms, completed_at_ms, revision
        ) VALUES (
          $1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10,
          'queued', 'enqueued', 0, $11, $12, $12, $12, NULL, NULL, NULL, 1
        )
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING ${JOB_COLUMNS}
      `, [
        input.jobId,
        input.idempotencyKey,
        input.logicalSessionId,
        input.kind,
        input.payload.schemaVersion,
        JSON.stringify(input.payload),
        input.payloadFingerprint,
        input.sourceTurnId,
        input.sourceRequestId,
        input.sourceChannelId,
        input.maxAttempts,
        input.createdAtMs,
      ]);
      const inserted = insertedResult.rows.at(0);
      if (!inserted) {
        const incumbentResult = await client.query<BackgroundWorkRow>(`
          SELECT ${JOB_COLUMNS}
          FROM agent_background_work_jobs
          WHERE idempotency_key = $1
          FOR UPDATE
        `, [input.idempotencyKey]);
        const incumbentRow = incumbentResult.rows.at(0);
        if (!incumbentRow) {
          throw new Error(`Background work replay disappeared: ${input.idempotencyKey}`);
        }
        const incumbent = mapRow(incumbentRow);
        assertIdempotentReplay(incumbent, input);
        return { outcome: 'deduplicated', job: incumbent, staleDiscardedJobIds: [] };
      }

      const staleDiscardedJobIds: string[] = [];
      let insertedJob = inserted;
      if (input.kind === 'auto_compaction') {
        const newerResult = await client.query<BackgroundWorkRow>(`
          UPDATE agent_background_work_jobs inserted_job
          SET state = 'stale_discarded',
              reason_code = 'superseded',
              completed_at_ms = $3,
              updated_at_ms = $3,
              revision = revision + 1
          WHERE inserted_job.job_id = $2
            AND EXISTS (
              SELECT 1
              FROM agent_background_work_jobs newer_job
              WHERE newer_job.logical_session_id = $1
                AND newer_job.kind = 'auto_compaction'
                AND newer_job.job_id <> $2
                AND (
                  newer_job.created_at_ms > $3
                  OR (newer_job.created_at_ms = $3 AND newer_job.job_id > $2)
                )
            )
          RETURNING ${qualifiedJobColumns('inserted_job')}
        `, [input.logicalSessionId, input.jobId, input.createdAtMs]);
        if (newerResult.rows[0]) {
          insertedJob = newerResult.rows[0];
        } else {
          const staleResult = await client.query<{ job_id: string }>(`
          UPDATE agent_background_work_jobs
          SET state = 'stale_discarded',
              reason_code = 'superseded',
              completed_at_ms = $3,
              updated_at_ms = $3,
              revision = revision + 1
          WHERE logical_session_id = $1
            AND kind = 'auto_compaction'
            AND job_id <> $2
            AND state IN ('queued', 'deferred', 'retry_wait')
            AND (
              created_at_ms < $3
              OR (created_at_ms = $3 AND job_id < $2)
            )
          RETURNING job_id
        `, [input.logicalSessionId, input.jobId, input.createdAtMs]);
          staleDiscardedJobIds.push(...staleResult.rows.map(row => row.job_id));
        }
      }
      return {
        outcome: 'enqueued',
        job: mapRow(insertedJob),
        staleDiscardedJobIds,
      };
    });
  }

  async deferRunnableForSession(input: {
    logicalSessionId: string;
    nowMs: number;
    resumeFallbackAtMs: number;
  }): Promise<StoredBackgroundWorkJob[]> {
    const rows = await queryRows<BackgroundWorkRow>(this.pool, `
      UPDATE agent_background_work_jobs
      SET state = 'deferred',
          reason_code = 'foreground_active',
          available_at_ms = $3,
          updated_at_ms = $2,
          revision = revision + 1
      WHERE logical_session_id = $1
        AND state IN ('queued', 'retry_wait')
      RETURNING ${JOB_COLUMNS}
    `, [
      requireText(input.logicalSessionId, 'logicalSessionId'),
      safeInteger(input.nowMs, 'nowMs'),
      safeInteger(input.resumeFallbackAtMs, 'resumeFallbackAtMs'),
    ]);
    return rows.map(mapRow);
  }

  async resumeDeferredForSession(input: {
    logicalSessionId: string;
    nowMs: number;
  }): Promise<StoredBackgroundWorkJob[]> {
    const rows = await queryRows<BackgroundWorkRow>(this.pool, `
      UPDATE agent_background_work_jobs
      SET state = 'queued',
          reason_code = 'foreground_active',
          available_at_ms = $2,
          updated_at_ms = $2,
          revision = revision + 1
      WHERE logical_session_id = $1
        AND state = 'deferred'
        AND reason_code = 'foreground_active'
      RETURNING ${JOB_COLUMNS}
    `, [
      requireText(input.logicalSessionId, 'logicalSessionId'),
      safeInteger(input.nowMs, 'nowMs'),
    ]);
    return rows.map(mapRow);
  }

  async claimNext(input: {
    leaseOwner: string;
    nowMs: number;
    leaseDurationMs: number;
    excludedLogicalSessionIds: readonly string[];
  }): Promise<ClaimedBackgroundWorkJob | null> {
    const nowMs = safeInteger(input.nowMs, 'nowMs');
    const leaseDurationMs = positiveInteger(input.leaseDurationMs, 'leaseDurationMs');
    const excluded = input.excludedLogicalSessionIds.map(sessionId => (
      requireText(sessionId, 'excludedLogicalSessionId')
    ));
    const row = await queryOne<BackgroundWorkRow>(this.pool, `
      WITH candidate AS (
        SELECT job_id
        FROM agent_background_work_jobs candidate_job
        WHERE state IN ('queued', 'deferred', 'retry_wait')
          AND available_at_ms <= $2
          AND NOT (logical_session_id = ANY($4::text[]))
          AND NOT EXISTS (
            SELECT 1
            FROM agent_background_work_jobs running_job
            WHERE running_job.logical_session_id = candidate_job.logical_session_id
              AND running_job.state = 'running'
          )
        ORDER BY
          created_at_ms ASC,
          CASE kind
            WHEN 'intention_post_turn_hooks' THEN 0
            WHEN 'emotion_appraisal' THEN 1
            WHEN 'memory_extraction' THEN 2
            ELSE 3
          END ASC,
          job_id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE agent_background_work_jobs job
      SET state = 'running',
          reason_code = 'started',
          lease_owner = $1,
          lease_expires_at_ms = $2 + $3,
          updated_at_ms = $2,
          revision = revision + 1
      FROM candidate
      WHERE job.job_id = candidate.job_id
      RETURNING ${qualifiedJobColumns('job')}
    `, [
      requireText(input.leaseOwner, 'leaseOwner'),
      nowMs,
      leaseDurationMs,
      excluded,
    ]);
    return row ? mapClaimedRow(row) : null;
  }

  async renewClaims(input: {
    leaseOwner: string;
    jobIds: readonly string[];
    nowMs: number;
    leaseDurationMs: number;
  }): Promise<number> {
    if (input.jobIds.length === 0) return 0;
    const result = await this.pool.query(`
      UPDATE agent_background_work_jobs
      SET lease_expires_at_ms = $3 + $4,
          updated_at_ms = $3
      WHERE lease_owner = $1
        AND job_id = ANY($2::text[])
        AND state = 'running'
    `, [
      requireText(input.leaseOwner, 'leaseOwner'),
      input.jobIds.map(jobId => requireText(jobId, 'jobId')),
      safeInteger(input.nowMs, 'nowMs'),
      positiveInteger(input.leaseDurationMs, 'leaseDurationMs'),
    ]);
    return result.rowCount ?? 0;
  }

  async complete(input: {
    jobId: string;
    leaseOwner: string;
    expectedRevision: number;
    nowMs: number;
  }): Promise<StoredBackgroundWorkJob> {
    const row = await this.transitionClaim(input, `
      state = 'succeeded',
      reason_code = 'completed',
      completed_at_ms = $4,
      updated_at_ms = $4,
      lease_owner = NULL,
      lease_expires_at_ms = NULL,
      revision = revision + 1
    `);
    return requireTransitionRow(row, input.jobId);
  }

  async defer(input: {
    jobId: string;
    leaseOwner: string;
    expectedRevision: number;
    reasonCode: BackgroundWorkReasonCode;
    availableAtMs: number;
    nowMs: number;
  }): Promise<StoredBackgroundWorkJob> {
    if (input.reasonCode !== 'foreground_active' && input.reasonCode !== 'source_not_ready') {
      throw new Error(`Invalid background deferral reason: ${input.reasonCode}`);
    }
    const row = await queryOne<BackgroundWorkRow>(this.pool, `
      UPDATE agent_background_work_jobs
      SET state = 'deferred',
          reason_code = $5,
          available_at_ms = $6,
          updated_at_ms = $4,
          lease_owner = NULL,
          lease_expires_at_ms = NULL,
          revision = revision + 1
      WHERE job_id = $1 AND state = 'running' AND lease_owner = $2 AND revision = $3
      RETURNING ${JOB_COLUMNS}
    `, [
      requireText(input.jobId, 'jobId'),
      requireText(input.leaseOwner, 'leaseOwner'),
      positiveInteger(input.expectedRevision, 'expectedRevision'),
      safeInteger(input.nowMs, 'nowMs'),
      input.reasonCode,
      safeInteger(input.availableAtMs, 'availableAtMs'),
    ]);
    return requireTransitionRow(row, input.jobId);
  }

  async failOrRetry(input: {
    jobId: string;
    leaseOwner: string;
    expectedRevision: number;
    nowMs: number;
    retryAtMs: number;
  }): Promise<StoredBackgroundWorkJob> {
    const row = await queryOne<BackgroundWorkRow>(this.pool, `
      UPDATE agent_background_work_jobs
      SET attempt_count = attempt_count + 1,
          state = CASE WHEN attempt_count + 1 >= max_attempts THEN 'failed' ELSE 'retry_wait' END,
          reason_code = CASE
            WHEN attempt_count + 1 >= max_attempts THEN 'retry_exhausted'
            ELSE 'retry_scheduled'
          END,
          available_at_ms = $5,
          completed_at_ms = CASE WHEN attempt_count + 1 >= max_attempts THEN $4 ELSE NULL END,
          updated_at_ms = $4,
          lease_owner = NULL,
          lease_expires_at_ms = NULL,
          revision = revision + 1
      WHERE job_id = $1 AND state = 'running' AND lease_owner = $2 AND revision = $3
      RETURNING ${JOB_COLUMNS}
    `, [
      requireText(input.jobId, 'jobId'),
      requireText(input.leaseOwner, 'leaseOwner'),
      positiveInteger(input.expectedRevision, 'expectedRevision'),
      safeInteger(input.nowMs, 'nowMs'),
      safeInteger(input.retryAtMs, 'retryAtMs'),
    ]);
    return requireTransitionRow(row, input.jobId);
  }

  async markClaimMalformed(input: {
    jobId: string;
    leaseOwner: string;
    expectedRevision: number;
    reasonCode: 'malformed_payload' | 'unknown_kind';
    nowMs: number;
  }): Promise<StoredBackgroundWorkJob> {
    return this.markClaimTerminal(input, 'failed');
  }

  async markClaimFailed(input: {
    jobId: string;
    leaseOwner: string;
    expectedRevision: number;
    reasonCode: 'source_missing' | 'source_mismatch';
    nowMs: number;
  }): Promise<StoredBackgroundWorkJob> {
    return this.markClaimTerminal(input, 'failed');
  }

  async markClaimStale(input: {
    jobId: string;
    leaseOwner: string;
    expectedRevision: number;
    reasonCode: 'source_missing' | 'source_mismatch' | 'superseded';
    nowMs: number;
  }): Promise<StoredBackgroundWorkJob> {
    return this.markClaimTerminal(input, 'stale_discarded');
  }

  async releaseClaims(input: {
    leaseOwner: string;
    nowMs: number;
    reasonCode: 'shutdown';
  }): Promise<number> {
    const result = await this.pool.query(`
      UPDATE agent_background_work_jobs
      SET state = 'deferred',
          reason_code = $3,
          available_at_ms = $2,
          updated_at_ms = $2,
          lease_owner = NULL,
          lease_expires_at_ms = NULL,
          revision = revision + 1
      WHERE state = 'running' AND lease_owner = $1
    `, [
      requireText(input.leaseOwner, 'leaseOwner'),
      safeInteger(input.nowMs, 'nowMs'),
      input.reasonCode,
    ]);
    return result.rowCount ?? 0;
  }

  async recoverExpired(input: { nowMs: number }): Promise<number> {
    const nowMs = safeInteger(input.nowMs, 'nowMs');
    const result = await this.pool.query(`
      UPDATE agent_background_work_jobs
      SET attempt_count = attempt_count + 1,
          state = CASE WHEN attempt_count + 1 >= max_attempts THEN 'failed' ELSE 'retry_wait' END,
          reason_code = CASE
            WHEN attempt_count + 1 >= max_attempts THEN 'retry_exhausted'
            ELSE 'lease_expired'
          END,
          available_at_ms = $1,
          completed_at_ms = CASE WHEN attempt_count + 1 >= max_attempts THEN $1 ELSE NULL END,
          updated_at_ms = $1,
          lease_owner = NULL,
          lease_expires_at_ms = NULL,
          revision = revision + 1
      WHERE state = 'running' AND lease_expires_at_ms <= $1
    `, [nowMs]);
    return result.rowCount ?? 0;
  }

  async purgeTerminal(input: { completedBeforeMs: number; limit: number }): Promise<number> {
    const limit = positiveInteger(input.limit, 'limit');
    if (limit > MAX_PURGE_LIMIT) throw new Error(`Background work purge limit exceeds ${MAX_PURGE_LIMIT}`);
    const result = await this.pool.query(`
      WITH expired AS (
        SELECT job_id
        FROM agent_background_work_jobs
        WHERE state IN ('succeeded', 'failed', 'stale_discarded')
          AND completed_at_ms <= $1
        ORDER BY completed_at_ms ASC, job_id ASC
        LIMIT $2
      )
      DELETE FROM agent_background_work_jobs job
      USING expired
      WHERE job.job_id = expired.job_id
    `, [safeInteger(input.completedBeforeMs, 'completedBeforeMs'), limit]);
    return result.rowCount ?? 0;
  }

  async countRunnable(input: { nowMs: number }): Promise<number> {
    const row = await queryOne<{ count: string }>(this.pool, `
      SELECT COUNT(*)::text AS count
      FROM agent_background_work_jobs
      WHERE state IN ('queued', 'deferred', 'retry_wait') AND available_at_ms <= $1
    `, [safeInteger(input.nowMs, 'nowMs')]);
    return row ? safeInteger(row.count, 'runnable count') : 0;
  }

  async get(jobId: string): Promise<StoredBackgroundWorkJob | null> {
    const row = await queryOne<BackgroundWorkRow>(this.pool, `
      SELECT ${JOB_COLUMNS}
      FROM agent_background_work_jobs
      WHERE job_id = $1
    `, [requireText(jobId, 'jobId')]);
    return row ? mapRow(row) : null;
  }

  async close(): Promise<void> {
    if (!this.closePromise) this.closePromise = this.pool.end();
    return this.closePromise;
  }

  private async transitionClaim(
    input: { jobId: string; leaseOwner: string; expectedRevision: number; nowMs: number },
    setClause: string,
  ): Promise<BackgroundWorkRow | undefined> {
    return queryOne<BackgroundWorkRow>(this.pool, `
      UPDATE agent_background_work_jobs
      SET ${setClause}
      WHERE job_id = $1 AND state = 'running' AND lease_owner = $2 AND revision = $3
      RETURNING ${JOB_COLUMNS}
    `, [
      requireText(input.jobId, 'jobId'),
      requireText(input.leaseOwner, 'leaseOwner'),
      positiveInteger(input.expectedRevision, 'expectedRevision'),
      safeInteger(input.nowMs, 'nowMs'),
    ]);
  }

  private async markClaimTerminal(input: {
    jobId: string;
    leaseOwner: string;
    expectedRevision: number;
    reasonCode: BackgroundWorkReasonCode;
    nowMs: number;
  }, state: 'failed' | 'stale_discarded'): Promise<StoredBackgroundWorkJob> {
    const row = await queryOne<BackgroundWorkRow>(this.pool, `
      UPDATE agent_background_work_jobs
      SET state = $5,
          reason_code = $6,
          completed_at_ms = $4,
          updated_at_ms = $4,
          lease_owner = NULL,
          lease_expires_at_ms = NULL,
          revision = revision + 1
      WHERE job_id = $1 AND state = 'running' AND lease_owner = $2 AND revision = $3
      RETURNING ${JOB_COLUMNS}
    `, [
      requireText(input.jobId, 'jobId'),
      requireText(input.leaseOwner, 'leaseOwner'),
      positiveInteger(input.expectedRevision, 'expectedRevision'),
      safeInteger(input.nowMs, 'nowMs'),
      state,
      input.reasonCode,
    ]);
    return requireTransitionRow(row, input.jobId);
  }
}
