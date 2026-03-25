import BetterSqlite3 from 'better-sqlite3';
import type Database from 'better-sqlite3';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../event-bus.js';
import { Scheduler } from '../scheduler/scheduler.js';
import {
  registerScheduledBackupTask,
  runBackupCycle,
  SCHEDULED_BACKUP_TASK_ID,
  verifyBackupRestore,
} from './service.js';

interface BackupDbLike {
  backup: (path: string) => Promise<unknown>;
}

function asDb(value: BackupDbLike): Database.Database {
  return value as unknown as Database.Database;
}

describe('runBackupCycle', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) {
      rmSync(root, { recursive: true, force: true });
    }
    roots.length = 0;
  });

  it('creates timestamped sqlite and JSONL snapshots', async () => {
    const root = join(tmpdir(), `psfn-backup-cycle-${Date.now()}`);
    roots.push(root);
    const sessionsDir = join(root, 'sessions');
    const backupRootDir = join(root, 'backups');
    const databasePath = join(root, 'companion.db');
    const characterCardPath = join(root, 'psfn.json');
    const characterCardHistoryPath = join(root, 'character-card-history.jsonl');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'alpha.jsonl'), '{"id":1}\n', 'utf-8');
    writeFileSync(join(sessionsDir, 'ignored.txt'), 'nope', 'utf-8');
    writeFileSync(databasePath, 'live-db', 'utf-8');
    writeFileSync(characterCardPath, '{"name":"PSFN"}\n', 'utf-8');
    writeFileSync(characterCardHistoryPath, '{"version":1}\n', 'utf-8');

    const backup = vi.fn(async (path: string) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, 'backup-db', 'utf-8');
    });

    const result = await runBackupCycle({
      db: asDb({ backup }),
      databasePath,
      sessionsDir,
      backupRootDir,
      characterCardPath,
      characterCardHistoryPath,
      retentionCount: 7,
      now: () => Date.UTC(2026, 1, 26, 10, 11, 12, 123),
    });

    expect(backup).toHaveBeenCalledTimes(1);
    expect(result.backupDir).toContain('20260226T101112123Z');
    expect(existsSync(result.databaseBackupPath)).toBe(true);
    expect(existsSync(join(result.sessionSnapshotDir, 'alpha.jsonl'))).toBe(true);
    expect(existsSync(join(result.sessionSnapshotDir, 'ignored.txt'))).toBe(false);
    expect(existsSync(join(result.backupDir, 'companion', 'psfn.json'))).toBe(true);
    expect(existsSync(join(result.backupDir, 'companion', 'character-card-history.jsonl'))).toBe(true);
    expect(result.copiedSessionFiles).toEqual(['alpha.jsonl']);
    expect(result.prunedBackupDirs).toEqual([]);
  });

  it('prunes old backup directories by retention count', async () => {
    const root = join(tmpdir(), `psfn-backup-retention-${Date.now()}`);
    roots.push(root);
    const sessionsDir = join(root, 'sessions');
    const backupRootDir = join(root, 'backups');
    const databasePath = join(root, 'companion.db');
    mkdirSync(sessionsDir, { recursive: true });
    mkdirSync(backupRootDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'channel.jsonl'), '{}\n', 'utf-8');
    writeFileSync(databasePath, 'live-db', 'utf-8');

    for (const dir of ['20260101T000000000Z', '20260102T000000000Z', '20260103T000000000Z']) {
      mkdirSync(join(backupRootDir, dir), { recursive: true });
    }

    const backup = vi.fn(async (path: string) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, 'backup-db', 'utf-8');
    });

    await runBackupCycle({
      db: asDb({ backup }),
      databasePath,
      sessionsDir,
      backupRootDir,
      maxRotatingBackups: 2,
      maxWeeklyBackups: 0,
      maxMonthlyBackups: 0,
      now: () => Date.UTC(2026, 1, 26, 10, 11, 12, 123),
    });

    const remaining = readdirSync(backupRootDir).sort((a, b) => a.localeCompare(b));
    expect(remaining).toEqual(['20260103T000000000Z', '20260226T101112123Z']);
  });

  it('verifies backup restore integrity when enabled', async () => {
    const root = join(tmpdir(), `psfn-backup-restore-verify-${Date.now()}`);
    roots.push(root);
    const sessionsDir = join(root, 'sessions');
    const backupRootDir = join(root, 'backups');
    const databasePath = join(root, 'companion.db');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'channel-a.jsonl'), '{}\n', 'utf-8');

    const liveDb = new BetterSqlite3(databasePath);
    liveDb.exec('CREATE TABLE IF NOT EXISTS runtime_state (id INTEGER PRIMARY KEY, value TEXT);');
    liveDb.exec("INSERT INTO runtime_state (value) VALUES ('ok');");

    try {
      const result = await runBackupCycle({
        db: liveDb as unknown as Database.Database,
        databasePath,
        sessionsDir,
        backupRootDir,
        maxRotatingBackups: 7,
        maxWeeklyBackups: 0,
        maxMonthlyBackups: 0,
        verifyRestore: true,
        now: () => Date.UTC(2026, 1, 27, 10, 11, 12, 123),
      });

      expect(result.restoreVerification).toBeDefined();
      expect(result.restoreVerification?.integrityDetails).toEqual(['ok']);
      expect(result.restoreVerification?.restoredSessionFiles).toEqual(['channel-a.jsonl']);
    } finally {
      liveDb.close();
    }
  });
});

describe('verifyBackupRestore', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) {
      rmSync(root, { recursive: true, force: true });
    }
    roots.length = 0;
  });

  it('throws when database snapshot is missing', () => {
    const root = join(tmpdir(), `psfn-backup-restore-missing-${Date.now()}`);
    roots.push(root);
    const sessionsDir = join(root, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'channel.jsonl'), '{}\n', 'utf-8');

    expect(() => verifyBackupRestore({
      databaseBackupPath: join(root, 'missing.db'),
      sessionSnapshotDir: sessionsDir,
    })).toThrow('Backup database snapshot missing');
  });
});

describe('registerScheduledBackupTask', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) {
      rmSync(root, { recursive: true, force: true });
    }
    roots.length = 0;
  });

  it('registers a scheduled backup task with configured interval', async () => {
    const root = join(tmpdir(), `psfn-backup-scheduler-${Date.now()}`);
    roots.push(root);
    const sessionsDir = join(root, 'sessions');
    const backupRootDir = join(root, 'backups');
    const databasePath = join(root, 'companion.db');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'channel.jsonl'), '{}\n', 'utf-8');
    writeFileSync(databasePath, 'live-db', 'utf-8');

    const backup = vi.fn(async (path: string) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, 'backup-db', 'utf-8');
    });

    const scheduler = new Scheduler(new EventBus(), {
      tickIntervalMs: 100,
      heartbeatIntervalMs: 1_000,
    });

    registerScheduledBackupTask({
      scheduler,
      db: asDb({ backup }),
      databasePath,
      sessionsDir,
      config: {
        intervalMs: 60_000,
        maxRotatingBackups: 7,
        maxWeeklyBackups: 0,
        maxMonthlyBackups: 0,
        rootDir: backupRootDir,
        mirrorDir: '',
        verifyRestore: false,
      },
      skipFirstRun: false,
    });

    const task = scheduler.getTask(SCHEDULED_BACKUP_TASK_ID);
    expect(task).toBeDefined();
    expect(task?.intervalMs).toBe(60_000);

    await scheduler.tick();
    expect(backup).toHaveBeenCalledTimes(1);
  });
});
