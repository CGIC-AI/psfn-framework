export const FLEET_AUTH_FIRST_OWNER_FUNCTION_NAME = 'fleet_auth.complete_first_owner_bootstrap';

export const FLEET_AUTH_FIRST_OWNER_FUNCTION_ARG_TYPES =
  'uuid, uuid, text, uuid, text, bigint, bigint, uuid, text, uuid, uuid, uuid, timestamptz, text, text, text, text, text';

/**
 * Narrow SECURITY DEFINER boundary for the one no-existing-owner transition.
 * The runtime cannot mint or update trusted_host_ceremonies, and this function
 * accepts only an already pending OAuth principal plus an exact pre-bound
 * first_owner ceremony. All authority is rechecked under one transaction.
 */
export const FLEET_AUTH_FIRST_OWNER_DDL_SQL = `
DROP FUNCTION IF EXISTS fleet_auth.complete_first_owner_bootstrap(
  uuid, uuid, text, uuid, text, uuid, uuid, uuid, timestamptz
);
DROP FUNCTION IF EXISTS fleet_auth.complete_first_owner_bootstrap(
  uuid, uuid, text, uuid, text, bigint, bigint, uuid, text,
  uuid, uuid, uuid, timestamptz
);
CREATE OR REPLACE FUNCTION fleet_auth.complete_first_owner_bootstrap(
  p_ceremony_id uuid,
  p_principal_id uuid,
  p_provider_subject_id text,
  p_companion_id uuid,
  p_contact_id text,
  p_contact_authority_version bigint,
  p_identity_version bigint,
  p_verification_id uuid,
  p_verification_digest text,
  p_binding_id uuid,
  p_role_grant_id uuid,
  p_audit_event_id uuid,
  p_at timestamptz,
  p_ceremony_digest text,
  p_provider_subject_digest text,
  p_companion_digest text,
  p_contact_digest text,
  p_verification_id_digest text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, fleet_auth
AS $$
DECLARE
  v_generation bigint;
  v_epoch bigint;
  v_new_epoch bigint;
  v_ceremony fleet_auth.trusted_host_ceremonies%ROWTYPE;
  v_principal fleet_auth.human_principals%ROWTYPE;
  v_subject fleet_auth.provider_subjects%ROWTYPE;
  v_new_authn bigint;
  v_new_authz bigint;
  v_now timestamptz;
BEGIN
  IF p_at IS NULL THEN
    RAISE EXCEPTION 'first-owner timestamp is required' USING ERRCODE = '42501';
  END IF;

  SELECT authority_generation, global_auth_epoch
    INTO v_generation, v_epoch
  FROM fleet_auth.authority_state
  WHERE singleton = TRUE
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fleet_auth authority_state singleton is missing' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_ceremony
  FROM fleet_auth.trusted_host_ceremonies
  WHERE ceremony_id = p_ceremony_id
  FOR UPDATE;
  IF NOT FOUND OR v_ceremony.kind <> 'first_owner'
     OR v_ceremony.status <> 'pending'
     OR v_ceremony.global_auth_epoch <> v_epoch THEN
    RAISE EXCEPTION 'trusted-host first-owner ceremony is unavailable' USING ERRCODE = '42501';
  END IF;
  IF v_ceremony.expected_provider <> 'discord'
     OR v_ceremony.expected_provider_subject_id <> p_provider_subject_id
     OR v_ceremony.expected_companion_id IS DISTINCT FROM p_companion_id
     OR v_ceremony.expected_contact_id IS DISTINCT FROM p_contact_id
     OR v_ceremony.exact_scope->>'role' IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'trusted-host first-owner ceremony binding mismatch' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_principal
  FROM fleet_auth.human_principals
  WHERE principal_id = p_principal_id
  FOR UPDATE;
  IF NOT FOUND OR v_principal.status <> 'pending' OR v_principal.restore_state <> 'live' THEN
    RAISE EXCEPTION 'first-owner principal is not pending live authority' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_subject
  FROM fleet_auth.provider_subjects
  WHERE provider = 'discord' AND subject_id = p_provider_subject_id
  FOR UPDATE;
  IF NOT FOUND OR v_subject.principal_id <> p_principal_id
     OR v_subject.state <> 'pending' OR v_subject.restore_state <> 'live'
     OR EXISTS (
       SELECT 1 FROM fleet_auth.provider_subject_tombstones
       WHERE provider = 'discord' AND subject_id = p_provider_subject_id
     ) THEN
    RAISE EXCEPTION 'first-owner provider subject is unavailable' USING ERRCODE = '42501';
  END IF;

  -- The caller timestamp is diagnostic input only. Expiry authority is sampled
  -- from the database after every pre-existing ceremony/principal/provider row
  -- has been locked, so waiting on any of those locks cannot preserve a stale
  -- ceremony past its real expiry.
  v_now := clock_timestamp();
  IF v_ceremony.expires_at <= v_now THEN
    RAISE EXCEPTION 'trusted-host first-owner ceremony expired while acquiring authority locks'
      USING ERRCODE = '42501';
  END IF;
  IF p_contact_authority_version < 1 OR p_identity_version < 1
     OR p_verification_id IS NULL
     OR p_verification_digest !~ '^[0-9a-f]{64}$'
     OR p_ceremony_digest !~ '^[0-9a-f]{64}$'
     OR p_provider_subject_digest !~ '^[0-9a-f]{64}$'
     OR p_companion_digest !~ '^[0-9a-f]{64}$'
     OR p_contact_digest !~ '^[0-9a-f]{64}$'
     OR p_verification_id_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'first-owner contact authority proof is invalid' USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM fleet_auth.principal_role_grants
    WHERE companion_id = p_companion_id
      AND role = 'owner'
      AND lifecycle IN ('active', 'pending')
  ) THEN
    RAISE EXCEPTION 'an owner already exists for this companion' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM fleet_auth.principal_contact_bindings
    WHERE companion_id = p_companion_id
      AND contact_id = p_contact_id
      AND state IN ('active', 'pending')
  ) THEN
    RAISE EXCEPTION 'first-owner contact is already bound' USING ERRCODE = '42501';
  END IF;

  INSERT INTO fleet_auth.companion_authority_state
    (companion_id, lifecycle, authority_generation, created_at, updated_at)
  VALUES (p_companion_id, 'active', v_generation, v_now, v_now)
  ON CONFLICT (companion_id) DO NOTHING;
  IF NOT EXISTS (
    SELECT 1 FROM fleet_auth.companion_authority_state
    WHERE companion_id = p_companion_id
      AND lifecycle = 'active'
      AND restore_state = 'live'
  ) THEN
    RAISE EXCEPTION 'first-owner companion authority is unavailable' USING ERRCODE = '42501';
  END IF;

  v_new_epoch := v_epoch + 1;
  v_new_authn := v_principal.authn_version + 1;
  v_new_authz := v_principal.authz_version + 1;

  UPDATE fleet_auth.human_principals
  SET status = 'active', authn_version = v_new_authn,
      authz_version = v_new_authz,
      binding_version = binding_version + 1,
      grant_version = grant_version + 1,
      policy_version = policy_version + 1,
      updated_at = v_now
  WHERE principal_id = p_principal_id;

  UPDATE fleet_auth.provider_subjects
  SET state = 'active', updated_at = v_now
  WHERE provider = 'discord' AND subject_id = p_provider_subject_id;

  INSERT INTO fleet_auth.principal_contact_bindings
    (binding_id, principal_id, companion_id, contact_id, state,
     verification_provenance, authority_generation, created_at, updated_at)
  VALUES (
    p_binding_id, p_principal_id, p_companion_id, p_contact_id, 'active',
    jsonb_build_object(
      'kind', 'trusted_host_first_owner',
      'ceremonyId', p_ceremony_id::text,
      'provider', 'discord',
      'providerSubjectId', p_provider_subject_id,
      'contactAuthorityVersion', p_contact_authority_version,
      'identityVersion', p_identity_version,
      'verificationId', p_verification_id::text,
      'verificationDigest', p_verification_digest
    ),
    v_generation, v_now, v_now
  );

  INSERT INTO fleet_auth.principal_role_grants
    (grant_id, principal_id, companion_id, role, lifecycle,
     authority_generation, created_at, updated_at)
  VALUES (
    p_role_grant_id, p_principal_id, p_companion_id, 'owner', 'active',
    v_generation, v_now, v_now
  );

  UPDATE fleet_auth.authority_state
  SET global_auth_epoch = v_new_epoch, updated_at = v_now
  WHERE singleton = TRUE;

  UPDATE fleet_auth.browser_sessions
  SET revoked_at = COALESCE(revoked_at, v_now)
  WHERE principal_id = p_principal_id;
  UPDATE fleet_auth.escalation_grants
  SET revoked_at = COALESCE(revoked_at, v_now)
  WHERE principal_id = p_principal_id;
  DELETE FROM fleet_auth.discord_evidence_snapshots
  WHERE principal_id = p_principal_id;
  DELETE FROM fleet_auth.discord_evidence_lifecycle_fences
  WHERE principal_id = p_principal_id;

  UPDATE fleet_auth.trusted_host_ceremonies
  SET status = 'consumed', consumed_at = v_now
  WHERE ceremony_id = p_ceremony_id;

  INSERT INTO fleet_auth.authorization_audit_events
    (event_id, actor_context, action, resource, decision, reason_code,
     companion_id, principal_id, authority_generation, global_auth_epoch,
     occurred_at, decision_id, ceremony_id, decision_context)
  VALUES (
    p_audit_event_id,
    jsonb_build_object(
      'kind', 'trusted_host',
      'id', 'first_owner',
      'ceremonyDigest', p_ceremony_digest
    ),
    'authority.first_owner',
    'first-owner-exact-tuple',
    'allow',
    'trusted_host_oauth_webauthn',
    p_companion_id,
    p_principal_id,
    v_generation,
    v_new_epoch,
    v_now,
    p_audit_event_id,
    p_ceremony_id,
    jsonb_build_object(
      'schemaVersion', 1,
      'provider', 'discord',
      'providerSubjectDigest', p_provider_subject_digest,
      'companionDigest', p_companion_digest,
      'contactDigest', p_contact_digest,
      'role', 'owner',
      'ceremonyDigest', p_ceremony_digest,
      'contactAuthorityVersion', p_contact_authority_version,
      'identityVersion', p_identity_version,
      'verificationIdDigest', p_verification_id_digest,
      'verificationDigest', p_verification_digest,
      'authorityGeneration', v_generation,
      'globalAuthEpoch', v_new_epoch,
      'decision', 'allow'
    )
  );

  RETURN jsonb_build_object(
    'principalId', p_principal_id::text,
    'globalAuthEpoch', v_new_epoch,
    'authnVersion', v_new_authn,
    'authzVersion', v_new_authz,
    'bindingVersion', v_principal.binding_version + 1,
    'grantVersion', v_principal.grant_version + 1,
    'policyVersion', v_principal.policy_version + 1
  );
END;
$$;
`;
