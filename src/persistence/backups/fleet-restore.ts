import { execFile } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { isRecord } from '../../shared/utils/types.js';
import { isStrictSubpath } from '../layout.js';
import {
  COMPANION_TREE_DIR_NAME,
  WORKSPACE_TREE_DIR_NAME,
  verifyCompanionTreeSnapshot,
  verifyWorkspaceTreeSnapshot,
} from './companion-tree.js';
import {
  SYSTEM_CONFIG_DIR_NAME,
  verifySystemConfigSnapshot,
} from './system-config-tree.js';
import { verifyBackupContentsManifest } from './backup-contents.js';
import {
  FLEET_BACKUP_MANIFEST_SCHEMA_VERSION,
  type FleetBackupUnitOutcome,
} from './service.js';

const execFileAsync = promisify(execFile);

interface ParsedFleetManifest {
  mode: 'per-companion' | 'group';
  backupRootDir: string;
  units: FleetBackupUnitOutcome[];
}

export interface FleetRestorePostgresOptions {
  databaseUrl: string;
  pgRestoreBinary?: string;
}

export interface FleetRestoreResult {
  kind: 'companion' | 'cluster' | 'group';
  artifactDir: string;
  databaseDumpPath: string;
  restoredDestinations: string[];
}

interface StagedTree {
  destination: string;
  staging: string;
}

function parseFleetManifest(fleetManifestPath: string): ParsedFleetManifest {
  const manifestPath = resolve(fleetManifestPath);
  const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!isRecord(parsed)
    || parsed.schemaVersion !== FLEET_BACKUP_MANIFEST_SCHEMA_VERSION
    || (parsed.mode !== 'per-companion' && parsed.mode !== 'group')
    || parsed.overallStatus !== 'success'
    || !Array.isArray(parsed.units)) {
    throw new Error(`Fleet restore requires a successful schema-v1 fleet manifest: ${manifestPath}`);
  }
  const rawUnits: unknown[] = parsed.units;
  if (rawUnits.some(unit => !isRecord(unit)
    || (unit.kind !== 'companion' && unit.kind !== 'cluster' && unit.kind !== 'group')
    || unit.status !== 'success'
    || typeof unit.artifactDir !== 'string')) {
    throw new Error(`Fleet restore manifest contains an invalid or unsuccessful unit: ${manifestPath}`);
  }
  const units = rawUnits as FleetBackupUnitOutcome[];
  return { mode: parsed.mode, backupRootDir: realpathSync(dirname(manifestPath)), units };
}

function resolveArtifactDir(manifest: ParsedFleetManifest, unit: FleetBackupUnitOutcome): string {
  const relativePath = unit.artifactDir!;
  if (isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith('../')) {
    throw new Error('Fleet restore artifactDir must stay beneath the backup root');
  }
  const requestedArtifactDir = resolve(manifest.backupRootDir, relativePath);
  if (!isStrictSubpath(requestedArtifactDir, manifest.backupRootDir)
    || !existsSync(requestedArtifactDir)) {
    throw new Error(`Fleet restore artifact is missing or escapes the backup root: ${relativePath}`);
  }
  const artifactDir = realpathSync(requestedArtifactDir);
  if (!isStrictSubpath(artifactDir, manifest.backupRootDir)) {
    throw new Error(`Fleet restore artifact resolves outside the backup root: ${relativePath}`);
  }
  verifyBackupContentsManifest(artifactDir);
  return artifactDir;
}

function findDatabaseDump(artifactDir: string): string {
  const databaseDir = join(artifactDir, 'database');
  const dumps = existsSync(databaseDir)
    ? readdirSync(databaseDir, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.dump'))
      .map(entry => join(databaseDir, entry.name))
    : [];
  if (dumps.length !== 1 || statSync(dumps[0]).size <= 0) {
    throw new Error(`Fleet restore requires exactly one non-empty Postgres dump in ${databaseDir}`);
  }
  return dumps[0];
}

function toCredentialFreePostgresConnection(databaseUrl: string): {
  connectionArg: string;
  password?: string;
} {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error('Fleet restore requires a postgres:// URL so credentials stay out of process arguments');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('Fleet restore databaseUrl must use postgres:// or postgresql://');
  }
  const password = url.password ? decodeURIComponent(url.password) : '';
  url.password = '';
  return { connectionArg: url.toString(), ...(password ? { password } : {}) };
}

async function restorePostgresDump(
  dumpPath: string,
  postgres: FleetRestorePostgresOptions,
): Promise<void> {
  const binary = postgres.pgRestoreBinary?.trim() || 'pg_restore';
  const { connectionArg, password } = toCredentialFreePostgresConnection(postgres.databaseUrl);
  try {
    await execFileAsync(binary, [
      '--exit-on-error',
      '--no-password',
      '--no-owner',
      '--no-privileges',
      '--dbname',
      connectionArg,
      dumpPath,
    ], {
      env: password ? { ...process.env, PGPASSWORD: password } : process.env,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Fleet pg_restore failed for ${dumpPath}: ${message}`);
  }
}

function pathsOverlap(first: string, second: string): boolean {
  return first === second || isStrictSubpath(first, second) || isStrictSubpath(second, first);
}

function resolveCanonicalDestination(destinationValue: string): string {
  const requested = resolve(destinationValue);
  let existingAncestor = requested;
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) break;
    existingAncestor = parent;
  }
  return resolve(realpathSync(existingAncestor), relative(existingAncestor, requested));
}

function cleanupStagedTrees(staged: readonly StagedTree[]): void {
  for (const tree of staged) {
    if (existsSync(tree.staging)) rmSync(tree.staging, { recursive: true, force: true });
  }
}

function stageVerifiedTrees(
  artifactDirValue: string,
  backupRootValue: string,
  specs: ReadonlyArray<{ treeDirName: string; destination: string }>,
): StagedTree[] {
  const artifactDir = resolve(artifactDirValue);
  const backupRoot = resolve(backupRootValue);
  const resolvedSpecs = specs.map(spec => ({
    treeDirName: spec.treeDirName,
    destination: resolveCanonicalDestination(spec.destination),
  }));
  for (const spec of resolvedSpecs) {
    if (existsSync(spec.destination)) {
      throw new Error(
        `Fleet restore destination already exists; no-overwrite policy refuses collision: ${spec.destination}`,
      );
    }
    if (pathsOverlap(spec.destination, artifactDir) || pathsOverlap(spec.destination, backupRoot)) {
      throw new Error(`Fleet restore destination overlaps its immutable backup root: ${spec.destination}`);
    }
  }
  for (let index = 0; index < resolvedSpecs.length; index += 1) {
    for (let peer = index + 1; peer < resolvedSpecs.length; peer += 1) {
      if (pathsOverlap(resolvedSpecs[index].destination, resolvedSpecs[peer].destination)) {
        throw new Error('Fleet restore destinations must be distinct, non-overlapping roots');
      }
    }
  }

  const staged: StagedTree[] = [];
  try {
    for (const spec of resolvedSpecs) {
      mkdirSync(dirname(spec.destination), { recursive: true });
      const staging = join(
        dirname(spec.destination),
        `.${basename(spec.destination)}.restore-${randomUUID()}`,
      );
      staged.push({ destination: spec.destination, staging });
      cpSync(join(artifactDir, spec.treeDirName), staging, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
    }
    return staged;
  } catch (error) {
    cleanupStagedTrees(staged);
    throw error;
  }
}

async function commitRestore(options: {
  kind: FleetRestoreResult['kind'];
  artifactDir: string;
  dumpPath: string;
  postgres: FleetRestorePostgresOptions;
  staged: StagedTree[];
}): Promise<FleetRestoreResult> {
  try {
    await restorePostgresDump(options.dumpPath, options.postgres);
    for (const tree of options.staged) {
      if (existsSync(tree.destination)) {
        throw new Error(`Fleet restore destination collided during restore: ${tree.destination}`);
      }
    }
    for (const tree of options.staged) renameSync(tree.staging, tree.destination);
  } catch (error) {
    cleanupStagedTrees(options.staged);
    throw error;
  }
  return {
    kind: options.kind,
    artifactDir: options.artifactDir,
    databaseDumpPath: options.dumpPath,
    restoredDestinations: options.staged.map(tree => tree.destination),
  };
}

function requireSingleUnit(
  manifest: ParsedFleetManifest,
  predicate: (unit: FleetBackupUnitOutcome) => boolean,
  label: string,
): FleetBackupUnitOutcome {
  const matches = manifest.units.filter(predicate);
  if (matches.length !== 1) {
    throw new Error(`Fleet restore requires exactly one successful ${label} unit; found ${matches.length}`);
  }
  return matches[0];
}

export async function restoreFleetCompanionSlice(options: {
  fleetManifestPath: string;
  companionId: string;
  destinations: { companionDataDir: string; personalWorkspacePath: string };
  postgres: FleetRestorePostgresOptions;
}): Promise<FleetRestoreResult> {
  const manifest = parseFleetManifest(options.fleetManifestPath);
  if (manifest.mode !== 'per-companion') throw new Error('Companion-slice restore requires a per-companion fleet backup');
  const unit = requireSingleUnit(
    manifest,
    candidate => candidate.kind === 'companion' && candidate.companionId === options.companionId,
    `companion ${options.companionId}`,
  );
  const artifactDir = resolveArtifactDir(manifest, unit);
  verifyCompanionTreeSnapshot(artifactDir);
  verifyWorkspaceTreeSnapshot(artifactDir);
  const dumpPath = findDatabaseDump(artifactDir);
  const staged = stageVerifiedTrees(artifactDir, manifest.backupRootDir, [
    { treeDirName: COMPANION_TREE_DIR_NAME, destination: options.destinations.companionDataDir },
    { treeDirName: WORKSPACE_TREE_DIR_NAME, destination: options.destinations.personalWorkspacePath },
  ]);
  try {
    const sessionsSource = join(artifactDir, 'sessions');
    if (existsSync(sessionsSource)) {
      const sessionsDestination = join(staged[0].staging, 'state', 'sessions');
      if (existsSync(sessionsDestination)) {
        throw new Error('Companion restore session destination collides with the verified companion tree');
      }
      mkdirSync(dirname(sessionsDestination), { recursive: true });
      cpSync(sessionsSource, sessionsDestination, { recursive: true, errorOnExist: true, force: false });
    }
    return await commitRestore({
      kind: 'companion',
      artifactDir,
      dumpPath,
      postgres: options.postgres,
      staged,
    });
  } catch (error) {
    cleanupStagedTrees(staged);
    throw error;
  }
}

export async function restoreFleetClusterArtifact(options: {
  fleetManifestPath: string;
  destinations: { systemDataDir: string; sharedWorkspacePath: string };
  postgres: FleetRestorePostgresOptions;
}): Promise<FleetRestoreResult> {
  const manifest = parseFleetManifest(options.fleetManifestPath);
  if (manifest.mode !== 'per-companion') throw new Error('Cluster restore requires a per-companion fleet backup');
  const unit = requireSingleUnit(manifest, candidate => candidate.kind === 'cluster', 'cluster');
  const artifactDir = resolveArtifactDir(manifest, unit);
  verifySystemConfigSnapshot(artifactDir);
  verifyWorkspaceTreeSnapshot(artifactDir);
  const dumpPath = findDatabaseDump(artifactDir);
  return await commitRestore({
    kind: 'cluster',
    artifactDir,
    dumpPath,
    postgres: options.postgres,
    staged: stageVerifiedTrees(artifactDir, manifest.backupRootDir, [
      { treeDirName: SYSTEM_CONFIG_DIR_NAME, destination: options.destinations.systemDataDir },
      { treeDirName: WORKSPACE_TREE_DIR_NAME, destination: options.destinations.sharedWorkspacePath },
    ]),
  });
}

export async function restoreFleetGroupArtifact(options: {
  fleetManifestPath: string;
  destinations: { groupCompanionDataDir: string; groupWorkspacesRoot: string; systemDataDir: string };
  postgres: FleetRestorePostgresOptions;
}): Promise<FleetRestoreResult> {
  const manifest = parseFleetManifest(options.fleetManifestPath);
  if (manifest.mode !== 'group') throw new Error('Group restore requires a group fleet backup');
  const unit = requireSingleUnit(manifest, candidate => candidate.kind === 'group', 'group');
  const artifactDir = resolveArtifactDir(manifest, unit);
  verifyCompanionTreeSnapshot(artifactDir);
  verifyWorkspaceTreeSnapshot(artifactDir);
  verifySystemConfigSnapshot(artifactDir);
  const dumpPath = findDatabaseDump(artifactDir);
  return await commitRestore({
    kind: 'group',
    artifactDir,
    dumpPath,
    postgres: options.postgres,
    staged: stageVerifiedTrees(artifactDir, manifest.backupRootDir, [
      { treeDirName: COMPANION_TREE_DIR_NAME, destination: options.destinations.groupCompanionDataDir },
      { treeDirName: WORKSPACE_TREE_DIR_NAME, destination: options.destinations.groupWorkspacesRoot },
      { treeDirName: SYSTEM_CONFIG_DIR_NAME, destination: options.destinations.systemDataDir },
    ]),
  });
}
