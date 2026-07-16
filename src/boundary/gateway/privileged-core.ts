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
import type { GatewayCompanionChannelLane } from './companion-channels.js';
import type { CompanionId } from '../../shared/routing/companion-id.js';
import {
  composeGatewayIntakeScreening,
  resolveIntakeScreenerBackend,
  type GatewayIntakeScreeningComposition,
} from './intake/compose-screening.js';
import { GatewayServer } from './server.js';
import type { WelfareGrantVerifier } from './welfare-grant-verifier.js';
import { CogSecEventStore } from '../../core/cogsec/events.js';
import { resolveCogSecEventsPath } from '../../persistence/layout.js';
import type { StartupConfigHydrationResult } from '../../app/startup/support/bootstrap-helpers.js';
import type { IcpSharedAutonomyStorePort } from '../../core/icp/autonomy-store-ports.js';
import type { GatewayIcpInitiationPolicyAuthority } from './icp-initiation-policy-authority.js';
import { emitGardenQueueChanged } from '../../shared/garden-queue-change.js';
import { resolveCoreCompanionIdFromConfig } from '../../core/identity/companion-runtime.js';
import { resolveKubeSelfManagementController } from './kube-self-management-runtime.js';

export interface GatewayPrivilegedCoreBuildInput {
  config: SubstrateConfig;
  env: NodeJS.ProcessEnv;
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
  /**
   * Cognition intake firewall (htm9.2): the gateway-wide screening service
   * (null when intake-policy mode is 'off') plus its disposer. Shared by the
   * RPC method runtime (web.fetch/web.search) and the Discord channel surface
   * (parsed document ingest).
   */
  intakeScreening: GatewayIntakeScreeningComposition;
  auditDb: null;
  createGatewayServer(input: {
    discordAdapter: ChannelOutboundDock;
    /** Multi-account discord (W1-P2): outbound dock per companionId. */
    discordAccountDocks?: ReadonlyMap<CompanionId, ChannelOutboundDock>;
    /** Inter-companion channel lane (W6); multi-companion only. */
    companionChannels?: GatewayCompanionChannelLane;
    /** Shared durable authority for the ICP autonomy broker. */
    icpAutonomyStore?: IcpSharedAutonomyStorePort;
    icpInitiationPolicyAuthority?: Pick<GatewayIcpInitiationPolicyAuthority, 'resolve' | 'authorizeHandoff'>;
    /**
     * fxt1: gateway-side welfare grant verifier. Injected by
     * gateway main so the LLM RPC handlers can re-verify caller-asserted
     * `preemptionProtected` against the background-work store.
     */
    welfareGrantVerifier?: WelfareGrantVerifier;
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
    // capability-tier.json is per-companion (dnll.2): root it at the companion
    // data dir so each fleet companion holds its own maturation tier.
    dataDir: input.startupHydration.companionDataDir,
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
      onIcpConversationCostDecision: (event) => {
        eventBus.emit('icp.conversation.cost.decision', event).catch((error) => {
          input.logger.error('Failed to emit ICP conversation cost decision telemetry', {
            error: error instanceof Error ? error.message : String(error),
            conversationId: event.conversationId,
            reason: event.reason,
            outcome: event.outcome,
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
  const kubeSelfManagement = resolveKubeSelfManagementController({
    env: input.env,
    lifecycleKubernetes: input.config.lifecycleKubernetes,
    audit: entry => auditStore.recordSummary(entry),
  });

  // Cognition intake firewall (htm9.2): composed once for the gateway process
  // and threaded into the RPC runtime and channel surfaces. Mode 'off' yields
  // a null service; a provisioned-but-broken L1.5 model fails startup.
  const intakeScreening = await composeGatewayIntakeScreening({
    systemDataDir: input.startupHydration.systemDataDir,
    companionDataDir: input.startupHydration.companionDataDir,
    // htm9.8: the vision intake screener shares the gateway's OpenRouter
    // credentials (providers.json openrouter apiBaseUrl + apiKeyRef, key
    // resolved through the credential vault with process-env fallback).
    screenerBackend: resolveIntakeScreenerBackend(input.config),
    onQuarantineHeld: () => emitGardenQueueChanged(
      eventBus,
      'intake-quarantine',
      input.config.companionId,
    ),
  });

  // htm9.18: durable CogSec event store for the canary egress tripwire. Shares
  // the same cogsec-events.json the contact-block gate and L3 screener use
  // (multi-writer, reloads from disk per op).
  const cogSecEvents = new CogSecEventStore(
    resolveCogSecEventsPath(input.startupHydration.companionDataDir),
  );

  return {
    eventBus,
    capabilityRuntime,
    eligibilityGate,
    privilegedServices,
    intakeScreening,
    auditDb: null,
    createGatewayServer: ({
      discordAdapter,
      discordAccountDocks,
      companionChannels,
      icpAutonomyStore,
      icpInitiationPolicyAuthority,
      welfareGrantVerifier,
    }) => new GatewayServer({
      ...(discordAccountDocks ? { discordAccountDocks } : {}),
      ...(companionChannels ? { companionChannels } : {}),
      ...(icpAutonomyStore ? { icpAutonomyStore } : {}),
      ...(icpInitiationPolicyAuthority ? { icpInitiationPolicyAuthority } : {}),
      ...(welfareGrantVerifier ? { welfareGrantVerifier } : {}),
      socketPath: input.bootstrap.socketPath,
      companionId: resolveCoreCompanionIdFromConfig(input.config),
      gatewayRpcEndpoint: input.bootstrap.gatewayRpcEndpoint,
      llmProvider: privilegedServices.llmClient,
      embeddingService: privilegedServices.embeddingProvider,
      modelDiscovery: privilegedServices.modelDiscovery,
      discordAdapter,
      gitOps,
      imageConfig: input.config,
      ...(privilegedServices.modelUsageStore ? { modelUsageRecorder: privilegedServices.modelUsageStore } : {}),
      ...(input.config.credentialVault ? { credentialVault: input.config.credentialVault } : {}),
      ...(intakeScreening.screening ? { intakeScreening: intakeScreening.screening } : {}),
      cogSecEvents,
      ...(intakeScreening.visionIntake ? { visionIntake: intakeScreening.visionIntake } : {}),
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
      ...(kubeSelfManagement ? { kubeSelfManagement } : {}),
      sessionHmacKeyring: input.bootstrap.server.sessionHmacKeyring,
      wyomingShardRouting: input.bootstrap.server.wyomingShardRouting,
      multiCompanion: input.bootstrap.server.multiCompanion,
      credentialPresence: input.bootstrap.server.credentialPresence,
      eventBus,
    }),
  };
}
