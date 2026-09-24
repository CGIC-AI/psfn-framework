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
import type { CapabilityTier, WyomingShardRoutingConfig } from '../../system/config/runtime-config-contracts.js';
import type { SubstrateMessage } from '../../shared/contracts/runtime.js';
import type { GatewayRpcConnection } from './transport.js';
import { GatewayInlineImageRetention } from './inline-image-retention.js';
import { createSocketServer, createWebSocketRpcServer } from './transport.js';
import {
  GatewayErrors,
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
import { createComponentLogger } from '../../shared/logger.js';
import { createCompanionDisplayIdentityResolver } from '../../shared/companion-display-identity.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
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
import type { ApiChatCompletionRpcResult } from '../../channels/api/types.js';
import { verifyCompanionAuthToken } from './companion-auth.js';
import { createCanaryEgressGuard, type CanaryEgressGuard } from './canary-egress-guard.js';
import type { GardenQueueName } from '../../shared/event-bus.js';
import type {
  ConfirmationQueueEntry,
  ConfirmationQueueHistoryEntry,
  ConfirmationApprovalOwner,
  ConfirmationResolveResult,
} from '../../system/capabilities/confirmation-queue.js';
import type { AuditSummaryEntry } from './audit-port.js';
import type { GatewayIcpAutonomyBroker } from './icp-autonomy-broker.js';
import { createGatewayIcpAutonomyBroker } from './icp-autonomy-rpc.js';
import {
  createCompanionId,
  type CompanionId,
} from '../../shared/routing/companion-id.js';
import { SharedCompanionWorkspaceReader } from '../../persistence/workspaces/shared-workspace-reader.js';
import { materializeGatewayAttachments } from './attachment-materialization.js';
import type { TurnPerformanceEvent } from '../../shared/telemetry/turn-performance.js';
import { resolveTierCapabilityTokens } from '../../system/capabilities/tiers.js';
import { ShardApprovalGrantAuthority } from '../../system/capabilities/shard-approval-grants.js';
import { GatewayShardWorkloadRegistrar } from './shard-workload-registrar.js';
import { GatewayFleetPostureCache } from './fleet-posture-cache.js';
import type { GatewayServerOptions } from './server/options.js';
import type { GatewayServerPorts } from './server/ports.js';
import { GatewayConnectionRouter } from './server/connection-routing.js';
import { GatewayInboundChannelDelivery } from './server/inbound-channel-delivery.js';
import { GatewayCompanionMessageLane } from './server/companion-message-lane.js';
import { GatewaySharedSatelliteOrchestrator } from './server/shared-satellite-orchestration.js';
import { GatewayConnectionScope } from './server/connection-scope.js';
import { GatewayAuditTrail } from './server/audit-trail.js';
import { GatewayConnectionRpcMethods } from './server/rpc-method-registration.js';
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
  private readonly connectionLifecycle: GatewayConnectionLifecycle;
  private readonly companionViolations: GatewayCompanionViolations;
  private readonly connectionRouter: GatewayConnectionRouter;
  private readonly inboundChannelDelivery: GatewayInboundChannelDelivery;
  private readonly companionMessageLane: GatewayCompanionMessageLane;
  private readonly sharedSatellite: GatewaySharedSatelliteOrchestrator;
  private readonly connectionScope: GatewayConnectionScope;
  private readonly auditTrail: GatewayAuditTrail;
  private readonly rpcMethods: GatewayConnectionRpcMethods;

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
      canaryEgressGuard: this.canaryEgressGuard,
      inlineImageRetentionByConnection: this.inlineImageRetentionByConnection,
      llmRequestCancellationByConnection: this.llmRequestCancellationByConnection,
      mcpRequestCancellationByConnection: this.mcpRequestCancellationByConnection,
      mcpInvocationAuthorityByConnection: this.mcpInvocationAuthorityByConnection,
      sessionHmacKeyring: this.sessionHmacKeyring,
      capabilityTierProvider: this.capabilityTierProvider,
      approvalBoundary: this.approvalBoundary,
      shardApprovalGrants: this.shardApprovalGrants,
      shardWorkloadRegistrar: this.shardWorkloadRegistrar,
      getRuntimeHealth: companionId => this.getRuntimeHealth(companionId),
      identifyConnection: (conn, params) => this.identifyConnection(conn, params),
      markConnectionReady: (conn, params) => this.markConnectionReady(conn, params),
      recordConnectionPosture: (conn, params) => this.recordConnectionPosture(conn, params),
      runtimeHealthTracker: this.runtimeHealthTracker,
      icpAutonomyBroker: this.icpAutonomyBroker,
      wyomingShardRouting: this.wyomingShardRouting,
      nextStreamRequestCounter: () => ++this.streamRequestCounter,
      inspectAgentReply: (method, result) => this.auditTrail.inspectAgentReply(method, result),
      requestCompanionAgent: (companionId, method, params, timeoutMs) => (
        this.requestCompanionAgent(companionId, method, params, timeoutMs)
      ),
      requireReadyCompanionRoute: (surface, companionId) => (
        this.connectionRouter.requireReadyCompanionRoute(surface, companionId)
      ),
      resolveConnectionWorkspacePath: conn => this.connectionScope.resolveConnectionWorkspacePath(conn),
      sharedWorkspaceReader: this.sharedWorkspaceReader,
      discordAccountRoutingActive: () => this.discordAccountRoutingActive(),
      audit: (method, decision, params) => this.auditTrail.audit(method, decision, params),
      auditComplete: (id, startTime, error) => this.auditTrail.auditComplete(id, startTime, error),
    };
  }

  constructor(options: GatewayServerOptions) {
    this.options = options;
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
      audit: (method, decision, params) => this.auditTrail.audit(method, decision, params),
      auditComplete: (id, startTime, error) => this.auditTrail.auditComplete(id, startTime, error),
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
    this.auditTrail = new GatewayAuditTrail(ports);
    this.connectionLifecycle = new GatewayConnectionLifecycle(ports);
    this.companionViolations = new GatewayCompanionViolations(ports);
    this.connectionRouter = new GatewayConnectionRouter(ports);
    this.inboundChannelDelivery = new GatewayInboundChannelDelivery(ports);
    this.companionMessageLane = new GatewayCompanionMessageLane(ports);
    this.sharedSatellite = new GatewaySharedSatelliteOrchestrator(ports);
    this.connectionScope = new GatewayConnectionScope(ports);
    this.rpcMethods = new GatewayConnectionRpcMethods({
      ...ports,
      auditTrail: this.auditTrail,
      companionMessageLane: this.companionMessageLane,
      connectionRouter: this.connectionRouter,
      connectionScope: this.connectionScope,
      sharedSatellite: this.sharedSatellite,
    });
  }

  async notifyOperator(params: NotifyNtfyParams): Promise<OperatorAlertResult> {
    return await this.operatorAlertDispatcher.dispatch(params);
  }

  subscribeApiStream(
    requestId: string,
    listener: (text: string, companionId?: string) => void,
    companionId?: string,
  ): () => void {
    return this.rpcMethods.subscribeApiStream(requestId, listener, companionId);
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
    this.rpcMethods.registerMethods(serverAndClient, conn);
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
      const auditId = await this.auditTrail.audit(INVALID_FRAME_AUDIT_METHOD, 'DENY', params);
      await this.auditTrail.auditComplete(auditId, startedAt, reason);
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
    return await this.auditTrail.inspectAgentReply(method, result) as T;
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
    return await this.auditTrail.inspectAgentReply(method, result) as T;
  }
  /** Persist and publish a content-free observation-delivery audit. */
  recordSharedSatelliteObservationAudit(
    event: Parameters<GatewaySharedSatelliteOrchestrator['recordSharedSatelliteObservationAudit']>[0],
  ): Promise<void> {
    return this.sharedSatellite.recordSharedSatelliteObservationAudit(event);
  }

  /**
   * Run an authenticated satellite HTTP turn through the same speech lease as
   * voice. This is the only multi-companion satellite chat model-call path.
   */
  requestSharedSatelliteChatCompletion(
    input: Parameters<GatewaySharedSatelliteOrchestrator['requestSharedSatelliteChatCompletion']>[0],
  ): Promise<ApiChatCompletionRpcResult> {
    return this.sharedSatellite.requestSharedSatelliteChatCompletion(input);
  }

  cancelSharedSatelliteChatCompletion(
    requestId: string,
    params: unknown,
    timeoutMs = DEFAULT_AGENT_TIMEOUT_MS,
  ): Promise<unknown> {
    return this.sharedSatellite.cancelSharedSatelliteChatCompletion(requestId, params, timeoutMs);
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
      return await this.sharedSatellite.requestSharedSatelliteVoiceStream(
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
      inspectReply: (replyMethod, replyResult) => this.auditTrail.inspectAgentReply(replyMethod, replyResult),
    });
    const attachments = materializeGatewayAttachments(
      result.attachments,
      this.connectionScope.resolveConnectionWorkspacePath(conn),
    );
    return { ...result, ...(attachments ? { attachments } : {}) };
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
}
