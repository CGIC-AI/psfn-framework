import { describe, expect, it } from 'vitest';
import type { QueryResult, QueryResultRow } from 'pg';
import {
  RETIRED_FLEET_SCHEMA_GRANTEES,
  RETIRED_FLEET_WELFARE_VERIFIER_ROLE,
  partitionRetiredGrantees,
  revokeRetiredFleetGranteesFromSchema,
  type PostgresRetiredGranteeClient,
} from './retired-fleet-grantees.js';

function recordingClient(existingRoles: readonly string[]): {
  client: PostgresRetiredGranteeClient;
  statements: string[];
} {
  const statements: string[] = [];
  const client: PostgresRetiredGranteeClient = {
    async query<T extends QueryResultRow = QueryResultRow>(
      sql: string,
      values?: readonly unknown[],
    ): Promise<QueryResult<T>> {
      statements.push(sql.trim());
      if (sql.includes('pg_roles')) {
        const requested = (values?.[0] ?? []) as string[];
        return {
          rows: requested
            .filter(role => existingRoles.includes(role))
            .map(role => ({ role_name: role })) as unknown as T[],
          command: 'SELECT',
          rowCount: 0,
          oid: 0,
          fields: [],
        };
      }
      return { rows: [], command: 'REVOKE', rowCount: 0, oid: 0, fields: [] };
    },
  };
  return { client, statements };
}

describe('retired fleet grantees', () => {
  it('names exactly the retired welfare verifier role', () => {
    expect(RETIRED_FLEET_SCHEMA_GRANTEES).toEqual([RETIRED_FLEET_WELFARE_VERIFIER_ROLE]);
    expect(RETIRED_FLEET_WELFARE_VERIFIER_ROLE).toBe('psfn_welfare_verifier');
  });

  it('tolerates only the retired grantee and fails every other grantee closed', () => {
    // The retired role is the single tolerated name; PUBLIC, a stray reader, and
    // a look-alike are all unexpected and must keep failing closed.
    expect(partitionRetiredGrantees([
      'PUBLIC',
      RETIRED_FLEET_WELFARE_VERIFIER_ROLE,
      'psfn_stray_reader',
      'psfn_welfare_verifier_2',
    ])).toEqual({
      retired: [RETIRED_FLEET_WELFARE_VERIFIER_ROLE],
      unexpected: ['PUBLIC', 'psfn_stray_reader', 'psfn_welfare_verifier_2'],
    });

    // A clean schema partitions to nothing at all.
    expect(partitionRetiredGrantees([])).toEqual({ retired: [], unexpected: [] });

    // An empty allowlist tolerates nothing.
    expect(partitionRetiredGrantees([RETIRED_FLEET_WELFARE_VERIFIER_ROLE], []))
      .toEqual({ retired: [], unexpected: [RETIRED_FLEET_WELFARE_VERIFIER_ROLE] });
  });

  it('revokes every retired grantee privilege class on the schema', async () => {
    const { client, statements } = recordingClient([RETIRED_FLEET_WELFARE_VERIFIER_ROLE]);
    await expect(revokeRetiredFleetGranteesFromSchema(client, { schema: 'companion_default' }))
      .resolves.toEqual([RETIRED_FLEET_WELFARE_VERIFIER_ROLE]);
    expect(statements.slice(1)).toEqual([
      'REVOKE ALL ON ALL TABLES IN SCHEMA "companion_default" FROM "psfn_welfare_verifier"',
      'REVOKE ALL ON ALL SEQUENCES IN SCHEMA "companion_default" FROM "psfn_welfare_verifier"',
      'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA "companion_default" FROM "psfn_welfare_verifier"',
      'REVOKE ALL ON SCHEMA "companion_default" FROM "psfn_welfare_verifier"',
    ]);
  });

  it('issues no privilege change when the retired role no longer exists', async () => {
    const { client, statements } = recordingClient([]);
    await expect(revokeRetiredFleetGranteesFromSchema(client, { schema: 'companion_default' }))
      .resolves.toEqual([]);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('pg_roles');
  });

  it('refuses an unsafe schema or grantee name', async () => {
    const { client } = recordingClient([RETIRED_FLEET_WELFARE_VERIFIER_ROLE]);
    await expect(revokeRetiredFleetGranteesFromSchema(client, { schema: 'public"; DROP' }))
      .rejects.toThrow();
    await expect(revokeRetiredFleetGranteesFromSchema(client, {
      schema: 'companion_default',
      retiredGrantees: ['psfn welfare verifier'],
    })).rejects.toThrow();
  });

  it('refuses a role probe that answers outside the closed allowlist', async () => {
    const { client } = recordingClient([]);
    const smuggling: PostgresRetiredGranteeClient = {
      async query<T extends QueryResultRow = QueryResultRow>(
        sql: string,
        values?: readonly unknown[],
      ): Promise<QueryResult<T>> {
        if (sql.includes('pg_roles')) {
          return {
            rows: [{ role_name: 'psfn_stray_reader' }] as unknown as T[],
            command: 'SELECT',
            rowCount: 1,
            oid: 0,
            fields: [],
          };
        }
        return client.query<T>(sql, values);
      },
    };
    await expect(revokeRetiredFleetGranteesFromSchema(smuggling, { schema: 'companion_default' }))
      .rejects.toThrow(/outside the closed allowlist/);
  });
});
