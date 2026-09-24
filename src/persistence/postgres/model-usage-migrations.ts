import { POSTGRES_MODEL_USAGE_ROLLBACK_MIGRATIONS } from './model-usage-rollback-migrations.js';

export const POSTGRES_MODEL_USAGE_MIGRATION_ADVISORY_LOCK = [
  1_297_431_347,
  1_431_521_607,
] as const;

export const POSTGRES_MODEL_USAGE_MIGRATIONS = [
  `
  CREATE TABLE IF NOT EXISTS model_usage_events (
    id TEXT PRIMARY KEY,
    logical_call_id TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 0,
    recorded_at_ms BIGINT NOT NULL,
    started_at_ms BIGINT NOT NULL,
    completed_at_ms BIGINT,
    duration_ms BIGINT,
    ttft_ms BIGINT,
    day_key TEXT NOT NULL,
    month_key TEXT NOT NULL,
    status TEXT NOT NULL,
    settlement TEXT NOT NULL DEFAULT 'unknown',
    call_kind TEXT NOT NULL,
    call_type TEXT NOT NULL,
    purpose TEXT NOT NULL,
    origin_type TEXT NOT NULL DEFAULT 'unknown',
    origin_stage TEXT NOT NULL DEFAULT 'unknown',
    service TEXT NOT NULL DEFAULT 'unknown',
    process TEXT NOT NULL DEFAULT 'unknown',
    companion_id TEXT NOT NULL DEFAULT 'unknown',
    session_id TEXT NOT NULL DEFAULT 'unknown',
    turn_id TEXT NOT NULL DEFAULT 'unknown',
    request_id TEXT NOT NULL DEFAULT 'unknown',
    channel_id TEXT NOT NULL DEFAULT 'unknown',
    channel_type TEXT NOT NULL DEFAULT 'unknown',
    tool_name TEXT NOT NULL DEFAULT 'unknown',
    tool_call_id TEXT NOT NULL DEFAULT 'unknown',
    charge_lane TEXT NOT NULL DEFAULT 'unknown',
    charge_surface TEXT NOT NULL DEFAULT 'unknown',
    charge_event_id TEXT NOT NULL DEFAULT 'unknown',
    charge_run_id TEXT NOT NULL DEFAULT 'unknown',
    charge_root_run_id TEXT NOT NULL DEFAULT 'unknown',
    charge_parent_run_id TEXT NOT NULL DEFAULT 'unknown',
    shard_id TEXT NOT NULL DEFAULT 'unknown',
    subagent_id TEXT NOT NULL DEFAULT 'unknown',
    conversation_id TEXT NOT NULL DEFAULT 'unknown',
    root_initiation_id TEXT NOT NULL DEFAULT 'unknown',
    workload_type TEXT NOT NULL DEFAULT 'unknown',
    workload_id TEXT NOT NULL DEFAULT 'unknown',
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    slot_key TEXT NOT NULL DEFAULT 'unknown',
    requested_provider TEXT NOT NULL DEFAULT 'unknown',
    requested_model TEXT NOT NULL DEFAULT 'unknown',
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    provider_input_cost_usd DOUBLE PRECISION,
    provider_output_cost_usd DOUBLE PRECISION,
    provider_cache_read_cost_usd DOUBLE PRECISION,
    provider_cache_write_cost_usd DOUBLE PRECISION,
    provider_cost_usd DOUBLE PRECISION,
    estimated_input_cost_usd DOUBLE PRECISION,
    estimated_output_cost_usd DOUBLE PRECISION,
    estimated_cache_read_cost_usd DOUBLE PRECISION,
    estimated_cache_write_cost_usd DOUBLE PRECISION,
    estimated_cost_usd DOUBLE PRECISION,
    effective_input_cost_usd DOUBLE PRECISION,
    effective_output_cost_usd DOUBLE PRECISION,
    effective_cache_read_cost_usd DOUBLE PRECISION,
    effective_cache_write_cost_usd DOUBLE PRECISION,
    effective_cost_usd DOUBLE PRECISION,
    cost_source TEXT NOT NULL DEFAULT 'none',
    currency TEXT,
    stop_reason TEXT,
    error_code TEXT,
    error_message TEXT,
    metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    event_fingerprint TEXT NOT NULL,
    telemetry_visibility TEXT NOT NULL DEFAULT 'operator_visible',
    accounting_schema_version INTEGER NOT NULL DEFAULT 2,
    attribution_schema_version INTEGER NOT NULL DEFAULT 1,
    CHECK (status IN ('success', 'failure')),
    CHECK (settlement IN ('complete', 'partial', 'unknown')),
    CHECK (call_kind IN ('chat', 'completion', 'embedding', 'image_create', 'image_edit')),
    CHECK (telemetry_visibility IN ('operator_visible', 'companion_private')),
    CHECK (cost_source IN ('provider', 'estimate', 'none')),
    CHECK (accounting_schema_version = 2),
    CHECK (attribution_schema_version = 1),
    CONSTRAINT model_usage_events_usd_currency_check CHECK (currency IS NULL OR currency = 'USD'),
    CONSTRAINT model_usage_events_token_accounting_check CHECK (
      attempt >= 0
      AND input_tokens >= 0
      AND output_tokens >= 0
      AND cache_read_tokens >= 0
      AND cache_write_tokens >= 0
      AND total_tokens = input_tokens + output_tokens + cache_read_tokens + cache_write_tokens
    ),
    UNIQUE (logical_call_id, attempt)
  );
  `,
  `
  ALTER TABLE model_usage_events
    ADD COLUMN IF NOT EXISTS settlement TEXT NOT NULL DEFAULT 'unknown',
    ADD COLUMN IF NOT EXISTS provider_input_cost_usd DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS provider_output_cost_usd DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS provider_cache_read_cost_usd DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS provider_cache_write_cost_usd DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS estimated_input_cost_usd DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS estimated_output_cost_usd DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS estimated_cache_read_cost_usd DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS estimated_cache_write_cost_usd DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS effective_input_cost_usd DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS effective_output_cost_usd DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS effective_cache_read_cost_usd DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS effective_cache_write_cost_usd DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS effective_cost_usd DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS event_fingerprint TEXT,
    ADD COLUMN IF NOT EXISTS accounting_schema_version INTEGER,
    ADD COLUMN IF NOT EXISTS companion_id TEXT NOT NULL DEFAULT 'unknown',
    ADD COLUMN IF NOT EXISTS session_id TEXT NOT NULL DEFAULT 'unknown',
    ADD COLUMN IF NOT EXISTS channel_type TEXT NOT NULL DEFAULT 'unknown',
    ADD COLUMN IF NOT EXISTS charge_event_id TEXT NOT NULL DEFAULT 'unknown',
    ADD COLUMN IF NOT EXISTS shard_id TEXT NOT NULL DEFAULT 'unknown',
    ADD COLUMN IF NOT EXISTS subagent_id TEXT NOT NULL DEFAULT 'unknown',
    ADD COLUMN IF NOT EXISTS conversation_id TEXT NOT NULL DEFAULT 'unknown',
    ADD COLUMN IF NOT EXISTS root_initiation_id TEXT NOT NULL DEFAULT 'unknown',
    ADD COLUMN IF NOT EXISTS workload_type TEXT NOT NULL DEFAULT 'unknown',
    ADD COLUMN IF NOT EXISTS workload_id TEXT NOT NULL DEFAULT 'unknown',
    ADD COLUMN IF NOT EXISTS attribution_schema_version INTEGER NOT NULL DEFAULT 1;
  `,
  `
  UPDATE model_usage_events
  SET
    origin_type = COALESCE(NULLIF(BTRIM(origin_type), ''), 'unknown'),
    origin_stage = COALESCE(NULLIF(BTRIM(origin_stage), ''), 'unknown'),
    service = COALESCE(NULLIF(BTRIM(service), ''), 'unknown'),
    process = COALESCE(NULLIF(BTRIM(process), ''), 'unknown'),
    companion_id = COALESCE(NULLIF(BTRIM(companion_id), ''), 'unknown'),
    session_id = COALESCE(NULLIF(BTRIM(session_id), ''), 'unknown'),
    turn_id = COALESCE(NULLIF(BTRIM(turn_id), ''), 'unknown'),
    request_id = COALESCE(NULLIF(BTRIM(request_id), ''), 'unknown'),
    channel_id = COALESCE(NULLIF(BTRIM(channel_id), ''), 'unknown'),
    channel_type = COALESCE(NULLIF(BTRIM(channel_type), ''), 'unknown'),
    tool_name = COALESCE(NULLIF(BTRIM(tool_name), ''), 'unknown'),
    tool_call_id = COALESCE(NULLIF(BTRIM(tool_call_id), ''), 'unknown'),
    charge_lane = COALESCE(NULLIF(BTRIM(charge_lane), ''), 'unknown'),
    charge_surface = COALESCE(NULLIF(BTRIM(charge_surface), ''), 'unknown'),
    charge_event_id = COALESCE(NULLIF(BTRIM(charge_event_id), ''), 'unknown'),
    charge_run_id = COALESCE(NULLIF(BTRIM(charge_run_id), ''), 'unknown'),
    charge_root_run_id = COALESCE(NULLIF(BTRIM(charge_root_run_id), ''), 'unknown'),
    charge_parent_run_id = COALESCE(NULLIF(BTRIM(charge_parent_run_id), ''), 'unknown'),
    shard_id = COALESCE(NULLIF(BTRIM(shard_id), ''), 'unknown'),
    subagent_id = COALESCE(NULLIF(BTRIM(subagent_id), ''), 'unknown'),
    conversation_id = COALESCE(NULLIF(BTRIM(conversation_id), ''), 'unknown'),
    root_initiation_id = COALESCE(NULLIF(BTRIM(root_initiation_id), ''), 'unknown'),
    workload_type = COALESCE(NULLIF(BTRIM(workload_type), ''), 'unknown'),
    workload_id = COALESCE(NULLIF(BTRIM(workload_id), ''), 'unknown'),
    slot_key = COALESCE(NULLIF(BTRIM(slot_key), ''), 'unknown'),
    requested_provider = COALESCE(NULLIF(BTRIM(requested_provider), ''), 'unknown'),
    requested_model = COALESCE(NULLIF(BTRIM(requested_model), ''), 'unknown'),
    attribution_schema_version = 1
  WHERE attribution_schema_version IS DISTINCT FROM 1
    OR COALESCE(BTRIM(origin_type), '') = ''
    OR COALESCE(BTRIM(origin_stage), '') = ''
    OR COALESCE(BTRIM(service), '') = ''
    OR COALESCE(BTRIM(process), '') = ''
    OR COALESCE(BTRIM(companion_id), '') = ''
    OR COALESCE(BTRIM(session_id), '') = ''
    OR COALESCE(BTRIM(turn_id), '') = ''
    OR COALESCE(BTRIM(request_id), '') = ''
    OR COALESCE(BTRIM(channel_id), '') = ''
    OR COALESCE(BTRIM(channel_type), '') = ''
    OR COALESCE(BTRIM(tool_name), '') = ''
    OR COALESCE(BTRIM(tool_call_id), '') = ''
    OR COALESCE(BTRIM(charge_lane), '') = ''
    OR COALESCE(BTRIM(charge_surface), '') = ''
    OR COALESCE(BTRIM(charge_event_id), '') = ''
    OR COALESCE(BTRIM(charge_run_id), '') = ''
    OR COALESCE(BTRIM(charge_root_run_id), '') = ''
    OR COALESCE(BTRIM(charge_parent_run_id), '') = ''
    OR COALESCE(BTRIM(shard_id), '') = ''
    OR COALESCE(BTRIM(subagent_id), '') = ''
    OR COALESCE(BTRIM(conversation_id), '') = ''
    OR COALESCE(BTRIM(root_initiation_id), '') = ''
    OR COALESCE(BTRIM(workload_type), '') = ''
    OR COALESCE(BTRIM(workload_id), '') = ''
    OR COALESCE(BTRIM(slot_key), '') = ''
    OR COALESCE(BTRIM(requested_provider), '') = ''
    OR COALESCE(BTRIM(requested_model), '') = '';
  `,
  `
  ALTER TABLE model_usage_events
    ALTER COLUMN origin_type SET DEFAULT 'unknown', ALTER COLUMN origin_type SET NOT NULL,
    ALTER COLUMN origin_stage SET DEFAULT 'unknown', ALTER COLUMN origin_stage SET NOT NULL,
    ALTER COLUMN service SET DEFAULT 'unknown', ALTER COLUMN service SET NOT NULL,
    ALTER COLUMN process SET DEFAULT 'unknown', ALTER COLUMN process SET NOT NULL,
    ALTER COLUMN companion_id SET DEFAULT 'unknown', ALTER COLUMN companion_id SET NOT NULL,
    ALTER COLUMN session_id SET DEFAULT 'unknown', ALTER COLUMN session_id SET NOT NULL,
    ALTER COLUMN turn_id SET DEFAULT 'unknown', ALTER COLUMN turn_id SET NOT NULL,
    ALTER COLUMN request_id SET DEFAULT 'unknown', ALTER COLUMN request_id SET NOT NULL,
    ALTER COLUMN channel_id SET DEFAULT 'unknown', ALTER COLUMN channel_id SET NOT NULL,
    ALTER COLUMN channel_type SET DEFAULT 'unknown', ALTER COLUMN channel_type SET NOT NULL,
    ALTER COLUMN tool_name SET DEFAULT 'unknown', ALTER COLUMN tool_name SET NOT NULL,
    ALTER COLUMN tool_call_id SET DEFAULT 'unknown', ALTER COLUMN tool_call_id SET NOT NULL,
    ALTER COLUMN charge_lane SET DEFAULT 'unknown', ALTER COLUMN charge_lane SET NOT NULL,
    ALTER COLUMN charge_surface SET DEFAULT 'unknown', ALTER COLUMN charge_surface SET NOT NULL,
    ALTER COLUMN charge_event_id SET DEFAULT 'unknown', ALTER COLUMN charge_event_id SET NOT NULL,
    ALTER COLUMN charge_run_id SET DEFAULT 'unknown', ALTER COLUMN charge_run_id SET NOT NULL,
    ALTER COLUMN charge_root_run_id SET DEFAULT 'unknown', ALTER COLUMN charge_root_run_id SET NOT NULL,
    ALTER COLUMN charge_parent_run_id SET DEFAULT 'unknown', ALTER COLUMN charge_parent_run_id SET NOT NULL,
    ALTER COLUMN shard_id SET DEFAULT 'unknown', ALTER COLUMN shard_id SET NOT NULL,
    ALTER COLUMN subagent_id SET DEFAULT 'unknown', ALTER COLUMN subagent_id SET NOT NULL,
    ALTER COLUMN conversation_id SET DEFAULT 'unknown', ALTER COLUMN conversation_id SET NOT NULL,
    ALTER COLUMN root_initiation_id SET DEFAULT 'unknown', ALTER COLUMN root_initiation_id SET NOT NULL,
    ALTER COLUMN workload_type SET DEFAULT 'unknown', ALTER COLUMN workload_type SET NOT NULL,
    ALTER COLUMN workload_id SET DEFAULT 'unknown', ALTER COLUMN workload_id SET NOT NULL,
    ALTER COLUMN slot_key SET DEFAULT 'unknown', ALTER COLUMN slot_key SET NOT NULL,
    ALTER COLUMN requested_provider SET DEFAULT 'unknown', ALTER COLUMN requested_provider SET NOT NULL,
    ALTER COLUMN requested_model SET DEFAULT 'unknown', ALTER COLUMN requested_model SET NOT NULL,
    ALTER COLUMN attribution_schema_version SET DEFAULT 1,
    ALTER COLUMN attribution_schema_version SET NOT NULL;
  `,
  `ALTER TABLE model_usage_events ALTER COLUMN estimated_cost_usd DROP DEFAULT;`,
  `ALTER TABLE model_usage_events ALTER COLUMN estimated_cost_usd DROP NOT NULL;`,
  `UPDATE model_usage_events SET accounting_schema_version = 1 WHERE accounting_schema_version IS NULL;`,
  `
  UPDATE model_usage_events
  SET
    estimated_cost_usd = NULL,
    effective_cost_usd = NULL
  WHERE accounting_schema_version = 1
    AND cost_source = 'none'
    AND provider_cost_usd IS NULL
    AND estimated_input_cost_usd IS NULL
    AND estimated_output_cost_usd IS NULL
    AND estimated_cache_read_cost_usd IS NULL
    AND estimated_cache_write_cost_usd IS NULL
    AND estimated_cost_usd = 0;
  `,
  `
  UPDATE model_usage_events
  SET
    settlement = CASE WHEN status = 'success' THEN 'complete' ELSE 'unknown' END,
    effective_cost_usd = COALESCE(effective_cost_usd, provider_cost_usd, estimated_cost_usd),
    event_fingerprint = COALESCE(event_fingerprint, 'legacy:' || id),
    accounting_schema_version = 1
  WHERE accounting_schema_version = 1
    AND (event_fingerprint IS NULL OR event_fingerprint LIKE 'legacy:%');
  `,
  `
  UPDATE model_usage_events
  SET currency = 'USD'
  WHERE accounting_schema_version = 1
    AND event_fingerprint LIKE 'legacy:%'
    AND currency IS NOT NULL
    AND UPPER(BTRIM(currency)) = 'USD'
    AND currency <> 'USD';
  `,
  `
  UPDATE model_usage_events
  SET
    metadata_json = jsonb_set(
      COALESCE(metadata_json, '{}'::jsonb),
      '{_accountingMigration}',
      COALESCE(metadata_json -> '_accountingMigration', '{}'::jsonb)
        || jsonb_build_object(
          'nonUsdCostQuarantined', TRUE,
          'currency', currency,
          'providerCost', jsonb_strip_nulls(jsonb_build_object(
            'input', provider_input_cost_usd,
            'output', provider_output_cost_usd,
            'cacheRead', provider_cache_read_cost_usd,
            'cacheWrite', provider_cache_write_cost_usd,
            'total', provider_cost_usd
          )),
          'estimatedCost', jsonb_strip_nulls(jsonb_build_object(
            'input', estimated_input_cost_usd,
            'output', estimated_output_cost_usd,
            'cacheRead', estimated_cache_read_cost_usd,
            'cacheWrite', estimated_cache_write_cost_usd,
            'total', estimated_cost_usd
          )),
          'effectiveCost', jsonb_strip_nulls(jsonb_build_object(
            'input', effective_input_cost_usd,
            'output', effective_output_cost_usd,
            'cacheRead', effective_cache_read_cost_usd,
            'cacheWrite', effective_cache_write_cost_usd,
            'total', effective_cost_usd
          ))
        ),
      TRUE
    ),
    provider_input_cost_usd = NULL,
    provider_output_cost_usd = NULL,
    provider_cache_read_cost_usd = NULL,
    provider_cache_write_cost_usd = NULL,
    provider_cost_usd = NULL,
    estimated_input_cost_usd = NULL,
    estimated_output_cost_usd = NULL,
    estimated_cache_read_cost_usd = NULL,
    estimated_cache_write_cost_usd = NULL,
    estimated_cost_usd = NULL,
    effective_input_cost_usd = NULL,
    effective_output_cost_usd = NULL,
    effective_cache_read_cost_usd = NULL,
    effective_cache_write_cost_usd = NULL,
    effective_cost_usd = NULL,
    cost_source = 'none',
    currency = NULL
  WHERE accounting_schema_version = 1
    AND event_fingerprint LIKE 'legacy:%'
    AND currency IS NOT NULL
    AND UPPER(BTRIM(currency)) <> 'USD';
  `,
  `
  UPDATE model_usage_events
  SET
    metadata_json = jsonb_set(
      COALESCE(metadata_json, '{}'::jsonb),
      '{_accountingMigration}',
      COALESCE(metadata_json -> '_accountingMigration', '{}'::jsonb)
        || jsonb_build_object(
          'legacyTotalTokens', total_tokens,
          'canonicalTotalTokens', input_tokens + output_tokens + cache_read_tokens + cache_write_tokens
        ),
      TRUE
    ),
    total_tokens = input_tokens + output_tokens + cache_read_tokens + cache_write_tokens
  WHERE accounting_schema_version = 1
    AND event_fingerprint LIKE 'legacy:%'
    AND total_tokens <> input_tokens + output_tokens + cache_read_tokens + cache_write_tokens;
  `,
  `UPDATE model_usage_events SET accounting_schema_version = 2 WHERE accounting_schema_version IS NULL OR accounting_schema_version = 1;`,
  `ALTER TABLE model_usage_events ALTER COLUMN accounting_schema_version SET DEFAULT 2;`,
  `ALTER TABLE model_usage_events ALTER COLUMN accounting_schema_version SET NOT NULL;`,
  `
  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'model_usage_events_accounting_schema_version_check'
        AND conrelid = 'model_usage_events'::regclass
    ) THEN
      ALTER TABLE model_usage_events
        ADD CONSTRAINT model_usage_events_accounting_schema_version_check
        CHECK (accounting_schema_version = 2) NOT VALID;
    END IF;
  END $$;
  `,
  `ALTER TABLE model_usage_events VALIDATE CONSTRAINT model_usage_events_accounting_schema_version_check;`,
  `
  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'model_usage_events_attribution_schema_version_check'
        AND conrelid = 'model_usage_events'::regclass
    ) THEN
      ALTER TABLE model_usage_events
        ADD CONSTRAINT model_usage_events_attribution_schema_version_check
        CHECK (attribution_schema_version = 1) NOT VALID;
    END IF;
  END $$;
  `,
  `ALTER TABLE model_usage_events VALIDATE CONSTRAINT model_usage_events_attribution_schema_version_check;`,
  `ALTER TABLE model_usage_events ALTER COLUMN event_fingerprint SET NOT NULL;`,
  // Live-alpha rollback bridge (bead 6yh6): the pre-attribution
  // writer explicitly inserts NULL for optional lineage columns and omits the
  // later event fingerprint. Defaults cannot repair an explicit NULL, so keep
  // the canonical NOT NULL invariants and normalize only that legacy shape at
  // the table boundary. Modern writers already provide canonical values and
  // pass through unchanged.
  ...POSTGRES_MODEL_USAGE_ROLLBACK_MIGRATIONS,
  `
  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'model_usage_events_settlement_check'
        AND conrelid = 'model_usage_events'::regclass
    ) THEN
      ALTER TABLE model_usage_events
        ADD CONSTRAINT model_usage_events_settlement_check
        CHECK (settlement IN ('complete', 'partial', 'unknown'));
    END IF;
  END $$;
  `,
  `
  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'model_usage_events_usd_currency_check'
        AND conrelid = 'model_usage_events'::regclass
    ) THEN
      ALTER TABLE model_usage_events
        ADD CONSTRAINT model_usage_events_usd_currency_check
        CHECK (currency IS NULL OR currency = 'USD') NOT VALID;
    END IF;
  END $$;
  `,
  `ALTER TABLE model_usage_events VALIDATE CONSTRAINT model_usage_events_usd_currency_check;`,
  `
  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'model_usage_events_token_accounting_check'
        AND conrelid = 'model_usage_events'::regclass
    ) THEN
      ALTER TABLE model_usage_events
        ADD CONSTRAINT model_usage_events_token_accounting_check
        CHECK (
          attempt >= 0
          AND input_tokens >= 0
          AND output_tokens >= 0
          AND cache_read_tokens >= 0
          AND cache_write_tokens >= 0
          AND total_tokens = input_tokens + output_tokens + cache_read_tokens + cache_write_tokens
        ) NOT VALID;
    END IF;
  END $$;
  `,
  `ALTER TABLE model_usage_events VALIDATE CONSTRAINT model_usage_events_token_accounting_check;`,
  // Introspection landmark privacy (#49): companion-private telemetry visibility. Appended after
  // the canonical cost-accounting steps; must precede idx_model_usage_events_visibility below.
  `ALTER TABLE model_usage_events ADD COLUMN IF NOT EXISTS telemetry_visibility TEXT NOT NULL DEFAULT 'operator_visible';`,
  `
  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = 'model_usage_events_telemetry_visibility_check'
        AND conrelid = 'model_usage_events'::regclass
    ) THEN
      ALTER TABLE model_usage_events
        ADD CONSTRAINT model_usage_events_telemetry_visibility_check
        CHECK (telemetry_visibility IN ('operator_visible', 'companion_private'));
    END IF;
  END
  $$;
  `,
  `CREATE INDEX IF NOT EXISTS idx_model_usage_events_recorded_at ON model_usage_events(recorded_at_ms DESC, id DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_model_usage_events_day ON model_usage_events(day_key, recorded_at_ms DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_model_usage_events_month ON model_usage_events(month_key, recorded_at_ms DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_model_usage_events_model ON model_usage_events(provider, model, recorded_at_ms DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_model_usage_events_purpose ON model_usage_events(call_kind, purpose, recorded_at_ms DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_model_usage_events_visibility ON model_usage_events(telemetry_visibility, recorded_at_ms DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_model_usage_events_tool ON model_usage_events(tool_name, recorded_at_ms DESC) WHERE tool_name IS NOT NULL;`,
  `CREATE INDEX IF NOT EXISTS idx_model_usage_events_request ON model_usage_events(request_id, turn_id, tool_call_id);`,
  `CREATE INDEX IF NOT EXISTS idx_model_usage_events_charge ON model_usage_events(charge_root_run_id, charge_run_id, recorded_at_ms DESC) WHERE charge_root_run_id IS NOT NULL;`,
  `CREATE INDEX IF NOT EXISTS idx_model_usage_events_charge_event ON model_usage_events(companion_id, charge_event_id, recorded_at_ms DESC) WHERE charge_event_id <> 'unknown';`,
  `CREATE INDEX IF NOT EXISTS idx_model_usage_events_companion_time ON model_usage_events(companion_id, recorded_at_ms DESC, id DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_model_usage_events_session_time ON model_usage_events(companion_id, session_id, recorded_at_ms DESC) WHERE session_id <> 'unknown';`,
  `CREATE INDEX IF NOT EXISTS idx_model_usage_events_channel_time ON model_usage_events(companion_id, channel_type, channel_id, recorded_at_ms DESC) WHERE channel_id <> 'unknown';`,
  `CREATE INDEX IF NOT EXISTS idx_model_usage_events_origin_time ON model_usage_events(companion_id, origin_type, origin_stage, recorded_at_ms DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_model_usage_events_service_process_time ON model_usage_events(companion_id, service, process, recorded_at_ms DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_model_usage_events_charge_attribution_time ON model_usage_events(companion_id, charge_lane, charge_surface, charge_root_run_id, charge_run_id, recorded_at_ms DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_model_usage_events_shard_time ON model_usage_events(companion_id, shard_id, recorded_at_ms DESC) WHERE shard_id <> 'unknown';`,
  `CREATE INDEX IF NOT EXISTS idx_model_usage_events_subagent_time ON model_usage_events(companion_id, subagent_id, recorded_at_ms DESC) WHERE subagent_id <> 'unknown';`,
  `CREATE INDEX IF NOT EXISTS idx_model_usage_events_conversation_time ON model_usage_events(companion_id, conversation_id, recorded_at_ms DESC) WHERE conversation_id <> 'unknown';`,
  `CREATE INDEX IF NOT EXISTS idx_model_usage_events_root_initiation_time ON model_usage_events(companion_id, root_initiation_id, recorded_at_ms DESC) WHERE root_initiation_id <> 'unknown';`,
  `CREATE INDEX IF NOT EXISTS idx_model_usage_events_workload_time ON model_usage_events(companion_id, workload_type, workload_id, recorded_at_ms DESC) WHERE workload_id <> 'unknown';`,
  `CREATE INDEX IF NOT EXISTS idx_model_usage_events_status_cost_time ON model_usage_events(companion_id, status, cost_source, recorded_at_ms DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_model_usage_events_slot_time ON model_usage_events(companion_id, slot_key, requested_provider, requested_model, recorded_at_ms DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_model_usage_events_expensive ON model_usage_events(companion_id, (COALESCE(effective_cost_usd, 0)) DESC, recorded_at_ms DESC, id DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_model_usage_events_metadata_gin ON model_usage_events USING GIN (metadata_json);`,
  // mmo9.7.3: per-companion x lane x model spend attribution. `runtime_lane_class`
  // records the SINGLE gate-resolved RuntimeLaneClass (worker-lanes.ts
  // RUNTIME_LANE_CLASSES). Additive to attribution schema v1; existing rows default
  // to 'unknown'. Keep the CHECK value list in sync with MODEL_USAGE_RUNTIME_LANE_CLASSES.
  `ALTER TABLE model_usage_events ADD COLUMN IF NOT EXISTS runtime_lane_class TEXT NOT NULL DEFAULT 'unknown';`,
  `
  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'model_usage_events_runtime_lane_class_check'
        AND conrelid = 'model_usage_events'::regclass
    ) THEN
      ALTER TABLE model_usage_events
        ADD CONSTRAINT model_usage_events_runtime_lane_class_check
        CHECK (runtime_lane_class IN (
          'foreground_chat',
          'post_turn_appraisal',
          'background_continuation',
          'maintenance_reflection',
          'unknown'
        )) NOT VALID;
    END IF;
  END $$;
  `,
  `ALTER TABLE model_usage_events VALIDATE CONSTRAINT model_usage_events_runtime_lane_class_check;`,
  `CREATE INDEX IF NOT EXISTS idx_model_usage_events_runtime_lane_class_time ON model_usage_events(companion_id, runtime_lane_class, model, recorded_at_ms DESC);`,
  `
  CREATE TABLE IF NOT EXISTS icp_conversation_cost_reservations (
    logical_call_id TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    conversation_id TEXT NOT NULL,
    root_initiation_id TEXT NOT NULL,
    companion_id TEXT NOT NULL,
    cost_purpose TEXT NOT NULL,
    closeout_eligible BOOLEAN NOT NULL,
    projected_cost_usd DOUBLE PRECISION NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    reservation_reason TEXT NOT NULL,
    settled_event_id TEXT,
    created_at_ms BIGINT NOT NULL,
    settled_at_ms BIGINT,
    PRIMARY KEY (logical_call_id, attempt),
    CHECK (attempt >= 0),
    CHECK (cost_purpose IN ('conversation_turn', 'tool', 'summary', 'extraction', 'sidecar')),
    CHECK (projected_cost_usd >= 0 AND projected_cost_usd <> 'NaN'::double precision),
    CHECK (status IN ('pending', 'settled', 'settled_unknown')),
    CHECK (reservation_reason IN ('below_warning', 'final_closeout_reserve')),
    CHECK (
      (status = 'pending' AND settled_event_id IS NULL AND settled_at_ms IS NULL)
      OR (status IN ('settled', 'settled_unknown') AND settled_event_id IS NOT NULL AND settled_at_ms IS NOT NULL)
    )
  );
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_icp_conversation_cost_reservations_projection
    ON icp_conversation_cost_reservations (conversation_id, root_initiation_id, status, created_at_ms);
  `,
  `
  CREATE TABLE IF NOT EXISTS icp_conversation_cost_decisions (
    decision_id TEXT PRIMARY KEY,
    recorded_at_ms BIGINT NOT NULL,
    logical_call_id TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    conversation_id TEXT NOT NULL,
    root_initiation_id TEXT NOT NULL,
    companion_id TEXT NOT NULL,
    cost_purpose TEXT NOT NULL,
    closeout_eligible BOOLEAN NOT NULL,
    allowed BOOLEAN NOT NULL,
    replayed BOOLEAN NOT NULL,
    reason TEXT NOT NULL,
    projected_request_cost_usd DOUBLE PRECISION NOT NULL,
    actual_cost_usd DOUBLE PRECISION NOT NULL,
    pending_projected_cost_usd DOUBLE PRECISION NOT NULL,
    projected_total_cost_usd DOUBLE PRECISION NOT NULL,
    unknown_cost_attempt_count INTEGER NOT NULL,
    warning_threshold_usd DOUBLE PRECISION NOT NULL,
    hard_limit_usd DOUBLE PRECISION NOT NULL,
    CHECK (attempt >= 0),
    CHECK (cost_purpose IN ('conversation_turn', 'tool', 'summary', 'extraction', 'sidecar')),
    CHECK (reason IN (
      'below_warning', 'final_closeout_reserve', 'warning_closeout_reserve_only',
      'hard_limit_exceeded', 'unknown_historical_cost', 'attempt_already_settled'
    )),
    CHECK (projected_request_cost_usd >= 0 AND projected_request_cost_usd <> 'NaN'::double precision),
    CHECK (actual_cost_usd >= 0 AND actual_cost_usd <> 'NaN'::double precision),
    CHECK (pending_projected_cost_usd >= 0 AND pending_projected_cost_usd <> 'NaN'::double precision),
    CHECK (projected_total_cost_usd >= 0 AND projected_total_cost_usd <> 'NaN'::double precision),
    CHECK (unknown_cost_attempt_count >= 0),
    CHECK (warning_threshold_usd > 0 AND hard_limit_usd > warning_threshold_usd)
  );
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_icp_conversation_cost_decisions_timeline
    ON icp_conversation_cost_decisions (conversation_id, root_initiation_id, recorded_at_ms DESC, decision_id DESC);
  `,
  `
  CREATE TABLE IF NOT EXISTS model_budget_operator_alerts (
    companion_id TEXT NOT NULL,
    threshold_reason TEXT NOT NULL,
    window_key TEXT NOT NULL,
    created_at_ms BIGINT NOT NULL,
    dedupe_key TEXT NOT NULL,
    dispatch_state TEXT NOT NULL DEFAULT 'ready',
    dispatch_attempt INTEGER NOT NULL DEFAULT 0,
    last_claimed_at_ms BIGINT,
    PRIMARY KEY (companion_id, threshold_reason, window_key),
    CHECK (threshold_reason IN ('daily_budget_exceeded', 'monthly_budget_exceeded')),
    CHECK (
      (threshold_reason = 'daily_budget_exceeded' AND window_key ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
      OR (threshold_reason = 'monthly_budget_exceeded' AND window_key ~ '^[0-9]{4}-[0-9]{2}$')
    ),
    CHECK (created_at_ms >= 0)
  );
  `,
  `ALTER TABLE model_budget_operator_alerts
    ADD COLUMN IF NOT EXISTS dedupe_key TEXT;`,
  `ALTER TABLE model_budget_operator_alerts
    ADD COLUMN IF NOT EXISTS dispatch_state TEXT NOT NULL DEFAULT 'ready';`,
  `ALTER TABLE model_budget_operator_alerts
    ADD COLUMN IF NOT EXISTS dispatch_attempt INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE model_budget_operator_alerts
    ADD COLUMN IF NOT EXISTS last_claimed_at_ms BIGINT;`,
  `UPDATE model_budget_operator_alerts
    SET dedupe_key = companion_id || ':' || threshold_reason || ':' || window_key
    WHERE dedupe_key IS NULL;`,
  `ALTER TABLE model_budget_operator_alerts
    ALTER COLUMN dedupe_key SET NOT NULL;`,
  `ALTER TABLE model_budget_operator_alerts
    DROP CONSTRAINT IF EXISTS model_budget_operator_alerts_outbox_check;`,
  `ALTER TABLE model_budget_operator_alerts
    ADD CONSTRAINT model_budget_operator_alerts_outbox_check CHECK (
      dedupe_key = companion_id || ':' || threshold_reason || ':' || window_key
      AND dispatch_state IN ('ready', 'dispatching', 'delivered')
      AND dispatch_attempt >= 0
      AND (dispatch_state = 'ready' OR dispatch_attempt >= 1)
      AND (last_claimed_at_ms IS NULL OR last_claimed_at_ms >= 0)
    );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_model_budget_operator_alert_dedupe_key
    ON model_budget_operator_alerts (dedupe_key);`,
  `
  CREATE TABLE IF NOT EXISTS model_budget_operator_alert_delivery_events (
    companion_id TEXT NOT NULL,
    threshold_reason TEXT NOT NULL,
    window_key TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    recorded_at_ms BIGINT NOT NULL,
    dedupe_key TEXT NOT NULL,
    status TEXT NOT NULL,
    topic TEXT,
    message_id TEXT,
    error TEXT,
    PRIMARY KEY (companion_id, threshold_reason, window_key, attempt),
    FOREIGN KEY (companion_id, threshold_reason, window_key)
      REFERENCES model_budget_operator_alerts(companion_id, threshold_reason, window_key)
      ON DELETE RESTRICT,
    CHECK (attempt >= 1),
    CHECK (recorded_at_ms >= 0),
    CHECK (status IN ('sent', 'debounced', 'failed')),
    CHECK ((status = 'failed') = (error IS NOT NULL))
  );
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_model_budget_operator_alert_delivery_timeline
    ON model_budget_operator_alert_delivery_events (
      companion_id, recorded_at_ms DESC, threshold_reason, window_key, attempt DESC
    );
  `,
  `
  CREATE OR REPLACE FUNCTION reject_model_budget_operator_alert_delivery_mutation()
  RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF TG_OP IN ('UPDATE', 'DELETE', 'TRUNCATE') THEN
      RAISE EXCEPTION '% is append-only: % is forbidden', TG_TABLE_NAME, TG_OP
        USING ERRCODE = '55000';
    END IF;
    RETURN NULL;
  END;
  $$;
  `,
  `
  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgname = 'model_budget_operator_alert_delivery_append_only'
        AND tgrelid = 'model_budget_operator_alert_delivery_events'::regclass
        AND NOT tgisinternal
    ) THEN
      CREATE TRIGGER model_budget_operator_alert_delivery_append_only
      BEFORE UPDATE OR DELETE ON model_budget_operator_alert_delivery_events
      FOR EACH ROW EXECUTE FUNCTION reject_model_budget_operator_alert_delivery_mutation();
    END IF;
  END;
  $$;
  `,
  `
  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgname = 'model_budget_operator_alert_delivery_no_truncate'
        AND tgrelid = 'model_budget_operator_alert_delivery_events'::regclass
        AND NOT tgisinternal
    ) THEN
      CREATE TRIGGER model_budget_operator_alert_delivery_no_truncate
      BEFORE TRUNCATE ON model_budget_operator_alert_delivery_events
      FOR EACH STATEMENT EXECUTE FUNCTION reject_model_budget_operator_alert_delivery_mutation();
    END IF;
  END;
  $$;
  `,
];
