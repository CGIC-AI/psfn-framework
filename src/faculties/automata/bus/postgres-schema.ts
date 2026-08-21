export const AUTOMATA_BUS_POSTGRES_RELATIONS = [
  'automata_bus_events',
  'automata_bus_current_findings',
  'automata_bus_finding_vectors',
  'automata_bus_vector_state',
  'automata_bus_vector_lag',
] as const;

export const AUTOMATA_BUS_POSTGRES_READINESS = {
  requiredRelations: AUTOMATA_BUS_POSTGRES_RELATIONS,
  optionalAnnIndexPrefix: 'automata_bus_finding_vectors_hnsw_',
} as const;

/**
 * Migration-owned DDL for the immutable event ledger and its transactional
 * current-finding projection. The shared migration registry must execute these
 * statements in order; runtime code must only assert readiness.
 */
export const AUTOMATA_BUS_POSTGRES_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS automata_bus_events (
    companion_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    sequence BIGINT NOT NULL CHECK (sequence > 0),
    schema_version INTEGER NOT NULL CHECK (schema_version > 0),
    occurred_at TIMESTAMPTZ NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN ('finding', 'relation')),
    automaton_class TEXT NOT NULL,
    run_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    parent_run_id TEXT,
    audiences TEXT[] NOT NULL CHECK (
      cardinality(audiences) > 0
      AND audiences <@ ARRAY['eligible-automata', 'operator']::text[]
    ),
    sensitivity TEXT NOT NULL
      CHECK (sensitivity IN ('public', 'personal', 'intimate', 'confidential')),
    event_json JSONB NOT NULL CHECK (jsonb_typeof(event_json) = 'object'),
    inserted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (companion_id, event_id),
    UNIQUE (companion_id, sequence),
    CHECK (event_json ->> 'companionId' = companion_id),
    CHECK (event_json ->> 'eventId' = event_id),
    CHECK ((event_json ->> 'sequence')::bigint = sequence),
    CHECK ((event_json ->> 'schemaVersion')::integer = schema_version),
    CHECK (event_json ->> 'type' = event_type)
  )`,
  `CREATE INDEX IF NOT EXISTS automata_bus_events_run_sequence_idx
    ON automata_bus_events (companion_id, run_id, sequence)`,
  `CREATE INDEX IF NOT EXISTS automata_bus_events_task_sequence_idx
    ON automata_bus_events (companion_id, task_id, sequence)`,
  `CREATE OR REPLACE FUNCTION reject_automata_bus_event_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      RAISE EXCEPTION 'Automata Bus events are append-only' USING ERRCODE = '55000';
    END
    $$`,
  `DROP TRIGGER IF EXISTS automata_bus_events_append_only ON automata_bus_events`,
  `CREATE TRIGGER automata_bus_events_append_only
    BEFORE UPDATE OR DELETE ON automata_bus_events
    FOR EACH ROW EXECUTE FUNCTION reject_automata_bus_event_mutation()`,
  `DROP TRIGGER IF EXISTS automata_bus_events_no_truncate ON automata_bus_events`,
  `CREATE TRIGGER automata_bus_events_no_truncate
    BEFORE TRUNCATE ON automata_bus_events
    FOR EACH STATEMENT EXECUTE FUNCTION reject_automata_bus_event_mutation()`,
  `CREATE TABLE IF NOT EXISTS automata_bus_current_findings (
    companion_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    sequence BIGINT NOT NULL CHECK (sequence > 0),
    audiences TEXT[] NOT NULL CHECK (
      cardinality(audiences) > 0
      AND audiences <@ ARRAY['eligible-automata', 'operator']::text[]
    ),
    sensitivity TEXT NOT NULL
      CHECK (sensitivity IN ('public', 'personal', 'intimate', 'confidential')),
    event_json JSONB NOT NULL CHECK (jsonb_typeof(event_json) = 'object'),
    materialized_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (companion_id, event_id),
    UNIQUE (companion_id, sequence),
    FOREIGN KEY (companion_id, event_id)
      REFERENCES automata_bus_events (companion_id, event_id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CHECK (event_json ->> 'companionId' = companion_id),
    CHECK (event_json ->> 'eventId' = event_id),
    CHECK ((event_json ->> 'sequence')::bigint = sequence)
  )`,
  `CREATE INDEX IF NOT EXISTS automata_bus_current_findings_visibility_idx
    ON automata_bus_current_findings (companion_id, sensitivity, sequence)`,
  `CREATE TABLE IF NOT EXISTS automata_bus_vector_state (
    companion_id TEXT PRIMARY KEY,
    provider TEXT NOT NULL CHECK (length(btrim(provider)) > 0),
    model TEXT NOT NULL CHECK (length(btrim(model)) > 0),
    dimensions INTEGER NOT NULL CHECK (dimensions > 0),
    index_state TEXT NOT NULL
      CHECK (index_state IN ('building', 'degraded', 'ready', 'unavailable')),
    reindex_state TEXT NOT NULL
      CHECK (reindex_state IN ('current', 'required', 'running')),
    mutation_fence BIGINT NOT NULL DEFAULT 0 CHECK (mutation_fence >= 0),
    reindex_lease_token UUID,
    reindex_lease_until TIMESTAMPTZ,
    reindex_snapshot_sequence BIGINT,
    reindex_snapshot_mutation_fence BIGINT,
    CONSTRAINT automata_bus_vector_reindex_lease_check CHECK (
      (
        reindex_state = 'running'
        AND reindex_lease_token IS NOT NULL
        AND reindex_lease_until IS NOT NULL
        AND reindex_snapshot_sequence IS NOT NULL
        AND reindex_snapshot_mutation_fence IS NOT NULL
      )
      OR (
        reindex_state <> 'running'
        AND reindex_lease_token IS NULL
        AND reindex_lease_until IS NULL
        AND reindex_snapshot_sequence IS NULL
        AND reindex_snapshot_mutation_fence IS NULL
      )
    ),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `ALTER TABLE automata_bus_vector_state
    ADD COLUMN IF NOT EXISTS mutation_fence BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS reindex_lease_token UUID,
    ADD COLUMN IF NOT EXISTS reindex_lease_until TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS reindex_snapshot_sequence BIGINT,
    ADD COLUMN IF NOT EXISTS reindex_snapshot_mutation_fence BIGINT`,
  `UPDATE automata_bus_vector_state
    SET index_state = 'degraded', reindex_state = 'required'
    WHERE reindex_state = 'running'
      AND reindex_lease_token IS NULL`,
  `ALTER TABLE automata_bus_vector_state
    DROP CONSTRAINT IF EXISTS automata_bus_vector_reindex_lease_check`,
  `ALTER TABLE automata_bus_vector_state
    ADD CONSTRAINT automata_bus_vector_reindex_lease_check CHECK (
      mutation_fence >= 0
      AND (
        (
          reindex_state = 'running'
          AND reindex_lease_token IS NOT NULL
          AND reindex_lease_until IS NOT NULL
          AND reindex_snapshot_sequence IS NOT NULL
          AND reindex_snapshot_mutation_fence IS NOT NULL
        )
        OR (
          reindex_state <> 'running'
          AND reindex_lease_token IS NULL
          AND reindex_lease_until IS NULL
          AND reindex_snapshot_sequence IS NULL
          AND reindex_snapshot_mutation_fence IS NULL
        )
      )
    )`,
  `CREATE TABLE IF NOT EXISTS automata_bus_finding_vectors (
    companion_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    provider TEXT NOT NULL CHECK (length(btrim(provider)) > 0),
    model TEXT NOT NULL CHECK (length(btrim(model)) > 0),
    dimensions INTEGER NOT NULL CHECK (dimensions > 0),
    embedding vector NOT NULL,
    mutation_fence BIGINT NOT NULL DEFAULT 0 CHECK (mutation_fence >= 0),
    indexed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (companion_id, event_id),
    FOREIGN KEY (companion_id, event_id)
      REFERENCES automata_bus_current_findings (companion_id, event_id)
      ON UPDATE RESTRICT ON DELETE CASCADE,
    CHECK (vector_dims(embedding) = dimensions)
  )`,
  `ALTER TABLE automata_bus_finding_vectors
    ADD COLUMN IF NOT EXISTS mutation_fence BIGINT NOT NULL DEFAULT 0`,
  `ALTER TABLE automata_bus_finding_vectors
    DROP CONSTRAINT IF EXISTS automata_bus_finding_vectors_mutation_fence_check`,
  `ALTER TABLE automata_bus_finding_vectors
    ADD CONSTRAINT automata_bus_finding_vectors_mutation_fence_check
    CHECK (mutation_fence >= 0)`,
  `CREATE INDEX IF NOT EXISTS automata_bus_finding_vectors_identity_idx
    ON automata_bus_finding_vectors (companion_id, provider, model, dimensions)`,
  `CREATE TABLE IF NOT EXISTS automata_bus_vector_lag (
    companion_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    stage TEXT NOT NULL
      CHECK (stage IN ('embedding', 'index-state', 'model-identity', 'vector')),
    provider TEXT NOT NULL CHECK (length(btrim(provider)) > 0),
    model TEXT NOT NULL CHECK (length(btrim(model)) > 0),
    dimensions INTEGER NOT NULL CHECK (dimensions > 0),
    first_failed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_failed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts > 0),
    mutation_fence BIGINT NOT NULL DEFAULT 0 CHECK (mutation_fence >= 0),
    PRIMARY KEY (companion_id, event_id),
    FOREIGN KEY (companion_id, event_id)
      REFERENCES automata_bus_current_findings (companion_id, event_id)
      ON UPDATE RESTRICT ON DELETE CASCADE
  )`,
  `ALTER TABLE automata_bus_vector_lag
    ADD COLUMN IF NOT EXISTS mutation_fence BIGINT NOT NULL DEFAULT 0`,
  `ALTER TABLE automata_bus_vector_lag
    DROP CONSTRAINT IF EXISTS automata_bus_vector_lag_mutation_fence_check`,
  `ALTER TABLE automata_bus_vector_lag
    ADD CONSTRAINT automata_bus_vector_lag_mutation_fence_check
    CHECK (mutation_fence >= 0)`,
  `CREATE INDEX IF NOT EXISTS automata_bus_vector_lag_oldest_idx
    ON automata_bus_vector_lag (companion_id, first_failed_at)`,
] as const;

export const AUTOMATA_BUS_POSTGRES_ROLLBACK_STATEMENTS = [
  'DROP TABLE IF EXISTS automata_bus_vector_lag',
  'DROP TABLE IF EXISTS automata_bus_finding_vectors',
  'DROP TABLE IF EXISTS automata_bus_vector_state',
  'DROP TABLE IF EXISTS automata_bus_current_findings',
  'DROP TABLE IF EXISTS automata_bus_events',
  'DROP FUNCTION IF EXISTS reject_automata_bus_event_mutation()',
] as const;

function requireAnnDimensions(dimensions: number): number {
  if (!Number.isSafeInteger(dimensions) || dimensions <= 0) {
    throw new Error('Automata Bus ANN dimensions must be a positive safe integer');
  }
  return dimensions;
}

export function automataBusAnnIndexName(dimensions: number): string {
  return `${AUTOMATA_BUS_POSTGRES_READINESS.optionalAnnIndexPrefix}${requireAnnDimensions(dimensions)}`;
}

/** Runtime-dimension HNSW DDL; CONCURRENTLY callers must execute it outside a transaction. */
export function buildAutomataBusAnnIndexStatement(
  dimensions: number,
  options: { concurrent?: boolean } = {},
): string {
  const normalizedDimensions = requireAnnDimensions(dimensions);
  const concurrently = options.concurrent === true ? 'CONCURRENTLY ' : '';
  return `CREATE INDEX ${concurrently}IF NOT EXISTS ${automataBusAnnIndexName(normalizedDimensions)} `
    + 'ON automata_bus_finding_vectors USING hnsw '
    + `((embedding::vector(${normalizedDimensions})) vector_cosine_ops) `
    + `WHERE vector_dims(embedding) = ${normalizedDimensions};`;
}
