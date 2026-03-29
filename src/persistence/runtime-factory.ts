import type Database from 'better-sqlite3';
import { MemoryJournal } from '../faculties/memory/journal.js';
import type { MemoryStorePort } from '../faculties/memory/memory-store-port.js';
import { createPostgresMemoryStore } from '../faculties/memory/postgres-store.js';
import type {
  PersistenceBackend,
  SubstrateConfig,
} from '../system/config/runtime-config-contracts.js';
import {
  resolveMemoryJournalPath,
  resolveNotesDir,
  resolveScratchpadMirrorPath,
  type RuntimePathSnapshot,
} from './layout.js';
import {
  createSqliteCompanionStore,
  type SqliteCompanionStoreOptions,
} from './sqlite-companion-store.js';

export interface AgentPersistenceRuntime {
  backend: PersistenceBackend;
  db: Database.Database | null;
  memoryStore: MemoryStorePort;
}

export interface CreateAgentPersistenceRuntimeOptions {
  config: Pick<SubstrateConfig, 'databasePath' | 'persistenceBackend' | 'postgresDatabaseUrl'>;
  pathSnapshot: RuntimePathSnapshot;
  embeddingDims: number;
  sqlite?: Pick<SqliteCompanionStoreOptions, 'databaseOptions'>;
}

export async function createAgentPersistenceRuntime(
  options: CreateAgentPersistenceRuntimeOptions,
): Promise<AgentPersistenceRuntime> {
  const backend = options.config.persistenceBackend ?? 'sqlite';
  if (backend === 'postgres') {
    const databaseUrl = options.config.postgresDatabaseUrl?.trim();
    if (!databaseUrl) {
      throw new Error('PostgreSQL persistence requires config.postgresDatabaseUrl');
    }
    return {
      backend,
      db: null,
      memoryStore: await createPostgresMemoryStore(databaseUrl, options.embeddingDims, {
        notesDir: resolveNotesDir(options.pathSnapshot.companionDataDir),
        scratchpadMirrorPath: resolveScratchpadMirrorPath(options.pathSnapshot.companionDataDir),
        journal: new MemoryJournal(resolveMemoryJournalPath(options.pathSnapshot.companionDataDir)),
      }),
    };
  }

  const sqliteCompanionStore = createSqliteCompanionStore({
    databasePath: options.config.databasePath,
    companionDataDir: options.pathSnapshot.companionDataDir,
    embeddingDims: options.embeddingDims,
    databaseOptions: options.sqlite?.databaseOptions,
  });
  return {
    backend,
    db: sqliteCompanionStore.db,
    memoryStore: sqliteCompanionStore.memoryStore,
  };
}
