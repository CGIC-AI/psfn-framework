// Self-contained DDL for the constrained trusted-host reapproval boundary.
//
// This module owns no imports so it can be referenced by schema.ts without
// creating an import cycle. The SQL is applied idempotently by
// migrateFleetAuthSchema (alongside applyRoleGrants) rather than as a numbered
// migration, so the trusted-host reapproval boundary is reasserted on every
// migration run and is never left half-applied.
//
// Three structures make the raw-SQL restore-quarantine bypass impossible:
//
//   1. restore_quarantine_activation_guard — a BEFORE UPDATE trigger on every
//      mutable authority table. A quarantined row (restore_state='quarantined')
//      may only be de-escalated by the ordinary runtime/backup roles: its
//      lifecycle column may move to 'quarantined'/'revoked' only, restore_state
//      must stay 'quarantined', and authority generation / version counters may
//      not move. Reactivation (restore_state -> 'live', lifecycle -> active) is
//      permitted solely inside SECURITY DEFINER code owned by the fleet_auth
//      schema owner (the migration role), i.e. reapprove_account_authority.
//
//   2. reapprove_account_authority — a SECURITY DEFINER function owned by the
//      migration role that runs the full account/binding/role reapproval
//      ceremony transactionally: it consumes a current trusted-host ceremony,
//      binds lineage/generation/principal/provider/companion/contact/role,
//      rechecks conflicts and tombstones under lock, activates the account,
//      bumps versions and the auth epoch, revokes affected ephemeral authority,
//      and appends one immutable audit event.
//
//   3. restore_quarantine_insert_guard / restore_quarantine_delete_guard —
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
//      owner (the SECURITY DEFINER account or companion reapproval procedure)
//      may author the reactivating shape.

export const FLEET_AUTH_REAPPROVE_FUNCTION_NAME = 'fleet_auth.reapprove_account_authority';

export const FLEET_AUTH_REAPPROVE_FUNCTION_ARG_TYPES =
  'uuid, uuid, text, text, uuid, text, uuid, uuid, uuid, timestamptz';

export const FLEET_AUTH_REAPPROVAL_DDL_SQL = `
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
    RAISE EXCEPTION 'companion authority identity is immutable; use fleet_auth.reapprove_companion_authority'
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

  -- The constrained reapproval procedure runs SECURITY DEFINER as the schema
  -- owner. Only that context may reactivate a quarantined account row.
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
      RAISE EXCEPTION 'companion lineage quarantine can only be activated through fleet_auth.reapprove_companion_authority'
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
    RAISE EXCEPTION 'quarantined fleet_auth authority can only be reactivated through fleet_auth.reapprove_account_authority'
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

  -- The SECURITY DEFINER reapproval procedure runs as the schema owner; only
  -- that context may author a live authority row bound to a quarantined
  -- principal.
  IF current_user = v_schema_owner THEN
    RETURN NEW;
  END IF;

  SELECT restore_state INTO v_principal_restore_state
  FROM fleet_auth.human_principals
  WHERE principal_id = NEW.principal_id;

  IF v_principal_restore_state = 'quarantined' THEN
    RAISE EXCEPTION 'cannot create a live fleet_auth authority row for a quarantined principal; use fleet_auth.reapprove_account_authority'
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

CREATE OR REPLACE FUNCTION fleet_auth.reapprove_account_authority(
  p_ceremony_id uuid,
  p_principal_id uuid,
  p_provider text,
  p_provider_subject_id text,
  p_companion_id uuid,
  p_contact_id text,
  p_binding_id uuid,
  p_role_grant_id uuid,
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
  v_lineage text;
  v_now timestamptz;
  v_expected_scope jsonb;
  v_ceremony fleet_auth.trusted_host_ceremonies%ROWTYPE;
  v_principal fleet_auth.human_principals%ROWTYPE;
  v_companion fleet_auth.companion_authority_state%ROWTYPE;
  v_subject fleet_auth.provider_subjects%ROWTYPE;
  v_binding fleet_auth.principal_contact_bindings%ROWTYPE;
  v_grant fleet_auth.principal_role_grants%ROWTYPE;
  v_conflict integer;
  v_new_authn bigint;
  v_new_authz bigint;
  v_new_binding_version bigint;
  v_new_role_version bigint;
  v_contact_proof_intent_id uuid;
  v_contact_proof_request_digest text;
  v_contact_verification_digest text;
  v_reason_digest text;
  v_actor_session fleet_auth.browser_sessions%ROWTYPE;
  v_actor_principal fleet_auth.human_principals%ROWTYPE;
  v_actor_subject fleet_auth.provider_subjects%ROWTYPE;
  v_oauth fleet_auth.oauth_transactions%ROWTYPE;
  v_expected_oauth_proof_digest text;
BEGIN
  IF p_at IS NULL THEN
    RAISE EXCEPTION 'reapproval timestamp is required' USING ERRCODE = '42501';
  END IF;

  -- Current durable authority under lock.
  SELECT authority_generation, global_auth_epoch, restore_checkpoint, authority_lineage_id
    INTO v_generation, v_epoch, v_restore_checkpoint, v_lineage
  FROM fleet_auth.authority_state
  WHERE singleton = TRUE
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fleet_auth authority_state singleton is missing' USING ERRCODE = '42501';
  END IF;
  IF v_lineage IS NULL THEN
    RAISE EXCEPTION 'fleet_auth authority lineage is not provisioned' USING ERRCODE = '42501';
  END IF;

  -- Consume the exact current trusted-host ceremony.
  SELECT * INTO v_ceremony
  FROM fleet_auth.trusted_host_ceremonies
  WHERE ceremony_id = p_ceremony_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'trusted-host ceremony not found' USING ERRCODE = '42501';
  END IF;
  IF v_ceremony.kind <> 'account_reapproval' THEN
    RAISE EXCEPTION 'trusted-host ceremony is not an account reapproval' USING ERRCODE = '42501';
  END IF;
  IF v_ceremony.status <> 'pending' THEN
    RAISE EXCEPTION 'trusted-host ceremony is not pending' USING ERRCODE = '42501';
  END IF;
  IF v_ceremony.global_auth_epoch <> v_epoch THEN
    RAISE EXCEPTION 'trusted-host ceremony is bound to a stale auth epoch' USING ERRCODE = '42501';
  END IF;
  IF v_ceremony.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'trusted-host ceremony has expired' USING ERRCODE = '42501';
  END IF;
  IF v_ceremony.expected_provider <> p_provider
     OR v_ceremony.expected_provider_subject_id <> p_provider_subject_id
     OR v_ceremony.expected_companion_id IS DISTINCT FROM p_companion_id
     OR v_ceremony.expected_contact_id IS DISTINCT FROM p_contact_id THEN
    RAISE EXCEPTION 'trusted-host ceremony does not bind the requested account' USING ERRCODE = '42501';
  END IF;

  -- Principal must be a quarantined restore candidate.
  SELECT * INTO v_principal
  FROM fleet_auth.human_principals
  WHERE principal_id = p_principal_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'principal not found' USING ERRCODE = '42501';
  END IF;
  IF v_principal.restore_state <> 'quarantined' OR v_principal.status <> 'quarantined' THEN
    RAISE EXCEPTION 'principal is not a quarantined restore candidate' USING ERRCODE = '42501';
  END IF;

  -- Recheck the database projection of the non-restored authority floor. This
  -- keeps even direct invocation of the constrained procedure subordinate to
  -- principal/companion/provider/binding/grant tombstones; the gateway wrapper
  -- performs the same check against the authoritative file before connecting.
  IF EXISTS (
    SELECT 1
    FROM fleet_auth.authority_floor_tombstone_projection AS tombstone
    WHERE (tombstone.kind = 'provider_subject'
      AND tombstone.resource_hash = encode(sha256(convert_to(
        p_provider || ':' || p_provider_subject_id, 'UTF8'
      )), 'hex'))
      OR (tombstone.kind = 'principal'
        AND tombstone.resource_hash = encode(sha256(convert_to(p_principal_id::text, 'UTF8')), 'hex'))
      OR (tombstone.kind = 'companion'
        AND tombstone.resource_hash = encode(sha256(convert_to(p_companion_id::text, 'UTF8')), 'hex'))
      OR (tombstone.kind = 'contact_binding'
        AND tombstone.resource_hash = encode(sha256(convert_to(p_binding_id::text, 'UTF8')), 'hex'))
      OR (tombstone.kind = 'role_grant'
        AND tombstone.resource_hash = encode(sha256(convert_to(p_role_grant_id::text, 'UTF8')), 'hex'))
  ) THEN
    RAISE EXCEPTION 'account authority is tombstoned by the non-restored floor'
      USING ERRCODE = '42501';
  END IF;

  -- Provider subject binding, not tombstoned.
  SELECT * INTO v_subject
  FROM fleet_auth.provider_subjects
  WHERE provider = p_provider AND subject_id = p_provider_subject_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'provider subject not found' USING ERRCODE = '42501';
  END IF;
  IF v_subject.principal_id <> p_principal_id THEN
    RAISE EXCEPTION 'provider subject is bound to another principal' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM fleet_auth.provider_subject_tombstones
    WHERE provider = p_provider AND subject_id = p_provider_subject_id
  ) THEN
    RAISE EXCEPTION 'provider subject is permanently tombstoned' USING ERRCODE = '42501';
  END IF;
  IF v_subject.restore_state <> 'quarantined' OR v_subject.state <> 'quarantined' THEN
    RAISE EXCEPTION 'provider subject is not a quarantined restore candidate' USING ERRCODE = '42501';
  END IF;

  -- The companion is an independent versioned authority resource. A restored
  -- companion is promoted exactly once with the account; an already-live
  -- active companion remains unchanged so another restored account can be
  -- reapproved without spuriously advancing the companion version.
  SELECT * INTO v_companion
  FROM fleet_auth.companion_authority_state
  WHERE companion_id = p_companion_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'companion authority not found' USING ERRCODE = '42501';
  END IF;
  IF NOT (
    (v_companion.restore_state = 'quarantined' AND v_companion.lifecycle = 'quarantined')
    OR (v_companion.restore_state = 'live' AND v_companion.lifecycle = 'active')
  ) THEN
    RAISE EXCEPTION 'companion authority is not reapprovable' USING ERRCODE = '42501';
  END IF;

  -- Contact binding, exact and conflict-free.
  SELECT * INTO v_binding
  FROM fleet_auth.principal_contact_bindings
  WHERE binding_id = p_binding_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'contact binding not found' USING ERRCODE = '42501';
  END IF;
  IF v_binding.principal_id <> p_principal_id
     OR v_binding.companion_id <> p_companion_id
     OR v_binding.contact_id <> p_contact_id THEN
    RAISE EXCEPTION 'contact binding does not match the requested account' USING ERRCODE = '42501';
  END IF;
  IF v_binding.restore_state <> 'quarantined' OR v_binding.state <> 'quarantined' THEN
    RAISE EXCEPTION 'contact binding is not a quarantined restore candidate' USING ERRCODE = '42501';
  END IF;
  SELECT count(*) INTO v_conflict
  FROM fleet_auth.principal_contact_bindings
  WHERE companion_id = p_companion_id AND contact_id = p_contact_id
    AND binding_id <> p_binding_id AND state IN ('active', 'pending');
  IF v_conflict > 0 THEN
    RAISE EXCEPTION 'contact binding conflicts with a live binding' USING ERRCODE = '42501';
  END IF;

  -- Role grant, exact and conflict-free.
  SELECT * INTO v_grant
  FROM fleet_auth.principal_role_grants
  WHERE grant_id = p_role_grant_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'role grant not found' USING ERRCODE = '42501';
  END IF;
  IF v_grant.principal_id <> p_principal_id OR v_grant.companion_id <> p_companion_id THEN
    RAISE EXCEPTION 'role grant does not match the requested account' USING ERRCODE = '42501';
  END IF;
  IF v_grant.restore_state <> 'quarantined' OR v_grant.lifecycle <> 'quarantined' THEN
    RAISE EXCEPTION 'role grant is not a quarantined restore candidate' USING ERRCODE = '42501';
  END IF;
  SELECT count(*) INTO v_conflict
  FROM fleet_auth.principal_role_grants
  WHERE principal_id = p_principal_id AND companion_id = p_companion_id
    AND grant_id <> p_role_grant_id AND lifecycle IN ('active', 'pending');
  IF v_conflict > 0 THEN
    RAISE EXCEPTION 'role grant conflicts with a live grant' USING ERRCODE = '42501';
  END IF;

  -- Restored fleet authority may become live only after the authenticated
  -- companion has finalized one exact post-restore contact reapproval saga.
  -- The finalize request digest commits the exact reapproved post-state and
  -- contact version; the intent row binds companion/contact/Discord ownership.
  SELECT intent.intent_id, receipt.request_digest
    INTO v_contact_proof_intent_id, v_contact_proof_request_digest
  FROM fleet_auth.contact_authority_intents AS intent
  JOIN fleet_auth.contact_authority_receipts AS receipt
    ON receipt.companion_id = intent.companion_id
   AND receipt.intent_id = intent.intent_id
   AND receipt.phase = 'finalize'
  WHERE intent.companion_id = p_companion_id
    AND intent.action = 'contact.reapprove'
    AND intent.contact_id = p_contact_id
    AND intent.provider_subject_id = p_provider_subject_id
    AND intent.state = 'released'
    AND intent.restore_state = 'live'
    AND receipt.restore_state = 'live'
    AND receipt.result->>'status' = 'finalized'
    AND NOT EXISTS (
      SELECT 1
      FROM fleet_auth.contact_authority_intents AS newer
      WHERE newer.companion_id = intent.companion_id
        AND newer.intent_id <> intent.intent_id
        AND newer.created_at > intent.updated_at
        AND (newer.contact_id = intent.contact_id
          OR newer.provider_subject_id = intent.provider_subject_id)
    )
  ORDER BY intent.updated_at DESC, intent.intent_id DESC
  LIMIT 1
  FOR UPDATE OF intent;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'finalized exact companion contact ownership proof is required'
      USING ERRCODE = '42501';
  END IF;

  -- The trusted host binds the exact authority being promoted, including the
  -- role value and the current non-restored floor projection. JSONB equality
  -- is intentionally exact: missing or extra fields reject rather than being
  -- ignored by a permissive partial parser.
  v_contact_verification_digest := encode(sha256(convert_to(
    v_binding.verification_provenance::text, 'UTF8'
  )), 'hex');
  v_reason_digest := v_ceremony.exact_scope->>'reasonDigest';
  IF v_reason_digest IS NULL OR v_reason_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'trusted-host ceremony reason digest is invalid'
      USING ERRCODE = '42501';
  END IF;
  v_expected_scope := jsonb_build_object(
    'schemaVersion', 4,
    'principalId', p_principal_id::text,
    'provider', p_provider,
    'providerSubjectId', p_provider_subject_id,
    'companionId', p_companion_id::text,
    'contactId', p_contact_id,
    'bindingId', p_binding_id::text,
    'roleGrantId', p_role_grant_id::text,
    'role', v_grant.role,
    'companionVersion', v_companion.version,
    'bindingVersion', v_binding.version,
    'roleGrantVersion', v_grant.version,
    'contactOwnershipIntentId', v_contact_proof_intent_id::text,
    'contactOwnershipRequestDigest', v_contact_proof_request_digest,
    'contactVerificationDigest', v_contact_verification_digest,
    'authorityLineageId', v_lineage,
    'authorityGeneration', v_generation,
    'restoreCheckpoint', v_restore_checkpoint,
    'reasonDigest', v_reason_digest
  );
  IF v_ceremony.exact_scope IS DISTINCT FROM v_expected_scope THEN
    RAISE EXCEPTION 'trusted-host ceremony exact scope does not match the requested authority'
      USING ERRCODE = '42501';
  END IF;

  IF v_ceremony.protocol_version <> 1
     OR v_ceremony.exact_origin IS NULL
     OR v_ceremony.rp_id IS NULL
     OR v_ceremony.confirmed_at IS NULL
     OR v_ceremony.reapproval_verified_at IS NULL
     OR v_ceremony.reapproval_actor_principal_id IS NULL
     OR v_ceremony.reapproval_actor_session_id IS NULL
     OR v_ceremony.reapproval_oauth_transaction_id IS NULL
     OR v_ceremony.reapproval_oauth_proof_digest IS NULL
     OR v_ceremony.reapproval_credential_id_hash IS NULL
     OR v_ceremony.reapproval_credential_generation IS NULL
     OR v_ceremony.reapproval_credential_floor_generation IS NULL THEN
    RAISE EXCEPTION 'trusted-host ceremony lacks authenticated browser confirmation'
      USING ERRCODE = '42501';
  END IF;
  IF v_ceremony.reapproval_credential_id_hash !~ '^[0-9a-f]{64}$'
     OR v_ceremony.reapproval_credential_generation < 1
     OR NOT (
       v_ceremony.reapproval_credential_floor_generation =
         v_ceremony.credential_floor_generation
       OR v_ceremony.reapproval_credential_floor_generation =
         v_ceremony.credential_floor_generation + 1
     )
     OR v_ceremony.reapproval_credential_generation >
       v_ceremony.reapproval_credential_floor_generation THEN
    RAISE EXCEPTION 'trusted-host WebAuthn confirmation is stale'
      USING ERRCODE = '42501';
  END IF;

  -- The browser completion is an active same-origin session, a fresh Discord
  -- lifecycle callback for the exact restored subject, and a UV assertion
  -- confirmed by the coordinator role. Recheck the durable session and OAuth
  -- rows under lock so revocation between WebAuthn and activation denies.
  SELECT * INTO v_actor_session
  FROM fleet_auth.browser_sessions
  WHERE record_id = v_ceremony.reapproval_actor_session_id
  FOR UPDATE;
  IF NOT FOUND
     OR v_actor_session.principal_id <> v_ceremony.reapproval_actor_principal_id
     OR v_actor_session.provider <> 'discord'
     OR v_actor_session.revoked_at IS NOT NULL
     OR v_actor_session.replaced_by IS NOT NULL
     OR v_actor_session.global_auth_epoch <> v_epoch THEN
    RAISE EXCEPTION 'account reapproval browser session is unavailable'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_actor_principal
  FROM fleet_auth.human_principals
  WHERE principal_id = v_actor_session.principal_id
  FOR UPDATE;
  IF NOT FOUND
     OR v_actor_principal.status <> 'active'
     OR v_actor_principal.restore_state <> 'live'
     OR v_actor_principal.authn_version <> v_actor_session.authn_version
     OR v_actor_principal.authz_version <> v_actor_session.authz_version
     OR v_actor_principal.binding_version <> v_actor_session.binding_version
     OR v_actor_principal.grant_version <> v_actor_session.grant_version
     OR v_actor_principal.policy_version <> v_actor_session.policy_version THEN
    RAISE EXCEPTION 'account reapproval browser principal is unavailable'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_actor_subject
  FROM fleet_auth.provider_subjects
  WHERE provider = v_actor_session.provider
    AND subject_id = v_actor_session.provider_subject_id
    AND principal_id = v_actor_session.principal_id
  FOR UPDATE;
  IF NOT FOUND
     OR v_actor_subject.state <> 'active'
     OR v_actor_subject.restore_state <> 'live' THEN
    RAISE EXCEPTION 'account reapproval browser provider is unavailable'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_oauth
  FROM fleet_auth.oauth_transactions
  WHERE transaction_id = v_ceremony.reapproval_oauth_transaction_id
  FOR UPDATE;
  v_expected_oauth_proof_digest := encode(sha256(convert_to(
    'fleet-auth-verified-provider-proof:v1:discord:'
      || p_provider_subject_id || ':' || v_ceremony.reapproval_oauth_transaction_id::text,
    'UTF8'
  )), 'hex');
  IF NOT FOUND
     OR v_oauth.status <> 'consumed'
     OR v_oauth.kind <> 'recovery'
     OR v_oauth.global_auth_epoch <> v_epoch
     OR v_oauth.verified_provider <> 'discord'
     OR v_oauth.verified_provider_subject_id <> p_provider_subject_id
     OR v_oauth.lifecycle_ceremony_id <> p_ceremony_id
     OR v_oauth.lifecycle_action <> 'provider.relink'
     OR v_oauth.lifecycle_proof_role <> 'new'
     OR v_oauth.initiating_principal_id <> v_actor_session.principal_id
     OR v_oauth.initiating_session_id <> v_actor_session.record_id
     OR v_ceremony.reapproval_oauth_proof_digest <> v_expected_oauth_proof_digest THEN
    RAISE EXCEPTION 'account reapproval Discord proof is unavailable'
      USING ERRCODE = '42501';
  END IF;

  -- Escalate atomically. current_user is the definer (schema owner), so the
  -- restore_quarantine_activation_guard permits these transitions.
  v_new_epoch := v_epoch + 1;
  v_new_authn := v_principal.authn_version + 1;
  v_new_authz := v_principal.authz_version + 1;
  v_new_binding_version := v_binding.version + 1;
  v_new_role_version := v_grant.version + 1;

  -- A procedure may have waited on any authority row above after the ceremony
  -- was observed. Use a fresh database clock only after every relevant lock and
  -- validation, immediately before the first mutation, so a ceremony cannot be
  -- consumed after expiring during lock contention. This same instant stamps
  -- every atomic write below.
  v_now := clock_timestamp();
  IF v_ceremony.expires_at <= v_now
     OR v_actor_session.idle_expires_at <= v_now
     OR v_actor_session.absolute_expires_at <= v_now
     OR v_oauth.expires_at <= v_now THEN
    RAISE EXCEPTION 'trusted-host ceremony has expired' USING ERRCODE = '42501';
  END IF;

  IF v_companion.restore_state = 'quarantined' THEN
    UPDATE fleet_auth.companion_authority_state
    SET lifecycle = 'active', restore_state = 'live', version = version + 1,
        authority_generation = v_generation, updated_at = v_now
    WHERE companion_id = p_companion_id;
  END IF;

  UPDATE fleet_auth.provider_subjects
  SET state = 'active', restore_state = 'live',
      authority_generation = v_generation, updated_at = v_now
  WHERE provider = p_provider AND subject_id = p_provider_subject_id;

  UPDATE fleet_auth.human_principals
  SET status = 'active', restore_state = 'live',
      authn_version = v_new_authn, authz_version = v_new_authz,
      binding_version = binding_version + 1,
      grant_version = grant_version + 1,
      policy_version = policy_version + 1,
      authority_generation = v_generation, updated_at = v_now
  WHERE principal_id = p_principal_id;

  UPDATE fleet_auth.principal_contact_bindings
  SET state = 'active', restore_state = 'live', version = v_new_binding_version,
      authority_generation = v_generation, updated_at = v_now
  WHERE binding_id = p_binding_id;

  UPDATE fleet_auth.principal_role_grants
  SET lifecycle = 'active', restore_state = 'live', version = v_new_role_version,
      authority_generation = v_generation, updated_at = v_now
  WHERE grant_id = p_role_grant_id;

  -- Advance the ephemeral auth epoch and revoke affected ephemeral authority so
  -- no pre-reapproval session or escalation grant survives.
  UPDATE fleet_auth.authority_state
  SET global_auth_epoch = v_new_epoch, updated_at = v_now
  WHERE singleton = TRUE;

  UPDATE fleet_auth.browser_sessions
  SET revoked_at = v_now
  WHERE principal_id = p_principal_id AND revoked_at IS NULL;

  UPDATE fleet_auth.escalation_grants
  SET revoked_at = v_now
  WHERE principal_id = p_principal_id AND revoked_at IS NULL;

  -- Consume the ceremony exactly once.
  UPDATE fleet_auth.trusted_host_ceremonies
  SET status = 'consumed', consumed_at = v_now
  WHERE ceremony_id = p_ceremony_id;

  -- One immutable audit event bound to the new epoch.
  INSERT INTO fleet_auth.authorization_audit_events
    (event_id, actor_context, action, resource, decision, reason_code,
     companion_id, principal_id, authority_generation, global_auth_epoch,
     correlation_id, occurred_at, decision_context)
  VALUES (
    p_audit_event_id,
    jsonb_build_object(
      'kind', 'trusted_host',
      'id', 'account_reapproval',
      'ceremony', p_ceremony_id::text,
      'actorPrincipalId', v_actor_session.principal_id::text
    ),
    'authority.reapprove',
    format('principal:%s;binding:%s;role:%s', p_principal_id, p_binding_id, p_role_grant_id),
    'allow',
    'trusted_host_reapproval',
    p_companion_id,
    p_principal_id,
    v_generation,
    v_new_epoch,
    p_ceremony_id,
    v_now,
    jsonb_build_object(
      'schemaVersion', 1,
      'reasonDigest', v_reason_digest,
      'companionVersion', v_companion.version,
      'bindingVersion', v_binding.version,
      'roleGrantVersion', v_grant.version,
      'contactOwnershipRequestDigest', v_contact_proof_request_digest,
      'contactVerificationDigest', v_contact_verification_digest,
      'authorityLineageId', v_lineage,
      'authorityGeneration', v_generation,
      'restoreCheckpoint', v_restore_checkpoint,
      'credentialIdDigest', encode(sha256(convert_to(
        v_ceremony.reapproval_credential_id_hash, 'UTF8'
      )), 'hex'),
      'credentialGeneration', v_ceremony.reapproval_credential_generation,
      'credentialFloorGeneration', v_ceremony.reapproval_credential_floor_generation,
      'oauthProofDigest', v_ceremony.reapproval_oauth_proof_digest
    )
  );

  RETURN jsonb_build_object(
    'principalId', p_principal_id::text,
    'authorityGeneration', v_generation,
    'globalAuthEpoch', v_new_epoch,
    'authnVersion', v_new_authn,
    'authzVersion', v_new_authz,
    'bindingVersion', v_new_binding_version,
    'roleVersion', v_new_role_version,
    'auditEventId', p_audit_event_id::text
  );
END;
$$;
`;
