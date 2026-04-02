import type { ShardExecutionPort } from '../../faculties/shards/port.js';
import { AdminServer } from '../../operator/garden/server.js';
import { createInProcessGardenAdminContract } from '../../operator/garden/local-admin-contract.js';
import { createGatewayAdminToolHealthProvider } from '../../operator/garden/tool-health-provider.js';
import type { GatewayClient } from '../../boundary/gateway/client.js';
import { GatewayModelDiscovery } from '../../primitives/llm/discovery.js';
import type { CharacterCardVersionStore } from '../../core/identity/card-versioning.js';
import type { CharacterCardV2 } from '../../core/identity/types.js';
import type { AgentCoreRuntime } from './core-runtime.js';
import type { EventBus } from '../../shared/event-bus.js';
import type { Scheduler } from '../../core/scheduler/scheduler.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { ApprovalQueuePort } from '../../system/capabilities/approval-queue-port.js';
import { createGatewayConfirmationQueueAdminApi } from '../startup/support/confirmation-queue-admin-api.js';
import { isExplicitTrue } from '../startup/support/env-parsing.js';

export interface StartOptionalAdminServerOptions {
  adminHost?: string;
  adminPort?: number;
  apiHost?: string;
  apiPort?: number;
  env?: NodeJS.ProcessEnv;
  config: SubstrateConfig;
  gateway: GatewayClient;
  eventBus: EventBus;
  scheduler: Scheduler;
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
    | 'agentLoop'
  >;
}

export async function startOptionalAdminServer(
  options: StartOptionalAdminServerOptions,
): Promise<AdminServer | undefined> {
  if (!options.adminPort) {
    return undefined;
  }

  const env = options.env ?? process.env;
  const adminToken = env.ADMIN_TOKEN || undefined;
  const allowInsecureWithoutToken = isExplicitTrue(env.ADMIN_ALLOW_INSECURE);
  const modelDiscovery = new GatewayModelDiscovery(options.gateway);
  const services = createInProcessGardenAdminContract({
    apiBaseUrl: env.API_BASE_URL,
    apiHost: options.apiHost,
    apiPort: options.apiPort,
    memoryStore: options.coreRuntime.memoryStore,
    sessionStore: options.coreRuntime.sessionStore,
    sessionManager: options.coreRuntime.sessionManager,
    scheduler: options.scheduler,
    shardManager: options.shardManager,
    eventBus: options.eventBus,
    contactStore: options.coreRuntime.contactStore,
    characterCard: options.card,
    config: options.config,
    embeddingService: options.gateway,
    modelDiscovery,
    promptState: options.coreRuntime.promptState,
    skillsRuntime: options.coreRuntime.skillsRuntime,
    confirmationQueueApi: createGatewayConfirmationQueueAdminApi(
      options.gateway,
      options.cardProposalQueue,
    ),
    cardVersionStore: options.cardVersionStore,
    adaptiveToolsStateProvider: options.coreRuntime.agentLoop,
    toolHealthProvider: createGatewayAdminToolHealthProvider(options.gateway),
  });
  const adminServer = new AdminServer({
    port: options.adminPort,
    host: options.adminHost,
    token: adminToken,
    allowInsecureWithoutToken,
    eventBus: options.eventBus,
    config: options.config,
    services,
  });
  await adminServer.init();
  await adminServer.start();
  return adminServer;
}
