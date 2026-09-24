/** Companion-private durable queue for optional post-turn work (mmo9.3). */
export const POSTGRES_BACKGROUND_WORK_MIGRATIONS = [
  `
  CREATE TABLE IF NOT EXISTS agent_background_work_jobs (
    job_id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    logical_session_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload_schema_version INTEGER NOT NULL,
    payload JSONB NOT NULL,
    payload_fingerprint TEXT NOT NULL,
    source_turn_id TEXT NOT NULL,
    source_request_id TEXT NOT NULL,
    source_channel_id TEXT NOT NULL,
    state TEXT NOT NULL,
    reason_code TEXT NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL,
    created_at_ms BIGINT NOT NULL,
    available_at_ms BIGINT NOT NULL,
    updated_at_ms BIGINT NOT NULL,
    lease_owner TEXT,
    lease_expires_at_ms BIGINT,
    completed_at_ms BIGINT,
    revision INTEGER NOT NULL DEFAULT 1,
    deferred_from_state TEXT,
    deferred_from_available_at_ms BIGINT,
    CHECK (kind IN (
      'memory_extraction',
      'intention_post_turn_hooks',
      'emotion_appraisal',
      'auto_compaction'
    )),
    CHECK (payload_schema_version = 1),
    CHECK (state IN (
      'queued', 'deferred', 'retry_wait', 'running',
      'succeeded', 'failed', 'stale_discarded'
    )),
    CHECK (reason_code IN (
      'enqueued', 'deduplicated', 'foreground_active', 'started', 'completed',
      'handler_failed', 'retry_scheduled', 'retry_exhausted', 'lease_expired',
      'shutdown', 'source_not_ready', 'source_missing', 'source_mismatch',
      'superseded', 'malformed_payload', 'unknown_kind', 'effect_outcome_unknown'
    )),
    CHECK (attempt_count >= 0),
    CHECK (max_attempts > 0),
    CHECK (attempt_count <= max_attempts),
    CHECK (created_at_ms >= 0 AND available_at_ms >= 0 AND updated_at_ms >= 0),
    CHECK (revision > 0),
    CHECK (deferred_from_state IS NULL OR deferred_from_state IN ('queued', 'retry_wait')),
    CHECK (deferred_from_available_at_ms IS NULL OR deferred_from_available_at_ms >= 0),
    CHECK ((state = 'deferred') OR (
      deferred_from_state IS NULL AND deferred_from_available_at_ms IS NULL
    )),
    CHECK (
      (state = 'running' AND lease_owner IS NOT NULL AND lease_expires_at_ms IS NOT NULL)
      OR (state <> 'running' AND lease_owner IS NULL AND lease_expires_at_ms IS NULL)
    ),
    CHECK (
      (state IN ('succeeded', 'failed', 'stale_discarded') AND completed_at_ms IS NOT NULL)
      OR (state NOT IN ('succeeded', 'failed', 'stale_discarded') AND completed_at_ms IS NULL)
    )
  );
  `,
  `ALTER TABLE agent_background_work_jobs
    ADD COLUMN IF NOT EXISTS deferred_from_state TEXT;`,
  `ALTER TABLE agent_background_work_jobs
    ADD COLUMN IF NOT EXISTS deferred_from_available_at_ms BIGINT;`,
  `ALTER TABLE agent_background_work_jobs
    DROP CONSTRAINT IF EXISTS agent_background_work_jobs_reason_code_check;`,
  `ALTER TABLE agent_background_work_jobs
    ADD CONSTRAINT agent_background_work_jobs_reason_code_check CHECK (reason_code IN (
      'enqueued', 'deduplicated', 'foreground_active', 'started', 'completed',
      'handler_failed', 'retry_scheduled', 'retry_exhausted', 'lease_expired',
      'shutdown', 'source_not_ready', 'source_missing', 'source_mismatch',
      'superseded', 'malformed_payload', 'unknown_kind', 'effect_outcome_unknown'
    ));`,
  `ALTER TABLE agent_background_work_jobs
    DROP CONSTRAINT IF EXISTS agent_background_work_jobs_deferred_from_state_check;`,
  `ALTER TABLE agent_background_work_jobs
    ADD CONSTRAINT agent_background_work_jobs_deferred_from_state_check
      CHECK (deferred_from_state IS NULL OR deferred_from_state IN ('queued', 'retry_wait'));`,
  `
  CREATE TABLE IF NOT EXISTS agent_background_work_foreground_leases (
    lease_id TEXT PRIMARY KEY,
    logical_session_id TEXT NOT NULL,
    lease_owner TEXT NOT NULL,
    acquired_at_ms BIGINT NOT NULL CHECK (acquired_at_ms >= 0),
    expires_at_ms BIGINT NOT NULL CHECK (expires_at_ms >= acquired_at_ms)
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_agent_background_work_foreground_session
    ON agent_background_work_foreground_leases (logical_session_id, expires_at_ms);`,
  `
  CREATE TABLE IF NOT EXISTS agent_background_work_handoffs (
    logical_session_id TEXT NOT NULL,
    source_turn_id TEXT NOT NULL,
    manifest_fingerprint TEXT NOT NULL,
    accepted_at_ms BIGINT NOT NULL CHECK (accepted_at_ms >= 0),
    PRIMARY KEY (logical_session_id, source_turn_id)
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS agent_background_work_effect_receipts (
    job_id TEXT NOT NULL REFERENCES agent_background_work_jobs(job_id) ON DELETE CASCADE,
    effect_key TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'started', 'applied')),
    lease_owner TEXT NOT NULL,
    lease_revision INTEGER NOT NULL CHECK (lease_revision > 0),
    projects_subsystem_outputs BOOLEAN NOT NULL DEFAULT false,
    started_at_ms BIGINT NOT NULL CHECK (started_at_ms >= 0),
    applied_at_ms BIGINT,
    PRIMARY KEY (job_id, effect_key),
    CHECK ((state = 'applied') = (applied_at_ms IS NOT NULL))
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS agent_turn_subsystem_output_refs (
    logical_session_id TEXT NOT NULL,
    source_channel_id TEXT NOT NULL,
    source_turn_id TEXT NOT NULL,
    source_request_id TEXT NOT NULL,
    output_ref TEXT NOT NULL,
    source_job_id TEXT NOT NULL,
    source_effect_key TEXT NOT NULL,
    recorded_at_ms BIGINT NOT NULL CHECK (recorded_at_ms >= 0),
    PRIMARY KEY (logical_session_id, source_channel_id, source_turn_id, source_request_id, output_ref)
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS agent_turn_subsystem_output_status (
    logical_session_id TEXT NOT NULL,
    source_channel_id TEXT NOT NULL,
    source_turn_id TEXT NOT NULL,
    source_request_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('applied', 'failed', 'outcome_unknown')),
    source_job_id TEXT NOT NULL,
    source_effect_key TEXT NOT NULL,
    recorded_at_ms BIGINT NOT NULL CHECK (recorded_at_ms >= 0),
    PRIMARY KEY (logical_session_id, source_channel_id, source_turn_id, source_request_id)
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_agent_turn_subsystem_output_refs_turn
    ON agent_turn_subsystem_output_refs (
      logical_session_id, source_channel_id, source_turn_id, source_request_id
    );`,
  `ALTER TABLE agent_turn_subsystem_output_status
    DROP CONSTRAINT IF EXISTS agent_turn_subsystem_output_status_status_check;`,
  `ALTER TABLE agent_turn_subsystem_output_status
    ADD CONSTRAINT agent_turn_subsystem_output_status_status_check
    CHECK (status IN ('applied', 'failed', 'outcome_unknown'));`,
  `
  CREATE OR REPLACE FUNCTION reject_agent_turn_subsystem_output_ref_mutation()
  RETURNS TRIGGER AS $$
  BEGIN
    RAISE EXCEPTION 'agent_turn_subsystem_output_refs is append-only';
  END;
  $$ LANGUAGE plpgsql;
  `,
  `DROP TRIGGER IF EXISTS trg_agent_turn_subsystem_output_refs_append_only
    ON agent_turn_subsystem_output_refs;`,
  `CREATE TRIGGER trg_agent_turn_subsystem_output_refs_append_only
    BEFORE UPDATE OR DELETE ON agent_turn_subsystem_output_refs
    FOR EACH ROW EXECUTE FUNCTION reject_agent_turn_subsystem_output_ref_mutation();`,
  `DROP TRIGGER IF EXISTS trg_agent_turn_subsystem_output_refs_no_truncate
    ON agent_turn_subsystem_output_refs;`,
  `CREATE TRIGGER trg_agent_turn_subsystem_output_refs_no_truncate
    BEFORE TRUNCATE ON agent_turn_subsystem_output_refs
    FOR EACH STATEMENT EXECUTE FUNCTION reject_agent_turn_subsystem_output_ref_mutation();`,
  `
  CREATE OR REPLACE FUNCTION reject_agent_turn_subsystem_output_status_mutation()
  RETURNS TRIGGER AS $$
  BEGIN
    RAISE EXCEPTION 'agent_turn_subsystem_output_status is append-only';
  END;
  $$ LANGUAGE plpgsql;
  `,
  `DROP TRIGGER IF EXISTS trg_agent_turn_subsystem_output_status_append_only
    ON agent_turn_subsystem_output_status;`,
  `CREATE TRIGGER trg_agent_turn_subsystem_output_status_append_only
    BEFORE UPDATE OR DELETE ON agent_turn_subsystem_output_status
    FOR EACH ROW EXECUTE FUNCTION reject_agent_turn_subsystem_output_status_mutation();`,
  `DROP TRIGGER IF EXISTS trg_agent_turn_subsystem_output_status_no_truncate
    ON agent_turn_subsystem_output_status;`,
  `CREATE TRIGGER trg_agent_turn_subsystem_output_status_no_truncate
    BEFORE TRUNCATE ON agent_turn_subsystem_output_status
    FOR EACH STATEMENT EXECUTE FUNCTION reject_agent_turn_subsystem_output_status_mutation();`,
  `ALTER TABLE agent_background_work_effect_receipts
    ADD COLUMN IF NOT EXISTS lease_revision INTEGER;`,
  `ALTER TABLE agent_background_work_effect_receipts
    ADD COLUMN IF NOT EXISTS projects_subsystem_outputs BOOLEAN NOT NULL DEFAULT false;`,
  `UPDATE agent_background_work_effect_receipts receipt
    SET lease_revision = job.revision
    FROM agent_background_work_jobs job
    WHERE receipt.job_id = job.job_id AND receipt.lease_revision IS NULL;`,
  `ALTER TABLE agent_background_work_effect_receipts
    ALTER COLUMN lease_revision SET NOT NULL;`,
  // A durable phase boundary distinct from handler entry: an effect receipt is
  // 'pending' (run entered, no external write attempted yet — safely
  // cancelable/requeue-able) until the handler crosses its write boundary, at
  // which point it becomes 'started' (outcome ambiguous on interruption) and
  // finally 'applied' (idempotent proof of completion).
  `ALTER TABLE agent_background_work_effect_receipts
    DROP CONSTRAINT IF EXISTS agent_background_work_effect_receipts_state_check;`,
  `ALTER TABLE agent_background_work_effect_receipts
    ADD CONSTRAINT agent_background_work_effect_receipts_state_check
      CHECK (state IN ('pending', 'started', 'applied'));`,
  `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_background_work_one_running_per_session
    ON agent_background_work_jobs (logical_session_id)
    WHERE state = 'running';
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_agent_background_work_runnable
    ON agent_background_work_jobs (available_at_ms ASC, created_at_ms ASC, job_id ASC)
    WHERE state IN ('queued', 'deferred', 'retry_wait');
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_agent_background_work_session_history
    ON agent_background_work_jobs (logical_session_id, created_at_ms ASC, job_id ASC);
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_agent_background_work_terminal_retention
    ON agent_background_work_jobs (completed_at_ms ASC, job_id ASC)
    WHERE state IN ('succeeded', 'failed', 'stale_discarded');
  `,
  // Anti-starvation welfare aging (mmo9.7.4). A background job that
  // is repeatedly deferred by sustained foreground turns accrues durable defer
  // pressure so it can eventually be admitted into a bounded welfare-reserve slot
  // instead of starving forever. `defer_count`/`first_deferred_at_ms` are the
  // aging boost columns the claimNext eligibility predicate reads (an in-memory
  // boost alone cannot survive the process-restart / multi-replica boundary);
  // `welfare_claimed` marks a running job admitted via the welfare bypass so the
  // reserve cap can be counted and the foreground effect-fence can grant it a
  // protected completion. All three are additive with fail-closed defaults, so
  // pre-mmo9.7.4 rows and every non-welfare claim path stay byte-identical.
  `ALTER TABLE agent_background_work_jobs
    ADD COLUMN IF NOT EXISTS defer_count INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE agent_background_work_jobs
    ADD COLUMN IF NOT EXISTS first_deferred_at_ms BIGINT;`,
  `ALTER TABLE agent_background_work_jobs
    ADD COLUMN IF NOT EXISTS welfare_claimed BOOLEAN NOT NULL DEFAULT false;`,
  `ALTER TABLE agent_background_work_jobs
    DROP CONSTRAINT IF EXISTS agent_background_work_jobs_defer_count_check;`,
  `ALTER TABLE agent_background_work_jobs
    ADD CONSTRAINT agent_background_work_jobs_defer_count_check CHECK (defer_count >= 0);`,
  `ALTER TABLE agent_background_work_jobs
    DROP CONSTRAINT IF EXISTS agent_background_work_jobs_first_deferred_at_ms_check;`,
  `ALTER TABLE agent_background_work_jobs
    ADD CONSTRAINT agent_background_work_jobs_first_deferred_at_ms_check
      CHECK (first_deferred_at_ms IS NULL OR first_deferred_at_ms >= 0);`,
  // A welfare_claimed marker is only meaningful while the row is running; a
  // non-running row must never carry it, matching the lease-field invariant.
  `ALTER TABLE agent_background_work_jobs
    DROP CONSTRAINT IF EXISTS agent_background_work_jobs_welfare_claimed_check;`,
  `ALTER TABLE agent_background_work_jobs
    ADD CONSTRAINT agent_background_work_jobs_welfare_claimed_check
      CHECK (state = 'running' OR welfare_claimed = false);`,
  // Bounded welfare-eligibility scan: find the oldest runnable jobs carrying
  // defer pressure without a sequential scan of the whole table.
  `
  CREATE INDEX IF NOT EXISTS idx_agent_background_work_welfare_aging
    ON agent_background_work_jobs (defer_count DESC, first_deferred_at_ms ASC, created_at_ms ASC)
    WHERE state IN ('queued', 'deferred', 'retry_wait');
  `,
  // Count concurrently-running welfare-admitted jobs against the reserve cap.
  `
  CREATE INDEX IF NOT EXISTS idx_agent_background_work_welfare_running
    ON agent_background_work_jobs (welfare_claimed)
    WHERE state = 'running' AND welfare_claimed = true;
  `,
  // Poison-claim budget (bead psfn-framework-52epa). A pre-boundary lease
  // expiry deliberately spends no work attempt, so a claim that dies with its
  // process at every restart was re-leased forever. This separate durable
  // counter lets the expiry sweep fail such a claim after a bounded number of
  // lost process lifetimes. Additive with a fail-closed default.
  `ALTER TABLE agent_background_work_jobs
    ADD COLUMN IF NOT EXISTS lease_expiry_count INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE agent_background_work_jobs
    DROP CONSTRAINT IF EXISTS agent_background_work_jobs_lease_expiry_count_check;`,
  `ALTER TABLE agent_background_work_jobs
    ADD CONSTRAINT agent_background_work_jobs_lease_expiry_count_check
      CHECK (lease_expiry_count >= 0);`,
];

export const POSTGRES_BACKGROUND_WORK_MIGRATION_ADVISORY_LOCK = [
  1_297_431_347,
  1_159_535_447,
] as const;
