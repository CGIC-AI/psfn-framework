import { describe, expect, it } from 'vitest';

import {
  AUTOMATA_BUS_POSTGRES_RELATIONS,
  AUTOMATA_BUS_POSTGRES_ROLLBACK_STATEMENTS,
  AUTOMATA_BUS_POSTGRES_SCHEMA_STATEMENTS,
} from './postgres-schema.js';

describe('Automata Bus Postgres schema contract', () => {
  it('exports the complete migration, readiness, and rollback requirements', () => {
    expect(AUTOMATA_BUS_POSTGRES_RELATIONS).toEqual([
      'automata_bus_events',
      'automata_bus_current_findings',
    ]);
    const migration = AUTOMATA_BUS_POSTGRES_SCHEMA_STATEMENTS.join('\n');
    expect(migration).toContain('PRIMARY KEY (companion_id, event_id)');
    expect(migration).toContain('UNIQUE (companion_id, sequence)');
    expect(migration).toContain("CHECK (sensitivity IN ('public', 'personal', 'intimate', 'confidential'))");
    expect(migration).toContain("audiences <@ ARRAY['eligible-automata', 'operator']::text[]");
    expect(migration).toContain('REFERENCES automata_bus_events (companion_id, event_id)');
    expect(AUTOMATA_BUS_POSTGRES_ROLLBACK_STATEMENTS).toEqual([
      'DROP TABLE IF EXISTS automata_bus_current_findings',
      'DROP TABLE IF EXISTS automata_bus_events',
    ]);
  });
});
