import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryStorePort } from '../faculties/memory/memory-store-port.js';
import type { ContactStorePort } from '../core/contacts/contact-store-port.js';
import type { IntentionRuntimeProviders, IntentionRuntimeWiring } from '../core/intention/runtime-wiring.js';
import { createAgentPersistenceRuntime } from './runtime-factory.js';

const runtimeFactoryMocks = vi.hoisted(() => ({
  sqliteMemoryStore: { kind: 'sqlite-memory-store' },
  sqliteEpisodicStore: { kind: 'sqlite-episodic-store' },
  sqliteReflectionStore: { kind: 'sqlite-reflection-store' },
  postgresMemoryStore: { kind: 'postgres-memory-store' },
  postgresEpisodicStore: { kind: 'postgres-episodic-store' },
  postgresReflectionMirror: { kind: 'postgres-reflection-mirror' },
  postgresContactStore: { kind: 'postgres-contact-store' },
  postgresIntentionRuntime: {
    concernStore: { kind: 'concern-store' },
    pendingFollowUpStore: { kind: 'pending-store' },
    behavioralPatternTracker: { kind: 'behavioral-store' },
  },
  sqliteCompanionStore: {
    db: { close: vi.fn() },
    memoryStore: { kind: 'sqlite-memory-store' },
    reflectionStore: { kind: 'sqlite-reflection-store' },
  },
  createSqliteCompanionStore: vi.fn(() => runtimeFactoryMocks.sqliteCompanionStore),
  createPostgresMemoryStore: vi.fn(async () => runtimeFactoryMocks.postgresMemoryStore),
  createPostgresEpisodicStore: vi.fn(() => runtimeFactoryMocks.postgresEpisodicStore),
  createPostgresContactStore: vi.fn(async () => runtimeFactoryMocks.postgresContactStore),
  createPostgresIntentionPorts: vi.fn(async () => runtimeFactoryMocks.postgresIntentionRuntime),
  connectPostgresReflectionMirror: vi.fn(async () => runtimeFactoryMocks.postgresReflectionMirror),
  createSqliteEpisodicStore: vi.fn(function EpisodicStore() {
    return runtimeFactoryMocks.sqliteEpisodicStore;
  }),
  createReflectionMetacognitionJournalStore: vi.fn(function ReflectionMetacognitionJournalStore(path: string, options: unknown) {
    return {
      kind: 'reflection-metacognition-journal-store',
      path,
      options,
    };
  }),
}));

vi.mock('./sqlite-companion-store.js', () => ({
  createSqliteCompanionStore: runtimeFactoryMocks.createSqliteCompanionStore,
}));

vi.mock('../faculties/memory/postgres-store.js', () => ({
  createPostgresMemoryStore: runtimeFactoryMocks.createPostgresMemoryStore,
}));

vi.mock('../faculties/memory/episodic/index.js', () => ({
  createPostgresEpisodicStore: runtimeFactoryMocks.createPostgresEpisodicStore,
  EpisodicStore: runtimeFactoryMocks.createSqliteEpisodicStore,
}));

vi.mock('../core/contacts/postgres-adapter.js', () => ({
  createPostgresContactStore: runtimeFactoryMocks.createPostgresContactStore,
}));

vi.mock('../core/intention/postgres-adapters.js', () => ({
  createPostgresIntentionPorts: runtimeFactoryMocks.createPostgresIntentionPorts,
}));

vi.mock('./reflections/postgres-mirror.js', () => ({
  PostgresReflectionMetacognitionMirrorStore: {
    connect: runtimeFactoryMocks.connectPostgresReflectionMirror,
  },
}));

vi.mock('./journals/reflection-metacognition-journal.js', () => ({
  ReflectionMetacognitionJournalStore: runtimeFactoryMocks.createReflectionMetacognitionJournalStore,
}));

beforeEach(() => {
  runtimeFactoryMocks.createSqliteCompanionStore.mockClear();
  runtimeFactoryMocks.createPostgresMemoryStore.mockClear();
  runtimeFactoryMocks.createPostgresEpisodicStore.mockClear();
  runtimeFactoryMocks.createPostgresContactStore.mockClear();
  runtimeFactoryMocks.createPostgresIntentionPorts.mockClear();
  runtimeFactoryMocks.connectPostgresReflectionMirror.mockClear();
  runtimeFactoryMocks.createSqliteEpisodicStore.mockClear();
  runtimeFactoryMocks.createReflectionMetacognitionJournalStore.mockClear();
});

describe('createAgentPersistenceRuntime', () => {
  it('selects sqlite companion storage by default', async () => {
    const runtime = await createAgentPersistenceRuntime({
      config: {
        databasePath: '/tmp/companion.db',
        persistenceBackend: 'sqlite',
      },
      pathSnapshot: {
        systemDataDir: '/tmp/system-data',
        companionDataDir: '/tmp/companion-data',
        workspacePath: '/tmp/workspace',
        tempDir: '/tmp/tmp',
        logsDir: '/tmp/logs',
        backupRootDir: '/tmp/backups',
      },
      embeddingDims: 1024,
    });

    expect(runtime).toEqual({
      backend: 'sqlite',
      db: runtimeFactoryMocks.sqliteCompanionStore.db,
      memoryStore: runtimeFactoryMocks.sqliteMemoryStore as MemoryStorePort,
      episodicStore: runtimeFactoryMocks.sqliteEpisodicStore,
      reflectionStore: runtimeFactoryMocks.sqliteReflectionStore,
    });
    expect(runtimeFactoryMocks.createSqliteCompanionStore).toHaveBeenCalled();
    expect(runtimeFactoryMocks.createSqliteEpisodicStore).toHaveBeenCalledWith(
      runtimeFactoryMocks.sqliteCompanionStore.db,
    );
    expect(runtimeFactoryMocks.createPostgresMemoryStore).not.toHaveBeenCalled();
    expect(runtimeFactoryMocks.createPostgresEpisodicStore).not.toHaveBeenCalled();
    expect(runtimeFactoryMocks.connectPostgresReflectionMirror).not.toHaveBeenCalled();
  });

  it('selects postgres-backed memory, reflections, contacts, and intention stores through the factory', async () => {
    const runtime = await createAgentPersistenceRuntime({
      config: {
        databasePath: '/tmp/ignored.db',
        persistenceBackend: 'postgres',
        postgresDatabaseUrl: 'postgres://postgres:secret@localhost:5432/psfn',
      },
      pathSnapshot: {
        systemDataDir: '/tmp/system-data',
        companionDataDir: '/tmp/companion-data',
        workspacePath: '/tmp/workspace',
        tempDir: '/tmp/tmp',
        logsDir: '/tmp/logs',
        backupRootDir: '/tmp/backups',
      },
      embeddingDims: 1536,
      primaryUserId: 'user-primary',
    });

    expect(runtime).toEqual({
      backend: 'postgres',
      db: null,
      memoryStore: runtimeFactoryMocks.postgresMemoryStore as MemoryStorePort,
      episodicStore: runtimeFactoryMocks.postgresEpisodicStore,
      reflectionStore: {
        kind: 'reflection-metacognition-journal-store',
        path: '/tmp/companion-data/state/notes/reflections/metacognition/journal.jsonl',
        options: {
          mirror: runtimeFactoryMocks.postgresReflectionMirror,
        },
      },
      contactStore: runtimeFactoryMocks.postgresContactStore as ContactStorePort,
      intentionRuntime: runtimeFactoryMocks.postgresIntentionRuntime as IntentionRuntimeWiring,
      intentionProviders: runtimeFactoryMocks.postgresIntentionRuntime as IntentionRuntimeProviders,
    });
    expect(runtimeFactoryMocks.createSqliteCompanionStore).not.toHaveBeenCalled();
    expect(runtimeFactoryMocks.createPostgresMemoryStore).toHaveBeenCalledWith(
      'postgres://postgres:secret@localhost:5432/psfn',
      1536,
      expect.objectContaining({
        notesDir: '/tmp/companion-data/state/notes',
        scratchpadMirrorPath: '/tmp/companion-data/state/notes/scratchpad.json',
        journal: expect.any(Object),
      }),
    );
    expect(runtimeFactoryMocks.createPostgresEpisodicStore).toHaveBeenCalledWith(
      'postgres://postgres:secret@localhost:5432/psfn',
    );
    expect(runtimeFactoryMocks.connectPostgresReflectionMirror).toHaveBeenCalledWith(
      'postgres://postgres:secret@localhost:5432/psfn',
    );
    expect(runtimeFactoryMocks.createReflectionMetacognitionJournalStore).toHaveBeenCalledWith(
      '/tmp/companion-data/state/notes/reflections/metacognition/journal.jsonl',
      {
        mirror: runtimeFactoryMocks.postgresReflectionMirror,
      },
    );
    expect(runtimeFactoryMocks.createPostgresContactStore).toHaveBeenCalledWith(
      'postgres://postgres:secret@localhost:5432/psfn',
      'user-primary',
      {
        exportDir: '/tmp/companion-data/state/contacts',
      },
    );
    expect(runtimeFactoryMocks.createPostgresIntentionPorts).toHaveBeenCalledWith(
      'postgres://postgres:secret@localhost:5432/psfn',
    );
  });
});
