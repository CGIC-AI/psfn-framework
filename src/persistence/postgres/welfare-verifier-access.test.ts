import { describe, expect, it, vi } from 'vitest';
import type { QueryResult, QueryResultRow } from 'pg';
import {
  grantWelfareVerifierReadAccessToTenantSchema,
  provisionWelfareVerifierLoginRole,
  type PostgresWelfareVerifierClient,
} from './welfare-verifier-access.js';

/**
 * Recording client: captures every rendered DDL/grant statement and serves
 * canned catalog responses in order so the provisioning helpers run to
 * completion without a live Postgres.
 */
function recordingClient(
  responses: Array<{ rows: QueryResultRow[] }>,
): PostgresWelfareVerifierClient & { calls: Array<{ sql: string; values?: readonly unknown[] }> } {
  const calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
  let cursor = 0;
  return {
    calls,
    async query<T extends QueryResultRow = QueryResultRow>(
      sql: string,
      values?: readonly unknown[],
    ): Promise<QueryResult<T>> {
      calls.push({ sql, values });
      const canned = responses[Math.min(cursor, responses.length - 1)];
      cursor += 1;
      return { rows: canned.rows as T[] } as QueryResult<T>;
    },
  };
}

describe('provisionWelfareVerifierLoginRole (dedicated gateway welfare verifier)', () => {
  it('creates the LOGIN role with exact least-privilege attributes when absent', async () => {
    const client = recordingClient([
      { rows: [{ exists: false }] },
      { rows: [{ stmt: "CREATE ROLE \"psfn_welfare_verifier\" LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 8 PASSWORD 'pw'" }] },
      { rows: [] as QueryResultRow[] },
    ]);
    const evidence = await provisionWelfareVerifierLoginRole(client, {
      role: 'psfn_welfare_verifier',
      password: 'pw',
    });
    expect(evidence).toEqual({ role: 'psfn_welfare_verifier', created: true });

    // The existence probe is parameterized; the DDL is rendered server-side.
    expect(client.calls[0]).toMatchObject({
      sql: 'SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists',
      values: ['psfn_welfare_verifier'],
    });
    expect(client.calls[1]).toMatchObject({
      sql: expect.stringContaining('SELECT format('),
      values: ['CREATE ROLE', 'psfn_welfare_verifier', 'pw'],
    });
    const ddl = client.calls[1]!.values![1];
    expect(client.calls[1]!.sql).toContain('%s %I');
    // The executed DDL carries every least-privilege attribute.
    expect(client.calls[2]!.sql).toContain('CREATE ROLE "psfn_welfare_verifier"');
    expect(client.calls[2]!.sql).toContain('LOGIN');
    expect(client.calls[2]!.sql).toContain('NOINHERIT');
    expect(client.calls[2]!.sql).toContain('NOSUPERUSER');
    expect(client.calls[2]!.sql).toContain('NOCREATEDB');
    expect(client.calls[2]!.sql).toContain('NOCREATEROLE');
    expect(client.calls[2]!.sql).toContain('NOREPLICATION');
    expect(client.calls[2]!.sql).toContain('NOBYPASSRLS');
    expect(client.calls[2]!.sql).toContain('CONNECTION LIMIT 8');
    expect(client.calls[2]!.sql).toContain("PASSWORD 'pw'");
    // No CREATE/ownership/membership clauses leak in.
    expect(client.calls[2]!.sql).not.toMatch(/CREATE ON SCHEMA|OWNER TO|IN ROLE|MEMBER/u);
    void ddl;
  });

  it('converges an existing role to the same posture via ALTER ROLE (idempotent)', async () => {
    const client = recordingClient([
      { rows: [{ exists: true }] },
      { rows: [{ stmt: "ALTER ROLE \"psfn_welfare_verifier\" LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 8 PASSWORD 'rotated'" }] },
      { rows: [] as QueryResultRow[] },
    ]);
    const evidence = await provisionWelfareVerifierLoginRole(client, {
      role: 'psfn_welfare_verifier',
      password: 'rotated',
    });
    expect(evidence.created).toBe(false);
    expect(client.calls[1]!.values).toEqual(['ALTER ROLE', 'psfn_welfare_verifier', 'rotated']);
    expect(client.calls[2]!.sql).toContain('ALTER ROLE "psfn_welfare_verifier"');
    expect(client.calls[2]!.sql).toContain("PASSWORD 'rotated'");
  });

  it('rejects an empty password and an unsafe role name before any SQL', async () => {
    const client = recordingClient([{ rows: [] as QueryResultRow[] }]);
    await expect(provisionWelfareVerifierLoginRole(client, {
      role: 'psfn_welfare_verifier',
      password: '',
    })).rejects.toThrow(/non-empty string/);
    await expect(provisionWelfareVerifierLoginRole(client, {
      role: 'Not Safe',
      password: 'pw',
    })).rejects.toThrow(/Invalid PostgreSQL role name/);
    // No SQL was issued for the rejected cases beyond what the first call
    // already consumed — the role-name guard throws before the probe.
    expect(client.calls).toHaveLength(0);
  });

  it('passes the role name and password to format() only through parameters, never interpolated', async () => {
    const client = recordingClient([
      { rows: [{ exists: false }] },
      { rows: [{ stmt: 'rendered' }] },
      { rows: [] as QueryResultRow[] },
    ]);
    await provisionWelfareVerifierLoginRole(client, {
      role: 'psfn_welfare_verifier',
      // A password containing SQL metacharacters must never reach the format
      // string itself; it arrives only as a bound parameter.
      password: "'); DROP ROLE x; --",
    });
    expect(client.calls[1]!.values![2]).toBe("'); DROP ROLE x; --");
    expect(client.calls[1]!.sql).not.toContain('DROP ROLE');
  });
});

describe('grantWelfareVerifierReadAccessToTenantSchema', () => {
  it('grants USAGE plus SELECT on the verifier relation only, idempotently', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('GRANT USAGE')) return { rows: [] };
      if (sql.includes('to_regclass')) return { rows: [{ relation: 'agent_background_work_jobs' }] };
      if (sql.includes('GRANT SELECT')) return { rows: [] };
      throw new Error(`unexpected SQL: ${sql}`);
    });
    const evidence = await grantWelfareVerifierReadAccessToTenantSchema(
      { query } as unknown as PostgresWelfareVerifierClient,
      { schema: 'companion_primary', verifierRole: 'psfn_welfare_verifier' },
    );
    expect(evidence).toEqual({
      schema: 'companion_primary',
      verifierRole: 'psfn_welfare_verifier',
      relationGranted: true,
    });
    const grantedSql = query.mock.calls.map(call => call[0] as string);
    expect(grantedSql).toEqual([
      'GRANT USAGE ON SCHEMA "companion_primary" TO "psfn_welfare_verifier"',
      "SELECT to_regclass('companion_primary.agent_background_work_jobs')::text AS relation",
      'GRANT SELECT ON "companion_primary".agent_background_work_jobs TO "psfn_welfare_verifier"',
    ]);
    // No write/create/ownership clauses.
    for (const sql of grantedSql) {
      expect(sql).not.toMatch(/INSERT|UPDATE|DELETE|TRUNCATE|CREATE|OWNER|REFERENCES|TRIGGER/u);
    }
  });

  it('reports relationGranted=false and skips the table grant when the table is absent', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('GRANT USAGE')) return { rows: [] };
      if (sql.includes('to_regclass')) return { rows: [{ relation: null }] };
      throw new Error(`unexpected SQL: ${sql}`);
    });
    const evidence = await grantWelfareVerifierReadAccessToTenantSchema(
      { query } as unknown as PostgresWelfareVerifierClient,
      { schema: 'companion_follower', verifierRole: 'psfn_welfare_verifier' },
    );
    expect(evidence.relationGranted).toBe(false);
    expect(query.mock.calls.some(call => (call[0] as string).includes('GRANT SELECT'))).toBe(false);
  });
});
