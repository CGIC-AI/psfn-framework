import { FLEET_AUTH_LOCK_AUTHORITY_STATE_DDL_SQL } from './authority-state-lock-sql.js';

export interface FleetAuthMigration {
  version: number;
  name: string;
  sql: string;
}

const DURABLE_AUTHORITY_SQL = `
CREATE TABLE human_principals (
  principal_id UUID PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'suspended', 'revoked', 'quarantined')),
  authn_version BIGINT NOT NULL DEFAULT 1 CHECK (authn_version >= 1),
  authz_version BIGINT NOT NULL DEFAULT 1 CHECK (authz_version >= 1),
  authority_generation BIGINT NOT NULL CHECK (authority_generation >= 1),
  restore_state TEXT NOT NULL DEFAULT 'live' CHECK (restore_state IN ('live', 'quarantined')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE authority_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  authority_generation BIGINT NOT NULL CHECK (authority_generation >= 1),
  global_auth_epoch BIGINT NOT NULL CHECK (global_auth_epoch >= 1),
  restore_checkpoint BIGINT NOT NULL CHECK (restore_checkpoint >= 0),
  activation_generation BIGINT NOT NULL CHECK (activation_generation >= 1),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO authority_state (
  singleton, authority_generation, global_auth_epoch, restore_checkpoint, activation_generation
) VALUES (TRUE, 1, 1, 0, 1)
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE provider_subjects (
  provider TEXT NOT NULL CHECK (provider = 'discord'),
  subject_id TEXT NOT NULL CHECK (subject_id ~ '^[1-9][0-9]{16,19}$'),
  principal_id UUID NOT NULL REFERENCES human_principals(principal_id),
  state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'suspended', 'revoked', 'quarantined')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  authority_generation BIGINT NOT NULL CHECK (authority_generation >= 1),
  restore_state TEXT NOT NULL DEFAULT 'live' CHECK (restore_state IN ('live', 'quarantined')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider, subject_id)
);

CREATE TABLE provider_subject_history (
  event_id UUID PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider = 'discord'),
  subject_id TEXT NOT NULL CHECK (subject_id ~ '^[1-9][0-9]{16,19}$'),
  principal_id UUID NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'suspended', 'revoked', 'quarantined')),
  event_type TEXT NOT NULL CHECK (event_type IN ('created', 'linked', 'unlinked', 'replaced', 'recovered', 'restored')),
  authority_generation BIGINT NOT NULL CHECK (authority_generation >= 1),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE provider_subject_tombstones (
  provider TEXT NOT NULL CHECK (provider = 'discord'),
  subject_id TEXT NOT NULL CHECK (subject_id ~ '^[1-9][0-9]{16,19}$'),
  prior_principal_id UUID NOT NULL,
  authority_generation BIGINT NOT NULL CHECK (authority_generation >= 1),
  revoked_at TIMESTAMPTZ NOT NULL,
  reason_digest TEXT NOT NULL CHECK (reason_digest ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (provider, subject_id)
);

CREATE TABLE principal_contact_bindings (
  binding_id UUID PRIMARY KEY,
  principal_id UUID NOT NULL REFERENCES human_principals(principal_id),
  companion_id UUID NOT NULL,
  contact_id TEXT NOT NULL CHECK (length(contact_id) BETWEEN 1 AND 256),
  state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'conflict', 'suspended', 'revoked', 'quarantined')),
  verification_provenance JSONB NOT NULL CHECK (jsonb_typeof(verification_provenance) = 'object'),
  version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
  authority_generation BIGINT NOT NULL CHECK (authority_generation >= 1),
  restore_state TEXT NOT NULL DEFAULT 'live' CHECK (restore_state IN ('live', 'quarantined')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (principal_id, companion_id, contact_id)
);

CREATE TABLE principal_role_grants (
  grant_id UUID PRIMARY KEY,
  principal_id UUID NOT NULL REFERENCES human_principals(principal_id),
  companion_id UUID NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'guest')),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('pending', 'active', 'suspended', 'revoked', 'quarantined')),
  version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
  authority_generation BIGINT NOT NULL CHECK (authority_generation >= 1),
  restore_state TEXT NOT NULL DEFAULT 'live' CHECK (restore_state IN ('live', 'quarantined')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE UNIQUE INDEX principal_role_one_live_base_role
  ON principal_role_grants (principal_id, companion_id)
  WHERE lifecycle IN ('active', 'pending');

CREATE TABLE passkey_credentials (
  credential_id_hash TEXT PRIMARY KEY CHECK (credential_id_hash ~ '^[0-9a-f]{64}$'),
  principal_id UUID NOT NULL REFERENCES human_principals(principal_id),
  expected_provider TEXT NOT NULL DEFAULT 'discord' CHECK (expected_provider = 'discord'),
  expected_provider_subject_id TEXT NOT NULL CHECK (expected_provider_subject_id ~ '^[1-9][0-9]{16,19}$'),
  rp_id TEXT NOT NULL CHECK (length(rp_id) BETWEEN 1 AND 253),
  public_key_projection TEXT NOT NULL CHECK (length(public_key_projection) > 0),
  credential_generation BIGINT NOT NULL CHECK (credential_generation >= 1),
  state TEXT NOT NULL CHECK (state IN ('pending', 'quarantined', 'suspended', 'revoked')),
  sign_count BIGINT NOT NULL DEFAULT 0 CHECK (sign_count >= 0),
  backup_eligible BOOLEAN NOT NULL DEFAULT FALSE,
  backup_state BOOLEAN NOT NULL DEFAULT FALSE,
  CHECK (NOT backup_state OR backup_eligible),
  authority_floor_generation BIGINT NOT NULL CHECK (authority_floor_generation >= 1),
  restore_state TEXT NOT NULL DEFAULT 'quarantined' CHECK (restore_state = 'quarantined'),
  imported_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE authorization_audit_events (
  event_id UUID PRIMARY KEY,
  actor_context JSONB NOT NULL CHECK (jsonb_typeof(actor_context) = 'object'),
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 128),
  resource TEXT NOT NULL CHECK (length(resource) BETWEEN 1 AND 1024),
  decision TEXT NOT NULL CHECK (decision IN ('allow', 'deny')),
  reason_code TEXT,
  companion_id UUID,
  principal_id UUID,
  authority_generation BIGINT NOT NULL CHECK (authority_generation >= 1),
  global_auth_epoch BIGINT NOT NULL CHECK (global_auth_epoch >= 1),
  correlation_id TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
`;

const EPHEMERAL_AUTHORITY_SQL = `
CREATE TABLE discord_evidence_snapshots (
  evidence_id UUID PRIMARY KEY,
  principal_id UUID NOT NULL REFERENCES human_principals(principal_id),
  provider TEXT NOT NULL DEFAULT 'discord' CHECK (provider = 'discord'),
  provider_subject_id TEXT NOT NULL CHECK (provider_subject_id ~ '^[1-9][0-9]{16,19}$'),
  companion_id UUID NOT NULL,
  guild_id TEXT NOT NULL CHECK (guild_id ~ '^[1-9][0-9]{16,19}$'),
  channel_id TEXT CHECK (channel_id IS NULL OR channel_id ~ '^[1-9][0-9]{16,19}$'),
  permission_inputs JSONB NOT NULL CHECK (jsonb_typeof(permission_inputs) = 'object'),
  discord_permission_result BOOLEAN NOT NULL,
  member_specific_deny_veto BOOLEAN NOT NULL,
  psfn_evidence_result BOOLEAN NOT NULL,
  input_digest TEXT NOT NULL CHECK (input_digest ~ '^[0-9a-f]{64}$'),
  config_digest TEXT NOT NULL CHECK (config_digest ~ '^[0-9a-f]{64}$'),
  provenance JSONB NOT NULL CHECK (jsonb_typeof(provenance) = 'object'),
  global_auth_epoch BIGINT NOT NULL CHECK (global_auth_epoch >= 1),
  fetched_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at > fetched_at)
);

CREATE TABLE oauth_transactions (
  transaction_id UUID PRIMARY KEY,
  state_digest TEXT NOT NULL UNIQUE CHECK (state_digest ~ '^[0-9a-f]{64}$'),
  pkce_verifier_digest TEXT NOT NULL CHECK (pkce_verifier_digest ~ '^[0-9a-f]{64}$'),
  callback_uri TEXT NOT NULL CHECK (callback_uri LIKE 'https://%'),
  return_path TEXT NOT NULL CHECK (return_path LIKE '/%' AND return_path NOT LIKE '//%'),
  kind TEXT NOT NULL DEFAULT 'login' CHECK (kind IN ('login', 'provider_link', 'provider_replace', 'first_owner', 'recovery')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'consumed', 'expired', 'revoked')),
  global_auth_epoch BIGINT NOT NULL CHECK (global_auth_epoch >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  CHECK (expires_at > created_at)
);

CREATE TABLE provider_token_custody (
  custody_id UUID PRIMARY KEY,
  principal_id UUID NOT NULL REFERENCES human_principals(principal_id),
  provider TEXT NOT NULL DEFAULT 'discord' CHECK (provider = 'discord'),
  encrypted_token BYTEA NOT NULL CHECK (octet_length(encrypted_token) > 0),
  key_version INTEGER NOT NULL CHECK (key_version >= 1),
  global_auth_epoch BIGINT NOT NULL CHECK (global_auth_epoch >= 1),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE browser_sessions (
  record_id UUID PRIMARY KEY,
  token_digest TEXT NOT NULL UNIQUE CHECK (token_digest ~ '^[0-9a-f]{64}$'),
  csrf_digest TEXT NOT NULL CHECK (csrf_digest ~ '^[0-9a-f]{64}$'),
  principal_id UUID NOT NULL REFERENCES human_principals(principal_id),
  audience TEXT NOT NULL CHECK (length(audience) BETWEEN 1 AND 256),
  assurance TEXT NOT NULL CHECK (assurance IN ('oauth', 'webauthn_uv', 'break_glass')),
  authn_version BIGINT NOT NULL CHECK (authn_version >= 1),
  authz_version BIGINT NOT NULL CHECK (authz_version >= 1),
  binding_version BIGINT NOT NULL DEFAULT 1 CHECK (binding_version >= 1),
  policy_version BIGINT NOT NULL DEFAULT 1 CHECK (policy_version >= 1),
  global_auth_epoch BIGINT NOT NULL CHECK (global_auth_epoch >= 1),
  idle_expires_at TIMESTAMPTZ NOT NULL,
  absolute_expires_at TIMESTAMPTZ NOT NULL,
  replaced_by UUID,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (absolute_expires_at > created_at),
  CHECK (idle_expires_at <= absolute_expires_at)
);

CREATE TABLE step_up_challenges (
  challenge_id UUID PRIMARY KEY,
  principal_id UUID NOT NULL REFERENCES human_principals(principal_id),
  browser_session_id UUID NOT NULL REFERENCES browser_sessions(record_id),
  challenge_digest TEXT NOT NULL UNIQUE CHECK (challenge_digest ~ '^[0-9a-f]{64}$'),
  kind TEXT NOT NULL CHECK (kind IN ('webauthn_uv', 'discord_possession')),
  action TEXT NOT NULL,
  resource_digest TEXT NOT NULL CHECK (resource_digest ~ '^[0-9a-f]{64}$'),
  global_auth_epoch BIGINT NOT NULL CHECK (global_auth_epoch >= 1),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'consumed', 'expired', 'revoked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  CHECK (expires_at > created_at)
);

CREATE TABLE jit_authorization_grants (
  grant_id UUID PRIMARY KEY,
  principal_id UUID NOT NULL REFERENCES human_principals(principal_id),
  browser_session_id UUID NOT NULL REFERENCES browser_sessions(record_id),
  companion_id UUID NOT NULL,
  subject_scope JSONB NOT NULL CHECK (jsonb_typeof(subject_scope) = 'object'),
  action TEXT NOT NULL,
  resource_selector JSONB NOT NULL CHECK (jsonb_typeof(resource_selector) = 'object'),
  purpose TEXT NOT NULL CHECK (length(purpose) BETWEEN 1 AND 512),
  assurance TEXT NOT NULL CHECK (assurance IN ('webauthn_uv', 'discord_possession')),
  memory_revision BIGINT NOT NULL CHECK (memory_revision >= 1),
  classifier_evidence_digest TEXT NOT NULL CHECK (classifier_evidence_digest ~ '^[0-9a-f]{64}$'),
  authz_version BIGINT NOT NULL CHECK (authz_version >= 1),
  binding_version BIGINT NOT NULL CHECK (binding_version >= 1),
  global_auth_epoch BIGINT NOT NULL CHECK (global_auth_epoch >= 1),
  issued_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  CHECK (expires_at > issued_at)
);

CREATE TABLE trusted_host_ceremonies (
  ceremony_id UUID PRIMARY KEY,
  nonce_digest TEXT NOT NULL UNIQUE CHECK (nonce_digest ~ '^[0-9a-f]{64}$'),
  kind TEXT NOT NULL CHECK (kind IN ('first_owner', 'account_reapproval', 'passkey_enrollment', 'passkey_recovery')),
  expected_provider TEXT NOT NULL DEFAULT 'discord' CHECK (expected_provider = 'discord'),
  expected_provider_subject_id TEXT NOT NULL CHECK (expected_provider_subject_id ~ '^[1-9][0-9]{16,19}$'),
  expected_companion_id UUID,
  expected_contact_id TEXT,
  exact_scope JSONB NOT NULL CHECK (jsonb_typeof(exact_scope) = 'object'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'consumed', 'expired', 'revoked')),
  global_auth_epoch BIGINT NOT NULL CHECK (global_auth_epoch >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  CHECK (expires_at > created_at)
);
`;

const GUARDS_AND_INDEXES_SQL = `
CREATE OR REPLACE FUNCTION reject_immutable_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'fleet_auth immutable relation is append-only' USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS provider_subject_history_append_only ON provider_subject_history;
CREATE TRIGGER provider_subject_history_append_only
  BEFORE UPDATE OR DELETE ON provider_subject_history
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();

DROP TRIGGER IF EXISTS provider_subject_tombstones_append_only ON provider_subject_tombstones;
CREATE TRIGGER provider_subject_tombstones_append_only
  BEFORE UPDATE OR DELETE ON provider_subject_tombstones
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();

DROP TRIGGER IF EXISTS authorization_audit_events_append_only ON authorization_audit_events;
CREATE TRIGGER authorization_audit_events_append_only
  BEFORE UPDATE OR DELETE ON authorization_audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();

CREATE INDEX provider_subjects_principal_idx ON provider_subjects (principal_id);
CREATE INDEX contact_bindings_principal_companion_idx
  ON principal_contact_bindings (principal_id, companion_id, state);
CREATE INDEX role_grants_principal_companion_idx
  ON principal_role_grants (principal_id, companion_id, lifecycle);
CREATE INDEX evidence_lookup_idx
  ON discord_evidence_snapshots (principal_id, companion_id, expires_at);
CREATE INDEX browser_sessions_principal_idx
  ON browser_sessions (principal_id, revoked_at, absolute_expires_at);
CREATE INDEX jit_grants_session_idx
  ON jit_authorization_grants (browser_session_id, revoked_at, expires_at);
CREATE INDEX audit_occurred_idx ON authorization_audit_events (occurred_at, event_id);
`;

const LINEAGE_AND_IDENTITY_GUARDS_SQL = `
ALTER TABLE authority_state
  ADD COLUMN authority_lineage_id TEXT
  CHECK (authority_lineage_id IS NULL OR authority_lineage_id ~ '^[0-9a-f]{64}$');

CREATE TABLE provider_subject_registry (
  provider TEXT NOT NULL CHECK (provider = 'discord'),
  subject_id TEXT NOT NULL CHECK (subject_id ~ '^[1-9][0-9]{16,19}$'),
  principal_id UUID NOT NULL,
  tombstoned BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider, subject_id)
);

-- Freeze every source of durable identity evidence for the backfill window.
-- provider_subject_history is append-only, but a concurrent INSERT during the
-- upgrade could otherwise slip a new principal in between derivation and the
-- trigger install, so it is locked alongside the live and tombstone tables.
LOCK TABLE provider_subjects, provider_subject_tombstones, provider_subject_history
  IN SHARE ROW EXCLUSIVE MODE;

-- Derive one permanent provider/subject owner from ALL immutable identity
-- evidence: current live rows, terminal tombstones, and the append-only
-- history log. A subject linked to a principal only in history (for example
-- one deleted before v4 without a tombstone) must still seed the registry, or
-- it could be resurrected under a different principal after enforcement is
-- installed. Any subject whose combined legacy evidence names more than one
-- principal is ambiguous: fail the entire migration closed with an
-- operator-actionable error instead of silently choosing an owner.
DO $$
DECLARE
  ambiguous RECORD;
BEGIN
  SELECT provider, subject_id
  INTO ambiguous
  FROM (
    SELECT provider, subject_id, principal_id FROM provider_subjects
    UNION
    SELECT provider, subject_id, prior_principal_id FROM provider_subject_tombstones
    UNION
    SELECT provider, subject_id, principal_id FROM provider_subject_history
  ) AS identity_evidence
  GROUP BY provider, subject_id
  HAVING count(DISTINCT principal_id) > 1
  ORDER BY provider, subject_id
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION
      'provider subject %/% has conflicting legacy principal identity evidence; resolve ownership before upgrading',
      ambiguous.provider, ambiguous.subject_id
      USING ERRCODE = '23514';
  END IF;
END;
$$;

-- The ambiguity guard above guarantees exactly one distinct principal per
-- subject, so the deduplicated principal aggregate has a single element that is
-- the sole owner; bool_or(tombstoned) keeps any terminal tombstone permanent.
INSERT INTO provider_subject_registry (provider, subject_id, principal_id, tombstoned)
SELECT
  provider,
  subject_id,
  (array_agg(DISTINCT principal_id))[1] AS principal_id,
  bool_or(tombstoned) AS tombstoned
FROM (
  SELECT provider, subject_id, principal_id, FALSE AS tombstoned
    FROM provider_subjects
  UNION ALL
  SELECT provider, subject_id, prior_principal_id AS principal_id, TRUE AS tombstoned
    FROM provider_subject_tombstones
  UNION ALL
  SELECT provider, subject_id, principal_id, FALSE AS tombstoned
    FROM provider_subject_history
) AS identity_evidence
GROUP BY provider, subject_id
ON CONFLICT (provider, subject_id) DO NOTHING;

CREATE OR REPLACE FUNCTION enforce_provider_subject_registry()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, fleet_auth
AS $$
DECLARE
  registered_principal UUID;
  permanently_tombstoned BOOLEAN;
BEGIN
  INSERT INTO fleet_auth.provider_subject_registry
    (provider, subject_id, principal_id, tombstoned)
  VALUES (NEW.provider, NEW.subject_id, NEW.principal_id, FALSE)
  ON CONFLICT (provider, subject_id) DO NOTHING;

  SELECT principal_id, tombstoned
  INTO registered_principal, permanently_tombstoned
  FROM fleet_auth.provider_subject_registry
  WHERE provider = NEW.provider AND subject_id = NEW.subject_id
  FOR UPDATE;

  IF registered_principal <> NEW.principal_id THEN
    RAISE EXCEPTION 'provider subject is permanently bound to another principal'
      USING ERRCODE = '23505';
  END IF;
  IF permanently_tombstoned AND NEW.state NOT IN ('revoked', 'quarantined') THEN
    RAISE EXCEPTION 'provider subject is permanently tombstoned'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_provider_subject_tombstone_registry()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, fleet_auth
AS $$
DECLARE
  registered_principal UUID;
BEGIN
  INSERT INTO fleet_auth.provider_subject_registry
    (provider, subject_id, principal_id, tombstoned)
  VALUES (NEW.provider, NEW.subject_id, NEW.prior_principal_id, TRUE)
  ON CONFLICT (provider, subject_id) DO NOTHING;

  SELECT principal_id
  INTO registered_principal
  FROM fleet_auth.provider_subject_registry
  WHERE provider = NEW.provider AND subject_id = NEW.subject_id
  FOR UPDATE;

  IF registered_principal <> NEW.prior_principal_id THEN
    RAISE EXCEPTION 'provider subject tombstone conflicts with its permanent principal binding'
      USING ERRCODE = '23514';
  END IF;

  UPDATE fleet_auth.provider_subject_registry
  SET tombstoned = TRUE, updated_at = clock_timestamp()
  WHERE provider = NEW.provider AND subject_id = NEW.subject_id;

  UPDATE fleet_auth.provider_subjects
  SET state = 'revoked', updated_at = clock_timestamp()
  WHERE provider = NEW.provider AND subject_id = NEW.subject_id
    AND state <> 'revoked';
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION reject_untombstoned_provider_subject_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, fleet_auth
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM fleet_auth.provider_subject_registry
    WHERE provider = OLD.provider
      AND subject_id = OLD.subject_id
      AND principal_id = OLD.principal_id
      AND tombstoned = TRUE
  ) THEN
    RAISE EXCEPTION 'provider subject must be permanently tombstoned before deletion'
      USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER provider_subject_registry_guard
  BEFORE INSERT OR UPDATE OF provider, subject_id, principal_id, state
  ON provider_subjects
  FOR EACH ROW EXECUTE FUNCTION enforce_provider_subject_registry();

CREATE TRIGGER provider_subject_delete_guard
  BEFORE DELETE ON provider_subjects
  FOR EACH ROW EXECUTE FUNCTION reject_untombstoned_provider_subject_delete();

CREATE TRIGGER provider_subject_tombstone_registry_guard
  BEFORE INSERT ON provider_subject_tombstones
  FOR EACH ROW EXECUTE FUNCTION enforce_provider_subject_tombstone_registry();

CREATE UNIQUE INDEX contact_binding_one_live_principal
  ON principal_contact_bindings (companion_id, contact_id)
  WHERE state IN ('active', 'pending');
`;

const RESTORED_HISTORY_IDENTITY_GUARD_SQL = `
-- Immutable history is itself permanent provider identity evidence. Migration
-- v4 backfilled pre-existing rows, but restore/import can append history after
-- that one-time backfill. Register every new history row transactionally so a
-- history-only A->subject binding can never later be recreated for B.
--
-- Freeze every identity source and the registry before closing the v4-to-v5
-- trigger gap. SHARE ROW EXCLUSIVE blocks concurrent writes while allowing
-- ordinary reads, so no restore/import row can slip between this backfill and
-- trigger installation.
LOCK TABLE provider_subjects, provider_subject_tombstones,
  provider_subject_history, provider_subject_registry
  IN SHARE ROW EXCLUSIVE MODE;

-- A v4 database can contain history appended before v5 existed. Reject any
-- subject whose history names multiple principals or conflicts with the
-- permanent registry. The migration runner wraps this script and its ledger
-- write in one transaction, so every conflict leaves both registry and schema
-- version untouched.
DO $$
DECLARE
  conflicting RECORD;
BEGIN
  SELECT provider, subject_id
  INTO conflicting
  FROM (
    SELECT provider, subject_id, principal_id FROM provider_subject_history
    UNION
    SELECT provider, subject_id, principal_id FROM provider_subject_registry
  ) AS identity_evidence
  GROUP BY provider, subject_id
  HAVING count(DISTINCT principal_id) > 1
  ORDER BY provider, subject_id
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION
      'provider subject history conflicts with its permanent principal binding for %/%',
      conflicting.provider, conflicting.subject_id
      USING ERRCODE = '23505';
  END IF;
END;
$$;

-- The ambiguity check guarantees one owner per historical subject. Seed every
-- missing permanent binding before the trigger begins enforcing future rows;
-- existing tombstone state and registry timestamps remain unchanged.
INSERT INTO provider_subject_registry (provider, subject_id, principal_id, tombstoned)
SELECT provider, subject_id, (array_agg(DISTINCT principal_id))[1], FALSE
FROM provider_subject_history
GROUP BY provider, subject_id
ON CONFLICT (provider, subject_id) DO NOTHING;

CREATE OR REPLACE FUNCTION enforce_provider_subject_history_registry()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, fleet_auth
AS $$
DECLARE
  registered_principal UUID;
BEGIN
  INSERT INTO fleet_auth.provider_subject_registry
    (provider, subject_id, principal_id, tombstoned)
  VALUES (NEW.provider, NEW.subject_id, NEW.principal_id, FALSE)
  ON CONFLICT (provider, subject_id) DO NOTHING;

  SELECT principal_id
  INTO registered_principal
  FROM fleet_auth.provider_subject_registry
  WHERE provider = NEW.provider AND subject_id = NEW.subject_id
  FOR UPDATE;

  IF registered_principal <> NEW.principal_id THEN
    RAISE EXCEPTION 'provider subject history conflicts with its permanent principal binding'
      USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS provider_subject_history_registry_guard ON provider_subject_history;
CREATE TRIGGER provider_subject_history_registry_guard
  AFTER INSERT ON provider_subject_history
  FOR EACH ROW EXECUTE FUNCTION enforce_provider_subject_history_registry();

`;

const OAUTH_BROKER_SESSION_SQL = `
ALTER TABLE oauth_transactions
  ADD COLUMN pkce_verifier_ciphertext BYTEA,
  ADD COLUMN completed_session_id UUID
    REFERENCES browser_sessions(record_id);

-- Transactions created before the broker could retain its PKCE verifier only
-- contain a digest and can never complete a code exchange. Revoke them rather
-- than attempting a compatibility fallback or accepting PKCE-less callbacks.
UPDATE oauth_transactions
SET status = 'revoked'
WHERE pkce_verifier_ciphertext IS NULL
  AND status = 'pending';

ALTER TABLE browser_sessions
  ADD CONSTRAINT browser_sessions_replacement_fk
  FOREIGN KEY (replaced_by) REFERENCES browser_sessions(record_id);

CREATE INDEX oauth_transactions_expiry_idx
  ON oauth_transactions (status, expires_at);
CREATE INDEX browser_sessions_token_lookup_idx
  ON browser_sessions (token_digest, revoked_at);
`;

const OAUTH_INITIATING_BROWSER_SQL = `
ALTER TABLE oauth_transactions
  ADD COLUMN initiating_browser_digest TEXT
    CHECK (initiating_browser_digest ~ '^[0-9a-f]{64}$');

-- Transactions created before browser binding cannot safely complete. Preserve
-- historical receipts but revoke every still-pending unbound transaction.
UPDATE oauth_transactions
SET status = 'revoked'
WHERE initiating_browser_digest IS NULL
  AND status = 'pending';

ALTER TABLE oauth_transactions
  ADD CONSTRAINT oauth_transactions_pending_browser_bound
  CHECK (status <> 'pending' OR initiating_browser_digest IS NOT NULL);
`;

const HUB_DEVICE_ASSERTION_REPLAY_SQL = `
CREATE TABLE hub_device_assertion_replays (
  issuer TEXT NOT NULL CHECK (length(issuer) BETWEEN 1 AND 128),
  jti UUID NOT NULL,
  assertion_digest TEXT NOT NULL CHECK (assertion_digest ~ '^[0-9a-f]{64}$'),
  device_id TEXT NOT NULL CHECK (length(device_id) BETWEEN 1 AND 256),
  enrollment_version BIGINT NOT NULL CHECK (enrollment_version >= 1),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (issuer, jti),
  CHECK (expires_at > consumed_at)
);

CREATE INDEX hub_device_assertion_replays_expiry_idx
  ON hub_device_assertion_replays (expires_at);
`;

const HUB_DEVICE_ASSERTION_REPLAY_AUDIT_SQL = `
ALTER TABLE hub_device_assertion_replays
  ADD COLUMN replay_count BIGINT NOT NULL DEFAULT 0 CHECK (replay_count >= 0),
  ADD COLUMN last_replayed_at TIMESTAMPTZ,
  ADD COLUMN mismatch_count BIGINT NOT NULL DEFAULT 0 CHECK (mismatch_count >= 0),
  ADD COLUMN last_mismatch_digest TEXT CHECK (last_mismatch_digest ~ '^[0-9a-f]{64}$'),
  ADD COLUMN last_mismatch_at TIMESTAMPTZ,
  ADD CONSTRAINT hub_device_assertion_replay_audit_consistency
    CHECK ((replay_count = 0) = (last_replayed_at IS NULL)),
  ADD CONSTRAINT hub_device_assertion_mismatch_audit_consistency
    CHECK ((mismatch_count = 0) = (last_mismatch_digest IS NULL AND last_mismatch_at IS NULL));
`;

const DISCORD_EVIDENCE_COMPLETENESS_SQL = `
-- Pre-v10 evidence lacks the complete thread/config/reason contract and must
-- never survive as positive authorization input after this migration.
TRUNCATE TABLE discord_evidence_snapshots;

ALTER TABLE discord_evidence_snapshots
  ADD COLUMN thread_id TEXT
    CHECK (thread_id IS NULL OR thread_id ~ '^[1-9][0-9]{16,19}$'),
  ADD COLUMN decision_reason TEXT
    CHECK (decision_reason IS NULL OR decision_reason IN (
      'bot_absent',
      'incomplete_observation',
      'member_specific_deny',
      'membership_removed',
      'missing_private_thread_access',
      'provider_unavailable',
      'required_role_missing',
      'stale_observation',
      'view_channel_denied'
    )),
  ADD COLUMN mapping_config_version BIGINT NOT NULL DEFAULT 1
    CHECK (mapping_config_version >= 1),
  ADD CONSTRAINT discord_evidence_distinct_thread_parent
    CHECK (thread_id IS NULL OR (channel_id IS NOT NULL AND thread_id <> channel_id)),
  ADD CONSTRAINT discord_evidence_positive_consistency
    CHECK (
      NOT psfn_evidence_result
      OR ((
        discord_permission_result
        AND NOT member_specific_deny_veto
        AND decision_reason IS NULL
      ) IS TRUE)
    ),
  ADD CONSTRAINT discord_evidence_positive_inputs
    CHECK (
      NOT psfn_evidence_result
      OR ((
        jsonb_typeof(permission_inputs -> 'oauthGuildMembership') = 'object'
        AND jsonb_typeof(permission_inputs -> 'observation') = 'object'
        AND jsonb_typeof(permission_inputs -> 'target') = 'object'
        AND provenance ->> 'source' = 'discord_oauth_and_bot_observation'
        AND provenance ->> 'provider' = 'discord'
        AND provenance ->> 'providerSubjectId' = provider_subject_id
        AND provenance ->> 'observationStatus' = 'observed'
        AND length(provenance ->> 'observedAt') > 0
        AND length(provenance ->> 'oauthObservedAt') > 0
        AND length(provenance ->> 'observationId') > 0
        AND length(provenance ->> 'botUserId') > 0
      ) IS TRUE)
    ),
  ADD CONSTRAINT discord_evidence_denial_reason
    CHECK (psfn_evidence_result OR decision_reason IS NOT NULL);

CREATE INDEX evidence_exact_input_lookup_idx
  ON discord_evidence_snapshots (
    principal_id,
    companion_id,
    guild_id,
    channel_id,
    thread_id,
    input_digest,
    config_digest,
    mapping_config_version,
    expires_at
  )
  WHERE psfn_evidence_result = TRUE;
`;

const DISCORD_EVIDENCE_LIFECYCLE_FENCE_SQL = `
CREATE TABLE discord_evidence_lifecycle_fences (
  principal_id UUID NOT NULL REFERENCES human_principals(principal_id),
  provider TEXT NOT NULL DEFAULT 'discord' CHECK (provider = 'discord'),
  provider_subject_id TEXT NOT NULL CHECK (provider_subject_id ~ '^[1-9][0-9]{16,19}$'),
  lifecycle_id UUID NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
  mutation_generation BIGINT NOT NULL CHECK (mutation_generation >= 0),
  global_auth_epoch BIGINT NOT NULL CHECK (global_auth_epoch >= 1),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (principal_id, provider, provider_subject_id),
  FOREIGN KEY (provider, provider_subject_id)
    REFERENCES provider_subjects(provider, subject_id)
);

CREATE INDEX discord_evidence_lifecycle_active_idx
  ON discord_evidence_lifecycle_fences (principal_id, provider_subject_id, lifecycle_id)
  WHERE state = 'active';
`;

const ATOMIC_AUTHORITY_LIFECYCLE_SQL = `
-- Central counters make every authorization input part of the session/JIT
-- validity predicate. Existing ephemeral credentials predate exact provider
-- provenance, so they are fenced instead of being guessed during migration.
ALTER TABLE human_principals
  ADD COLUMN binding_version BIGINT NOT NULL DEFAULT 1 CHECK (binding_version >= 1),
  ADD COLUMN grant_version BIGINT NOT NULL DEFAULT 1 CHECK (grant_version >= 1),
  ADD COLUMN policy_version BIGINT NOT NULL DEFAULT 1 CHECK (policy_version >= 1);

ALTER TABLE oauth_transactions
  ADD COLUMN verified_provider TEXT CHECK (verified_provider = 'discord'),
  ADD COLUMN verified_provider_subject_id TEXT
    CHECK (verified_provider_subject_id ~ '^[1-9][0-9]{16,19}$'),
  ADD CONSTRAINT oauth_transaction_verified_provider_pair
    CHECK (
      (verified_provider IS NULL AND verified_provider_subject_id IS NULL)
      OR (verified_provider IS NOT NULL
          AND verified_provider_subject_id IS NOT NULL
          AND status = 'consumed'
          AND consumed_at IS NOT NULL)
    );

UPDATE browser_sessions SET revoked_at = COALESCE(revoked_at, clock_timestamp());
ALTER TABLE browser_sessions
  ADD COLUMN provider TEXT CHECK (provider = 'discord'),
  ADD COLUMN provider_subject_id TEXT
    CHECK (provider_subject_id ~ '^[1-9][0-9]{16,19}$'),
  ADD COLUMN grant_version BIGINT NOT NULL DEFAULT 1 CHECK (grant_version >= 1),
  ADD CONSTRAINT browser_session_exact_provider
    CHECK (revoked_at IS NOT NULL OR (provider IS NOT NULL AND provider_subject_id IS NOT NULL)),
  ADD CONSTRAINT browser_session_provider_subject_fk
    FOREIGN KEY (provider, provider_subject_id)
    REFERENCES provider_subjects(provider, subject_id);

UPDATE provider_token_custody SET revoked_at = COALESCE(revoked_at, clock_timestamp());
ALTER TABLE provider_token_custody
  ADD COLUMN provider_subject_id TEXT
    CHECK (provider_subject_id ~ '^[1-9][0-9]{16,19}$'),
  ADD CONSTRAINT provider_custody_exact_subject
    CHECK (revoked_at IS NOT NULL OR provider_subject_id IS NOT NULL),
  ADD CONSTRAINT provider_custody_subject_fk
    FOREIGN KEY (provider, provider_subject_id)
    REFERENCES provider_subjects(provider, subject_id);

UPDATE jit_authorization_grants SET revoked_at = COALESCE(revoked_at, clock_timestamp());
ALTER TABLE jit_authorization_grants
  ADD COLUMN grant_version BIGINT NOT NULL DEFAULT 1 CHECK (grant_version >= 1),
  ADD COLUMN policy_version BIGINT NOT NULL DEFAULT 1 CHECK (policy_version >= 1);

CREATE TABLE companion_authority_state (
  companion_id UUID PRIMARY KEY,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'removed', 'quarantined')),
  version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
  authority_generation BIGINT NOT NULL CHECK (authority_generation >= 1),
  restore_state TEXT NOT NULL DEFAULT 'live' CHECK (restore_state IN ('live', 'quarantined')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO companion_authority_state (companion_id, lifecycle, authority_generation)
SELECT companion_id, 'active', max(authority_generation)
FROM (
  SELECT companion_id, authority_generation FROM principal_contact_bindings
  UNION ALL
  SELECT companion_id, authority_generation FROM principal_role_grants
) AS existing_companions
GROUP BY companion_id;

CREATE TABLE principal_merge_aliases (
  source_principal_id UUID PRIMARY KEY REFERENCES human_principals(principal_id),
  canonical_principal_id UUID NOT NULL REFERENCES human_principals(principal_id),
  decision_id UUID NOT NULL UNIQUE,
  authority_generation BIGINT NOT NULL CHECK (authority_generation >= 1),
  reason_digest TEXT NOT NULL CHECK (reason_digest ~ '^[0-9a-f]{64}$'),
  restore_state TEXT NOT NULL DEFAULT 'live' CHECK (restore_state IN ('live', 'quarantined')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (source_principal_id <> canonical_principal_id)
);

CREATE TABLE lifecycle_decision_receipts (
  receipt_id UUID PRIMARY KEY,
  decision_id UUID NOT NULL,
  ceremony_id UUID NOT NULL,
  callback_transaction_id UUID,
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 128),
  proof_digest TEXT CHECK (proof_digest ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (decision_id, callback_transaction_id),
  UNIQUE (callback_transaction_id)
);

ALTER TABLE authorization_audit_events
  ADD COLUMN decision_id UUID,
  ADD COLUMN ceremony_id UUID,
  ADD COLUMN reason_digest TEXT CHECK (reason_digest ~ '^[0-9a-f]{64}$'),
  ADD COLUMN decision_context JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(decision_context) = 'object');
CREATE UNIQUE INDEX authorization_audit_lifecycle_decision_unique
  ON authorization_audit_events (decision_id)
  WHERE decision_id IS NOT NULL;

CREATE TRIGGER principal_merge_aliases_append_only
  BEFORE UPDATE OR DELETE ON principal_merge_aliases
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE INDEX principal_merge_aliases_canonical_idx
  ON principal_merge_aliases (canonical_principal_id);
CREATE INDEX lifecycle_decision_receipts_decision_idx
  ON lifecycle_decision_receipts (decision_id);
`;

const LIFECYCLE_OAUTH_PURPOSE_SQL = `
CREATE TABLE authority_floor_tombstone_projection (
  kind TEXT NOT NULL CHECK (kind IN (
    'provider_subject', 'contact_binding', 'role_grant', 'principal', 'companion'
  )),
  resource_hash TEXT NOT NULL CHECK (resource_hash ~ '^[0-9a-f]{64}$'),
  authority_generation BIGINT NOT NULL CHECK (authority_generation >= 1),
  PRIMARY KEY (kind, resource_hash)
);

ALTER TABLE oauth_transactions
  ADD COLUMN lifecycle_ceremony_id UUID,
  ADD COLUMN lifecycle_action TEXT,
  ADD COLUMN lifecycle_proof_role TEXT,
  ADD COLUMN initiating_principal_id UUID REFERENCES human_principals(principal_id),
  ADD COLUMN initiating_session_id UUID REFERENCES browser_sessions(record_id);

-- Pending pre-v14 non-login transactions have no trustworthy lifecycle
-- purpose. Revoke them instead of inferring a ceremony or proof role.
UPDATE oauth_transactions
SET status = 'revoked'
WHERE status = 'pending'
  AND kind <> 'login'
  AND lifecycle_ceremony_id IS NULL;

ALTER TABLE oauth_transactions
  ADD CONSTRAINT oauth_transaction_lifecycle_purpose_complete CHECK (
    (lifecycle_ceremony_id IS NULL
      AND lifecycle_action IS NULL
      AND lifecycle_proof_role IS NULL
      AND initiating_principal_id IS NULL
      AND initiating_session_id IS NULL)
    OR
    (lifecycle_ceremony_id IS NOT NULL
      AND lifecycle_action IS NOT NULL
      AND lifecycle_proof_role IS NOT NULL
      AND initiating_principal_id IS NOT NULL
      AND initiating_session_id IS NOT NULL)
  ),
  ADD CONSTRAINT oauth_transaction_lifecycle_purpose_exact CHECK (
    lifecycle_action IS NULL OR (
      (lifecycle_action IN ('binding.activate', 'provider.add')
        AND lifecycle_proof_role = 'new'
        AND kind = 'provider_link')
      OR (lifecycle_action = 'provider.relink'
        AND lifecycle_proof_role = 'new'
        AND kind = 'recovery')
      OR (lifecycle_action = 'provider.replace'
        AND lifecycle_proof_role IN ('current', 'new')
        AND kind = 'provider_replace')
      OR (lifecycle_action = 'provider.unlink'
        AND lifecycle_proof_role = 'current'
        AND kind = 'recovery')
      OR (lifecycle_action = 'principal.merge'
        AND lifecycle_proof_role IN ('canonical', 'source')
        AND kind = 'recovery')
    )
  );

CREATE UNIQUE INDEX oauth_transaction_lifecycle_proof_unique
  ON oauth_transactions (lifecycle_ceremony_id, lifecycle_proof_role)
  WHERE lifecycle_ceremony_id IS NOT NULL;
`;

const COMPANION_AUTHORITY_LINEAGE_SQL = `
ALTER TABLE companion_authority_state
  ADD COLUMN authority_lineage_id TEXT CHECK (authority_lineage_id ~ '^[0-9a-f]{64}$'),
  ADD COLUMN lineage_generation BIGINT CHECK (lineage_generation >= 1),
  ADD COLUMN readd_decision_id UUID UNIQUE,
  ADD CONSTRAINT companion_authority_lineage_complete CHECK (
    (authority_lineage_id IS NULL AND lineage_generation IS NULL AND readd_decision_id IS NULL)
    OR (authority_lineage_id IS NOT NULL
      AND lineage_generation IS NOT NULL
      AND readd_decision_id IS NOT NULL)
  );

ALTER TABLE authority_floor_tombstone_projection
  DROP CONSTRAINT authority_floor_tombstone_projection_kind_check,
  ADD COLUMN companion_lineage_id TEXT CHECK (companion_lineage_id ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT authority_floor_tombstone_projection_kind_check CHECK (kind IN (
    'provider_subject', 'contact_binding', 'role_grant', 'principal', 'companion',
    'companion_lineage_floor'
  )),
  ADD CONSTRAINT authority_floor_companion_lineage_exact CHECK (
    (kind = 'companion_lineage_floor' AND companion_lineage_id IS NOT NULL)
    OR (kind <> 'companion_lineage_floor' AND companion_lineage_id IS NULL)
  );

ALTER TABLE trusted_host_ceremonies
  DROP CONSTRAINT trusted_host_ceremonies_kind_check,
  ALTER COLUMN expected_provider DROP NOT NULL,
  ALTER COLUMN expected_provider_subject_id DROP NOT NULL,
  ADD CONSTRAINT trusted_host_ceremonies_kind_check CHECK (kind IN (
    'first_owner', 'account_reapproval', 'companion_reapproval',
    'passkey_enrollment', 'passkey_recovery'
  )),
  ADD CONSTRAINT trusted_host_ceremony_provider_scope_exact CHECK (
    (kind = 'companion_reapproval'
      AND expected_provider IS NULL
      AND expected_provider_subject_id IS NULL
      AND expected_companion_id IS NOT NULL
      AND expected_contact_id IS NULL)
    OR (kind <> 'companion_reapproval'
      AND expected_provider = 'discord'
      AND expected_provider_subject_id IS NOT NULL)
  );
`;

const COMPANION_RESTORE_PROJECTION_SQL = `
ALTER TABLE authority_floor_tombstone_projection
  ADD COLUMN companion_readd_decision_id UUID;
`;

export const FLEET_AUTH_MIGRATIONS: readonly FleetAuthMigration[] = [
  { version: 1, name: 'durable_authority', sql: DURABLE_AUTHORITY_SQL },
  { version: 2, name: 'ephemeral_authority', sql: EPHEMERAL_AUTHORITY_SQL },
  { version: 3, name: 'immutable_guards_and_indexes', sql: GUARDS_AND_INDEXES_SQL },
  { version: 4, name: 'lineage_and_identity_guards', sql: LINEAGE_AND_IDENTITY_GUARDS_SQL },
  { version: 5, name: 'restored_history_identity_guard', sql: RESTORED_HISTORY_IDENTITY_GUARD_SQL },
  { version: 6, name: 'oauth_broker_sessions', sql: OAUTH_BROKER_SESSION_SQL },
  { version: 7, name: 'oauth_initiating_browser_binding', sql: OAUTH_INITIATING_BROWSER_SQL },
  { version: 8, name: 'hub_device_assertion_replay', sql: HUB_DEVICE_ASSERTION_REPLAY_SQL },
  { version: 9, name: 'hub_device_assertion_replay_audit', sql: HUB_DEVICE_ASSERTION_REPLAY_AUDIT_SQL },
  { version: 10, name: 'discord_evidence_completeness', sql: DISCORD_EVIDENCE_COMPLETENESS_SQL },
  { version: 11, name: 'discord_evidence_lifecycle_fence', sql: DISCORD_EVIDENCE_LIFECYCLE_FENCE_SQL },
  { version: 12, name: 'exclusive_broker_authority_lock', sql: FLEET_AUTH_LOCK_AUTHORITY_STATE_DDL_SQL },
  { version: 13, name: 'atomic_authority_lifecycle', sql: ATOMIC_AUTHORITY_LIFECYCLE_SQL },
  { version: 14, name: 'lifecycle_oauth_purpose', sql: LIFECYCLE_OAUTH_PURPOSE_SQL },
  { version: 15, name: 'companion_authority_lineage', sql: COMPANION_AUTHORITY_LINEAGE_SQL },
  { version: 16, name: 'companion_restore_projection', sql: COMPANION_RESTORE_PROJECTION_SQL },
] as const;
