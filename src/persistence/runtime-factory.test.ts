import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryStorePort } from '../faculties/memory/memory-store-port.js';
import type { ContactStorePort } from '../core/contacts/contact-store-port.js';
import type { IntentionRuntimeProviders, IntentionRuntimeWiring } from '../core/intention/runtime-wiring.js';
import { createAgentPersistenceRuntime } from './runtime-factory.js';

const runtimeFactoryMocks = vi.hoisted(() => ({
  postgresMemoryStore: { kind: 'postgres-memory-store' },
  postgresEpisodicStore: { kind: 'postgres-episodic-store' },
  postgresReflectionMirror: { kind: 'postgres-reflection-mirror' },
  postgresContactStore: {
    kind: 'postgres-contact-store',
    assertContactLifecycleLedgerHealthy: vi.fn(async () => undefined),
    recoverContactLifecycleMutations: vi.fn(async () => []),
  },
  postgresIntentionRuntime: {
    concernStore: { kind: 'concern-store' },
    pendingFollowUpStore: { kind: 'pending-store' },
    behavioralPatternTracker: { kind: 'behavioral-store' },
  },
  createPostgresMemoryStore: vi.fn(async () => runtimeFactoryMocks.postgresMemoryStore),
  createPostgresEpisodicStore: vi.fn(() => runtimeFactoryMocks.postgresEpisodicStore),
  createPostgresContactStore: vi.fn(async () => runtimeFactoryMocks.postgresContactStore),
  createPostgresIntentionPorts: vi.fn(async () => runtimeFactoryMocks.postgresIntentionRuntime),
  connectPostgresReflectionMirror: vi.fn(async () => runtimeFactoryMocks.postgresReflectionMirror),
  postgresInternalStateStore: { kind: 'postgres-internal-state-store' },
  connectPostgresInternalStateStore: vi.fn(async () => runtimeFactoryMocks.postgresInternalStateStore),
  postgresParticipantTrendStore: { kind: 'postgres-participant-trend-store' },
  connectPostgresParticipantTrendStore: vi.fn(async () => runtimeFactoryMocks.postgresParticipantTrendStore),
  postgresScheduledPromptStore: { kind: 'postgres-scheduled-prompt-store' },
  connectPostgresScheduledPromptStore: vi.fn(async () => runtimeFactoryMocks.postgresScheduledPromptStore),
  postgresBackgroundWorkStore: { kind: 'postgres-background-work-store' },
  connectPostgresBackgroundWorkStore: vi.fn(async () => runtimeFactoryMocks.postgresBackgroundWorkStore),
  postgresCompanionPresenceStore: { kind: 'postgres-companion-presence-store' },
  connectPostgresCompanionPresenceStore: vi.fn(async () => runtimeFactoryMocks.postgresCompanionPresenceStore),
  postgresPartnerAffectShadowStore: { kind: 'postgres-partner-affect-shadow-store' },
  connectPostgresPartnerAffectShadowStore: vi.fn(async () => runtimeFactoryMocks.postgresPartnerAffectShadowStore),
  bootstrapPool: { end: vi.fn(async () => undefined) },
  createPostgresPool: vi.fn(() => runtimeFactoryMocks.bootstrapPool),
  ensurePostgresSchemaExists: vi.fn(async () => undefined),
  ensurePostgresSchema: vi.fn(async () => undefined),
  derivePostgresTenantRole: vi.fn((schema: string) => `psfn_role_${schema}`),
  planPostgresTenantAccess: vi.fn((plan: { schema: string; role: string }) => ({
    ...plan,
    extensionSchema: 'extensions',
    searchPath: `${plan.schema},extensions`,
  })),
  assertPostgresTenantAccessProvisioned: vi.fn(async () => undefined),
  createReflectionMetacognitionJournalStore: vi.fn(function ReflectionMetacognitionJournalStore(path: string, options: unknown) {
    return {
      kind: 'reflection-metacognition-journal-store',
      path,
      options,
    };
  }),
}));

vi.mock('../faculties/memory/postgres-store.js', () => ({
  createPostgresMemoryStore: runtimeFactoryMocks.createPostgresMemoryStore,
}));

vi.mock('../faculties/memory/episodic/index.js', () => ({
  createPostgresEpisodicStore: runtimeFactoryMocks.createPostgresEpisodicStore,
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

vi.mock('./postgres/internal-state-store.js', () => ({
  PostgresInternalStateStore: {
    connect: runtimeFactoryMocks.connectPostgresInternalStateStore,
  },
}));

vi.mock('./postgres/participant-trend-store.js', () => ({
  PostgresParticipantTrendStore: {
    connect: runtimeFactoryMocks.connectPostgresParticipantTrendStore,
  },
}));

vi.mock('./postgres/scheduled-prompt-store.js', () => ({
  PostgresScheduledPromptStore: {
    connect: runtimeFactoryMocks.connectPostgresScheduledPromptStore,
  },
}));

vi.mock('./postgres/background-work-store.js', () => ({
  PostgresBackgroundWorkStore: {
    connect: runtimeFactoryMocks.connectPostgresBackgroundWorkStore,
  },
}));

vi.mock('./postgres/companion-presence-store.js', () => ({
  PostgresCompanionPresenceStore: {
    connect: runtimeFactoryMocks.connectPostgresCompanionPresenceStore,
  },
}));

vi.mock('./postgres/partner-affect-shadow-store.js', () => ({
  PostgresPartnerAffectShadowStore: {
    connect: runtimeFactoryMocks.connectPostgresPartnerAffectShadowStore,
  },
}));

vi.mock('./postgres.js', () => ({
  createPostgresPool: runtimeFactoryMocks.createPostgresPool,
  ensurePostgresSchemaExists: runtimeFactoryMocks.ensurePostgresSchemaExists,
  ensurePostgresSchema: runtimeFactoryMocks.ensurePostgresSchema,
}));

vi.mock('./postgres/tenancy.js', () => ({
  derivePostgresTenantRole: runtimeFactoryMocks.derivePostgresTenantRole,
  planPostgresTenantAccess: runtimeFactoryMocks.planPostgresTenantAccess,
  assertPostgresTenantAccessProvisioned: runtimeFactoryMocks.assertPostgresTenantAccessProvisioned,
}));

beforeEach(() => {
  runtimeFactoryMocks.createPostgresMemoryStore.mockClear();
  runtimeFactoryMocks.createPostgresEpisodicStore.mockClear();
  runtimeFactoryMocks.createPostgresContactStore.mockClear();
  runtimeFactoryMocks.createPostgresIntentionPorts.mockClear();
  runtimeFactoryMocks.connectPostgresReflectionMirror.mockClear();
  runtimeFactoryMocks.connectPostgresScheduledPromptStore.mockClear();
  runtimeFactoryMocks.connectPostgresBackgroundWorkStore.mockClear();
  runtimeFactoryMocks.connectPostgresCompanionPresenceStore.mockClear();
  runtimeFactoryMocks.connectPostgresPartnerAffectShadowStore.mockClear();
  runtimeFactoryMocks.createReflectionMetacognitionJournalStore.mockClear();
  runtimeFactoryMocks.connectPostgresInternalStateStore.mockClear();
  runtimeFactoryMocks.connectPostgresParticipantTrendStore.mockClear();
  runtimeFactoryMocks.createPostgresPool.mockClear();
  runtimeFactoryMocks.ensurePostgresSchemaExists.mockClear();
  runtimeFactoryMocks.derivePostgresTenantRole.mockClear();
  runtimeFactoryMocks.planPostgresTenantAccess.mockClear();
  runtimeFactoryMocks.assertPostgresTenantAccessProvisioned.mockClear();
  runtimeFactoryMocks.bootstrapPool.end.mockClear();
  runtimeFactoryMocks.postgresContactStore.assertContactLifecycleLedgerHealthy.mockClear();
  runtimeFactoryMocks.postgresContactStore.recoverContactLifecycleMutations.mockClear();
});

describe('createAgentPersistenceRuntime', () => {
  it('runs authenticated contact recovery before returning and exposes a stoppable worker', async () => {
    const gateway = { executeContactLifecycle: vi.fn() };
    const runtime = await createAgentPersistenceRuntime({
      config: {
        databasePath: '/tmp/ignored.db',
        persistenceBackend: 'postgres',
        postgresDatabaseUrl: 'postgres://postgres:secret@localhost:5432/psfn',
        postgresSchema: 'companion_x',
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
      contactLifecycleGateway: gateway,
    });

    expect(runtimeFactoryMocks.createPostgresContactStore).toHaveBeenCalledWith(
      expect.any(String),
      undefined,
      expect.objectContaining({ contactLifecycleGateway: gateway, schema: 'companion_x' }),
    );
    expect(runtimeFactoryMocks.postgresContactStore.assertContactLifecycleLedgerHealthy)
      .toHaveBeenCalledTimes(1);
    expect(runtimeFactoryMocks.postgresContactStore.recoverContactLifecycleMutations)
      .toHaveBeenCalledTimes(1);
    expect(runtime.contactLifecycleRecovery).toBeDefined();
    await runtime.contactLifecycleRecovery?.stop();
  });

  it('fails closed when runtime persistence is not configured for postgres', async () => {
    await expect(createAgentPersistenceRuntime({
      config: {
        databasePath: '/tmp/companion.db',
        persistenceBackend: 'sqlite' as never,
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
    })).rejects.toThrow('requires config.persistenceBackend=postgres');
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
      // Enrollment store (locations vinz.12) is constructed for real around the
      // mocked pool — asserted structurally, schema threading asserted below.
      hubIdentityEnrollmentStore: expect.any(Object),
      intentionRuntime: runtimeFactoryMocks.postgresIntentionRuntime as IntentionRuntimeWiring,
      intentionProviders: runtimeFactoryMocks.postgresIntentionRuntime as IntentionRuntimeProviders,
      internalStateStore: runtimeFactoryMocks.postgresInternalStateStore,
      participantTrendStore: runtimeFactoryMocks.postgresParticipantTrendStore,
      scheduledPromptStore: runtimeFactoryMocks.postgresScheduledPromptStore,
      backgroundWorkStore: runtimeFactoryMocks.postgresBackgroundWorkStore,
      partnerAffectShadowStore: runtimeFactoryMocks.postgresPartnerAffectShadowStore,
      introspectionLandmarkStore: expect.any(Object),
      weightedThoughtStore: undefined,
    });
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
      { schema: undefined },
    );
    expect(runtimeFactoryMocks.connectPostgresReflectionMirror).toHaveBeenCalledWith(
      'postgres://postgres:secret@localhost:5432/psfn',
      { schema: undefined },
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
        schema: undefined,
      },
    );
    expect(runtimeFactoryMocks.createPostgresIntentionPorts).toHaveBeenCalledWith(
      'postgres://postgres:secret@localhost:5432/psfn',
      { schema: undefined },
    );
    expect(runtimeFactoryMocks.connectPostgresScheduledPromptStore).toHaveBeenCalledWith(
      'postgres://postgres:secret@localhost:5432/psfn',
      { schema: undefined },
    );
    expect(runtimeFactoryMocks.connectPostgresBackgroundWorkStore).toHaveBeenCalledWith(
      'postgres://postgres:secret@localhost:5432/psfn',
      { schema: undefined },
    );
    // No schema configured: no companion schema is provisioned up front. The
    // enrollment store still creates its own (schema-less) pool, so assert no
    // pool anywhere was schema-pinned rather than "no pool at all".
    expect(runtimeFactoryMocks.ensurePostgresSchemaExists).not.toHaveBeenCalled();
    for (const call of runtimeFactoryMocks.createPostgresPool.mock.calls) {
      expect(call[1]?.schema).toBeUndefined();
    }
    // Multi-companion flag off: the shared schema is never touched and no
    // presence store exists.
    expect(runtimeFactoryMocks.connectPostgresCompanionPresenceStore).not.toHaveBeenCalled();
    expect(runtime.companionPresenceStore).toBeUndefined();
  });

  it('connects the shared-schema companion presence store only when multi-companion is enabled', async () => {
    const runtime = await createAgentPersistenceRuntime({
      config: {
        databasePath: '/tmp/ignored.db',
        persistenceBackend: 'postgres',
        postgresDatabaseUrl: 'postgres://postgres:secret@localhost:5432/psfn',
        postgresSchema: 'companion_x',
        multiCompanion: true,
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

    expect(runtimeFactoryMocks.connectPostgresCompanionPresenceStore).toHaveBeenCalledWith(
      'postgres://postgres:secret@localhost:5432/psfn',
    );
    expect(runtimeFactoryMocks.assertPostgresTenantAccessProvisioned).toHaveBeenCalledWith(
      runtimeFactoryMocks.bootstrapPool,
      expect.objectContaining({
        schema: 'companion_x',
        role: 'psfn_role_companion_x',
        searchPath: 'companion_x,extensions',
      }),
    );
    expect(runtime.companionPresenceStore).toBe(runtimeFactoryMocks.postgresCompanionPresenceStore);
  });

  it('threads the configured per-companion schema into every store and provisions it up front', async () => {
    await createAgentPersistenceRuntime({
      config: {
        databasePath: '/tmp/ignored.db',
        persistenceBackend: 'postgres',
        postgresDatabaseUrl: 'postgres://postgres:secret@localhost:5432/psfn',
        postgresSchema: 'companion_x',
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

    // The schema is created once, before any store connects.
    expect(runtimeFactoryMocks.createPostgresPool).toHaveBeenCalledWith(
      'postgres://postgres:secret@localhost:5432/psfn',
      expect.objectContaining({ schema: 'companion_x' }),
    );
    expect(runtimeFactoryMocks.ensurePostgresSchemaExists).toHaveBeenCalledWith(
      runtimeFactoryMocks.bootstrapPool,
      'companion_x',
    );

    // Every runtime store receives the same schema.
    expect(runtimeFactoryMocks.createPostgresMemoryStore).toHaveBeenCalledWith(
      'postgres://postgres:secret@localhost:5432/psfn',
      1536,
      expect.objectContaining({ schema: 'companion_x' }),
    );
    expect(runtimeFactoryMocks.createPostgresEpisodicStore).toHaveBeenCalledWith(
      'postgres://postgres:secret@localhost:5432/psfn',
      { schema: 'companion_x' },
    );
    expect(runtimeFactoryMocks.connectPostgresReflectionMirror).toHaveBeenCalledWith(
      'postgres://postgres:secret@localhost:5432/psfn',
      { schema: 'companion_x' },
    );
    expect(runtimeFactoryMocks.createPostgresContactStore).toHaveBeenCalledWith(
      'postgres://postgres:secret@localhost:5432/psfn',
      'user-primary',
      expect.objectContaining({ schema: 'companion_x' }),
    );
    expect(runtimeFactoryMocks.createPostgresIntentionPorts).toHaveBeenCalledWith(
      'postgres://postgres:secret@localhost:5432/psfn',
      { schema: 'companion_x' },
    );
    // The enrollment store's pool is schema-pinned too — its tables FK-reference
    // contacts(id), which lives inside the companion schema.
    expect(runtimeFactoryMocks.createPostgresPool).toHaveBeenCalledWith(
      'postgres://postgres:secret@localhost:5432/psfn',
      expect.objectContaining({ applicationName: 'psfn-enrollment', schema: 'companion_x' }),
    );
    expect(runtimeFactoryMocks.connectPostgresInternalStateStore).toHaveBeenCalledWith(
      'postgres://postgres:secret@localhost:5432/psfn',
      { schema: 'companion_x' },
    );
    expect(runtimeFactoryMocks.connectPostgresParticipantTrendStore).toHaveBeenCalledWith(
      'postgres://postgres:secret@localhost:5432/psfn',
      { schema: 'companion_x' },
    );
    expect(runtimeFactoryMocks.connectPostgresScheduledPromptStore).toHaveBeenCalledWith(
      'postgres://postgres:secret@localhost:5432/psfn',
      { schema: 'companion_x' },
    );
    expect(runtimeFactoryMocks.connectPostgresBackgroundWorkStore).toHaveBeenCalledWith(
      'postgres://postgres:secret@localhost:5432/psfn',
      { schema: 'companion_x' },
    );
  });
});
