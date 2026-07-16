import { FLEET_AUTH_FENCE_HUB_DEVICE_ATTACHMENT_FUNCTION_ARG_TYPES } from './hub-device-human-attachment-sql.js';

export const FLEET_AUTH_HANDOFF_PRIMARY_EMBODIMENT_FUNCTION_NAME =
  'fleet_auth.handoff_primary_embodiment';

export const FLEET_AUTH_HANDOFF_PRIMARY_EMBODIMENT_FUNCTION_ARG_TYPES = [
  'uuid', 'uuid', 'uuid', 'text', 'bigint', 'text', 'text', 'bigint', 'uuid', 'text',
  'timestamptz',
].join(', ');

export const FLEET_AUTH_PRIMARY_EMBODIMENT_DDL_SQL = `
CREATE OR REPLACE FUNCTION handoff_primary_embodiment(
  p_companion_id UUID,
  p_attachment_id UUID,
  p_decision_id UUID,
  p_device_id TEXT,
  p_enrollment_version BIGINT,
  p_hub_session_id TEXT,
  p_connection_id TEXT,
  p_expected_generation BIGINT,
  p_actor_principal_id UUID,
  p_reason TEXT,
  p_occurred_at TIMESTAMPTZ
) RETURNS TABLE (
  decision TEXT,
  reason_code TEXT,
  companion_id UUID,
  generation BIGINT,
  version BIGINT,
  current_attachment_id UUID,
  current_device_id TEXT,
  current_enrollment_version BIGINT,
  current_hub_session_id TEXT,
  last_decision_id UUID,
  last_decision TEXT,
  last_reason TEXT,
  decided_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = fleet_auth, pg_catalog
AS $function$
DECLARE
  state_row primary_embodiment_authority%ROWTYPE;
  attachment_row hub_device_human_attachments%ROWTYPE;
  prior_decision primary_embodiment_handoff_decisions%ROWTYPE;
  outcome TEXT;
  outcome_reason TEXT;
  current_generation BIGINT := 0;
  current_version BIGINT := 0;
BEGIN
  IF length(p_device_id) NOT BETWEEN 1 AND 256
    OR p_enrollment_version < 1
    OR length(p_hub_session_id) NOT BETWEEN 1 AND 256
    OR length(p_connection_id) NOT BETWEEN 1 AND 256
    OR p_expected_generation < 0
    OR p_reason NOT IN ('user_requested', 'device_replacement', 'recovery') THEN
    RAISE EXCEPTION 'invalid primary embodiment handoff input' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_decision_id::text, 1162105161));
  PERFORM pg_advisory_xact_lock(hashtextextended(p_companion_id::text, 1162105162));

  SELECT * INTO prior_decision
  FROM primary_embodiment_handoff_decisions AS prior
  WHERE prior.decision_id = p_decision_id;

  SELECT * INTO state_row
  FROM primary_embodiment_authority AS state
  WHERE state.companion_id = p_companion_id
  FOR UPDATE;
  IF FOUND THEN
    current_generation := state_row.generation;
    current_version := state_row.version;
  END IF;

  IF prior_decision.decision_id IS NOT NULL THEN
    outcome_reason := CASE
      WHEN prior_decision.companion_id = p_companion_id
        THEN 'decision_replay'
      ELSE 'decision_cross_companion'
    END;
    RETURN QUERY SELECT 'deny', outcome_reason, p_companion_id,
      current_generation, current_version,
      state_row.current_attachment_id, state_row.current_device_id,
      state_row.current_enrollment_version, state_row.current_hub_session_id,
      state_row.last_decision_id, state_row.last_decision, state_row.last_reason,
      state_row.decided_at;
    RETURN;
  END IF;

  SELECT * INTO attachment_row
  FROM hub_device_human_attachments AS attachment
  WHERE attachment.attachment_id = p_attachment_id
  FOR UPDATE;

  IF attachment_row.attachment_id IS NULL
    OR attachment_row.companion_id <> p_companion_id
    OR attachment_row.device_id <> p_device_id
    OR attachment_row.enrollment_version <> p_enrollment_version
    OR attachment_row.hub_session_id <> p_hub_session_id
    OR attachment_row.connection_id <> p_connection_id
    OR attachment_row.device_state <> 'active' THEN
    outcome := 'deny';
    outcome_reason := 'attachment_not_current';
  ELSIF attachment_row.human_state <> 'attached'
    OR attachment_row.principal_id IS DISTINCT FROM p_actor_principal_id
    OR attachment_row.role NOT IN ('owner', 'admin') THEN
    outcome := 'deny';
    outcome_reason := 'human_authority_required';
  ELSIF p_expected_generation <> current_generation THEN
    outcome := 'deny';
    outcome_reason := 'stale_generation';
  ELSIF state_row.current_attachment_id = p_attachment_id THEN
    outcome := 'deny';
    outcome_reason := 'already_primary';
  ELSE
    outcome := 'allow';
    outcome_reason := 'handoff';
    IF state_row.companion_id IS NULL THEN
      INSERT INTO primary_embodiment_authority (
        companion_id, generation, version, current_attachment_id, current_device_id,
        current_enrollment_version, current_hub_session_id, last_decision_id,
        last_decision, last_reason, decided_at, created_at, updated_at
      ) VALUES (
        p_companion_id, 1, 1, p_attachment_id, p_device_id, p_enrollment_version,
        p_hub_session_id, p_decision_id, 'handoff', p_reason,
        p_occurred_at, p_occurred_at, p_occurred_at
      );
    ELSE
      UPDATE primary_embodiment_authority AS state
      SET generation = state.generation + 1,
          version = state.version + 1,
          current_attachment_id = p_attachment_id,
          current_device_id = p_device_id,
          current_enrollment_version = p_enrollment_version,
          current_hub_session_id = p_hub_session_id,
          last_decision_id = p_decision_id,
          last_decision = 'handoff',
          last_reason = p_reason,
          decided_at = p_occurred_at,
          updated_at = p_occurred_at
      WHERE state.companion_id = p_companion_id;
    END IF;
    SELECT * INTO state_row
    FROM primary_embodiment_authority AS state
    WHERE state.companion_id = p_companion_id;
    current_generation := state_row.generation;
    current_version := state_row.version;
  END IF;

  INSERT INTO primary_embodiment_handoff_decisions (
    decision_id, companion_id, expected_generation, target_attachment_id,
    target_device_digest, decision, reason_code, resulting_generation,
    resulting_version, occurred_at
  ) VALUES (
    p_decision_id, p_companion_id, p_expected_generation, p_attachment_id,
    encode(sha256(
      convert_to('fleet-auth:primary-embodiment-device:v1', 'UTF8')
      || decode('00', 'hex')
      || convert_to(p_device_id, 'UTF8')
    ), 'hex'), outcome, outcome_reason,
    current_generation, current_version, p_occurred_at
  );

  RETURN QUERY SELECT outcome, outcome_reason, p_companion_id,
    current_generation, current_version,
    state_row.current_attachment_id, state_row.current_device_id,
    state_row.current_enrollment_version, state_row.current_hub_session_id,
    state_row.last_decision_id, state_row.last_decision, state_row.last_reason,
    state_row.decided_at;
END;
$function$;

DROP FUNCTION IF EXISTS fence_hub_device_attachment(
  ${FLEET_AUTH_FENCE_HUB_DEVICE_ATTACHMENT_FUNCTION_ARG_TYPES}
);
CREATE FUNCTION fence_hub_device_attachment(
  p_assertion_digest TEXT,
  p_connection_id TEXT,
  p_reason TEXT,
  p_occurred_at TIMESTAMPTZ
) RETURNS TABLE (
  attachment_id UUID,
  companion_id UUID,
  changed BOOLEAN,
  primary_invalidated BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = fleet_auth, pg_catalog
AS $function$
DECLARE
  bound_companion_id UUID;
BEGIN
  IF p_assertion_digest !~ '^[0-9a-f]{64}$'
    OR length(p_connection_id) NOT BETWEEN 1 AND 256
    OR p_reason NOT IN ('assertion_rejected', 'enrollment_authority_changed') THEN
    RAISE EXCEPTION 'invalid hub device fence input' USING ERRCODE = '22023';
  END IF;
  SELECT attachment.companion_id INTO bound_companion_id
  FROM hub_device_human_attachments AS attachment
  WHERE attachment.assertion_digest = p_assertion_digest;
  IF bound_companion_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(bound_companion_id::text, 1162105162));
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_assertion_digest, 1212763470));
  RETURN QUERY
  WITH prior AS (
    SELECT attachment.attachment_id, attachment.device_state
    FROM hub_device_human_attachments AS attachment
    WHERE attachment.assertion_digest = p_assertion_digest
      AND attachment.connection_id = p_connection_id
    FOR UPDATE
  ), updated AS (
    UPDATE hub_device_human_attachments AS attachment
    SET device_state = 'fenced', human_state = 'detached', fenced_at = p_occurred_at,
        updated_at = p_occurred_at
    FROM prior
    WHERE attachment.attachment_id = prior.attachment_id
    RETURNING attachment.attachment_id, attachment.companion_id,
      prior.device_state IS DISTINCT FROM 'fenced' AS changed
  ), invalidated AS (
    UPDATE primary_embodiment_authority AS state
    SET generation = state.generation + 1,
        version = state.version + 1,
        current_attachment_id = NULL,
        current_device_id = NULL,
        current_enrollment_version = NULL,
        current_hub_session_id = NULL,
        last_decision_id = gen_random_uuid(),
        last_decision = 'invalidated',
        last_reason = CASE WHEN p_reason = 'enrollment_authority_changed'
          THEN 'enrollment_revoked' ELSE 'device_revoked' END,
        decided_at = p_occurred_at,
        updated_at = p_occurred_at
    WHERE EXISTS (
      SELECT 1 FROM updated
      WHERE updated.attachment_id = state.current_attachment_id AND updated.changed
    )
    RETURNING state.companion_id
  )
  SELECT updated.attachment_id, updated.companion_id, updated.changed,
    EXISTS (
      SELECT 1 FROM invalidated
      WHERE invalidated.companion_id = updated.companion_id
    ) AS primary_invalidated
  FROM updated;
END;
$function$;

REVOKE ALL ON FUNCTION handoff_primary_embodiment(
  ${FLEET_AUTH_HANDOFF_PRIMARY_EMBODIMENT_FUNCTION_ARG_TYPES}
) FROM PUBLIC;
REVOKE ALL ON FUNCTION fence_hub_device_attachment(
  ${FLEET_AUTH_FENCE_HUB_DEVICE_ATTACHMENT_FUNCTION_ARG_TYPES}
) FROM PUBLIC;
`;
