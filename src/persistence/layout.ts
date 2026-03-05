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
