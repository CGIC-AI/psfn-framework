import { isRecord } from '../../shared/utils/types.js';
// ── Gateway Server ──
// Host-side process that holds secrets and proxies all external interactions.

import * as net from 'node:net';
import type * as https from 'node:https';
import {
  JSONRPCServer,
  JSONRPCClient,
  JSONRPCServerAndClient,
  JSONRPCErrorException,
} from 'json-rpc-2.0';
import { DEFAULT_COMPANION_ID } from '../../core/identity/companion-naming.js';
import type { ChannelOutboundDock } from '../../channels/backplane/types.js';
import type { CapabilityTier, WyomingShardRoutingConfig } from '../../system/config/runtime-config-contracts.js';
import type { SubstrateMessage } from '../../shared/contracts/runtime.js';
import type { SatelliteRoutingMetadata } from '../../shared/contracts/satellite-registry.js';
import type { GatewayRpcConnection } from './transport.js';
import { GatewayInlineImageRetention } from './inline-image-retention.js';
import { createSocketServer, createWebSocketRpcServer } from './transport.js';
import {
  GatewayErrors,
  type GatewayCredentialPresenceResult,
  type GatewayPolicyDecision,
  type RuntimeHealthResult,
  type OperatorAlertResult,
  type NotifyNtfyParams,
  type VoiceHandleMessageResult,
} from './protocol.js';
import {
  disabledGatewayMultiCompanionConfig,
  resolveGatewaySurfaceForChannelType,
  type GatewayChannelSurface,
  type GatewayMultiCompanionConfig,
} from './multi-companion.js';
import type { ChannelPluginAccountRoute } from '../../channels/plugins/types.js';
import type { SessionHmacKeyring } from '../../persistence/journals/journal-utils.js';
import { resolvePersonalSkillsDir } from '../../persistence/layout.js';
import { createComponentLogger } from '../../shared/logger.js';
import { createCompanionDisplayIdentityResolver } from '../../shared/companion-display-identity.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import { registerGatewayMethods } from './methods/index.js';
import type { GatewayMethodRuntime } from './methods/types.js';
import { GatewayLLMRequestCancellation } from './llm-request-cancellation.js';
import { GatewayMcpRequestCancellation } from './methods/mcp.js';
import { GatewayMcpInvocationAuthority } from './mcp/invocation-authority.js';
import type { PolicyConfig } from './policy.js';
import {
  DEFAULT_AGENT_TIMEOUT_MS,
  requestAgentVoiceStream,
  type VoiceStreamRequestOptions,
} from './voice-stream-request.js';
import { GatewayNtfyNotifier, type GatewayNtfyConfig } from './ntfy-notifier.js';
import { GatewayOperatorAlertDispatcher } from './operator-alert-dispatcher.js';
import {
  createGatewayApprovalBoundaryService,
  type ApprovalBoundaryService,
} from './approval-boundary.js';
import { GatewayRuntimeHealthTracker } from './runtime-health.js';
import { evaluatePolicy } from './policy.js';
import type {
  ApiChatCompletionRpcParams,
  ApiChatCompletionRpcResult,
  ApiStreamDeltaNotification,
} from '../../channels/api/types.js';
import { verifyCompanionAuthToken } from './companion-auth.js';
import type { IntakeScreeningService } from '../../core/cogsec/intake/screening.js';
import { createCanaryEgressGuard, type CanaryEgressGuard } from './canary-egress-guard.js';
import {
  readCanaryCarrier,
  stripCanaryCarrier,
} from '../../core/cogsec/canary/egress-scan.js';
import type { GatewayVisionIntakeScreener } from './intake/compose-screening.js';
import type { GardenQueueName } from '../../shared/event-bus.js';
import type {
  ConfirmationQueueEntry,
  ConfirmationQueueHistoryEntry,
  ConfirmationApprovalOwner,
  ConfirmationResolveResult,
} from '../../system/capabilities/confirmation-queue.js';
import type { AuditSummaryEntry } from './audit-port.js';
import { parseCompanionRelayPublishParams } from '../../channels/backplane/companion-relay/relay.js';
import type { GatewayIcpAutonomyBroker } from './icp-autonomy-broker.js';
import {
  createGatewayIcpAutonomyBroker,
  registerGatewayIcpAutonomyRpc,
} from './icp-autonomy-rpc.js';
import {
  createCompanionId,
  type CompanionId,
} from '../../shared/routing/companion-id.js';
import { SharedCompanionWorkspaceReader } from '../../persistence/workspaces/shared-workspace-reader.js';
import { materializeGatewayAttachments } from './attachment-materialization.js';
import type { TurnPerformanceEvent } from '../../shared/telemetry/turn-performance.js';
import { resolveTierCapabilityTokens } from '../../system/capabilities/tiers.js';
import {
  ShardApprovalGrantAuthority,
  type AuthenticatedShardWorkloadHandle,
} from '../../system/capabilities/shard-approval-grants.js';
import { GatewayShardWorkloadRegistrar } from './shard-workload-registrar.js';
import {
  SharedSatelliteResponseArbiter,
  type SharedSatelliteEligibility,
  type SharedSatelliteLeaseAuditEvent,
} from './shared-satellite-response-arbiter.js';
import { GatewayFleetPostureCache } from './fleet-posture-cache.js';
import type { GatewayServerOptions } from './server/options.js';
import type { GatewayServerPorts } from './server/ports.js';
import { GatewayConnectionRouter } from './server/connection-routing.js';
import { GatewayInboundChannelDelivery } from './server/inbound-channel-delivery.js';
import { GatewayCompanionMessageLane } from './server/companion-message-lane.js';
import {
  GatewayCompanionViolations,
  type GatewayFleetConnectionSnapshot,
} from './server/companion-violations.js';
import {
  DEFAULT_CONNECTION_HEALTHCHECK_STALE_AFTER_MS,
  GatewayConnectionLifecycle,
} from './server/connection-lifecycle.js';
import {
  isIdentifiableGatewayConnectionRole,
  type GatewayConnectionRole,
  type GatewayConnectionStatus,
  type MalformedFrameKind,
} from './server/connection-status.js';
import {
  hasOwn,
  normalizeNdjsonFrameError,
  summarizeFramePreview,
  validateJsonRpcFrame,
} from './server/rpc-frame-validation.js';

const log = createComponentLogger('Gateway');
const unknownCompanionDisplayIdentity = createCompanionDisplayIdentityResolver([]);
const INVALID_FRAME_AUDIT_METHOD = 'gateway.ipc.frame.invalid';
export { evaluatePolicy };
export type { GatewayNtfyConfig, PolicyConfig, VoiceStreamRequestOptions };

const INTERNAL_SESSION_INTEGRITY_METHODS = new Set([
  'session.hmac.sign',
  'session.hmac.verify',
]);
const EMPTY_CREDENTIAL_PRESENCE: GatewayCredentialPresenceResult = {
  discordToken: false,
  apiKey: false,
  adminToken: false,
  openrouterApiKey: false,
  importProcessingLocalApiKey: false,
  falApiKey: false,
  telegramBotToken: false,
};

export { requireGatewaySessionHmacKeyring, resolveGatewaySessionHmacKeyring } from './session-hmac-env.js';
export type { GatewayServerOptions } from './server/options.js';
export type {
  GatewayFleetCompanionConnection,
  GatewayFleetConnectionSnapshot,
} from './server/companion-violations.js';

// ── Gateway Server Class ──

type IcpQueuedInvalidationReason =
  | 'peer_offline'
  | 'fatigue_exhausted'
  | 'operator_cancelled'
  | 'unknown_participant';

type IcpInvalidationAttemptOutcome =
  | { readonly ok: true; readonly revokedCount: number }
  | { readonly ok: false; readonly error: unknown };

interface PendingIcpInvalidation {
  readonly reasonCode: IcpQueuedInvalidationReason;
  /** Never rejects so failed invalidations remain observable and chainable. */
  readonly completion: Promise<IcpInvalidationAttemptOutcome>;
}

export class GatewayServer {
  private rpcServer: net.Server | https.Server | null = null;
  private readonly connections = new Set<GatewayRpcConnection>();
  private readonly rpcClients = new Map<GatewayRpcConnection, JSONRPCServerAndClient>();
  private readonly connectionStatuses = new Map<GatewayRpcConnection, GatewayConnectionStatus>();
  private readonly inlineImageRetentionByConnection = new Map<
    GatewayRpcConnection,
    GatewayInlineImageRetention
  >();
  private readonly llmRequestCancellationByConnection = new Map<
    GatewayRpcConnection,
    GatewayLLMRequestCancellation
  >();
  private readonly mcpRequestCancellationByConnection = new Map<
    GatewayRpcConnection,
    GatewayMcpRequestCancellation
  >();
  private readonly mcpInvocationAuthorityByConnection = new Map<
    GatewayRpcConnection,
    GatewayMcpInvocationAuthority
  >();
  private readonly options: GatewayServerOptions;
  private readonly sessionHmacKeyring: SessionHmacKeyring;
  private streamRequestCounter = 0;
  private readonly capabilityTierProvider: (companionId?: string) => CapabilityTier;
  private readonly wyomingShardRouting: WyomingShardRoutingConfig;
  private readonly ntfyNotifier: GatewayNtfyNotifier;
  private readonly operatorAlertDispatcher: GatewayOperatorAlertDispatcher;
  private readonly shardApprovalGrants: ShardApprovalGrantAuthority | undefined;
  private readonly shardWorkloadRegistrar: GatewayShardWorkloadRegistrar | undefined;
  private readonly approvalBoundary: ApprovalBoundaryService;
  private readonly canaryEgressGuard: CanaryEgressGuard | undefined;
  private readonly runtimeHealthTracker: GatewayRuntimeHealthTracker;
  private readonly apiStreamListeners = new Map<
    string,
    Set<(text: string, companionId?: string) => void>
  >();
  private readonly apiStreamCompanionTargets = new Map<string, CompanionId>();
  private readonly multiCompanion: GatewayMultiCompanionConfig;
  private readonly fleetCompanionIds: ReadonlySet<CompanionId>;
  private readonly companionConnections = new Map<CompanionId, GatewayRpcConnection>();
  private readonly companionLastSeen = new Map<CompanionId, number>();
  private readonly companionPostures = new GatewayFleetPostureCache<GatewayRpcConnection>();
  private readonly icpAutonomyBroker: GatewayIcpAutonomyBroker | null;
  private readonly pendingIcpInvalidations = new Map<string, PendingIcpInvalidation>();
  private readonly fatigueFencedCompanionIds = new Set<string>();
  private readonly gardenQueueChangeUnsubscribers: Array<() => void> = [];
  private readonly sharedWorkspaceReader: SharedCompanionWorkspaceReader | null;
  private readonly sharedSatelliteResponseArbiter: SharedSatelliteResponseArbiter;
  private readonly sharedSatelliteChatRequests = new Map<string, CompanionId>();
  private readonly connectionLifecycle: GatewayConnectionLifecycle;
  private readonly companionViolations: GatewayCompanionViolations;
  private readonly connectionRouter: GatewayConnectionRouter;
  private readonly inboundChannelDelivery: GatewayInboundChannelDelivery;
  private readonly companionMessageLane: GatewayCompanionMessageLane;

  private companionDisplayLabel(companionId: string): string {
    return this.options.approvalParentLabelProvider?.(companionId)?.trim()
      || unknownCompanionDisplayIdentity.resolve(companionId).displayLabel;
  }

  /** Typed ports handed to lifecycle modules: shared registry state + narrow callbacks. */
  private createServerPorts(): GatewayServerPorts {
    return {
      connections: this.connections,
      rpcClients: this.rpcClients,
      connectionStatuses: this.connectionStatuses,
      companionConnections: this.companionConnections,
      companionLastSeen: this.companionLastSeen,
      options: this.options,
      multiCompanion: this.multiCompanion,
      fleetCompanionIds: this.fleetCompanionIds,
      companionPostures: this.companionPostures,
      ntfyNotifier: this.ntfyNotifier,
      flushInboundChannelReplay: companionId => this.inboundChannelDelivery.flushInboundChannelReplay(companionId),
      refreshConnectionHealth: now => this.refreshConnectionHealth(now),
      alarmCompanionViolation: (event, message, details) => (
        this.companionViolations.alarmCompanionViolation(event, message, details)
      ),
      notifyAll: (method, params) => this.notifyAll(method, params),
      notifyOne: (conn, method, params) => this.notifyOne(conn, method, params),
      recordCompanionViolation: (event, details) => (
        this.companionViolations.recordCompanionViolation(event, details)
      ),
      resolveReadyCompanionConnection: companionId => (
        this.connectionRouter.resolveReadyCompanionConnection(companionId)
      ),
      resolveRoutedCompanionId: (surface, route) => (
        this.connectionRouter.resolveRoutedCompanionId(surface, route)
      ),
      operatorAlertDispatcher: this.operatorAlertDispatcher,
      icpAutonomyBroker: this.icpAutonomyBroker,
      audit: (method, decision, params) => this.audit(method, decision, params),
      auditComplete: (id, startTime, error) => this.auditComplete(id, startTime, error),
    };
  }

  constructor(options: GatewayServerOptions) {
    this.options = options;
    this.sharedSatelliteResponseArbiter = new SharedSatelliteResponseArbiter({
      audit: event => {
        void this.recordSharedSatelliteLeaseAudit(event).catch((error: unknown) => {
          log.error('Failed to persist shared-satellite response lease audit', {
            action: event.action,
            satelliteId: event.satelliteId,
            companionId: event.companionId,
            error: toErrorMessage(error),
          });
        });
      },
    });
    this.sessionHmacKeyring = options.sessionHmacKeyring;
    this.multiCompanion = options.multiCompanion ?? disabledGatewayMultiCompanionConfig();
    this.fleetCompanionIds = new Set(this.multiCompanion.fleetCompanionIds);
    this.sharedWorkspaceReader = this.multiCompanion.enabled && this.multiCompanion.sharedWorkspacePath
      ? new SharedCompanionWorkspaceReader(this.multiCompanion.sharedWorkspacePath)
      : null;
    // Fail at boot rather than on the first operator request: a gateway that
    // starts and then cannot list the shared workspace hides the missing
    // setting behind an RPC error nobody is watching.
    if (this.sharedWorkspaceReader && !options.sharedWorkspaceListBounds) {
      throw new Error(
        'GatewayServer exposes a governed shared workspace without listing bounds; '
        + 'settings.json must declare sharedWorkspaceListPageSize and '
        + 'sharedWorkspaceListPageBytes',
      );
    }
    if (options.companionChannels && !this.multiCompanion.enabled) {
      throw new Error(
        'GatewayServer received a companionChannels lane while multi-companion is disabled; '
        + 'the inter-companion lane must not exist in single-companion topology',
      );
    }
    if (options.icpAutonomyStore && !this.multiCompanion.enabled) {
      throw new Error(
        'GatewayServer received an icpAutonomyStore while multi-companion is disabled; '
        + 'the autonomy broker must not exist in single-companion topology',
      );
    }
    if (Boolean(options.icpAutonomyStore) !== Boolean(options.icpInitiationPolicyAuthority)) {
      throw new Error(
        'GatewayServer requires icpAutonomyStore and icpInitiationPolicyAuthority together',
      );
    }
    this.icpAutonomyBroker = options.icpAutonomyStore
      ? createGatewayIcpAutonomyBroker({
          store: options.icpAutonomyStore,
          fleetCompanionIds: this.fleetCompanionIds,
          companionChannels: options.companionChannels,
          isCompanionReady: companionId => this.connectionRouter.resolveReadyCompanionConnection(
            createCompanionId(companionId, 'isCompanionReady companionId'),
          ) !== null,
          readCompanionFatiguePosture: companionId => {
            const exactCompanionId = createCompanionId(
              companionId,
              'ICP fatigue posture companionId',
            );
            const connection = this.connectionRouter.resolveReadyCompanionConnection(exactCompanionId);
            return connection === null
              ? null
              : this.companionPostures.read(connection, exactCompanionId)?.fatigue.state ?? null;
          },
          hasRuntimeAvailabilityCapability: companionId => {
            const snapshot = options.capabilityGrantSnapshotProvider?.(companionId);
            const grantedTokens = snapshot?.grantedTokens
              ?? resolveTierCapabilityTokens(options.capabilityTierProvider?.(companionId) ?? 'nursery');
            return grantedTokens.includes('external.companion');
          },
          policyAuthority: options.icpInitiationPolicyAuthority!,
          eventBus: options.eventBus,
          alarm: (event, message, details) => this.companionViolations.alarmCompanionViolation(event, message, details),
        })
      : null;
    if (this.multiCompanion.enabled) {
      const missingWorkspaceRoots = this.multiCompanion.fleetCompanionIds.filter(
        (companionId) => {
          const workspacePath = this.multiCompanion.personalWorkspaceByCompanionId[companionId];
          return typeof workspacePath !== 'string' || !workspacePath.trim();
        },
      );
      if (missingWorkspaceRoots.length > 0) {
        throw new Error(
          'Multi-companion gateway requires one resolved Personal Workspace per fleet companion; '
          + `missing: ${missingWorkspaceRoots.join(', ')}`,
        );
      }
      log.info('Multi-companion gateway routing enabled', {
        channelRouting: this.multiCompanion.channelRouting,
        discordAccounts: this.multiCompanion.discordAccounts,
        pluginAccounts: this.multiCompanion.pluginAccounts,
      });
      if (options.intakeScreening || options.visionIntake) {
        throw new Error(
          'Multi-companion gateway intake screening must use companion-owned providers, not singleton services',
        );
      }
      if (!options.intakeScreeningProvider || !options.visionIntakeProvider) {
        throw new Error(
          'Multi-companion gateway requires companion-owned text and vision intake screening providers',
        );
      }
      for (const companionId of this.multiCompanion.fleetCompanionIds) {
        const screening = options.intakeScreeningProvider(companionId);
        if (!screening || screening.globalMode !== options.intakeScreeningMode) {
          throw new Error(
            `Fleet intake screening mode=${options.intakeScreeningMode} has no matching service for companion ${companionId}`,
          );
        }
        // Resolve every vision owner at construction too. Null is an explicit,
        // valid disabled posture; a missing/unknown owner must throw here.
        options.visionIntakeProvider(companionId);
      }
    } else {
      if (
        !options.intakeScreening
        || options.intakeScreening.globalMode !== options.intakeScreeningMode
      ) {
        throw new Error(
          `Single-companion intake screening mode=${options.intakeScreeningMode} has no matching service`,
        );
      }
    }
    if (this.discordAccountRoutingActive()) {
      const missingDocks = [...new Set(Object.values(this.multiCompanion.discordAccounts))]
        .filter(companionId => !options.discordAccountDocks?.has(companionId));
      if (missingDocks.length > 0) {
        throw new Error(
          'Multi-account discord routing requires an outbound dock per routed companion; '
          + `missing docks for: ${missingDocks.join(', ')}`,
        );
      }
    }
    this.capabilityTierProvider = options.capabilityTierProvider ?? (() => 'nursery');
    this.wyomingShardRouting = options.wyomingShardRouting;
    this.ntfyNotifier = new GatewayNtfyNotifier(options.ntfy);
    this.operatorAlertDispatcher = new GatewayOperatorAlertDispatcher({
      ntfy: this.ntfyNotifier,
      ...(options.telegramDock ? { telegramDock: options.telegramDock } : {}),
      ...(options.operatorTelegramChatId
        ? { telegramChatId: options.operatorTelegramChatId }
        : {}),
      ...(options.operatorDiscordDock ? { discordDock: options.operatorDiscordDock } : {}),
      ...(options.operatorDiscordChannelId
        ? { discordChannelId: options.operatorDiscordChannelId }
        : {}),
    });
    const cogSecMode = options.intakeScreeningMode;
    this.canaryEgressGuard = createCanaryEgressGuard({
      mode: cogSecMode,
      ...(options.cogSecEvents ? { cogSecEvents: options.cogSecEvents } : {}),
      log,
    });
    // 2h6q.3: the exact-once shard approval-grant authority exists only when
    // a server-owned authenticated workload registry is wired; the authority
    // is constructed here so the production GatewayServer construction path
    // (privileged-core createGatewayServer) reaches it without test-only glue.
    this.shardApprovalGrants = options.shardApprovalWorkloads
      ? new ShardApprovalGrantAuthority({
          workloadRegistry: options.shardApprovalWorkloads,
          audit: options.shardApprovalGrantAudit
            ?? ((event) => log.info('Shard approval grant audit', { ...event })),
        })
      : undefined;
    this.shardWorkloadRegistrar = options.shardApprovalWorkloads
      ? new GatewayShardWorkloadRegistrar(
          options.shardApprovalWorkloads,
          options.capabilityGrantSnapshotProvider,
        )
      : undefined;
    this.approvalBoundary = createGatewayApprovalBoundaryService({
      policyConfig: options.policyConfig,
      ntfyNotifier: this.ntfyNotifier,
      discordAdapter: options.discordAdapter,
      capabilityTierProvider: this.capabilityTierProvider,
      confirmation: options.confirmation,
      canaryEgressGuard: this.canaryEgressGuard,
      eventBus: options.eventBus,
      parentLabelProvider: options.approvalParentLabelProvider,
      ...(this.shardApprovalGrants
        ? { shardApprovalGrants: this.shardApprovalGrants }
        : {}),
      ...(options.confirmationEscalation
        ? { confirmationEscalation: options.confirmationEscalation }
        : {}),
      audit: this.audit.bind(this),
      auditComplete: this.auditComplete.bind(this),
      recordMethodSuccess: (method) => this.runtimeHealthTracker.recordMethodSuccess(method),
      recordMethodFailure: (method, error) => this.runtimeHealthTracker.recordMethodFailure(method, error),
      recordApprovalNotificationSuccess: () => this.runtimeHealthTracker.recordApprovalNotificationSuccess(),
      recordApprovalNotificationFailure: (error) => this.runtimeHealthTracker.recordApprovalNotificationFailure(error),
    });
    this.runtimeHealthTracker = new GatewayRuntimeHealthTracker({
      ntfyConfigured: Boolean(options.ntfy),
      operatorAlertingConfigured:
        this.operatorAlertDispatcher.configuration().status === 'configured',
      approvalNotificationConfigured: Boolean(
        options.confirmation?.operatorDiscordChannelId?.trim()
        || this.ntfyNotifier.hasConfiguredTopic(options.confirmation?.ntfyTopic),
      ),
      vaultEnabled: Boolean(options.policyConfig.vault?.enabled),
      vaultAllowActions: options.policyConfig.vault?.allowActions ?? [],
      vaultOpsConfigured: Boolean(options.policyConfig.vault?.ops),
      ...(options.mcpBroker ? { mcpBroker: options.mcpBroker } : {}),
    });
    const notifyConfirmationQueueChanged = ({ companionId }: { companionId: string }): void => {
      this.notifyCompanionGardenQueueChanged(companionId, 'confirmations');
    };
    this.gardenQueueChangeUnsubscribers.push(
      options.eventBus.on('companion.approval.requested', notifyConfirmationQueueChanged),
      options.eventBus.on('companion.approval.resolved', notifyConfirmationQueueChanged),
      options.eventBus.on('garden.queue.changed', ({ companionId, queue }) => {
        if (!companionId) {
          log.error('Refusing to route ownerless gateway Garden queue change', { queue });
          return;
        }
        this.notifyCompanionGardenQueueChanged(companionId, queue);
      }),
    );
    log.info('Session HMAC keyring configured', {
      activeVersion: this.sessionHmacKeyring.activeVersion,
      versionCount: Object.keys(this.sessionHmacKeyring.keys).length,
    });
    const ports = this.createServerPorts();
    this.connectionLifecycle = new GatewayConnectionLifecycle(ports);
    this.companionViolations = new GatewayCompanionViolations(ports);
    this.connectionRouter = new GatewayConnectionRouter(ports);
    this.inboundChannelDelivery = new GatewayInboundChannelDelivery(ports);
    this.companionMessageLane = new GatewayCompanionMessageLane(ports);
  }

  async notifyOperator(params: NotifyNtfyParams): Promise<OperatorAlertResult> {
    return await this.operatorAlertDispatcher.dispatch(params);
  }

  // Wrap a handler with audit timing — logs call, records duration/error on completion
  private audited<P, R>(
    method: string,
    handler: (params: P) => Promise<R>,
    paramsSummary?: (params: P) => Record<string, unknown>,
  ): (params: P) => Promise<R> {
    return async (params: P) => {
      // htm9.18 egress tripwire: hold the action if the session canary leaked
      // into an outbound method, and strip the carrier before it reaches the
      // handler or any audit summary.
      let cleaned: P;
      try {
        cleaned = (this.canaryEgressGuard
          ? this.canaryEgressGuard.inspect(method, params)
          : params) as P;
      } catch (err) {
        this.runtimeHealthTracker.recordMethodFailure(method, err);
        const heldAuditId = await this.audit(method, 'DENY', { canaryEgressHeld: true });
        await this.auditComplete(heldAuditId, Date.now(), toErrorMessage(err));
        throw err;
      }
      const summary = paramsSummary ? paramsSummary(cleaned) : undefined;
      const auditId = await this.audit(method, 'ALLOW', summary);
      const startTime = Date.now();
      try {
        const result = await handler(cleaned);
        this.runtimeHealthTracker.recordMethodSuccess(method);
        await this.auditComplete(auditId, startTime);
        return result;
      } catch (err) {
        this.runtimeHealthTracker.recordMethodFailure(method, err);
        const msg = toErrorMessage(err);
        await this.auditComplete(auditId, startTime, msg);
        throw err;
      }
    };
  }

  /**
   * d269: scan a reverse-RPC reply result at the gateway seam before it can
   * reach any channel adapter. Strips the reserved canary carrier in every
   * mode; when the CogSec guard is active, a reply carrying its own session
   * canary is HELD in enforce mode (recorded + audited) and observed in
   * shadow. This adds no RPC round-trips — one substring scan on the already
   * in-hand result.
   */
  private async inspectAgentReply<T>(method: string, result: T): Promise<T> {
    if (!this.canaryEgressGuard) {
      return stripCanaryCarrier(result) as T;
    }
    try {
      return this.canaryEgressGuard.inspectReply(method, result) as T;
    } catch (error) {
      const auditId = await this.audit(method, 'DENY', { canaryReplyHeld: true });
      await this.auditComplete(auditId, Date.now(), toErrorMessage(error));
      throw error;
    }
  }

  subscribeApiStream(
    requestId: string,
    listener: (text: string, companionId?: string) => void,
    companionId?: string,
  ): () => void {
    if (companionId) {
      const exactCompanionId = createCompanionId(
        companionId,
        'API stream target companionId',
      );
      const existingTarget = this.apiStreamCompanionTargets.get(requestId);
      if (existingTarget && existingTarget !== exactCompanionId) {
        throw new Error(`API stream request ${requestId} is already bound to another companion`);
      }
      this.apiStreamCompanionTargets.set(requestId, exactCompanionId);
    }
    const listeners = this.apiStreamListeners.get(requestId) ?? new Set();
    listeners.add(listener);
    this.apiStreamListeners.set(requestId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.apiStreamListeners.delete(requestId);
        this.apiStreamCompanionTargets.delete(requestId);
      }
    };
  }

  private dispatchApiStreamDelta(
    notification: ApiStreamDeltaNotification,
    companionId?: string,
  ): void {
    const listeners = this.apiStreamListeners.get(notification.requestId);
    if (!listeners) return;
    for (const listener of listeners) {
      listener(notification.text, companionId);
    }
  }

  private registerMethods(target: JSONRPCServerAndClient, conn: GatewayRpcConnection): void {
    const inlineImageRetention = new GatewayInlineImageRetention();
    this.inlineImageRetentionByConnection.set(conn, inlineImageRetention);
    const llmRequestCancellation = new GatewayLLMRequestCancellation();
    this.llmRequestCancellationByConnection.set(conn, llmRequestCancellation);
    const mcpRequestCancellation = new GatewayMcpRequestCancellation();
    this.mcpRequestCancellationByConnection.set(conn, mcpRequestCancellation);
    const mcpInvocationAuthority = new GatewayMcpInvocationAuthority();
    this.mcpInvocationAuthorityByConnection.set(conn, mcpInvocationAuthority);
    const resolveWorkspacePath = (): string => this.resolveConnectionWorkspacePath(conn);
    const resolvePolicyConfig = (): PolicyConfig => this.resolveConnectionPolicyConfig(conn);
    const resolveIntakeScreening = (): IntakeScreeningService | undefined =>
      this.options.intakeScreeningProvider
        ? this.options.intakeScreeningProvider(this.connectionRouter.authenticatedCompanionId(conn)) ?? undefined
        : this.options.intakeScreening;
    const resolveVisionIntake = (): GatewayVisionIntakeScreener | undefined =>
      this.options.visionIntakeProvider
        ? this.options.visionIntakeProvider(this.connectionRouter.authenticatedCompanionId(conn)) ?? undefined
        : this.options.visionIntake;
    const runtime: GatewayMethodRuntime = {
      target,
      llmProvider: this.options.llmProvider,
      llmRequestCancellation,
      mcpRequestCancellation,
      mcpInvocationAuthority,
      embeddingService: this.options.embeddingService,
      ...(this.options.modelDiscovery ? { modelDiscovery: this.options.modelDiscovery } : {}),
      discordAdapter: this.resolveConnectionDiscordDock(conn),
      resolveChannelOutboundDock: channelType => (
        this.resolveConnectionPluginOutboundDock(conn, channelType)
      ),
      ...(this.options.telegramDock ? { telegramDock: this.options.telegramDock } : {}),
      gitOps: this.options.gitOps,
      imageConfig: this.options.imageConfig,
      ...(this.options.modelUsageRecorder ? { modelUsageRecorder: this.options.modelUsageRecorder } : {}),
      ...(this.options.credentialVault ? { credentialVault: this.options.credentialVault } : {}),
      get intakeScreening() { return resolveIntakeScreening(); },
      ...(this.options.quarantinedArtifactGuard
        ? { quarantinedArtifactGuard: this.options.quarantinedArtifactGuard }
        : {}),
      ...(this.options.personaMutationAttemptGuard
        ? { personaMutationAttemptGuard: this.options.personaMutationAttemptGuard }
        : {}),
      get visionIntake() { return resolveVisionIntake(); },
      inlineImageRetention,
      get policyConfig() { return resolvePolicyConfig(); },
      get workspacePath() { return resolveWorkspacePath(); },
      personalWorkspaceIsolation: this.multiCompanion.enabled,
      sessionHmacKeyring: this.sessionHmacKeyring,
      // an52.3: bind the tier to THIS connection's authenticated companion so
      // shard.backend.request (and any gated method) resolves the caller's own
      // capability tier, not the gateway's single hydrated root.
      capabilityTierProvider: () => this.capabilityTierProvider(this.connectionRouter.authenticatedCompanionId(conn)),
      ...(this.options.capabilityGrantSnapshotProvider
        ? {
            capabilityGrantSnapshotProvider: () =>
              this.options.capabilityGrantSnapshotProvider!(this.connectionRouter.authenticatedCompanionId(conn)),
          }
        : {}),
      ...(this.options.shardBackendExecutor
        ? { shardBackendExecutor: this.options.shardBackendExecutor }
        : {}),
      // 2h6q.3: per-dispatch authenticated shard lineage for gated methods.
      resolveShardWorkloadForChannel: (channelId) =>
        this.resolveShardWorkloadForGatedDispatch(conn, channelId),
      approvalBoundary: this.approvalBoundary,
      ...(this.options.kubeSelfManagement
        ? { kubeSelfManagement: this.options.kubeSelfManagement }
        : {}),
      ...(this.options.contactLifecycleAuthority
        ? { contactLifecycleAuthority: this.options.contactLifecycleAuthority }
        : {}),
      ...(this.options.systemDataWriter
        ? { systemDataWriter: this.options.systemDataWriter }
        : {}),
      ...(this.options.mcpBroker ? { mcpBroker: this.options.mcpBroker } : {}),
      authenticatedCompanionId: () => this.connectionRouter.authenticatedCompanionId(conn),
      ...(this.options.welfareGrantVerifier
        ? {
            verifyWelfareGrant: (jobId: string, companionId: string) =>
              this.options.welfareGrantVerifier!.verify(jobId, companionId),
          }
        : {}),
      notifyRequester: (method, params) => this.connectionRouter.notifyRequestingConnection(conn, method, params),
      listPendingConfirmations: () => this.approvalBoundary.listPendingConfirmations(),
      listConfirmationHistory: () => this.approvalBoundary.listConfirmationHistory(),
      resolveConfirmation: (params) => {
        const companionId = this.connectionRouter.authenticatedCompanionId(conn);
        if (!companionId) {
          return Promise.resolve({
            id: params.id,
            status: 'not_found' as const,
            message: 'Confirmation request not found.',
            executed: false,
          });
        }
        return this.approvalBoundary.resolveConfirmationForOwner(
          companionId,
          params,
          { kind: 'companion', id: companionId },
        );
      },
      sendNtfy: (params) => this.ntfyNotifier.send(params),
      sendOperatorAlert: (params) => this.operatorAlertDispatcher.dispatch(params),
      getRuntimeHealth: () => this.getRuntimeHealth(this.connectionRouter.authenticatedCompanionId(conn)),
      getCredentialPresence: () => this.options.credentialPresence ?? EMPTY_CREDENTIAL_PRESENCE,
      nextStreamRequestId: () => `gw-${++this.streamRequestCounter}`,
      authorizeIcpConversationCorrelation: async (correlation) => {
        if (!this.icpAutonomyBroker) {
          throw new JSONRPCErrorException(
            'ICP autonomy broker is not configured',
            GatewayErrors.COMPANION_ROUTING_UNAVAILABLE,
          );
        }
        const companionId = this.connectionRouter.requireAuthenticatedAgentCompanionId(conn);
        return await this.icpAutonomyBroker.bindConversationCostCorrelation(
          companionId,
          correlation,
        );
      },
      recordAuditEvent: async (entry) => {
        if (this.options.auditStore) {
          await this.options.auditStore.recordSummary(entry);
        }
      },
      audited: (method, handler, paramsSummary) => this.audited(method, handler, paramsSummary),
    };

    registerGatewayMethods(runtime);
    registerGatewayIcpAutonomyRpc({
      target,
      broker: this.icpAutonomyBroker,
      requireAuthenticatedCompanionId: () => this.connectionRouter.requireAuthenticatedAgentCompanionId(conn),
      audited: (method, handler, paramsSummary) => this.audited(method, handler, paramsSummary),
    });
    target.addMethod('gateway.client.identify', (params: unknown) => this.identifyConnection(conn, params));
    target.addMethod('gateway.client.ready', (params: unknown) => this.markConnectionReady(conn, params));
    target.addMethod(
      'gateway.client.health',
      (params: unknown) => this.recordConnectionPosture(conn, params),
    );
    target.addMethod('shard.workload.register', this.audited(
      'shard.workload.register',
      async (params: unknown) => {
        const companionId = this.connectionRouter.requireAuthenticatedAgentCompanionId(conn);
        if (!this.shardWorkloadRegistrar) {
          throw new JSONRPCErrorException(
            'Shard workload registration is unavailable',
            GatewayErrors.POLICY_DENIED,
          );
        }
        return this.shardWorkloadRegistrar.register(conn, companionId, params);
      },
      () => ({
        companionId: this.connectionStatuses.get(conn)?.companionId ?? '(unidentified)',
      }),
    ));
    target.addMethod('shard.workload.end', this.audited(
      'shard.workload.end',
      async (params: unknown) => {
        this.connectionRouter.requireAuthenticatedAgentCompanionId(conn);
        if (!this.shardWorkloadRegistrar) {
          throw new JSONRPCErrorException(
            'Shard workload registration is unavailable',
            GatewayErrors.POLICY_DENIED,
          );
        }
        return this.shardWorkloadRegistrar.end(conn, params);
      },
      () => ({
        companionId: this.connectionStatuses.get(conn)?.companionId ?? '(unidentified)',
      }),
    ));
    target.addMethod('companion.message.send', this.audited(
      'companion.message.send',
      (params: unknown) => this.companionMessageLane.handleCompanionMessageSend(conn, params),
      (params: unknown) => ({
        senderCompanionId: this.connectionStatuses.get(conn)?.companionId ?? '(unidentified)',
        ...(isRecord(params) && typeof params.channelId === 'string' ? { channelId: params.channelId } : {}),
        ...(isRecord(params) && typeof params.content === 'string' ? { contentLength: params.content.length } : {}),
      }),
    ));
    target.addMethod('companion.message.report_failure', this.audited(
      'companion.message.report_failure',
      (params: unknown) => this.companionMessageLane.handleCompanionMessageFailureReport(conn, params),
      (params: unknown) => ({
        reportingCompanionId: this.connectionStatuses.get(conn)?.companionId ?? '(unidentified)',
        ...(isRecord(params) && typeof params.channelId === 'string' ? { channelId: params.channelId } : {}),
        ...(isRecord(params) && typeof params.messageId === 'string' ? { messageId: params.messageId } : {}),
        ...(isRecord(params) && typeof params.reason === 'string' ? { reason: params.reason } : {}),
      }),
    ));
    target.addMethod('api.stream.delta', (params: unknown) => {
      if (!isRecord(params)
        || typeof params.requestId !== 'string'
        || typeof params.text !== 'string') {
        this.companionViolations.alarmCompanionViolation(
          'api_stream_delta_rejected',
          'api.stream.delta rejected: notification shape is invalid',
          {
            senderCompanionId: this.connectionStatuses.get(conn)?.companionId ?? '(unidentified)',
          },
        );
        return null;
      }
      const notification: ApiStreamDeltaNotification = {
        requestId: params.requestId,
        text: params.text,
      };
      if (this.multiCompanion.enabled
        && !this.isConnectionAuthorizedForApiStream(conn, notification.requestId)) {
        const expectedCompanionId = this.apiStreamCompanionTargets.get(notification.requestId)
          ?? this.sharedSatelliteChatRequests.get(notification.requestId)
          ?? this.multiCompanion.channelRouting.api;
        this.companionViolations.alarmCompanionViolation(
          'api_stream_delta_rejected',
          'api.stream.delta rejected: sending connection is not the request-bound api companion',
          {
            senderCompanionId: this.connectionStatuses.get(conn)?.companionId ?? '(unidentified)',
            routedApiCompanionId: expectedCompanionId ?? '(unrouted)',
          },
        );
        return null;
      }
      // d269: streamed reply frames are main-reply egress. The agent attaches
      // the session canary under the reserved carrier key (never forwarded);
      // the guard scans the frame over a rolling per-request window and, in
      // enforce mode, a hit closes the stream tap for the request.
      const carrierToken = readCanaryCarrier(params);
      if (this.canaryEgressGuard) {
        const verdict = this.canaryEgressGuard.inspectApiStreamDelta({
          requestId: notification.requestId,
          text: notification.text,
          token: carrierToken,
        });
        if (!verdict.forward) return null;
      }
      this.dispatchApiStreamDelta(
        notification,
        this.connectionStatuses.get(conn)?.companionId,
      );
      return null;
    });
    target.addMethod('companion.event.publish', async (params: unknown) => {
      await this.dispatchCompanionEventPublish(conn, params);
      return null;
    });
    target.addMethod('shared.workspace.list', this.audited(
      'shared.workspace.list',
      (params: unknown) => this.listSharedWorkspaceArtifacts(conn, params),
      (params: unknown) => ({
        ...(isRecord(params) && typeof params.cursor === 'string'
          ? { cursor: params.cursor }
          : {}),
      }),
    ));
    target.addMethod('shared.workspace.read', this.audited(
      'shared.workspace.read',
      (params: unknown) => this.readSharedWorkspaceArtifact(conn, params),
      (params: unknown) => ({
        ...(isRecord(params) && typeof params.artifactPath === 'string'
          ? { artifactPath: params.artifactPath }
          : {}),
      }),
    ));
  }

  private requireSharedWorkspaceReader(conn: GatewayRpcConnection): SharedCompanionWorkspaceReader {
    const status = this.connectionStatuses.get(conn);
    if (!this.multiCompanion.enabled
      || status?.role !== 'agent'
      || !status.companionId
      || !this.sharedWorkspaceReader) {
      throw new Error('Shared workspace reads require an authenticated fleet companion connection');
    }
    return this.sharedWorkspaceReader;
  }

  private async listSharedWorkspaceArtifacts(conn: GatewayRpcConnection, params: unknown) {
    // A continuation cursor is the only accepted parameter. Page size stays
    // operator policy, so a caller can neither raise nor lower it, and any
    // other key is still an identity assertion attempt.
    const keys = isRecord(params) ? Object.keys(params) : [];
    const cursor = isRecord(params) ? params.cursor : undefined;
    if (params !== undefined
      && (!isRecord(params)
        || keys.some(key => key !== 'cursor')
        || (cursor !== undefined && typeof cursor !== 'string'))) {
      throw new Error('shared.workspace.list accepts no parameters or identity assertions');
    }
    const bounds = this.options.sharedWorkspaceListBounds;
    if (!bounds) {
      throw new Error('Shared workspace listing has no operator-declared bounds');
    }
    const reader = this.requireSharedWorkspaceReader(conn);
    const page = reader.listArtifacts({
      bounds,
      ...(typeof cursor === 'string' ? { cursor } : {}),
    });
    return { artifacts: page.artifacts, nextCursor: page.nextCursor };
  }

  private async readSharedWorkspaceArtifact(conn: GatewayRpcConnection, params: unknown) {
    if (!isRecord(params)
      || Object.keys(params).length !== 1
      || typeof params.artifactPath !== 'string') {
      throw new Error('shared.workspace.read requires only artifactPath; identity assertions are forbidden');
    }
    return this.requireSharedWorkspaceReader(conn).readArtifact(params.artifactPath);
  }

  private resolveConnectionWorkspacePath(conn: GatewayRpcConnection): string {
    if (!this.multiCompanion.enabled) {
      return this.options.policyConfig.workspacePath;
    }
    const companionId = this.connectionStatuses.get(conn)?.companionId;
    if (!companionId) {
      throw new Error('Multi-companion workspace access requires an authenticated companion connection');
    }
    const workspacePath = this.multiCompanion.personalWorkspaceByCompanionId[companionId];
    if (typeof workspacePath !== 'string' || !workspacePath.trim()) {
      throw new Error(`No Personal Workspace is resolved for companion ${companionId}`);
    }
    return workspacePath;
  }

  private resolveConnectionPolicyConfig(conn: GatewayRpcConnection): PolicyConfig {
    if (!this.multiCompanion.enabled) {
      return this.options.policyConfig;
    }
    // Method registration inspects policy feature flags before the connection
    // can authenticate. Request dispatch still rejects every non-identify RPC
    // from an unidentified connection; return the base config only for that
    // registration phase and bind the personal policy after identify.
    if (!this.connectionStatuses.get(conn)?.companionId) {
      return this.options.policyConfig;
    }
    const workspacePath = this.resolveConnectionWorkspacePath(conn);
    const { fullCodebaseReadRoot: _ignoredReadRoot, ...basePolicy } = this.options.policyConfig;
    return {
      ...basePolicy,
      workspacePath,
      allowedReadPaths: [workspacePath],
      protectedWritePaths: [
        ...(basePolicy.protectedWritePaths ?? []),
        resolvePersonalSkillsDir(workspacePath),
      ],
      ...(basePolicy.shellExec
        ? { shellExec: { ...basePolicy.shellExec, allowedCwd: [workspacePath] } }
        : {}),
    };
  }

  /**
   * Agent-forwarded redacted companion events (tool activity, artifacts,
   * emotion snapshots). The params are re-validated and payloads reconstructed
   * field-by-field at this process boundary; malformed frames are rejected,
   * never partially published. Approval events cannot arrive here — they
   * originate inside the gateway approval boundary.
   */
  private async dispatchCompanionEventPublish(
    conn: GatewayRpcConnection,
    params: unknown,
  ): Promise<void> {
    const parsed = parseCompanionRelayPublishParams(params);
    const companionId = this.connectionStatuses.get(conn)?.companionId;
    if (this.multiCompanion.enabled && !companionId) {
      throw new Error('companion.event.publish requires an authenticated companion identity');
    }
    if (parsed.kind === 'tool.activity') {
      await this.options.eventBus.emit('companion.tool.activity', {
        payload: parsed.payload,
        ...(parsed.channelId ? { channelId: parsed.channelId } : {}),
        ...(companionId ? { companionId } : {}),
        timestamp: Date.now(),
      });
      return;
    }
    if (parsed.kind === 'emotion.snapshot') {
      await this.options.eventBus.emit('companion.emotion.snapshot', {
        payload: parsed.payload,
        ...(parsed.channelId ? { channelId: parsed.channelId } : {}),
        ...(companionId ? { companionId } : {}),
        timestamp: Date.now(),
      });
      return;
    }
    await this.options.eventBus.emit('companion.artifact.created', {
      payload: parsed.payload,
      ...(parsed.preview ? { preview: parsed.preview } : {}),
      ...(parsed.channelId ? { channelId: parsed.channelId } : {}),
      ...(companionId ? { companionId } : {}),
      timestamp: Date.now(),
    });
  }

  /**
   * Companion relay approval surface (w9hj.1): decisions from the Satellite
   * Hub resolve through the SAME approval boundary / confirmation queue as
   * operator decisions — no bypass of the capability-tier path.
   */
  resolveCompanionApproval(params: {
    id: string;
    decision: 'approve' | 'deny';
    companionId: string;
  }): Promise<ConfirmationResolveResult> {
    return this.approvalBoundary.resolveConfirmationForOwner(params.companionId, params, {
      kind: 'companion',
      id: `companion-relay:${params.companionId}`,
    });
  }

  resolveOperatorApproval(params: {
    id: string;
    decision: 'approve' | 'deny' | 'modify';
    modifiedParams?: Record<string, unknown>;
  }): Promise<ConfirmationResolveResult> {
    return this.approvalBoundary.resolveConfirmation(params, {
      kind: 'operator',
      id: 'garden-admin',
    });
  }

  resolveOperatorApprovalForOwner(
    companionId: string,
    params: {
      id: string;
      decision: 'approve' | 'deny' | 'modify';
      modifiedParams?: Record<string, unknown>;
    },
  ): Promise<ConfirmationResolveResult> {
    return this.approvalBoundary.resolveConfirmationForOwner(companionId, params, {
      kind: 'operator',
      id: `garden-admin:${companionId}`,
    });
  }

  resolveCompanionUiApproval(
    companionId: string,
    params: {
      id: string;
      decision: 'approve' | 'deny';
    },
  ): Promise<ConfirmationResolveResult> {
    return this.approvalBoundary.resolveConfirmationForOwner(companionId, params, {
      kind: 'operator',
      id: `companion-ui:${companionId}`,
    });
  }

  listCompanionUiConfirmations(companionId: string): readonly ConfirmationQueueEntry[] {
    return this.approvalBoundary.listPendingConfirmationsForOwner(companionId);
  }

  listOperatorConfirmations(): Readonly<{
    pending: ConfirmationQueueEntry[];
    history: ConfirmationQueueHistoryEntry[];
  }> {
    return Object.freeze({
      pending: this.approvalBoundary.listPendingConfirmations(),
      history: this.approvalBoundary.listConfirmationHistory(),
    });
  }

  /**
   * Read-only owner attribution for a confirmation id (companion roster wire).
   * Returns the authenticated companion that enqueued the confirmation, or
   * `undefined` when none is recorded — the fleet-wide approvals view excludes
   * ownerless entries so an approval is never mis-attributed.
   */
  ownerOfConfirmation(id: string): string | undefined {
    return this.approvalBoundary.ownerOfConfirmation(id);
  }

  approvalOwnerOfConfirmation(id: string): ConfirmationApprovalOwner | undefined {
    return this.approvalBoundary.approvalOwnerOfConfirmation(id);
  }

  findConfirmationHistoryEntry(id: string): ConfirmationQueueHistoryEntry | null {
    return this.approvalBoundary.listConfirmationHistory()
      .find((entry) => entry.id === id) ?? null;
  }

  /** Operator/fleet-reload hook: revoke pending autonomy before removing identity. */
  isIcpAutonomyConfigured(): boolean {
    return this.icpAutonomyBroker !== null;
  }

  async invalidateIcpAutonomyForCompanion(
    companionId: string,
    reasonCode: 'operator_cancelled' | 'unknown_participant' = 'operator_cancelled',
  ): Promise<number> {
    if (!this.icpAutonomyBroker) {
      throw new Error('ICP autonomy lifecycle control is not configured');
    }
    return await this.queueIcpInvalidation(companionId, reasonCode);
  }

  /** Fail-closed audit hook for companion relay decisions. */
  async recordCompanionAuditSummary(entry: AuditSummaryEntry): Promise<void> {
    if (!this.options.auditStore) {
      throw new Error('Gateway audit store is not configured');
    }
    await this.options.auditStore.recordSummary(entry);
  }

  /** True when per-account discord routing (W1-P2 multi-account) is active. */
  private discordAccountRoutingActive(): boolean {
    return this.multiCompanion.enabled
      && Object.keys(this.multiCompanion.discordAccounts).length > 0;
  }

  /**
   * Outbound discord dock for one agent connection. Single-companion mode and
   * W1 single-account multi-companion mode keep today's shared adapter
   * byte-identical; multi-account mode resolves the calling companion's own
   * bot account at send time and fails closed (alarm + error) when the
   * connection is unidentified or its companion owns no discord account —
   * cross-account egress is structurally impossible because the dock is
   * derived from the connection's bound companionId, never from parameters.
   */
  private resolveConnectionDiscordDock(conn: GatewayRpcConnection): ChannelOutboundDock {
    if (!this.discordAccountRoutingActive()) {
      return this.options.discordAdapter;
    }
    const requireDock = (): ChannelOutboundDock => this.requireCompanionDiscordDock(conn);
    return {
      id: 'discord',
      outbound: {
        textChunkLimit: this.options.discordAdapter.outbound.textChunkLimit,
        sendText: async (ctx, text) => {
          await requireDock().outbound.sendText(ctx, text);
        },
        sendMedia: async (ctx, media) => {
          const dock = requireDock();
          if (!dock.outbound.sendMedia) {
            throw new Error('Discord outbound dock does not support media sends');
          }
          await dock.outbound.sendMedia(ctx, media);
        },
      },
      availability: {
        setAvailability: async state => {
          const dock = requireDock();
          return dock.availability
            ? dock.availability.setAvailability(state)
            : 'unsupported';
        },
      },
    };
  }

  private requireCompanionDiscordDock(conn: GatewayRpcConnection): ChannelOutboundDock {
    const companionId = this.connectionStatuses.get(conn)?.companionId;
    if (!companionId) {
      this.companionViolations.alarmCompanionViolation(
        'discord_send_unidentified',
        'Discord outbound rejected: connection has no bound companionId',
        {},
      );
      throw new Error('Multi-account discord outbound requires an identified companion connection');
    }
    const dock = this.options.discordAccountDocks?.get(companionId);
    if (!dock) {
      this.companionViolations.alarmCompanionViolation(
        'discord_send_no_account',
        `Discord outbound rejected: companion "${companionId}" owns no discord bot account`,
        { companionId },
      );
      throw new Error(
        `Companion "${companionId}" has no discord bot account; sending through another `
        + 'companion\'s account is not permitted',
      );
    }
    return dock;
  }

  private resolveConnectionPluginOutboundDock(
    conn: GatewayRpcConnection,
    pluginId: 'buzz',
  ): ChannelOutboundDock {
    const routes = this.options.pluginOutboundRoutes ?? [];
    const companionId = this.connectionStatuses.get(conn)?.companionId;
    const ownedRoutes = this.multiCompanion.enabled
      ? routes.filter(route => route.companionId === companionId)
      : routes;
    if (this.multiCompanion.enabled && !companionId) {
      this.companionViolations.alarmCompanionViolation(
        'channel_send_unidentified',
        `${pluginId} outbound rejected: connection has no bound companionId`,
        { pluginId },
      );
      throw new Error(`${pluginId} outbound requires an identified companion connection`);
    }
    if (ownedRoutes.length !== 1) {
      this.companionViolations.alarmCompanionViolation(
        'channel_send_no_account',
        `${pluginId} outbound rejected: caller does not own exactly one account`,
        { pluginId, ...(companionId ? { companionId } : {}), accountCount: ownedRoutes.length },
      );
      throw new Error(
        companionId
          ? `Companion "${companionId}" does not own exactly one ${pluginId} account`
          : `${pluginId} outbound requires exactly one configured account`,
      );
    }
    return ownedRoutes[0]!.dock;
  }

  private isConnectionAuthorizedForApiStream(
    conn: GatewayRpcConnection,
    requestId: string,
  ): boolean {
    const routedCompanionId = this.apiStreamCompanionTargets.get(requestId)
      ?? this.sharedSatelliteChatRequests.get(requestId)
      ?? this.multiCompanion.channelRouting.api;
    if (!routedCompanionId) {
      return false;
    }
    return this.connectionStatuses.get(conn)?.companionId === routedCompanionId;
  }

  /**
   * 2h6q.3: bind a gated dispatch to its authenticated shard workload. The
   * runtime-stamped correlation channel id is only a lookup key into the
   * server-owned workload registry; every authority value (parent binding,
   * generation, frozen derived access) comes from registration state. Fail
   * closed: a recognizably shard-originated channel that cannot be bound to
   * a live workload of THIS connection's authenticated companion is denied —
   * it must never fall through to the parent's own (possibly autonomous)
   * authority. Recognition is registry-backed, not just prefix-based:
   * satellite/Wyoming shard workloads register arbitrary channel schemes, so
   * the registry's ever-hosted tombstones (live, ended, or superseded
   * generations) deny alongside the `shard:` scheme rule, which alone covers
   * the no-registry configuration.
   */
  private resolveShardWorkloadForGatedDispatch(
    conn: GatewayRpcConnection,
    channelId: string | undefined,
  ): {
    workload: AuthenticatedShardWorkloadHandle;
    identity: import('../../system/capabilities/shard-approval-grant-contracts.js').AuthenticatedShardWorkloadIdentity;
  } | undefined {
    const normalized = channelId?.trim();
    if (!normalized) {
      return undefined;
    }
    const registry = this.options.shardApprovalWorkloads;
    const companionId = this.connectionRouter.authenticatedCompanionId(conn);
    if (registry && companionId) {
      // May throw on ambiguous channel lineage — ambiguity is a denial.
      const workload = registry.resolveWorkloadForChannel(companionId, normalized);
      if (workload) {
        if (!this.shardApprovalGrants) {
          throw new JSONRPCErrorException(
            'Shard-originated request denied: authenticated shard authority is unavailable',
            GatewayErrors.POLICY_DENIED,
          );
        }
        return {
          workload,
          identity: this.shardApprovalGrants.resolveAuthenticatedWorkload(workload),
        };
      }
    }
    const shardRecognizable = normalized.startsWith('shard:')
      || (registry !== undefined
        && companionId !== undefined
        && registry.hasHostedWorkloadForChannel(companionId, normalized));
    if (shardRecognizable) {
      throw new JSONRPCErrorException(
        'Shard-originated request denied: no live authenticated shard workload matches this dispatch',
        GatewayErrors.POLICY_DENIED,
      );
    }
    return undefined;
  }

  private notifyCompanionGardenQueueChanged(
    companionId: string,
    queue: GardenQueueName,
  ): void {
    this.connectionLifecycle.refreshConnectionHealth();
    if (this.multiCompanion.enabled) {
      const conn = this.connectionRouter.resolveReadyCompanionConnection(
        createCompanionId(companionId, 'garden queue change companionId'),
      );
      if (!conn) {
        log.warn('Garden queue change owner has no healthy ready agent connection', {
          companionId,
          queue,
        });
        return;
      }
      this.notifyOne(conn, 'garden.queue.changed', { queue });
      return;
    }

    for (const conn of this.connections) {
      const status = this.connectionStatuses.get(conn);
      if (status?.role !== 'agent' || status.state !== 'ready' || status.health !== 'healthy') {
        continue;
      }
      const connectionCompanionId = status.companionId
        ?? this.options.companionId
        ?? DEFAULT_COMPANION_ID;
      if (connectionCompanionId === companionId) {
        this.notifyOne(conn, 'garden.queue.changed', { queue });
      }
    }
  }

  // ── Connection management ──

  start(): void {
    const endpoint = this.options.gatewayRpcEndpoint ?? {
      kind: 'unix' as const,
      socketPath: this.options.socketPath,
    };

    this.rpcServer = endpoint.kind === 'unix'
      ? createSocketServer(endpoint.socketPath, (conn) => this.registerConnection(conn))
      : createWebSocketRpcServer({
          host: endpoint.host,
          port: endpoint.port,
          path: endpoint.path,
          tls: endpoint.tls,
        }, (conn) => this.registerConnection(conn));
  }

  private registerConnection(conn: GatewayRpcConnection): void {
    log.info('Agent connected');
    this.connections.add(conn);
    this.connectionStatuses.set(conn, {
      role: this.multiCompanion.enabled ? 'unidentified' : 'agent',
      state: 'registering',
      stateReason: 'connection_opened',
      health: 'healthy',
      connectedAt: Date.now(),
      lastHealthcheckAt: Date.now(),
      lastTransitionAt: Date.now(),
      healthcheckStaleAfterMs: DEFAULT_CONNECTION_HEALTHCHECK_STALE_AFTER_MS,
      runtimeReadyDeclared: !this.multiCompanion.enabled,
    });
    this.connectionLifecycle.appendConnectionTransition(conn, 'none', 'registering', 'connection_opened');

    const serverAndClient = new JSONRPCServerAndClient(
      new JSONRPCServer(),
      new JSONRPCClient((request) => { conn.send(request); }),
    );
    this.registerMethods(serverAndClient, conn);
    this.rpcClients.set(conn, serverAndClient);
    if (!this.multiCompanion.enabled) {
      this.connectionLifecycle.transitionConnectionState(conn, 'ready', 'rpc_registered');
    }

    conn.on('frameError', (error: unknown) => {
      const frameError = normalizeNdjsonFrameError(error);
      this.handleMalformedFrame(conn, 'ndjson', frameError.reason, frameError.preview);
    });

    conn.on('heartbeat', () => {
      this.connectionLifecycle.touchConnectionHealthcheck(conn);
    });

    conn.onMessage((message) => {
      void (async (): Promise<void> => {
        if (!this.connections.has(conn)) {
          return;
        }
        this.connectionLifecycle.touchConnectionHealthcheck(conn);
        const validationError = validateJsonRpcFrame(message);
        if (validationError) {
          this.handleMalformedFrame(
            conn,
            'jsonrpc',
            validationError,
            summarizeFramePreview(message),
          );
          return;
        }
        const verdict = this.enforceCompanionFrameIdentity(conn, message as Record<string, unknown>);
        if (verdict !== 'pass') {
          return;
        }
        if (
          !this.multiCompanion.enabled
          && (message as Record<string, unknown>).method !== 'gateway.client.identify'
        ) {
          this.connectionLifecycle.transitionConnectionState(conn, 'ready', 'rpc_message_received');
        }
        const releaseInFlightHealthcheck = this.connectionLifecycle.beginInFlightHealthcheck(conn);
        // json-rpc-2.0 receiveAndSend() payload param is typed as `any`; message is parsed JSON
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        try {
          await serverAndClient.receiveAndSend(message as any);
        } catch (error) {
          const messageText = toErrorMessage(error);
          this.handleMalformedFrame(
            conn,
            'jsonrpc',
            `JSON-RPC receive/send failed: ${messageText}`,
            summarizeFramePreview(message),
          );
        } finally {
          releaseInFlightHealthcheck();
        }
      })().catch((handlingError: unknown) => {
        log.error('Gateway connection message handling failed', {
          error: toErrorMessage(handlingError),
        });
      });
    });

    conn.on('close', () => {
      log.info('Agent disconnected');
      this.connectionLifecycle.transitionConnectionState(conn, 'offline', 'connection_closed');
      this.removeConnection(conn);
    });

    conn.on('error', (err) => {
      const messageText = err instanceof Error ? err.message : String(err);
      log.error('Connection error', { error: messageText });
      this.connectionLifecycle.transitionConnectionState(conn, 'degraded', 'connection_error', messageText);
      this.connectionLifecycle.transitionConnectionState(conn, 'offline', 'connection_error', messageText);
      this.removeConnection(conn);
    });
  }

  // Send to eligible agents and count only transports that accepted the frame.
  notifyAll(method: string, params: unknown): number {
    const notification = {
      jsonrpc: '2.0' as const,
      method,
      params,
    };
    let recipientCount = 0;
    for (const conn of this.connections) {
      const status = this.connectionStatuses.get(conn);
      if (status?.role !== 'agent' || status.state !== 'ready' || status.health !== 'healthy') {
        continue;
      }
      if (conn.send(notification)) {
        recipientCount += 1;
      }
    }
    return recipientCount;
  }

  // Send to one connection and report whether its transport accepted the frame.
  notifyOne(conn: GatewayRpcConnection, method: string, params: unknown): boolean {
    return conn.send({
      jsonrpc: '2.0' as const,
      method,
      params,
    });
  }

  /**
   * Deliver an inbound channel message to its owning agent.
   * Single-companion mode keeps today's broadcast semantics byte-identical;
   * multi-companion mode resolves exactly one companion via the channels.json
   * routing table and fails closed on any ambiguity.
   */
  notifyChannelMessage(
    surface: GatewayChannelSurface,
    method: string,
    params: unknown,
    discordAccountId?: string,
  ): number {
    return this.inboundChannelDelivery.notifyChannelMessage(surface, method, params, discordAccountId);
  }

  /**
   * Fail-closed connection authorization applied to every inbound method:
   * - unidentified connections may call only gateway.client.identify;
   * - internal session-integrity connections may call only HMAC sign/verify;
   * - normal agents may not call those internal signing methods;
   * - multi-companion frames remain pinned to the authenticated companion id.
   * - a frame claiming a companionId different from the connection's identified
   *   companionId is treated as identity spoofing → audit + disconnect;
   * - agent-role connections must identify with a companionId before any other
   *   RPC → requests are rejected with COMPANION_IDENTIFY_REQUIRED.
   * Responses to gateway-originated requests pass through untouched.
   */
  private enforceCompanionFrameIdentity(
    conn: GatewayRpcConnection,
    frame: Record<string, unknown>,
  ): 'pass' | 'rejected' | 'disconnected' {
    if (!hasOwn(frame, 'method')) {
      return 'pass';
    }
    const method = typeof frame.method === 'string' ? frame.method : '';
    if (method === 'gateway.client.identify') {
      return 'pass';
    }
    const status = this.connectionStatuses.get(conn);
    if (!status) {
      return 'rejected';
    }
    const boundCompanionId = status.companionId;
    const params = isRecord(frame.params) ? frame.params : undefined;
    const hasClaimedCompanionId = params !== undefined && Object.hasOwn(params, 'companionId');
    const claimedRaw = params?.companionId;

    if (status.role === 'unidentified') {
      this.companionViolations.alarmCompanionViolation(
        'identify_required',
        `RPC "${method}" rejected: connection has not authenticated a role`,
        { method },
      );
      if (hasOwn(frame, 'id')) {
        conn.send({
          jsonrpc: '2.0' as const,
          id: frame.id as string | number | null,
          error: {
            code: GatewayErrors.COMPANION_IDENTIFY_REQUIRED,
            message: 'gateway.client.identify is required before other RPC methods',
          },
        });
      }
      return 'rejected';
    }

    const isInternalMethod = INTERNAL_SESSION_INTEGRITY_METHODS.has(method);
    if (
      (status.role === 'internal_session_integrity' && !isInternalMethod)
      || (status.role === 'agent' && isInternalMethod)
    ) {
      this.companionViolations.alarmCompanionViolation(
        'connection_role_denied',
        `RPC "${method}" is not permitted for gateway role "${status.role}"`,
        { method, role: status.role, ...(boundCompanionId ? { companionId: boundCompanionId } : {}) },
      );
      if (hasOwn(frame, 'id')) {
        conn.send({
          jsonrpc: '2.0' as const,
          id: frame.id as string | number | null,
          error: {
            code: GatewayErrors.CONNECTION_ROLE_DENIED,
            message: `Gateway role "${status.role}" is not authorized for ${method}`,
          },
        });
      }
      return 'rejected';
    }

    let claimedCompanionId: CompanionId | undefined;
    if (hasClaimedCompanionId) {
      try {
        claimedCompanionId = createCompanionId(claimedRaw, 'RPC frame companionId');
      } catch (error) {
        this.companionViolations.alarmCompanionViolation(
          'identity_claim_invalid',
          'RPC frame carried an invalid companionId claim; disconnecting connection',
          { method, boundCompanionId, reason: toErrorMessage(error) },
        );
        this.connectionLifecycle.transitionConnectionState(conn, 'degraded', 'companion_identity_claim_invalid');
        this.connectionLifecycle.transitionConnectionState(conn, 'offline', 'companion_identity_claim_invalid');
        this.removeConnection(conn);
        if (!conn.destroyed) {
          conn.destroy();
        }
        return 'disconnected';
      }
    }

    // Single-companion mode retains its existing socket-trust contract for
    // normal agent methods, but a frame that explicitly carries a malformed
    // identity claim is still invalid and never reaches method dispatch.
    if (!this.multiCompanion.enabled && status.role === 'agent') {
      return 'pass';
    }

    if (claimedCompanionId && boundCompanionId && claimedCompanionId !== boundCompanionId) {
      this.companionViolations.alarmCompanionViolation(
        'identity_mismatch',
        'Companion identity mismatch on RPC frame; disconnecting connection',
        { method, boundCompanionId, claimedCompanionId },
      );
      this.connectionLifecycle.transitionConnectionState(conn, 'degraded', 'companion_identity_mismatch');
      this.connectionLifecycle.transitionConnectionState(conn, 'offline', 'companion_identity_mismatch');
      this.removeConnection(conn);
      if (!conn.destroyed) {
        conn.destroy();
      }
      return 'disconnected';
    }

    if (this.multiCompanion.enabled && !boundCompanionId) {
      this.companionViolations.alarmCompanionViolation(
        'identify_required',
        `RPC "${method}" rejected: agent connection has not identified a companionId`,
        { method },
      );
      if (hasOwn(frame, 'id')) {
        conn.send({
          jsonrpc: '2.0' as const,
          id: frame.id as string | number | null,
          error: {
            code: GatewayErrors.COMPANION_IDENTIFY_REQUIRED,
            message: 'Multi-companion mode requires an authenticated companionId before other RPC methods',
          },
        });
      }
      return 'rejected';
    }

    return 'pass';
  }

  /**
   * Read-only fleet health view: identified companion
   * connections, last-seen activity (retained across disconnects), and recent
   * multi-companion violation counts. Available for bounded, server-side fleet
   * projections and internal operations; never mutates connection state.
   */
  getFleetConnectionSnapshot(now = Date.now()): GatewayFleetConnectionSnapshot {
    return this.companionViolations.getFleetConnectionSnapshot(now);
  }

  private removeConnection(conn: GatewayRpcConnection): void {
    // A crashed/restarted agent cannot leave a grant-bearing generation live.
    this.shardWorkloadRegistrar?.releaseConnection(conn);
    const status = this.connectionStatuses.get(conn);
    if (status?.companionId) {
      // Preserve last-seen across the disconnect so the fleet view can report
      // when a now-down companion was last alive.
      this.companionLastSeen.set(status.companionId, status.lastHealthcheckAt);
    }
    if (status?.companionId && this.companionConnections.get(status.companionId) === conn) {
      this.companionConnections.delete(status.companionId);
      this.icpAutonomyBroker?.markRuntimeAvailabilityInactive(status.companionId);
      this.fatigueFencedCompanionIds.delete(status.companionId);
      log.info(`${this.companionDisplayLabel(status.companionId)} connection unbound`, {
        companionId: status.companionId,
      });
      void this.queueIcpInvalidation(status.companionId, 'peer_offline')
        .catch((error: unknown) => {
          log.error('Failed to invalidate ICP permits after companion disconnect', {
            companionId: status.companionId,
            error: toErrorMessage(error),
          });
        });
    }
    this.connections.delete(conn);
    this.companionPostures.unbind(conn);
    this.inlineImageRetentionByConnection.get(conn)?.clear();
    this.inlineImageRetentionByConnection.delete(conn);
    this.llmRequestCancellationByConnection.get(conn)?.abortAll();
    this.llmRequestCancellationByConnection.delete(conn);
    this.mcpRequestCancellationByConnection.get(conn)?.abortAll();
    this.mcpRequestCancellationByConnection.delete(conn);
    this.mcpInvocationAuthorityByConnection.get(conn)?.clear();
    this.mcpInvocationAuthorityByConnection.delete(conn);
    const companionId = status?.companionId ?? this.options.companionId;
    if (companionId && this.options.mcpBroker) {
      void this.options.mcpBroker.releaseCompanion(companionId).catch((error: unknown) => {
        log.error('Failed to release MCP sessions after companion disconnect', {
          companionId,
          error: toErrorMessage(error),
        });
      });
    }
    this.rpcClients.delete(conn);
    this.connectionStatuses.delete(conn);
  }

  private queueIcpInvalidation(
    companionId: string,
    reasonCode: IcpQueuedInvalidationReason,
  ): Promise<number> {
    if (!this.icpAutonomyBroker) return Promise.resolve(0);
    const previous = this.pendingIcpInvalidations.get(companionId);
    const attempt = (async (): Promise<number> => {
      if (previous) await previous.completion;
      const revoked = await this.icpAutonomyBroker!.invalidateForCompanion(companionId, reasonCode);
      return revoked.length;
    })();
    const pending: PendingIcpInvalidation = {
      reasonCode,
      completion: attempt.then(
        (revokedCount): IcpInvalidationAttemptOutcome => ({ ok: true, revokedCount }),
        (error: unknown): IcpInvalidationAttemptOutcome => ({ ok: false, error }),
      ),
    };
    this.pendingIcpInvalidations.set(companionId, pending);
    void pending.completion.then((outcome) => {
      if (outcome.ok && this.pendingIcpInvalidations.get(companionId) === pending) {
        this.pendingIcpInvalidations.delete(companionId);
      }
    });
    return attempt;
  }

  private async awaitIcpInvalidationBeforeReconnect(companionId: string): Promise<void> {
    let pending = this.pendingIcpInvalidations.get(companionId);
    while (pending) {
      const outcome = await pending.completion;
      const current = this.pendingIcpInvalidations.get(companionId);
      if (current !== pending) {
        pending = current;
        continue;
      }
      if (outcome.ok) {
        this.pendingIcpInvalidations.delete(companionId);
        return;
      }
      await this.queueIcpInvalidation(companionId, pending.reasonCode);
      pending = this.pendingIcpInvalidations.get(companionId);
    }
  }

  private handleMalformedFrame(
    conn: GatewayRpcConnection,
    frameKind: MalformedFrameKind,
    reason: string,
    preview?: string,
  ): void {
    if (!this.connectionStatuses.has(conn)) {
      return;
    }

    const startedAt = Date.now();
    const params: Record<string, unknown> = {
      frameKind,
      reason,
      ...(preview ? { preview } : {}),
    };
    void (async (): Promise<void> => {
      const auditId = await this.audit(INVALID_FRAME_AUDIT_METHOD, 'DENY', params);
      await this.auditComplete(auditId, startedAt, reason);
    })().catch((auditError: unknown) => {
      log.error('Malformed IPC frame audit persistence failed after disconnecting peer fail closed', {
        ...params,
        error: toErrorMessage(auditError),
      });
    });

    log.error('Malformed IPC frame received; disconnecting agent connection', params);
    this.connectionLifecycle.transitionConnectionState(conn, 'degraded', 'malformed_frame', reason);
    this.connectionLifecycle.transitionConnectionState(conn, 'offline', 'malformed_frame', reason);
    this.removeConnection(conn);
    if (!conn.destroyed) {
      conn.destroy();
    }
  }

  /** Local readiness of the same owner used by API requests, without sending RPC. */
  isApiReady(): boolean {
    try {
      if (this.multiCompanion.enabled) this.connectionRouter.resolveCompanionAgent('api');
      else this.connectionRouter.resolveReadyAgentConnection();
      return true;
    } catch {
      // Route resolution rejects absent, unready, stale, or unbound owners.
      return false;
    }
  }

  /**
   * Send an RPC request to the agent and await its response. This is the
   * gateway API-surface request path (api.chat.completion, api.health, …):
   * single-companion mode targets the first ready agent (unchanged); under
   * multi-companion it routes fail-closed to the companion that owns the
   * `api` channel surface.
   */
  async requestAgent<T = unknown>(
    method: string,
    params: unknown,
    timeoutMs = DEFAULT_AGENT_TIMEOUT_MS,
  ): Promise<T> {
    const client = this.multiCompanion.enabled
      ? this.connectionRouter.resolveCompanionAgent('api').client
      : this.connectionRouter.resolveReadyRpcClient();

    const result = await Promise.race([
      client.request(method, params),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Agent request timed out')), timeoutMs),
      ),
    ]);
    // d269: reverse-RPC results are reply egress — scan before returning to
    // any channel surface.
    return await this.inspectAgentReply(method, result) as T;
  }

  /** Route one exact authority read to the authenticated companion agent. */
  async requestCompanionAgent<T = unknown>(
    companionId: string,
    method: string,
    params: unknown,
    timeoutMs = DEFAULT_AGENT_TIMEOUT_MS,
  ): Promise<T> {
    const exactCompanionId = createCompanionId(
      companionId,
      'Explicit companion agent request companionId',
    );
    const client = this.multiCompanion.enabled
      ? this.connectionRouter.requireReadyCompanionRoute('api', exactCompanionId).client
      : this.connectionRouter.resolveReadyRpcClient();
    const result = await Promise.race([
      client.request(method, params),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Companion agent request timed out')), timeoutMs),
      ),
    ]);
    // d269: reverse-RPC results are reply egress — scan before returning to
    // any channel surface.
    return await this.inspectAgentReply(method, result) as T;
  }

  /** Persist and publish a content-free observation-delivery audit. */
  async recordSharedSatelliteObservationAudit(event: {
    satelliteId: string;
    companionId: string;
    scope: string;
    eventId: string;
    timestamp: number;
  }): Promise<void> {
    await this.audit('satellite.observation.delivered', 'ALLOW', event);
    await this.options.eventBus.emit('satellite.observation.delivered', event);
  }

  /**
   * Run an authenticated satellite HTTP turn through the same speech lease as
   * voice. This is the only multi-companion satellite chat model-call path.
   */
  async requestSharedSatelliteChatCompletion(input: {
    satellite: SatelliteRoutingMetadata & {
      sharedDevice: NonNullable<SatelliteRoutingMetadata['sharedDevice']>;
    };
    canonicalContactId: string;
    channelId: string;
    /** Exact gateway-authenticated target for an inbound human Hub-device turn. */
    explicitHumanInboundCompanionId?: CompanionId;
    params: ApiChatCompletionRpcParams;
    timeoutMs: number;
  }): Promise<ApiChatCompletionRpcResult> {
    const { satellite, params } = input;
    const policy = satellite.sharedDevice;
    const eligibility = await this.resolveSharedSatelliteEligibility({
      policy,
      canonicalContactId: input.canonicalContactId,
      channelId: input.channelId,
      ...(input.explicitHumanInboundCompanionId
        ? { explicitHumanInboundCompanionId: input.explicitHumanInboundCompanionId }
        : {}),
    });
    const excludedCompanionIds = new Set<CompanionId>();
    const conversationKey = JSON.stringify([
      input.canonicalContactId,
      satellite.sessionId,
    ]);
    const explicitAddressedCompanionId = input.explicitHumanInboundCompanionId
      ?? satellite.addressedCompanionId;

    for (;;) {
      const acquisition = this.sharedSatelliteResponseArbiter.acquire({
        satelliteId: satellite.satelliteId,
        conversationKey,
        policy,
        eligibility,
        ...(explicitAddressedCompanionId
          ? { explicitAddressedCompanionId }
          : {}),
        excludedCompanionIds,
      });
      if (!acquisition.acquired) {
        // A refused shared-satellite turn used to vanish (empty 200, no line
        // anywhere); the hub cannot tell that from a broken model. Name the
        // disposition (psfn-framework-rqm6t).
        await this.audit('satellite.response.refused', 'DENY', {
          channelId: input.channelId,
          satelliteId: input.satellite.satelliteId,
          reason: acquisition.reason,
          explicitAddressed: Boolean(explicitAddressedCompanionId),
        });
        return this.sharedSatelliteChatNoOp(input.channelId);
      }
      const { lease } = acquisition;
      try {
        const route = this.connectionRouter.requireReadyCompanionRoute(
          `satellite:${satellite.satelliteId}`,
          lease.companionId,
        );
        this.sharedSatelliteChatRequests.set(params.requestId, lease.companionId);
        const effectiveTimeoutMs = Math.min(
          input.timeoutMs,
          Math.max(1, lease.expiresAtMs - Date.now()),
        );
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error('Shared-satellite chat request timed out')),
            effectiveTimeoutMs,
          );
          timeoutHandle.unref();
        });
        let raced: unknown;
        try {
          raced = await Promise.race([
            route.client.request('api.chat.completion', params),
            timeout,
          ]);
        } finally {
          if (timeoutHandle) clearTimeout(timeoutHandle);
        }
        // d269: shared-satellite chat replies cross the same reverse-RPC seam;
        // scan before arbitration reads the content.
        const rawResult = await this.inspectAgentReply(
          'api.chat.completion',
          raced,
        ) as ApiChatCompletionRpcResult;
        const result: ApiChatCompletionRpcResult = rawResult.ok
          ? {
              ...rawResult,
              response: {
                ...rawResult.response,
                companionId: lease.companionId,
              },
            }
          : rawResult;
        if (!result.ok) {
          if (result.error.type === 'request_timeout') {
            this.sharedSatelliteResponseArbiter.timeout(
              lease.leaseId,
              'agent_request_timeout',
            );
            excludedCompanionIds.add(lease.companionId);
            continue;
          }
          this.sharedSatelliteResponseArbiter.complete(
            lease.leaseId,
            'release',
            `agent_error:${result.error.type}`,
          );
          return result;
        }
        if (result.response.content.trim()) {
          if (!this.sharedSatelliteResponseArbiter.complete(lease.leaseId, 'speech')) {
            await this.audit('satellite.response.refused', 'DENY', {
              channelId: input.channelId,
              satelliteId: input.satellite.satelliteId,
              reason: 'speech_lease_lost',
              explicitAddressed: Boolean(explicitAddressedCompanionId),
            });
            return this.sharedSatelliteChatNoOp(input.channelId);
          }
          return result;
        }
        if (result.response.noReply?.disposition !== 'intentional_no_reply') {
          this.sharedSatelliteResponseArbiter.complete(
            lease.leaseId,
            'release',
            'unmarked_empty_response',
          );
          return {
            ok: false,
            error: {
              status: 502,
              type: 'empty_response',
              message: 'Shared-satellite agent returned empty content without an intentional disposition',
            },
          };
        }
        this.sharedSatelliteResponseArbiter.complete(
          lease.leaseId,
          'decline',
          'structured_intentional_no_reply',
        );
        if (lease.priority === 'explicit_address' || lease.priority === 'active_conversation') {
          return result;
        }
        excludedCompanionIds.add(lease.companionId);
      } catch (error) {
        const timedOut = toErrorMessage(error).toLowerCase().includes('timed out');
        if (timedOut) {
          this.sharedSatelliteResponseArbiter.timeout(lease.leaseId, 'model_timeout');
          excludedCompanionIds.add(lease.companionId);
          continue;
        }
        this.sharedSatelliteResponseArbiter.complete(lease.leaseId, 'release', 'model_error');
        throw error;
      } finally {
        if (this.sharedSatelliteChatRequests.get(params.requestId) === lease.companionId) {
          this.sharedSatelliteChatRequests.delete(params.requestId);
        }
      }
    }
  }

  async cancelSharedSatelliteChatCompletion(
    requestId: string,
    params: unknown,
    timeoutMs = DEFAULT_AGENT_TIMEOUT_MS,
  ): Promise<unknown> {
    const companionId = this.sharedSatelliteChatRequests.get(requestId);
    if (!companionId) return { cancelled: false };
    return await this.requestCompanionAgent(
      companionId,
      'api.chat.cancel',
      params,
      timeoutMs,
    );
  }

  /**
   * Forward a gateway-process timing observation to the owning agent process,
   * where the canonical Garden tracker lives. Multi-companion routing requires
   * an explicit event companionId and never falls back to another agent.
   */
  async requestAgentTurnPerformance(
    event: TurnPerformanceEvent,
    timeoutMs = DEFAULT_AGENT_TIMEOUT_MS,
  ): Promise<void> {
    let client: JSONRPCServerAndClient;
    if (this.multiCompanion.enabled) {
      if (!event.companionId) {
        throw new Error('Multi-companion turn performance forwarding requires event.companionId');
      }
      const companionId = createCompanionId(event.companionId, 'Turn performance companionId');
      this.connectionLifecycle.refreshConnectionHealth();
      const conn = this.companionConnections.get(companionId);
      const status = conn ? this.connectionStatuses.get(conn) : undefined;
      if (!conn
        || !status
        || status.role !== 'agent'
        || status.state !== 'ready'
        || status.health !== 'healthy') {
        throw new Error(`No ready agent connection for turn performance companion "${companionId}"`);
      }
      const routedClient = this.rpcClients.get(conn);
      if (!routedClient) {
        throw new Error(`No RPC client for turn performance companion "${companionId}"`);
      }
      client = routedClient;
    } else {
      client = this.connectionRouter.resolveReadyRpcClient();
    }

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error('Turn performance forwarding timed out')),
        timeoutMs,
      );
      timeoutHandle.unref();
    });
    let result: unknown;
    try {
      result = await Promise.race([
        client.request('telemetry.turn.performance', { event }),
        timeout,
      ]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
    if (!isRecord(result)
      || result.accepted !== true
      || Object.keys(result).some(key => key !== 'accepted')) {
      throw new Error('Agent rejected turn performance telemetry');
    }
  }

  async requestAgentVoiceStream(
    message: SubstrateMessage,
    options: VoiceStreamRequestOptions & {
      channelAccountRoute?: ChannelPluginAccountRoute;
    } = {},
  ): Promise<VoiceHandleMessageResult> {
    const { channelAccountRoute, ...voiceOptions } = options;
    const sharedSatellite = this.multiCompanion.enabled
      && message.routing?.source === 'satellite'
      ? message.routing.satellite
      : undefined;
    if (channelAccountRoute && message.routing?.source === 'satellite') {
      this.companionViolations.alarmCompanionViolation(
        'invalid_satellite_route',
        `Channel plugin "${channelAccountRoute.pluginId}" cannot supply satellite routing metadata`,
        { channelType: message.channelType, pluginId: channelAccountRoute.pluginId },
      );
      throw new Error('Channel plugin account routes cannot select a satellite companion');
    }
    if (sharedSatellite?.sharedDevice) {
      return await this.requestSharedSatelliteVoiceStream(
        message,
        { ...sharedSatellite, sharedDevice: sharedSatellite.sharedDevice },
        voiceOptions,
      );
    }
    let client: JSONRPCServerAndClient;
    let conn: GatewayRpcConnection;
    let companionId = this.options.companionId;
    if (this.multiCompanion.enabled) {
      const satellite = message.routing?.satellite;
      const satelliteSource = message.routing?.source === 'satellite';
      let route: ReturnType<GatewayConnectionRouter['resolveCompanionAgent']>;
      if (satellite) {
        if (!satelliteSource) {
          this.companionViolations.alarmCompanionViolation(
            'invalid_satellite_route',
            'Inbound voice message carries satellite metadata without a satellite routing source',
            { channelType: message.channelType, channelId: message.channelId },
          );
          throw new Error('Satellite voice routing metadata requires routing.source="satellite"');
        }
        route = this.connectionRouter.resolveSatelliteCompanionAgent(satellite);
      } else {
        if (satelliteSource) {
          this.companionViolations.alarmCompanionViolation(
            'invalid_satellite_route',
            'Inbound satellite voice message is missing authenticated satellite routing metadata',
            { channelType: message.channelType, channelId: message.channelId },
          );
          throw new Error('Satellite voice routing requires authenticated satellite metadata');
        }
        const surface = resolveGatewaySurfaceForChannelType(message.channelType);
        if (!surface) {
          this.companionViolations.alarmCompanionViolation(
            'unrouted_channel',
            `Inbound message channelType "${message.channelType}" has no multi-companion routing surface`,
            { channelType: message.channelType, channelId: message.channelId },
          );
          throw new Error(
            `Multi-companion routing cannot map channelType "${message.channelType}" to a companion`,
          );
        }
        route = this.connectionRouter.resolveCompanionAgent(
          surface,
          channelAccountRoute
            ? { kind: 'plugin', ...channelAccountRoute }
            : undefined,
        );
      }
      client = route.client;
      conn = route.conn;
      companionId = route.companionId;
    } else {
      const route = this.connectionRouter.resolveReadyAgentConnection();
      client = route.client;
      conn = route.conn;
      companionId ??= this.connectionStatuses.get(conn)?.companionId;
    }
    if (!companionId) {
      throw new Error(
        'Gateway voice routing requires a lowercase RFC-4122 companion UUID binding',
      );
    }

    const screenedMessage = voiceOptions.screenMessageForCompanion
      ? await voiceOptions.screenMessageForCompanion(message, companionId)
      : message;
    const result = await requestAgentVoiceStream({
      client,
      message: screenedMessage,
      options: voiceOptions,
      wyomingShardRouting: this.wyomingShardRouting,
      companionId,
      nextRequestCounter: () => ++this.streamRequestCounter,
      // d269: main-reply canary scan at the reverse-RPC seam.
      inspectReply: (replyMethod, replyResult) => this.inspectAgentReply(replyMethod, replyResult),
    });
    const attachments = materializeGatewayAttachments(
      result.attachments,
      this.resolveConnectionWorkspacePath(conn),
    );
    return { ...result, ...(attachments ? { attachments } : {}) };
  }

  private async requestSharedSatelliteVoiceStream(
    message: SubstrateMessage,
    satellite: SatelliteRoutingMetadata & {
      sharedDevice: NonNullable<SatelliteRoutingMetadata['sharedDevice']>;
    },
    options: VoiceStreamRequestOptions,
  ): Promise<VoiceHandleMessageResult> {
    const policy = satellite.sharedDevice;
    const canonicalContactId = message.routing?.canonicalContactId?.trim();
    if (!canonicalContactId) {
      throw new Error('Shared-satellite response arbitration requires exact canonical partner identity');
    }
    const eligibility = await this.resolveSharedSatelliteEligibility({
      policy,
      canonicalContactId,
      channelId: message.channelId,
    });
    const excludedCompanionIds = new Set<CompanionId>();
    const addressedCompanionId = satellite.addressedCompanionId;
    const conversationKey = JSON.stringify([canonicalContactId, satellite.sessionId]);

    for (;;) {
      const acquisition = this.sharedSatelliteResponseArbiter.acquire({
        satelliteId: satellite.satelliteId,
        conversationKey,
        policy,
        eligibility,
        ...(addressedCompanionId ? { explicitAddressedCompanionId: addressedCompanionId } : {}),
        excludedCompanionIds,
      });
      if (!acquisition.acquired) {
        return this.sharedSatelliteNoOp(message.channelId);
      }
      const { lease } = acquisition;
      try {
        const route = this.connectionRouter.requireReadyCompanionRoute(
          `satellite:${satellite.satelliteId}`,
          lease.companionId,
        );
        const screenedMessage = options.screenMessageForCompanion
          ? await options.screenMessageForCompanion(message, lease.companionId)
          : message;
        const result = await requestAgentVoiceStream({
          client: route.client,
          message: screenedMessage,
          options: {
            ...options,
            timeoutMs: Math.min(
              options.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS,
              Math.max(1, lease.expiresAtMs - Date.now()),
            ),
          },
          wyomingShardRouting: this.wyomingShardRouting,
          companionId: lease.companionId,
          nextRequestCounter: () => ++this.streamRequestCounter,
          // d269: main-reply canary scan at the reverse-RPC seam.
          inspectReply: (replyMethod, replyResult) => this.inspectAgentReply(replyMethod, replyResult),
        });
        if (result.content.trim()) {
          if (!this.sharedSatelliteResponseArbiter.complete(lease.leaseId, 'speech')) {
            return this.sharedSatelliteNoOp(message.channelId);
          }
          const attachments = materializeGatewayAttachments(
            result.attachments,
            this.resolveConnectionWorkspacePath(route.conn),
          );
          return { ...result, ...(attachments ? { attachments } : {}) };
        }
        if (result.disposition !== 'decline' && result.disposition !== 'no_op') {
          this.sharedSatelliteResponseArbiter.complete(
            lease.leaseId,
            'release',
            'unmarked_empty_response',
          );
          throw new Error('Shared-satellite agent returned empty content without a structured disposition');
        }
        this.sharedSatelliteResponseArbiter.complete(
          lease.leaseId,
          result.disposition,
          result.disposition === 'decline'
            ? 'structured_intentional_no_reply'
            : 'structured_no_op',
        );
        if (lease.priority === 'explicit_address' || lease.priority === 'active_conversation') {
          return this.sharedSatelliteNoOp(message.channelId);
        }
        excludedCompanionIds.add(lease.companionId);
      } catch (error) {
        const timedOut = toErrorMessage(error).toLowerCase().includes('timed out');
        if (timedOut) {
          this.sharedSatelliteResponseArbiter.timeout(lease.leaseId, 'model_timeout');
        } else {
          this.sharedSatelliteResponseArbiter.complete(
            lease.leaseId,
            'release',
            'model_error',
          );
        }
        if (!timedOut) throw error;
        excludedCompanionIds.add(lease.companionId);
      }
    }
  }

  private sharedSatelliteNoOp(channelId: string): VoiceHandleMessageResult {
    return {
      content: '',
      channelId,
      model: 'shared-satellite-deterministic-no-op',
      durationMs: 0,
    };
  }

  private sharedSatelliteChatNoOp(channelId: string): ApiChatCompletionRpcResult {
    return {
      ok: true,
      response: {
        content: '',
        channelId,
        inputTokens: 0,
        outputTokens: 0,
        disposition: 'no_op',
      },
    };
  }

  private async resolveSharedSatelliteEligibility(
    input: {
      policy: NonNullable<SatelliteRoutingMetadata['sharedDevice']>;
      canonicalContactId: string;
      channelId: string;
      explicitHumanInboundCompanionId?: CompanionId;
    },
  ): Promise<SharedSatelliteEligibility[]> {
    this.connectionLifecycle.refreshConnectionHealth();
    return await Promise.all(input.policy.emanationMemberIds.map(async (
      companionId,
    ): Promise<SharedSatelliteEligibility> => {
      const availability = this.icpAutonomyBroker
        ? await this.icpAutonomyBroker.readOwnAvailability(companionId)
        : undefined;
      // A deployment with no ICP autonomy broker (every one-companion fleet)
      // has no availability fence to consult; it is not "unavailable"
      // (psfn-framework-5ybt1).
      const availabilityUnfenced = this.icpAutonomyBroker === null;
      const availabilityState = availability?.lease?.state;
      const connection = this.connectionRouter.resolveReadyCompanionConnection(companionId);
      const client = connection ? this.rpcClients.get(connection) : undefined;
      const nowMs = Date.now();
      const isExplicitHumanInbound = input.explicitHumanInboundCompanionId === companionId;
      const availabilityLeaseIsAbsent = availability?.control === 'missing'
        || availability?.control === 'expired';
      const explicitHumanAvailabilityAllows = isExplicitHumanInbound
        && availability !== undefined
        && (availabilityLeaseIsAbsent || availabilityState === 'resting');
      // A satellite turn that names its own in-world speaker carries no
      // canonical contact for the operator (satellite-registry resolves it to
      // ''); contact-level fatigue then has nothing to consult and the agent
      // decoder would reject the empty id. Speaker fatigue (machine
      // intelligence, strangers) is evaluated inside the turn pipeline instead.
      const contactFatigueApplies = input.canonicalContactId.length > 0;
      let fatigueAllows = !contactFatigueApplies;
      if (client && contactFatigueApplies) {
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        try {
          const timeout = new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(
              () => reject(new Error('Satellite response eligibility timed out')),
              input.policy.responseLease.durationMs,
            );
            timeoutHandle.unref();
          });
          const result = await Promise.race([
            client.request('satellite.response.eligibility', {
              canonicalContactId: input.canonicalContactId,
              channelId: input.channelId,
            }),
            timeout,
          ]);
          fatigueAllows = isRecord(result)
            && Object.keys(result).length === 1
            && result.fatigueAllows === true;
        } catch {
          fatigueAllows = false;
        } finally {
          if (timeoutHandle) clearTimeout(timeoutHandle);
        }
      }
      return {
        companionId,
        availabilityAllows: connection !== null
          && (availabilityUnfenced
            || availability?.eligible === true
            || explicitHumanAvailabilityAllows),
        fatigueAllows,
        quietHoursAllows: isExplicitHumanInbound
          || this.options.sharedSatelliteQuietHoursAllows?.(nowMs, companionId) === true,
        restAllows: availabilityLeaseIsAbsent
          || ((isExplicitHumanInbound || availabilityState !== 'resting')
            && availabilityState !== 'do_not_disturb'),
        // This is an explicit human-partner turn, not an autonomous Pack Task.
        taskAllows: true,
        deviceAllows: input.policy.emanationMemberIds.includes(companionId),
      };
    }));
  }

  private getRuntimeHealth(companionId?: string): RuntimeHealthResult {
    return {
      ...this.runtimeHealthTracker.getSnapshot(this.connectionLifecycle.getConnectionSummary(), companionId),
      operatorAlerting: this.operatorAlertDispatcher.configuration(),
    };
  }

  private async recordConnectionPosture(
    conn: GatewayRpcConnection,
    params: unknown,
  ): Promise<{ success: true }> {
    const status = this.connectionStatuses.get(conn);
    if (status?.role !== 'agent' || !status.companionId) {
      throw new Error('gateway.client.health requires an authenticated companion agent');
    }
    if (!isRecord(params)
      || !Object.hasOwn(params, 'posture')
      || Object.keys(params).length !== 1) {
      throw new Error('gateway.client.health accepts only the bounded posture envelope');
    }
    const posture = this.companionPostures.record(
      conn,
      status.companionId,
      params.posture,
    );
    if (posture.fatigue.state === 'exhausted'
      && !this.fatigueFencedCompanionIds.has(status.companionId)) {
      await this.queueIcpInvalidation(status.companionId, 'fatigue_exhausted');
      this.fatigueFencedCompanionIds.add(status.companionId);
    } else if (posture.fatigue.state !== 'exhausted') {
      this.fatigueFencedCompanionIds.delete(status.companionId);
    }
    return { success: true };
  }

  private markConnectionReady(
    conn: GatewayRpcConnection,
    params: unknown,
  ): { success: true } {
    if (!isRecord(params) || Object.keys(params).length !== 0) {
      throw new Error('gateway.client.ready accepts only an empty object');
    }
    const status = this.connectionStatuses.get(conn);
    if (status?.role !== 'agent') {
      throw new Error('gateway.client.ready requires an authenticated companion agent');
    }
    if (this.multiCompanion.enabled && !status.companionId) {
      throw new Error('gateway.client.ready requires an identified companion agent');
    }
    status.runtimeReadyDeclared = true;
    this.connectionLifecycle.transitionConnectionState(conn, 'ready', 'agent_runtime_ready');
    return { success: true };
  }

  private async identifyConnection(
    conn: GatewayRpcConnection,
    params: unknown,
  ): Promise<{ success: true; role: GatewayConnectionRole; companionId?: CompanionId }> {
    if (!isRecord(params) || !isIdentifiableGatewayConnectionRole(params.role)) {
      throw new Error('gateway.client.identify requires a valid role');
    }

    const status = this.connectionStatuses.get(conn);
    if (!status || status.state === 'offline') {
      throw new Error('Cannot identify an inactive gateway connection');
    }

    if (params.companionId !== undefined
      && (typeof params.companionId !== 'string' || !params.companionId.trim())) {
      throw new Error('gateway.client.identify companionId must be a non-empty string');
    }
    const companionId = typeof params.companionId === 'string'
      ? createCompanionId(params.companionId, 'gateway.client.identify companionId')
      : undefined;
    if (params.authToken !== undefined && typeof params.authToken !== 'string') {
      throw new Error('gateway.client.identify authToken must be a string when provided');
    }
    const authToken = typeof params.authToken === 'string' ? params.authToken : undefined;

    const maySelectSingleCompanionRole = !this.multiCompanion.enabled
      && status.role === 'agent'
      && status.stateReason === 'rpc_registered';
    if (status.role !== 'unidentified' && !maySelectSingleCompanionRole) {
      if (status.role !== params.role || status.companionId !== companionId) {
        throw new Error('Gateway connection is already identified and cannot change role or companion identity');
      }
      return {
        success: true,
        role: status.role,
        ...(status.companionId ? { companionId: status.companionId } : {}),
      };
    }

    const requiresRoleProof = this.multiCompanion.enabled
      || params.role === 'internal_session_integrity';
    if (requiresRoleProof) {
      if (!companionId) {
        const missingCompanionMessage = this.multiCompanion.enabled
          ? 'Multi-companion mode requires a companionId in gateway.client.identify'
          : 'The internal session-integrity role requires a companionId in gateway.client.identify';
        this.companionViolations.alarmCompanionViolation(
          'identify_missing_companion',
          'Authenticated gateway role identified without a companionId; rejecting',
          {},
        );
        throw new Error(missingCompanionMessage);
      }
      if (this.multiCompanion.enabled && !this.fleetCompanionIds.has(companionId)) {
        this.companionViolations.alarmCompanionViolation(
          'identify_unknown_companion',
          'Connection claimed a companionId absent from companions.json; rejecting',
          { claimedCompanionId: companionId },
        );
        throw new JSONRPCErrorException(
          `Companion ${JSON.stringify(companionId)} is not a member of the active fleet`,
          GatewayErrors.COMPANION_AUTH_FAILED,
        );
      }
      if (!verifyCompanionAuthToken(companionId, params.role, authToken, this.sessionHmacKeyring)) {
        this.companionViolations.alarmCompanionViolation(
          'identify_auth_failed',
          'Connection presented invalid companion authentication; rejecting',
          { claimedCompanionId: companionId },
        );
        throw new JSONRPCErrorException(
          'Companion authentication failed',
          GatewayErrors.COMPANION_AUTH_FAILED,
        );
      }
    }

    if (this.multiCompanion.enabled) {
      if (!companionId) {
        throw new Error('Multi-companion identification invariant violated: companionId is missing');
      }
      const authenticatedCompanionId = companionId;
      if (status.companionId && status.companionId !== companionId) {
        this.companionViolations.alarmCompanionViolation(
          'identify_rebind_rejected',
          'Connection attempted to re-identify as a different companion; rejecting',
          { boundCompanionId: status.companionId, claimedCompanionId: companionId },
        );
        throw new Error(
          `Connection is already identified as companion "${status.companionId}" and cannot rebind to "${companionId}"`,
        );
      }
      if (params.role === 'agent') {
        await this.awaitIcpInvalidationBeforeReconnect(authenticatedCompanionId);
        const existing = this.companionConnections.get(authenticatedCompanionId);
        if (existing && existing !== conn) {
          if (this.connections.has(existing)) {
            this.companionViolations.alarmCompanionViolation(
              'duplicate_identify',
              `Duplicate identify for companion "${companionId}"; keeping the existing connection and rejecting the new one`,
              { companionId },
            );
            throw new Error(
              `Companion "${companionId}" already has an active gateway connection; duplicate identify rejected`,
            );
          }
          this.companionConnections.delete(authenticatedCompanionId);
        }
        this.companionConnections.set(authenticatedCompanionId, conn);
        this.companionPostures.bind(conn, authenticatedCompanionId);
      }
      status.companionId = authenticatedCompanionId;
      this.companionLastSeen.set(authenticatedCompanionId, Date.now());
      log.info(`${this.companionDisplayLabel(authenticatedCompanionId)} connection authenticated`, {
        companionId: authenticatedCompanionId,
        role: params.role,
      });
    } else if (companionId) {
      // Flag off (or non-agent role): record for observability only — routing
      // semantics stay byte-identical to single-companion behavior.
      status.companionId = companionId;
      this.companionLastSeen.set(companionId, Date.now());
      if (params.role === 'agent') {
        this.companionPostures.bind(conn, companionId);
      }
    }

    status.role = params.role;
    if (params.role === 'agent' && this.multiCompanion.enabled) {
      this.connectionLifecycle.transitionConnectionState(conn, 'registering', 'client_identified:agent');
    } else {
      this.connectionLifecycle.transitionConnectionState(conn, 'ready', `client_identified:${params.role}`);
    }
    return {
      success: true,
      role: params.role,
      ...(companionId ? { companionId } : {}),
    };
  }

  /** Stale-healthcheck sweep; delegates to the connection lifecycle owner. */
  private refreshConnectionHealth(now = Date.now()): void {
    this.connectionLifecycle.refreshConnectionHealth(now);
  }

  async stop(): Promise<void> {
    for (const retention of this.inlineImageRetentionByConnection.values()) {
      retention.clear();
    }
    this.inlineImageRetentionByConnection.clear();
    for (const cancellation of this.llmRequestCancellationByConnection.values()) {
      cancellation.abortAll();
    }
    this.llmRequestCancellationByConnection.clear();
    for (const cancellation of this.mcpRequestCancellationByConnection.values()) {
      cancellation.abortAll();
    }
    this.mcpRequestCancellationByConnection.clear();
    for (const authority of this.mcpInvocationAuthorityByConnection.values()) {
      authority.clear();
    }
    this.mcpInvocationAuthorityByConnection.clear();
    if (this.icpAutonomyBroker) {
      const companionIds = new Set([
        ...this.companionConnections.keys(),
        ...this.pendingIcpInvalidations.keys(),
      ]);
      await Promise.all([...companionIds].map(async companionId => {
        await this.queueIcpInvalidation(companionId, 'peer_offline');
      }));
    }
    for (const unsubscribe of this.gardenQueueChangeUnsubscribers.splice(0)) {
      unsubscribe();
    }
    for (const conn of this.connections) {
      this.shardWorkloadRegistrar?.releaseConnection(conn);
      conn.destroy();
    }
    this.connections.clear();
    this.rpcClients.clear();
    this.connectionStatuses.clear();
    this.companionConnections.clear();
    this.companionMessageLane.clearDeliveryFailureReceipts();

    if (this.rpcServer) {
      await new Promise<void>((resolve) => {
        this.rpcServer!.close(() => resolve());
      });
    }

    await this.options.mcpBroker?.close();

    log.info('Stopped');
  }

  private async audit(method: string, decision: GatewayPolicyDecision, params?: Record<string, unknown>): Promise<number> {
    const correlation = extractGatewayCorrelation(params);
    if (decision !== 'ALLOW') {
      log.info(`${method} → ${decision}`, {
        ...(Object.keys(correlation).length > 0 ? correlation : {}),
      });
    }
    if (this.options.auditStore) {
      return await this.options.auditStore.append({ method, decision, params });
    }
    return 0;
  }

  private async recordSharedSatelliteLeaseAudit(
    event: SharedSatelliteLeaseAuditEvent,
  ): Promise<void> {
    await this.audit('satellite.response.lease', 'ALLOW', { ...event });
    await this.options.eventBus.emit('satellite.response.lease', event);
  }

  private async auditComplete(id: number, startTime: number, error?: string): Promise<void> {
    if (this.options.auditStore && id > 0) {
      await this.options.auditStore.complete(id, Date.now() - startTime, error);
    }
  }
}

function extractGatewayCorrelation(
  params: Record<string, unknown> | undefined,
): Record<string, string> {
  if (!params) return {};
  const correlation: Record<string, string> = {};
  for (const key of [
    'companionId',
    'turnId',
    'requestId',
    'channelId',
    'callType',
    'originType',
    'originStage',
    'toolName',
    'toolCallId',
    'purpose',
  ]) {
    const value = params[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    correlation[key] = trimmed;
  }
  return correlation;
}
