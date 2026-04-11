import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCompanionStateDir } from '../../persistence/layout.js';
import { loadConfig } from '../../system/config/load-config.js';
import { hydrateJsonBackedRuntimeConfig } from '../../system/config/runtime-config.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';

const ISOLATED_E2E_ENV_KEYS = [
  'BACKUP_ROOT_DIR',
  'CHARACTER_CARD_PATH',
  'COMPANION_DATA_DIR',
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

export function createIsolatedE2ERuntime(
  options: IsolatedE2ERuntimeOptions = {},
): IsolatedE2ERuntime {
  const rootDir = mkdtempSync(join(tmpdir(), options.prefix ?? 'psfn-e2e-'));
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
    delete process.env.PSFN_RUNTIME_ROOT;
    process.env.SYSTEM_DATA_DIR = systemDataDir;
    process.env.COMPANION_DATA_DIR = companionDataDir;
    process.env.WORKSPACE_PATH = workspacePath;
    process.env.PSFN_LOGS_DIR = logsDir;
    process.env.PSFN_TEMP_DIR = tempDir;
    process.env.BACKUP_ROOT_DIR = backupsDir;
    process.env.PSFN_RUNTIME_LAYOUT_MODE = 'continuous';
    process.env.DATABASE_PATH = databasePath;
    process.env.CHARACTER_CARD_PATH = characterCardPath;

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
