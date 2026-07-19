/**
 * Temporary live-alpha compatibility for images that predate canonical
 * model-usage attribution. The legacy writer omits event_fingerprint, which
 * gives the table boundary a narrow discriminator that modern writers cannot
 * accidentally enter.
 */
export const POSTGRES_MODEL_USAGE_ROLLBACK_MIGRATIONS = [
  `
  CREATE OR REPLACE FUNCTION psfn_model_usage_legacy_insert_bridge()
  RETURNS trigger
  LANGUAGE plpgsql
  AS $bridge$
  BEGIN
    IF NULLIF(BTRIM(NEW.event_fingerprint), '') IS NULL THEN
      NEW.origin_type := COALESCE(NULLIF(BTRIM(NEW.origin_type), ''), 'unknown');
      NEW.origin_stage := COALESCE(NULLIF(BTRIM(NEW.origin_stage), ''), 'unknown');
      NEW.service := COALESCE(NULLIF(BTRIM(NEW.service), ''), 'unknown');
      NEW.process := COALESCE(NULLIF(BTRIM(NEW.process), ''), 'unknown');
      NEW.turn_id := COALESCE(NULLIF(BTRIM(NEW.turn_id), ''), 'unknown');
      NEW.request_id := COALESCE(NULLIF(BTRIM(NEW.request_id), ''), 'unknown');
      NEW.channel_id := COALESCE(NULLIF(BTRIM(NEW.channel_id), ''), 'unknown');
      NEW.tool_name := COALESCE(NULLIF(BTRIM(NEW.tool_name), ''), 'unknown');
      NEW.tool_call_id := COALESCE(NULLIF(BTRIM(NEW.tool_call_id), ''), 'unknown');
      NEW.charge_lane := COALESCE(NULLIF(BTRIM(NEW.charge_lane), ''), 'unknown');
      NEW.charge_surface := COALESCE(NULLIF(BTRIM(NEW.charge_surface), ''), 'unknown');
      NEW.charge_run_id := COALESCE(NULLIF(BTRIM(NEW.charge_run_id), ''), 'unknown');
      NEW.charge_root_run_id := COALESCE(NULLIF(BTRIM(NEW.charge_root_run_id), ''), 'unknown');
      NEW.charge_parent_run_id := COALESCE(NULLIF(BTRIM(NEW.charge_parent_run_id), ''), 'unknown');
      NEW.slot_key := COALESCE(NULLIF(BTRIM(NEW.slot_key), ''), 'unknown');
      NEW.requested_provider := COALESCE(NULLIF(BTRIM(NEW.requested_provider), ''), 'unknown');
      NEW.requested_model := COALESCE(NULLIF(BTRIM(NEW.requested_model), ''), 'unknown');
      NEW.event_fingerprint := 'legacy:rollback-writer:' || NEW.id;
    END IF;
    RETURN NEW;
  END;
  $bridge$;
  `,
  `
  DO $bridge$
  BEGIN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_trigger
      WHERE tgrelid = 'model_usage_events'::regclass
        AND tgname = 'psfn_model_usage_legacy_insert_bridge'
        AND NOT tgisinternal
    ) THEN
      CREATE TRIGGER psfn_model_usage_legacy_insert_bridge
        BEFORE INSERT ON model_usage_events
        FOR EACH ROW
        EXECUTE FUNCTION psfn_model_usage_legacy_insert_bridge();
    END IF;
  END;
  $bridge$;
  `,
] as const;
