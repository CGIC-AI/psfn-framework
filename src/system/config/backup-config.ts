import { join } from 'node:path';
import {
  loadOrSeedJson,
  writeJsonAtomic,
} from './load-or-seed.js';
import { isRecord } from '../../shared/utils/types.js';

export const BACKUP_FILE_NAME = 'backup.json';
export const BACKUP_SEED_FILE_NAME = 'backup.seed.json';

export interface BackupJsonConfig {
  intervalHours: number;
  maxRotatingBackups: number;
  maxWeeklyBackups: number;
  maxMonthlyBackups: number;
  mirrorDir: string;
  verifyRestore: boolean;
}

interface BackupConfigLoadOptions {
  seedDir?: string;
}

function toPositiveNumber(value: unknown, field: string, min: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) {
    throw new Error(
      `Invalid backup config: ${field} must be a number >= ${min}, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function toBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(
      `Invalid backup config: ${field} must be a boolean, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function toString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(
      `Invalid backup config: ${field} must be a string, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function validateBackupConfig(raw: unknown, sourcePath: string): BackupJsonConfig {
  if (!isRecord(raw)) {
    throw new Error(`Invalid backup config at ${sourcePath}: expected object`);
  }
  return {
    intervalHours: toPositiveNumber(raw.intervalHours, 'intervalHours', 1),
    maxRotatingBackups: toPositiveNumber(raw.maxRotatingBackups, 'maxRotatingBackups', 1),
    maxWeeklyBackups: toPositiveNumber(raw.maxWeeklyBackups, 'maxWeeklyBackups', 0),
    maxMonthlyBackups: toPositiveNumber(raw.maxMonthlyBackups, 'maxMonthlyBackups', 0),
    mirrorDir: toString(raw.mirrorDir, 'mirrorDir'),
    verifyRestore: toBoolean(raw.verifyRestore, 'verifyRestore'),
  };
}

export function loadBackupConfig(
  dataDir: string,
  options: BackupConfigLoadOptions = {},
): BackupJsonConfig {
  const seedDir = options.seedDir ?? process.env.CONFIG_DIR ?? './config';
  return loadOrSeedJson({
    dataPath: join(dataDir, BACKUP_FILE_NAME),
    seedPath: join(seedDir, BACKUP_SEED_FILE_NAME),
    validate: validateBackupConfig,
  });
}

export function saveBackupConfig(
  dataDir: string,
  nextConfig: unknown,
): BackupJsonConfig {
  const validated = validateBackupConfig(nextConfig, BACKUP_FILE_NAME);
  writeJsonAtomic(join(dataDir, BACKUP_FILE_NAME), validated);
  return validated;
}
