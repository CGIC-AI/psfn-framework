import { MemoryJournal } from '../faculties/memory/journal.js';
import type { MemoryStorePort } from '../faculties/memory/memory-store-port.js';
import { createPostgresMemoryStore } from '../faculties/memory/postgres-store.js';
import {
  createPostgresEpisodicStore,
  type EpisodicStorePort,
} from '../faculties/memory/episodic/index.js';
import type {
  CompanionAuthoredEpisodicStorePort,
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
import { PostgresCompanionPresenceStore } from './postgres/companion-presence-store.js';
import { PostgresIcpInitiationCandidateStore } from './postgres/icp-initiation-candidate-store.js';
import type { IcpInitiationCandidateStorePort } from '../core/icp/autonomy-store-ports.js';
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

export interface AgentPersistenceRuntime {
  backend: PersistenceBackend;
  memoryStore: MemoryStorePort;
  episodicStore: EpisodicStorePort;
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
  introspectionLandmarkStore: IntrospectionLandmarkPostgresStore;
  backgroundWorkStore: BackgroundWorkStorePort;
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
  const schema = options.config.postgresSchema?.trim() || undefined;
  const tenantRole = options.config.multiCompanion === true
    ? options.config.postgresRole?.trim() || (() => {
        throw new Error('Multi-companion Postgres persistence requires config.postgresRole');
      })()
    : undefined;
  if (schema && options.config.multiCompanion === true) {
    // Deployment provisioning is explicit. Startup only verifies the boundary
    // and refuses to repair/migrate tenant roles, schemas, or extensions.
    const bootstrapPool = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-tenant-boundary-preflight',
      allowExitOnIdle: true,
      max: 1,
    });
    try {
      await assertPostgresTenantAccessProvisioned(
        bootstrapPool,
        planPostgresTenantAccess({ schema, role: tenantRole }),
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
      await ensurePostgresSchemaExists(bootstrapPool, schema);
    } finally {
      await bootstrapPool.end();
    }
  }

  // Shared world schema (sprint 10, W5a). The gateway has already run shared
  // migrations under the dedicated shared owner before exposing its socket.
  // Every agent proves its ordinary credential has exact own-schema + shared
  // DML authority, reciprocal tenant isolation, and zero fleet_auth access
  // before opening a shared store.
  if (options.config.multiCompanion === true) {
    if (!schema || !options.config.companionFleet) {
      throw new Error('Multi-companion shared persistence requires a complete fleet schema identity');
    }
    await assertSharedSchemaRuntimeAuthority(databaseUrl, {
      ownSchema: schema,
      companionSchemas: options.config.companionFleet.companions.map(
        companion => companion.postgresSchema,
      ),
    });
  }
  const companionPresenceStore = options.config.multiCompanion === true
    ? await PostgresCompanionPresenceStore.connect(databaseUrl)
    : undefined;
  const icpInitiationCandidateStore = options.config.multiCompanion === true
    ? await PostgresIcpInitiationCandidateStore.connect(databaseUrl, {
        schema: schema ?? (() => {
          throw new Error('Multi-companion ICP candidates require a companion-local postgresSchema');
        })(),
        role: tenantRole,
      })
    : undefined;
  // Per-companion social pot lives in the shared schema (gateway-owned budget,
  // never a companion-local store). Multi-companion only, like presence above.
  const socialPotStore = options.config.multiCompanion === true
    ? await PostgresSocialPotStore.connect(databaseUrl)
    : undefined;
  // Speaking arbiter state (reservations, egress leases, room-episode pressure)
  // is gateway-owned in the shared schema, exactly like the social pot above.
  const speakingArbiterStore = options.config.multiCompanion === true
    ? await PostgresSpeakingArbiterStore.connect(databaseUrl)
    : undefined;

  const intentionRuntime = await createPostgresIntentionPorts(databaseUrl, {
    schema,
    role: tenantRole,
  });
  const contactStore = await createPostgresContactStore(databaseUrl, options.primaryUserId, {
    exportDir: resolveContactsDir(options.pathSnapshot.companionDataDir),
    schema,
    role: tenantRole,
    ...(options.contactLifecycleGateway
      ? { contactLifecycleGateway: options.contactLifecycleGateway }
      : {}),
  });
  const episodicStore = createPostgresEpisodicStore(databaseUrl, { schema, role: tenantRole });
  const runtime: AgentPersistenceRuntime = {
    backend: 'postgres',
    memoryStore: await createPostgresMemoryStore(databaseUrl, options.embeddingDims, {
      notesDir: resolveNotesDir(options.pathSnapshot.companionDataDir),
      scratchpadMirrorPath: resolveScratchpadMirrorPath(options.pathSnapshot.companionDataDir),
      journal: new MemoryJournal(resolveMemoryJournalPath(options.pathSnapshot.companionDataDir)),
      schema,
      role: tenantRole,
    }),
    episodicStore,
    firstPersonPreservingEpisodicStore: episodicStore,
    companionAuthoredEpisodicStore: episodicStore,
    reflectionStore: new ReflectionMetacognitionJournalStore(
      resolveReflectionMetacognitionJournalPath(options.pathSnapshot.companionDataDir),
      {
        mirror: await PostgresReflectionMetacognitionMirrorStore.connect(databaseUrl, {
          schema,
          role: tenantRole,
        }),
      },
    ),
    contactStore,
    hubIdentityEnrollmentStore: await createPostgresHubIdentityEnrollmentStore(databaseUrl, {
      schema,
      role: tenantRole,
    }),
    intentionRuntime,
    intentionProviders: intentionRuntime,
    weightedThoughtStore: intentionRuntime.weightedThoughtStore,
    socialDesireStore: intentionRuntime.socialDesireStore,
    internalStateStore: await PostgresInternalStateStore.connect(databaseUrl, { schema, role: tenantRole }),
    participantTrendStore: await PostgresParticipantTrendStore.connect(databaseUrl, { schema, role: tenantRole }),
    scheduledPromptStore: await PostgresScheduledPromptStore.connect(databaseUrl, { schema, role: tenantRole }),
    introspectionLandmarkStore: await IntrospectionLandmarkPostgresStore.connect(databaseUrl, { schema, role: tenantRole }),
    backgroundWorkStore: await PostgresBackgroundWorkStore.connect(databaseUrl, { schema, role: tenantRole }),
    partnerAffectShadowStore: await PostgresPartnerAffectShadowStore.connect(databaseUrl, { schema, role: tenantRole }),
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
