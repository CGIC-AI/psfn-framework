import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { verifyBackupRestore } from '../src/backup/service.js';

interface CliArgs {
  backupRootDir?: string;
  backupDir?: string;
  restoreScratchRootDir?: string;
  keepRestoreDir: boolean;
}

function printUsage(): void {
  console.log(
    [
      'Usage: tsx scripts/verify-backup-restore.ts [options]',
      '',
      'Options:',
      '  --backup-root <path>          Root backup directory (default: BACKUP_ROOT_DIR or ./data/backups)',
      '  --backup-dir <path>           Exact backup snapshot directory to verify',
      '  --restore-scratch-root <path> Root for temporary restore rehearsal directory',
      '  --keep-restore-dir            Preserve restore rehearsal directory for inspection',
      '  --help                        Show this help text',
    ].join('\n'),
  );
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { keepRestoreDir: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help') {
      printUsage();
      process.exit(0);
    }
    if (arg === '--keep-restore-dir') {
      args.keepRestoreDir = true;
      continue;
    }
    if (arg === '--backup-root') {
      const value = argv[index + 1];
      if (!value) throw new Error('--backup-root requires a value');
      args.backupRootDir = value;
      index += 1;
      continue;
    }
    if (arg === '--backup-dir') {
      const value = argv[index + 1];
      if (!value) throw new Error('--backup-dir requires a value');
      args.backupDir = value;
      index += 1;
      continue;
    }
    if (arg === '--restore-scratch-root') {
      const value = argv[index + 1];
      if (!value) throw new Error('--restore-scratch-root requires a value');
      args.restoreScratchRootDir = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function resolveLatestBackupDir(backupRootDir: string): string {
  if (!existsSync(backupRootDir)) {
    throw new Error(`Backup root does not exist: ${backupRootDir}`);
  }

  const candidates = readdirSync(backupRootDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b));

  if (candidates.length === 0) {
    throw new Error(`No backup snapshots found under ${backupRootDir}`);
  }

  return join(backupRootDir, candidates[candidates.length - 1]);
}

function resolveDatabaseSnapshotPath(backupDir: string): string {
  const databaseDir = join(backupDir, 'database');
  if (!existsSync(databaseDir)) {
    throw new Error(`Backup database directory missing: ${databaseDir}`);
  }

  const candidates = readdirSync(databaseDir, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b));

  if (candidates.length === 0) {
    throw new Error(`No database snapshot file found in ${databaseDir}`);
  }

  return join(databaseDir, candidates[0]);
}

function listSessionSnapshotFiles(sessionSnapshotDir: string): string[] {
  if (!existsSync(sessionSnapshotDir)) {
    throw new Error(`Backup session snapshot directory missing: ${sessionSnapshotDir}`);
  }
  return readdirSync(sessionSnapshotDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const backupDir = resolve(args.backupDir ?? resolveLatestBackupDir(
    resolve(args.backupRootDir ?? process.env.BACKUP_ROOT_DIR ?? './data/backups'),
  ));
  const databaseBackupPath = resolveDatabaseSnapshotPath(backupDir);
  const sessionSnapshotDir = join(backupDir, 'sessions');
  const expectedSessionFiles = listSessionSnapshotFiles(sessionSnapshotDir);

  const verification = verifyBackupRestore({
    databaseBackupPath,
    sessionSnapshotDir,
    expectedSessionFiles,
    restoreScratchRootDir: args.restoreScratchRootDir ? resolve(args.restoreScratchRootDir) : undefined,
    cleanupRestoreDir: !args.keepRestoreDir,
  });

  console.log(JSON.stringify({
    backupDir,
    databaseBackupPath,
    sessionSnapshotDir,
    expectedSessionFiles: expectedSessionFiles.length,
    verified: true,
    integrityDetails: verification.integrityDetails,
    restoreDir: verification.restoreDir,
    cleanupRestoreDir: verification.cleanupRestoreDir,
  }, null, 2));
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[verify-backup-restore] ${message}`);
  process.exit(1);
}
