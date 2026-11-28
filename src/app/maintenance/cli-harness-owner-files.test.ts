import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapMaintenanceRuntime } from './cli-harness.js';

// The embedding repair CLIs (memory:repair:embeddings from PR #664,
// migrate:embeddings) build their embedding provider from settings.json.
// loadConfig alone leaves every owner-file setting unset, so on a real
// deployment both failed with "embeddingProvider is required in settings.json"
// (found live on the 2026-11-28 shakedown soak). These tests run the real
// loader and the real owner-file hydration over a seeded runtime layout.

const ORIGINAL_ENV = { ...process.env };
const TEMP_DIRS: string[] = [];
const COMPANION_ID = '11111111-1111-4111-8111-111111111111';

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
  while (TEMP_DIRS.length > 0) rmSync(TEMP_DIRS.pop()!, { recursive: true, force: true });
});

function seedRuntime(): void {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'psfn-maintenance-owner-files-'));
  TEMP_DIRS.push(runtimeRoot);
  const systemDataDir = join(runtimeRoot, 'system-data');
  const companionDataDir = join(runtimeRoot, 'companion-data');
  mkdirSync(systemDataDir, { recursive: true });
  mkdirSync(companionDataDir, { recursive: true });
  const copySeed = (dir: string, ownerFile: string): void => {
    writeFileSync(
      join(dir, ownerFile),
      readFileSync(join(process.cwd(), 'config', ownerFile.replace(/\.json$/, '.seed.json')), 'utf8'),
      'utf8',
    );
  };
  for (const ownerFile of ['settings.json', 'models.json', 'providers.json']) copySeed(systemDataDir, ownerFile);
  for (const ownerFile of ['scheduler.json', 'capability-tier.json', 'charge-policy.json']) {
    copySeed(companionDataDir, ownerFile);
  }
  writeFileSync(join(systemDataDir, 'companions.json'), `${JSON.stringify({
    postgres: {
      sharedMigrationRole: 'shared_schema_migration',
      sharedMigrationDatabaseUrlRef: { kind: 'env', envName: 'SHARED_MIGRATION_URL' },
    },
    companions: [{
      companionId: COMPANION_ID,
      companionDataDir: 'companion-data',
      characterCardPath: 'companion-data/companion.json',
      postgresSchema: 'public',
      postgresRole: 'single_companion_runtime',
      postgresDatabaseUrlRef: { kind: 'env', envName: 'SINGLE_COMPANION_DATABASE_URL' },
    }],
  })}\n`, 'utf8');
  delete process.env.DATA_DIR;
  Object.assign(process.env, {
    PSFN_RUNTIME_LAYOUT_MODE: 'continuous',
    PSFN_RUNTIME_ROOT: runtimeRoot,
    SYSTEM_DATA_DIR: systemDataDir,
    COMPANION_DATA_DIR: companionDataDir,
    WORKSPACE_PATH: join(runtimeRoot, 'workspaces', 'personal', COMPANION_ID),
    CHARACTER_CARD_PATH: join(companionDataDir, 'companion.json'),
    COMPANION_ID,
    COMPANION_PG_SCHEMA: 'public',
    POSTGRES_DATABASE_URL: 'postgresql://test:test@127.0.0.1:5432/test',
    CONFIG_DIR: 'config',
  });
}

describe('bootstrapMaintenanceRuntime owner-file hydration', () => {
  it('applies settings.json so the embedding CLIs can build their provider', async () => {
    seedRuntime();
    const seeded = JSON.parse(readFileSync(join(process.cwd(), 'config', 'settings.seed.json'), 'utf8')) as {
      embeddingProvider: string;
    };

    const { config } = await bootstrapMaintenanceRuntime({ hydrateSecrets: false, hydrateOwnerFiles: true });

    expect(config.embeddingProvider).toBe(seeded.embeddingProvider);
  });

  it('leaves owner-file settings unset for commands that do not opt in', async () => {
    seedRuntime();

    const { config } = await bootstrapMaintenanceRuntime({ hydrateSecrets: false });

    expect(config.embeddingProvider).toBeUndefined();
  });
});
