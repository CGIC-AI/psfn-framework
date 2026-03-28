import type { ShardExecutionPort } from '../../shards/port.js';
import { AdminServer } from '../../operator/garden/server.js';
import { createGatewayAdminToolHealthProvider } from '../../operator/garden/tool-health-provider.js';
import type { GatewayClient } from '../../gateway/client.js';
import { GatewayModelDiscovery } from '../../llm/discovery.js';
import type { CharacterCardVersionStore } from '../../identity/card-versioning.js';
import type { CharacterCardV2 } from '../../identity/types.js';
import type { AgentCoreRuntime } from '../../agent-main/core-runtime.js';
import type { EventBus } from '../../shared/event-bus.js';
import type { Scheduler } from '../../scheduler/scheduler.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { ConfirmationQueue } from '../../system/capabilities/confirmation-queue.js';
import { createGatewayConfirmationQueueAdminApi } from '../../runtime/confirmation-queue-admin-api.js';
import { isExplicitTrue } from '../../runtime/env-parsing.js';

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
  cardProposalQueue: ConfirmationQueue;
  coreRuntime: Pick<
    AgentCoreRuntime,
    'memoryStore'
    | 'sessionStore'
    | 'sessionManager'
    | 'contactStore'
    | 'promptStore'
    | 'promptRegistry'
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
  const adminServer = new AdminServer({
    port: options.adminPort,
    host: options.adminHost,
    token: adminToken,
    allowInsecureWithoutToken,
    apiBaseUrl: env.API_BASE_URL,
    apiHost: options.apiHost,
    apiPort: options.apiPort,
    memoryStore: options.coreRuntime.memoryStore,
    sessionStore: options.coreRuntime.sessionStore,
    sessionManager: options.coreRuntime.sessionManager,
    scheduler: options.scheduler,
    shardManager: options.shardManager,
    eventBus: options.eventBus,
    characterCard: options.card,
    config: options.config,
    embeddingService: options.gateway,
    modelDiscovery,
    contactStore: options.coreRuntime.contactStore,
    promptStore: options.coreRuntime.promptStore,
    promptRegistry: options.coreRuntime.promptRegistry,
    skillsRuntime: options.coreRuntime.skillsRuntime,
    confirmationQueueApi: createGatewayConfirmationQueueAdminApi(
      options.gateway,
      options.cardProposalQueue,
    ),
    cardVersionStore: options.cardVersionStore,
    adaptiveToolsStateProvider: options.coreRuntime.agentLoop,
    toolHealthProvider: createGatewayAdminToolHealthProvider(options.gateway),
  });
  await adminServer.init();
  await adminServer.start();
  return adminServer;
}
