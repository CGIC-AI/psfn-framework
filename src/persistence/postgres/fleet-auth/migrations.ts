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

export const FLEET_AUTH_MIGRATIONS: readonly FleetAuthMigration[] = [
  { version: 1, name: 'durable_authority', sql: DURABLE_AUTHORITY_SQL },
  { version: 2, name: 'ephemeral_authority', sql: EPHEMERAL_AUTHORITY_SQL },
  { version: 3, name: 'immutable_guards_and_indexes', sql: GUARDS_AND_INDEXES_SQL },
] as const;
