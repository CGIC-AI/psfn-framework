import { isRecord } from '../../shared/utils/types.js';
// ── Gateway Server ──
// Host-side process that holds secrets and proxies all external interactions.

import * as net from 'node:net';
import type * as https from 'node:https';
import {
  JSONRPCServer,
  JSONRPCClient,
  JSONRPCServerAndClient,
} from 'json-rpc-2.0';
import type { LLMProviderPort, EmbeddingProviderPort } from '../../core/agent/contracts.js';
import { DEFAULT_COMPANION_ID } from '../../core/identity/companion-naming.js';
import type { ChannelOutboundDock } from '../../channels/backplane/types.js';
import type { CapabilityTier, WyomingShardRoutingConfig } from '../../system/config/runtime-config-contracts.js';
import type { SubstrateMessage } from '../../shared/contracts/runtime.js';
import type { GatewayRpcConnection, GatewayRpcEndpoint } from './transport.js';
import { createSocketServer, createWebSocketRpcServer } from './transport.js';
import {
  GatewayErrors,
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

const log = createComponentLogger('Gateway');
const DEFAULT_CONNECTION_HEALTHCHECK_STALE_AFTER_MS = 90_000;
const CONNECTION_IN_FLIGHT_HEALTH_TOUCH_INTERVAL_MS = Math.min(
  30_000,
  Math.max(1_000, Math.floor(DEFAULT_CONNECTION_HEALTHCHECK_STALE_AFTER_MS / 3)),
);
const INVALID_FRAME_AUDIT_METHOD = 'gateway.ipc.frame.invalid';
const FRAME_PREVIEW_LIMIT = 200;
export { evaluatePolicy };
export type { GatewayNtfyConfig, PolicyConfig, VoiceStreamRequestOptions };

type GatewayConnectionState = 'registering' | 'ready' | 'degraded' | 'offline';
type GatewayConnectionHealth = 'healthy' | 'stale' | 'failed';
type GatewayConnectionRole = 'agent' | 'internal_session_integrity';
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
  companionId?: string;
}

const GATEWAY_CONNECTION_STATE_TRANSITIONS:
Readonly<Record<GatewayConnectionState, readonly GatewayConnectionState[]>> = {
  registering: ['ready', 'degraded', 'offline'],
  ready: ['degraded', 'offline'],
  degraded: ['ready', 'offline'],
  offline: [],
};

export { requireGatewaySessionHmacKeyring, resolveGatewaySessionHmacKeyring } from './session-hmac-env.js';

// ── Gateway Server Class ──

export interface GatewayServerOptions {
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
  discordAccountDocks?: ReadonlyMap<string, ChannelOutboundDock>;
  gitOps?: GitOperations;
  imageConfig?: ImageRuntimeConfig;
  modelUsageRecorder?: ModelUsageRecorder;
  policyConfig: PolicyConfig;
  ntfy?: GatewayNtfyConfig;
  auditStore?: GatewayAuditStorePort;
  sessionHmacKeyring: SessionHmacKeyring;
  confirmation?: Partial<GatewayConfirmationConfig>;
  capabilityTierProvider?: () => CapabilityTier;
  wyomingShardRouting: WyomingShardRoutingConfig;
  companionId?: string;
  /**
   * Multi-companion (sprint-10 W1). When absent or disabled, the gateway keeps
   * the single-agent semantics (first-ready routing + broadcast notifications)
   * byte-identical. When enabled, every routed exchange is companion-addressed
   * and any ambiguity fails closed.
   */
  multiCompanion?: GatewayMultiCompanionConfig;
}

export class GatewayServer {
  private rpcServer: net.Server | https.Server | null = null;
  private readonly connections = new Set<GatewayRpcConnection>();
  private readonly rpcClients = new Map<GatewayRpcConnection, JSONRPCServerAndClient>();
  private readonly connectionStatuses = new Map<GatewayRpcConnection, GatewayConnectionStatus>();
  private readonly options: GatewayServerOptions;
  private readonly sessionHmacKeyring: SessionHmacKeyring;
  private streamRequestCounter = 0;
  private readonly capabilityTierProvider: () => CapabilityTier;
  private readonly wyomingShardRouting: WyomingShardRoutingConfig;
  private readonly ntfyNotifier: GatewayNtfyNotifier;
  private readonly approvalBoundary: ApprovalBoundaryService;
  private readonly runtimeHealthTracker: GatewayRuntimeHealthTracker;
  private readonly apiStreamListeners = new Map<string, Set<(text: string) => void>>();
  private readonly multiCompanion: GatewayMultiCompanionConfig;
  private readonly companionConnections = new Map<string, GatewayRpcConnection>();

  constructor(options: GatewayServerOptions) {
    this.options = options;
    this.sessionHmacKeyring = options.sessionHmacKeyring;
    this.multiCompanion = options.multiCompanion ?? disabledGatewayMultiCompanionConfig();
    if (this.multiCompanion.enabled) {
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
    this.approvalBoundary = createGatewayApprovalBoundaryService({
      policyConfig: options.policyConfig,
      ntfyNotifier: this.ntfyNotifier,
      discordAdapter: options.discordAdapter,
      capabilityTierProvider: this.capabilityTierProvider,
      confirmation: options.confirmation,
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
      const summary = paramsSummary ? paramsSummary(params) : undefined;
      const auditId = await this.audit(method, 'ALLOW', summary);
      const startTime = Date.now();
      try {
        const result = await handler(params);
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
    const runtime: GatewayMethodRuntime = {
      target,
      llmProvider: this.options.llmProvider,
      embeddingService: this.options.embeddingService,
      ...(this.options.modelDiscovery ? { modelDiscovery: this.options.modelDiscovery } : {}),
      discordAdapter: this.resolveConnectionDiscordDock(conn),
      gitOps: this.options.gitOps,
      imageConfig: this.options.imageConfig,
      ...(this.options.modelUsageRecorder ? { modelUsageRecorder: this.options.modelUsageRecorder } : {}),
      policyConfig: this.options.policyConfig,
      workspacePath: this.options.policyConfig.workspacePath,
      sessionHmacKeyring: this.sessionHmacKeyring,
      approvalBoundary: this.approvalBoundary,
      notifyRequester: (method, params) => this.notifyRequestingConnection(conn, method, params),
      listPendingConfirmations: () => this.approvalBoundary.listPendingConfirmations(),
      listConfirmationHistory: () => this.approvalBoundary.listConfirmationHistory(),
      resolveConfirmation: (params) => this.approvalBoundary.resolveConfirmation(params),
      sendNtfy: (params) => this.ntfyNotifier.send(params),
      getRuntimeHealth: () => this.getRuntimeHealth(),
      nextStreamRequestId: () => `gw-${++this.streamRequestCounter}`,
      recordAuditEvent: async (entry) => {
        if (this.options.auditStore) {
          await this.options.auditStore.recordSummary(entry);
        }
      },
      audited: (method, handler, paramsSummary) => this.audited(method, handler, paramsSummary),
    };

    registerGatewayMethods(runtime);
    target.addMethod('gateway.client.identify', (params: unknown) => this.identifyConnection(conn, params));
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
      role: 'agent',
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
    this.transitionConnectionState(conn, 'ready', 'rpc_registered');

    conn.on('frameError', async (error: unknown) => {
      const frameError = normalizeNdjsonFrameError(error);
      await this.handleMalformedFrame(conn, 'ndjson', frameError.reason, frameError.preview);
    });

    conn.onMessage(async (message) => {
      if (!this.connections.has(conn)) {
        return;
      }
      this.touchConnectionHealthcheck(conn);
      this.transitionConnectionState(conn, 'ready', 'rpc_message_received');
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
      if (this.multiCompanion.enabled) {
        const verdict = this.enforceCompanionFrameIdentity(conn, message as Record<string, unknown>);
        if (verdict !== 'pass') {
          return;
        }
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

  // Send notification to all connected agents
  notifyAll(method: string, params: unknown): void {
    const notification = {
      jsonrpc: '2.0' as const,
      method,
      params,
    };
    for (const conn of this.connections) {
      const status = this.connectionStatuses.get(conn);
      if (status?.role !== 'agent' || status.state !== 'ready' || status.health !== 'healthy') {
        continue;
      }
      conn.send(notification);
    }
  }

  // Send notification to a specific connection
  notifyOne(conn: GatewayRpcConnection, method: string, params: unknown): void {
    conn.send({
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
  ): void {
    if (!this.multiCompanion.enabled) {
      this.notifyAll(method, params);
      return;
    }
    const route = this.resolveCompanionAgent(surface, discordAccountId);
    this.notifyOne(route.conn, method, params);
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
   * Fail-closed companion identity check applied to every inbound frame while
   * multi-companion is active:
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
      return 'pass';
    }
    const boundCompanionId = status.companionId;
    const params = isRecord(frame.params) ? frame.params : undefined;
    const claimedRaw = params?.companionId;
    const claimedCompanionId = typeof claimedRaw === 'string' ? claimedRaw.trim() : undefined;

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

    if (status.role === 'agent' && !boundCompanionId) {
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
            message: 'Multi-companion mode requires gateway.client.identify with a companionId before other RPC methods',
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
    companionId: string;
  } {
    const companionId = this.resolveRoutedCompanionId(surface, discordAccountId);
    this.refreshConnectionHealth();
    return this.requireReadyCompanionRoute(surface, companionId);
  }

  private resolveRoutedCompanionId(
    surface: GatewayChannelSurface,
    discordAccountId?: string,
  ): string {
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

  private requireReadyCompanionRoute(surface: GatewayChannelSurface, companionId: string): {
    conn: GatewayRpcConnection;
    client: JSONRPCServerAndClient;
    companionId: string;
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

  private removeConnection(conn: GatewayRpcConnection): void {
    const status = this.connectionStatuses.get(conn);
    if (status?.companionId && this.companionConnections.get(status.companionId) === conn) {
      this.companionConnections.delete(status.companionId);
      log.info('Companion connection unbound', { companionId: status.companionId });
    }
    this.connections.delete(conn);
    this.rpcClients.delete(conn);
    this.connectionStatuses.delete(conn);
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

  async requestAgentVoiceStream(
    message: SubstrateMessage,
    options: VoiceStreamRequestOptions = {},
  ): Promise<VoiceHandleMessageResult> {
    let client: JSONRPCServerAndClient;
    let companionId = this.options.companionId ?? DEFAULT_COMPANION_ID;
    if (this.multiCompanion.enabled) {
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
      const route = this.resolveCompanionAgent(surface);
      client = route.client;
      companionId = route.companionId;
    } else {
      client = this.resolveReadyRpcClient();
    }

    return requestAgentVoiceStream({
      client,
      message,
      options,
      wyomingShardRouting: this.wyomingShardRouting,
      companionId,
      nextRequestCounter: () => ++this.streamRequestCounter,
    });
  }

  private resolveReadyRpcClient(): JSONRPCServerAndClient {
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
        return client;
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

  private identifyConnection(
    conn: GatewayRpcConnection,
    params: unknown,
  ): { success: true; role: GatewayConnectionRole; companionId?: string } {
    if (!isRecord(params) || !isGatewayConnectionRole(params.role)) {
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
      ? params.companionId.trim()
      : undefined;

    if (this.multiCompanion.enabled && params.role === 'agent') {
      if (!companionId) {
        this.alarmCompanionViolation(
          'identify_missing_companion',
          'Agent identified without a companionId while multi-companion is active; rejecting',
          {},
        );
        throw new Error(
          'Multi-companion mode requires a companionId in gateway.client.identify for agent connections',
        );
      }
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
      const existing = this.companionConnections.get(companionId);
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
        // Stale registry entry from a connection that vanished without cleanup.
        this.companionConnections.delete(companionId);
      }
      this.companionConnections.set(companionId, conn);
      status.companionId = companionId;
      log.info('Companion connection bound', { companionId });
    } else if (companionId) {
      // Flag off (or non-agent role): record for observability only — routing
      // semantics stay byte-identical to single-companion behavior.
      status.companionId = companionId;
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
    for (const conn of this.connections) {
      conn.destroy();
    }
    this.connections.clear();
    this.rpcClients.clear();
    this.connectionStatuses.clear();
    this.companionConnections.clear();

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

function isGatewayConnectionRole(value: unknown): value is GatewayConnectionRole {
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
