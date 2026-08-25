import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCompanionStateDir } from '../../persistence/layout.js';
import { loadConfig } from '../../system/config/load-config.js';
import { hydrateJsonBackedRuntimeConfig } from '../../system/config/runtime-config.js';
import { PER_COMPANION_OWNER_FILES } from '../../system/config/settings-contract.js';
import { COMPANIONS_FILE_NAME } from '../../system/config/companions-config.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { createBootstrapStarterCard } from '../../core/identity/loader.js';

const ISOLATED_E2E_ENV_KEYS = [
  'BACKUP_ROOT_DIR',
  'CHARACTER_CARD_PATH',
  'COMPANION_ID',
  'COMPANION_DATA_DIR',
  'COMPANION_PG_SCHEMA',
  'DATA_DIR',
  'DATABASE_PATH',
  'PSFN_LOGS_DIR',
  'PSFN_RUNTIME_LAYOUT_MODE',
  'PSFN_RUNTIME_ROOT',
  'PSFN_TEMP_DIR',
  'SYSTEM_DATA_DIR',
  'WORKSPACE_PATH',
] as const;

const DEFAULT_SEED_DIR = 'config';

type IsolatedE2EEnvKey = (typeof ISOLATED_E2E_ENV_KEYS)[number];
type IsolatedE2EEnvSnapshot = Record<IsolatedE2EEnvKey, string | undefined>;

export interface IsolatedE2ERuntimeOptions {
  databasePath?: string;
  prefix?: string;
  seedDir?: string;
}

export interface IsolatedE2ERuntime {
  backupsDir: string;
  companionDataDir: string;
  config: SubstrateConfig;
  logsDir: string;
  rootDir: string;
  seedDir: string;
  systemDataDir: string;
  tempDir: string;
  workspacePath: string;
  cleanup(): void;
}

function snapshotIsolatedE2EEnv(): IsolatedE2EEnvSnapshot {
  return ISOLATED_E2E_ENV_KEYS.reduce((snapshot, key) => {
    snapshot[key] = process.env[key];
    return snapshot;
  }, {} as IsolatedE2EEnvSnapshot);
}

function restoreIsolatedE2EEnv(snapshot: IsolatedE2EEnvSnapshot): void {
  for (const key of ISOLATED_E2E_ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function normalizeNonEmptyString(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function copyOwnerExample(seedDir: string, systemDataDir: string, ownerFile: string): void {
  const exampleFile = ownerFile.replace(/\.json$/, '.seed.json');
  writeFileSync(
    join(systemDataDir, ownerFile),
    readFileSync(join(seedDir, exampleFile), 'utf8'),
    'utf8',
  );
}

export function createIsolatedE2ERuntime(
  options: IsolatedE2ERuntimeOptions = {},
): IsolatedE2ERuntime {
  const rootDir = mkdtempSync(join(tmpdir(), options.prefix ?? 'companion-e2e-'));
  const systemDataDir = join(rootDir, 'system-data');
  const companionDataDir = join(rootDir, 'companion-data');
  const workspacePath = join(rootDir, 'workspace');
  const logsDir = join(rootDir, 'logs');
  const tempDir = join(rootDir, 'tmp');
  const backupsDir = join(rootDir, 'backups');
  const companionStateDir = resolveCompanionStateDir(companionDataDir);
  const databasePath = normalizeNonEmptyString(options.databasePath ?? process.env.E2E_DATABASE_PATH)
    ?? join(companionStateDir, 'companion.db');
  const characterCardPath = join(companionDataDir, 'companion.json');
  const seedDir = normalizeNonEmptyString(options.seedDir ?? process.env.CONFIG_DIR)
    ?? DEFAULT_SEED_DIR;
  const envSnapshot = snapshotIsolatedE2EEnv();

  mkdirSync(systemDataDir, { recursive: true });
  mkdirSync(companionStateDir, { recursive: true });
  mkdirSync(workspacePath, { recursive: true });
  mkdirSync(logsDir, { recursive: true });
  mkdirSync(tempDir, { recursive: true });
  mkdirSync(backupsDir, { recursive: true });

  let cleanedUp = false;
  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    restoreIsolatedE2EEnv(envSnapshot);
    rmSync(rootDir, { recursive: true, force: true });
  };

  try {
    delete process.env.DATA_DIR;
    // Fleet paths in companions.json are resolved from the runtime root. Keep
    // that authority inside the same temporary tree as the copied owner files
    // instead of allowing relative fleet paths to resolve from process.cwd().
    process.env.PSFN_RUNTIME_ROOT = rootDir;
    process.env.SYSTEM_DATA_DIR = systemDataDir;
    process.env.COMPANION_DATA_DIR = companionDataDir;
    process.env.WORKSPACE_PATH = workspacePath;
    process.env.PSFN_LOGS_DIR = logsDir;
    process.env.PSFN_TEMP_DIR = tempDir;
    process.env.BACKUP_ROOT_DIR = backupsDir;
    process.env.PSFN_RUNTIME_LAYOUT_MODE = 'continuous';
    process.env.DATABASE_PATH = databasePath;
    process.env.CHARACTER_CARD_PATH = characterCardPath;
    process.env.COMPANION_ID = '11111111-1111-4111-8111-111111111111';
    process.env.COMPANION_PG_SCHEMA = 'public';
    // Postgres-only runtime persistence requires a URL at config load; e2e
    // runs may override with a real scratch database via the ambient env.
    process.env.POSTGRES_DATABASE_URL ??= 'postgresql://psfn:psfn-local@127.0.0.1:5432/psfn_e2e';

    for (const ownerFile of [
      'settings.json',
      'models.json',
      'providers.json',
      'scheduler.json',
      'capability-tier.json',
      'trust-policy.json',
      'charge-policy.json',
      'backup.json',
      'skills.json',
      'mcp-servers.json',
    ]) {
      // Registry-owned per-companion files are rooted at companionDataDir; the
      // rest stay cluster-global at systemDataDir.
      copyOwnerExample(
        seedDir,
        PER_COMPANION_OWNER_FILES.has(ownerFile) ? companionDataDir : systemDataDir,
        ownerFile,
      );
    }
    writeFileSync(
      characterCardPath,
      `${JSON.stringify(createBootstrapStarterCard('E2E Companion'), null, 2)}\n`,
      'utf8',
    );
    // The companions.json fleet manifest is mandatory for every deployment.
    // A single-companion e2e run is a one-entry fleet ("a fleet of one"), which
    // load-config treats identically to the old single-companion topology
    // (multiCompanion=false, no tenant schema binding).
    writeFileSync(
      join(systemDataDir, COMPANIONS_FILE_NAME),
      `${JSON.stringify({
        postgres: {
          sharedMigrationRole: 'shared_schema_migration',
          sharedMigrationDatabaseUrlRef: {
            kind: 'env',
            envName: 'SHARED_SCHEMA_MIGRATION_DATABASE_URL',
          },
        },
        companions: [
          {
            companionId: process.env.COMPANION_ID,
            companionDataDir: 'companion-data',
            characterCardPath: 'companion-data/companion.json',
            postgresSchema: 'public',
            postgresRole: 'single_companion_runtime',
            postgresDatabaseUrlRef: {
              kind: 'env',
              envName: 'SINGLE_COMPANION_DATABASE_URL',
            },
          },
        ],
      }, null, 2)}\n`,
      'utf8',
    );

    return {
      backupsDir,
      companionDataDir,
      config: hydrateJsonBackedRuntimeConfig(loadConfig(), { seedDir }),
      logsDir,
      rootDir,
      seedDir,
      systemDataDir,
      tempDir,
      workspacePath,
      cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}
