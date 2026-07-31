import type { Pool, PoolClient, QueryResultRow } from 'pg';

import type {
  BackgroundWorkClaimFence,
  BackgroundWorkEnqueueResult,
  BackgroundWorkJobEnqueueResult,
  BackgroundWorkStorePort,
  BackgroundWorkWelfarePolicy,
  SubsystemOutputProjection,
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
  withPostgresClient,
} from '../postgres.js';
import {
  POSTGRES_BACKGROUND_WORK_MIGRATION_ADVISORY_LOCK,
  POSTGRES_BACKGROUND_WORK_MIGRATIONS,
} from './migrations.js';
import { parseSubsystemOutputRef } from '../../shared/contracts/subsystem-output-refs.js';
import { createComponentLogger } from '../../shared/logger.js';

const log = createComponentLogger('PostgresBackgroundWorkStore');

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
  defer_count: number | string;
  first_deferred_at_ms: number | string | null;
  welfare_claimed: boolean;
}

interface BackgroundWorkClaimCandidateRow extends QueryResultRow {
  job_id: string;
  logical_session_id: string;
  via_welfare?: boolean;
}

/**
 * The single kind the foreground turn lease excludes (hrmrq.119). Background
 * automata are designed to run concurrently with chat turns; `auto_compaction`
 * is the one exception because it rewrites the live session context a
 * concurrent foreground turn is reading/appending. The same property makes it
 * welfare-ineligible (mmo9.7.4): a welfare slot must never admit it past the
 * turn exclusion. The other three kinds write to separate stores (memories,
 * emotion/internal state, behavioral patterns) off a claim-time snapshot, so
 * they claim and run regardless of foreground activity.
 */
const FOREGROUND_EXCLUSIVE_KIND = 'auto_compaction';

function normalizeWelfarePolicy(
  welfare: BackgroundWorkWelfarePolicy | undefined,
): { deferThreshold: number; ageThresholdMs: number; reserveSlots: number } {
  if (!welfare) return { deferThreshold: 1, ageThresholdMs: 0, reserveSlots: 0 };
  const reserveSlots = safeInteger(welfare.reserveSlots, 'welfare.reserveSlots');
  if (reserveSlots === 0) return { deferThreshold: 1, ageThresholdMs: 0, reserveSlots: 0 };
  return {
    deferThreshold: positiveInteger(welfare.deferThreshold, 'welfare.deferThreshold'),
    ageThresholdMs: safeInteger(welfare.ageThresholdMs, 'welfare.ageThresholdMs'),
    reserveSlots,
  };
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
  'defer_count',
  'first_deferred_at_ms',
  'welfare_claimed',
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
    deferCount: safeInteger(row.defer_count, 'deferCount'),
    ...(row.first_deferred_at_ms === null
      ? {}
      : { firstDeferredAtMs: safeInteger(row.first_deferred_at_ms, 'firstDeferredAtMs') }),
    welfareClaimed: row.welfare_claimed === true,
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
    options: { schema?: string; role?: string } = {},
  ): Promise<PostgresBackgroundWorkStore> {
    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-background-work',
      allowExitOnIdle: true,
      max: 8,
      schema: options.schema,
      role: options.role,
    });
    try {
      const migrationStatements = options.schema === undefined || options.role !== undefined
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
      await PostgresBackgroundWorkStore.repairStrandedForegroundSweepRows(pool);
      return new PostgresBackgroundWorkStore(pool);
    } catch (error) {
      await pool.end().catch(() => undefined);
      throw error;
    }
  }

  /**
   * Startup normalization for rows stranded by the retired turn-boundary sweep
   * (hrmrq.119 fixA). The pre-decoupling `beginForeground` bulk UPDATE parked
   * every queued/retry_wait job as `deferred`/`foreground_active` with its
   * availability pushed past the lease window and the original availability
   * preserved in `deferred_from_available_at_ms`; only the (also retired)
   * resume sweep could flip them back. The retired sweep is the ONLY writer
   * that ever set `deferred_from_available_at_ms` (claim-level `defer` nulls
   * it), so that column being non-null is an exact legacy discriminator.
   * Restore each such row to its pre-sweep state and availability — the same
   * transition the old resume performed — so the normal claim path drains the
   * backlog. Idempotent (the matched shape can no longer be produced) and
   * fail-closed: a repair failure fails the connect.
   */
  private static async repairStrandedForegroundSweepRows(pool: Pool): Promise<void> {
    const nowMs = Date.now();
    const repaired = await pool.query(`
      UPDATE agent_background_work_jobs
      SET state = COALESCE(deferred_from_state, 'queued'),
          available_at_ms = deferred_from_available_at_ms,
          deferred_from_state = NULL,
          deferred_from_available_at_ms = NULL,
          updated_at_ms = $1,
          revision = revision + 1
      WHERE state = 'deferred'
        AND reason_code = 'foreground_active'
        AND deferred_from_available_at_ms IS NOT NULL
    `, [nowMs]);
    const repairedCount = repaired.rowCount ?? 0;
    if (repairedCount > 0) {
      log.info('Restored background jobs stranded by the retired foreground sweep', {
        repairedCount,
      });
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
      // Deliberately no job-row writes here (hrmrq.119): the lease row alone is
      // the turn-presence signal, checked at claim/effect time for the one
      // foreground-exclusive kind. Stamping every queued job made turn latency
      // O(queue depth) and suspended the autonomic lane during chat.
    });
  }

  async renewForeground(input: {
    leaseOwner: string;
    leaseIds: readonly string[];
    nowMs: number;
    leaseDurationMs: number;
  }): Promise<string[]> {
    if (input.leaseIds.length === 0) return [];
    const leaseOwner = requireText(input.leaseOwner, 'foreground leaseOwner');
    const leaseIds = input.leaseIds.map(id => requireText(id, 'foreground leaseId'));
    const nowMs = safeInteger(input.nowMs, 'nowMs');
    const leaseDurationMs = positiveInteger(input.leaseDurationMs, 'leaseDurationMs');
    return withPostgresClient(this.pool, async (client) => {
      const owned = await client.query<{ lease_id: string; logical_session_id: string }>(`
        SELECT lease_id, logical_session_id
        FROM agent_background_work_foreground_leases
        WHERE lease_owner = $1 AND lease_id = ANY($2::text[])
        ORDER BY logical_session_id ASC, lease_id ASC
      `, [leaseOwner, leaseIds]);
      const sessions = [...new Set(owned.rows.map(row => row.logical_session_id))];
      for (const logicalSessionId of sessions) {
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [`background-work:${logicalSessionId}`],
        );
      }
      // An owner that notices expiry has already lost the lease, so the id is
      // not reported as renewed. We still extend its owned row for one bounded
      // lease window: this durable quarantine gives the loss signal time to
      // abort/finish local foreground cleanup before a background effect can
      // cross the same-session fence. A crashed owner never executes this path,
      // so ordinary expiry remains bounded crash recovery.
      const renewed = await client.query<{ lease_id: string }>(`
        WITH candidates AS (
          SELECT lease_id, expires_at_ms > $3 AS was_owned
          FROM agent_background_work_foreground_leases
          WHERE lease_owner = $1 AND lease_id = ANY($2::text[])
          FOR UPDATE
        ), extended AS (
          UPDATE agent_background_work_foreground_leases lease
          SET expires_at_ms = $3::bigint + $4::bigint
          FROM candidates candidate
          WHERE lease.lease_id = candidate.lease_id
          RETURNING lease.lease_id, candidate.was_owned
        )
        SELECT lease_id FROM extended WHERE was_owned
      `, [leaseOwner, leaseIds, nowMs, leaseDurationMs]);
      return renewed.rows.map(row => row.lease_id);
    });
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
        const incumbent = await client.query<{ lease_owner: string; logical_session_id: string }>(`
          SELECT lease_owner, logical_session_id
          FROM agent_background_work_foreground_leases
          WHERE lease_id = $1
        `, [input.leaseId]);
        if (incumbent.rows[0]) {
          throw new Error(`Foreground lease transition conflict for ${input.leaseId}`);
        }
      }
      await client.query(
        `DELETE FROM agent_background_work_foreground_leases
         WHERE expires_at_ms <= $1 AND logical_session_id = $2`,
        [nowMs, logicalSessionId],
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

  async claimNext(input: {
    leaseOwner: string;
    nowMs: number;
    leaseDurationMs: number;
    excludedLogicalSessionIds: readonly string[];
    foregroundExcludedLogicalSessionIds?: readonly string[];
    welfare?: BackgroundWorkWelfarePolicy;
  }): Promise<ClaimedBackgroundWorkJob | null> {
    const nowMs = safeInteger(input.nowMs, 'nowMs');
    const leaseDurationMs = positiveInteger(input.leaseDurationMs, 'leaseDurationMs');
    // Hard exclusion (running sessions): never bypassed. Foreground exclusion:
    // applies only to the foreground-exclusive kind (auto_compaction) — all
    // other kinds claim concurrently with an active turn (hrmrq.119). A session
    // may appear in both lists; the hard list always wins.
    const excluded = input.excludedLogicalSessionIds.map(sessionId => (
      requireText(sessionId, 'excludedLogicalSessionId')
    ));
    const foregroundExcluded = (input.foregroundExcludedLogicalSessionIds ?? []).map(sessionId => (
      requireText(sessionId, 'foregroundExcludedLogicalSessionId')
    ));
    const welfare = normalizeWelfarePolicy(input.welfare);
    const leaseOwner = requireText(input.leaseOwner, 'leaseOwner');
    return withPostgresClient(this.pool, async (client) => {
      // SAFETY: foreground acquisition, enqueue, and claim all serialize on
      // the same per-session transaction advisory lock before mutating rows.
      // Candidate discovery deliberately takes no row lock: taking a job row
      // before this advisory lock would invert beginForeground's lock order.
      //
      // A candidate is admissible via the NORMAL path (available, and for the
      // foreground-exclusive kind no turn contention) or, once it has crossed
      // the welfare threshold (mmo9.7.4), via the WELFARE path which bypasses
      // the availability backoff accrued from repeated claim-level preemption
      // defers into one of a bounded number of reserve slots. Non-admissible
      // rows are filtered out before ranking, so an inadmissible sibling (e.g.
      // a foreground-blocked auto_compaction) never occupies the session's
      // rank-1 slot ahead of a welfare-eligible job.
      const candidates = await client.query<BackgroundWorkClaimCandidateRow>(`
        WITH admissible AS (
          SELECT
            candidate_job.job_id,
            candidate_job.logical_session_id,
            candidate_job.created_at_ms,
            candidate_job.kind,
            -- via_welfare = NOT admissible-by-the-normal-path. The normal path
            -- requires the job to be available (backoff elapsed) AND, for the
            -- foreground-exclusive kind only, free of turn contention; anything
            -- else that still reaches this CTE got here through the welfare
            -- branch below.
            NOT (
              candidate_job.available_at_ms <= $1
              AND (
                candidate_job.kind <> '${FOREGROUND_EXCLUSIVE_KIND}'
                OR (
                  NOT (candidate_job.logical_session_id = ANY($3::text[]))
                  AND NOT EXISTS (
                    SELECT 1
                    FROM agent_background_work_foreground_leases foreground
                    WHERE foreground.logical_session_id = candidate_job.logical_session_id
                      AND foreground.expires_at_ms > $1
                  )
                )
              )
            ) AS via_welfare
          FROM agent_background_work_jobs candidate_job
          WHERE candidate_job.state IN ('queued', 'deferred', 'retry_wait')
            AND NOT (candidate_job.logical_session_id = ANY($2::text[]))
            AND NOT EXISTS (
              SELECT 1
              FROM agent_background_work_jobs running_job
              WHERE running_job.logical_session_id = candidate_job.logical_session_id
                AND running_job.state = 'running'
            )
            AND (
              -- normal admission: available; only the foreground-exclusive kind
              -- additionally requires the session to be free of turn contention
              (
                candidate_job.available_at_ms <= $1
                AND (
                  candidate_job.kind <> '${FOREGROUND_EXCLUSIVE_KIND}'
                  OR (
                    NOT (candidate_job.logical_session_id = ANY($3::text[]))
                    AND NOT EXISTS (
                      SELECT 1
                      FROM agent_background_work_foreground_leases foreground
                      WHERE foreground.logical_session_id = candidate_job.logical_session_id
                        AND foreground.expires_at_ms > $1
                    )
                  )
                )
              )
              -- welfare admission: aged past threshold, kind is welfare-safe, and a
              -- reserve slot is free. Deliberately bypasses the availability
              -- backoff: repeated claim-level preemption defers push
              -- available_at_ms forward, but the welfare age is measured from the
              -- stable first_deferred_at_ms, so an aged job runs now rather than
              -- waiting out contention that never ends.
              OR (
                $6 > 0
                AND candidate_job.kind <> '${FOREGROUND_EXCLUSIVE_KIND}'
                AND (
                  candidate_job.defer_count >= $4
                  OR (
                    candidate_job.first_deferred_at_ms IS NOT NULL
                    AND $1 - candidate_job.first_deferred_at_ms >= $5
                  )
                )
                AND (
                  SELECT COUNT(*)
                  FROM agent_background_work_jobs welfare_running
                  WHERE welfare_running.state = 'running'
                    AND welfare_running.welfare_claimed = true
                ) < $6
              )
            )
        ), ranked AS (
          SELECT
            admissible.job_id,
            admissible.logical_session_id,
            admissible.created_at_ms,
            admissible.kind,
            admissible.via_welfare,
            ROW_NUMBER() OVER (
              PARTITION BY admissible.logical_session_id
              ORDER BY
                admissible.created_at_ms ASC,
                CASE admissible.kind
                  WHEN 'intention_post_turn_hooks' THEN 0
                  WHEN 'emotion_appraisal' THEN 1
                  WHEN 'memory_extraction' THEN 2
                  ELSE 3
                END ASC,
                admissible.job_id ASC
            ) AS session_rank
          FROM admissible
        )
        SELECT job_id, logical_session_id, via_welfare
        FROM ranked
        WHERE session_rank = 1
        ORDER BY
          created_at_ms ASC,
          CASE kind
            WHEN 'intention_post_turn_hooks' THEN 0
            WHEN 'emotion_appraisal' THEN 1
            WHEN 'memory_extraction' THEN 2
            ELSE 3
          END ASC,
          job_id ASC
      `, [nowMs, excluded, foregroundExcluded, welfare.deferThreshold, welfare.ageThresholdMs, welfare.reserveSlots]);

      for (const candidate of candidates.rows) {
        const lock = await client.query<{ acquired: boolean }>(`
          SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired
        `, [`background-work:${candidate.logical_session_id}`]);
        if (lock.rows[0]?.acquired !== true) continue;
        await client.query(`
          DELETE FROM agent_background_work_foreground_leases
          WHERE logical_session_id = $1 AND expires_at_ms <= $2
        `, [candidate.logical_session_id, nowMs]);

        const claimed = candidate.via_welfare === true
          ? await client.query<BackgroundWorkRow>(`
            UPDATE agent_background_work_jobs job
            SET state = 'running',
                reason_code = 'started',
                lease_owner = $1,
                lease_expires_at_ms = $2::bigint + $3::bigint,
                updated_at_ms = $2,
                deferred_from_state = NULL,
                deferred_from_available_at_ms = NULL,
                welfare_claimed = true,
                revision = revision + 1
            WHERE job.job_id = $4
              AND job.state IN ('queued', 'deferred', 'retry_wait')
              AND job.kind <> '${FOREGROUND_EXCLUSIVE_KIND}'
              AND $7 > 0
              AND (
                job.defer_count >= $5
                OR (job.first_deferred_at_ms IS NOT NULL AND $2 - job.first_deferred_at_ms >= $6)
              )
              AND (
                SELECT COUNT(*)
                FROM agent_background_work_jobs welfare_running
                WHERE welfare_running.state = 'running'
                  AND welfare_running.welfare_claimed = true
              ) < $7
              AND NOT EXISTS (
                SELECT 1
                FROM agent_background_work_jobs running_job
                WHERE running_job.logical_session_id = job.logical_session_id
                  AND running_job.state = 'running'
              )
            RETURNING ${qualifiedJobColumns('job')}
          `, [
            leaseOwner,
            nowMs,
            leaseDurationMs,
            candidate.job_id,
            welfare.deferThreshold,
            welfare.ageThresholdMs,
            welfare.reserveSlots,
          ])
          : await client.query<BackgroundWorkRow>(`
            UPDATE agent_background_work_jobs job
            SET state = 'running',
                reason_code = 'started',
                lease_owner = $1,
                lease_expires_at_ms = $2::bigint + $3::bigint,
                updated_at_ms = $2,
                deferred_from_state = NULL,
                deferred_from_available_at_ms = NULL,
                welfare_claimed = false,
                revision = revision + 1
            WHERE job.job_id = $4
              AND job.state IN ('queued', 'deferred', 'retry_wait')
              AND job.available_at_ms <= $2
              AND (
                job.kind <> '${FOREGROUND_EXCLUSIVE_KIND}'
                OR NOT EXISTS (
                  SELECT 1
                  FROM agent_background_work_foreground_leases foreground
                  WHERE foreground.logical_session_id = job.logical_session_id
                    AND foreground.expires_at_ms > $2
                )
              )
              AND NOT EXISTS (
                SELECT 1
                FROM agent_background_work_jobs running_job
                WHERE running_job.logical_session_id = job.logical_session_id
                  AND running_job.state = 'running'
              )
            RETURNING ${qualifiedJobColumns('job')}
          `, [leaseOwner, nowMs, leaseDurationMs, candidate.job_id]);
        if (claimed.rows[0]) return mapClaimedRow(claimed.rows[0]);
      }
      return null;
    });
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
      ) AS owned
    `, [
      requireText(input.jobId, 'jobId'),
      requireText(input.leaseOwner, 'leaseOwner'),
      positiveInteger(input.expectedRevision, 'expectedRevision'),
      safeInteger(input.nowMs, 'nowMs'),
    ]);
    return row?.owned === true;
  }

  async checkClaimFence(input: {
    jobId: string;
    leaseOwner: string;
    expectedRevision: number;
    nowMs: number;
  }): Promise<BackgroundWorkClaimFence> {
    const row = await queryOne<{ disposition: BackgroundWorkClaimFence }>(this.pool, `
      SELECT CASE
        WHEN job.job_id IS NULL
          OR job.state <> 'running'
          OR job.lease_owner <> $2
          OR job.revision <> $3
          OR job.lease_expires_at_ms <= $4
          THEN 'lease_lost'
        WHEN job.kind = '${FOREGROUND_EXCLUSIVE_KIND}' AND EXISTS (
          SELECT 1
          FROM agent_background_work_foreground_leases foreground
          WHERE foreground.logical_session_id = job.logical_session_id
            AND foreground.expires_at_ms > $4
        ) THEN 'foreground_active'
        ELSE 'owned'
      END AS disposition
      FROM (SELECT 1) singleton
      LEFT JOIN agent_background_work_jobs job ON job.job_id = $1
    `, [
      requireText(input.jobId, 'jobId'),
      requireText(input.leaseOwner, 'leaseOwner'),
      positiveInteger(input.expectedRevision, 'expectedRevision'),
      safeInteger(input.nowMs, 'nowMs'),
    ]);
    return row?.disposition ?? 'lease_lost';
  }

  async beginEffect(input: {
    jobId: string;
    effectKey: string;
    leaseOwner: string;
    expectedRevision: number;
    nowMs: number;
    projectsSubsystemOutputs?: boolean;
  }): Promise<'execute' | 'applied' | 'outcome_unknown' | 'foreground_active' | 'lease_lost'> {
    return withPostgresClient(this.pool, async (client) => {
      const session = await client.query<{ logical_session_id: string }>(`
        SELECT logical_session_id
        FROM agent_background_work_jobs
        WHERE job_id = $1
      `, [requireText(input.jobId, 'jobId')]);
      if (!session.rows[0]) return 'lease_lost';
      // SAFETY: receipt creation and foreground acquisition share this lock,
      // making "effect started" versus "foreground active" one total order.
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`background-work:${session.rows[0].logical_session_id}`],
      );
      const claim = await client.query<{ disposition: BackgroundWorkClaimFence }>(`
        SELECT CASE
          WHEN job.state <> 'running'
            OR job.lease_owner <> $2
            OR job.revision <> $3
            OR job.lease_expires_at_ms <= $4
            THEN 'lease_lost'
          WHEN job.kind = '${FOREGROUND_EXCLUSIVE_KIND}' AND EXISTS (
            SELECT 1 FROM agent_background_work_foreground_leases foreground
            WHERE foreground.logical_session_id = job.logical_session_id
              AND foreground.expires_at_ms > $4
          ) THEN 'foreground_active'
          ELSE 'owned'
        END AS disposition
        FROM agent_background_work_jobs job
        WHERE job.job_id = $1
      `, [
        input.jobId,
        requireText(input.leaseOwner, 'leaseOwner'),
        positiveInteger(input.expectedRevision, 'expectedRevision'),
        safeInteger(input.nowMs, 'nowMs'),
      ]);
      const fence = claim.rows[0]?.disposition ?? 'lease_lost';
      if (fence !== 'owned') return fence;
      // Open the effect at its durable phase boundary as `pending`: the run has
      // entered but no external write has been attempted, so the job is still
      // safely requeue-able. commitEffectBoundary promotes it to `started`.
      const inserted = await client.query<{ state: string }>(`
        INSERT INTO agent_background_work_effect_receipts (
          job_id, effect_key, state, lease_owner, lease_revision, started_at_ms, applied_at_ms,
          projects_subsystem_outputs
        ) VALUES ($1, $2, 'pending', $3, $4, $5, NULL, $6)
        ON CONFLICT (job_id, effect_key) DO NOTHING
        RETURNING state
      `, [
        input.jobId,
        requireText(input.effectKey, 'effectKey'),
        input.leaseOwner,
        input.expectedRevision,
        input.nowMs,
        input.projectsSubsystemOutputs === true,
      ]);
      if (inserted.rows[0]) return 'execute';
      const incumbent = await client.query<{
        state: string;
        lease_owner: string;
        lease_revision: number | string;
        projects_subsystem_outputs: boolean;
      }>(`
        SELECT state, lease_owner, lease_revision, projects_subsystem_outputs
        FROM agent_background_work_effect_receipts
        WHERE job_id = $1 AND effect_key = $2
        FOR UPDATE
      `, [input.jobId, input.effectKey]);
      if (incumbent.rowCount === 0) return 'outcome_unknown';
      const receipt = incumbent.rows[0]!;
      if (receipt.projects_subsystem_outputs !== (input.projectsSubsystemOutputs === true)) {
        throw new Error(`Background work effect projection contract changed for ${input.jobId}:${input.effectKey}`);
      }
      const ownedReceipt = receipt.lease_owner === input.leaseOwner
        && Number(receipt.lease_revision) === input.expectedRevision;
      if (receipt.state === 'applied') return 'applied';
      if (receipt.state === 'started') {
        // A prior boundary crossing whose write outcome is unknown. Only this
        // exact owner/revision may resume it; any other reader stays fail-closed.
        return ownedReceipt ? 'execute' : 'outcome_unknown';
      }
      // `pending`: no write was attempted. A same owner/revision replay resumes;
      // a stale pending receipt from an expired lease is re-taken (still safe,
      // still pre-boundary) rather than quarantined.
      if (ownedReceipt) return 'execute';
      await client.query(`
        UPDATE agent_background_work_effect_receipts
        SET lease_owner = $3, lease_revision = $4, started_at_ms = $5, applied_at_ms = NULL
        WHERE job_id = $1 AND effect_key = $2 AND state = 'pending'
      `, [
        input.jobId,
        input.effectKey,
        input.leaseOwner,
        input.expectedRevision,
        input.nowMs,
      ]);
      return 'execute';
    });
  }

  async commitEffectBoundary(input: {
    jobId: string;
    effectKey: string;
    leaseOwner: string;
    expectedRevision: number;
    nowMs: number;
  }): Promise<'crossed' | 'applied' | 'foreground_active' | 'lease_lost'> {
    return withPostgresClient(this.pool, async (client) => {
      const session = await client.query<{ logical_session_id: string }>(`
        SELECT logical_session_id
        FROM agent_background_work_jobs
        WHERE job_id = $1
      `, [requireText(input.jobId, 'jobId')]);
      if (!session.rows[0]) return 'lease_lost';
      // SAFETY: boundary promotion and foreground acquisition share this lock,
      // making "effect boundary crossed" versus "foreground active" one total
      // order — identical to beginEffect's linearization point.
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`background-work:${session.rows[0].logical_session_id}`],
      );
      const claim = await client.query<{ disposition: BackgroundWorkClaimFence }>(`
        SELECT CASE
          WHEN job.state <> 'running'
            OR job.lease_owner <> $2
            OR job.revision <> $3
            OR job.lease_expires_at_ms <= $4
            THEN 'lease_lost'
          WHEN job.kind = '${FOREGROUND_EXCLUSIVE_KIND}' AND EXISTS (
            SELECT 1 FROM agent_background_work_foreground_leases foreground
            WHERE foreground.logical_session_id = job.logical_session_id
              AND foreground.expires_at_ms > $4
          ) THEN 'foreground_active'
          ELSE 'owned'
        END AS disposition
        FROM agent_background_work_jobs job
        WHERE job.job_id = $1
      `, [
        input.jobId,
        requireText(input.leaseOwner, 'leaseOwner'),
        positiveInteger(input.expectedRevision, 'expectedRevision'),
        safeInteger(input.nowMs, 'nowMs'),
      ]);
      const disposition = claim.rows[0]?.disposition ?? 'lease_lost';
      if (disposition !== 'owned') return disposition;
      const promoted = await client.query<{ state: string }>(`
        UPDATE agent_background_work_effect_receipts
        SET state = 'started', started_at_ms = $5
        WHERE job_id = $1 AND effect_key = $2 AND state = 'pending'
          AND lease_owner = $3 AND lease_revision = $4
        RETURNING state
      `, [
        input.jobId,
        requireText(input.effectKey, 'effectKey'),
        input.leaseOwner,
        input.expectedRevision,
        input.nowMs,
      ]);
      if (promoted.rows[0]) return 'crossed';
      const incumbent = await client.query<{ state: string }>(`
        SELECT state
        FROM agent_background_work_effect_receipts
        WHERE job_id = $1 AND effect_key = $2
          AND lease_owner = $3 AND lease_revision = $4
      `, [input.jobId, input.effectKey, input.leaseOwner, input.expectedRevision]);
      const state = incumbent.rows[0]?.state;
      if (state === 'started') return 'crossed';
      if (state === 'applied') return 'applied';
      return 'lease_lost';
    });
  }

  async completeEffect(input: {
    jobId: string;
    effectKey: string;
    leaseOwner: string;
    expectedRevision: number;
    nowMs: number;
    outputRefs?: readonly string[];
  }): Promise<void> {
    const projectsSubsystemOutputs = input.outputRefs !== undefined;
    const outputRefs = [...new Set(input.outputRefs ?? [])].sort();
    if (outputRefs.length > 128) {
      throw new Error('Background work effect output ref count exceeds 128');
    }
    for (const outputRef of outputRefs) parseSubsystemOutputRef(outputRef);
    // A handler may complete without ever crossing its write boundary (a
    // no-op effect leaves the receipt `pending`); completion applies from
    // either pre-terminal phase so the effect key is durably recorded once.
    // Projection rows and the applied receipt share this transaction: a reader
    // can never observe an applied effect whose stable refs were not committed.
    await withPostgresClient(this.pool, async (client) => {
      const jobId = requireText(input.jobId, 'jobId');
      const effectKey = requireText(input.effectKey, 'effectKey');
      const leaseOwner = requireText(input.leaseOwner, 'leaseOwner');
      const expectedRevision = positiveInteger(input.expectedRevision, 'expectedRevision');
      const nowMs = safeInteger(input.nowMs, 'nowMs');
      const job = await client.query<{
        logical_session_id: string;
        source_channel_id: string;
        source_turn_id: string;
        source_request_id: string;
      }>(`
        SELECT logical_session_id, source_channel_id, source_turn_id, source_request_id
        FROM agent_background_work_jobs
        WHERE job_id = $1 AND state = 'running' AND lease_owner = $2
          AND revision = $3 AND lease_expires_at_ms > $4
        FOR UPDATE
      `, [jobId, leaseOwner, expectedRevision, nowMs]);
      if (job.rowCount !== 1) {
        throw new Error(`Background work effect completion conflict for ${jobId}:${effectKey}`);
      }
      const source = job.rows[0]!;
      const result = await client.query(`
        UPDATE agent_background_work_effect_receipts
        SET state = 'applied', applied_at_ms = $5
        WHERE job_id = $1 AND effect_key = $2
          AND state IN ('pending', 'started') AND lease_owner = $3
          AND lease_revision = $4
          AND projects_subsystem_outputs = $6
      `, [
        jobId,
        effectKey,
        leaseOwner,
        expectedRevision,
        nowMs,
        projectsSubsystemOutputs,
      ]);
      if ((result.rowCount ?? 0) !== 1) {
        throw new Error(`Background work effect completion conflict for ${jobId}:${effectKey}`);
      }
      if (projectsSubsystemOutputs) {
        const status = await client.query<{ status: string }>(`
          INSERT INTO agent_turn_subsystem_output_status (
            logical_session_id, source_channel_id, source_turn_id, source_request_id,
            status, source_job_id, source_effect_key, recorded_at_ms
          ) VALUES ($1, $2, $3, $4, 'applied', $5, $6, $7)
          ON CONFLICT (
            logical_session_id, source_channel_id, source_turn_id, source_request_id
          ) DO NOTHING
          RETURNING status
        `, [
          source.logical_session_id,
          source.source_channel_id,
          source.source_turn_id,
          source.source_request_id,
          jobId,
          effectKey,
          nowMs,
        ]);
        if (status.rowCount !== 1) {
          const incumbent = await client.query<{ status: string }>(`
            SELECT status
            FROM agent_turn_subsystem_output_status
            WHERE logical_session_id = $1 AND source_channel_id = $2
              AND source_turn_id = $3 AND source_request_id = $4
          `, [
            source.logical_session_id,
            source.source_channel_id,
            source.source_turn_id,
            source.source_request_id,
          ]);
          if (incumbent.rows[0]?.status !== 'applied') {
            throw new Error(`Subsystem output projection conflict for ${jobId}:${effectKey}`);
          }
        }
      }
      for (const outputRef of outputRefs) {
        await client.query(`
          INSERT INTO agent_turn_subsystem_output_refs (
            logical_session_id, source_channel_id, source_turn_id, source_request_id,
            output_ref, source_job_id, source_effect_key, recorded_at_ms
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (
            logical_session_id, source_channel_id, source_turn_id, source_request_id, output_ref
          ) DO NOTHING
        `, [
          source.logical_session_id,
          source.source_channel_id,
          source.source_turn_id,
          source.source_request_id,
          outputRef,
          jobId,
          effectKey,
          nowMs,
        ]);
      }
    });
  }

  async abandonEffect(input: {
    jobId: string;
    effectKey: string;
    leaseOwner: string;
    expectedRevision: number;
    nowMs: number;
  }): Promise<void> {
    // Only a `pending` receipt may be abandoned. A `pending` receipt proves the
    // run entered but never crossed its write boundary, so deleting it returns
    // the job to a cleanly re-runnable state with no durable effect at risk.
    // A `started` receipt is durable evidence that a write MAY have happened;
    // deleting it would let a retry replay the write and DUPLICATE the durable
    // effect (the u5bv.6 defect). A boundary-crossed effect that throws is left
    // `started` (outcome-ambiguous) so recovery/retry fails closed via
    // `outcome_unknown` instead of duplicating. This DELETE therefore never
    // matches a `started` receipt, even if a caller requests it.
    await this.pool.query(`
      DELETE FROM agent_background_work_effect_receipts receipt
      WHERE receipt.job_id = $1 AND receipt.effect_key = $2
        AND receipt.state = 'pending'
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
      welfare_claimed = false,
      defer_count = 0,
      first_deferred_at_ms = NULL,
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
          welfare_claimed = false,
          defer_count = defer_count + CASE WHEN $5 = 'foreground_active' THEN 1 ELSE 0 END,
          first_deferred_at_ms = CASE
            WHEN $5 = 'foreground_active' THEN COALESCE(first_deferred_at_ms, $4::bigint)
            ELSE first_deferred_at_ms
          END,
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
    return withPostgresClient(this.pool, async (client) => {
      const jobId = requireText(input.jobId, 'jobId');
      const leaseOwner = requireText(input.leaseOwner, 'leaseOwner');
      const expectedRevision = positiveInteger(input.expectedRevision, 'expectedRevision');
      const nowMs = safeInteger(input.nowMs, 'nowMs');
      const retryAtMs = safeInteger(input.retryAtMs, 'retryAtMs');
      const locked = await client.query<BackgroundWorkRow>(`
        SELECT ${JOB_COLUMNS}
        FROM agent_background_work_jobs
        WHERE job_id = $1 AND state = 'running' AND lease_owner = $2 AND revision = $3
        FOR UPDATE
      `, [jobId, leaseOwner, expectedRevision]);
      if (locked.rowCount !== 1) return requireTransitionRow(undefined, jobId);
      const current = locked.rows[0]!;
      const startedProjection = await client.query<{ effect_key: string }>(`
        SELECT effect_key
        FROM agent_background_work_effect_receipts
        WHERE job_id = $1 AND state = 'started' AND projects_subsystem_outputs = true
        ORDER BY effect_key ASC
        LIMIT 1
      `, [jobId]);
      const unknownEffectKey = startedProjection.rowCount === 1
        ? startedProjection.rows[0]!.effect_key
        : undefined;
      const nextAttemptCount = Number(current.attempt_count) + 1;
      const retryExhausted = nextAttemptCount >= Number(current.max_attempts);
      const terminal = unknownEffectKey !== undefined || retryExhausted;
      const reasonCode = unknownEffectKey !== undefined
        ? 'effect_outcome_unknown'
        : (retryExhausted ? 'retry_exhausted' : 'retry_scheduled');
      const updated = await client.query<BackgroundWorkRow>(`
        UPDATE agent_background_work_jobs
        SET attempt_count = $5,
            state = $6,
            reason_code = $7,
            available_at_ms = $8,
            completed_at_ms = $9,
            updated_at_ms = $4,
            lease_owner = NULL,
            lease_expires_at_ms = NULL,
            deferred_from_state = NULL,
            deferred_from_available_at_ms = NULL,
            welfare_claimed = false,
            revision = revision + 1
        WHERE job_id = $1 AND state = 'running' AND lease_owner = $2 AND revision = $3
        RETURNING ${JOB_COLUMNS}
      `, [
        jobId,
        leaseOwner,
        expectedRevision,
        nowMs,
        nextAttemptCount,
        terminal ? 'failed' : 'retry_wait',
        reasonCode,
        retryAtMs,
        terminal ? nowMs : null,
      ]);
      if (updated.rowCount !== 1) return requireTransitionRow(undefined, jobId);
      const row = updated.rows[0]!;
      if (row.kind === 'memory_extraction' && terminal) {
        await this.recordTerminalSubsystemProjection(
          client,
          row,
          unknownEffectKey ? 'outcome_unknown' : 'failed',
          unknownEffectKey ?? 'memory-extraction',
          nowMs,
        );
      }
      return mapRow(row);
    });
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

  async requeuePreBoundaryClaims(input: {
    leaseOwner: string;
    nowMs: number;
    reasonCode: 'shutdown';
  }): Promise<StoredBackgroundWorkJob[]> {
    const leaseOwner = requireText(input.leaseOwner, 'leaseOwner');
    const nowMs = safeInteger(input.nowMs, 'nowMs');
    const reasonCode = input.reasonCode;
    return withPostgresClient(this.pool, async (client) => {
      // Candidate = this owner's running claims with no boundary-crossed
      // receipt. Ordered by session so concurrent requeue sweeps acquire the
      // per-session locks in one canonical order and cannot deadlock.
      const candidates = await client.query<BackgroundWorkClaimCandidateRow>(`
        SELECT job.job_id, job.logical_session_id
        FROM agent_background_work_jobs job
        WHERE job.state = 'running' AND job.lease_owner = $1
          AND NOT EXISTS (
            SELECT 1 FROM agent_background_work_effect_receipts receipt
            WHERE receipt.job_id = job.job_id
              AND receipt.state IN ('started', 'applied')
          )
        ORDER BY job.logical_session_id ASC, job.job_id ASC
      `, [leaseOwner]);

      const requeued: StoredBackgroundWorkJob[] = [];
      for (const candidate of candidates.rows) {
        // Serialize against a concurrent boundary crossing for this session: if
        // the worker promotes its receipt first, the re-check below skips it; if
        // this requeue wins, the revision bump makes the worker's next
        // commitEffectBoundary fail ownership before it can write.
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [`background-work:${candidate.logical_session_id}`],
        );
        const updated = await client.query<BackgroundWorkRow>(`
          UPDATE agent_background_work_jobs job
          SET state = 'queued',
              reason_code = $3,
              available_at_ms = $2::bigint,
              updated_at_ms = $2,
              lease_owner = NULL,
              lease_expires_at_ms = NULL,
              deferred_from_state = NULL,
              deferred_from_available_at_ms = NULL,
              welfare_claimed = false,
              revision = revision + 1
          WHERE job.job_id = $1 AND job.state = 'running' AND job.lease_owner = $4
            AND NOT EXISTS (
              SELECT 1 FROM agent_background_work_effect_receipts receipt
              WHERE receipt.job_id = job.job_id
                AND receipt.state IN ('started', 'applied')
            )
          RETURNING ${qualifiedJobColumns('job')}
        `, [candidate.job_id, nowMs, reasonCode, leaseOwner]);
        if (!updated.rows[0]) continue;
        await client.query(`
          DELETE FROM agent_background_work_effect_receipts
          WHERE job_id = $1 AND state = 'pending'
        `, [candidate.job_id]);
        requeued.push(mapRow(updated.rows[0]));
      }
      return requeued;
    });
  }

  async recoverExpired(input: { nowMs: number }): Promise<number> {
    const nowMs = safeInteger(input.nowMs, 'nowMs');
    // A `pending` receipt marks a run that entered but never crossed its write
    // boundary. On lease expiry that work is safely re-runnable, so drop the
    // receipt before classifying: recovery decides from the durable phase, and
    // only a boundary-crossed (`started`) receipt forces outcome-unknown. A
    // pre-boundary crash did not attempt the durable effect, so lease recovery
    // must not consume a work attempt; otherwise maxAttempts=1 loses safe work
    // solely because a graceful-release database call or process failed.
    await this.pool.query(`
      DELETE FROM agent_background_work_effect_receipts receipt
      USING agent_background_work_jobs job
      WHERE receipt.job_id = job.job_id
        AND receipt.state = 'pending'
        AND job.state = 'running'
        AND job.lease_expires_at_ms <= $1
    `, [nowMs]);
    const result = await this.pool.query(`
      WITH unknown_projection AS (
        SELECT
          job.logical_session_id,
          job.source_channel_id,
          job.source_turn_id,
          job.source_request_id,
          job.job_id,
          receipt.effect_key
        FROM agent_background_work_jobs job
        JOIN agent_background_work_effect_receipts receipt ON receipt.job_id = job.job_id
        WHERE job.state = 'running' AND job.lease_expires_at_ms <= $1
          AND receipt.state = 'started'
          AND receipt.projects_subsystem_outputs = true
      ), recorded_unknown_projection AS (
        INSERT INTO agent_turn_subsystem_output_status (
          logical_session_id, source_channel_id, source_turn_id, source_request_id,
          status, source_job_id, source_effect_key, recorded_at_ms
        )
        SELECT
          logical_session_id, source_channel_id, source_turn_id, source_request_id,
          'outcome_unknown', job_id, effect_key, $1
        FROM unknown_projection
        ON CONFLICT (
          logical_session_id, source_channel_id, source_turn_id, source_request_id
        ) DO NOTHING
      )
      UPDATE agent_background_work_jobs
      SET attempt_count = CASE
            WHEN EXISTS (
              SELECT 1 FROM agent_background_work_effect_receipts receipt
              WHERE receipt.job_id = agent_background_work_jobs.job_id
                AND receipt.state = 'started'
            ) THEN attempt_count + 1
            ELSE attempt_count
          END,
          state = CASE
            WHEN EXISTS (
              SELECT 1 FROM agent_background_work_effect_receipts receipt
              WHERE receipt.job_id = agent_background_work_jobs.job_id
                AND receipt.state = 'started'
            ) THEN 'failed'
            ELSE 'retry_wait'
          END,
          reason_code = CASE
            WHEN EXISTS (
              SELECT 1 FROM agent_background_work_effect_receipts receipt
              WHERE receipt.job_id = agent_background_work_jobs.job_id
                AND receipt.state = 'started'
            ) THEN 'effect_outcome_unknown'
            ELSE 'lease_expired'
          END,
          available_at_ms = $1::bigint,
          completed_at_ms = CASE
            WHEN EXISTS (
              SELECT 1 FROM agent_background_work_effect_receipts receipt
              WHERE receipt.job_id = agent_background_work_jobs.job_id
                AND receipt.state = 'started'
            ) THEN $1::bigint
            ELSE NULL::bigint
          END,
          updated_at_ms = $1,
          lease_owner = NULL,
          lease_expires_at_ms = NULL,
          deferred_from_state = NULL,
          deferred_from_available_at_ms = NULL,
          welfare_claimed = false,
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

  async countPending(): Promise<number> {
    const row = await queryOne<{ count: string }>(this.pool, `
      SELECT COUNT(*)::text AS count
      FROM agent_background_work_jobs
      WHERE state IN ('queued', 'deferred', 'retry_wait', 'running')
    `);
    return row ? safeInteger(row.count, 'pending count') : 0;
  }

  async get(jobId: string): Promise<StoredBackgroundWorkJob | null> {
    const row = await queryOne<BackgroundWorkRow>(this.pool, `
      SELECT ${JOB_COLUMNS}
      FROM agent_background_work_jobs
      WHERE job_id = $1
    `, [requireText(jobId, 'jobId')]);
    return row ? mapRow(row) : null;
  }

  async listSubsystemOutputRefs(input: {
    logicalSessionId: string;
    sourceChannelId: string;
    sourceTurnId: string;
    sourceRequestId: string;
  }): Promise<string[]> {
    return (await this.getSubsystemOutputProjection(input)).outputRefs;
  }

  async getSubsystemOutputProjection(input: {
    logicalSessionId: string;
    sourceChannelId: string;
    sourceTurnId: string;
    sourceRequestId: string;
  }): Promise<SubsystemOutputProjection> {
    const params = [
      requireText(input.logicalSessionId, 'logicalSessionId'),
      requireText(input.sourceChannelId, 'sourceChannelId'),
      requireText(input.sourceTurnId, 'sourceTurnId'),
      requireText(input.sourceRequestId, 'sourceRequestId'),
    ];
    const row = await queryOne<{
      status: 'applied' | 'failed' | 'outcome_unknown' | null;
      output_refs: string[];
    }>(this.pool, `
      SELECT marker.status, ARRAY(
        SELECT output.output_ref
        FROM agent_turn_subsystem_output_refs output
        WHERE output.logical_session_id = $1 AND output.source_channel_id = $2
          AND output.source_turn_id = $3 AND output.source_request_id = $4
        ORDER BY output.output_ref ASC
      ) AS output_refs
      FROM (SELECT 1) singleton
      LEFT JOIN agent_turn_subsystem_output_status marker
        ON marker.logical_session_id = $1 AND marker.source_channel_id = $2
          AND marker.source_turn_id = $3 AND marker.source_request_id = $4
    `, params);
    if (!row) throw new Error('Subsystem output projection query returned no row');
    const outputRefs = row.output_refs.map((outputRef) => {
      parseSubsystemOutputRef(outputRef);
      return outputRef;
    });
    if (!row.status && outputRefs.length > 0) {
      throw new Error('Subsystem output refs exist without a projection status');
    }
    return { status: row.status ?? 'pending', outputRefs };
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
    return withPostgresClient(this.pool, async (client) => {
      const jobId = requireText(input.jobId, 'jobId');
      const leaseOwner = requireText(input.leaseOwner, 'leaseOwner');
      const expectedRevision = positiveInteger(input.expectedRevision, 'expectedRevision');
      const nowMs = safeInteger(input.nowMs, 'nowMs');
      const updated = await client.query<BackgroundWorkRow>(`
        UPDATE agent_background_work_jobs
        SET state = $5,
            reason_code = $6,
            completed_at_ms = $4,
            updated_at_ms = $4,
            lease_owner = NULL,
            lease_expires_at_ms = NULL,
            deferred_from_state = NULL,
            deferred_from_available_at_ms = NULL,
            welfare_claimed = false,
            defer_count = 0,
            first_deferred_at_ms = NULL,
            revision = revision + 1
        WHERE job_id = $1 AND state = 'running' AND lease_owner = $2 AND revision = $3
        RETURNING ${JOB_COLUMNS}
      `, [jobId, leaseOwner, expectedRevision, nowMs, state, input.reasonCode]);
      if (updated.rowCount !== 1) return requireTransitionRow(undefined, jobId);
      const row = updated.rows[0]!;
      if (row.kind === 'memory_extraction') {
        const status = input.reasonCode === 'effect_outcome_unknown'
          ? 'outcome_unknown'
          : 'failed';
        await this.recordTerminalSubsystemProjection(
          client,
          row,
          status,
          'memory-extraction',
          nowMs,
        );
      }
      return mapRow(row);
    });
  }

  private async recordTerminalSubsystemProjection(
    client: PoolClient,
    job: BackgroundWorkRow,
    status: 'failed' | 'outcome_unknown',
    effectKey: string,
    nowMs: number,
  ): Promise<void> {
    const inserted = await client.query<{ status: string }>(`
      INSERT INTO agent_turn_subsystem_output_status (
        logical_session_id, source_channel_id, source_turn_id, source_request_id,
        status, source_job_id, source_effect_key, recorded_at_ms
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (
        logical_session_id, source_channel_id, source_turn_id, source_request_id
      ) DO NOTHING
      RETURNING status
    `, [
      job.logical_session_id,
      job.source_channel_id,
      job.source_turn_id,
      job.source_request_id,
      status,
      job.job_id,
      effectKey,
      nowMs,
    ]);
    if (inserted.rowCount === 1) return;
    const incumbent = await client.query<{ status: string }>(`
      SELECT status
      FROM agent_turn_subsystem_output_status
      WHERE logical_session_id = $1 AND source_channel_id = $2
        AND source_turn_id = $3 AND source_request_id = $4
    `, [
      job.logical_session_id,
      job.source_channel_id,
      job.source_turn_id,
      job.source_request_id,
    ]);
    if (incumbent.rows[0]?.status !== status && incumbent.rows[0]?.status !== 'applied') {
      throw new Error(`Subsystem output terminal projection conflict for ${job.job_id}`);
    }
  }
}
