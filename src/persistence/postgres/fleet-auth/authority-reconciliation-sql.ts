import {
  FLEET_AUTH_FLOOR_RESOURCE_TOMBSTONED_FUNCTION_NAME,
} from './authority-floor-read-sql.js';

export const FLEET_AUTH_RECONCILE_FUNCTION_NAME =
  'fleet_auth.reconcile_authority_floor';
export const FLEET_AUTH_RECONCILE_FUNCTION_ARG_TYPES =
  'text,bigint,bigint,bigint,uuid';

/**
 * The runtime broker may advance authority only toward a non-restored floor.
 * Keeping the complete quarantine/epoch transition in this constrained
 * SECURITY DEFINER function makes it atomic with provider revocation without
 * granting ordinary UPDATE authority over fleet_auth.authority_state.
 */
export const FLEET_AUTH_RECONCILIATION_DDL_SQL = `
CREATE OR REPLACE FUNCTION ${FLEET_AUTH_RECONCILE_FUNCTION_NAME}(
  p_authority_lineage_id TEXT,
  p_authority_generation BIGINT,
  p_restore_checkpoint BIGINT,
  p_activation_generation BIGINT,
  p_audit_event_id UUID
)
RETURNS TABLE (global_auth_epoch BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, fleet_auth
AS $$
DECLARE
  current_state fleet_auth.authority_state%ROWTYPE;
  floor_advanced BOOLEAN;
  owner_principal_ids UUID[] := ARRAY[]::UUID[];
  owner_companion_ids UUID[] := ARRAY[]::UUID[];
  owner_provider_subject_ids TEXT[] := ARRAY[]::TEXT[];
  owner_binding_ids UUID[] := ARRAY[]::UUID[];
  owner_grant_ids UUID[] := ARRAY[]::UUID[];
BEGIN
  IF p_authority_lineage_id !~ '^[0-9a-f]{64}$'
    OR p_authority_generation < 1
    OR p_restore_checkpoint < 0
    OR p_activation_generation < 1 THEN
    RAISE EXCEPTION 'Invalid non-restored fleet_auth authority floor'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO current_state
  FROM fleet_auth.authority_state AS state
  WHERE state.singleton = TRUE
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fleet_auth authority_state singleton is missing'
      USING ERRCODE = '55000';
  END IF;
  IF current_state.authority_lineage_id IS NOT NULL
    AND current_state.authority_lineage_id <> p_authority_lineage_id THEN
    RAISE EXCEPTION
      'Restorable fleet_auth authority lineage does not match its non-restored trusted-host floor'
      USING ERRCODE = '22023';
  END IF;
  IF current_state.authority_generation > p_authority_generation
    OR current_state.restore_checkpoint > p_restore_checkpoint
    OR current_state.activation_generation > p_activation_generation THEN
    RAISE EXCEPTION
      'Restorable fleet_auth authority is ahead of its non-restored trusted-host floor'
      USING ERRCODE = '22023';
  END IF;

  floor_advanced := current_state.authority_generation < p_authority_generation
    OR current_state.restore_checkpoint < p_restore_checkpoint
    OR current_state.activation_generation < p_activation_generation;
  IF NOT floor_advanced THEN
    IF current_state.authority_lineage_id IS NULL THEN
      UPDATE fleet_auth.authority_state
      SET authority_lineage_id = p_authority_lineage_id,
          updated_at = clock_timestamp()
      WHERE singleton = TRUE;
    END IF;
    RETURN QUERY SELECT current_state.global_auth_epoch;
    RETURN;
  END IF;

  SELECT COALESCE(array_agg(DISTINCT principal.principal_id), ARRAY[]::UUID[]),
         COALESCE(array_agg(DISTINCT companion.companion_id), ARRAY[]::UUID[]),
         COALESCE(array_agg(DISTINCT role_grant.grant_id), ARRAY[]::UUID[])
  INTO owner_principal_ids, owner_companion_ids, owner_grant_ids
  FROM fleet_auth.human_principals AS principal
  JOIN fleet_auth.principal_role_grants AS role_grant
    ON role_grant.principal_id = principal.principal_id
  JOIN fleet_auth.companion_authority_state AS companion
    ON companion.companion_id = role_grant.companion_id
  WHERE principal.status = 'active'
    AND principal.restore_state = 'live'
    AND principal.authority_generation = current_state.authority_generation
    AND role_grant.role = 'owner'
    AND role_grant.lifecycle = 'active'
    AND role_grant.restore_state = 'live'
    AND role_grant.version = principal.grant_version
    AND role_grant.authority_generation = current_state.authority_generation
    AND companion.lifecycle = 'active'
    AND companion.restore_state = 'live'
    AND companion.authority_generation = current_state.authority_generation
    AND NOT ${FLEET_AUTH_FLOOR_RESOURCE_TOMBSTONED_FUNCTION_NAME}(
      'principal', principal.principal_id::text
    )
    AND NOT ${FLEET_AUTH_FLOOR_RESOURCE_TOMBSTONED_FUNCTION_NAME}(
      'role_grant', role_grant.grant_id::text
    )
    AND NOT ${FLEET_AUTH_FLOOR_RESOURCE_TOMBSTONED_FUNCTION_NAME}(
      'companion', companion.companion_id::text
    );

  SELECT COALESCE(
    array_agg(DISTINCT subject.provider || ':' || subject.subject_id),
    ARRAY[]::TEXT[]
  )
  INTO owner_provider_subject_ids
  FROM fleet_auth.provider_subjects AS subject
  WHERE subject.principal_id = ANY(owner_principal_ids)
    AND subject.state = 'active'
    AND subject.restore_state = 'live'
    AND subject.authority_generation = current_state.authority_generation
    AND NOT ${FLEET_AUTH_FLOOR_RESOURCE_TOMBSTONED_FUNCTION_NAME}(
      'provider_subject', subject.provider || ':' || subject.subject_id
    );

  SELECT COALESCE(array_agg(DISTINCT binding.binding_id), ARRAY[]::UUID[])
  INTO owner_binding_ids
  FROM fleet_auth.principal_contact_bindings AS binding
  JOIN fleet_auth.principal_role_grants AS role_grant
    ON role_grant.principal_id = binding.principal_id
   AND role_grant.companion_id = binding.companion_id
  JOIN fleet_auth.human_principals AS principal
    ON principal.principal_id = binding.principal_id
  WHERE role_grant.grant_id = ANY(owner_grant_ids)
    AND binding.state = 'active'
    AND binding.restore_state = 'live'
    AND binding.version = principal.binding_version
    AND binding.authority_generation = current_state.authority_generation
    AND NOT ${FLEET_AUTH_FLOOR_RESOURCE_TOMBSTONED_FUNCTION_NAME}(
      'contact_binding', binding.binding_id::text
    );

  UPDATE fleet_auth.human_principals
  SET status = CASE WHEN status = 'revoked' THEN status ELSE 'quarantined' END,
      restore_state = 'quarantined', updated_at = clock_timestamp()
  WHERE principal_id <> ALL(owner_principal_ids);
  UPDATE fleet_auth.companion_authority_state
  SET lifecycle = CASE WHEN lifecycle = 'removed' THEN lifecycle ELSE 'quarantined' END,
      restore_state = 'quarantined', updated_at = clock_timestamp()
  WHERE companion_id <> ALL(owner_companion_ids);
  UPDATE fleet_auth.provider_subjects
  SET state = CASE WHEN state = 'revoked' THEN state ELSE 'quarantined' END,
      restore_state = 'quarantined', updated_at = clock_timestamp()
  WHERE provider || ':' || subject_id <> ALL(owner_provider_subject_ids);
  UPDATE fleet_auth.principal_contact_bindings
  SET state = CASE WHEN state = 'revoked' THEN state ELSE 'quarantined' END,
      restore_state = 'quarantined', updated_at = clock_timestamp()
  WHERE binding_id <> ALL(owner_binding_ids);
  UPDATE fleet_auth.principal_role_grants
  SET lifecycle = CASE WHEN lifecycle = 'revoked' THEN lifecycle ELSE 'quarantined' END,
      restore_state = 'quarantined', updated_at = clock_timestamp()
  WHERE grant_id <> ALL(owner_grant_ids);
  UPDATE fleet_auth.contact_authority_intents
  SET state = 'quarantined', restore_state = 'quarantined',
      updated_at = clock_timestamp();

  UPDATE fleet_auth.human_principals
  SET authority_generation = p_authority_generation,
      updated_at = clock_timestamp()
  WHERE principal_id = ANY(owner_principal_ids);
  UPDATE fleet_auth.companion_authority_state
  SET authority_generation = p_authority_generation,
      updated_at = clock_timestamp()
  WHERE companion_id = ANY(owner_companion_ids);
  UPDATE fleet_auth.provider_subjects
  SET authority_generation = p_authority_generation,
      updated_at = clock_timestamp()
  WHERE provider || ':' || subject_id = ANY(owner_provider_subject_ids);
  UPDATE fleet_auth.principal_contact_bindings
  SET authority_generation = p_authority_generation,
      updated_at = clock_timestamp()
  WHERE binding_id = ANY(owner_binding_ids);
  UPDATE fleet_auth.principal_role_grants
  SET authority_generation = p_authority_generation,
      updated_at = clock_timestamp()
  WHERE grant_id = ANY(owner_grant_ids);

  DELETE FROM fleet_auth.escalation_grants;
  DELETE FROM fleet_auth.oauth_transactions;
  DELETE FROM fleet_auth.browser_sessions;
  DELETE FROM fleet_auth.provider_token_custody;
  DELETE FROM fleet_auth.discord_evidence_lifecycle_fences;
  DELETE FROM fleet_auth.discord_evidence_snapshots;
  DELETE FROM fleet_auth.trusted_host_ceremonies;
  DELETE FROM fleet_auth.hub_device_assertion_replays;
  DELETE FROM fleet_auth.lifecycle_decision_receipts;

  UPDATE fleet_auth.authority_state
  SET authority_lineage_id = p_authority_lineage_id,
      authority_generation = p_authority_generation,
      global_auth_epoch = current_state.global_auth_epoch + 1,
      restore_checkpoint = p_restore_checkpoint,
      activation_generation = p_activation_generation,
      updated_at = clock_timestamp()
  WHERE singleton = TRUE;
  INSERT INTO fleet_auth.authorization_audit_events
    (event_id, actor_context, action, resource, decision, reason_code,
     authority_generation, global_auth_epoch)
  VALUES (p_audit_event_id,
          '{"kind":"system","id":"fleet-auth-startup"}'::jsonb,
          'authority.reconcile', 'fleet_auth', 'deny',
          'restored_authority_quarantined', p_authority_generation,
          current_state.global_auth_epoch + 1);

  RETURN QUERY SELECT current_state.global_auth_epoch + 1;
END;
$$;

REVOKE ALL ON FUNCTION ${FLEET_AUTH_RECONCILE_FUNCTION_NAME}(
  ${FLEET_AUTH_RECONCILE_FUNCTION_ARG_TYPES}
) FROM PUBLIC;
`;
