import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { assertPostgresRelationColumns } from './relation-contract.js';

describe('assertPostgresRelationColumns', () => {
  it('proves relation and column metadata through pg_catalog without data-table access', async () => {
    const query = vi.fn(async () => ({
      rows: [{
        schema_name: 'tenant_a',
        relation_exists: true,
        missing_columns: [],
        missing_privileges: [],
      }],
    }));

    await assertPostgresRelationColumns({ query } as unknown as Pool, {
      schema: 'tenant_a',
      relation: 'events',
      columns: ['event_id', 'state'],
    });

    expect(query).toHaveBeenCalledOnce();
    const [sql, values] = query.mock.calls[0] ?? [];
    expect(sql).toContain('pg_catalog.pg_namespace');
    expect(sql).toContain('pg_catalog.pg_class');
    expect(sql).toContain('pg_catalog.pg_attribute');
    expect(sql).not.toContain('tenant_a.events');
    expect(values).toEqual(['tenant_a', 'events', ['event_id', 'state'], []]);
  });

  it('names a missing relation without probing it', async () => {
    const query = vi.fn(async () => ({
      rows: [{
        schema_name: 'tenant_a',
        relation_exists: false,
        missing_columns: ['event_id'],
        missing_privileges: [],
      }],
    }));

    await expect(assertPostgresRelationColumns({ query } as unknown as Pool, {
      schema: 'tenant_a',
      relation: 'events',
      columns: ['event_id'],
    })).rejects.toThrow('PostgreSQL relation tenant_a.events is missing');
  });

  it('names missing columns as a schema-version mismatch', async () => {
    const query = vi.fn(async () => ({
      rows: [{
        schema_name: 'tenant_a',
        relation_exists: true,
        missing_columns: ['state'],
        missing_privileges: [],
      }],
    }));

    await expect(assertPostgresRelationColumns({ query } as unknown as Pool, {
      schema: 'tenant_a',
      relation: 'events',
      columns: ['event_id', 'state'],
    })).rejects.toThrow(
      'PostgreSQL relation tenant_a.events is missing required columns: state',
    );
  });

  it('proves operational privileges through ACL metadata without reading the relation', async () => {
    const query = vi.fn(async () => ({
      rows: [{
        schema_name: 'tenant_a',
        relation_exists: true,
        missing_columns: [],
        missing_privileges: ['UPDATE'],
      }],
    }));

    await expect(assertPostgresRelationColumns({ query } as unknown as Pool, {
      schema: 'tenant_a',
      relation: 'events',
      columns: ['event_id'],
      privileges: ['SELECT', 'UPDATE'],
    })).rejects.toThrow(
      'PostgreSQL relation tenant_a.events is missing required role privileges: UPDATE',
    );
    const [sql] = query.mock.calls[0] ?? [];
    expect(sql).toContain('pg_catalog.has_table_privilege');
    expect(sql).not.toContain('tenant_a.events');
  });
});
