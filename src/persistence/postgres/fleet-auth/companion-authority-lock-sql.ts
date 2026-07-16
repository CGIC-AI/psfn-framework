/**
 * Authorization must lock companion lifecycle state between the exact session
 * provider and companion-local binding/grant rows. The runtime role remains
 * unable to mutate companion authority; this bounded SECURITY DEFINER function
 * exposes only the locked row and its exact non-restored floor status.
 */
export const FLEET_AUTH_LOCK_COMPANION_AUTHORITY_FUNCTION_NAME =
  'fleet_auth.lock_companion_authority_for_broker';
export const FLEET_AUTH_LOCK_COMPANION_AUTHORITY_FUNCTION_ARG_TYPES = 'uuid';

export const FLEET_AUTH_LOCK_COMPANION_AUTHORITY_DDL_SQL = `
CREATE OR REPLACE FUNCTION ${FLEET_AUTH_LOCK_COMPANION_AUTHORITY_FUNCTION_NAME}(
  p_companion_id UUID
)
RETURNS TABLE (
  companion_id UUID,
  lifecycle TEXT,
  version BIGINT,
  authority_generation BIGINT,
  restore_state TEXT,
  authority_lineage_id TEXT,
  lineage_floor_current BOOLEAN,
  tombstoned BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, fleet_auth
AS $$
DECLARE
  current_companion fleet_auth.companion_authority_state%ROWTYPE;
  v_resource_digest TEXT;
BEGIN
  SELECT companion.* INTO current_companion
  FROM fleet_auth.companion_authority_state AS companion
  WHERE companion.companion_id = p_companion_id
  FOR UPDATE OF companion;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  v_resource_digest := encode(
    sha256(convert_to(current_companion.companion_id::text, 'UTF8')),
    'hex'
  );
  RETURN QUERY SELECT
    current_companion.companion_id,
    current_companion.lifecycle,
    current_companion.version,
    current_companion.authority_generation,
    current_companion.restore_state,
    current_companion.authority_lineage_id,
    EXISTS (
      SELECT 1
      FROM fleet_auth.authority_floor_tombstone_projection AS floor
      WHERE floor.kind = 'companion_lineage_floor'
        AND floor.resource_hash = v_resource_digest
        AND floor.authority_generation = current_companion.lineage_generation
        AND floor.companion_lineage_id = current_companion.authority_lineage_id
        AND floor.companion_readd_decision_id = current_companion.readd_decision_id
    ),
    EXISTS (
      SELECT 1
      FROM fleet_auth.authority_floor_tombstone_projection AS floor
      WHERE floor.kind = 'companion'
        AND floor.resource_hash = v_resource_digest
    );
END;
$$;

REVOKE ALL ON FUNCTION ${FLEET_AUTH_LOCK_COMPANION_AUTHORITY_FUNCTION_NAME}(
  ${FLEET_AUTH_LOCK_COMPANION_AUTHORITY_FUNCTION_ARG_TYPES}
) FROM PUBLIC;
`;
