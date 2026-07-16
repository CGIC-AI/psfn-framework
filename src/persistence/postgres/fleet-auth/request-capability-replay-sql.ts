export const FLEET_AUTH_CONSUME_REQUEST_CAPABILITY_FUNCTION_NAME =
  'fleet_auth.consume_request_capability';
export const FLEET_AUTH_CONSUME_REQUEST_CAPABILITY_FUNCTION_ARG_TYPES =
  'text,text,text,text,text,text,text,text,text,text,text,text,timestamptz,jsonb';

/**
 * Atomically fences an issuer/JTI pair. Identical retries receive the first
 * durable result while every mutation is denied and recorded using digests
 * only. Callers receive EXECUTE, never DML, on the underlying ledger.
 */
export const FLEET_AUTH_REQUEST_CAPABILITY_REPLAY_DDL_SQL = `
CREATE OR REPLACE FUNCTION ${FLEET_AUTH_CONSUME_REQUEST_CAPABILITY_FUNCTION_NAME}(
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
  p_authority_versions_digest TEXT,
  p_expires_at TIMESTAMPTZ,
  p_consume_result JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, fleet_auth
AS $$
DECLARE
  v_authority fleet_auth.authority_state%ROWTYPE;
  v_replay fleet_auth.request_capability_consumptions%ROWTYPE;
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
     OR p_authority_versions_digest !~ '^[0-9a-f]{64}$'
     OR p_expires_at <= clock_timestamp()
     OR jsonb_typeof(p_consume_result) IS DISTINCT FROM 'object'
     OR NOT p_consume_result ?& ARRAY[
       'schemaVersion', 'decision', 'requestId', 'decisionId', 'targetDigest',
       'audience', 'companionId', 'parentDigest', 'authorityVersionsDigest',
       'expiresAt'
     ]
     OR p_consume_result - ARRAY[
       'schemaVersion', 'decision', 'requestId', 'decisionId', 'targetDigest',
       'audience', 'companionId', 'parentDigest', 'authorityVersionsDigest',
       'expiresAt'
     ]::text[] <> '{}'::jsonb
     OR p_consume_result->'schemaVersion' <> '1'::jsonb
     OR p_consume_result->>'decision' <> 'allow'
     OR (p_consume_result->>'requestId') !~
       '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR (p_consume_result->>'decisionId') !~
       '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_consume_result->>'targetDigest' IS DISTINCT FROM p_target_digest
     OR p_consume_result->>'parentDigest' IS DISTINCT FROM p_parent_digest
     OR p_consume_result->>'authorityVersionsDigest' IS DISTINCT FROM p_authority_versions_digest
     OR encode(sha256(convert_to(p_consume_result->>'audience', 'UTF8')), 'hex')
       IS DISTINCT FROM p_audience_digest
     OR encode(sha256(convert_to(p_consume_result->>'companionId', 'UTF8')), 'hex')
       IS DISTINCT FROM p_companion_digest
     OR encode(sha256(convert_to(p_consume_result->>'decisionId', 'UTF8')), 'hex')
       IS DISTINCT FROM p_decision_digest
     OR jsonb_typeof(p_consume_result->'expiresAt') IS DISTINCT FROM 'number'
     OR (p_consume_result->>'expiresAt')::numeric
       IS DISTINCT FROM floor(extract(epoch FROM p_expires_at)) THEN
    RAISE EXCEPTION 'Invalid request capability replay input'
      USING ERRCODE = '22023';
  END IF;

  -- Match the repository-wide authority lock order before serializing the
  -- replay key. This prevents restore reconciliation from racing consumption.
  SELECT * INTO v_authority
  FROM fleet_auth.authority_state AS authority
  WHERE authority.singleton = TRUE
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fleet_auth authority_state singleton is missing'
      USING ERRCODE = '55000';
  END IF;

  -- Expired capabilities cannot pass the verifier again, so their ephemeral
  -- first-result rows no longer fence any executable authority.
  DELETE FROM fleet_auth.request_capability_consumptions AS expired
  WHERE expired.ctid IN (
    SELECT replay.ctid
    FROM fleet_auth.request_capability_consumptions AS replay
    WHERE replay.expires_at <= clock_timestamp()
    ORDER BY replay.expires_at
    LIMIT 256
  );

  INSERT INTO fleet_auth.request_capability_consumptions
    (issuer, jti, capability_digest, target_digest, body_digest,
     audience_digest, companion_digest, action_digest, resource_digest,
     parent_digest, decision_digest, authority_versions_digest, expires_at,
     consume_result)
  VALUES (
    p_issuer, p_jti, p_capability_digest, p_target_digest, p_body_digest,
    p_audience_digest, p_companion_digest, p_action_digest, p_resource_digest,
    p_parent_digest, p_decision_digest, p_authority_versions_digest,
    p_expires_at, p_consume_result
  )
  ON CONFLICT (issuer, jti) DO NOTHING;
  IF FOUND THEN
    RETURN jsonb_build_object('outcome', 'consumed', 'result', p_consume_result);
  END IF;

  SELECT * INTO v_replay
  FROM fleet_auth.request_capability_consumptions AS replay
  WHERE replay.issuer = p_issuer AND replay.jti = p_jti
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Request capability replay conflict was not readable'
      USING ERRCODE = '55000';
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
     AND v_replay.authority_versions_digest = p_authority_versions_digest THEN
    UPDATE fleet_auth.request_capability_consumptions
    SET replay_count = replay_count + 1,
        last_replayed_at = clock_timestamp()
    WHERE issuer = p_issuer AND jti = p_jti;
    RETURN jsonb_build_object('outcome', 'replayed', 'result', v_replay.consume_result);
  END IF;

  v_context := jsonb_build_object(
    'schemaVersion', 1,
    'issuerDigest', encode(sha256(convert_to(v_replay.issuer, 'UTF8')), 'hex'),
    'jtiDigest', encode(sha256(convert_to(v_replay.jti, 'UTF8')), 'hex'),
    'acceptedCapabilityDigest', v_replay.capability_digest,
    'mutatedCapabilityDigest', p_capability_digest,
    'acceptedTargetDigest', v_replay.target_digest,
    'mutatedTargetDigest', p_target_digest,
    'acceptedBodyDigest', v_replay.body_digest,
    'mutatedBodyDigest', p_body_digest,
    'acceptedAudienceDigest', v_replay.audience_digest,
    'mutatedAudienceDigest', p_audience_digest,
    'acceptedCompanionDigest', v_replay.companion_digest,
    'mutatedCompanionDigest', p_companion_digest,
    'acceptedActionDigest', v_replay.action_digest,
    'mutatedActionDigest', p_action_digest,
    'acceptedResourceDigest', v_replay.resource_digest,
    'mutatedResourceDigest', p_resource_digest,
    'acceptedParentDigest', v_replay.parent_digest,
    'mutatedParentDigest', p_parent_digest,
    'acceptedDecisionDigest', v_replay.decision_digest,
    'mutatedDecisionDigest', p_decision_digest,
    'acceptedAuthorityVersionsDigest', v_replay.authority_versions_digest,
    'mutatedAuthorityVersionsDigest', p_authority_versions_digest
  );
  v_correlation_id := encode(sha256(convert_to(v_context::text, 'UTF8')), 'hex');

  UPDATE fleet_auth.request_capability_consumptions
  SET mismatch_count = mismatch_count + 1,
      last_mismatch_digest = p_capability_digest,
      last_mismatch_at = clock_timestamp()
  WHERE issuer = p_issuer AND jti = p_jti;

  INSERT INTO fleet_auth.authorization_audit_events
    (event_id, actor_context, action, resource, decision, reason_code,
     authority_generation, global_auth_epoch, correlation_id, occurred_at,
     decision_context)
  VALUES (
    gen_random_uuid(), '{"kind":"request_capability"}'::jsonb,
    'request_capability.consume', 'request-capability-replay', 'deny',
    'request_capability_mutated_replay', v_authority.authority_generation,
    v_authority.global_auth_epoch, v_correlation_id, clock_timestamp(), v_context
  )
  ON CONFLICT DO NOTHING;

  RETURN jsonb_build_object('outcome', 'mismatch');
END;
$$;

CREATE OR REPLACE FUNCTION fleet_auth.guard_request_capability_replay_audit_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, fleet_auth
AS $$
DECLARE
  v_schema_owner TEXT;
BEGIN
  IF NEW.action = 'request_capability.consume'
     OR NEW.reason_code IS NOT DISTINCT FROM 'request_capability_mutated_replay' THEN
    SELECT owner_role.rolname INTO v_schema_owner
    FROM pg_namespace AS namespace
    JOIN pg_roles AS owner_role ON owner_role.oid = namespace.nspowner
    WHERE namespace.nspname = 'fleet_auth';
    IF current_user <> v_schema_owner THEN
      RAISE EXCEPTION 'Request capability replay audit can only be appended through a bounded fleet_auth procedure'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS authorization_audit_request_capability_replay_insert_guard
  ON fleet_auth.authorization_audit_events;
CREATE TRIGGER authorization_audit_request_capability_replay_insert_guard
  BEFORE INSERT ON fleet_auth.authorization_audit_events
  FOR EACH ROW EXECUTE FUNCTION fleet_auth.guard_request_capability_replay_audit_insert();

REVOKE ALL ON FUNCTION ${FLEET_AUTH_CONSUME_REQUEST_CAPABILITY_FUNCTION_NAME}(
  ${FLEET_AUTH_CONSUME_REQUEST_CAPABILITY_FUNCTION_ARG_TYPES}
) FROM PUBLIC;
REVOKE ALL ON FUNCTION fleet_auth.guard_request_capability_replay_audit_insert() FROM PUBLIC;
`;
