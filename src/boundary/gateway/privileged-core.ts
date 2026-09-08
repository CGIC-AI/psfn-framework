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
import { resolveGatewayReceiptStoreTargets } from './intake/receipt-store-targets.js';
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
import type { IntakeQuarantineEntry } from '../../core/cogsec/intake/quarantine-store.js';
import type {
  ConfirmationEscalationProducerOptions,
} from '../../system/capabilities/confirmation-escalation-producer.js';
import type { NotifyNtfyParams } from './protocol.js';
import { CogSecEventStore } from '../../core/cogsec/events.js';
import { resolveCogSecEventsPath } from '../../persistence/layout.js';
import type { StartupConfigHydrationResult } from '../../app/startup/support/bootstrap-helpers.js';
import type { IcpSharedAutonomyStorePort } from '../../core/icp/autonomy-store-ports.js';
import type { GatewayIcpInitiationPolicyAuthority } from './icp-initiation-policy-authority.js';
import type { GatewayCredentialPresenceResult } from './protocol.js';
import { createComponentLogger } from '../../shared/logger.js';
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
import {
  awaitOptionalPostgresStoreReadiness,
  awaitPostgresStoreReadiness,
} from '../../persistence/postgres/runtime-readiness.js';
import { PostgresCogSecReceiptStore } from '../../persistence/postgres/cogsec-receipt-store.js';
import { COGSEC_INTAKE_FIREWALL_ISSUER_ID } from '../../shared/contracts/cogsec-receipt.js';
import { intakeReceiptTtlMs, loadIntakePolicyConfig } from '../../system/config/intake-policy-config.js';
import { composeMcpGatewayRuntime, type McpGatewayRuntime } from './mcp/runtime.js';
import { emitTurnPerformance } from '../../shared/telemetry/turn-performance.js';
import { createCompanionDisplayIdentityResolver } from '../../shared/companion-display-identity.js';
import { PersonaMutationAttemptGuard } from './persona-mutation-attempt-guard.js';
import { createPersonaOwnerPathRegistry } from './persona-owner-path-registry.js';
import { resolveOperatorAlertSinkConfiguration } from '../../shared/contracts/operator-alerting.js';

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
  /**
   * wtw7l: raises a CogSec quarantine hold onto the human escalation control
   * plane. Resolved per hold rather than captured, because the plane is
   * constructed after this core — the same late binding the gateway's incident
   * alert sink uses. Absent leaves quarantine behaving exactly as before.
   */
  resolveQuarantineHoldEscalation?: () => ((entry: IntakeQuarantineEntry) => void) | null;
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
    operatorDiscordDock?: ChannelOutboundDock;
    operatorDiscordChannelId?: string;
    /** Multi-account discord (W1-P2): outbound dock per companionId. */
    discordAccountDocks?: ReadonlyMap<CompanionId, ChannelOutboundDock>;
    pluginOutboundRoutes?: readonly {
      pluginId: 'buzz';
      accountId?: string;
      companionId?: string;
      dock: ChannelOutboundDock;
    }[];
    /** Inter-companion channel lane (W6); multi-companion only. */
    companionChannels?: GatewayCompanionChannelLane;
    /** Shared durable authority for the ICP autonomy broker. */
    icpAutonomyStore?: IcpSharedAutonomyStorePort;
    icpInitiationPolicyAuthority?: Pick<
      GatewayIcpInitiationPolicyAuthority,
      'resolve' | 'authorizeHandoff' | 'runAuthorizedHandoff'
        | 'authorizeDyadContinuation' | 'runAuthorizedDyadContinuation'
    >;
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
    /**
     * wtw7l: human escalation control plane and its durable ledger. Presence
     * projects every confirmation-queue enqueue and resolution onto the Garden
     * attention surface; absence leaves the queue behaving exactly as before.
     */
    confirmationEscalation?: ConfirmationEscalationProducerOptions<NotifyNtfyParams>;
    sharedSatelliteQuietHoursAllows?: (nowMs: number) => boolean;
    credentialPresence?: GatewayCredentialPresenceResult;
  }): GatewayServer;
}

export async function buildGatewayPrivilegedCore(
  input: GatewayPrivilegedCoreBuildInput,
): Promise<GatewayPrivilegedCore> {
  const eventBus = new EventBus();
  const poolTelemetryLog = createComponentLogger('IntakeScreeningPool');
  const approvalDisplayIdentity = input.config.companionFleet
    ? createCompanionDisplayIdentityResolver(input.config.companionFleet.companions)
    : undefined;
  const unknownApprovalDisplayIdentity = createCompanionDisplayIdentityResolver([]);
  const resolveApprovalDisplayLabel = (companionId: string): string => {
    if (approvalDisplayIdentity) {
      return approvalDisplayIdentity.resolve(companionId).displayLabel;
    }
    if (companionId === input.config.companionId) {
      return createCompanionDisplayIdentityResolver([{
        companionId,
        displayName: resolveCompanionNameFromConfig(input.config),
      }]).resolve(companionId).displayLabel;
    }
    return unknownApprovalDisplayIdentity.resolve(companionId).displayLabel;
  };
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
      onBudgetThresholdExceeded: (event) => {
        eventBus.emit('model.budget.threshold_exceeded', event).catch((error) => {
          input.logger.error('Failed to emit model budget threshold telemetry', {
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
  // ── Gateway ingress admission receipts (psfn-framework-ccgdz.2) ──
  // Receipt issuance was wired in the agent process but NOT here, so the
  // highest-volume channel ingress (Discord/Telegram/buzz/multica/api) admitted
  // bytes with no content-addressed proof. One receipt store per companion,
  // scoped to that companion's schema exactly like the fleet-wide read stores,
  // because a receipt is owned by exactly one companion.
  //
  // Each store is opened on that companion's OWN schema AND role, exactly like
  // the agent's `cogsec_receipts` store: whichever process connects first
  // creates the receipts table, and the creating role owns it. A gateway that
  // connected on the bare login role would leave the agent's REQUIRED readiness
  // failing on a table its tenant role cannot touch.
  //
  // The store is an OPTIONAL readiness entry: a receipt is admission PROOF, not
  // an admission gate, and its absence only forces the next consumer to screen
  // again (the safe direction). A schema failure is therefore recorded as a
  // named degradation and every screening result then reports
  // `no_receipt_writer` rather than staying silent — it never takes ingress
  // down, and it never converts an unproved admission into a proved one.
  const receiptLog = createComponentLogger('GatewayIntakeReceipts');
  const intakeReceiptTtl = intakeReceiptTtlMs(
    loadIntakePolicyConfig(input.startupHydration.systemDataDir).receipts,
  );
  const receiptStoresByCompanionId = new Map<string, PostgresCogSecReceiptStore>();
  for (const entry of resolveGatewayReceiptStoreTargets(input.config)) {
    const store = await awaitOptionalPostgresStoreReadiness(
      'gateway_cogsec_receipts',
      () => PostgresCogSecReceiptStore.connect(databaseUrl, entry.connectOptions),
    );
    if (!store) {
      receiptLog.warn('Gateway ingress admission receipts unavailable for companion', {
        ...(entry.companionId ? { companionId: entry.companionId } : {}),
        ...(entry.connectOptions.schema ? { schema: entry.connectOptions.schema } : {}),
        ...(entry.connectOptions.role ? { role: entry.connectOptions.role } : {}),
      });
      continue;
    }
    receiptStoresByCompanionId.set(entry.companionId ?? '', store);
  }
  const resolveIntakeReceipts = (
    companionId?: CompanionId,
  ) => {
    const store = receiptStoresByCompanionId.get(companionId ?? '');
    if (!store) return undefined;
    return {
      store,
      issuerId: COGSEC_INTAKE_FIREWALL_ISSUER_ID,
      ttlMs: intakeReceiptTtl,
    };
  };

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
    resolveReceipts: resolveIntakeReceipts,
    disposeReceipts: async () => {
      for (const store of receiptStoresByCompanionId.values()) {
        await store.close();
      }
    },
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
    // htm9.8: intake screeners share the gateway's sole pi-ai runtime and
    // resolve provider credentials through the existing request capability.
    screenerBackend: resolveIntakeScreenerBackend(input.config, privilegedServices.runtime),
    operatorAlerting: resolveOperatorAlertSinkConfiguration({
      ntfyConfigured: input.bootstrap.server.ntfy !== undefined,
      telegramEnabled: input.bootstrap.channelsConfig.telegram.enabled,
      telegramChatId: input.bootstrap.channelsConfig.telegram.operatorChatId,
      discordEnabled: true,
      discordChannelId: input.bootstrap.channelsConfig.discord.operatorAlert?.channelId,
    }),
    onQuarantineHeld: (companionId, entry) => {
      emitGardenQueueChanged(
        eventBus,
        'intake-quarantine',
        companionId ?? input.config.companionId,
      );
      // wtw7l: the same hold, on the one surface a person is asked to look at.
      // Resolved per hold rather than captured, because the escalation plane is
      // constructed after this core — the same late-binding the incident alert
      // sink beside it uses, and for the same startup-ordering reason.
      input.resolveQuarantineHoldEscalation?.()?.(entry);
    },
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
    onPostEscalation: async (companionId, event) => {
      await eventBus.emitRequired('intake.screening.post_escalation', {
        ...event,
        ...(companionId ? { companionId } : {}),
      });
    },
    onInlineShadowFinding: async (companionId, event) => {
      await eventBus.emitRequired('intake.screening.inline_shadow_finding', {
        ...event,
        ...(companionId ? { companionId } : {}),
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
    onScreeningPoolTelemetry: (companionId, event) => {
      // Content-free bounded-pool metrics (psfn-framework-yxz0z.4). Emitted as a
      // structured operational log so dashboards can read queue depth, wait /
      // service time, and worker saturation without any screened payload.
      poolTelemetryLog.info('Intake screening pool telemetry', {
        companionId: companionId ?? resolveCoreCompanionIdFromConfig(input.config),
        kind: event.kind,
        concurrency: event.concurrency,
        busyWorkers: event.busyWorkers,
        queueDepth: event.queueDepth,
        outstanding: event.outstanding,
        ...(event.waitMs !== undefined ? { waitMs: event.waitMs } : {}),
        ...(event.serviceMs !== undefined ? { serviceMs: event.serviceMs } : {}),
        ...(event.outcome !== undefined ? { outcome: event.outcome } : {}),
      });
    },
    singleStreamKey: resolveCoreCompanionIdFromConfig(input.config),
  });

  // htm9.18: durable CogSec event store for the canary egress tripwire. Shares
  // the same cogsec-events.json the contact-block gate and L3 screener use
  // (multi-writer, reloads from disk per op).
  const cogSecEvents = new CogSecEventStore(
    resolveCogSecEventsPath(input.startupHydration.companionDataDir),
  );
  const personaMutationOwners = input.config.companionFleet?.companions.map(companion => ({
    companionId: companion.companionId,
    companionDataDir: companion.companionDataDir,
    characterCardPath: companion.characterCardPath,
  })) ?? [{
    companionId: resolveCoreCompanionIdFromConfig(input.config),
    companionDataDir: input.startupHydration.companionDataDir,
    characterCardPath: input.config.characterCardPath,
  }];
  const personaMutationAttemptGuard = new PersonaMutationAttemptGuard({
    companions: personaMutationOwners.map(owner => ({
      companionId: owner.companionId,
      registry: createPersonaOwnerPathRegistry(owner),
      eventStore: owner.companionDataDir === input.startupHydration.companionDataDir
        ? cogSecEvents
        : new CogSecEventStore(resolveCogSecEventsPath(owner.companionDataDir)),
    })),
  });
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
      operatorDiscordDock,
      operatorDiscordChannelId,
      discordAccountDocks,
      pluginOutboundRoutes,
      companionChannels,
      icpAutonomyStore,
      icpInitiationPolicyAuthority,
      welfareGrantVerifier,
      contactLifecycleAuthority,
      shardApprovalWorkloads,
      confirmationEscalation,
      sharedSatelliteQuietHoursAllows,
      credentialPresence,
    }) => new GatewayServer({
      ...(discordAccountDocks ? { discordAccountDocks } : {}),
      ...(pluginOutboundRoutes ? { pluginOutboundRoutes } : {}),
      ...(companionChannels ? { companionChannels } : {}),
      ...(icpAutonomyStore ? { icpAutonomyStore } : {}),
      ...(icpInitiationPolicyAuthority ? { icpInitiationPolicyAuthority } : {}),
      ...(welfareGrantVerifier ? { welfareGrantVerifier } : {}),
      ...(contactLifecycleAuthority ? { contactLifecycleAuthority } : {}),
      ...(shardApprovalWorkloads ? { shardApprovalWorkloads } : {}),
      ...(confirmationEscalation ? { confirmationEscalation } : {}),
      ...(sharedSatelliteQuietHoursAllows ? { sharedSatelliteQuietHoursAllows } : {}),
      ...(credentialPresence ? { credentialPresence } : {}),
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
      ...(operatorDiscordDock ? { operatorDiscordDock } : {}),
      ...(operatorDiscordChannelId ? { operatorDiscordChannelId } : {}),
      gitOps,
      imageConfig: input.config,
      ...(privilegedServices.modelUsageStore ? { modelUsageRecorder: privilegedServices.modelUsageStore } : {}),
      ...(input.config.credentialVault ? { credentialVault: input.config.credentialVault } : {}),
      intakeScreeningMode: intakeScreening.globalMode,
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
      personaMutationAttemptGuard,
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
        return resolveApprovalDisplayLabel(companionId);
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
