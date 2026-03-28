import type { ChannelOutboundDock } from '../channels/types.js';
import {
  createEligibilityGate,
  type EligibilityDecision,
  type EligibilityGate,
} from '../system/capabilities/eligibility.js';
import { CapabilityRuntime } from '../system/capabilities/runtime.js';
import { EventBus } from '../shared/event-bus.js';
import { GitOps } from '../git/ops.js';
import { initDatabase } from '../persistence/sqlite-utils.js';
import type { SubstrateConfig } from '../types.js';
import { AuditStore } from './audit.js';
import type { GatewayBootstrapInput } from './bootstrap-input.js';
import { createGatewayPrivilegedServiceRegistry } from './privileged-services.js';
import { GatewayServer } from './server.js';
import type { StartupConfigHydrationResult } from '../runtime/bootstrap-helpers.js';

export interface GatewayPrivilegedCoreBuildInput {
  config: SubstrateConfig;
  bootstrap: GatewayBootstrapInput;
  startupHydration: StartupConfigHydrationResult;
  logger: {
    error(message: string, meta?: Record<string, unknown>): void;
  };
  onEligibilityDecision?: (eventBus: EventBus, decision: EligibilityDecision) => void;
}

export interface GatewayPrivilegedCore {
  eventBus: EventBus;
  capabilityRuntime: CapabilityRuntime;
  eligibilityGate: EligibilityGate;
  privilegedServices: ReturnType<typeof createGatewayPrivilegedServiceRegistry>;
  auditDb: ReturnType<typeof initDatabase>;
  createGatewayServer(input: {
    discordAdapter: ChannelOutboundDock;
  }): GatewayServer;
}

export function buildGatewayPrivilegedCore(
  input: GatewayPrivilegedCoreBuildInput,
): GatewayPrivilegedCore {
  const eventBus = new EventBus();
  const gitOps = new GitOps({
    repoRoot: input.bootstrap.gitRepoRoot,
  });
  const capabilityRuntime = new CapabilityRuntime({
    dataDir: input.startupHydration.systemDataDir,
  });
  const eligibilityGate = createEligibilityGate(
    () => capabilityRuntime,
    input.onEligibilityDecision
      ? (decision) => input.onEligibilityDecision?.(eventBus, decision)
      : undefined,
  );
  const privilegedServices = createGatewayPrivilegedServiceRegistry({
    config: input.config,
    providerEnv: input.bootstrap.providerEnv,
    llmOptions: {
      eligibilityGate,
      onBudgetBlocked: (event) => {
        eventBus.emit('model.budget.blocked', event).catch((error) => {
          input.logger.error('Failed to emit model budget blocked telemetry', {
            error: error instanceof Error ? error.message : String(error),
            provider: event.provider,
            model: event.model,
            reason: event.reason,
          });
        });
      },
    },
    vaultPolicyConfig: input.bootstrap.policyConfig.vault,
  });
  const auditDb = initDatabase(input.bootstrap.auditDbPath, { foreignKeys: false });
  const auditStore = new AuditStore(auditDb);

  return {
    eventBus,
    capabilityRuntime,
    eligibilityGate,
    privilegedServices,
    auditDb,
    createGatewayServer: ({ discordAdapter }) => new GatewayServer({
      socketPath: input.bootstrap.socketPath,
      llmProvider: privilegedServices.llmClient,
      embeddingService: privilegedServices.embeddingProvider,
      modelDiscovery: privilegedServices.modelDiscovery,
      discordAdapter,
      gitOps,
      imageConfig: input.config,
      policyConfig: {
        ...input.bootstrap.policyConfig,
        ...(privilegedServices.vaultOps
          ? {
              vault: {
                ...input.bootstrap.policyConfig.vault,
                ops: privilegedServices.vaultOps,
              },
            }
          : {}),
      },
      ntfy: input.bootstrap.server.ntfy,
      confirmation: input.bootstrap.server.confirmation,
      capabilityTierProvider: () => capabilityRuntime.getTier(),
      auditStore,
      sessionHmacKeyring: input.bootstrap.server.sessionHmacKeyring,
      wyomingShardRouting: input.bootstrap.server.wyomingShardRouting,
    }),
  };
}
