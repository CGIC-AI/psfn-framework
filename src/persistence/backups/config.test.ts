import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  function withBackupOwnerFile(test: (dataDir: string) => void): void {
    const root = mkdtempSync(join(tmpdir(), 'psfn-backup-config-'));
    const dataDir = join(root, 'system-data');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'backup.json'), JSON.stringify({
      intervalHours: DEFAULT_BACKUP_INTERVAL_HOURS,
      maxRotatingBackups: DEFAULT_BACKUP_ROTATING_COUNT,
      maxWeeklyBackups: DEFAULT_BACKUP_WEEKLY_COUNT,
      maxMonthlyBackups: DEFAULT_BACKUP_MONTHLY_COUNT,
      mirrorDir: '',
      verifyRestore: DEFAULT_BACKUP_VERIFY_RESTORE,
      encryption: {
        mode: 'required',
        keyRef: {
          kind: 'env',
          envName: 'PSFN_BACKUP_TEST_KEY',
        },
      },
    }), 'utf8');
    try {
      test(dataDir);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it('fails closed when backup.json is missing', () => {
    expect(() => resolveBackupRuntimeConfig({
      dataDir: '/tmp/psfn-backup-missing',
      env: {},
    })).toThrow('Missing required JSON owner file');
  });

  it('fails closed when backup.json is malformed', () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-backup-config-invalid-'));
    const dataDir = join(root, 'system-data');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'backup.json'), '{"broken":', 'utf8');
    try {
      expect(() => resolveBackupRuntimeConfig({
        dataDir,
        env: {},
      })).toThrow('Invalid JSON owner file');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses owner-file values when env values are absent', () => {
    withBackupOwnerFile((dataDir) => {
      const config = resolveBackupRuntimeConfig({
        dataDir,
        env: {
          PSFN_BACKUP_TEST_KEY: 'backup-secret',
        },
      });

      expect(config.intervalMs).toBe(DEFAULT_BACKUP_INTERVAL_HOURS * 60 * 60 * 1000);
      expect(config.maxRotatingBackups).toBe(DEFAULT_BACKUP_ROTATING_COUNT);
      expect(config.maxWeeklyBackups).toBe(DEFAULT_BACKUP_WEEKLY_COUNT);
      expect(config.maxMonthlyBackups).toBe(DEFAULT_BACKUP_MONTHLY_COUNT);
      expect(config.rootDir).toBe(`${dataDir}/backups`);
      expect(config.verifyRestore).toBe(DEFAULT_BACKUP_VERIFY_RESTORE);
      expect(config.encryption.keyRef.envName).toBe('PSFN_BACKUP_TEST_KEY');
      expect(config.encryption.passphrase).toBe('backup-secret');
    });
  });

  it('fails closed when the configured backup encryption key is missing', () => {
    withBackupOwnerFile((dataDir) => {
      expect(() => resolveBackupRuntimeConfig({
        dataDir,
        env: {},
      })).toThrow('Backup encryption key env PSFN_BACKUP_TEST_KEY is required');
    });
  });

  it('uses env overrides and enforces minimum values', () => {
    withBackupOwnerFile((dataDir) => {
      const config = resolveBackupRuntimeConfig({
        dataDir,
        env: {
          BACKUP_INTERVAL_MS: '1000',
          BACKUP_RETENTION_COUNT: '0',
          BACKUP_ROOT_DIR: '/tmp/custom-backups',
          BACKUP_VERIFY_RESTORE: 'false',
          PSFN_BACKUP_TEST_KEY: 'backup-secret',
        },
      });

      expect(config.intervalMs).toBe(MIN_BACKUP_INTERVAL_MS);
      expect(config.maxRotatingBackups).toBe(MIN_BACKUP_RETENTION_COUNT);
      expect(config.rootDir).toBe('/tmp/custom-backups');
      expect(config.verifyRestore).toBe(false);
    });
  });

  it('defaults groupMode off and honours the BACKUP_GROUP_MODE override', () => {
    withBackupOwnerFile((dataDir) => {
      const off = resolveBackupRuntimeConfig({
        dataDir,
        env: { PSFN_BACKUP_TEST_KEY: 'backup-secret' },
      });
      expect(off.groupMode).toBe(false);

      const on = resolveBackupRuntimeConfig({
        dataDir,
        env: { PSFN_BACKUP_TEST_KEY: 'backup-secret', BACKUP_GROUP_MODE: 'true' },
      });
      expect(on.groupMode).toBe(true);
    });
  });

  it('uses layout-provided backup root when env override is absent', () => {
    withBackupOwnerFile((dataDir) => {
      const config = resolveBackupRuntimeConfig({
        dataDir,
        defaultRootDir: '/srv/psfn/runtime/production/backups',
        env: {
          PSFN_BACKUP_TEST_KEY: 'backup-secret',
        },
      });

      expect(config.rootDir).toBe('/srv/psfn/runtime/production/backups');
    });
  });
});
