import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ResolvedCompanionsFleetConfig } from '../system/config/companions-config.js';
import { fsyncTreeSync, writeFileDurableAtomicSync } from '../shared/utils/fs.js';
import { isRecord } from '../shared/utils/types.js';
import { isStrictSubpath } from './layout.js';
import {
  captureTreeSnapshot,
  restoreTreeSnapshotToEmptyDirectory,
  verifyTreeSnapshot,
} from './backups/companion-tree.js';

export const SYSTEM_OWNER_FLEET_SNAPSHOT_MANIFEST_NAME = 'system-owner-fleet-snapshot.json';
const SYSTEM_TREE_DIR_NAME = 'system-tree';
const SYSTEM_TREE_MANIFEST_NAME = 'system-tree-manifest.json';
const COMPANION_TREE_DIR_NAME = 'companion-tree';
const COMPANION_TREE_MANIFEST_NAME = 'companion-tree-manifest.json';

interface SnapshotArtifact {
  artifactDir: string;
  manifestSha256: string;
  sourceRelativePath: string;
}

interface SnapshotCompanionArtifact extends SnapshotArtifact {
  companionId: string;
}

export interface SystemOwnerFleetSnapshotManifest {
  schemaVersion: 1;
  kind: 'system-owner-fleet-pre-migration';
  capturedAt: string;
  persistenceRoot: string;
  cluster: SnapshotArtifact;
  companions: SnapshotCompanionArtifact[];
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function artifactTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/gu, '').replace('.', '');
}

function strictRelativePath(root: string, target: string, label: string): string {
  const relativePath = relative(resolve(root), resolve(target));
  if (!relativePath
    || isAbsolute(relativePath)
    || relativePath === '..'
    || relativePath.startsWith(`..${sep}`)) {
    throw new Error(`${label} must be a strict descendant of ${resolve(root)}: ${target}`);
  }
  return relativePath;
}

function pathsOverlap(first: string, second: string): boolean {
  const firstPath = resolve(first);
  const secondPath = resolve(second);
  return firstPath === secondPath
    || isStrictSubpath(firstPath, secondPath)
    || isStrictSubpath(secondPath, firstPath);
}

function captureExactTree(input: {
  sourceDir: string;
  artifactDir: string;
  treeDirName: string;
  manifestName: string;
  label: string;
  now: () => number;
}): void {
  const capture = captureTreeSnapshot({
    sourceDir: input.sourceDir,
    backupDir: input.artifactDir,
    treeDirName: input.treeDirName,
    manifestName: input.manifestName,
    sourceDescription: input.label,
    now: input.now,
  });
  if (capture.excludedPaths.length > 0 || capture.skippedSpecialPaths.length > 0) {
    throw new Error(
      `${input.label} snapshot is not whole-root: excluded=${capture.excludedPaths.join(',')} `
      + `special=${capture.skippedSpecialPaths.join(',')}`,
    );
  }
  verifyTreeSnapshot(
    input.artifactDir,
    input.treeDirName,
    input.manifestName,
    input.label,
  );
  fsyncTreeSync(input.artifactDir);
}

export function captureSystemOwnerFleetSnapshot(input: {
  systemDataDir: string;
  fleet: ResolvedCompanionsFleetConfig;
  outputDir: string;
  now?: () => Date;
}): { manifestPath: string; manifest: SystemOwnerFleetSnapshotManifest } {
  const outputDir = resolve(input.outputDir);
  if (existsSync(outputDir)) {
    throw new Error(`System-owner fleet snapshot output already exists: ${outputDir}`);
  }
  const sourceRoots = [
    resolve(input.systemDataDir),
    ...input.fleet.companions.map(companion => resolve(companion.companionDataDir)),
  ];
  for (const sourceRoot of sourceRoots) {
    if (pathsOverlap(outputDir, sourceRoot)) {
      throw new Error(`System-owner fleet snapshot output overlaps source root: ${sourceRoot}`);
    }
  }
  const now = input.now?.() ?? new Date();
  const capturedAt = now.toISOString();
  const timestamp = artifactTimestamp(now);
  const persistenceRoot = resolve(input.fleet.persistenceRoot);
  const manifestPath = join(outputDir, SYSTEM_OWNER_FLEET_SNAPSHOT_MANIFEST_NAME);
  mkdirSync(dirname(outputDir), { recursive: true });
  mkdirSync(outputDir);
  try {
    const clusterArtifactDir = join(outputDir, 'cluster', timestamp);
    captureExactTree({
      sourceDir: input.systemDataDir,
      artifactDir: clusterArtifactDir,
      treeDirName: SYSTEM_TREE_DIR_NAME,
      manifestName: SYSTEM_TREE_MANIFEST_NAME,
      label: 'System data tree',
      now: () => now.getTime(),
    });
    const companions: SnapshotCompanionArtifact[] = [];
    for (const companion of input.fleet.companions) {
      const artifactDir = join(outputDir, 'companions', companion.companionId, timestamp);
      captureExactTree({
        sourceDir: companion.companionDataDir,
        artifactDir,
        treeDirName: COMPANION_TREE_DIR_NAME,
        manifestName: COMPANION_TREE_MANIFEST_NAME,
        label: `Companion ${companion.companionId} data tree`,
        now: () => now.getTime(),
      });
      companions.push({
        companionId: companion.companionId,
        artifactDir: relative(outputDir, artifactDir),
        manifestSha256: sha256File(join(artifactDir, COMPANION_TREE_MANIFEST_NAME)),
        sourceRelativePath: strictRelativePath(
          persistenceRoot,
          companion.companionDataDir,
          `Companion ${companion.companionId} data root`,
        ),
      });
    }
    const manifest: SystemOwnerFleetSnapshotManifest = {
      schemaVersion: 1,
      kind: 'system-owner-fleet-pre-migration',
      capturedAt,
      persistenceRoot,
      cluster: {
        artifactDir: relative(outputDir, clusterArtifactDir),
        manifestSha256: sha256File(join(clusterArtifactDir, SYSTEM_TREE_MANIFEST_NAME)),
        sourceRelativePath: strictRelativePath(
          persistenceRoot,
          input.systemDataDir,
          'System data root',
        ),
      },
      companions,
    };
    writeFileDurableAtomicSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      exclusive: true,
    });
    return { manifestPath, manifest };
  } catch (error) {
    rmSync(outputDir, { recursive: true, force: true });
    throw error;
  }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function parseSnapshotArtifact(
  value: unknown,
  label: string,
  expectedKeys: readonly string[],
): SnapshotArtifact {
  if (!isRecord(value)
    || !exactKeys(value, expectedKeys)
    || typeof value.artifactDir !== 'string'
    || !value.artifactDir
    || isAbsolute(value.artifactDir)
    || value.artifactDir === '..'
    || value.artifactDir.startsWith(`..${sep}`)
    || typeof value.manifestSha256 !== 'string'
    || !/^[0-9a-f]{64}$/u.test(value.manifestSha256)
    || typeof value.sourceRelativePath !== 'string'
    || !value.sourceRelativePath
    || isAbsolute(value.sourceRelativePath)
    || value.sourceRelativePath === '..'
    || value.sourceRelativePath.startsWith(`..${sep}`)) {
    throw new Error(`${label} is malformed`);
  }
  return {
    artifactDir: value.artifactDir,
    manifestSha256: value.manifestSha256,
    sourceRelativePath: value.sourceRelativePath,
  };
}

function loadSnapshotManifest(path: string): SystemOwnerFleetSnapshotManifest {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isRecord(parsed)
    || parsed.schemaVersion !== 1
    || parsed.kind !== 'system-owner-fleet-pre-migration'
    || typeof parsed.capturedAt !== 'string'
    || typeof parsed.persistenceRoot !== 'string'
    || !exactKeys(parsed, [
      'schemaVersion',
      'kind',
      'capturedAt',
      'persistenceRoot',
      'cluster',
      'companions',
    ])
    || !Array.isArray(parsed.companions)) {
    throw new Error(`System-owner fleet snapshot manifest is malformed: ${path}`);
  }
  const cluster = parseSnapshotArtifact(
    parsed.cluster,
    'Cluster snapshot artifact',
    ['artifactDir', 'manifestSha256', 'sourceRelativePath'],
  );
  const companions = parsed.companions.map((value, index): SnapshotCompanionArtifact => {
    const artifact = parseSnapshotArtifact(
      value,
      `Companion snapshot artifact ${index}`,
      ['companionId', 'artifactDir', 'manifestSha256', 'sourceRelativePath'],
    );
    if (!isRecord(value) || typeof value.companionId !== 'string' || !value.companionId) {
      throw new Error(`Companion snapshot artifact ${index} is malformed`);
    }
    return { ...artifact, companionId: value.companionId };
  });
  if (new Set(companions.map(entry => entry.companionId)).size !== companions.length
    || new Set(companions.map(entry => entry.sourceRelativePath)).size !== companions.length) {
    throw new Error('System-owner fleet snapshot contains duplicate companion identities or roots');
  }
  return {
    schemaVersion: 1,
    kind: 'system-owner-fleet-pre-migration',
    capturedAt: parsed.capturedAt,
    persistenceRoot: parsed.persistenceRoot,
    cluster,
    companions,
  };
}

function resolveArtifactDir(snapshotRoot: string, relativePath: string, label: string): string {
  const artifactDir = resolve(snapshotRoot, relativePath);
  if (!isStrictSubpath(artifactDir, snapshotRoot) || !existsSync(artifactDir)) {
    throw new Error(`${label} is missing or escapes the snapshot root: ${relativePath}`);
  }
  return artifactDir;
}

function resolveRestoreDestination(
  restoreRoot: string,
  relativePath: string,
  label: string,
): string {
  const destination = resolve(restoreRoot, relativePath);
  if (!isStrictSubpath(destination, restoreRoot)) {
    throw new Error(`${label} escapes the fresh restore root: ${relativePath}`);
  }
  if (!existsSync(destination) || readdirSync(destination).length > 0) {
    throw new Error(`${label} must be a pre-provisioned empty directory: ${destination}`);
  }
  return destination;
}

export function restoreSystemOwnerFleetSnapshot(input: {
  manifestPath: string;
  restorePersistenceRoot: string;
}): { restoredRoots: string[] } {
  const manifestPath = resolve(input.manifestPath);
  const snapshotRoot = dirname(manifestPath);
  const manifest = loadSnapshotManifest(manifestPath);
  const restoreRoot = resolve(input.restorePersistenceRoot);
  const artifacts = [
    {
      ...manifest.cluster,
      label: 'System data tree',
      treeDirName: SYSTEM_TREE_DIR_NAME,
      treeManifestName: SYSTEM_TREE_MANIFEST_NAME,
    },
    ...manifest.companions.map(companion => ({
      ...companion,
      label: `Companion ${companion.companionId} data tree`,
      treeDirName: COMPANION_TREE_DIR_NAME,
      treeManifestName: COMPANION_TREE_MANIFEST_NAME,
    })),
  ].map(artifact => {
    const artifactDir = resolveArtifactDir(snapshotRoot, artifact.artifactDir, artifact.label);
    const treeManifestPath = join(artifactDir, artifact.treeManifestName);
    if (sha256File(treeManifestPath) !== artifact.manifestSha256) {
      throw new Error(`${artifact.label} manifest digest does not match the fleet snapshot`);
    }
    verifyTreeSnapshot(
      artifactDir,
      artifact.treeDirName,
      artifact.treeManifestName,
      artifact.label,
    );
    return {
      ...artifact,
      artifactDir,
      destination: resolveRestoreDestination(
        restoreRoot,
        artifact.sourceRelativePath,
        artifact.label,
      ),
    };
  });

  for (const artifact of artifacts) {
    restoreTreeSnapshotToEmptyDirectory({
      backupDir: artifact.artifactDir,
      treeDirName: artifact.treeDirName,
      manifestName: artifact.treeManifestName,
      label: artifact.label,
      destinationDir: artifact.destination,
    });
  }
  return { restoredRoots: artifacts.map(artifact => artifact.destination) };
}
