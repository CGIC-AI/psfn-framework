import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../shared/event-bus.js';
import { Scheduler } from '../../core/scheduler/scheduler.js';
import {
  ENCRYPTED_BACKUP_MANIFEST_NAME,
  ENCRYPTED_BACKUP_PAYLOAD_NAME,
  decryptEncryptedBackupPackage,
  type BackupEncryptionRuntimeConfig,
} from './encryption.js';
import {
  SYSTEM_CONFIG_DIR_NAME,
  SYSTEM_CONFIG_MANIFEST_NAME,
  verifySystemConfigSnapshot,
} from './system-config-tree.js';
import {
  registerScheduledBackupTask,
  runBackupCycle,
  SCHEDULED_BACKUP_TASK_ID,
} from './service.js';

const TEST_BACKUP_ENCRYPTION: BackupEncryptionRuntimeConfig = {
  mode: 'required',
  keyRef: {
    kind: 'env',
    envName: 'PSFN_BACKUP_TEST_KEY',
  },
  passphrase: 'test-backup-secret',
};

function makeBackupRuntimeConfig(rootDir: string, verifyRestore = false) {
  return {
    intervalMs: 60_000,
    maxRotatingBackups: 7,
    maxWeeklyBackups: 0,
    maxMonthlyBackups: 0,
    rootDir,
    mirrorDir: '',
    verifyRestore,
    encryption: TEST_BACKUP_ENCRYPTION,
  };
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

function writeRecordingStubPgDump(root: string): {
  stubPath: string;
  argvPath: string;
  pgPasswordPath: string;
} {
  const stubPath = join(root, 'stub-pg-dump-recording.sh');
  const argvPath = join(root, 'pg-dump-argv.txt');
  const pgPasswordPath = join(root, 'pg-dump-pgpassword.txt');
  writeFileSync(
    stubPath,
    [
      '#!/bin/sh',
      `printf '%s\\n' "$@" > '${argvPath}'`,
      `printf '%s' "\${PGPASSWORD:-}" > '${pgPasswordPath}'`,
      'out=""',
      'for arg in "$@"; do case "$arg" in --file=*) out="${arg#--file=}";; esac; done',
      'printf "stub-dump" > "$out"',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return { stubPath, argvPath, pgPasswordPath };
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

function writeSystemOwnerFiles(systemDataDir: string): void {
  mkdirSync(systemDataDir, { recursive: true });
  writeFileSync(join(systemDataDir, 'settings.json'), JSON.stringify({ sessionHistoryBudgetPct: 50 }), 'utf-8');
  writeFileSync(join(systemDataDir, 'models.json'), JSON.stringify({ schemaVersion: 1, models: [] }), 'utf-8');
  writeFileSync(join(systemDataDir, 'backup.json'), JSON.stringify({
    intervalHours: 12,
    maxRotatingBackups: 9,
    maxWeeklyBackups: 2,
    maxMonthlyBackups: 1,
    mirrorDir: '',
    verifyRestore: true,
    encryption: {
      mode: 'required',
      keyRef: {
        kind: 'env',
        envName: 'PSFN_BACKUP_TEST_KEY',
      },
    },
  }), 'utf-8');
  writeFileSync(join(systemDataDir, 'channels.json'), JSON.stringify({
    discord: {
      heartbeatChannelId: 'heartbeat',
    },
  }), 'utf-8');
  writeFileSync(join(systemDataDir, '.env'), 'OPENROUTER_API_KEY=super-secret-env\n', 'utf-8');
}

describe('runBackupCycle', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) {
      rmSync(root, { recursive: true, force: true });
    }
    roots.length = 0;
  });

  it('creates timestamped postgres dump and JSONL snapshots', async () => {
    const root = join(tmpdir(), `psfn-backup-cycle-${Date.now()}`);
    roots.push(root);
    const sessionsDir = join(root, 'sessions');
    const backupRootDir = join(root, 'backups');
    const characterCardPath = join(root, 'companion.json');
    const characterCardHistoryPath = join(root, 'character-card-history.jsonl');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'alpha.jsonl'), '{"id":1}\n', 'utf-8');
    writeFileSync(join(sessionsDir, 'ignored.txt'), 'nope', 'utf-8');
    writeFileSync(characterCardPath, '{"name":"Companion"}\n', 'utf-8');
    writeFileSync(characterCardHistoryPath, '{"version":1}\n', 'utf-8');

    const result = await runBackupCycle({
      postgres: {
        databaseUrl: 'postgresql://psfn:secret@127.0.0.1:5432/psfn',
        pgDumpBinary: writeStubPgDump(root),
      },
      sessionsDir,
      backupRootDir,
      characterCardPath,
      characterCardHistoryPath,
      retentionCount: 7,
      now: () => Date.UTC(2026, 1, 26, 10, 11, 12, 123),
    });

    expect(result.backupDir).toContain('20260226T101112123Z');
    expect(existsSync(result.postgresDumpPath!)).toBe(true);
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
    mkdirSync(sessionsDir, { recursive: true });
    mkdirSync(backupRootDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'channel.jsonl'), '{}\n', 'utf-8');

    for (const dir of ['20260101T000000000Z', '20260102T000000000Z', '20260103T000000000Z']) {
      mkdirSync(join(backupRootDir, dir), { recursive: true });
    }

    await runBackupCycle({
      postgres: {
        databaseUrl: 'postgresql://psfn:secret@127.0.0.1:5432/psfn',
        pgDumpBinary: writeStubPgDump(root),
      },
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

  it('captures a Postgres dump archive', async () => {
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

  it('keeps Postgres credentials out of pg_dump argv and passes the password via PGPASSWORD', async () => {
    const root = join(tmpdir(), `psfn-backup-pg-argv-${Date.now()}`);
    roots.push(root);
    const sessionsDir = join(root, 'sessions');
    const backupRootDir = join(root, 'backups');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'channel.jsonl'), '{}\n', 'utf-8');
    const { stubPath, argvPath, pgPasswordPath } = writeRecordingStubPgDump(root);

    const result = await runBackupCycle({
      postgres: {
        databaseUrl: 'postgresql://psfn:sup3r-secret@127.0.0.1:5432/psfn',
        pgDumpBinary: stubPath,
      },
      sessionsDir,
      backupRootDir,
      now: () => Date.UTC(2026, 1, 26, 10, 11, 12, 123),
    });

    expect(existsSync(result.postgresDumpPath!)).toBe(true);
    const argv = readFileSync(argvPath, 'utf-8');
    expect(argv).not.toContain('sup3r-secret');
    expect(argv).toContain('postgresql://psfn@127.0.0.1:5432/psfn');
    expect(readFileSync(pgPasswordPath, 'utf-8')).toBe('sup3r-secret');
  });

  it('fails closed when the Postgres connection string is not a URL', async () => {
    const root = join(tmpdir(), `psfn-backup-pg-nonurl-${Date.now()}`);
    roots.push(root);
    const sessionsDir = join(root, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });

    await expect(runBackupCycle({
      postgres: {
        databaseUrl: 'host=127.0.0.1 dbname=psfn password=sup3r-secret',
        pgDumpBinary: writeStubPgDump(root),
      },
      sessionsDir,
      backupRootDir: join(root, 'backups'),
      now: () => Date.UTC(2026, 1, 26, 10, 11, 12, 123),
    })).rejects.toThrow('requires a URL connection string');
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

  it('captures and verifies a separate workspace tree with wiki knowledge files', async () => {
    const root = join(tmpdir(), `psfn-backup-workspace-tree-${Date.now()}`);
    roots.push(root);
    const systemDataDir = join(root, 'system-data');
    const companionDataDir = join(root, 'companion-data');
    const workspacePath = join(root, 'workspace');
    const sessionsDir = join(companionDataDir, 'state', 'sessions');
    const backupRootDir = join(root, 'backups');
    mkdirSync(systemDataDir, { recursive: true });
    mkdirSync(sessionsDir, { recursive: true });
    mkdirSync(join(workspacePath, 'knowledge', 'wiki', 'documents'), { recursive: true });
    mkdirSync(join(workspacePath, 'docs'), { recursive: true });
    mkdirSync(join(workspacePath, 'downloads'), { recursive: true });
    mkdirSync(join(workspacePath, 'images'), { recursive: true });
    mkdirSync(join(workspacePath, 'journal'), { recursive: true });
    mkdirSync(join(workspacePath, 'scratchpad'), { recursive: true });
    mkdirSync(join(workspacePath, 'skills'), { recursive: true });
    mkdirSync(join(workspacePath, 'modules'), { recursive: true });
    mkdirSync(join(workspacePath, 'experiments'), { recursive: true });
    mkdirSync(join(workspacePath, '.git'), { recursive: true });
    mkdirSync(join(workspacePath, 'node_modules'), { recursive: true });
    mkdirSync(join(workspacePath, 'tmp'), { recursive: true });
    writeFileSync(join(sessionsDir, 'channel.jsonl'), '{}\n', 'utf-8');
    writeFileSync(join(workspacePath, 'knowledge', 'wiki', 'documents', 'reference.md'), 'wiki reference\n', 'utf-8');
    writeFileSync(join(workspacePath, 'docs', 'personal.md'), 'doc\n', 'utf-8');
    writeFileSync(join(workspacePath, 'downloads', 'article.txt'), 'download\n', 'utf-8');
    writeFileSync(join(workspacePath, 'images', 'saved.png'), 'image\n', 'utf-8');
    writeFileSync(join(workspacePath, 'journal', 'entry.md'), 'journal\n', 'utf-8');
    writeFileSync(join(workspacePath, 'scratchpad', 'scratch.md'), 'scratch\n', 'utf-8');
    writeFileSync(join(workspacePath, 'skills', 'skill.md'), 'skill\n', 'utf-8');
    writeFileSync(join(workspacePath, 'modules', 'module.ts'), 'module\n', 'utf-8');
    writeFileSync(join(workspacePath, 'experiments', 'trial.md'), 'experiment\n', 'utf-8');
    writeFileSync(join(workspacePath, '.git', 'config'), 'git\n', 'utf-8');
    writeFileSync(join(workspacePath, 'node_modules', 'dependency.js'), 'dependency\n', 'utf-8');
    writeFileSync(join(workspacePath, 'tmp', 'temp.txt'), 'temp\n', 'utf-8');

    const result = await runBackupCycle({
      postgres: {
        databaseUrl: 'postgresql://psfn:secret@127.0.0.1:5432/psfn',
        pgDumpBinary: writeStubPgDump(root),
        pgRestoreBinary: writeStubPgRestore(root),
      },
      companionDataDir,
      workspacePath,
      workspaceProtectedPaths: [systemDataDir, companionDataDir, backupRootDir],
      sessionsDir,
      backupRootDir,
      verifyRestore: true,
      now: () => Date.UTC(2026, 5, 28, 10, 11, 12, 123),
    });

    expect(result.workspaceTree).toBeDefined();
    expect(result.workspaceTree?.fileCount).toBe(9);
    expect(existsSync(join(result.workspaceTree!.treeDir, 'knowledge', 'wiki', 'documents', 'reference.md'))).toBe(true);
    expect(existsSync(join(result.workspaceTree!.treeDir, 'docs', 'personal.md'))).toBe(true);
    expect(existsSync(join(result.workspaceTree!.treeDir, '.git'))).toBe(false);
    expect(existsSync(join(result.workspaceTree!.treeDir, 'node_modules'))).toBe(false);
    expect(existsSync(join(result.workspaceTree!.treeDir, 'tmp'))).toBe(false);
    expect(result.workspaceTree?.excludedPaths).toEqual(expect.arrayContaining([
      '.git',
      'node_modules',
      'tmp',
    ]));
    expect(result.workspaceTreeVerification?.verifiedFileCount).toBe(9);
  });

  it('captures and verifies system-data owner JSON files without broad env capture', async () => {
    const root = join(tmpdir(), `psfn-backup-system-config-${Date.now()}`);
    roots.push(root);
    const systemDataDir = join(root, 'system-data');
    const sessionsDir = join(root, 'sessions');
    const backupRootDir = join(root, 'backups');
    writeSystemOwnerFiles(systemDataDir);
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'channel.jsonl'), '{}\n', 'utf-8');

    const result = await runBackupCycle({
      postgres: {
        databaseUrl: 'postgresql://psfn:secret@127.0.0.1:5432/psfn',
        pgDumpBinary: writeStubPgDump(root),
        pgRestoreBinary: writeStubPgRestore(root),
      },
      systemDataDir,
      sessionsDir,
      backupRootDir,
      verifyRestore: true,
      now: () => Date.UTC(2026, 5, 28, 11, 12, 13, 123),
    });

    expect(result.systemConfig).toBeDefined();
    expect(result.systemConfig?.fileCount).toBe(4);
    expect(result.systemConfigVerification?.verifiedFileCount).toBe(4);
    expect(existsSync(join(result.backupDir, SYSTEM_CONFIG_MANIFEST_NAME))).toBe(true);
    expect(existsSync(join(result.backupDir, SYSTEM_CONFIG_DIR_NAME, 'settings.json'))).toBe(true);
    expect(existsSync(join(result.backupDir, SYSTEM_CONFIG_DIR_NAME, '.env'))).toBe(false);
    expect(verifySystemConfigSnapshot(result.backupDir).verifiedFileCount).toBe(4);
  });

  it('fails closed when a system-data owner file is malformed', async () => {
    const root = join(tmpdir(), `psfn-backup-system-config-invalid-${Date.now()}`);
    roots.push(root);
    const systemDataDir = join(root, 'system-data');
    const sessionsDir = join(root, 'sessions');
    mkdirSync(systemDataDir, { recursive: true });
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(systemDataDir, 'settings.json'), '{"broken":', 'utf-8');
    writeFileSync(join(sessionsDir, 'channel.jsonl'), '{}\n', 'utf-8');

    await expect(runBackupCycle({
      postgres: {
        databaseUrl: 'postgresql://psfn:secret@127.0.0.1:5432/psfn',
        pgDumpBinary: writeStubPgDump(root),
      },
      systemDataDir,
      sessionsDir,
      backupRootDir: join(root, 'backups'),
      now: () => Date.UTC(2026, 5, 28, 11, 12, 13, 123),
    })).rejects.toThrow('System config owner file settings.json is not valid JSON');
  });

  it('stores sensitive backup snapshots as encrypted packages when encryption is configured', async () => {
    const root = join(tmpdir(), `psfn-backup-encrypted-${Date.now()}`);
    roots.push(root);
    const systemDataDir = join(root, 'system-data');
    const companionDataDir = join(root, 'companion-data');
    const sessionsDir = join(companionDataDir, 'state', 'sessions');
    const backupRootDir = join(root, 'backups');
    const decryptDir = join(root, 'decrypted');
    writeSystemOwnerFiles(systemDataDir);
    mkdirSync(sessionsDir, { recursive: true });
    mkdirSync(join(companionDataDir, 'journal'), { recursive: true });
    writeFileSync(join(sessionsDir, 'channel.jsonl'), '{}\n', 'utf-8');
    writeFileSync(join(companionDataDir, 'journal', 'private.md'), 'memory and chat are sensitive\n', 'utf-8');

    const result = await runBackupCycle({
      postgres: {
        databaseUrl: 'postgresql://psfn:secret@127.0.0.1:5432/psfn',
        pgDumpBinary: writeStubPgDump(root),
        pgRestoreBinary: writeStubPgRestore(root),
      },
      systemDataDir,
      companionDataDir,
      sessionsDir,
      backupRootDir,
      verifyRestore: true,
      encryption: TEST_BACKUP_ENCRYPTION,
      now: () => Date.UTC(2026, 5, 28, 12, 13, 14, 123),
    });

    expect(result.encryptedBackup).toBeDefined();
    expect(result.postgresDumpVerification?.tocEntryCount).toBe(2);
    expect(result.systemConfigVerification?.verifiedFileCount).toBe(4);
    expect(existsSync(join(result.backupDir, ENCRYPTED_BACKUP_MANIFEST_NAME))).toBe(true);
    expect(existsSync(join(result.backupDir, ENCRYPTED_BACKUP_PAYLOAD_NAME))).toBe(true);
    expect(existsSync(join(result.backupDir, 'database'))).toBe(false);
    expect(existsSync(join(result.backupDir, 'sessions'))).toBe(false);
    expect(existsSync(join(result.backupDir, SYSTEM_CONFIG_DIR_NAME))).toBe(false);

    await decryptEncryptedBackupPackage({
      encryptedBackupDir: result.backupDir,
      outputDir: decryptDir,
      encryption: TEST_BACKUP_ENCRYPTION,
    });
    expect(existsSync(join(decryptDir, 'database', 'psfn.dump'))).toBe(true);
    expect(existsSync(join(decryptDir, 'sessions', 'channel.jsonl'))).toBe(true);
    expect(existsSync(join(decryptDir, SYSTEM_CONFIG_DIR_NAME, 'settings.json'))).toBe(true);
    expect(existsSync(join(decryptDir, SYSTEM_CONFIG_DIR_NAME, '.env'))).toBe(false);
    expect(readFileSync(join(decryptDir, 'companion-tree', 'journal', 'private.md'), 'utf-8'))
      .toBe('memory and chat are sensitive\n');
  });

  it('fails closed when workspace backup root overlaps protected runtime or backup paths', async () => {
    const root = join(tmpdir(), `psfn-backup-workspace-overlap-${Date.now()}`);
    roots.push(root);
    const sessionsDir = join(root, 'companion-data', 'state', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });

    await expect(runBackupCycle({
      postgres: {
        databaseUrl: 'postgresql://psfn:secret@127.0.0.1:5432/psfn',
        pgDumpBinary: writeStubPgDump(root),
      },
      workspacePath: root,
      workspaceProtectedPaths: [join(root, 'system-data'), join(root, 'companion-data')],
      sessionsDir,
      backupRootDir: join(root, 'backups'),
      now: () => Date.UTC(2026, 5, 28, 10, 11, 12, 123),
    })).rejects.toThrow('Workspace backup root');
  });

  it('fails closed when workspace backup root overlaps systemDataDir without explicit protected paths', async () => {
    const root = join(tmpdir(), `psfn-backup-workspace-systemdata-overlap-${Date.now()}`);
    roots.push(root);
    const systemDataDir = join(root, 'system-data');
    const sessionsDir = join(root, 'companion-data', 'state', 'sessions');
    mkdirSync(systemDataDir, { recursive: true });
    mkdirSync(sessionsDir, { recursive: true });

    await expect(runBackupCycle({
      postgres: {
        databaseUrl: 'postgresql://psfn:secret@127.0.0.1:5432/psfn',
        pgDumpBinary: writeStubPgDump(root),
      },
      workspacePath: join(systemDataDir, 'workspace'),
      systemDataDir,
      sessionsDir,
      backupRootDir: join(root, 'backups'),
      now: () => Date.UTC(2026, 5, 28, 10, 11, 12, 123),
    })).rejects.toThrow('Workspace backup root');
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
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'channel.jsonl'), '{}\n', 'utf-8');

    const scheduler = new Scheduler(new EventBus(), {
      tickIntervalMs: 100,
      heartbeatIntervalMs: 1_000,
    });

    registerScheduledBackupTask({
      scheduler,
      postgres: {
        databaseUrl: 'postgresql://psfn:secret@127.0.0.1:5432/psfn',
        pgDumpBinary: writeStubPgDump(root),
      },
      sessionsDir,
      config: makeBackupRuntimeConfig(backupRootDir),
      skipFirstRun: false,
    });

    const task = scheduler.getTask(SCHEDULED_BACKUP_TASK_ID);
    expect(task).toBeDefined();
    expect(task?.intervalMs).toBe(60_000);

    await scheduler.tick();
    expect(readdirSync(backupRootDir)).toHaveLength(1);
  });

  it('throws at registration when no database backup source is configured', () => {
    const scheduler = new Scheduler(new EventBus(), {
      tickIntervalMs: 100,
      heartbeatIntervalMs: 1_000,
    });

    expect(() => registerScheduledBackupTask({
      scheduler,
      sessionsDir: '/tmp/nowhere',
      config: makeBackupRuntimeConfig('/tmp/nowhere-backups'),
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
      config: makeBackupRuntimeConfig(join(root, 'backups')),
      skipFirstRun: false,
      onBackupFailure,
    });

    await scheduler.tick();
    expect(onBackupFailure).toHaveBeenCalledTimes(1);
    expect(String(onBackupFailure.mock.calls[0]?.[0])).toContain('pg_dump failed');
  });
});
