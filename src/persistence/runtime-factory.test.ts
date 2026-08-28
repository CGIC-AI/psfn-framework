import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryStorePort } from '../faculties/memory/memory-store-port.js';
import type { ContactStorePort } from '../core/contacts/contact-store-port.js';
import type { IntentionRuntimeProviders, IntentionRuntimeWiring } from '../core/intention/runtime-wiring.js';
import { createAgentPersistenceRuntime } from './runtime-factory.js';
import { loadAutomataPolicySeedDefaults } from '../system/config/automata-policy-config.js';

const runtimeFactoryMocks = vi.hoisted(() => ({
  postgresMemoryStore: {
    kind: 'postgres-memory-store',
    memoryDeletionProposalStore: { kind: 'postgres-memory-deletion-proposal-store' },
  },
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
  postgresCompanionAvailabilityStore: { kind: 'postgres-companion-availability-store' },
  connectPostgresCompanionAvailabilityStore: vi.fn(
    async () => runtimeFactoryMocks.postgresCompanionAvailabilityStore,
  ),
  postgresBackgroundWorkStore: { kind: 'postgres-background-work-store' },
  connectPostgresBackgroundWorkStore: vi.fn(async () => runtimeFactoryMocks.postgresBackgroundWorkStore),
  postgresCompanionPresenceStore: { kind: 'postgres-companion-presence-store' },
  connectPostgresCompanionPresenceStore: vi.fn(async () => runtimeFactoryMocks.postgresCompanionPresenceStore),
  postgresSocialPotStore: { kind: 'postgres-social-pot-store' },
  connectPostgresSocialPotStore: vi.fn(async () => runtimeFactoryMocks.postgresSocialPotStore),
  postgresSpeakingArbiterStore: { kind: 'postgres-speaking-arbiter-store' },
  connectPostgresSpeakingArbiterStore: vi.fn(async () => runtimeFactoryMocks.postgresSpeakingArbiterStore),
  postgresPartnerAffectShadowStore: { kind: 'postgres-partner-affect-shadow-store' },
  connectPostgresPartnerAffectShadowStore: vi.fn(async () => runtimeFactoryMocks.postgresPartnerAffectShadowStore),
  postgresAutomataRunStore: {
    loadRetained: vi.fn(async () => []),
    insert: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  },
  connectPostgresAutomataRunStore: vi.fn(async () => runtimeFactoryMocks.postgresAutomataRunStore),
  postgresAutomataBusStore: {
    append: vi.fn(),
    readHistory: vi.fn(),
    readCurrentFindingsByEventIds: vi.fn(),
    readCurrentState: vi.fn(),
    getQueryPool: vi.fn(() => runtimeFactoryMocks.bootstrapPool),
    close: vi.fn(async () => undefined),
  },
  connectPostgresAutomataBusRuntimeStore: vi.fn(
    async () => runtimeFactoryMocks.postgresAutomataBusStore,
  ),
  bootstrapPool: { end: vi.fn(async () => undefined) },
  createPostgresPool: vi.fn(() => runtimeFactoryMocks.bootstrapPool),
  ensurePostgresSchemaExists: vi.fn(async () => undefined),
  ensurePostgresSchema: vi.fn(async () => undefined),
  assertSharedSchemaRuntimeAuthority: vi.fn(async () => undefined),
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

vi.mock('./postgres/companion-availability-store.js', () => ({
  PostgresCompanionAvailabilityStore: {
    connect: runtimeFactoryMocks.connectPostgresCompanionAvailabilityStore,
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

vi.mock('./postgres/social-pot-store.js', () => ({
  PostgresSocialPotStore: {
    connect: runtimeFactoryMocks.connectPostgresSocialPotStore,
  },
}));

vi.mock('./postgres/speaking-arbiter-store.js', () => ({
  PostgresSpeakingArbiterStore: {
    connect: runtimeFactoryMocks.connectPostgresSpeakingArbiterStore,
  },
}));

vi.mock('./postgres/partner-affect-shadow-store.js', () => ({
  PostgresPartnerAffectShadowStore: {
    connect: runtimeFactoryMocks.connectPostgresPartnerAffectShadowStore,
  },
}));

vi.mock('./postgres/automata-run-store.js', () => ({
  PostgresAutomataRunStore: {
    connect: runtimeFactoryMocks.connectPostgresAutomataRunStore,
  },
}));

vi.mock('../faculties/automata/bus/runtime-store.js', () => ({
  connectPostgresAutomataBusRuntimeStore:
    runtimeFactoryMocks.connectPostgresAutomataBusRuntimeStore,
}));

vi.mock('./postgres.js', () => ({
  createPostgresPool: runtimeFactoryMocks.createPostgresPool,
  ensurePostgresSchemaExists: runtimeFactoryMocks.ensurePostgresSchemaExists,
  ensurePostgresSchema: runtimeFactoryMocks.ensurePostgresSchema,
}));

vi.mock('./postgres/shared-schema.js', () => ({
  assertSharedSchemaRuntimeAuthority: runtimeFactoryMocks.assertSharedSchemaRuntimeAuthority,
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
  runtimeFactoryMocks.connectPostgresCompanionAvailabilityStore.mockClear();
  runtimeFactoryMocks.connectPostgresBackgroundWorkStore.mockClear();
  runtimeFactoryMocks.connectPostgresCompanionPresenceStore.mockClear();
  runtimeFactoryMocks.connectPostgresSocialPotStore.mockClear();
  runtimeFactoryMocks.connectPostgresSpeakingArbiterStore.mockClear();
  runtimeFactoryMocks.connectPostgresPartnerAffectShadowStore.mockClear();
  runtimeFactoryMocks.connectPostgresAutomataRunStore.mockClear();
  runtimeFactoryMocks.connectPostgresAutomataBusRuntimeStore.mockClear();
  runtimeFactoryMocks.createReflectionMetacognitionJournalStore.mockClear();
  runtimeFactoryMocks.connectPostgresInternalStateStore.mockClear();
  runtimeFactoryMocks.connectPostgresParticipantTrendStore.mockClear();
  runtimeFactoryMocks.createPostgresPool.mockClear();
  runtimeFactoryMocks.ensurePostgresSchemaExists.mockClear();
  runtimeFactoryMocks.assertSharedSchemaRuntimeAuthority.mockClear();
  runtimeFactoryMocks.derivePostgresTenantRole.mockClear();
  runtimeFactoryMocks.planPostgresTenantAccess.mockClear();
  runtimeFactoryMocks.assertPostgresTenantAccessProvisioned.mockClear();
  runtimeFactoryMocks.bootstrapPool.end.mockClear();
  runtimeFactoryMocks.postgresContactStore.assertContactLifecycleLedgerHealthy.mockClear();
  runtimeFactoryMocks.postgresContactStore.recoverContactLifecycleMutations.mockClear();
});

describe('createAgentPersistenceRuntime', () => {
  it('names a required store and its schema mismatch when startup readiness fails', async () => {
    runtimeFactoryMocks.createPostgresMemoryStore.mockRejectedValueOnce(
      new Error('schema version 12 is missing'),
    );

    await expect(createAgentPersistenceRuntime({
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
    })).rejects.toMatchObject({
      name: 'PostgresStoreReadinessError',
      store: 'memory',
      requirement: 'required',
      mismatch: 'schema version 12 is missing',
    });
  });

  it('runs authenticated contact recovery before returning and exposes a stoppable worker', async () => {
    const gateway = { executeContactLifecycle: vi.fn() };
    const runtime = await createAgentPersistenceRuntime({
      config: {
        databasePath: '/tmp/ignored.db',
        persistenceBackend: 'postgres',
        postgresDatabaseUrl: 'postgres://postgres:secret@localhost:5432/psfn',
        postgresSchema: 'companion_x',
        companionId: 'companion-x',
        automataPolicy: loadAutomataPolicySeedDefaults(),
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

  it('rejects a sibling tenant schema before opening any persistence store', async () => {
    await expect(createAgentPersistenceRuntime({
      config: {
        databasePath: '/tmp/ignored.db',
        persistenceBackend: 'postgres',
        postgresDatabaseUrl: 'postgres://postgres:secret@localhost:5432/psfn',
        postgresSchema: 'companion_y',
        postgresRole: 'companion_y_runtime',
        multiCompanion: true,
        companionId: 'companion-x',
        automataPolicy: loadAutomataPolicySeedDefaults(),
        companionFleet: {
          companions: [
            {
              companionId: 'companion-x',
              postgresSchema: 'companion_x',
              postgresRole: 'companion_x_runtime',
            },
            {
              companionId: 'companion-y',
              postgresSchema: 'companion_y',
              postgresRole: 'companion_y_runtime',
            },
          ],
        } as never,
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
    })).rejects.toThrow('does not match the exact companion tenant authority');

    expect(runtimeFactoryMocks.createPostgresPool).not.toHaveBeenCalled();
    expect(runtimeFactoryMocks.createPostgresMemoryStore).not.toHaveBeenCalled();
    expect(runtimeFactoryMocks.createPostgresEpisodicStore).not.toHaveBeenCalled();
    expect(runtimeFactoryMocks.connectPostgresBackgroundWorkStore).not.toHaveBeenCalled();
  });

  it('selects postgres-backed memory, reflections, contacts, and intention stores through the factory', async () => {
    const runtime = await createAgentPersistenceRuntime({
      config: {
        databasePath: '/tmp/ignored.db',
        persistenceBackend: 'postgres',
        postgresDatabaseUrl: 'postgres://postgres:secret@localhost:5432/psfn',
        companionId: 'companion-x',
        automataPolicy: loadAutomataPolicySeedDefaults(),
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
      memoryDeletionProposalStore: runtimeFactoryMocks.postgresMemoryStore.memoryDeletionProposalStore,
      episodicStore: runtimeFactoryMocks.postgresEpisodicStore,
      firstPersonPreservingEpisodicStore: runtimeFactoryMocks.postgresEpisodicStore,
      companionAuthoredEpisodicStore: runtimeFactoryMocks.postgresEpisodicStore,
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
      icpFeltImpulseFunnelStore: expect.any(Object),
      emosimProactivityStateStore: expect.any(Object),
      intentionRuntime: runtimeFactoryMocks.postgresIntentionRuntime as IntentionRuntimeWiring,
      intentionProviders: runtimeFactoryMocks.postgresIntentionRuntime as IntentionRuntimeProviders,
      internalStateStore: runtimeFactoryMocks.postgresInternalStateStore,
      participantTrendStore: runtimeFactoryMocks.postgresParticipantTrendStore,
      scheduledPromptStore: runtimeFactoryMocks.postgresScheduledPromptStore,
      companionAvailabilityStore: runtimeFactoryMocks.postgresCompanionAvailabilityStore,
      backgroundWorkStore: runtimeFactoryMocks.postgresBackgroundWorkStore,
      partnerAffectShadowStore: runtimeFactoryMocks.postgresPartnerAffectShadowStore,
      automataRunStore: runtimeFactoryMocks.postgresAutomataRunStore,
      automataRunRegistry: expect.any(Object),
      automataBusStore: runtimeFactoryMocks.postgresAutomataBusStore,
      automataRetentionStore: expect.any(Object),
      automataSessionClassification: expect.any(Object),
      automataPurgeSagaStore: expect.any(Object),
      introspectionLandmarkStore: expect.any(Object),
      weightedThoughtStore: undefined,
      socialDesireStore: undefined,
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
    expect(runtimeFactoryMocks.connectPostgresCompanionAvailabilityStore).toHaveBeenCalledWith(
      'postgres://postgres:secret@localhost:5432/psfn',
      { schema: undefined, role: undefined },
    );
    expect(runtimeFactoryMocks.connectPostgresBackgroundWorkStore).toHaveBeenCalledWith(
      'postgres://postgres:secret@localhost:5432/psfn',
      { schema: undefined },
    );
    expect(runtimeFactoryMocks.connectPostgresAutomataBusRuntimeStore).toHaveBeenCalledWith(
      'postgres://postgres:secret@localhost:5432/psfn',
      'companion-x',
      expect.any(Object),
      { schema: undefined, role: undefined },
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
    expect(runtimeFactoryMocks.connectPostgresSocialPotStore).not.toHaveBeenCalled();
    expect(runtime.socialPotStore).toBeUndefined();
    expect(runtimeFactoryMocks.connectPostgresSpeakingArbiterStore).not.toHaveBeenCalled();
    expect(runtime.speakingArbiterStore).toBeUndefined();
  });

  it('connects tenant and shared-schema infrastructure for a one-entry fleet', async () => {
    const runtime = await createAgentPersistenceRuntime({
      config: {
        databasePath: '/tmp/ignored.db',
        persistenceBackend: 'postgres',
        postgresDatabaseUrl: 'postgres://postgres:secret@localhost:5432/psfn',
        postgresSchema: 'companion_x',
        postgresRole: 'companion_x_runtime',
        multiCompanion: false,
        companionId: 'companion-x',
        automataPolicy: loadAutomataPolicySeedDefaults(),
        companionFleet: {
          persistenceRoot: '/tmp',
          workspacesRoot: '/tmp/workspaces',
          sharedWorkspacePath: '/tmp/workspaces/shared',
          companions: [
            {
              companionId: 'companion-x',
              postgresSchema: 'companion_x',
              postgresRole: 'companion_x_runtime',
            },
          ],
        } as never,
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
    expect(runtimeFactoryMocks.assertSharedSchemaRuntimeAuthority).toHaveBeenCalledWith(
      'postgres://postgres:secret@localhost:5432/psfn',
      {
        ownSchema: 'companion_x',
        companionSchemas: ['companion_x'],
        modelUsageLedgerSchema: 'companion_x',
      },
    );
    expect(runtimeFactoryMocks.assertPostgresTenantAccessProvisioned).toHaveBeenCalledWith(
      runtimeFactoryMocks.bootstrapPool,
      expect.objectContaining({
        schema: 'companion_x',
        role: 'companion_x_runtime',
        searchPath: 'companion_x,extensions',
      }),
    );
    expect(runtime.companionPresenceStore).toBe(runtimeFactoryMocks.postgresCompanionPresenceStore);
    expect(runtimeFactoryMocks.connectPostgresSocialPotStore).toHaveBeenCalledWith(
      'postgres://postgres:secret@localhost:5432/psfn',
    );
    expect(runtime.socialPotStore).toBe(runtimeFactoryMocks.postgresSocialPotStore);
    expect(runtimeFactoryMocks.connectPostgresSpeakingArbiterStore).toHaveBeenCalledWith(
      'postgres://postgres:secret@localhost:5432/psfn',
    );
    expect(runtime.speakingArbiterStore).toBe(runtimeFactoryMocks.postgresSpeakingArbiterStore);
  });

  it('threads the configured per-companion schema into every store and provisions it up front', async () => {
    await createAgentPersistenceRuntime({
      config: {
        databasePath: '/tmp/ignored.db',
        persistenceBackend: 'postgres',
        postgresDatabaseUrl: 'postgres://postgres:secret@localhost:5432/psfn',
        postgresSchema: 'companion_x',
        companionId: 'companion-x',
        automataPolicy: loadAutomataPolicySeedDefaults(),
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
    expect(runtimeFactoryMocks.connectPostgresCompanionAvailabilityStore).toHaveBeenCalledWith(
      'postgres://postgres:secret@localhost:5432/psfn',
      { schema: 'companion_x', role: undefined },
    );
    expect(runtimeFactoryMocks.connectPostgresBackgroundWorkStore).toHaveBeenCalledWith(
      'postgres://postgres:secret@localhost:5432/psfn',
      { schema: 'companion_x' },
    );
    expect(runtimeFactoryMocks.connectPostgresAutomataBusRuntimeStore).toHaveBeenCalledWith(
      'postgres://postgres:secret@localhost:5432/psfn',
      'companion-x',
      expect.any(Object),
      { schema: 'companion_x', role: undefined },
    );
  });
});
