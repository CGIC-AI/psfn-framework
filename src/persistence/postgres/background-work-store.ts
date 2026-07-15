import type { Pool, PoolClient, QueryResultRow } from 'pg';

import type {
  BackgroundWorkEnqueueResult,
  BackgroundWorkJobEnqueueResult,
  BackgroundWorkStorePort,
} from '../../core/agent/background-work/store-port.js';
import {
  BACKGROUND_WORK_REASON_CODES,
  BACKGROUND_WORK_STATES,
  createBackgroundWorkIdentity,
  fingerprintBackgroundWorkHandoff,
  fingerprintBackgroundWorkPayload,
  parseBackgroundWorkPayload,
  type BackgroundWorkReasonCode,
  type BackgroundWorkState,
  type ClaimedBackgroundWorkJob,
  type EnqueueBackgroundWorkInput,
  type StoredBackgroundWorkJob,
} from '../../core/agent/background-work/types.js';
import {
  assertValidPostgresSchemaName,
  createPostgresPool,
  ensurePostgresSchemaWithAdvisoryLock,
  queryOne,
  queryRows,
  withPostgresClient,
} from '../postgres.js';
import {
  POSTGRES_BACKGROUND_WORK_MIGRATION_ADVISORY_LOCK,
  POSTGRES_BACKGROUND_WORK_MIGRATIONS,
} from './migrations.js';

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
  deferred_from_state: string | null;
  deferred_from_available_at_ms: number | string | null;
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
  'deferred_from_state',
  'deferred_from_available_at_ms',
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
    ...(row.deferred_from_state === 'queued' || row.deferred_from_state === 'retry_wait'
      ? { deferredFromState: row.deferred_from_state }
      : {}),
    ...(row.deferred_from_available_at_ms === null
      ? {}
      : {
        deferredFromAvailableAtMs: safeInteger(
          row.deferred_from_available_at_ms,
          'deferredFromAvailableAtMs',
        ),
      }),
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
      const migrationStatements = options.schema === undefined
        ? POSTGRES_BACKGROUND_WORK_MIGRATIONS
        : [
          `CREATE SCHEMA IF NOT EXISTS "${assertValidPostgresSchemaName(options.schema)}"`,
          ...POSTGRES_BACKGROUND_WORK_MIGRATIONS,
        ];
      await ensurePostgresSchemaWithAdvisoryLock(
        pool,
        migrationStatements,
        POSTGRES_BACKGROUND_WORK_MIGRATION_ADVISORY_LOCK,
      );
      return new PostgresBackgroundWorkStore(pool);
    } catch (error) {
      await pool.end().catch(() => undefined);
      throw error;
    }
  }

  async enqueue(inputValue: EnqueueBackgroundWorkInput): Promise<BackgroundWorkJobEnqueueResult> {
    const input = validateEnqueueInput(inputValue);
    return withPostgresClient(this.pool, async (client) => {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`background-work:${input.logicalSessionId}`],
      );
      return this.enqueueValidated(client, input);
    });
  }

  async enqueueBatch(
    inputValues: readonly EnqueueBackgroundWorkInput[],
  ): Promise<BackgroundWorkEnqueueResult[]> {
    if (inputValues.length === 0) return [];
    if (inputValues.length > 4) throw new Error('Background work handoff supports at most four jobs');
    const inputs = inputValues.map(validateEnqueueInput);
    const first = inputs[0]!;
    const kinds = new Set<string>();
    for (const input of inputs) {
      if (input.logicalSessionId !== first.logicalSessionId
        || input.sourceTurnId !== first.sourceTurnId
        || input.sourceRequestId !== first.sourceRequestId
        || input.sourceChannelId !== first.sourceChannelId
        || input.createdAtMs !== first.createdAtMs) {
        throw new Error('Background work batch must bind to one canonical turn');
      }
      if (kinds.has(input.kind)) throw new Error(`Duplicate background work kind in batch: ${input.kind}`);
      kinds.add(input.kind);
    }
    return withPostgresClient(this.pool, async (client) => {
      // Serialize enqueue/supersession decisions per logical session so two
      // replicas cannot both leave competing auto-compaction jobs runnable.
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`background-work:${first.logicalSessionId}`],
      );
      const manifestFingerprint = fingerprintBackgroundWorkHandoff(inputs);
      const accepted = await client.query<{ manifest_fingerprint: string }>(`
        INSERT INTO agent_background_work_handoffs (
          logical_session_id, source_turn_id, manifest_fingerprint, accepted_at_ms
        ) VALUES ($1, $2, $3, $4)
        ON CONFLICT (logical_session_id, source_turn_id) DO NOTHING
        RETURNING manifest_fingerprint
      `, [
        first.logicalSessionId,
        first.sourceTurnId,
        manifestFingerprint,
        first.createdAtMs,
      ]);
      if (!accepted.rows[0]) {
        const incumbent = await client.query<{ manifest_fingerprint: string }>(`
          SELECT manifest_fingerprint
          FROM agent_background_work_handoffs
          WHERE logical_session_id = $1 AND source_turn_id = $2
          FOR UPDATE
        `, [first.logicalSessionId, first.sourceTurnId]);
        if (incumbent.rows[0]?.manifest_fingerprint !== manifestFingerprint) {
          throw new Error('Background work handoff replay fingerprint mismatch');
        }
        const replayResults: BackgroundWorkEnqueueResult[] = [];
        for (const input of inputs) {
          const row = await client.query<BackgroundWorkRow>(`
            SELECT ${JOB_COLUMNS}
            FROM agent_background_work_jobs
            WHERE idempotency_key = $1
            FOR UPDATE
          `, [input.idempotencyKey]);
          if (row.rowCount === 0) {
            replayResults.push({
              outcome: 'already_accepted',
              jobId: input.jobId,
              staleDiscardedJobIds: [],
            });
            continue;
          }
          const jobRow = row.rows[0]!;
          const job = mapRow(jobRow);
          assertIdempotentReplay(job, input);
          replayResults.push({ outcome: 'deduplicated', job, staleDiscardedJobIds: [] });
        }
        return replayResults;
      }
      const results: BackgroundWorkEnqueueResult[] = [];
      for (const input of inputs) {
        results.push(await this.enqueueValidated(client, input));
      }
      return results;
    });
  }

  private async enqueueValidated(
    client: PoolClient,
    input: EnqueueBackgroundWorkInput,
  ): Promise<BackgroundWorkJobEnqueueResult> {
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
              deferred_from_state = NULL,
              deferred_from_available_at_ms = NULL,
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
              deferred_from_state = NULL,
              deferred_from_available_at_ms = NULL,
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
  }

  async beginForeground(input: {
    logicalSessionId: string;
    leaseOwner: string;
    leaseId: string;
    nowMs: number;
    leaseDurationMs: number;
  }): Promise<void> {
    const logicalSessionId = requireText(input.logicalSessionId, 'logicalSessionId');
    const nowMs = safeInteger(input.nowMs, 'nowMs');
    const leaseDurationMs = positiveInteger(input.leaseDurationMs, 'leaseDurationMs');
    await withPostgresClient(this.pool, async (client) => {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`background-work:${logicalSessionId}`],
      );
      await client.query(`
        INSERT INTO agent_background_work_foreground_leases (
          lease_id, logical_session_id, lease_owner, acquired_at_ms, expires_at_ms
        ) VALUES ($1, $2, $3, $4::bigint, $4::bigint + $5::bigint)
      `, [
        requireText(input.leaseId, 'foreground leaseId'),
        logicalSessionId,
        requireText(input.leaseOwner, 'foreground leaseOwner'),
        nowMs,
        leaseDurationMs,
      ]);
      await client.query(`
        UPDATE agent_background_work_jobs
        SET state = 'deferred',
            deferred_from_state = state,
            deferred_from_available_at_ms = available_at_ms,
            available_at_ms = GREATEST(available_at_ms, $2::bigint + $3::bigint),
            reason_code = 'foreground_active',
            updated_at_ms = $2::bigint,
            revision = revision + 1
        WHERE logical_session_id = $1
          AND state IN ('queued', 'retry_wait')
      `, [logicalSessionId, nowMs, leaseDurationMs]);
    });
  }

  async renewForeground(input: {
    leaseOwner: string;
    leaseIds: readonly string[];
    nowMs: number;
    leaseDurationMs: number;
  }): Promise<string[]> {
    if (input.leaseIds.length === 0) return [];
    const rows = await queryRows<{ lease_id: string }>(this.pool, `
      UPDATE agent_background_work_foreground_leases
      SET expires_at_ms = $3::bigint + $4::bigint
      WHERE lease_owner = $1 AND lease_id = ANY($2::text[])
      RETURNING lease_id
    `, [
      requireText(input.leaseOwner, 'foreground leaseOwner'),
      input.leaseIds.map(id => requireText(id, 'foreground leaseId')),
      safeInteger(input.nowMs, 'nowMs'),
      positiveInteger(input.leaseDurationMs, 'leaseDurationMs'),
    ]);
    return rows.map(row => row.lease_id);
  }

  async endForeground(input: {
    logicalSessionId: string;
    leaseOwner: string;
    leaseId: string;
    nowMs: number;
  }): Promise<boolean> {
    const logicalSessionId = requireText(input.logicalSessionId, 'logicalSessionId');
    const nowMs = safeInteger(input.nowMs, 'nowMs');
    return withPostgresClient(this.pool, async (client) => {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`background-work:${logicalSessionId}`],
      );
      const deleted = await client.query(`
        DELETE FROM agent_background_work_foreground_leases
        WHERE lease_id = $1 AND logical_session_id = $2 AND lease_owner = $3
      `, [
        requireText(input.leaseId, 'foreground leaseId'),
        logicalSessionId,
        requireText(input.leaseOwner, 'foreground leaseOwner'),
      ]);
      if ((deleted.rowCount ?? 0) !== 1) {
        throw new Error(`Foreground lease transition conflict for ${input.leaseId}`);
      }
      await client.query(
        'DELETE FROM agent_background_work_foreground_leases WHERE expires_at_ms <= $1',
        [nowMs],
      );
      const active = await client.query<{ active: boolean }>(`
        SELECT EXISTS (
          SELECT 1 FROM agent_background_work_foreground_leases
          WHERE logical_session_id = $1 AND expires_at_ms > $2
        ) AS active
      `, [logicalSessionId, nowMs]);
      return active.rows[0]?.active !== true;
    });
  }

  async deferRunnableForSession(input: {
    logicalSessionId: string;
    nowMs: number;
    resumeFallbackAtMs: number;
  }): Promise<StoredBackgroundWorkJob[]> {
    safeInteger(input.resumeFallbackAtMs, 'resumeFallbackAtMs');
    const rows = await queryRows<BackgroundWorkRow>(this.pool, `
      UPDATE agent_background_work_jobs
      SET state = 'deferred',
          deferred_from_state = state,
          deferred_from_available_at_ms = available_at_ms,
          available_at_ms = GREATEST(available_at_ms, $3::bigint),
          reason_code = 'foreground_active',
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
      SET state = COALESCE(deferred_from_state, 'queued'),
          available_at_ms = COALESCE(deferred_from_available_at_ms, available_at_ms),
          deferred_from_state = NULL,
          deferred_from_available_at_ms = NULL,
          reason_code = 'foreground_active',
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
            FROM agent_background_work_foreground_leases foreground
            WHERE foreground.logical_session_id = candidate_job.logical_session_id
              AND foreground.expires_at_ms > $2
          )
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
          lease_expires_at_ms = $2::bigint + $3::bigint,
          updated_at_ms = $2,
          deferred_from_state = NULL,
          deferred_from_available_at_ms = NULL,
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
  }): Promise<string[]> {
    if (input.jobIds.length === 0) return [];
    const result = await this.pool.query<{ job_id: string }>(`
      UPDATE agent_background_work_jobs
      SET lease_expires_at_ms = $3::bigint + $4::bigint,
          updated_at_ms = $3
      WHERE lease_owner = $1
        AND job_id = ANY($2::text[])
        AND state = 'running'
      RETURNING job_id
    `, [
      requireText(input.leaseOwner, 'leaseOwner'),
      input.jobIds.map(jobId => requireText(jobId, 'jobId')),
      safeInteger(input.nowMs, 'nowMs'),
      positiveInteger(input.leaseDurationMs, 'leaseDurationMs'),
    ]);
    return result.rows.map(row => row.job_id);
  }

  async assertClaimOwned(input: {
    jobId: string;
    leaseOwner: string;
    expectedRevision: number;
    nowMs: number;
  }): Promise<boolean> {
    const row = await queryOne<{ owned: boolean }>(this.pool, `
      SELECT EXISTS (
        SELECT 1
        FROM agent_background_work_jobs job
        WHERE job.job_id = $1
          AND job.state = 'running'
          AND job.lease_owner = $2
          AND job.revision = $3
          AND job.lease_expires_at_ms > $4
          AND NOT EXISTS (
            SELECT 1
            FROM agent_background_work_foreground_leases foreground
            WHERE foreground.logical_session_id = job.logical_session_id
              AND foreground.expires_at_ms > $4
          )
      ) AS owned
    `, [
      requireText(input.jobId, 'jobId'),
      requireText(input.leaseOwner, 'leaseOwner'),
      positiveInteger(input.expectedRevision, 'expectedRevision'),
      safeInteger(input.nowMs, 'nowMs'),
    ]);
    return row?.owned === true;
  }

  async beginEffect(input: {
    jobId: string;
    effectKey: string;
    leaseOwner: string;
    expectedRevision: number;
    nowMs: number;
  }): Promise<'execute' | 'applied' | 'outcome_unknown'> {
    return withPostgresClient(this.pool, async (client) => {
      const claim = await client.query<{ owned: boolean }>(`
        SELECT EXISTS (
          SELECT 1
          FROM agent_background_work_jobs job
          WHERE job.job_id = $1 AND job.state = 'running'
            AND job.lease_owner = $2 AND job.revision = $3
            AND job.lease_expires_at_ms > $4
            AND NOT EXISTS (
              SELECT 1 FROM agent_background_work_foreground_leases foreground
              WHERE foreground.logical_session_id = job.logical_session_id
                AND foreground.expires_at_ms > $4
            )
        ) AS owned
      `, [
        requireText(input.jobId, 'jobId'),
        requireText(input.leaseOwner, 'leaseOwner'),
        positiveInteger(input.expectedRevision, 'expectedRevision'),
        safeInteger(input.nowMs, 'nowMs'),
      ]);
      if (claim.rows[0]?.owned !== true) {
        throw new Error(`Background work effect lease lost for ${input.jobId}`);
      }
      const inserted = await client.query<{ state: string }>(`
        INSERT INTO agent_background_work_effect_receipts (
          job_id, effect_key, state, lease_owner, lease_revision, started_at_ms, applied_at_ms
        ) VALUES ($1, $2, 'started', $3, $4, $5, NULL)
        ON CONFLICT (job_id, effect_key) DO NOTHING
        RETURNING state
      `, [
        input.jobId,
        requireText(input.effectKey, 'effectKey'),
        input.leaseOwner,
        input.expectedRevision,
        input.nowMs,
      ]);
      if (inserted.rows[0]) return 'execute';
      const incumbent = await client.query<{
        state: string;
        lease_owner: string;
        lease_revision: number | string;
      }>(`
        SELECT state, lease_owner, lease_revision
        FROM agent_background_work_effect_receipts
        WHERE job_id = $1 AND effect_key = $2
        FOR UPDATE
      `, [input.jobId, input.effectKey]);
      if (incumbent.rowCount === 0) return 'outcome_unknown';
      const receipt = incumbent.rows[0]!;
      if (receipt.state === 'applied') return 'applied';
      if (receipt.state === 'started'
        && receipt.lease_owner === input.leaseOwner
        && Number(receipt.lease_revision) === input.expectedRevision) return 'execute';
      return 'outcome_unknown';
    });
  }

  async completeEffect(input: {
    jobId: string;
    effectKey: string;
    leaseOwner: string;
    expectedRevision: number;
    nowMs: number;
  }): Promise<void> {
    const result = await this.pool.query(`
      UPDATE agent_background_work_effect_receipts receipt
      SET state = 'applied', applied_at_ms = $5
      WHERE receipt.job_id = $1 AND receipt.effect_key = $2
        AND receipt.state = 'started' AND receipt.lease_owner = $3
        AND receipt.lease_revision = $4
        AND EXISTS (
          SELECT 1 FROM agent_background_work_jobs job
          WHERE job.job_id = receipt.job_id AND job.state = 'running'
            AND job.lease_owner = $3 AND job.revision = $4
            AND job.lease_expires_at_ms > $5
            AND NOT EXISTS (
              SELECT 1 FROM agent_background_work_foreground_leases foreground
              WHERE foreground.logical_session_id = job.logical_session_id
                AND foreground.expires_at_ms > $5
            )
        )
    `, [
      requireText(input.jobId, 'jobId'),
      requireText(input.effectKey, 'effectKey'),
      requireText(input.leaseOwner, 'leaseOwner'),
      positiveInteger(input.expectedRevision, 'expectedRevision'),
      safeInteger(input.nowMs, 'nowMs'),
    ]);
    if ((result.rowCount ?? 0) !== 1) {
      throw new Error(`Background work effect completion conflict for ${input.jobId}:${input.effectKey}`);
    }
  }

  async abandonEffect(input: {
    jobId: string;
    effectKey: string;
    leaseOwner: string;
    expectedRevision: number;
    nowMs: number;
  }): Promise<void> {
    await this.pool.query(`
      DELETE FROM agent_background_work_effect_receipts receipt
      WHERE receipt.job_id = $1 AND receipt.effect_key = $2 AND receipt.state = 'started'
        AND receipt.lease_owner = $3 AND receipt.lease_revision = $4
        AND EXISTS (
          SELECT 1 FROM agent_background_work_jobs job
          WHERE job.job_id = receipt.job_id AND job.state = 'running'
            AND job.lease_owner = $3 AND job.revision = $4
            AND job.lease_expires_at_ms > $5
        )
    `, [
      requireText(input.jobId, 'jobId'),
      requireText(input.effectKey, 'effectKey'),
      requireText(input.leaseOwner, 'leaseOwner'),
      positiveInteger(input.expectedRevision, 'expectedRevision'),
      safeInteger(input.nowMs, 'nowMs'),
    ]);
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
      deferred_from_state = NULL,
      deferred_from_available_at_ms = NULL,
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
          deferred_from_state = 'queued',
          deferred_from_available_at_ms = NULL,
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
          available_at_ms = $5::bigint,
          completed_at_ms = CASE
            WHEN attempt_count + 1 >= max_attempts THEN $4::bigint
            ELSE NULL::bigint
          END,
          updated_at_ms = $4::bigint,
          lease_owner = NULL,
          lease_expires_at_ms = NULL,
          deferred_from_state = NULL,
          deferred_from_available_at_ms = NULL,
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
    reasonCode: 'source_missing' | 'source_mismatch' | 'effect_outcome_unknown';
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
          deferred_from_state = 'queued',
          deferred_from_available_at_ms = available_at_ms,
          reason_code = $3,
          available_at_ms = $2::bigint,
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
          state = CASE
            WHEN EXISTS (
              SELECT 1 FROM agent_background_work_effect_receipts receipt
              WHERE receipt.job_id = agent_background_work_jobs.job_id
                AND receipt.state = 'started'
            ) THEN 'failed'
            WHEN attempt_count + 1 >= max_attempts THEN 'failed'
            ELSE 'retry_wait'
          END,
          reason_code = CASE
            WHEN EXISTS (
              SELECT 1 FROM agent_background_work_effect_receipts receipt
              WHERE receipt.job_id = agent_background_work_jobs.job_id
                AND receipt.state = 'started'
            ) THEN 'effect_outcome_unknown'
            WHEN attempt_count + 1 >= max_attempts THEN 'retry_exhausted'
            ELSE 'lease_expired'
          END,
          available_at_ms = $1::bigint,
          completed_at_ms = CASE
            WHEN EXISTS (
              SELECT 1 FROM agent_background_work_effect_receipts receipt
              WHERE receipt.job_id = agent_background_work_jobs.job_id
                AND receipt.state = 'started'
            ) OR attempt_count + 1 >= max_attempts THEN $1::bigint
            ELSE NULL::bigint
          END,
          updated_at_ms = $1,
          lease_owner = NULL,
          lease_expires_at_ms = NULL,
          deferred_from_state = NULL,
          deferred_from_available_at_ms = NULL,
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
          deferred_from_state = NULL,
          deferred_from_available_at_ms = NULL,
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
