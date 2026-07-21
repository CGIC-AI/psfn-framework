import { randomUUID } from 'node:crypto';
import {
  existsSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { isTestingSessionId } from '../../core/session/session-id.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import {
  CHANNEL_INDEX_FILENAME,
  type ChannelIndexEntry,
} from './store-primitives.js';
import {
  deleteChannelIndexEntryIfUnchanged,
  loadChannelIndex,
  upsertChannelIndex,
} from './store/channel-index.js';
import { indexedChannelId } from './store/session-index-keys.js';
import { withSessionJournalWriteLock } from './store/session-journal-write-lock.js';
import type {
  SessionDatabasePurgePort,
  SessionDatabasePurgeReport,
} from './testing-session-postgres-purge.js';

const WILDCARD_LIKE_PATTERN = /[*?[\]{}]/u;

export interface SessionTailPurgePort {
  purgeChannelKeyFamily(channelKey: string): Promise<number>;
}

export class TestingSessionTailPurgeError extends Error {
  override readonly name = 'TestingSessionTailPurgeError';

  constructor(sessionId: string, cause: unknown) {
    super(
      `Configured Redis tail cache purge failed for ${sessionId}: ${toErrorMessage(cause)}`,
      { cause },
    );
  }
}

export interface PurgeTestingSessionOptions {
  sessionsDir: string;
  sessionId: string;
  database: SessionDatabasePurgePort;
  tailCache?: SessionTailPurgePort;
  forceNonTesting?: boolean;
  /**
   * Confirmation proof for non-testing data. The caller must collect the
   * exact session id independently (the CLI requires the operator to type it).
   */
  confirmedNonTestingSessionId?: string;
}

export interface PurgeTestingSessionReport {
  sessionId: string;
  channelId: string;
  removedJournalFiles: string[];
  database: SessionDatabasePurgeReport;
  tailCache:
    | {
        status: 'not_configured';
        message: 'no tail cache configured';
        removedKeys: 0;
      }
    | {
        status: 'purged';
        message: string;
        removedKeys: number;
      };
}

interface StagedJournal {
  originalPath: string;
  stagedPath: string;
}

function assertExplicitSessionId(sessionId: string): void {
  if (!sessionId || sessionId !== sessionId.trim()) {
    throw new Error('Session purge requires one exact, non-empty session id without surrounding whitespace');
  }
  if (/[\u0000-\u001f\u007f]/u.test(sessionId)) {
    throw new Error('Session purge refuses control characters in the session id');
  }
  if (WILDCARD_LIKE_PATTERN.test(sessionId)) {
    throw new Error('Session purge refuses wildcard-like session ids');
  }
}

function assertNonTestingConfirmation(options: PurgeTestingSessionOptions): void {
  if (isTestingSessionId(options.sessionId)) return;
  if (!options.forceNonTesting) {
    throw new Error(
      `Refusing to purge non-testing session ${options.sessionId}; pass --force-non-testing and confirm the exact id`,
    );
  }
  if (options.confirmedNonTestingSessionId !== options.sessionId) {
    throw new Error(`Non-testing session purge confirmation did not exactly match ${options.sessionId}`);
  }
}

function restoreStagedJournals(staged: readonly StagedJournal[]): void {
  for (const journal of [...staged].reverse()) {
    if (existsSync(journal.stagedPath)) {
      renameSync(journal.stagedPath, journal.originalPath);
    }
  }
}

function rollbackBeforeProjectionCommit(input: {
  staged: readonly StagedJournal[];
  sessionId: string;
  entry: ChannelIndexEntry;
  channelIndexPath: string;
  channelIndex: Map<string, ChannelIndexEntry>;
  cause: unknown;
}): never {
  const rollbackErrors: unknown[] = [];
  try {
    restoreStagedJournals(input.staged);
  } catch (error) {
    rollbackErrors.push(error);
  }
  try {
    upsertChannelIndex(
      input.sessionId,
      input.entry,
      input.channelIndexPath,
      input.channelIndex,
    );
  } catch (error) {
    rollbackErrors.push(error);
  }
  if (rollbackErrors.length > 0) {
    throw new AggregateError(
      [input.cause, ...rollbackErrors],
      `Session purge failed and rollback was incomplete for ${input.sessionId}`,
    );
  }
  throw input.cause;
}

/**
 * Purge exactly one indexed session.
 *
 * Files are first atomically renamed out of the journal namespace and the
 * index entry is removed with a compare-and-delete. If the transactional
 * projection deletion fails, both filesystem changes are restored. The
 * projection commit is the last irreversible step; staged files are unlinked
 * only after it succeeds.
 *
 * Run this maintenance operation while the owning runtime workloads are
 * stopped so no process retains a pre-purge in-memory session cache.
 */
export async function purgeTestingSession(
  options: PurgeTestingSessionOptions,
): Promise<PurgeTestingSessionReport> {
  assertExplicitSessionId(options.sessionId);
  assertNonTestingConfirmation(options);

  const sessionsDir = resolve(options.sessionsDir);
  const channelIndexPath = join(sessionsDir, CHANNEL_INDEX_FILENAME);
  const channelIndex = new Map<string, ChannelIndexEntry>();
  loadChannelIndex(channelIndexPath, channelIndex, { persistMigration: false });
  const entry = channelIndex.get(options.sessionId);
  if (!entry) {
    throw new Error(`Session purge target is not an exact channel-index key: ${options.sessionId}`);
  }

  const channelId = indexedChannelId(options.sessionId, entry);
  const collidingSessions = [...channelIndex.entries()]
    .filter(([candidateSessionId, candidate]) => (
      candidateSessionId !== options.sessionId
      && indexedChannelId(candidateSessionId, candidate) === channelId
    ))
    .map(([candidateSessionId]) => candidateSessionId);
  if (collidingSessions.length > 0) {
    throw new Error(
      `Session purge cannot isolate projection rows for ${options.sessionId}; `
      + `logical channel ${channelId} is also owned by ${collidingSessions.join(', ')}`,
    );
  }

  const journalPaths = entry.filenames.map(filename => join(sessionsDir, filename));
  const missing = journalPaths.filter(filePath => !existsSync(filePath));
  if (missing.length > 0) {
    throw new Error(`Session purge refuses an incomplete journal chain: ${missing.join(', ')}`);
  }

  const staged: StagedJournal[] = [];
  const stageToken = randomUUID();
  withSessionJournalWriteLock(journalPaths[0]!, () => {
    try {
      for (const originalPath of journalPaths) {
        const stagedPath = `${originalPath}.purge-${stageToken}`;
        renameSync(originalPath, stagedPath);
        staged.push({ originalPath, stagedPath });
      }
      const deleted = deleteChannelIndexEntryIfUnchanged(
        options.sessionId,
        entry,
        channelIndexPath,
        channelIndex,
      );
      if (!deleted) {
        restoreStagedJournals(staged);
        throw new Error(`Session channel-index entry changed during purge: ${options.sessionId}`);
      }
    } catch (error) {
      restoreStagedJournals(staged);
      throw error;
    }
  });

  let removedTailCacheKeys = 0;
  if (options.tailCache) {
    try {
      removedTailCacheKeys = await options.tailCache.purgeChannelKeyFamily(options.sessionId);
    } catch (error) {
      rollbackBeforeProjectionCommit({
        staged,
        sessionId: options.sessionId,
        entry,
        channelIndexPath,
        channelIndex,
        cause: new TestingSessionTailPurgeError(options.sessionId, error),
      });
    }
  }

  let database: SessionDatabasePurgeReport;
  try {
    database = await options.database.purgeSession({
      sessionId: options.sessionId,
      channelId,
    });
  } catch (error) {
    rollbackBeforeProjectionCommit({
      staged,
      sessionId: options.sessionId,
      entry,
      channelIndexPath,
      channelIndex,
      cause: error,
    });
  }

  for (const journal of staged) {
    rmSync(journal.stagedPath);
  }

  return {
    sessionId: options.sessionId,
    channelId,
    removedJournalFiles: entry.filenames,
    database,
    tailCache: options.tailCache
      ? {
          status: 'purged',
          message: `purged ${removedTailCacheKeys} tail cache keys`,
          removedKeys: removedTailCacheKeys,
        }
      : {
          status: 'not_configured',
          message: 'no tail cache configured',
          removedKeys: 0,
        },
  };
}
