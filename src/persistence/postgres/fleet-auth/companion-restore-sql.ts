export const FLEET_AUTH_IMPORT_RESTORED_COMPANION_FUNCTION_NAME =
  'fleet_auth.import_restored_companion_authority';

export const FLEET_AUTH_IMPORT_RESTORED_COMPANION_FUNCTION_ARG_TYPES =
  'uuid,bigint,text,bigint,uuid,timestamptz,timestamptz,text,bigint,bigint,uuid';

/**
 * The backup role must not own raw INSERT authority over companion lineage
 * rows. This schema-owner procedure is the sole restore import aperture: it
 * forces quarantine and binds every lineage-bearing row to the exact authority
 * singleton and non-restored floor projection already reconciled in the same
 * transaction.
 */
export const FLEET_AUTH_COMPANION_RESTORE_DDL_SQL = `
CREATE OR REPLACE FUNCTION ${FLEET_AUTH_IMPORT_RESTORED_COMPANION_FUNCTION_NAME}(
  p_companion_id UUID,
  p_version BIGINT,
  p_authority_lineage_id TEXT,
  p_lineage_generation BIGINT,
  p_readd_decision_id UUID,
  p_created_at TIMESTAMPTZ,
  p_imported_at TIMESTAMPTZ,
  p_global_authority_lineage_id TEXT,
  p_authority_generation BIGINT,
  p_restore_checkpoint BIGINT,
  p_restore_audit_event_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, fleet_auth
AS $$
DECLARE
  v_state fleet_auth.authority_state%ROWTYPE;
  v_resource_hash TEXT;
  v_inserted_rows INTEGER;
BEGIN
  IF p_companion_id IS NULL
     OR p_version < 1
     OR p_created_at IS NULL
     OR p_imported_at IS NULL
     OR p_global_authority_lineage_id !~ '^[0-9a-f]{64}$'
     OR p_authority_generation < 1
     OR p_restore_checkpoint < 0
     OR p_restore_audit_event_id IS NULL THEN
    RAISE EXCEPTION 'Invalid restored companion authority import'
      USING ERRCODE = '22023';
  END IF;
  IF NOT (
    (p_authority_lineage_id IS NULL
      AND p_lineage_generation IS NULL
      AND p_readd_decision_id IS NULL)
    OR (p_authority_lineage_id ~ '^[0-9a-f]{64}$'
      AND p_lineage_generation >= 1
      AND p_readd_decision_id IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'Restored companion authority lineage tuple is incomplete'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_state
  FROM fleet_auth.authority_state AS state
  WHERE state.singleton = TRUE
  FOR UPDATE;
  IF NOT FOUND
     OR v_state.authority_lineage_id IS DISTINCT FROM p_global_authority_lineage_id
     OR v_state.authority_generation <> p_authority_generation
     OR v_state.restore_checkpoint <> p_restore_checkpoint THEN
    RAISE EXCEPTION 'Restored companion authority import is not bound to the current restore floor'
      USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM fleet_auth.authorization_audit_events AS audit
    WHERE audit.event_id = p_restore_audit_event_id
      AND audit.action = 'authority.reconcile'
      AND audit.resource = 'fleet_auth'
      AND audit.decision = 'deny'
      AND audit.reason_code = 'restored_authority_quarantined'
      AND audit.authority_generation = p_authority_generation
      AND audit.global_auth_epoch = v_state.global_auth_epoch
  ) THEN
    RAISE EXCEPTION 'Restored companion authority import is not bound to its reconciliation audit'
      USING ERRCODE = '42501';
  END IF;

  IF p_authority_lineage_id IS NOT NULL THEN
    v_resource_hash := encode(
      sha256(convert_to(p_companion_id::text, 'UTF8')),
      'hex'
    );
    IF NOT EXISTS (
      SELECT 1
      FROM fleet_auth.authority_floor_tombstone_projection AS lineage
      WHERE lineage.kind = 'companion_lineage_floor'
        AND lineage.resource_hash = v_resource_hash
        AND lineage.authority_generation = p_lineage_generation
        AND lineage.companion_lineage_id = p_authority_lineage_id
        AND lineage.companion_readd_decision_id = p_readd_decision_id
    ) OR NOT EXISTS (
      SELECT 1
      FROM fleet_auth.authority_floor_tombstone_projection AS removal
      WHERE removal.kind = 'companion'
        AND removal.resource_hash = v_resource_hash
        AND removal.authority_generation < p_lineage_generation
    ) THEN
      RAISE EXCEPTION 'Restored companion authority lineage is not current in the floor projection'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  INSERT INTO fleet_auth.companion_authority_state
    (companion_id, lifecycle, version, authority_generation, restore_state,
     authority_lineage_id, lineage_generation, readd_decision_id,
     created_at, updated_at)
  VALUES (
    p_companion_id, 'quarantined', p_version, p_authority_generation,
    'quarantined', p_authority_lineage_id, p_lineage_generation,
    p_readd_decision_id, p_created_at, p_imported_at
  )
  ON CONFLICT (companion_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted_rows = ROW_COUNT;
  RETURN v_inserted_rows = 1;
END;
$$;

REVOKE ALL ON FUNCTION ${FLEET_AUTH_IMPORT_RESTORED_COMPANION_FUNCTION_NAME}(
  ${FLEET_AUTH_IMPORT_RESTORED_COMPANION_FUNCTION_ARG_TYPES}
) FROM PUBLIC;
`;
