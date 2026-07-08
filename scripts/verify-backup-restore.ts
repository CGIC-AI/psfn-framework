import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ensureRepositoryBackupRestoreFixture } from './backup-restore-fixture.js';
import {
  verifyPostgresDumpArchive,
} from '../src/persistence/backups/service.js';
import {
  COMPANION_TREE_MANIFEST_NAME,
  WORKSPACE_TREE_MANIFEST_NAME,
  verifyCompanionTreeSnapshot,
  verifyWorkspaceTreeSnapshot,
} from '../src/persistence/backups/companion-tree.js';
import {
  ENCRYPTED_BACKUP_MANIFEST_NAME,
  decryptEncryptedBackupToTemp,
  readEncryptedBackupManifest,
  resolveBackupEncryptionFromManifest,
} from '../src/persistence/backups/encryption.js';
import { verifyPostgresDumpRestore } from '../src/persistence/backups/postgres-restore.js';
import {
  SYSTEM_CONFIG_MANIFEST_NAME,
  verifySystemConfigSnapshot,
} from '../src/persistence/backups/system-config-tree.js';

interface CliArgs {
  backupRootDir?: string;
  backupDir?: string;
  restoreScratchRootDir?: string;
  keepRestoreDir: boolean;
  postgresRestoreUrl?: string;
  postgresSourceUrl?: string;
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
      '  --postgres-restore-url <url>  Scratch database URL for full pg_restore fidelity verification (schema is wiped each run)',
      '  --postgres-source-url <url>   Source database URL for restored-vs-source row count assertions',
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
    if (arg === '--postgres-restore-url') {
      const value = argv[index + 1];
      if (!value) throw new Error('--postgres-restore-url requires a value');
      args.postgresRestoreUrl = value;
      index += 1;
      continue;
    }
    if (arg === '--postgres-source-url') {
      const value = argv[index + 1];
      if (!value) throw new Error('--postgres-source-url requires a value');
      args.postgresSourceUrl = value;
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
  postgresDumpPath?: string;
}

function resolveDatabaseSnapshotPaths(backupDir: string): DatabaseSnapshotPaths {
  const databaseDir = join(backupDir, 'database');
  if (!existsSync(databaseDir)) {
    return {};
  }

  const candidates = readdirSync(databaseDir, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b));

  if (candidates.length === 0) {
    throw new Error(`No database snapshot file found in ${databaseDir}`);
  }

  const postgresDump = candidates.find(name => name.endsWith('.dump'));
  const unsupportedSnapshots = candidates.filter(name => !name.endsWith('.dump'));
  if (unsupportedSnapshots.length > 0) {
    throw new Error(
      `Unsupported legacy database snapshot(s) in ${databaseDir}: ${unsupportedSnapshots.join(', ')}. `
      + 'SQLite backup verification is retired; current backups must use Postgres dump archives and/or tree manifests.',
    );
  }
  return {
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
  const requestedBackupDir = resolve(args.backupDir ?? resolveLatestBackupDir(backupRootDir!));
  const encryptedManifestPath = join(requestedBackupDir, ENCRYPTED_BACKUP_MANIFEST_NAME);
  const encryptedManifest = existsSync(encryptedManifestPath)
    ? readEncryptedBackupManifest(requestedBackupDir)
    : undefined;
  const decrypted = encryptedManifest
    ? await decryptEncryptedBackupToTemp(
      requestedBackupDir,
      resolveBackupEncryptionFromManifest(encryptedManifest),
    )
    : undefined;
  const backupDir = decrypted?.decryptedBackupDir ?? requestedBackupDir;
  try {
    const { postgresDumpPath } = resolveDatabaseSnapshotPaths(backupDir);
    const sessionSnapshotDir = join(backupDir, 'sessions');
    const expectedSessionFiles = listSessionSnapshotFiles(sessionSnapshotDir);

    const postgresDumpVerification = postgresDumpPath
      ? await verifyPostgresDumpArchive(postgresDumpPath)
      : undefined;

    if (args.postgresRestoreUrl && !postgresDumpPath) {
      throw new Error('--postgres-restore-url was provided but the backup contains no Postgres dump');
    }
    const postgresRestoreVerification = postgresDumpPath && args.postgresRestoreUrl
      ? await verifyPostgresDumpRestore({
        dumpPath: postgresDumpPath,
        scratchDatabaseUrl: args.postgresRestoreUrl,
        sourceDatabaseUrl: args.postgresSourceUrl,
      })
      : undefined;

    const companionTreeVerification = existsSync(join(backupDir, COMPANION_TREE_MANIFEST_NAME))
      ? verifyCompanionTreeSnapshot(backupDir)
      : undefined;
    const workspaceTreeVerification = existsSync(join(backupDir, WORKSPACE_TREE_MANIFEST_NAME))
      ? verifyWorkspaceTreeSnapshot(backupDir)
      : undefined;
    const systemConfigVerification = existsSync(join(backupDir, SYSTEM_CONFIG_MANIFEST_NAME))
      ? verifySystemConfigSnapshot(backupDir)
      : undefined;

    console.log(JSON.stringify({
      backupDir: requestedBackupDir,
      ...(encryptedManifest
        ? {
          encrypted: true,
          decryptedBackupDir: backupDir,
        }
        : { encrypted: false }),
      sessionSnapshotDir,
      expectedSessionFiles: expectedSessionFiles.length,
      verified: true,
      ...(postgresDumpPath
        ? {
          postgresDumpPath,
          postgresDumpTocEntries: postgresDumpVerification?.tocEntryCount,
        }
        : {}),
      ...(postgresRestoreVerification
        ? {
          postgresRestoredTables: postgresRestoreVerification.restoredTableCount,
          postgresVectorExtension: postgresRestoreVerification.vectorExtensionPresent,
          postgresVectorColumnChecked: postgresRestoreVerification.vectorColumnChecked,
          postgresTableCounts: postgresRestoreVerification.tableCounts,
        }
        : {}),
      ...(companionTreeVerification
        ? {
          companionTreeVerifiedFiles: companionTreeVerification.verifiedFileCount,
          companionTreeBytes: companionTreeVerification.totalBytes,
        }
        : {}),
      ...(workspaceTreeVerification
        ? {
          workspaceTreeVerifiedFiles: workspaceTreeVerification.verifiedFileCount,
          workspaceTreeBytes: workspaceTreeVerification.totalBytes,
        }
        : {}),
      ...(systemConfigVerification
        ? {
          systemConfigVerifiedFiles: systemConfigVerification.verifiedFileCount,
          systemConfigBytes: systemConfigVerification.totalBytes,
        }
        : {}),
    }, null, 2));
  } finally {
    decrypted?.cleanup();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[verify-backup-restore] ${message}`);
  process.exit(1);
});
