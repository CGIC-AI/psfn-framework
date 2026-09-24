import type { Pool, QueryResultRow } from 'pg';

import type {
  BackgroundWorkRunLinkageJob,
  BackgroundWorkRunLinkageKeys,
} from '../../core/agent/background-work/automata-run-redelivery.js';
import { BACKGROUND_WORK_STATES, type BackgroundWorkState } from '../../core/agent/background-work/types.js';
import { requireBackgroundWorkSafeInteger as safeInteger } from './row-guards.js';

interface RunLinkageRow extends QueryResultRow {
  job_id: string;
  kind: string;
  state: string;
  source_request_id: string;
  source_turn_id: string;
  attempt_count: number | string;
  lease_expires_at_ms: number | string | null;
  lease_expiry_count: number | string;
  boundary_crossed: boolean;
}

function parseState(value: string): BackgroundWorkState {
  if (!(BACKGROUND_WORK_STATES as readonly string[]).includes(value)) {
    throw new Error(`Unknown background work state in run linkage: ${value}`);
  }
  return value as BackgroundWorkState;
}

/**
 * Non-terminal background-work jobs whose request, job, or turn id matches a
 * restart-linkage key, with the expiry-sweep inputs (`boundary_crossed` is the
 * same `started`-receipt test the sweep uses) that decide whether each will
 * ever be claimed again.
 */
export async function listNonTerminalBackgroundWorkJobsForRunLinkage(
  pool: Pool,
  keys: BackgroundWorkRunLinkageKeys,
): Promise<BackgroundWorkRunLinkageJob[]> {
  const result = await pool.query<RunLinkageRow>(`
    SELECT
      job.job_id,
      job.kind,
      job.state,
      job.source_request_id,
      job.source_turn_id,
      job.attempt_count,
      job.lease_expires_at_ms,
      job.lease_expiry_count,
      EXISTS (
        SELECT 1 FROM agent_background_work_effect_receipts receipt
        WHERE receipt.job_id = job.job_id AND receipt.state = 'started'
      ) AS boundary_crossed
    FROM agent_background_work_jobs job
    WHERE job.state IN ('queued', 'deferred', 'retry_wait', 'running')
      AND (
        job.source_request_id = ANY($1::text[])
        OR job.job_id = ANY($2::text[])
        OR job.source_turn_id = ANY($3::text[])
      )
    ORDER BY job.job_id ASC
  `, [[...keys.sourceRequestIds], [...keys.jobIds], [...keys.sourceTurnIds]]);
  return result.rows.map(row => {
    const leaseExpiresAtMs = row.lease_expires_at_ms === null
      ? undefined
      : safeInteger(row.lease_expires_at_ms, 'leaseExpiresAtMs');
    return {
      jobId: row.job_id,
      kind: row.kind,
      state: parseState(row.state),
      sourceRequestId: row.source_request_id,
      sourceTurnId: row.source_turn_id,
      attemptCount: safeInteger(row.attempt_count, 'attemptCount'),
      ...(leaseExpiresAtMs === undefined ? {} : { leaseExpiresAtMs }),
      leaseExpiryCount: safeInteger(row.lease_expiry_count, 'leaseExpiryCount'),
      boundaryCrossed: row.boundary_crossed === true,
    };
  });
}
