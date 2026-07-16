import { createComponentLogger } from '../../shared/logger.js';
import {
  createDiscordLifecycleNotifier,
  type LifecycleNotifier,
  type MessageSender,
} from '../../system/lifecycle/notifications.js';
import { resolveRuntimeCommandInvocation, type RuntimeModeContract } from '../../system/lifecycle/runtime-mode.js';
import { createSystemTool, runRepoLifecycleBuildCommand } from '../../core/tools/lifecycle.js';
import {
  createGatewayDiscordNotifySender,
  createNotifyDispatcher,
  createNotifyTool,
  type NotificationPort,
} from '../../core/tools/ntfy.js';
import {
  createRetryableShutdown,
  runShutdownSequence,
  runShutdownStep,
} from '../startup/support/shutdown-helpers.js';
import { parsePositiveIntEnv } from '../../shared/utils/env.js';
import type { EventBus } from '../../shared/event-bus.js';
import type { Scheduler } from '../../core/scheduler/scheduler.js';
import type { ModuleLoader } from '../../system/modules/loader.js';
import type { MemoryExtractor } from '../../faculties/memory/extraction.js';
import type { GatewayClient } from '../../boundary/gateway/client.js';
import type { CapabilityRuntime } from '../../system/capabilities/runtime.js';
import type { LifecycleRestartSafeguard, ExternalCommunicationRateLimiter } from '../../system/capabilities/safeguards.js';
import type { SubstrateAgent } from '../../core/agent/substrate-agent.js';
import type { ApiServer } from '../../channels/api/server.js';
import type { Lifecycle } from '../../shared/contracts/runtime.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { PostTurnActionRuntime } from '../../core/agent/post-turn-action-runtime.js';
import type { AgentFacingIcpAutonomyRuntime } from '../../core/icp/agent-facing-autonomy.js';
import { resolveIcpAutonomyCandidateSchedulerOrigin } from '../../core/icp/candidate-scheduler-origin.js';
import type { RunChargeLedger } from '../../shared/telemetry/charge-ledger.js';
import {
  isDeferredCompanionOutreachExecutionAuthorized,
  registerDeferredCompanionOutreachRuntime,
  resolveCompanionOutreachOriginCatalogSource,
  type DeferredCompanionOutreachAuthorizationRuntime,
} from '../../core/tools/notify-companion-handoff.js';
import {
  createIcpAutonomyCandidateDispatcher,
  type IcpAutonomyCandidateDispatcher,
} from './icp-autonomy-candidate-dispatcher.js';
import { registerIcpInitiationCandidatePostTurnRuntime } from '../../core/tools/notify-companion-candidate.js';
import type { IcpInitiationSourceRuntime } from '../../core/icp/initiation-source-runtime.js';

const log = createComponentLogger('AgentControlPlane');
const DEFAULT_EXTRACTION_DRAIN_TIMEOUT_MS = 10_000;

export interface AgentControlPlaneShutdownTargets {
  apiServer?: ApiServer;
  adminTransport?: Lifecycle;
  appCache?: { close?: () => Promise<void> };
  fatigueRegulationReservations?: { close: () => Promise<void> };
  chargeLedger?: Pick<RunChargeLedger, 'close'>;
  sessionTailCache?: { close?: () => Promise<void> } | null;
}

export interface BuildAgentControlPlaneOptions {
  heartbeatChannelId?: string;
  dataDir: string;
  config: SubstrateConfig;
  eventBus: EventBus;
  gateway: GatewayClient;
  unregisterGatewayDisconnect: () => void;
  stopDebugObserver: () => void;
  writeGracefulShutdownMarkers: () => void;
  closeDatabase: () => Promise<void> | void;
  scheduler: Scheduler;
  moduleLoader: ModuleLoader;
  memoryExtractor: MemoryExtractor;
  agentLoop: SubstrateAgent;
  operatorNotifier: NotificationPort;
  lifecycleRestartSafeguard: LifecycleRestartSafeguard;
  externalRateLimiter: ExternalCommunicationRateLimiter;
  capabilityRuntime: CapabilityRuntime;
  lifecycleRuntimeContract: RuntimeModeContract;
  shutdownTargets: AgentControlPlaneShutdownTargets;
  postTurnActions: PostTurnActionRuntime;
  icpAutonomyRuntime?: AgentFacingIcpAutonomyRuntime;
  icpInitiationSourceRuntime?: IcpInitiationSourceRuntime;
}

export interface AgentControlPlaneRuntime {
  lifecycleNotifier: LifecycleNotifier;
  stopFn: () => Promise<void>;
  icpAutonomyCandidateDispatcher?: IcpAutonomyCandidateDispatcher;
}

export function buildAgentControlPlane(
  options: BuildAgentControlPlaneOptions,
): AgentControlPlaneRuntime {
  const {
    heartbeatChannelId,
    dataDir,
    config,
    eventBus,
    gateway,
    unregisterGatewayDisconnect,
    stopDebugObserver,
    writeGracefulShutdownMarkers,
    closeDatabase,
    scheduler,
    moduleLoader,
    memoryExtractor,
    agentLoop,
    operatorNotifier,
    lifecycleRestartSafeguard,
    externalRateLimiter,
    capabilityRuntime,
    lifecycleRuntimeContract,
    shutdownTargets,
    postTurnActions,
    icpAutonomyRuntime,
    icpInitiationSourceRuntime,
  } = options;
  const deferredCompanionOutreachAuthorizationRuntime: DeferredCompanionOutreachAuthorizationRuntime = {
    hasExternalCompanionCapability: () => capabilityRuntime.has('external.companion'),
    isNotifyToolRegistered: () => agentLoop.getToolCatalog().extended.some(
      tool => tool.name === 'notify',
    ),
  };
  const unregisterDeferredCompanionOutreach = icpAutonomyRuntime
    ? registerDeferredCompanionOutreachRuntime({
        agentLoop,
        postTurnActions,
        runtime: icpAutonomyRuntime,
        resolveOriginCatalogSource: () => resolveCompanionOutreachOriginCatalogSource(
          deferredCompanionOutreachAuthorizationRuntime,
        ),
        isExecutionAuthorized: evidence => isDeferredCompanionOutreachExecutionAuthorized(
          evidence,
          deferredCompanionOutreachAuthorizationRuntime,
        ),
      })
    : () => undefined;
  const unregisterIcpInitiationCandidates = icpInitiationSourceRuntime
    ? registerIcpInitiationCandidatePostTurnRuntime({
        agentLoop,
        postTurnActions,
        runtime: icpInitiationSourceRuntime,
        resolveOriginCatalogSource: () => resolveCompanionOutreachOriginCatalogSource(
          deferredCompanionOutreachAuthorizationRuntime,
        ),
        isExecutionAuthorized: evidence => isDeferredCompanionOutreachExecutionAuthorized(
          evidence,
          deferredCompanionOutreachAuthorizationRuntime,
        ),
      })
    : () => undefined;

  const gatewaySender: MessageSender = {
    send: (channelId, content) => gateway.discordSend(channelId, content),
  };
  const lifecycleNotifier = createDiscordLifecycleNotifier({
    sender: gatewaySender,
    heartbeatChannelId,
    dataDir,
    startTime: Date.now(),
  });

  const prepareRestartCommand = createRetryableShutdown(async () => {
    await runShutdownStep(
      'stop durable background work supervisor',
      () => agentLoop.stopBackgroundWork(),
      log,
      2,
      true,
    );
  });

  const stopFn = createRetryableShutdown(async () => {
    const timeoutMs = parsePositiveIntEnv(
      process.env.EXTRACTION_DRAIN_TIMEOUT_MS,
      DEFAULT_EXTRACTION_DRAIN_TIMEOUT_MS,
    );
    await runShutdownSequence([
      { step: 'unregister deferred companion outreach', action: () => unregisterDeferredCompanionOutreach() },
      { step: 'unregister ICP initiation candidates', action: () => unregisterIcpInitiationCandidates() },
      { step: 'unregister gateway disconnect hook', action: () => unregisterGatewayDisconnect() },
      { step: 'emit system.shutdown event', action: () => eventBus.emit('system.shutdown', {}) },
      { step: 'stop debug observer', action: () => stopDebugObserver() },
      { step: 'stop scheduler', action: () => scheduler.stop() },
      {
        step: 'stop durable background work supervisor',
        action: prepareRestartCommand,
        maxAttempts: 1,
        failClosed: true,
      },
      {
        step: 'drain memory extractor',
        action: async () => {
          const drained = await memoryExtractor.stop({ timeoutMs });
          if (!drained) {
            log.warn('Proceeding with shutdown before extraction drain completed', { timeoutMs });
          }
        },
      },
      {
        step: 'write graceful shutdown markers',
        action: () => writeGracefulShutdownMarkers(),
      },
      { step: 'shutdown module loader', action: () => moduleLoader.shutdown() },
      { step: 'stop API server', action: () => shutdownTargets.apiServer?.stop() },
      { step: 'stop admin server', action: () => shutdownTargets.adminTransport?.stop() },
      { step: 'close app cache', action: () => shutdownTargets.appCache?.close?.() },
      { step: 'close charge ledger', action: () => shutdownTargets.chargeLedger?.close() },
      { step: 'close ICP fatigue regulation reservations', action: () => shutdownTargets.fatigueRegulationReservations?.close() },
      { step: 'close session tail cache', action: () => shutdownTargets.sessionTailCache?.close?.() },
      { step: 'destroy gateway client', action: () => gateway.destroy() },
      { step: 'close database', action: () => closeDatabase() },
    ], log);
    log.info('Stopped');
  });

  agentLoop.registerTool(createSystemTool(
    config,
    {
      notifier: lifecycleNotifier,
      stopFn,
      restartSafeguard: lifecycleRestartSafeguard,
      getCapabilityTier: () => capabilityRuntime.getTier(),
      restartContract: lifecycleRuntimeContract.restart,
      prepareRestartCommand,
      runBuildCommand: async () => {
        await runRepoLifecycleBuildCommand({
          repoRoot: process.cwd(),
          timeoutMs: 120_000,
          maxOutputChars: 40_000,
        });
      },
      runRestartCommand: async () => {
        const invocation = resolveRuntimeCommandInvocation(lifecycleRuntimeContract.restart.command);
        if (!invocation) {
          throw new Error('Lifecycle restart command strategy is missing a restart command');
        }
        await gateway.shellExec(invocation.command, invocation.args, {
          cwd: process.cwd(),
          timeoutMs: 30_000,
          maxOutputChars: 10_000,
        });
      },
    },
  ));
  agentLoop.registerTool(createNotifyTool(createNotifyDispatcher({
    briefNotifier: operatorNotifier,
    channelSender: createGatewayDiscordNotifySender(gateway),
    operatorDiscordChannelId: heartbeatChannelId,
    rateLimiter: externalRateLimiter,
    defaultBudgetChannel: 'discord',
  }), {
    gatewayMode: true,
    ...(icpAutonomyRuntime ? { companionOutreach: icpAutonomyRuntime } : {}),
    companionCandidateEnabled: icpInitiationSourceRuntime !== undefined,
    isCompanionCandidateAuthorized: () => (
      resolveCompanionOutreachOriginCatalogSource(
        deferredCompanionOutreachAuthorizationRuntime,
      ) !== null
    ),
  }), 'extended');

  const icpAutonomyCandidateDispatcher = icpAutonomyRuntime
    ? createIcpAutonomyCandidateDispatcher({
        runCandidateTurn: async message => {
          if (!resolveIcpAutonomyCandidateSchedulerOrigin(message)) {
            throw new Error('ICP candidate dispatcher lost its validated internal origin');
          }
          if (!deferredCompanionOutreachAuthorizationRuntime.hasExternalCompanionCapability()
            || !deferredCompanionOutreachAuthorizationRuntime.isNotifyToolRegistered()) {
            throw new Error('ICP candidate notify turn is no longer authorized');
          }
          return await agentLoop.handleIcpAutonomyCandidateTurn(message);
        },
      })
    : undefined;

  return {
    lifecycleNotifier,
    stopFn,
    ...(icpAutonomyCandidateDispatcher ? { icpAutonomyCandidateDispatcher } : {}),
  };
}
