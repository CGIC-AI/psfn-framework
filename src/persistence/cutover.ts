import {
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, relative, resolve } from 'node:path';
import type { SubstrateConfig } from '../types.js';
import { createComponentLogger } from '../shared/logger.js';
import { writeJsonAtomic } from '../system/config/load-or-seed.js';
import {
  DEFAULT_LEGACY_SHARED_DATA_DIR,
  migrateLegacyPersistenceLayout,
  resolveBackupsDir,
  resolveCharacterCardHistoryPath,
  resolveContactsDir,
  resolveHeartbeatPolicyPath,
  resolveIdentityAssetsDir,
  resolveLastActiveSessionPath,
  resolveNorthStarPath,
  resolveNotesDir,
  resolvePromptHistoryPath,
  resolvePromptLayersPath,
  resolvePromptRegistryHistoryPath,
  resolvePromptRegistryPath,
  resolveSafeguardAuditTrailPath,
  resolveSessionsDir,
  resolveValuesJournalPath,
} from './layout.js';

const log = createComponentLogger('PersistenceCutover');

const DEFAULT_LEGACY_COMPANION_DIR = './companion';
const DEFAULT_CHARACTER_CARD_FILE_NAME = 'character.json';
const DEFAULT_DATABASE_FILE_NAME = 'companion.db';
const DEFAULT_GATEWAY_AUDIT_DB_FILE_NAME = 'gateway-audit.db';
const CUTOVER_MANIFEST_DIR = 'migrations';
const CUTOVER_MANIFEST_PREFIX = 'persistence-cutover';
const HASH_BUFFER_BYTES = 64 * 1024;

const SYSTEM_FILE_NAMES = [
  'settings.json',
  'models.json',
  'scheduler.json',
  'capability-tier.json',
  'channels.json',
  'skills.json',
  'trust-policy.json',
] as const;

type ArtifactOwner = 'system' | 'companion';
type ArtifactKind = 'file' | 'dir';
type CutoverEntryStatus =
  | 'pending_migration'
  | 'cleanup_legacy_source'
  | 'already_migrated'
  | 'absent'
  | 'conflict';

export interface ArtifactSignature {
  kind: ArtifactKind;
  fileCount: number;
  directoryCount: number;
  totalBytes: number;
  sha256: string;
}

interface PersistenceCutoverSpec {
  id: string;
  owner: ArtifactOwner;
  kind: ArtifactKind;
  description: string;
  targetPath: string;
  sourceCandidates: string[];
}

export interface PersistenceCutoverEntry {
  id: string;
  owner: ArtifactOwner;
  kind: ArtifactKind;
  description: string;
  status: CutoverEntryStatus;
  sourcePath?: string;
  targetPath: string;
  sourceCandidates: string[];
  sourceSignature?: ArtifactSignature;
  targetSignature?: ArtifactSignature;
  conflictReason?: string;
}

export interface PersistenceCutoverPlan {
  splitRoots: boolean;
  systemDataDir: string;
  companionDataDir: string;
  legacySharedDataDir: string;
  legacyCompanionDir: string;
  entries: PersistenceCutoverEntry[];
  pendingMigrationCount: number;
  cleanupLegacyCount: number;
  conflictCount: number;
  actionableCount: number;
  canApply: boolean;
}

export interface PersistenceCutoverOptions {
  systemDataDir: string;
  companionDataDir: string;
  legacySharedDataDir?: string;
  legacyCompanionDir?: string;
  characterCardPath?: string;
  databasePath?: string;
  auditDbPath?: string;
}

export interface PersistenceCutoverExecutionResult {
  dryRun: boolean;
  plan: PersistenceCutoverPlan;
  manifestPath?: string;
  backupRootDir?: string;
  migratedEntryIds: string[];
  cleanedLegacyEntryIds: string[];
}

interface CutoverManifestEntry {
  id: string;
  owner: ArtifactOwner;
  kind: ArtifactKind;
  description: string;
  status: CutoverEntryStatus | 'completed_migration' | 'completed_cleanup';
  sourcePath?: string;
  targetPath: string;
  backupPath?: string;
  sourceSignature?: ArtifactSignature;
  targetSignature?: ArtifactSignature;
  conflictReason?: string;
}

interface CutoverManifest {
  schemaVersion: 1;
  status: 'in_progress' | 'completed';
  startedAt: string;
  completedAt?: string;
  systemDataDir: string;
  companionDataDir: string;
  legacySharedDataDir: string;
  legacyCompanionDir: string;
  backupRootDir: string;
  rollbackNotes: string[];
  entries: CutoverManifestEntry[];
}

function normalizeNonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function uniqueResolvedPaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of paths) {
    const resolvedCandidate = resolve(candidate);
    if (seen.has(resolvedCandidate)) continue;
    seen.add(resolvedCandidate);
    result.push(resolvedCandidate);
  }
  return result;
}

function ensurePathWithinRoot(path: string, root: string): void {
  const relativePath = relative(resolve(root), resolve(path));
  if (relativePath === '' || (!relativePath.startsWith('..') && !relativePath.includes(`..${process.platform === 'win32' ? '\\' : '/'}`))) {
    return;
  }
  throw new Error(`Path ${path} must stay inside ${root} in split-root mode`);
}

function hashFileSync(path: string): string {
  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
  try {
    for (;;) {
      const bytesRead = readSync(fd, buffer, 0, HASH_BUFFER_BYTES, null);
      if (bytesRead === 0) break;
      hash.update(bytesRead === HASH_BUFFER_BYTES ? buffer : buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

function summarizePath(path: string): ArtifactSignature {
  const stats = statSync(path);
  if (stats.isFile()) {
    return {
      kind: 'file',
      fileCount: 1,
      directoryCount: 0,
      totalBytes: stats.size,
      sha256: hashFileSync(path),
    };
  }

  if (!stats.isDirectory()) {
    throw new Error(`Unsupported artifact type at ${path}`);
  }

  const hash = createHash('sha256');
  let fileCount = 0;
  let directoryCount = 1;
  let totalBytes = 0;
  const stack: Array<{ absolutePath: string; relativePath: string }> = [{ absolutePath: path, relativePath: '' }];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const entries = readdirSync(current.absolutePath, { withFileTypes: true })
      .map((entry) => ({
        entry,
        relativePath: current.relativePath ? `${current.relativePath}/${entry.name}` : entry.name,
        absolutePath: join(current.absolutePath, entry.name),
      }))
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath));

    for (const item of entries) {
      if (item.entry.isDirectory()) {
        directoryCount += 1;
        hash.update(`dir:${item.relativePath}\n`);
        stack.push({ absolutePath: item.absolutePath, relativePath: item.relativePath });
        continue;
      }

      if (!item.entry.isFile()) {
        throw new Error(`Unsupported nested artifact type at ${item.absolutePath}`);
      }

      const nestedStats = statSync(item.absolutePath);
      const nestedHash = hashFileSync(item.absolutePath);
      fileCount += 1;
      totalBytes += nestedStats.size;
      hash.update(`file:${item.relativePath}:${nestedStats.size}:${nestedHash}\n`);
    }
  }

  return {
    kind: 'dir',
    fileCount,
    directoryCount,
    totalBytes,
    sha256: hash.digest('hex'),
  };
}

function signaturesEqual(left: ArtifactSignature | undefined, right: ArtifactSignature | undefined): boolean {
  if (!left || !right) return false;
  return left.kind === right.kind
    && left.fileCount === right.fileCount
    && left.directoryCount === right.directoryCount
    && left.totalBytes === right.totalBytes
    && left.sha256 === right.sha256;
}

function copyPath(sourcePath: string, targetPath: string, kind: ArtifactKind): void {
  mkdirSync(dirname(targetPath), { recursive: true });
  if (kind === 'dir') {
    cpSync(sourcePath, targetPath, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    return;
  }

  copyFileSync(sourcePath, targetPath);
}

function removePath(path: string, kind: ArtifactKind): void {
  if (kind === 'dir') {
    rmSync(path, { recursive: true, force: false });
    return;
  }
  unlinkSync(path);
}

function buildRollbackNotes(manifestPath: string, backupRootDir: string): string[] {
  return [
    `Stop runtime processes before rolling back this cutover.`,
    `Backup copies of legacy artifacts were preserved under ${backupRootDir}.`,
    `Use ${manifestPath} to map each migrated target back to its original source path before restoring.`,
    `If you must roll back, remove the migrated targets and copy the backed-up legacy artifacts back to their source paths.`,
  ];
}

function buildBackupPath(entry: PersistenceCutoverEntry, backupRootDir: string, plan: PersistenceCutoverPlan): string {
  const ownerRoot = entry.owner === 'system'
    ? resolve(plan.systemDataDir)
    : resolve(plan.companionDataDir);
  const ownerRelativeTarget = relative(ownerRoot, resolve(entry.targetPath));
  if (ownerRelativeTarget.startsWith('..')) {
    return join(backupRootDir, entry.owner, basename(entry.targetPath));
  }
  return join(backupRootDir, entry.owner, ownerRelativeTarget);
}

function relativePathWithinRoot(path: string | undefined, root: string): string | undefined {
  const normalizedPath = normalizeNonEmpty(path);
  if (!normalizedPath) return undefined;
  const relativePath = relative(resolve(root), resolve(normalizedPath));
  if (relativePath === '') {
    return '.';
  }
  if (relativePath.startsWith('..') || relativePath.includes(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    return undefined;
  }
  return relativePath;
}

function deriveOwnedTargetPath(
  explicitPath: string | undefined,
  ownerRoot: string,
  defaultFileName: string,
): string {
  const relativePath = relativePathWithinRoot(explicitPath, ownerRoot);
  if (relativePath && relativePath !== '.') {
    return join(resolve(ownerRoot), relativePath);
  }
  const fileName = basename(normalizeNonEmpty(explicitPath) ?? defaultFileName);
  return join(resolve(ownerRoot), fileName || defaultFileName);
}

function buildCompanionSpecs(options: {
  companionDataDir: string;
  legacySharedDataDir: string;
  legacyCompanionDir: string;
}): PersistenceCutoverSpec[] {
  return [
    {
      id: 'companion.values_journal',
      owner: 'companion',
      kind: 'file',
      description: 'legacy values journal',
      targetPath: resolveValuesJournalPath(options.companionDataDir),
      sourceCandidates: uniqueResolvedPaths([
        join(options.legacyCompanionDir, 'values.jsonl'),
        join(options.legacySharedDataDir, 'values.jsonl'),
      ]),
    },
    {
      id: 'companion.character_history',
      owner: 'companion',
      kind: 'file',
      description: 'character card history',
      targetPath: resolveCharacterCardHistoryPath(options.companionDataDir),
      sourceCandidates: uniqueResolvedPaths([
        join(options.legacyCompanionDir, 'character-card-history.jsonl'),
        join(options.legacySharedDataDir, 'character-card-history.jsonl'),
      ]),
    },
    {
      id: 'companion.prompt_layers',
      owner: 'companion',
      kind: 'file',
      description: 'prompt layers',
      targetPath: resolvePromptLayersPath(options.companionDataDir),
      sourceCandidates: uniqueResolvedPaths([
        join(options.legacyCompanionDir, 'prompt-layers.json'),
        join(options.legacySharedDataDir, 'prompt-layers.json'),
      ]),
    },
    {
      id: 'companion.prompt_history',
      owner: 'companion',
      kind: 'file',
      description: 'prompt layer history',
      targetPath: resolvePromptHistoryPath(options.companionDataDir),
      sourceCandidates: uniqueResolvedPaths([
        join(options.legacyCompanionDir, 'prompt-history.jsonl'),
        join(options.legacySharedDataDir, 'prompt-history.jsonl'),
      ]),
    },
    {
      id: 'companion.prompt_registry',
      owner: 'companion',
      kind: 'file',
      description: 'prompt registry',
      targetPath: resolvePromptRegistryPath(options.companionDataDir),
      sourceCandidates: uniqueResolvedPaths([
        join(options.legacyCompanionDir, 'prompt-registry.json'),
        join(options.legacySharedDataDir, 'prompt-registry.json'),
      ]),
    },
    {
      id: 'companion.prompt_registry_history',
      owner: 'companion',
      kind: 'file',
      description: 'prompt registry history',
      targetPath: resolvePromptRegistryHistoryPath(options.companionDataDir),
      sourceCandidates: uniqueResolvedPaths([
        join(options.legacyCompanionDir, 'prompt-registry-history.jsonl'),
        join(options.legacySharedDataDir, 'prompt-registry-history.jsonl'),
      ]),
    },
    {
      id: 'companion.north_star',
      owner: 'companion',
      kind: 'file',
      description: 'north star goals',
      targetPath: resolveNorthStarPath(options.companionDataDir),
      sourceCandidates: uniqueResolvedPaths([
        join(options.legacyCompanionDir, 'north-star.json'),
        join(options.legacySharedDataDir, 'north-star.json'),
      ]),
    },
    {
      id: 'companion.heartbeat_policy',
      owner: 'companion',
      kind: 'file',
      description: 'heartbeat policy',
      targetPath: resolveHeartbeatPolicyPath(options.companionDataDir),
      sourceCandidates: uniqueResolvedPaths([
        join(options.legacyCompanionDir, 'heartbeat-policy.json'),
        join(options.legacySharedDataDir, 'heartbeat-policy.json'),
      ]),
    },
    {
      id: 'companion.safeguards_audit',
      owner: 'companion',
      kind: 'file',
      description: 'safeguards audit trail',
      targetPath: resolveSafeguardAuditTrailPath(options.companionDataDir),
      sourceCandidates: uniqueResolvedPaths([
        join(options.legacyCompanionDir, 'safeguards-audit.jsonl'),
        join(options.legacySharedDataDir, 'safeguards-audit.jsonl'),
      ]),
    },
    {
      id: 'companion.last_active_session',
      owner: 'companion',
      kind: 'file',
      description: 'last active session metadata',
      targetPath: resolveLastActiveSessionPath(options.companionDataDir),
      sourceCandidates: uniqueResolvedPaths([
        join(options.legacyCompanionDir, 'last_active_channel.json'),
        join(options.legacySharedDataDir, 'last_active_channel.json'),
      ]),
    },
    {
      id: 'companion.sessions',
      owner: 'companion',
      kind: 'dir',
      description: 'session journals',
      targetPath: resolveSessionsDir(options.companionDataDir),
      sourceCandidates: uniqueResolvedPaths([
        join(options.legacyCompanionDir, 'sessions'),
        join(options.legacySharedDataDir, 'sessions'),
      ]),
    },
    {
      id: 'companion.notes',
      owner: 'companion',
      kind: 'dir',
      description: 'notes and reflections',
      targetPath: resolveNotesDir(options.companionDataDir),
      sourceCandidates: uniqueResolvedPaths([
        join(options.legacyCompanionDir, 'notes'),
        join(options.legacySharedDataDir, 'notes'),
      ]),
    },
    {
      id: 'companion.contacts',
      owner: 'companion',
      kind: 'dir',
      description: 'contact exports and continuity',
      targetPath: resolveContactsDir(options.companionDataDir),
      sourceCandidates: uniqueResolvedPaths([
        join(options.legacyCompanionDir, 'contacts'),
        join(options.legacySharedDataDir, 'contacts'),
      ]),
    },
    {
      id: 'companion.identity_assets',
      owner: 'companion',
      kind: 'dir',
      description: 'imported identity assets',
      targetPath: resolveIdentityAssetsDir(options.companionDataDir),
      sourceCandidates: uniqueResolvedPaths([
        join(options.legacyCompanionDir, 'identity-assets'),
        join(options.legacySharedDataDir, 'identity-assets'),
      ]),
    },
    {
      id: 'companion.backups',
      owner: 'companion',
      kind: 'dir',
      description: 'scheduled backups',
      targetPath: resolveBackupsDir(options.companionDataDir),
      sourceCandidates: uniqueResolvedPaths([
        join(options.legacyCompanionDir, 'backups'),
        join(options.legacySharedDataDir, 'backups'),
      ]),
    },
  ];
}

function buildSpecs(options: PersistenceCutoverOptions): PersistenceCutoverSpec[] {
  const systemDataDir = resolve(options.systemDataDir);
  const companionDataDir = resolve(options.companionDataDir);
  const legacySharedDataDir = resolve(options.legacySharedDataDir ?? DEFAULT_LEGACY_SHARED_DATA_DIR);
  const legacyCompanionDir = resolve(options.legacyCompanionDir ?? DEFAULT_LEGACY_COMPANION_DIR);
  const specs: PersistenceCutoverSpec[] = [];

  for (const fileName of SYSTEM_FILE_NAMES) {
    specs.push({
      id: `system.${fileName.replaceAll(/[^A-Za-z0-9]+/g, '_')}`,
      owner: 'system',
      kind: 'file',
      description: fileName,
      targetPath: join(systemDataDir, fileName),
      sourceCandidates: [join(legacySharedDataDir, fileName)],
    });
  }

  const characterCardTargetPath = deriveOwnedTargetPath(
    options.characterCardPath,
    companionDataDir,
    DEFAULT_CHARACTER_CARD_FILE_NAME,
  );
  const characterCardOverrideSource = normalizeNonEmpty(options.characterCardPath);
  specs.push({
    id: 'companion.character_card',
    owner: 'companion',
    kind: 'file',
    description: 'character card',
    targetPath: characterCardTargetPath,
    sourceCandidates: uniqueResolvedPaths([
      ...(characterCardOverrideSource ? [characterCardOverrideSource] : []),
      join(legacyCompanionDir, basename(characterCardTargetPath)),
      join(legacySharedDataDir, basename(characterCardTargetPath)),
    ]),
  });

  const databaseTargetPath = deriveOwnedTargetPath(
    options.databasePath,
    companionDataDir,
    DEFAULT_DATABASE_FILE_NAME,
  );
  const databaseOverrideSource = normalizeNonEmpty(options.databasePath);
  const databaseFileName = basename(databaseTargetPath);
  for (const suffix of ['', '-wal', '-shm']) {
    const label = suffix === '' ? 'database' : `database sidecar ${suffix}`;
    specs.push({
      id: suffix === ''
        ? 'companion.database'
        : `companion.database_${suffix.slice(1)}`,
      owner: 'companion',
      kind: 'file',
      description: label,
      targetPath: `${databaseTargetPath}${suffix}`,
      sourceCandidates: uniqueResolvedPaths([
        ...(databaseOverrideSource ? [`${databaseOverrideSource}${suffix}`] : []),
        join(legacyCompanionDir, `${databaseFileName}${suffix}`),
        join(legacySharedDataDir, `${databaseFileName}${suffix}`),
      ]),
    });
  }

  specs.push(...buildCompanionSpecs({
    companionDataDir,
    legacySharedDataDir,
    legacyCompanionDir,
  }));

  const auditDbTargetPath = deriveOwnedTargetPath(
    options.auditDbPath,
    systemDataDir,
    DEFAULT_GATEWAY_AUDIT_DB_FILE_NAME,
  );
  const auditDbOverrideSource = normalizeNonEmpty(options.auditDbPath);
  const auditDbFileName = basename(auditDbTargetPath);
  specs.push({
    id: 'system.gateway_audit_db',
    owner: 'system',
    kind: 'file',
    description: 'gateway audit database',
    targetPath: auditDbTargetPath,
    sourceCandidates: uniqueResolvedPaths([
      ...(auditDbOverrideSource ? [auditDbOverrideSource] : []),
      join(legacySharedDataDir, auditDbFileName),
    ]),
  });

  return specs;
}

function selectSourcePath(spec: PersistenceCutoverSpec): {
  sourcePath?: string;
  sourceSignature?: ArtifactSignature;
  conflictReason?: string;
} {
  const existingSources = spec.sourceCandidates
    .filter(candidate => resolve(candidate) !== resolve(spec.targetPath))
    .filter(candidate => existsSync(candidate))
    .map((candidate) => ({
      candidate,
      signature: summarizePath(candidate),
    }));

  if (existingSources.length === 0) {
    return {};
  }

  if (existingSources.length > 1) {
    return {
      conflictReason: `Multiple legacy sources found for ${spec.id}: ${existingSources.map(source => source.candidate).join(', ')}`,
    };
  }

  return {
    sourcePath: existingSources[0]?.candidate,
    sourceSignature: existingSources[0]?.signature,
  };
}

export function buildPersistenceCutoverPlan(options: PersistenceCutoverOptions): PersistenceCutoverPlan {
  const systemDataDir = resolve(options.systemDataDir);
  const companionDataDir = resolve(options.companionDataDir);
  const legacySharedDataDir = resolve(options.legacySharedDataDir ?? DEFAULT_LEGACY_SHARED_DATA_DIR);
  const legacyCompanionDir = resolve(options.legacyCompanionDir ?? DEFAULT_LEGACY_COMPANION_DIR);
  const splitRoots = systemDataDir !== companionDataDir;

  const entries = buildSpecs({
    ...options,
    systemDataDir,
    companionDataDir,
    legacySharedDataDir,
    legacyCompanionDir,
  }).map((spec): PersistenceCutoverEntry => {
    const targetSignature = existsSync(spec.targetPath) ? summarizePath(spec.targetPath) : undefined;
    const selected = selectSourcePath(spec);
    if (selected.conflictReason) {
      return {
        id: spec.id,
        owner: spec.owner,
        kind: spec.kind,
        description: spec.description,
        status: 'conflict',
        targetPath: spec.targetPath,
        sourceCandidates: spec.sourceCandidates,
        targetSignature,
        conflictReason: selected.conflictReason,
      };
    }

    if (!selected.sourcePath) {
      return {
        id: spec.id,
        owner: spec.owner,
        kind: spec.kind,
        description: spec.description,
        status: targetSignature ? 'already_migrated' : 'absent',
        targetPath: spec.targetPath,
        sourceCandidates: spec.sourceCandidates,
        targetSignature,
      };
    }

    if (!targetSignature) {
      return {
        id: spec.id,
        owner: spec.owner,
        kind: spec.kind,
        description: spec.description,
        status: 'pending_migration',
        sourcePath: selected.sourcePath,
        targetPath: spec.targetPath,
        sourceCandidates: spec.sourceCandidates,
        sourceSignature: selected.sourceSignature,
      };
    }

    if (signaturesEqual(selected.sourceSignature, targetSignature)) {
      return {
        id: spec.id,
        owner: spec.owner,
        kind: spec.kind,
        description: spec.description,
        status: 'cleanup_legacy_source',
        sourcePath: selected.sourcePath,
        targetPath: spec.targetPath,
        sourceCandidates: spec.sourceCandidates,
        sourceSignature: selected.sourceSignature,
        targetSignature,
      };
    }

    return {
      id: spec.id,
      owner: spec.owner,
      kind: spec.kind,
      description: spec.description,
      status: 'conflict',
      sourcePath: selected.sourcePath,
      targetPath: spec.targetPath,
      sourceCandidates: spec.sourceCandidates,
      sourceSignature: selected.sourceSignature,
      targetSignature,
      conflictReason: `Legacy source and target differ for ${spec.id}`,
    };
  });

  const pendingMigrationCount = entries.filter(entry => entry.status === 'pending_migration').length;
  const cleanupLegacyCount = entries.filter(entry => entry.status === 'cleanup_legacy_source').length;
  const conflictCount = entries.filter(entry => entry.status === 'conflict').length;

  return {
    splitRoots,
    systemDataDir,
    companionDataDir,
    legacySharedDataDir,
    legacyCompanionDir,
    entries,
    pendingMigrationCount,
    cleanupLegacyCount,
    conflictCount,
    actionableCount: pendingMigrationCount + cleanupLegacyCount + conflictCount,
    canApply: splitRoots && conflictCount === 0,
  };
}

export function assertPersistenceCutoverReady(
  options: PersistenceCutoverOptions,
): void {
  const plan = buildPersistenceCutoverPlan(options);
  if (!plan.splitRoots) {
    return;
  }

  const characterCardPath = normalizeNonEmpty(options.characterCardPath);
  if (characterCardPath) {
    ensurePathWithinRoot(characterCardPath, plan.companionDataDir);
  }

  const databasePath = normalizeNonEmpty(options.databasePath);
  if (databasePath) {
    ensurePathWithinRoot(databasePath, plan.companionDataDir);
  }

  const auditDbPath = normalizeNonEmpty(options.auditDbPath);
  if (auditDbPath) {
    ensurePathWithinRoot(auditDbPath, plan.systemDataDir);
  }

  if (plan.actionableCount === 0) {
    return;
  }

  const pendingIds = plan.entries
    .filter(entry => entry.status === 'pending_migration' || entry.status === 'cleanup_legacy_source' || entry.status === 'conflict')
    .map(entry => `${entry.id}:${entry.status}`)
    .join(', ');

  throw new Error(
    `Split persistence roots are configured but legacy data still needs cutover. ` +
    `Run "npm run migrate:persistence-layout" to inspect the plan and ` +
    `"npm run migrate:persistence-layout -- --apply" to migrate before startup. ` +
    `Outstanding artifacts: ${pendingIds}`,
  );
}

function buildManifestPath(plan: PersistenceCutoverPlan): { manifestPath: string; backupRootDir: string } {
  const stamp = new Date().toISOString().replaceAll(':', '-');
  const rootDir = join(plan.systemDataDir, CUTOVER_MANIFEST_DIR, `${CUTOVER_MANIFEST_PREFIX}-${stamp}`);
  return {
    manifestPath: join(rootDir, 'manifest.json'),
    backupRootDir: join(rootDir, 'legacy-backup'),
  };
}

function writeManifest(manifestPath: string, manifest: CutoverManifest): void {
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeJsonAtomic(manifestPath, manifest);
}

export function executePersistenceCutover(
  options: PersistenceCutoverOptions,
  execution: { dryRun?: boolean } = {},
): PersistenceCutoverExecutionResult {
  const plan = buildPersistenceCutoverPlan(options);
  const dryRun = execution.dryRun === true;
  if (!plan.splitRoots) {
    throw new Error('Persistence cutover requires distinct SYSTEM_DATA_DIR and COMPANION_DATA_DIR targets');
  }
  if (!plan.canApply) {
    const conflicts = plan.entries
      .filter(entry => entry.status === 'conflict')
      .map(entry => entry.conflictReason ?? entry.id)
      .join('; ');
    throw new Error(`Refusing to apply persistence cutover with conflicts: ${conflicts}`);
  }

  if (dryRun) {
    return {
      dryRun: true,
      plan,
      migratedEntryIds: [],
      cleanedLegacyEntryIds: [],
    };
  }

  mkdirSync(plan.systemDataDir, { recursive: true });
  mkdirSync(plan.companionDataDir, { recursive: true });

  const { manifestPath, backupRootDir } = buildManifestPath(plan);
  const manifest: CutoverManifest = {
    schemaVersion: 1,
    status: 'in_progress',
    startedAt: new Date().toISOString(),
    systemDataDir: plan.systemDataDir,
    companionDataDir: plan.companionDataDir,
    legacySharedDataDir: plan.legacySharedDataDir,
    legacyCompanionDir: plan.legacyCompanionDir,
    backupRootDir,
    rollbackNotes: buildRollbackNotes(manifestPath, backupRootDir),
    entries: plan.entries.map(entry => ({
      id: entry.id,
      owner: entry.owner,
      kind: entry.kind,
      description: entry.description,
      status: entry.status,
      sourcePath: entry.sourcePath,
      targetPath: entry.targetPath,
      sourceSignature: entry.sourceSignature,
      targetSignature: entry.targetSignature,
      conflictReason: entry.conflictReason,
    })),
  };
  writeManifest(manifestPath, manifest);

  const migratedEntryIds: string[] = [];
  const cleanedLegacyEntryIds: string[] = [];

  for (const entry of plan.entries) {
    if (entry.status !== 'pending_migration' && entry.status !== 'cleanup_legacy_source') continue;
    if (!entry.sourcePath) {
      throw new Error(`Missing source path for actionable cutover entry ${entry.id}`);
    }

    const backupPath = buildBackupPath(entry, backupRootDir, plan);
    mkdirSync(dirname(backupPath), { recursive: true });

    if (entry.status === 'pending_migration') {
      copyPath(entry.sourcePath, entry.targetPath, entry.kind);
      const verifiedTarget = summarizePath(entry.targetPath);
      if (!signaturesEqual(entry.sourceSignature, verifiedTarget)) {
        throw new Error(`Integrity verification failed after copying ${entry.id} to ${entry.targetPath}`);
      }
      copyPath(entry.sourcePath, backupPath, entry.kind);
      const verifiedBackup = summarizePath(backupPath);
      if (!signaturesEqual(entry.sourceSignature, verifiedBackup)) {
        throw new Error(`Integrity verification failed while backing up ${entry.id} to ${backupPath}`);
      }
      removePath(entry.sourcePath, entry.kind);
      migratedEntryIds.push(entry.id);
      manifest.entries = manifest.entries.map((manifestEntry) => manifestEntry.id === entry.id
        ? {
          ...manifestEntry,
          status: 'completed_migration',
          backupPath,
          targetSignature: verifiedTarget,
        }
        : manifestEntry);
      writeManifest(manifestPath, manifest);
      continue;
    }

    copyPath(entry.sourcePath, backupPath, entry.kind);
    const verifiedBackup = summarizePath(backupPath);
    if (!signaturesEqual(entry.sourceSignature, verifiedBackup)) {
      throw new Error(`Integrity verification failed while backing up duplicate legacy source ${entry.id}`);
    }
    removePath(entry.sourcePath, entry.kind);
    cleanedLegacyEntryIds.push(entry.id);
    manifest.entries = manifest.entries.map((manifestEntry) => manifestEntry.id === entry.id
      ? {
        ...manifestEntry,
        status: 'completed_cleanup',
        backupPath,
      }
      : manifestEntry);
    writeManifest(manifestPath, manifest);
  }

  if (migratedEntryIds.some(entryId => entryId.startsWith('companion.')) || cleanedLegacyEntryIds.some(entryId => entryId.startsWith('companion.'))) {
    migrateLegacyPersistenceLayout(plan.companionDataDir);
  }

  manifest.status = 'completed';
  manifest.completedAt = new Date().toISOString();
  writeManifest(manifestPath, manifest);
  log.info('Persistence cutover completed', {
    manifestPath,
    migratedCount: migratedEntryIds.length,
    cleanupCount: cleanedLegacyEntryIds.length,
  });

  return {
    dryRun: false,
    plan,
    manifestPath,
    backupRootDir,
    migratedEntryIds,
    cleanedLegacyEntryIds,
  };
}

export function buildPersistenceCutoverOptionsFromConfig(
  config: Pick<SubstrateConfig, 'characterCardPath' | 'databasePath' | 'systemDataDir' | 'companionDataDir' | 'dataDir'>,
  env: NodeJS.ProcessEnv = process.env,
): PersistenceCutoverOptions {
  const systemDataDir = config.systemDataDir ?? config.dataDir;
  return {
    systemDataDir,
    companionDataDir: config.companionDataDir ?? config.dataDir,
    legacySharedDataDir: env.DATA_DIR ?? DEFAULT_LEGACY_SHARED_DATA_DIR,
    legacyCompanionDir: DEFAULT_LEGACY_COMPANION_DIR,
    characterCardPath: config.characterCardPath,
    databasePath: config.databasePath,
    auditDbPath: env.AUDIT_DB_PATH?.trim() || join(systemDataDir, DEFAULT_GATEWAY_AUDIT_DB_FILE_NAME),
  };
}
