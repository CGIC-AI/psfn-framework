import { POSTGRES_VECTOR_EXTENSION_MIGRATION } from './vector-extension-migration.js';
import {
  AUTOMATA_BUS_POSTGRES_ROLLBACK_STATEMENTS,
  AUTOMATA_BUS_POSTGRES_SCHEMA_STATEMENTS,
} from '../../faculties/automata/bus/postgres-schema.js';
import {
  AUTOMATA_RETENTION_POSTGRES_ROLLBACK_STATEMENTS,
  AUTOMATA_RETENTION_POSTGRES_SCHEMA_STATEMENTS,
} from '../../faculties/automata/retention-postgres-schema.js';
import {
  AUTOMATA_EXACT_SESSION_PURGE_POSTGRES_ROLLBACK_STATEMENTS,
  AUTOMATA_EXACT_SESSION_PURGE_POSTGRES_SCHEMA_STATEMENTS,
} from './automata-exact-session-purge-store.js';

/** Companion-private durable class/run/session discovery for ephemeral workers. */
export const POSTGRES_AUTOMATA_RUN_MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE IF NOT EXISTS automata_runs (
    companion_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    automaton_class TEXT NOT NULL,
    worker_id TEXT NOT NULL,
    worker_generation INTEGER NOT NULL,
    task_id TEXT NOT NULL,
    task_label TEXT NOT NULL,
    task_summary TEXT NOT NULL,
    parent_run_id TEXT,
    source_run_id TEXT,
    session_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    artifacts_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    status TEXT NOT NULL,
    status_reason TEXT NOT NULL,
    outcome TEXT,
    failure_reason TEXT,
    promotion_state TEXT NOT NULL DEFAULT 'not_requested',
    fold_state TEXT NOT NULL DEFAULT 'not_required',
    created_at_ms BIGINT NOT NULL,
    started_at_ms BIGINT,
    finished_at_ms BIGINT,
    retention_deadline_ms BIGINT NOT NULL,
    PRIMARY KEY (companion_id, run_id),
    CHECK (worker_generation >= 1),
    CHECK (jsonb_typeof(session_ids_json) = 'array'),
    CHECK (jsonb_typeof(artifacts_json) = 'array'),
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
    CHECK (outcome IS NULL OR outcome IN ('completed', 'blocked', 'cancelled', 'budget_limited')),
    CHECK (promotion_state IN ('not_requested', 'pending', 'promoted', 'rejected')),
    CHECK (fold_state IN ('not_required', 'pending', 'folded', 'rejected')),
    CHECK (retention_deadline_ms > created_at_ms),
    CHECK ((status IN ('queued', 'running') AND finished_at_ms IS NULL) OR status IN ('completed', 'failed', 'cancelled'))
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_automata_runs_companion_status_created
    ON automata_runs(companion_id, status, created_at_ms DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_automata_runs_companion_task_created
    ON automata_runs(companion_id, task_id, created_at_ms DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_automata_runs_companion_class_created
    ON automata_runs(companion_id, automaton_class, created_at_ms DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_automata_runs_retention
    ON automata_runs(companion_id, retention_deadline_ms);`,
];

/** One ordered migration head for the run authority and its append-only Bus. */
export const POSTGRES_AUTOMATA_MIGRATIONS: readonly string[] = [
  // The Bus vector relation is part of this independently executable migration
  // head (PostgresAutomataRunStore.connect runs it without memory migrations).
  // Install or validate pgvector before any VECTOR-typed Bus DDL is parsed.
  POSTGRES_VECTOR_EXTENSION_MIGRATION,
  ...POSTGRES_AUTOMATA_RUN_MIGRATIONS,
  ...AUTOMATA_BUS_POSTGRES_SCHEMA_STATEMENTS,
  ...AUTOMATA_RETENTION_POSTGRES_SCHEMA_STATEMENTS,
  ...AUTOMATA_EXACT_SESSION_PURGE_POSTGRES_SCHEMA_STATEMENTS,
];

/** Roll back only the dependent Bus slice, preserving the run authority. */
export const POSTGRES_AUTOMATA_ROLLBACK_MIGRATIONS: readonly string[] = [
  ...AUTOMATA_EXACT_SESSION_PURGE_POSTGRES_ROLLBACK_STATEMENTS,
  ...AUTOMATA_RETENTION_POSTGRES_ROLLBACK_STATEMENTS,
  ...AUTOMATA_BUS_POSTGRES_ROLLBACK_STATEMENTS,
];
