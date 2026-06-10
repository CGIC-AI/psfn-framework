import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ensureRepositoryBackupRestoreFixture } from './backup-restore-fixture.js';
import {
  verifyBackupRestore,
  verifyPostgresDumpArchive,
} from '../src/persistence/backups/service.js';
import {
  COMPANION_TREE_MANIFEST_NAME,
  verifyCompanionTreeSnapshot,
} from '../src/persistence/backups/companion-tree.js';

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
      '  --backup-root <path>          Root backup directory (default: BACKUP_ROOT_DIR or an auto-generated repo fixture)',
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

function resolveDefaultBackupRootDir(args: CliArgs): string {
  if (args.backupRootDir) {
    return resolve(args.backupRootDir);
  }

  const envBackupRootDir = process.env.BACKUP_ROOT_DIR?.trim();
  if (envBackupRootDir) {
    return resolve(envBackupRootDir);
  }

  return ensureRepositoryBackupRestoreFixture();
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

interface DatabaseSnapshotPaths {
  sqlitePath?: string;
  postgresDumpPath?: string;
}

function resolveDatabaseSnapshotPaths(backupDir: string): DatabaseSnapshotPaths {
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

  const postgresDump = candidates.find(name => name.endsWith('.dump'));
  const sqliteSnapshot = candidates.find(name => !name.endsWith('.dump'));
  return {
    ...(sqliteSnapshot ? { sqlitePath: join(databaseDir, sqliteSnapshot) } : {}),
    ...(postgresDump ? { postgresDumpPath: join(databaseDir, postgresDump) } : {}),
  };
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const backupRootDir = args.backupDir ? undefined : resolveDefaultBackupRootDir(args);
  const backupDir = resolve(args.backupDir ?? resolveLatestBackupDir(backupRootDir!));
  const { sqlitePath, postgresDumpPath } = resolveDatabaseSnapshotPaths(backupDir);
  const sessionSnapshotDir = join(backupDir, 'sessions');
  const expectedSessionFiles = listSessionSnapshotFiles(sessionSnapshotDir);

  const sqliteVerification = sqlitePath
    ? verifyBackupRestore({
      databaseBackupPath: sqlitePath,
      sessionSnapshotDir,
      expectedSessionFiles,
      restoreScratchRootDir: args.restoreScratchRootDir ? resolve(args.restoreScratchRootDir) : undefined,
      cleanupRestoreDir: !args.keepRestoreDir,
    })
    : undefined;

  const postgresDumpVerification = postgresDumpPath
    ? await verifyPostgresDumpArchive(postgresDumpPath)
    : undefined;

  const companionTreeVerification = existsSync(join(backupDir, COMPANION_TREE_MANIFEST_NAME))
    ? verifyCompanionTreeSnapshot(backupDir)
    : undefined;

  console.log(JSON.stringify({
    backupDir,
    sessionSnapshotDir,
    expectedSessionFiles: expectedSessionFiles.length,
    verified: true,
    ...(sqlitePath
      ? {
        databaseBackupPath: sqlitePath,
        integrityDetails: sqliteVerification?.integrityDetails,
        restoreDir: sqliteVerification?.restoreDir,
        cleanupRestoreDir: sqliteVerification?.cleanupRestoreDir,
      }
      : {}),
    ...(postgresDumpPath
      ? {
        postgresDumpPath,
        postgresDumpTocEntries: postgresDumpVerification?.tocEntryCount,
      }
      : {}),
    ...(companionTreeVerification
      ? {
        companionTreeVerifiedFiles: companionTreeVerification.verifiedFileCount,
        companionTreeBytes: companionTreeVerification.totalBytes,
      }
      : {}),
  }, null, 2));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[verify-backup-restore] ${message}`);
  process.exit(1);
});
