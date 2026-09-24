// ── Partner Affect shadow observations (docs/partner-affect.md slice 1) ──
//
// Shadow-only evidence store: accepted Signal Observations (summarized
// scalars + provenance handles only — raw sensitive content is rejected at
// the guard boundary and can never reach these tables) and structural
// suppression audit records. Idempotency key is (source_id, observation_id).
export const POSTGRES_PARTNER_AFFECT_SHADOW_MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE IF NOT EXISTS partner_affect_shadow_observations (
    observation_key TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL,
    observation_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    partner_contact_id TEXT NOT NULL,
    signal_family TEXT NOT NULL,
    metric_name TEXT NOT NULL,
    value DOUBLE PRECISION NOT NULL,
    unit TEXT NOT NULL,
    window_start_ms BIGINT NOT NULL,
    window_end_ms BIGINT NOT NULL,
    observed_at_ms BIGINT NOT NULL,
    coverage DOUBLE PRECISION NOT NULL,
    confidence DOUBLE PRECISION NOT NULL,
    missingness DOUBLE PRECISION NOT NULL,
    direction TEXT NOT NULL,
    sensitivity TEXT NOT NULL,
    consent_ref TEXT NOT NULL,
    assertion TEXT NOT NULL,
    provenance_json JSONB NOT NULL,
    processing_revision TEXT NOT NULL,
    received_at_ms BIGINT NOT NULL,
    UNIQUE (source_id, observation_id),
    CHECK (window_start_ms >= 0 AND window_end_ms >= window_start_ms),
    CHECK (coverage >= 0 AND coverage <= 1),
    CHECK (confidence >= 0 AND confidence <= 1),
    CHECK (missingness >= 0 AND missingness <= 1),
    CHECK (direction IN ('higher_supports_need', 'lower_supports_need', 'unknown')),
    CHECK (assertion IN ('partner_asserted', 'model_inferred', 'sensor_summary', 'unverified')),
    CHECK (jsonb_typeof(provenance_json) = 'array'),
    CHECK (provenance_json <> '[]'::jsonb),
    CHECK (octet_length(provenance_json::text) <= 16384)
  );
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_partner_affect_shadow_obs_partner_observed
    ON partner_affect_shadow_observations(partner_contact_id, observed_at_ms DESC, observation_key DESC);
  `,
  `
  CREATE TABLE IF NOT EXISTS partner_affect_shadow_suppressions (
    id TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL,
    observation_key TEXT,
    source_id TEXT,
    signal_family TEXT,
    partner_contact_id TEXT,
    reasons_json JSONB NOT NULL,
    detail TEXT NOT NULL,
    received_at_ms BIGINT NOT NULL,
    CHECK (jsonb_typeof(reasons_json) = 'array'),
    CHECK (reasons_json <> '[]'::jsonb),
    CHECK (octet_length(reasons_json::text) <= 4096),
    CHECK (octet_length(detail) <= 4096)
  );
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_partner_affect_shadow_suppressions_received
    ON partner_affect_shadow_suppressions(partner_contact_id, received_at_ms DESC, id DESC);
  `,
];
