import { describe, expect, it } from 'vitest';
import type { QueryResult, QueryResultRow } from 'pg';
import { assertExactSchemaGrantees } from './fleet-auth-schema-access.js';
import {
  RETIRED_FLEET_WELFARE_VERIFIER_ROLE,
  type PostgresRetiredGranteeClient,
} from '../postgres/retired-fleet-grantees.js';

/**
 * A client whose ACL probe answers a scripted grantee set per call, so the
 * proof's cleanup-then-reprove sequence can be driven without a database.
 */
function scriptedClient(aclAnswers: readonly (readonly string[])[]): {
  client: PostgresRetiredGranteeClient;
  statements: string[];
} {
  const statements: string[] = [];
  let aclCall = 0;
  const client: PostgresRetiredGranteeClient = {
    async query<T extends QueryResultRow = QueryResultRow>(
      sql: string,
    ): Promise<QueryResult<T>> {
      statements.push(sql.trim());
      const empty = { command: 'SELECT', rowCount: 0, oid: 0, fields: [] };
      if (sql.includes('acl_grantees')) {
        const answer = aclAnswers[Math.min(aclCall, aclAnswers.length - 1)] ?? [];
        aclCall += 1;
        return {
          ...empty,
          rows: answer.map(role_name => ({ role_name })) as unknown as T[],
        };
      }
      if (sql.includes('pg_roles')) {
        return {
          ...empty,
          rows: [{ role_name: RETIRED_FLEET_WELFARE_VERIFIER_ROLE }] as unknown as T[],
        };
      }
      return { ...empty, rows: [] };
    },
  };
  return { client, statements };
}

const ALLOWED = ['companion_owner'] as const;

describe('exact schema grantee proof', () => {
  it('passes an exactly-granted schema without touching privileges', async () => {
    const { client, statements } = scriptedClient([[]]);
    await expect(assertExactSchemaGrantees(client, {
      schema: 'companion_default',
      allowedGrantees: ALLOWED,
    })).resolves.toBeUndefined();
    expect(statements.filter(sql => sql.startsWith('REVOKE'))).toEqual([]);
  });

  it('revokes the retired grantee and reproves rather than refusing the boot', async () => {
    // First probe sees the legacy grant; the reprove after the revoke is clean.
    const { client, statements } = scriptedClient([[RETIRED_FLEET_WELFARE_VERIFIER_ROLE], []]);
    await expect(assertExactSchemaGrantees(client, {
      schema: 'companion_default',
      allowedGrantees: ALLOWED,
    })).resolves.toBeUndefined();
    expect(statements.filter(sql => sql.startsWith('REVOKE'))).toHaveLength(4);
  });

  it('tolerates a retired grantee that survived the revoke', async () => {
    // A foreign grantor, or a process without owner authority: the revoke is a
    // no-op and the retired grantee is still there. Warn, do not refuse.
    const { client } = scriptedClient([[RETIRED_FLEET_WELFARE_VERIFIER_ROLE]]);
    await expect(assertExactSchemaGrantees(client, {
      schema: 'companion_default',
      allowedGrantees: ALLOWED,
    })).resolves.toBeUndefined();
  });

  it('refuses every other unexpected grantee, cleanup or not', async () => {
    const { client: stray } = scriptedClient([['psfn_stray_reader']]);
    await expect(assertExactSchemaGrantees(stray, {
      schema: 'companion_default',
      allowedGrantees: ALLOWED,
    })).rejects.toThrow(/unexpected PostgreSQL grantees: psfn_stray_reader/);

    // PUBLIC is never on the closed allowlist.
    const { client: publicGrant } = scriptedClient([['PUBLIC']]);
    await expect(assertExactSchemaGrantees(publicGrant, {
      schema: 'companion_default',
      allowedGrantees: ALLOWED,
    })).rejects.toThrow(/unexpected PostgreSQL grantees: PUBLIC/);

    // A retired grantee alongside a stray one still refuses on the stray.
    const { client: mixed } = scriptedClient([
      [RETIRED_FLEET_WELFARE_VERIFIER_ROLE, 'psfn_stray_reader'],
      ['psfn_stray_reader'],
    ]);
    await expect(assertExactSchemaGrantees(mixed, {
      schema: 'companion_default',
      allowedGrantees: ALLOWED,
    })).rejects.toThrow(/unexpected PostgreSQL grantees: psfn_stray_reader/);
  });
});
