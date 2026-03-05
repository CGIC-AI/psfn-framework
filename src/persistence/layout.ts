import { existsSync, mkdirSync, readdirSync, renameSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createComponentLogger } from '../logger.js';
import { readJournalFirstEntry } from '../session/journal-utils.js';
import { writeJsonAtomic } from '../utils/fs.js';

const log = createComponentLogger('PersistenceLayout');

interface ChannelIndexPayload {
  version?: number;
  channels?: Record<string, unknown>;
}

export const DEFAULT_LEGACY_SHARED_DATA_DIR = './data';

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

function normalizeDir(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
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

  const legacyDataDir = normalizeDir(options.legacyDataDir) ?? DEFAULT_LEGACY_SHARED_DATA_DIR;
  return {
    systemDataDir: legacyDataDir,
    companionDataDir: legacyDataDir,
    usesLegacySharedDataDir: true,
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
    ?? DEFAULT_LEGACY_SHARED_DATA_DIR;
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
  return join(dataDir, 'sessions');
}

export function resolveNotesDir(dataDir: string): string {
  return join(dataDir, 'notes');
}

export function resolveContactsDir(dataDir: string): string {
  return join(dataDir, 'contacts');
}

export function resolveContinuityDir(dataDir: string): string {
  return join(resolveContactsDir(dataDir), 'continuity');
}

export function resolveValuesJournalPath(dataDir: string): string {
  return join(resolveNotesDir(dataDir), 'values.jsonl');
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

export function resolveScratchpadMirrorPath(dataDir: string): string {
  return join(resolveNotesDir(dataDir), 'scratchpad.json');
}

export function resolveCharacterCardHistoryPath(companionDataDir: string): string {
  return join(companionDataDir, 'character-card-history.jsonl');
}

export function resolvePromptLayersPath(companionDataDir: string): string {
  return join(companionDataDir, 'prompt-layers.json');
}

export function resolvePromptHistoryPath(companionDataDir: string): string {
  return join(companionDataDir, 'prompt-history.jsonl');
}

export function resolvePromptRegistryPath(companionDataDir: string): string {
  return join(companionDataDir, 'prompt-registry.json');
}

export function resolvePromptRegistryHistoryPath(companionDataDir: string): string {
  return join(companionDataDir, 'prompt-registry-history.jsonl');
}

export function resolveHeartbeatPolicyPath(companionDataDir: string): string {
  return join(companionDataDir, 'heartbeat-policy.json');
}

export function resolveSafeguardAuditTrailPath(companionDataDir: string): string {
  return join(companionDataDir, 'safeguards-audit.jsonl');
}

export function resolveIdentityAssetsDir(companionDataDir: string): string {
  return join(companionDataDir, 'identity-assets');
}

export function resolveBackupsDir(companionDataDir: string): string {
  return join(companionDataDir, 'backups');
}

export function resolveLastActiveSessionPath(companionDataDir: string): string {
  return join(companionDataDir, 'last_active_channel.json');
}

export function ensurePersistenceLayout(dataDir: string): void {
  mkdirSync(resolveSessionsDir(dataDir), { recursive: true });
  mkdirSync(resolveNotesDir(dataDir), { recursive: true });
  mkdirSync(resolveReflectionNotesDir(dataDir), { recursive: true });
  mkdirSync(resolveContactsDir(dataDir), { recursive: true });
  mkdirSync(resolveContinuityDir(dataDir), { recursive: true });
}

export function migrateLegacyPersistenceLayout(dataDir: string): void {
  ensurePersistenceLayout(dataDir);
  migrateReflectionSessionFiles(dataDir);
  migrateLegacyContinuityFiles(dataDir);
}
