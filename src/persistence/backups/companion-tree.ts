import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { isStrictSubpath } from '../layout.js';
import { writeJsonAtomic } from '../../shared/utils/fs.js';

export const COMPANION_TREE_DIR_NAME = 'companion-tree';
export const COMPANION_TREE_MANIFEST_NAME = 'companion-tree-manifest.json';
export const WORKSPACE_TREE_DIR_NAME = 'workspace-tree';
export const WORKSPACE_TREE_MANIFEST_NAME = 'workspace-tree-manifest.json';

const DEFAULT_WORKSPACE_EXCLUDED_DIR_NAMES = new Set([
  '.cache',
  '.git',
  '.hg',
  '.svn',
  '.tmp',
  '.vite',
  '.svelte-kit',
  'cache',
  'dist',
  'build',
  'node_modules',
  'tmp',
]);

export interface TreeSnapshotManifestEntry {
  /** Path relative to the source root, using `/` separators. */
  path: string;
  sizeBytes: number;
  sha256: string;
}

export interface TreeSnapshotManifest {
  schemaVersion: 1;
  capturedAt: string;
  sourceDir: string;
  fileCount: number;
  totalBytes: number;
  /** Relative paths deliberately excluded from capture. */
  excludedPaths: string[];
  /** Non-regular files (sockets, symlinks, fifos) found and skipped during the walk. */
  skippedSpecialPaths: string[];
  files: TreeSnapshotManifestEntry[];
}

export type CompanionTreeManifestEntry = TreeSnapshotManifestEntry;
export type CompanionTreeManifest = TreeSnapshotManifest;
export type WorkspaceTreeManifestEntry = TreeSnapshotManifestEntry;
export type WorkspaceTreeManifest = TreeSnapshotManifest;

interface CaptureTreeSnapshotOptions {
  sourceDir: string;
  backupDir: string;
  treeDirName: string;
  manifestName: string;
  sourceDescription: string;
  excludePaths?: string[];
  excludeDirNames?: ReadonlySet<string>;
  now?: () => number;
}

export interface CaptureCompanionTreeOptions {
  companionDataDir: string;
  /** The backup snapshot directory; the tree is captured into `<backupDir>/companion-tree`. */
  backupDir: string;
  /**
   * Absolute or root-relative paths to exclude. Paths outside the companion
   * root are ignored. The capture is otherwise exhaustive so companion-authored
   * files can never silently fall out of backup scope.
   */
  excludePaths?: string[];
  now?: () => number;
}

export interface CaptureWorkspaceTreeOptions {
  workspacePath: string;
  /** The backup snapshot directory; the tree is captured into `<backupDir>/workspace-tree`. */
  backupDir: string;
  /**
   * Absolute or root-relative paths to exclude. Paths outside the workspace
   * root are ignored. Default dependency/cache/temp/VCS directory names are
   * also excluded wherever they appear in the workspace.
   */
  excludePaths?: string[];
  now?: () => number;
}

export interface TreeSnapshotCaptureResult {
  treeDir: string;
  manifestPath: string;
  fileCount: number;
  totalBytes: number;
  excludedPaths: string[];
  skippedSpecialPaths: string[];
}

export type CompanionTreeCaptureResult = TreeSnapshotCaptureResult;
export type WorkspaceTreeCaptureResult = TreeSnapshotCaptureResult;

export interface TreeSnapshotVerificationResult {
  verifiedFileCount: number;
  totalBytes: number;
}

export type CompanionTreeVerificationResult = TreeSnapshotVerificationResult;
export type WorkspaceTreeVerificationResult = TreeSnapshotVerificationResult;

function toManifestPath(relativePath: string): string {
  return relativePath.split(sep).join('/');
}

function normalizeExcludePaths(
  sourceDir: string,
  excludePaths: readonly string[],
): Set<string> {
  const normalized = new Set<string>();
  for (const excludePath of excludePaths) {
    const trimmed = excludePath.trim();
    if (!trimmed) continue;
    const relativePath = isAbsolute(trimmed)
      ? relative(sourceDir, trimmed)
      : trimmed;
    if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
      continue;
    }
    normalized.add(toManifestPath(relativePath));
  }
  return normalized;
}

function isExcludedPath(relativePath: string, excludedPaths: Set<string>): boolean {
  const manifestPath = toManifestPath(relativePath);
  for (const excludedPath of excludedPaths) {
    if (manifestPath === excludedPath || manifestPath.startsWith(`${excludedPath}/`)) {
      return true;
    }
  }
  return false;
}

/**
 * Resolves a manifest entry path under the capture root, rejecting absolute
 * paths, empty/`.`/`..` segments, and anything that resolves outside the
 * root — manifest contents are untrusted at verification time.
 */
function resolveManifestEntryPath(treeDir: string, manifestPath: string, label: string): string {
  const segments = manifestPath.split('/');
  const hasUnsafeSegment = isAbsolute(manifestPath)
    || segments.some(segment => !segment || segment === '.' || segment === '..');
  if (hasUnsafeSegment) {
    throw new Error(`${label} manifest entry escapes the capture root: ${manifestPath}`);
  }
  const capturedPath = join(treeDir, ...segments);
  if (!isStrictSubpath(capturedPath, treeDir)) {
    throw new Error(`${label} manifest entry escapes the capture root: ${manifestPath}`);
  }
  return capturedPath;
}

function hashFile(path: string): { sha256: string; sizeBytes: number } {
  const bytes = readFileSync(path);
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.length,
  };
}

function captureTreeSnapshot(options: CaptureTreeSnapshotOptions): TreeSnapshotCaptureResult {
  const sourceDir = options.sourceDir.trim();
  if (!sourceDir) {
    throw new Error(`captureTreeSnapshot requires ${options.sourceDescription}`);
  }
  if (!existsSync(sourceDir)) {
    throw new Error(`${options.sourceDescription} directory missing: ${sourceDir}`);
  }

  const treeDir = join(options.backupDir, options.treeDirName);
  const manifestPath = join(options.backupDir, options.manifestName);
  const excluded = normalizeExcludePaths(sourceDir, options.excludePaths ?? []);
  const files: TreeSnapshotManifestEntry[] = [];
  const skippedSpecialPaths: string[] = [];
  let totalBytes = 0;

  const walk = (relativeDir: string): void => {
    const currentSourceDir = relativeDir ? join(sourceDir, relativeDir) : sourceDir;
    const entries = readdirSync(currentSourceDir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relativePath = relativeDir ? join(relativeDir, entry.name) : entry.name;
      const manifestRelativePath = toManifestPath(relativePath);
      if (isExcludedPath(relativePath, excluded)) continue;
      if (entry.isDirectory() && options.excludeDirNames?.has(entry.name)) {
        excluded.add(manifestRelativePath);
        continue;
      }

      const sourcePath = join(sourceDir, relativePath);
      const stats = lstatSync(sourcePath);
      if (stats.isDirectory()) {
        walk(relativePath);
        continue;
      }
      if (!stats.isFile()) {
        skippedSpecialPaths.push(manifestRelativePath);
        continue;
      }

      const destinationPath = join(treeDir, relativePath);
      mkdirSync(dirname(destinationPath), { recursive: true });
      copyFileSync(sourcePath, destinationPath);
      const { sha256, sizeBytes } = hashFile(destinationPath);
      files.push({ path: manifestRelativePath, sizeBytes, sha256 });
      totalBytes += sizeBytes;
    }
  };

  mkdirSync(treeDir, { recursive: true });
  walk('');

  const manifest: TreeSnapshotManifest = {
    schemaVersion: 1,
    capturedAt: new Date((options.now ?? (() => Date.now()))()).toISOString(),
    sourceDir,
    fileCount: files.length,
    totalBytes,
    excludedPaths: [...excluded].sort((a, b) => a.localeCompare(b)),
    skippedSpecialPaths,
    files,
  };
  writeJsonAtomic(manifestPath, manifest);

  return {
    treeDir,
    manifestPath,
    fileCount: files.length,
    totalBytes,
    excludedPaths: manifest.excludedPaths,
    skippedSpecialPaths,
  };
}

/**
 * Captures the full companion-data file tree into the backup snapshot with a
 * per-file sha256 manifest. The walk is exhaustive by construction: only the
 * explicitly listed exclusions are skipped.
 */
export function captureCompanionTree(
  options: CaptureCompanionTreeOptions,
): CompanionTreeCaptureResult {
  return captureTreeSnapshot({
    sourceDir: options.companionDataDir,
    backupDir: options.backupDir,
    treeDirName: COMPANION_TREE_DIR_NAME,
    manifestName: COMPANION_TREE_MANIFEST_NAME,
    sourceDescription: 'Companion data',
    ...(options.excludePaths ? { excludePaths: options.excludePaths } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
}

/**
 * Captures personal workspace files, including workspace-backed wiki documents,
 * into a dedicated backup snapshot with a per-file sha256 manifest.
 */
export function captureWorkspaceTree(
  options: CaptureWorkspaceTreeOptions,
): WorkspaceTreeCaptureResult {
  return captureTreeSnapshot({
    sourceDir: options.workspacePath,
    backupDir: options.backupDir,
    treeDirName: WORKSPACE_TREE_DIR_NAME,
    manifestName: WORKSPACE_TREE_MANIFEST_NAME,
    sourceDescription: 'Workspace',
    excludePaths: [
      ...(options.excludePaths ?? []),
      '.psfn/temp-artifacts',
    ],
    excludeDirNames: DEFAULT_WORKSPACE_EXCLUDED_DIR_NAMES,
    ...(options.now ? { now: options.now } : {}),
  });
}

export function verifyTreeSnapshot(
  backupDir: string,
  treeDirName: string,
  manifestName: string,
  label: string,
): TreeSnapshotVerificationResult {
  const treeDir = join(backupDir, treeDirName);
  const manifestPath = join(backupDir, manifestName);
  if (!existsSync(manifestPath)) {
    throw new Error(`${label} manifest missing: ${manifestPath}`);
  }
  if (!existsSync(treeDir)) {
    throw new Error(`${label} capture missing: ${treeDir}`);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as TreeSnapshotManifest;
  const manifestPaths = new Set(manifest.files.map(entry => entry.path));

  const presentPaths: string[] = [];
  const walk = (relativeDir: string): void => {
    const dir = relativeDir ? join(treeDir, relativeDir) : treeDir;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relativePath = relativeDir ? join(relativeDir, entry.name) : entry.name;
      if (entry.isDirectory()) {
        walk(relativePath);
        continue;
      }
      presentPaths.push(toManifestPath(relativePath));
    }
  };
  walk('');

  for (const presentPath of presentPaths) {
    if (!manifestPaths.has(presentPath)) {
      throw new Error(`Unmanifested file present in ${label.toLowerCase()} capture: ${presentPath}`);
    }
  }

  let totalBytes = 0;
  for (const entry of manifest.files) {
    const capturedPath = resolveManifestEntryPath(treeDir, entry.path, label);
    if (!existsSync(capturedPath)) {
      throw new Error(`Manifested file missing from ${label.toLowerCase()} capture: ${entry.path}`);
    }
    const { sha256, sizeBytes } = hashFile(capturedPath);
    if (sha256 !== entry.sha256) {
      throw new Error(`${label} capture hash mismatch for ${entry.path}`);
    }
    totalBytes += sizeBytes;
  }

  return {
    verifiedFileCount: manifest.files.length,
    totalBytes,
  };
}

/**
 * Verifies a captured companion tree against its manifest: every manifest
 * entry must exist with a matching sha256, and no unmanifested files may be
 * present in the captured tree.
 */
export function verifyCompanionTreeSnapshot(
  backupDir: string,
): CompanionTreeVerificationResult {
  return verifyTreeSnapshot(
    backupDir,
    COMPANION_TREE_DIR_NAME,
    COMPANION_TREE_MANIFEST_NAME,
    'Companion tree',
  );
}

/**
 * Verifies a captured workspace tree against its manifest.
 */
export function verifyWorkspaceTreeSnapshot(
  backupDir: string,
): WorkspaceTreeVerificationResult {
  return verifyTreeSnapshot(
    backupDir,
    WORKSPACE_TREE_DIR_NAME,
    WORKSPACE_TREE_MANIFEST_NAME,
    'Workspace tree',
  );
}
