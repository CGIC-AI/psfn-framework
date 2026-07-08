import { join } from 'node:path';
import {
  loadRequiredJson,
} from './load-or-seed.js';
import { writeJsonAtomic } from '../../shared/utils/fs.js';
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
  /**
   * Multi-companion backup shape. `false` (default) = one companion, one backup:
   * each companion is captured as its own portable slice plus a separate cluster
   * artifact. `true` = a single whole-database family artifact. Ignored in
   * single-companion topology. Optional for backward compatibility; absent means
   * `false`.
   */
  groupMode: boolean;
  encryption: BackupEncryptionJsonConfig;
}

export interface BackupEncryptionJsonConfig {
  mode: 'required';
  keyRef: BackupEncryptionKeyRefConfig;
}

export interface BackupEncryptionKeyRefConfig {
  kind: 'env';
  envName: string;
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

function validateEncryptionConfig(value: unknown): BackupEncryptionJsonConfig {
  if (!isRecord(value)) {
    throw new Error('Invalid backup config: encryption must be an object');
  }
  if (value.mode !== 'required') {
    throw new Error(
      `Invalid backup config: encryption.mode must be "required", got ${JSON.stringify(value.mode)}`,
    );
  }
  if (!isRecord(value.keyRef)) {
    throw new Error('Invalid backup config: encryption.keyRef must be an object');
  }
  if (value.keyRef.kind !== 'env') {
    throw new Error(
      `Invalid backup config: encryption.keyRef.kind must be "env", got ${JSON.stringify(value.keyRef.kind)}`,
    );
  }
  const envName = toString(value.keyRef.envName, 'encryption.keyRef.envName').trim();
  if (!/^[A-Z_][A-Z0-9_]*$/.test(envName)) {
    throw new Error(
      `Invalid backup config: encryption.keyRef.envName must be an uppercase env var name, got ${JSON.stringify(value.keyRef.envName)}`,
    );
  }
  return {
    mode: 'required',
    keyRef: {
      kind: 'env',
      envName,
    },
  };
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
    // Optional for backward compatibility: an absent value means group mode off.
    groupMode: raw.groupMode === undefined ? false : toBoolean(raw.groupMode, 'groupMode'),
    encryption: validateEncryptionConfig(raw.encryption),
  };
}

export function loadBackupConfig(
  dataDir: string,
  options: BackupConfigLoadOptions = {},
): BackupJsonConfig {
  const seedDir = options.seedDir ?? process.env.CONFIG_DIR ?? './config';
  return loadRequiredJson({
    dataPath: join(dataDir, BACKUP_FILE_NAME),
    examplePath: join(seedDir, BACKUP_SEED_FILE_NAME),
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
