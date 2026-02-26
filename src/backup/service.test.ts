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
    const databasePath = join(root, 'purrsephone.db');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'alpha.jsonl'), '{"id":1}\n', 'utf-8');
    writeFileSync(join(sessionsDir, 'ignored.txt'), 'nope', 'utf-8');
    writeFileSync(databasePath, 'live-db', 'utf-8');

    const backup = vi.fn(async (path: string) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, 'backup-db', 'utf-8');
    });

    const result = await runBackupCycle({
      db: asDb({ backup }),
      databasePath,
      sessionsDir,
      backupRootDir,
      retentionCount: 7,
      now: () => Date.UTC(2026, 1, 26, 10, 11, 12, 123),
    });

    expect(backup).toHaveBeenCalledTimes(1);
    expect(result.backupDir).toContain('20260226T101112123Z');
    expect(existsSync(result.databaseBackupPath)).toBe(true);
    expect(existsSync(join(result.sessionSnapshotDir, 'alpha.jsonl'))).toBe(true);
    expect(existsSync(join(result.sessionSnapshotDir, 'ignored.txt'))).toBe(false);
    expect(result.copiedSessionFiles).toEqual(['alpha.jsonl']);
    expect(result.prunedBackupDirs).toEqual([]);
  });

  it('prunes old backup directories by retention count', async () => {
    const root = join(tmpdir(), `psfn-backup-retention-${Date.now()}`);
    roots.push(root);
    const sessionsDir = join(root, 'sessions');
    const backupRootDir = join(root, 'backups');
    const databasePath = join(root, 'purrsephone.db');
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
      retentionCount: 2,
      now: () => Date.UTC(2026, 1, 26, 10, 11, 12, 123),
    });

    const remaining = readdirSync(backupRootDir).sort((a, b) => a.localeCompare(b));
    expect(remaining).toEqual(['20260103T000000000Z', '20260226T101112123Z']);
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
    const databasePath = join(root, 'purrsephone.db');
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
        retentionCount: 7,
        rootDir: backupRootDir,
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
