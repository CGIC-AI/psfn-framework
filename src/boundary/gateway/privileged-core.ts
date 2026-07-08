import type { ChannelOutboundDock } from '../../channels/backplane/types.js';
import {
  createEligibilityGate,
  type EligibilityDecision,
  type EligibilityGate,
} from '../../system/capabilities/eligibility.js';
import { CapabilityRuntime } from '../../system/capabilities/runtime.js';
import { EventBus } from '../../shared/event-bus.js';
import { GitOps } from '../integrations/git/ops.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { createPostgresGatewayAuditStore } from './postgres-audit.js';
import type { GatewayBootstrapInput } from './bootstrap-input.js';
import { createGatewayPrivilegedServiceRegistry } from './privileged-services.js';
import { GatewayServer } from './server.js';
import type { StartupConfigHydrationResult } from '../../app/startup/support/bootstrap-helpers.js';

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
  auditDb: null;
  createGatewayServer(input: {
    discordAdapter: ChannelOutboundDock;
  }): GatewayServer;
}

export async function buildGatewayPrivilegedCore(
  input: GatewayPrivilegedCoreBuildInput,
): Promise<GatewayPrivilegedCore> {
  const eventBus = new EventBus();
  const gitOps = new GitOps({
    repoRoot: input.bootstrap.gitRepoRoot,
    companionId: input.config.companionId,
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
  if (input.config.persistenceBackend !== 'postgres') {
    throw new Error('Gateway privileged core requires config.persistenceBackend=postgres');
  }
  const databaseUrl = input.config.postgresDatabaseUrl?.trim();
  if (!databaseUrl) {
    throw new Error('Gateway postgres audit persistence requires config.postgresDatabaseUrl');
  }
  const auditStore = await createPostgresGatewayAuditStore(databaseUrl);

  return {
    eventBus,
    capabilityRuntime,
    eligibilityGate,
    privilegedServices,
    auditDb: null,
    createGatewayServer: ({ discordAdapter }) => new GatewayServer({
      socketPath: input.bootstrap.socketPath,
      gatewayRpcEndpoint: input.bootstrap.gatewayRpcEndpoint,
      llmProvider: privilegedServices.llmClient,
      embeddingService: privilegedServices.embeddingProvider,
      modelDiscovery: privilegedServices.modelDiscovery,
      discordAdapter,
      gitOps,
      imageConfig: input.config,
      ...(privilegedServices.modelUsageStore ? { modelUsageRecorder: privilegedServices.modelUsageStore } : {}),
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
