export const FLEET_AUTH_ATTACH_HUB_DEVICE_HUMAN_FUNCTION_NAME =
  'fleet_auth.attach_hub_device_human';

export const FLEET_AUTH_ATTACH_HUB_DEVICE_HUMAN_FUNCTION_ARG_TYPES = [
  'uuid', 'text', 'uuid', 'text', 'bigint', 'text', 'text', 'uuid', 'text', 'text',
  'text', 'text', 'text', 'uuid', 'uuid', 'text', 'uuid', 'text', 'bigint', 'uuid', 'text',
  'bigint', 'bigint', 'bigint', 'timestamptz',
].join(', ');

export const FLEET_AUTH_FENCE_HUB_DEVICE_ATTACHMENT_FUNCTION_NAME =
  'fleet_auth.fence_hub_device_attachment';

export const FLEET_AUTH_FENCE_HUB_DEVICE_ATTACHMENT_FUNCTION_ARG_TYPES =
  'text, text, text, timestamptz';

export const FLEET_AUTH_HUB_DEVICE_HUMAN_ATTACHMENT_DDL_SQL = `
CREATE OR REPLACE FUNCTION attach_hub_device_human(
  p_attachment_id UUID,
  p_assertion_digest TEXT,
  p_assertion_jti UUID,
  p_device_id TEXT,
  p_enrollment_version BIGINT,
  p_place_id TEXT,
  p_key_id TEXT,
  p_companion_id UUID,
  p_hub_session_id TEXT,
  p_connection_id TEXT,
  p_channel_id TEXT,
  p_human_mode TEXT,
  p_human_binding_digest TEXT,
  p_principal_id UUID,
  p_session_record_id UUID,
  p_provider_subject_id TEXT,
  p_binding_id UUID,
  p_contact_id TEXT,
  p_binding_version BIGINT,
  p_grant_id UUID,
  p_role TEXT,
  p_grant_version BIGINT,
  p_authority_generation BIGINT,
  p_global_auth_epoch BIGINT,
  p_occurred_at TIMESTAMPTZ
) RETURNS TABLE (
  decision TEXT,
  reason_code TEXT,
  disposition TEXT,
  attachment_id UUID,
  device_state TEXT,
  human_state TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = fleet_auth, pg_catalog
AS $function$
DECLARE
  current_row hub_device_human_attachments%ROWTYPE;
  human_present BOOLEAN := p_human_mode = 'attach';
BEGIN
  IF p_assertion_digest !~ '^[0-9a-f]{64}$'
    OR length(p_device_id) NOT BETWEEN 1 AND 256
    OR p_enrollment_version < 1
    OR (p_place_id IS NOT NULL AND length(p_place_id) NOT BETWEEN 1 AND 256)
    OR length(p_key_id) NOT BETWEEN 1 AND 128
    OR length(p_hub_session_id) NOT BETWEEN 1 AND 256
    OR length(p_connection_id) NOT BETWEEN 1 AND 256
    OR p_channel_id !~ '^hub-device:[0-9a-f]{64}$'
    OR p_human_mode NOT IN ('attach', 'guest', 'detach')
    OR (human_present AND (
      p_human_binding_digest !~ '^[0-9a-f]{64}$'
      OR p_principal_id IS NULL OR p_session_record_id IS NULL
      OR p_provider_subject_id IS NULL OR p_binding_id IS NULL
      OR p_contact_id IS NULL OR p_binding_version IS NULL
      OR p_grant_id IS NULL OR p_role NOT IN ('owner', 'admin', 'member', 'guest')
      OR p_grant_version IS NULL OR p_authority_generation IS NULL
      OR p_global_auth_epoch IS NULL
    ))
    OR (NOT human_present AND (
      p_human_binding_digest IS NOT NULL
      OR p_principal_id IS NOT NULL OR p_session_record_id IS NOT NULL
      OR p_provider_subject_id IS NOT NULL OR p_binding_id IS NOT NULL
      OR p_contact_id IS NOT NULL OR p_binding_version IS NOT NULL
      OR p_grant_id IS NOT NULL OR p_role IS NOT NULL
      OR p_grant_version IS NOT NULL OR p_authority_generation IS NOT NULL
      OR p_global_auth_epoch IS NOT NULL
    )) THEN
    RAISE EXCEPTION 'invalid hub device attachment input' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_assertion_digest, 1212763470));
  SELECT * INTO current_row
  FROM hub_device_human_attachments AS attachment
  WHERE attachment.assertion_digest = p_assertion_digest
     OR attachment.assertion_jti = p_assertion_jti
  ORDER BY (attachment.assertion_digest = p_assertion_digest) DESC
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    IF current_row.assertion_digest <> p_assertion_digest
      OR current_row.assertion_jti <> p_assertion_jti
      OR current_row.device_id <> p_device_id
      OR current_row.enrollment_version <> p_enrollment_version
      OR current_row.place_id IS DISTINCT FROM p_place_id
      OR current_row.key_id <> p_key_id
      OR current_row.companion_id <> p_companion_id
      OR current_row.hub_session_id <> p_hub_session_id
      OR current_row.connection_id <> p_connection_id
      OR current_row.channel_id <> p_channel_id THEN
      UPDATE hub_device_human_attachments
      SET device_state = 'fenced', human_state = 'detached', fenced_at = p_occurred_at,
          updated_at = p_occurred_at
      WHERE hub_device_human_attachments.attachment_id = current_row.attachment_id;
      RETURN QUERY SELECT 'deny', 'device_binding_mismatch', NULL::TEXT,
        current_row.attachment_id, 'fenced', 'detached';
      RETURN;
    END IF;

    IF current_row.device_state <> 'active' THEN
      RETURN QUERY SELECT 'deny', 'device_fenced', NULL::TEXT,
        current_row.attachment_id, current_row.device_state, current_row.human_state;
      RETURN;
    END IF;

    IF p_human_mode = 'detach' THEN
      UPDATE hub_device_human_attachments
      SET human_state = 'detached', human_detached_at = p_occurred_at,
          updated_at = p_occurred_at
      WHERE hub_device_human_attachments.attachment_id = current_row.attachment_id;
      RETURN QUERY SELECT 'allow', NULL::TEXT, 'human_detached',
        current_row.attachment_id, 'active', 'detached';
      RETURN;
    END IF;

    IF p_human_mode = 'guest' THEN
      IF current_row.principal_id IS NOT NULL THEN
        UPDATE hub_device_human_attachments
        SET human_state = 'detached', human_detached_at = p_occurred_at,
            updated_at = p_occurred_at
        WHERE hub_device_human_attachments.attachment_id = current_row.attachment_id;
        RETURN QUERY SELECT 'deny', 'human_binding_mismatch', NULL::TEXT,
          current_row.attachment_id, 'active', 'detached';
        RETURN;
      END IF;
    ELSIF current_row.human_binding_digest IS DISTINCT FROM p_human_binding_digest
      OR current_row.principal_id IS DISTINCT FROM p_principal_id
      OR current_row.session_record_id IS DISTINCT FROM p_session_record_id
      OR current_row.provider_subject_id IS DISTINCT FROM p_provider_subject_id
      OR current_row.binding_id IS DISTINCT FROM p_binding_id
      OR current_row.contact_id IS DISTINCT FROM p_contact_id
      OR current_row.binding_version IS DISTINCT FROM p_binding_version
      OR current_row.grant_id IS DISTINCT FROM p_grant_id
      OR current_row.role IS DISTINCT FROM p_role
      OR current_row.grant_version IS DISTINCT FROM p_grant_version
      OR current_row.authority_generation IS DISTINCT FROM p_authority_generation
      OR current_row.global_auth_epoch IS DISTINCT FROM p_global_auth_epoch
      OR current_row.human_state <> 'attached' THEN
      UPDATE hub_device_human_attachments
      SET human_state = 'detached', human_detached_at = p_occurred_at,
          updated_at = p_occurred_at
      WHERE hub_device_human_attachments.attachment_id = current_row.attachment_id;
      RETURN QUERY SELECT 'deny', 'human_binding_mismatch', NULL::TEXT,
        current_row.attachment_id, 'active', 'detached';
      RETURN;
    END IF;

    UPDATE hub_device_human_attachments
    SET retry_count = retry_count + 1, last_retry_at = p_occurred_at,
        updated_at = p_occurred_at
    WHERE hub_device_human_attachments.attachment_id = current_row.attachment_id;
    RETURN QUERY SELECT 'allow', NULL::TEXT, 'retry', current_row.attachment_id,
      'active', current_row.human_state;
    RETURN;
  END IF;

  INSERT INTO hub_device_human_attachments (
    attachment_id, assertion_digest, assertion_jti, device_id, enrollment_version,
    place_id, key_id, companion_id, hub_session_id, connection_id, channel_id,
    human_binding_digest, principal_id, session_record_id, provider_subject_id,
    binding_id, contact_id,
    binding_version, grant_id, role, grant_version, authority_generation,
    global_auth_epoch, device_state, human_state, created_at, updated_at
  ) VALUES (
    p_attachment_id, p_assertion_digest, p_assertion_jti, p_device_id,
    p_enrollment_version, p_place_id, p_key_id, p_companion_id, p_hub_session_id,
    p_connection_id, p_channel_id, p_human_binding_digest, p_principal_id,
    p_session_record_id,
    p_provider_subject_id, p_binding_id, p_contact_id, p_binding_version,
    p_grant_id, p_role, p_grant_version, p_authority_generation,
    p_global_auth_epoch, 'active', CASE WHEN human_present THEN 'attached' ELSE 'guest' END,
    p_occurred_at, p_occurred_at
  );
  RETURN QUERY SELECT 'allow', NULL::TEXT,
    CASE WHEN human_present THEN 'created' ELSE 'guest_created' END,
    p_attachment_id, 'active', CASE WHEN human_present THEN 'attached' ELSE 'guest' END;
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
) RETURNS TABLE (attachment_id UUID, companion_id UUID, changed BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = fleet_auth, pg_catalog
AS $function$
BEGIN
  IF p_assertion_digest !~ '^[0-9a-f]{64}$'
    OR length(p_connection_id) NOT BETWEEN 1 AND 256
    OR p_reason NOT IN ('assertion_rejected', 'enrollment_authority_changed') THEN
    RAISE EXCEPTION 'invalid hub device fence input' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_assertion_digest, 1212763470));
  RETURN QUERY
  WITH prior AS (
    SELECT attachment.attachment_id, attachment.device_state
    FROM hub_device_human_attachments AS attachment
    WHERE attachment.assertion_digest = p_assertion_digest
    FOR UPDATE
  ), updated AS (
    UPDATE hub_device_human_attachments AS attachment
    SET device_state = 'fenced', human_state = 'detached', fenced_at = p_occurred_at,
        updated_at = p_occurred_at
    FROM prior
    WHERE attachment.attachment_id = prior.attachment_id
    RETURNING attachment.attachment_id, attachment.companion_id,
      prior.device_state IS DISTINCT FROM 'fenced' AS changed
  )
  SELECT updated.attachment_id, updated.companion_id, updated.changed FROM updated;
END;
$function$;

REVOKE ALL ON FUNCTION attach_hub_device_human(
  ${FLEET_AUTH_ATTACH_HUB_DEVICE_HUMAN_FUNCTION_ARG_TYPES}
) FROM PUBLIC;
REVOKE ALL ON FUNCTION fence_hub_device_attachment(
  ${FLEET_AUTH_FENCE_HUB_DEVICE_ATTACHMENT_FUNCTION_ARG_TYPES}
) FROM PUBLIC;
`;
