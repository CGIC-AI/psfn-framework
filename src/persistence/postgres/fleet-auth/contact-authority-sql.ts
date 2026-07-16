/**
 * Durable, gateway-owned contact lifecycle intent ledger and the database-side
 * activation fence.  The guard deliberately lives below every authoring path:
 * direct DML, first-owner, reapproval, and future SECURITY DEFINER procedures
 * cannot activate authority while a matching lifecycle resource is fenced.
 */
export const FLEET_AUTH_CONTACT_AUTHORITY_DDL_SQL = `
CREATE TABLE IF NOT EXISTS contact_authority_intents (
  companion_id UUID NOT NULL REFERENCES companion_authority_state(companion_id),
  intent_id UUID NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  intent_digest TEXT NOT NULL CHECK (intent_digest ~ '^[0-9a-f]{64}$'),
  action TEXT NOT NULL CHECK (action IN (
    'contact.merge', 'contact.delete', 'contact.discord_unlink',
    'contact.identity_conflict', 'contact.verify', 'contact.reapprove'
  )),
  contact_id TEXT NOT NULL CHECK (length(contact_id) BETWEEN 1 AND 256),
  canonical_contact_id TEXT,
  provider_subject_id TEXT CHECK (
    provider_subject_id IS NULL OR provider_subject_id ~ '^[1-9][0-9]{16,19}$'
  ),
  state TEXT NOT NULL CHECK (state IN ('active', 'released', 'terminal', 'quarantined')),
  authority_generation BIGINT NOT NULL CHECK (authority_generation >= 1),
  restore_state TEXT NOT NULL DEFAULT 'live' CHECK (restore_state IN ('live', 'quarantined')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (companion_id, intent_id),
  UNIQUE (intent_id),
  CONSTRAINT contact_authority_action_fields_exact CHECK (
    (action = 'contact.merge' AND canonical_contact_id IS NOT NULL
      AND canonical_contact_id <> contact_id AND provider_subject_id IS NULL)
    OR (action = 'contact.delete' AND canonical_contact_id IS NULL
      AND provider_subject_id IS NULL)
    OR (action IN ('contact.discord_unlink', 'contact.identity_conflict',
                   'contact.verify', 'contact.reapprove')
      AND canonical_contact_id IS NULL AND provider_subject_id IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS contact_authority_resources (
  companion_id UUID NOT NULL,
  intent_id UUID NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('contact', 'provider_subject')),
  resource_id TEXT NOT NULL CHECK (length(resource_id) BETWEEN 1 AND 512),
  terminal_fence BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (companion_id, intent_id, kind, resource_id),
  FOREIGN KEY (companion_id, intent_id)
    REFERENCES contact_authority_intents(companion_id, intent_id)
);

CREATE INDEX IF NOT EXISTS contact_authority_resource_fence_idx
  ON contact_authority_resources (kind, resource_id, companion_id, intent_id);

CREATE TABLE IF NOT EXISTS contact_authority_receipts (
  companion_id UUID NOT NULL,
  intent_id UUID NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('prepare', 'finalize')),
  request_digest TEXT NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  result JSONB NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  authority_generation BIGINT NOT NULL CHECK (authority_generation >= 1),
  global_auth_epoch BIGINT NOT NULL CHECK (global_auth_epoch >= 1),
  audit_event_id UUID NOT NULL UNIQUE REFERENCES authorization_audit_events(event_id),
  restore_state TEXT NOT NULL DEFAULT 'live' CHECK (restore_state IN ('live', 'quarantined')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (companion_id, intent_id, phase),
  UNIQUE (intent_id, phase),
  FOREIGN KEY (companion_id, intent_id)
    REFERENCES contact_authority_intents(companion_id, intent_id)
);

CREATE OR REPLACE FUNCTION reject_contact_authority_ledger_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'contact authority ledger is append-only'
    USING ERRCODE = '55000';
END;
$$;

CREATE OR REPLACE FUNCTION guard_contact_authority_intent_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'contact authority intents are durable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.companion_id IS DISTINCT FROM OLD.companion_id
    OR NEW.intent_id IS DISTINCT FROM OLD.intent_id
    OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
    OR NEW.intent_digest IS DISTINCT FROM OLD.intent_digest
    OR NEW.action IS DISTINCT FROM OLD.action
    OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
    OR NEW.canonical_contact_id IS DISTINCT FROM OLD.canonical_contact_id
    OR NEW.provider_subject_id IS DISTINCT FROM OLD.provider_subject_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.authority_generation < OLD.authority_generation
    OR NOT (
      NEW.state = OLD.state
      OR (OLD.state = 'active' AND NEW.state IN ('released', 'terminal', 'quarantined'))
      OR NEW.state = 'quarantined'
    )
    OR NOT (
      NEW.restore_state = OLD.restore_state
      OR (OLD.restore_state = 'live' AND NEW.restore_state = 'quarantined')
    ) THEN
    RAISE EXCEPTION 'invalid contact authority intent transition'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS contact_authority_intents_transition_guard
  ON contact_authority_intents;
CREATE TRIGGER contact_authority_intents_transition_guard
  BEFORE UPDATE OR DELETE ON contact_authority_intents
  FOR EACH ROW EXECUTE FUNCTION guard_contact_authority_intent_transition();

CREATE OR REPLACE FUNCTION guard_contact_authority_receipt_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  intent_action TEXT;
BEGIN
  SELECT action INTO intent_action
  FROM fleet_auth.contact_authority_intents AS intent
  WHERE intent.companion_id = NEW.companion_id
    AND intent.intent_id = NEW.intent_id;
  IF NOT FOUND
    OR (SELECT count(*) FROM jsonb_object_keys(NEW.result)) <> 8
    OR NEW.result->'schemaVersion' <> '1'::jsonb
    OR NEW.result->'intentId' <> to_jsonb(NEW.intent_id::text)
    OR NEW.result->'phase' <> to_jsonb(NEW.phase)
    OR NEW.result->'action' <> to_jsonb(intent_action)
    OR NEW.result->'authorityGeneration' <> to_jsonb(NEW.authority_generation)
    OR NEW.result->'globalAuthEpoch' <> to_jsonb(NEW.global_auth_epoch)
    OR NEW.result->'auditEventId' <> to_jsonb(NEW.audit_event_id::text)
    OR NOT (
      (NEW.phase = 'prepare'
        AND NEW.result->>'status' IN ('prepared', 'reserved', 'no_binding'))
      OR (NEW.phase = 'finalize' AND NEW.result->>'status' = 'finalized')
    ) THEN
    RAISE EXCEPTION 'contact authority receipt does not match its exact ledger tuple'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS contact_authority_receipts_insert_guard
  ON contact_authority_receipts;
CREATE TRIGGER contact_authority_receipts_insert_guard
  BEFORE INSERT ON contact_authority_receipts
  FOR EACH ROW EXECUTE FUNCTION guard_contact_authority_receipt_insert();

DROP TRIGGER IF EXISTS contact_authority_resources_append_only ON contact_authority_resources;
CREATE TRIGGER contact_authority_resources_append_only
  BEFORE UPDATE OR DELETE ON contact_authority_resources
  FOR EACH ROW EXECUTE FUNCTION reject_contact_authority_ledger_mutation();

DROP TRIGGER IF EXISTS contact_authority_receipts_append_only ON contact_authority_receipts;
CREATE TRIGGER contact_authority_receipts_append_only
  BEFORE UPDATE OR DELETE ON contact_authority_receipts
  FOR EACH ROW EXECUTE FUNCTION reject_contact_authority_ledger_mutation();

CREATE OR REPLACE FUNCTION contact_authority_resource_fenced(
  p_companion_id UUID,
  p_kind TEXT,
  p_resource_id TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, fleet_auth
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM fleet_auth.contact_authority_resources AS resource
    JOIN fleet_auth.contact_authority_intents AS intent
      ON intent.companion_id = resource.companion_id
     AND intent.intent_id = resource.intent_id
    WHERE resource.kind = p_kind
      AND resource.resource_id = p_resource_id
      AND (resource.companion_id = p_companion_id OR p_kind = 'provider_subject')
      AND (intent.state IN ('active', 'quarantined')
        OR (intent.state = 'terminal' AND resource.terminal_fence)
        OR intent.restore_state = 'quarantined')
  ) OR EXISTS (
    SELECT 1
    FROM fleet_auth.authority_floor_tombstone_projection AS floor
    WHERE floor.kind = 'contact_authority_fence'
      AND floor.resource_hash = encode(sha256(convert_to(
        CASE WHEN p_kind = 'contact'
          THEN 'contact:' || p_companion_id::text || ':' || p_resource_id
          ELSE 'provider_subject:' || p_companion_id::text || ':discord:' || p_resource_id
        END,
        'UTF8'
      )), 'hex')
  );
$$;

CREATE OR REPLACE FUNCTION guard_contact_binding_authority_activation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, fleet_auth
AS $$
BEGIN
  IF NEW.state = 'active'
     AND fleet_auth.contact_authority_resource_fenced(
       NEW.companion_id, 'contact', NEW.contact_id
     ) THEN
    RAISE EXCEPTION 'contact authority is fenced' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_provider_subject_contact_authority_activation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, fleet_auth
AS $$
BEGIN
  IF NEW.state = 'active' AND (
    EXISTS (
      SELECT 1
      FROM fleet_auth.contact_authority_resources AS resource
      JOIN fleet_auth.contact_authority_intents AS intent
        ON intent.companion_id = resource.companion_id
       AND intent.intent_id = resource.intent_id
      WHERE resource.kind = 'provider_subject'
        AND resource.resource_id = NEW.subject_id
        AND (intent.state IN ('active', 'quarantined')
          OR (intent.state = 'terminal' AND resource.terminal_fence)
          OR intent.restore_state = 'quarantined')
    ) OR EXISTS (
      SELECT 1
      FROM fleet_auth.authority_floor_tombstone_projection AS floor
      WHERE floor.kind = 'provider_subject'
        AND floor.resource_hash = encode(sha256(convert_to(
          'discord:' || NEW.subject_id,
          'UTF8'
        )), 'hex')
    )
  ) THEN
    RAISE EXCEPTION 'provider subject authority is fenced' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_role_grant_contact_authority_activation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, fleet_auth
AS $$
BEGIN
  IF NEW.lifecycle = 'active' AND EXISTS (
       SELECT 1
       FROM fleet_auth.principal_contact_bindings AS binding
       WHERE binding.principal_id = NEW.principal_id
         AND binding.companion_id = NEW.companion_id
         AND fleet_auth.contact_authority_resource_fenced(
           binding.companion_id, 'contact', binding.contact_id
         )
     ) THEN
    RAISE EXCEPTION 'role grant contact authority is fenced' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS contact_authority_binding_activation_guard
  ON principal_contact_bindings;
CREATE TRIGGER contact_authority_binding_activation_guard
  BEFORE INSERT OR UPDATE OF state, companion_id, contact_id
  ON principal_contact_bindings
  FOR EACH ROW EXECUTE FUNCTION guard_contact_binding_authority_activation();

DROP TRIGGER IF EXISTS contact_authority_provider_activation_guard
  ON provider_subjects;
CREATE TRIGGER contact_authority_provider_activation_guard
  BEFORE INSERT OR UPDATE OF state, subject_id ON provider_subjects
  FOR EACH ROW EXECUTE FUNCTION guard_provider_subject_contact_authority_activation();

DROP TRIGGER IF EXISTS contact_authority_grant_activation_guard
  ON principal_role_grants;
CREATE TRIGGER contact_authority_grant_activation_guard
  BEFORE INSERT OR UPDATE OF lifecycle, companion_id, principal_id
  ON principal_role_grants
  FOR EACH ROW EXECUTE FUNCTION guard_role_grant_contact_authority_activation();

REVOKE ALL ON FUNCTION contact_authority_resource_fenced(UUID, TEXT, TEXT) FROM PUBLIC;
`;

export const FLEET_AUTH_CONTACT_AUTHORITY_FENCE_FUNCTION_NAME =
  'fleet_auth.contact_authority_resource_fenced';
export const FLEET_AUTH_CONTACT_AUTHORITY_FENCE_FUNCTION_ARG_TYPES = 'uuid,text,text';
