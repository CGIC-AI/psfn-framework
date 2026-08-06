import type { ChannelOutboundDock } from '../../channels/backplane/types.js';
import {
  createEligibilityGate,
  type EligibilityDecision,
  type EligibilityGate,
} from '../../system/capabilities/eligibility.js';
import { CapabilityRuntime } from '../../system/capabilities/runtime.js';
import { GatewayCapabilityTierResolver } from './capability-tier-resolver.js';
import { EventBus } from '../../shared/event-bus.js';
import { GitOps } from '../integrations/git/ops.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { createPostgresGatewayAuditStore } from './postgres-audit.js';
import type { GatewayBootstrapInput } from './bootstrap-input.js';
import { createGatewayPrivilegedServiceRegistry } from './privileged-services.js';
import type { GatewayCompanionChannelLane } from './companion-channels.js';
import type { CompanionId } from '../../shared/routing/companion-id.js';
import {
  resolveIntakeScreenerBackend,
} from './intake/compose-screening.js';
import {
  composeGatewayIntakeScreeningRuntime,
  type GatewayIntakeScreeningRuntime,
} from './intake/fleet-screening.js';
import { GatewayServer } from './server.js';
import type { WelfareGrantVerifier } from './welfare-grant-verifier.js';
import { CogSecEventStore } from '../../core/cogsec/events.js';
import { resolveCogSecEventsPath } from '../../persistence/layout.js';
import type { StartupConfigHydrationResult } from '../../app/startup/support/bootstrap-helpers.js';
import type { IcpSharedAutonomyStorePort } from '../../core/icp/autonomy-store-ports.js';
import type { GatewayIcpInitiationPolicyAuthority } from './icp-initiation-policy-authority.js';
import { emitGardenQueueChanged } from '../../shared/garden-queue-change.js';
import {
  resolveCompanionNameFromConfig,
  resolveCoreCompanionIdFromConfig,
} from '../../core/identity/companion-runtime.js';
import { resolveKubeSelfManagementController } from './kube-self-management-runtime.js';
import type { IcpConversationChargePolicyResolver } from '../../primitives/llm/icp-conversation-cost-breaker.js';
import type { GatewayContactLifecycleAuthorityPort } from './contact-lifecycle-authority.js';
import type { ShardWorkloadLifecycleRegistryPort } from '../../system/capabilities/shard-approval-grant-contracts.js';
import { createOwnerFileConfigStore } from '../../system/config/config-store.js';
import { GatewaySystemDataWriter } from './system-data-writer.js';
import { awaitPostgresStoreReadiness } from '../../persistence/postgres/runtime-readiness.js';
import { composeMcpGatewayRuntime, type McpGatewayRuntime } from './mcp/runtime.js';
import { emitTurnPerformance } from '../../shared/telemetry/turn-performance.js';

export interface GatewayPrivilegedCoreBuildInput {
  config: SubstrateConfig;
  env: NodeJS.ProcessEnv;
  bootstrap: GatewayBootstrapInput;
  startupHydration: StartupConfigHydrationResult;
  logger: {
    error(message: string, meta?: Record<string, unknown>): void;
  };
  onEligibilityDecision?: (eventBus: EventBus, decision: EligibilityDecision) => void;
  icpConversationChargePolicyResolver?: IcpConversationChargePolicyResolver;
}

export interface GatewayPrivilegedCore {
  eventBus: EventBus;
  capabilityRuntime: CapabilityRuntime;
  eligibilityGate: EligibilityGate;
  privilegedServices: ReturnType<typeof createGatewayPrivilegedServiceRegistry>;
  /**
   * Cognition intake firewall (htm9.2): one historical composition in
   * single-companion mode, or an exact per-companion resolver plus fleet-wide
   * artifact guard in fleet mode.
   */
  intakeScreening: GatewayIntakeScreeningRuntime;
  /** Native external MCP client runtime; null broker when every server is disabled. */
  mcp: McpGatewayRuntime;
  auditDb: null;
  createGatewayServer(input: {
    discordAdapter: ChannelOutboundDock;
    telegramDock?: ChannelOutboundDock;
    operatorTelegramChatId?: string;
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
    contactLifecycleAuthority?: GatewayContactLifecycleAuthorityPort;
    /**
     * 2h6q.3: server-owned authenticated shard-workload registry fed from
     * ShardManager registration state. Presence enables the exact-once shard
     * approval-grant authority inside the gateway server.
     */
    shardApprovalWorkloads?: ShardWorkloadLifecycleRegistryPort;
    sharedSatelliteQuietHoursAllows?: (nowMs: number) => boolean;
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
  // an52.3: in a one-gateway/N-companion fleet every tier-gated decision must
  // resolve against the *authenticated* companion's own capability-tier.json,
  // not the single gateway-hydrated root. The resolver owns a CapabilityRuntime
  // per fleet companion; single-companion mode keeps using the base runtime.
  const capabilityTierResolver = new GatewayCapabilityTierResolver({
    baseRuntime: capabilityRuntime,
    multiCompanion: input.bootstrap.server.multiCompanion.enabled,
    ...(input.config.companionFleet ? { companionFleet: input.config.companionFleet } : {}),
  });
  const eligibilityDecisionReporter = input.onEligibilityDecision
    ? (decision: EligibilityDecision) => input.onEligibilityDecision?.(eventBus, decision)
    : undefined;
  const eligibilityGate = createEligibilityGate(
    (companionId) => capabilityTierResolver.resolveAccess(companionId),
    eligibilityDecisionReporter,
  );
  // an52.3 remediation: the gateway LLM client serves only authenticated agent
  // RPCs (methods/llm.ts injects the connection's companion id), so its gate is
  // strict — in multi-companion mode an absent identity throws instead of
  // falling back to the gateway root's tier. The lenient gate above remains for
  // gateway-global plugin activation (channels/voice), which has no companion.
  const llmEligibilityGate = createEligibilityGate(
    (companionId) => capabilityTierResolver.resolveAccessStrict(companionId),
    eligibilityDecisionReporter,
  );
  const privilegedServices = createGatewayPrivilegedServiceRegistry({
    config: input.config,
    providerEnv: input.bootstrap.providerEnv,
    llmOptions: {
      eligibilityGate: llmEligibilityGate,
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
      ...(input.icpConversationChargePolicyResolver
        ? { icpConversationChargePolicyResolver: input.icpConversationChargePolicyResolver }
        : {}),
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
  const auditStore = await awaitPostgresStoreReadiness(
    'gateway_audit',
    () => createPostgresGatewayAuditStore(databaseUrl),
  );
  const kubeSelfManagement = resolveKubeSelfManagementController({
    env: input.env,
    lifecycleKubernetes: input.config.lifecycleKubernetes,
    audit: entry => auditStore.recordSummary(entry),
  });

  // Cognition intake firewall (htm9.2): single-companion mode preserves the
  // historical one-service composition. Fleet mode composes one service and
  // durable quarantine store per companion, then routes every ingress by its
  // authenticated/routed owner. Mode 'off' yields null services; a
  // provisioned-but-broken L1.5 model fails startup.
  const intakeScreening = await composeGatewayIntakeScreeningRuntime({
    config: input.config,
    systemDataDir: input.startupHydration.systemDataDir,
    companionDataDir: input.startupHydration.companionDataDir,
    multiCompanion: input.bootstrap.server.multiCompanion.enabled,
    ...(input.config.companionFleet
      ? {
          companions: input.config.companionFleet.companions.map(companion => ({
            companionId: companion.companionId,
            companionDataDir: companion.companionDataDir,
          })),
        }
      : {}),
    // htm9.8: the vision intake screener shares the gateway's OpenRouter
    // credentials (providers.json openrouter apiBaseUrl + apiKeyRef, key
    // resolved through the credential vault with process-env fallback).
    screenerBackend: resolveIntakeScreenerBackend(input.config),
    onQuarantineHeld: companionId => emitGardenQueueChanged(
      eventBus,
      'intake-quarantine',
      companionId ?? input.config.companionId,
    ),
    onQuarantineExpired: (_companionId, { entry, expiredAtMs, reason }) => {
      void eventBus.emit('intake.quarantine.expired', {
        envelopeId: entry.id,
        ...(entry.sourceChannelId ? { sourceChannelId: entry.sourceChannelId } : {}),
        heldAtMs: entry.heldAtMs,
        expiredAtMs,
        reason,
      }).catch((error: unknown) => {
        input.logger.error('Failed to emit intake quarantine expiry alert event', {
          envelopeId: entry.id,
          error: String(error),
        });
      });
    },
    onFailClosedScreening: (_companionId, event) => {
      void eventBus.emit('intake.screening.fail_closed', event).catch((error: unknown) => {
        input.logger.error('Failed to emit fail-closed intake screening alert event', {
          stage: event.stage,
          error: String(error),
        });
      });
    },
    onScreeningTiming: (companionId, event) => {
      const ownerCompanionId = companionId ?? resolveCoreCompanionIdFromConfig(input.config);
      const stage = event.stage === 'local_screening'
        ? 'cogsec_local_screening'
        : event.stage === 'l2'
          ? 'cogsec_l2_screening'
          : 'cogsec_l3_screening';
      void emitTurnPerformance(eventBus, {
        traceId: event.traceId,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        ...(event.requestId ? { requestId: event.requestId } : {}),
        companionId: ownerCompanionId,
        ...(event.channelId ? { channelId: event.channelId } : {}),
        ...(event.channelType ? { channelType: event.channelType } : {}),
        stage,
        stageStatus: event.status,
        ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
      }).catch((error: unknown) => {
        input.logger.error('Failed to emit intake screening timing telemetry', {
          traceId: event.traceId,
          stage: event.stage,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
  });

  // htm9.18: durable CogSec event store for the canary egress tripwire. Shares
  // the same cogsec-events.json the contact-block gate and L3 screener use
  // (multi-writer, reloads from disk per op).
  const cogSecEvents = new CogSecEventStore(
    resolveCogSecEventsPath(input.startupHydration.companionDataDir),
  );
  const configStore = createOwnerFileConfigStore({
    dataDir: input.startupHydration.systemDataDir,
    companionDataDir: input.startupHydration.companionDataDir,
    defaultContextWindow: input.config.defaultContextWindow,
  });
  const mcp = composeMcpGatewayRuntime({
    config: configStore.loadStartupMcpServers(),
    ...(input.config.credentialVault ? { credentialVault: input.config.credentialVault } : {}),
    screeningFor: companionId => intakeScreening.screeningFor(companionId),
  });
  const systemDataWriter = new GatewaySystemDataWriter({
    configStore,
    systemDataDir: input.startupHydration.systemDataDir,
  });

  return {
    eventBus,
    capabilityRuntime,
    eligibilityGate,
    privilegedServices,
    intakeScreening,
    mcp,
    auditDb: null,
    createGatewayServer: ({
      discordAdapter,
      telegramDock,
      operatorTelegramChatId,
      discordAccountDocks,
      companionChannels,
      icpAutonomyStore,
      icpInitiationPolicyAuthority,
      welfareGrantVerifier,
      contactLifecycleAuthority,
      shardApprovalWorkloads,
      sharedSatelliteQuietHoursAllows,
    }) => new GatewayServer({
      ...(discordAccountDocks ? { discordAccountDocks } : {}),
      ...(companionChannels ? { companionChannels } : {}),
      ...(icpAutonomyStore ? { icpAutonomyStore } : {}),
      ...(icpInitiationPolicyAuthority ? { icpInitiationPolicyAuthority } : {}),
      ...(welfareGrantVerifier ? { welfareGrantVerifier } : {}),
      ...(contactLifecycleAuthority ? { contactLifecycleAuthority } : {}),
      ...(shardApprovalWorkloads ? { shardApprovalWorkloads } : {}),
      ...(sharedSatelliteQuietHoursAllows ? { sharedSatelliteQuietHoursAllows } : {}),
      systemDataWriter,
      ...(mcp.broker ? { mcpBroker: mcp.broker } : {}),
      socketPath: input.bootstrap.socketPath,
      companionId: resolveCoreCompanionIdFromConfig(input.config),
      gatewayRpcEndpoint: input.bootstrap.gatewayRpcEndpoint,
      llmProvider: privilegedServices.llmClient,
      embeddingService: privilegedServices.embeddingProvider,
      modelDiscovery: privilegedServices.modelDiscovery,
      discordAdapter,
      ...(telegramDock ? { telegramDock } : {}),
      ...(operatorTelegramChatId ? { operatorTelegramChatId } : {}),
      gitOps,
      imageConfig: input.config,
      ...(privilegedServices.modelUsageStore ? { modelUsageRecorder: privilegedServices.modelUsageStore } : {}),
      ...(input.config.credentialVault ? { credentialVault: input.config.credentialVault } : {}),
      intakeScreeningMode: intakeScreening.mode,
      ...(!input.bootstrap.server.multiCompanion.enabled
        && intakeScreening.screeningFor()
        ? { intakeScreening: intakeScreening.screeningFor()! }
        : {}),
      ...(input.bootstrap.server.multiCompanion.enabled
        ? {
            intakeScreeningProvider: (companionId?: string) =>
              intakeScreening.screeningFor(companionId),
          }
        : {}),
      // hrmrq.54: fs read/search seams refuse to serve a quarantined item's
      // on-disk artifacts and record the attempted access on the queue entry.
      ...(intakeScreening.quarantinedArtifactGuard
        ? { quarantinedArtifactGuard: intakeScreening.quarantinedArtifactGuard }
        : {}),
      cogSecEvents,
      ...(!input.bootstrap.server.multiCompanion.enabled
        && intakeScreening.resolve().visionIntake
        ? { visionIntake: intakeScreening.resolve().visionIntake! }
        : {}),
      ...(input.bootstrap.server.multiCompanion.enabled
        ? {
            visionIntakeProvider: (companionId?: string) =>
              intakeScreening.resolve(companionId).visionIntake,
          }
        : {}),
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
      capabilityTierProvider: (companionId) => capabilityTierResolver.resolveTier(companionId),
      capabilityGrantSnapshotProvider: (companionId) =>
        capabilityTierResolver.snapshotOwnerGrantStrict(companionId),
      approvalParentLabelProvider: (companionId) => {
        const fleetEntry = input.config.companionFleet?.companions
          .find(entry => entry.companionId === companionId);
        if (fleetEntry) return fleetEntry.displayName?.trim() || undefined;
        return companionId === input.config.companionId
          ? resolveCompanionNameFromConfig(input.config)
          : undefined;
      },
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
