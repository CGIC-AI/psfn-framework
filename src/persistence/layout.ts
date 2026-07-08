import { existsSync, mkdirSync, readdirSync, renameSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { createComponentLogger } from '../shared/logger.js';
import { readJournalFirstEntry } from './journals/journal-utils.js';
import { sanitizeChannelId } from './sessions/store-primitives.js';
import { writeJsonAtomic } from '../shared/utils/fs.js';

const log = createComponentLogger('PersistenceLayout');

interface ChannelIndexPayload {
  version?: number;
  channels?: Record<string, unknown>;
}

export const DEFAULT_LEGACY_SHARED_DATA_DIR = './data';
export const DEFAULT_CONTINUOUS_SYSTEM_DATA_DIR = './data';
export const DEFAULT_CONTINUOUS_COMPANION_DATA_DIR = './companion';
export const DEFAULT_PRODUCTION_RUNTIME_ROOT = './runtime/production';
export const DEFAULT_CONTINUOUS_RUNTIME_ROOT = '.';

export interface PersistenceRoots {
  systemDataDir: string;
  companionDataDir: string;
  usesLegacySharedDataDir: boolean;
}

export interface PersistenceRootOptions {
  systemDataDir?: string;
  companionDataDir?: string;
  legacyDataDir?: string;
}

export interface ConfiguredPersistenceDirs {
  dataDir?: string;
  systemDataDir?: string;
  companionDataDir?: string;
}

export const RUNTIME_LAYOUT_MODE = Object.freeze({
  CONTINUOUS: 'continuous',
  PRODUCTION: 'production',
} as const);

export type RuntimeLayoutMode = (typeof RUNTIME_LAYOUT_MODE)[keyof typeof RUNTIME_LAYOUT_MODE];

export interface RuntimePathLayoutOptions extends PersistenceRootOptions {
  mode?: string;
  nodeEnv?: string;
  runtimeRootDir?: string;
  workspacePath?: string;
  logsDir?: string;
  tempDir?: string;
  backupsDir?: string;
}

export interface RuntimePathLayout extends PersistenceRoots {
  mode: RuntimeLayoutMode;
  runtimeRootDir: string;
  workspacePath: string;
  logsDir: string;
  tempDir: string;
  backupsDir: string;
}

export interface RuntimePathSnapshot extends PersistenceRoots {
  runtimePathLayout: RuntimePathLayout;
  workspacePath: string;
  workspaceRoot: string;
}

const DEFAULT_LEGACY_CONTINUOUS_WORKSPACE_PATH = './workspace';
const DEFAULT_CONTINUOUS_LOGS_DIR = './logs';
const DEFAULT_CONTINUOUS_TEMP_DIR = './tmp';
const DEFAULT_PRODUCTION_SYSTEM_DATA_DIR = `${DEFAULT_PRODUCTION_RUNTIME_ROOT}/system-data`;
const DEFAULT_PRODUCTION_COMPANION_DATA_DIR = `${DEFAULT_PRODUCTION_RUNTIME_ROOT}/companion-data`;
const DEFAULT_PRODUCTION_WORKSPACE_PATH = `${DEFAULT_PRODUCTION_RUNTIME_ROOT}/workspace`;
const DEFAULT_PRODUCTION_LOGS_DIR = `${DEFAULT_PRODUCTION_RUNTIME_ROOT}/logs`;
const DEFAULT_PRODUCTION_TEMP_DIR = `${DEFAULT_PRODUCTION_RUNTIME_ROOT}/tmp`;
const DEFAULT_PRODUCTION_BACKUPS_DIR = `${DEFAULT_PRODUCTION_RUNTIME_ROOT}/backups`;
const PERSONAL_DOCS_DIRNAME = 'docs';
const PERSONAL_DOWNLOADS_DIRNAME = 'downloads';
const PERSONAL_IMAGES_DIRNAME = 'images';
const PERSONAL_JOURNAL_DIRNAME = 'journal';
const PERSONAL_KNOWLEDGE_DIRNAME = 'knowledge';
const PERSONAL_WIKI_DIRNAME = 'wiki';
const PERSONAL_SCRATCHPAD_DIRNAME = 'scratchpad';
const PERSONAL_SKILLS_DIRNAME = 'skills';
const PERSONAL_MODULES_DIRNAME = 'modules';
const PERSONAL_EXPERIMENTS_DIRNAME = 'experiments';
const PERSONAL_TMP_DIRNAME = 'tmp';
const COMPANION_STATE_DIRNAME = 'state';
const SYSTEM_STATE_DIRNAME = 'state';
const COMPANION_DOCS_DIRNAME = 'docs';
const COMPANION_WORKSPACE_DIRNAME = 'workspace';
const COMPANION_IMAGES_DIRNAME = 'images';
const COMPANION_VAULT_DIRNAME = 'vault';
const COMPANION_SKILLS_DIRNAME = 'skills';

const RUNTIME_LAYOUT_MODE_ALIASES: Readonly<Record<string, RuntimeLayoutMode>> = Object.freeze({
  continuous: RUNTIME_LAYOUT_MODE.CONTINUOUS,
  dev: RUNTIME_LAYOUT_MODE.CONTINUOUS,
  development: RUNTIME_LAYOUT_MODE.CONTINUOUS,
  production: RUNTIME_LAYOUT_MODE.PRODUCTION,
  prod: RUNTIME_LAYOUT_MODE.PRODUCTION,
  live: RUNTIME_LAYOUT_MODE.PRODUCTION,
});

function normalizeDir(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeRuntimeLayoutMode(value: string | undefined): RuntimeLayoutMode | null {
  const normalized = value?.trim().toLowerCase() ?? '';
  if (!normalized) return null;
  return RUNTIME_LAYOUT_MODE_ALIASES[normalized] ?? null;
}

export function resolveRuntimeLayoutMode(
  options: { mode?: string; nodeEnv?: string } = {},
): RuntimeLayoutMode {
  const normalizedMode = normalizeRuntimeLayoutMode(options.mode);
  if (normalizedMode) {
    return normalizedMode;
  }

  if (normalizeDir(options.mode)) {
    throw new Error(
      `Unsupported PSFN_RUNTIME_LAYOUT_MODE "${options.mode}". ` +
      'Expected one of: continuous, dev, production, prod.',
    );
  }

  if ((options.nodeEnv ?? '').trim().toLowerCase() === 'production') {
    return RUNTIME_LAYOUT_MODE.PRODUCTION;
  }

  return RUNTIME_LAYOUT_MODE.CONTINUOUS;
}

export function isStrictSubpath(path: string, root: string): boolean {
  const relativePath = relative(resolve(root), resolve(path));
  return relativePath.length > 0 && !relativePath.startsWith('..') && !isAbsolute(relativePath);
}

function assertNoDuplicateRoots(
  mode: RuntimeLayoutMode,
  roots: Readonly<Record<string, string>>,
): void {
  const seen = new Map<string, string>();
  for (const [label, path] of Object.entries(roots)) {
    const resolvedPath = resolve(path);
    const existing = seen.get(resolvedPath);
    if (existing) {
      throw new Error(
        `Runtime layout path "${label}" (${path}) shares a mutable root with "${existing}" in ${mode} mode.`,
      );
    }
    seen.set(resolvedPath, label);
  }
}

function assertNoOverlappingRoots(
  mode: RuntimeLayoutMode,
  roots: Readonly<Record<string, string>>,
): void {
  const entries = Object.entries(roots);
  for (let i = 0; i < entries.length; i += 1) {
    const [firstLabel, firstPath] = entries[i];
    for (let j = i + 1; j < entries.length; j += 1) {
      const [secondLabel, secondPath] = entries[j];
      if (isStrictSubpath(firstPath, secondPath) || isStrictSubpath(secondPath, firstPath)) {
        throw new Error(
          `Runtime layout paths "${firstLabel}" (${firstPath}) and "${secondLabel}" (${secondPath}) ` +
          `must not overlap in ${mode} mode.`,
        );
      }
    }
  }
}

function assertWorkspaceDoesNotOverlapRuntimeState(
  mode: RuntimeLayoutMode,
  workspacePath: string,
  roots: Readonly<Record<string, string>>,
): void {
  for (const [label, root] of Object.entries(roots)) {
    if (workspacePath === root || isStrictSubpath(workspacePath, root) || isStrictSubpath(root, workspacePath)) {
      throw new Error(
        `Personal workspace path (${workspacePath}) must not overlap runtime state root "${label}" (${root}) ` +
        `in ${mode} mode.`,
      );
    }
  }
}

function resolveProductionDefaultPath(
  explicitRuntimeRoot: string | undefined,
  runtimeRootDir: string,
  suffix: string,
): string {
  if (!explicitRuntimeRoot) {
    switch (suffix) {
      case 'system-data':
        return DEFAULT_PRODUCTION_SYSTEM_DATA_DIR;
      case 'companion-data':
        return DEFAULT_PRODUCTION_COMPANION_DATA_DIR;
      case 'workspace':
        return DEFAULT_PRODUCTION_WORKSPACE_PATH;
      case 'logs':
        return DEFAULT_PRODUCTION_LOGS_DIR;
      case 'tmp':
        return DEFAULT_PRODUCTION_TEMP_DIR;
      case 'backups':
        return DEFAULT_PRODUCTION_BACKUPS_DIR;
      default:
        return join(runtimeRootDir, suffix);
    }
  }
  return join(runtimeRootDir, suffix);
}

export function resolveRuntimePathLayout(
  options: RuntimePathLayoutOptions = {},
): RuntimePathLayout {
  const mode = resolveRuntimeLayoutMode({
    mode: options.mode,
    nodeEnv: options.nodeEnv,
  });
  const explicitRuntimeRoot = normalizeDir(options.runtimeRootDir);
  const runtimeRootDir = explicitRuntimeRoot
    ?? (mode === RUNTIME_LAYOUT_MODE.PRODUCTION
      ? DEFAULT_PRODUCTION_RUNTIME_ROOT
      : DEFAULT_CONTINUOUS_RUNTIME_ROOT);

  const explicitSystem = normalizeDir(options.systemDataDir);
  const explicitCompanion = normalizeDir(options.companionDataDir);
  const legacyDataDir = normalizeDir(options.legacyDataDir);

  if ((explicitSystem && !explicitCompanion) || (!explicitSystem && explicitCompanion)) {
    throw new Error(
      'SYSTEM_DATA_DIR and COMPANION_DATA_DIR must both be set together; ' +
      'use DATA_DIR only for continuous mode shared-root compatibility',
    );
  }

  let systemDataDir: string;
  let companionDataDir: string;
  let usesLegacySharedDataDir = false;

  if (explicitSystem && explicitCompanion) {
    if (explicitSystem === explicitCompanion) {
      throw new Error(
        'SYSTEM_DATA_DIR and COMPANION_DATA_DIR must point to different roots; ' +
        'use DATA_DIR only for continuous mode shared-root compatibility',
      );
    }
    systemDataDir = explicitSystem;
    companionDataDir = explicitCompanion;
  } else if (legacyDataDir) {
    if (mode === RUNTIME_LAYOUT_MODE.PRODUCTION) {
      throw new Error(
        'DATA_DIR shared-root mode is forbidden when PSFN runtime layout mode is production. ' +
        'Set SYSTEM_DATA_DIR and COMPANION_DATA_DIR to isolated roots instead.',
      );
    }
    systemDataDir = legacyDataDir;
    companionDataDir = legacyDataDir;
    usesLegacySharedDataDir = true;
  } else if (mode === RUNTIME_LAYOUT_MODE.PRODUCTION) {
    systemDataDir = resolveProductionDefaultPath(explicitRuntimeRoot, runtimeRootDir, 'system-data');
    companionDataDir = resolveProductionDefaultPath(explicitRuntimeRoot, runtimeRootDir, 'companion-data');
  } else if (explicitRuntimeRoot && runtimeRootDir !== DEFAULT_CONTINUOUS_RUNTIME_ROOT) {
    systemDataDir = join(runtimeRootDir, 'data');
    companionDataDir = join(runtimeRootDir, 'companion');
  } else {
    systemDataDir = DEFAULT_CONTINUOUS_SYSTEM_DATA_DIR;
    companionDataDir = DEFAULT_CONTINUOUS_COMPANION_DATA_DIR;
  }

  const workspacePath = normalizeDir(options.workspacePath)
    ?? (mode === RUNTIME_LAYOUT_MODE.PRODUCTION
      ? resolveProductionDefaultPath(explicitRuntimeRoot, runtimeRootDir, 'workspace')
      : (explicitRuntimeRoot && runtimeRootDir !== DEFAULT_CONTINUOUS_RUNTIME_ROOT
        ? join(runtimeRootDir, 'workspace')
        : DEFAULT_LEGACY_CONTINUOUS_WORKSPACE_PATH));
  const logsDir = normalizeDir(options.logsDir)
    ?? (mode === RUNTIME_LAYOUT_MODE.PRODUCTION
      ? resolveProductionDefaultPath(explicitRuntimeRoot, runtimeRootDir, 'logs')
      : (explicitRuntimeRoot && runtimeRootDir !== DEFAULT_CONTINUOUS_RUNTIME_ROOT
        ? join(runtimeRootDir, 'logs')
        : DEFAULT_CONTINUOUS_LOGS_DIR));
  const tempDir = normalizeDir(options.tempDir)
    ?? (mode === RUNTIME_LAYOUT_MODE.PRODUCTION
      ? resolveProductionDefaultPath(explicitRuntimeRoot, runtimeRootDir, 'tmp')
      : (explicitRuntimeRoot && runtimeRootDir !== DEFAULT_CONTINUOUS_RUNTIME_ROOT
        ? join(runtimeRootDir, 'tmp')
        : DEFAULT_CONTINUOUS_TEMP_DIR));
  const backupsDir = normalizeDir(options.backupsDir)
    ?? (mode === RUNTIME_LAYOUT_MODE.PRODUCTION
      ? resolveProductionDefaultPath(explicitRuntimeRoot, runtimeRootDir, 'backups')
      : resolveBackupsDir(companionDataDir));

  assertWorkspaceDoesNotOverlapRuntimeState(mode, workspacePath, {
    systemDataDir,
    companionDataDir,
  });

  if (mode === RUNTIME_LAYOUT_MODE.PRODUCTION) {
    assertNoDuplicateRoots(mode, {
      systemDataDir,
      companionDataDir,
      workspacePath,
      logsDir,
      tempDir,
      backupsDir,
    });
    assertNoOverlappingRoots(mode, {
      systemDataDir,
      companionDataDir,
      workspacePath,
      logsDir,
      tempDir,
      backupsDir,
    });
  }

  return {
    mode,
    runtimeRootDir,
    systemDataDir,
    companionDataDir,
    workspacePath,
    logsDir,
    tempDir,
    backupsDir,
    usesLegacySharedDataDir,
  };
}

export function resolveRuntimePathSnapshot(
  options: RuntimePathLayoutOptions = {},
): RuntimePathSnapshot {
  const runtimePathLayout = resolveRuntimePathLayout(options);
  return {
    systemDataDir: runtimePathLayout.systemDataDir,
    companionDataDir: runtimePathLayout.companionDataDir,
    usesLegacySharedDataDir: runtimePathLayout.usesLegacySharedDataDir,
    runtimePathLayout,
    workspacePath: runtimePathLayout.workspacePath,
    workspaceRoot: resolve(normalize(runtimePathLayout.workspacePath)),
  };
}

export function resolveRuntimePathSnapshotFromConfig(
  config: ConfiguredPersistenceDirs,
  options: RuntimePathLayoutOptions = {},
): RuntimePathSnapshot {
  const systemDataDir = resolveConfiguredSystemDataDir(config);
  const companionDataDir = resolveConfiguredCompanionDataDir(config);
  return resolveRuntimePathSnapshot({
    ...options,
    ...(systemDataDir === companionDataDir
      ? { legacyDataDir: systemDataDir }
      : {
        systemDataDir,
        companionDataDir,
      }),
  });
}

export function resolvePersistenceRoots(
  options: PersistenceRootOptions = {},
): PersistenceRoots {
  const explicitSystem = normalizeDir(options.systemDataDir);
  const explicitCompanion = normalizeDir(options.companionDataDir);

  if ((explicitSystem && !explicitCompanion) || (!explicitSystem && explicitCompanion)) {
    throw new Error(
      'SYSTEM_DATA_DIR and COMPANION_DATA_DIR must both be set together; ' +
      'use DATA_DIR for legacy shared-root mode',
    );
  }

  if (explicitSystem && explicitCompanion) {
    if (explicitSystem === explicitCompanion) {
      throw new Error(
        'SYSTEM_DATA_DIR and COMPANION_DATA_DIR must point to different roots; ' +
        'use DATA_DIR for legacy shared-root mode',
      );
    }
    return {
      systemDataDir: explicitSystem,
      companionDataDir: explicitCompanion,
      usesLegacySharedDataDir: false,
    };
  }

  const legacyDataDir = normalizeDir(options.legacyDataDir);
  if (legacyDataDir) {
    return {
      systemDataDir: legacyDataDir,
      companionDataDir: legacyDataDir,
      usesLegacySharedDataDir: true,
    };
  }

  return {
    systemDataDir: DEFAULT_CONTINUOUS_SYSTEM_DATA_DIR,
    companionDataDir: DEFAULT_CONTINUOUS_COMPANION_DATA_DIR,
    usesLegacySharedDataDir: false,
  };
}

export function resolveConfiguredSystemDataDir(config: ConfiguredPersistenceDirs): string {
  return normalizeDir(config.systemDataDir)
    ?? normalizeDir(config.dataDir)
    ?? DEFAULT_LEGACY_SHARED_DATA_DIR;
}

export function resolveConfiguredCompanionDataDir(config: ConfiguredPersistenceDirs): string {
  return normalizeDir(config.companionDataDir)
    ?? normalizeDir(config.dataDir)
    ?? DEFAULT_CONTINUOUS_COMPANION_DATA_DIR;
}

export function resolveCompanionStateDir(companionDataDir: string): string {
  return join(companionDataDir, COMPANION_STATE_DIRNAME);
}

/** System-owned runtime/operator state directory (system-data/state). */
export function resolveSystemStateDir(systemDataDir: string): string {
  return join(systemDataDir, SYSTEM_STATE_DIRNAME);
}

/** Latest tool-surface conformance run (system-owned, cross-workstream contract). */
// ── Shared-world (operator/caretaker-owned, cross-companion) storage ──
// Shared-world wiki documents are NOT companion-data: they are world knowledge
// attached to a site and are owned by operator/caretaker maintenance surfaces
// (publication + bulk import), never authored by a companion directly. They live
// under system-data so a single canonical copy is shared across companions
// (multi-companion §4 W5: the "shared" data domain). One subtree per site keeps
// publication and import idempotent and per-site isolated.
const SHARED_WORLD_DIRNAME = 'shared-world';
const SHARED_WORLD_WIKI_DIRNAME = 'wiki';
const SHARED_WORLD_WIKI_SITES_DIRNAME = 'sites';

/** Shared-world (operator/caretaker-owned) root under system-data. */
export function resolveSharedWorldDir(systemDataDir: string): string {
  return join(systemDataDir, SHARED_WORLD_DIRNAME);
}

/** Root for shared-world wiki markdown (one subtree per site). NOT companion-data. */
export function resolveSharedWorldWikiDir(systemDataDir: string): string {
  return join(resolveSharedWorldDir(systemDataDir), SHARED_WORLD_WIKI_DIRNAME);
}

/**
 * Per-site shared-world wiki store root:
 *   <system-data>/shared-world/wiki/sites/<siteId>
 * The siteId is contained fail-closed to the sites root so a malformed id can
 * never escape the shared-world subtree.
 */
export function resolveSharedWorldWikiSiteDir(systemDataDir: string, siteId: string): string {
  const sitesRoot = join(resolveSharedWorldWikiDir(systemDataDir), SHARED_WORLD_WIKI_SITES_DIRNAME);
  const resolved = resolve(sitesRoot, siteId);
  const relativePath = relative(sitesRoot, resolved);
  if (relativePath === '' || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error(`shared-world wiki siteId "${siteId}" resolves outside the sites root`);
  }
  return resolved;
}

export function resolveToolConformanceLatestPath(systemDataDir: string): string {
  return join(resolveSystemStateDir(systemDataDir), 'tool-conformance-latest.json');
}

/** Bounded JSONL history of the last tool-surface conformance runs. */
export function resolveToolConformanceHistoryPath(systemDataDir: string): string {
  return join(resolveSystemStateDir(systemDataDir), 'tool-conformance-history.jsonl');
}

export function resolveCompanionDocsDir(companionDataDir: string): string {
  return join(companionDataDir, COMPANION_DOCS_DIRNAME);
}

export function resolveCompanionWorkspaceDir(companionDataDir: string): string {
  return join(companionDataDir, COMPANION_WORKSPACE_DIRNAME);
}

export function resolveCompanionImagesDir(companionDataDir: string): string {
  return join(companionDataDir, COMPANION_IMAGES_DIRNAME);
}

export function resolveCompanionVaultDir(companionDataDir: string): string {
  return join(companionDataDir, COMPANION_VAULT_DIRNAME);
}

export function resolveCompanionSkillsDir(companionDataDir: string): string {
  return join(companionDataDir, COMPANION_SKILLS_DIRNAME);
}

function isInternalReflectionChannel(channelId: string | undefined): boolean {
  return typeof channelId === 'string' && channelId.startsWith('internal:reflection:');
}

function buildUniquePath(dir: string, preferredFilename: string): string {
  const preferred = join(dir, preferredFilename);
  if (!existsSync(preferred)) return preferred;

  const dotIndex = preferredFilename.lastIndexOf('.');
  const stem = dotIndex > 0 ? preferredFilename.slice(0, dotIndex) : preferredFilename;
  const ext = dotIndex > 0 ? preferredFilename.slice(dotIndex) : '';
  return join(dir, `${stem}-${Date.now()}${ext}`);
}

function migrateReflectionSessionFiles(dataDir: string): void {
  const sessionsDir = resolveSessionsDir(dataDir);
  const reflectionsDir = resolveReflectionNotesDir(dataDir);
  mkdirSync(reflectionsDir, { recursive: true });

  const movedChannels = new Set<string>();
  const files = readdirSync(sessionsDir).filter(file => file.endsWith('.jsonl') && !file.startsWith('user_'));

  for (const filename of files) {
    const sourcePath = join(sessionsDir, filename);
    let channelId: string | undefined;
    try {
      const firstEntry = readJournalFirstEntry(sourcePath);
      channelId = firstEntry?.channelId;
    } catch {
      continue;
    }

    if (!isInternalReflectionChannel(channelId)) continue;

    const targetPath = buildUniquePath(reflectionsDir, filename);
    try {
      renameSync(sourcePath, targetPath);
      if (channelId) movedChannels.add(channelId);
    } catch (error) {
      log.warn('Failed to migrate reflection session file', {
        sourcePath,
        targetPath,
        error: String(error),
      });
    }
  }

  if (movedChannels.size === 0) return;

  const channelIndexPath = join(sessionsDir, '_channel_index.json');
  if (!existsSync(channelIndexPath)) return;

  try {
    const payload = JSON.parse(readFileSafely(channelIndexPath)) as ChannelIndexPayload;
    if (!payload.channels || typeof payload.channels !== 'object') {
      return;
    }

    let changed = false;
    for (const channelId of movedChannels) {
      if (channelId in payload.channels) {
        delete payload.channels[channelId];
        changed = true;
      }
    }

    if (changed) {
      writeJsonAtomic(channelIndexPath, payload);
    }
  } catch (error) {
    log.warn('Failed to prune migrated reflection channels from session index', {
      channelIndexPath,
      error: String(error),
    });
  }
}

function readFileSafely(path: string): string {
  const size = statSync(path).size;
  if (size <= 0) return '';
  return readFileSync(path, 'utf-8');
}

function migrateLegacyContinuityFiles(dataDir: string): void {
  const sessionsDir = resolveSessionsDir(dataDir);
  const continuityDir = resolveContinuityDir(dataDir);
  mkdirSync(continuityDir, { recursive: true });

  const files = readdirSync(sessionsDir).filter(file => file.startsWith('user_') && file.endsWith('.jsonl'));
  for (const filename of files) {
    const sourcePath = join(sessionsDir, filename);
    const targetPath = join(continuityDir, filename);
    if (existsSync(targetPath)) continue;
    try {
      renameSync(sourcePath, targetPath);
    } catch (error) {
      log.warn('Failed to migrate continuity file', {
        sourcePath,
        targetPath,
        error: String(error),
      });
    }
  }
}

export function resolveSessionsDir(dataDir: string): string {
  return join(resolveCompanionStateDir(dataDir), 'sessions');
}

export function resolveNotesDir(dataDir: string): string {
  return join(resolveCompanionStateDir(dataDir), 'notes');
}

export function resolveContactsDir(dataDir: string): string {
  return join(resolveCompanionStateDir(dataDir), 'contacts');
}

export function resolveContinuityDir(dataDir: string): string {
  return join(resolveContactsDir(dataDir), 'continuity');
}

export function resolvePendingContactApprovalsPath(dataDir: string): string {
  return join(resolveContactsDir(dataDir), 'pending-approvals.json');
}

export function resolveValuesJournalPath(dataDir: string): string {
  return join(resolveNotesDir(dataDir), 'values.jsonl');
}

export function resolveSessionContinuityArtifactsDir(dataDir: string): string {
  return join(resolveNotesDir(dataDir), 'session-continuity');
}

export function resolveSessionContinuityArtifactsPath(dataDir: string, sessionId: string): string {
  return join(resolveSessionContinuityArtifactsDir(dataDir), `${sanitizeChannelId(sessionId)}.jsonl`);
}

export function resolveLegacyValuesJournalPath(dataDir: string): string {
  return join(dataDir, 'values.jsonl');
}

export function resolveReflectionNotesDir(dataDir: string): string {
  return join(resolveNotesDir(dataDir), 'reflections');
}

export function resolveReflectionJournalPath(dataDir: string): string {
  return join(resolveReflectionNotesDir(dataDir), 'journal.jsonl');
}

export function resolveReflectionMetacognitionDir(dataDir: string): string {
  return join(resolveReflectionNotesDir(dataDir), 'metacognition');
}

export function resolveReflectionMetacognitionJournalPath(dataDir: string): string {
  return join(resolveReflectionMetacognitionDir(dataDir), 'journal.jsonl');
}

export function resolveReflectionDailyJournalsDir(dataDir: string): string {
  return join(resolveReflectionNotesDir(dataDir), 'daily');
}

export function resolveReflectionDailyJournalPath(dataDir: string, date: string): string {
  return join(resolveReflectionDailyJournalsDir(dataDir), `${date}.jsonl`);
}

export function resolveReflectionProcessLogsDir(dataDir: string): string {
  return join(resolveReflectionNotesDir(dataDir), 'process-logs');
}

export function resolveReflectionProcessLogPath(dataDir: string, processId: string): string {
  return join(resolveReflectionProcessLogsDir(dataDir), `${sanitizeChannelId(processId)}.jsonl`);
}

export function resolveFocusKnowledgePath(dataDir: string): string {
  return join(resolveNotesDir(dataDir), 'focus-knowledge.jsonl');
}

export function resolveCompressionGuidelinePath(dataDir: string): string {
  return join(resolveNotesDir(dataDir), 'compaction-guideline.json');
}

export function resolveCompressionFailureLogPath(dataDir: string): string {
  return join(resolveNotesDir(dataDir), 'compaction-failures.jsonl');
}

export function resolveScratchpadMirrorPath(dataDir: string): string {
  return join(resolveNotesDir(dataDir), 'scratchpad.json');
}

export function resolveMemoryJournalPath(dataDir: string): string {
  return join(resolveNotesDir(dataDir), 'memories.jsonl');
}

export function resolveCoreMemoryPath(companionDataDir: string): string {
  return join(resolveCompanionStateDir(companionDataDir), 'core_memory.json');
}

export function resolveInternalRoleEnvelopesDir(companionDataDir: string): string {
  return join(resolveCompanionStateDir(companionDataDir), 'internal-role-envelopes');
}

export function resolveInternalRoleEnvelopeLedgerPath(
  companionDataDir: string,
  channelId: string,
): string {
  return join(resolveInternalRoleEnvelopesDir(companionDataDir), `${sanitizeChannelId(channelId)}.jsonl`);
}

export function resolveCharacterCardHistoryPath(companionDataDir: string): string {
  return join(resolveCompanionStateDir(companionDataDir), 'character-card-history.jsonl');
}

export function resolvePromptLayersPath(companionDataDir: string): string {
  return join(resolveCompanionStateDir(companionDataDir), 'prompt-layers.json');
}

export function resolvePromptHistoryPath(companionDataDir: string): string {
  return join(resolveCompanionStateDir(companionDataDir), 'prompt-history.jsonl');
}

export function resolvePromptLastKnownGoodPath(companionDataDir: string): string {
  return join(resolveCompanionStateDir(companionDataDir), 'last-known-good.json');
}

export function resolvePromptRegistryPath(companionDataDir: string): string {
  return join(resolveCompanionStateDir(companionDataDir), 'prompt-registry.json');
}

export function resolvePromptRegistryHistoryPath(companionDataDir: string): string {
  return join(resolveCompanionStateDir(companionDataDir), 'prompt-registry-history.jsonl');
}

export function resolveNorthStarPath(companionDataDir: string): string {
  return join(resolveCompanionStateDir(companionDataDir), 'north-star.json');
}

export function resolveHeartbeatPolicyPath(companionDataDir: string): string {
  return join(resolveCompanionStateDir(companionDataDir), 'heartbeat-policy.json');
}

export function resolvePostTurnActionQueuePath(companionDataDir: string): string {
  return join(resolveCompanionStateDir(companionDataDir), 'post-turn-actions.queue.json');
}

export function resolveOutreachOutboxLedgerPath(companionDataDir: string): string {
  return join(resolveCompanionStateDir(companionDataDir), 'outreach-outbox.jsonl');
}

export function resolveSafeguardAuditTrailPath(companionDataDir: string): string {
  return join(resolveCompanionStateDir(companionDataDir), 'safeguards-audit.jsonl');
}

export function resolveChargeLedgerPath(companionDataDir: string): string {
  return join(resolveCompanionStateDir(companionDataDir), 'charge-ledger.jsonl');
}

// ── Social-graph builder (E4.2) ──
export function resolveSocialGraphProposalsPath(companionDataDir: string): string {
  return join(resolveCompanionStateDir(companionDataDir), 'social-graph-proposals.json');
}

export function resolveSocialGraphBuilderWatermarkPath(companionDataDir: string): string {
  return join(resolveCompanionStateDir(companionDataDir), 'social-graph-builder-watermark.json');
}

export function resolveFatigueLedgerPath(companionDataDir: string): string {
  return join(resolveCompanionStateDir(companionDataDir), 'fatigue-ledger.jsonl');
}

export function resolveShardSessionMemorySyncAuditPath(companionDataDir: string): string {
  return join(resolveCompanionStateDir(companionDataDir), 'shard-session-memory-sync-audit.jsonl');
}

export function resolveShardFoldReviewStorePath(companionDataDir: string): string {
  return join(resolveCompanionStateDir(companionDataDir), 'shard-fold-reviews.json');
}

export function resolveSessionRoutesPath(companionDataDir: string): string {
  return join(resolveCompanionStateDir(companionDataDir), 'session-routes.json');
}

export function resolveCogSecEventsPath(companionDataDir: string): string {
  return join(resolveCompanionStateDir(companionDataDir), 'cogsec-events.json');
}

export function resolveCogSecForensicArchiveDir(companionDataDir: string): string {
  return join(resolveCompanionVaultDir(companionDataDir), 'cogsec-forensics');
}

export function resolveIdentityAssetsDir(companionDataDir: string): string {
  return join(resolveCompanionStateDir(companionDataDir), 'identity-assets');
}

export function resolveGeneratedImagesDir(companionDataDir: string): string {
  return resolveCompanionImagesDir(companionDataDir);
}

export function resolvePersonalDocsDir(personalFilesDir: string): string {
  return join(personalFilesDir, PERSONAL_DOCS_DIRNAME);
}

export function resolvePersonalDownloadsDir(personalFilesDir: string): string {
  return join(personalFilesDir, PERSONAL_DOWNLOADS_DIRNAME);
}

export function resolvePersonalImagesDir(personalFilesDir: string): string {
  return join(personalFilesDir, PERSONAL_IMAGES_DIRNAME);
}

export function resolvePersonalJournalDir(personalFilesDir: string): string {
  return join(personalFilesDir, PERSONAL_JOURNAL_DIRNAME);
}

export function resolvePersonalKnowledgeDir(personalFilesDir: string): string {
  return join(personalFilesDir, PERSONAL_KNOWLEDGE_DIRNAME);
}

export function resolvePersonalWikiDir(personalFilesDir: string): string {
  return join(resolvePersonalKnowledgeDir(personalFilesDir), PERSONAL_WIKI_DIRNAME);
}

export function resolvePersonalScratchpadDir(personalFilesDir: string): string {
  return join(personalFilesDir, PERSONAL_SCRATCHPAD_DIRNAME);
}

export function resolvePersonalSkillsDir(personalFilesDir: string): string {
  return join(personalFilesDir, PERSONAL_SKILLS_DIRNAME);
}

export function resolvePersonalModulesDir(personalFilesDir: string): string {
  return join(personalFilesDir, PERSONAL_MODULES_DIRNAME);
}

export function resolvePersonalExperimentsDir(personalFilesDir: string): string {
  return join(personalFilesDir, PERSONAL_EXPERIMENTS_DIRNAME);
}

export function resolvePersonalTempDir(personalFilesDir: string): string {
  return join(personalFilesDir, PERSONAL_TMP_DIRNAME);
}

export function ensurePersonalFilesLayout(personalFilesDir: string): void {
  mkdirSync(personalFilesDir, { recursive: true });
  mkdirSync(resolvePersonalDocsDir(personalFilesDir), { recursive: true });
  mkdirSync(resolvePersonalDownloadsDir(personalFilesDir), { recursive: true });
  mkdirSync(resolvePersonalImagesDir(personalFilesDir), { recursive: true });
  mkdirSync(resolvePersonalJournalDir(personalFilesDir), { recursive: true });
  mkdirSync(resolvePersonalKnowledgeDir(personalFilesDir), { recursive: true });
  mkdirSync(resolvePersonalWikiDir(personalFilesDir), { recursive: true });
  mkdirSync(resolvePersonalScratchpadDir(personalFilesDir), { recursive: true });
  mkdirSync(resolvePersonalSkillsDir(personalFilesDir), { recursive: true });
  mkdirSync(resolvePersonalModulesDir(personalFilesDir), { recursive: true });
  mkdirSync(resolvePersonalExperimentsDir(personalFilesDir), { recursive: true });
  mkdirSync(resolvePersonalTempDir(personalFilesDir), { recursive: true });
}

export function resolveWorkspaceLifecycleDir(workspacePath: string): string {
  return join(workspacePath, '.psfn');
}

export function resolveManagedWorkspaceTempDir(workspacePath: string): string {
  return join(resolveWorkspaceLifecycleDir(workspacePath), 'temp-artifacts');
}

export function resolveArtifactLifecycleDir(companionDataDir: string): string {
  return join(companionDataDir, 'artifact-lifecycle');
}

export function resolveArtifactLifecycleAuditPath(companionDataDir: string): string {
  return join(resolveArtifactLifecycleDir(companionDataDir), 'cleanup-runs.jsonl');
}

export function resolveResearchLibraryDir(companionDataDir: string): string {
  return join(companionDataDir, 'research-library');
}

export function resolveResearchLibraryEntriesDir(companionDataDir: string): string {
  return join(resolveResearchLibraryDir(companionDataDir), 'entries');
}

export function resolveResearchLibraryEntryDir(companionDataDir: string, entryId: string): string {
  return join(resolveResearchLibraryEntriesDir(companionDataDir), sanitizeChannelId(entryId));
}

export function resolveBackupsDir(companionDataDir: string): string {
  return join(companionDataDir, 'backups');
}

export function resolveLastActiveSessionPath(companionDataDir: string): string {
  return join(resolveCompanionStateDir(companionDataDir), 'last_active_channel.json');
}

function moveLegacyCompanionArtifact(legacyPath: string, targetPath: string): void {
  if (!existsSync(legacyPath) || existsSync(targetPath)) {
    return;
  }

  mkdirSync(dirname(targetPath), { recursive: true });
  try {
    renameSync(legacyPath, targetPath);
  } catch (error) {
    log.warn('Failed to migrate legacy companion artifact into state dir', {
      legacyPath,
      targetPath,
      error: String(error),
    });
  }
}

function migrateLegacyCompanionStateLayout(companionDataDir: string): void {
  const stateDir = resolveCompanionStateDir(companionDataDir);
  const legacyMappings = [
    ['sessions', resolveSessionsDir(companionDataDir)],
    ['notes', resolveNotesDir(companionDataDir)],
    ['contacts', resolveContactsDir(companionDataDir)],
    ['internal-role-envelopes', resolveInternalRoleEnvelopesDir(companionDataDir)],
    ['identity-assets', resolveIdentityAssetsDir(companionDataDir)],
    ['core_memory.json', resolveCoreMemoryPath(companionDataDir)],
    ['character-card-history.jsonl', resolveCharacterCardHistoryPath(companionDataDir)],
    ['prompt-layers.json', resolvePromptLayersPath(companionDataDir)],
    ['prompt-history.jsonl', resolvePromptHistoryPath(companionDataDir)],
    ['last-known-good.json', resolvePromptLastKnownGoodPath(companionDataDir)],
    ['prompt-registry.json', resolvePromptRegistryPath(companionDataDir)],
    ['prompt-registry-history.jsonl', resolvePromptRegistryHistoryPath(companionDataDir)],
    ['north-star.json', resolveNorthStarPath(companionDataDir)],
    ['heartbeat-policy.json', resolveHeartbeatPolicyPath(companionDataDir)],
    ['post-turn-actions.queue.json', resolvePostTurnActionQueuePath(companionDataDir)],
    ['outreach-outbox.jsonl', resolveOutreachOutboxLedgerPath(companionDataDir)],
    ['safeguards-audit.jsonl', resolveSafeguardAuditTrailPath(companionDataDir)],
    ['charge-ledger.jsonl', resolveChargeLedgerPath(companionDataDir)],
    ['fatigue-ledger.jsonl', resolveFatigueLedgerPath(companionDataDir)],
    ['shard-session-memory-sync-audit.jsonl', resolveShardSessionMemorySyncAuditPath(companionDataDir)],
    ['shard-fold-reviews.json', resolveShardFoldReviewStorePath(companionDataDir)],
    ['session-routes.json', resolveSessionRoutesPath(companionDataDir)],
    ['last_active_channel.json', resolveLastActiveSessionPath(companionDataDir)],
  ] as const;

  mkdirSync(stateDir, { recursive: true });
  for (const [legacyRelativePath, targetPath] of legacyMappings) {
    moveLegacyCompanionArtifact(join(companionDataDir, legacyRelativePath), targetPath);
  }
}

export function ensurePersistenceLayout(dataDir: string): void {
  mkdirSync(resolveCompanionStateDir(dataDir), { recursive: true });
  mkdirSync(resolveCompanionDocsDir(dataDir), { recursive: true });
  mkdirSync(resolveCompanionWorkspaceDir(dataDir), { recursive: true });
  mkdirSync(resolveCompanionImagesDir(dataDir), { recursive: true });
  mkdirSync(resolveCompanionVaultDir(dataDir), { recursive: true });
  mkdirSync(resolveCompanionSkillsDir(dataDir), { recursive: true });
  mkdirSync(resolveBackupsDir(dataDir), { recursive: true });
  mkdirSync(resolveSessionsDir(dataDir), { recursive: true });
  mkdirSync(resolveNotesDir(dataDir), { recursive: true });
  mkdirSync(resolveReflectionNotesDir(dataDir), { recursive: true });
  mkdirSync(resolveReflectionMetacognitionDir(dataDir), { recursive: true });
  mkdirSync(resolveReflectionDailyJournalsDir(dataDir), { recursive: true });
  mkdirSync(resolveReflectionProcessLogsDir(dataDir), { recursive: true });
  mkdirSync(resolveContactsDir(dataDir), { recursive: true });
  mkdirSync(resolveContinuityDir(dataDir), { recursive: true });
  mkdirSync(resolveInternalRoleEnvelopesDir(dataDir), { recursive: true });
  mkdirSync(resolveArtifactLifecycleDir(dataDir), { recursive: true });
  mkdirSync(resolveResearchLibraryEntriesDir(dataDir), { recursive: true });
}

export function migrateLegacyPersistenceLayout(dataDir: string): void {
  migrateLegacyCompanionStateLayout(dataDir);
  ensurePersistenceLayout(dataDir);
  migrateReflectionSessionFiles(dataDir);
  migrateLegacyContinuityFiles(dataDir);
}
