import { join } from 'node:path';
import type { SessionArchivePort } from '../journals/journal/port.js';
import { createFilesystemSessionArchivePort } from '../journals/journal/port.js';
import { createSqliteTranscriptProjection } from './transcript-projection.js';
import type { TranscriptProjectionPort } from './transcript-projection-port.js';
import type { TranscriptSearchPort } from './transcript-search-port.js';
import type { TurnRecordStorePort } from './turn-record-store-port.js';
import { createFilesystemTurnRecordStorePort } from './turn-records.js';

export const DEFAULT_SQLITE_SESSION_SEARCH_INDEX_FILENAME = 'session-search.sqlite';

export interface SQLiteSessionAdapters {
  sessionArchivePort: SessionArchivePort;
  transcriptProjection: TranscriptProjectionPort | null;
  transcriptSearch: TranscriptSearchPort | null;
  turnRecordStore: TurnRecordStorePort;
}

export interface SQLiteSessionAdaptersOptions {
  disableSearchIndex?: boolean;
  searchIndexPath?: string;
}

export function createDefaultSQLiteSessionArchivePort(): SessionArchivePort {
  return createFilesystemSessionArchivePort();
}

export function createDefaultSQLiteTranscriptProjection(
  searchIndexPath: string,
): TranscriptProjectionPort {
  return createSqliteTranscriptProjection(searchIndexPath);
}

export function createDefaultSQLiteTurnRecordStorePort(
  sessionsDir: string,
): TurnRecordStorePort {
  return createFilesystemTurnRecordStorePort(sessionsDir);
}

export function createDefaultSQLiteSessionAdapters(
  sessionsDir: string,
  options: SQLiteSessionAdaptersOptions = {},
): SQLiteSessionAdapters {
  const sessionArchivePort = createDefaultSQLiteSessionArchivePort();
  const transcriptProjection = options.disableSearchIndex
    ? null
    : createDefaultSQLiteTranscriptProjection(
      options.searchIndexPath
        ?? join(sessionsDir, DEFAULT_SQLITE_SESSION_SEARCH_INDEX_FILENAME),
    );

  return {
    sessionArchivePort,
    transcriptProjection,
    transcriptSearch: transcriptProjection,
    turnRecordStore: createDefaultSQLiteTurnRecordStorePort(sessionsDir),
  };
}
