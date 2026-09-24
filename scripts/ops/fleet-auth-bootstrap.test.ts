import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ensureAuthorityFloorRoot,
  planFleetAuthProvisioning,
  restoreVerifyDatabaseGrants,
  runtimeDatabaseGrants,
} from './lib/postgres-fleet-auth.mjs';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const repoRoot = join(import.meta.dirname, '../..');
const fleetAuthSeed = JSON.parse(readFileSync(join(repoRoot, 'config/fleet-auth.seed.json'), 'utf8')) as Record<string, unknown>;

function systemDataDir(fleetAuthOverrides: Record<string, unknown> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'psfn-fleet-auth-bootstrap-'));
  roots.push(root);
  writeFileSync(join(root, 'fleet-auth.json'), JSON.stringify({ ...fleetAuthSeed, ...fleetAuthOverrides }));
  writeFileSync(join(root, 'companions.json'), JSON.stringify({
    postgres: {
      sharedMigrationRole: 'shared_schema_migration',
      sharedMigrationDatabaseUrlRef: { kind: 'env', envName: 'SHARED_SCHEMA_MIGRATION_DATABASE_URL' },
    },
    companions: [{
      companionId: '11111111-1111-4111-8111-111111111111',
      postgresSchema: 'companion_main',
      postgresRole: 'companion_main_runtime',
    }],
  }));
  return root;
}

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    POSTGRES_ADMIN_DATABASE_URL: 'postgresql://postgres:admin-pw@127.0.0.1:19700/psfn',
    PSFN_FLEET_AUTH_DATABASE_CONNECTION_LIMIT: '20',
    FLEET_AUTH_RUNTIME_DATABASE_URL: 'postgresql://fleet_auth_runtime:runtime-pw@127.0.0.1:19700/psfn',
    FLEET_AUTH_MIGRATION_DATABASE_URL: 'postgresql://fleet_auth_migration:migration-pw@127.0.0.1:19700/psfn',
    FLEET_AUTH_BACKUP_DATABASE_URL: 'postgresql://fleet_auth_backup:backup-pw@127.0.0.1:19700/psfn',
    FLEET_AUTH_AUTHORITY_FLOOR_ROOT: '/srv/psfn/fleet-auth-floor',
    ...overrides,
  };
}

describe('planFleetAuthProvisioning', () => {
  it('resolves the fleet-auth roles, scratch database, and schema owners', () => {
    const plan = planFleetAuthProvisioning({ systemDataDir: systemDataDir(), env: env() });
    expect(plan.databaseName).toBe('psfn');
    expect(plan.restoreVerifyDatabaseName).toBe('psfn_restore_verify');
    expect(plan.loginRoles.map((entry: { role: string }) => entry.role)).toEqual([
      'fleet_auth_runtime', 'fleet_auth_migration', 'fleet_auth_backup',
    ]);
    expect(plan.schemaOwnerRoles).toEqual(['companion_main_runtime', 'shared_schema_migration']);
    expect(plan.authorityFloorRoot).toBe('/srv/psfn/fleet-auth-floor');
  });

  it('includes the welfare verifier with its own connection limit when declared', () => {
    const plan = planFleetAuthProvisioning({
      systemDataDir: systemDataDir({
        welfareVerifier: {
          role: 'psfn_welfare_verifier',
          connectionLimit: 8,
          databaseUrlRef: { kind: 'env', envName: 'FLEET_AUTH_WELFARE_VERIFIER_DATABASE_URL' },
        },
      }),
      env: env({
        FLEET_AUTH_WELFARE_VERIFIER_DATABASE_URL: 'postgresql://psfn_welfare_verifier:verifier-pw@127.0.0.1:19700/psfn',
      }),
    });
    expect(plan.loginRoles.at(-1)).toMatchObject({ role: 'psfn_welfare_verifier', connectionLimit: 8 });
  });

  it('names the remediation for each startup failure it front-runs', () => {
    expect(() => planFleetAuthProvisioning({
      systemDataDir: systemDataDir({ canonicalOrigin: 'http://127.0.0.1:10054' }),
      env: env(),
    })).toThrow(/canonicalOrigin must be an exact normalized https origin/);
    expect(() => planFleetAuthProvisioning({
      systemDataDir: systemDataDir({
        hubDeviceAssertions: { ...(fleetAuthSeed.hubDeviceAssertions as object), audience: 'https://psfn.local/' },
      }),
      env: env(),
    })).toThrow(/hubDeviceAssertions.audience must be an exact normalized https origin/);
    expect(() => planFleetAuthProvisioning({ systemDataDir: systemDataDir(), env: env({ FLEET_AUTH_BACKUP_DATABASE_URL: undefined }) }))
      .toThrow(/credentials.backupRestoreDatabaseUrlRef names FLEET_AUTH_BACKUP_DATABASE_URL, which is not set/);
    expect(() => planFleetAuthProvisioning({
      systemDataDir: systemDataDir(),
      env: env({ FLEET_AUTH_MIGRATION_DATABASE_URL: 'postgresql://postgres:pw@127.0.0.1:19700/psfn' }),
    })).toThrow(/must authenticate as fleet_auth_migration/);
    expect(() => planFleetAuthProvisioning({
      systemDataDir: systemDataDir(),
      env: env({ FLEET_AUTH_RUNTIME_DATABASE_URL: 'postgresql://fleet_auth_runtime:pw@127.0.0.1:19700/other' }),
    })).toThrow(/must share the runtime database/);
    expect(() => planFleetAuthProvisioning({ systemDataDir: systemDataDir(), env: env({ PSFN_FLEET_AUTH_DATABASE_CONNECTION_LIMIT: '0' }) }))
      .toThrow(/PSFN_FLEET_AUTH_DATABASE_CONNECTION_LIMIT must be an integer >= 1/);
    expect(() => planFleetAuthProvisioning({ systemDataDir: systemDataDir(), env: env({ FLEET_AUTH_AUTHORITY_FLOOR_ROOT: 'relative/floor' }) }))
      .toThrow(/must be an absolute path/);
  });
});

describe('fleet-auth grant statements', () => {
  const plan = () => planFleetAuthProvisioning({ systemDataDir: systemDataDir(), env: env() });

  it('grants CONNECT/TEMPORARY to every role and CREATE only to the migration role', () => {
    expect(runtimeDatabaseGrants(plan()).slice(0, 2)).toEqual([
      'GRANT CONNECT, TEMPORARY ON DATABASE "psfn" TO "fleet_auth_runtime", "fleet_auth_migration", "fleet_auth_backup"',
      'GRANT CREATE ON DATABASE "psfn" TO "fleet_auth_migration"',
    ]);
  });

  it('grants CONNECT and CREATE on the scratch database to every recovery authority', () => {
    const statements = restoreVerifyDatabaseGrants(plan());
    expect(statements).toContain(
      'GRANT CONNECT, CREATE ON DATABASE "psfn_restore_verify" TO "fleet_auth_migration", "fleet_auth_backup", "companion_main_runtime", "shared_schema_migration"',
    );
    expect(statements).toContain(
      'ALTER ROLE "companion_main_runtime" IN DATABASE "psfn_restore_verify" SET search_path TO "companion_main", "extensions"',
    );
  });
});

describe('ensureAuthorityFloorRoot', () => {
  it('creates the root 0700 and tightens an existing group-readable directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-fleet-auth-floor-'));
    roots.push(root);
    const created = join(root, 'new-floor');
    ensureAuthorityFloorRoot(created);
    expect(statSync(created).mode & 0o777).toBe(0o700);
    const loose = join(root, 'loose-floor');
    mkdirSync(loose, { mode: 0o750 });
    ensureAuthorityFloorRoot(loose);
    expect(statSync(loose).mode & 0o777).toBe(0o700);
  });
});
