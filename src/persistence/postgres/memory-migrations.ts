import { POSTGRES_VECTOR_EXTENSION_MIGRATION } from './vector-extension-migration.js';

export const POSTGRES_MEMORY_MIGRATIONS = [
  // Tenant search paths exclude public. Deployment provisioning creates the
  // explicit extension schema before runtime migrations begin.
  POSTGRES_VECTOR_EXTENSION_MIGRATION,
  `
  CREATE TABLE IF NOT EXISTS l2_memories (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    type TEXT NOT NULL,
    importance DOUBLE PRECISION NOT NULL,
    confidence DOUBLE PRECISION NOT NULL,
    emotional_valence DOUBLE PRECISION NOT NULL,
    formation_vad JSONB,
    emotional_texture JSONB,
    salience DOUBLE PRECISION NOT NULL,
    salience_decay_anchor_at BIGINT NOT NULL DEFAULT ((EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint),
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
    authorization_revision BIGINT NOT NULL DEFAULT 1,
    subject_evidence_digest TEXT,
    search_vector TSVECTOR GENERATED ALWAYS AS (
      to_tsvector('simple', coalesce(text, ''))
    ) STORED,
    embedding VECTOR
  );
  `,
  `ALTER TABLE l2_memories ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'unknown';`,
  `ALTER TABLE l2_memories ADD COLUMN IF NOT EXISTS provenance_json JSONB NOT NULL DEFAULT '{}'::jsonb;`,
  `ALTER TABLE l2_memories ADD COLUMN IF NOT EXISTS formation_vad JSONB;`,
  // Multi-signal emotional texture (031.11.1): discrete distribution + emotion
  // confidence retained at formation so mixed states are not compressed to a
  // single dominant tag. Additive, nullable, backward-safe.
  `ALTER TABLE l2_memories ADD COLUMN IF NOT EXISTS emotional_texture JSONB;`,
  `ALTER TABLE l2_memories ADD COLUMN IF NOT EXISTS salience_decay_anchor_at BIGINT;`,
  `UPDATE l2_memories SET salience_decay_anchor_at = last_accessed WHERE salience_decay_anchor_at IS NULL;`,
  `ALTER TABLE l2_memories ALTER COLUMN salience_decay_anchor_at SET DEFAULT ((EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint);`,
  `ALTER TABLE l2_memories ALTER COLUMN salience_decay_anchor_at SET NOT NULL;`,
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
  `ALTER TABLE l2_memories ADD COLUMN IF NOT EXISTS authorization_revision BIGINT NOT NULL DEFAULT 1;`,
  `ALTER TABLE l2_memories ADD COLUMN IF NOT EXISTS subject_evidence_digest TEXT;`,
  `ALTER TABLE l2_memories ADD COLUMN IF NOT EXISTS search_vector TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', coalesce(text, ''))) STORED;`,
  `ALTER TABLE l2_memories DROP CONSTRAINT IF EXISTS l2_memories_subject_evidence_digest_check;`,
  `ALTER TABLE l2_memories ADD CONSTRAINT l2_memories_subject_evidence_digest_check CHECK (subject_evidence_digest IS NULL OR subject_evidence_digest ~ '^[a-f0-9]{64}$');`,
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
  `CREATE INDEX IF NOT EXISTS idx_l2_memories_search_vector ON l2_memories USING GIN (search_vector);`,
  `CREATE INDEX IF NOT EXISTS idx_l2_memories_tags_gin ON l2_memories USING GIN (tags);`,
  `CREATE INDEX IF NOT EXISTS idx_l2_memories_scope_tags_gin ON l2_memories USING GIN (scope_tags);`,
  `CREATE INDEX IF NOT EXISTS idx_l2_memories_provenance_refs_gin ON l2_memories USING GIN (provenance_refs);`,
  `CREATE INDEX IF NOT EXISTS idx_l2_memories_provenance_json_gin ON l2_memories USING GIN (provenance_json);`,
  `CREATE INDEX IF NOT EXISTS idx_l2_memories_consent_flags_gin ON l2_memories USING GIN (consent_flags);`,
  `
  CREATE TABLE IF NOT EXISTS l2_memory_subject_classifications (
    memory_id TEXT PRIMARY KEY REFERENCES l2_memories(id) ON DELETE CASCADE,
    subject_class TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'invalidated',
    classifier_version INTEGER NOT NULL,
    memory_revision BIGINT NOT NULL,
    evidence_digest TEXT NOT NULL,
    evidence_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    room_id TEXT,
    unbound_person_label_hash TEXT,
    reason_class TEXT NOT NULL,
    classified_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    CHECK (subject_class IN (
      'single_contact', 'multiple_contacts', 'shared_room', 'companion_private',
      'unbound_person', 'unattributed', 'ambiguous'
    )),
    CHECK (status IN ('current', 'invalidated')),
    CHECK (classifier_version > 0),
    CHECK (memory_revision > 0),
    CHECK (evidence_digest ~ '^[a-f0-9]{64}$'),
    CHECK (jsonb_typeof(evidence_json) = 'array'),
    CHECK (unbound_person_label_hash IS NULL OR unbound_person_label_hash ~ '^[a-f0-9]{64}$'),
    CHECK (subject_class <> 'shared_room' OR room_id IS NOT NULL),
    CHECK (subject_class <> 'unbound_person' OR unbound_person_label_hash IS NOT NULL)
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS l2_memory_subject_contacts (
    memory_id TEXT NOT NULL REFERENCES l2_memory_subject_classifications(memory_id) ON DELETE CASCADE,
    contact_id TEXT NOT NULL,
    PRIMARY KEY (memory_id, contact_id)
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS l2_memory_subject_backfill_checkpoints (
    classifier_version INTEGER PRIMARY KEY,
    cursor_memory_id TEXT,
    completed BOOLEAN NOT NULL DEFAULT FALSE,
    processed_count BIGINT NOT NULL DEFAULT 0,
    updated_at BIGINT NOT NULL,
    CHECK (classifier_version > 0),
    CHECK (processed_count >= 0)
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_l2_memory_subject_classifications_policy ON l2_memory_subject_classifications(status, classifier_version, subject_class, memory_revision);`,
  `CREATE INDEX IF NOT EXISTS idx_l2_memory_subject_contacts_contact ON l2_memory_subject_contacts(contact_id, memory_id);`,
  `
  DO $migration$
  DECLARE
    vector_schema pg_catalog.text;
  BEGIN
    SELECT namespace.nspname
    INTO vector_schema
    FROM pg_catalog.pg_extension AS extension
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = extension.extnamespace
    WHERE extension.extname = 'vector';

    IF vector_schema IS NULL OR vector_schema NOT IN ('public', 'extensions') THEN
      RAISE EXCEPTION
        'Memory subject evidence trigger requires pgvector in public or extensions';
    END IF;

    -- Function expressions are planned in the caller's session. Bake the
    -- validated extension schema into vector_eq so tenant-only maintenance
    -- search paths remain safe without replacing pgvector equality semantics.
    EXECUTE pg_catalog.format($function$
      CREATE OR REPLACE FUNCTION psfn_prepare_memory_subject_evidence_change()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $body$
      BEGIN
        IF TG_OP = 'UPDATE' AND (
          NEW.text IS DISTINCT FROM OLD.text
          OR NEW.type IS DISTINCT FROM OLD.type
          OR NEW.source_ref IS DISTINCT FROM OLD.source_ref
          OR NEW.source_type IS DISTINCT FROM OLD.source_type
          OR NEW.provenance_json IS DISTINCT FROM OLD.provenance_json
          OR NEW.provenance_refs IS DISTINCT FROM OLD.provenance_refs
          OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
          OR NEW.scope_ref_kind IS DISTINCT FROM OLD.scope_ref_kind
          OR NEW.scope_ref_id IS DISTINCT FROM OLD.scope_ref_id
          OR NEW.scope_ref_label IS DISTINCT FROM OLD.scope_ref_label
          OR NEW.scope_tags IS DISTINCT FROM OLD.scope_tags
          OR NEW.tags IS DISTINCT FROM OLD.tags
          OR (
            (NEW.embedding IS NULL AND OLD.embedding IS NOT NULL)
            OR (NEW.embedding IS NOT NULL AND OLD.embedding IS NULL)
            OR (
              NEW.embedding IS NOT NULL
              AND OLD.embedding IS NOT NULL
              AND NOT %I.vector_eq(NEW.embedding, OLD.embedding)
            )
          )
          OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
          OR NEW.superseded_by IS DISTINCT FROM OLD.superseded_by
        ) THEN
          NEW.authorization_revision := OLD.authorization_revision + 1;
          NEW.subject_evidence_digest := NULL;
        END IF;
        RETURN NEW;
      END
      $body$;
    $function$, vector_schema);
  END
  $migration$;
  `,
  `DROP TRIGGER IF EXISTS trg_l2_memories_prepare_subject_evidence_change ON l2_memories;`,
  `
  CREATE TRIGGER trg_l2_memories_prepare_subject_evidence_change
  BEFORE UPDATE ON l2_memories
  FOR EACH ROW EXECUTE FUNCTION psfn_prepare_memory_subject_evidence_change();
  `,
  `
  CREATE OR REPLACE FUNCTION psfn_invalidate_memory_subject_projection()
  RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF TG_OP = 'INSERT' OR NEW.subject_evidence_digest IS NULL THEN
      UPDATE l2_memory_subject_classifications
      SET status = 'invalidated', updated_at = (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT
      WHERE memory_id = NEW.id;
    END IF;
    RETURN NEW;
  END
  $$;
  `,
  `DROP TRIGGER IF EXISTS trg_l2_memories_invalidate_subject_projection ON l2_memories;`,
  `
  CREATE TRIGGER trg_l2_memories_invalidate_subject_projection
  AFTER INSERT OR UPDATE ON l2_memories
  FOR EACH ROW EXECUTE FUNCTION psfn_invalidate_memory_subject_projection();
  `,
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
  CREATE TABLE IF NOT EXISTS memory_deletion_proposals (
    id TEXT PRIMARY KEY,
    memory_id TEXT NOT NULL REFERENCES l2_memories(id) ON DELETE RESTRICT,
    memory_authorization_revision BIGINT NOT NULL,
    justification_category TEXT NOT NULL,
    explanation TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN (
      'pending_partner_alert', 'pending_operator_validation', 'approved', 'denied', 'restored'
    )),
    proposed_at BIGINT NOT NULL,
    proposed_by TEXT NOT NULL CHECK (proposed_by = 'Companion'),
    partner_alerted_at BIGINT,
    operator_decided_at BIGINT,
    operator_id TEXT,
    delete_id TEXT REFERENCES l2_memory_delete_versions(delete_id) ON DELETE RESTRICT,
    restored_at BIGINT,
    restored_by TEXT
  );
  `,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_deletion_proposals_pending_memory ON memory_deletion_proposals(memory_id) WHERE status IN ('pending_partner_alert', 'pending_operator_validation');`,
  `CREATE INDEX IF NOT EXISTS idx_memory_deletion_proposals_status ON memory_deletion_proposals(status, proposed_at);`,
  `ALTER TABLE l2_memory_delete_versions ADD COLUMN IF NOT EXISTS proposal_id TEXT REFERENCES memory_deletion_proposals(id) ON DELETE RESTRICT;`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_l2_memory_delete_versions_proposal ON l2_memory_delete_versions(proposal_id) WHERE proposal_id IS NOT NULL;`,
  `
  CREATE TABLE IF NOT EXISTS memory_deletion_audit_events (
    sequence BIGSERIAL PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    proposal_id TEXT NOT NULL REFERENCES memory_deletion_proposals(id) ON DELETE RESTRICT,
    event_type TEXT NOT NULL CHECK (event_type IN (
      'proposed', 'partner_alerted', 'approved', 'denied', 'deleted', 'restored'
    )),
    actor_role TEXT NOT NULL CHECK (actor_role IN ('Companion', 'Partner', 'Operator')),
    actor_id TEXT,
    occurred_at BIGINT NOT NULL,
    delete_id TEXT REFERENCES l2_memory_delete_versions(delete_id) ON DELETE RESTRICT
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_memory_deletion_audit_proposal ON memory_deletion_audit_events(proposal_id, sequence);`,
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
    embedding_document_schema TEXT,
    embedding_provider TEXT,
    embedding_model TEXT,
    embedding_dimensions INTEGER,
    embedding_document_hash TEXT,
    embedding_source_updated_at TIMESTAMPTZ,
    embedding_indexed_at TIMESTAMPTZ,
    embedding_attempted_at TIMESTAMPTZ,
    embedding_last_error TEXT,
    episode_json JSONB NOT NULL,
    affect_authorship TEXT,
    meaning_authorship TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    CHECK (started_at <= ended_at),
    CHECK (status IN ('candidate', 'canonical', 'merged', 'superseded')),
    CHECK (affect_authorship IS NULL OR affect_authorship IN ('none', 'companion', 'companion_preserved')),
    CHECK (meaning_authorship IS NULL OR meaning_authorship IN ('none', 'companion', 'companion_preserved'))
  );
  `,
  // Authorship is deliberately nullable for rows that predate structural
  // first-person authority. NULL means legacy/unknown; it is never guessed or
  // backfilled. Every new store write supplies an explicit value.
  `ALTER TABLE l01_episodes ADD COLUMN IF NOT EXISTS affect_authorship TEXT;`,
  `ALTER TABLE l01_episodes ADD COLUMN IF NOT EXISTS meaning_authorship TEXT;`,
  `ALTER TABLE l01_episodes ADD COLUMN IF NOT EXISTS embedding_document_schema TEXT;`,
  `ALTER TABLE l01_episodes ADD COLUMN IF NOT EXISTS embedding_provider TEXT;`,
  `ALTER TABLE l01_episodes ADD COLUMN IF NOT EXISTS embedding_model TEXT;`,
  `ALTER TABLE l01_episodes ADD COLUMN IF NOT EXISTS embedding_dimensions INTEGER;`,
  `ALTER TABLE l01_episodes ADD COLUMN IF NOT EXISTS embedding_document_hash TEXT;`,
  `ALTER TABLE l01_episodes ADD COLUMN IF NOT EXISTS embedding_source_updated_at TIMESTAMPTZ;`,
  `ALTER TABLE l01_episodes ADD COLUMN IF NOT EXISTS embedding_indexed_at TIMESTAMPTZ;`,
  `ALTER TABLE l01_episodes ADD COLUMN IF NOT EXISTS embedding_attempted_at TIMESTAMPTZ;`,
  `ALTER TABLE l01_episodes ADD COLUMN IF NOT EXISTS embedding_last_error TEXT;`,
  `ALTER TABLE l01_episodes DROP CONSTRAINT IF EXISTS l01_episodes_embedding_dimensions_check;`,
  `ALTER TABLE l01_episodes ADD CONSTRAINT l01_episodes_embedding_dimensions_check CHECK (
    embedding_dimensions IS NULL OR embedding_dimensions > 0
  );`,
  `ALTER TABLE l01_episodes DROP CONSTRAINT IF EXISTS l01_episodes_embedding_document_hash_check;`,
  `ALTER TABLE l01_episodes ADD CONSTRAINT l01_episodes_embedding_document_hash_check CHECK (
    embedding_document_hash IS NULL OR embedding_document_hash ~ '^[a-f0-9]{64}$'
  );`,
  `ALTER TABLE l01_episodes DROP CONSTRAINT IF EXISTS l01_episodes_affect_authorship_check;`,
  `ALTER TABLE l01_episodes ADD CONSTRAINT l01_episodes_affect_authorship_check CHECK (
    affect_authorship IS NULL
    OR affect_authorship IN ('companion', 'companion_preserved')
    OR (affect_authorship = 'none' AND affect_json = '{"labels": []}'::jsonb)
  );`,
  `ALTER TABLE l01_episodes DROP CONSTRAINT IF EXISTS l01_episodes_meaning_authorship_check;`,
  `ALTER TABLE l01_episodes ADD CONSTRAINT l01_episodes_meaning_authorship_check CHECK (
    meaning_authorship IS NULL
    OR (meaning_authorship IN ('companion', 'companion_preserved') AND episode_json ? 'meaning')
    OR (meaning_authorship = 'none' AND NOT (episode_json ? 'meaning'))
  );`,
  `CREATE INDEX IF NOT EXISTS idx_l01_episodes_scope_time ON l01_episodes(channel_id, thread_id, started_at, ended_at);`,
  `CREATE INDEX IF NOT EXISTS idx_l01_episodes_thread_time ON l01_episodes(thread_id, started_at, id);`,
  `CREATE INDEX IF NOT EXISTS idx_l01_episodes_channel_time ON l01_episodes(channel_id, started_at, id);`,
  // ccgdz.8: the custody query asks which episodes were derived from one
  // turn, by containment on `{kind:'turn', refId}`. `jsonb_path_ops` indexes
  // only the `@>` operator this lookup uses.
  `CREATE INDEX IF NOT EXISTS idx_l01_episodes_provenance_refs_gin ON l01_episodes USING GIN (provenance_refs jsonb_path_ops);`,
  `CREATE INDEX IF NOT EXISTS idx_l01_episodes_status ON l01_episodes(status, updated_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_l01_episodes_canonical ON l01_episodes(canonical_episode_id, status);`,
  `CREATE INDEX IF NOT EXISTS idx_l01_episodes_merged ON l01_episodes(merged_into_episode_id) WHERE merged_into_episode_id IS NOT NULL;`,
  `CREATE INDEX IF NOT EXISTS idx_l01_episodes_superseded ON l01_episodes(superseded_by_episode_id) WHERE superseded_by_episode_id IS NOT NULL;`,
  `CREATE INDEX IF NOT EXISTS idx_l01_episodes_embedding_present ON l01_episodes(id) WHERE embedding IS NOT NULL;`,
  `CREATE INDEX IF NOT EXISTS idx_l01_episodes_embedding_profile ON l01_episodes(
    embedding_document_schema, embedding_provider, embedding_model, embedding_dimensions
  ) WHERE embedding IS NOT NULL;`,
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
  // o61vb.9 cutover: the former mixed-authority contact profile table becomes
  // an explicitly non-authoritative Recent Contact Shape. Existing prose rows
  // migrate as schema version 0 and are never loaded; only a rebuild from live,
  // authorized source memories writes version 1 with a bounded fresh_until.
  `
  DO $$
  BEGIN
    IF to_regclass('recent_contact_shapes') IS NULL THEN
      IF to_regclass('contact_profiles') IS NOT NULL THEN
        ALTER TABLE contact_profiles RENAME TO recent_contact_shapes;
      ELSE
        CREATE TABLE recent_contact_shapes (
          contact_id TEXT PRIMARY KEY,
          summary_text TEXT NOT NULL,
          source_memory_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
          confidence_score DOUBLE PRECISION NOT NULL,
          novelty_score DOUBLE PRECISION NOT NULL,
          updated_at BIGINT NOT NULL
        );
      END IF;
    END IF;
  END $$;
  ALTER TABLE recent_contact_shapes
    ADD COLUMN IF NOT EXISTS schema_version INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE recent_contact_shapes
    ADD COLUMN IF NOT EXISTS fresh_until BIGINT;
  UPDATE recent_contact_shapes
    SET fresh_until = updated_at
    WHERE fresh_until IS NULL;
  ALTER TABLE recent_contact_shapes
    ALTER COLUMN fresh_until SET NOT NULL;
  ALTER TABLE recent_contact_shapes
    DROP CONSTRAINT IF EXISTS recent_contact_shapes_schema_version_check;
  ALTER TABLE recent_contact_shapes
    ADD CONSTRAINT recent_contact_shapes_schema_version_check
    CHECK (schema_version IN (0, 1));
  `,
  // psfn-framework-h4bq1: companion-internal tool-writer memories were stamped
  // with the pseudo contact id 'companion:internal', which the subject
  // classifier reads as a (non-existent) contact, so the companion could never
  // see its own notes. Rewrite them to the companion-internal subject scope; the
  // evidence trigger invalidates their classification and bumps the revision,
  // and reopening the classifier checkpoint makes the startup backfill
  // reclassify them before the corpus is exposed. Idempotent: no matching rows
  // leaves both tables untouched.
  `
  WITH repaired AS (
    UPDATE l2_memories
    SET provenance_json = (provenance_json - 'subjectContactId')
      || '{"subjectScope": "companion_internal"}'::jsonb
    WHERE provenance_json ->> 'subjectContactId' = 'companion:internal'
    RETURNING id
  )
  UPDATE l2_memory_subject_backfill_checkpoints
  SET completed = FALSE,
    cursor_memory_id = NULL,
    updated_at = (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT
  WHERE EXISTS (SELECT 1 FROM repaired);
  `,
];
