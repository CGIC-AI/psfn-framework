import type { Pool, QueryResultRow } from 'pg';
import {
  BACKGROUND_WORK_STATES,
  type BackgroundWorkState,
} from '../../core/agent/background-work/types.js';
import { queryRows, withPostgresClient } from '../postgres.js';
import { requireBackgroundWorkSafeInteger as safeInteger } from './row-guards.js';

/**
 * Operator inspection and retirement of durable background-work jobs (bead
 * psfn-framework-gbwpq), the supported replacement for the hand-written UPDATE
 * in docs/operations.md "Recovery: stuck background work".
 *
 * Content-free: rows carry ids, states, counters, and the source channel id,
 * never the payload. Retirement is terminal (`stale_discarded`, reason
 * `operator_retired`) and never touches a job whose lease is still live, so it
 * cannot race the process that holds it.
 */

export interface BackgroundWorkJobSummary {
  jobId: string;
  kind: string;
  state: BackgroundWorkState;
  reasonCode: string;
  attemptCount: number;
  maxAttempts: number;
  leaseExpiryCount: number;
  leaseOwner: string | null;
  leaseExpiresAtMs: number | null;
  sourceChannelId: string;
  sourceTurnId: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface BackgroundWorkJobFilter {
  states?: readonly BackgroundWorkState[];
  /** Exact job ids; mutually exclusive with `channelPrefix`. */
  jobIds?: readonly string[];
  /** `source_channel_id` prefix, e.g. `hub-device:`. */
  channelPrefix?: string;
  limit: number;
}

const TERMINAL_STATES: readonly BackgroundWorkState[] = ['succeeded', 'failed', 'stale_discarded'];

interface JobSummaryRow extends QueryResultRow {
  job_id: string;
  kind: string;
  state: string;
  reason_code: string;
  attempt_count: string | number;
  max_attempts: string | number;
  lease_expiry_count: string | number;
  lease_owner: string | null;
  lease_expires_at_ms: string | number | null;
  source_channel_id: string;
  source_turn_id: string;
  created_at_ms: string | number;
  updated_at_ms: string | number;
}

const SUMMARY_COLUMNS = `job_id, kind, state, reason_code, attempt_count, max_attempts,
  lease_expiry_count, lease_owner, lease_expires_at_ms, source_channel_id, source_turn_id,
  created_at_ms, updated_at_ms`;

function mapRow(row: JobSummaryRow): BackgroundWorkJobSummary {
  if (!(BACKGROUND_WORK_STATES as readonly string[]).includes(row.state)) {
    throw new Error(`Background work job ${row.job_id} holds an unknown state ${row.state}`);
  }
  return {
    jobId: row.job_id,
    kind: row.kind,
    state: row.state as BackgroundWorkState,
    reasonCode: row.reason_code,
    attemptCount: safeInteger(row.attempt_count, 'attempt_count'),
    maxAttempts: safeInteger(row.max_attempts, 'max_attempts'),
    leaseExpiryCount: safeInteger(row.lease_expiry_count, 'lease_expiry_count'),
    leaseOwner: row.lease_owner,
    leaseExpiresAtMs: row.lease_expires_at_ms === null
      ? null
      : safeInteger(row.lease_expires_at_ms, 'lease_expires_at_ms'),
    sourceChannelId: row.source_channel_id,
    sourceTurnId: row.source_turn_id,
    createdAtMs: safeInteger(row.created_at_ms, 'created_at_ms'),
    updatedAtMs: safeInteger(row.updated_at_ms, 'updated_at_ms'),
  };
}

function assertFilter(filter: BackgroundWorkJobFilter): void {
  if (!Number.isSafeInteger(filter.limit) || filter.limit < 1) {
    throw new Error('Background work job listing limit must be a positive integer');
  }
  if (filter.jobIds && filter.channelPrefix !== undefined) {
    throw new Error('Select background work jobs by id or by channel prefix, not both');
  }
  if (filter.channelPrefix !== undefined && filter.channelPrefix.length === 0) {
    throw new Error('Background work channel prefix must be non-empty');
  }
  for (const state of filter.states ?? []) {
    if (!(BACKGROUND_WORK_STATES as readonly string[]).includes(state)) {
      throw new Error(`Unknown background work state ${String(state)}`);
    }
  }
}

function escapeLikePrefix(prefix: string): string {
  return `${prefix.replace(/[\\%_]/gu, match => `\\${match}`)}%`;
}

export async function listBackgroundWorkJobs(
  pool: Pool,
  filter: BackgroundWorkJobFilter,
): Promise<BackgroundWorkJobSummary[]> {
  assertFilter(filter);
  const rows = await queryRows<JobSummaryRow>(pool, `
    SELECT ${SUMMARY_COLUMNS}
    FROM agent_background_work_jobs
    WHERE ($1::text[] IS NULL OR state = ANY($1::text[]))
      AND ($2::text[] IS NULL OR job_id = ANY($2::text[]))
      AND ($3::text IS NULL OR source_channel_id LIKE $3)
    ORDER BY created_at_ms, job_id
    LIMIT $4
  `, [
    filter.states ? [...filter.states] : null,
    filter.jobIds ? [...filter.jobIds] : null,
    filter.channelPrefix !== undefined ? escapeLikePrefix(filter.channelPrefix) : null,
    filter.limit,
  ]);
  return rows.map(mapRow);
}

export interface BackgroundWorkRetirement {
  /** Rows retired (apply) or that would be retired (dry run). */
  retired: BackgroundWorkJobSummary[];
  /** Selected rows left alone because their lease is still live. */
  skippedLiveLease: BackgroundWorkJobSummary[];
  applied: boolean;
}

/**
 * Retire the selected non-terminal jobs. A `running` job is retired only when
 * its lease has expired (its holder is gone); a live lease is reported and
 * skipped. The UPDATE re-checks both conditions, so a job claimed or finished
 * between the read and the write is never overwritten.
 */
export async function retireBackgroundWorkJobs(
  pool: Pool,
  input: {
    jobIds?: readonly string[];
    channelPrefix?: string;
    limit: number;
    nowMs: number;
    apply: boolean;
  },
): Promise<BackgroundWorkRetirement> {
  if (!input.jobIds?.length && input.channelPrefix === undefined) {
    throw new Error('Retiring background work requires --job ids or a --channel-prefix');
  }
  const selected = await listBackgroundWorkJobs(pool, {
    states: BACKGROUND_WORK_STATES.filter(state => !TERMINAL_STATES.includes(state)),
    ...(input.jobIds?.length ? { jobIds: input.jobIds } : {}),
    ...(input.channelPrefix !== undefined ? { channelPrefix: input.channelPrefix } : {}),
    limit: input.limit,
  });
  const isLive = (job: BackgroundWorkJobSummary): boolean => job.state === 'running'
    && job.leaseExpiresAtMs !== null && job.leaseExpiresAtMs > input.nowMs;
  const candidates = selected.filter(job => !isLive(job));
  const skippedLiveLease = selected.filter(isLive);
  if (!input.apply || candidates.length === 0) {
    return { retired: candidates, skippedLiveLease, applied: false };
  }
  const retired = await withPostgresClient(pool, async (client) => {
    const result = await client.query<JobSummaryRow>(`
      UPDATE agent_background_work_jobs
      SET state = 'stale_discarded',
          reason_code = 'operator_retired',
          lease_owner = NULL,
          lease_expires_at_ms = NULL,
          welfare_claimed = false,
          deferred_from_state = NULL,
          deferred_from_available_at_ms = NULL,
          completed_at_ms = $2,
          updated_at_ms = $2,
          revision = revision + 1
      WHERE job_id = ANY($1::text[])
        AND state NOT IN ('succeeded', 'failed', 'stale_discarded')
        AND (state <> 'running' OR lease_expires_at_ms <= $2)
      RETURNING ${SUMMARY_COLUMNS}
    `, [candidates.map(job => job.jobId), input.nowMs]);
    return result.rows.map(mapRow);
  });
  return { retired, skippedLiveLease, applied: true };
}
