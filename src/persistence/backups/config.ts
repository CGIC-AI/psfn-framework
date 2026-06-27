import { resolveBackupsDir } from '../layout.js';
import { loadBackupConfig } from '../../system/config/backup-config.js';

export const DEFAULT_BACKUP_INTERVAL_HOURS = 12;
export const DEFAULT_BACKUP_ROTATING_COUNT = 9;
export const DEFAULT_BACKUP_WEEKLY_COUNT = 2;
export const DEFAULT_BACKUP_MONTHLY_COUNT = 1;
export const DEFAULT_BACKUP_VERIFY_RESTORE = true;

/** @deprecated Use DEFAULT_BACKUP_INTERVAL_HOURS instead */
export const DEFAULT_BACKUP_INTERVAL_MS = DEFAULT_BACKUP_INTERVAL_HOURS * 60 * 60 * 1000;
/** @deprecated Use DEFAULT_BACKUP_ROTATING_COUNT instead */
export const DEFAULT_BACKUP_RETENTION_COUNT = DEFAULT_BACKUP_ROTATING_COUNT;
export const MIN_BACKUP_INTERVAL_MS = 60_000;
export const MIN_BACKUP_RETENTION_COUNT = 1;

export interface BackupRuntimeConfig {
  intervalMs: number;
  /** Number of rotating (most-recent) backup slots to keep. */
  maxRotatingBackups: number;
  /** Number of weekly backup slots to keep (derived from rotating cycle). */
  maxWeeklyBackups: number;
  /** Number of monthly backup slots to keep (derived from rotating cycle). */
  maxMonthlyBackups: number;
  rootDir: string;
  /** When non-empty, completed backups are mirrored here. */
  mirrorDir: string;
  verifyRestore: boolean;
}

interface ResolveBackupRuntimeConfigOptions {
  dataDir: string;
  defaultRootDir?: string;
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

function parseBooleanEnv(raw: string | undefined, fallback: boolean): boolean {
  if (typeof raw !== 'string') return fallback;
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

export function resolveBackupRuntimeConfig(
  options: ResolveBackupRuntimeConfigOptions,
): BackupRuntimeConfig {
  const env = options.env ?? process.env;
  const defaultRootDir = options.defaultRootDir?.trim() || resolveBackupsDir(options.dataDir);
  const rootDir = env.BACKUP_ROOT_DIR?.trim() || defaultRootDir;

  const jsonConfig = loadBackupConfig(options.dataDir);

  // Env vars override the JSON config for bootstrap/ops use
  const intervalHoursFromJson = jsonConfig.intervalHours;
  const intervalMsFromEnv = parseIntegerEnv(env.BACKUP_INTERVAL_MS, 0, MIN_BACKUP_INTERVAL_MS);
  const intervalMs = intervalMsFromEnv > 0
    ? intervalMsFromEnv
    : Math.max(MIN_BACKUP_INTERVAL_MS, intervalHoursFromJson * 60 * 60 * 1000);

  const retentionCountFromEnv = parseIntegerEnv(env.BACKUP_RETENTION_COUNT, 0, MIN_BACKUP_RETENTION_COUNT);
  const maxRotatingBackups = retentionCountFromEnv > 0
    ? retentionCountFromEnv
    : jsonConfig.maxRotatingBackups;

  const mirrorDir = env.BACKUP_MIRROR_DIR?.trim()
    ?? jsonConfig.mirrorDir;

  return {
    intervalMs,
    maxRotatingBackups,
    maxWeeklyBackups: jsonConfig.maxWeeklyBackups,
    maxMonthlyBackups: jsonConfig.maxMonthlyBackups,
    rootDir,
    mirrorDir,
    verifyRestore: parseBooleanEnv(
      env.BACKUP_VERIFY_RESTORE,
      jsonConfig.verifyRestore,
    ),
  };
}
