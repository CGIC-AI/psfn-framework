export const FLEET_AUTH_CONSUME_HUB_REPLAY_FUNCTION_NAME =
  'fleet_auth.consume_hub_device_assertion_replay';
export const FLEET_AUTH_CONSUME_HUB_REPLAY_FUNCTION_ARG_TYPES =
  'text,uuid,text,text,bigint,timestamptz,text,text,text,text,text,text,text,text';

export const FLEET_AUTH_IMPORT_HUB_REPLAY_AUDIT_FUNCTION_NAME =
  'fleet_auth.import_hub_mutated_replay_audit';
export const FLEET_AUTH_IMPORT_HUB_REPLAY_AUDIT_FUNCTION_ARG_TYPES =
  'uuid,bigint,bigint,timestamptz,jsonb';

/**
 * Hub replay enforcement is deliberately narrower than ordinary ephemeral
 * table DML. The runtime receives only the consume procedure; the restore
 * coordinator receives only the exact durable-denial importer. Both execute as
 * the schema owner so the underlying replay row and audit event remain outside
 * either caller's direct mutation authority.
 */
export const FLEET_AUTH_HUB_REPLAY_BOUNDARY_DDL_SQL = `
CREATE OR REPLACE FUNCTION fleet_auth.hub_mutated_replay_correlation(
  p_context JSONB
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, fleet_auth
AS $$
  SELECT encode(sha256(convert_to(jsonb_build_array(
    p_context->>'issuerDigest',
    p_context->>'keyIdDigest',
    p_context->>'audienceDigest',
    p_context->>'companionIdDigest',
    p_context->>'deviceIdDigest',
    p_context->>'sessionIdDigest',
    p_context->>'enrollmentVersionDigest',
    p_context->>'jtiDigest',
    p_context->>'acceptedAssertionDigest',
    p_context->>'mutatedAssertionDigest'
  )::text, 'UTF8')), 'hex')
$$;

CREATE OR REPLACE FUNCTION fleet_auth.hub_mutated_replay_context_is_exact(
  p_context JSONB
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, fleet_auth
AS $$
  SELECT jsonb_typeof(p_context) = 'object'
    AND p_context ?& ARRAY[
      'schemaVersion',
      'issuerDigest',
      'keyIdDigest',
      'audienceDigest',
      'companionIdDigest',
      'deviceIdDigest',
      'sessionIdDigest',
      'enrollmentVersionDigest',
      'jtiDigest',
      'acceptedAssertionDigest',
      'mutatedAssertionDigest'
    ]
    AND p_context - ARRAY[
      'schemaVersion',
      'issuerDigest',
      'keyIdDigest',
      'audienceDigest',
      'companionIdDigest',
      'deviceIdDigest',
      'sessionIdDigest',
      'enrollmentVersionDigest',
      'jtiDigest',
      'acceptedAssertionDigest',
      'mutatedAssertionDigest'
    ]::text[] = '{}'::jsonb
    AND p_context->'schemaVersion' = '1'::jsonb
    AND (p_context->>'issuerDigest') ~ '^[0-9a-f]{64}$'
    AND (p_context->>'keyIdDigest') ~ '^[0-9a-f]{64}$'
    AND (p_context->>'audienceDigest') ~ '^[0-9a-f]{64}$'
    AND (p_context->>'companionIdDigest') ~ '^[0-9a-f]{64}$'
    AND (p_context->>'deviceIdDigest') ~ '^[0-9a-f]{64}$'
    AND (p_context->>'sessionIdDigest') ~ '^[0-9a-f]{64}$'
    AND (p_context->>'enrollmentVersionDigest') ~ '^[0-9a-f]{64}$'
    AND (p_context->>'jtiDigest') ~ '^[0-9a-f]{64}$'
    AND (p_context->>'acceptedAssertionDigest') ~ '^[0-9a-f]{64}$'
    AND (p_context->>'mutatedAssertionDigest') ~ '^[0-9a-f]{64}$'
$$;

CREATE OR REPLACE FUNCTION ${FLEET_AUTH_CONSUME_HUB_REPLAY_FUNCTION_NAME}(
  p_issuer TEXT,
  p_jti UUID,
  p_assertion_digest TEXT,
  p_device_id TEXT,
  p_enrollment_version BIGINT,
  p_expires_at TIMESTAMPTZ,
  p_issuer_digest TEXT,
  p_key_id_digest TEXT,
  p_audience_digest TEXT,
  p_companion_id_digest TEXT,
  p_device_id_digest TEXT,
  p_session_id_digest TEXT,
  p_enrollment_version_digest TEXT,
  p_jti_digest TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, fleet_auth
AS $$
DECLARE
  v_authority fleet_auth.authority_state%ROWTYPE;
  v_replay fleet_auth.hub_device_assertion_replays%ROWTYPE;
  v_context JSONB;
  v_correlation_id TEXT;
  v_inserted_event UUID;
BEGIN
  IF p_issuer IS NULL OR length(p_issuer) NOT BETWEEN 1 AND 128
     OR p_jti IS NULL
     OR p_assertion_digest !~ '^[0-9a-f]{64}$'
     OR p_device_id IS NULL OR length(p_device_id) NOT BETWEEN 1 AND 256
     OR p_enrollment_version < 1
     OR p_expires_at <= clock_timestamp()
     OR p_issuer_digest IS DISTINCT FROM encode(sha256(convert_to(p_issuer, 'UTF8')), 'hex')
     OR p_device_id_digest IS DISTINCT FROM encode(sha256(convert_to(p_device_id, 'UTF8')), 'hex')
     OR p_enrollment_version_digest IS DISTINCT FROM encode(
       sha256(convert_to(p_enrollment_version::text, 'UTF8')), 'hex'
     )
     OR p_jti_digest IS DISTINCT FROM encode(sha256(convert_to(p_jti::text, 'UTF8')), 'hex')
     OR p_key_id_digest !~ '^[0-9a-f]{64}$'
     OR p_audience_digest !~ '^[0-9a-f]{64}$'
     OR p_companion_id_digest !~ '^[0-9a-f]{64}$'
     OR p_session_id_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid Hub device assertion replay input'
      USING ERRCODE = '22023';
  END IF;

  -- Authority is locked first to retain the global lock order used by restore
  -- reconciliation, then the exact replay key is serialized below.
  SELECT * INTO v_authority
  FROM fleet_auth.authority_state AS authority
  WHERE authority.singleton = TRUE
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fleet_auth authority_state singleton is missing'
      USING ERRCODE = '55000';
  END IF;

  DELETE FROM fleet_auth.hub_device_assertion_replays
  WHERE expires_at <= clock_timestamp();

  INSERT INTO fleet_auth.hub_device_assertion_replays
    (issuer, jti, assertion_digest, device_id, enrollment_version, expires_at,
     key_id_digest, audience_digest, companion_id_digest, session_id_digest)
  VALUES (
    p_issuer, p_jti, p_assertion_digest, p_device_id, p_enrollment_version,
    p_expires_at, p_key_id_digest, p_audience_digest, p_companion_id_digest,
    p_session_id_digest
  )
  ON CONFLICT (issuer, jti) DO NOTHING;
  IF FOUND THEN
    RETURN 'consumed';
  END IF;

  SELECT * INTO v_replay
  FROM fleet_auth.hub_device_assertion_replays AS replay
  WHERE replay.issuer = p_issuer AND replay.jti = p_jti
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Hub device assertion replay ledger conflict was not readable'
      USING ERRCODE = '55000';
  END IF;

  IF v_replay.device_id IS DISTINCT FROM p_device_id
     OR v_replay.enrollment_version IS DISTINCT FROM p_enrollment_version
     OR v_replay.key_id_digest IS DISTINCT FROM p_key_id_digest
     OR v_replay.audience_digest IS DISTINCT FROM p_audience_digest
     OR v_replay.companion_id_digest IS DISTINCT FROM p_companion_id_digest
     OR v_replay.session_id_digest IS DISTINCT FROM p_session_id_digest THEN
    RAISE EXCEPTION 'Hub device assertion replay binding does not match its locked ledger row'
      USING ERRCODE = '42501';
  END IF;

  IF v_replay.assertion_digest = p_assertion_digest THEN
    UPDATE fleet_auth.hub_device_assertion_replays
    SET replay_count = replay_count + 1,
        last_replayed_at = clock_timestamp()
    WHERE issuer = p_issuer AND jti = p_jti;
    RETURN 'replayed';
  END IF;

  v_context := jsonb_build_object(
    'schemaVersion', 1,
    'issuerDigest', encode(sha256(convert_to(v_replay.issuer, 'UTF8')), 'hex'),
    'keyIdDigest', v_replay.key_id_digest,
    'audienceDigest', v_replay.audience_digest,
    'companionIdDigest', v_replay.companion_id_digest,
    'deviceIdDigest', encode(sha256(convert_to(v_replay.device_id, 'UTF8')), 'hex'),
    'sessionIdDigest', v_replay.session_id_digest,
    'enrollmentVersionDigest', encode(
      sha256(convert_to(v_replay.enrollment_version::text, 'UTF8')), 'hex'
    ),
    'jtiDigest', encode(sha256(convert_to(v_replay.jti::text, 'UTF8')), 'hex'),
    'acceptedAssertionDigest', v_replay.assertion_digest,
    'mutatedAssertionDigest', p_assertion_digest
  );
  v_correlation_id := fleet_auth.hub_mutated_replay_correlation(v_context);

  UPDATE fleet_auth.hub_device_assertion_replays
  SET mismatch_count = mismatch_count + 1,
      last_mismatch_digest = p_assertion_digest,
      last_mismatch_at = clock_timestamp()
  WHERE issuer = p_issuer AND jti = p_jti;

  INSERT INTO fleet_auth.authorization_audit_events
    (event_id, actor_context, action, resource, decision, reason_code,
     authority_generation, global_auth_epoch, correlation_id, occurred_at,
     decision_context)
  VALUES (
    gen_random_uuid(), '{"kind":"hub_device_assertion"}'::jsonb,
    'hub_device_assertion.verify', 'hub-device-assertion-replay', 'deny',
    'mutated_replay', v_authority.authority_generation,
    v_authority.global_auth_epoch, v_correlation_id, clock_timestamp(), v_context
  )
  ON CONFLICT DO NOTHING
  RETURNING event_id INTO v_inserted_event;

  IF v_inserted_event IS NULL AND NOT EXISTS (
    SELECT 1
    FROM fleet_auth.authorization_audit_events AS audit
    WHERE audit.correlation_id = v_correlation_id
      AND audit.actor_context = '{"kind":"hub_device_assertion"}'::jsonb
      AND audit.action = 'hub_device_assertion.verify'
      AND audit.resource = 'hub-device-assertion-replay'
      AND audit.decision = 'deny'
      AND audit.reason_code = 'mutated_replay'
      AND audit.companion_id IS NULL
      AND audit.principal_id IS NULL
      AND audit.decision_id IS NULL
      AND audit.ceremony_id IS NULL
      AND audit.reason_digest IS NULL
      AND audit.decision_context = v_context
  ) THEN
    RAISE EXCEPTION 'Hub device assertion mutated-replay audit conflict was not compatible'
      USING ERRCODE = '23505';
  END IF;
  RETURN 'mismatch';
END;
$$;

CREATE OR REPLACE FUNCTION ${FLEET_AUTH_IMPORT_HUB_REPLAY_AUDIT_FUNCTION_NAME}(
  p_event_id UUID,
  p_authority_generation BIGINT,
  p_global_auth_epoch BIGINT,
  p_occurred_at TIMESTAMPTZ,
  p_decision_context JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, fleet_auth
AS $$
DECLARE
  v_correlation_id TEXT;
  v_inserted_event UUID;
BEGIN
  IF p_event_id IS NULL
     OR p_authority_generation < 1
     OR p_global_auth_epoch < 1
     OR p_occurred_at IS NULL
     OR NOT fleet_auth.hub_mutated_replay_context_is_exact(p_decision_context) THEN
    RAISE EXCEPTION 'Invalid restored Hub mutated-replay audit event'
      USING ERRCODE = '22023';
  END IF;
  v_correlation_id := fleet_auth.hub_mutated_replay_correlation(p_decision_context);

  INSERT INTO fleet_auth.authorization_audit_events
    (event_id, actor_context, action, resource, decision, reason_code,
     authority_generation, global_auth_epoch, correlation_id, occurred_at,
     decision_context)
  VALUES (
    p_event_id, '{"kind":"hub_device_assertion"}'::jsonb,
    'hub_device_assertion.verify', 'hub-device-assertion-replay', 'deny',
    'mutated_replay', p_authority_generation, p_global_auth_epoch,
    v_correlation_id, p_occurred_at, p_decision_context
  )
  ON CONFLICT DO NOTHING
  RETURNING event_id INTO v_inserted_event;

  IF v_inserted_event IS NULL AND NOT EXISTS (
    SELECT 1
    FROM fleet_auth.authorization_audit_events AS audit
    WHERE audit.event_id = p_event_id
      AND audit.actor_context = '{"kind":"hub_device_assertion"}'::jsonb
      AND audit.action = 'hub_device_assertion.verify'
      AND audit.resource = 'hub-device-assertion-replay'
      AND audit.decision = 'deny'
      AND audit.reason_code = 'mutated_replay'
      AND audit.companion_id IS NULL
      AND audit.principal_id IS NULL
      AND audit.authority_generation = p_authority_generation
      AND audit.global_auth_epoch = p_global_auth_epoch
      AND audit.correlation_id = v_correlation_id
      AND audit.occurred_at = p_occurred_at
      AND audit.decision_id IS NULL
      AND audit.ceremony_id IS NULL
      AND audit.reason_digest IS NULL
      AND audit.decision_context = p_decision_context
  ) THEN
    RAISE EXCEPTION 'Restored Hub mutated-replay audit conflict was not compatible'
      USING ERRCODE = '23505';
  END IF;
  RETURN v_inserted_event IS NOT NULL;
END;
$$;

CREATE OR REPLACE FUNCTION fleet_auth.guard_hub_mutated_replay_audit_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, fleet_auth
AS $$
DECLARE
  v_schema_owner TEXT;
BEGIN
  IF NEW.action = 'hub_device_assertion.verify'
     OR NEW.reason_code IS NOT DISTINCT FROM 'mutated_replay' THEN
    SELECT owner_role.rolname INTO v_schema_owner
    FROM pg_namespace AS namespace
    JOIN pg_roles AS owner_role ON owner_role.oid = namespace.nspowner
    WHERE namespace.nspname = 'fleet_auth';
    IF current_user <> v_schema_owner THEN
      RAISE EXCEPTION 'Hub mutated-replay audit can only be appended through a bounded fleet_auth procedure'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS authorization_audit_hub_mutated_replay_insert_guard
  ON fleet_auth.authorization_audit_events;
CREATE TRIGGER authorization_audit_hub_mutated_replay_insert_guard
  BEFORE INSERT ON fleet_auth.authorization_audit_events
  FOR EACH ROW EXECUTE FUNCTION fleet_auth.guard_hub_mutated_replay_audit_insert();

REVOKE ALL ON FUNCTION fleet_auth.hub_mutated_replay_correlation(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION fleet_auth.hub_mutated_replay_context_is_exact(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION ${FLEET_AUTH_CONSUME_HUB_REPLAY_FUNCTION_NAME}(
  ${FLEET_AUTH_CONSUME_HUB_REPLAY_FUNCTION_ARG_TYPES}
) FROM PUBLIC;
REVOKE ALL ON FUNCTION ${FLEET_AUTH_IMPORT_HUB_REPLAY_AUDIT_FUNCTION_NAME}(
  ${FLEET_AUTH_IMPORT_HUB_REPLAY_AUDIT_FUNCTION_ARG_TYPES}
) FROM PUBLIC;
`;
