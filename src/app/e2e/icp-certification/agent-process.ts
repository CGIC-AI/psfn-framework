import { randomUUID } from 'node:crypto';
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
import { PostgresIcpAdminProjectionStore } from '../../../persistence/postgres/icp-admin-projection-store.js';
import { RunChargeLedger } from '../../../shared/telemetry/charge-ledger.js';
import { prepareAgentStartupContext } from '../../agent/startup-context.js';
import { registerGatewayMessageHandlers } from '../../agent/gateway-message-handlers.js';
import type { GatewayMessageAgentLoop } from '../../agent/gateway-message-handlers.js';
import { createAgentFacingIcpAutonomyRuntime } from '../../../core/icp/agent-facing-autonomy.js';
import { wireIcpInitiationSources } from '../../agent/icp-initiation-source-wiring.js';
import { runAutoCompaction } from '../../../core/session/manager/compaction-service.js';
import { createCompactionBoundaryStore } from '../../../core/session/manager/compaction-boundary-store.js';
import { createIcpDeliveryProjectionStore } from '../../../core/session/manager/icp-delivery-projection-store.js';
import { countTokens } from '../../../primitives/llm/tokens.js';
import { Scheduler } from '../../../core/scheduler/scheduler.js';
import { registerDurableBackgroundWorkSupervisorTask } from '../../../core/agent/background-work/scheduler-task.js';
import { wirePostTurnActionRuntime } from '../../startup/composition/post-turn-actions.js';
import {
  COMPANION_CANDIDATE_QUEUED_TEXT,
  inferIcpInitiationCandidateActions,
  registerIcpInitiationCandidatePostTurnRuntime,
} from '../../../core/tools/notify-companion-candidate.js';
import { createNotifyTool } from '../../../core/tools/ntfy.js';
import { toInferredPostTurnActions } from '../../../core/intention/appraisal/action-translation.js';
import { createThoughtWeight } from '../../../core/intention/weighted-thoughts.js';
import {
  registerWeightedThoughtOutreachTask,
  WEIGHTED_THOUGHT_OUTREACH_TASK_ID,
} from '../../../core/scheduler/weighted-thought-outreach-lane.js';
import { AdminIcpAutonomyDataService } from '../../../operator/garden/services/icp-autonomy-service.js';
import { AdminSettingsDataService } from '../../../operator/garden/services/settings-service.js';
import { createOwnerFileConfigStore } from '../../../system/config/config-store.js';
import { CompanionPresenceRuntime } from '../../../core/agent/companion-presence-runtime.js';
import { wireCompanionPresenceContext } from '../../agent/companion-presence-wiring.js';
import {
  CERTIFICATION_EMBEDDING_DIMS,
  CERTIFICATION_PRIVATE_ROOM,
} from './constants.js';
import { composeCompanionDmChannelId } from '../../../shared/contracts/companion-channels.js';
import {
  deriveIcpTransportMessageId,
  parseIcpConversationCorrelation,
} from '../../../shared/contracts/icp-autonomy.js';
import { buildCharacterPromptTemplateVariables } from '../../../core/identity/loader.js';
import { createPersonaPreambleService } from '../../../core/identity/persona-preamble.js';
import { resolveCoreCompanionIdFromConfig } from '../../../core/identity/companion-runtime.js';
import { createCompanionId } from '../../../shared/routing/companion-id.js';
import { createAgentFleetPostureProvider } from '../../agent/fleet-posture.js';
import { startIcpRuntimeAvailability } from '../../agent/icp-runtime-availability.js';
import { createHumanRelayIntentCapsule } from '../../../core/icp/human-relay-capsule.js';
import type { IcpDyadContinuationAuthorization } from '../../../boundary/gateway/icp-autonomy-contract.js';
type AgentProcessCommand = {
  id: number;
  type: 'background_work_snapshot' | 'ping' | 'shutdown' | 'snapshot';
} | {
  id: number;
  type: 'publish_availability';
  state: 'open_to_chat' | 'busy' | 'do_not_disturb';
} | {
  id: number;
  type: 'garden_emergency_disable';
} | {
  id: number;
  type: 'enter_private_room' | 'run_free_time_notification'
    | 'fail_next_companion_turn' | 'failure_observation_snapshot'
    | 'run_room_weighted_thought_scheduler' | 'run_weighted_thought_scheduler';
} | {
  action: 'continue' | 'deliver_prepared' | 'list' | 'prepare' | 'relay_probe' | 'transition';
  id: number;
  input: Record<string, unknown>;
  type: 'run_dyad_certification_action';
} | {
  candidateId: string;
  id: number;
  type: 'retry_candidate_delivery';
} | {
  id: number;
  rootInitiationId: string;
  type: 'run_recursive_weighted_thought_scheduler';
} | {
  id: number;
  phase: 'post_exit' | 'pre_entry' | 'rejoined';
  type: 'send_room_probe';
} | {
  channelId: string;
  id: number;
  type: 'channel_snapshot' | 'served_channel_snapshot'
    | 'turn_records_snapshot' | 'force_compaction' | 'append_compaction_marker';
} | {
  channelId: string;
  id: number;
  rootInitiationId: string;
  type: 'has_completed_fatigue_suppression';
};

interface AgentProcessReply {
  id?: number;
  ok: boolean;
  result?: unknown;
  error?: string;
  type?: 'ready';
}

const CERTIFICATION_CONTACT_FIXTURE_ACTOR = 'operator:e2e:icp-certification';

const logger = {
  info: (_message: string, _meta?: Record<string, unknown>) => undefined,
  warn: (_message: string, _meta?: Record<string, unknown>) => undefined,
  error: (_message: string, _meta?: Record<string, unknown>) => undefined,
};

function reply(message: AgentProcessReply): void {
  if (!process.send) throw new Error('ICP certification agent requires an IPC parent');
  process.send(message);
}

function projectCandidate(candidate: {
  candidateId: string;
  deliveryDisposition?: string;
  preferredChannel: string;
  reasonCode?: string;
  rootInitiationId: string;
  source: string;
  status: string;
}): Record<string, unknown> {
  return {
    candidateId: candidate.candidateId,
    rootInitiationId: candidate.rootInitiationId,
    source: candidate.source,
    preferredChannel: candidate.preferredChannel,
    status: candidate.status,
    ...(candidate.reasonCode ? { reasonCode: candidate.reasonCode } : {}),
    ...(candidate.deliveryDisposition
      ? { deliveryDisposition: candidate.deliveryDisposition }
      : {}),
  };
}

async function main(): Promise<void> {
  const startup = prepareAgentStartupContext({ env: process.env, log: logger });
  const databaseUrl = startup.config.postgresDatabaseUrl?.trim();
  const companionIdRaw = startup.config.companionId?.trim();
  if (!databaseUrl || !companionIdRaw) {
    throw new Error('ICP certification agent requires Postgres and a companion identity');
  }
  const companionId = createCompanionId(companionIdRaw, 'ICP certification companionId');
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
  if (startup.config.multiCompanion && !peer) {
    throw new Error('ICP certification agent requires exactly one peer fixture');
  }
  const peerContact = peer
    ? await contactStore.resolveChannelIdentity(
        'companion',
        peer.companionId,
        `Certification peer ${peer.companionId.slice(0, 4)}`,
      )
    : undefined;
  if (peerContact) {
    const machineIntelligenceApplied = await contactStore.setMachineIntelligence(
      peerContact.id,
      true,
      CERTIFICATION_CONTACT_FIXTURE_ACTOR,
    );
    if (!machineIntelligenceApplied) {
      throw new Error(`ICP certification failed to mark peer contact ${peerContact.id} as machine intelligence`);
    }
    const trustApplied = await contactStore.setTrustLevel(
      peerContact.id,
      'trusted',
      CERTIFICATION_CONTACT_FIXTURE_ACTOR,
    );
    if (!trustApplied) {
      throw new Error(`ICP certification failed to establish trusted peer contact ${peerContact.id}`);
    }
    const relationshipApplied = await contactStore.updateRelationshipType(
      peerContact.id,
      'ai_companion',
      CERTIFICATION_CONTACT_FIXTURE_ACTOR,
    );
    if (!relationshipApplied) {
      throw new Error(`ICP certification failed to establish AI companion relationship for ${peerContact.id}`);
    }
  }

  const llmProvider = createLLMProviderPort(gateway);
  const sessionRuntime = await composeSessionRuntimeAsync({
    config: startup.config,
    postgresDatabaseUrl: databaseUrl,
    eventBus: startup.eventBus,
    enableContinuity: true,
    continuityChannelIds: Object.keys(startup.channelsConfig.contextEnvelope.channels),
    sessionIntegrityProvider: gateway.createSessionIntegrityProvider(),
  });
  const identity = composeIdentity(startup.config);
  const characterPromptVariables = buildCharacterPromptTemplateVariables(identity.card);
  const personaPreamble = createPersonaPreambleService({
    registry: { getByKey: () => undefined },
    personaVariables: () => characterPromptVariables,
  });
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
    characterPromptVariables,
    config: startup.coreConfig,
    runtimeMode: 'gateway',
    fatigueBudget: fatigue.fatigueBudget,
    fatigueRegulationReservations: fatigueReservations,
    backgroundWorkStore: persistence.backgroundWorkStore,
    backgroundWorkTuning: startup.schedulerConfig.backgroundWork,
    backgroundWorkWelfare: startup.schedulerConfig.backgroundWorkWelfare,
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
    personaPreamble,
  });
  let failNextCompanionTurn = false;
  let failureObservationCount = 0;
  const certificationAgentLoop: GatewayMessageAgentLoop = {
    handleMessage: async (message, deliveryLifecycle) => {
      if (failNextCompanionTurn && message.channelType === 'companion') {
        failNextCompanionTurn = false;
        throw new Error('Controlled certification companion processing failure');
      }
      return await agent.handleMessage(message, deliveryLifecycle);
    },
    observeMessage: async (message) => {
      if (message.id.startsWith('companion-delivery-failure:')) {
        failureObservationCount += 1;
      }
      await agent.observeMessage(message);
    },
    waitForIdle: agent.waitForIdle.bind(agent),
    findRecordedIcpInitiation: agent.findRecordedIcpInitiation.bind(agent),
    findIcpDeliveryObservation: agent.findIcpDeliveryObservation.bind(agent),
    findRecordedCompanionSourceMessage: agent.findRecordedCompanionSourceMessage.bind(agent),
    recordIcpDeliveryObservation: agent.recordIcpDeliveryObservation.bind(agent),
    getCurrentTurnDisclosureLineage: agent.getCurrentTurnDisclosureLineage.bind(agent),
  };
  const registeredHandlers = registerGatewayMessageHandlers({
    eventBus: startup.eventBus,
    gateway,
    agentLoop: certificationAgentLoop,
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
      executeContinuation: async request => (
        await registeredHandlers.icpTargetChannelInitiator.continueDyad(request)
      ),
      executeHumanRelay: async request => (
        await registeredHandlers.icpTargetChannelInitiator.relayHumanIntent(request)
      ),
    },
  });
  const candidateStore = persistence.icpInitiationCandidateStore;
  const intentionRuntime = persistence.intentionRuntime;
  const weightedThoughtStore = persistence.weightedThoughtStore;
  if (!intentionRuntime || !weightedThoughtStore) {
    throw new Error('ICP certification agent requires durable intention stores');
  }
  const sourceWiring = wireIcpInitiationSources({
    config: startup.schedulerConfig.icpAutonomy,
    localCompanionId: companionId,
    candidateStore,
    feltImpulseFunnelStore: persistence.icpFeltImpulseFunnelStore,
    peers: autonomy,
    gateway,
    isExternalCompanionAuthorized: () => startup.capabilityRuntime.has('external.companion'),
    llmProvider,
    eventBus: startup.eventBus,
    pendingFollowUpStore: intentionRuntime.pendingFollowUpStore,
    concernStore: intentionRuntime.concernStore,
    socialDesireStore: persistence.socialDesireStore,
    presenceEnabled: false,
    contactStore,
    weightedThoughtStore,
    lifecycleConfig: startup.schedulerConfig.weightedThoughtOutreach.lifecycle,
  });
  const { runtimeEnablement, sourceRuntime, weightedThoughtCandidateAdapter } = sourceWiring;
  const scheduler = new Scheduler(startup.eventBus, { tickIntervalMs: 10 }, {
    eligibilityGate: startup.eligibilityGate,
  });
  const backgroundScheduler = new Scheduler(startup.eventBus, { tickIntervalMs: 10 }, {
    eligibilityGate: startup.eligibilityGate,
  });
  const postTurnActions = wirePostTurnActionRuntime({
    eventBus: startup.eventBus,
    scheduler,
    agentLoop: agent,
    eligibilityGate: startup.eligibilityGate,
    intervalMs: 1,
  });
  const fixedNotifyCatalogSource = 'extended' as const;
  const unregisterInitiationCandidates = sourceRuntime
    ? registerIcpInitiationCandidatePostTurnRuntime({
        agentLoop: agent,
        postTurnActions,
        runtime: sourceRuntime,
        resolveOriginCatalogSource: () => fixedNotifyCatalogSource,
        isExecutionAuthorized: () => runtimeEnablement.isEnabled()
          && startup.capabilityRuntime.has('external.companion'),
      })
    : () => undefined;
  registerWeightedThoughtOutreachTask({
    scheduler,
    eventBus: startup.eventBus,
    config: startup.schedulerConfig.weightedThoughtOutreach,
    quietHours: null,
    store: weightedThoughtStore,
    nudgeEvaluator: {
      evaluate: async () => {
        throw new Error('Companion weighted thoughts must route through the ICP adapter');
      },
    },
    ...(weightedThoughtCandidateAdapter ? { icpCandidateAdapter: weightedThoughtCandidateAdapter } : {}),
    channelPolicy: { primaryChannelType: 'discord' },
  });
  registerDurableBackgroundWorkSupervisorTask({
    scheduler: backgroundScheduler,
    agentLoop: agent,
    intervalMs: 10,
  });
  const presenceStore = persistence.companionPresenceStore;
  const presenceRuntime = presenceStore
    ? new CompanionPresenceRuntime({
        store: presenceStore,
        companionId,
        eventBus: startup.eventBus,
        placesRegistry: startup.placesRegistryConfig,
      })
    : undefined;
  if (presenceRuntime) {
    wireCompanionPresenceContext({
      agentLoop: agent,
      presenceRuntime,
      eventBus: startup.eventBus,
      sessionManager: sessionRuntime.sessionManager,
      placesRegistry: startup.placesRegistryConfig,
    });
  }
  const projectionStore = candidateStore && startup.config.multiCompanion === true
    ? await PostgresIcpAdminProjectionStore.connect(databaseUrl, {
        localCompanionId: companionId,
        knownCompanionIds: startup.config.companionFleet?.companions.map(entry => entry.companionId)
          ?? [companionId],
        config: startup.config,
      })
    : undefined;
  const gardenIcpAutonomy = candidateStore && projectionStore
    ? new AdminIcpAutonomyDataService({
        localCompanionId: companionId,
        candidateStore,
        feltImpulseFunnelStore: persistence.icpFeltImpulseFunnelStore,
        projectionStore,
        runtimeEnablement,
        settingsService: new AdminSettingsDataService({
          config: startup.config,
          configStore: createOwnerFileConfigStore({
            dataDir: startup.pathSnapshot.systemDataDir,
            companionDataDir: startup.pathSnapshot.companionDataDir,
            seedDir: process.env.CONFIG_DIR,
            defaultContextWindow: startup.config.defaultContextWindow,
          }),
          effectiveSchedulerConfig: startup.schedulerConfig,
        }),
        operatorLeaseTtlMs: startup.schedulerConfig.icpAutonomy.availability.operatorLeaseTtlMs,
      })
    : undefined;
  const autonomousTriggerEpoch = randomUUID();
  let autonomousTriggerIndex = 0;
  let preparedCertificationContinuation: {
    authorization: IcpDyadContinuationAuthorization;
    peerContactId: string;
  } | undefined;
  const compactionStore = createCompactionBoundaryStore(
    createIcpDeliveryProjectionStore(sessionRuntime.sessionStore),
  );
  let compactionMarkerIndex = 0;
  await startup.eventBus.emit('system.init', {});
  await startup.eventBus.emit('system.ready', {});
  if (!startup.config.chargePolicy) {
    throw new Error('ICP certification runtime requires chargePolicy');
  }
  const fleetPostureProvider = createAgentFleetPostureProvider({
    companionId: resolveCoreCompanionIdFromConfig(startup.config),
    chargePolicy: startup.config.chargePolicy,
    fatigueHistory: fatigue.fatigueLedger,
  });
  await gateway.startFleetPostureReporting(fleetPostureProvider);
  const icpRuntimeAvailability = startup.config.multiCompanion
    ? await startIcpRuntimeAvailability({
        eventBus: startup.eventBus,
        gateway,
        isEnabled: () => runtimeEnablement.isEnabled()
          && startup.capabilityRuntime.has('external.companion'),
        readFatigueState: () => fleetPostureProvider().fatigue.state,
      })
    : undefined;
  await gateway.declareRuntimeReady();
  backgroundScheduler.start();
  reply({
    ok: true,
    type: 'ready',
    result: {
      companionId,
      ...(peerContact ? { peerContactId: peerContact.id } : {}),
      postgresSchema: startup.config.postgresSchema,
      runtimeClass: agent.constructor.name,
      multiCompanion: startup.config.multiCompanion,
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
        if (raw.type === 'background_work_snapshot') {
          await agent.waitForIdle();
          const pending = await persistence.backgroundWorkStore.countPending();
          reply({ id: raw.id, ok: true, result: { pending } });
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
        if (raw.type === 'fail_next_companion_turn') {
          if (!startup.config.multiCompanion) {
            throw new Error('Controlled companion failure requires multi-companion mode');
          }
          failNextCompanionTurn = true;
          reply({ id: raw.id, ok: true, result: { armed: true } });
          return;
        }
        if (raw.type === 'failure_observation_snapshot') {
          await agent.waitForIdle();
          reply({ id: raw.id, ok: true, result: { failureObservationCount } });
          return;
        }
        if (raw.type === 'enter_private_room') {
          if (!presenceRuntime) throw new Error('Private-room presence requires multi-companion mode');
          await presenceRuntime.recordDeliberateMove({
            siteId: 'certification',
            placeId: 'certification_private_room',
            kind: 'virtual',
          });
          reply({ id: raw.id, ok: true, result: presenceRuntime.getOwnPresenceWindow() });
          return;
        }
        if (raw.type === 'send_room_probe') {
          const result = await gateway.companionSend(
            CERTIFICATION_PRIVATE_ROOM,
            `Certification ${raw.phase.replace('_', '-')} room probe.`,
            identity.card.data.name,
          );
          reply({ id: raw.id, ok: true, result });
          return;
        }
        if (raw.type === 'run_free_time_notification') {
          if (!sourceRuntime) throw new Error('ICP autonomy is disabled by scheduler.json');
          if (!candidateStore || !peerContact) {
            throw new Error('ICP autonomy requires multi-companion candidate ownership');
          }
          const candidateIdsBefore = new Set(
            (await candidateStore.listCandidates({ limit: 50 })).map(candidate => candidate.candidateId),
          );
          autonomousTriggerIndex += 1;
          const turnId = `free-time-notify-${autonomousTriggerEpoch}-${autonomousTriggerIndex}`;
          const toolCallId = `notify-${autonomousTriggerEpoch}-${autonomousTriggerIndex}`;
          const notify = createNotifyTool({
            dispatch: async () => {
              throw new Error('Companion candidate notification must not dispatch during tool execution');
            },
          }, {
            companionCandidateEnabled: true,
            isCompanionCandidateAuthorized: () => runtimeEnablement.isEnabled()
              && startup.capabilityRuntime.has('external.companion'),
          });
          const params = {
            action: 'consider' as const,
            target_kind: 'companion' as const,
            contact_id: peerContact.id,
            reason_summary: 'Private free-time certification motivation',
          };
          const toolResult = await notify.execute(toolCallId, params);
          const toolText = toolResult.content.map(part => (
            part.type === 'text' ? part.text : ''
          )).join('');
          if (toolText !== COMPANION_CANDIDATE_QUEUED_TEXT || toolResult.details?.isError) {
            throw new Error(`Free-time notification was not queued: ${toolText}`);
          }
          const message = {
            id: turnId,
            channelId: 'internal:free-time:idle',
            channelType: 'terminal' as const,
            authorId: 'scheduler',
            authorName: 'Free Time',
            content: 'Run the bounded free-time notification adapter.',
            timestamp: new Date(),
          };
          const candidates = inferIcpInitiationCandidateActions({
            message,
            response: {} as never,
            turnMessages: [
              {
                role: 'assistant',
                content: [{ type: 'toolCall', id: toolCallId, name: 'notify', arguments: params }],
              },
              {
                role: 'toolResult',
                toolCallId,
                toolName: 'notify',
                isError: false,
                content: [{ type: 'text', text: toolText }],
              },
            ] as never,
            turnId: turnId as never,
            completedAt: Date.now(),
            capturedSessionReads: {} as never,
          }, fixedNotifyCatalogSource);
          const action = toInferredPostTurnActions(candidates, message)[0]!;
          await startup.eventBus.emit('agent.post_turn.actions.inferred', {
            message,
            response: {
              content: '',
              channelId: message.channelId,
              metadata: { model: 'scheduler:free-time', inputTokens: 0, outputTokens: 0, durationMs: 0 },
            },
            actions: [action],
          });
          await scheduler.tick();
          const status = postTurnActions.getActionStatus(action.id);
          const candidateId = (await candidateStore.listCandidates({ limit: 50 })).find(candidate => (
            !candidateIdsBefore.has(candidate.candidateId) && candidate.source === 'free_time'
          ))?.candidateId;
          if (!candidateId) throw new Error('Free-time candidate was not persisted');
          const candidate = await candidateStore.getCandidate(candidateId);
          if (!candidate) throw new Error('Free-time candidate disappeared after persistence');
          let senderExchange: Record<string, string> | undefined;
          if (candidate.deliveryDisposition === 'delivered') {
            const channelId = composeCompanionDmChannelId(
              companionId,
              createCompanionId(candidate.peerCompanionId, 'candidate peerCompanionId'),
            );
            const sourceMessageId = `icp-initiation:${candidate.candidateId}`;
            const observation = await agent.findIcpDeliveryObservation(channelId, sourceMessageId);
            const response = observation?.recoveryResponse;
            if (!response?.content.trim() || !response.metadata.icpCorrelation) {
              throw new Error('Delivered free-time candidate is missing its durable sender response');
            }
            const correlation = parseIcpConversationCorrelation(
              response.metadata.icpCorrelation,
            );
            const senderRecord = sessionRuntime.sessionStore.findTurnRecord(
              channelId,
              correlation.turnId,
            );
            if (!senderRecord || senderRecord.requestId !== correlation.requestId) {
              throw new Error('Delivered free-time candidate is missing its durable sender record');
            }
            senderExchange = {
              channelId,
              conversationId: correlation.conversationId,
              rootInitiationId: correlation.rootInitiationId,
              senderRequestId: senderRecord.requestId,
              senderTurnId: senderRecord.turnId,
              recipientRequestId: deriveIcpTransportMessageId(correlation),
            };
          }
          reply({
            id: raw.id,
            ok: true,
            result: {
              ...projectCandidate(candidate),
              postTurnStatus: status?.state,
              ...(senderExchange ? { senderExchange } : {}),
            },
          });
          return;
        }
        if (raw.type === 'run_dyad_certification_action') {
          if (!peer || !peerContact) {
            throw new Error('Dyad certification actions require a canonical peer');
          }
          if (raw.action === 'list') {
            reply({ id: raw.id, ok: true, result: { dyads: await autonomy.listDyads() } });
            return;
          }
          const dyadId = typeof raw.input.dyadId === 'string' ? raw.input.dyadId : '';
          if (raw.action === 'transition') {
            const action = raw.input.action;
            const expectedRevision = raw.input.expectedRevision;
            if ((action !== 'close' && action !== 'block' && action !== 'unblock')
              || typeof expectedRevision !== 'number') {
              throw new Error('Dyad certification transition input is malformed');
            }
            const result = await autonomy.transitionDyad({ dyadId, action, expectedRevision });
            reply({ id: raw.id, ok: true, result });
            return;
          }
          const deliveryId = randomUUID();
          const conversationId = randomUUID();
          if (raw.action === 'prepare') {
            const prepared = await gateway.companionPrepareDyadContinuation({
              dyadId,
              deliveryId,
              conversationId,
              peerContactId: peerContact.id,
              initiationSource: 'foreground',
            });
            if (prepared.status === 'authorized') {
              preparedCertificationContinuation = {
                authorization: prepared.authorization,
                peerContactId: peerContact.id,
              };
            }
            reply({ id: raw.id, ok: true, result: prepared });
            return;
          }
          if (raw.action === 'deliver_prepared') {
            if (!preparedCertificationContinuation) {
              throw new Error('No certification continuation is queued');
            }
            const result = await registeredHandlers.icpTargetChannelInitiator.continueDyad({
              ...preparedCertificationContinuation,
              privateIntent: 'Deliver the queued certification continuation.',
            });
            reply({ id: raw.id, ok: true, result });
            return;
          }
          if (raw.action === 'continue') {
            const result = await autonomy.executeDyadContinuation({
              dyadId,
              deliveryId,
              conversationId,
              privateIntent: 'Send one ordinary permit-free certification continuation.',
              initiationSource: 'foreground',
            });
            reply({ id: raw.id, ok: true, result: { ...result, deliveryId } });
            return;
          }
          const siblingChannelId = 'discord:dm:invented-sibling';
          const siblingSecret = 'INVENTED_SIBLING_TRANSCRIPT_DO_NOT_EXFILTRATE';
          const adjacentSecret = 'INVENTED_ADJACENT_SOURCE_SECRET_DO_NOT_EXFILTRATE';
          sessionRuntime.sessionStore.append({
            channelId: siblingChannelId,
            role: 'user',
            content: siblingSecret,
            authorId: 'invented-sibling-human',
            authorName: 'Invented Sibling Human',
            timestamp: Date.now(),
            channelVisibility: 'private',
          });
          const owned = await autonomy.inspectOpenDyad(dyadId);
          const nowMs = Date.now();
          const intent = 'Would you like to meet in the invented library tomorrow?';
          const capsule = await createHumanRelayIntentCapsule({
            capsuleId: randomUUID(),
            intent,
            sourceMessage: `Please relay exactly: ${intent} ${adjacentSecret}`,
            source: {
              companionId,
              channelId: 'discord:dm:invented-requester',
              turnId: randomUUID(),
              requestId: 'invented-relay-source-request',
              messageId: 'invented-relay-source-message',
              humanParticipantId: 'discord-user:invented-requester',
              humanContactId: 'contact:invented-requester',
              requesterKind: 'human',
            },
            target: {
              companionId: peer.companionId,
              peerContactId: peerContact.id,
              dyadId: owned.dyadId,
              channelId: owned.channelId,
              participantCompanionIds: [companionId, peer.companionId],
            },
            issuedAtMs: nowMs,
            expiresAtMs: nowMs + 60_000,
            sourceGate: binding => ({
              authorized: true,
              boundary: 'source_egress',
              bindingHash: binding.bindingHash,
              policyRef: 'cogsec:invented-certification-source',
              provenanceRefs: ['turn:invented-relay-source'],
              disclosureCeiling: 'stated_intent_only',
              decidedAtMs: nowMs,
            }),
          });
          const result = await autonomy.executeHumanRelay({
            dyadId,
            deliveryId,
            conversationId,
            capsule,
          });
          reply({
            id: raw.id,
            ok: true,
            result: {
              ...result,
              capsule,
              intent,
              siblingChannelId,
              siblingSecret,
              adjacentSecret,
            },
          });
          return;
        }
        if (raw.type === 'retry_candidate_delivery') {
          if (!candidateStore) {
            throw new Error('ICP delivery recovery requires multi-companion candidate ownership');
          }
          const candidate = await candidateStore.getCandidate(raw.candidateId);
          if (!candidate || candidate.status !== 'consumed' || !candidate.permitId) {
            throw new Error('ICP delivery recovery requires a consumed candidate with a permit');
          }
          if (candidate.preferredChannel !== 'dm') {
            throw new Error('Certification delivery recovery currently requires a companion DM');
          }
          const channelId = composeCompanionDmChannelId(
            companionId,
            createCompanionId(candidate.peerCompanionId, 'candidate peerCompanionId'),
          );
          const sourceMessageId = `icp-initiation:${candidate.candidateId}`;
          const observation = await agent.findIcpDeliveryObservation(channelId, sourceMessageId);
          const response = observation?.recoveryResponse;
          if (!response?.content.trim() || !response.metadata.icpCorrelation) {
            throw new Error('ICP delivery recovery requires a durable sender response');
          }
          const correlation = parseIcpConversationCorrelation(response.metadata.icpCorrelation);
          const result = await gateway.companionSendInitiation({
            channelId,
            content: response.content,
            authorName: identity.card.data.name,
            permitId: candidate.permitId,
            conversationId: correlation.conversationId,
            recipientCompanionId: candidate.peerCompanionId,
            correlation,
          });
          reply({ id: raw.id, ok: true, result: { disposition: 'delivered', ...result } });
          return;
        }
        if (raw.type === 'run_weighted_thought_scheduler') {
          if (!sourceRuntime || !weightedThoughtCandidateAdapter) {
            throw new Error('ICP autonomy is disabled by scheduler.json');
          }
          if (!candidateStore || !peerContact) {
            throw new Error('Weighted-thought autonomy requires multi-companion candidate ownership');
          }
          autonomousTriggerIndex += 1;
          const thoughtId = `certification-weighted-${autonomousTriggerEpoch}-${autonomousTriggerIndex}`;
          const candidateIdsBefore = new Set(
            (await candidateStore.listCandidates({ limit: 50 })).map(candidate => candidate.candidateId),
          );
          await weightedThoughtStore.save(createThoughtWeight({
            id: thoughtId,
            content: 'Private weighted-thought certification motivation',
            source: 'certification_co_location',
            thoughtClass: 'standard',
            contactId: peerContact.id,
            provenance: { coLocationRef: `certification:${autonomousTriggerIndex}` },
            relationshipMultiplier: 2,
            emotionalIntensity: 1,
          }, startup.schedulerConfig.weightedThoughtOutreach.lifecycle, Date.now()));
          const task = scheduler.getTask(WEIGHTED_THOUGHT_OUTREACH_TASK_ID);
          if (!task) throw new Error('Weighted-thought production scheduler task is not registered');
          await task.handler();
          const candidate = (await candidateStore.listCandidates({ limit: 50 })).find(entry => (
            !candidateIdsBefore.has(entry.candidateId) && entry.source === 'weighted_thought'
          ));
          if (!candidate) throw new Error('Weighted-thought scheduler did not persist a candidate');
          reply({ id: raw.id, ok: true, result: projectCandidate(candidate) });
          return;
        }
        if (raw.type === 'run_recursive_weighted_thought_scheduler') {
          if (!sourceRuntime || !weightedThoughtCandidateAdapter) {
            throw new Error('ICP autonomy is disabled by scheduler.json');
          }
          if (!candidateStore || !peer || !peerContact) {
            throw new Error('Recursive autonomy probe requires multi-companion candidate ownership');
          }
          autonomousTriggerIndex += 1;
          const thoughtId = `certification-recursive-${autonomousTriggerEpoch}-${autonomousTriggerIndex}`;
          const candidateIdsBefore = new Set(
            (await candidateStore.listCandidates({ limit: 50 })).map(candidate => candidate.candidateId),
          );
          await weightedThoughtStore.save(createThoughtWeight({
            id: thoughtId,
            content: 'Private recursive weighted-thought certification probe',
            source: 'certification_icp_reply',
            thoughtClass: 'standard',
            contactId: peerContact.id,
            provenance: {
              icpRootInitiationId: raw.rootInitiationId,
              sourceChannelId: composeCompanionDmChannelId(companionId, peer.companionId),
              sourceChannelType: 'companion',
            },
            relationshipMultiplier: 2,
            emotionalIntensity: 1,
          }, startup.schedulerConfig.weightedThoughtOutreach.lifecycle, Date.now()));
          const task = scheduler.getTask(WEIGHTED_THOUGHT_OUTREACH_TASK_ID);
          if (!task) throw new Error('Weighted-thought production scheduler task is not registered');
          await task.handler();
          const candidate = (await candidateStore.listCandidates({ limit: 50 })).find(entry => (
            !candidateIdsBefore.has(entry.candidateId) && entry.source === 'weighted_thought'
          ));
          if (!candidate) throw new Error('Recursive weighted-thought scheduler did not persist a candidate');
          reply({ id: raw.id, ok: true, result: projectCandidate(candidate) });
          return;
        }
        if (raw.type === 'run_room_weighted_thought_scheduler') {
          if (!sourceRuntime || !weightedThoughtCandidateAdapter) {
            throw new Error('ICP autonomy is disabled by scheduler.json');
          }
          if (!candidateStore || !peerContact) {
            throw new Error('Room autonomy requires multi-companion candidate ownership');
          }
          if (!presenceRuntime
            || presenceRuntime.getOwnPresenceWindow()?.place.placeId !== 'certification_private_room') {
            throw new Error('Room weighted-thought scheduler requires current private-room presence');
          }
          autonomousTriggerIndex += 1;
          const thoughtId = `certification-room-weighted-${autonomousTriggerEpoch}-${autonomousTriggerIndex}`;
          const candidateIdsBefore = new Set(
            (await candidateStore.listCandidates({ limit: 50 })).map(candidate => candidate.candidateId),
          );
          await weightedThoughtStore.save(createThoughtWeight({
            id: thoughtId,
            content: 'Private room weighted-thought certification motivation',
            source: 'certification_room_co_location',
            thoughtClass: 'standard',
            contactId: peerContact.id,
            provenance: {
              coLocationRef: `certification-room:${autonomousTriggerIndex}`,
              sourceChannelId: CERTIFICATION_PRIVATE_ROOM,
              sourceChannelType: 'companion',
            },
            relationshipMultiplier: 2,
            emotionalIntensity: 1,
          }, startup.schedulerConfig.weightedThoughtOutreach.lifecycle, Date.now()));
          const task = scheduler.getTask(WEIGHTED_THOUGHT_OUTREACH_TASK_ID);
          if (!task) throw new Error('Weighted-thought production scheduler task is not registered');
          await task.handler();
          const candidate = (await candidateStore.listCandidates({ limit: 50 })).find(entry => (
            !candidateIdsBefore.has(entry.candidateId) && entry.source === 'weighted_thought'
          ));
          if (!candidate) throw new Error('Room weighted-thought scheduler did not persist a candidate');
          reply({ id: raw.id, ok: true, result: projectCandidate(candidate) });
          return;
        }
        if (raw.type === 'garden_emergency_disable') {
          if (!gardenIcpAutonomy) {
            throw new Error('Garden ICP autonomy is unavailable in single-companion mode');
          }
          const result = await gardenIcpAutonomy.emergencyDisable();
          const current = await autonomy.readOwnAvailability();
          reply({
            id: raw.id,
            ok: true,
            result: {
              ...result,
              enabled: runtimeEnablement.isEnabled(),
              lease: current.lease,
            },
          });
          return;
        }
        if (raw.type === 'channel_snapshot') {
          await agent.waitForIdle();
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
        if (raw.type === 'served_channel_snapshot') {
          await agent.waitForIdle();
          const snapshot = await sessionRuntime.sessionManager.captureTurnSessionContext({
            channelId: raw.channelId,
            llmProvider,
          });
          reply({
            id: raw.id,
            ok: true,
            result: {
              recentEntries: snapshot.recentEntries,
              roomWindowFloorMs: snapshot.roomWindowFloorMs,
              roomWindowFilteredEntryCount: snapshot.roomWindowFilteredEntryCount ?? 0,
              sourceEntryCount: snapshot.sourceEntryCount ?? 0,
            },
          });
          return;
        }
        if (raw.type === 'turn_records_snapshot') {
          await agent.waitForIdle();
          const records = sessionRuntime.sessionStore.getRecentTurnRecords(raw.channelId, 100);
          reply({
            id: raw.id,
            ok: true,
            result: {
              records: records.map(record => ({
                turnId: record.turnId,
                requestId: record.requestId,
                status: record.status,
                hasAssistantMessage: record.assistantMessage !== undefined,
                ...(record.icpCorrelation
                  ? {
                      correlation: {
                        conversationId: record.icpCorrelation.conversationId,
                        rootInitiationId: record.icpCorrelation.rootInitiationId,
                        localCompanionId: record.icpCorrelation.localCompanionId,
                        peerCompanionId: record.icpCorrelation.peerCompanionId,
                        channelId: record.icpCorrelation.channelId,
                        turnId: record.icpCorrelation.turnId,
                        requestId: record.icpCorrelation.requestId,
                        fatigueDecision: record.icpCorrelation.fatigueDecision,
                        ...(record.icpCorrelation.fatigueReasonCode
                          ? { fatigueReasonCode: record.icpCorrelation.fatigueReasonCode }
                          : {}),
                      },
                    }
                  : {}),
              })),
            },
          });
          return;
        }
        if (raw.type === 'has_completed_fatigue_suppression') {
          await agent.waitForIdle();
          const completed = sessionRuntime.sessionStore
            .getRecentTurnRecords(raw.channelId, 100)
            .some(record => (
              record.status === 'completed'
              && record.icpCorrelation?.rootInitiationId === raw.rootInitiationId
              && record.icpCorrelation.fatigueDecision === 'suppress'
            ));
          reply({ id: raw.id, ok: true, result: { completed } });
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
                compactedCount: recent.length - compaction.recent.length,
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
        icpRuntimeAvailability?.stop();
        unregisterInitiationCandidates();
        sourceWiring.unregisterCoLocationThoughtAdapter();
        await scheduler.stop();
        await backgroundScheduler.stop();
        await agent.stopBackgroundWork();
        gateway.destroy();
        await gardenIcpAutonomy?.close();
        await presenceRuntime?.shutdown();
        await fatigueReservations.close();
        await persistence.backgroundWorkStore.close();
        await persistence.automataBusStore.close();
        await persistence.automataRunRegistry.close();
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
