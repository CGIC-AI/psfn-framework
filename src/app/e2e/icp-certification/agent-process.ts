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
import { resolveChargeLedgerPath } from '../../../persistence/layout.js';
import { PostgresIcpFatigueRegulationReservationStore } from '../../../persistence/postgres/icp-fatigue-regulation-reservation-store.js';
import { RunChargeLedger } from '../../../shared/telemetry/charge-ledger.js';
import { prepareAgentStartupContext } from '../../agent/startup-context.js';
import { registerGatewayMessageHandlers } from '../../agent/gateway-message-handlers.js';
import { createAgentFacingIcpAutonomyRuntime } from '../../../core/icp/agent-facing-autonomy.js';
import { createIcpInitiationSourceRuntime } from '../../../core/icp/initiation-source-runtime.js';
import { createLlmIcpInitiationConsentEvaluator } from '../../../core/icp/initiation-consent-evaluator.js';
import { createIcpAutonomyRuntimeEnablement } from '../../../core/icp/runtime-enablement.js';
import { runAutoCompaction } from '../../../core/session/manager/compaction-service.js';
import { createCompactionBoundaryStore } from '../../../core/session/manager/compaction-boundary-store.js';
import { createIcpDeliveryProjectionStore } from '../../../core/session/manager/icp-delivery-projection-store.js';
import { countTokens } from '../../../primitives/llm/tokens.js';
import { CERTIFICATION_EMBEDDING_DIMS } from './constants.js';

type AgentProcessCommand = {
  id: number;
  type: 'ping' | 'shutdown' | 'snapshot';
} | {
  id: number;
  type: 'publish_availability';
  state: 'open_to_chat' | 'busy' | 'do_not_disturb';
} | {
  id: number;
  type: 'runtime_emergency_disable';
} | {
  id: number;
  type: 'submit_initiation';
  source: 'free_time' | 'weighted_thought';
  sourceRecordId: string;
} | {
  channelId: string;
  id: number;
  type: 'channel_snapshot' | 'force_compaction' | 'append_compaction_marker';
};

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
  const chargeLedger = new RunChargeLedger(
    resolveChargeLedgerPath(startup.pathSnapshot.companionDataDir),
    startup.eventBus,
  );
  agent.setDurableChargeRecorder(
    event => chargeLedger.commitChargeEvent(event).outcome,
    event => chargeLedger.probeChargeEvent(event),
  );
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
  const registeredHandlers = registerGatewayMessageHandlers({
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
  const autonomy = createAgentFacingIcpAutonomyRuntime({
    contactStore,
    gateway,
    command: {
      execute: async request => {
        const initiated = await registeredHandlers.icpTargetChannelInitiator.initiate(request);
        return { disposition: initiated.disposition };
      },
    },
  });
  const candidateStore = persistence.icpInitiationCandidateStore;
  if (!candidateStore) throw new Error('ICP certification agent requires a candidate store');
  const runtimeEnablement = createIcpAutonomyRuntimeEnablement(
    startup.schedulerConfig.icpAutonomy.enabled,
  );
  const sourceRuntime = startup.schedulerConfig.icpAutonomy.enabled
    ? createIcpInitiationSourceRuntime({
        localCompanionId: companionId,
        store: candidateStore,
        peers: autonomy,
        gateway,
        consent: createLlmIcpInitiationConsentEvaluator({ llmProvider }),
        isExternalCompanionAuthorized: () => runtimeEnablement.isEnabled()
          && startup.capabilityRuntime.has('external.companion'),
        policy: {
          candidateDefaultTtlMs: startup.schedulerConfig.icpAutonomy.candidate.defaultTtlMs,
          retryCadenceMs: startup.schedulerConfig.icpAutonomy.candidate.retryCadenceMs,
          maxRetryAttempts: startup.schedulerConfig.icpAutonomy.candidate.maxRetryAttempts,
          permitTtlMs: startup.schedulerConfig.icpAutonomy.permit.ttlMs,
        },
        eventBus: startup.eventBus,
      })
    : undefined;
  const compactionStore = createCompactionBoundaryStore(
    createIcpDeliveryProjectionStore(sessionRuntime.sessionStore),
  );
  let compactionMarkerIndex = 0;
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
        if (raw.type === 'publish_availability') {
          const current = await autonomy.readOwnAvailability();
          const lease = await autonomy.publishOwnAvailability({
            state: raw.state,
            expiresAtMs: Date.now() + 60_000,
            revision: (current.lease?.revision ?? 0) + 1,
          });
          reply({ id: raw.id, ok: true, result: lease });
          return;
        }
        if (raw.type === 'submit_initiation') {
          if (!sourceRuntime) throw new Error('ICP autonomy is disabled by scheduler.json');
          const result = await sourceRuntime.submit({
            source: raw.source,
            peerContactId: peerContact.id,
            preferredChannel: 'dm',
            sourceRecordId: raw.sourceRecordId,
            reasonSummary: `Private ${raw.source} certification motivation`,
            cause: { kind: 'independent' },
          });
          reply({ id: raw.id, ok: true, result });
          return;
        }
        if (raw.type === 'runtime_emergency_disable') {
          runtimeEnablement.disable();
          const current = await autonomy.readOwnAvailability();
          const lease = await autonomy.publishOwnAvailability({
            state: 'do_not_disturb',
            expiresAtMs: Date.now() + startup.schedulerConfig.icpAutonomy.availability.operatorLeaseTtlMs,
            revision: (current.lease?.revision ?? 0) + 1,
          });
          reply({
            id: raw.id,
            ok: true,
            result: { enabled: runtimeEnablement.isEnabled(), lease },
          });
          return;
        }
        if (raw.type === 'channel_snapshot') {
          reply({
            id: raw.id,
            ok: true,
            result: {
              entries: sessionRuntime.sessionStore.getRecent(raw.channelId, 100),
              memories: await persistence.memoryStore.getMemoriesByChannel(raw.channelId, 100),
              summaries: sessionRuntime.sessionStore.getCompactionSummaries(raw.channelId),
            },
          });
          return;
        }
        if (raw.type === 'force_compaction') {
          const recent = compactionStore.getRecent(raw.channelId, 100);
          const compaction = await runAutoCompaction({
            channelId: raw.channelId,
            recent,
            channelVisibility: 'private',
            systemTokens: countTokens(identity.systemPrompt),
            llmProvider,
            store: compactionStore,
            config: startup.coreConfig,
            eventBus: startup.eventBus,
            promptRegistry: null,
            preCompactionExtractionHandler: null,
          });
          reply({
            id: raw.id,
            ok: true,
            result: {
              compaction: {
                compacted: compaction.compacted,
                compactedCount: compaction.compactedCount ?? 0,
              },
              compactionThresholdPct: startup.coreConfig.compactionThresholdPct,
              recentCount: recent.length,
              summaries: sessionRuntime.sessionStore.getCompactionSummaries(raw.channelId),
            },
          });
          return;
        }
        if (raw.type === 'append_compaction_marker') {
          compactionMarkerIndex += 1;
          const assistantMarker = compactionMarkerIndex % 2 === 0;
          sessionRuntime.sessionStore.append({
            channelId: raw.channelId,
            role: assistantMarker ? 'assistant' : 'user',
            content: 'deterministic certification continuity marker '.repeat(20).trim(),
            authorId: assistantMarker ? companionId : 'certification-fixture',
            authorName: assistantMarker
              ? identity.card.data.name
              : 'Certification Fixture',
            timestamp: Date.now() + compactionMarkerIndex,
            channelVisibility: 'private',
            metadata: JSON.stringify({
              turn: { actorKind: assistantMarker ? 'machine_intelligence' : 'human' },
            }),
          });
          reply({ id: raw.id, ok: true });
          return;
        }
        await agent.waitForIdle();
        gateway.destroy();
        await fatigueReservations.close();
        chargeLedger.close();
        startup.stopDebugObserver();
        reply({ id: raw.id, ok: true });
        process.disconnect();
      } catch (error) {
        reply({
          id: raw.id,
          ok: false,
          error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        });
      }
    })();
  });
}

void main().catch((error) => {
  reply({ ok: false, error: error instanceof Error ? error.stack : String(error) });
  process.exitCode = 1;
});
