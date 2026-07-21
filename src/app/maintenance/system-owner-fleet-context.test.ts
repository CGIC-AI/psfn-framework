import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveSystemOwnerFleetContext } from './system-owner-fleet-context.js';

const roots: string[] = [];

function singleCompanionEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const root = mkdtempSync(join(tmpdir(), 'psfn-owner-context-'));
  roots.push(root);
  for (const relativePath of [
    'system-data',
    'companions/companion',
    'workspace',
    'logs',
    'tmp',
    'backups',
  ]) {
    mkdirSync(join(root, relativePath), { recursive: true });
  }
  return {
    NODE_ENV: 'production',
    PSFN_RUNTIME_LAYOUT_MODE: 'production',
    PSFN_RUNTIME_ROOT: root,
    SYSTEM_DATA_DIR: join(root, 'system-data'),
    COMPANION_DATA_DIR: join(root, 'companions', '11111111-1111-4111-8111-111111111111'),
    WORKSPACE_PATH: join(root, 'workspace'),
    PSFN_LOGS_DIR: join(root, 'logs'),
    PSFN_TEMP_DIR: join(root, 'tmp'),
    BACKUP_ROOT_DIR: join(root, 'backups'),
    DATA_DIR: '',
    COMPANION_ID: '11111111-1111-4111-8111-111111111111',
    ...overrides,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('resolveSystemOwnerFleetContext', () => {
  it('binds the default topology to its one explicit companion root', () => {
    const env = singleCompanionEnv();
    const { layout, fleet } = resolveSystemOwnerFleetContext(env);

    expect(fleet.companions).toHaveLength(1);
    expect(fleet.companions[0]).toMatchObject({
      companionId: '11111111-1111-4111-8111-111111111111',
      companionDataDir: layout.companionDataDir,
      characterCardPath: join(layout.companionDataDir, 'companion.json'),
      postgresSchema: 'public',
    });
  });

  it('requires an explicit identity for a single-companion migration', () => {
    const env = singleCompanionEnv({ COMPANION_ID: '' });
    expect(() => resolveSystemOwnerFleetContext(env)).toThrow(
      'COMPANION_ID for single-companion system-owner migration must be a lowercase RFC-4122 UUID',
    );
  });

  it('synthesizes the single-companion migration fleet when no manifest is present', () => {
    // The retired PSFN_MULTI_COMPANION flag no longer forces a manifest here:
    // the migration tool synthesizes a one-entry fleet from the environment so a
    // pre-manifest install can be migrated. A stray flag value is ignored.
    const env = singleCompanionEnv({ PSFN_MULTI_COMPANION: 'true' });
    const { fleet } = resolveSystemOwnerFleetContext(env);
    expect(fleet.companions).toHaveLength(1);
    expect(fleet.companions[0]).toMatchObject({
      companionId: '11111111-1111-4111-8111-111111111111',
      postgresSchema: 'public',
    });
  });

  it('uses an explicit manifest when one is present', () => {
    const env = singleCompanionEnv();
    const companionId = '123e4567-e89b-42d3-a456-426614174000';
    writeFileSync(
      join(env.SYSTEM_DATA_DIR!, 'companions.json'),
      `${JSON.stringify({
        postgres: {
          sharedMigrationRole: 'shared_schema_migration',
          sharedMigrationDatabaseUrlRef: { kind: 'env', envName: 'SHARED_MIGRATION_URL' },
        },
        companions: [{
          companionId,
          companionDataDir: 'companions/companion',
          characterCardPath: 'companions/companion/companion.json',
          postgresSchema: 'companion_one',
          postgresRole: 'companion_one_runtime',
          postgresDatabaseUrlRef: { kind: 'env', envName: 'COMPANION_ONE_DATABASE_URL' },
        }],
      })}\n`,
    );

    const { fleet } = resolveSystemOwnerFleetContext(env);
    expect(fleet.companions).toHaveLength(1);
    expect(fleet.companions[0].companionId).toBe(companionId);
  });
});
