/**
 * Bounded runtime health-event stream (bead psfn-framework-7qeo1.24.1).
 *
 * One append-only ring of content-free `HealthEvent` envelopes, capped by the
 * settings.json-owned `healthEventStreamMaxRows` so it survives a restart
 * without growing without bound. The columns a detector filters and joins on
 * (correlation, causation, code, severity, component, subject digest, time)
 * are first-class; the bounded structured evidence rides as a small JSONB map.
 *
 * The CHECK constraints are deliberately STRUCTURAL only. The closed
 * vocabularies for `code`, `severity`, `process`, and `component` live in
 * `shared/contracts/health-event.ts` and are enforced by `validateHealthEvent`
 * on both the write and the read path: pinning them into DDL would silently
 * drift the day a detector child adds a code, because `CREATE TABLE IF NOT
 * EXISTS` never updates an existing constraint.
 */
export const RUNTIME_HEALTH_EVENT_TABLE_STATEMENTS: readonly string[] = [
  `
  CREATE TABLE IF NOT EXISTS runtime_health_events (
    event_id UUID PRIMARY KEY,
    schema_version INTEGER NOT NULL,
    correlation_id UUID NOT NULL,
    causation_id UUID,
    owner_kind TEXT NOT NULL,
    owner_companion_id TEXT,
    severity TEXT NOT NULL,
    code TEXT NOT NULL,
    process TEXT NOT NULL,
    component TEXT NOT NULL,
    observer_id UUID NOT NULL,
    subject_hash TEXT,
    occurrence_count INTEGER NOT NULL,
    first_observed_at_ms BIGINT NOT NULL,
    last_observed_at_ms BIGINT NOT NULL,
    recorded_at_ms BIGINT NOT NULL,
    evidence_json JSONB NOT NULL,
    CHECK (owner_kind IN ('system', 'companion')),
    CHECK ((owner_kind = 'companion') = (owner_companion_id IS NOT NULL)),
    CHECK (occurrence_count >= 1),
    CHECK (first_observed_at_ms >= 0),
    CHECK (last_observed_at_ms >= first_observed_at_ms),
    CHECK (recorded_at_ms >= 0),
    CHECK (subject_hash IS NULL OR subject_hash ~ '^[0-9a-f]{64}$'),
    CHECK (jsonb_typeof(evidence_json) = 'object'),
    CHECK (octet_length(evidence_json::text) <= 4096)
  );
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_runtime_health_events_recorded
    ON runtime_health_events(recorded_at_ms DESC, event_id DESC);
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_runtime_health_events_correlation
    ON runtime_health_events(correlation_id, recorded_at_ms DESC, event_id DESC);
  `,
];

/**
 * Durable human escalation ledger (bead psfn-framework-bznbn).
 *
 * Two tables because two things are being remembered, and conflating them is
 * the bug this ledger exists to prevent:
 *
 *   * `human_escalations` holds one row per CONDITION a human was asked about,
 *     keyed by `(kind, dedupe_key)`. That row is what an operator resolves, and
 *     it is what survives a restart so a runtime does not re-ask about every
 *     open condition on boot.
 *   * `human_escalation_attempts` holds one row per DELIVERY ATTEMPT, keyed by
 *     the caller's idempotency key. That primary key is the whole idempotency
 *     guarantee: a redelivered notice collides and is never dispatched twice.
 *
 * Content-free by construction, enforced structurally rather than by review.
 * There is no message, detail, note, or error column: the rendered notification
 * is handed to a sink and never persisted. The narrative half of a human
 * decision (who, in their own words) lives in the Garden audit timeline, which
 * already carries actor identity under its own retention.
 *
 * As with the health-event stream, the CHECK constraints are STRUCTURAL only.
 * The closed vocabularies for kind, severity, state, reason, actor, sink, and
 * outcome live in `shared/escalation/contracts.ts` and are enforced on both the
 * write and the read path; pinning them into DDL would silently drift the day a
 * surface adopts the plane, because `CREATE TABLE IF NOT EXISTS` never updates
 * an existing constraint.
 */
export const HUMAN_ESCALATION_TABLE_STATEMENTS: readonly string[] = [
  `
  CREATE TABLE IF NOT EXISTS human_escalations (
    escalation_id UUID PRIMARY KEY,
    schema_version INTEGER NOT NULL,
    kind TEXT NOT NULL,
    severity TEXT NOT NULL,
    owner_kind TEXT NOT NULL,
    owner_companion_id TEXT,
    dedupe_key TEXT NOT NULL,
    source_ref TEXT NOT NULL,
    detail_path TEXT NOT NULL,
    labels_json JSONB NOT NULL,
    evidence_json JSONB NOT NULL,
    state TEXT NOT NULL,
    resolution_reason TEXT,
    resolved_by TEXT,
    resolved_at_ms BIGINT,
    raised_at_ms BIGINT NOT NULL,
    last_raised_at_ms BIGINT NOT NULL,
    last_notified_at_ms BIGINT,
    raise_count INTEGER NOT NULL,
    CHECK (owner_kind IN ('system', 'companion')),
    CHECK ((owner_kind = 'companion') = (owner_companion_id IS NOT NULL)),
    -- An escalation that left the queue always says why, and one that is still
    -- open never claims a reason it was never given.
    CHECK ((state = 'open') = (resolution_reason IS NULL)),
    CHECK ((resolution_reason IS NULL) = (resolved_at_ms IS NULL)),
    CHECK ((resolution_reason IS NULL) = (resolved_by IS NULL)),
    CHECK (raise_count >= 1),
    CHECK (raised_at_ms >= 0),
    CHECK (last_raised_at_ms >= raised_at_ms),
    CHECK (last_notified_at_ms IS NULL OR last_notified_at_ms >= 0),
    CHECK (resolved_at_ms IS NULL OR resolved_at_ms >= 0),
    CHECK (jsonb_typeof(labels_json) = 'array'),
    CHECK (jsonb_typeof(evidence_json) = 'object'),
    CHECK (octet_length(labels_json::text) <= 1024),
    CHECK (octet_length(evidence_json::text) <= 4096),
    CHECK (detail_path ~ '^/[a-z0-9/-]*$'),
    CHECK (length(dedupe_key) BETWEEN 1 AND 256),
    CHECK (length(source_ref) BETWEEN 1 AND 256)
  );
  `,
  `
  CREATE UNIQUE INDEX IF NOT EXISTS uq_human_escalations_condition
    ON human_escalations(kind, dedupe_key);
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_human_escalations_attention
    ON human_escalations(state, last_raised_at_ms DESC, escalation_id DESC);
  `,
  `
  CREATE TABLE IF NOT EXISTS human_escalation_attempts (
    idempotency_key TEXT PRIMARY KEY,
    escalation_id UUID NOT NULL
      REFERENCES human_escalations(escalation_id) ON DELETE CASCADE,
    sink TEXT NOT NULL,
    outcome TEXT NOT NULL,
    attempted_at_ms BIGINT NOT NULL,
    CHECK (length(idempotency_key) BETWEEN 1 AND 256),
    CHECK (attempted_at_ms >= 0)
  );
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_human_escalation_attempts_escalation
    ON human_escalation_attempts(escalation_id, attempted_at_ms DESC);
  `,
];

/**
 * The bounded health-event ring a per-companion runtime opens in its own
 * schema. Identical DDL to the shared-schema copy (shared migration version
 * 21), from one definition.
 */
export const POSTGRES_HEALTH_EVENT_MIGRATIONS: readonly string[] =
  RUNTIME_HEALTH_EVENT_TABLE_STATEMENTS;

/**
 * The durable human escalation ledger a per-companion runtime opens in its own
 * schema. Identical DDL to the shared-schema copy the fleet's system-owned
 * escalations live in (shared migration version 21) — one definition, so the
 * two can never drift into a projection that cannot be read back.
 */
export const POSTGRES_HUMAN_ESCALATION_MIGRATIONS: readonly string[] =
  HUMAN_ESCALATION_TABLE_STATEMENTS;
