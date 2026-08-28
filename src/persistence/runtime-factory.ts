import { MemoryJournal } from '../faculties/memory/journal.js';
import type { MemoryStorePort } from '../faculties/memory/memory-store-port.js';
import type { MemoryDeletionProposalStorePort } from '../faculties/memory/deletion-proposals.js';
import { createPostgresMemoryStore } from '../faculties/memory/postgres-store.js';
import {
  createPostgresEpisodicStore,
  type EpisodicStorePort,
} from '../faculties/memory/episodic/index.js';
import type {
  CompanionAuthoredEpisodicStorePort,
  EpisodeEmbeddingRuntimeStorePort,
  FirstPersonPreservingEpisodicStorePort,
} from '../faculties/memory/episodic/store-port.js';
import { createPostgresContactStore } from '../core/contacts/postgres-adapter.js';
import type { ContactStorePort } from '../core/contacts/contact-store-port.js';
import { createPostgresHubIdentityEnrollmentStore } from '../core/enrollment/store.js';
import type { HubIdentityEnrollmentStorePort } from '../core/enrollment/enrollment-store-port.js';
import { createPostgresIntentionPorts } from '../core/intention/postgres-adapters.js';
import type {
  IntentionRuntimeProviders,
  IntentionRuntimeWiring,
} from '../core/intention/runtime-wiring.js';
import type { WeightedThoughtStorePort } from '../core/intention/weighted-thought-store-port.js';
import type { SocialDesireStorePort } from '../core/intention/social-desire-store-port.js';
import type {
  PersistenceBackend,
  SubstrateConfig,
} from '../system/config/runtime-config-contracts.js';
import {
  migrateLegacyPersistenceLayout,
  resolveContactsDir,
  resolveMemoryJournalPath,
  resolveNotesDir,
  resolveReflectionMetacognitionJournalPath,
  resolveScratchpadMirrorPath,
  type RuntimePathSnapshot,
} from './layout.js';
import {
  ReflectionMetacognitionJournalStore,
} from './journals/reflection-metacognition-journal.js';
import { PostgresReflectionMetacognitionMirrorStore } from './reflections/postgres-mirror.js';
import { PostgresInternalStateStore } from './postgres/internal-state-store.js';
import type { InternalStateStorePort } from '../core/self-model/internal-state-persistence.js';
import { PostgresParticipantTrendStore } from './postgres/participant-trend-store.js';
import type { ParticipantTrendStorePort } from '../core/emotion/participant-trend-persistence.js';
import { PostgresScheduledPromptStore } from './postgres/scheduled-prompt-store.js';
import type { ScheduledPromptStorePort } from '../core/scheduler/scheduled-prompt-store-port.js';
import { PostgresCompanionAvailabilityStore } from './postgres/companion-availability-store.js';
import type { CompanionAvailabilityStorePort } from '../core/agent/companion-availability.js';
import { PostgresCompanionPresenceStore } from './postgres/companion-presence-store.js';
import { PostgresIcpInitiationCandidateStore } from './postgres/icp-initiation-candidate-store.js';
import type { IcpInitiationCandidateStorePort } from '../core/icp/autonomy-store-ports.js';
import { PostgresIcpFeltImpulseFunnelStore } from './postgres/icp-felt-impulse-funnel-store.js';
import type { IcpFeltImpulseFunnelStorePort } from '../core/icp/felt-impulse-funnel.js';
import { PostgresEmoSimProactivityStateStore } from './postgres/emosim-proactivity-state-store.js';
import type { EmoSimProactivityStateStorePort } from '../core/emotion/emosim-proactivity-port.js';
import { PostgresSocialImpulseOutreachStore } from './postgres/social-impulse-outreach-store.js';
import type { SocialImpulseOutreachStorePort } from '../core/emotion/social-impulse-outreach.js';
import type { CompanionPresenceStorePort } from '../core/agent/companion-presence-store-port.js';
import { PostgresSocialPotStore } from './postgres/social-pot-store.js';
import type { SocialPotPort } from '../core/agent/fatigue/social-pot.js';
import { PostgresSpeakingArbiterStore } from './postgres/speaking-arbiter-store.js';
import type { SpeakingArbiterStorePort } from '../core/agent/arbiter/speaking-arbiter-store-port.js';
import { createPostgresPool, ensurePostgresSchemaExists } from './postgres.js';
import {
  assertPostgresTenantAccessProvisioned,
  planPostgresTenantAccess,
} from './postgres/tenancy.js';
import { IntrospectionLandmarkPostgresStore } from '../faculties/introspection/postgres-store.js';
import { assertSharedSchemaRuntimeAuthority } from './postgres/shared-schema.js';
import { PostgresPartnerAffectShadowStore } from './postgres/partner-affect-shadow-store.js';
import type { PartnerAffectShadowStorePort } from '../core/emotion/partner-affect/shadow-store-port.js';
import { PostgresBackgroundWorkStore } from './postgres/background-work-store.js';
import type { BackgroundWorkStorePort } from '../core/agent/background-work/store-port.js';
import type { ContactLifecycleGatewayPort } from '../core/contacts/contact-lifecycle-gateway-port.js';
import { ContactLifecycleRecoveryRuntime } from '../core/contacts/contact-lifecycle-recovery-runtime.js';
import { awaitPostgresStoreReadiness } from './postgres/runtime-readiness.js';
import { PostgresAutomataRunStore } from './postgres/automata-run-store.js';
import { AutomataRunRegistry } from '../faculties/automata/run-registry.js';
import {
  connectPostgresAutomataBusRuntimeStore,
  type PostgresAutomataBusRuntimeStore,
} from '../faculties/automata/bus/runtime-store.js';
import { PostgresAutomataRetentionStore } from '../faculties/automata/retention-postgres-store.js';
import { AutomataSessionClassificationService } from '../faculties/automata/session-classification.js';
import { PostgresExactSessionPurgeSagaStore } from './postgres/automata-exact-session-purge-store.js';
import { resolveConfigTenantPoolScope } from './postgres/tenant-pool-scope.js';

export interface AgentPersistenceRuntime {
  backend: PersistenceBackend;
  memoryStore: MemoryStorePort;
  /** Postgres-only durable deletion proposal and linked audit authority. */
  memoryDeletionProposalStore: MemoryDeletionProposalStorePort;
  episodicStore: EpisodicStorePort & EpisodeEmbeddingRuntimeStorePort;
  /** Consolidation-only capability for source-proven first-person preservation. */
  firstPersonPreservingEpisodicStore: EpisodicStorePort & FirstPersonPreservingEpisodicStorePort;
  /** Narrow capability for the companion's own first-person affect/meaning writes. */
  companionAuthoredEpisodicStore: CompanionAuthoredEpisodicStorePort;
  reflectionStore: ReflectionMetacognitionJournalStore;
  contactStore?: ContactStorePort;
  /**
   * Hub identity ↔ contact enrollment binding store (Sprint 10 D2a). Biometric
   * compute/templates stay at the Satellite Hub; this store holds only the
   * opaque handle → contact binding. Consumed by the presence resolution path
   * (bead .13) and the Garden enrollment surface (bead .17).
   */
  hubIdentityEnrollmentStore?: HubIdentityEnrollmentStorePort;
  intentionRuntime?: IntentionRuntimeWiring;
  intentionProviders?: IntentionRuntimeProviders;
  weightedThoughtStore?: WeightedThoughtStorePort;
  /** Per-contact durable social desire store (bead oth4.1); Postgres-backed, hydrated at startup. */
  socialDesireStore?: SocialDesireStorePort;
  internalStateStore: InternalStateStorePort;
  participantTrendStore: ParticipantTrendStorePort;
  scheduledPromptStore: ScheduledPromptStorePort;
  companionAvailabilityStore: CompanionAvailabilityStorePort & { close(): Promise<void> };
  introspectionLandmarkStore: IntrospectionLandmarkPostgresStore;
  backgroundWorkStore: BackgroundWorkStorePort;
  automataRunRegistry: AutomataRunRegistry;
  /** Exact durable run authority retained beyond the bounded registry discovery view. */
  automataRunStore: PostgresAutomataRunStore;
  /** Companion-locked canonical Automata Bus store; derived search indexes are not authority. */
  automataBusStore: PostgresAutomataBusRuntimeStore;
  automataRetentionStore: PostgresAutomataRetentionStore;
  automataSessionClassification: AutomataSessionClassificationService;
  automataPurgeSagaStore: PostgresExactSessionPurgeSagaStore;
  /**
   * Shadow-only Partner Affect observation store (docs/partner-affect.md
   * slice 1). Written by the shadow ingest bridge; read only by the Garden
   * inspection surface. Never behavioral authority.
   */
  partnerAffectShadowStore: PartnerAffectShadowStorePort;
  /**
   * Shared-schema cross-companion presence store (sprint 10, W5a). Present
   * ONLY when multi-companion mode is enabled; flag-off never touches the
   * shared schema.
   */
  companionPresenceStore?: CompanionPresenceStorePort;
  /** Companion-private durable ICP motivation; multi-companion only. */
  icpInitiationCandidateStore?: IcpInitiationCandidateStorePort;
  /** Content-free exactly-once provenance for qualified felt-impulse fires. */
  icpFeltImpulseFunnelStore: IcpFeltImpulseFunnelStorePort;
  /** Companion-local production cursor; never stored in eval telemetry rows. */
  emosimProactivityStateStore: EmoSimProactivityStateStorePort & { close(): Promise<void> };
  /** One companion's durable content-free social-impulse disposition ledger. */
  socialImpulseOutreachStore: SocialImpulseOutreachStorePort & { close(): Promise<void> };
  /**
   * Gateway-owned per-companion social pot (shared schema). The durable
   * authority for the fatigue-economy budget that funds group participation and
   * ICP continuation; draw-cap/ICP-priority policy is applied via
   * `enforceSocialPotDraw`. Present ONLY in multi-companion mode; flag-off never
   * touches the shared schema.
   */
  socialPotStore?: SocialPotPort;
  /**
   * Gateway-owned speaking-arbiter store (shared schema): the durable substrate
   * for the two-phase reservation → egress-lease protocol and per-channel
   * room-episode pressure (design bible §8.5, §12.2). Consumed by the arbiter
   * service and egress-lease grant path. Present ONLY in multi-companion mode;
   * flag-off never touches the shared schema.
   */
  speakingArbiterStore?: SpeakingArbiterStorePort;
  /** Leased contact-authority recovery, started before the factory returns. */
  contactLifecycleRecovery?: ContactLifecycleRecoveryRuntime;
}

export interface CreateAgentPersistenceRuntimeOptions {
  config: Pick<
    SubstrateConfig,
    | 'databasePath'
    | 'persistenceBackend'
    | 'postgresDatabaseUrl'
    | 'postgresSchema'
    | 'postgresRole'
    | 'multiCompanion'
    | 'companionFleet'
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

export async function createAgentPersistenceRuntime(
  options: CreateAgentPersistenceRuntimeOptions,
): Promise<AgentPersistenceRuntime> {
  migrateLegacyPersistenceLayout(options.pathSnapshot.companionDataDir);

  if (options.config.persistenceBackend !== 'postgres') {
    throw new Error('Agent persistence runtime requires config.persistenceBackend=postgres');
  }
  const databaseUrl = options.config.postgresDatabaseUrl?.trim();
  if (!databaseUrl) {
    throw new Error('PostgreSQL persistence requires config.postgresDatabaseUrl');
  }

  // Multi-companion tenancy (sprint 10, W2). When a per-companion schema is
  // configured, every runtime persistence pool below pins its role and
  // search_path to the explicitly provisioned tenant boundary. Startup checks
  // that boundary but never creates or repairs it. When unset, `schema` stays
  // undefined and behavior is byte-identical to single-companion public mode.
  const tenantScope = resolveConfigTenantPoolScope(options.config);
  const schema = tenantScope?.schema ?? (options.config.postgresSchema?.trim() || undefined);
  const tenantRole = tenantScope?.role;
  const fleetTenancy = options.config.companionFleet !== undefined;
  if (schema && fleetTenancy) {
    // Deployment provisioning is explicit. Startup only verifies the boundary
    // and refuses to repair/migrate tenant roles, schemas, or extensions.
    const bootstrapPool = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-tenant-boundary-preflight',
      allowExitOnIdle: true,
      max: 1,
    });
    try {
      await awaitPostgresStoreReadiness(
        'tenant_boundary',
        () => assertPostgresTenantAccessProvisioned(
          bootstrapPool,
          planPostgresTenantAccess({ schema, role: tenantRole }),
        ),
      );
    } finally {
      await bootstrapPool.end();
    }
  } else if (schema) {
    const bootstrapPool = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-schema-bootstrap',
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

  // Shared world schema (sprint 10, W5a). The gateway has already run shared
  // migrations under the dedicated shared owner before exposing its socket.
  // Every agent proves its ordinary credential has exact own-schema + shared
  // DML authority, reciprocal tenant isolation, and zero fleet_auth access
  // before opening a shared store.
  if (fleetTenancy) {
    const companionFleet = options.config.companionFleet;
    const modelUsagePrimary = companionFleet?.companions.at(0);
    if (!schema || !companionFleet || !modelUsagePrimary) {
      throw new Error('Fleet shared persistence requires a complete fleet schema identity');
    }
    await awaitPostgresStoreReadiness(
      'shared_runtime_authority',
      () => assertSharedSchemaRuntimeAuthority(databaseUrl, {
        ownSchema: schema,
        companionSchemas: companionFleet.companions.map(
          companion => companion.postgresSchema,
        ),
        modelUsageLedgerSchema: modelUsagePrimary.postgresSchema,
      }),
    );
  }
  const companionPresenceStore = fleetTenancy
    ? await awaitPostgresStoreReadiness(
        'companion_presence',
        () => PostgresCompanionPresenceStore.connect(databaseUrl),
      )
    : undefined;
  const icpInitiationCandidateStore = fleetTenancy
    ? await awaitPostgresStoreReadiness(
        'icp_initiation_candidates',
        () => PostgresIcpInitiationCandidateStore.connect(databaseUrl, {
          schema: schema ?? (() => {
            throw new Error('Multi-companion ICP candidates require a companion-local postgresSchema');
          })(),
          role: tenantRole,
        }),
      )
    : undefined;
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
  // Per-companion social pot lives in the shared schema (gateway-owned budget,
  // never a companion-local store). Multi-companion only, like presence above.
  const socialPotStore = fleetTenancy
    ? await awaitPostgresStoreReadiness(
        'social_pot',
        () => PostgresSocialPotStore.connect(databaseUrl),
      )
    : undefined;
  // Speaking arbiter state (reservations, egress leases, room-episode pressure)
  // is gateway-owned in the shared schema, exactly like the social pot above.
  const speakingArbiterStore = fleetTenancy
    ? await awaitPostgresStoreReadiness(
        'speaking_arbiter',
        () => PostgresSpeakingArbiterStore.connect(databaseUrl),
      )
    : undefined;

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
  const automataRunRegistry = await AutomataRunRegistry.hydrate({
    companionId,
    policy: options.config.automataPolicy,
    store: automataRunStore,
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
  const runtime: AgentPersistenceRuntime = {
    backend: 'postgres',
    memoryStore,
    memoryDeletionProposalStore: memoryStore.memoryDeletionProposalStore,
    episodicStore,
    firstPersonPreservingEpisodicStore: episodicStore,
    companionAuthoredEpisodicStore: episodicStore,
    reflectionStore: new ReflectionMetacognitionJournalStore(
      resolveReflectionMetacognitionJournalPath(options.pathSnapshot.companionDataDir),
      {
        mirror: reflectionMirror,
      },
    ),
    contactStore,
    hubIdentityEnrollmentStore: await awaitPostgresStoreReadiness(
      'hub_identity_enrollment',
      () => createPostgresHubIdentityEnrollmentStore(databaseUrl, { schema, role: tenantRole }),
    ),
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
    companionAvailabilityStore: await awaitPostgresStoreReadiness(
      'companion_availability',
      () => PostgresCompanionAvailabilityStore.connect(databaseUrl, { schema, role: tenantRole }),
    ),
    introspectionLandmarkStore: await awaitPostgresStoreReadiness(
      'introspection',
      () => IntrospectionLandmarkPostgresStore.connect(databaseUrl, { schema, role: tenantRole }),
    ),
    backgroundWorkStore: await awaitPostgresStoreReadiness(
      'background_work',
      () => PostgresBackgroundWorkStore.connect(databaseUrl, { schema, role: tenantRole }),
    ),
    automataRunRegistry,
    automataRunStore,
    automataBusStore,
    automataRetentionStore,
    automataSessionClassification,
    automataPurgeSagaStore,
    partnerAffectShadowStore: await awaitPostgresStoreReadiness(
      'partner_affect_shadow',
      () => PostgresPartnerAffectShadowStore.connect(databaseUrl, { schema, role: tenantRole }),
    ),
    icpFeltImpulseFunnelStore,
    emosimProactivityStateStore,
    socialImpulseOutreachStore,
    ...(companionPresenceStore ? { companionPresenceStore } : {}),
    ...(icpInitiationCandidateStore ? { icpInitiationCandidateStore } : {}),
    ...(socialPotStore ? { socialPotStore } : {}),
    ...(speakingArbiterStore ? { speakingArbiterStore } : {}),
  };
  if (!options.contactLifecycleGateway) return runtime;
  const contactLifecycleRecovery = new ContactLifecycleRecoveryRuntime({
    store: contactStore,
    ...(options.onContactLifecycleRecoveryFailure
      ? { onFailure: options.onContactLifecycleRecoveryFailure }
      : {}),
  });
  // This is deliberately awaited before returning: callers cannot register
  // contact tools, RPC callbacks, or Garden/admin surfaces first.
  await contactLifecycleRecovery.recoverBeforeExposure();
  contactLifecycleRecovery.start();
  return { ...runtime, contactLifecycleRecovery };
}
