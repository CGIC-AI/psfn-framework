export const POSTGRES_MEMORY_MIGRATIONS = [
  `CREATE EXTENSION IF NOT EXISTS vector;`,
  `
  CREATE TABLE IF NOT EXISTS l2_memories (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    type TEXT NOT NULL,
    importance DOUBLE PRECISION NOT NULL,
    confidence DOUBLE PRECISION NOT NULL,
    emotional_valence DOUBLE PRECISION NOT NULL,
    formation_vad JSONB,
    salience DOUBLE PRECISION NOT NULL,
    source_ref TEXT NOT NULL,
    extracted_at BIGINT NOT NULL,
    last_accessed BIGINT NOT NULL,
    access_count INTEGER NOT NULL,
    superseded_by TEXT,
    tags JSONB NOT NULL DEFAULT '[]'::jsonb,
    scope_ref_kind TEXT,
    scope_ref_id TEXT,
    scope_ref_label TEXT,
    scope_tags JSONB NOT NULL DEFAULT '[]'::jsonb,
    provenance_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
    retention_class TEXT,
    sensitivity TEXT NOT NULL DEFAULT 'personal',
    consent_flags JSONB NOT NULL DEFAULT '{}'::jsonb,
    contact_id TEXT,
    deleted_at BIGINT,
    deleted_by TEXT,
    delete_reason TEXT,
    embedding VECTOR
  );
  `,
  `
  DO $$
  BEGIN
    IF EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'l2_memories'
        AND column_name = 'embedding'
        AND udt_name = '_float8'
    ) THEN
      ALTER TABLE l2_memories
      ALTER COLUMN embedding TYPE VECTOR
      USING (
        CASE
          WHEN embedding IS NULL THEN NULL
          ELSE ('[' || array_to_string(embedding, ',') || ']')::vector
        END
      );
    END IF;
  END
  $$;
  `,
  `CREATE INDEX IF NOT EXISTS idx_l2_memories_active ON l2_memories(superseded_by, deleted_at, extracted_at DESC, id DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_l2_memories_contact ON l2_memories(contact_id, deleted_at, extracted_at DESC, id DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_l2_memories_source_ref ON l2_memories(source_ref);`,
  `CREATE INDEX IF NOT EXISTS idx_l2_memories_scope_ref ON l2_memories(scope_ref_kind, scope_ref_id);`,
  `CREATE TABLE IF NOT EXISTS l2_memory_delete_versions (
    delete_id TEXT PRIMARY KEY,
    memory_id TEXT NOT NULL REFERENCES l2_memories(id) ON DELETE CASCADE,
    snapshot_json JSONB NOT NULL,
    deleted_at BIGINT NOT NULL,
    deleted_by TEXT,
    delete_reason TEXT,
    restored_at BIGINT,
    restored_by TEXT
  );`,
  `CREATE INDEX IF NOT EXISTS idx_l2_memory_delete_versions_memory ON l2_memory_delete_versions(memory_id, deleted_at DESC);`,
  `
  CREATE TABLE IF NOT EXISTS l2_memory_abstraction_links (
    id TEXT PRIMARY KEY,
    source_memory_id TEXT NOT NULL REFERENCES l2_memories(id) ON DELETE CASCADE,
    abstracted_memory_id TEXT NOT NULL REFERENCES l2_memories(id) ON DELETE CASCADE,
    external_ref TEXT NOT NULL UNIQUE,
    created_at BIGINT NOT NULL,
    created_by TEXT,
    reason TEXT
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_l2_memory_abstraction_source ON l2_memory_abstraction_links(source_memory_id, created_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_l2_memory_abstraction_abstracted ON l2_memory_abstraction_links(abstracted_memory_id, created_at DESC);`,
  `
  CREATE TABLE IF NOT EXISTS scratchpad_entries (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_scratchpad_entries_updated ON scratchpad_entries(updated_at DESC, created_at DESC);`,
  `
  CREATE TABLE IF NOT EXISTS memory_links (
    id1 TEXT NOT NULL,
    id2 TEXT NOT NULL,
    link_type TEXT NOT NULL DEFAULT 'related',
    created_at BIGINT NOT NULL,
    PRIMARY KEY (id1, id2)
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_memory_links_id1 ON memory_links(id1);`,
  `CREATE INDEX IF NOT EXISTS idx_memory_links_id2 ON memory_links(id2);`,
  `
  CREATE TABLE IF NOT EXISTS contact_profiles (
    contact_id TEXT PRIMARY KEY,
    summary_text TEXT NOT NULL,
    source_memory_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    confidence_score DOUBLE PRECISION NOT NULL,
    novelty_score DOUBLE PRECISION NOT NULL,
    updated_at BIGINT NOT NULL
  );
  `,
];

export const POSTGRES_CONTACT_MIGRATIONS = [
  `
  CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY,
    discord_user_id TEXT UNIQUE,
    display_name TEXT NOT NULL,
    nickname TEXT,
    trust_level TEXT NOT NULL DEFAULT 'regular',
    relationship_type TEXT NOT NULL DEFAULT 'stranger',
    emotional_baseline JSONB NOT NULL DEFAULT '{}'::jsonb,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    notes TEXT,
    channel_identities JSONB NOT NULL DEFAULT '[]'::jsonb,
    conversation_channels JSONB NOT NULL DEFAULT '[]'::jsonb
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_contacts_trust ON contacts(trust_level);`,
  `CREATE INDEX IF NOT EXISTS idx_contacts_discord ON contacts(discord_user_id);`,
  `
  CREATE TABLE IF NOT EXISTS contact_channel_ids (
    contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    channel TEXT NOT NULL,
    channel_user_id TEXT NOT NULL,
    privacy_level TEXT NOT NULL DEFAULT 'semi_private',
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    PRIMARY KEY (channel, channel_user_id)
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_contact_channel_ids_contact ON contact_channel_ids(contact_id);`,
  `
  CREATE TABLE IF NOT EXISTS contact_channel_activity (
    contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    channel TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    privacy_level TEXT,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    PRIMARY KEY (contact_id, channel, channel_id)
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_contact_channel_activity_contact ON contact_channel_activity(contact_id, last_seen DESC);`,
  `
  CREATE TABLE IF NOT EXISTS contact_identity_link_verifications (
    id TEXT PRIMARY KEY,
    contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    source_channel TEXT NOT NULL,
    source_user_id TEXT NOT NULL,
    target_channel TEXT NOT NULL,
    target_user_id TEXT NOT NULL,
    nonce TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    signature TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    verified_at TEXT,
    failure_reason TEXT
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_contact_identity_link_verifications_contact ON contact_identity_link_verifications(contact_id, created_at DESC);`,
  `
  CREATE TABLE IF NOT EXISTS contact_mutation_audit (
    id BIGSERIAL PRIMARY KEY,
    contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    actor TEXT NOT NULL,
    field TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    timestamp TEXT NOT NULL
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_contact_mutation_audit_contact ON contact_mutation_audit(contact_id, timestamp DESC);`,
  `
  CREATE TABLE IF NOT EXISTS social_graph_entities (
    id TEXT PRIMARY KEY,
    entity_kind TEXT NOT NULL DEFAULT 'person',
    display_name TEXT NOT NULL,
    contact_id TEXT UNIQUE,
    sensitivity TEXT NOT NULL DEFAULT 'personal',
    provenance_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
    confidence DOUBLE PRECISION NOT NULL DEFAULT 1,
    source TEXT NOT NULL DEFAULT 'contact',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS social_relationship_edges (
    id TEXT PRIMARY KEY,
    source_entity_id TEXT NOT NULL REFERENCES social_graph_entities(id) ON DELETE CASCADE,
    target_entity_id TEXT NOT NULL REFERENCES social_graph_entities(id) ON DELETE CASCADE,
    relationship_type TEXT NOT NULL,
    directional BOOLEAN NOT NULL DEFAULT TRUE,
    sensitivity TEXT NOT NULL DEFAULT 'personal',
    provenance_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
    evidence_memory_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    confidence DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (source_entity_id, target_entity_id, relationship_type, directional)
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_social_relationship_edges_source ON social_relationship_edges(source_entity_id, updated_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_social_relationship_edges_target ON social_relationship_edges(target_entity_id, updated_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_social_relationship_edges_type ON social_relationship_edges(relationship_type, updated_at DESC);`,
];

export const POSTGRES_INTENTION_MIGRATIONS = [
  `
  CREATE TABLE IF NOT EXISTS active_concerns (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    priority TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    resolved_at TEXT,
    resolution_outcome TEXT,
    contact_id TEXT,
    formation_vad JSONB,
    CHECK (priority IN ('high', 'medium', 'low')),
    CHECK (source IN ('appraisal', 'agent', 'heartbeat'))
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_active_concerns_active ON active_concerns (resolved_at, expires_at, priority, created_at, id);`,
  `CREATE INDEX IF NOT EXISTS idx_active_concerns_contact ON active_concerns (contact_id, resolved_at, expires_at, created_at, id);`,
  `
  CREATE TABLE IF NOT EXISTS intention_pending_follow_ups (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    priority TEXT NOT NULL,
    timing TEXT NOT NULL,
    created_at TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    channel_type TEXT NOT NULL,
    author_id TEXT NOT NULL,
    author_name TEXT NOT NULL,
    due_at TEXT,
    contact_id TEXT,
    source_message_id TEXT,
    activated_at TEXT,
    activation_reason TEXT,
    CHECK (priority IN ('low', 'medium', 'high')),
    CHECK (timing IN ('immediate', 'soon', 'scheduled')),
    CHECK (channel_type IN ('terminal', 'api', 'discord', 'telegram', 'psfn-amica'))
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_intention_pending_follow_ups_active ON intention_pending_follow_ups (activated_at, created_at, id);`,
  `CREATE INDEX IF NOT EXISTS idx_intention_pending_follow_ups_contact ON intention_pending_follow_ups (contact_id, activated_at, created_at, id);`,
  `
  CREATE TABLE IF NOT EXISTS behavioral_pattern_events (
    id TEXT PRIMARY KEY,
    contact_id TEXT NOT NULL,
    source_message_id TEXT NOT NULL,
    strategy TEXT NOT NULL,
    response_excerpt TEXT NOT NULL,
    created_at TEXT NOT NULL,
    outcome_score DOUBLE PRECISION,
    outcome_observed_at TEXT,
    outcome_source_message_id TEXT,
    promoted_at TEXT,
    promoted_memory_id TEXT,
    UNIQUE(contact_id, source_message_id, strategy)
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_behavioral_pattern_events_contact ON behavioral_pattern_events(contact_id, created_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_behavioral_pattern_events_outcome ON behavioral_pattern_events(contact_id, outcome_score DESC NULLS LAST, outcome_observed_at DESC NULLS LAST);`,
];

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
  `
  CREATE TABLE IF NOT EXISTS session_projection_drift (
    channel_id TEXT PRIMARY KEY,
    reason TEXT,
    marked_at BIGINT NOT NULL
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_session_projection_drift_marked_at ON session_projection_drift(marked_at DESC, channel_id ASC);`,
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
