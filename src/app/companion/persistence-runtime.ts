// Standalone companion PostgreSQL persistence runtime.
// Connects only the companion-core stores (omitting fleet/arbiter/custody/
// gateway scaffolding and retired letters/doing-mirror surfaces).

import { MemoryJournal } from '../../faculties/memory/journal.js';
import type { MemoryStorePort } from '../../faculties/memory/memory-store-port.js';
import type { MemoryDeletionProposalStorePort } from '../../faculties/memory/deletion-proposals.js';
import { createPostgresMemoryStore } from '../../faculties/memory/postgres-store.js';
import {
  createPostgresEpisodicStore,
  type EpisodicStorePort,
} from '../../faculties/memory/episodic/index.js';
import type {
  CompanionAuthoredEpisodicStorePort,
  EpisodeEmbeddingRuntimeStorePort,
  FirstPersonPreservingEpisodicStorePort,
} from '../../faculties/memory/episodic/store-port.js';
import { createPostgresContactStore } from '../../core/contacts/postgres-adapter.js';
import type { ContactStorePort } from '../../core/contacts/contact-store-port.js';
import { createPostgresIntentionPorts } from '../../core/intention/postgres-adapters.js';
import type {
  IntentionRuntimeProviders,
  IntentionRuntimeWiring,
} from '../../core/intention/runtime-wiring.js';
import type { WeightedThoughtStorePort } from '../../core/intention/weighted-thought-store-port.js';
import type { SocialDesireStorePort } from '../../core/intention/social-desire-store-port.js';
import type {
  PersistenceBackend,
  SubstrateConfig,
} from '../../system/config/runtime-config-contracts.js';
import {
  migrateLegacyPersistenceLayout,
  resolveContactsDir,
  resolveMemoryJournalPath,
  resolveNotesDir,
  resolveReflectionMetacognitionJournalPath,
  resolveScratchpadMirrorPath,
  type RuntimePathSnapshot,
} from '../../persistence/layout.js';
import {
  ReflectionMetacognitionJournalStore,
} from '../../persistence/journals/reflection-metacognition-journal.js';
import { PostgresReflectionMetacognitionMirrorStore } from '../../persistence/reflections/postgres-mirror.js';
import { PostgresInternalStateStore } from '../../persistence/postgres/internal-state-store.js';
import type { InternalStateStorePort } from '../../core/self-model/internal-state-persistence.js';
import { PostgresParticipantTrendStore } from '../../persistence/postgres/participant-trend-store.js';
import type { ParticipantTrendStorePort } from '../../core/emotion/participant-trend-persistence.js';
import { PostgresScheduledPromptStore } from '../../persistence/postgres/scheduled-prompt-store.js';
import { PostgresSchedulerLaneStateStore } from '../../persistence/postgres/scheduler-lane-state-store.js';
import type { RestSilenceStorePort } from '../../core/scheduler/rest-window-policy.js';
import type { WorldExplorationStatePort } from '../../core/scheduler/world-exploration-state.js';
import type { ScheduledPromptStorePort } from '../../core/scheduler/scheduled-prompt-store-port.js';
import { PostgresCompanionAvailabilityStore } from '../../persistence/postgres/companion-availability-store.js';
import type { CompanionAvailabilityStorePort } from '../../core/agent/companion-availability.js';
import { PostgresIcpFeltImpulseFunnelStore } from '../../persistence/postgres/icp-felt-impulse-funnel-store.js';
import type { IcpFeltImpulseFunnelStorePort } from '../../core/icp/felt-impulse-funnel.js';
import { PostgresEmoSimProactivityStateStore } from '../../persistence/postgres/emosim-proactivity-state-store.js';
import type { EmoSimProactivityStateStorePort } from '../../core/emotion/emosim-proactivity-port.js';
import { PostgresSocialImpulseOutreachStore } from '../../persistence/postgres/social-impulse-outreach-store.js';
import type { SocialImpulseOutreachStorePort } from '../../core/emotion/social-impulse-outreach.js';
import { createPostgresPool, ensurePostgresSchemaExists } from '../../persistence/postgres.js';
import { IntrospectionLandmarkPostgresStore } from '../../faculties/introspection/postgres-store.js';
import { PostgresBackgroundWorkStore } from '../../persistence/postgres/background-work-store.js';
import type { BackgroundWorkStorePort } from '../../core/agent/background-work/store-port.js';
import type { ContactLifecycleGatewayPort } from '../../core/contacts/contact-lifecycle-gateway-port.js';
import { ContactLifecycleRecoveryRuntime } from '../../core/contacts/contact-lifecycle-recovery-runtime.js';
import { awaitPostgresStoreReadiness } from '../../persistence/postgres/runtime-readiness.js';
import { PostgresAutomataRunStore } from '../../persistence/postgres/automata-run-store.js';
import { AutomataRunRegistry } from '../../faculties/automata/run-registry.js';
import { createBackgroundWorkRunRedeliveryOracle } from '../../core/agent/background-work/automata-run-redelivery.js';
import {
  connectPostgresAutomataBusRuntimeStore,
  type PostgresAutomataBusRuntimeStore,
} from '../../faculties/automata/bus/runtime-store.js';
import { PostgresAutomataRetentionStore } from '../../faculties/automata/retention-postgres-store.js';
import { AutomataSessionClassificationService } from '../../faculties/automata/session-classification.js';
import { PostgresExactSessionPurgeSagaStore } from '../../persistence/postgres/automata-exact-session-purge-store.js';
import { resolveConfigTenantPoolScope } from '../../persistence/postgres/tenant-pool-scope.js';

export interface CompanionPersistenceRuntime {
  backend: PersistenceBackend;
  memoryStore: MemoryStorePort;
  memoryDeletionProposalStore: MemoryDeletionProposalStorePort;
  episodicStore: EpisodicStorePort & EpisodeEmbeddingRuntimeStorePort;
  firstPersonPreservingEpisodicStore: EpisodicStorePort & FirstPersonPreservingEpisodicStorePort;
  companionAuthoredEpisodicStore: CompanionAuthoredEpisodicStorePort;
  reflectionStore: ReflectionMetacognitionJournalStore;
  contactStore?: ContactStorePort;
  intentionRuntime?: IntentionRuntimeWiring;
  intentionProviders?: IntentionRuntimeProviders;
  weightedThoughtStore?: WeightedThoughtStorePort;
  socialDesireStore?: SocialDesireStorePort;
  internalStateStore: InternalStateStorePort;
  participantTrendStore: ParticipantTrendStorePort;
  scheduledPromptStore: ScheduledPromptStorePort;
  schedulerLaneStateStore: RestSilenceStorePort & WorldExplorationStatePort;
  companionAvailabilityStore: CompanionAvailabilityStorePort & { close(): Promise<void> };
  introspectionLandmarkStore: IntrospectionLandmarkPostgresStore;
  backgroundWorkStore: BackgroundWorkStorePort;
  automataRunRegistry: AutomataRunRegistry;
  automataRunStore: PostgresAutomataRunStore;
  automataBusStore: PostgresAutomataBusRuntimeStore;
  automataRetentionStore: PostgresAutomataRetentionStore;
  automataSessionClassification: AutomataSessionClassificationService;
  automataPurgeSagaStore: PostgresExactSessionPurgeSagaStore;
  icpFeltImpulseFunnelStore: IcpFeltImpulseFunnelStorePort;
  emosimProactivityStateStore: EmoSimProactivityStateStorePort & { close(): Promise<void> };
  socialImpulseOutreachStore: SocialImpulseOutreachStorePort
    & Pick<PostgresSocialImpulseOutreachStore, 'getHealthSummary'>
    & { close(): Promise<void> };
  contactLifecycleRecovery?: ContactLifecycleRecoveryRuntime;
}

export interface CreateCompanionPersistenceRuntimeOptions {
  config: Pick<
    SubstrateConfig,
    | 'databasePath'
    | 'persistenceBackend'
    | 'postgresDatabaseUrl'
    | 'postgresSchema'
    | 'postgresRole'
    | 'multiCompanion'
    | 'memoryDeletionPolicy'
    | 'companionId'
    | 'automataPolicy'
    | 'observerEvalSidecar'
  >;
  pathSnapshot: RuntimePathSnapshot;
  embeddingDims: number;
  primaryUserId?: string;
  contactLifecycleGateway?: ContactLifecycleGatewayPort;
  onContactLifecycleRecoveryFailure?: (error: unknown) => void;
}

export async function createCompanionPersistenceRuntime(
  options: CreateCompanionPersistenceRuntimeOptions,
): Promise<CompanionPersistenceRuntime> {
  migrateLegacyPersistenceLayout(options.pathSnapshot.companionDataDir);

  if (options.config.persistenceBackend !== 'postgres') {
    throw new Error('Companion persistence runtime requires config.persistenceBackend=postgres');
  }
  const databaseUrl = options.config.postgresDatabaseUrl?.trim();
  if (!databaseUrl) {
    throw new Error('PostgreSQL persistence requires config.postgresDatabaseUrl');
  }

  const tenantScope = resolveConfigTenantPoolScope(options.config);
  const schema = tenantScope?.schema ?? (options.config.postgresSchema?.trim() || undefined);
  const tenantRole = tenantScope?.role;
  if (schema) {
    const bootstrapPool = createPostgresPool(databaseUrl, {
      applicationName: 'companion-schema-bootstrap',
      allowExitOnIdle: true,
      max: 1,
      schema,
    });
    try {
      await awaitPostgresStoreReadiness(
        'tenant_boundary',
        () => ensurePostgresSchemaExists(bootstrapPool, schema),
      );
    } finally {
      await bootstrapPool.end();
    }
  }

  const icpFeltImpulseFunnelStore = await awaitPostgresStoreReadiness(
    'icp_felt_impulse_funnel',
    () => PostgresIcpFeltImpulseFunnelStore.connect(databaseUrl, {
      schema,
      role: tenantRole,
    }),
  );
  const emosimProactivityStateStore = await awaitPostgresStoreReadiness(
    'emosim_proactivity_state',
    () => PostgresEmoSimProactivityStateStore.connect(databaseUrl, {
      schema,
      role: tenantRole,
      legacySidecarId: options.config.observerEvalSidecar?.sidecarId,
    }),
  );
  const socialImpulseOutreachStore = await awaitPostgresStoreReadiness(
    'social_impulse_outreach',
    () => PostgresSocialImpulseOutreachStore.connect(databaseUrl, {
      schema,
      role: tenantRole,
    }),
  );

  const intentionRuntime = await awaitPostgresStoreReadiness(
    'intention',
    () => createPostgresIntentionPorts(databaseUrl, { schema, role: tenantRole }),
  );
  const contactStore = await awaitPostgresStoreReadiness(
    'contacts',
    () => createPostgresContactStore(databaseUrl, options.primaryUserId, {
      exportDir: resolveContactsDir(options.pathSnapshot.companionDataDir),
      schema,
      role: tenantRole,
      ...(options.contactLifecycleGateway
        ? { contactLifecycleGateway: options.contactLifecycleGateway }
        : {}),
    }),
  );
  const episodicStore = createPostgresEpisodicStore(databaseUrl, { schema, role: tenantRole });
  const memoryStore = await awaitPostgresStoreReadiness(
    'memory',
    () => createPostgresMemoryStore(databaseUrl, options.embeddingDims, {
      notesDir: resolveNotesDir(options.pathSnapshot.companionDataDir),
      scratchpadMirrorPath: resolveScratchpadMirrorPath(options.pathSnapshot.companionDataDir),
      journal: new MemoryJournal(resolveMemoryJournalPath(options.pathSnapshot.companionDataDir)),
      schema,
      role: tenantRole,
      memoryDeletionPolicy: () => options.config.memoryDeletionPolicy,
    }),
  );
  const reflectionMirror = await awaitPostgresStoreReadiness(
    'reflection',
    () => PostgresReflectionMetacognitionMirrorStore.connect(databaseUrl, {
      schema,
      role: tenantRole,
    }),
  );
  const companionId = options.config.companionId?.trim();
  if (!companionId) throw new Error('Automata run persistence requires config.companionId');
  if (!options.config.automataPolicy) throw new Error('Automata run persistence requires automata-policy.json');
  const automataRunStore = await awaitPostgresStoreReadiness(
    'automata_runs',
    () => PostgresAutomataRunStore.connect(databaseUrl, companionId, { schema, role: tenantRole }),
  );
  const backgroundWorkStore = await awaitPostgresStoreReadiness(
    'background_work',
    () => PostgresBackgroundWorkStore.connect(databaseUrl, { schema, role: tenantRole }),
  );
  const automataRunRegistry = await AutomataRunRegistry.hydrate({
    companionId,
    policy: options.config.automataPolicy,
    store: automataRunStore,
    redelivery: createBackgroundWorkRunRedeliveryOracle(backgroundWorkStore),
  });
  const automataBusStore = await awaitPostgresStoreReadiness(
    'automata_bus',
    () => connectPostgresAutomataBusRuntimeStore(
      databaseUrl,
      companionId,
      automataRunRegistry,
      { schema, role: tenantRole },
    ),
  );
  const automataRetentionStore = await awaitPostgresStoreReadiness(
    'automata_retention',
    async () => new PostgresAutomataRetentionStore(automataBusStore.getQueryPool()),
  );
  const automataSessionClassification = new AutomataSessionClassificationService(
    { rawSessionRetentionMs: options.config.automataPolicy.rawSessionRetentionMs },
    automataRetentionStore,
  );
  const automataPurgeSagaStore = new PostgresExactSessionPurgeSagaStore(
    automataBusStore.getQueryPool(),
    companionId,
  );
  const runtime: CompanionPersistenceRuntime = {
    backend: 'postgres',
    memoryStore,
    memoryDeletionProposalStore: memoryStore.memoryDeletionProposalStore,
    episodicStore,
    firstPersonPreservingEpisodicStore: episodicStore,
    companionAuthoredEpisodicStore: episodicStore,
    reflectionStore: new ReflectionMetacognitionJournalStore(
      resolveReflectionMetacognitionJournalPath(options.pathSnapshot.companionDataDir),
      { mirror: reflectionMirror },
    ),
    contactStore,
    intentionRuntime,
    intentionProviders: intentionRuntime,
    weightedThoughtStore: intentionRuntime.weightedThoughtStore,
    socialDesireStore: intentionRuntime.socialDesireStore,
    internalStateStore: await awaitPostgresStoreReadiness(
      'internal_state',
      () => PostgresInternalStateStore.connect(databaseUrl, { schema, role: tenantRole }),
    ),
    participantTrendStore: await awaitPostgresStoreReadiness(
      'participant_trend',
      () => PostgresParticipantTrendStore.connect(databaseUrl, { schema, role: tenantRole }),
    ),
    scheduledPromptStore: await awaitPostgresStoreReadiness(
      'scheduled_prompts',
      () => PostgresScheduledPromptStore.connect(databaseUrl, { schema, role: tenantRole }),
    ),
    schedulerLaneStateStore: await awaitPostgresStoreReadiness(
      'scheduler_lane_state',
      () => PostgresSchedulerLaneStateStore.connect(databaseUrl, { schema, role: tenantRole }),
    ),
    companionAvailabilityStore: await awaitPostgresStoreReadiness(
      'companion_availability',
      () => PostgresCompanionAvailabilityStore.connect(databaseUrl, { schema, role: tenantRole }),
    ),
    introspectionLandmarkStore: await awaitPostgresStoreReadiness(
      'introspection',
      () => IntrospectionLandmarkPostgresStore.connect(databaseUrl, { schema, role: tenantRole }),
    ),
    backgroundWorkStore,
    automataRunRegistry,
    automataRunStore,
    automataBusStore,
    automataRetentionStore,
    automataSessionClassification,
    automataPurgeSagaStore,
    icpFeltImpulseFunnelStore,
    emosimProactivityStateStore,
    socialImpulseOutreachStore,
  };
  if (!options.contactLifecycleGateway) return runtime;
  const contactLifecycleRecovery = new ContactLifecycleRecoveryRuntime({
    store: contactStore,
    ...(options.onContactLifecycleRecoveryFailure
      ? { onFailure: options.onContactLifecycleRecoveryFailure }
      : {}),
  });
  await contactLifecycleRecovery.recoverBeforeExposure();
  contactLifecycleRecovery.start();
  return { ...runtime, contactLifecycleRecovery };
}
