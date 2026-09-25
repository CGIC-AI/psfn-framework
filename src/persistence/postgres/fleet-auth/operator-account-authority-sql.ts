// Self-contained DDL for audited ADMIN_TOKEN operator account authority
// (psfn-framework-aol3m, key-or-SSO ruling). This module owns no imports so
// schema.ts can reference it without an import cycle; like the other bounded
// procedures it is reasserted idempotently on every migration run.
//
// Quarantined (restored) authority rows can only change inside schema-owner
// context (restore_quarantine_*_guard). These SECURITY DEFINER procedures are
// that context for the key operator: each one first proves, inside the same
// transaction, a durable `admin_token_operator` approval row written by the
// gateway for exactly this action, companion, audit event and current
// authority snapshot. No Discord session, OAuth proof or SSO principal is
// involved; the non-restored authority floor projection (tombstones, companion
// lineage) still wins, and every call appends one immutable audit event whose
// id is single-use.

export const FLEET_AUTH_OPERATOR_REINSTATE_PRINCIPAL_FUNCTION_NAME =
  'fleet_auth.operator_reinstate_principal';
export const FLEET_AUTH_OPERATOR_REINSTATE_PRINCIPAL_FUNCTION_ARG_TYPES =
  'uuid, uuid, uuid, uuid, uuid, uuid';
export const FLEET_AUTH_OPERATOR_REINSTATE_COMPANION_FUNCTION_NAME =
  'fleet_auth.operator_reinstate_companion';
export const FLEET_AUTH_OPERATOR_REINSTATE_COMPANION_FUNCTION_ARG_TYPES =
  'uuid, uuid, uuid, bigint';
export const FLEET_AUTH_OPERATOR_SET_PRINCIPAL_STATUS_FUNCTION_NAME =
  'fleet_auth.operator_set_principal_status';
export const FLEET_AUTH_OPERATOR_SET_PRINCIPAL_STATUS_FUNCTION_ARG_TYPES =
  'uuid, uuid, uuid, uuid, boolean';

export const FLEET_AUTH_OPERATOR_ACCOUNT_AUTHORITY_DDL_SQL = `
-- Internal: the exact gateway approval row for one operator account action.
CREATE OR REPLACE FUNCTION fleet_auth.operator_account_approval_is_exact(
  p_approval_event_id uuid,
  p_audit_event_id uuid,
  p_companion_id uuid,
  p_action text,
  p_generation bigint,
  p_epoch bigint
) RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, fleet_auth
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM fleet_auth.authorization_audit_events AS approval
    WHERE approval.event_id = p_approval_event_id
      AND approval.actor_context ->> 'kind' = 'admin_token_operator'
      AND approval.actor_context ->> 'boundary' = 'fleet_auth_lifecycle'
      AND approval.decision = 'allow'
      AND approval.reason_code = 'admin_token_lifecycle_approval_allowed'
      AND approval.action = 'roles.manage'
      AND approval.companion_id = p_companion_id
      AND approval.resource = format('companion:%s:fleet-auth-lifecycle', p_companion_id)
      AND approval.authority_generation = p_generation
      AND approval.global_auth_epoch = p_epoch
      AND approval.decision_context ->> 'lifecycleDecisionId' = p_audit_event_id::text
      AND approval.decision_context ->> 'lifecycleAction' = p_action
  ) AND p_approval_event_id <> p_audit_event_id;
$$;
REVOKE ALL ON FUNCTION fleet_auth.operator_account_approval_is_exact(
  uuid, uuid, uuid, text, bigint, bigint
) FROM PUBLIC;

-- Internal: advance the auth epoch, fence the affected principal's ephemeral
-- authority (when given) and carry everyone else's to the new epoch.
CREATE OR REPLACE FUNCTION fleet_auth.operator_account_epoch_rollover(
  p_principal_id uuid,
  p_epoch bigint,
  p_now timestamptz
) RETURNS bigint
LANGUAGE plpgsql
SET search_path = pg_catalog, fleet_auth
AS $$
DECLARE
  v_new_epoch bigint := p_epoch + 1;
BEGIN
  UPDATE fleet_auth.authority_state
  SET global_auth_epoch = v_new_epoch, updated_at = p_now
  WHERE singleton = TRUE AND global_auth_epoch = p_epoch;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fleet_auth authority changed during operator account action'
      USING ERRCODE = '42501';
  END IF;
  IF p_principal_id IS NOT NULL THEN
    UPDATE fleet_auth.browser_sessions SET revoked_at = COALESCE(revoked_at, p_now)
    WHERE principal_id = p_principal_id;
    UPDATE fleet_auth.escalation_grants SET revoked_at = COALESCE(revoked_at, p_now)
    WHERE principal_id = p_principal_id;
    UPDATE fleet_auth.provider_token_custody SET revoked_at = COALESCE(revoked_at, p_now)
    WHERE principal_id = p_principal_id;
    DELETE FROM fleet_auth.discord_evidence_snapshots WHERE principal_id = p_principal_id;
    DELETE FROM fleet_auth.discord_evidence_lifecycle_fences WHERE principal_id = p_principal_id;
    UPDATE fleet_auth.oauth_transactions SET status = 'revoked'
    WHERE status = 'pending' AND initiating_principal_id = p_principal_id;
  END IF;
  UPDATE fleet_auth.browser_sessions SET global_auth_epoch = v_new_epoch
  WHERE global_auth_epoch = p_epoch AND principal_id IS DISTINCT FROM p_principal_id;
  UPDATE fleet_auth.escalation_grants SET global_auth_epoch = v_new_epoch
  WHERE global_auth_epoch = p_epoch AND principal_id IS DISTINCT FROM p_principal_id;
  UPDATE fleet_auth.provider_token_custody SET global_auth_epoch = v_new_epoch
  WHERE global_auth_epoch = p_epoch AND principal_id IS DISTINCT FROM p_principal_id;
  UPDATE fleet_auth.discord_evidence_snapshots SET global_auth_epoch = v_new_epoch
  WHERE global_auth_epoch = p_epoch;
  UPDATE fleet_auth.discord_evidence_lifecycle_fences SET global_auth_epoch = v_new_epoch
  WHERE global_auth_epoch = p_epoch;
  UPDATE fleet_auth.oauth_transactions SET global_auth_epoch = v_new_epoch
  WHERE status = 'pending' AND global_auth_epoch = p_epoch;
  RETURN v_new_epoch;
END;
$$;
REVOKE ALL ON FUNCTION fleet_auth.operator_account_epoch_rollover(uuid, bigint, timestamptz)
  FROM PUBLIC;

CREATE OR REPLACE FUNCTION fleet_auth.operator_account_tombstoned(p_kind text, p_resource_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, fleet_auth
AS $$
  SELECT EXISTS (
    SELECT 1 FROM fleet_auth.authority_floor_tombstone_projection AS floor
    WHERE floor.kind = p_kind
      AND floor.resource_hash = encode(sha256(convert_to(p_resource_id, 'UTF8')), 'hex')
  );
$$;
REVOKE ALL ON FUNCTION fleet_auth.operator_account_tombstoned(text, text) FROM PUBLIC;

-- Reinstate one quarantined (restored) account for one companion: the
-- principal, its non-tombstoned quarantined provider subjects, and the exact
-- contact binding and role grant. The companion must already be live.
CREATE OR REPLACE FUNCTION fleet_auth.operator_reinstate_principal(
  p_approval_event_id uuid,
  p_audit_event_id uuid,
  p_companion_id uuid,
  p_principal_id uuid,
  p_binding_id uuid,
  p_role_grant_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, fleet_auth
AS $$
DECLARE
  v_generation bigint;
  v_epoch bigint;
  v_new_epoch bigint;
  v_now timestamptz := clock_timestamp();
  v_principal fleet_auth.human_principals%ROWTYPE;
  v_companion fleet_auth.companion_authority_state%ROWTYPE;
  v_binding fleet_auth.principal_contact_bindings%ROWTYPE;
  v_grant fleet_auth.principal_role_grants%ROWTYPE;
  v_subjects integer;
BEGIN
  SELECT authority_generation, global_auth_epoch INTO v_generation, v_epoch
  FROM fleet_auth.authority_state WHERE singleton = TRUE FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fleet_auth authority_state singleton is missing' USING ERRCODE = '42501';
  END IF;
  IF NOT fleet_auth.operator_account_approval_is_exact(
    p_approval_event_id, p_audit_event_id, p_companion_id, 'principal.reinstate',
    v_generation, v_epoch
  ) THEN
    RAISE EXCEPTION 'operator account approval is missing, stale, or not for this action'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_companion FROM fleet_auth.companion_authority_state
  WHERE companion_id = p_companion_id FOR UPDATE;
  IF NOT FOUND OR v_companion.lifecycle <> 'active' OR v_companion.restore_state <> 'live' THEN
    RAISE EXCEPTION 'companion authority must be live before an account is reinstated'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_principal FROM fleet_auth.human_principals
  WHERE principal_id = p_principal_id FOR UPDATE;
  IF NOT FOUND OR v_principal.restore_state <> 'quarantined'
     OR v_principal.status NOT IN ('quarantined', 'active') THEN
    RAISE EXCEPTION 'principal is not a quarantined restore candidate' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_binding FROM fleet_auth.principal_contact_bindings
  WHERE binding_id = p_binding_id FOR UPDATE;
  IF NOT FOUND OR v_binding.principal_id <> p_principal_id
     OR v_binding.companion_id <> p_companion_id
     OR v_binding.restore_state <> 'quarantined'
     OR v_binding.state NOT IN ('quarantined', 'active') THEN
    RAISE EXCEPTION 'contact binding is not a quarantined restore candidate of this account'
      USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_grant FROM fleet_auth.principal_role_grants
  WHERE grant_id = p_role_grant_id FOR UPDATE;
  IF NOT FOUND OR v_grant.principal_id <> p_principal_id
     OR v_grant.companion_id <> p_companion_id
     OR v_grant.restore_state <> 'quarantined'
     OR v_grant.lifecycle NOT IN ('quarantined', 'active') THEN
    RAISE EXCEPTION 'role grant is not a quarantined restore candidate of this account'
      USING ERRCODE = '42501';
  END IF;

  IF fleet_auth.operator_account_tombstoned('principal', p_principal_id::text)
     OR fleet_auth.operator_account_tombstoned('companion', p_companion_id::text)
     OR fleet_auth.operator_account_tombstoned('contact_binding', p_binding_id::text)
     OR fleet_auth.operator_account_tombstoned('role_grant', p_role_grant_id::text) THEN
    RAISE EXCEPTION 'account authority is tombstoned by the non-restored floor'
      USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM fleet_auth.principal_contact_bindings
    WHERE companion_id = p_companion_id AND contact_id = v_binding.contact_id
      AND binding_id <> p_binding_id AND state IN ('active', 'pending')
  ) THEN
    RAISE EXCEPTION 'contact binding conflicts with a live binding' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM fleet_auth.principal_role_grants
    WHERE principal_id = p_principal_id AND companion_id = p_companion_id
      AND grant_id <> p_role_grant_id AND lifecycle IN ('active', 'pending')
  ) THEN
    RAISE EXCEPTION 'role grant conflicts with a live grant' USING ERRCODE = '42501';
  END IF;

  UPDATE fleet_auth.provider_subjects AS subject
  SET state = 'active', restore_state = 'live',
      authority_generation = v_generation, updated_at = v_now
  WHERE subject.principal_id = p_principal_id
    AND subject.restore_state = 'quarantined'
    AND subject.state IN ('quarantined', 'active')
    AND NOT EXISTS (
      SELECT 1 FROM fleet_auth.provider_subject_tombstones AS tombstone
      WHERE tombstone.provider = subject.provider AND tombstone.subject_id = subject.subject_id
    )
    AND NOT fleet_auth.operator_account_tombstoned(
      'provider_subject', subject.provider || ':' || subject.subject_id
    );
  SELECT count(*) INTO v_subjects FROM fleet_auth.provider_subjects
  WHERE principal_id = p_principal_id AND state = 'active' AND restore_state = 'live';
  IF v_subjects = 0 THEN
    RAISE EXCEPTION 'account has no reinstatable provider subject' USING ERRCODE = '42501';
  END IF;

  UPDATE fleet_auth.human_principals
  SET status = 'active', restore_state = 'live',
      authn_version = authn_version + 1, authz_version = authz_version + 1,
      binding_version = binding_version + 1, grant_version = grant_version + 1,
      policy_version = policy_version + 1,
      authority_generation = v_generation, updated_at = v_now
  WHERE principal_id = p_principal_id;
  UPDATE fleet_auth.principal_contact_bindings
  SET state = 'active', restore_state = 'live', version = version + 1,
      authority_generation = v_generation, updated_at = v_now
  WHERE binding_id = p_binding_id;
  UPDATE fleet_auth.principal_role_grants
  SET lifecycle = 'active', restore_state = 'live', version = version + 1,
      authority_generation = v_generation, updated_at = v_now
  WHERE grant_id = p_role_grant_id;

  v_new_epoch := fleet_auth.operator_account_epoch_rollover(p_principal_id, v_epoch, v_now);

  INSERT INTO fleet_auth.authorization_audit_events
    (event_id, actor_context, action, resource, decision, reason_code,
     companion_id, principal_id, authority_generation, global_auth_epoch,
     occurred_at, decision_id, decision_context)
  VALUES (
    p_audit_event_id,
    jsonb_build_object('kind', 'admin_token_operator', 'boundary', 'fleet_auth_lifecycle',
      'principalId', 'admin-token-operator', 'authorizationEventId', p_approval_event_id::text),
    'principal.reinstate',
    format('principal:%s;binding:%s;role:%s', p_principal_id, p_binding_id, p_role_grant_id),
    'allow', 'admin_token_operator_account_lifecycle',
    p_companion_id, p_principal_id, v_generation, v_new_epoch,
    v_now, p_audit_event_id,
    jsonb_build_object('schemaVersion', 1, 'action', 'principal.reinstate',
      'approvalEventId', p_approval_event_id::text,
      'beforeStatus', v_principal.status, 'afterStatus', 'active',
      'bindingVersion', v_binding.version + 1, 'roleGrantVersion', v_grant.version + 1)
  );
  RETURN jsonb_build_object(
    'action', 'principal.reinstate', 'principalId', p_principal_id::text,
    'companionId', p_companion_id::text, 'authorityGeneration', v_generation,
    'globalAuthEpoch', v_new_epoch, 'auditEventId', p_audit_event_id::text
  );
END;
$$;
REVOKE ALL ON FUNCTION fleet_auth.operator_reinstate_principal(uuid, uuid, uuid, uuid, uuid, uuid)
  FROM PUBLIC;

-- Reinstate a quarantined companion authority (restored from backup, or a
-- re-added lineage) on the exact version the operator saw. A re-added lineage
-- must still be admitted by the non-restored floor projection.
CREATE OR REPLACE FUNCTION fleet_auth.operator_reinstate_companion(
  p_approval_event_id uuid,
  p_audit_event_id uuid,
  p_companion_id uuid,
  p_companion_version bigint
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, fleet_auth
AS $$
DECLARE
  v_generation bigint;
  v_epoch bigint;
  v_new_epoch bigint;
  v_now timestamptz := clock_timestamp();
  v_companion fleet_auth.companion_authority_state%ROWTYPE;
BEGIN
  SELECT authority_generation, global_auth_epoch INTO v_generation, v_epoch
  FROM fleet_auth.authority_state WHERE singleton = TRUE FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fleet_auth authority_state singleton is missing' USING ERRCODE = '42501';
  END IF;
  IF NOT fleet_auth.operator_account_approval_is_exact(
    p_approval_event_id, p_audit_event_id, p_companion_id, 'companion.reinstate',
    v_generation, v_epoch
  ) THEN
    RAISE EXCEPTION 'operator account approval is missing, stale, or not for this action'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_companion FROM fleet_auth.companion_authority_state
  WHERE companion_id = p_companion_id FOR UPDATE;
  IF NOT FOUND OR v_companion.version <> p_companion_version
     OR NOT (v_companion.lifecycle = 'quarantined' OR v_companion.restore_state = 'quarantined')
     OR v_companion.lifecycle = 'removed' THEN
    RAISE EXCEPTION 'companion authority is not a quarantined restore candidate at this version'
      USING ERRCODE = '42501';
  END IF;
  IF v_companion.authority_lineage_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM fleet_auth.authority_floor_tombstone_projection AS lineage
      WHERE lineage.kind = 'companion_lineage_floor'
        AND lineage.resource_hash = encode(sha256(convert_to(p_companion_id::text, 'UTF8')), 'hex')
        AND lineage.authority_generation = v_companion.lineage_generation
        AND lineage.companion_lineage_id = v_companion.authority_lineage_id
        AND lineage.companion_readd_decision_id = v_companion.readd_decision_id
    ) THEN
      RAISE EXCEPTION 'companion authority lineage is not admitted by the non-restored floor'
        USING ERRCODE = '42501';
    END IF;
  ELSIF fleet_auth.operator_account_tombstoned('companion', p_companion_id::text) THEN
    RAISE EXCEPTION 'companion authority is tombstoned by the non-restored floor'
      USING ERRCODE = '42501';
  END IF;

  UPDATE fleet_auth.companion_authority_state
  SET lifecycle = 'active', restore_state = 'live', version = version + 1,
      authority_generation = v_generation, updated_at = v_now
  WHERE companion_id = p_companion_id;

  v_new_epoch := fleet_auth.operator_account_epoch_rollover(NULL, v_epoch, v_now);

  INSERT INTO fleet_auth.authorization_audit_events
    (event_id, actor_context, action, resource, decision, reason_code,
     companion_id, authority_generation, global_auth_epoch,
     occurred_at, decision_id, decision_context)
  VALUES (
    p_audit_event_id,
    jsonb_build_object('kind', 'admin_token_operator', 'boundary', 'fleet_auth_lifecycle',
      'principalId', 'admin-token-operator', 'authorizationEventId', p_approval_event_id::text),
    'companion.reinstate',
    format('companion:%s', p_companion_id),
    'allow', 'admin_token_operator_account_lifecycle',
    p_companion_id, v_generation, v_new_epoch,
    v_now, p_audit_event_id,
    jsonb_build_object('schemaVersion', 1, 'action', 'companion.reinstate',
      'approvalEventId', p_approval_event_id::text,
      'beforeLifecycle', v_companion.lifecycle, 'beforeRestoreState', v_companion.restore_state,
      'beforeVersion', p_companion_version, 'afterVersion', p_companion_version + 1)
  );
  RETURN jsonb_build_object(
    'action', 'companion.reinstate', 'companionId', p_companion_id::text,
    'companionVersion', p_companion_version + 1, 'authorityGeneration', v_generation,
    'globalAuthEpoch', v_new_epoch, 'auditEventId', p_audit_event_id::text
  );
END;
$$;
REVOKE ALL ON FUNCTION fleet_auth.operator_reinstate_companion(uuid, uuid, uuid, bigint)
  FROM PUBLIC;

-- Disable (suspend) or re-enable a live account. Suspension ends every
-- session of the account at once; re-enabling requires a fresh sign-in.
CREATE OR REPLACE FUNCTION fleet_auth.operator_set_principal_status(
  p_approval_event_id uuid,
  p_audit_event_id uuid,
  p_companion_id uuid,
  p_principal_id uuid,
  p_enabled boolean
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, fleet_auth
AS $$
DECLARE
  v_generation bigint;
  v_epoch bigint;
  v_new_epoch bigint;
  v_now timestamptz := clock_timestamp();
  v_principal fleet_auth.human_principals%ROWTYPE;
  v_action text := CASE WHEN p_enabled THEN 'principal.reactivate' ELSE 'principal.suspend' END;
  v_expected_status text := CASE WHEN p_enabled THEN 'suspended' ELSE 'active' END;
BEGIN
  IF p_enabled IS NULL THEN
    RAISE EXCEPTION 'operator account status input is invalid' USING ERRCODE = '42501';
  END IF;
  SELECT authority_generation, global_auth_epoch INTO v_generation, v_epoch
  FROM fleet_auth.authority_state WHERE singleton = TRUE FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fleet_auth authority_state singleton is missing' USING ERRCODE = '42501';
  END IF;
  IF NOT fleet_auth.operator_account_approval_is_exact(
    p_approval_event_id, p_audit_event_id, p_companion_id, v_action, v_generation, v_epoch
  ) THEN
    RAISE EXCEPTION 'operator account approval is missing, stale, or not for this action'
      USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_principal FROM fleet_auth.human_principals
  WHERE principal_id = p_principal_id FOR UPDATE;
  IF NOT FOUND OR v_principal.restore_state <> 'live'
     OR v_principal.status <> v_expected_status THEN
    RAISE EXCEPTION 'account is not in the expected state for %', v_action USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM fleet_auth.principal_contact_bindings
    WHERE principal_id = p_principal_id AND companion_id = p_companion_id
      AND restore_state = 'live'
  ) THEN
    RAISE EXCEPTION 'account is not bound to this companion' USING ERRCODE = '42501';
  END IF;

  UPDATE fleet_auth.human_principals
  SET status = CASE WHEN p_enabled THEN 'active' ELSE 'suspended' END,
      authn_version = authn_version + 1, authz_version = authz_version + 1,
      policy_version = policy_version + 1, updated_at = v_now
  WHERE principal_id = p_principal_id;

  v_new_epoch := fleet_auth.operator_account_epoch_rollover(p_principal_id, v_epoch, v_now);

  INSERT INTO fleet_auth.authorization_audit_events
    (event_id, actor_context, action, resource, decision, reason_code,
     companion_id, principal_id, authority_generation, global_auth_epoch,
     occurred_at, decision_id, decision_context)
  VALUES (
    p_audit_event_id,
    jsonb_build_object('kind', 'admin_token_operator', 'boundary', 'fleet_auth_lifecycle',
      'principalId', 'admin-token-operator', 'authorizationEventId', p_approval_event_id::text),
    v_action,
    format('principal:%s', p_principal_id),
    'allow', 'admin_token_operator_account_lifecycle',
    p_companion_id, p_principal_id, v_generation, v_new_epoch,
    v_now, p_audit_event_id,
    jsonb_build_object('schemaVersion', 1, 'action', v_action,
      'approvalEventId', p_approval_event_id::text,
      'beforeStatus', v_principal.status,
      'afterStatus', CASE WHEN p_enabled THEN 'active' ELSE 'suspended' END)
  );
  RETURN jsonb_build_object(
    'action', v_action, 'principalId', p_principal_id::text,
    'companionId', p_companion_id::text, 'authorityGeneration', v_generation,
    'globalAuthEpoch', v_new_epoch, 'auditEventId', p_audit_event_id::text
  );
END;
$$;
REVOKE ALL ON FUNCTION fleet_auth.operator_set_principal_status(uuid, uuid, uuid, uuid, boolean)
  FROM PUBLIC;
`;
