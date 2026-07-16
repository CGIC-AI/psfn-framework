import { assertNoUnknownKeys, isRecord } from '../../shared/utils/types.js';
// ── Gateway Server ──
// Host-side process that holds secrets and proxies all external interactions.

import * as net from 'node:net';
import type * as https from 'node:https';
import { randomUUID } from 'node:crypto';
import {
  JSONRPCServer,
  JSONRPCClient,
  JSONRPCServerAndClient,
  JSONRPCErrorException,
} from 'json-rpc-2.0';
import type { LLMProviderPort } from '../../core/agent/contracts.js';
import type { EmbeddingProviderPort } from '../../shared/contracts/embedding-provider.js';
import { DEFAULT_COMPANION_ID } from '../../core/identity/companion-naming.js';
import type { ChannelOutboundDock } from '../../channels/backplane/types.js';
import type { CapabilityTier, WyomingShardRoutingConfig } from '../../system/config/runtime-config-contracts.js';
import type { SubstrateMessage } from '../../shared/contracts/runtime.js';
import type { SatelliteRoutingMetadata } from '../../shared/contracts/satellite-registry.js';
import type { GatewayRpcConnection, GatewayRpcEndpoint } from './transport.js';
import { GatewayInlineImageRetention } from './inline-image-retention.js';
import { createSocketServer, createWebSocketRpcServer } from './transport.js';
import {
  GatewayErrors,
  type CompanionMessageDeliveryFailureNotification,
  type CompanionMessageFailureReportResult,
  type CompanionMessageSendResult,
  type GatewayCredentialPresenceResult,
  type PolicyDecision,
  type RuntimeHealthResult,
  type VoiceHandleMessageResult,
} from './protocol.js';
import {
  disabledGatewayMultiCompanionConfig,
  resolveGatewaySurfaceForChannelType,
  type GatewayChannelSurface,
  type GatewayMultiCompanionConfig,
} from './multi-companion.js';
import type { GatewayCompanionChannelLane } from './companion-channels.js';
import { COMPANION_CHANNEL_TYPE } from '../../shared/contracts/companion-channels.js';
import type { GitOperations } from '../integrations/git/ops.js';
import type { ImageRuntimeConfig } from '../../primitives/images/types.js';
import type { ModelDiscoveryBackend } from '../../primitives/llm/discovery.js';
import type { GatewayAuditStorePort } from './audit-port.js';
import type { SessionHmacKeyring } from '../../persistence/journals/journal-utils.js';
import { createComponentLogger } from '../../shared/logger.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import { registerGatewayMethods } from './methods/index.js';
import type { GatewayMethodRuntime } from './methods/types.js';
import type { PolicyConfig } from './policy.js';
import {
  DEFAULT_AGENT_TIMEOUT_MS,
  requestAgentVoiceStream,
  type VoiceStreamRequestOptions,
} from './voice-stream-request.js';
import { GatewayNtfyNotifier, type GatewayNtfyConfig } from './ntfy-notifier.js';
import {
  createGatewayApprovalBoundaryService,
  type ApprovalBoundaryService,
  type GatewayConfirmationConfig,
} from './approval-boundary.js';
import { GatewayRuntimeHealthTracker } from './runtime-health.js';
import { evaluatePolicy } from './policy.js';
import type { ApiStreamDeltaNotification } from '../../channels/api/types.js';
import type { ModelUsageRecorder } from '../../shared/telemetry/model-usage.js';
import type { CredentialVaultPort } from '../custody/credential-vault.js';
import { verifyCompanionAuthToken } from './companion-auth.js';
import {
  CompanionDeliveryFailureReceipts,
  parseCompanionMessageFailureReport,
} from './companion-delivery-failures.js';
import type { IntakeScreeningService } from '../../core/cogsec/intake/screening.js';
import type { CogSecEventStore } from '../../core/cogsec/events.js';
import { createCanaryEgressGuard, type CanaryEgressGuard } from './canary-egress-guard.js';
import type { GatewayVisionIntakeScreener } from './intake/compose-screening.js';
import type { EventBus, GardenQueueName } from '../../shared/event-bus.js';
import type {
  ConfirmationQueueHistoryEntry,
  ConfirmationResolveResult,
} from '../../system/capabilities/confirmation-queue.js';
import type { AuditSummaryEntry } from './audit-port.js';
import { parseCompanionRelayPublishParams } from '../../channels/backplane/companion-relay/relay.js';
import type { IcpSharedAutonomyStorePort } from '../../core/icp/autonomy-store-ports.js';
import type { GatewayIcpInitiationPolicyAuthority } from './icp-initiation-policy-authority.js';
import type { GatewayIcpAutonomyBroker } from './icp-autonomy-broker.js';
import {
  createGatewayIcpAutonomyBroker,
  registerGatewayIcpAutonomyRpc,
} from './icp-autonomy-rpc.js';
import {
  deriveIcpTransportMessageId,
  parseIcpConversationCorrelation,
  type IcpConversationCorrelation,
} from '../../shared/contracts/icp-autonomy.js';
import {
  createCompanionId,
  type CompanionId,
  type OptionalCompanionRoutingBinding,
} from '../../shared/routing/companion-id.js';
import { SharedCompanionWorkspaceReader } from '../../persistence/workspaces/shared-workspace-reader.js';
import { materializeGatewayAttachments } from './attachment-materialization.js';
import type { TurnPerformanceEvent } from '../../shared/telemetry/turn-performance.js';
import type { KubeSelfManagementController } from '../../system/lifecycle/kube-self-management.js';

const log = createComponentLogger('Gateway');
const DEFAULT_CONNECTION_HEALTHCHECK_STALE_AFTER_MS = 90_000;
const CONNECTION_IN_FLIGHT_HEALTH_TOUCH_INTERVAL_MS = Math.min(
  30_000,
  Math.max(1_000, Math.floor(DEFAULT_CONNECTION_HEALTHCHECK_STALE_AFTER_MS / 3)),
);
const INVALID_FRAME_AUDIT_METHOD = 'gateway.ipc.frame.invalid';
const FRAME_PREVIEW_LIMIT = 200;
const ICP_DELIVERY_REPLAY_CACHE_TTL_MS = 15 * 60_000;
export { evaluatePolicy };
export type { GatewayNtfyConfig, PolicyConfig, VoiceStreamRequestOptions };

type GatewayConnectionState = 'registering' | 'ready' | 'degraded' | 'offline';
type GatewayConnectionHealth = 'healthy' | 'stale' | 'failed';
type GatewayConnectionRole = 'unidentified' | 'agent' | 'internal_session_integrity';
type MalformedFrameKind = 'ndjson' | 'jsonrpc';

interface GatewayConnectionStatus {
  role: GatewayConnectionRole;
  state: GatewayConnectionState;
  stateReason: string;
  health: GatewayConnectionHealth;
  connectedAt: number;
  lastHealthcheckAt: number;
  lastTransitionAt: number;
  healthcheckStaleAfterMs: number;
  failureReason?: string;
  /** Multi-companion (W1): companionId this connection identified as. */
  companionId?: CompanionId;
}

const GATEWAY_CONNECTION_STATE_TRANSITIONS:
Readonly<Record<GatewayConnectionState, readonly GatewayConnectionState[]>> = {
  registering: ['ready', 'degraded', 'offline'],
  ready: ['degraded', 'offline'],
  degraded: ['ready', 'offline'],
  offline: [],
};

// ── Fleet health snapshot (sprint-10 W4 fleet view) ──
// Cheap, read-only view over state the gateway already tracks: the companion
// connection registry plus an in-memory ring of multi-companion violation
// alarms. No new telemetry pipes; fatigue/charge posture is intentionally not
// here (documented follow-up — the gateway has no cheap authority for it).

const COMPANION_VIOLATION_LOG_LIMIT = 1_000;
export const FLEET_RECENT_VIOLATION_WINDOW_MS = 60 * 60 * 1_000;
const INTERNAL_SESSION_INTEGRITY_METHODS = new Set([
  'session.hmac.sign',
  'session.hmac.verify',
]);
const EMPTY_CREDENTIAL_PRESENCE: GatewayCredentialPresenceResult = {
  discordToken: false,
  apiKey: false,
  adminToken: false,
  openrouterApiKey: false,
  litellmBaseUrl: false,
  litellmApiKey: false,
  importProcessingLocalApiKey: false,
  falApiKey: false,
  telegramBotToken: false,
};

interface CompanionViolationEvent {
  event: string;
  companionId?: string;
  /** Value-free provider/channel credential inventory for the Garden status UI. */
  credentialPresence?: GatewayCredentialPresenceResult;
  at: number;
}

export interface GatewayFleetCompanionConnection {
  companionId: CompanionId;
  /** Live connection state; offline connections are removed, never reported. */
  state: Exclude<GatewayConnectionState, 'offline'>;
  health: GatewayConnectionHealth;
  stateReason: string;
  connectedAt: number;
  lastSeenAt: number;
}

export interface GatewayFleetConnectionSnapshot {
  generatedAt: number;
  /** Currently-identified companion connections (one per bound companionId). */
  connections: GatewayFleetCompanionConnection[];
  /** Last activity per companionId, retained across disconnects. */
  lastSeenByCompanionId: Record<string, number>;
  /** Violation alarms in the recent window, keyed by attributed companionId. */
  recentViolationsByCompanionId: Record<string, number>;
  /** Recent violation alarms with no companion attribution. */
  unattributedRecentViolationCount: number;
  recentViolationWindowMs: number;
}

export { requireGatewaySessionHmacKeyring, resolveGatewaySessionHmacKeyring } from './session-hmac-env.js';

// ── Gateway Server Class ──

export interface GatewayServerOptions extends OptionalCompanionRoutingBinding {
  socketPath: string;
  gatewayRpcEndpoint?: GatewayRpcEndpoint;
  llmProvider: LLMProviderPort;
  embeddingService: EmbeddingProviderPort;
  modelDiscovery?: ModelDiscoveryBackend;
  discordAdapter: ChannelOutboundDock;
  /**
   * Multi-account discord (sprint-10 W1-P2): outbound dock per companionId.
   * Required to cover every companion routed via multiCompanion.discordAccounts;
   * outbound sends from a companion connection resolve through its own dock
   * only, so one companion can never egress through another companion's bot.
   */
  discordAccountDocks?: ReadonlyMap<CompanionId, ChannelOutboundDock>;
  gitOps?: GitOperations;
  imageConfig?: ImageRuntimeConfig;
  modelUsageRecorder?: ModelUsageRecorder;
  credentialVault?: CredentialVaultPort;
  /** Cognition intake firewall screening (htm9.2); absent when mode is 'off'. */
  intakeScreening?: IntakeScreeningService;
  /**
   * CogSec event store (htm9.18). When present, a canary token leaking into an
   * outbound method is recorded as a durable CogSecEvent (token sha256 only)
   * before the action is held. Absent ⇒ the tripwire still holds the action,
   * but writes no durable event.
   */
  cogSecEvents?: Pick<CogSecEventStore, 'createEvent'>;
  /** Vision intake screener (htm9.8); absent when off/disabled/backend-less. */
  visionIntake?: GatewayVisionIntakeScreener;
  policyConfig: PolicyConfig;
  ntfy?: GatewayNtfyConfig;
  auditStore?: GatewayAuditStorePort;
  kubeSelfManagement?: KubeSelfManagementController;
  sessionHmacKeyring: SessionHmacKeyring;
  confirmation?: Partial<GatewayConfirmationConfig>;
  capabilityTierProvider?: () => CapabilityTier;
  wyomingShardRouting: WyomingShardRoutingConfig;
  companionId?: CompanionId;
  /**
   * Multi-companion (sprint-10 W1). When absent or disabled, the gateway keeps
   * the single-agent semantics (first-ready routing + broadcast notifications)
   * byte-identical. When enabled, every routed exchange is companion-addressed
   * and any ambiguity fails closed.
   */
  multiCompanion?: GatewayMultiCompanionConfig;
  /**
   * Inter-companion channel lane (sprint-10 W6): resolves companion-room /
   * companion-dm addressing for `companion.message.send`. Requires the
   * multi-companion flag; providing it flag-off is a configuration error
   * (fail closed). Absent while multi-companion is on, the lane RPC alarms
   * and rejects every send.
   */
  companionChannels?: GatewayCompanionChannelLane;
  /** Durable shared-schema authority for the content-free ICP autonomy broker. */
  icpAutonomyStore?: IcpSharedAutonomyStorePort;
  /** Canonical gateway-owned deterministic policy authority for ICP initiation. */
  icpInitiationPolicyAuthority?: Pick<GatewayIcpInitiationPolicyAuthority, 'resolve' | 'authorizeHandoff'>;
  /** Shared clock for companion room delivery/reply boundary tests. */
  companionChannelNow?: () => number;
  /**
   * Gateway-process event bus. Carries the redacted `companion.*` relay
   * events: approval lifecycle emitted at the confirmation-queue choke
   * points, plus agent-forwarded tool/artifact events re-published from
   * `companion.event.publish` (w9hj.1).
   */
  eventBus: EventBus;
}

type IcpQueuedInvalidationReason =
  | 'peer_offline'
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
  private readonly options: GatewayServerOptions;
  private readonly sessionHmacKeyring: SessionHmacKeyring;
  private streamRequestCounter = 0;
  private readonly capabilityTierProvider: () => CapabilityTier;
  private readonly wyomingShardRouting: WyomingShardRoutingConfig;
  private readonly ntfyNotifier: GatewayNtfyNotifier;
  private readonly approvalBoundary: ApprovalBoundaryService;
  private readonly canaryEgressGuard: CanaryEgressGuard | null;
  private readonly runtimeHealthTracker: GatewayRuntimeHealthTracker;
  private readonly apiStreamListeners = new Map<string, Set<(text: string) => void>>();
  private readonly multiCompanion: GatewayMultiCompanionConfig;
  private readonly fleetCompanionIds: ReadonlySet<CompanionId>;
  private readonly companionConnections = new Map<CompanionId, GatewayRpcConnection>();
  private readonly companionLastSeen = new Map<CompanionId, number>();
  private readonly companionViolationLog: CompanionViolationEvent[] = [];
  private readonly companionDeliveryFailureReceipts = new CompanionDeliveryFailureReceipts();
  private readonly icpAutonomyBroker: GatewayIcpAutonomyBroker | null;
  private readonly pendingIcpInvalidations = new Map<string, PendingIcpInvalidation>();
  /**
   * Same-process retry accelerator only. This map deliberately is not the
   * durable exactly-once boundary: an RPC acknowledgement can be lost across
   * a gateway restart, so correlated sends retain one deterministic message
   * id and may be notified again. Recipient agents must claim that id before
   * durable recovery reads and use their L0 source-id lookup for cross-process
   * idempotency.
   */
  private readonly deliveredIcpMessages = new Map<string, {
    content: string;
    correlation: string;
    expiresAtMs: number;
    result: CompanionMessageSendResult;
  }>();
  private readonly gardenQueueChangeUnsubscribers: Array<() => void> = [];
  private readonly sharedWorkspaceReader: SharedCompanionWorkspaceReader | null;

  constructor(options: GatewayServerOptions) {
    this.options = options;
    this.sessionHmacKeyring = options.sessionHmacKeyring;
    this.multiCompanion = options.multiCompanion ?? disabledGatewayMultiCompanionConfig();
    this.fleetCompanionIds = new Set(this.multiCompanion.fleetCompanionIds);
    this.sharedWorkspaceReader = this.multiCompanion.enabled && this.multiCompanion.sharedWorkspacePath
      ? new SharedCompanionWorkspaceReader(this.multiCompanion.sharedWorkspacePath)
      : null;
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
          isCompanionReady: companionId => this.resolveReadyCompanionConnection(companionId) !== null,
          policyAuthority: options.icpInitiationPolicyAuthority!,
          eventBus: options.eventBus,
          alarm: (event, message, details) => this.alarmCompanionViolation(event, message, details),
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
      });
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
    const cogSecMode = options.intakeScreening?.mode ?? 'off';
    this.canaryEgressGuard = cogSecMode === 'off'
      ? null
      : createCanaryEgressGuard({
          mode: cogSecMode,
          ...(options.cogSecEvents ? { cogSecEvents: options.cogSecEvents } : {}),
          log,
        });
    this.approvalBoundary = createGatewayApprovalBoundaryService({
      policyConfig: options.policyConfig,
      ntfyNotifier: this.ntfyNotifier,
      discordAdapter: options.discordAdapter,
      capabilityTierProvider: this.capabilityTierProvider,
      confirmation: options.confirmation,
      canaryEgressGuard: this.canaryEgressGuard,
      eventBus: options.eventBus,
      audit: this.audit.bind(this),
      auditComplete: this.auditComplete.bind(this),
      recordMethodSuccess: (method) => this.runtimeHealthTracker.recordMethodSuccess(method),
      recordMethodFailure: (method, error) => this.runtimeHealthTracker.recordMethodFailure(method, error),
    });
    this.runtimeHealthTracker = new GatewayRuntimeHealthTracker({
      ntfyConfigured: Boolean(options.ntfy),
      vaultEnabled: Boolean(options.policyConfig.vault?.enabled),
      vaultAllowActions: options.policyConfig.vault?.allowActions ?? [],
      vaultOpsConfigured: Boolean(options.policyConfig.vault?.ops),
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

  subscribeApiStream(requestId: string, listener: (text: string) => void): () => void {
    const listeners = this.apiStreamListeners.get(requestId) ?? new Set();
    listeners.add(listener);
    this.apiStreamListeners.set(requestId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.apiStreamListeners.delete(requestId);
      }
    };
  }

  private dispatchApiStreamDelta(notification: ApiStreamDeltaNotification): void {
    const listeners = this.apiStreamListeners.get(notification.requestId);
    if (!listeners) return;
    for (const listener of listeners) {
      listener(notification.text);
    }
  }

  private registerMethods(target: JSONRPCServerAndClient, conn: GatewayRpcConnection): void {
    const inlineImageRetention = new GatewayInlineImageRetention();
    this.inlineImageRetentionByConnection.set(conn, inlineImageRetention);
    const resolveWorkspacePath = (): string => this.resolveConnectionWorkspacePath(conn);
    const resolvePolicyConfig = (): PolicyConfig => this.resolveConnectionPolicyConfig(conn);
    const runtime: GatewayMethodRuntime = {
      target,
      llmProvider: this.options.llmProvider,
      embeddingService: this.options.embeddingService,
      ...(this.options.modelDiscovery ? { modelDiscovery: this.options.modelDiscovery } : {}),
      discordAdapter: this.resolveConnectionDiscordDock(conn),
      gitOps: this.options.gitOps,
      imageConfig: this.options.imageConfig,
      ...(this.options.modelUsageRecorder ? { modelUsageRecorder: this.options.modelUsageRecorder } : {}),
      ...(this.options.credentialVault ? { credentialVault: this.options.credentialVault } : {}),
      ...(this.options.intakeScreening ? { intakeScreening: this.options.intakeScreening } : {}),
      ...(this.options.visionIntake ? { visionIntake: this.options.visionIntake } : {}),
      inlineImageRetention,
      get policyConfig() { return resolvePolicyConfig(); },
      get workspacePath() { return resolveWorkspacePath(); },
      personalWorkspaceIsolation: this.multiCompanion.enabled,
      sessionHmacKeyring: this.sessionHmacKeyring,
      approvalBoundary: this.approvalBoundary,
      ...(this.options.kubeSelfManagement
        ? { kubeSelfManagement: this.options.kubeSelfManagement }
        : {}),
      authenticatedCompanionId: () => this.authenticatedCompanionId(conn),
      notifyRequester: (method, params) => this.notifyRequestingConnection(conn, method, params),
      listPendingConfirmations: () => this.approvalBoundary.listPendingConfirmations(),
      listConfirmationHistory: () => this.approvalBoundary.listConfirmationHistory(),
      resolveConfirmation: (params) => this.approvalBoundary.resolveConfirmation(params, {
        kind: 'companion',
        id: this.authenticatedCompanionId(conn) ?? 'unidentified-agent-rpc',
      }),
      sendNtfy: (params) => this.ntfyNotifier.send(params),
      getRuntimeHealth: () => this.getRuntimeHealth(),
      getCredentialPresence: () => this.options.credentialPresence ?? EMPTY_CREDENTIAL_PRESENCE,
      nextStreamRequestId: () => `gw-${++this.streamRequestCounter}`,
      authorizeIcpConversationCorrelation: async (correlation) => {
        if (!this.icpAutonomyBroker) {
          throw new JSONRPCErrorException(
            'ICP autonomy broker is not configured',
            GatewayErrors.COMPANION_ROUTING_UNAVAILABLE,
          );
        }
        const companionId = this.requireAuthenticatedAgentCompanionId(conn);
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
      requireAuthenticatedCompanionId: () => this.requireAuthenticatedAgentCompanionId(conn),
      audited: (method, handler, paramsSummary) => this.audited(method, handler, paramsSummary),
    });
    target.addMethod('gateway.client.identify', (params: unknown) => this.identifyConnection(conn, params));
    target.addMethod('companion.message.send', this.audited(
      'companion.message.send',
      (params: unknown) => this.handleCompanionMessageSend(conn, params),
      (params: unknown) => ({
        senderCompanionId: this.connectionStatuses.get(conn)?.companionId ?? '(unidentified)',
        ...(isRecord(params) && typeof params.channelId === 'string' ? { channelId: params.channelId } : {}),
        ...(isRecord(params) && typeof params.content === 'string' ? { contentLength: params.content.length } : {}),
      }),
    ));
    target.addMethod('companion.message.report_failure', this.audited(
      'companion.message.report_failure',
      (params: unknown) => this.handleCompanionMessageFailureReport(conn, params),
      (params: unknown) => ({
        reportingCompanionId: this.connectionStatuses.get(conn)?.companionId ?? '(unidentified)',
        ...(isRecord(params) && typeof params.channelId === 'string' ? { channelId: params.channelId } : {}),
        ...(isRecord(params) && typeof params.messageId === 'string' ? { messageId: params.messageId } : {}),
        ...(isRecord(params) && typeof params.reason === 'string' ? { reason: params.reason } : {}),
      }),
    ));
    target.addMethod('api.stream.delta', (params: unknown) => {
      if (this.multiCompanion.enabled && !this.isConnectionAuthorizedForApiStream(conn)) {
        this.alarmCompanionViolation(
          'api_stream_delta_rejected',
          'api.stream.delta rejected: sending connection is not the routed api companion',
          {
            senderCompanionId: this.connectionStatuses.get(conn)?.companionId ?? '(unidentified)',
            routedApiCompanionId: this.multiCompanion.channelRouting.api ?? '(unrouted)',
          },
        );
        return null;
      }
      this.dispatchApiStreamDelta(params as ApiStreamDeltaNotification);
      return null;
    });
    target.addMethod('companion.event.publish', async (params: unknown) => {
      await this.dispatchCompanionEventPublish(conn, params);
      return null;
    });
    target.addMethod('shared.workspace.list', this.audited(
      'shared.workspace.list',
      (params: unknown) => this.listSharedWorkspaceArtifacts(conn, params),
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

  private listSharedWorkspaceArtifacts(conn: GatewayRpcConnection, params: unknown) {
    if (params !== undefined && (!isRecord(params) || Object.keys(params).length > 0)) {
      throw new Error('shared.workspace.list accepts no parameters or identity assertions');
    }
    return { artifacts: this.requireSharedWorkspaceReader(conn).listArtifacts() };
  }

  private readSharedWorkspaceArtifact(conn: GatewayRpcConnection, params: unknown) {
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
      ...(basePolicy.shellExec
        ? { shellExec: { ...basePolicy.shellExec, allowedCwd: [workspacePath] } }
        : {}),
    };
  }

  /**
   * Agent-forwarded redacted companion events (tool activity, artifacts).
   * The params are re-validated and payloads reconstructed field-by-field at
   * this process boundary; malformed frames are rejected, never partially
   * published. Approval events cannot arrive here — they originate inside
   * the gateway approval boundary.
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
  }): Promise<ConfirmationResolveResult> {
    return this.approvalBoundary.resolveConfirmation(params, {
      kind: 'companion',
      id: 'companion-relay',
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
    };
  }

  private requireCompanionDiscordDock(conn: GatewayRpcConnection): ChannelOutboundDock {
    const companionId = this.connectionStatuses.get(conn)?.companionId;
    if (!companionId) {
      this.alarmCompanionViolation(
        'discord_send_unidentified',
        'Discord outbound rejected: connection has no bound companionId',
        {},
      );
      throw new Error('Multi-account discord outbound requires an identified companion connection');
    }
    const dock = this.options.discordAccountDocks?.get(companionId);
    if (!dock) {
      this.alarmCompanionViolation(
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

  private isConnectionAuthorizedForApiStream(conn: GatewayRpcConnection): boolean {
    const routedCompanionId = this.multiCompanion.channelRouting.api;
    if (!routedCompanionId) {
      return false;
    }
    return this.connectionStatuses.get(conn)?.companionId === routedCompanionId;
  }

  // ── Inter-companion channel lane (sprint-10 W6) ──
  // `companion.message.send`: the ONLY way a companion message moves between
  // agents. The sender identity is the connection's BOUND companionId (never a
  // parameter); the lane resolves recipients (room = presence at the place,
  // DM = the addressed peer); every delivery is an ordinary inbound channel
  // notification (`companion.message`) so the receiving agent runs it through
  // the normal turn pipeline — fatigue (MI↔MI charging, hard suppression),
  // trust, and extraction apply with zero new mechanism. No side-channel
  // dispatch exists (sprint doc §8 fatigue-bypass risk).

  private async handleCompanionMessageSend(
    conn: GatewayRpcConnection,
    params: unknown,
  ): Promise<CompanionMessageSendResult> {
    if (!this.multiCompanion.enabled) {
      throw new Error(
        'Inter-companion channels do not exist in single-companion topology '
        + '(enable multi-companion mode to use companion.message.send)',
      );
    }
    const lane = this.options.companionChannels;
    if (!lane) {
      this.alarmCompanionViolation(
        'companion_lane_unconfigured',
        'companion.message.send rejected: multi-companion is enabled but no companion channel lane is wired',
        {},
      );
      throw new JSONRPCErrorException(
        'Inter-companion channel lane is not configured on this gateway',
        GatewayErrors.COMPANION_ROUTING_UNAVAILABLE,
      );
    }

    const status = this.connectionStatuses.get(conn);
    const senderCompanionId = status?.role === 'agent' ? status.companionId : undefined;
    if (!senderCompanionId) {
      this.alarmCompanionViolation(
        'companion_send_unidentified',
        'companion.message.send rejected: connection has no bound agent companionId',
        {},
      );
      throw new Error('companion.message.send requires an identified agent companion connection');
    }

    const {
      channelId,
      content,
      authorName,
      messageId: requestedMessageId,
      initiation,
      correlation,
      replyToMessageId,
    } = parseCompanionMessageSendParams(params);
    let initiationPermitOutcome: 'consumed' | 'replayed' | undefined;
    let initiationPermitExpiresAtMs: number | undefined;
    let messageCorrelation: import('../../shared/contracts/icp-autonomy.js').IcpConversationCorrelation | undefined;
    if (initiation) {
      if (!this.icpAutonomyBroker) {
        throw new JSONRPCErrorException(
          'ICP autonomy broker is not configured',
          GatewayErrors.COMPANION_ROUTING_UNAVAILABLE,
        );
      }
      const { correlation } = initiation;
      if (correlation.localCompanionId !== senderCompanionId
        || correlation.peerCompanionId !== initiation.recipientCompanionId
        || correlation.initiatedByCompanionId !== senderCompanionId
        || correlation.channelId !== channelId
        || correlation.conversationId !== initiation.conversationId) {
        this.alarmCompanionViolation(
          'icp_initiation_delivery_mismatch',
          'ICP initiation delivery correlation does not match the authenticated sender binding',
          { senderCompanionId, channelId, recipientCompanionId: initiation.recipientCompanionId },
        );
        throw new Error('ICP initiation delivery correlation mismatch');
      }
      const consumption = await this.icpAutonomyBroker.consumePermit(senderCompanionId, {
        permitId: initiation.permitId,
        conversationId: initiation.conversationId,
        recipientCompanionId: initiation.recipientCompanionId,
        channelId,
        rootInitiationId: correlation.rootInitiationId,
        peerContactId: correlation.peerContactId,
      });
      if ((consumption.outcome !== 'consumed' && consumption.outcome !== 'replayed')
        || !consumption.permit) {
        throw new JSONRPCErrorException(
          `ICP initiation permit delivery rejected: ${consumption.reasonCode ?? consumption.outcome}`,
          GatewayErrors.COMPANION_ROUTING_UNAVAILABLE,
        );
      }
      if (correlation.messageId !== `icp-initiation:${consumption.permit.candidateId}`
        || correlation.requestId !== correlation.messageId) {
        this.alarmCompanionViolation(
          'icp_initiation_delivery_mismatch',
          'ICP initiation delivery correlation does not match the consumed permit',
          { senderCompanionId, channelId, conversationId: initiation.conversationId },
        );
        throw new Error('ICP initiation delivery permit/correlation mismatch');
      }
      initiationPermitOutcome = consumption.outcome;
      initiationPermitExpiresAtMs = consumption.permit.expiresAtMs;
      messageCorrelation = {
        ...correlation,
        rootInitiationId: consumption.episode.rootInitiationId,
      };
    } else if (correlation) {
      if (!this.icpAutonomyBroker) {
        throw new JSONRPCErrorException(
          'ICP autonomy broker is not configured',
          GatewayErrors.COMPANION_ROUTING_UNAVAILABLE,
        );
      }
      messageCorrelation = await this.icpAutonomyBroker.bindConversationReplyCorrelation(
        senderCompanionId,
        correlation,
      );
    }

    const stableIcpMessageId = messageCorrelation
      ? deriveIcpTransportMessageId(messageCorrelation)
      : undefined;
    if (stableIcpMessageId !== requestedMessageId) {
      this.alarmCompanionViolation(
        'icp_delivery_message_id_mismatch',
        'Correlated ICP send did not use its deterministic gateway-bound message id',
        { senderCompanionId, channelId, requestedMessageId, stableIcpMessageId },
      );
      throw new Error('Correlated ICP transport message id mismatch');
    }
    const now = Date.now();
    for (const [cachedMessageId, delivered] of this.deliveredIcpMessages.entries()) {
      if (delivered.expiresAtMs <= now) this.deliveredIcpMessages.delete(cachedMessageId);
    }
    if (stableIcpMessageId) {
      // Collapse an identical retry while this gateway process still owns the
      // result. On restart the cache is empty and at-least-once redelivery is
      // intentional; the recipient's durable source-envelope binding is
      // authoritative across gateway process restarts.
      const delivered = this.deliveredIcpMessages.get(stableIcpMessageId);
      if (delivered) {
        if (delivered.content !== content
          || delivered.correlation !== JSON.stringify(messageCorrelation)) {
          this.alarmCompanionViolation(
            'icp_delivery_replay_mismatch',
            'Replayed ICP message changed its already-delivered content or correlation',
            { senderCompanionId, channelId, messageId: stableIcpMessageId },
          );
          throw new Error('Replayed ICP delivery mismatch');
        }
        return {
          ...delivered.result,
          ...(initiationPermitOutcome ? { permitOutcome: 'replayed' as const } : {}),
        };
      }
    }

    // The envelope timestamp is minted BEFORE recipient resolution and handed
    // to the lane: private-room windowing (bead s10rm) compares each
    // recipient's presence `since` against this exact instant, so the window
    // check and the delivered envelope can never disagree on the clock.
    const mintedAt = new Date(this.options.companionChannelNow?.() ?? Date.now());
    const senderReplyReceipt = replyToMessageId !== undefined
      ? this.companionDeliveryFailureReceipts.claimReply(
        senderCompanionId,
        channelId,
        replyToMessageId,
        mintedAt.getTime(),
      )
      : null;
    if (replyToMessageId !== undefined && !senderReplyReceipt) {
      this.alarmCompanionViolation(
        'companion_reply_unverified',
        'Companion reply does not match an unclaimed gateway delivery receipt',
        { senderCompanionId, channelId, replyToMessageId },
      );
      throw new JSONRPCErrorException(
        'Companion reply does not match an unclaimed gateway delivery receipt',
        GatewayErrors.COMPANION_ROUTING_UNAVAILABLE,
      );
    }
    const resolution = await lane.resolveDelivery(senderCompanionId, channelId, {
      messageTimestampMs: mintedAt.getTime(),
      ...(senderReplyReceipt?.roomPresenceEpoch
        ? { senderReplyPresenceEpoch: senderReplyReceipt.roomPresenceEpoch }
        : {}),
    });
    if (!resolution.ok) {
      this.alarmCompanionViolation(
        resolution.violation.event,
        resolution.violation.message,
        resolution.violation.details,
      );
      throw new JSONRPCErrorException(
        resolution.violation.message,
        GatewayErrors.COMPANION_ROUTING_UNAVAILABLE,
      );
    }
    if (initiation && !resolution.recipients.includes(initiation.recipientCompanionId)) {
      throw new JSONRPCErrorException(
        'ICP initiation recipient is outside the current channel delivery window',
        GatewayErrors.COMPANION_ROUTING_UNAVAILABLE,
      );
    }

    // Gateway-authoritative message envelope: id and timestamp are minted
    // here, the author identity is the verified sender companionId, and the
    // machine-intelligence marker is stamped by construction (every sender on
    // this lane is a companion) so observed-MI contact tagging and fatigue
    // relationship classes apply on the recipient with no trust in
    // sender-supplied metadata.
    const message = {
      id: stableIcpMessageId
        ? stableIcpMessageId
        : `companion-${randomUUID()}`,
      channelId,
      channelType: COMPANION_CHANNEL_TYPE,
      authorId: senderCompanionId,
      authorName: authorName ?? senderCompanionId,
      content,
      timestamp: mintedAt.toISOString(),
      isDirectMessage: resolution.kind === 'dm',
      routing: {
        source: 'companion',
        authorIsMachineIntelligence: true,
        ...(messageCorrelation ? { icpCorrelation: messageCorrelation } : {}),
        ...(resolution.kind === 'room'
          ? {
            channelPrivacy: resolution.roomPrivacy,
            room: {
              placeId: resolution.placeId,
              privacy: resolution.roomPrivacy,
            },
          }
          : {}),
      },
      ...(senderReplyReceipt ? { replyToMessageId: senderReplyReceipt.messageId } : {}),
    };

    this.refreshConnectionHealth();
    const deliveredTo: string[] = [];
    const skippedOffline: string[] = [];
    for (const recipientId of resolution.recipients) {
      const recipientConn = this.resolveReadyCompanionConnection(recipientId);
      if (!recipientConn) {
        if (resolution.kind === 'dm') {
          // DM to a disconnected peer fails closed back to the sender.
          this.alarmCompanionViolation(
            'companion_dm_peer_unavailable',
            `Companion DM peer "${recipientId}" has no ready agent connection`,
            { senderCompanionId, channelId, peerCompanionId: recipientId },
          );
          throw new JSONRPCErrorException(
            `Companion DM peer "${recipientId}" is not connected`,
            GatewayErrors.COMPANION_ROUTING_UNAVAILABLE,
          );
        }
        // A room with an offline member still works: skip with a log.
        log.info('Companion room recipient has no ready connection; skipping delivery', {
          senderCompanionId,
          channelId,
          recipientCompanionId: recipientId,
        });
        skippedOffline.push(recipientId);
        continue;
      }
      const roomPresenceEpoch = resolution.kind === 'room'
        ? resolution.recipientPresenceEpochs[recipientId]
        : undefined;
      this.companionDeliveryFailureReceipts.record({
        channelId,
        messageId: message.id,
        senderCompanionId,
        recipientCompanionId: recipientId,
        deliveredAt: mintedAt.getTime(),
        ...(roomPresenceEpoch ? { roomPresenceEpoch } : {}),
      });
      try {
        this.notifyOne(recipientConn, 'companion.message', { message });
      } catch (error) {
        this.companionDeliveryFailureReceipts.consume(recipientId, message.id);
        throw error;
      }
      deliveredTo.push(recipientId);
    }

    if (resolution.kind === 'room' && resolution.windowExcluded && resolution.windowExcluded.length > 0) {
      // Private-room join race: present companions whose window opened after
      // the mint receive nothing pre-join (bead s10rm). Loud log,
      // not a violation — this is the window working as designed.
      log.info('Companion room recipients excluded by presence window', {
        senderCompanionId,
        channelId,
        messageId: message.id,
        windowExcluded: resolution.windowExcluded,
      });
    }

    log.info('Companion message routed', {
      senderCompanionId,
      channelId,
      kind: resolution.kind,
      messageId: message.id,
      deliveredTo,
      skippedOffline,
    });

    const result: CompanionMessageSendResult = {
      channelId,
      messageId: message.id,
      deliveredTo,
      skippedOffline,
      ...(initiationPermitOutcome ? { permitOutcome: initiationPermitOutcome } : {}),
    };
    if (stableIcpMessageId && messageCorrelation) {
      this.deliveredIcpMessages.set(stableIcpMessageId, {
        content,
        correlation: JSON.stringify(messageCorrelation),
        expiresAtMs: initiationPermitExpiresAtMs ?? (now + ICP_DELIVERY_REPLAY_CACHE_TTL_MS),
        result,
      });
    }
    return result;
  }

  private async handleCompanionMessageFailureReport(
    conn: GatewayRpcConnection,
    params: unknown,
  ): Promise<CompanionMessageFailureReportResult> {
    if (!this.multiCompanion.enabled || !this.options.companionChannels) {
      throw new JSONRPCErrorException(
        'Inter-companion channel lane is not configured on this gateway',
        GatewayErrors.COMPANION_ROUTING_UNAVAILABLE,
      );
    }

    const status = this.connectionStatuses.get(conn);
    const reportingCompanionId = status?.role === 'agent' ? status.companionId : undefined;
    if (!reportingCompanionId) {
      throw new Error('companion.message.report_failure requires an identified agent companion connection');
    }

    const { channelId, messageId, reason } = parseCompanionMessageFailureReport(params);
    const receipt = this.companionDeliveryFailureReceipts.findVerified(
      reportingCompanionId,
      { channelId, messageId, reason },
    );
    if (!receipt) {
      this.alarmCompanionViolation(
        'companion_failure_report_unverified',
        'Companion failure report does not match a gateway delivery receipt',
        { reportingCompanionId, channelId, messageId },
      );
      throw new JSONRPCErrorException(
        'Companion failure report does not match a gateway delivery receipt',
        GatewayErrors.COMPANION_ROUTING_UNAVAILABLE,
      );
    }

    this.refreshConnectionHealth();
    const senderConn = this.resolveReadyCompanionConnection(receipt.senderCompanionId);
    if (!senderConn) {
      throw new JSONRPCErrorException(
        `Original companion sender "${receipt.senderCompanionId}" is not connected`,
        GatewayErrors.COMPANION_ROUTING_UNAVAILABLE,
      );
    }

    const notification: CompanionMessageDeliveryFailureNotification = {
      channelId,
      messageId,
      reportingCompanionId,
      reason,
      reportedAt: new Date().toISOString(),
    };
    this.notifyOne(senderConn, 'companion.message.delivery_failure', notification);
    this.companionDeliveryFailureReceipts.consume(reportingCompanionId, messageId);
    log.warn('Companion message delivery failure reported to original sender', notification);
    return { reportedTo: receipt.senderCompanionId };
  }

  /** Ready+healthy agent connection for a companion, or null. Never throws. */
  private resolveReadyCompanionConnection(companionId: CompanionId): GatewayRpcConnection | null {
    const conn = this.companionConnections.get(companionId);
    if (!conn) {
      return null;
    }
    const status = this.connectionStatuses.get(conn);
    if (!status || status.role !== 'agent' || status.state !== 'ready' || status.health !== 'healthy') {
      return null;
    }
    return conn;
  }

  private requireAuthenticatedAgentCompanionId(conn: GatewayRpcConnection): string {
    const status = this.connectionStatuses.get(conn);
    if (status?.role !== 'agent' || !status.companionId) {
      throw new Error('ICP autonomy RPC requires an authenticated agent companion connection');
    }
    return status.companionId;
  }

  private authenticatedCompanionId(conn: GatewayRpcConnection): string | undefined {
    const status = this.connectionStatuses.get(conn);
    if (!status || status.role !== 'agent' || status.state === 'offline') {
      return undefined;
    }
    if (this.multiCompanion.enabled) {
      return status.companionId;
    }
    return status.companionId ?? this.options.companionId ?? DEFAULT_COMPANION_ID;
  }

  private notifyCompanionGardenQueueChanged(
    companionId: string,
    queue: GardenQueueName,
  ): void {
    this.refreshConnectionHealth();
    if (this.multiCompanion.enabled) {
      const conn = this.resolveReadyCompanionConnection(companionId);
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
    });
    this.appendConnectionTransition(conn, 'none', 'registering', 'connection_opened');

    const serverAndClient = new JSONRPCServerAndClient(
      new JSONRPCServer(),
      new JSONRPCClient((request) => { conn.send(request); }),
    );
    this.registerMethods(serverAndClient, conn);
    this.rpcClients.set(conn, serverAndClient);
    if (!this.multiCompanion.enabled) {
      this.transitionConnectionState(conn, 'ready', 'rpc_registered');
    }

    conn.on('frameError', async (error: unknown) => {
      const frameError = normalizeNdjsonFrameError(error);
      await this.handleMalformedFrame(conn, 'ndjson', frameError.reason, frameError.preview);
    });

    conn.on('heartbeat', () => {
      this.touchConnectionHealthcheck(conn);
    });

    conn.onMessage(async (message) => {
      if (!this.connections.has(conn)) {
        return;
      }
      this.touchConnectionHealthcheck(conn);
      const validationError = validateJsonRpcFrame(message);
      if (validationError) {
        await this.handleMalformedFrame(
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
      if ((message as Record<string, unknown>).method !== 'gateway.client.identify') {
        this.transitionConnectionState(conn, 'ready', 'rpc_message_received');
      }
      const releaseInFlightHealthcheck = this.beginInFlightHealthcheck(conn);
      // json-rpc-2.0 receiveAndSend() payload param is typed as `any`; message is parsed JSON
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      try {
        await serverAndClient.receiveAndSend(message as any);
      } catch (error) {
        const messageText = toErrorMessage(error);
        await this.handleMalformedFrame(
          conn,
          'jsonrpc',
          `JSON-RPC receive/send failed: ${messageText}`,
          summarizeFramePreview(message),
        );
      } finally {
        releaseInFlightHealthcheck();
      }
    });

    conn.on('close', () => {
      log.info('Agent disconnected');
      this.transitionConnectionState(conn, 'offline', 'connection_closed');
      this.removeConnection(conn);
    });

    conn.on('error', (err) => {
      const messageText = err instanceof Error ? err.message : String(err);
      log.error('Connection error', { error: messageText });
      this.transitionConnectionState(conn, 'degraded', 'connection_error', messageText);
      this.transitionConnectionState(conn, 'offline', 'connection_error', messageText);
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
    if (!this.multiCompanion.enabled) {
      this.refreshConnectionHealth();
      return this.notifyAll(method, params);
    }
    const route = this.resolveCompanionAgent(surface, discordAccountId);
    return this.notifyOne(route.conn, method, params) ? 1 : 0;
  }

  /**
   * Notify the connection that originated the in-flight request (e.g.
   * llm.chunk streaming deltas). Single-companion mode preserves the existing
   * broadcast path byte-identically; multi-companion mode pins delivery to the
   * requesting connection so one companion's stream can never reach another.
   */
  private notifyRequestingConnection(
    conn: GatewayRpcConnection,
    method: string,
    params: unknown,
  ): void {
    if (this.multiCompanion.enabled) {
      this.notifyOne(conn, method, params);
      return;
    }
    this.notifyAll(method, params);
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
      this.alarmCompanionViolation(
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
      this.alarmCompanionViolation(
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
        this.alarmCompanionViolation(
          'identity_claim_invalid',
          'RPC frame carried an invalid companionId claim; disconnecting connection',
          { method, boundCompanionId, reason: toErrorMessage(error) },
        );
        this.transitionConnectionState(conn, 'degraded', 'companion_identity_claim_invalid');
        this.transitionConnectionState(conn, 'offline', 'companion_identity_claim_invalid');
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
      this.alarmCompanionViolation(
        'identity_mismatch',
        'Companion identity mismatch on RPC frame; disconnecting connection',
        { method, boundCompanionId, claimedCompanionId },
      );
      this.transitionConnectionState(conn, 'degraded', 'companion_identity_mismatch');
      this.transitionConnectionState(conn, 'offline', 'companion_identity_mismatch');
      this.removeConnection(conn);
      if (!conn.destroyed) {
        conn.destroy();
      }
      return 'disconnected';
    }

    if (this.multiCompanion.enabled && !boundCompanionId) {
      this.alarmCompanionViolation(
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
   * Resolve the ready agent connection owning a channel surface. Fail-closed:
   * unrouted surface, unknown/disconnected companion, or unhealthy connection
   * all alarm loudly and throw — traffic is never rerouted to another agent.
   *
   * When multi-account discord routing is active (W1-P2), the discord surface
   * routes per bot account: the adapter that received the message names its
   * accountId, and only that account's companion receives it. A missing or
   * unknown accountId fails closed — never a broadcast, never another account.
   */
  private resolveCompanionAgent(surface: GatewayChannelSurface, discordAccountId?: string): {
    conn: GatewayRpcConnection;
    client: JSONRPCServerAndClient;
    companionId: CompanionId;
  } {
    const companionId = this.resolveRoutedCompanionId(surface, discordAccountId);
    this.refreshConnectionHealth();
    return this.requireReadyCompanionRoute(surface, companionId);
  }

  private resolveSatelliteCompanionAgent(satellite: SatelliteRoutingMetadata): {
    conn: GatewayRpcConnection;
    client: JSONRPCServerAndClient;
    companionId: CompanionId;
  } {
    const routeLabel = `satellite:${satellite.satelliteId}`;
    if (!satellite.companionId) {
      this.alarmCompanionViolation(
        'unbound_satellite',
        `Satellite "${satellite.satelliteId}" has no companion binding in satellites.json`,
        { satelliteId: satellite.satelliteId, endpointId: satellite.endpointId },
      );
      throw new Error(
        `Multi-companion satellite "${satellite.satelliteId}" has no companion binding in satellites.json`,
      );
    }
    if (!this.fleetCompanionIds.has(satellite.companionId)) {
      this.alarmCompanionViolation(
        'satellite_unknown_companion',
        `Satellite "${satellite.satelliteId}" names a companion absent from companions.json`,
        {
          satelliteId: satellite.satelliteId,
          endpointId: satellite.endpointId,
          companionId: satellite.companionId,
        },
      );
      throw new Error(
        `Satellite "${satellite.satelliteId}" routes to companion "${satellite.companionId}" `
        + 'which is absent from companions.json',
      );
    }
    this.refreshConnectionHealth();
    return this.requireReadyCompanionRoute(routeLabel, satellite.companionId);
  }

  private resolveRoutedCompanionId(
    surface: GatewayChannelSurface,
    discordAccountId?: string,
  ): CompanionId {
    if (surface === 'discord' && this.discordAccountRoutingActive()) {
      if (!discordAccountId) {
        this.alarmCompanionViolation(
          'unrouted_discord_account',
          'Discord surface uses per-account routing but the inbound message carries no accountId',
          { surface },
        );
        throw new Error(
          'Multi-account discord routing requires an accountId for the discord surface',
        );
      }
      const companionId = this.multiCompanion.discordAccounts[discordAccountId];
      if (!companionId) {
        this.alarmCompanionViolation(
          'unrouted_discord_account',
          `Discord account "${discordAccountId}" has no companion routing entry in channels.json`,
          { surface, discordAccountId },
        );
        throw new Error(
          `Multi-companion routing has no companion for discord account "${discordAccountId}"`,
        );
      }
      return companionId;
    }
    if (discordAccountId) {
      this.alarmCompanionViolation(
        'unrouted_discord_account',
        `Received discord accountId "${discordAccountId}" but no discord.accounts routing is configured`,
        { surface, discordAccountId },
      );
      throw new Error(
        `No discord account routing configured for account "${discordAccountId}"`,
      );
    }
    const companionId = this.multiCompanion.channelRouting[surface];
    if (!companionId) {
      this.alarmCompanionViolation(
        'unrouted_channel',
        `Channel surface "${surface}" has no companion routing entry in channels.json`,
        { surface },
      );
      throw new Error(
        `Multi-companion routing has no companion for channel surface "${surface}"`,
      );
    }
    return companionId;
  }

  private requireReadyCompanionRoute(surface: string, companionId: CompanionId): {
    conn: GatewayRpcConnection;
    client: JSONRPCServerAndClient;
    companionId: CompanionId;
  } {
    const conn = this.companionConnections.get(companionId);
    if (!conn) {
      this.alarmCompanionViolation(
        'companion_not_connected',
        `Companion "${companionId}" (surface "${surface}") has no connected agent`,
        { surface, companionId },
      );
      throw new Error(`No agent connection for companion "${companionId}" (surface "${surface}")`);
    }
    const status = this.connectionStatuses.get(conn);
    if (!status || status.role !== 'agent' || status.state !== 'ready' || status.health !== 'healthy') {
      this.alarmCompanionViolation(
        'companion_not_ready',
        `Companion "${companionId}" (surface "${surface}") connection is not ready`,
        {
          surface,
          companionId,
          state: status?.state ?? 'missing',
          health: status?.health ?? 'missing',
        },
      );
      throw new Error(`Agent connection for companion "${companionId}" is not ready (surface "${surface}")`);
    }
    const client = this.rpcClients.get(conn);
    if (!client) {
      this.alarmCompanionViolation(
        'companion_rpc_client_missing',
        `Companion "${companionId}" (surface "${surface}") has no RPC client bound`,
        { surface, companionId },
      );
      throw new Error(`No RPC client for companion "${companionId}" (surface "${surface}")`);
    }
    return { conn, client, companionId };
  }

  /**
   * Loud fail-closed alarm for multi-companion routing/identity violations:
   * synchronous error log, gateway audit entry (DENY), and an operator ntfy
   * alert when configured. Never throws.
   */
  private alarmCompanionViolation(
    event: string,
    message: string,
    details: Record<string, unknown>,
  ): void {
    log.error(`Multi-companion violation [${event}]: ${message}`, details);
    this.recordCompanionViolation(event, details);
    const startedAt = Date.now();
    void (async () => {
      const auditId = await this.audit(`gateway.companion.${event}`, 'DENY', details);
      await this.auditComplete(auditId, startedAt, message);
      if (this.ntfyNotifier.isConfigured()) {
        await this.ntfyNotifier.send({
          message: `${message} (${JSON.stringify(details)})`,
          title: 'Multi-companion routing violation',
          priority: 5,
          sender: {
            kind: 'system',
            provenance: 'system.operator_alert.multi_companion_routing',
          },
        });
      }
    })().catch((error: unknown) => {
      log.error('Failed to record multi-companion violation alarm', {
        event,
        error: toErrorMessage(error),
      });
    });
  }

  private recordCompanionViolation(event: string, details: Record<string, unknown>): void {
    const companionId = extractViolationCompanionId(details);
    this.companionViolationLog.push({
      event,
      ...(companionId !== undefined ? { companionId } : {}),
      at: Date.now(),
    });
    if (this.companionViolationLog.length > COMPANION_VIOLATION_LOG_LIMIT) {
      this.companionViolationLog.splice(
        0,
        this.companionViolationLog.length - COMPANION_VIOLATION_LOG_LIMIT,
      );
    }
  }

  /**
   * Read-only fleet health view (sprint-10 W4): identified companion
   * connections, last-seen activity (retained across disconnects), and recent
   * multi-companion violation counts. Consumed by the gateway fleet-status
   * page; never mutates connection state.
   */
  getFleetConnectionSnapshot(now = Date.now()): GatewayFleetConnectionSnapshot {
    this.refreshConnectionHealth(now);

    const connections: GatewayFleetCompanionConnection[] = [];
    for (const [companionId, conn] of this.companionConnections.entries()) {
      const status = this.connectionStatuses.get(conn);
      if (!status || status.state === 'offline') {
        continue;
      }
      connections.push({
        companionId,
        state: status.state,
        health: status.health,
        stateReason: status.stateReason,
        connectedAt: status.connectedAt,
        lastSeenAt: status.lastHealthcheckAt,
      });
    }

    const windowStart = now - FLEET_RECENT_VIOLATION_WINDOW_MS;
    const recentViolationsByCompanionId: Record<string, number> = {};
    let unattributedRecentViolationCount = 0;
    for (const violation of this.companionViolationLog) {
      if (violation.at < windowStart) {
        continue;
      }
      if (violation.companionId) {
        recentViolationsByCompanionId[violation.companionId] =
          (recentViolationsByCompanionId[violation.companionId] ?? 0) + 1;
      } else {
        unattributedRecentViolationCount += 1;
      }
    }

    return {
      generatedAt: now,
      connections,
      lastSeenByCompanionId: Object.fromEntries(this.companionLastSeen),
      recentViolationsByCompanionId,
      unattributedRecentViolationCount,
      recentViolationWindowMs: FLEET_RECENT_VIOLATION_WINDOW_MS,
    };
  }

  private removeConnection(conn: GatewayRpcConnection): void {
    const status = this.connectionStatuses.get(conn);
    if (status?.companionId) {
      // Preserve last-seen across the disconnect so the fleet view can report
      // when a now-down companion was last alive.
      this.companionLastSeen.set(status.companionId, status.lastHealthcheckAt);
    }
    if (status?.companionId && this.companionConnections.get(status.companionId) === conn) {
      this.companionConnections.delete(status.companionId);
      log.info('Companion connection unbound', { companionId: status.companionId });
      void this.queueIcpInvalidation(status.companionId, 'peer_offline')
        .catch((error: unknown) => {
          log.error('Failed to invalidate ICP permits after companion disconnect', {
            companionId: status.companionId,
            error: toErrorMessage(error),
          });
        });
    }
    this.connections.delete(conn);
    this.inlineImageRetentionByConnection.get(conn)?.clear();
    this.inlineImageRetentionByConnection.delete(conn);
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
      completion: attempt.then<IcpInvalidationAttemptOutcome>(
        (revokedCount) => ({ ok: true, revokedCount }),
        (error: unknown) => ({ ok: false, error }),
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

  private async handleMalformedFrame(
    conn: GatewayRpcConnection,
    frameKind: MalformedFrameKind,
    reason: string,
    preview?: string,
  ): Promise<void> {
    if (!this.connectionStatuses.has(conn)) {
      return;
    }

    const startedAt = Date.now();
    const params: Record<string, unknown> = {
      frameKind,
      reason,
      ...(preview ? { preview } : {}),
    };
    const auditId = await this.audit(INVALID_FRAME_AUDIT_METHOD, 'DENY', params);
    await this.auditComplete(auditId, startedAt, reason);
    log.error('Malformed IPC frame received; disconnecting agent connection', params);
    this.transitionConnectionState(conn, 'degraded', 'malformed_frame', reason);
    this.transitionConnectionState(conn, 'offline', 'malformed_frame', reason);
    this.removeConnection(conn);
    if (!conn.destroyed) {
      conn.destroy();
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
      ? this.resolveCompanionAgent('api').client
      : this.resolveReadyRpcClient();

    const result = await Promise.race([
      client.request(method, params),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Agent request timed out')), timeoutMs),
      ),
    ]);
    return result as T;
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
      this.refreshConnectionHealth();
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
      client = this.resolveReadyRpcClient();
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
    options: VoiceStreamRequestOptions = {},
  ): Promise<VoiceHandleMessageResult> {
    let client: JSONRPCServerAndClient;
    let conn: GatewayRpcConnection;
    let companionId = this.options.companionId
      ?? createCompanionId(DEFAULT_COMPANION_ID, 'Default companionId');
    if (this.multiCompanion.enabled) {
      const satellite = message.routing?.satellite;
      const satelliteSource = message.routing?.source === 'satellite';
      let route: ReturnType<GatewayServer['resolveCompanionAgent']>;
      if (satellite) {
        if (!satelliteSource) {
          this.alarmCompanionViolation(
            'invalid_satellite_route',
            'Inbound voice message carries satellite metadata without a satellite routing source',
            { channelType: message.channelType, channelId: message.channelId },
          );
          throw new Error('Satellite voice routing metadata requires routing.source="satellite"');
        }
        route = this.resolveSatelliteCompanionAgent(satellite);
      } else {
        if (satelliteSource) {
          this.alarmCompanionViolation(
            'invalid_satellite_route',
            'Inbound satellite voice message is missing authenticated satellite routing metadata',
            { channelType: message.channelType, channelId: message.channelId },
          );
          throw new Error('Satellite voice routing requires authenticated satellite metadata');
        }
        const surface = resolveGatewaySurfaceForChannelType(message.channelType);
        if (!surface) {
          this.alarmCompanionViolation(
            'unrouted_channel',
            `Inbound message channelType "${message.channelType}" has no multi-companion routing surface`,
            { channelType: message.channelType, channelId: message.channelId },
          );
          throw new Error(
            `Multi-companion routing cannot map channelType "${message.channelType}" to a companion`,
          );
        }
        route = this.resolveCompanionAgent(surface);
      }
      client = route.client;
      conn = route.conn;
      companionId = route.companionId;
    } else {
      const route = this.resolveReadyAgentConnection();
      client = route.client;
      conn = route.conn;
    }

    const result = await requestAgentVoiceStream({
      client,
      message,
      options,
      wyomingShardRouting: this.wyomingShardRouting,
      companionId,
      nextRequestCounter: () => ++this.streamRequestCounter,
    });
    const attachments = materializeGatewayAttachments(
      result.attachments,
      this.resolveConnectionWorkspacePath(conn),
    );
    return { ...result, ...(attachments ? { attachments } : {}) };
  }

  private resolveReadyRpcClient(): JSONRPCServerAndClient {
    return this.resolveReadyAgentConnection().client;
  }

  private resolveReadyAgentConnection(): {
    conn: GatewayRpcConnection;
    client: JSONRPCServerAndClient;
  } {
    this.refreshConnectionHealth();
    if (this.rpcClients.size === 0) {
      throw new Error('No agent connected');
    }

    for (const [conn, client] of this.rpcClients.entries()) {
      const status = this.connectionStatuses.get(conn);
      if (!status) {
        continue;
      }
      if (status.role === 'agent' && status.state === 'ready' && status.health === 'healthy') {
        return { conn, client };
      }
    }

    throw new Error('No ready agent connected');
  }

  private refreshConnectionHealth(now = Date.now()): void {
    for (const [conn, status] of this.connectionStatuses.entries()) {
      if (status.role !== 'agent') {
        continue;
      }
      if (status.state !== 'ready' && status.state !== 'registering') {
        continue;
      }

      const staleForMs = now - status.lastHealthcheckAt;
      if (staleForMs <= status.healthcheckStaleAfterMs) {
        continue;
      }

      const reason = `No healthcheck observed for ${staleForMs}ms (limit ${status.healthcheckStaleAfterMs}ms).`;
      this.transitionConnectionState(conn, 'degraded', 'healthcheck_stale', reason);
    }
  }

  private touchConnectionHealthcheck(conn: GatewayRpcConnection): void {
    const status = this.connectionStatuses.get(conn);
    if (!status || status.state === 'offline') {
      return;
    }
    status.lastHealthcheckAt = Date.now();
    if (status.companionId) {
      this.companionLastSeen.set(status.companionId, status.lastHealthcheckAt);
    }
    if (status.state === 'degraded' && status.stateReason === 'healthcheck_stale') {
      this.transitionConnectionState(conn, 'ready', 'healthcheck_recovered');
    }
  }

  private beginInFlightHealthcheck(conn: GatewayRpcConnection): () => void {
    const timer = setInterval(() => {
      this.touchConnectionHealthcheck(conn);
    }, CONNECTION_IN_FLIGHT_HEALTH_TOUCH_INTERVAL_MS);
    timer.unref();

    return () => {
      clearInterval(timer);
      this.touchConnectionHealthcheck(conn);
    };
  }

  private transitionConnectionState(
    conn: GatewayRpcConnection,
    nextState: GatewayConnectionState,
    reason: string,
    failureReason?: string,
  ): void {
    const status = this.connectionStatuses.get(conn);
    if (!status) {
      return;
    }

    const currentState = status.state;
    if (currentState === nextState && status.stateReason === reason && !failureReason) {
      return;
    }
    if (currentState !== nextState) {
      const allowedTransitions = GATEWAY_CONNECTION_STATE_TRANSITIONS[currentState];
      if (!allowedTransitions.includes(nextState)) {
        throw new Error(
          `Invalid gateway connection transition: ${currentState} -> ${nextState}.`,
        );
      }
      status.state = nextState;
      status.lastTransitionAt = Date.now();
    }
    status.stateReason = reason;

    if (nextState === 'ready') {
      status.health = 'healthy';
      delete status.failureReason;
    } else if (nextState === 'degraded') {
      status.health = reason === 'healthcheck_stale' ? 'stale' : 'failed';
      if (failureReason) {
        status.failureReason = failureReason;
      }
    } else if (nextState === 'offline' && failureReason) {
      status.failureReason = failureReason;
    }

    this.appendConnectionTransition(conn, currentState, nextState, reason, failureReason);
  }

  private appendConnectionTransition(
    conn: GatewayRpcConnection,
    from: GatewayConnectionState | 'none',
    to: GatewayConnectionState,
    reason: string,
    failureReason?: string,
  ): void {
    const status = this.connectionStatuses.get(conn);
    log.info('Gateway connection lifecycle transition', {
      from,
      to,
      reason,
      health: status?.health,
      ...(failureReason ? { failureReason } : {}),
    });
  }

  private getConnectionSummary(): {
    total: number;
    registering: number;
    ready: number;
    degraded: number;
    offline: number;
  } {
    const summary = {
      total: 0,
      registering: 0,
      ready: 0,
      degraded: 0,
      offline: 0,
    };

    for (const status of this.connectionStatuses.values()) {
      if (status.role !== 'agent') {
        continue;
      }
      summary.total += 1;
      if (status.state === 'registering') summary.registering += 1;
      else if (status.state === 'ready') summary.ready += 1;
      else if (status.state === 'degraded') summary.degraded += 1;
      else summary.offline += 1;
    }

    return summary;
  }

  private getRuntimeHealth(): RuntimeHealthResult {
    return this.runtimeHealthTracker.getSnapshot(this.getConnectionSummary());
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
        this.alarmCompanionViolation(
          'identify_missing_companion',
          'Authenticated gateway role identified without a companionId; rejecting',
          {},
        );
        throw new Error(missingCompanionMessage);
      }
      if (this.multiCompanion.enabled && !this.fleetCompanionIds.has(companionId)) {
        this.alarmCompanionViolation(
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
        this.alarmCompanionViolation(
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
        this.alarmCompanionViolation(
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
            this.alarmCompanionViolation(
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
      }
      status.companionId = authenticatedCompanionId;
      this.companionLastSeen.set(authenticatedCompanionId, Date.now());
      log.info('Companion connection authenticated', {
        companionId: authenticatedCompanionId,
        role: params.role,
      });
    } else if (companionId) {
      // Flag off (or non-agent role): record for observability only — routing
      // semantics stay byte-identical to single-companion behavior.
      status.companionId = companionId;
      this.companionLastSeen.set(companionId, Date.now());
    }

    status.role = params.role;
    this.transitionConnectionState(conn, 'ready', `client_identified:${params.role}`);
    return {
      success: true,
      role: params.role,
      ...(companionId ? { companionId } : {}),
    };
  }

  async stop(): Promise<void> {
    for (const retention of this.inlineImageRetentionByConnection.values()) {
      retention.clear();
    }
    this.inlineImageRetentionByConnection.clear();
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
      conn.destroy();
    }
    this.connections.clear();
    this.rpcClients.clear();
    this.connectionStatuses.clear();
    this.companionConnections.clear();
    this.companionDeliveryFailureReceipts.clear();

    if (this.rpcServer) {
      await new Promise<void>((resolve) => {
        this.rpcServer!.close(() => resolve());
      });
    }

    log.info('Stopped');
  }

  private async audit(method: string, decision: PolicyDecision, params?: Record<string, unknown>): Promise<number> {
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

  private async auditComplete(id: number, startTime: number, error?: string): Promise<void> {
    if (this.options.auditStore && id > 0) {
      await this.options.auditStore.complete(id, Date.now() - startTime, error);
    }
  }
}

/**
 * Best-effort companion attribution for a violation alarm. Violation `details`
 * carry the companion under different keys depending on the event; placeholder
 * markers like "(unidentified)" are not real ids and stay unattributed.
 */
function extractViolationCompanionId(details: Record<string, unknown>): string | undefined {
  for (const key of ['companionId', 'boundCompanionId', 'senderCompanionId']) {
    const value = details[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed || trimmed.startsWith('(')) continue;
    return trimmed;
  }
  return undefined;
}

const COMPANION_MESSAGE_MAX_CONTENT_CHARS = 65_536;
const COMPANION_MESSAGE_MAX_AUTHOR_NAME_CHARS = 200;
const COMPANION_MESSAGE_MAX_REPLY_TO_ID_CHARS = 256;

/**
 * Fail-closed validation for companion.message.send params. Note the sender
 * identity is NOT read from params — it always comes from the connection's
 * bound companionId (a params.companionId that disagrees with the binding is
 * already treated as spoofing by enforceCompanionFrameIdentity).
 */
function parseCompanionMessageSendParams(params: unknown): {
  channelId: string;
  content: string;
  authorName?: string;
  messageId?: string;
  initiation?: {
    permitId: string;
    conversationId: string;
    recipientCompanionId: string;
    correlation: IcpConversationCorrelation;
  };
  correlation?: IcpConversationCorrelation;
  replyToMessageId?: string;
} {
  if (!isRecord(params)) {
    throw new Error('companion.message.send requires an object params payload');
  }
  const channelId = typeof params.channelId === 'string' ? params.channelId.trim() : '';
  if (!channelId) {
    throw new Error('companion.message.send requires a non-empty channelId');
  }
  const content = typeof params.content === 'string' ? params.content : '';
  if (!content.trim()) {
    throw new Error('companion.message.send requires non-empty content');
  }
  if (content.length > COMPANION_MESSAGE_MAX_CONTENT_CHARS) {
    throw new Error(
      `companion.message.send content exceeds ${COMPANION_MESSAGE_MAX_CONTENT_CHARS} characters`,
    );
  }
  let authorName: string | undefined;
  if (params.authorName !== undefined) {
    if (typeof params.authorName !== 'string') {
      throw new Error('companion.message.send authorName must be a string when provided');
    }
    authorName = params.authorName.trim();
    if (!authorName || authorName.length > COMPANION_MESSAGE_MAX_AUTHOR_NAME_CHARS) {
      throw new Error(
        `companion.message.send authorName must be 1-${COMPANION_MESSAGE_MAX_AUTHOR_NAME_CHARS} characters`,
      );
    }
  }
  let messageId: string | undefined;
  if (params.messageId !== undefined) {
    if (typeof params.messageId !== 'string' || !params.messageId.trim()) {
      throw new Error('companion.message.send messageId must be a non-empty string when provided');
    }
    messageId = params.messageId.trim();
  }
  let initiation: {
    permitId: string;
    conversationId: string;
    recipientCompanionId: string;
    correlation: IcpConversationCorrelation;
  } | undefined;
  if (params.initiation !== undefined) {
    if (!isRecord(params.initiation)) {
      throw new Error('companion.message.send initiation must be an object');
    }
    assertNoUnknownKeys(
      params.initiation,
      ['permitId', 'conversationId', 'recipientCompanionId', 'correlation'] as const,
      'companion.message.send initiation',
    );
    const permitId = typeof params.initiation.permitId === 'string'
      ? params.initiation.permitId.trim()
      : '';
    const conversationId = typeof params.initiation.conversationId === 'string'
      ? params.initiation.conversationId.trim()
      : '';
    const recipientCompanionId = typeof params.initiation.recipientCompanionId === 'string'
      ? params.initiation.recipientCompanionId.trim()
      : '';
    if (!permitId || !conversationId || !recipientCompanionId) {
      throw new Error(
        'companion.message.send initiation requires permitId, conversationId, and recipientCompanionId',
      );
    }
    initiation = {
      permitId,
      conversationId,
      recipientCompanionId,
      correlation: parseIcpConversationCorrelation(params.initiation.correlation),
    };
  }
  if (params.correlation !== undefined && initiation) {
    throw new Error('companion.message.send cannot combine initiation and reply correlation');
  }
  const correlation = params.correlation === undefined
    ? undefined
    : parseIcpConversationCorrelation(params.correlation);
  if ((initiation !== undefined || correlation !== undefined) !== (messageId !== undefined)) {
    throw new Error('companion.message.send correlated transports require a deterministic messageId');
  }
  let replyToMessageId: string | undefined;
  if (params.replyToMessageId !== undefined) {
    if (typeof params.replyToMessageId !== 'string') {
      throw new Error('companion.message.send replyToMessageId must be a string when provided');
    }
    replyToMessageId = params.replyToMessageId.trim();
    if (!replyToMessageId || replyToMessageId.length > COMPANION_MESSAGE_MAX_REPLY_TO_ID_CHARS) {
      throw new Error(
        'companion.message.send replyToMessageId must be '
        + `1-${COMPANION_MESSAGE_MAX_REPLY_TO_ID_CHARS} characters`,
      );
    }
  }
  return {
    channelId,
    content,
    ...(authorName ? { authorName } : {}),
    ...(messageId ? { messageId } : {}),
    ...(initiation ? { initiation } : {}),
    ...(correlation ? { correlation } : {}),
    ...(replyToMessageId ? { replyToMessageId } : {}),
  };
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

function normalizeNdjsonFrameError(error: unknown): { reason: string; preview?: string } {
  const reason = error instanceof Error ? error.message : 'Malformed NDJSON frame received';
  if (isRecord(error)) {
    const previewValue = error.preview;
    if (typeof previewValue === 'string' && previewValue.trim()) {
      return { reason, preview: summarizeFramePreview(previewValue) };
    }
  }
  return { reason };
}

function validateJsonRpcFrame(message: unknown): string | null {
  if (!isRecord(message)) {
    return 'JSON-RPC frame must be an object';
  }
  if (message.jsonrpc !== '2.0') {
    return 'JSON-RPC frame must include jsonrpc="2.0"';
  }

  const hasMethod = hasOwn(message, 'method');
  const hasId = hasOwn(message, 'id');
  const hasResult = hasOwn(message, 'result');
  const hasError = hasOwn(message, 'error');

  if (hasMethod) {
    if (typeof message.method !== 'string' || !message.method.trim()) {
      return 'JSON-RPC request method must be a non-empty string';
    }
    if (hasResult || hasError) {
      return 'JSON-RPC request/notification must not contain result or error';
    }
    if (hasId && !isValidJsonRpcId(message.id)) {
      return 'JSON-RPC request id must be string, number, or null';
    }
    return null;
  }

  if (!hasId) {
    return 'JSON-RPC response must include id';
  }
  if (!isValidJsonRpcId(message.id)) {
    return 'JSON-RPC response id must be string, number, or null';
  }
  if (hasResult === hasError) {
    return 'JSON-RPC response must contain exactly one of result or error';
  }
  if (hasError && !isValidJsonRpcError(message.error)) {
    return 'JSON-RPC response error must include numeric code and string message';
  }
  return null;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isValidJsonRpcId(id: unknown): boolean {
  return id === null || typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
}

function isValidJsonRpcError(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.code === 'number'
    && Number.isFinite(value.code)
    && typeof value.message === 'string'
    && value.message.trim().length > 0;
}

function isIdentifiableGatewayConnectionRole(
  value: unknown,
): value is Exclude<GatewayConnectionRole, 'unidentified'> {
  return value === 'agent' || value === 'internal_session_integrity';
}

function summarizeFramePreview(message: unknown): string {
  if (typeof message === 'string') {
    return truncateFramePreview(message.trim());
  }
  try {
    const serialized = JSON.stringify(message);
    return truncateFramePreview(typeof serialized === 'string' ? serialized : String(message));
  } catch {
    return truncateFramePreview(String(message));
  }
}

function truncateFramePreview(value: string): string {
  if (value.length <= FRAME_PREVIEW_LIMIT) {
    return value;
  }
  return `${value.slice(0, FRAME_PREVIEW_LIMIT)}... (${value.length} chars)`;
}
