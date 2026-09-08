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
import { PostgresRoomParticipationLeaseStore } from './postgres/room-participation-lease-store.js';
import type { SpeakingArbiterStorePort } from '../core/agent/arbiter/speaking-arbiter-store-port.js';
import type { RoomParticipationLeaseStorePort } from '../core/participation/room-participation-lease.js';
import { createPostgresPool, ensurePostgresSchemaExists } from './postgres.js';
import {
  assertPostgresTenantAccessProvisioned,
  planPostgresTenantAccess,
} from './postgres/tenancy.js';
import { IntrospectionLandmarkPostgresStore } from '../faculties/introspection/postgres-store.js';
import { assertSharedSchemaRuntimeAuthority } from './postgres/shared-schema.js';
import { PostgresPartnerAffectShadowStore } from './postgres/partner-affect-shadow-store.js';
import { PostgresHealthEventStore } from './postgres/health-event-store.js';
import {
  PostgresHumanEscalationStore,
  type HumanEscalationLedgerSaturationReporter,
} from './postgres/human-escalation-store.js';
import type { HumanEscalationLedgerBounds } from '../shared/escalation/contracts.js';
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
import {
  createFleetMaintenanceCoordinator,
  type FleetMaintenanceCoordinator,
} from '../core/scheduler/fleet-maintenance-coordinator.js';
import { PostgresFleetMaintenanceStore } from './postgres/fleet-maintenance-store.js';
import { PostgresLetterStore } from './postgres/letter-store.js';
import { PostgresCogSecReceiptStore } from './postgres/cogsec-receipt-store.js';
import type { CogSecReceiptStorePort } from '../core/cogsec/receipts/contracts.js';
import { PostgresCustodySnapshotStore } from './postgres/custody-snapshot-store.js';
import type { CustodySnapshotStorePort } from '../core/cogsec/disclosure/custody-snapshot.js';
import { PostgresCustodyChainReader } from './postgres/custody-chain-reader.js';
import { PostgresEgressDeliveryRecordStore } from './postgres/egress-delivery-record-store.js';
import type { EgressDeliveryRecordStorePort } from '../core/cogsec/disclosure/egress-delivery-record.js';
import type { LetterStorePort } from '../core/letters/contracts.js';
import { PostgresDoingMirrorStore } from './postgres/doing-mirror-store.js';
import type { DoingMirrorStorePort } from '../core/doing-mirror/contracts.js';

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
  /** Companion-private durable asynchronous correspondence bin. */
  letterStore: LetterStorePort;
  /** Companion-private outcome mirror with durable partner-Letter delivery metadata. */
  doingMirrorStore: DoingMirrorStorePort;
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
   * Durable content-addressed CogSec admission receipts
   * (psfn-framework-1fjvm.3). Written by intake screening when it admits fully
   * screened bytes; read by admission consumers deciding whether byte-identical
   * durable content may skip re-screening.
   */
  cogSecReceiptStore: CogSecReceiptStorePort;
  /**
   * Durable per-turn CogSec custody snapshots (psfn-framework-ccgdz.1). Written
   * record-first by the turn runtime once the generation's disclosure lineage
   * is folded and before the reply is composed; read by custody/provenance
   * queries. Content-free by contract, retention bound owned by settings.json.
   */
  custodySnapshotStore: CustodySnapshotStorePort;
  /**
   * Durable egress delivery records (psfn-framework-ccgdz.6). Written on every
   * social, tool, and artifact egress, binding the delivered bytes' digest to
   * the turn, its custody snapshot, the resolved disclosure destination, and
   * the decision outcome. Shares the custody snapshots' retention horizon so a
   * delivery never outlives the proof it cites. Content-free by contract.
   */
  egressDeliveryRecordStore: EgressDeliveryRecordStorePort;
  /**
   * Read side of the custody chain (psfn-framework-ccgdz.7), behind the Garden
   * provenance surface. It lives here rather than being opened by the admin
   * surface so it pins the SAME tenant schema and role the two writer stores
   * above pin: a reader on `public` while the turn writes to a companion
   * schema would report every real chain as absent, which is the one answer an
   * audit surface must never give wrongly.
   */
  custodyChainReader: PostgresCustodyChainReader;
  /**
   * Bounded runtime health-event stream (bead psfn-framework-7qeo1.24.1).
   * Written by the bus sink that drains `runtime.health.event`; read by
   * detectors and the Garden incident timeline. Content-free by contract.
   */
  healthEventStore: PostgresHealthEventStore;
  /** Durable ledger behind the human escalation control plane (bznbn). */
  humanEscalationStore: PostgresHumanEscalationStore;
  /**
   * The fleet's SYSTEM-owned health stream and escalation ledger, in the shared
   * schema (bead psfn-framework-e5r0s). Present ONLY in fleet mode, where the
   * gateway persists into a pool scope this process cannot otherwise read; in a
   * single-companion deployment the two stores above already resolve to the
   * table the gateway writes, so these are absent rather than duplicated.
   *
   * Read by the Garden incident timeline and attention surface. The escalation
   * ledger is also WRITTEN by them, and only there: a companion must be able to
   * answer a fault the gateway saw, or the one place a human resolves things is
   * read-only for exactly the faults nobody else can see.
   */
  fleetSystemHealthEventStore?: PostgresHealthEventStore;
  fleetSystemHumanEscalationStore?: PostgresHumanEscalationStore;
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
  /**
   * Gateway-owned bounded room-participation leases (shared schema, jp36.5.5):
   * one companion's durable membership in one verified group room, carrying the
   * context watermark that keeps a restart from replaying old room chatter into
   * consideration. Present ONLY in multi-companion mode, exactly like the
   * arbiter store it sits beside.
   */
  roomParticipationLeaseStore?: RoomParticipationLeaseStorePort;
  /**
   * System-scoped heavy-maintenance scheduling authority. The coordinator is
   * content-free; episode/sleeptime runners commit private progress through its
   * fenced checkpoint seam.
   */
  fleetMaintenanceCoordinator?: FleetMaintenanceCoordinator;
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
    | 'healthEventStreamMaxRows'
    | 'custodySnapshotRetentionDays'
  >;
  pathSnapshot: RuntimePathSnapshot;
  embeddingDims: number;
  primaryUserId?: string;
  contactLifecycleGateway?: ContactLifecycleGatewayPort;
  onContactLifecycleRecoveryFailure?: (error: unknown) => void;
  /**
   * Owner-file bounds for the durable escalation ledger
   * (`scheduler.json` `humanEscalation.retention`, bead psfn-framework-yu03d).
   * Required: this factory has no fallback bound, so an agent can never persist
   * escalations without a declared one.
   */
  humanEscalationLedgerBounds: HumanEscalationLedgerBounds;
  /** Content-free report when this companion's open half reaches its cap. */
  onHumanEscalationLedgerSaturated?: HumanEscalationLedgerSaturationReporter;
}

/**
 * The health stream is bounded by an operator-owned value only. There is no
 * built-in cap: booting a runtime that persists health events without a
 * declared bound is the failure this refuses.
 */
function requireHealthEventStreamMaxRows(value: number | undefined): number {
  if (value === undefined) {
    throw new Error(
      'Runtime health stream requires settings.json healthEventStreamMaxRows',
    );
  }
  return value;
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
  // e5r0s: the fleet's system-owned observability, opened read/answer-only over
  // the shared schema. Gated on fleet tenancy for a reason that is not
  // cosmetic: outside a fleet the gateway and this process resolve to the same
  // table, so a second store would be the same rows under a second name.
  const fleetSystemHealthEventStore = fleetTenancy
    ? await awaitPostgresStoreReadiness(
        'fleet_system_health_stream',
        () => PostgresHealthEventStore.connectShared(
          databaseUrl,
          requireHealthEventStreamMaxRows(options.config.healthEventStreamMaxRows),
          tenantRole ? { role: tenantRole } : {},
        ),
      )
    : undefined;
  const fleetSystemHumanEscalationStore = fleetTenancy
    ? await awaitPostgresStoreReadiness(
        'fleet_system_human_escalations',
        () => PostgresHumanEscalationStore.connectShared(databaseUrl, {
          ...(tenantRole ? { role: tenantRole } : {}),
          bounds: options.humanEscalationLedgerBounds,
        }),
      )
    : undefined;
  const fleetMaintenanceCoordinator = options.config.multiCompanion === true
    ? await awaitPostgresStoreReadiness(
        'fleet_maintenance',
        async () => {
          const companionFleet = options.config.companionFleet;
          const companionId = options.config.companionId?.trim();
          if (!companionFleet || !companionId) {
            throw new Error(
              'Multi-companion fleet maintenance requires manifest and companion identity',
            );
          }
          const store = await PostgresFleetMaintenanceStore.connect(databaseUrl);
          try {
            return createFleetMaintenanceCoordinator({
              store,
              companionId,
              fleetCompanionIds: companionFleet.companions.map(
                companion => companion.companionId,
              ),
            });
          } catch (error) {
            await store.close();
            throw error;
          }
        },
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
  // Bounded room-participation leases share the arbiter's gateway ownership and
  // reboot-survival contract, so they share its shared-schema placement too.
  const roomParticipationLeaseStore = fleetTenancy
    ? await awaitPostgresStoreReadiness(
        'room_participation_lease',
        () => PostgresRoomParticipationLeaseStore.connect(databaseUrl),
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
    letterStore: await awaitPostgresStoreReadiness(
      'letters',
      () => PostgresLetterStore.connect(databaseUrl, { schema, role: tenantRole }),
    ),
    doingMirrorStore: await awaitPostgresStoreReadiness(
      'doing_mirror',
      () => PostgresDoingMirrorStore.connect(databaseUrl, { schema, role: tenantRole }),
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
    cogSecReceiptStore: await awaitPostgresStoreReadiness(
      'cogsec_receipts',
      () => PostgresCogSecReceiptStore.connect(databaseUrl, { schema, role: tenantRole }),
    ),
    custodySnapshotStore: await awaitPostgresStoreReadiness(
      'custody_snapshots',
      () => PostgresCustodySnapshotStore.connect(
        databaseUrl,
        options.config.custodySnapshotRetentionDays,
        { schema, role: tenantRole },
      ),
    ),
    egressDeliveryRecordStore: await awaitPostgresStoreReadiness(
      'egress_delivery_records',
      () => PostgresEgressDeliveryRecordStore.connect(
        databaseUrl,
        options.config.custodySnapshotRetentionDays,
        { schema, role: tenantRole },
      ),
    ),
    // No readiness wrapper: the reader runs no migration. It opens a pool on
    // the schema the two custody writers above just migrated, so a readiness
    // gate here would wait on work that has already happened.
    custodyChainReader: await PostgresCustodyChainReader.connect(
      databaseUrl,
      { schema, role: tenantRole },
    ),
    partnerAffectShadowStore: await awaitPostgresStoreReadiness(
      'partner_affect_shadow',
      () => PostgresPartnerAffectShadowStore.connect(databaseUrl, { schema, role: tenantRole }),
    ),
    humanEscalationStore: await awaitPostgresStoreReadiness(
      'human_escalations',
      () => PostgresHumanEscalationStore.connect(databaseUrl, {
        schema,
        role: tenantRole,
        bounds: options.humanEscalationLedgerBounds,
        ...(options.onHumanEscalationLedgerSaturated
          ? { onSaturated: options.onHumanEscalationLedgerSaturated }
          : {}),
      }),
    ),
    healthEventStore: await awaitPostgresStoreReadiness(
      'runtime_health_stream',
      () => PostgresHealthEventStore.connect(
        databaseUrl,
        requireHealthEventStreamMaxRows(options.config.healthEventStreamMaxRows),
        { schema, role: tenantRole },
      ),
    ),
    icpFeltImpulseFunnelStore,
    emosimProactivityStateStore,
    socialImpulseOutreachStore,
    ...(companionPresenceStore ? { companionPresenceStore } : {}),
    ...(fleetSystemHealthEventStore ? { fleetSystemHealthEventStore } : {}),
    ...(fleetSystemHumanEscalationStore ? { fleetSystemHumanEscalationStore } : {}),
    ...(icpInitiationCandidateStore ? { icpInitiationCandidateStore } : {}),
    ...(socialPotStore ? { socialPotStore } : {}),
    ...(speakingArbiterStore ? { speakingArbiterStore } : {}),
    ...(roomParticipationLeaseStore ? { roomParticipationLeaseStore } : {}),
    ...(fleetMaintenanceCoordinator ? { fleetMaintenanceCoordinator } : {}),
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
