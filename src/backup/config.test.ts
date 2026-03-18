import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BACKUP_INTERVAL_HOURS,
  DEFAULT_BACKUP_MONTHLY_COUNT,
  DEFAULT_BACKUP_ROTATING_COUNT,
  DEFAULT_BACKUP_VERIFY_RESTORE,
  DEFAULT_BACKUP_WEEKLY_COUNT,
  MIN_BACKUP_INTERVAL_MS,
  MIN_BACKUP_RETENTION_COUNT,
  resolveBackupRuntimeConfig,
} from './config.js';

describe('resolveBackupRuntimeConfig', () => {
  it('uses defaults when env values are absent', () => {
    const config = resolveBackupRuntimeConfig({
      dataDir: '/tmp/psfn-backup-defaults',
      env: {},
    });

    expect(config.intervalMs).toBe(DEFAULT_BACKUP_INTERVAL_HOURS * 60 * 60 * 1000);
    expect(config.maxRotatingBackups).toBe(DEFAULT_BACKUP_ROTATING_COUNT);
    expect(config.maxWeeklyBackups).toBe(DEFAULT_BACKUP_WEEKLY_COUNT);
    expect(config.maxMonthlyBackups).toBe(DEFAULT_BACKUP_MONTHLY_COUNT);
    expect(config.rootDir).toBe('/tmp/psfn-backup-defaults/backups');
    expect(config.verifyRestore).toBe(DEFAULT_BACKUP_VERIFY_RESTORE);
  });

  it('uses env overrides and enforces minimum values', () => {
    const config = resolveBackupRuntimeConfig({
      dataDir: '/tmp/psfn-backup-env',
      env: {
        BACKUP_INTERVAL_MS: '1000',
        BACKUP_RETENTION_COUNT: '0',
        BACKUP_ROOT_DIR: '/tmp/custom-backups',
        BACKUP_VERIFY_RESTORE: 'false',
      },
    });

    expect(config.intervalMs).toBe(MIN_BACKUP_INTERVAL_MS);
    expect(config.maxRotatingBackups).toBe(MIN_BACKUP_RETENTION_COUNT);
    expect(config.rootDir).toBe('/tmp/custom-backups');
    expect(config.verifyRestore).toBe(false);
  });

  it('uses layout-provided backup root when env override is absent', () => {
    const config = resolveBackupRuntimeConfig({
      dataDir: '/tmp/psfn-backup-layout',
      defaultRootDir: '/srv/psfn/runtime/production/backups',
      env: {},
    });

    expect(config.rootDir).toBe('/srv/psfn/runtime/production/backups');
  });
});
