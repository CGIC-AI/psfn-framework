import { createLLMProviderPort } from '../../../core/agent/contracts.js';
import { createNoopSatelliteRoutingPort } from '../../../core/agent/satellite-adapter-port.js';
import { GatewayClient } from '../../../boundary/gateway/client.js';
import {
  composeFatigueBudgetRuntime,
  composeIdentity,
  composeSessionRuntimeAsync,
  composeSubstrateAgent,
  wireMemoryRuntime,
} from '../../startup/composition/composition.js';
import { createAgentPersistenceRuntime } from '../../../persistence/runtime-factory.js';
import { PostgresIcpFatigueRegulationReservationStore } from '../../../persistence/postgres/icp-fatigue-regulation-reservation-store.js';
import { prepareAgentStartupContext } from '../../agent/startup-context.js';
import { registerGatewayMessageHandlers } from '../../agent/gateway-message-handlers.js';
import { CERTIFICATION_EMBEDDING_DIMS } from './constants.js';

interface AgentProcessCommand {
  id: number;
  type: 'ping' | 'shutdown' | 'snapshot';
}

interface AgentProcessReply {
  id?: number;
  ok: boolean;
  result?: unknown;
  error?: string;
  type?: 'ready';
}

const logger = {
  info: (_message: string, _meta?: Record<string, unknown>) => undefined,
  warn: (_message: string, _meta?: Record<string, unknown>) => undefined,
  error: (_message: string, _meta?: Record<string, unknown>) => undefined,
};

function reply(message: AgentProcessReply): void {
  if (!process.send) throw new Error('ICP certification agent requires an IPC parent');
  process.send(message);
}

async function main(): Promise<void> {
  const startup = prepareAgentStartupContext({ env: process.env, log: logger });
  const databaseUrl = startup.config.postgresDatabaseUrl?.trim();
  const companionId = startup.config.companionId?.trim();
  if (!databaseUrl || !companionId) {
    throw new Error('ICP certification agent requires Postgres and a companion identity');
  }
  const gateway = await GatewayClient.connectEndpoint(
    startup.gatewayRpcEndpoint,
    CERTIFICATION_EMBEDDING_DIMS,
    {
      companionId,
      companionAuthToken: startup.config.gatewayCompanionAuthToken,
      sessionIntegrityAuthToken: startup.config.gatewaySessionIntegrityAuthToken,
      keepaliveIntervalMs: 60_000,
    },
  );
  await gateway.identifyAsAgent();
  const persistence = await createAgentPersistenceRuntime({
    config: startup.config,
    pathSnapshot: startup.pathSnapshot,
    embeddingDims: CERTIFICATION_EMBEDDING_DIMS,
  });
  const contactStore = persistence.contactStore;
  if (!contactStore) throw new Error('ICP certification agent requires the Postgres contact store');
  const peer = startup.config.companionFleet?.companions.find(
    candidate => candidate.companionId !== companionId,
  );
  if (!peer) throw new Error('ICP certification agent requires exactly one peer fixture');
  const peerContact = await contactStore.resolveChannelIdentity(
    'companion',
    peer.companionId,
    `Certification peer ${peer.companionId.slice(0, 4)}`,
  );
  await contactStore.setMachineIntelligence(peerContact.id, true, 'e2e:icp-certification');
  await contactStore.setTrustLevel(peerContact.id, 'trusted', 'e2e:icp-certification');
  await contactStore.updateRelationshipType(
    peerContact.id,
    'ai_companion',
    'e2e:icp-certification',
  );

  const llmProvider = createLLMProviderPort(gateway);
  const sessionRuntime = await composeSessionRuntimeAsync({
    config: startup.config,
    postgresDatabaseUrl: databaseUrl,
    eventBus: startup.eventBus,
    enableContinuity: true,
    sessionIntegrityProvider: gateway.createSessionIntegrityProvider(),
  });
  const identity = composeIdentity(startup.config);
  const fatigue = composeFatigueBudgetRuntime({
    config: startup.config,
    eventBus: startup.eventBus,
  });
  const fatigueReservations = await PostgresIcpFatigueRegulationReservationStore.connect(databaseUrl);
  const agent = composeSubstrateAgent({
    eventBus: startup.eventBus,
    llmProvider,
    sessionManager: sessionRuntime.sessionManager,
    systemPrompt: identity.systemPrompt,
    characterName: identity.card.data.name,
    config: startup.coreConfig,
    runtimeMode: 'gateway',
    fatigueBudget: fatigue.fatigueBudget,
    fatigueRegulationReservations: fatigueReservations,
    streamTransport: { stream: gateway.stream.bind(gateway) },
  });
  agent.contactStore = contactStore;
  agent.scratchpadProvider = persistence.memoryStore;
  wireMemoryRuntime({
    agentLoop: agent,
    llmProvider,
    sessionManager: sessionRuntime.sessionManager,
    sessionStore: sessionRuntime.sessionStore,
    memoryStore: persistence.memoryStore,
    embeddingService: gateway,
    eventBus: startup.eventBus,
    config: startup.config,
    contactStore,
    episodicStore: persistence.episodicStore,
  });
  registerGatewayMessageHandlers({
    gateway,
    agentLoop: agent,
    shardManager: {
      delegateSatelliteSession: async () => {
        throw new Error('Shard delegation is outside ICP certification scope');
      },
    },
    safeguardAuditTrail: { append: () => undefined },
    satelliteRouting: createNoopSatelliteRoutingPort(),
    config: startup.config,
    log: logger,
    trackSessionActivity: () => undefined,
    companionAuthorName: identity.card.data.name,
  });
  await startup.eventBus.emit('system.init', {});
  await startup.eventBus.emit('system.ready', {});
  reply({
    ok: true,
    type: 'ready',
    result: {
      companionId,
      peerContactId: peerContact.id,
      postgresSchema: startup.config.postgresSchema,
      runtimeClass: agent.constructor.name,
    },
  });

  process.on('message', (raw: AgentProcessCommand) => {
    void (async () => {
      try {
        if (raw.type === 'ping') {
          reply({ id: raw.id, ok: true, result: { companionId } });
          return;
        }
        if (raw.type === 'snapshot') {
          reply({
            id: raw.id,
            ok: true,
            result: {
              companionId,
              recentSessions: sessionRuntime.sessionManager.listRecentSessions(10),
              runtimeClass: agent.constructor.name,
            },
          });
          return;
        }
        await agent.waitForIdle();
        gateway.destroy();
        await fatigueReservations.close();
        startup.stopDebugObserver();
        reply({ id: raw.id, ok: true });
        process.disconnect();
      } catch (error) {
        reply({
          id: raw.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  });
}

void main().catch((error) => {
  reply({ ok: false, error: error instanceof Error ? error.stack : String(error) });
  process.exitCode = 1;
});
