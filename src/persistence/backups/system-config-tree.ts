import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from '../../shared/utils/fs.js';
import { isRecord } from '../../shared/utils/types.js';
import {
  COMPANIONS_FILE_NAME,
  validateCompanionsConfig,
} from '../../system/config/companions-config.js';
import { SETTINGS_SUBSYSTEMS } from '../../system/config/settings-contract.js';
import { describeStartupOwnerFileChecks } from '../../system/config/startup-owner-files.js';
import {
  verifyTreeSnapshot,
  type TreeSnapshotManifest,
  type TreeSnapshotManifestEntry,
  type TreeSnapshotCaptureResult,
  type TreeSnapshotVerificationResult,
} from './companion-tree.js';

export const SYSTEM_CONFIG_DIR_NAME = 'system-config';
export const SYSTEM_CONFIG_MANIFEST_NAME = 'system-config-manifest.json';

const STARTUP_SYSTEM_OWNER_DESCRIPTORS = describeStartupOwnerFileChecks()
  .filter(descriptor => descriptor.scope === 'system');

/** Mandatory cluster-global owners, derived from the startup guard's registry. */
const MANDATORY_SYSTEM_CONFIG_OWNER_FILES: readonly string[] =
  STARTUP_SYSTEM_OWNER_DESCRIPTORS
    .filter(descriptor => !descriptor.optionalWhenMissing)
    .map(descriptor => descriptor.ownerFileName);

// Cluster-global owner files rooted at systemDataDir. The startup descriptors
// are the authority for startup-critical topology/config, while the settings
// contract contributes cluster-global owners (currently channels.json) that
// are not startup checks. Per-companion owners are filtered by scope and remain
// exclusively in the exhaustive companion-tree slice.
export const SYSTEM_CONFIG_OWNER_FILES: readonly string[] = [
  ...new Set([
    ...STARTUP_SYSTEM_OWNER_DESCRIPTORS.map(descriptor => descriptor.ownerFileName),
    ...Object.values(SETTINGS_SUBSYSTEMS)
      .filter(subsystem => subsystem.scope === 'global')
      .map(subsystem => subsystem.ownerFile),
  ]),
];

const MANDATORY_SYSTEM_CONFIG_OWNER_FILE_SET = new Set(MANDATORY_SYSTEM_CONFIG_OWNER_FILES);

export interface CaptureSystemConfigSnapshotOptions {
  systemDataDir: string;
  backupDir: string;
  now?: () => number;
}

export type SystemConfigSnapshotCaptureResult = TreeSnapshotCaptureResult;
export type SystemConfigSnapshotVerificationResult = TreeSnapshotVerificationResult;

function hashFile(path: string): { sha256: string; sizeBytes: number } {
  const bytes = readFileSync(path);
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.length,
  };
}

function assertJsonOwnerFile(path: string, ownerFile: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(`System config owner file ${ownerFile} is not valid JSON: ${cause}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`System config owner file ${ownerFile} must contain a JSON object`);
  }
  if (ownerFile === COMPANIONS_FILE_NAME) {
    validateCompanionsConfig(parsed, path);
  }
}

export function captureSystemConfigSnapshot(
  options: CaptureSystemConfigSnapshotOptions,
): SystemConfigSnapshotCaptureResult {
  const systemDataDir = options.systemDataDir.trim();
  if (!systemDataDir) {
    throw new Error('System config backup requires systemDataDir');
  }
  if (!existsSync(systemDataDir)) {
    throw new Error(`System config directory missing: ${systemDataDir}`);
  }

  const treeDir = join(options.backupDir, SYSTEM_CONFIG_DIR_NAME);
  const manifestPath = join(options.backupDir, SYSTEM_CONFIG_MANIFEST_NAME);
  mkdirSync(treeDir, { recursive: true });

  const files: TreeSnapshotManifestEntry[] = [];
  let totalBytes = 0;
  for (const ownerFile of SYSTEM_CONFIG_OWNER_FILES) {
    const sourcePath = join(systemDataDir, ownerFile);
    if (!existsSync(sourcePath)) {
      if (MANDATORY_SYSTEM_CONFIG_OWNER_FILE_SET.has(ownerFile)) {
        throw new Error(`Mandatory system config owner file missing: ${sourcePath}`);
      }
      continue;
    }
    assertJsonOwnerFile(sourcePath, ownerFile);

    const destinationPath = join(treeDir, ownerFile);
    copyFileSync(sourcePath, destinationPath);
    const { sha256, sizeBytes } = hashFile(destinationPath);
    files.push({ path: ownerFile, sizeBytes, sha256 });
    totalBytes += sizeBytes;
  }

  if (files.length === 0) {
    throw new Error(`No system config owner files found in ${systemDataDir}`);
  }

  const manifest: TreeSnapshotManifest = {
    schemaVersion: 1,
    capturedAt: new Date((options.now ?? (() => Date.now()))()).toISOString(),
    sourceDir: systemDataDir,
    fileCount: files.length,
    totalBytes,
    excludedPaths: [],
    skippedSpecialPaths: [],
    files,
  };
  writeJsonAtomic(manifestPath, manifest);

  return {
    treeDir,
    manifestPath,
    fileCount: files.length,
    totalBytes,
    excludedPaths: [],
    skippedSpecialPaths: [],
  };
}

export function verifySystemConfigSnapshot(
  backupDir: string,
): SystemConfigSnapshotVerificationResult {
  const manifestPath = join(backupDir, SYSTEM_CONFIG_MANIFEST_NAME);
  if (!existsSync(manifestPath)) {
    throw new Error(`System config manifest missing: ${manifestPath}`);
  }
  const parsedManifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as unknown;
  if (!isRecord(parsedManifest) || !Array.isArray(parsedManifest.files)) {
    throw new Error(`Invalid system config manifest: ${manifestPath}`);
  }
  const manifestEntries = parsedManifest.files.map((entry) => {
    if (!isRecord(entry)
      || typeof entry.path !== 'string'
      || typeof entry.sizeBytes !== 'number'
      || !Number.isSafeInteger(entry.sizeBytes)
      || entry.sizeBytes < 0
      || typeof entry.sha256 !== 'string') {
      throw new Error(`Invalid system config manifest: ${manifestPath}`);
    }
    return {
      path: entry.path,
      sizeBytes: entry.sizeBytes,
      sha256: entry.sha256,
    };
  });
  const manifestPaths = new Set(manifestEntries.map(entry => entry.path));
  for (const ownerFile of MANDATORY_SYSTEM_CONFIG_OWNER_FILES) {
    if (!manifestPaths.has(ownerFile)) {
      throw new Error(`Mandatory system config owner missing from manifest: ${ownerFile}`);
    }
  }

  const result = verifyTreeSnapshot(
    backupDir,
    SYSTEM_CONFIG_DIR_NAME,
    SYSTEM_CONFIG_MANIFEST_NAME,
    'System config',
  );
  let declaredTotalBytes = 0;
  for (const entry of manifestEntries) {
    const capturedPath = join(backupDir, SYSTEM_CONFIG_DIR_NAME, entry.path);
    const actualSizeBytes = readFileSync(capturedPath).length;
    if (actualSizeBytes !== entry.sizeBytes) {
      throw new Error(`System config capture size mismatch for ${entry.path}`);
    }
    declaredTotalBytes += entry.sizeBytes;
    if (SYSTEM_CONFIG_OWNER_FILES.includes(entry.path)) {
      assertJsonOwnerFile(capturedPath, entry.path);
    }
  }
  if (parsedManifest.fileCount !== manifestEntries.length
    || parsedManifest.totalBytes !== declaredTotalBytes) {
    throw new Error(`System config manifest aggregate size/count mismatch: ${manifestPath}`);
  }
  return result;
}
