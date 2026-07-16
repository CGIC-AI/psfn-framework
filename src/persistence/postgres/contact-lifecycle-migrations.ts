/**
 * Companion-owned exact contact authority evidence and lifecycle saga state.
 * This is intentionally separate from the general contact CRUD schema: these
 * rows are authorization evidence and therefore have stricter transition and
 * restore rules than profile data.
 */
export const POSTGRES_CONTACT_LIFECYCLE_MIGRATIONS = [
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS contact_authority_version BIGINT NOT NULL DEFAULT 1;`,
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS contact_lifecycle_state TEXT NOT NULL DEFAULT 'live';`,
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS contact_restore_state TEXT NOT NULL DEFAULT 'live';`,
  `ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_contact_authority_version_check;`,
  `ALTER TABLE contacts ADD CONSTRAINT contacts_contact_authority_version_check CHECK (contact_authority_version >= 1);`,
  `ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_contact_lifecycle_state_check;`,
  `ALTER TABLE contacts ADD CONSTRAINT contacts_contact_lifecycle_state_check CHECK (contact_lifecycle_state IN ('live', 'deleted', 'quarantined'));`,
  `ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_contact_restore_state_check;`,
  `ALTER TABLE contacts ADD CONSTRAINT contacts_contact_restore_state_check CHECK (contact_restore_state IN ('live', 'quarantined'));`,
  `ALTER TABLE contact_channel_ids ADD COLUMN IF NOT EXISTS identity_version BIGINT NOT NULL DEFAULT 1;`,
  `ALTER TABLE contact_channel_ids ADD COLUMN IF NOT EXISTS ownership_state TEXT NOT NULL DEFAULT 'unverified';`,
  `ALTER TABLE contact_channel_ids ADD COLUMN IF NOT EXISTS verification_id TEXT;`,
  `ALTER TABLE contact_channel_ids ADD COLUMN IF NOT EXISTS verification_digest TEXT;`,
  `ALTER TABLE contact_channel_ids ADD COLUMN IF NOT EXISTS restore_state TEXT NOT NULL DEFAULT 'live';`,
  `ALTER TABLE contact_channel_ids DROP CONSTRAINT IF EXISTS contact_channel_ids_authority_shape_check;`,
  `
  ALTER TABLE contact_channel_ids ADD CONSTRAINT contact_channel_ids_authority_shape_check CHECK (
    identity_version >= 1
    AND ownership_state IN ('unverified', 'verified', 'deleted', 'quarantined')
    AND restore_state IN ('live', 'quarantined')
    AND (
      (ownership_state = 'verified' AND channel = 'discord'
        AND verification_id IS NOT NULL
        AND verification_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        AND verification_digest ~ '^[0-9a-f]{64}$')
      OR (ownership_state <> 'verified')
    )
    AND (restore_state = 'live' OR ownership_state = 'quarantined')
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_contact_channel_ids_exact_authority ON contact_channel_ids(channel, channel_user_id, ownership_state, restore_state, identity_version);`,
  `
  CREATE OR REPLACE FUNCTION prepare_contact_identity_authority_change()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF TG_OP = 'UPDATE' AND (
      NEW.contact_id IS DISTINCT FROM OLD.contact_id
      OR NEW.channel IS DISTINCT FROM OLD.channel
      OR NEW.channel_user_id IS DISTINCT FROM OLD.channel_user_id
      OR NEW.ownership_state IS DISTINCT FROM OLD.ownership_state
      OR NEW.verification_id IS DISTINCT FROM OLD.verification_id
      OR NEW.verification_digest IS DISTINCT FROM OLD.verification_digest
      OR NEW.restore_state IS DISTINCT FROM OLD.restore_state
    ) THEN
      NEW.identity_version := OLD.identity_version + 1;
    ELSIF TG_OP = 'UPDATE' AND NEW.identity_version IS DISTINCT FROM OLD.identity_version THEN
      RAISE EXCEPTION 'contact identity version is database-owned' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END
  $$;
  `,
  `DROP TRIGGER IF EXISTS contact_identity_authority_prepare ON contact_channel_ids;`,
  `
  CREATE TRIGGER contact_identity_authority_prepare
  BEFORE UPDATE ON contact_channel_ids
  FOR EACH ROW EXECUTE FUNCTION prepare_contact_identity_authority_change();
  `,
  `
  CREATE OR REPLACE FUNCTION bump_contact_authority_for_identity_change()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND OLD.contact_id IS DISTINCT FROM NEW.contact_id) THEN
      UPDATE contacts SET contact_authority_version = contact_authority_version + 1
      WHERE id = OLD.contact_id;
    END IF;
    IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
      IF TG_OP = 'INSERT' OR OLD.contact_id IS DISTINCT FROM NEW.contact_id
        OR OLD.channel IS DISTINCT FROM NEW.channel
        OR OLD.channel_user_id IS DISTINCT FROM NEW.channel_user_id
        OR OLD.ownership_state IS DISTINCT FROM NEW.ownership_state
        OR OLD.verification_id IS DISTINCT FROM NEW.verification_id
        OR OLD.verification_digest IS DISTINCT FROM NEW.verification_digest
        OR OLD.restore_state IS DISTINCT FROM NEW.restore_state THEN
        UPDATE contacts SET contact_authority_version = contact_authority_version + 1
        WHERE id = NEW.contact_id;
      END IF;
    END IF;
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END
  $$;
  `,
  `DROP TRIGGER IF EXISTS contact_identity_authority_bump ON contact_channel_ids;`,
  `
  CREATE TRIGGER contact_identity_authority_bump
  AFTER INSERT OR UPDATE OR DELETE ON contact_channel_ids
  FOR EACH ROW EXECUTE FUNCTION bump_contact_authority_for_identity_change();
  `,
  `
  CREATE OR REPLACE FUNCTION quarantine_contact_ownership_for_verification_change()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF OLD.status = 'verified' AND (
      TG_OP = 'DELETE'
      OR NEW.status IS DISTINCT FROM 'verified'
      OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
      OR NEW.source_channel IS DISTINCT FROM OLD.source_channel
      OR NEW.source_user_id IS DISTINCT FROM OLD.source_user_id
      OR NEW.target_channel IS DISTINCT FROM OLD.target_channel
      OR NEW.target_user_id IS DISTINCT FROM OLD.target_user_id
      OR NEW.verified_at IS DISTINCT FROM OLD.verified_at
    ) THEN
      UPDATE contact_channel_ids
      SET ownership_state = 'quarantined', restore_state = 'quarantined'
      WHERE verification_id = OLD.id AND ownership_state = 'verified';
    END IF;
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END
  $$;
  `,
  `DROP TRIGGER IF EXISTS contact_verification_authority_guard ON contact_identity_link_verifications;`,
  `
  CREATE TRIGGER contact_verification_authority_guard
  BEFORE UPDATE OR DELETE ON contact_identity_link_verifications
  FOR EACH ROW EXECUTE FUNCTION quarantine_contact_ownership_for_verification_change();
  `,
  `
  CREATE TABLE IF NOT EXISTS contact_lifecycle_intents (
    intent_id UUID PRIMARY KEY,
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    request_digest TEXT NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
    canonical_request JSONB NOT NULL CHECK (jsonb_typeof(canonical_request) = 'object'),
    action TEXT NOT NULL CHECK (action IN (
      'contact.merge', 'contact.delete', 'contact.discord_unlink',
      'contact.identity_conflict', 'contact.verify', 'contact.reapprove'
    )),
    contact_id TEXT NOT NULL CHECK (length(contact_id) BETWEEN 1 AND 256),
    canonical_contact_id TEXT,
    provider_subject_id TEXT,
    locked_snapshot JSONB,
    snapshot_digest TEXT CHECK (snapshot_digest IS NULL OR snapshot_digest ~ '^[0-9a-f]{64}$'),
    phase TEXT NOT NULL CHECK (phase IN (
      'gateway_prepare_pending', 'contact_commit_pending',
      'gateway_finalize_pending', 'finalized', 'manual_hold', 'quarantined'
    )),
    reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 128),
    retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    lease_owner TEXT,
    lease_expires_at TIMESTAMPTZ,
    restore_state TEXT NOT NULL DEFAULT 'live' CHECK (restore_state IN ('live', 'quarantined')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
    CHECK ((locked_snapshot IS NULL) = (snapshot_digest IS NULL)),
    CHECK (restore_state = 'live' OR phase = 'quarantined'),
    CHECK (
      (action = 'contact.merge' AND canonical_contact_id IS NOT NULL
        AND canonical_contact_id <> contact_id AND provider_subject_id IS NULL)
      OR (action = 'contact.delete' AND canonical_contact_id IS NULL
        AND provider_subject_id IS NULL)
      OR (action IN ('contact.discord_unlink', 'contact.identity_conflict',
                     'contact.verify', 'contact.reapprove')
        AND canonical_contact_id IS NULL
        AND provider_subject_id ~ '^[1-9][0-9]{16,19}$')
    )
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_contact_lifecycle_intents_recovery ON contact_lifecycle_intents(restore_state, phase, next_attempt_at, lease_expires_at, created_at, intent_id);`,
  `
  CREATE TABLE IF NOT EXISTS contact_lifecycle_target_locks (
    intent_id UUID NOT NULL REFERENCES contact_lifecycle_intents(intent_id),
    target_kind TEXT NOT NULL CHECK (target_kind IN ('contact', 'provider_subject')),
    target_id TEXT NOT NULL CHECK (length(target_id) BETWEEN 1 AND 512),
    lock_state TEXT NOT NULL DEFAULT 'active' CHECK (lock_state IN ('active', 'released', 'quarantined')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (intent_id, target_kind, target_id)
  );
  `,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_lifecycle_active_target ON contact_lifecycle_target_locks(target_kind, target_id) WHERE lock_state IN ('active', 'quarantined');`,
  `
  CREATE TABLE IF NOT EXISTS contact_lifecycle_results (
    intent_id UUID NOT NULL REFERENCES contact_lifecycle_intents(intent_id),
    gateway_phase TEXT NOT NULL CHECK (gateway_phase IN ('prepare', 'finalize')),
    result_digest TEXT NOT NULL CHECK (result_digest ~ '^[0-9a-f]{64}$'),
    result JSONB NOT NULL CHECK (jsonb_typeof(result) = 'object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (intent_id, gateway_phase)
  );
  `,
  `
  CREATE OR REPLACE FUNCTION guard_contact_lifecycle_intent_transition()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'contact lifecycle intents are durable' USING ERRCODE = '55000';
    END IF;
    IF NEW.intent_id IS DISTINCT FROM OLD.intent_id
      OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
      OR NEW.request_digest IS DISTINCT FROM OLD.request_digest
      OR NEW.canonical_request IS DISTINCT FROM OLD.canonical_request
      OR NEW.action IS DISTINCT FROM OLD.action
      OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
      OR NEW.canonical_contact_id IS DISTINCT FROM OLD.canonical_contact_id
      OR NEW.provider_subject_id IS DISTINCT FROM OLD.provider_subject_id
      OR NEW.locked_snapshot IS DISTINCT FROM OLD.locked_snapshot
      OR NEW.snapshot_digest IS DISTINCT FROM OLD.snapshot_digest
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
      OR NEW.retry_count < OLD.retry_count
      OR NOT (
        NEW.phase = OLD.phase
        OR (OLD.phase = 'gateway_prepare_pending' AND NEW.phase IN ('contact_commit_pending', 'manual_hold', 'quarantined'))
        OR (OLD.phase = 'contact_commit_pending' AND NEW.phase IN ('gateway_finalize_pending', 'manual_hold', 'quarantined'))
        OR (OLD.phase = 'gateway_finalize_pending' AND NEW.phase IN ('finalized', 'manual_hold', 'quarantined'))
        OR (OLD.phase = 'manual_hold' AND NEW.phase = 'quarantined')
        OR NEW.phase = 'quarantined'
      )
      OR NOT (NEW.restore_state = OLD.restore_state
        OR (OLD.restore_state = 'live' AND NEW.restore_state = 'quarantined')) THEN
      RAISE EXCEPTION 'invalid contact lifecycle intent transition' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END
  $$;
  `,
  `DROP TRIGGER IF EXISTS contact_lifecycle_intent_transition_guard ON contact_lifecycle_intents;`,
  `
  CREATE TRIGGER contact_lifecycle_intent_transition_guard
  BEFORE UPDATE OR DELETE ON contact_lifecycle_intents
  FOR EACH ROW EXECUTE FUNCTION guard_contact_lifecycle_intent_transition();
  `,
  `
  CREATE OR REPLACE FUNCTION guard_contact_lifecycle_lock_transition()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF TG_OP = 'DELETE'
      OR NEW.intent_id IS DISTINCT FROM OLD.intent_id
      OR NEW.target_kind IS DISTINCT FROM OLD.target_kind
      OR NEW.target_id IS DISTINCT FROM OLD.target_id
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
      OR NOT (NEW.lock_state = OLD.lock_state
        OR (OLD.lock_state = 'active' AND NEW.lock_state = 'released')
        OR (OLD.lock_state = 'active' AND NEW.lock_state = 'quarantined')) THEN
      RAISE EXCEPTION 'invalid contact lifecycle target lock transition' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END
  $$;
  `,
  `DROP TRIGGER IF EXISTS contact_lifecycle_target_lock_guard ON contact_lifecycle_target_locks;`,
  `
  CREATE TRIGGER contact_lifecycle_target_lock_guard
  BEFORE UPDATE OR DELETE ON contact_lifecycle_target_locks
  FOR EACH ROW EXECUTE FUNCTION guard_contact_lifecycle_lock_transition();
  `,
  `
  CREATE OR REPLACE FUNCTION reject_contact_lifecycle_result_mutation()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  AS $$
  BEGIN
    RAISE EXCEPTION 'contact lifecycle results are append-only' USING ERRCODE = '55000';
  END
  $$;
  `,
  `DROP TRIGGER IF EXISTS contact_lifecycle_results_append_only ON contact_lifecycle_results;`,
  `
  CREATE TRIGGER contact_lifecycle_results_append_only
  BEFORE UPDATE OR DELETE ON contact_lifecycle_results
  FOR EACH ROW EXECUTE FUNCTION reject_contact_lifecycle_result_mutation();
  `,
] as const;
