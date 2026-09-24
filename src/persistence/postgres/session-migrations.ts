export const POSTGRES_AUDIT_MIGRATIONS = [
  `
  CREATE TABLE IF NOT EXISTS gateway_audit (
    id BIGSERIAL PRIMARY KEY,
    timestamp BIGINT NOT NULL,
    method TEXT NOT NULL,
    decision TEXT NOT NULL,
    params_json TEXT,
    duration_ms BIGINT,
    error TEXT
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_gateway_audit_ts ON gateway_audit(timestamp);`,
  `CREATE INDEX IF NOT EXISTS idx_gateway_audit_method ON gateway_audit(method);`,
  `CREATE INDEX IF NOT EXISTS idx_gateway_audit_decision ON gateway_audit(decision);`,
];

export const POSTGRES_TRANSCRIPT_MIGRATIONS = [
  `
  CREATE TABLE IF NOT EXISTS session_messages_projection (
    channel_id TEXT NOT NULL,
    message_id BIGINT NOT NULL,
    role TEXT NOT NULL,
    author_id TEXT,
    author_name TEXT,
    content TEXT NOT NULL,
    timestamp BIGINT NOT NULL,
    channel_visibility TEXT NOT NULL,
    search_vector tsvector GENERATED ALWAYS AS (
      to_tsvector('simple', coalesce(content, ''))
    ) STORED,
    PRIMARY KEY (channel_id, message_id)
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_session_messages_projection_channel_timestamp ON session_messages_projection(channel_id, timestamp DESC, message_id DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_session_messages_projection_search_vector ON session_messages_projection USING GIN(search_vector);`,
  `ALTER TABLE session_messages_projection ADD COLUMN IF NOT EXISTS metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb;`,
  `
  CREATE TABLE IF NOT EXISTS session_conversational_activity (
    logical_session_id TEXT NOT NULL,
    message_revision BIGINT NOT NULL,
    activity_kind TEXT NOT NULL CHECK (activity_kind IN (
      'direct_message',
      'group_conversation',
      'inter_companion',
      'experiential_free_time',
      'automation_scaffold',
      'journal',
      'health',
      'maintenance',
      'testing'
    )),
    processable BOOLEAN NOT NULL,
    occurred_at_ms BIGINT NOT NULL,
    PRIMARY KEY (logical_session_id, message_revision),
    CHECK (processable = (activity_kind IN (
      'direct_message',
      'group_conversation',
      'inter_companion',
      'experiential_free_time'
    )))
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_session_conversational_activity_workset
    ON session_conversational_activity(logical_session_id, message_revision DESC)
    WHERE processable = TRUE;`,
  `
  CREATE TABLE IF NOT EXISTS session_conversational_workset (
    purpose TEXT NOT NULL CHECK (purpose IN ('episodic_synthesis', 'sleeptime_consolidation')),
    logical_session_id TEXT NOT NULL,
    checkpoint_revision BIGINT NOT NULL DEFAULT 0 CHECK (checkpoint_revision >= 0),
    claimed_revision BIGINT,
    claimed_by TEXT,
    claimed_at_ms BIGINT,
    completed_stages JSONB NOT NULL DEFAULT '[]'::jsonb,
    failed_stage TEXT,
    failure_message TEXT,
    failed_at_ms BIGINT,
    updated_at_ms BIGINT NOT NULL,
    PRIMARY KEY (purpose, logical_session_id),
    CHECK (
      (claimed_revision IS NULL AND claimed_by IS NULL AND claimed_at_ms IS NULL)
      OR (claimed_revision > checkpoint_revision AND claimed_by <> '' AND claimed_at_ms >= 0)
    )
  );
  `,
  `ALTER TABLE session_conversational_workset ADD COLUMN IF NOT EXISTS completed_stages JSONB NOT NULL DEFAULT '[]'::jsonb;`,
  `ALTER TABLE session_conversational_workset ADD COLUMN IF NOT EXISTS failed_stage TEXT;`,
  `ALTER TABLE session_conversational_workset ADD COLUMN IF NOT EXISTS failure_message TEXT;`,
  `ALTER TABLE session_conversational_workset ADD COLUMN IF NOT EXISTS failed_at_ms BIGINT;`,
  `
  CREATE TABLE IF NOT EXISTS session_message_addressing_quarantine (
    channel_id TEXT NOT NULL,
    message_id BIGINT NOT NULL,
    reason TEXT NOT NULL,
    addressing_fingerprint TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    PRIMARY KEY (channel_id, message_id)
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_session_message_addressing_quarantine_reason
    ON session_message_addressing_quarantine(reason, channel_id, message_id);`,
  `
  CREATE TABLE IF NOT EXISTS session_projection_drift (
    channel_id TEXT PRIMARY KEY,
    reason TEXT,
    marked_at BIGINT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'sync'
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_session_projection_drift_marked_at ON session_projection_drift(marked_at DESC, channel_id ASC);`,
  // Bead 6oott: distinguish best-effort 'sync' drift from fail-closed
  // 'redaction' drift (a redaction-carrying projection write failed, so the
  // projection may still hold content canon has redacted). Existing rows
  // backfill to 'sync', matching their pre-migration best-effort semantics.
  `ALTER TABLE session_projection_drift ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'sync';`,
];

export const POSTGRES_INTERNAL_STATE_MIGRATIONS = [
  `
  CREATE TABLE IF NOT EXISTS internal_state_snapshots (
    id TEXT PRIMARY KEY,
    state JSONB NOT NULL,
    snapshot_ref TEXT NOT NULL,
    metacognitive_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
    saved_at TEXT NOT NULL
  );
  `,
];

export const POSTGRES_PARTICIPANT_TREND_MIGRATIONS = [
  `
  CREATE TABLE IF NOT EXISTS participant_emotion_trends (
    room_key TEXT NOT NULL,
    participant_key TEXT NOT NULL,
    vad JSONB NOT NULL,
    discrete JSONB NOT NULL DEFAULT '{}'::jsonb,
    interaction_count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (room_key, participant_key)
  );
  `,
  `
  CREATE INDEX IF NOT EXISTS participant_emotion_trends_updated_at_idx
    ON participant_emotion_trends (updated_at);
  `,
];

export const POSTGRES_REFLECTION_MIGRATIONS = [
  `
  CREATE TABLE IF NOT EXISTS reflections (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    template_id TEXT,
    template_name TEXT,
    execution_source TEXT,
    initiator_surface TEXT NOT NULL,
    initiated_by TEXT NOT NULL,
    reason TEXT,
    channel_id TEXT,
    send_to_discord_effective BOOLEAN,
    mode TEXT,
    internal_state_snapshot_ref TEXT,
    metacognitive_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
    reflection_journal_entry_id TEXT,
    daily_journal_entry_id TEXT,
    process_id TEXT,
    mutation_before JSONB,
    mutation_after JSONB,
    prompt TEXT,
    reflection TEXT,
    deliberation JSONB,
    substrate_boundary TEXT,
    substrate_provenance_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
    payload JSONB NOT NULL,
    mirrored_at TEXT NOT NULL
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_reflections_occurred_at ON reflections(occurred_at DESC, id DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_reflections_kind ON reflections(kind, occurred_at DESC, id DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_reflections_template ON reflections(template_id, occurred_at DESC, id DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_reflections_process ON reflections(process_id, occurred_at DESC, id DESC);`,
];
