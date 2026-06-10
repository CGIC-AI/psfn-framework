import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { writeJsonAtomic } from '../../shared/utils/fs.js';

export const COMPANION_TREE_DIR_NAME = 'companion-tree';
export const COMPANION_TREE_MANIFEST_NAME = 'companion-tree-manifest.json';

export interface CompanionTreeManifestEntry {
  /** Path relative to the companion-data root, using `/` separators. */
  path: string;
  sizeBytes: number;
  sha256: string;
}

export interface CompanionTreeManifest {
  schemaVersion: 1;
  capturedAt: string;
  sourceDir: string;
  fileCount: number;
  totalBytes: number;
  /** Relative paths deliberately excluded from capture (already captured elsewhere or backup targets). */
  excludedPaths: string[];
  /** Non-regular files (sockets, symlinks, fifos) found and skipped during the walk. */
  skippedSpecialPaths: string[];
  files: CompanionTreeManifestEntry[];
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

export interface CompanionTreeCaptureResult {
  treeDir: string;
  manifestPath: string;
  fileCount: number;
  totalBytes: number;
  excludedPaths: string[];
  skippedSpecialPaths: string[];
}

export interface CompanionTreeVerificationResult {
  verifiedFileCount: number;
  totalBytes: number;
}

function toManifestPath(relativePath: string): string {
  return relativePath.split(sep).join('/');
}

function normalizeExcludePaths(
  companionDataDir: string,
  excludePaths: readonly string[],
): Set<string> {
  const normalized = new Set<string>();
  for (const excludePath of excludePaths) {
    const trimmed = excludePath.trim();
    if (!trimmed) continue;
    const relativePath = isAbsolute(trimmed)
      ? relative(companionDataDir, trimmed)
      : trimmed;
    if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
      continue;
    }
    normalized.add(toManifestPath(relativePath));
  }
  return normalized;
}

function hashFile(path: string): { sha256: string; sizeBytes: number } {
  const bytes = readFileSync(path);
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.length,
  };
}

/**
 * Captures the full companion-data file tree into the backup snapshot with a
 * per-file sha256 manifest. The walk is exhaustive by construction — only the
 * explicitly listed exclusions (sessions captured separately, backup targets)
 * are skipped — so newly introduced companion-authored file classes are always
 * inside backup scope without manifest maintenance.
 */
export function captureCompanionTree(
  options: CaptureCompanionTreeOptions,
): CompanionTreeCaptureResult {
  const companionDataDir = options.companionDataDir.trim();
  if (!companionDataDir) {
    throw new Error('captureCompanionTree requires companionDataDir');
  }
  if (!existsSync(companionDataDir)) {
    throw new Error(`Companion data directory missing: ${companionDataDir}`);
  }

  const treeDir = join(options.backupDir, COMPANION_TREE_DIR_NAME);
  const manifestPath = join(options.backupDir, COMPANION_TREE_MANIFEST_NAME);
  const excluded = normalizeExcludePaths(companionDataDir, options.excludePaths ?? []);
  const files: CompanionTreeManifestEntry[] = [];
  const skippedSpecialPaths: string[] = [];
  let totalBytes = 0;

  const walk = (relativeDir: string): void => {
    const sourceDir = relativeDir ? join(companionDataDir, relativeDir) : companionDataDir;
    const entries = readdirSync(sourceDir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relativePath = relativeDir ? join(relativeDir, entry.name) : entry.name;
      const manifestRelativePath = toManifestPath(relativePath);
      if (excluded.has(manifestRelativePath)) continue;

      const sourcePath = join(companionDataDir, relativePath);
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
      mkdirSync(join(treeDir, relativeDir), { recursive: true });
      copyFileSync(sourcePath, destinationPath);
      const { sha256, sizeBytes } = hashFile(destinationPath);
      files.push({ path: manifestRelativePath, sizeBytes, sha256 });
      totalBytes += sizeBytes;
    }
  };

  mkdirSync(treeDir, { recursive: true });
  walk('');

  const manifest: CompanionTreeManifest = {
    schemaVersion: 1,
    capturedAt: new Date((options.now ?? (() => Date.now()))()).toISOString(),
    sourceDir: companionDataDir,
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
 * Verifies a captured companion tree against its manifest: every manifest
 * entry must exist with a matching sha256, and no unmanifested files may be
 * present in the captured tree.
 */
export function verifyCompanionTreeSnapshot(
  backupDir: string,
): CompanionTreeVerificationResult {
  const treeDir = join(backupDir, COMPANION_TREE_DIR_NAME);
  const manifestPath = join(backupDir, COMPANION_TREE_MANIFEST_NAME);
  if (!existsSync(manifestPath)) {
    throw new Error(`Companion tree manifest missing: ${manifestPath}`);
  }
  if (!existsSync(treeDir)) {
    throw new Error(`Companion tree capture missing: ${treeDir}`);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as CompanionTreeManifest;
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
      throw new Error(`Unmanifested file present in companion tree capture: ${presentPath}`);
    }
  }

  let totalBytes = 0;
  for (const entry of manifest.files) {
    const capturedPath = join(treeDir, ...entry.path.split('/'));
    if (!existsSync(capturedPath)) {
      throw new Error(`Manifested file missing from companion tree capture: ${entry.path}`);
    }
    const { sha256, sizeBytes } = hashFile(capturedPath);
    if (sha256 !== entry.sha256) {
      throw new Error(`Companion tree capture hash mismatch for ${entry.path}`);
    }
    totalBytes += sizeBytes;
  }

  return {
    verifiedFileCount: manifest.files.length,
    totalBytes,
  };
}
