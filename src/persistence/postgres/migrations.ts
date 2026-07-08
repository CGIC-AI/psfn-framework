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
    source_type TEXT NOT NULL DEFAULT 'unknown',
    provenance_json JSONB NOT NULL DEFAULT '{}'::jsonb,
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
  `ALTER TABLE l2_memories ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'unknown';`,
  `ALTER TABLE l2_memories ADD COLUMN IF NOT EXISTS provenance_json JSONB NOT NULL DEFAULT '{}'::jsonb;`,
  `ALTER TABLE l2_memories ADD COLUMN IF NOT EXISTS formation_vad JSONB;`,
  `ALTER TABLE l2_memories ADD COLUMN IF NOT EXISTS scope_ref_kind TEXT;`,
  `ALTER TABLE l2_memories ADD COLUMN IF NOT EXISTS scope_ref_id TEXT;`,
  `ALTER TABLE l2_memories ADD COLUMN IF NOT EXISTS scope_ref_label TEXT;`,
  `ALTER TABLE l2_memories ADD COLUMN IF NOT EXISTS scope_tags JSONB NOT NULL DEFAULT '[]'::jsonb;`,
  `ALTER TABLE l2_memories ADD COLUMN IF NOT EXISTS provenance_refs JSONB NOT NULL DEFAULT '[]'::jsonb;`,
  `ALTER TABLE l2_memories ADD COLUMN IF NOT EXISTS retention_class TEXT;`,
  `ALTER TABLE l2_memories ADD COLUMN IF NOT EXISTS sensitivity TEXT NOT NULL DEFAULT 'personal';`,
  `ALTER TABLE l2_memories ADD COLUMN IF NOT EXISTS consent_flags JSONB NOT NULL DEFAULT '{}'::jsonb;`,
  `ALTER TABLE l2_memories ADD COLUMN IF NOT EXISTS contact_id TEXT;`,
  `ALTER TABLE l2_memories ADD COLUMN IF NOT EXISTS deleted_at BIGINT;`,
  `ALTER TABLE l2_memories ADD COLUMN IF NOT EXISTS deleted_by TEXT;`,
  `ALTER TABLE l2_memories ADD COLUMN IF NOT EXISTS delete_reason TEXT;`,
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
  `CREATE INDEX IF NOT EXISTS idx_l2_memories_admin_type ON l2_memories(type, superseded_by, deleted_at, extracted_at DESC, id DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_l2_memories_admin_sensitivity ON l2_memories(sensitivity, superseded_by, deleted_at, extracted_at DESC, id DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_l2_memories_admin_retention ON l2_memories(retention_class, superseded_by, deleted_at, extracted_at DESC, id DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_l2_memories_status ON l2_memories(deleted_at, superseded_by, extracted_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_l2_memories_contact ON l2_memories(contact_id, deleted_at, extracted_at DESC, id DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_l2_memories_source_ref ON l2_memories(source_ref);`,
  `CREATE INDEX IF NOT EXISTS idx_l2_memories_source_type ON l2_memories(source_type, extracted_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_l2_memories_scope_ref ON l2_memories(scope_ref_kind, scope_ref_id);`,
  `CREATE INDEX IF NOT EXISTS idx_l2_memories_embedding_present ON l2_memories(id) WHERE embedding IS NOT NULL;`,
  `CREATE INDEX IF NOT EXISTS idx_l2_memories_tags_gin ON l2_memories USING GIN (tags);`,
  `CREATE INDEX IF NOT EXISTS idx_l2_memories_scope_tags_gin ON l2_memories USING GIN (scope_tags);`,
  `CREATE INDEX IF NOT EXISTS idx_l2_memories_provenance_refs_gin ON l2_memories USING GIN (provenance_refs);`,
  `CREATE INDEX IF NOT EXISTS idx_l2_memories_provenance_json_gin ON l2_memories USING GIN (provenance_json);`,
  `CREATE INDEX IF NOT EXISTS idx_l2_memories_consent_flags_gin ON l2_memories USING GIN (consent_flags);`,
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
  CREATE TABLE IF NOT EXISTS l2_memory_patch_events (
    id TEXT PRIMARY KEY,
    memory_id TEXT NOT NULL REFERENCES l2_memories(id) ON DELETE CASCADE,
    source_ref TEXT NOT NULL,
    source_type TEXT NOT NULL,
    provenance_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    reason TEXT,
    patch_json JSONB NOT NULL,
    previous_json JSONB NOT NULL,
    next_json JSONB NOT NULL,
    created_at BIGINT NOT NULL
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_l2_memory_patch_events_memory ON l2_memory_patch_events(memory_id, created_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_l2_memory_patch_events_source ON l2_memory_patch_events(source_ref, source_type, created_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_l2_memory_patch_events_provenance_gin ON l2_memory_patch_events USING GIN (provenance_json);`,
  `CREATE INDEX IF NOT EXISTS idx_l2_memory_patch_events_patch_gin ON l2_memory_patch_events USING GIN (patch_json);`,
  `
  CREATE TABLE IF NOT EXISTS memory_evolution_links (
    id TEXT PRIMARY KEY,
    source_memory_id TEXT NOT NULL REFERENCES l2_memories(id) ON DELETE CASCADE,
    target_memory_id TEXT NOT NULL REFERENCES l2_memories(id) ON DELETE CASCADE,
    relation TEXT NOT NULL,
    confidence DOUBLE PRECISION NOT NULL DEFAULT 1,
    reason TEXT,
    source_ref TEXT,
    source_type TEXT NOT NULL DEFAULT 'unknown',
    provenance_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
    provenance_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at BIGINT NOT NULL,
    CHECK (source_memory_id <> target_memory_id),
    CHECK (relation IN ('supersedes', 'updates', 'negates', 'conflicts_with')),
    CHECK (confidence >= 0 AND confidence <= 1),
    UNIQUE (source_memory_id, target_memory_id, relation)
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_memory_evolution_links_source ON memory_evolution_links(source_memory_id, created_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_memory_evolution_links_target ON memory_evolution_links(target_memory_id, created_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_memory_evolution_links_relation ON memory_evolution_links(relation, created_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_memory_evolution_links_source_ref ON memory_evolution_links(source_ref, source_type);`,
  `CREATE INDEX IF NOT EXISTS idx_memory_evolution_links_provenance_refs_gin ON memory_evolution_links USING GIN (provenance_refs);`,
  `CREATE INDEX IF NOT EXISTS idx_memory_evolution_links_provenance_json_gin ON memory_evolution_links USING GIN (provenance_json);`,
  `
  CREATE TABLE IF NOT EXISTS l2_memory_maintenance_reviews (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    subject_memory_id TEXT NOT NULL,
    candidate_memory_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    state_json JSONB NOT NULL,
    quarantine_reason TEXT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_l2_memory_maintenance_reviews_status ON l2_memory_maintenance_reviews(status, updated_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_l2_memory_maintenance_reviews_kind ON l2_memory_maintenance_reviews(kind, updated_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_l2_memory_maintenance_reviews_subject ON l2_memory_maintenance_reviews(subject_memory_id, updated_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_l2_memory_maintenance_reviews_candidates_gin ON l2_memory_maintenance_reviews USING GIN (candidate_memory_ids);`,
  `CREATE INDEX IF NOT EXISTS idx_l2_memory_maintenance_reviews_state_gin ON l2_memory_maintenance_reviews USING GIN (state_json);`,
  `
  CREATE TABLE IF NOT EXISTS l01_episodes (
    id TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL DEFAULT 1,
    title TEXT NOT NULL,
    landmark TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'canonical',
    canonical_episode_id TEXT REFERENCES l01_episodes(id) ON DELETE SET NULL,
    merged_into_episode_id TEXT REFERENCES l01_episodes(id) ON DELETE SET NULL,
    superseded_by_episode_id TEXT REFERENCES l01_episodes(id) ON DELETE SET NULL,
    thread_id TEXT,
    channel_id TEXT,
    started_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ NOT NULL,
    participant_contact_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    salience_score DOUBLE PRECISION NOT NULL,
    salience_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    affect_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    themes JSONB NOT NULL DEFAULT '[]'::jsonb,
    artifact_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
    provenance_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
    scope_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    consent_flags JSONB NOT NULL DEFAULT '{}'::jsonb,
    embedding VECTOR,
    episode_json JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    CHECK (started_at <= ended_at),
    CHECK (status IN ('candidate', 'canonical', 'merged', 'superseded'))
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_l01_episodes_scope_time ON l01_episodes(channel_id, thread_id, started_at, ended_at);`,
  `CREATE INDEX IF NOT EXISTS idx_l01_episodes_thread_time ON l01_episodes(thread_id, started_at, id);`,
  `CREATE INDEX IF NOT EXISTS idx_l01_episodes_channel_time ON l01_episodes(channel_id, started_at, id);`,
  `CREATE INDEX IF NOT EXISTS idx_l01_episodes_status ON l01_episodes(status, updated_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_l01_episodes_canonical ON l01_episodes(canonical_episode_id, status);`,
  `CREATE INDEX IF NOT EXISTS idx_l01_episodes_merged ON l01_episodes(merged_into_episode_id) WHERE merged_into_episode_id IS NOT NULL;`,
  `CREATE INDEX IF NOT EXISTS idx_l01_episodes_superseded ON l01_episodes(superseded_by_episode_id) WHERE superseded_by_episode_id IS NOT NULL;`,
  `CREATE INDEX IF NOT EXISTS idx_l01_episodes_embedding_present ON l01_episodes(id) WHERE embedding IS NOT NULL;`,
  `CREATE INDEX IF NOT EXISTS idx_l01_episodes_participants_gin ON l01_episodes USING GIN (participant_contact_ids);`,
  `CREATE INDEX IF NOT EXISTS idx_l01_episodes_themes_gin ON l01_episodes USING GIN (themes);`,
  `CREATE INDEX IF NOT EXISTS idx_l01_episodes_artifact_refs_gin ON l01_episodes USING GIN (artifact_refs);`,
  `CREATE INDEX IF NOT EXISTS idx_l01_episodes_provenance_refs_gin ON l01_episodes USING GIN (provenance_refs);`,
  `CREATE INDEX IF NOT EXISTS idx_l01_episodes_scope_json_gin ON l01_episodes USING GIN (scope_json);`,
  `CREATE INDEX IF NOT EXISTS idx_l01_episodes_consent_flags_gin ON l01_episodes USING GIN (consent_flags);`,
  `CREATE INDEX IF NOT EXISTS idx_l01_episodes_episode_json_gin ON l01_episodes USING GIN (episode_json);`,
  `
  CREATE TABLE IF NOT EXISTS l01_episode_spans (
    episode_id TEXT NOT NULL REFERENCES l01_episodes(id) ON DELETE CASCADE,
    span_id TEXT NOT NULL,
    channel_id TEXT,
    thread_id TEXT,
    session_id TEXT,
    start_turn_id TEXT,
    end_turn_id TEXT,
    started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    span_range TSTZRANGE,
    span_json JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (episode_id, span_id),
    CHECK (started_at IS NULL OR ended_at IS NULL OR started_at <= ended_at)
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_l01_episode_spans_episode ON l01_episode_spans(episode_id);`,
  `CREATE INDEX IF NOT EXISTS idx_l01_episode_spans_scope_time ON l01_episode_spans(channel_id, thread_id, started_at, ended_at);`,
  `CREATE INDEX IF NOT EXISTS idx_l01_episode_spans_session ON l01_episode_spans(session_id, start_turn_id, end_turn_id);`,
  `CREATE INDEX IF NOT EXISTS idx_l01_episode_spans_range_gist ON l01_episode_spans USING GIST (span_range);`,
  `CREATE INDEX IF NOT EXISTS idx_l01_episode_spans_json_gin ON l01_episode_spans USING GIN (span_json);`,
  `
  CREATE TABLE IF NOT EXISTS l01_episode_arcs (
    id TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL DEFAULT 1,
    source_episode_id TEXT NOT NULL REFERENCES l01_episodes(id) ON DELETE CASCADE,
    target_episode_id TEXT NOT NULL REFERENCES l01_episodes(id) ON DELETE CASCADE,
    arc_kind TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'canonical',
    canonical_arc_id TEXT REFERENCES l01_episode_arcs(id) ON DELETE SET NULL,
    merged_into_arc_id TEXT REFERENCES l01_episode_arcs(id) ON DELETE SET NULL,
    superseded_by_arc_id TEXT REFERENCES l01_episode_arcs(id) ON DELETE SET NULL,
    salience_score DOUBLE PRECISION NOT NULL,
    confidence DOUBLE PRECISION NOT NULL,
    themes JSONB NOT NULL DEFAULT '[]'::jsonb,
    span_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
    artifact_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
    provenance_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
    arc_json JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    CHECK (source_episode_id <> target_episode_id),
    CHECK (status IN ('candidate', 'canonical', 'merged', 'superseded')),
    CHECK (confidence >= 0 AND confidence <= 1)
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_l01_episode_arcs_source ON l01_episode_arcs(source_episode_id, updated_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_l01_episode_arcs_target ON l01_episode_arcs(target_episode_id, updated_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_l01_episode_arcs_kind ON l01_episode_arcs(arc_kind, updated_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_l01_episode_arcs_status ON l01_episode_arcs(status, updated_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_l01_episode_arcs_canonical ON l01_episode_arcs(canonical_arc_id, status);`,
  `CREATE INDEX IF NOT EXISTS idx_l01_episode_arcs_themes_gin ON l01_episode_arcs USING GIN (themes);`,
  `CREATE INDEX IF NOT EXISTS idx_l01_episode_arcs_span_refs_gin ON l01_episode_arcs USING GIN (span_refs);`,
  `CREATE INDEX IF NOT EXISTS idx_l01_episode_arcs_artifact_refs_gin ON l01_episode_arcs USING GIN (artifact_refs);`,
  `CREATE INDEX IF NOT EXISTS idx_l01_episode_arcs_provenance_refs_gin ON l01_episode_arcs USING GIN (provenance_refs);`,
  `
  CREATE TABLE IF NOT EXISTS l01_episode_arc_audit (
    id TEXT PRIMARY KEY,
    arc_id TEXT NOT NULL REFERENCES l01_episode_arcs(id) ON DELETE CASCADE,
    action TEXT NOT NULL,
    actor TEXT NOT NULL,
    reason TEXT NOT NULL,
    details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL,
    CHECK (action IN ('written', 'repointed', 'removed'))
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_l01_episode_arc_audit_arc ON l01_episode_arc_audit(arc_id, created_at ASC);`,
  `
  CREATE TABLE IF NOT EXISTS l01_episode_lineage (
    id TEXT PRIMARY KEY,
    source_episode_id TEXT NOT NULL REFERENCES l01_episodes(id) ON DELETE CASCADE,
    target_episode_id TEXT NOT NULL REFERENCES l01_episodes(id) ON DELETE CASCADE,
    relation TEXT NOT NULL,
    confidence DOUBLE PRECISION NOT NULL DEFAULT 1,
    reason TEXT,
    source_ref TEXT,
    provenance_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
    lineage_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL,
    CHECK (source_episode_id <> target_episode_id),
    CHECK (relation IN ('canonicalizes', 'merges', 'supersedes', 'splits_from', 'derived_from', 'conflicts_with', 'updates')),
    CHECK (confidence >= 0 AND confidence <= 1)
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_l01_episode_lineage_source ON l01_episode_lineage(source_episode_id, created_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_l01_episode_lineage_target ON l01_episode_lineage(target_episode_id, created_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_l01_episode_lineage_relation ON l01_episode_lineage(relation, created_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_l01_episode_lineage_provenance_refs_gin ON l01_episode_lineage USING GIN (provenance_refs);`,
  `CREATE INDEX IF NOT EXISTS idx_l01_episode_lineage_json_gin ON l01_episode_lineage USING GIN (lineage_json);`,
  `
  CREATE TABLE IF NOT EXISTS l01_processing_watermarks (
    id TEXT PRIMARY KEY,
    processor TEXT NOT NULL,
    channel_id TEXT,
    thread_id TEXT,
    session_id TEXT,
    source_ref TEXT NOT NULL,
    high_water_turn_id TEXT,
    high_water_message_id TEXT,
    processed_started_at TIMESTAMPTZ,
    processed_ended_at TIMESTAMPTZ,
    previous_watermark_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    next_watermark_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'active',
    reconciliation_status TEXT NOT NULL DEFAULT 'pending',
    artifacts_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_processed_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    CHECK (status IN ('active', 'reconciling', 'blocked', 'complete')),
    CHECK (reconciliation_status IN ('pending', 'clean', 'needs_review', 'blocked'))
  );
  `,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_l01_processing_watermarks_unique_scope ON l01_processing_watermarks(processor, source_ref, (COALESCE(channel_id, '')), (COALESCE(thread_id, '')), (COALESCE(session_id, '')));`,
  `CREATE INDEX IF NOT EXISTS idx_l01_processing_watermarks_scope ON l01_processing_watermarks(channel_id, thread_id, session_id, updated_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_l01_processing_watermarks_status ON l01_processing_watermarks(status, reconciliation_status, updated_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_l01_processing_watermarks_artifacts_gin ON l01_processing_watermarks USING GIN (artifacts_json);`,
  `
  CREATE TABLE IF NOT EXISTS l01_episode_candidates (
    id TEXT PRIMARY KEY,
    candidate_episode_id TEXT REFERENCES l01_episodes(id) ON DELETE SET NULL,
    canonical_episode_id TEXT REFERENCES l01_episodes(id) ON DELETE SET NULL,
    merged_into_episode_id TEXT REFERENCES l01_episodes(id) ON DELETE SET NULL,
    superseded_by_episode_id TEXT REFERENCES l01_episodes(id) ON DELETE SET NULL,
    source_watermark_id TEXT REFERENCES l01_processing_watermarks(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    channel_id TEXT,
    thread_id TEXT,
    session_id TEXT,
    started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    overlap_score DOUBLE PRECISION,
    confidence DOUBLE PRECISION NOT NULL DEFAULT 0,
    reason TEXT,
    candidate_json JSONB NOT NULL,
    artifact_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
    provenance_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    CHECK (started_at IS NULL OR ended_at IS NULL OR started_at <= ended_at),
    CHECK (status IN ('pending', 'accepted', 'canonical', 'merged', 'superseded', 'rejected', 'needs_review')),
    CHECK (overlap_score IS NULL OR (overlap_score >= 0 AND overlap_score <= 1)),
    CHECK (confidence >= 0 AND confidence <= 1)
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_l01_episode_candidates_status ON l01_episode_candidates(status, updated_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_l01_episode_candidates_canonical ON l01_episode_candidates(canonical_episode_id, status);`,
  `CREATE INDEX IF NOT EXISTS idx_l01_episode_candidates_merged ON l01_episode_candidates(merged_into_episode_id) WHERE merged_into_episode_id IS NOT NULL;`,
  `CREATE INDEX IF NOT EXISTS idx_l01_episode_candidates_superseded ON l01_episode_candidates(superseded_by_episode_id) WHERE superseded_by_episode_id IS NOT NULL;`,
  `CREATE INDEX IF NOT EXISTS idx_l01_episode_candidates_scope_time ON l01_episode_candidates(channel_id, thread_id, session_id, started_at, ended_at);`,
  `CREATE INDEX IF NOT EXISTS idx_l01_episode_candidates_watermark ON l01_episode_candidates(source_watermark_id, created_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_l01_episode_candidates_json_gin ON l01_episode_candidates USING GIN (candidate_json);`,
  `CREATE INDEX IF NOT EXISTS idx_l01_episode_candidates_artifact_refs_gin ON l01_episode_candidates USING GIN (artifact_refs);`,
  `CREATE INDEX IF NOT EXISTS idx_l01_episode_candidates_provenance_refs_gin ON l01_episode_candidates USING GIN (provenance_refs);`,
  `
  CREATE TABLE IF NOT EXISTS l01_episode_reviews (
    id TEXT PRIMARY KEY,
    candidate_id TEXT REFERENCES l01_episode_candidates(id) ON DELETE SET NULL,
    episode_id TEXT REFERENCES l01_episodes(id) ON DELETE SET NULL,
    canonical_episode_id TEXT REFERENCES l01_episodes(id) ON DELETE SET NULL,
    merged_into_episode_id TEXT REFERENCES l01_episodes(id) ON DELETE SET NULL,
    superseded_by_episode_id TEXT REFERENCES l01_episodes(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    recommended_action TEXT NOT NULL,
    reviewer TEXT,
    reason TEXT,
    review_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    artifacts_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    provenance_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    resolved_at TIMESTAMPTZ,
    CHECK (status IN ('pending', 'approved', 'rejected', 'merged', 'superseded', 'dismissed')),
    CHECK (recommended_action IN ('canonize', 'merge', 'supersede', 'reject', 'needs_human_review'))
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_l01_episode_reviews_status ON l01_episode_reviews(status, updated_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_l01_episode_reviews_candidate ON l01_episode_reviews(candidate_id, updated_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_l01_episode_reviews_episode ON l01_episode_reviews(episode_id, updated_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_l01_episode_reviews_canonical ON l01_episode_reviews(canonical_episode_id, status);`,
  `CREATE INDEX IF NOT EXISTS idx_l01_episode_reviews_review_json_gin ON l01_episode_reviews USING GIN (review_json);`,
  `CREATE INDEX IF NOT EXISTS idx_l01_episode_reviews_artifacts_gin ON l01_episode_reviews USING GIN (artifacts_json);`,
  `CREATE INDEX IF NOT EXISTS idx_l01_episode_reviews_provenance_refs_gin ON l01_episode_reviews USING GIN (provenance_refs);`,
  `
  CREATE TABLE IF NOT EXISTS l01_episode_message_claims (
    episode_id TEXT NOT NULL REFERENCES l01_episodes(id) ON DELETE CASCADE,
    claim_key TEXT NOT NULL,
    turn_id TEXT,
    channel_id TEXT,
    session_id TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    claimed_at TIMESTAMPTZ NOT NULL,
    transferred_to_episode_id TEXT REFERENCES l01_episodes(id) ON DELETE SET NULL,
    transferred_at TIMESTAMPTZ,
    reason TEXT,
    PRIMARY KEY (episode_id, claim_key),
    CHECK (status IN ('active', 'transferred')),
    CHECK (status <> 'transferred' OR transferred_at IS NOT NULL)
  );
  `,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_l01_episode_message_claims_active_key ON l01_episode_message_claims(claim_key) WHERE status = 'active';`,
  `CREATE INDEX IF NOT EXISTS idx_l01_episode_message_claims_episode ON l01_episode_message_claims(episode_id, status);`,
  `CREATE INDEX IF NOT EXISTS idx_l01_episode_message_claims_key ON l01_episode_message_claims(claim_key, status);`,
  `
  CREATE TABLE IF NOT EXISTS memory_processing_watermarks (
    id TEXT PRIMARY KEY,
    processor TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    source_ref TEXT NOT NULL,
    scope_ref_kind TEXT,
    scope_ref_id TEXT,
    high_water_ref TEXT,
    high_water_timestamp BIGINT,
    status TEXT NOT NULL DEFAULT 'active',
    state_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    artifacts_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    provenance_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    CHECK (status IN ('active', 'blocked', 'complete'))
  );
  `,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_processing_watermarks_unique_source ON memory_processing_watermarks(processor, source_kind, source_ref);`,
  `CREATE INDEX IF NOT EXISTS idx_memory_processing_watermarks_status ON memory_processing_watermarks(status, updated_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_memory_processing_watermarks_scope ON memory_processing_watermarks(scope_ref_kind, scope_ref_id);`,
  `CREATE INDEX IF NOT EXISTS idx_memory_processing_watermarks_state_gin ON memory_processing_watermarks USING GIN (state_json);`,
  `CREATE INDEX IF NOT EXISTS idx_memory_processing_watermarks_artifacts_gin ON memory_processing_watermarks USING GIN (artifacts_json);`,
  `CREATE INDEX IF NOT EXISTS idx_memory_processing_watermarks_provenance_refs_gin ON memory_processing_watermarks USING GIN (provenance_refs);`,
  `
  CREATE TABLE IF NOT EXISTS memory_eval_runs (
    id TEXT PRIMARY KEY,
    eval_kind TEXT NOT NULL,
    target_surface TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at BIGINT NOT NULL,
    completed_at BIGINT,
    summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    metrics_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    artifacts_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    provenance_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
    CHECK (status IN ('pending', 'running', 'passed', 'failed', 'blocked'))
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_memory_eval_runs_status ON memory_eval_runs(status, started_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_memory_eval_runs_target ON memory_eval_runs(target_surface, eval_kind, started_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_memory_eval_runs_summary_gin ON memory_eval_runs USING GIN (summary_json);`,
  `CREATE INDEX IF NOT EXISTS idx_memory_eval_runs_metrics_gin ON memory_eval_runs USING GIN (metrics_json);`,
  `CREATE INDEX IF NOT EXISTS idx_memory_eval_runs_artifacts_gin ON memory_eval_runs USING GIN (artifacts_json);`,
  `CREATE INDEX IF NOT EXISTS idx_memory_eval_runs_provenance_refs_gin ON memory_eval_runs USING GIN (provenance_refs);`,
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
  // Sleep-cycle consolidation (m58.1): fast scan of live candidate episodes
  // awaiting the nightly candidate-then-consolidate pass. The status CHECK on
  // l01_episodes already admits 'candidate'.
  `CREATE INDEX IF NOT EXISTS idx_l01_episodes_lifecycle_candidate ON l01_episodes(started_at, ended_at) WHERE status = 'candidate';`,
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

// E8.3: pgvector projection of canonical workspace wiki documents. This is a
// rebuildable mirror (charter 6.23/7.5): the workspace Markdown + metadata are
// the source of truth, and every row is keyed by document id + body_sha256 so
// checksum drift is detectable and the projection can be rebuilt/repaired from
// the canonical files at any time. Projection loss never corrupts the archive;
// it only degrades semantic search until rebuilt.
export const POSTGRES_WIKI_PROJECTION_MIGRATIONS = [
  `CREATE EXTENSION IF NOT EXISTS vector;`,
  `
  CREATE TABLE IF NOT EXISTS wiki_document_chunks (
    document_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    body_sha256 TEXT NOT NULL,
    title TEXT NOT NULL,
    body_path TEXT NOT NULL,
    source_class TEXT NOT NULL,
    sensitivity TEXT NOT NULL DEFAULT 'personal',
    chunk_text TEXT NOT NULL,
    chunk_char_count INTEGER NOT NULL,
    embedding VECTOR NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (document_id, chunk_index)
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_wiki_document_chunks_doc ON wiki_document_chunks(document_id);`,
  `CREATE INDEX IF NOT EXISTS idx_wiki_document_chunks_sha ON wiki_document_chunks(document_id, body_sha256);`,
  // W5b scope dimension: chunks carry their document's scope so retrieval can
  // filter at query time (personal always, plus the current site's shared world
  // scope). Additive with a `personal` default: pre-W5b rows and the flag-off
  // (unfiltered) query path are byte-identical.
  `ALTER TABLE wiki_document_chunks ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'personal';`,
  `CREATE INDEX IF NOT EXISTS idx_wiki_document_chunks_scope ON wiki_document_chunks(scope);`,
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
    emotional_time_series JSONB NOT NULL DEFAULT '[]'::jsonb,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    notes TEXT,
    timezone TEXT,
    channel_identities JSONB NOT NULL DEFAULT '[]'::jsonb,
    conversation_channels JSONB NOT NULL DEFAULT '[]'::jsonb,
    is_machine_intelligence BOOLEAN NOT NULL DEFAULT FALSE
  );
  `,
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS emotional_time_series JSONB NOT NULL DEFAULT '[]'::jsonb;`,
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS nickname TEXT;`,
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS notes TEXT;`,
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS timezone TEXT;`,
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS channel_identities JSONB NOT NULL DEFAULT '[]'::jsonb;`,
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS conversation_channels JSONB NOT NULL DEFAULT '[]'::jsonb;`,
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS is_machine_intelligence BOOLEAN NOT NULL DEFAULT FALSE;`,
  `CREATE INDEX IF NOT EXISTS idx_contacts_trust ON contacts(trust_level);`,
  `CREATE INDEX IF NOT EXISTS idx_contacts_discord ON contacts(discord_user_id);`,
  `
  CREATE TABLE IF NOT EXISTS contact_channel_ids (
    contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    channel TEXT NOT NULL,
    channel_user_id TEXT NOT NULL,
    privacy_level TEXT NOT NULL DEFAULT 'invite_only',
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
  CREATE TABLE IF NOT EXISTS contact_maintenance_watermarks (
    processor TEXT PRIMARY KEY,
    last_run_at TEXT NOT NULL
  );
  `,
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

// Sprint 10 D2a — hub identity ↔ contact enrollment. Biometrics stay at the
// Satellite Hub; core stores only the opaque handle → contact binding plus an
// audit trail. Semantically separate from the conversational contact_channel_*
// tables.
export const POSTGRES_ENROLLMENT_MIGRATIONS = [
  `
  CREATE TABLE IF NOT EXISTS hub_identity_enrollments (
    hub_identity_id TEXT PRIMARY KEY,
    contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'enrolled',
    satellite_id TEXT,
    endpoint_id TEXT,
    enrolled_by TEXT NOT NULL DEFAULT 'system:unknown',
    enrolled_at TEXT NOT NULL,
    revoked_by TEXT,
    revoked_at TEXT
  );
  `,
  `ALTER TABLE hub_identity_enrollments ADD COLUMN IF NOT EXISTS satellite_id TEXT;`,
  `ALTER TABLE hub_identity_enrollments ADD COLUMN IF NOT EXISTS endpoint_id TEXT;`,
  `CREATE INDEX IF NOT EXISTS idx_hub_identity_enrollments_contact ON hub_identity_enrollments(contact_id);`,
  `CREATE INDEX IF NOT EXISTS idx_hub_identity_enrollments_status ON hub_identity_enrollments(status);`,
  `
  CREATE TABLE IF NOT EXISTS hub_identity_enrollment_audit (
    id BIGSERIAL PRIMARY KEY,
    hub_identity_id TEXT NOT NULL,
    contact_id TEXT NOT NULL,
    action TEXT NOT NULL,
    actor TEXT NOT NULL,
    satellite_id TEXT,
    endpoint_id TEXT,
    timestamp TEXT NOT NULL
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_hub_identity_enrollment_audit_handle ON hub_identity_enrollment_audit(hub_identity_id, timestamp DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_hub_identity_enrollment_audit_contact ON hub_identity_enrollment_audit(contact_id, timestamp DESC);`,
];

export const POSTGRES_INTENTION_MIGRATIONS = [
  `
  CREATE TABLE IF NOT EXISTS active_concerns (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    priority TEXT NOT NULL,
    source TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    salience DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    sensitivity TEXT NOT NULL DEFAULT 'personal',
    owner TEXT NOT NULL DEFAULT 'companion',
    evidence_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
    resolution_evidence_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
    resolved_at TEXT,
    resolution_outcome TEXT,
    contact_id TEXT,
    formation_vad JSONB,
    last_reviewed_at TEXT,
    next_review_at TEXT,
    merged_from_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    split_from_id TEXT,
    CHECK (priority IN ('high', 'medium', 'low')),
    CHECK (source IN ('appraisal', 'agent', 'heartbeat')),
    CHECK (status IN ('candidate', 'active', 'watching', 'deferred', 'blocked', 'resolved', 'dismissed', 'suppressed')),
    CHECK (sensitivity IN ('public', 'personal', 'intimate', 'confidential', 'redacted')),
    CHECK (owner IN ('companion', 'operator', 'system')),
    CHECK (salience >= 0 AND salience <= 1)
  );
  `,
  `ALTER TABLE active_concerns ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';`,
  `ALTER TABLE active_concerns ADD COLUMN IF NOT EXISTS salience DOUBLE PRECISION NOT NULL DEFAULT 0.5;`,
  `ALTER TABLE active_concerns ADD COLUMN IF NOT EXISTS sensitivity TEXT NOT NULL DEFAULT 'personal';`,
  `ALTER TABLE active_concerns ADD COLUMN IF NOT EXISTS owner TEXT NOT NULL DEFAULT 'companion';`,
  `ALTER TABLE active_concerns ADD COLUMN IF NOT EXISTS evidence_refs JSONB NOT NULL DEFAULT '[]'::jsonb;`,
  `ALTER TABLE active_concerns ADD COLUMN IF NOT EXISTS resolution_evidence_refs JSONB NOT NULL DEFAULT '[]'::jsonb;`,
  `ALTER TABLE active_concerns ADD COLUMN IF NOT EXISTS last_reviewed_at TEXT;`,
  `ALTER TABLE active_concerns ADD COLUMN IF NOT EXISTS next_review_at TEXT;`,
  `ALTER TABLE active_concerns ADD COLUMN IF NOT EXISTS merged_from_ids JSONB NOT NULL DEFAULT '[]'::jsonb;`,
  `ALTER TABLE active_concerns ADD COLUMN IF NOT EXISTS split_from_id TEXT;`,
  `
  UPDATE active_concerns
  SET status = 'resolved'
  WHERE resolved_at IS NOT NULL AND COALESCE(status, 'active') = 'active';
  `,
  `
  UPDATE active_concerns
  SET last_reviewed_at = created_at
  WHERE last_reviewed_at IS NULL;
  `,
  `CREATE INDEX IF NOT EXISTS idx_active_concerns_active ON active_concerns (resolved_at, expires_at, priority, created_at, id);`,
  `CREATE INDEX IF NOT EXISTS idx_active_concerns_contact ON active_concerns (contact_id, resolved_at, expires_at, created_at, id);`,
  `CREATE INDEX IF NOT EXISTS idx_active_concerns_lifecycle ON active_concerns (status, next_review_at, expires_at, last_reviewed_at, id);`,
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
    context_summary TEXT,
    wake_conditions TEXT,
    activated_at TEXT,
    activation_reason TEXT,
    CHECK (priority IN ('low', 'medium', 'high')),
    CHECK (timing IN ('immediate', 'soon', 'scheduled')),
    CHECK (channel_type IN ('terminal', 'api', 'discord', 'telegram', 'psfn-amica'))
  );
  `,
  `ALTER TABLE intention_pending_follow_ups ADD COLUMN IF NOT EXISTS context_summary TEXT;`,
  `ALTER TABLE intention_pending_follow_ups ADD COLUMN IF NOT EXISTS wake_conditions TEXT;`,
  `CREATE INDEX IF NOT EXISTS idx_intention_pending_follow_ups_active ON intention_pending_follow_ups (activated_at, created_at, id);`,
  `CREATE INDEX IF NOT EXISTS idx_intention_pending_follow_ups_contact ON intention_pending_follow_ups (contact_id, activated_at, created_at, id);`,
  `
  CREATE TABLE IF NOT EXISTS intention_pending_follow_up_quarantine (
    id TEXT PRIMARY KEY,
    follow_up_id TEXT,
    reason TEXT NOT NULL,
    source TEXT,
    raw_entry TEXT NOT NULL,
    quarantined_at TEXT NOT NULL
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_intention_pending_follow_up_quarantine_follow_up ON intention_pending_follow_up_quarantine (follow_up_id, quarantined_at, id);`,
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
  // Weighted-thought lifecycle (Charter 6.24, bead 1xb.4). Accumulated weight
  // and lastReinforcedAt persist so decay is deterministic across restart;
  // decay is computed at read time (no in-memory-only accumulator, 9vi.13).
  `
  CREATE TABLE IF NOT EXISTS weighted_thoughts (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    source TEXT NOT NULL,
    thought_class TEXT NOT NULL DEFAULT 'standard',
    contact_id TEXT,
    base_weight DOUBLE PRECISION NOT NULL,
    context_multipliers JSONB NOT NULL DEFAULT '{}'::jsonb,
    accumulated_weight DOUBLE PRECISION NOT NULL,
    reinforcement_count INTEGER NOT NULL DEFAULT 0,
    decay_halflife_ms DOUBLE PRECISION NOT NULL,
    created_at TEXT NOT NULL,
    last_reinforced_at TEXT NOT NULL,
    provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
    nudge_state TEXT NOT NULL DEFAULT 'pending',
    last_nudged_at TEXT,
    decline_count INTEGER NOT NULL DEFAULT 0,
    CHECK (thought_class IN ('time_sensitive', 'standard', 'trivial')),
    CHECK (nudge_state IN ('pending', 'nudged', 'accepted', 'declined')),
    CHECK (base_weight >= 0),
    CHECK (accumulated_weight >= 0),
    CHECK (decay_halflife_ms > 0)
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_weighted_thoughts_active ON weighted_thoughts(nudge_state, accumulated_weight DESC, last_reinforced_at DESC, id);`,
  `CREATE INDEX IF NOT EXISTS idx_weighted_thoughts_contact ON weighted_thoughts(contact_id, nudge_state, accumulated_weight DESC, id);`,
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

export const POSTGRES_SCHEDULED_PROMPT_MIGRATIONS = [
  `
  CREATE TABLE IF NOT EXISTS scheduler_scheduled_prompts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    run_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    source TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    channel_type TEXT NOT NULL,
    author_id TEXT NOT NULL,
    author_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    delivery_channel_id TEXT,
    completed_at TEXT,
    CHECK (source = 'schedule_tool'),
    CHECK (channel_type IN ('discord', 'terminal', 'api', 'telegram', 'psfn-amica')),
    CHECK (status IN ('pending', 'completed')),
    CHECK (
      (status = 'pending' AND completed_at IS NULL)
      OR (status = 'completed' AND completed_at IS NOT NULL)
    )
  );
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_scheduler_scheduled_prompts_pending_due
    ON scheduler_scheduled_prompts (run_at ASC, created_at ASC, id ASC)
    WHERE status = 'pending';
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_scheduler_scheduled_prompts_created_at
    ON scheduler_scheduled_prompts (created_at DESC, id DESC);
  `,
];

export const POSTGRES_MODEL_USAGE_MIGRATIONS = [
  `
  CREATE TABLE IF NOT EXISTS model_usage_events (
    id TEXT PRIMARY KEY,
    logical_call_id TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 0,
    recorded_at_ms BIGINT NOT NULL,
    started_at_ms BIGINT NOT NULL,
    completed_at_ms BIGINT,
    duration_ms BIGINT,
    ttft_ms BIGINT,
    day_key TEXT NOT NULL,
    month_key TEXT NOT NULL,
    status TEXT NOT NULL,
    call_kind TEXT NOT NULL,
    call_type TEXT NOT NULL,
    purpose TEXT NOT NULL,
    origin_type TEXT,
    origin_stage TEXT,
    service TEXT,
    process TEXT,
    turn_id TEXT,
    request_id TEXT,
    channel_id TEXT,
    tool_name TEXT,
    tool_call_id TEXT,
    charge_lane TEXT,
    charge_surface TEXT,
    charge_run_id TEXT,
    charge_root_run_id TEXT,
    charge_parent_run_id TEXT,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    slot_key TEXT,
    requested_provider TEXT,
    requested_model TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    provider_cost_usd DOUBLE PRECISION,
    estimated_cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
    cost_source TEXT NOT NULL DEFAULT 'none',
    currency TEXT,
    stop_reason TEXT,
    error_code TEXT,
    error_message TEXT,
    metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    CHECK (status IN ('success', 'failure')),
    CHECK (call_kind IN ('chat', 'completion', 'embedding', 'image_create', 'image_edit')),
    CHECK (cost_source IN ('provider', 'estimate', 'none')),
    UNIQUE (logical_call_id, attempt)
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_model_usage_events_recorded_at ON model_usage_events(recorded_at_ms DESC, id DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_model_usage_events_day ON model_usage_events(day_key, recorded_at_ms DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_model_usage_events_month ON model_usage_events(month_key, recorded_at_ms DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_model_usage_events_model ON model_usage_events(provider, model, recorded_at_ms DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_model_usage_events_purpose ON model_usage_events(call_kind, purpose, recorded_at_ms DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_model_usage_events_tool ON model_usage_events(tool_name, recorded_at_ms DESC) WHERE tool_name IS NOT NULL;`,
  `CREATE INDEX IF NOT EXISTS idx_model_usage_events_request ON model_usage_events(request_id, turn_id, tool_call_id);`,
  `CREATE INDEX IF NOT EXISTS idx_model_usage_events_charge ON model_usage_events(charge_root_run_id, charge_run_id, recorded_at_ms DESC) WHERE charge_root_run_id IS NOT NULL;`,
  `CREATE INDEX IF NOT EXISTS idx_model_usage_events_metadata_gin ON model_usage_events USING GIN (metadata_json);`,
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

// Multi-companion world schema (sprint 10, W2). Every companion gets its own
// per-companion schema running the migration chains above; the single `shared`
// schema holds cross-companion world data (locations/presence, shared wiki
// chunks, world state). This is the SEPARATE migration chain for that schema.
//
// The chain owns its own version ledger so shared migrations are registered
// and tracked independently of the per-companion chains. World tables belong
// here, never in the per-companion chains. Current versions:
//   1 — baseline (ledger only)
//   2 — companion_presence (W5a cross-companion presence)
export const SHARED_SCHEMA_NAME = 'shared';

export const POSTGRES_SHARED_MIGRATIONS: readonly string[] = [
  // Version ledger for the shared schema. Independent of the per-companion
  // chains (which are idempotent CREATE ... IF NOT EXISTS lists); this table is
  // the registration point that lets the shared chain track applied versions as
  // world tables are added.
  `
  CREATE TABLE IF NOT EXISTS shared_schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  `,
  // Register the baseline (infrastructure-only) version. No world tables yet.
  `
  INSERT INTO shared_schema_migrations (version, name)
  VALUES (1, 'shared-schema-baseline')
  ON CONFLICT (version) DO NOTHING;
  `,
  // Version 2 (sprint 10, W5a): cross-companion presence. The durable authority
  // for "which companion is at which place". One row per companion, written by
  // that companion's own agent process only. NOTHING personal ever lands in
  // this table — presence is companion id + place coordinates + timestamps.
  //
  // `since` is when the companion arrived at its CURRENT place (preserved on
  // same-place refreshes, reset on moves); `updated_at` is the freshness beat —
  // readers treat rows older than a TTL as stale so a crashed agent never
  // leaves a permanent ghost (graceful shutdown deletes the row outright).
  `
  CREATE TABLE IF NOT EXISTS companion_presence (
    companion_id UUID PRIMARY KEY,
    site_id TEXT NOT NULL,
    place_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('physical', 'virtual')),
    since TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  `,
  // Co-presence reads are always "who else is at THIS place".
  `
  CREATE INDEX IF NOT EXISTS idx_companion_presence_place
    ON companion_presence (site_id, place_id);
  `,
  `
  INSERT INTO shared_schema_migrations (version, name)
  VALUES (2, 'companion-presence')
  ON CONFLICT (version) DO NOTHING;
  `,
];
