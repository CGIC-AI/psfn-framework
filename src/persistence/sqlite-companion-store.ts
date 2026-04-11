import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { MemoryJournal } from '../faculties/memory/journal.js';
import {
  createMemoryStorePort,
  type MemoryStorePort,
} from '../faculties/memory/memory-store-port.js';
import { MemoryStore } from '../faculties/memory/store.js';
import {
  resolveMemoryJournalPath,
  resolveNotesDir,
  resolveCompanionStateDir,
  resolveReflectionMetacognitionJournalPath,
  resolveScratchpadMirrorPath,
} from './layout.js';
import {
  ReflectionMetacognitionJournalStore,
} from './journals/reflection-metacognition-journal.js';
import { SqliteReflectionMetacognitionMirrorStore } from './reflections/sqlite-mirror.js';
import { initDatabase, type SqliteInitOptions } from './sqlite-utils.js';

export interface SqliteCompanionStoreOptions {
  databasePath: string;
  companionDataDir: string;
  embeddingDims: number;
  databaseOptions?: SqliteInitOptions;
}

export interface SqliteCompanionStore {
  db: Database.Database;
  memoryStore: MemoryStorePort;
  reflectionStore: ReflectionMetacognitionJournalStore;
}

function migrateLegacySqliteDatabaseIfNeeded(
  companionDataDir: string,
  databasePath: string,
): void {
  const resolvedTargetPath = resolve(databasePath);
  const legacyDatabasePath = resolve(join(companionDataDir, basename(databasePath)));
  const companionStateDir = resolve(resolveCompanionStateDir(companionDataDir));

  if (
    existsSync(resolvedTargetPath)
    || legacyDatabasePath === resolvedTargetPath
    || !resolvedTargetPath.startsWith(`${companionStateDir}/`)
    || !existsSync(legacyDatabasePath)
  ) {
    return;
  }

  mkdirSync(dirname(resolvedTargetPath), { recursive: true });
  renameSync(legacyDatabasePath, resolvedTargetPath);

  for (const suffix of ['-wal', '-shm']) {
    const legacySidecarPath = `${legacyDatabasePath}${suffix}`;
    const targetSidecarPath = `${resolvedTargetPath}${suffix}`;
    if (!existsSync(legacySidecarPath) || existsSync(targetSidecarPath)) {
      continue;
    }
    renameSync(legacySidecarPath, targetSidecarPath);
  }
}

export function createSqliteCompanionStore(
  options: SqliteCompanionStoreOptions,
): SqliteCompanionStore {
  migrateLegacySqliteDatabaseIfNeeded(options.companionDataDir, options.databasePath);
  const db = initDatabase(options.databasePath, options.databaseOptions);
  const companionDataDir = options.companionDataDir.trim();
  const memoryStore = createMemoryStorePort(
    new MemoryStore(db, options.embeddingDims, {
      notesDir: resolveNotesDir(companionDataDir),
      scratchpadMirrorPath: resolveScratchpadMirrorPath(companionDataDir),
      journal: new MemoryJournal(resolveMemoryJournalPath(companionDataDir)),
    }),
  );
  const reflectionStore = new ReflectionMetacognitionJournalStore(
    resolveReflectionMetacognitionJournalPath(companionDataDir),
    {
      mirror: new SqliteReflectionMetacognitionMirrorStore(db),
    },
  );

  return {
    db,
    memoryStore,
    reflectionStore,
  };
}
