import { createComponentLogger } from '../shared/logger.js';
import { DiscordLifecycleNotifier } from '../system/lifecycle/notifications.js';
import type { MessageSender } from '../system/lifecycle/notifications.js';
import { resolveRuntimeCommandInvocation } from '../system/lifecycle/runtime-mode.js';
import { createRestartTool, createRebuildTool } from '../tools/lifecycle.js';
import { createNotifyOperatorTool, type NtfyNotifier } from '../tools/ntfy.js';
import { runShutdownSequence } from '../app/startup/support/shutdown-helpers.js';
import { parsePositiveIntEnv } from '../shared/utils/env.js';
import type { EventBus } from '../shared/event-bus.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import type { ModuleLoader } from '../modules/loader.js';
import type { MemoryExtractor } from '../memory/extraction.js';
import type { GatewayClient } from '../boundary/gateway/client.js';
import type { CapabilityRuntime } from '../system/capabilities/runtime.js';
import type { LifecycleRestartSafeguard, ExternalCommunicationRateLimiter } from '../system/capabilities/safeguards.js';
import type { SubstrateAgent } from '../agent/substrate-agent.js';
import type { ApiServer } from '../channels/api/server.js';
import type { AdminServer } from '../operator/garden/server.js';

const log = createComponentLogger('AgentControlPlane');
const DEFAULT_EXTRACTION_DRAIN_TIMEOUT_MS = 10_000;

export interface AgentControlPlaneShutdownTargets {
  apiServer?: ApiServer;
  adminServer?: AdminServer;
}

export interface BuildAgentControlPlaneOptions {
  heartbeatChannelId?: string;
  dataDir: string;
  eventBus: EventBus;
  gateway: GatewayClient;
  unregisterGatewayDisconnect: () => void;
  stopDebugObserver: () => void;
  writeGracefulShutdownMarkers: () => void;
  closeDatabase: () => void;
  scheduler: Scheduler;
  moduleLoader: ModuleLoader;
  memoryExtractor: MemoryExtractor;
  agentLoop: SubstrateAgent;
  operatorNotifier: NtfyNotifier;
  lifecycleRestartSafeguard: LifecycleRestartSafeguard;
  externalRateLimiter: ExternalCommunicationRateLimiter;
  capabilityRuntime: CapabilityRuntime;
  lifecycleRuntimeContract: { mode: string; restart: { command: string } };
  shutdownTargets: AgentControlPlaneShutdownTargets;
}

export interface AgentControlPlaneRuntime {
  lifecycleNotifier: DiscordLifecycleNotifier;
  stopFn: () => Promise<void>;
}

export function buildAgentControlPlane(
  options: BuildAgentControlPlaneOptions,
): AgentControlPlaneRuntime {
  const {
    heartbeatChannelId,
    dataDir,
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
  } = options;
  let stopPromise: Promise<void> | null = null;

  const gatewaySender: MessageSender = {
    send: (channelId, content) => gateway.discordSend(channelId, content),
  };
  const lifecycleNotifier = new DiscordLifecycleNotifier({
    sender: gatewaySender,
    heartbeatChannelId,
    dataDir,
    startTime: Date.now(),
  });

  const stopFn = async () => {
    if (stopPromise) {
      await stopPromise;
      return;
    }

    stopPromise = (async () => {
      const timeoutMs = parsePositiveIntEnv(
        process.env.EXTRACTION_DRAIN_TIMEOUT_MS,
        DEFAULT_EXTRACTION_DRAIN_TIMEOUT_MS,
      );
      await runShutdownSequence([
        { step: 'unregister gateway disconnect hook', action: () => unregisterGatewayDisconnect() },
        { step: 'emit system.shutdown event', action: () => eventBus.emit('system.shutdown', {}) },
        { step: 'stop debug observer', action: () => stopDebugObserver() },
        { step: 'stop scheduler', action: () => scheduler.stop() },
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
        { step: 'stop admin server', action: () => shutdownTargets.adminServer?.stop() },
        { step: 'destroy gateway client', action: () => gateway.destroy() },
        { step: 'close database', action: () => closeDatabase() },
      ], log);
      log.info('Stopped');
    })();

    await stopPromise;
  };

  agentLoop.registerTool(createRestartTool(
    lifecycleNotifier,
    stopFn,
    {
      restartSafeguard: lifecycleRestartSafeguard,
      getCapabilityTier: () => capabilityRuntime.getTier(),
      runRestartCommand: async () => {
        const invocation = resolveRuntimeCommandInvocation(lifecycleRuntimeContract.restart.command);
        if (!invocation) return;
        await gateway.shellExec(invocation.command, invocation.args, {
          cwd: process.cwd(),
          timeoutMs: 30_000,
          maxOutputChars: 10_000,
        });
      },
    },
  ));
  agentLoop.registerTool(createRebuildTool(
    lifecycleNotifier,
    stopFn,
    {
      restartSafeguard: lifecycleRestartSafeguard,
      getCapabilityTier: () => capabilityRuntime.getTier(),
      runBuildCommand: async () => {
        await gateway.shellExec('npm', ['run', 'build'], {
          cwd: process.cwd(),
          timeoutMs: 120_000,
          maxOutputChars: 40_000,
        });
      },
      runRestartCommand: async () => {
        const invocation = resolveRuntimeCommandInvocation(lifecycleRuntimeContract.restart.command);
        if (!invocation) return;
        await gateway.shellExec(invocation.command, invocation.args, {
          cwd: process.cwd(),
          timeoutMs: 30_000,
          maxOutputChars: 10_000,
        });
      },
    },
  ));
  agentLoop.registerTool(createNotifyOperatorTool(
    operatorNotifier,
    {
      rateLimiter: externalRateLimiter,
      defaultChannel: 'discord',
      gatewayMode: true,
    },
  ));

  return { lifecycleNotifier, stopFn };
}
