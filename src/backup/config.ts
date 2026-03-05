import { resolveBackupsDir } from '../persistence/layout.js';

export const DEFAULT_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_BACKUP_RETENTION_COUNT = 7;
export const MIN_BACKUP_INTERVAL_MS = 60_000;
export const MIN_BACKUP_RETENTION_COUNT = 1;

export interface BackupRuntimeConfig {
  intervalMs: number;
  retentionCount: number;
  rootDir: string;
}

interface ResolveBackupRuntimeConfigOptions {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
}

function parseIntegerEnv(
  raw: string | undefined,
  fallback: number,
  min: number,
): number {
  if (typeof raw !== 'string') return fallback;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, parsed);
}

export function resolveBackupRuntimeConfig(
  options: ResolveBackupRuntimeConfigOptions,
): BackupRuntimeConfig {
  const env = options.env ?? process.env;
  const rootDir = env.BACKUP_ROOT_DIR?.trim() || resolveBackupsDir(options.dataDir);

  return {
    intervalMs: parseIntegerEnv(
      env.BACKUP_INTERVAL_MS,
      DEFAULT_BACKUP_INTERVAL_MS,
      MIN_BACKUP_INTERVAL_MS,
    ),
    retentionCount: parseIntegerEnv(
      env.BACKUP_RETENTION_COUNT,
      DEFAULT_BACKUP_RETENTION_COUNT,
      MIN_BACKUP_RETENTION_COUNT,
    ),
    rootDir,
  };
}
