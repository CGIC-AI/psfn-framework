export const AUTOMATA_RETENTION_POSTGRES_RELATIONS = [
  'automata_session_classifications',
  'automata_retention_audit_events',
] as const;

/**
 * Migration-owned durable classification and content-free audit schema.
 * Runtime code must receive an already-migrated, companion-scoped pool.
 */
export const AUTOMATA_RETENTION_POSTGRES_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS automata_session_classifications (
    companion_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    ownership TEXT NOT NULL CHECK (
      ownership IN ('automata', 'companion', 'free_time', 'icp', 'contact', 'unknown')
    ),
    classified_at_ms BIGINT NOT NULL CHECK (classified_at_ms >= 0),
    run_id TEXT,
    automaton_class TEXT,
    worker_generation INTEGER,
    retention_deadline_ms BIGINT,
    PRIMARY KEY (companion_id, session_id),
    CHECK (length(btrim(companion_id)) > 0),
    CHECK (length(btrim(session_id)) > 0),
    CHECK (
      (
        ownership = 'automata'
        AND run_id IS NOT NULL
        AND automaton_class IS NOT NULL
        AND worker_generation > 0
        AND retention_deadline_ms >= classified_at_ms
      )
      OR (
        ownership <> 'automata'
        AND run_id IS NULL
        AND automaton_class IS NULL
        AND worker_generation IS NULL
        AND retention_deadline_ms IS NULL
      )
    )
  )`,
  `CREATE INDEX IF NOT EXISTS automata_session_classifications_due_idx
    ON automata_session_classifications (
      companion_id, retention_deadline_ms, session_id
    ) WHERE ownership = 'automata'`,
  `CREATE TABLE IF NOT EXISTS automata_retention_audit_events (
    companion_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    session_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    automaton_class TEXT NOT NULL,
    worker_generation INTEGER NOT NULL CHECK (worker_generation > 0),
    event_kind TEXT NOT NULL CHECK (
      event_kind IN ('retained', 'purge_started', 'purged', 'retryable_failure')
    ),
    reason TEXT NOT NULL CHECK (reason IN (
      'eligible', 'proof_missing', 'target_mismatch', 'generation_not_terminal',
      'run_not_terminal', 'pending_work', 'pending_handoff',
      'artifact_custody_pending', 'promotion_receipt_missing', 'review_pending',
      'retention_window_open', 'shard_unfolded', 'target_changed',
      'evidence_unresolvable', 'purge_incomplete', 'purge_failed', 'already_purged'
    )),
    occurred_at_ms BIGINT NOT NULL CHECK (occurred_at_ms >= 0),
    target_revision TEXT,
    surface_counts_json JSONB CHECK (
      surface_counts_json IS NULL OR jsonb_typeof(surface_counts_json) = 'object'
    ),
    preserved_reference_count INTEGER CHECK (preserved_reference_count >= 0),
    error_digest TEXT CHECK (error_digest ~ '^[0-9a-f]{64}$'),
    PRIMARY KEY (companion_id, event_id),
    CHECK (length(btrim(event_id)) > 0),
    CHECK (length(btrim(attempt_id)) > 0),
    CHECK (length(btrim(run_id)) > 0),
    CHECK (length(btrim(automaton_class)) > 0),
    CHECK (
      (event_kind = 'purged'
        AND target_revision IS NOT NULL
        AND preserved_reference_count IS NOT NULL
        AND surface_counts_json ?& ARRAY[
          'journals', 'journal_rolls', 'channel_index', 'transcript_projection',
          'turn_records', 'redis_tail_pointers'
        ]
        AND surface_counts_json - ARRAY[
          'journals', 'journal_rolls', 'channel_index', 'transcript_projection',
          'turn_records', 'redis_tail_pointers'
        ]::text[] = '{}'::jsonb
        AND error_digest IS NULL)
      OR event_kind <> 'purged'
    ),
    CHECK (
      (event_kind = 'retryable_failure' AND error_digest IS NOT NULL)
      OR event_kind <> 'retryable_failure'
    ),
    FOREIGN KEY (companion_id, session_id)
      REFERENCES automata_session_classifications (companion_id, session_id)
      ON UPDATE RESTRICT ON DELETE RESTRICT
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS automata_retention_one_purge_receipt_idx
    ON automata_retention_audit_events (companion_id, session_id)
    WHERE event_kind = 'purged'`,
  `CREATE INDEX IF NOT EXISTS automata_retention_audit_session_idx
    ON automata_retention_audit_events (companion_id, session_id, occurred_at_ms, event_id)`,
  `CREATE OR REPLACE FUNCTION reject_automata_retention_history_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      RAISE EXCEPTION 'Automata retention history is append-only' USING ERRCODE = '55000';
    END
    $$`,
  `DROP TRIGGER IF EXISTS automata_session_classifications_append_only
    ON automata_session_classifications`,
  `CREATE TRIGGER automata_session_classifications_append_only
    BEFORE UPDATE OR DELETE ON automata_session_classifications
    FOR EACH ROW EXECUTE FUNCTION reject_automata_retention_history_mutation()`,
  `DROP TRIGGER IF EXISTS automata_session_classifications_no_truncate
    ON automata_session_classifications`,
  `CREATE TRIGGER automata_session_classifications_no_truncate
    BEFORE TRUNCATE ON automata_session_classifications
    FOR EACH STATEMENT EXECUTE FUNCTION reject_automata_retention_history_mutation()`,
  `DROP TRIGGER IF EXISTS automata_retention_audit_events_append_only
    ON automata_retention_audit_events`,
  `CREATE TRIGGER automata_retention_audit_events_append_only
    BEFORE UPDATE OR DELETE ON automata_retention_audit_events
    FOR EACH ROW EXECUTE FUNCTION reject_automata_retention_history_mutation()`,
  `DROP TRIGGER IF EXISTS automata_retention_audit_events_no_truncate
    ON automata_retention_audit_events`,
  `CREATE TRIGGER automata_retention_audit_events_no_truncate
    BEFORE TRUNCATE ON automata_retention_audit_events
    FOR EACH STATEMENT EXECUTE FUNCTION reject_automata_retention_history_mutation()`,
] as const;

export const AUTOMATA_RETENTION_POSTGRES_ROLLBACK_STATEMENTS = [
  'DROP TABLE IF EXISTS automata_retention_audit_events',
  'DROP TABLE IF EXISTS automata_session_classifications',
  'DROP FUNCTION IF EXISTS reject_automata_retention_history_mutation()',
] as const;
