import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, join, relative, resolve } from 'node:path';
import type { ResolvedCompanionsFleetConfig } from '../../system/config/companions-config.js';
import { writeJsonAtomic } from '../../shared/utils/fs.js';
import { isRecord } from '../../shared/utils/types.js';

export const LEGACY_WORKSPACE_COMPANION_ID_ENV = 'PSFN_LEGACY_WORKSPACE_COMPANION_ID';
export const LEGACY_WORKSPACE_SHA256_ENV = 'PSFN_LEGACY_WORKSPACE_SHA256';

interface MigrationReceipt {
  schemaVersion: 1;
  companionId: string;
  sourcePath: string;
  destinationPath: string;
  sourceSha256: string;
  sourceEntries: LegacyWorkspaceTreeEntry[];
  migratedAt: string;
  sourceRetained: true;
}

type LegacyWorkspaceTreeEntry =
  | { kind: 'directory'; path: string }
  | { kind: 'file'; path: string; size: number; sha256: string };

interface WorkspaceDirectoryIdentity {
  realPath: string;
  device: string;
  inode: string;
}

function requireDigest(value: string | undefined): string {
  const digest = value?.trim() ?? '';
  if (!/^[0-9a-f]{64}$/u.test(digest)) {
    throw new Error(
      `${LEGACY_WORKSPACE_SHA256_ENV} must be the exact lowercase SHA-256 tree digest printed by the migration check`,
    );
  }
  return digest;
}

function inspectTree(root: string): LegacyWorkspaceTreeEntry[] {
  const results: LegacyWorkspaceTreeEntry[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const absolutePath = join(directory, entry.name);
      const relativePath = relative(root, absolutePath).replace(/\\/g, '/');
      const stat = lstatSync(absolutePath);
      if (stat.isSymbolicLink()) {
        throw new Error(`Legacy workspace migration rejects symbolic links: ${absolutePath}`);
      }
      if (stat.isDirectory()) {
        results.push({ kind: 'directory', path: relativePath });
        visit(absolutePath);
      } else if (stat.isFile()) {
        results.push({
          kind: 'file',
          path: relativePath,
          size: stat.size,
          sha256: createHash('sha256').update(readFileSync(absolutePath)).digest('hex'),
        });
      } else {
        throw new Error(`Legacy workspace migration rejects non-file entry: ${absolutePath}`);
      }
    }
  };
  visit(root);
  return results;
}

function hashLegacyWorkspaceEntries(entries: readonly LegacyWorkspaceTreeEntry[]): string {
  const hash = createHash('sha256');
  for (const entry of entries) {
    hash.update(entry.kind === 'directory'
      ? `d\0${entry.path}\0`
      : `f\0${entry.path}\0${entry.size}\0${entry.sha256}\0`, 'utf8');
  }
  return hash.digest('hex');
}

/** Deterministic content-and-path digest used for explicit operator approval. */
export function hashLegacyWorkspaceTree(rootPath: string): string {
  const root = resolve(rootPath);
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`Legacy workspace migration source must be a real directory: ${root}`);
  }
  return hashLegacyWorkspaceEntries(inspectTree(root));
}

function isTreeEntry(value: unknown): value is LegacyWorkspaceTreeEntry {
  if (!isRecord(value)
    || (value.kind !== 'directory' && value.kind !== 'file')
    || typeof value.path !== 'string'
    || !value.path
    || value.path.startsWith('/')
    || value.path === '..'
    || value.path.startsWith('../')) {
    return false;
  }
  return value.kind === 'directory'
    ? Object.keys(value).sort().join(',') === 'kind,path'
    : Object.keys(value).sort().join(',') === 'kind,path,sha256,size'
      && typeof value.size === 'number'
      && Number.isSafeInteger(value.size)
      && value.size >= 0
      && typeof value.sha256 === 'string'
      && /^[0-9a-f]{64}$/u.test(value.sha256);
}

function readWorkspaceDirectoryIdentity(path: string): WorkspaceDirectoryIdentity | undefined {
  if (!existsSync(path)) return undefined;
  const stats = statSync(path, { bigint: true });
  if (!stats.isDirectory()) return undefined;
  return {
    realPath: realpathSync(path),
    device: stats.dev.toString(),
    inode: stats.ino.toString(),
  };
}

function workspaceDirectoryIdentitiesMatch(
  source: WorkspaceDirectoryIdentity,
  destination: WorkspaceDirectoryIdentity,
): boolean {
  return source.realPath === destination.realPath
    || (source.device === destination.device && source.inode === destination.inode);
}

function copyTreeNoOverwrite(source: string, destination: string): void {
  mkdirSync(destination, { recursive: false });
  const visit = (sourceDirectory: string, destinationDirectory: string): void => {
    for (const entry of readdirSync(sourceDirectory, { withFileTypes: true })) {
      const sourcePath = join(sourceDirectory, entry.name);
      const destinationPath = join(destinationDirectory, entry.name);
      const stat = lstatSync(sourcePath);
      if (stat.isSymbolicLink()) {
        throw new Error(`Legacy workspace migration rejects symbolic links: ${sourcePath}`);
      }
      if (stat.isDirectory()) {
        mkdirSync(destinationPath, { recursive: false });
        visit(sourcePath, destinationPath);
      } else if (stat.isFile()) {
        copyFileSync(sourcePath, destinationPath, constants.COPYFILE_EXCL);
      } else {
        throw new Error(`Legacy workspace migration rejects non-file entry: ${sourcePath}`);
      }
    }
  };
  visit(source, destination);
}

function parseReceipt(path: string): MigrationReceipt {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isRecord(raw)
    || Object.keys(raw).sort().join(',') !== [
      'companionId',
      'destinationPath',
      'migratedAt',
      'schemaVersion',
      'sourceEntries',
      'sourcePath',
      'sourceRetained',
      'sourceSha256',
    ].join(',')
    || raw.schemaVersion !== 1
    || typeof raw.companionId !== 'string'
    || typeof raw.sourcePath !== 'string'
    || typeof raw.destinationPath !== 'string'
    || typeof raw.sourceSha256 !== 'string'
    || !Array.isArray(raw.sourceEntries)
    || !raw.sourceEntries.every(isTreeEntry)
    || typeof raw.migratedAt !== 'string'
    || raw.sourceRetained !== true) {
    throw new Error(`Malformed legacy workspace migration receipt: ${path}`);
  }
  const receipt = raw as unknown as MigrationReceipt;
  if (hashLegacyWorkspaceEntries(receipt.sourceEntries) !== receipt.sourceSha256) {
    throw new Error(`Legacy workspace migration receipt integrity check failed: ${path}`);
  }
  return receipt;
}

export interface LegacyWorkspaceMigrationResult {
  status: 'not_needed' | 'already_migrated' | 'migrated';
  reason?: 'same_directory_identity';
  sourceSha256?: string;
  companionId?: string;
  sourcePath?: string;
  destinationPath?: string;
}

/**
 * Assign legacy WORKSPACE_PATH data to exactly one companion. The source is
 * retained, the destination must not exist, and the operator must approve the
 * exact tree digest. There is deliberately no merge or best-effort fallback.
 */
export function migrateLegacyWorkspaceForFleet(options: {
  fleet: ResolvedCompanionsFleetConfig;
  legacyWorkspacePath: string | undefined;
  env?: NodeJS.ProcessEnv;
}): LegacyWorkspaceMigrationResult {
  const legacyValue = options.legacyWorkspacePath?.trim();
  if (!legacyValue) return { status: 'not_needed' };
  const sourcePath = resolve(legacyValue);
  const sourceExists = existsSync(sourcePath);
  if (sourceExists) {
    const sourceIdentity = readWorkspaceDirectoryIdentity(sourcePath);
    for (const companion of options.fleet.companions) {
      const destinationPath = resolve(companion.personalWorkspacePath);
      const destinationIdentity = readWorkspaceDirectoryIdentity(destinationPath);
      if (sourceIdentity
        && destinationIdentity
        && workspaceDirectoryIdentitiesMatch(sourceIdentity, destinationIdentity)) {
        return {
          status: 'not_needed',
          reason: 'same_directory_identity',
          companionId: companion.companionId,
          sourcePath,
          destinationPath,
        };
      }
    }
  }

  const env = options.env ?? process.env;
  const requestedCompanionId = env[LEGACY_WORKSPACE_COMPANION_ID_ENV]?.trim() ?? '';
  const requestedDigest = env[LEGACY_WORKSPACE_SHA256_ENV]?.trim() ?? '';
  const migrationDir = join(options.fleet.workspacesRoot, '.migration');
  const receiptPath = join(migrationDir, 'legacy-workspace.json');
  if (existsSync(receiptPath)) {
    const receipt = parseReceipt(receiptPath);
    if (sourceExists || requestedCompanionId || requestedDigest) {
      if (!requestedCompanionId) {
        throw new Error(
          `${LEGACY_WORKSPACE_COMPANION_ID_ENV} remains required to validate a completed migration receipt`,
        );
      }
      const expectedSha256 = requireDigest(requestedDigest);
      if (requestedCompanionId !== receipt.companionId || expectedSha256 !== receipt.sourceSha256) {
        throw new Error('Legacy workspace migration receipt conflicts with the requested migration identity');
      }
    }
    const companion = options.fleet.companions.find(entry => entry.companionId === receipt.companionId);
    if (!companion) {
      throw new Error('Legacy workspace migration receipt no longer matches its migration identity');
    }
    const destinationPath = resolve(companion.personalWorkspacePath);
    if (resolve(receipt.sourcePath) !== sourcePath
      || resolve(receipt.destinationPath) !== destinationPath
      || !readWorkspaceDirectoryIdentity(destinationPath)) {
      throw new Error('Legacy workspace migration receipt no longer matches its migration identity');
    }
    return {
      status: 'already_migrated',
      sourceSha256: receipt.sourceSha256,
      companionId: receipt.companionId,
      sourcePath,
      destinationPath,
    };
  }

  if (!sourceExists || readdirSync(sourcePath).length === 0) return { status: 'not_needed' };
  const companionId = requestedCompanionId;
  if (!companionId) {
    const sourceSha256 = hashLegacyWorkspaceTree(sourcePath);
    throw new Error(
      `Unmigrated legacy WORKSPACE_PATH data exists at ${sourcePath} (sha256 ${sourceSha256}). `
      + `Set ${LEGACY_WORKSPACE_COMPANION_ID_ENV} and ${LEGACY_WORKSPACE_SHA256_ENV} to assign it explicitly.`,
    );
  }
  const expectedSha256 = requireDigest(requestedDigest);
  const companion = options.fleet.companions.find(entry => entry.companionId === companionId);
  if (!companion) {
    throw new Error(`${LEGACY_WORKSPACE_COMPANION_ID_ENV} does not identify exactly one configured companion`);
  }
  const destinationPath = resolve(companion.personalWorkspacePath);
  const sourceSha256 = hashLegacyWorkspaceTree(sourcePath);
  if (expectedSha256 !== sourceSha256) {
    throw new Error(
      `Legacy workspace digest changed: expected ${expectedSha256}, found ${sourceSha256}; refusing migration`,
    );
  }
  if (existsSync(destinationPath)) {
    throw new Error(
      `Legacy workspace destination already exists at ${destinationPath}; no-overwrite migration refuses to merge`,
    );
  }

  mkdirSync(dirname(destinationPath), { recursive: true });
  mkdirSync(migrationDir, { recursive: true });
  const stagingPath = join(dirname(destinationPath), `.${basename(destinationPath)}.legacy-${randomUUID()}`);
  const sourceEntries = inspectTree(sourcePath);
  try {
    copyTreeNoOverwrite(sourcePath, stagingPath);
    if (hashLegacyWorkspaceTree(stagingPath) !== sourceSha256) {
      throw new Error('Legacy workspace staging verification failed');
    }
    renameSync(stagingPath, destinationPath);
    writeJsonAtomic(receiptPath, {
      schemaVersion: 1,
      companionId,
      sourcePath,
      destinationPath,
      sourceSha256,
      sourceEntries,
      migratedAt: new Date().toISOString(),
      sourceRetained: true,
    } satisfies MigrationReceipt);
  } catch (error) {
    if (existsSync(stagingPath)) rmSync(stagingPath, { recursive: true, force: true });
    throw error;
  }
  // A final receipt is authoritative. There is no pending journal to leave
  // behind, and the source remains available for operator rollback evidence.
  if (existsSync(join(migrationDir, 'legacy-workspace.pending.json'))) {
    unlinkSync(join(migrationDir, 'legacy-workspace.pending.json'));
  }
  return { status: 'migrated', sourceSha256, companionId, sourcePath, destinationPath };
}
