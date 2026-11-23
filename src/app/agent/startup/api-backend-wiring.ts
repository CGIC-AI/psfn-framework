// ── Agent API backend, charge ledger, ICP authority & relay wiring ──
//
// Extracted from app/agent/main.ts (Phase 4.3 decomposition): owns the
// gateway-hosted API backend, durable charge ledger, welfare-grant authority,
// fleet ICP policy/posture wiring, and companion relay / queue-change forwarding.

import type { GatewayClient } from '../../../boundary/gateway/client.js';
import { createRequestCapabilityVerifier } from '../../../boundary/fleet-auth/request-capability.js';
import { resolveActiveHealthProbeConfig } from '../../../channels/api/active-health-probe.js';
import { AgentApiBackend } from '../../../channels/api/agent-backend.js';
import { attachCompanionEventForwarder } from '../../../channels/backplane/companion-relay/agent-forwarder.js';
import {
  buildExternalChannelProfiles,
  resolveDiscordCompanionView,
  type RuntimeChannelsConfig,
} from '../../../channels/backplane/config.js';
import { resolveTestingHarnessDevicesConfig } from '../../../channels/backplane/testing-harness-devices.js';
import type { LLMProviderPort } from '../../../core/agent/contracts.js';
import { IcpLocalInitiationCapacityAuthority } from '../../../core/agent/fatigue/initiation-capacity.js';
import { resolveSharedSatelliteFatigueEligibility } from '../../../core/agent/fatigue/shared-satellite-eligibility.js';
import type { SubstrateAgent } from '../../../core/agent/substrate-agent.js';
import type { ContactStorePort } from '../../../core/contacts/contact-store-port.js';
import { resolveCoreCompanionIdFromConfig } from '../../../core/identity/companion-runtime.js';
import type { Scheduler } from '../../../core/scheduler/scheduler.js';
import type { SessionManager } from '../../../core/session/manager.js';
import { resolveDocumentIngestLimits } from '../../../faculties/file-ingest/index.js';
import type { MemoryStorePort } from '../../../faculties/memory/memory-store-port.js';
import type { wireShardAndThinkRuntime } from '../../startup/composition/composition.js';
import { resolveChargeLedgerPath } from '../../../persistence/layout.js';
import type { AgentPersistenceRuntime } from '../../../persistence/runtime-factory.js';
import { PostgresIcpLocalPolicyAuthority } from '../../../persistence/postgres/icp-local-policy-authority.js';
import type { SatelliteRegistryConfig } from '../../../shared/contracts/satellite-registry.js';
import type { EventBus } from '../../../shared/event-bus.js';
import { emitGardenQueueChanged } from '../../../shared/garden-queue-change.js';
import {
  RunChargeLedger,
  readRunChargeRollingWindowFromLedger,
} from '../../../shared/telemetry/charge-ledger.js';
import type { CapabilityRuntime } from '../../../system/capabilities/runtime.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import type { SchedulerRuntimeConfig } from '../../../system/config/scheduler-config.js';
import { buildApiHealthChecks, resolveAgentApiSurfaceBindings } from '../api-surface.js';
import type { AgentCoreRuntime } from '../core-runtime.js';
import { createAgentFleetPostureProvider } from '../fleet-posture.js';
import { reconcileIcpAppraisalFailureClosures } from '../icp-appraisal-failure-reconciliation.js';
import {
  startIcpRuntimeAvailability,
  type AgentIcpRuntimeAvailability,
  type IcpRuntimeAvailabilityLane,
} from '../icp-runtime-availability.js';
import type { maybeCreateIntakeScreeningService } from '../../../core/cogsec/intake/screening.js';

interface AgentApiBackendWiringDeps {
  config: SubstrateConfig;
  channelsConfig: RuntimeChannelsConfig;
  schedulerConfig: SchedulerRuntimeConfig;
  satelliteRegistryConfig: SatelliteRegistryConfig;
  companionDataDir: string;
  workspaceRoot: string;
  env: NodeJS.ProcessEnv;
  gateway: GatewayClient;
  agentLoop: SubstrateAgent;
  eventBus: EventBus;
  sessionManager: SessionManager;
  llmProvider: LLMProviderPort;
  contactStore: ContactStorePort;
  memoryStore: MemoryStorePort;
  scheduler: Scheduler;
  shardManager: ReturnType<typeof wireShardAndThinkRuntime>;
  capabilityRuntime: CapabilityRuntime;
  backgroundWorkStore: AgentPersistenceRuntime['backgroundWorkStore'];
  fatigueLedger: AgentCoreRuntime['fatigueLedger'];
  intakeScreening: ReturnType<typeof maybeCreateIntakeScreeningService>;
  icpRuntimeEnablement: { isEnabled(): boolean };
  runtimeStatusMeta: Parameters<typeof buildApiHealthChecks>[0]['runtimeStatusMeta'];
  log: { error(message: string, payload?: Record<string, unknown>): void };
}

interface AgentApiBackendRuntime {
  apiHost: string | undefined;
  apiPort: number | undefined;
  adminPort: number | undefined;
  discordChannelView: ReturnType<typeof resolveDiscordCompanionView>;
  chargeLedger: RunChargeLedger;
  icpLocalPolicyAuthority: PostgresIcpLocalPolicyAuthority | null;
  icpRuntimeAvailability: AgentIcpRuntimeAvailability;
  apiBackend: AgentApiBackend;
  detachCompanionEventForwarder: () => void;
  detachGatewayQueueChange: () => void;
}

export async function wireAgentApiBackend(
  deps: AgentApiBackendWiringDeps,
): Promise<AgentApiBackendRuntime> {
  const {
    config,
    channelsConfig,
    schedulerConfig,
    satelliteRegistryConfig,
    companionDataDir,
    workspaceRoot,
    env,
    gateway,
    agentLoop,
    eventBus,
    sessionManager,
    llmProvider,
    contactStore,
    memoryStore,
    scheduler,
    shardManager,
    capabilityRuntime,
    backgroundWorkStore,
    fatigueLedger,
    intakeScreening,
    icpRuntimeEnablement,
    runtimeStatusMeta,
    log,
  } = deps;

  const { apiHost, apiPort, adminPort } = resolveAgentApiSurfaceBindings(env);
  const apiHealthChecks = buildApiHealthChecks({
    config,
    memoryStore,
    gateway,
    scheduler,
    runtimeStatusMeta,
  }, resolveActiveHealthProbeConfig(env));
  const localCompanionId = resolveCoreCompanionIdFromConfig(config);
  const discordChannelView = resolveDiscordCompanionView(
    channelsConfig.discord,
    localCompanionId,
  );
  const chargeLedgerPath = resolveChargeLedgerPath(companionDataDir);
  const chargeLedger = await RunChargeLedger.open(
    chargeLedgerPath,
    eventBus,
    { readLimitSettings: config },
  );

  gateway.onWelfareGrantAuthority({
    verify: async (jobId: string): Promise<boolean> => {
      const job = await backgroundWorkStore.get(jobId);
      return job !== null && job.state === 'running' && job.welfareClaimed === true;
    },
  });

  let icpLocalPolicyAuthority: PostgresIcpLocalPolicyAuthority | null = null;
  let icpRuntimeAvailabilityLane: IcpRuntimeAvailabilityLane | null = null;
  if (config.multiCompanion === true) {
    if (!config.chargePolicy) {
      throw new Error('Multi-companion fleet posture requires chargePolicy');
    }
    const databaseUrl = config.postgresDatabaseUrl?.trim();
    const postgresSchema = config.postgresSchema?.trim();
    const postgresRole = config.postgresRole?.trim();
    if (!databaseUrl || !postgresSchema || !postgresRole) {
      throw new Error('Companion-local ICP policy requires tenant PostgreSQL wiring');
    }
    const capacityAuthority = new IcpLocalInitiationCapacityAuthority(
      {
        read: ({ senderCompanionId }) => {
          if (senderCompanionId !== localCompanionId) {
            throw new Error('ICP local charge policy requested for another companion');
          }
          return config.chargePolicy!;
        },
      },
      {
        read: ({ senderCompanionId, nowMs }) => {
          if (senderCompanionId !== localCompanionId) {
            throw new Error('ICP local charge balance requested for another companion');
          }
          return readRunChargeRollingWindowFromLedger(chargeLedgerPath, nowMs, config);
        },
      },
    );
    icpLocalPolicyAuthority = new PostgresIcpLocalPolicyAuthority(databaseUrl, {
      companionId: localCompanionId,
      postgresSchema,
      postgresRole,
      companionDataDir,
      policyHolds: schedulerConfig.icpAutonomy.policyHolds,
      capacityAuthority,
    });
    try {
      await icpLocalPolicyAuthority.assertReady();
      gateway.onIcpLocalPolicyAuthority(icpLocalPolicyAuthority);
      gateway.markIcpLocalPolicyAuthorityReady();
    } catch (error) {
      await icpLocalPolicyAuthority.close();
      throw error;
    }
    const fleetPostureProvider = createAgentFleetPostureProvider({
      companionId: localCompanionId,
      chargePolicy: config.chargePolicy,
      fatigueHistory: fatigueLedger,
    });
    await gateway.startFleetPostureReporting(fleetPostureProvider);
    void reconcileIcpAppraisalFailureClosures({
      sessions: sessionManager,
      endEpisodeActivity: endInput => gateway.companionEndIcpEpisodeActivity(endInput),
      windowMs: config.chargePolicy.fatigue.socialRegulation.relationshipPressureWindowMs,
      nowMs: Date.now(),
    }).catch((error: unknown) => {
      log.error('ICP appraisal-failure closure reconciliation failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    icpRuntimeAvailabilityLane = {
      gateway,
      isEnabled: () => icpRuntimeEnablement.isEnabled()
        && capabilityRuntime.has('external.companion'),
      readFatigueState: () => fleetPostureProvider().fatigue.state,
    };
  }

  const icpRuntimeAvailability = await startIcpRuntimeAvailability({
    eventBus,
    lane: icpRuntimeAvailabilityLane,
  });
  agentLoop.setDurableChargeRecorder(
    event => chargeLedger.commitChargeEvent(event).outcome,
    event => chargeLedger.probeChargeEvent(event),
  );

  const apiBackend = new AgentApiBackend({
    agentLoop,
    eventBus,
    sessionManager,
    llmProvider,
    contactStore,
    healthChecks: apiHealthChecks,
    externalChannelProfiles: buildExternalChannelProfiles(channelsConfig),
    satelliteRegistry: satelliteRegistryConfig,
    ...(resolveTestingHarnessDevicesConfig(channelsConfig.api.testingHarness !== undefined, env)
      ? { testingHarnessDevices: { enabled: true as const } }
      : {}),
    companionId: localCompanionId,
    shardDirectory: shardManager.shardDirectory,
    ...(config.fleetAuthVerifier
      ? {
          requestCapabilityVerifier: createRequestCapabilityVerifier(
            config.fleetAuthVerifier.requestCapabilities,
          ),
        }
      : {}),
    onStreamDelta: (requestId, text) => gateway.notifyApiStreamDelta(requestId, text),
    documentIngest: {
      personalFilesDir: workspaceRoot,
      intakeScreening,
      limits: resolveDocumentIngestLimits(config),
    },
  });
  gateway.onApiChatCompletion((params) => apiBackend.handleChatCompletion(params));
  gateway.onApiChatCancel((params) => apiBackend.cancelChatCompletion(params));
  gateway.onCompanionUiShardActions({
    hubAttachment: (params) => apiBackend.handleCompanionUiShardAction(params),
    operatorKey: (params) => apiBackend.handleCompanionUiKeyShardAction(params),
  });
  gateway.onShardOwner((params) => Promise.resolve(apiBackend.handleShardOwner(params)));
  gateway.onApiTelemetryIngest((params) => apiBackend.handleTelemetryIngest(params));
  gateway.onApiHealth(() => apiBackend.handleHealth());
  gateway.onSatelliteResponseEligibility(async ({ canonicalContactId, channelId }) => (
    resolveSharedSatelliteFatigueEligibility({
      fatigueLedger,
      localCompanionId,
      canonicalContactId,
      channelId,
    })
  ));
  gateway.onTurnPerformance(async (event) => {
    await eventBus.emit('agent.turn.performance', event);
  });

  const detachCompanionEventForwarder = attachCompanionEventForwarder({
    eventBus,
    publisher: gateway,
  });
  const detachGatewayQueueChange = gateway.onGardenQueueChanged((queue) => {
    emitGardenQueueChanged(eventBus, queue);
  });

  return {
    apiHost,
    apiPort,
    adminPort,
    discordChannelView,
    chargeLedger,
    icpLocalPolicyAuthority,
    icpRuntimeAvailability,
    apiBackend,
    detachCompanionEventForwarder,
    detachGatewayQueueChange,
  };
}
