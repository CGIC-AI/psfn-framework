export const FLEET_AUTH_REGISTER_ROSTERED_FIRST_OWNER_COMPANIONS_FUNCTION_NAME =
  'fleet_auth.register_rostered_first_owner_companions';
export const FLEET_AUTH_REGISTER_ROSTERED_FIRST_OWNER_COMPANIONS_FUNCTION_ARG_TYPES =
  'uuid,text,uuid[]';

/**
 * Narrow schema-owner boundary for the companion rows needed by a rostered
 * first-owner transition. The caller already holds the authority-state lock;
 * this function reacquires it transaction-locally and refuses anything except
 * the one fresh pending Discord principal.
 */
export const FLEET_AUTH_REGISTER_ROSTERED_FIRST_OWNER_COMPANIONS_DDL_SQL = `
CREATE OR REPLACE FUNCTION ${FLEET_AUTH_REGISTER_ROSTERED_FIRST_OWNER_COMPANIONS_FUNCTION_NAME}(
  p_principal_id UUID,
  p_provider_subject_id TEXT,
  p_companion_ids UUID[]
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, fleet_auth
AS $$
DECLARE
  v_generation BIGINT;
BEGIN
  IF p_principal_id IS NULL
     OR p_provider_subject_id !~ '^[1-9][0-9]{16,19}$'
     OR p_companion_ids IS NULL
     OR cardinality(p_companion_ids) NOT BETWEEN 1 AND 64
     OR array_position(p_companion_ids, NULL) IS NOT NULL
     OR (SELECT count(*) FROM unnest(p_companion_ids) AS ids(companion_id))
        <> (SELECT count(DISTINCT companion_id)
            FROM unnest(p_companion_ids) AS ids(companion_id)) THEN
    RAISE EXCEPTION 'rostered first-owner companion registration is invalid'
      USING ERRCODE = '42501';
  END IF;

  SELECT authority_generation INTO v_generation
  FROM fleet_auth.authority_state
  WHERE singleton = TRUE
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fleet_auth authority_state singleton is missing' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM fleet_auth.human_principals
    WHERE status = 'active' AND restore_state = 'live'
  ) THEN
    RAISE EXCEPTION 'rostered first-owner authority is no longer fresh' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM fleet_auth.human_principals AS principal
    JOIN fleet_auth.provider_subjects AS subject
      ON subject.principal_id = principal.principal_id
     AND subject.provider = 'discord'
     AND subject.subject_id = p_provider_subject_id
    WHERE principal.principal_id = p_principal_id
      AND principal.status = 'pending'
      AND principal.restore_state = 'live'
      AND principal.authority_generation = v_generation
      AND subject.state = 'pending'
      AND subject.restore_state = 'live'
      AND subject.authority_generation = v_generation
      AND NOT EXISTS (
        SELECT 1 FROM fleet_auth.provider_subject_tombstones AS tombstone
        WHERE tombstone.provider = 'discord'
          AND tombstone.subject_id = p_provider_subject_id
      )
  ) THEN
    RAISE EXCEPTION 'rostered first-owner principal is unavailable' USING ERRCODE = '42501';
  END IF;

  INSERT INTO fleet_auth.companion_authority_state
    (companion_id, lifecycle, authority_generation)
  SELECT companion_id, 'active', v_generation
  FROM unnest(p_companion_ids) AS ids(companion_id)
  ON CONFLICT (companion_id) DO NOTHING;

  IF EXISTS (
    SELECT 1
    FROM unnest(p_companion_ids) AS expected(companion_id)
    LEFT JOIN fleet_auth.companion_authority_state AS companion
      ON companion.companion_id = expected.companion_id
    WHERE companion.companion_id IS NULL
       OR companion.lifecycle <> 'active'
       OR companion.restore_state <> 'live'
       OR companion.authority_generation <> v_generation
  ) THEN
    RAISE EXCEPTION 'rostered first-owner companion authority is unavailable'
      USING ERRCODE = '42501';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION ${FLEET_AUTH_REGISTER_ROSTERED_FIRST_OWNER_COMPANIONS_FUNCTION_NAME}(
  ${FLEET_AUTH_REGISTER_ROSTERED_FIRST_OWNER_COMPANIONS_FUNCTION_ARG_TYPES}
) FROM PUBLIC;
`;
