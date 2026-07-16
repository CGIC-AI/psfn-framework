export const FLEET_AUTH_IMPORT_RESTORED_COMPANION_FUNCTION_NAME =
  'fleet_auth.import_restored_companion_authority';

export const FLEET_AUTH_IMPORT_RESTORED_COMPANION_FUNCTION_ARG_TYPES =
  'uuid,uuid,text,text,uuid,bigint,text,bigint,uuid,timestamptz,timestamptz,text,bigint,bigint';

/**
 * The backup role must not own raw INSERT authority over companion lineage
 * rows or be able to mint its admission proof. The schema owner creates a
 * one-shot receipt only after verifying the snapshot family. This procedure is
 * the bounded execution aperture: it binds the receipt to the exact restore,
 * exact row, current singleton/checkpoint, and non-restored floor, consumes it
 * atomically, and always forces the imported row into quarantine.
 */
export const FLEET_AUTH_COMPANION_RESTORE_DDL_SQL = `
CREATE OR REPLACE FUNCTION ${FLEET_AUTH_IMPORT_RESTORED_COMPANION_FUNCTION_NAME}(
  p_receipt_id UUID,
  p_restore_operation_id UUID,
  p_manifest_digest TEXT,
  p_snapshot_digest TEXT,
  p_companion_id UUID,
  p_version BIGINT,
  p_authority_lineage_id TEXT,
  p_lineage_generation BIGINT,
  p_readd_decision_id UUID,
  p_created_at TIMESTAMPTZ,
  p_imported_at TIMESTAMPTZ,
  p_global_authority_lineage_id TEXT,
  p_authority_generation BIGINT,
  p_restore_checkpoint BIGINT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, fleet_auth
AS $$
DECLARE
  v_state fleet_auth.authority_state%ROWTYPE;
  v_receipt fleet_auth.companion_restore_import_receipts%ROWTYPE;
  v_resource_hash TEXT;
  v_consumed_rows INTEGER;
  v_inserted_rows INTEGER;
BEGIN
  IF p_receipt_id IS NULL
     OR p_restore_operation_id IS NULL
     OR p_manifest_digest !~ '^[0-9a-f]{64}$'
     OR p_snapshot_digest !~ '^[0-9a-f]{64}$'
     OR p_companion_id IS NULL
     OR p_version < 1
     OR p_created_at IS NULL
     OR p_imported_at IS NULL
     OR p_global_authority_lineage_id !~ '^[0-9a-f]{64}$'
     OR p_authority_generation < 1
     OR p_restore_checkpoint < 1 THEN
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

  SELECT * INTO v_receipt
  FROM fleet_auth.companion_restore_import_receipts AS receipt
  WHERE receipt.receipt_id = p_receipt_id
    AND receipt.restore_operation_id = p_restore_operation_id
    AND receipt.restore_transaction_id = txid_current()
    AND receipt.manifest_digest = p_manifest_digest
    AND receipt.snapshot_digest = p_snapshot_digest
    AND receipt.companion_id = p_companion_id
    AND receipt.version = p_version
    AND receipt.authority_lineage_id IS NOT DISTINCT FROM p_authority_lineage_id
    AND receipt.lineage_generation IS NOT DISTINCT FROM p_lineage_generation
    AND receipt.readd_decision_id IS NOT DISTINCT FROM p_readd_decision_id
    AND receipt.created_at = p_created_at
    AND receipt.imported_at = p_imported_at
    AND receipt.global_authority_lineage_id = p_global_authority_lineage_id
    AND receipt.authority_generation = p_authority_generation
    AND receipt.restore_checkpoint = p_restore_checkpoint
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Restored companion authority admission receipt is unavailable or mismatched'
      USING ERRCODE = '42501';
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

  v_resource_hash := encode(
    sha256(convert_to(p_companion_id::text, 'UTF8')),
    'hex'
  );
  IF p_authority_lineage_id IS NULL THEN
    -- Legacy rows remain inert, but a null tuple does not skip floor
    -- validation. If a newer re-add exists, its prerequisite removal must also
    -- exist at a lower generation; otherwise even quarantine would preserve a
    -- floor-forged identity sequence.
    IF EXISTS (
      SELECT 1
      FROM fleet_auth.authority_floor_tombstone_projection AS lineage
      WHERE lineage.kind = 'companion_lineage_floor'
        AND lineage.resource_hash = v_resource_hash
        AND NOT EXISTS (
          SELECT 1
          FROM fleet_auth.authority_floor_tombstone_projection AS removal
          WHERE removal.kind = 'companion'
            AND removal.resource_hash = v_resource_hash
            AND removal.authority_generation < lineage.authority_generation
        )
    ) THEN
      RAISE EXCEPTION 'Restored companion authority without lineage is not admitted by the floor'
        USING ERRCODE = '42501';
    END IF;
  ELSIF NOT EXISTS (
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

  DELETE FROM fleet_auth.companion_restore_import_receipts
  WHERE receipt_id = p_receipt_id;
  GET DIAGNOSTICS v_consumed_rows = ROW_COUNT;
  IF v_consumed_rows <> 1 THEN
    RAISE EXCEPTION 'Restored companion authority admission receipt was not consumed exactly once'
      USING ERRCODE = '42501';
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
