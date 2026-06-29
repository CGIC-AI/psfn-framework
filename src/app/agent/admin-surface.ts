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
import type { AgentCoreRuntime } from './core-runtime.js';
import type { EventBus } from '../../shared/event-bus.js';
import type { Scheduler } from '../../core/scheduler/scheduler.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { SatelliteRegistryConfig } from '../../shared/contracts/satellite-registry.js';
import type { ChannelGroupMemoryConfig } from '../../system/config/group-memory-config.js';
import type { ApprovalQueuePort } from '../../system/capabilities/approval-queue-port.js';
import type { EpisodicStorePort } from '../../faculties/memory/episodic/store.js';
import { createGatewayConfirmationQueueAdminApi } from '../startup/support/confirmation-queue-admin-api.js';
import {
  resolveAdminTransportMode,
  resolveAdminTransportServerEndpoint,
} from '../../operator/garden/transport-paths.js';

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
  scheduler: Scheduler;
  postTurnActions: PostTurnActionRuntime;
  outreachOutbox?: OutreachOutboxStore | null;
  episodicStore?: EpisodicStorePort | null;
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
  const services = createInProcessGardenAdminContract({
    apiBaseUrl: env.API_BASE_URL,
    apiHost: options.apiHost,
    apiPort: options.apiPort,
    memoryStore: options.coreRuntime.memoryStore,
    episodicStore: options.episodicStore ?? null,
    sessionStore: options.coreRuntime.sessionStore,
    sessionManager: options.coreRuntime.sessionManager,
    scheduler: options.scheduler,
    postTurnActions: options.postTurnActions,
    outreachOutbox: options.outreachOutbox ?? null,
    shardManager: options.shardManager,
    eventBus: options.eventBus,
    contactStore: options.coreRuntime.contactStore,
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
    confirmationQueueApi: createGatewayConfirmationQueueAdminApi(
      options.gateway,
      options.cardProposalQueue,
    ),
    cardVersionStore: options.cardVersionStore,
    adaptiveToolsStateProvider: options.coreRuntime.agentLoop,
    toolHealthProvider: createGatewayAdminToolHealthProvider(options.gateway),
  });
  const adminTransport = new GardenAdminTransportServer({
    endpoint: resolveAdminTransportServerEndpoint(env),
    eventBus: options.eventBus,
    config: adminConfig,
    services,
  });
  await adminTransport.init();
  await adminTransport.start();
  return adminTransport;
}
