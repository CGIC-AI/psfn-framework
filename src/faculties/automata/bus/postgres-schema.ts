export const AUTOMATA_BUS_POSTGRES_RELATIONS = [
  'automata_bus_events',
  'automata_bus_current_findings',
] as const;

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
] as const;

export const AUTOMATA_BUS_POSTGRES_ROLLBACK_STATEMENTS = [
  'DROP TABLE IF EXISTS automata_bus_current_findings',
  'DROP TABLE IF EXISTS automata_bus_events',
  'DROP FUNCTION IF EXISTS reject_automata_bus_event_mutation()',
] as const;
