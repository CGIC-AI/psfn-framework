import { describe, expect, it } from 'vitest';
import { createStaticCredentialVault } from '../../boundary/custody/credential-vault.js';
import { resolveCompanionDatabaseTopology } from './companion-database-config.js';
import type { ResolvedCompanionsFleetConfig } from './companions-config.js';

const FLEET: ResolvedCompanionsFleetConfig = {
  postgres: {
    sharedMigrationRole: 'shared_schema_migration',
    sharedMigrationDatabaseUrlRef: { kind: 'env', envName: 'SHARED_MIGRATION_URL' },
  },
  persistenceRoot: '/runtime',
  workspacesRoot: '/runtime/workspaces',
  sharedWorkspacePath: '/runtime/workspaces/shared',
  companions: [
    {
      companionId: '11111111-1111-4111-8111-111111111111',
      companionDataDir: '/runtime/alpha',
      characterCardPath: '/runtime/alpha/card.json',
      personalWorkspacePath: '/runtime/workspaces/personal/alpha',
      postgresSchema: 'companion_alpha',
      postgresRole: 'companion_alpha_runtime',
      postgresDatabaseUrlRef: { kind: 'env', envName: 'ALPHA_DATABASE_URL' },
    },
    {
      companionId: '22222222-2222-4222-8222-222222222222',
      companionDataDir: '/runtime/beta',
      characterCardPath: '/runtime/beta/card.json',
      personalWorkspacePath: '/runtime/workspaces/personal/beta',
      postgresSchema: 'companion_beta',
      postgresRole: 'companion_beta_runtime',
      postgresDatabaseUrlRef: { kind: 'env', envName: 'BETA_DATABASE_URL' },
    },
  ],
};

const CREDENTIALS = {
  SHARED_MIGRATION_URL: 'postgres://shared_schema_migration:shared@db.example.test/psfn',
  ALPHA_DATABASE_URL: 'postgres://companion_alpha_runtime:alpha@db.example.test/psfn',
  BETA_DATABASE_URL: 'postgres://companion_beta_runtime:beta@db.example.test/psfn',
};

describe('multi-companion database topology resolution', () => {
  it('resolves one exact distinct credential per companion and keeps shared migration separate', () => {
    const resolved = resolveCompanionDatabaseTopology({
      fleet: FLEET,
      credentialVault: createStaticCredentialVault(CREDENTIALS),
      gatewayDatabaseUrl: CREDENTIALS.ALPHA_DATABASE_URL,
    });
    expect(resolved.sharedMigration).toEqual({
      databaseUrl: CREDENTIALS.SHARED_MIGRATION_URL,
      role: 'shared_schema_migration',
    });
    expect(resolved.companions.map(entry => [entry.role, entry.databaseUrl])).toEqual([
      ['companion_alpha_runtime', CREDENTIALS.ALPHA_DATABASE_URL],
      ['companion_beta_runtime', CREDENTIALS.BETA_DATABASE_URL],
    ]);
  });

  it('fails closed on missing, routed, reused, role-mismatched, or cross-target credentials', () => {
    const resolve = (credentials: Record<string, string>, gateway = credentials.ALPHA_DATABASE_URL) => (
      resolveCompanionDatabaseTopology({
        fleet: FLEET,
        credentialVault: createStaticCredentialVault(credentials),
        gatewayDatabaseUrl: gateway,
      })
    );
    expect(() => resolve({ ...CREDENTIALS, BETA_DATABASE_URL: '' }))
      .toThrow(/Companion .* database credential is not configured/);
    expect(() => resolve({
      ...CREDENTIALS,
      BETA_DATABASE_URL: `${CREDENTIALS.BETA_DATABASE_URL}?user=companion_alpha_runtime`,
    })).toThrow(/routing or authentication query override/);
    expect(() => resolve({ ...CREDENTIALS, BETA_DATABASE_URL: CREDENTIALS.ALPHA_DATABASE_URL }))
      .toThrow(/configured role companion_beta_runtime|distinct database credential/);
    expect(() => resolve({
      ...CREDENTIALS,
      BETA_DATABASE_URL: 'postgres://companion_beta_runtime:beta@other.example.test/psfn',
    })).toThrow(/same exact database/);
    expect(() => resolve(CREDENTIALS, 'postgres://other:other@db.example.test/psfn'))
      .toThrow(/Gateway POSTGRES_DATABASE_URL must exactly match/);
  });
});
