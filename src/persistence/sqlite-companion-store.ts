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
  resolveScratchpadMirrorPath,
} from './layout.js';
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
}

export function createSqliteCompanionStore(
  options: SqliteCompanionStoreOptions,
): SqliteCompanionStore {
  const db = initDatabase(options.databasePath, options.databaseOptions);
  const companionDataDir = options.companionDataDir.trim();
  const memoryStore = createMemoryStorePort(
    new MemoryStore(db, options.embeddingDims, {
      notesDir: resolveNotesDir(companionDataDir),
      scratchpadMirrorPath: resolveScratchpadMirrorPath(companionDataDir),
      journal: new MemoryJournal(resolveMemoryJournalPath(companionDataDir)),
    }),
  );

  return {
    db,
    memoryStore,
  };
}
