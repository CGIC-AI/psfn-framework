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
  verifyTreeSnapshot,
  type TreeSnapshotManifest,
  type TreeSnapshotManifestEntry,
  type TreeSnapshotCaptureResult,
  type TreeSnapshotVerificationResult,
} from './companion-tree.js';

export const SYSTEM_CONFIG_DIR_NAME = 'system-config';
export const SYSTEM_CONFIG_MANIFEST_NAME = 'system-config-manifest.json';

export const SYSTEM_CONFIG_OWNER_FILES = [
  'settings.json',
  'models.json',
  'providers.json',
  'scheduler.json',
  'capability-tier.json',
  'channels.json',
  'backup.json',
  'skills.json',
  'trust-policy.json',
  'charge-policy.json',
  'intake-policy.json',
] as const;

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
    if (!existsSync(sourcePath)) continue;
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
  const result = verifyTreeSnapshot(
    backupDir,
    SYSTEM_CONFIG_DIR_NAME,
    SYSTEM_CONFIG_MANIFEST_NAME,
    'System config',
  );
  for (const ownerFile of SYSTEM_CONFIG_OWNER_FILES) {
    const capturedPath = join(backupDir, SYSTEM_CONFIG_DIR_NAME, ownerFile);
    if (!existsSync(capturedPath)) continue;
    assertJsonOwnerFile(capturedPath, ownerFile);
  }
  return result;
}
