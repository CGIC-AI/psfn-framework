import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BACKUP_INTERVAL_MS,
  DEFAULT_BACKUP_RETENTION_COUNT,
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

    expect(config.intervalMs).toBe(DEFAULT_BACKUP_INTERVAL_MS);
    expect(config.retentionCount).toBe(DEFAULT_BACKUP_RETENTION_COUNT);
    expect(config.rootDir).toBe('/tmp/psfn-backup-defaults/backups');
  });

  it('uses env overrides and enforces minimum values', () => {
    const config = resolveBackupRuntimeConfig({
      dataDir: '/tmp/psfn-backup-env',
      env: {
        BACKUP_INTERVAL_MS: '1000',
        BACKUP_RETENTION_COUNT: '0',
        BACKUP_ROOT_DIR: '/tmp/custom-backups',
      },
    });

    expect(config.intervalMs).toBe(MIN_BACKUP_INTERVAL_MS);
    expect(config.retentionCount).toBe(MIN_BACKUP_RETENTION_COUNT);
    expect(config.rootDir).toBe('/tmp/custom-backups');
  });
});
