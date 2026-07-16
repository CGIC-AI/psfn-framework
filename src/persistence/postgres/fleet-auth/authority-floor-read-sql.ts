/**
 * The broker needs exact tombstone membership, not bulk visibility into the
 * non-restored authority-floor projection. This SECURITY DEFINER function
 * keeps the projection read-only and opaque to ordinary runtime SQL.
 */
export const FLEET_AUTH_FLOOR_RESOURCE_TOMBSTONED_FUNCTION_NAME =
  'fleet_auth.authority_floor_resource_tombstoned_for_broker';
export const FLEET_AUTH_FLOOR_RESOURCE_TOMBSTONED_FUNCTION_ARG_TYPES = 'text,text';

export const FLEET_AUTH_FLOOR_RESOURCE_TOMBSTONED_DDL_SQL = `
CREATE OR REPLACE FUNCTION ${FLEET_AUTH_FLOOR_RESOURCE_TOMBSTONED_FUNCTION_NAME}(
  p_kind TEXT,
  p_resource_id TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, fleet_auth
AS $$
BEGIN
  IF p_kind NOT IN ('provider_subject', 'contact_binding', 'role_grant',
                    'principal', 'companion')
     OR length(p_resource_id) NOT BETWEEN 1 AND 512 THEN
    RAISE EXCEPTION 'Invalid fleet_auth authority-floor resource lookup'
      USING ERRCODE = '22023';
  END IF;
  RETURN EXISTS (
    SELECT 1
    FROM fleet_auth.authority_floor_tombstone_projection AS floor
    WHERE floor.kind = p_kind
      AND floor.resource_hash = encode(
        sha256(convert_to(p_resource_id, 'UTF8')),
        'hex'
      )
  );
END;
$$;

REVOKE ALL ON FUNCTION ${FLEET_AUTH_FLOOR_RESOURCE_TOMBSTONED_FUNCTION_NAME}(
  ${FLEET_AUTH_FLOOR_RESOURCE_TOMBSTONED_FUNCTION_ARG_TYPES}
) FROM PUBLIC;
`;
