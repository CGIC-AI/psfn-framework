import { describe, expect, it } from 'vitest';

import {
  AUTOMATA_BUS_POSTGRES_READINESS,
  AUTOMATA_BUS_POSTGRES_RELATIONS,
  AUTOMATA_BUS_POSTGRES_ROLLBACK_STATEMENTS,
  AUTOMATA_BUS_POSTGRES_SCHEMA_STATEMENTS,
  buildAutomataBusAnnIndexStatement,
} from './postgres-schema.js';

describe('Automata Bus Postgres schema contract', () => {
  it('exports the complete migration, readiness, and rollback requirements', () => {
    expect(AUTOMATA_BUS_POSTGRES_RELATIONS).toEqual([
      'automata_bus_events',
      'automata_bus_current_findings',
      'automata_bus_finding_vectors',
      'automata_bus_vector_state',
      'automata_bus_vector_lag',
    ]);
    const migration = AUTOMATA_BUS_POSTGRES_SCHEMA_STATEMENTS.join('\n');
    expect(migration).toContain('PRIMARY KEY (companion_id, event_id)');
    expect(migration).toContain('UNIQUE (companion_id, sequence)');
    expect(migration).toContain("CHECK (sensitivity IN ('public', 'personal', 'intimate', 'confidential'))");
    expect(migration).toContain("audiences <@ ARRAY['eligible-automata', 'operator']::text[]");
    expect(migration).toContain('REFERENCES automata_bus_events (companion_id, event_id)');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS automata_bus_finding_vectors');
    expect(migration).toContain('vector_dims(embedding) = dimensions');
    expect(migration).toContain('ON DELETE CASCADE');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS automata_bus_vector_state');
    expect(migration).toContain("reindex_state IN ('current', 'required', 'running')");
    expect(migration).toContain('reindex_lease_token UUID');
    expect(migration).toContain('reindex_lease_until TIMESTAMPTZ');
    expect(migration).toContain('reindex_snapshot_sequence BIGINT');
    expect(migration).toContain('reindex_snapshot_mutation_fence BIGINT');
    expect(migration).toContain('mutation_fence BIGINT NOT NULL DEFAULT 0');
    expect(migration).toContain('automata_bus_vector_reindex_lease_check');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS automata_bus_vector_lag');
    expect(AUTOMATA_BUS_POSTGRES_READINESS.requiredRelations).toEqual(
      AUTOMATA_BUS_POSTGRES_RELATIONS,
    );
    expect(AUTOMATA_BUS_POSTGRES_READINESS.optionalAnnIndexPrefix)
      .toBe('automata_bus_finding_vectors_hnsw_');
    expect(buildAutomataBusAnnIndexStatement(384, { concurrent: true })).toContain(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS automata_bus_finding_vectors_hnsw_384',
    );
    expect(buildAutomataBusAnnIndexStatement(384, { concurrent: true })).toContain(
      '(embedding::vector(384)) vector_cosine_ops',
    );
    expect(AUTOMATA_BUS_POSTGRES_ROLLBACK_STATEMENTS).toEqual([
      'DROP TABLE IF EXISTS automata_bus_vector_lag',
      'DROP TABLE IF EXISTS automata_bus_finding_vectors',
      'DROP TABLE IF EXISTS automata_bus_vector_state',
      'DROP TABLE IF EXISTS automata_bus_current_findings',
      'DROP TABLE IF EXISTS automata_bus_events',
      'DROP FUNCTION IF EXISTS reject_automata_bus_event_mutation()',
    ]);
  });
});
