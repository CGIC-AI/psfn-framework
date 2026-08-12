import {
  existsSync,
  rmSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { Pool } from 'pg';
import type {
  ExactSessionPurgeInput,
} from '../../faculties/automata/retention-contract.js';
import type {
  ExactSessionPurgeResolvedTarget,
  ExactSessionSurfaceDeleteResult,
  ExactSessionSurfacePurgePort,
} from '../../faculties/automata/production-exact-session-purge.js';
import { listNumberedJsonlSegments } from '../jsonl-segments.js';
import { withPostgresClient } from '../postgres.js';
import {
  CHANNEL_INDEX_FILENAME,
  type ChannelIndexEntry,
} from './store-primitives.js';
import {
  deleteChannelIndexEntryIfUnchanged,
  loadChannelIndex,
} from './store/channel-index.js';
import { isSessionJournalFilename } from './store/channel-filenames.js';
import { indexedChannelId } from './store/session-index-keys.js';
import { withSessionJournalWriteLock } from './store/session-journal-write-lock.js';
import { sanitizeChannelId } from './store-file-contracts.js';
import { withTurnRecordRotationLock } from './turn-records.js';

function result(removedCount: number): ExactSessionSurfaceDeleteResult {
  return removedCount > 0
    ? { status: 'removed', removedCount }
    : { status: 'already_absent', removedCount: 0 };
}

function exactJournalPath(sessionsDir: string, filename: string): string {
  if (filename !== basename(filename) || !isSessionJournalFilename(filename)) {
    throw new Error(`Exact-session purge received an unsafe journal filename "${filename}"`);
  }
  return join(sessionsDir, filename);
}

function removeExisting(paths: readonly string[]): number {
  let removed = 0;
  for (const path of paths) {
    if (!existsSync(path)) continue;
    rmSync(path);
    removed += 1;
  }
  return removed;
}

function allAbsent(paths: readonly string[]): boolean {
  return paths.every(path => !existsSync(path));
}

function assertIndexTarget(
  input: ExactSessionPurgeInput,
  target: ExactSessionPurgeResolvedTarget,
  entry: ChannelIndexEntry,
): void {
  const expectedFilenames = [
    ...target.rolledJournalFilenames,
    target.activeJournalFilename,
  ];
  if (
    indexedChannelId(input.sessionId, entry) !== target.channelId
    || entry.filename !== target.activeJournalFilename
    || entry.filenames.length !== expectedFilenames.length
    || !entry.filenames.every((filename, index) => filename === expectedFilenames[index])
  ) {
    throw new Error('Exact-session purge channel-index target changed after authorization');
  }
}

export function createFilesystemExactSessionPurgeSurfaces(
  sessionsDirInput: string,
): Pick<Record<
  'journals' | 'journal_rolls' | 'channel_index' | 'turn_records',
  ExactSessionSurfacePurgePort
>, 'journals' | 'journal_rolls' | 'channel_index' | 'turn_records'> {
  const sessionsDir = resolve(sessionsDirInput);

  const journalPaths = (target: ExactSessionPurgeResolvedTarget): string[] => [
    exactJournalPath(sessionsDir, target.activeJournalFilename),
  ];
  const rollPaths = (target: ExactSessionPurgeResolvedTarget): string[] => (
    target.rolledJournalFilenames.map(filename => exactJournalPath(sessionsDir, filename))
  );

  const journals: ExactSessionSurfacePurgePort = {
    remove: async (_input, target) => {
      const paths = journalPaths(target);
      return withSessionJournalWriteLock(paths[0]!, () => result(removeExisting(paths)));
    },
    isAbsent: async (_input, target) => allAbsent(journalPaths(target)),
  };

  const journalRolls: ExactSessionSurfacePurgePort = {
    remove: async (_input, target) => {
      const activePath = journalPaths(target)[0]!;
      return withSessionJournalWriteLock(activePath, () => result(removeExisting(rollPaths(target))));
    },
    isAbsent: async (_input, target) => allAbsent(rollPaths(target)),
  };

  const channelIndex: ExactSessionSurfacePurgePort = {
    remove: async (input, target) => {
      const indexPath = join(sessionsDir, CHANNEL_INDEX_FILENAME);
      const index = new Map<string, ChannelIndexEntry>();
      loadChannelIndex(indexPath, index, { persistMigration: false });
      const current = index.get(input.sessionId);
      if (!current) return result(0);
      assertIndexTarget(input, target, current);
      if (!deleteChannelIndexEntryIfUnchanged(input.sessionId, current, indexPath, index)) {
        throw new Error('Exact-session purge channel-index target changed during deletion');
      }
      return result(1);
    },
    isAbsent: async (input) => {
      const index = new Map<string, ChannelIndexEntry>();
      loadChannelIndex(join(sessionsDir, CHANNEL_INDEX_FILENAME), index, { persistMigration: false });
      return !index.has(input.sessionId);
    },
  };

  const turnRecordPaths = (target: ExactSessionPurgeResolvedTarget): string[] => {
    const sanitized = sanitizeChannelId(target.turnRecordChannelId);
    const activePath = join(sessionsDir, '_turn_records', `${sanitized}.jsonl`);
    const dataPaths = [
      activePath,
      ...listNumberedJsonlSegments(activePath).map(segment => segment.path),
    ];
    return [
      ...dataPaths,
      ...dataPaths.map(path => `${path}.quarantine`),
    ];
  };

  const turnRecords: ExactSessionSurfacePurgePort = {
    remove: async (_input, target) => {
      const sanitized = sanitizeChannelId(target.turnRecordChannelId);
      const activePath = join(sessionsDir, '_turn_records', `${sanitized}.jsonl`);
      return withTurnRecordRotationLock(activePath, () => result(removeExisting(turnRecordPaths(target))));
    },
    isAbsent: async (_input, target) => allAbsent(turnRecordPaths(target)),
  };

  return {
    journals,
    journal_rolls: journalRolls,
    channel_index: channelIndex,
    turn_records: turnRecords,
  };
}

/** Postgres surface that deletes only the transcript/search projection and drift. */
export class PostgresExactSessionProjectionPurgeSurface implements ExactSessionSurfacePurgePort {
  constructor(
    private readonly pool: Pool,
    private readonly localProjection: {
      flushPendingWrites(): Promise<void>;
      evictChannel(channelId: string): void;
    },
  ) {}

  async remove(
    _input: ExactSessionPurgeInput,
    target: ExactSessionPurgeResolvedTarget,
  ): Promise<ExactSessionSurfaceDeleteResult> {
    await this.localProjection.flushPendingWrites();
    const removedCount = await withPostgresClient(this.pool, async (client) => {
      const messages = await client.query(`
        DELETE FROM session_messages_projection WHERE channel_id = $1
      `, [target.channelId]);
      const drift = await client.query(`
        DELETE FROM session_projection_drift WHERE channel_id = $1
      `, [target.channelId]);
      return (messages.rowCount ?? 0) + (drift.rowCount ?? 0);
    });
    this.localProjection.evictChannel(target.channelId);
    return result(removedCount);
  }

  async isAbsent(
    _input: ExactSessionPurgeInput,
    target: ExactSessionPurgeResolvedTarget,
  ): Promise<boolean> {
    const check = await this.pool.query<{ message_count: string; drift_count: string }>(`
      SELECT
        (SELECT count(*) FROM session_messages_projection WHERE channel_id = $1)::text AS message_count,
        (SELECT count(*) FROM session_projection_drift WHERE channel_id = $1)::text AS drift_count
    `, [target.channelId]);
    const row = check.rows[0];
    return row?.message_count === '0' && row.drift_count === '0';
  }
}

export interface ExactSessionRedisTailPurgePort {
  purgeChannelKeyFamily(channelKey: string): Promise<number>;
  isChannelKeyFamilyAbsent(channelKey: string): Promise<boolean>;
}

export class RedisExactSessionTailPurgeSurface implements ExactSessionSurfacePurgePort {
  constructor(private readonly tail: ExactSessionRedisTailPurgePort) {}

  async remove(
    _input: ExactSessionPurgeInput,
    target: ExactSessionPurgeResolvedTarget,
  ): Promise<ExactSessionSurfaceDeleteResult> {
    return result(await this.tail.purgeChannelKeyFamily(target.tailChannelKey));
  }

  async isAbsent(
    _input: ExactSessionPurgeInput,
    target: ExactSessionPurgeResolvedTarget,
  ): Promise<boolean> {
    return await this.tail.isChannelKeyFamilyAbsent(target.tailChannelKey);
  }
}
