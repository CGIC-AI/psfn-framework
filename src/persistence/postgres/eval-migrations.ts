export const POSTGRES_INTROSPECTION_MIGRATIONS = [
  `
  CREATE TABLE IF NOT EXISTS introspection_landmarks (
    id TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL DEFAULT 1,
    source_ref TEXT NOT NULL UNIQUE,
    channel_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    divergence_type TEXT NOT NULL,
    observation TEXT NOT NULL,
    confidence DOUBLE PRECISION NOT NULL,
    companion_reflection TEXT NOT NULL,
    consent_revision INTEGER NOT NULL,
    consent_hash TEXT NOT NULL,
    stable_estimator_model TEXT NOT NULL,
    divergence_auditor_model TEXT NOT NULL,
    companion_reflector_model TEXT NOT NULL,
    provenance_json JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    UNIQUE (id, source_ref),
    CHECK (schema_version = 1),
    CHECK (char_length(id) BETWEEN 1 AND 256),
    CHECK (char_length(source_ref) BETWEEN 1 AND 1024),
    CHECK (char_length(channel_id) BETWEEN 1 AND 512),
    CHECK (char_length(turn_id) BETWEEN 1 AND 512),
    CHECK (divergence_type IN ('affective', 'substantive')),
    CHECK (char_length(observation) BETWEEN 1 AND 32768),
    CHECK (confidence >= 0 AND confidence <= 1 AND confidence <> 'NaN'::double precision),
    CHECK (char_length(companion_reflection) BETWEEN 1 AND 32768),
    CHECK (consent_revision >= 1),
    CHECK (consent_hash ~ '^[0-9a-f]{64}$'),
    CHECK (char_length(stable_estimator_model) BETWEEN 1 AND 512),
    CHECK (char_length(divergence_auditor_model) BETWEEN 1 AND 512),
    CHECK (char_length(companion_reflector_model) BETWEEN 1 AND 512),
    CHECK (jsonb_typeof(provenance_json) = 'object'),
    CHECK (provenance_json <> '{}'::jsonb),
    CHECK (octet_length(provenance_json::text) <= 65536)
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS introspection_audit_decisions (
    source_ref TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL DEFAULT 1,
    outcome TEXT NOT NULL,
    confidence DOUBLE PRECISION,
    landmark_id TEXT,
    consent_revision INTEGER NOT NULL,
    consent_hash TEXT NOT NULL,
    provenance_json JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    CHECK (schema_version = 1),
    CHECK (char_length(source_ref) BETWEEN 1 AND 1024),
    CHECK (outcome IN ('no_divergence', 'below_confidence', 'landmark_created')),
    CHECK (confidence IS NULL OR (
      confidence >= 0 AND confidence <= 1 AND confidence <> 'NaN'::double precision
    )),
    CHECK (
      (outcome = 'landmark_created' AND landmark_id IS NOT NULL AND confidence IS NOT NULL)
      OR (outcome = 'below_confidence' AND landmark_id IS NULL AND confidence IS NOT NULL)
      OR (outcome = 'no_divergence' AND landmark_id IS NULL)
    ),
    CHECK (consent_revision >= 1),
    CHECK (consent_hash ~ '^[0-9a-f]{64}$'),
    CHECK (jsonb_typeof(provenance_json) = 'object'),
    CHECK (provenance_json <> '{}'::jsonb),
    CHECK (octet_length(provenance_json::text) <= 65536),
    FOREIGN KEY (landmark_id, source_ref)
      REFERENCES introspection_landmarks(id, source_ref)
      ON UPDATE RESTRICT
      ON DELETE RESTRICT
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_introspection_landmarks_created_at ON introspection_landmarks(created_at DESC, id DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_introspection_landmarks_consent_revision ON introspection_landmarks(consent_revision, created_at DESC, id DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_introspection_audit_decisions_created_at ON introspection_audit_decisions(created_at DESC, source_ref);`,
  `
  CREATE OR REPLACE FUNCTION reject_introspection_ledger_mutation()
  RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF TG_OP IN ('UPDATE', 'DELETE', 'TRUNCATE') THEN
      RAISE EXCEPTION '% is append-only: % is forbidden', TG_TABLE_NAME, TG_OP
        USING ERRCODE = '55000';
    END IF;
    RETURN NULL;
  END;
  $$;
  `,
  `
  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgname = 'introspection_landmarks_append_only'
        AND tgrelid = 'introspection_landmarks'::regclass
        AND NOT tgisinternal
    ) THEN
      CREATE TRIGGER introspection_landmarks_append_only
      BEFORE UPDATE OR DELETE ON introspection_landmarks
      FOR EACH ROW EXECUTE FUNCTION reject_introspection_ledger_mutation();
    END IF;
  END;
  $$;
  `,
  `
  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgname = 'introspection_landmarks_no_truncate'
        AND tgrelid = 'introspection_landmarks'::regclass
        AND NOT tgisinternal
    ) THEN
      CREATE TRIGGER introspection_landmarks_no_truncate
      BEFORE TRUNCATE ON introspection_landmarks
      FOR EACH STATEMENT EXECUTE FUNCTION reject_introspection_ledger_mutation();
    END IF;
  END;
  $$;
  `,
  `
  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgname = 'introspection_audit_decisions_append_only'
        AND tgrelid = 'introspection_audit_decisions'::regclass
        AND NOT tgisinternal
    ) THEN
      CREATE TRIGGER introspection_audit_decisions_append_only
      BEFORE UPDATE OR DELETE ON introspection_audit_decisions
      FOR EACH ROW EXECUTE FUNCTION reject_introspection_ledger_mutation();
    END IF;
  END;
  $$;
  `,
  `
  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgname = 'introspection_audit_decisions_no_truncate'
        AND tgrelid = 'introspection_audit_decisions'::regclass
        AND NOT tgisinternal
    ) THEN
      CREATE TRIGGER introspection_audit_decisions_no_truncate
      BEFORE TRUNCATE ON introspection_audit_decisions
      FOR EACH STATEMENT EXECUTE FUNCTION reject_introspection_ledger_mutation();
    END IF;
  END;
  $$;
  `,
];

export const POSTGRES_OBSERVER_EVAL_SIDECAR_MIGRATIONS = [
  `
  CREATE TABLE IF NOT EXISTS observer_eval_sidecar_runs (
    run_id TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL DEFAULT 1,
    eval_owner TEXT NOT NULL DEFAULT 'observer_sidecar_eval',
    authoritative BOOLEAN NOT NULL DEFAULT FALSE,
    sidecar_id TEXT NOT NULL,
    deployment TEXT NOT NULL,
    eval_session_id TEXT,
    scenario_id TEXT,
    test_run_id TEXT,
    status TEXT NOT NULL,
    started_at_ms BIGINT NOT NULL,
    completed_at_ms BIGINT,
    metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    retention_json JSONB NOT NULL,
    retain_until_ms BIGINT NOT NULL,
    created_at_ms BIGINT NOT NULL,
    updated_at_ms BIGINT NOT NULL,
    CHECK (schema_version = 1),
    CHECK (eval_owner = 'observer_sidecar_eval'),
    CHECK (authoritative = FALSE),
    CHECK (deployment IN ('live', 'eval', 'test')),
    CHECK (status IN ('running', 'completed', 'degraded', 'failed')),
    CHECK (completed_at_ms IS NULL OR completed_at_ms >= started_at_ms),
    CHECK (retain_until_ms >= started_at_ms)
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_observer_eval_sidecar_runs_session ON observer_eval_sidecar_runs(eval_session_id, started_at_ms DESC, run_id) WHERE eval_session_id IS NOT NULL;`,
  `CREATE INDEX IF NOT EXISTS idx_observer_eval_sidecar_runs_scenario ON observer_eval_sidecar_runs(scenario_id, test_run_id, started_at_ms DESC, run_id);`,
  `CREATE INDEX IF NOT EXISTS idx_observer_eval_sidecar_runs_status ON observer_eval_sidecar_runs(status, updated_at_ms DESC, run_id);`,
  `CREATE INDEX IF NOT EXISTS idx_observer_eval_sidecar_runs_retention ON observer_eval_sidecar_runs(retain_until_ms, run_id);`,
  `CREATE INDEX IF NOT EXISTS idx_observer_eval_sidecar_runs_metadata_gin ON observer_eval_sidecar_runs USING GIN (metadata_json);`,
  `
  CREATE TABLE IF NOT EXISTS observer_eval_sidecar_observations (
    observation_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES observer_eval_sidecar_runs(run_id) ON DELETE CASCADE,
    schema_version INTEGER NOT NULL DEFAULT 1,
    eval_owner TEXT NOT NULL DEFAULT 'observer_sidecar_eval',
    authoritative BOOLEAN NOT NULL DEFAULT FALSE,
    turn_id TEXT NOT NULL,
    captured_at_ms BIGINT NOT NULL,
    observed_at_ms BIGINT NOT NULL,
    status TEXT NOT NULL,
    privacy_class TEXT NOT NULL,
    sensitivity TEXT,
    channel_visibility TEXT,
    redaction_reason TEXT NOT NULL,
    raw_content_redacted BOOLEAN NOT NULL DEFAULT TRUE,
    sensitive_identifiers_redacted BOOLEAN NOT NULL DEFAULT TRUE,
    derived_telemetry_permitted BOOLEAN NOT NULL,
    psfn_emotion_snapshot_ref TEXT,
    psfn_emotion_snapshot_json JSONB,
    psfn_emotion_appraisal_entry_count BIGINT,
    psfn_emotion_snapshot_source TEXT,
    observer_input_json JSONB NOT NULL,
    projected_appraisal_json JSONB,
    emosim_output_json JSONB,
    crosswalk_json JSONB,
    comparison_metrics_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    divergence_score DOUBLE PRECISION,
    error_json JSONB,
    degraded_state_json JSONB,
    metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    retention_json JSONB NOT NULL,
    retain_until_ms BIGINT NOT NULL,
    created_at_ms BIGINT NOT NULL,
    CHECK (schema_version = 1),
    CHECK (eval_owner = 'observer_sidecar_eval'),
    CHECK (authoritative = FALSE),
    CHECK (status IN ('ok', 'degraded', 'error')),
    CHECK (privacy_class IN ('public', 'private', 'restricted', 'closed', 'fail_closed')),
    CHECK (divergence_score IS NULL OR divergence_score >= 0),
    CHECK (retain_until_ms >= observed_at_ms)
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_observer_eval_sidecar_observations_run_latest ON observer_eval_sidecar_observations(run_id, observed_at_ms DESC, observation_id DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_observer_eval_sidecar_observations_turn ON observer_eval_sidecar_observations(turn_id, observed_at_ms DESC, observation_id DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_observer_eval_sidecar_observations_time ON observer_eval_sidecar_observations(observed_at_ms DESC, observation_id DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_observer_eval_sidecar_observations_privacy ON observer_eval_sidecar_observations(privacy_class, observed_at_ms DESC, observation_id DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_observer_eval_sidecar_observations_divergence ON observer_eval_sidecar_observations(divergence_score DESC NULLS LAST, observed_at_ms DESC, observation_id DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_observer_eval_sidecar_observations_retention ON observer_eval_sidecar_observations(retain_until_ms, observation_id);`,
  `CREATE INDEX IF NOT EXISTS idx_observer_eval_sidecar_observations_input_gin ON observer_eval_sidecar_observations USING GIN (observer_input_json);`,
  `CREATE INDEX IF NOT EXISTS idx_observer_eval_sidecar_observations_appraisal_gin ON observer_eval_sidecar_observations USING GIN (projected_appraisal_json);`,
  `CREATE INDEX IF NOT EXISTS idx_observer_eval_sidecar_observations_emosim_gin ON observer_eval_sidecar_observations USING GIN (emosim_output_json);`,
  `CREATE INDEX IF NOT EXISTS idx_observer_eval_sidecar_observations_crosswalk_gin ON observer_eval_sidecar_observations USING GIN (crosswalk_json);`,
  `CREATE INDEX IF NOT EXISTS idx_observer_eval_sidecar_observations_metrics_gin ON observer_eval_sidecar_observations USING GIN (comparison_metrics_json);`,
  `
  CREATE TABLE IF NOT EXISTS observer_eval_sidecar_lever_events (
    event_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES observer_eval_sidecar_runs(run_id) ON DELETE CASCADE,
    schema_version INTEGER NOT NULL DEFAULT 1,
    eval_owner TEXT NOT NULL DEFAULT 'observer_sidecar_eval',
    authoritative BOOLEAN NOT NULL DEFAULT FALSE,
    lever TEXT NOT NULL,
    fired_at_ms BIGINT NOT NULL,
    observation_id TEXT NOT NULL,
    detail TEXT NOT NULL,
    state_values_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    sustain_ms BIGINT NOT NULL,
    first_crossing_ms BIGINT NOT NULL,
    cooldown_json JSONB NOT NULL,
    retention_json JSONB NOT NULL,
    retain_until_ms BIGINT NOT NULL,
    created_at_ms BIGINT NOT NULL,
    CHECK (schema_version = 1),
    CHECK (eval_owner = 'observer_sidecar_eval'),
    CHECK (authoritative = FALSE),
    CHECK (lever IN ('would_message', 'would_check_in', 'would_rest', 'rumination_watch')),
    CHECK (sustain_ms >= 0),
    CHECK (first_crossing_ms <= fired_at_ms),
    CHECK (retain_until_ms >= fired_at_ms)
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_observer_eval_sidecar_lever_events_lever ON observer_eval_sidecar_lever_events(lever, fired_at_ms DESC, event_id DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_observer_eval_sidecar_lever_events_time ON observer_eval_sidecar_lever_events(fired_at_ms DESC, event_id DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_observer_eval_sidecar_lever_events_run ON observer_eval_sidecar_lever_events(run_id, fired_at_ms DESC, event_id DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_observer_eval_sidecar_lever_events_retention ON observer_eval_sidecar_lever_events(retain_until_ms, event_id);`,
  `
  CREATE TABLE IF NOT EXISTS observer_eval_sidecar_lever_state (
    sidecar_id TEXT NOT NULL,
    lever TEXT NOT NULL,
    schema_version INTEGER NOT NULL DEFAULT 1,
    eval_owner TEXT NOT NULL DEFAULT 'observer_sidecar_eval',
    authoritative BOOLEAN NOT NULL DEFAULT FALSE,
    state_json JSONB NOT NULL,
    updated_at_ms BIGINT NOT NULL,
    PRIMARY KEY (sidecar_id, lever),
    CHECK (schema_version = 1),
    CHECK (eval_owner = 'observer_sidecar_eval'),
    CHECK (authoritative = FALSE),
    CHECK (lever IN ('would_message', 'would_check_in', 'would_rest', 'rumination_watch'))
  );
  `,
  // psfnEmotion metadata columns: rows written before these existed are
  // backfilled from observer_input_json, which is what the old read path
  // reconstructed them from; new writes persist the caller's psfnEmotion.
  `ALTER TABLE observer_eval_sidecar_observations ADD COLUMN IF NOT EXISTS psfn_emotion_appraisal_entry_count BIGINT;`,
  `ALTER TABLE observer_eval_sidecar_observations ADD COLUMN IF NOT EXISTS psfn_emotion_snapshot_source TEXT;`,
  `
  UPDATE observer_eval_sidecar_observations
  SET
    psfn_emotion_appraisal_entry_count = COALESCE(
      psfn_emotion_appraisal_entry_count,
      (observer_input_json->'emotion'->>'appraisalEntryCount')::bigint
    ),
    psfn_emotion_snapshot_source = COALESCE(
      psfn_emotion_snapshot_source,
      observer_input_json->'provenance'->>'emotionSnapshotSource'
    )
  WHERE psfn_emotion_appraisal_entry_count IS NULL
    OR psfn_emotion_snapshot_source IS NULL;
  `,
];
