import type { ShardExecutionPort } from '../../faculties/shards/port.js';
import { createInProcessGardenAdminContract } from '../../operator/garden/local-admin-contract.js';
import { createGatewayAdminToolHealthProvider } from '../../operator/garden/tool-health-provider.js';
import { GardenAdminTransportServer } from '../../operator/garden/transport-server.js';
import type { GatewayClient } from '../../boundary/gateway/client.js';
import { GatewayModelDiscovery } from '../../primitives/llm/discovery.js';
import type { CharacterCardVersionStore } from '../../core/identity/card-versioning.js';
import type { CharacterCardV2 } from '../../core/identity/types.js';
import type { PostTurnActionRuntime } from '../../core/agent/post-turn-action-runtime.js';
import type { OutreachOutboxStore } from '../../core/intention/outreach-outbox.js';
import type { PendingContactApprovalStore } from '../../core/contacts/pending-contact-approvals.js';
import type { SocialGraphProposalStore } from '../../faculties/memory/social-graph/proposals.js';
import type { HubIdentityEnrollmentStorePort } from '../../core/enrollment/enrollment-store-port.js';
import type { AgentCoreRuntime } from './core-runtime.js';
import type { EventBus } from '../../shared/event-bus.js';
import type { Scheduler } from '../../core/scheduler/scheduler.js';
import {
  sanitizeCoreSubstrateConfig,
  type SubstrateConfig,
} from '../../system/config/runtime-config-contracts.js';
import type { SatelliteRegistryConfig } from '../../shared/contracts/satellite-registry.js';
import type { ChannelGroupMemoryConfig } from '../../system/config/group-memory-config.js';
import type { ApprovalQueuePort } from '../../system/capabilities/approval-queue-port.js';
import type {
  EpisodicStorePort,
} from '../../faculties/memory/episodic/store-port.js';
import { createGatewayConfirmationQueueAdminApi } from '../startup/support/confirmation-queue-admin-api.js';
import {
  resolveAdminTransportMode,
  resolveAdminTransportServerEndpoint,
} from '../../operator/garden/transport-paths.js';
import type { RunChargeLedger } from '../../shared/telemetry/charge-ledger.js';
import type { SchedulerRuntimeConfig } from '../../system/config/scheduler-config.js';
import type { IcpInitiationCandidateStorePort } from '../../core/icp/autonomy-store-ports.js';
import type { IcpAutonomyRuntimeEnablement } from '../../core/icp/runtime-enablement.js';
import { PostgresIcpAdminProjectionStore } from '../../persistence/postgres/icp-admin-projection-store.js';
import { resolveSharedWorkspaceCredentials } from '../../operator/garden/services/shared-workspace-service.js';

export interface StartOptionalAdminTransportServerOptions {
  adminPort?: number;
  apiHost?: string;
  apiPort?: number;
  env?: NodeJS.ProcessEnv;
  config: SubstrateConfig;
  satelliteRegistryConfig: SatelliteRegistryConfig;
  channelGroupMemory?: ChannelGroupMemoryConfig;
  gateway: GatewayClient;
  eventBus: EventBus;
  chargeLedger: RunChargeLedger;
  scheduler: Scheduler;
  schedulerConfig: SchedulerRuntimeConfig;
  icpInitiationCandidateStore?: IcpInitiationCandidateStorePort | null;
  icpRuntimeEnablement: IcpAutonomyRuntimeEnablement;
  postTurnActions: PostTurnActionRuntime;
  outreachOutbox?: OutreachOutboxStore | null;
  episodicStore?: EpisodicStorePort | null;
  /** Pending contact approvals queue (E3.4 contact-tracking policy gate). */
  pendingContactApprovals?: PendingContactApprovalStore | null;
  /** Social-graph edge proposals from the graph-builder worker (E4.2). */
  socialGraphProposals?: SocialGraphProposalStore | null;
  /** Hub-identity ↔ contact enrollment store (S10 D2a). Enables the Garden enrollment surface. */
  hubIdentityEnrollmentStore?: HubIdentityEnrollmentStorePort | null;
  card: CharacterCardV2;
  shardManager: ShardExecutionPort;
  cardVersionStore: CharacterCardVersionStore;
  cardProposalQueue: ApprovalQueuePort;
  coreRuntime: Pick<
    AgentCoreRuntime,
    'memoryStore'
    | 'sessionStore'
    | 'sessionManager'
    | 'contactStore'
    | 'promptState'
    | 'skillsRuntime'
    | 'observerEvalSidecar'
    | 'agentLoop'
    | 'memoryExtractor'
    | 'intentionRuntime'
    | 'toolConformanceRunner'
  >;
}

export async function startOptionalAdminTransportServer(
  options: StartOptionalAdminTransportServerOptions,
): Promise<GardenAdminTransportServer | undefined> {
  const env = options.env ?? process.env;
  const transportMode = resolveAdminTransportMode(env);
  if (!options.adminPort && transportMode === 'socket') {
    return undefined;
  }

  const modelDiscovery = new GatewayModelDiscovery(options.gateway);
  const adminConfig: SubstrateConfig = {
    ...options.config,
    satelliteRegistry: options.satelliteRegistryConfig,
  };
  const publicAdminConfig = sanitizeCoreSubstrateConfig(adminConfig) as SubstrateConfig;
  const fleetCompanionIds = options.config.companionFleet?.companions
    .map(companion => companion.companionId)
    ?? (options.config.companionId ? [options.config.companionId] : []);
  const localCompanionId = options.config.companionId;
  const icpAdminProjectionStore = options.config.multiCompanion === true
    && options.config.postgresDatabaseUrl
    && localCompanionId
    && fleetCompanionIds.length > 0
    ? await PostgresIcpAdminProjectionStore.connect(
      options.config.postgresDatabaseUrl,
      {
        localCompanionId,
        knownCompanionIds: fleetCompanionIds,
      },
    )
    : null;
  const services = createInProcessGardenAdminContract({
    env,
    apiBaseUrl: env.API_BASE_URL,
    apiHost: options.apiHost,
    apiPort: options.apiPort,
    memoryStore: options.coreRuntime.memoryStore,
    episodicStore: options.episodicStore ?? null,
    sessionStore: options.coreRuntime.sessionStore,
    sessionManager: options.coreRuntime.sessionManager,
    scheduler: options.scheduler,
    effectiveSchedulerConfig: options.schedulerConfig,
    icpInitiationCandidateStore: options.icpInitiationCandidateStore ?? null,
    icpAdminProjectionStore,
    icpRuntimeEnablement: options.icpRuntimeEnablement,
    postTurnActions: options.postTurnActions,
    outreachOutbox: options.outreachOutbox ?? null,
    shardManager: options.shardManager,
    eventBus: options.eventBus,
    chargeLedger: options.chargeLedger,
    contactStore: options.coreRuntime.contactStore,
    pendingContactApprovals: options.pendingContactApprovals ?? null,
    socialGraphProposals: options.socialGraphProposals ?? null,
    hubIdentityEnrollmentStore: options.hubIdentityEnrollmentStore ?? null,
    concernStore: options.coreRuntime.intentionRuntime.concernStore,
    characterCard: options.card,
    config: adminConfig,
    embeddingService: options.gateway,
    modelDiscovery,
    promptState: options.coreRuntime.promptState,
    skillsRuntime: options.coreRuntime.skillsRuntime,
    observerEvalSidecar: options.coreRuntime.observerEvalSidecar,
    memoryExtractor: options.coreRuntime.memoryExtractor,
    ...(options.channelGroupMemory ? { channelGroupMemory: options.channelGroupMemory } : {}),
    companionAuthorIds: options.config.discordBotId ? [options.config.discordBotId] : [],
    // Operator-only gateway confirmations (e.g. kube self-management) are
    // resolved directly by the Garden operator process; the agent never holds
    // the operator gateway client or the ADMIN_TOKEN it would need (x5rt.10).
    // This surface resolves agent-local confirmations only.
    confirmationQueueApi: createGatewayConfirmationQueueAdminApi(
      options.gateway,
      options.cardProposalQueue,
    ),
    cardVersionStore: options.cardVersionStore,
    adaptiveToolsStateProvider: options.coreRuntime.agentLoop,
    toolHealthProvider: createGatewayAdminToolHealthProvider(options.gateway),
    getCredentialPresence: () => options.gateway.getCredentialPresence(),
    ...(env.PSFN_LOGS_DIR ? { logsDir: env.PSFN_LOGS_DIR } : {}),
    toolConformanceRunner: options.coreRuntime.toolConformanceRunner,
    wishlistBeadCreator: {
      createWishBead: input => options.gateway.beadsCreate({
        title: input.title,
        description: input.description,
        acceptance: input.acceptance,
        issueType: input.issueType,
        priority: input.priority,
        actor: input.actor,
      }),
    },
    ...(adminConfig.sharedWorkspacePath
      ? { sharedWorkspaceCredentials: resolveSharedWorkspaceCredentials(env) }
      : {}),
  });
  const adminTransport = new GardenAdminTransportServer({
    endpoint: resolveAdminTransportServerEndpoint(env),
    eventBus: options.eventBus,
    config: publicAdminConfig,
    services,
  });
  await adminTransport.init();
  await adminTransport.start();
  return adminTransport;
}
