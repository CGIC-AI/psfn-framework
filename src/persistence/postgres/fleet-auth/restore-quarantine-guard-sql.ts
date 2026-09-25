// Self-contained DDL for the restore-quarantine boundary.
//
// This module owns no imports so it can be referenced by schema.ts without
// creating an import cycle. The SQL is applied idempotently by
// migrateFleetAuthSchema (alongside applyRoleGrants) rather than as a numbered
// migration, so the boundary is reasserted on every migration run and is never
// left half-applied.
//
// Two structures make the raw-SQL restore-quarantine bypass impossible:
//
//   1. restore_quarantine_activation_guard: a BEFORE UPDATE trigger on every
//      mutable authority table. A quarantined row (restore_state='quarantined')
//      may only be de-escalated by the ordinary runtime/backup roles: its
//      lifecycle column may move to 'quarantined'/'revoked' only, restore_state
//      must stay 'quarantined', and authority generation / version counters may
//      not move. Reactivation (restore_state -> 'live', lifecycle -> active) is
//      permitted solely inside SECURITY DEFINER code owned by the fleet_auth
//      schema owner: the audited ADMIN_TOKEN operator reinstatement procedures
//      (operator-account-authority-sql.ts). The former trusted-host reapproval
//      procedures were dropped by migration 30 (psfn-framework-aol3m).
//
//   2. restore_quarantine_insert_guard / restore_quarantine_delete_guard:
//      BEFORE INSERT and BEFORE DELETE triggers on principal_contact_bindings
//      and principal_role_grants. A quarantined authority row occupies no live
//      unique-index slot, so a BEFORE UPDATE trigger alone cannot stop a
//      non-owner from clearing a quarantined row and re-inserting (or simply
//      inserting) a fresh live/active row for the same quarantined principal.
//      The INSERT guard fences a non-owner INSERT that would create a
//      live/active authority row referencing a quarantined principal; the
//      DELETE guard forbids a non-owner from removing a quarantined row.
//      Backup-restored rows (restore_state='quarantined') and legitimate
//      provisioning for live principals both pass untouched. Only the schema
//      owner may author the reactivating shape.

export const FLEET_AUTH_RESTORE_QUARANTINE_GUARD_DDL_SQL = `
CREATE OR REPLACE FUNCTION fleet_auth.restore_quarantine_activation_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, fleet_auth
AS $$
DECLARE
  v_old jsonb := to_jsonb(OLD);
  v_new jsonb := to_jsonb(NEW);
  v_lifecycle_column text;
  v_new_lifecycle text;
  v_schema_owner text;
  v_companion_non_active boolean;
BEGIN
  -- A companion UUID is its authority identity, not mutable row metadata.
  -- Renaming it would free the protected identity for a replacement INSERT.
  IF TG_TABLE_NAME = 'companion_authority_state'
     AND (v_new->>'companion_id') IS DISTINCT FROM (v_old->>'companion_id') THEN
    RAISE EXCEPTION 'companion authority identity is immutable; use fleet_auth.operator_reinstate_companion'
      USING ERRCODE = '42501';
  END IF;

  -- Every non-active companion row is an activation gate, including legacy
  -- removed rows whose lineage tuple predates the tuple columns. A null tuple
  -- must never turn this trigger into an unguarded backup-role update path.
  v_companion_non_active := TG_TABLE_NAME = 'companion_authority_state'
    AND (v_old->>'lifecycle') <> 'active';
  IF (v_old->>'restore_state') IS DISTINCT FROM 'quarantined'
     AND NOT v_companion_non_active THEN
    RETURN NEW;
  END IF;

  v_lifecycle_column := CASE TG_TABLE_NAME
    WHEN 'human_principals' THEN 'status'
    WHEN 'companion_authority_state' THEN 'lifecycle'
    WHEN 'provider_subjects' THEN 'state'
    WHEN 'principal_contact_bindings' THEN 'state'
    WHEN 'principal_role_grants' THEN 'lifecycle'
    ELSE NULL
  END;
  IF v_lifecycle_column IS NULL THEN
    RAISE EXCEPTION 'fleet_auth restore guard is attached to an unexpected table %', TG_TABLE_NAME
      USING ERRCODE = '42501';
  END IF;
  v_new_lifecycle := v_new->>v_lifecycle_column;

  SELECT owner_role.rolname INTO v_schema_owner
  FROM pg_namespace AS namespace
  JOIN pg_roles AS owner_role ON owner_role.oid = namespace.nspowner
  WHERE namespace.nspname = 'fleet_auth';

  -- The bounded operator reinstatement procedures run SECURITY DEFINER as the
  -- schema owner. Only that context may reactivate a quarantined account row.
  IF current_user = v_schema_owner THEN
    RETURN NEW;
  END IF;

  IF v_companion_non_active THEN
    -- A legitimately removed, previously reapproved companion may be re-added
    -- on a strictly newer projected lineage. This transition remains
    -- quarantined and is the only non-owner mutation of the protected tuple.
    IF (v_old->>'restore_state') = 'live'
       AND (v_old->>'lifecycle') = 'removed'
       AND (v_new->>'restore_state') = 'live'
       AND v_new_lifecycle = 'quarantined'
       AND (v_new->>'version')::bigint = (v_old->>'version')::bigint + 1
       AND (v_new->>'authority_generation')::bigint =
          (v_new->>'lineage_generation')::bigint
       AND (v_new->>'lineage_generation')::bigint >
          (v_old->>'authority_generation')::bigint
       AND (v_new->>'authority_lineage_id') IS NOT NULL
       AND (v_new->>'authority_lineage_id') IS DISTINCT FROM
          (v_old->>'authority_lineage_id')
       AND (v_new->>'readd_decision_id') IS NOT NULL
       AND (v_new->>'readd_decision_id') IS DISTINCT FROM
          (v_old->>'readd_decision_id')
       AND EXISTS (
         SELECT 1
         FROM fleet_auth.authority_floor_tombstone_projection AS lineage
         WHERE lineage.kind = 'companion_lineage_floor'
           AND lineage.resource_hash = encode(
             sha256(convert_to(v_old->>'companion_id', 'UTF8')), 'hex'
           )
           AND lineage.authority_generation =
             (v_new->>'lineage_generation')::bigint
           AND lineage.companion_lineage_id = v_new->>'authority_lineage_id'
           AND lineage.companion_readd_decision_id =
             (v_new->>'readd_decision_id')::uuid
       ) AND EXISTS (
         SELECT 1
         FROM fleet_auth.authority_floor_tombstone_projection AS removal
         WHERE removal.kind = 'companion'
           AND removal.resource_hash = encode(
             sha256(convert_to(v_old->>'companion_id', 'UTF8')), 'hex'
           )
           AND removal.authority_generation <
             (v_new->>'lineage_generation')::bigint
       ) THEN
      RETURN NEW;
    END IF;

    -- Every other update must preserve the complete non-active authority
    -- state. In particular, changing quarantined -> removed no longer creates
    -- an unguarded second hop to active, and a restored lineage cannot shed
    -- restore quarantine or its exact tuple.
    IF v_new_lifecycle IS DISTINCT FROM (v_old->>'lifecycle')
       OR (v_new->>'restore_state') IS DISTINCT FROM (v_old->>'restore_state')
       OR (v_new->>'authority_generation') IS DISTINCT FROM (v_old->>'authority_generation')
       OR (v_new->>'version') IS DISTINCT FROM (v_old->>'version')
       OR (v_new->>'authority_lineage_id') IS DISTINCT FROM (v_old->>'authority_lineage_id')
       OR (v_new->>'lineage_generation') IS DISTINCT FROM (v_old->>'lineage_generation')
       OR (v_new->>'readd_decision_id') IS DISTINCT FROM (v_old->>'readd_decision_id') THEN
      RAISE EXCEPTION 'companion lineage quarantine can only be activated through fleet_auth.operator_reinstate_companion'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF (v_new->>'restore_state') IS DISTINCT FROM 'quarantined'
     OR v_new_lifecycle NOT IN ('quarantined', 'revoked')
     OR (v_new->>'authority_generation') IS DISTINCT FROM (v_old->>'authority_generation')
     OR (v_new->>'authn_version') IS DISTINCT FROM (v_old->>'authn_version')
     OR (v_new->>'authz_version') IS DISTINCT FROM (v_old->>'authz_version')
     OR (v_new->>'binding_version') IS DISTINCT FROM (v_old->>'binding_version')
     OR (v_new->>'grant_version') IS DISTINCT FROM (v_old->>'grant_version')
     OR (v_new->>'policy_version') IS DISTINCT FROM (v_old->>'policy_version')
     OR (v_new->>'version') IS DISTINCT FROM (v_old->>'version')
     OR (v_new->>'authority_lineage_id') IS DISTINCT FROM (v_old->>'authority_lineage_id')
     OR (v_new->>'lineage_generation') IS DISTINCT FROM (v_old->>'lineage_generation')
     OR (v_new->>'readd_decision_id') IS DISTINCT FROM (v_old->>'readd_decision_id') THEN
    RAISE EXCEPTION 'quarantined fleet_auth authority can only be reactivated through fleet_auth.operator_reinstate_principal'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS restore_quarantine_activation_guard ON human_principals;
CREATE TRIGGER restore_quarantine_activation_guard
  BEFORE UPDATE ON human_principals
  FOR EACH ROW EXECUTE FUNCTION restore_quarantine_activation_guard();

DROP TRIGGER IF EXISTS restore_quarantine_activation_guard ON companion_authority_state;
CREATE TRIGGER restore_quarantine_activation_guard
  BEFORE UPDATE ON companion_authority_state
  FOR EACH ROW EXECUTE FUNCTION restore_quarantine_activation_guard();

DROP TRIGGER IF EXISTS restore_quarantine_activation_guard ON provider_subjects;
CREATE TRIGGER restore_quarantine_activation_guard
  BEFORE UPDATE ON provider_subjects
  FOR EACH ROW EXECUTE FUNCTION restore_quarantine_activation_guard();

DROP TRIGGER IF EXISTS restore_quarantine_activation_guard ON principal_contact_bindings;
CREATE TRIGGER restore_quarantine_activation_guard
  BEFORE UPDATE ON principal_contact_bindings
  FOR EACH ROW EXECUTE FUNCTION restore_quarantine_activation_guard();

DROP TRIGGER IF EXISTS restore_quarantine_activation_guard ON principal_role_grants;
CREATE TRIGGER restore_quarantine_activation_guard
  BEFORE UPDATE ON principal_role_grants
  FOR EACH ROW EXECUTE FUNCTION restore_quarantine_activation_guard();

-- BEFORE INSERT guard: a non-owner role must not create a live/active authority
-- row that reactivates a quarantined principal. Must NOT be SECURITY DEFINER:
-- current_user has to reflect the connected role so a non-owner INSERT is caught.
CREATE OR REPLACE FUNCTION fleet_auth.restore_quarantine_insert_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, fleet_auth
AS $$
DECLARE
  v_new jsonb := to_jsonb(NEW);
  v_lifecycle_column text;
  v_new_lifecycle text;
  v_schema_owner text;
  v_principal_restore_state text;
BEGIN
  SELECT owner_role.rolname INTO v_schema_owner
  FROM pg_namespace AS namespace
  JOIN pg_roles AS owner_role ON owner_role.oid = namespace.nspowner
  WHERE namespace.nspname = 'fleet_auth';

  -- Companion rows may only be authored by a bounded schema-owner procedure.
  -- This fences ordinary INSERT, UPSERT and COPY even if grants later drift.
  IF TG_TABLE_NAME = 'companion_authority_state' THEN
    IF current_user <> v_schema_owner THEN
      RAISE EXCEPTION 'companion authority can only be inserted through a bounded fleet_auth schema-owner procedure'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  v_lifecycle_column := CASE TG_TABLE_NAME
    WHEN 'principal_contact_bindings' THEN 'state'
    WHEN 'principal_role_grants' THEN 'lifecycle'
    ELSE NULL
  END;
  IF v_lifecycle_column IS NULL THEN
    RAISE EXCEPTION 'fleet_auth restore insert guard is attached to an unexpected table %', TG_TABLE_NAME
      USING ERRCODE = '42501';
  END IF;
  v_new_lifecycle := v_new->>v_lifecycle_column;

  -- Only a live/active row could reactivate a quarantined principal. Rows the
  -- backup coordinator restores enter as restore_state='quarantined' and are
  -- never a reactivation, so they are never fenced here.
  IF (v_new->>'restore_state') IS DISTINCT FROM 'live'
     OR v_new_lifecycle NOT IN ('active', 'pending') THEN
    RETURN NEW;
  END IF;

  -- The SECURITY DEFINER operator reinstatement procedures run as the schema owner; only
  -- that context may author a live authority row bound to a quarantined
  -- principal.
  IF current_user = v_schema_owner THEN
    RETURN NEW;
  END IF;

  SELECT restore_state INTO v_principal_restore_state
  FROM fleet_auth.human_principals
  WHERE principal_id = NEW.principal_id;

  IF v_principal_restore_state = 'quarantined' THEN
    RAISE EXCEPTION 'cannot create a live fleet_auth authority row for a quarantined principal; use fleet_auth.operator_reinstate_principal'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

-- BEFORE DELETE guard: a non-owner role must not remove a quarantined authority
-- row (e.g. to free a live unique-index slot for a reactivating replacement).
-- Must NOT be SECURITY DEFINER, for the same reason as the insert guard.
CREATE OR REPLACE FUNCTION fleet_auth.restore_quarantine_delete_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, fleet_auth
AS $$
DECLARE
  v_schema_owner text;
BEGIN
  SELECT owner_role.rolname INTO v_schema_owner
  FROM pg_namespace AS namespace
  JOIN pg_roles AS owner_role ON owner_role.oid = namespace.nspowner
  WHERE namespace.nspname = 'fleet_auth';

  IF current_user = v_schema_owner THEN
    RETURN OLD;
  END IF;

  -- A companion authority identity is never replaceable by ordinary SQL,
  -- regardless of its current lifecycle or restore state.
  IF TG_TABLE_NAME = 'companion_authority_state' THEN
    RAISE EXCEPTION 'companion authority can only be removed through the fleet_auth schema owner context'
      USING ERRCODE = '42501';
  END IF;

  -- Only quarantined restore candidates are fenced on the other authority
  -- tables. Deletes of their live/revoked rows are unaffected.
  IF (to_jsonb(OLD)->>'restore_state') IS DISTINCT FROM 'quarantined' THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'quarantined fleet_auth authority row can only be removed through the schema owner context'
    USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS restore_quarantine_insert_guard ON companion_authority_state;
CREATE TRIGGER restore_quarantine_insert_guard
  BEFORE INSERT ON companion_authority_state
  FOR EACH ROW EXECUTE FUNCTION restore_quarantine_insert_guard();

DROP TRIGGER IF EXISTS restore_quarantine_delete_guard ON companion_authority_state;
CREATE TRIGGER restore_quarantine_delete_guard
  BEFORE DELETE ON companion_authority_state
  FOR EACH ROW EXECUTE FUNCTION restore_quarantine_delete_guard();

DROP TRIGGER IF EXISTS restore_quarantine_insert_guard ON principal_contact_bindings;
CREATE TRIGGER restore_quarantine_insert_guard
  BEFORE INSERT ON principal_contact_bindings
  FOR EACH ROW EXECUTE FUNCTION restore_quarantine_insert_guard();

DROP TRIGGER IF EXISTS restore_quarantine_delete_guard ON principal_contact_bindings;
CREATE TRIGGER restore_quarantine_delete_guard
  BEFORE DELETE ON principal_contact_bindings
  FOR EACH ROW EXECUTE FUNCTION restore_quarantine_delete_guard();

DROP TRIGGER IF EXISTS restore_quarantine_insert_guard ON principal_role_grants;
CREATE TRIGGER restore_quarantine_insert_guard
  BEFORE INSERT ON principal_role_grants
  FOR EACH ROW EXECUTE FUNCTION restore_quarantine_insert_guard();

DROP TRIGGER IF EXISTS restore_quarantine_delete_guard ON principal_role_grants;
CREATE TRIGGER restore_quarantine_delete_guard
  BEFORE DELETE ON principal_role_grants
  FOR EACH ROW EXECUTE FUNCTION restore_quarantine_delete_guard();
`;
