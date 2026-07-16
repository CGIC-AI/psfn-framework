export const FLEET_AUTH_REAPPROVE_COMPANION_FUNCTION_NAME =
  'fleet_auth.reapprove_companion_authority';

export const FLEET_AUTH_REAPPROVE_COMPANION_FUNCTION_ARG_TYPES =
  'uuid, uuid, text, bigint, bigint, uuid, uuid, timestamptz';

export const FLEET_AUTH_COMPANION_REAPPROVAL_DDL_SQL = `
CREATE OR REPLACE FUNCTION fleet_auth.reapprove_companion_authority(
  p_ceremony_id uuid,
  p_companion_id uuid,
  p_lineage_id text,
  p_lineage_generation bigint,
  p_companion_version bigint,
  p_readd_decision_id uuid,
  p_audit_event_id uuid,
  p_at timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, fleet_auth
AS $$
DECLARE
  v_generation bigint;
  v_epoch bigint;
  v_restore_checkpoint bigint;
  v_new_epoch bigint;
  v_authority_lineage text;
  v_now timestamptz;
  v_expected_scope jsonb;
  v_ceremony fleet_auth.trusted_host_ceremonies%ROWTYPE;
  v_companion fleet_auth.companion_authority_state%ROWTYPE;
  v_prior_audit fleet_auth.authorization_audit_events%ROWTYPE;
BEGIN
  IF p_at IS NULL OR p_lineage_id !~ '^[0-9a-f]{64}$'
     OR p_lineage_generation < 1 OR p_companion_version < 1 THEN
    RAISE EXCEPTION 'companion reapproval input is invalid' USING ERRCODE = '42501';
  END IF;

  -- The audit event is the durable idempotency receipt. A lost response may be
  -- retried only with the byte-equivalent authority request.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_audit_event_id::text, 1)
  );
  SELECT * INTO v_prior_audit
  FROM fleet_auth.authorization_audit_events
  WHERE event_id = p_audit_event_id;
  IF FOUND THEN
    IF v_prior_audit.action <> 'companion.authority.reapprove'
       OR v_prior_audit.decision <> 'allow'
       OR v_prior_audit.companion_id IS DISTINCT FROM p_companion_id
       OR v_prior_audit.occurred_at IS DISTINCT FROM p_at
       OR v_prior_audit.decision_context->>'ceremonyId' IS DISTINCT FROM p_ceremony_id::text
       OR v_prior_audit.decision_context->>'lineageId' IS DISTINCT FROM p_lineage_id
       OR (v_prior_audit.decision_context->>'lineageGeneration')::bigint
          IS DISTINCT FROM p_lineage_generation
       OR (v_prior_audit.decision_context->>'beforeVersion')::bigint
          IS DISTINCT FROM p_companion_version
       OR v_prior_audit.decision_context->>'readdDecisionId'
          IS DISTINCT FROM p_readd_decision_id::text THEN
      RAISE EXCEPTION 'companion reapproval idempotency key conflicts with prior authority'
        USING ERRCODE = '42501';
    END IF;

    -- An immutable allow event is a replay receipt only while its exact
    -- post-state is still current. Backups deliberately retain audit history,
    -- but restore advances the checkpoint, quarantines durable authority and
    -- clears ceremonies. Rechecking all three under lock prevents that inert
    -- history from becoming an executable success receipt, including through
    -- direct SECURITY DEFINER invocation.
    SELECT authority_generation, global_auth_epoch, restore_checkpoint, authority_lineage_id
      INTO v_generation, v_epoch, v_restore_checkpoint, v_authority_lineage
    FROM fleet_auth.authority_state
    WHERE singleton = TRUE
    FOR UPDATE;
    SELECT * INTO v_companion
    FROM fleet_auth.companion_authority_state
    WHERE companion_id = p_companion_id
    FOR UPDATE;
    SELECT * INTO v_ceremony
    FROM fleet_auth.trusted_host_ceremonies
    WHERE ceremony_id = p_ceremony_id
    FOR UPDATE;
    IF v_prior_audit.reason_code IS DISTINCT FROM 'trusted_host_companion_reapproval'
       OR v_prior_audit.resource IS DISTINCT FROM format(
         'companion:%s;lineage:%s', p_companion_id, p_lineage_id
       )
       OR v_prior_audit.ceremony_id IS DISTINCT FROM p_ceremony_id
       OR v_prior_audit.decision_context->>'schemaVersion' IS DISTINCT FROM '2'
       OR v_prior_audit.decision_context->>'companionDigest' IS DISTINCT FROM
          encode(sha256(convert_to(p_companion_id::text, 'UTF8')), 'hex')
       OR v_prior_audit.decision_context->>'authorityLineageId'
          IS DISTINCT FROM v_authority_lineage
       OR (v_prior_audit.decision_context->>'authorityGeneration')::bigint
          IS DISTINCT FROM v_generation
       OR (v_prior_audit.decision_context->>'restoreCheckpoint')::bigint
          IS DISTINCT FROM v_restore_checkpoint
       OR v_prior_audit.authority_generation IS DISTINCT FROM v_generation
       OR v_prior_audit.global_auth_epoch IS DISTINCT FROM v_epoch
       OR v_companion.companion_id IS NULL
       OR v_companion.lifecycle IS DISTINCT FROM 'active'
       OR v_companion.restore_state IS DISTINCT FROM 'live'
       OR v_companion.version IS DISTINCT FROM
          (v_prior_audit.decision_context->>'afterVersion')::bigint
       OR v_companion.authority_generation IS DISTINCT FROM v_generation
       OR v_companion.authority_lineage_id IS DISTINCT FROM p_lineage_id
       OR v_companion.lineage_generation IS DISTINCT FROM p_lineage_generation
       OR v_companion.readd_decision_id IS DISTINCT FROM p_readd_decision_id
       OR v_ceremony.ceremony_id IS NULL
       OR v_ceremony.kind IS DISTINCT FROM 'companion_reapproval'
       OR v_ceremony.status IS DISTINCT FROM 'consumed'
       OR v_ceremony.expected_companion_id IS DISTINCT FROM p_companion_id
       OR NOT EXISTS (
         SELECT 1
         FROM fleet_auth.authority_floor_tombstone_projection AS lineage
         WHERE lineage.kind = 'companion_lineage_floor'
           AND lineage.resource_hash = encode(
             sha256(convert_to(p_companion_id::text, 'UTF8')), 'hex'
           )
           AND lineage.authority_generation = p_lineage_generation
           AND lineage.companion_lineage_id = p_lineage_id
           AND lineage.companion_readd_decision_id = p_readd_decision_id
       ) OR NOT EXISTS (
         SELECT 1
         FROM fleet_auth.authority_floor_tombstone_projection AS removal
         WHERE removal.kind = 'companion'
           AND removal.resource_hash = encode(
             sha256(convert_to(p_companion_id::text, 'UTF8')), 'hex'
           )
           AND removal.authority_generation < p_lineage_generation
       ) THEN
      RAISE EXCEPTION 'companion reapproval receipt does not match current companion authority'
        USING ERRCODE = '42501';
    END IF;
    RETURN jsonb_build_object(
      'companionId', p_companion_id::text,
      'lineageId', p_lineage_id,
      'lineageGeneration', p_lineage_generation,
      'companionVersion', (v_prior_audit.decision_context->>'afterVersion')::bigint,
      'authorityGeneration', v_prior_audit.authority_generation,
      'globalAuthEpoch', v_prior_audit.global_auth_epoch,
      'auditEventId', p_audit_event_id::text
    );
  END IF;

  SELECT authority_generation, global_auth_epoch, restore_checkpoint, authority_lineage_id
    INTO v_generation, v_epoch, v_restore_checkpoint, v_authority_lineage
  FROM fleet_auth.authority_state
  WHERE singleton = TRUE
  FOR UPDATE;
  IF NOT FOUND OR v_authority_lineage IS NULL THEN
    RAISE EXCEPTION 'fleet_auth authority state is unavailable' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_ceremony
  FROM fleet_auth.trusted_host_ceremonies
  WHERE ceremony_id = p_ceremony_id
  FOR UPDATE;
  IF NOT FOUND
     OR v_ceremony.kind <> 'companion_reapproval'
     OR v_ceremony.status <> 'pending'
     OR v_ceremony.global_auth_epoch <> v_epoch
     OR v_ceremony.expected_companion_id IS DISTINCT FROM p_companion_id
     OR v_ceremony.expected_provider IS NOT NULL
     OR v_ceremony.expected_provider_subject_id IS NOT NULL
     OR v_ceremony.expected_contact_id IS NOT NULL THEN
    RAISE EXCEPTION 'trusted-host companion reapproval ceremony is unavailable'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_companion
  FROM fleet_auth.companion_authority_state
  WHERE companion_id = p_companion_id
  FOR UPDATE;
  IF NOT FOUND
     OR v_companion.lifecycle <> 'quarantined'
     OR v_companion.restore_state NOT IN ('live', 'quarantined')
     OR v_companion.version <> p_companion_version
     OR v_companion.authority_lineage_id IS DISTINCT FROM p_lineage_id
     OR v_companion.lineage_generation IS DISTINCT FROM p_lineage_generation
     OR v_companion.readd_decision_id IS DISTINCT FROM p_readd_decision_id THEN
    RAISE EXCEPTION 'companion authority lineage is stale or unavailable'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM fleet_auth.authority_floor_tombstone_projection AS lineage
    WHERE lineage.kind = 'companion_lineage_floor'
      AND lineage.resource_hash = encode(sha256(convert_to(p_companion_id::text, 'UTF8')), 'hex')
      AND lineage.authority_generation = p_lineage_generation
      AND lineage.companion_lineage_id = p_lineage_id
      AND lineage.companion_readd_decision_id = p_readd_decision_id
  ) OR NOT EXISTS (
    SELECT 1
    FROM fleet_auth.authority_floor_tombstone_projection AS removal
    WHERE removal.kind = 'companion'
      AND removal.resource_hash = encode(sha256(convert_to(p_companion_id::text, 'UTF8')), 'hex')
      AND removal.authority_generation < p_lineage_generation
  ) THEN
    RAISE EXCEPTION 'companion authority lineage is not admitted by the non-restored floor'
      USING ERRCODE = '42501';
  END IF;

  v_expected_scope := jsonb_build_object(
    'schemaVersion', 1,
    'companionId', p_companion_id::text,
    'lineageId', p_lineage_id,
    'lineageGeneration', p_lineage_generation,
    'companionVersion', p_companion_version,
    'readdDecisionId', p_readd_decision_id::text,
    'authorityLineageId', v_authority_lineage,
    'authorityGeneration', v_generation,
    'restoreCheckpoint', v_restore_checkpoint
  );
  IF v_ceremony.exact_scope IS DISTINCT FROM v_expected_scope THEN
    RAISE EXCEPTION 'trusted-host companion reapproval scope is stale'
      USING ERRCODE = '42501';
  END IF;

  v_now := clock_timestamp();
  IF v_ceremony.expires_at <= v_now THEN
    RAISE EXCEPTION 'trusted-host companion reapproval ceremony has expired'
      USING ERRCODE = '42501';
  END IF;
  v_new_epoch := v_epoch + 1;

  UPDATE fleet_auth.companion_authority_state
  SET lifecycle = 'active', version = version + 1,
      authority_generation = v_generation, restore_state = 'live', updated_at = v_now
  WHERE companion_id = p_companion_id;

  UPDATE fleet_auth.authority_state
  SET global_auth_epoch = v_new_epoch, updated_at = v_now
  WHERE singleton = TRUE;

  -- Companion activation creates no contact or role authority. Existing
  -- ephemeral authority is therefore carried to the new global epoch without
  -- granting access to the newly active companion lineage.
  UPDATE fleet_auth.browser_sessions SET global_auth_epoch = v_new_epoch
  WHERE global_auth_epoch = v_epoch;
  UPDATE fleet_auth.jit_authorization_grants SET global_auth_epoch = v_new_epoch
  WHERE global_auth_epoch = v_epoch;
  UPDATE fleet_auth.step_up_challenges SET global_auth_epoch = v_new_epoch
  WHERE global_auth_epoch = v_epoch;
  UPDATE fleet_auth.provider_token_custody SET global_auth_epoch = v_new_epoch
  WHERE global_auth_epoch = v_epoch;
  UPDATE fleet_auth.discord_evidence_snapshots SET global_auth_epoch = v_new_epoch
  WHERE global_auth_epoch = v_epoch;
  UPDATE fleet_auth.discord_evidence_lifecycle_fences SET global_auth_epoch = v_new_epoch
  WHERE global_auth_epoch = v_epoch;
  UPDATE fleet_auth.oauth_transactions SET global_auth_epoch = v_new_epoch
  WHERE status = 'pending' AND global_auth_epoch = v_epoch;

  UPDATE fleet_auth.trusted_host_ceremonies
  SET status = 'consumed', consumed_at = v_now
  WHERE ceremony_id = p_ceremony_id;

  INSERT INTO fleet_auth.authorization_audit_events
    (event_id, actor_context, action, resource, decision, reason_code,
     companion_id, authority_generation, global_auth_epoch, correlation_id,
     occurred_at, ceremony_id, decision_context)
  VALUES (
    p_audit_event_id,
    jsonb_build_object('kind', 'trusted_host', 'id', 'companion_reapproval'),
    'companion.authority.reapprove',
    format('companion:%s;lineage:%s', p_companion_id, p_lineage_id),
    'allow',
    'trusted_host_companion_reapproval',
    p_companion_id,
    v_generation,
    v_new_epoch,
    p_ceremony_id,
    p_at,
    p_ceremony_id,
    jsonb_build_object(
      'schemaVersion', 2,
      'ceremonyId', p_ceremony_id::text,
      'companionDigest', encode(sha256(convert_to(p_companion_id::text, 'UTF8')), 'hex'),
      'lineageId', p_lineage_id,
      'lineageGeneration', p_lineage_generation,
      'beforeLifecycle', 'quarantined',
      'afterLifecycle', 'active',
      'beforeRestoreState', v_companion.restore_state,
      'afterRestoreState', 'live',
      'beforeVersion', p_companion_version,
      'afterVersion', p_companion_version + 1,
      'readdDecisionId', p_readd_decision_id::text,
      'authorityLineageId', v_authority_lineage,
      'authorityGeneration', v_generation,
      'restoreCheckpoint', v_restore_checkpoint,
      'globalAuthEpoch', v_new_epoch
    )
  );

  RETURN jsonb_build_object(
    'companionId', p_companion_id::text,
    'lineageId', p_lineage_id,
    'lineageGeneration', p_lineage_generation,
    'companionVersion', p_companion_version + 1,
    'authorityGeneration', v_generation,
    'globalAuthEpoch', v_new_epoch,
    'auditEventId', p_audit_event_id::text
  );
END;
$$;

REVOKE ALL ON FUNCTION ${FLEET_AUTH_REAPPROVE_COMPANION_FUNCTION_NAME}(
  ${FLEET_AUTH_REAPPROVE_COMPANION_FUNCTION_ARG_TYPES}
) FROM PUBLIC;
`;
