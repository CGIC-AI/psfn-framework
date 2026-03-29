import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryStorePort } from '../faculties/memory/memory-store-port.js';
import type { ContactStorePort } from '../core/contacts/contact-store-port.js';
import type { IntentionRuntimeProviders, IntentionRuntimeWiring } from '../core/intention/runtime-wiring.js';
import { createAgentPersistenceRuntime } from './runtime-factory.js';

const runtimeFactoryMocks = vi.hoisted(() => ({
  sqliteMemoryStore: { kind: 'sqlite-memory-store' },
  postgresMemoryStore: { kind: 'postgres-memory-store' },
  postgresContactStore: { kind: 'postgres-contact-store' },
  postgresIntentionRuntime: {
    concernStore: { kind: 'concern-store' },
    pendingFollowUpStore: { kind: 'pending-store' },
    behavioralPatternTracker: { kind: 'behavioral-store' },
  },
  sqliteCompanionStore: {
    db: { close: vi.fn() },
    memoryStore: { kind: 'sqlite-memory-store' },
  },
  createSqliteCompanionStore: vi.fn(() => runtimeFactoryMocks.sqliteCompanionStore),
  createPostgresMemoryStore: vi.fn(async () => runtimeFactoryMocks.postgresMemoryStore),
  createPostgresContactStore: vi.fn(async () => runtimeFactoryMocks.postgresContactStore),
  createPostgresIntentionPorts: vi.fn(async () => runtimeFactoryMocks.postgresIntentionRuntime),
}));

vi.mock('./sqlite-companion-store.js', () => ({
  createSqliteCompanionStore: runtimeFactoryMocks.createSqliteCompanionStore,
}));

vi.mock('../faculties/memory/postgres-store.js', () => ({
  createPostgresMemoryStore: runtimeFactoryMocks.createPostgresMemoryStore,
}));

vi.mock('../core/contacts/postgres-adapter.js', () => ({
  createPostgresContactStore: runtimeFactoryMocks.createPostgresContactStore,
}));

vi.mock('../core/intention/postgres-adapters.js', () => ({
  createPostgresIntentionPorts: runtimeFactoryMocks.createPostgresIntentionPorts,
}));

beforeEach(() => {
  runtimeFactoryMocks.createSqliteCompanionStore.mockClear();
  runtimeFactoryMocks.createPostgresMemoryStore.mockClear();
  runtimeFactoryMocks.createPostgresContactStore.mockClear();
  runtimeFactoryMocks.createPostgresIntentionPorts.mockClear();
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
    });
    expect(runtimeFactoryMocks.createSqliteCompanionStore).toHaveBeenCalled();
    expect(runtimeFactoryMocks.createPostgresMemoryStore).not.toHaveBeenCalled();
    expect(runtimeFactoryMocks.createPostgresContactStore).not.toHaveBeenCalled();
    expect(runtimeFactoryMocks.createPostgresIntentionPorts).not.toHaveBeenCalled();
  });

  it('selects postgres-backed memory, contacts, and intention stores through the factory', async () => {
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
      contactStore: runtimeFactoryMocks.postgresContactStore as ContactStorePort,
      intentionRuntime: runtimeFactoryMocks.postgresIntentionRuntime as IntentionRuntimeWiring,
      intentionProviders: runtimeFactoryMocks.postgresIntentionRuntime as IntentionRuntimeProviders,
    });
    expect(runtimeFactoryMocks.createSqliteCompanionStore).not.toHaveBeenCalled();
    expect(runtimeFactoryMocks.createPostgresMemoryStore).toHaveBeenCalledWith(
      'postgres://postgres:secret@localhost:5432/psfn',
      1536,
      expect.objectContaining({
        notesDir: '/tmp/companion-data/notes',
        scratchpadMirrorPath: '/tmp/companion-data/notes/scratchpad.json',
        journal: expect.any(Object),
      }),
    );
    expect(runtimeFactoryMocks.createPostgresContactStore).toHaveBeenCalledWith(
      'postgres://postgres:secret@localhost:5432/psfn',
      'user-primary',
      {
        exportDir: '/tmp/companion-data/contacts',
      },
    );
    expect(runtimeFactoryMocks.createPostgresIntentionPorts).toHaveBeenCalledWith(
      'postgres://postgres:secret@localhost:5432/psfn',
    );
  });
});
