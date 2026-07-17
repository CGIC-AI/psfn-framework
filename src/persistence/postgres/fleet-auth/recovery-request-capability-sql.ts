export const FLEET_AUTH_CONSUME_RECOVERY_CAPABILITY_FUNCTION_NAME =
  'fleet_auth.consume_trusted_host_recovery_capability';
export const FLEET_AUTH_CONSUME_RECOVERY_CAPABILITY_FUNCTION_ARG_TYPES =
  'text,text,text,text,text,text,text,text,text,text,text,text,timestamptz,jsonb,bigint,bigint,bigint';
export const FLEET_AUTH_AUDIT_RECOVERY_CAPABILITY_FUNCTION_NAME =
  'fleet_auth.audit_trusted_host_recovery_capability';
export const FLEET_AUTH_AUDIT_RECOVERY_CAPABILITY_FUNCTION_ARG_TYPES =
  'text,uuid,text,text,text,text,text,text';

/**
 * The recovery lane reuses the request-capability replay ledger and authority
 * lock order. These bounded procedures are the only runtime writers for its
 * consumption and audit records.
 */
export const FLEET_AUTH_RECOVERY_CAPABILITY_DDL_SQL = `
CREATE OR REPLACE FUNCTION ${FLEET_AUTH_AUDIT_RECOVERY_CAPABILITY_FUNCTION_NAME}(
  p_outcome TEXT,
  p_companion_id UUID,
  p_target_digest TEXT,
  p_resource_digest TEXT,
  p_reason_digest TEXT,
  p_credential_id TEXT,
  p_authority_floor_digest TEXT,
  p_correlation_id TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, fleet_auth
AS $$
DECLARE
  v_authority fleet_auth.authority_state%ROWTYPE;
BEGIN
  IF p_outcome NOT IN ('issued', 'revoked', 'denied')
     OR p_target_digest !~ '^[0-9a-f]{64}$'
     OR p_resource_digest !~ '^[0-9a-f]{64}$'
     OR p_reason_digest !~ '^[0-9a-f]{64}$'
     OR p_credential_id !~ '^[0-9a-f]{64}$'
     OR p_authority_floor_digest !~ '^[0-9a-f]{64}$'
     OR p_correlation_id !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid trusted-host recovery audit input' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_authority FROM fleet_auth.authority_state
  WHERE singleton = TRUE FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fleet_auth authority_state singleton is missing' USING ERRCODE = '55000';
  END IF;
  INSERT INTO fleet_auth.authorization_audit_events
    (event_id, actor_context, action, resource, decision, reason_code,
     companion_id, authority_generation, global_auth_epoch, correlation_id,
     occurred_at, decision_context)
  VALUES (
    gen_random_uuid(), jsonb_build_object('kind', 'trusted_host_recovery'),
    'trusted_host_recovery.capability', 'garden-recovery-exact-scope',
    CASE WHEN p_outcome IN ('issued', 'revoked') THEN 'allow' ELSE 'deny' END,
    'trusted_host_recovery_' || p_outcome, p_companion_id,
    v_authority.authority_generation, v_authority.global_auth_epoch,
    p_correlation_id, clock_timestamp(), jsonb_build_object(
      'schemaVersion', 1,
      'outcome', p_outcome,
      'action', 'recovery.begin',
      'targetDigest', p_target_digest,
      'resourceDigest', p_resource_digest,
      'reasonDigest', p_reason_digest,
      'credentialId', p_credential_id,
      'authorityFloorDigest', p_authority_floor_digest
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION ${FLEET_AUTH_CONSUME_RECOVERY_CAPABILITY_FUNCTION_NAME}(
  p_issuer TEXT,
  p_jti TEXT,
  p_capability_digest TEXT,
  p_target_digest TEXT,
  p_body_digest TEXT,
  p_audience_digest TEXT,
  p_companion_digest TEXT,
  p_action_digest TEXT,
  p_resource_digest TEXT,
  p_parent_digest TEXT,
  p_decision_digest TEXT,
  p_authority_floor_digest TEXT,
  p_expires_at TIMESTAMPTZ,
  p_consume_result JSONB,
  p_authority_generation BIGINT,
  p_activation_generation BIGINT,
  p_restore_checkpoint BIGINT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, fleet_auth
AS $$
DECLARE
  v_authority fleet_auth.authority_state%ROWTYPE;
  v_replay fleet_auth.request_capability_consumptions%ROWTYPE;
  v_outcome TEXT;
  v_context JSONB;
  v_correlation_id TEXT;
BEGIN
  IF p_issuer IS NULL OR length(p_issuer) NOT BETWEEN 1 AND 128
     OR p_jti IS NULL OR length(p_jti) NOT BETWEEN 1 AND 256
     OR p_capability_digest !~ '^[0-9a-f]{64}$'
     OR p_target_digest !~ '^[0-9a-f]{64}$'
     OR p_body_digest !~ '^[0-9a-f]{64}$'
     OR p_audience_digest !~ '^[0-9a-f]{64}$'
     OR p_companion_digest !~ '^[0-9a-f]{64}$'
     OR p_action_digest !~ '^[0-9a-f]{64}$'
     OR p_resource_digest !~ '^[0-9a-f]{64}$'
     OR p_parent_digest !~ '^[0-9a-f]{64}$'
     OR p_decision_digest !~ '^[0-9a-f]{64}$'
     OR p_authority_floor_digest !~ '^[0-9a-f]{64}$'
     OR p_authority_generation < 1 OR p_activation_generation < 1
     OR p_restore_checkpoint < 0 OR p_expires_at <= clock_timestamp()
     OR jsonb_typeof(p_consume_result) IS DISTINCT FROM 'object'
     OR NOT p_consume_result ?& ARRAY[
       'schemaVersion', 'kind', 'decision', 'outcome', 'requestId', 'decisionId',
       'targetDigest', 'audience', 'companionId', 'action', 'resourceDigest',
       'reasonDigest', 'credentialId', 'authorityFloorDigest', 'expiresAt'
     ]
     OR p_consume_result - ARRAY[
       'schemaVersion', 'kind', 'decision', 'outcome', 'requestId', 'decisionId',
       'targetDigest', 'audience', 'companionId', 'action', 'resourceDigest',
       'reasonDigest', 'credentialId', 'authorityFloorDigest', 'expiresAt'
     ]::text[] <> '{}'::jsonb
     OR p_consume_result->'schemaVersion' <> '1'::jsonb
     OR p_consume_result->>'kind' <> 'trusted_host_garden_recovery_receipt'
     OR p_consume_result->>'decision' <> 'allow'
     OR p_consume_result->>'outcome' <> 'recovery_ready'
     OR p_consume_result->>'action' <> 'recovery.begin'
     OR (p_consume_result->>'requestId') !~
       '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR (p_consume_result->>'decisionId') !~
       '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR (p_consume_result->>'companionId') !~
       '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_consume_result->>'targetDigest' IS DISTINCT FROM p_target_digest
     OR p_consume_result->>'resourceDigest' IS DISTINCT FROM p_resource_digest
     OR p_consume_result->>'authorityFloorDigest' IS DISTINCT FROM p_authority_floor_digest
     OR (p_consume_result->>'reasonDigest') !~ '^[0-9a-f]{64}$'
     OR (p_consume_result->>'credentialId') !~ '^[0-9a-f]{64}$'
     OR encode(sha256(convert_to(p_consume_result->>'audience', 'UTF8')), 'hex')
       IS DISTINCT FROM p_audience_digest
     OR encode(sha256(convert_to(p_consume_result->>'companionId', 'UTF8')), 'hex')
       IS DISTINCT FROM p_companion_digest
     OR encode(sha256(convert_to(p_consume_result->>'action', 'UTF8')), 'hex')
       IS DISTINCT FROM p_action_digest
     OR encode(sha256(convert_to(p_consume_result->>'decisionId', 'UTF8')), 'hex')
       IS DISTINCT FROM p_decision_digest
     OR (p_consume_result->>'expiresAt')::numeric
       IS DISTINCT FROM floor(extract(epoch FROM p_expires_at)) THEN
    RAISE EXCEPTION 'Invalid trusted-host recovery replay input' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_authority FROM fleet_auth.authority_state
  WHERE singleton = TRUE FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fleet_auth authority_state singleton is missing' USING ERRCODE = '55000';
  END IF;
  IF v_authority.authority_generation <> p_authority_generation
     OR v_authority.activation_generation <> p_activation_generation
     OR v_authority.restore_checkpoint <> p_restore_checkpoint THEN
    v_context := jsonb_build_object(
      'schemaVersion', 1,
      'outcome', 'authority_changed',
      'action', 'recovery.begin',
      'targetDigest', p_target_digest,
      'resourceDigest', p_resource_digest,
      'reasonDigest', p_consume_result->>'reasonDigest',
      'credentialId', p_consume_result->>'credentialId',
      'authorityFloorDigest', p_authority_floor_digest,
      'transportDigest', p_body_digest
    );
    v_correlation_id := encode(sha256(convert_to(
      p_issuer || ':' || p_jti || ':authority_changed:' || p_body_digest, 'UTF8'
    )), 'hex');
    INSERT INTO fleet_auth.authorization_audit_events
      (event_id, actor_context, action, resource, decision, reason_code,
       companion_id, authority_generation, global_auth_epoch, correlation_id,
       occurred_at, decision_context)
    VALUES (
      gen_random_uuid(), '{"kind":"trusted_host_recovery"}'::jsonb,
      'trusted_host_recovery.consume', 'garden-recovery-exact-scope', 'deny',
      'trusted_host_recovery_authority_changed',
      (p_consume_result->>'companionId')::uuid, v_authority.authority_generation,
      v_authority.global_auth_epoch, v_correlation_id, clock_timestamp(), v_context
    );
    RETURN jsonb_build_object('outcome', 'authority_changed');
  END IF;

  DELETE FROM fleet_auth.request_capability_consumptions AS expired
  WHERE expired.ctid IN (
    SELECT replay.ctid FROM fleet_auth.request_capability_consumptions AS replay
    WHERE replay.expires_at <= clock_timestamp()
    ORDER BY replay.expires_at LIMIT 256
  );
  INSERT INTO fleet_auth.request_capability_consumptions
    (issuer, jti, capability_digest, target_digest, body_digest,
     audience_digest, companion_digest, action_digest, resource_digest,
     parent_digest, decision_digest, authority_versions_digest, expires_at,
     consume_result)
  VALUES (
    p_issuer, p_jti, p_capability_digest, p_target_digest, p_body_digest,
    p_audience_digest, p_companion_digest, p_action_digest, p_resource_digest,
    p_parent_digest, p_decision_digest, p_authority_floor_digest,
    p_expires_at, p_consume_result
  ) ON CONFLICT (issuer, jti) DO NOTHING;
  IF FOUND THEN
    v_outcome := 'consumed';
  ELSE
    SELECT * INTO v_replay FROM fleet_auth.request_capability_consumptions AS replay
    WHERE replay.issuer = p_issuer AND replay.jti = p_jti FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Trusted-host recovery replay conflict was not readable' USING ERRCODE = '55000';
    END IF;
    IF v_replay.capability_digest = p_capability_digest
       AND v_replay.target_digest = p_target_digest
       AND v_replay.body_digest = p_body_digest
       AND v_replay.audience_digest = p_audience_digest
       AND v_replay.companion_digest = p_companion_digest
       AND v_replay.action_digest = p_action_digest
       AND v_replay.resource_digest = p_resource_digest
       AND v_replay.parent_digest = p_parent_digest
       AND v_replay.decision_digest = p_decision_digest
       AND v_replay.authority_versions_digest = p_authority_floor_digest THEN
      UPDATE fleet_auth.request_capability_consumptions
      SET replay_count = replay_count + 1, last_replayed_at = clock_timestamp()
      WHERE issuer = p_issuer AND jti = p_jti;
      v_outcome := 'replayed';
      p_consume_result := v_replay.consume_result;
    ELSE
      UPDATE fleet_auth.request_capability_consumptions
      SET mismatch_count = mismatch_count + 1,
          last_mismatch_digest = p_capability_digest,
          last_mismatch_at = clock_timestamp()
      WHERE issuer = p_issuer AND jti = p_jti;
      v_outcome := 'mismatch';
    END IF;
  END IF;

  v_context := jsonb_build_object(
    'schemaVersion', 1,
    'outcome', v_outcome,
    'action', 'recovery.begin',
    'targetDigest', p_target_digest,
    'resourceDigest', p_resource_digest,
    'reasonDigest', p_consume_result->>'reasonDigest',
    'credentialId', p_consume_result->>'credentialId',
    'authorityFloorDigest', p_authority_floor_digest,
    'transportDigest', p_body_digest
  );
  v_correlation_id := encode(sha256(convert_to(
    p_issuer || ':' || p_jti || ':' || v_outcome || ':' || p_body_digest, 'UTF8'
  )), 'hex');
  INSERT INTO fleet_auth.authorization_audit_events
    (event_id, actor_context, action, resource, decision, reason_code,
     companion_id, authority_generation, global_auth_epoch, correlation_id,
     occurred_at, decision_context)
  VALUES (
    gen_random_uuid(), '{"kind":"trusted_host_recovery"}'::jsonb,
    'trusted_host_recovery.consume', 'garden-recovery-exact-scope',
    CASE WHEN v_outcome IN ('consumed', 'replayed') THEN 'allow' ELSE 'deny' END,
    'trusted_host_recovery_' || v_outcome,
    (p_consume_result->>'companionId')::uuid, v_authority.authority_generation,
    v_authority.global_auth_epoch, v_correlation_id, clock_timestamp(), v_context
  );
  IF v_outcome = 'mismatch' THEN RETURN jsonb_build_object('outcome', 'mismatch'); END IF;
  RETURN jsonb_build_object('outcome', v_outcome, 'result', p_consume_result);
END;
$$;

CREATE OR REPLACE FUNCTION fleet_auth.guard_trusted_host_recovery_audit_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, fleet_auth
AS $$
DECLARE
  v_schema_owner TEXT;
BEGIN
  IF NEW.action IN ('trusted_host_recovery.capability', 'trusted_host_recovery.consume')
     OR NEW.reason_code LIKE 'trusted_host_recovery_%' THEN
    SELECT owner_role.rolname INTO v_schema_owner
    FROM pg_namespace AS namespace
    JOIN pg_roles AS owner_role ON owner_role.oid = namespace.nspowner
    WHERE namespace.nspname = 'fleet_auth';
    IF current_user <> v_schema_owner THEN
      RAISE EXCEPTION 'Trusted-host recovery audit requires a bounded fleet_auth procedure'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS authorization_audit_trusted_host_recovery_insert_guard
  ON fleet_auth.authorization_audit_events;
CREATE TRIGGER authorization_audit_trusted_host_recovery_insert_guard
  BEFORE INSERT ON fleet_auth.authorization_audit_events
  FOR EACH ROW EXECUTE FUNCTION fleet_auth.guard_trusted_host_recovery_audit_insert();

REVOKE ALL ON FUNCTION ${FLEET_AUTH_CONSUME_RECOVERY_CAPABILITY_FUNCTION_NAME}(
  ${FLEET_AUTH_CONSUME_RECOVERY_CAPABILITY_FUNCTION_ARG_TYPES}
) FROM PUBLIC;
REVOKE ALL ON FUNCTION ${FLEET_AUTH_AUDIT_RECOVERY_CAPABILITY_FUNCTION_NAME}(
  ${FLEET_AUTH_AUDIT_RECOVERY_CAPABILITY_FUNCTION_ARG_TYPES}
) FROM PUBLIC;
REVOKE ALL ON FUNCTION fleet_auth.guard_trusted_host_recovery_audit_insert() FROM PUBLIC;
`;
