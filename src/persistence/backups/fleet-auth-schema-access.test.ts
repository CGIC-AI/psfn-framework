import { describe, expect, it, vi } from 'vitest';
import type { QueryResult, QueryResultRow } from 'pg';
import {
  applyFleetAuthSchemaAccessContracts,
  assertExactSchemaGrantees,
  buildFleetAuthSchemaAccessStatements,
} from './fleet-auth-schema-access.js';
import { createPostgresPool } from '../postgres.js';
import {
  RETIRED_FLEET_WELFARE_VERIFIER_ROLE,
  type PostgresRetiredGranteeClient,
} from '../postgres/retired-fleet-grantees.js';

vi.mock('../postgres.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../postgres.js')>(),
  createPostgresPool: vi.fn(() => {
    throw new Error('schema access tests must not open a PostgreSQL pool');
  }),
}));

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

describe('fleet-auth schema access restore SQL', () => {
  const MAPPED = ['companion_alpha_runtime', 'companion_beta_runtime'];

  it('keeps the exact companion least-privilege statements, canonically quoted', () => {
    expect(buildFleetAuthSchemaAccessStatements({
      kind: 'companion',
      schema: 'companion_alpha',
      runtimeRoles: ['companion_alpha_runtime'],
    }, MAPPED)).toEqual([
      'REVOKE ALL ON SCHEMA "companion_alpha" FROM PUBLIC',
      'REVOKE ALL ON ALL TABLES IN SCHEMA "companion_alpha" FROM PUBLIC',
      'REVOKE ALL ON ALL SEQUENCES IN SCHEMA "companion_alpha" FROM PUBLIC',
      'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA "companion_alpha" FROM PUBLIC',
      'REVOKE ALL ON ALL TABLES IN SCHEMA "companion_alpha" FROM "companion_alpha_runtime", "companion_beta_runtime"',
      'REVOKE ALL ON ALL SEQUENCES IN SCHEMA "companion_alpha" FROM "companion_alpha_runtime", "companion_beta_runtime"',
      'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA "companion_alpha" FROM "companion_alpha_runtime", "companion_beta_runtime"',
      'REVOKE ALL ON SCHEMA "companion_alpha" FROM "companion_alpha_runtime", "companion_beta_runtime"',
      'GRANT USAGE, CREATE ON SCHEMA "companion_alpha" TO "companion_alpha_runtime"',
      'GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA "companion_alpha" TO "companion_alpha_runtime"',
      'GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA "companion_alpha" TO "companion_alpha_runtime"',
      'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA "companion_alpha" TO "companion_alpha_runtime"',
    ]);
  });

  it('keeps the shared schema read/write grant and the migration-ledger revoke', () => {
    const statements = buildFleetAuthSchemaAccessStatements({
      kind: 'shared',
      schema: 'shared',
      runtimeRoles: MAPPED,
    }, MAPPED);
    expect(statements.slice(8)).toEqual([
      'GRANT USAGE ON SCHEMA "shared" TO "companion_alpha_runtime", "companion_beta_runtime"',
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "shared" TO "companion_alpha_runtime", "companion_beta_runtime"',
      'REVOKE INSERT, UPDATE, DELETE ON "shared".shared_schema_migrations FROM "companion_alpha_runtime", "companion_beta_runtime"',
      'GRANT SELECT, USAGE, UPDATE ON ALL SEQUENCES IN SCHEMA "shared" TO "companion_alpha_runtime", "companion_beta_runtime"',
      'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA "shared" TO "companion_alpha_runtime", "companion_beta_runtime"',
    ]);
  });

  it.each([
    ['a quote-breaking schema', { schema: 'companion"; DROP SCHEMA shared; --', runtimeRoles: ['companion_alpha_runtime'] }, MAPPED],
    ['an uppercase schema', { schema: 'Companion_Alpha', runtimeRoles: ['companion_alpha_runtime'] }, MAPPED],
    ['a quote-breaking runtime role', { schema: 'companion_alpha', runtimeRoles: ['runtime" WITH SUPERUSER --'] }, MAPPED],
    ['the PUBLIC pseudo-role', { schema: 'companion_alpha', runtimeRoles: ['public'] }, MAPPED],
    ['an unsafe mapped role', { schema: 'companion_alpha', runtimeRoles: ['companion_alpha_runtime'] }, ['bad role']],
  ])('rejects %s', (_label, contract, mapped) => {
    expect(() => buildFleetAuthSchemaAccessStatements({ kind: 'companion', ...contract }, mapped))
      .toThrow(/Invalid (PostgreSQL role|Postgres schema) name/);
  });

  it('rejects an unsafe identifier before opening any connection', async () => {
    await expect(applyFleetAuthSchemaAccessContracts({
      contracts: [{
        kind: 'companion',
        schema: 'companion_alpha',
        ownerRole: 'companion_alpha_owner',
        runtimeRoles: ['runtime" WITH SUPERUSER --'],
      }],
      ownerDatabaseUrls: { companion_alpha: 'postgresql://owner:secret@db.invalid:5432/psfn' },
    })).rejects.toThrow('Invalid PostgreSQL role name');
    expect(createPostgresPool).not.toHaveBeenCalled();
  });
});
