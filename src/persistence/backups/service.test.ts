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
import { EventBus } from '../../shared/event-bus.js';
import { Scheduler } from '../../core/scheduler/scheduler.js';
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

function writeStubPgDump(root: string): string {
  const stubPath = join(root, 'stub-pg-dump.sh');
  writeFileSync(
    stubPath,
    '#!/bin/sh\nout=""\nfor arg in "$@"; do case "$arg" in --file=*) out="${arg#--file=}";; esac; done\nprintf "stub-dump" > "$out"\n',
    { mode: 0o755 },
  );
  return stubPath;
}

function writeFailingStubPgDump(root: string): string {
  const stubPath = join(root, 'stub-pg-dump-fail.sh');
  writeFileSync(
    stubPath,
    '#!/bin/sh\necho "connection to server failed" >&2\nexit 1\n',
    { mode: 0o755 },
  );
  return stubPath;
}

function writeStubPgRestore(root: string): string {
  const stubPath = join(root, 'stub-pg-restore.sh');
  writeFileSync(
    stubPath,
    '#!/bin/sh\necho ";"\necho "1; 0 100 TABLE public l2_memories psfn"\necho "2; 0 101 TABLE public reflections psfn"\n',
    { mode: 0o755 },
  );
  return stubPath;
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
    const characterCardPath = join(root, 'companion.json');
    const characterCardHistoryPath = join(root, 'character-card-history.jsonl');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'alpha.jsonl'), '{"id":1}\n', 'utf-8');
    writeFileSync(join(sessionsDir, 'ignored.txt'), 'nope', 'utf-8');
    writeFileSync(databasePath, 'live-db', 'utf-8');
    writeFileSync(characterCardPath, '{"name":"Companion"}\n', 'utf-8');
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
    expect(existsSync(join(result.backupDir, 'companion', 'companion.json'))).toBe(true);
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

  it('captures a Postgres dump archive without a SQLite handle', async () => {
    const root = join(tmpdir(), `psfn-backup-pg-${Date.now()}`);
    roots.push(root);
    const sessionsDir = join(root, 'sessions');
    const backupRootDir = join(root, 'backups');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'channel.jsonl'), '{}\n', 'utf-8');

    const result = await runBackupCycle({
      postgres: {
        databaseUrl: 'postgresql://psfn:secret@127.0.0.1:5432/psfn',
        pgDumpBinary: writeStubPgDump(root),
      },
      sessionsDir,
      backupRootDir,
      maxRotatingBackups: 7,
      maxWeeklyBackups: 0,
      maxMonthlyBackups: 0,
      now: () => Date.UTC(2026, 1, 26, 10, 11, 12, 123),
    });

    expect(result.databaseBackupPath).toBeUndefined();
    expect(result.postgresDumpPath).toBeDefined();
    expect(result.postgresDumpPath).toContain(join('database', 'psfn.dump'));
    expect(existsSync(result.postgresDumpPath!)).toBe(true);
    expect(result.copiedSessionFiles).toEqual(['channel.jsonl']);
  });

  it('verifies the Postgres dump archive table of contents when enabled', async () => {
    const root = join(tmpdir(), `psfn-backup-pg-verify-${Date.now()}`);
    roots.push(root);
    const sessionsDir = join(root, 'sessions');
    const backupRootDir = join(root, 'backups');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'channel.jsonl'), '{}\n', 'utf-8');

    const result = await runBackupCycle({
      postgres: {
        databaseUrl: 'postgresql://psfn:secret@127.0.0.1:5432/psfn',
        pgDumpBinary: writeStubPgDump(root),
        pgRestoreBinary: writeStubPgRestore(root),
      },
      sessionsDir,
      backupRootDir,
      verifyRestore: true,
      now: () => Date.UTC(2026, 1, 26, 10, 11, 12, 123),
    });

    expect(result.postgresDumpVerification).toBeDefined();
    expect(result.postgresDumpVerification?.tocEntryCount).toBe(2);
  });

  it('fails closed when pg_dump fails', async () => {
    const root = join(tmpdir(), `psfn-backup-pg-fail-${Date.now()}`);
    roots.push(root);
    const sessionsDir = join(root, 'sessions');
    const backupRootDir = join(root, 'backups');
    mkdirSync(sessionsDir, { recursive: true });

    await expect(runBackupCycle({
      postgres: {
        databaseUrl: 'postgresql://psfn:secret@127.0.0.1:5432/psfn',
        pgDumpBinary: writeFailingStubPgDump(root),
      },
      sessionsDir,
      backupRootDir,
      now: () => Date.UTC(2026, 1, 26, 10, 11, 12, 123),
    })).rejects.toThrow(/pg_dump failed.*connection to server failed/s);
  });

  it('captures and verifies the companion file tree when companionDataDir is set', async () => {
    const root = join(tmpdir(), `psfn-backup-tree-${Date.now()}`);
    roots.push(root);
    const companionDataDir = join(root, 'companion-data');
    const sessionsDir = join(companionDataDir, 'state', 'sessions');
    const backupRootDir = join(root, 'backups');
    mkdirSync(sessionsDir, { recursive: true });
    mkdirSync(join(companionDataDir, 'vault'), { recursive: true });
    mkdirSync(join(companionDataDir, 'images'), { recursive: true });
    writeFileSync(join(sessionsDir, 'channel.jsonl'), '{}\n', 'utf-8');
    writeFileSync(join(companionDataDir, 'companion.json'), '{"name":"Companion"}\n', 'utf-8');
    writeFileSync(join(companionDataDir, 'vault', 'note.md'), 'note\n', 'utf-8');
    writeFileSync(join(companionDataDir, 'images', 'selfie.png'), 'png', 'utf-8');

    const result = await runBackupCycle({
      postgres: {
        databaseUrl: 'postgresql://psfn:secret@127.0.0.1:5432/psfn',
        pgDumpBinary: writeStubPgDump(root),
        pgRestoreBinary: writeStubPgRestore(root),
      },
      companionDataDir,
      sessionsDir,
      backupRootDir,
      verifyRestore: true,
      now: () => Date.UTC(2026, 1, 26, 10, 11, 12, 123),
    });

    expect(result.companionTree).toBeDefined();
    expect(result.companionTree?.fileCount).toBe(3);
    expect(existsSync(join(result.companionTree!.treeDir, 'vault', 'note.md'))).toBe(true);
    expect(existsSync(join(result.companionTree!.treeDir, 'images', 'selfie.png'))).toBe(true);
    expect(existsSync(join(result.companionTree!.treeDir, 'state', 'sessions'))).toBe(false);
    expect(result.companionTreeVerification?.verifiedFileCount).toBe(3);
  });

  it('refuses to run without any database backup source', async () => {
    const root = join(tmpdir(), `psfn-backup-no-source-${Date.now()}`);
    roots.push(root);
    const sessionsDir = join(root, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });

    await expect(runBackupCycle({
      sessionsDir,
      backupRootDir: join(root, 'backups'),
    })).rejects.toThrow('refusing to capture a database-less backup');
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

  it('throws at registration when no database backup source is configured', () => {
    const scheduler = new Scheduler(new EventBus(), {
      tickIntervalMs: 100,
      heartbeatIntervalMs: 1_000,
    });

    expect(() => registerScheduledBackupTask({
      scheduler,
      sessionsDir: '/tmp/nowhere',
      config: {
        intervalMs: 60_000,
        maxRotatingBackups: 7,
        maxWeeklyBackups: 0,
        maxMonthlyBackups: 0,
        rootDir: '/tmp/nowhere-backups',
        mirrorDir: '',
        verifyRestore: false,
      },
    })).toThrow('Scheduled backups require');
  });

  it('invokes onBackupFailure when a scheduled backup cycle fails', async () => {
    const root = join(tmpdir(), `psfn-backup-scheduler-fail-${Date.now()}`);
    roots.push(root);
    const sessionsDir = join(root, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });

    const scheduler = new Scheduler(new EventBus(), {
      tickIntervalMs: 100,
      heartbeatIntervalMs: 1_000,
    });
    const onBackupFailure = vi.fn();

    registerScheduledBackupTask({
      scheduler,
      postgres: {
        databaseUrl: 'postgresql://psfn:secret@127.0.0.1:5432/psfn',
        pgDumpBinary: writeFailingStubPgDump(root),
      },
      sessionsDir,
      config: {
        intervalMs: 60_000,
        maxRotatingBackups: 7,
        maxWeeklyBackups: 0,
        maxMonthlyBackups: 0,
        rootDir: join(root, 'backups'),
        mirrorDir: '',
        verifyRestore: false,
      },
      skipFirstRun: false,
      onBackupFailure,
    });

    await scheduler.tick();
    expect(onBackupFailure).toHaveBeenCalledTimes(1);
    expect(String(onBackupFailure.mock.calls[0]?.[0])).toContain('pg_dump failed');
  });
});
