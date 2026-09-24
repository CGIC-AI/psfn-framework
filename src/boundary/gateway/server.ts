// ── Gateway Server ──
// Host-side process that holds secrets and proxies all external interactions.

import * as net from 'node:net';
import type * as https from 'node:https';
import {
  JSONRPCServer,
  JSONRPCClient,
  JSONRPCServerAndClient,
} from 'json-rpc-2.0';
import { DEFAULT_COMPANION_ID } from '../../core/identity/companion-naming.js';
import type { CapabilityTier, WyomingShardRoutingConfig } from '../../system/config/runtime-config-contracts.js';
import type { SubstrateMessage } from '../../shared/contracts/runtime.js';
import type { GatewayRpcConnection } from './transport.js';
import { GatewayInlineImageRetention } from './inline-image-retention.js';
import { createSocketServer, createWebSocketRpcServer } from './transport.js';
import {
  type RuntimeHealthResult,
  type OperatorAlertResult,
  type NotifyNtfyParams,
  type VoiceHandleMessageResult,
} from './protocol.js';
import {
  disabledGatewayMultiCompanionConfig,
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
import { GatewayAgentRequests } from './server/agent-request-routing.js';
import { GatewayIcpInvalidationQueue } from './server/icp-invalidation-queue.js';
import { GatewayConnectionAdmission } from './server/connection-admission.js';
import {
  assertGatewayFleetScreeningAndDocks,
  assertGatewayTopologyOptions,
} from './server/topology-validation.js';
import {
  GatewayCompanionViolations,
  type GatewayFleetConnectionSnapshot,
} from './server/companion-violations.js';
import {
  DEFAULT_CONNECTION_HEALTHCHECK_STALE_AFTER_MS,
  GatewayConnectionLifecycle,
} from './server/connection-lifecycle.js';
import type { GatewayConnectionStatus } from './server/connection-status.js';
import {
  normalizeNdjsonFrameError,
  summarizeFramePreview,
  validateJsonRpcFrame,
} from './server/rpc-frame-validation.js';

const log = createComponentLogger('Gateway');
const unknownCompanionDisplayIdentity = createCompanionDisplayIdentityResolver([]);
export { evaluatePolicy };
export type { GatewayNtfyConfig, PolicyConfig, VoiceStreamRequestOptions };

export { requireGatewaySessionHmacKeyring, resolveGatewaySessionHmacKeyring } from './session-hmac-env.js';
export type { GatewayServerOptions } from './server/options.js';
export type {
  GatewayFleetCompanionConnection,
  GatewayFleetConnectionSnapshot,
} from './server/companion-violations.js';

// ── Gateway Server Class ──

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
  private readonly agentRequests: GatewayAgentRequests;
  private readonly icpInvalidations: GatewayIcpInvalidationQueue;
  private readonly connectionAdmission: GatewayConnectionAdmission;

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
      fatigueFencedCompanionIds: this.fatigueFencedCompanionIds,
      removeConnection: conn => this.removeConnection(conn),
      companionDisplayLabel: companionId => this.companionDisplayLabel(companionId),
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
      identifyConnection: (conn, params) => this.connectionAdmission.identifyConnection(conn, params),
      markConnectionReady: (conn, params) => this.connectionAdmission.markConnectionReady(conn, params),
      recordConnectionPosture: (conn, params) => this.connectionAdmission.recordConnectionPosture(conn, params),
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
    assertGatewayTopologyOptions(options, this.multiCompanion, this.sharedWorkspaceReader);
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
    assertGatewayFleetScreeningAndDocks(
      options,
      this.multiCompanion,
      () => this.discordAccountRoutingActive(),
    );
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
    this.icpInvalidations = new GatewayIcpInvalidationQueue(ports);
    this.connectionLifecycle = new GatewayConnectionLifecycle(ports);
    this.companionViolations = new GatewayCompanionViolations(ports);
    this.connectionRouter = new GatewayConnectionRouter(ports);
    this.inboundChannelDelivery = new GatewayInboundChannelDelivery(ports);
    this.companionMessageLane = new GatewayCompanionMessageLane(ports);
    this.sharedSatellite = new GatewaySharedSatelliteOrchestrator(ports);
    this.connectionScope = new GatewayConnectionScope(ports);
    this.agentRequests = new GatewayAgentRequests({
      ...ports,
      auditTrail: this.auditTrail,
      connectionRouter: this.connectionRouter,
      connectionScope: this.connectionScope,
      sharedSatellite: this.sharedSatellite,
    });
    this.connectionAdmission = new GatewayConnectionAdmission({
      ...ports,
      auditTrail: this.auditTrail,
      connectionLifecycle: this.connectionLifecycle,
      icpInvalidations: this.icpInvalidations,
    });
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
    return await this.icpInvalidations.queueIcpInvalidation(companionId, reasonCode);
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
      this.connectionAdmission.handleMalformedFrame(conn, 'ndjson', frameError.reason, frameError.preview);
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
          this.connectionAdmission.handleMalformedFrame(
            conn,
            'jsonrpc',
            validationError,
            summarizeFramePreview(message),
          );
          return;
        }
        const verdict = this.connectionAdmission.enforceCompanionFrameIdentity(conn, message as Record<string, unknown>);
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
          this.connectionAdmission.handleMalformedFrame(
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
      void this.icpInvalidations.queueIcpInvalidation(status.companionId, 'peer_offline')
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
  /** Local readiness of the same owner used by API requests, without sending RPC. */
  isApiReady(): boolean {
    return this.agentRequests.isApiReady();
  }

  /**
   * Send an RPC request to the agent and await its response. This is the
   * gateway API-surface request path (api.chat.completion, api.health, …):
   * single-companion mode targets the first ready agent (unchanged); under
   * multi-companion it routes fail-closed to the companion that owns the
   * `api` channel surface.
   */
  requestAgent<T = unknown>(
    method: string,
    params: unknown,
    timeoutMs = DEFAULT_AGENT_TIMEOUT_MS,
  ): Promise<T> {
    return this.agentRequests.requestAgent<T>(method, params, timeoutMs);
  }

  /** Route one exact authority read to the authenticated companion agent. */
  requestCompanionAgent<T = unknown>(
    companionId: string,
    method: string,
    params: unknown,
    timeoutMs = DEFAULT_AGENT_TIMEOUT_MS,
  ): Promise<T> {
    return this.agentRequests.requestCompanionAgent<T>(companionId, method, params, timeoutMs);
  }

  /**
   * Forward a gateway-process timing observation to the owning agent process,
   * where the canonical Garden tracker lives. Multi-companion routing requires
   * an explicit event companionId and never falls back to another agent.
   */
  requestAgentTurnPerformance(
    event: TurnPerformanceEvent,
    timeoutMs = DEFAULT_AGENT_TIMEOUT_MS,
  ): Promise<void> {
    return this.agentRequests.requestAgentTurnPerformance(event, timeoutMs);
  }

  requestAgentVoiceStream(
    message: SubstrateMessage,
    options: VoiceStreamRequestOptions & {
      channelAccountRoute?: ChannelPluginAccountRoute;
    } = {},
  ): Promise<VoiceHandleMessageResult> {
    return this.agentRequests.requestAgentVoiceStream(message, options);
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


  private getRuntimeHealth(companionId?: string): RuntimeHealthResult {
    return {
      ...this.runtimeHealthTracker.getSnapshot(this.connectionLifecycle.getConnectionSummary(), companionId),
      operatorAlerting: this.operatorAlertDispatcher.configuration(),
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
        ...this.icpInvalidations.pendingIcpInvalidations.keys(),
      ]);
      await Promise.all([...companionIds].map(async companionId => {
        await this.icpInvalidations.queueIcpInvalidation(companionId, 'peer_offline');
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
