/**
 * Runtime OAuth/session writes must serialize with authority-floor
 * reconciliation, but the runtime role must not receive UPDATE on the
 * authority_state table merely to satisfy PostgreSQL's row-lock privilege
 * requirement. This zero-argument SECURITY DEFINER function exposes only the
 * two values needed by the broker while retaining the row lock until the
 * caller's transaction ends.
 */
export const FLEET_AUTH_LOCK_AUTHORITY_STATE_FUNCTION_NAME =
  'fleet_auth.lock_authority_state_for_broker';
export const FLEET_AUTH_LOCK_AUTHORITY_STATE_FUNCTION_ARG_TYPES = '';

export const FLEET_AUTH_LOCK_AUTHORITY_STATE_DDL_SQL = `
CREATE OR REPLACE FUNCTION ${FLEET_AUTH_LOCK_AUTHORITY_STATE_FUNCTION_NAME}()
RETURNS TABLE (authority_generation BIGINT, global_auth_epoch BIGINT)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, fleet_auth
AS $$
  SELECT state.authority_generation, state.global_auth_epoch
  FROM fleet_auth.authority_state AS state
  WHERE state.singleton = TRUE
  FOR SHARE OF state
$$;

REVOKE ALL ON FUNCTION ${FLEET_AUTH_LOCK_AUTHORITY_STATE_FUNCTION_NAME}() FROM PUBLIC;
`;
