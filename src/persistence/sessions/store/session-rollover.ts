import { existsSync } from 'node:fs';
import type { SessionEntry } from '../../../core/session/types.js';
import { createComponentLogger } from '../../../shared/logger.js';
import {
  L0_SESSION_FILE_MAX_BYTES,
  type ChannelCache,
} from '../store-primitives.js';
import { makeRolledFilePath } from './channel-filenames.js';
import { setSessionCacheArchivePaths } from './session-chain-cache.js';

const log = createComponentLogger('SessionStore');

export function rollSessionArchiveIfNeeded(params: {
  cache: ChannelCache;
  nextRole: SessionEntry['role'];
  archiveByteLength: (filePath: string) => number;
  materializeEmptyArchive: (filePath: string) => void;
  persistIndex: (cache: ChannelCache) => void;
}): ChannelCache {
  const { cache } = params;
  if (
    params.archiveByteLength(cache.resolvedPath) < L0_SESSION_FILE_MAX_BYTES
    || cache.lastMessageRole !== 'assistant'
    || params.nextRole === 'assistant'
    || params.nextRole === 'tool'
  ) {
    return cache;
  }

  const nextPath = makeRolledFilePath(cache.archivePaths[0]!, cache.archivePaths.length + 1);
  if (existsSync(nextPath) && params.archiveByteLength(nextPath) > 0) {
    throw new Error(
      `Refusing to roll L0 session ${cache.channelId}: target segment already exists (${nextPath})`,
    );
  }
  if (!existsSync(nextPath)) {
    // Materialize before index publication. A pre-index orphan is reusable;
    // an index that points at a missing active file would be an incomplete chain.
    params.materializeEmptyArchive(nextPath);
  }

  const previousPaths = cache.archivePaths;
  const previousFingerprint = cache.archiveFingerprint;
  setSessionCacheArchivePaths(cache, [...cache.archivePaths, nextPath]);
  cache.archiveFingerprint = null;
  cache.recentEntriesByLimit.clear();
  try {
    params.persistIndex(cache);
  } catch (error) {
    setSessionCacheArchivePaths(cache, previousPaths);
    cache.archiveFingerprint = previousFingerprint;
    throw error;
  }
  log.info('Rolled L0 session journal at the fixed byte cap', {
    channelId: cache.channelId,
    maxBytes: L0_SESSION_FILE_MAX_BYTES,
    segmentCount: cache.archivePaths.length,
    activeFilename: cache.resolvedPath,
  });
  return cache;
}
